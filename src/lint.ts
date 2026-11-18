import type { ParameterObject } from './types';
import { isReferenceObject } from './types';
import { analyzeParameters } from './parameter-resolver';
import {
  MAX_CONVERSION_ENTRIES,
  detectSpecVersion,
  isSpecObject,
  isSwagger2,
  listOperations,
  ownProperty,
  resolveOperationLayout,
  upgradeSwagger2,
  wireMethod,
} from './spec';

export type LintSeverity = 'error' | 'warning' | 'info';

/**
 * One agent-readiness finding. `path` names the operation (`GET /users`), or
 * is empty for a finding about the whole document;
 * `hint` says how to fix it — in the spec or via generate options/overlays.
 */
export interface LintFinding {
  severity: LintSeverity;
  /** Stable kebab-case finding code */
  code: string;
  message: string;
  path: string;
  hint?: string;
}

export interface LintResult {
  /** Sorted: errors first, then warnings, then infos; by path within each */
  findings: LintFinding[];
  counts: { error: number; warning: number; info: number };
}

/** Query-parameter names that read as pagination controls (shared with response hints) */
export const PAGINATION_PARAM = /^(page|limit|offset|cursor|per_page|pagesize|page_size|after|before)$/i;

/** Nesting depth beyond which schemas measurably hurt agent accuracy */
const DEEP_SCHEMA_THRESHOLD = 8;

/** Property count beyond which a single object bloats the context window */
const WIDE_SCHEMA_THRESHOLD = 30;

interface SchemaShape {
  depth: number;
  widestObject: number;
  hasArray: boolean;
}

/**
 * The child schemas the lint walks visit, in order: property VALUES (a
 * property merely NAMED 'example' is not one), single or tuple schemas, and
 * composition members. Holes are skipped, as with `forEach`.
 */
function schemaChildren(record: Record<string, unknown>): unknown[] {
  const children: unknown[] = [];
  const properties = record['properties'];
  if (properties && typeof properties === 'object') {
    for (const child of Object.values(properties)) children.push(child);
  }
  for (const key of ['items', 'additionalProperties', 'not', 'contentSchema']) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) children.push(value);
    if (Array.isArray(value)) value.forEach((item) => children.push(item));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const value = record[key];
    if (Array.isArray(value)) value.forEach((member) => children.push(member));
  }
  return children;
}

/** A schema being measured: its own counts, then each child's merged in as it finishes. */
interface MeasureFrame {
  node: object;
  children: unknown[];
  next: number;
  childDepth: number;
  widestObject: number;
  hasArray: boolean;
}

/**
 * Measure a schema's nesting depth and widest object — cycle-safe AND
 * shared-node-correct: dereferenced documents reuse ONE object per component,
 * so repeat visits return the memoized shape instead of zeros (only a true
 * cycle — an in-progress ancestor — measures as empty). Walks with an explicit
 * stack, depth-first, so a schema of any depth can be measured (issue #50).
 */
function measureSchema(root: unknown): SchemaShape {
  const seen = new Map<unknown, SchemaShape | null>();
  const frames: MeasureFrame[] = [];
  // A node's shape when known right away, else `undefined` with a frame pushed
  const enter = (node: unknown): SchemaShape | undefined => {
    if (node === null || typeof node !== 'object') {
      return { depth: 0, widestObject: 0, hasArray: false };
    }
    if (seen.has(node)) {
      // null marks an in-progress ancestor (a real cycle); a value is a memo hit
      return seen.get(node) ?? { depth: 0, widestObject: 0, hasArray: false };
    }
    seen.set(node, null);
    const record = node as Record<string, unknown>;
    const properties = record['properties'];
    frames.push({
      node,
      children: schemaChildren(record),
      next: 0,
      childDepth: 0,
      widestObject: properties && typeof properties === 'object' ? Object.keys(properties).length : 0,
      hasArray: record['type'] === 'array' || (Array.isArray(record['type']) && record['type'].includes('array')),
    });
    return undefined;
  };

  let shape = enter(root);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (shape) {
      // The child before `next` is measured
      frame.childDepth = Math.max(frame.childDepth, shape.depth);
      frame.widestObject = Math.max(frame.widestObject, shape.widestObject);
      frame.hasArray = frame.hasArray || shape.hasArray;
    }
    if (frame.next < frame.children.length) {
      shape = enter(frame.children[frame.next++]);
      continue;
    }
    frames.pop();
    shape = { depth: frame.childDepth + 1, widestObject: frame.widestObject, hasArray: frame.hasArray };
    seen.set(frame.node, shape);
  }
  return shape!;
}

/** Does a schema tree carry an `example`/`examples` keyword anywhere? Cycle-safe, any depth. */
function schemaHasExample(root: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (record['example'] !== undefined || record['examples'] !== undefined) return true;
    // Reversed, so children are searched in order
    const children = schemaChildren(record);
    for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
  }
  return false;
}

/** Does any media type in the map carry an example (media- or schema-level)? */
function hasAnyExample(content: Record<string, unknown> | undefined): boolean {
  /* c8 ignore next -- defensive: the only caller guards with `bodyContent &&` */
  if (!content) return false;
  return Object.values(content).some((media) => {
    if (!media || typeof media !== 'object') return false;
    const record = media as Record<string, unknown>;
    if (record['example'] !== undefined || record['examples'] !== undefined) return true;
    return schemaHasExample(record['schema']);
  });
}

/** What lint reads from the parameters that apply to an operation, for the path item list it was merged with */
interface ParameterSummary {
  /** The path item's `parameters` value */
  pathLevel: unknown;
  /** The names of the parameters without a description */
  undescribed: string[];
  /** Whether a query parameter names pagination */
  paginated: boolean;
}

/** At most this many names are listed in a message */
const LISTED_NAMES = 10;

/** `names` for a message, at most `LISTED_NAMES` of them: `a, b, c and 7 more` */
function listNames(names: string[]): string {
  const listed = names.slice(0, LISTED_NAMES).join(', ');
  return names.length > LISTED_NAMES ? `${listed} and ${names.length - LISTED_NAMES} more` : listed;
}

/**
 * The Parameter Objects of a `parameters` value. A document being linted may
 * be imperfect, so anything that is not an array of objects is skipped, as is
 * each entry that is not an object or is a Reference Object.
 */
function readParameters(value: unknown): ParameterObject[] {
  return Array.isArray(value)
    ? value.filter((param): param is ParameterObject => isSpecObject(param) && !isReferenceObject(param))
    : [];
}

/**
 * Lint an OpenAPI document for agent-readiness: the spec-quality gaps that
 * measurably degrade tool-calling accuracy (missing operationIds, absent or
 * vague descriptions, unpaginated list endpoints, oversized schemas, missing
 * examples). Small spec fixes routinely take tool-call success rates from
 * mediocre to near-perfect — each finding carries a concrete hint.
 *
 * Meant for imperfect documents: a value that cannot be read (a path item, a
 * `parameters` list, a parameter that is not an object, ...) is skipped
 * rather than failing. It lints the operations the generator generates: the
 * ones the declared version has (`query` and `additionalOperations` from
 * OpenAPI 3.2; the eight historical methods when the version is older,
 * missing or malformed).
 *
 * A Swagger 2.0 document is converted to OpenAPI 3.0 first (`upgradeSwagger2`,
 * whose diagnostics are not reported here), so its findings are those of the
 * tools it generates; pass it dereferenced, as `generator.lint()` does: a
 * `$ref` left in it is not followed. A conversion abandoned at
 * `MAX_CONVERSION_ENTRIES` leaves no operation to lint: the result is one
 * `swagger-conversion-too-large` error about the whole document (path `''`),
 * so it never reads as a clean document (`generator.lint()` throws the
 * `ParseError` generation throws instead).
 */
export function lintDocument(document: object): LintResult {
  if (isSwagger2(document)) {
    const upgraded = upgradeSwagger2(document);
    if (upgraded.tooLarge) return lintResult([conversionTooLarge()]);
    return lintDocument(upgraded.document);
  }
  const findings: LintFinding[] = [];
  const operationIds = new Map<string, string[]>();
  // What paths sharing a path item (a `$ref`) share is measured once: its operations' parameters, and schemas
  const shapes = new WeakMap<object, SchemaShape>();
  const measure = (schema: unknown): SchemaShape => {
    if (schema === null || typeof schema !== 'object') return measureSchema(schema);
    const shape = shapes.get(schema) ?? measureSchema(schema);
    shapes.set(schema, shape);
    return shape;
  };
  const parameterSummaries = new WeakMap<object, ParameterSummary>();
  const summarizeParameters = (operation: object, pathLevel: unknown): ParameterSummary => {
    const known = parameterSummaries.get(operation);
    if (known !== undefined && known.pathLevel === pathLevel) return known;
    // The parameters that apply, merged exactly as generation merges them (an operation parameter
    // overrides the path-level one with the same name and location)
    const parameters = readParameters(
      analyzeParameters(readParameters(pathLevel), readParameters(ownProperty(operation, 'parameters'))).effective.map(
        (slot) => slot.parameter,
      ),
    );
    const summary: ParameterSummary = {
      pathLevel,
      undescribed: parameters.filter((param) => !param.description).map((param) => param.name),
      paginated: parameters.some((param) => param.in === 'query' && PAGINATION_PARAM.test(param.name)),
    };
    parameterSummaries.set(operation, summary);
    return summary;
  };

  const layout = resolveOperationLayout(detectSpecVersion(document));
  const paths = ownProperty(document, 'paths');
  for (const [pathStr, pathItem] of Object.entries(isSpecObject(paths) ? paths : {}).sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    if (!isSpecObject(pathItem) || '$ref' in pathItem) continue;

    // Path-item-level parameters apply to every operation (the generator
    // merges them the same way) — lint must see them too.
    const pathLevelParameters = ownProperty(pathItem, 'parameters');

    for (const { method, operation } of listOperations(pathItem, { layout }).operations) {
      const wire = wireMethod(method);
      const label = `${wire} ${pathStr}`;

      // operationId presence + duplicates
      const operationId = typeof operation.operationId === 'string' ? operation.operationId : '';
      if (!operationId) {
        findings.push({
          severity: 'warning',
          code: 'missing-operation-id',
          message: 'Operation has no operationId; the tool name will be generated from the method and path.',
          path: label,
          hint: 'Add a short, action-oriented operationId (it becomes the tool name).',
        });
      } else {
        const existing = operationIds.get(operationId) ?? [];
        existing.push(label);
        operationIds.set(operationId, existing);
        if (operationId.length > 64) {
          findings.push({
            severity: 'info',
            code: 'long-operation-id',
            message: `operationId '${operationId.slice(0, 40)}…' exceeds 64 characters and will be truncated with a hash suffix.`,
            path: label,
            hint: 'Shorten the operationId below 64 characters to keep tool names readable.',
          });
        }
      }

      // description quality
      const prose = `${operation.summary ?? ''} ${operation.description ?? ''}`.trim();
      if (prose.length === 0) {
        findings.push({
          severity: 'warning',
          code: 'missing-description',
          message: 'Operation has neither summary nor description; the model only sees the method and path.',
          path: label,
          hint: 'Describe WHEN to use this operation and what it returns (or patch it in with an overlay).',
        });
      } else if (prose.length < 20) {
        findings.push({
          severity: 'info',
          code: 'vague-description',
          message: `Operation description is only ${prose.length} characters — likely too vague for reliable tool selection.`,
          path: label,
          hint: 'Expand the description with the use case and key parameters.',
        });
      }

      // parameter descriptions
      const parameters = summarizeParameters(operation, pathLevelParameters);
      if (parameters.undescribed.length > 0) {
        findings.push({
          severity: 'info',
          code: 'missing-parameter-description',
          message: `Parameter(s) without description: ${listNames(parameters.undescribed)}.`,
          path: label,
          hint: 'Describe each parameter — models mis-fill undocumented arguments.',
        });
      }

      // success response presence + list-endpoint pagination
      const responses = (operation.responses ?? {}) as Record<string, unknown>;
      const successCodes = Object.keys(responses).filter((code) => /^2(\d\d|XX)$/i.test(code));
      if (successCodes.length === 0 && !responses['default']) {
        findings.push({
          severity: 'warning',
          code: 'missing-success-response',
          message: 'Operation declares no 2xx or default response; no output schema can be generated.',
          path: label,
          hint: 'Add the success response with its schema.',
        });
      }

      let responseShape: SchemaShape = { depth: 0, widestObject: 0, hasArray: false };
      for (const code of [...successCodes, 'default']) {
        const response = responses[code];
        if (!response || typeof response !== 'object' || isReferenceObject(response)) continue;
        const content = (response as Record<string, unknown>)['content'] as Record<string, unknown> | undefined;
        if (!content) continue;
        for (const media of Object.values(content)) {
          const schema = media && typeof media === 'object' ? (media as Record<string, unknown>)['schema'] : undefined;
          const shape = measure(schema);
          responseShape = {
            depth: Math.max(responseShape.depth, shape.depth),
            widestObject: Math.max(responseShape.widestObject, shape.widestObject),
            hasArray: responseShape.hasArray || shape.hasArray,
          };
        }
      }

      // GET and QUERY are the safe reads
      if ((method === 'get' || method === 'query') && responseShape.hasArray) {
        if (!parameters.paginated) {
          findings.push({
            severity: 'warning',
            code: 'unpaginated-list',
            message: `${wire} returns an array but declares no pagination parameter — responses can blow past client result limits (Claude Code caps tool results at 25K tokens).`,
            path: label,
            hint: 'Add limit/cursor/page parameters, or shape responses at the server.',
          });
        }
      }

      // schema size (request + response)
      const body = operation.requestBody;
      const bodyContent =
        body && !isReferenceObject(body) ? (body.content as Record<string, unknown> | undefined) : undefined;
      let requestShape: SchemaShape = { depth: 0, widestObject: 0, hasArray: false };
      for (const media of Object.values(bodyContent ?? {})) {
        const schema = media && typeof media === 'object' ? (media as Record<string, unknown>)['schema'] : undefined;
        const shape = measure(schema);
        requestShape = {
          depth: Math.max(requestShape.depth, shape.depth),
          widestObject: Math.max(requestShape.widestObject, shape.widestObject),
          hasArray: requestShape.hasArray || shape.hasArray,
        };
      }

      const maxDepth = Math.max(requestShape.depth, responseShape.depth);
      if (maxDepth > DEEP_SCHEMA_THRESHOLD) {
        findings.push({
          severity: 'warning',
          code: 'deep-schema',
          message: `Schema nesting reaches depth ${maxDepth} (threshold ${DEEP_SCHEMA_THRESHOLD}) — deep schemas cost tokens and reduce accuracy.`,
          path: label,
          hint: 'Flatten the schema, or bound generation with maxSchemaDepth.',
        });
      }
      const maxWidth = Math.max(requestShape.widestObject, responseShape.widestObject);
      if (maxWidth > WIDE_SCHEMA_THRESHOLD) {
        findings.push({
          severity: 'info',
          code: 'wide-schema',
          message: `An object schema declares ${maxWidth} properties (threshold ${WIDE_SCHEMA_THRESHOLD}).`,
          path: label,
          hint: 'Split the payload, or bound generation with maxProperties.',
        });
      }

      // request-body examples
      if (bodyContent && !hasAnyExample(bodyContent)) {
        findings.push({
          severity: 'info',
          code: 'missing-request-example',
          message: 'Request body has no example — examples measurably improve complex-parameter accuracy.',
          path: label,
          hint: 'Add a media-type example (and enable includeExamples), or patch one in with an overlay.',
        });
      }
    }
  }

  for (const [operationId, labels] of operationIds) {
    if (labels.length > 1) {
      findings.push({
        severity: 'error',
        code: 'duplicate-operation-id',
        message: `operationId '${operationId}' is used by ${labels.length} operations: ${listNames(labels)}.`,
        path: labels[0],
        hint: 'Make operationIds unique — duplicates force hash-suffixed tool names.',
      });
    }
  }

  return lintResult(findings);
}

/** The finding for a Swagger 2.0 document whose conversion was abandoned: nothing of it could be linted. */
function conversionTooLarge(): LintFinding {
  return {
    severity: 'error',
    code: 'swagger-conversion-too-large',
    message:
      `The Swagger 2.0 document cannot be converted to OpenAPI 3.0: it needs more than ${MAX_CONVERSION_ENTRIES} media ` +
      'type, encoding, header and form property entries (MAX_CONVERSION_ENTRIES), as its `consumes`, `produces` and ' +
      'path-level parameters apply to every operation. No operation was linted, and no tool can be generated from it.',
    path: '',
    hint: 'Shorten the root `consumes`/`produces` lists (or give the operations their own), or convert the document to OpenAPI 3 first.',
  };
}

/** Sorts the findings (errors first, then warnings, then infos; by path, then code) and counts them. */
function lintResult(findings: LintFinding[]): LintResult {
  const rank: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.code < b.code ? -1 : 1),
  );

  return {
    findings,
    counts: {
      error: findings.filter((f) => f.severity === 'error').length,
      warning: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
    },
  };
}
