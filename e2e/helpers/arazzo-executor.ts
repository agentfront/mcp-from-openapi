/**
 * Minimal Arazzo workflow executor for the e2e story: drives the IR on
 * `metadata.workflow` — never the raw Arazzo text — evaluating runtime
 * expressions against real HTTP responses and building each step's request
 * from the step's embedded `operation.mapper` via buildHttpRequest.
 */
import { buildHttpRequest } from '../../src';
import type { ExpressionValueIR, McpOpenAPITool, RuntimeExpressionAST } from '../../src';
import { sendBuiltRequest } from './http';

interface StepResult {
  statusCode: number;
  body: unknown;
  outputs: Record<string, unknown>;
}

interface EvalContext {
  inputs: Record<string, unknown>;
  steps: Record<string, StepResult>;
  current?: StepResult;
}

const decodeSegment = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');

function walkPointer(value: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined || pointer === '') return value;
  let node: unknown = value;
  for (const segment of pointer.slice(1).split('/')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[decodeSegment(segment)];
  }
  return node;
}

function setPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const segments = pointer.slice(1).split('/').map(decodeSegment);
  let node: Record<string, unknown> = target;
  for (const segment of segments.slice(0, -1)) {
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

function evalExpression(ast: RuntimeExpressionAST, ctx: EvalContext): unknown {
  switch (ast.type) {
    case 'inputs':
      return ctx.inputs[ast.path.join('.')];
    case 'steps': {
      const step = ctx.steps[ast.path[0]];
      if (step && ast.path[1] === 'outputs') {
        return step.outputs[ast.path.slice(2).join('.')];
      }
      return undefined;
    }
    case 'statusCode':
      return ctx.current?.statusCode;
    case 'response':
      return ast.source === 'body' ? walkPointer(ctx.current?.body, ast.pointer) : undefined;
    default:
      throw new Error(`e2e executor does not evaluate ${ast.raw}`);
  }
}

function evalValue(value: ExpressionValueIR, ctx: EvalContext): unknown {
  switch (value.kind) {
    case 'literal':
      return value.value;
    case 'expression':
      return evalExpression(value.expression, ctx);
    case 'template':
      return value.parts.map((part) => (typeof part === 'string' ? part : String(evalExpression(part, ctx)))).join('');
  }
}

export interface WorkflowRun {
  steps: Record<string, StepResult>;
  outputs: Record<string, unknown>;
}

export async function executeWorkflow(
  tool: McpOpenAPITool,
  inputs: Record<string, unknown>,
  baseUrl: string,
): Promise<WorkflowRun> {
  const ir = tool.metadata.workflow;
  if (!ir) throw new Error(`${tool.name} carries no workflow IR`);

  const steps: Record<string, StepResult> = {};
  for (const step of ir.steps) {
    if (step.kind !== 'operation') {
      throw new Error('the e2e executor drives operation steps only');
    }

    const input: Record<string, unknown> = {};
    for (const parameter of step.parameters ?? []) {
      input[parameter.name] = evalValue(parameter.value, { inputs, steps });
    }

    if (step.requestBody?.payload !== undefined) {
      let payload = JSON.parse(JSON.stringify(step.requestBody.payload)) as Record<string, unknown>;
      for (const expression of step.requestBody.payloadExpressions ?? []) {
        const value = evalValue(expression.value, { inputs, steps });
        if (expression.pointer === '') {
          payload = value as Record<string, unknown>;
        } else {
          setPointer(payload, expression.pointer, value);
        }
      }
      const wholeBody = step.operation.mapper.find((entry) => entry.wholeBody);
      if (wholeBody) {
        input[wholeBody.inputKey] = payload;
      } else {
        // buildHttpRequest reads input[mapper.inputKey]; flattened payload
        // keys are wire names (mapper.key), which conflict renames can differ
        for (const [key, value] of Object.entries(payload)) {
          const entry = step.operation.mapper.find((m) => m.type === 'body' && m.key === key);
          input[entry?.inputKey ?? key] = value;
        }
      }
    }

    // The embedded operation essentials ARE the executable surface
    const stepTool: McpOpenAPITool = {
      name: step.stepId,
      description: step.description ?? step.stepId,
      inputSchema: step.operation.inputSchema,
      outputSchema: step.operation.outputSchema,
      mapper: step.operation.mapper,
      metadata: { path: step.path, method: step.method },
    };
    const response = await sendBuiltRequest(buildHttpRequest(stepTool, input, { baseUrl }));
    const body: unknown = await response.json().catch(() => undefined);

    const current: StepResult = { statusCode: response.status, body, outputs: {} };
    for (const [name, ast] of Object.entries(step.outputs ?? {})) {
      current.outputs[name] = evalExpression(ast, { inputs, steps, current });
    }
    steps[step.stepId] = current;
  }

  const outputs: Record<string, unknown> = {};
  for (const [name, ast] of Object.entries(ir.outputs ?? {})) {
    outputs[name] = evalExpression(ast, { inputs, steps });
  }
  return { steps, outputs };
}
