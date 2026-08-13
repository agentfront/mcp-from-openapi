import type { FrontMcpExtensionData, HTTPMethod, OperationObject, ToolAnnotations, ToolIcon } from './types';

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

  /**
   * MCP `_meta` entries supplied by the extension (merged key-by-key across
   * layers, emitted on the tool's `_meta` even when `emitMeta` is off).
   */
  meta?: Record<string, unknown>;

  /**
   * Tool icons supplied by the extension (later layers replace wholesale).
   */
  icons?: ToolIcon[];
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
    ...((base.meta || layer.meta) && { meta: { ...base.meta, ...layer.meta } }),
    ...(layer.icons !== undefined && { icons: layer.icons }),
  };
}

/** Rebuild a `_meta` contribution with pollution-gadget keys removed at every
 * level — untrusted specs cross a trust boundary here, and JSON/YAML parsing
 * creates `__proto__` as an own key that downstream deep-merges would follow. */
function cleanseMeta(node: unknown, seen: Set<object>): unknown {
  if (!node || typeof node !== 'object') {
    return node;
  }
  /* c8 ignore next 3 -- extension objects come from JSON/YAML and cannot be cyclic */
  if (seen.has(node)) {
    return undefined;
  }
  seen.add(node);
  try {
    if (Array.isArray(node)) {
      return node.map((item) => cleanseMeta(item, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      // Literal comparisons (not a shared Set) so static analysis recognizes
      // the prototype-pollution sanitizer
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = cleanseMeta(value, seen);
    }
    return out;
  } finally {
    seen.delete(node);
  }
}

/** Accept only a plain (non-array) object as a `_meta` contribution,
 * rebuilding it with pollution keys stripped recursively. */
function sanitizeMeta(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return cleanseMeta(value, new Set()) as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Whether an icon source URI matches the documented `ToolIcon.src` scheme
 * contract (`https:` or `data:` only, case-insensitive). Shared by extension
 * icon sanitization and the generator's `info['x-logo']` inheritance.
 */
export function isAllowedIconSrc(src: string): boolean {
  const lower = src.toLowerCase();
  return lower.startsWith('https:') || lower.startsWith('data:');
}

/** Keep only well-formed icon entries: objects with an `https:`/`data:`
 * string `src`, copying just the MCP icon fields (`src`, `mimeType`, `sizes`). */
function sanitizeIcons(value: unknown): ToolIcon[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const icons: ToolIcon[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw['src'] !== 'string' || !isAllowedIconSrc(raw['src'])) continue;
    const icon: ToolIcon = { src: raw['src'] };
    if (typeof raw['mimeType'] === 'string') {
      icon.mimeType = raw['mimeType'];
    }
    if (Array.isArray(raw['sizes']) && raw['sizes'].every((s) => typeof s === 'string')) {
      icon.sizes = [...(raw['sizes'] as string[])];
    }
    icons.push(icon);
  }
  return icons.length > 0 ? icons : undefined;
}

/** Read the `x-mcp` extension off any spec node (document, path item, operation). */
function readXMcp(node: object): unknown {
  return (node as { 'x-mcp'?: unknown })['x-mcp'];
}

/** Parse an `x-mcp` value (boolean shorthand or object form) into enabled/undefined. */
function parseXMcpEnabled(ext: unknown): boolean | undefined {
  if (ext === false) return false;
  if (ext === true) return true;
  if (ext && typeof ext === 'object' && typeof (ext as { enabled?: unknown }).enabled === 'boolean') {
    return (ext as { enabled: boolean }).enabled;
  }
  return undefined;
}

/**
 * Resolve whether an operation is enabled for tool generation, honoring the
 * `x-mcp` extension at every level with harsha-compatible precedence:
 * root (document) < path item < operation. A root-level `x-mcp: false` flips
 * the whole spec to opt-in; a path or operation level `x-mcp: true` (or
 * `{ enabled: true }`) re-enables its subtree. At the operation level the
 * whole extension family participates (`x-speakeasy-mcp: { disabled }` too),
 * with the family's own precedence.
 */
export function resolveExtensionEnabled(document: object, pathItem: object, operation: OperationObject): boolean {
  let enabled = true;

  const rootSetting = parseXMcpEnabled(readXMcp(document));
  if (rootSetting !== undefined) enabled = rootSetting;

  const pathSetting = parseXMcpEnabled(readXMcp(pathItem));
  if (pathSetting !== undefined) enabled = pathSetting;

  const operationDisabled = extractExtensionOverrides(operation).disabled;
  if (operationDisabled !== undefined) enabled = !operationDisabled;

  return enabled;
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
      meta: sanitizeMeta(ext['meta']),
      icons: sanitizeIcons(ext['icons']),
    });
  }

  // 3. x-frontmcp (highest precedence): `annotations`, `meta`, and `icons`
  // map onto tool overrides; the rest of the extension (cache, codecall,
  // tags, ...) flows through `metadata.frontmcp` untouched.
  const frontmcp = op['x-frontmcp'] as FrontMcpExtensionData | undefined;
  if (frontmcp && typeof frontmcp === 'object') {
    const layer: ExtensionToolOverrides = {
      meta: sanitizeMeta(frontmcp.meta),
      icons: sanitizeIcons(frontmcp.icons),
    };
    if (frontmcp.annotations) {
      layer.annotations = pickAnnotations(frontmcp.annotations as Record<string, unknown>);
      if (typeof frontmcp.annotations.title === 'string') {
        layer.title = frontmcp.annotations.title;
      }
    }
    result = mergeOverrides(result, layer);
  }

  return result;
}
