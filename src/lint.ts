import type { HTTPMethod, OpenAPIDocument, OperationObject, ParameterObject } from './types';
import { isReferenceObject } from './types';

export type LintSeverity = 'error' | 'warning' | 'info';

/**
 * One agent-readiness finding. `path` names the operation (`GET /users`);
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

const METHODS: HTTPMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

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

/** Measure a schema's nesting depth and widest object — cycle-safe. */
function measureSchema(node: unknown, seen = new Set<unknown>()): SchemaShape {
  if (node === null || typeof node !== 'object' || seen.has(node)) {
    return { depth: 0, widestObject: 0, hasArray: false };
  }
  seen.add(node);
  const record = node as Record<string, unknown>;
  let childDepth = 0;
  let widestObject = 0;
  let hasArray = record['type'] === 'array' || (Array.isArray(record['type']) && record['type'].includes('array'));

  const visit = (child: unknown): void => {
    const shape = measureSchema(child, seen);
    childDepth = Math.max(childDepth, shape.depth);
    widestObject = Math.max(widestObject, shape.widestObject);
    hasArray = hasArray || shape.hasArray;
  };

  const properties = record['properties'];
  if (properties && typeof properties === 'object') {
    widestObject = Math.max(widestObject, Object.keys(properties).length);
    for (const child of Object.values(properties)) visit(child);
  }
  for (const key of ['items', 'additionalProperties', 'not', 'contentSchema']) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) visit(value);
    if (Array.isArray(value)) value.forEach(visit);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const value = record[key];
    if (Array.isArray(value)) value.forEach(visit);
  }

  return { depth: childDepth + 1, widestObject, hasArray };
}

/** Does a schema tree carry an `example`/`examples` keyword anywhere? Cycle-safe. */
function schemaHasExample(node: unknown, seen = new Set<unknown>()): boolean {
  if (node === null || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  const record = node as Record<string, unknown>;
  if (record['example'] !== undefined || record['examples'] !== undefined) return true;

  const properties = record['properties'];
  if (properties && typeof properties === 'object') {
    // walk property VALUES only — a property merely NAMED 'example' is not one
    if (Object.values(properties).some((child) => schemaHasExample(child, seen))) return true;
  }
  for (const key of ['items', 'additionalProperties', 'not', 'contentSchema']) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && schemaHasExample(value, seen)) return true;
    if (Array.isArray(value) && value.some((item) => schemaHasExample(item, seen))) return true;
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const value = record[key];
    if (Array.isArray(value) && value.some((member) => schemaHasExample(member, seen))) return true;
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

/**
 * Lint an OpenAPI document for agent-readiness: the spec-quality gaps that
 * measurably degrade tool-calling accuracy (missing operationIds, absent or
 * vague descriptions, unpaginated list endpoints, oversized schemas, missing
 * examples). Small spec fixes routinely take tool-call success rates from
 * mediocre to near-perfect — each finding carries a concrete hint.
 */
export function lintDocument(document: OpenAPIDocument): LintResult {
  const findings: LintFinding[] = [];
  const operationIds = new Map<string, string[]>();

  const paths = document.paths ?? {};
  for (const [pathStr, pathItem] of Object.entries(paths).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!pathItem || '$ref' in pathItem) continue;

    // Path-item-level parameters apply to every operation (the generator
    // merges them the same way) — lint must see them too.
    const pathLevelParameters = ((pathItem as Record<string, unknown>)['parameters'] as unknown[] | undefined ?? []).filter(
      (param): param is ParameterObject => !isReferenceObject(param),
    );

    for (const method of METHODS) {
      const operation = pathItem[method] as OperationObject | undefined;
      if (!operation) continue;
      const label = `${method.toUpperCase()} ${pathStr}`;

      // operationId presence + duplicates
      if (!operation.operationId) {
        findings.push({
          severity: 'warning',
          code: 'missing-operation-id',
          message: 'Operation has no operationId; the tool name will be generated from the method and path.',
          path: label,
          hint: 'Add a short, action-oriented operationId (it becomes the tool name).',
        });
      } else {
        const existing = operationIds.get(operation.operationId) ?? [];
        existing.push(label);
        operationIds.set(operation.operationId, existing);
        if (operation.operationId.length > 64) {
          findings.push({
            severity: 'info',
            code: 'long-operation-id',
            message: `operationId '${operation.operationId.slice(0, 40)}…' exceeds 64 characters and will be truncated with a hash suffix.`,
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

      // parameter descriptions (path-level + operation-level, like generation)
      const parameters = [
        ...pathLevelParameters,
        ...(operation.parameters ?? []).filter((param): param is ParameterObject => !isReferenceObject(param)),
      ];
      const undescribed = parameters.filter((param) => !param.description).map((param) => param.name);
      if (undescribed.length > 0) {
        findings.push({
          severity: 'info',
          code: 'missing-parameter-description',
          message: `Parameter(s) without description: ${undescribed.join(', ')}.`,
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
          const shape = measureSchema(schema);
          responseShape = {
            depth: Math.max(responseShape.depth, shape.depth),
            widestObject: Math.max(responseShape.widestObject, shape.widestObject),
            hasArray: responseShape.hasArray || shape.hasArray,
          };
        }
      }

      if (method === 'get' && responseShape.hasArray) {
        const hasPagination = parameters.some((param) => param.in === 'query' && PAGINATION_PARAM.test(param.name));
        if (!hasPagination) {
          findings.push({
            severity: 'warning',
            code: 'unpaginated-list',
            message: 'GET returns an array but declares no pagination parameter — responses can blow past client result limits (Claude Code caps tool results at 25K tokens).',
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
        const shape = measureSchema(schema);
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
        message: `operationId '${operationId}' is used by ${labels.length} operations: ${labels.join(', ')}.`,
        path: labels[0],
        hint: 'Make operationIds unique — duplicates force hash-suffixed tool names.',
      });
    }
  }

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
