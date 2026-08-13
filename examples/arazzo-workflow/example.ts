/**
 * Arazzo workflows: many API calls, one tool.
 *
 * Tool consolidation is the consensus answer to context bloat, and Arazzo
 * (the OpenAPI workflows spec) is its standards-track format. fromArazzo()
 * turns each workflow into ONE MCP tool whose metadata carries a pure,
 * serializable IR — this example also shows a compact executor driving that
 * IR: evaluating `$inputs` / `$steps.*.outputs.*` / `$response.body#/ptr`
 * expressions and building each step's request from its embedded mapper.
 */
import { buildHttpRequest, fromArazzo } from 'mcp-from-openapi';
import type {
  ArazzoDocument,
  ExpressionValueIR,
  McpOpenAPITool,
  OpenAPIDocument,
  RuntimeExpressionAST,
} from 'mcp-from-openapi';

/** Consolidate every workflow in an Arazzo document into MCP tools. */
export async function loadWorkflowTools(
  arazzo: ArazzoDocument | string,
  sources: Record<string, OpenAPIDocument>,
): Promise<McpOpenAPITool[]> {
  return fromArazzo(arazzo, { sources });
}

interface StepState {
  statusCode: number;
  body: unknown;
  outputs: Record<string, unknown>;
}

const followPointer = (value: unknown, pointer?: string): unknown =>
  !pointer
    ? value
    : pointer
        .slice(1)
        .split('/')
        .reduce<unknown>(
          (node, raw) =>
            node && typeof node === 'object'
              ? (node as Record<string, unknown>)[raw.replace(/~1/g, '/').replace(/~0/g, '~')]
              : undefined,
          value,
        );

/** Evaluate one runtime-expression AST against the run state. */
function evaluate(
  ast: RuntimeExpressionAST,
  state: { inputs: Record<string, unknown>; steps: Record<string, StepState>; current?: StepState },
): unknown {
  if (ast.type === 'inputs') return state.inputs[ast.path.join('.')];
  if (ast.type === 'steps') return state.steps[ast.path[0]]?.outputs[ast.path.slice(2).join('.')];
  if (ast.type === 'statusCode') return state.current?.statusCode;
  if (ast.type === 'response' && ast.source === 'body') return followPointer(state.current?.body, ast.pointer);
  throw new Error(`this executor does not evaluate ${ast.raw}`);
}

const materialize = (value: ExpressionValueIR, state: Parameters<typeof evaluate>[1]): unknown =>
  value.kind === 'literal'
    ? value.value
    : value.kind === 'expression'
      ? evaluate(value.expression, state)
      : value.parts.map((part) => (typeof part === 'string' ? part : String(evaluate(part, state)))).join('');

/**
 * Execute a workflow tool's IR against a live API. Each operation step's
 * embedded `operation.mapper` feeds buildHttpRequest directly — no second
 * pass over the OpenAPI document is ever needed.
 */
export async function runWorkflow(
  tool: McpOpenAPITool,
  inputs: Record<string, unknown>,
  apiBaseUrl: string,
): Promise<Record<string, unknown>> {
  const ir = tool.metadata.workflow;
  if (!ir) throw new Error(`${tool.name} is not a workflow tool`);

  const steps: Record<string, StepState> = {};
  for (const step of ir.steps) {
    if (step.kind !== 'operation') throw new Error('nested workflows are out of scope here');

    const input: Record<string, unknown> = {};
    for (const parameter of step.parameters ?? []) {
      input[parameter.name] = materialize(parameter.value, { inputs, steps });
    }
    if (step.requestBody?.payload !== undefined) {
      const payload = JSON.parse(JSON.stringify(step.requestBody.payload)) as Record<string, unknown>;
      for (const expression of step.requestBody.payloadExpressions ?? []) {
        // RFC 6901: decode ~1 -> / and ~0 -> ~ (in that order) per segment
        const segments = expression.pointer
          .slice(1)
          .split('/')
          .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
        let node: Record<string, unknown> = payload;
        for (const segment of segments.slice(0, -1)) node = node[segment] as Record<string, unknown>;
        node[segments[segments.length - 1]] = materialize(expression.value, { inputs, steps });
      }
      for (const [key, value] of Object.entries(payload)) {
        const entry = step.operation.mapper.find((m) => m.type === 'body' && m.key === key);
        input[entry?.inputKey ?? key] = value;
      }
    }

    const built = buildHttpRequest(
      {
        name: step.stepId,
        description: step.stepId,
        inputSchema: step.operation.inputSchema,
        mapper: step.operation.mapper,
        metadata: { path: step.path, method: step.method },
      },
      input,
      { baseUrl: apiBaseUrl },
    );
    const response = await fetch(built.url, { method: built.method, headers: built.headers, body: built.body as never });
    const current: StepState = { statusCode: response.status, body: await response.json().catch(() => undefined), outputs: {} };
    for (const [name, ast] of Object.entries(step.outputs ?? {})) {
      current.outputs[name] = evaluate(ast, { inputs, steps, current });
    }
    steps[step.stepId] = current;
  }

  const outputs: Record<string, unknown> = {};
  for (const [name, ast] of Object.entries(ir.outputs ?? {})) {
    outputs[name] = evaluate(ast, { inputs, steps });
  }
  return outputs;
}
