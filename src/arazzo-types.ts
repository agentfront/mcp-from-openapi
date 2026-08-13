/**
 * Arazzo 1.0 document and workflow-IR type definitions.
 *
 * The document types cover the subset of the Arazzo Specification 1.0
 * (https://spec.openapis.org/arazzo/v1.0.0.html) that `fromArazzo()` reads.
 * The IR types describe the pure, JSON-serializable workflow representation
 * embedded on `metadata.workflow` — executors drive HTTP from it and never
 * need a second spec pass. This library never executes steps or evaluates
 * criteria.
 */
import type { HTTPMethod, JsonSchema, ParameterMapper, SchemaObject, SecurityRequirement, ServerInfo } from './types';

// ---------------------------------------------------------------------------
// Arazzo document subset
// ---------------------------------------------------------------------------

/** Arazzo `info` object. */
export interface ArazzoInfo {
  title: string;
  summary?: string;
  description?: string;
  version: string;
}

/** A source description entry (`sourceDescriptions[]`). */
export interface ArazzoSourceDescription {
  /** Unique name matching `[A-Za-z0-9_-]+`. */
  name: string;
  /** URL/location of the source document — never fetched by this library. */
  url: string;
  type?: 'openapi' | 'arazzo';
}

/** Root Arazzo 1.0 document. */
export interface ArazzoDocument {
  /** Version string matching `1.0.x`. */
  arazzo: string;
  info: ArazzoInfo;
  sourceDescriptions: ArazzoSourceDescription[];
  workflows: ArazzoWorkflow[];
  components?: ArazzoComponents;
}

/** A workflow (`workflows[]`). */
export interface ArazzoWorkflow {
  /** Unique id matching `[A-Za-z0-9_-]+`. */
  workflowId: string;
  summary?: string;
  description?: string;
  /** JSON Schema for workflow inputs; may `$ref` into `#/components/inputs`. */
  inputs?: SchemaObject;
  dependsOn?: string[];
  steps: ArazzoStep[];
  successActions?: Array<ArazzoSuccessAction | ArazzoReusableObject>;
  failureActions?: Array<ArazzoFailureAction | ArazzoReusableObject>;
  /** Output name → runtime expression. */
  outputs?: Record<string, string>;
  parameters?: Array<ArazzoParameter | ArazzoReusableObject>;
}

/** A step: exactly one of `operationId` / `operationPath` / `workflowId`. */
export interface ArazzoStep {
  /** Unique id within the workflow, matching `[A-Za-z0-9_-]+`. */
  stepId: string;
  description?: string;
  operationId?: string;
  operationPath?: string;
  workflowId?: string;
  parameters?: Array<ArazzoParameter | ArazzoReusableObject>;
  requestBody?: ArazzoRequestBody;
  successCriteria?: ArazzoCriterion[];
  onSuccess?: Array<ArazzoSuccessAction | ArazzoReusableObject>;
  onFailure?: Array<ArazzoFailureAction | ArazzoReusableObject>;
  /** Output name → runtime expression. */
  outputs?: Record<string, string>;
}

/** A parameter applied to a step or workflow. */
export interface ArazzoParameter {
  name: string;
  /** Required for operation steps; forbidden on workflowId steps. */
  in?: 'path' | 'query' | 'header' | 'cookie';
  /** Literal value or runtime expression (string form). */
  value: unknown;
}

/** Step request body. */
export interface ArazzoRequestBody {
  contentType?: string;
  /** Literal payload; strings may embed `{$...}` template expressions. */
  payload?: unknown;
  replacements?: ArazzoPayloadReplacement[];
}

/** A targeted replacement inside `payload`. */
export interface ArazzoPayloadReplacement {
  /** JSON Pointer (or XPath for XML payloads) into the payload. */
  target: string;
  value: unknown;
}

/** Criterion `type`: shorthand or the Criterion Expression Type Object. */
export type ArazzoCriterionType = 'simple' | 'regex' | 'jsonpath' | 'xpath' | { type: 'jsonpath' | 'xpath'; version: string };

/** A success criterion — this library never evaluates conditions. */
export interface ArazzoCriterion {
  /** Runtime expression providing evaluation context (required for non-simple types). */
  context?: string;
  condition: string;
  type?: ArazzoCriterionType;
}

/** `onSuccess` / workflow `successActions` entry. */
export interface ArazzoSuccessAction {
  name: string;
  type: 'end' | 'goto';
  workflowId?: string;
  stepId?: string;
  criteria?: ArazzoCriterion[];
}

/** `onFailure` / workflow `failureActions` entry. */
export interface ArazzoFailureAction {
  name: string;
  type: 'end' | 'retry' | 'goto';
  workflowId?: string;
  stepId?: string;
  /** Seconds to wait before retrying. */
  retryAfter?: number;
  retryLimit?: number;
  criteria?: ArazzoCriterion[];
}

/** Reusable Object: a `$components.…` reference with an optional value override. */
export interface ArazzoReusableObject {
  /** Runtime expression, e.g. `$components.parameters.page`. */
  reference: string;
  /** Overrides the referenced parameter's `value`. */
  value?: unknown;
}

/** Arazzo `components`. */
export interface ArazzoComponents {
  inputs?: Record<string, SchemaObject>;
  parameters?: Record<string, ArazzoParameter>;
  successActions?: Record<string, ArazzoSuccessAction>;
  failureActions?: Record<string, ArazzoFailureAction>;
}

// ---------------------------------------------------------------------------
// Runtime expressions
// ---------------------------------------------------------------------------

/** Root of a parsed runtime expression. */
export type RuntimeExpressionType =
  | 'url'
  | 'method'
  | 'statusCode'
  | 'request'
  | 'response'
  | 'message'
  | 'inputs'
  | 'outputs'
  | 'steps'
  | 'workflows'
  | 'sourceDescriptions'
  | 'components';

/**
 * Structured form of an Arazzo runtime expression. `raw` always preserves
 * the exact original text.
 */
export interface RuntimeExpressionAST {
  type: RuntimeExpressionType;
  raw: string;
  /** Dot segments after the root: `$steps.s1.outputs.id` → `['s1','outputs','id']`. */
  path: string[];
  /** For `request` / `response` roots: which part is referenced. */
  source?: 'header' | 'query' | 'path' | 'body';
  /** Header/query/path parameter name for `request` / `response` source refs. */
  name?: string;
  /** JSON Pointer after `#` on body refs: `$response.body#/items/0/id` → `/items/0/id`. */
  pointer?: string;
}

/** A value that is a literal, a whole expression, or a `{$...}`-templated string. */
export type ExpressionValueIR =
  | { kind: 'literal'; value: unknown }
  | { kind: 'expression'; expression: RuntimeExpressionAST }
  | { kind: 'template'; raw: string; parts: Array<string | RuntimeExpressionAST> };

// ---------------------------------------------------------------------------
// Workflow IR
// ---------------------------------------------------------------------------

/** A parameter in the IR — components inlined, value parsed. */
export interface StepParameterIR {
  name: string;
  in?: 'path' | 'query' | 'header' | 'cookie';
  value: ExpressionValueIR;
}

/** A criterion in the IR — the condition is raw text, never evaluated. */
export interface CriterionIR {
  context?: RuntimeExpressionAST;
  condition: string;
  type: 'simple' | 'regex' | 'jsonpath' | 'xpath';
  /** Present when the document used a Criterion Expression Type Object. */
  version?: string;
}

/** A flow action in the IR (success or failure family). */
export interface ActionIR {
  name: string;
  kind: 'success' | 'failure';
  type: 'end' | 'goto' | 'retry';
  workflowId?: string;
  stepId?: string;
  retryAfter?: number;
  retryLimit?: number;
  criteria?: CriterionIR[];
}

/** An expression located inside a request payload (RFC 6901 pointer). */
export interface PayloadExpressionIR {
  /** `''` means the whole payload is the expression value. */
  pointer: string;
  value: ExpressionValueIR;
}

/** A `replacements[]` entry in the IR. */
export interface PayloadReplacementIR {
  target: string;
  value: ExpressionValueIR;
}

/** Step request body in the IR: verbatim payload + located substitutions. */
export interface StepRequestBodyIR {
  contentType?: string;
  payload?: unknown;
  payloadExpressions?: PayloadExpressionIR[];
  replacements?: PayloadReplacementIR[];
}

/**
 * Embedded essentials of a step's resolved operation — the subset of the
 * per-operation tool an executor needs (`mapper` feeds `buildHttpRequest`).
 */
export interface StepOperationIR {
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  mapper: ParameterMapper[];
  security?: SecurityRequirement[];
  servers?: ServerInfo[];
}

interface StepIRBase {
  stepId: string;
  description?: string;
  parameters?: StepParameterIR[];
  successCriteria?: CriterionIR[];
  onSuccess?: ActionIR[];
  onFailure?: ActionIR[];
  outputs?: Record<string, RuntimeExpressionAST>;
}

/** A step that invokes one HTTP operation from a source description. */
export interface OperationStepIR extends StepIRBase {
  kind: 'operation';
  /** Source description name the operation was resolved from. */
  source: string;
  /** OpenAPI path in that source. */
  path: string;
  method: HTTPMethod;
  operationId?: string;
  operation: StepOperationIR;
  requestBody?: StepRequestBodyIR;
}

/** A step that invokes another workflow in the same Arazzo document. */
export interface NestedWorkflowStepIR extends StepIRBase {
  kind: 'workflow';
  workflowId: string;
}

/** Discriminated step union (`kind`). */
export type WorkflowStepIR = OperationStepIR | NestedWorkflowStepIR;

/** The complete serializable workflow IR carried on `metadata.workflow`. */
export interface WorkflowIR {
  /** The document's `arazzo` version, e.g. `'1.0.0'`. */
  arazzoVersion: string;
  workflowId: string;
  summary?: string;
  description?: string;
  /** Normalized workflow inputs (components `$ref`s resolved). */
  inputSchema?: JsonSchema;
  dependsOn?: string[];
  parameters?: StepParameterIR[];
  steps: WorkflowStepIR[];
  successActions?: ActionIR[];
  failureActions?: ActionIR[];
  outputs?: Record<string, RuntimeExpressionAST>;
}
