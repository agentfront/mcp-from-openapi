import type { FrontMcpExtensionData, HTTPMethod, OperationObject, ToolAnnotations } from './types';

/**
 * Tool-level overrides read from the `x-mcp` extension family on an operation.
 */
export interface ExtensionToolOverrides {
  /**
   * Operation explicitly excluded from tool generation
   * (`x-mcp: false`, `x-mcp: { enabled: false }`, or
   * `x-speakeasy-mcp: { disabled: true }`).
   */
  disabled?: boolean;

  /**
   * Tool name override (still normalized to MCP name rules).
   */
  name?: string;

  /**
   * Display title override.
   */
  title?: string;

  /**
   * LLM-facing description override.
   */
  description?: string;

  /**
   * Annotation overrides, merged field-by-field over inferred values.
   */
  annotations?: ToolAnnotations;
}

/**
 * Default MCP tool annotations per HTTP method, derived from HTTP semantics
 * (RFC 9110 safety/idempotency): safe methods are read-only and idempotent;
 * PUT/DELETE are idempotent but may destroy state; POST/PATCH are neither
 * safe nor idempotent. `openWorldHint` is false throughout — tools generated
 * from a spec target one known API backend, a closed world.
 */
export function inferAnnotationsFromMethod(method: HTTPMethod): ToolAnnotations {
  switch (method) {
    case 'get':
    case 'head':
    case 'options':
    case 'trace':
      return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    case 'put':
    case 'delete':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
    case 'post':
    case 'patch':
      return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  }
}

const ANNOTATION_KEYS = ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** Pick only defined, correctly-typed annotation fields from a raw object. */
function pickAnnotations(raw: Record<string, unknown> | undefined): ToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const key of ANNOTATION_KEYS) {
    const value = raw[key];
    if (key === 'title' ? typeof value === 'string' : typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? (result as ToolAnnotations) : undefined;
}

/** Merge override layers; later layers win field-by-field. */
function mergeOverrides(base: ExtensionToolOverrides, layer: ExtensionToolOverrides): ExtensionToolOverrides {
  return {
    ...base,
    ...(layer.disabled !== undefined && { disabled: layer.disabled }),
    ...(layer.name !== undefined && { name: layer.name }),
    ...(layer.title !== undefined && { title: layer.title }),
    ...(layer.description !== undefined && { description: layer.description }),
    ...((base.annotations || layer.annotations) && {
      annotations: { ...base.annotations, ...layer.annotations },
    }),
  };
}

/**
 * Extract tool overrides from the `x-mcp` extension family on an operation.
 *
 * Precedence (ascending — later overrides earlier, field-by-field):
 *   1. `x-speakeasy-mcp` — `{ disabled, name, title, description, readOnlyHint, ... }`
 *      (Speakeasy places annotation hints at the top level of the object)
 *   2. `x-mcp` — `false` to exclude, or `{ enabled, name, title, description, annotations }`
 *   3. `x-frontmcp` — the canonical extension for this stack; its `annotations`
 *      (including `annotations.title`) win over the generic variants
 */
export function extractExtensionOverrides(operation: OperationObject): ExtensionToolOverrides {
  const op = operation as Record<string, unknown>;
  let result: ExtensionToolOverrides = {};

  // 1. x-speakeasy-mcp (lowest precedence)
  const speakeasy = op['x-speakeasy-mcp'];
  if (speakeasy && typeof speakeasy === 'object') {
    const ext = speakeasy as Record<string, unknown>;
    result = mergeOverrides(result, {
      disabled: typeof ext['disabled'] === 'boolean' ? ext['disabled'] : undefined,
      name: typeof ext['name'] === 'string' ? ext['name'] : undefined,
      title: typeof ext['title'] === 'string' ? ext['title'] : undefined,
      description: typeof ext['description'] === 'string' ? ext['description'] : undefined,
      // Speakeasy's top-level `title` is the tool title, not an annotation slot
      annotations: pickAnnotations({ ...ext, title: undefined }),
    });
  }

  // 2. x-mcp: boolean shorthand or object form
  const xMcp = op['x-mcp'];
  if (xMcp === false) {
    result = mergeOverrides(result, { disabled: true });
  } else if (xMcp === true) {
    result = mergeOverrides(result, { disabled: false });
  } else if (xMcp && typeof xMcp === 'object') {
    const ext = xMcp as Record<string, unknown>;
    result = mergeOverrides(result, {
      disabled: typeof ext['enabled'] === 'boolean' ? !ext['enabled'] : undefined,
      name: typeof ext['name'] === 'string' ? ext['name'] : undefined,
      title: typeof ext['title'] === 'string' ? ext['title'] : undefined,
      description: typeof ext['description'] === 'string' ? ext['description'] : undefined,
      annotations: pickAnnotations(ext['annotations'] as Record<string, unknown> | undefined),
    });
  }

  // 3. x-frontmcp (highest precedence): only `annotations` maps onto tool
  // overrides; the rest of the extension (cache, codecall, tags, ...) flows
  // through `metadata.frontmcp` untouched.
  const frontmcp = op['x-frontmcp'] as FrontMcpExtensionData | undefined;
  if (frontmcp && typeof frontmcp === 'object' && frontmcp.annotations) {
    const annotations = pickAnnotations(frontmcp.annotations as Record<string, unknown>);
    result = mergeOverrides(result, {
      annotations,
      title: typeof frontmcp.annotations.title === 'string' ? frontmcp.annotations.title : undefined,
    });
  }

  return result;
}
