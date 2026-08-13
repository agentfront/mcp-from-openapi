/**
 * Arazzo 1.0 → consolidated MCP tools.
 *
 * `fromArazzo()` parses an Arazzo workflow document against caller-supplied
 * OpenAPI sources and emits ONE `McpOpenAPITool` per workflow: the workflow
 * inputs become the tool's input schema, the workflow outputs derive the
 * output schema, and a pure, JSON-serializable IR (`metadata.workflow`)
 * carries the step sequence — each operation step embedding its resolved
 * schemas and mapper so an executor needs no second spec pass. This library
 * never fetches source URLs, performs HTTP, or evaluates expressions.
 */
import { OpenAPIToolGenerator, fnv1aHex, normalizeToolName } from './generator';
import { ArazzoError } from './errors';
import { collectPayloadExpressions, parseExpressionValue, parseRuntimeExpression } from './arazzo-expressions';
import { inferAnnotationsFromMethod } from './annotations';
import { SchemaBuilder } from './schema-builder';
import { applyClientTarget } from './client-targets';
import { BUILTIN_FORMAT_RESOLVERS, resolveSchemaFormats } from './format-resolver';
import { emitToolTypeScript } from './type-signature';
import { toJsonSchema } from './types';
import * as yaml from 'yaml';
import type {
  GenerateOptions,
  HTTPMethod,
  JsonSchema,
  LoadOptions,
  McpOpenAPITool,
  OpenAPIDocument,
  SchemaObject,
  SecurityRequirement,
} from './types';
import type {
  ActionIR,
  ArazzoComponents,
  ArazzoCriterion,
  ArazzoDocument,
  ArazzoFailureAction,
  ArazzoParameter,
  ArazzoReusableObject,
  ArazzoStep,
  ArazzoSuccessAction,
  ArazzoWorkflow,
  CriterionIR,
  NestedWorkflowStepIR,
  OperationStepIR,
  RuntimeExpressionAST,
  StepOperationIR,
  StepParameterIR,
  StepRequestBodyIR,
  WorkflowIR,
  WorkflowStepIR,
} from './arazzo-types';

/**
 * The `GenerateOptions` subset that applies to Arazzo output — schema-shaping
 * and naming options. Operation-filtering options have no meaning here.
 */
export type ArazzoGenerateOptions = Pick<
  GenerateOptions,
  | 'target'
  | 'maxSchemaDepth'
  | 'maxProperties'
  | 'maxDescriptionLength'
  | 'stripExamples'
  | 'includeExamples'
  | 'resolveFormats'
  | 'formatResolvers'
  | 'preferredStatusCodes'
  | 'includeAllResponses'
  | 'maxToolNameLength'
  | 'includeSecurityInInput'
  | 'emitTypeSignatures'
>;

/** Options for {@link fromArazzo}. */
export interface FromArazzoOptions {
  /**
   * Source description name → resolved OpenAPI document or pre-built
   * generator. Source URLs are NEVER fetched — the caller supplies resolved
   * documents for every source the workflows use.
   */
  sources: Record<string, OpenAPIDocument | OpenAPIToolGenerator>;

  /**
   * Schema-affecting options, applied to the per-step embedded schemas AND
   * the consolidated workflow schemas.
   */
  generateOptions?: ArazzoGenerateOptions;

  /**
   * Load options for internally-constructed generators (raw documents only).
   */
  loadOptions?: Pick<LoadOptions, 'dereference' | 'validate' | 'baseUrl' | 'overlays'>;
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const OUTPUT_KEY_PATTERN = /^[a-zA-Z0-9.\-_]+$/;
const VERSION_PATTERN = /^1\.0\.\d+$/;
const HTTP_METHODS: readonly string[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const PARAMETER_LOCATIONS: readonly string[] = ['path', 'query', 'header', 'cookie'];
const OUTPUT_DERIVATION_MAX_DEPTH = 8;

function err(message: string, path: string, extra?: Record<string, unknown>): never {
  throw new ArazzoError(message, { path, ...extra });
}

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

/**
 * Normalize to plain, alias-free JSON data. The round-trip expands YAML
 * anchors into distinct nodes (so payload expression pointers see every
 * occurrence), converts YAML-only scalars (dates, binary) to their JSON
 * forms, and rejects cyclic or absurdly deep structures with an ArazzoError
 * instead of letting later passes crash.
 */
function toPlainJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error: unknown) {
    /* c8 ignore next -- JSON.stringify only throws Error instances */
    const message = error instanceof Error ? error.message : String(error);
    throw new ArazzoError(`Arazzo document must be JSON-serializable (acyclic, bounded depth): ${message}`, {
      path: '',
    });
  }
}

function parseArazzoInput(input: ArazzoDocument | string): ArazzoDocument {
  if (typeof input === 'string') {
    let parsed: unknown;
    try {
      parsed = yaml.parse(input);
    } catch (error: unknown) {
      /* c8 ignore next -- yaml only throws Error instances */
      const message = error instanceof Error ? error.message : String(error);
      throw new ArazzoError(`Failed to parse Arazzo document: ${message}`, { path: '' });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      err('Arazzo document must be an object', '');
    }
    return toPlainJson(parsed) as ArazzoDocument;
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    err('Arazzo document must be an object', '');
  }
  // Never mutate caller input (components inlining edits the tree)
  return toPlainJson(input) as ArazzoDocument;
}

function validateCriteria(criteria: unknown, path: string): void {
  if (criteria === undefined) return;
  if (!Array.isArray(criteria)) {
    err('successCriteria/criteria must be an array', path);
  }
  criteria.forEach((criterion: ArazzoCriterion, index) => {
    const cPath = `${path}/${index}`;
    if (!criterion || typeof criterion !== 'object') {
      err('Criterion must be an object', cPath);
    }
    if (typeof criterion.condition !== 'string' || criterion.condition === '') {
      err('Criterion requires a non-empty string "condition"', cPath);
    }
    const type = criterion.type;
    let effectiveType: string | undefined;
    if (type !== undefined) {
      if (typeof type === 'string') {
        if (!['simple', 'regex', 'jsonpath', 'xpath'].includes(type)) {
          err(`Unknown criterion type "${type}"`, cPath);
        }
        effectiveType = type;
      } else if (type && typeof type === 'object') {
        if ((type.type !== 'jsonpath' && type.type !== 'xpath') || typeof type.version !== 'string') {
          err('Criterion Expression Type Object requires "type" (jsonpath|xpath) and "version"', cPath);
        }
        effectiveType = type.type;
      } else {
        err('Criterion "type" must be a string or a Criterion Expression Type Object', cPath);
      }
    }
    if (criterion.context !== undefined && typeof criterion.context !== 'string') {
      err('Criterion "context" must be a runtime expression string', cPath);
    }
    if (effectiveType !== undefined && effectiveType !== 'simple' && criterion.context === undefined) {
      err(`Criterion of type "${effectiveType}" requires a "context" expression`, cPath);
    }
  });
}

function validateActions(
  actions: Array<ArazzoSuccessAction | ArazzoFailureAction | ArazzoReusableObject> | undefined,
  kind: 'success' | 'failure',
  path: string,
): void {
  if (actions === undefined) return;
  if (!Array.isArray(actions)) {
    err('Actions must be an array', path);
  }
  actions.forEach((action, index) => {
    const aPath = `${path}/${index}`;
    if (!action || typeof action !== 'object') {
      err('Action must be an object', aPath);
    }
    if ('reference' in action) {
      return; // Reusable Object — resolved and re-validated in resolveActions
    }
    validateActionObject(action, kind, aPath);
  });
}

/** Validation for one concrete action — also run on resolved reusables. */
function validateActionObject(action: ArazzoSuccessAction | ArazzoFailureAction, kind: 'success' | 'failure', aPath: string): void {
  const act = action as ArazzoSuccessAction & ArazzoFailureAction;
  if (typeof act.name !== 'string' || act.name === '') {
    err('Action requires a non-empty string "name"', aPath);
  }
  const allowed = kind === 'success' ? ['end', 'goto'] : ['end', 'retry', 'goto'];
  if (!allowed.includes(act.type)) {
    err(`Invalid ${kind}-action type "${String(act.type)}" (allowed: ${allowed.join(', ')})`, aPath);
  }
  const targets = [act.workflowId, act.stepId].filter((t) => t !== undefined).length;
  if (act.type === 'goto' && targets !== 1) {
    err('A "goto" action requires exactly one of "workflowId" or "stepId"', aPath);
  }
  if (act.type === 'end' && targets !== 0) {
    err('An "end" action must not specify "workflowId" or "stepId"', aPath);
  }
  if (act.retryAfter !== undefined && (typeof act.retryAfter !== 'number' || act.retryAfter < 0)) {
    err('"retryAfter" must be a non-negative number', aPath);
  }
  if (act.retryLimit !== undefined && (typeof act.retryLimit !== 'number' || !Number.isInteger(act.retryLimit) || act.retryLimit < 0)) {
    err('"retryLimit" must be a non-negative integer', aPath);
  }
  validateCriteria(act.criteria, `${aPath}/criteria`);
}

function validateParameters(
  parameters: Array<ArazzoParameter | ArazzoReusableObject> | undefined,
  requireIn: boolean | undefined,
  path: string,
): void {
  if (parameters === undefined) return;
  if (!Array.isArray(parameters)) {
    err('Parameters must be an array', path);
  }
  const seen = new Set<string>();
  parameters.forEach((parameter, index) => {
    const pPath = `${path}/${index}`;
    if (!parameter || typeof parameter !== 'object') {
      err('Parameter must be an object', pPath);
    }
    if ('reference' in parameter) {
      return; // Reusable Object — resolved and re-validated in resolveParameters
    }
    validateParameterObject(parameter, requireIn, pPath);
    const param = parameter as ArazzoParameter;
    const key = `${param.name} ${param.in ?? ''}`;
    if (seen.has(key)) {
      err(`Duplicate parameter "${param.name}"${param.in ? ` (in: ${param.in})` : ''}`, pPath);
    }
    seen.add(key);
  });
}

/** Validation for one concrete parameter — also run on resolved reusables. */
function validateParameterObject(param: ArazzoParameter, requireIn: boolean | undefined, pPath: string): void {
  if (typeof param.name !== 'string' || param.name === '') {
    err('Parameter requires a non-empty string "name"', pPath);
  }
  const paramName = param.name;
  if (!('value' in param)) {
    err(`Parameter "${paramName}" requires a "value"`, pPath);
  }
  if (param.in !== undefined && !PARAMETER_LOCATIONS.includes(param.in)) {
    err(`Invalid parameter location "${String(param.in)}"`, pPath);
  }
  if (requireIn === true && param.in === undefined) {
    err(`Parameter "${param.name}" on an operation step requires "in"`, pPath);
  }
  if (requireIn === false && param.in !== undefined) {
    err(`Parameter "${param.name}" on a workflowId step must not specify "in"`, pPath);
  }
}

function validateOutputs(outputs: unknown, path: string): void {
  if (outputs === undefined) return;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) {
    err('"outputs" must be an object of name → runtime expression', path);
  }
  for (const [key, value] of Object.entries(outputs)) {
    if (!OUTPUT_KEY_PATTERN.test(key)) {
      err(`Invalid output name "${key}"`, `${path}/${key}`);
    }
    if (typeof value !== 'string') {
      err(`Output "${key}" must be a runtime expression string`, `${path}/${key}`);
    }
  }
}

function validateDocument(doc: ArazzoDocument): void {
  if (typeof doc.arazzo !== 'string' || !VERSION_PATTERN.test(doc.arazzo)) {
    err(`Unsupported arazzo version "${String(doc.arazzo)}" (expected 1.0.x)`, '/arazzo');
  }
  if (!doc.info || typeof doc.info !== 'object' || typeof doc.info.title !== 'string' || typeof doc.info.version !== 'string') {
    err('"info" requires string "title" and "version"', '/info');
  }
  if (!Array.isArray(doc.sourceDescriptions) || doc.sourceDescriptions.length === 0) {
    err('"sourceDescriptions" must be a non-empty array', '/sourceDescriptions');
  }
  const sourceNames = new Set<string>();
  doc.sourceDescriptions.forEach((source, index) => {
    const sPath = `/sourceDescriptions/${index}`;
    if (!source || typeof source !== 'object' || typeof source.name !== 'string' || !ID_PATTERN.test(source.name)) {
      err('Source description requires a "name" matching [A-Za-z0-9_-]+', sPath);
    }
    if (typeof source.url !== 'string' || source.url === '') {
      err(`Source "${source.name}" requires a string "url"`, sPath);
    }
    if (source.type !== undefined && source.type !== 'openapi' && source.type !== 'arazzo') {
      err(`Source "${source.name}" has invalid type "${String(source.type)}"`, sPath);
    }
    if (sourceNames.has(source.name)) {
      err(`Duplicate source description name "${source.name}"`, sPath);
    }
    sourceNames.add(source.name);
  });

  if (!Array.isArray(doc.workflows) || doc.workflows.length === 0) {
    err('"workflows" must be a non-empty array', '/workflows');
  }
  const workflowIds = new Set<string>();
  doc.workflows.forEach((workflow, wIndex) => {
    const wPath = `/workflows/${wIndex}`;
    if (!workflow || typeof workflow !== 'object' || typeof workflow.workflowId !== 'string' || !ID_PATTERN.test(workflow.workflowId)) {
      err('Workflow requires a "workflowId" matching [A-Za-z0-9_-]+', wPath);
    }
    if (workflowIds.has(workflow.workflowId)) {
      err(`Duplicate workflowId "${workflow.workflowId}"`, wPath);
    }
    workflowIds.add(workflow.workflowId);

    if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
      err(`Workflow "${workflow.workflowId}" requires a non-empty "steps" array`, `${wPath}/steps`);
    }
    validateParameters(workflow.parameters, undefined, `${wPath}/parameters`);
    validateActions(workflow.successActions, 'success', `${wPath}/successActions`);
    validateActions(workflow.failureActions, 'failure', `${wPath}/failureActions`);
    validateOutputs(workflow.outputs, `${wPath}/outputs`);

    const stepIds = new Set<string>();
    workflow.steps.forEach((step, sIndex) => {
      const sPath = `${wPath}/steps/${sIndex}`;
      if (!step || typeof step !== 'object' || typeof step.stepId !== 'string' || !ID_PATTERN.test(step.stepId)) {
        err('Step requires a "stepId" matching [A-Za-z0-9_-]+', sPath);
      }
      if (stepIds.has(step.stepId)) {
        err(`Duplicate stepId "${step.stepId}" in workflow "${workflow.workflowId}"`, sPath);
      }
      stepIds.add(step.stepId);

      const kinds = [step.operationId, step.operationPath, step.workflowId].filter((k) => k !== undefined).length;
      if (kinds !== 1) {
        err(`Step "${step.stepId}" requires exactly one of "operationId", "operationPath", or "workflowId"`, sPath);
      }
      validateParameters(step.parameters, step.workflowId !== undefined ? false : true, `${sPath}/parameters`);
      validateCriteria(step.successCriteria, `${sPath}/successCriteria`);
      validateActions(step.onSuccess, 'success', `${sPath}/onSuccess`);
      validateActions(step.onFailure, 'failure', `${sPath}/onFailure`);
      validateOutputs(step.outputs, `${sPath}/outputs`);
    });
  });
}

// ---------------------------------------------------------------------------
// Components resolution
// ---------------------------------------------------------------------------

/** Own-key component lookup: inherited members (`toString`, `constructor`,
 * ...) and non-object values never resolve — document-supplied names must not
 * reach prototype members or leak primitives where component objects belong. */
function ownComponent(group: Record<string, unknown> | undefined, name: string): object | undefined {
  if (!group || !Object.prototype.hasOwnProperty.call(group, name)) {
    return undefined;
  }
  const value = group[name];
  return value !== null && typeof value === 'object' ? (value as object) : undefined;
}

function resolveReusable<T>(
  entry: T | ArazzoReusableObject,
  components: ArazzoComponents | undefined,
  expectedGroup: 'parameters' | 'successActions' | 'failureActions',
  path: string,
): T {
  if (!entry || typeof entry !== 'object' || !('reference' in (entry as object))) {
    return entry as T;
  }
  const reusable = entry as ArazzoReusableObject;
  if (typeof reusable.reference !== 'string') {
    err('Reusable Object "reference" must be a string', path);
  }
  const ast = parseRuntimeExpression(reusable.reference, path);
  if (ast.type !== 'components' || ast.path.length < 2 || ast.path[0] !== expectedGroup) {
    err(`Reference "${reusable.reference}" must point at $components.${expectedGroup}.<name>`, path);
  }
  // Component names may legally contain dots (`my.org.petId`) — re-join
  const name = ast.path.slice(1).join('.');
  const target = ownComponent(components?.[expectedGroup], name);
  if (!target) {
    err(`Unknown reference "$components.${expectedGroup}.${name}"`, path);
  }
  const resolved = JSON.parse(JSON.stringify(target)) as T;
  if (expectedGroup === 'parameters' && 'value' in reusable) {
    (resolved as ArazzoParameter).value = reusable.value;
  }
  return resolved;
}

/** Resolve `#/components/inputs/...` $refs inside a workflow inputs schema. */
function resolveInputRefs(node: unknown, components: ArazzoComponents | undefined, path: string, seen: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => resolveInputRefs(item, components, path, seen));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const record = node as Record<string, unknown>;
  const ref = record['$ref'];
  if (typeof ref === 'string') {
    const prefix = '#/components/inputs/';
    if (!ref.startsWith(prefix)) {
      err(`Unsupported $ref "${ref}" in workflow inputs (only ${prefix}<name> is resolvable)`, path);
    }
    const name = ref.slice(prefix.length);
    const target = ownComponent(components?.inputs, name);
    if (!target) {
      err(`Unknown workflow inputs reference "${ref}"`, path);
    }
    if (seen.has(name)) {
      err(`Cyclic workflow inputs reference "${ref}"`, path);
    }
    seen.add(name);
    const resolved = resolveInputRefs(target, components, path, seen);
    seen.delete(name);
    return resolved;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = resolveInputRefs(value, components, path, seen);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sources & operation resolution
// ---------------------------------------------------------------------------

interface SourceContext {
  generators: Map<string, OpenAPIToolGenerator>;
  /** operationId → every (source, path, method) that declares it. */
  operationIndex: Map<string, Array<{ source: string; path: string; method: HTTPMethod }>>;
  sourceTypes: Map<string, 'openapi' | 'arazzo'>;
}

async function prepareSources(doc: ArazzoDocument, options: FromArazzoOptions): Promise<SourceContext> {
  const declared = new Map(doc.sourceDescriptions.map((s) => [s.name, s]));
  const generators = new Map<string, OpenAPIToolGenerator>();
  const sourceTypes = new Map<string, 'openapi' | 'arazzo'>();

  for (const [name, source] of Object.entries(options.sources ?? {})) {
    if (!declared.has(name)) {
      err(`options.sources contains "${name}", which is not a declared source description`, '/sourceDescriptions', {
        declared: [...declared.keys()],
      });
    }
    if (source instanceof OpenAPIToolGenerator) {
      generators.set(name, source);
    } else {
      generators.set(name, await OpenAPIToolGenerator.fromJSON(source as object, options.loadOptions));
    }
  }
  for (const [name, source] of declared) {
    sourceTypes.set(name, source.type ?? 'openapi');
  }

  const operationIndex: SourceContext['operationIndex'] = new Map();
  for (const [name, generator] of generators) {
    const document = generator.getDocument();
    for (const [pathStr, pathItem] of Object.entries(document.paths ?? {})) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const method of HTTP_METHODS) {
        const operation = (pathItem as Record<string, unknown>)[method];
        if (!operation || typeof operation !== 'object') continue;
        const operationId = (operation as Record<string, unknown>)['operationId'];
        if (typeof operationId !== 'string') continue;
        const hits = operationIndex.get(operationId) ?? [];
        hits.push({ source: name, path: pathStr, method: method as HTTPMethod });
        operationIndex.set(operationId, hits);
      }
    }
  }
  return { generators, operationIndex, sourceTypes };
}

function requireGenerator(ctx: SourceContext, source: string, path: string): OpenAPIToolGenerator {
  if (ctx.sourceTypes.get(source) === 'arazzo') {
    err(`Source "${source}" has type "arazzo" — nested Arazzo sources are not supported`, path);
  }
  const generator = ctx.generators.get(source);
  if (!generator) {
    err(`No document supplied for source "${source}" (add it to options.sources)`, path, {
      supplied: [...ctx.generators.keys()],
    });
  }
  return generator;
}

/** Parse `{$sourceDescriptions.<name>.url}#<json-pointer>` into (source, path, method). */
function parseOperationPath(value: string, path: string): { source: string; path: string; method: HTTPMethod } {
  if (!value.startsWith('{')) {
    err(`operationPath "${value}" must start with a "{$sourceDescriptions...}" expression`, path);
  }
  const close = value.indexOf('}');
  if (close === -1) {
    err(`operationPath "${value}" is missing "}"`, path);
  }
  const ast = parseRuntimeExpression(value.slice(1, close), path);
  if (ast.type !== 'sourceDescriptions' || ast.path.length !== 2 || ast.path[1] !== 'url') {
    err(`operationPath "${value}" must reference $sourceDescriptions.<name>.url`, path);
  }
  const source = ast.path[0];
  const rest = value.slice(close + 1);
  if (!rest.startsWith('#/')) {
    err(`operationPath "${value}" requires a "#/paths/..." JSON Pointer after the source expression`, path);
  }
  const segments = rest
    .slice(2)
    .split('/')
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (segments.length !== 3 || segments[0] !== 'paths') {
    err(`operationPath pointer in "${value}" must have the shape #/paths/<path>/<method>`, path);
  }
  const method = segments[2].toLowerCase();
  if (!HTTP_METHODS.includes(method)) {
    err(`operationPath "${value}" ends in unknown HTTP method "${segments[2]}"`, path);
  }
  return { source, path: segments[1], method: method as HTTPMethod };
}

function resolveOperationRef(
  step: ArazzoStep,
  ctx: SourceContext,
  path: string,
): { source: string; path: string; method: HTTPMethod; operationId?: string } {
  if (step.operationPath !== undefined) {
    return parseOperationPath(step.operationPath, path);
  }
  const ref = step.operationId as string;
  if (ref.startsWith('$')) {
    // $sourceDescriptions.<name>.<operationId...> pins the source; the
    // remainder is re-joined so dotted operationIds survive.
    const ast = parseRuntimeExpression(ref, path);
    if (ast.type !== 'sourceDescriptions' || ast.path.length < 2) {
      err(`operationId expression "${ref}" must be $sourceDescriptions.<name>.<operationId>`, path);
    }
    const source = ast.path[0];
    const operationId = ast.path.slice(1).join('.');
    const hits = (ctx.operationIndex.get(operationId) ?? []).filter((h) => h.source === source);
    if (hits.length === 0) {
      requireGenerator(ctx, source, path); // surface missing-source/arazzo-type errors first
      err(`operationId "${operationId}" not found in source "${source}"`, path);
    }
    if (hits.length > 1) {
      err(`operationId "${operationId}" is duplicated inside source "${source}"`, path, { hits });
    }
    return { ...hits[0], operationId };
  }
  const hits = ctx.operationIndex.get(ref) ?? [];
  if (hits.length === 0) {
    err(`operationId "${ref}" not found in any supplied source (${[...ctx.generators.keys()].join(', ') || 'none'})`, path);
  }
  if (hits.length > 1) {
    err(
      `operationId "${ref}" is ambiguous across sources (${hits.map((h) => h.source).join(', ')}) — pin it with $sourceDescriptions.<name>.${ref}`,
      path,
      { hits },
    );
  }
  return { ...hits[0], operationId: ref };
}

// ---------------------------------------------------------------------------
// Cycle checks
// ---------------------------------------------------------------------------

function checkCycles(edges: Map<string, string[]>, kind: string): void {
  const state = new Map<string, 'visiting' | 'done'>();
  for (const start of edges.keys()) {
    if (state.get(start) === 'done') continue;
    const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    state.set(start, 'visiting');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const targets = edges.get(frame.node) ?? [];
      if (frame.next >= targets.length) {
        state.set(frame.node, 'done');
        stack.pop();
        continue;
      }
      const target = targets[frame.next++];
      const targetState = state.get(target);
      if (targetState === 'visiting') {
        const cycle = [...stack.map((f) => f.node), target];
        err(`Cyclic ${kind}: ${cycle.slice(cycle.indexOf(target)).join(' -> ')}`, '/workflows');
      }
      if (targetState !== 'done') {
        state.set(target, 'visiting');
        stack.push({ node: target, next: 0 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// IR construction
// ---------------------------------------------------------------------------

interface BuildContext {
  doc: ArazzoDocument;
  sources: SourceContext;
  generateOptions: ArazzoGenerateOptions;
  workflowIds: Set<string>;
  /** Cache of resolved per-operation tools, keyed by source+method+path. */
  operationCache: Map<string, Promise<McpOpenAPITool>>;
}

function toCriterionIR(criterion: ArazzoCriterion, path: string): CriterionIR {
  const ir: CriterionIR = {
    condition: criterion.condition,
    type: 'simple',
  };
  if (criterion.context !== undefined) {
    ir.context = parseRuntimeExpression(criterion.context, path);
  }
  if (typeof criterion.type === 'string') {
    ir.type = criterion.type;
  } else if (criterion.type) {
    ir.type = criterion.type.type;
    ir.version = criterion.type.version;
  }
  return ir;
}

function toActionIR(
  action: ArazzoSuccessAction | ArazzoFailureAction,
  kind: 'success' | 'failure',
  path: string,
): ActionIR {
  const failure = action as ArazzoFailureAction;
  return {
    name: action.name,
    kind,
    type: action.type,
    ...(action.workflowId !== undefined && { workflowId: action.workflowId }),
    ...(action.stepId !== undefined && { stepId: action.stepId }),
    ...(failure.retryAfter !== undefined && { retryAfter: failure.retryAfter }),
    ...(failure.retryLimit !== undefined && { retryLimit: failure.retryLimit }),
    ...(action.criteria && { criteria: action.criteria.map((c, i) => toCriterionIR(c, `${path}/criteria/${i}`)) }),
  };
}

function resolveActions(
  actions: Array<ArazzoSuccessAction | ArazzoFailureAction | ArazzoReusableObject>,
  kind: 'success' | 'failure',
  components: ArazzoComponents | undefined,
  path: string,
): ActionIR[] {
  const group = kind === 'success' ? 'successActions' : 'failureActions';
  return actions.map((action, index) => {
    const aPath = `${path}/${index}`;
    const concrete = resolveReusable<ArazzoSuccessAction | ArazzoFailureAction>(action, components, group, aPath);
    // Reusable-sourced actions bypass the first validation pass — re-run the
    // full object validation so components can't smuggle in malformed actions
    validateActionObject(concrete, kind, aPath);
    return toActionIR(concrete, kind, aPath);
  });
}

function resolveParameters(
  parameters: Array<ArazzoParameter | ArazzoReusableObject>,
  components: ArazzoComponents | undefined,
  requireIn: boolean | undefined,
  path: string,
): StepParameterIR[] {
  const seen = new Set<string>();
  return parameters.map((parameter, index) => {
    const pPath = `${path}/${index}`;
    const concrete = resolveReusable<ArazzoParameter>(parameter, components, 'parameters', pPath);
    // Reusable-sourced parameters bypass the first validation pass — re-run
    // the object validation and the duplicate check on the RESOLVED list
    validateParameterObject(concrete, requireIn, pPath);
    const key = `${concrete.name} ${concrete.in ?? ''}`;
    if (seen.has(key)) {
      err(`Duplicate parameter "${concrete.name}"${concrete.in ? ` (in: ${concrete.in})` : ''}`, pPath);
    }
    seen.add(key);
    return {
      name: concrete.name,
      ...(concrete.in !== undefined && { in: concrete.in }),
      value: parseExpressionValue(concrete.value, pPath),
    };
  });
}

function parseOutputs(outputs: Record<string, string> | undefined, path: string): Record<string, RuntimeExpressionAST> | undefined {
  if (!outputs) return undefined;
  const parsed: Record<string, RuntimeExpressionAST> = {};
  for (const [name, expression] of Object.entries(outputs)) {
    parsed[name] = parseRuntimeExpression(expression, `${path}/${name}`);
  }
  return parsed;
}

async function resolveStepOperation(
  ref: { source: string; path: string; method: HTTPMethod },
  ctx: BuildContext,
  docPath: string,
): Promise<McpOpenAPITool> {
  const key = `${ref.source} ${ref.method} ${ref.path}`;
  let cached = ctx.operationCache.get(key);
  if (!cached) {
    const generator = requireGenerator(ctx.sources, ref.source, docPath);
    cached = generator.generateTool(ref.path, ref.method, ctx.generateOptions as GenerateOptions).catch((error: unknown) => {
      /* c8 ignore next -- the generator only throws Error instances */
      const message = error instanceof Error ? error.message : String(error);
      throw new ArazzoError(
        `Failed to resolve ${ref.method.toUpperCase()} ${ref.path} from source "${ref.source}": ${message}`,
        { path: docPath, source: ref.source },
      );
    });
    ctx.operationCache.set(key, cached);
  }
  return cached;
}

async function buildStepIR(step: ArazzoStep, ctx: BuildContext, path: string): Promise<WorkflowStepIR> {
  const components = ctx.doc.components;
  const base = {
    stepId: step.stepId,
    ...(step.description !== undefined && { description: step.description }),
    ...(step.parameters && {
      parameters: resolveParameters(
        step.parameters,
        components,
        step.workflowId !== undefined ? false : true,
        `${path}/parameters`,
      ),
    }),
    ...(step.successCriteria && {
      successCriteria: step.successCriteria.map((c, i) => toCriterionIR(c, `${path}/successCriteria/${i}`)),
    }),
    ...(step.onSuccess && { onSuccess: resolveActions(step.onSuccess, 'success', components, `${path}/onSuccess`) }),
    ...(step.onFailure && { onFailure: resolveActions(step.onFailure, 'failure', components, `${path}/onFailure`) }),
    ...(step.outputs && { outputs: parseOutputs(step.outputs, `${path}/outputs`) }),
  };

  if (step.workflowId !== undefined) {
    if (step.requestBody !== undefined) {
      err(`Step "${step.stepId}" invokes a workflow and must not declare a requestBody`, `${path}/requestBody`);
    }
    if (step.workflowId.startsWith('$')) {
      // $sourceDescriptions.<name>.<workflowId> targets another Arazzo doc
      err(`Step "${step.stepId}" invokes a workflow in another Arazzo document — nested Arazzo sources are not supported`, path);
    }
    if (!ctx.workflowIds.has(step.workflowId)) {
      err(`Step "${step.stepId}" references unknown workflow "${step.workflowId}"`, path);
    }
    const ir: NestedWorkflowStepIR = { kind: 'workflow', workflowId: step.workflowId, ...base };
    return ir;
  }

  const ref = resolveOperationRef(step, ctx.sources, path);
  const tool = await resolveStepOperation(ref, ctx, path);
  const operation: StepOperationIR = {
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    mapper: tool.mapper,
    ...(tool.metadata.security && { security: tool.metadata.security }),
    ...(tool.metadata.servers && { servers: tool.metadata.servers }),
  };

  let requestBody: StepRequestBodyIR | undefined;
  if (step.requestBody !== undefined) {
    if (!step.requestBody || typeof step.requestBody !== 'object') {
      err(`Step "${step.stepId}" requestBody must be an object`, `${path}/requestBody`);
    }
    requestBody = {
      ...(step.requestBody.contentType !== undefined && { contentType: step.requestBody.contentType }),
      ...(step.requestBody.payload !== undefined && { payload: step.requestBody.payload }),
    };
    const expressions = collectPayloadExpressions(step.requestBody.payload, `${path}/requestBody/payload`);
    if (expressions.length > 0) {
      requestBody.payloadExpressions = expressions;
    }
    if (step.requestBody.replacements !== undefined) {
      if (!Array.isArray(step.requestBody.replacements)) {
        err(`Step "${step.stepId}" requestBody.replacements must be an array`, `${path}/requestBody/replacements`);
      }
      requestBody.replacements = step.requestBody.replacements.map((replacement, index) => {
        const rPath = `${path}/requestBody/replacements/${index}`;
        if (!replacement || typeof replacement !== 'object' || typeof replacement.target !== 'string') {
          err('Replacement requires a string "target"', rPath);
        }
        return { target: replacement.target, value: parseExpressionValue(replacement.value, rPath) };
      });
    }
  }

  const ir: OperationStepIR = {
    kind: 'operation',
    source: ref.source,
    path: ref.path,
    method: ref.method,
    ...(ref.operationId !== undefined && { operationId: ref.operationId }),
    operation,
    ...(requestBody && { requestBody }),
    ...base,
  };
  return ir;
}

// ---------------------------------------------------------------------------
// Output schema derivation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Follow a JSON Pointer through `properties` / `items`, best-effort. */
function walkPointer(schema: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined || pointer === '') {
    return schema;
  }
  let node: unknown = schema;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    /* c8 ignore next -- schema nodes are records after toJsonSchema; guards hand-built IRs */
    if (!isRecord(node)) return undefined;
    const properties = node['properties'];
    if (isRecord(properties) && properties[segment] !== undefined) {
      node = properties[segment];
      continue;
    }
    if (/^\d+$/.test(segment) && node['items'] !== undefined && !Array.isArray(node['items'])) {
      node = node['items'];
      continue;
    }
    return undefined;
  }
  return node;
}

/** Prefer the first status variant of a ResponseBuilder `oneOf` union. */
function primaryResponseSchema(outputSchema: unknown): unknown {
  if (isRecord(outputSchema) && Array.isArray(outputSchema['oneOf'])) {
    const variants = outputSchema['oneOf'] as unknown[];
    if (variants.length > 0 && variants.every((v) => isRecord(v) && v['x-status-code'] !== undefined)) {
      return variants[0];
    }
  }
  return outputSchema;
}

function deriveOutputSchema(
  ast: RuntimeExpressionAST,
  steps: Map<string, WorkflowStepIR>,
  inputSchema: JsonSchema | undefined,
  depth: number,
  stepContext?: OperationStepIR,
): JsonSchema {
  if (depth >= OUTPUT_DERIVATION_MAX_DEPTH) {
    return {};
  }
  if (ast.type === 'statusCode') {
    return { type: 'number' };
  }
  if (ast.type === 'url' || ast.type === 'method') {
    return { type: 'string' };
  }
  if (ast.type === 'response') {
    if (ast.source !== 'body') {
      return { type: 'string' };
    }
    if (!stepContext) {
      return {};
    }
    const body = primaryResponseSchema(stepContext.operation.outputSchema);
    const target = walkPointer(body, ast.pointer);
    return isRecord(target) ? (target as JsonSchema) : {};
  }
  if (ast.type === 'inputs') {
    const properties = isRecord(inputSchema) ? inputSchema['properties'] : undefined;
    // Input names may legally contain dots — the whole remainder is the name
    const target = isRecord(properties) ? properties[ast.path.join('.')] : undefined;
    return isRecord(target) ? (target as JsonSchema) : {};
  }
  if (ast.type === 'steps' && ast.path.length >= 3 && ast.path[1] === 'outputs') {
    const step = steps.get(ast.path[0]);
    if (step?.kind === 'operation') {
      const stepOutput = step.outputs?.[ast.path.slice(2).join('.')];
      if (stepOutput) {
        return deriveOutputSchema(stepOutput, steps, inputSchema, depth + 1, step);
      }
    }
    return {};
  }
  return {};
}

function deriveOutputsSchema(
  outputs: Record<string, RuntimeExpressionAST> | undefined,
  steps: WorkflowStepIR[],
  inputSchema: JsonSchema | undefined,
): JsonSchema | undefined {
  if (!outputs) {
    return undefined;
  }
  const stepMap = new Map(steps.map((s) => [s.stepId, s]));
  const properties: Record<string, JsonSchema> = {};
  for (const [name, ast] of Object.entries(outputs)) {
    const derived = deriveOutputSchema(ast, stepMap, inputSchema, 0);
    // Deep-copy so the tool's output schema never aliases the embedded step
    // schemas inside the IR (mutating one view must not corrupt the other)
    const copied = JSON.parse(JSON.stringify(derived)) as JsonSchema;
    properties[name] = { ...copied, description: `Arazzo output: ${ast.raw}` };
  }
  // No `required`: outputs exist only after successful execution
  return { type: 'object', properties };
}

// ---------------------------------------------------------------------------
// Tool assembly
// ---------------------------------------------------------------------------

/** The exact generateTool post-pipeline: formats → depth → trims → target. */
function applySchemaPipeline(schema: JsonSchema, options: ArazzoGenerateOptions, isInputRoot: boolean): JsonSchema {
  const formatResolvers = {
    ...(options.resolveFormats ? BUILTIN_FORMAT_RESOLVERS : {}),
    ...options.formatResolvers,
  };
  let resolved = Object.keys(formatResolvers).length > 0 ? resolveSchemaFormats(schema, formatResolvers) : schema;
  resolved = SchemaBuilder.truncateDepth(resolved, Math.max(1, options.maxSchemaDepth ?? 10));
  if (options.stripExamples) resolved = SchemaBuilder.stripExamples(resolved);
  if (options.maxDescriptionLength !== undefined) {
    resolved = SchemaBuilder.capDescriptions(resolved, options.maxDescriptionLength);
  }
  if (options.maxProperties !== undefined) {
    if (isInputRoot) {
      const properties = resolved.properties;
      if (properties && typeof properties === 'object') {
        const limited: Record<string, JsonSchema> = {};
        for (const [key, value] of Object.entries(properties)) {
          limited[key] = SchemaBuilder.limitProperties(value as JsonSchema, options.maxProperties);
        }
        resolved = { ...resolved, properties: limited };
      }
    } else {
      resolved = SchemaBuilder.limitProperties(resolved, options.maxProperties);
    }
  }
  if (options.target) {
    resolved = applyClientTarget(resolved, options.target);
  }
  return resolved;
}

function buildWorkflowTool(
  workflow: ArazzoWorkflow,
  stepIRs: WorkflowStepIR[],
  ctx: BuildContext,
  wPath: string,
): McpOpenAPITool {
  const options = ctx.generateOptions;

  // Input schema: workflow inputs → components refs resolved → normalized
  let inputSchema: JsonSchema;
  let rawInputSchema: JsonSchema | undefined;
  if (workflow.inputs !== undefined) {
    const resolved = resolveInputRefs(workflow.inputs, ctx.doc.components, `${wPath}/inputs`, new Set());
    rawInputSchema = toJsonSchema(resolved as SchemaObject);
    inputSchema = applySchemaPipeline(rawInputSchema, options, true);
  } else {
    inputSchema = { type: 'object', properties: {} };
  }

  const derivedOutput = deriveOutputsSchema(parseOutputs(workflow.outputs, `${wPath}/outputs`), stepIRs, rawInputSchema);
  const outputSchema = derivedOutput ? applySchemaPipeline(derivedOutput, options, false) : undefined;

  const name = normalizeToolName(workflow.workflowId, options.maxToolNameLength ?? 64, workflow.workflowId);
  const description =
    workflow.summary && workflow.description
      ? `${workflow.summary}\n\n${workflow.description}`
      : (workflow.summary ?? workflow.description ?? `Arazzo workflow: ${workflow.workflowId}`);

  // Read-only iff every step is an operation step on a safe method
  const operationSteps = stepIRs.filter((s): s is OperationStepIR => s.kind === 'operation');
  const allReadOnly =
    operationSteps.length === stepIRs.length &&
    operationSteps.every((s) => inferAnnotationsFromMethod(s.method).readOnlyHint === true);

  // Deduped union of every step's security requirements
  const security: SecurityRequirement[] = [];
  const seenSecurity = new Set<string>();
  for (const step of operationSteps) {
    for (const requirement of step.operation.security ?? []) {
      const key = JSON.stringify(requirement);
      if (!seenSecurity.has(key)) {
        seenSecurity.add(key);
        security.push(requirement);
      }
    }
  }

  const ir: WorkflowIR = {
    arazzoVersion: ctx.doc.arazzo,
    workflowId: workflow.workflowId,
    ...(workflow.summary !== undefined && { summary: workflow.summary }),
    ...(workflow.description !== undefined && { description: workflow.description }),
    ...(rawInputSchema !== undefined && { inputSchema: rawInputSchema }),
    ...(workflow.dependsOn && { dependsOn: workflow.dependsOn }),
    ...(workflow.parameters && {
      parameters: resolveParameters(workflow.parameters, ctx.doc.components, undefined, `${wPath}/parameters`),
    }),
    steps: stepIRs,
    ...(workflow.successActions && {
      successActions: resolveActions(workflow.successActions, 'success', ctx.doc.components, `${wPath}/successActions`),
    }),
    ...(workflow.failureActions && {
      failureActions: resolveActions(workflow.failureActions, 'failure', ctx.doc.components, `${wPath}/failureActions`),
    }),
    ...(workflow.outputs && { outputs: parseOutputs(workflow.outputs, `${wPath}/outputs`) }),
  };

  const tool: McpOpenAPITool = {
    name,
    ...(workflow.summary !== undefined && { title: workflow.summary }),
    description,
    ...(allReadOnly && {
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }),
    inputSchema,
    outputSchema,
    // A workflow tool has no single HTTP shape — each step's mapper lives at
    // metadata.workflow.steps[*].operation.mapper
    mapper: [],
    metadata: {
      path: `arazzo:${workflow.workflowId}`,
      method: 'post',
      operationId: workflow.workflowId,
      ...(workflow.summary !== undefined && { operationSummary: workflow.summary }),
      ...(workflow.description !== undefined && { operationDescription: workflow.description }),
      ...(security.length > 0 && { security }),
      workflow: ir,
    },
  };

  if (options.emitTypeSignatures) {
    tool.metadata.typescript = emitToolTypeScript(name, description, inputSchema, outputSchema, {
      maxDepth: Math.max(1, options.maxSchemaDepth ?? 10),
    });
  }
  return tool;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Convert an Arazzo 1.0 workflow document (object or YAML/JSON string) into
 * consolidated MCP tools — one per workflow, in document order. Source URLs
 * are never fetched; supply every used source via `options.sources`. Throws
 * `ArazzoError` (with a JSON-Pointer `path`) on malformed documents,
 * unresolvable references, or cyclic workflows.
 */
export async function fromArazzo(document: ArazzoDocument | string, options: FromArazzoOptions): Promise<McpOpenAPITool[]> {
  const doc = parseArazzoInput(document);
  validateDocument(doc);

  const sources = await prepareSources(doc, options);
  const workflowIds = new Set(doc.workflows.map((w) => w.workflowId));

  // dependsOn edges and nested workflowId-step edges must both be acyclic
  const dependsEdges = new Map<string, string[]>();
  const nestedEdges = new Map<string, string[]>();
  const declaredSources = new Set(doc.sourceDescriptions.map((s) => s.name));
  doc.workflows.forEach((workflow, index) => {
    if (workflow.dependsOn !== undefined && !Array.isArray(workflow.dependsOn)) {
      err(`Workflow "${workflow.workflowId}" dependsOn must be an array of workflowIds`, `/workflows/${index}/dependsOn`);
    }
    const localTargets: string[] = [];
    for (const target of workflow.dependsOn ?? []) {
      if (typeof target !== 'string') {
        err(`Workflow "${workflow.workflowId}" dependsOn entries must be strings`, `/workflows/${index}/dependsOn`);
      }
      if (target.startsWith('$')) {
        // Cross-document form (spec-mandated for external workflows):
        // $sourceDescriptions.<name>.<workflowId> — carried verbatim in the
        // IR, outside the local cycle graph
        const ast = parseRuntimeExpression(target, `/workflows/${index}/dependsOn`);
        if (ast.type !== 'sourceDescriptions' || ast.path.length < 2 || !declaredSources.has(ast.path[0])) {
          err(
            `Workflow "${workflow.workflowId}" dependsOn "${target}" must reference a declared source ($sourceDescriptions.<name>.<workflowId>)`,
            `/workflows/${index}/dependsOn`,
          );
        }
        continue;
      }
      if (!workflowIds.has(target)) {
        err(`Workflow "${workflow.workflowId}" dependsOn unknown workflow "${target}"`, `/workflows/${index}/dependsOn`);
      }
      localTargets.push(target);
    }
    dependsEdges.set(workflow.workflowId, localTargets);
    nestedEdges.set(
      workflow.workflowId,
      workflow.steps
        .filter((s) => s.workflowId !== undefined && !s.workflowId.startsWith('$'))
        .map((s) => s.workflowId as string),
    );
  });
  checkCycles(dependsEdges, 'dependsOn chain');
  checkCycles(nestedEdges, 'workflow invocation');

  const ctx: BuildContext = {
    doc,
    sources,
    generateOptions: options.generateOptions ?? {},
    workflowIds,
    operationCache: new Map(),
  };

  const tools: McpOpenAPITool[] = [];
  const usedNames = new Set<string>();
  for (let wIndex = 0; wIndex < doc.workflows.length; wIndex++) {
    const workflow = doc.workflows[wIndex];
    const wPath = `/workflows/${wIndex}`;
    const stepIRs: WorkflowStepIR[] = [];
    for (let sIndex = 0; sIndex < workflow.steps.length; sIndex++) {
      stepIRs.push(await buildStepIR(workflow.steps[sIndex], ctx, `${wPath}/steps/${sIndex}`));
    }
    let tool = buildWorkflowTool(workflow, stepIRs, ctx, wPath);
    // Distinct workflowIds can still normalize to the same name (`_flow` and
    // `flow` both become `flow`) — dedupe with the generator's hash pattern.
    if (usedNames.has(tool.name)) {
      const maxLength = ctx.generateOptions.maxToolNameLength ?? 64;
      let seed = workflow.workflowId;
      let deduped = normalizeToolName(`${tool.name}_${fnv1aHex(seed)}`, maxLength, seed);
      /* c8 ignore next 4 -- reachable only via an fnv1a hash collision between distinct ids */
      while (usedNames.has(deduped)) {
        seed += '#';
        deduped = normalizeToolName(`${tool.name}_${fnv1aHex(seed)}`, maxLength, seed);
      }
      tool = { ...tool, name: deduped };
    }
    usedNames.add(tool.name);
    tools.push(tool);
  }
  return tools;
}
