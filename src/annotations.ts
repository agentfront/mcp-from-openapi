import type { FrontMcpExtensionData, HTTPMethod, OperationObject, ToolAnnotations, ToolIcon } from './types';
import { SchemaError } from './errors';
import { resolveSchemaLimits } from './schema-builder';

/** Options for {@link extractExtensionOverrides} */
export interface ExtensionOverridesOptions {
  /**
   * Node budget for the `meta` copied out of the extensions (`x-mcp` and
   * `x-frontmcp` together). Dereferencing resolves `$ref`s there too, and each
   * occurrence is copied, so a few `$ref`s to schemas that share a child can
   * expand into an enormous value. Past the budget a `SchemaError` is thrown.
   * Defaults to 100000 — `OpenAPIToolGenerator` passes `maxSchemaNodes` —
   * and `Infinity` disables it.
   */
  maxMetaNodes?: number;
}

/**
 * How deeply extension meta may nest. A value nested deeper fails the tool, so
 * that every generated tool stays safe to serialize (`JSON.stringify` overflows
 * the call stack at a few thousand levels).
 */
const MAX_META_DEPTH = 1000;

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

/** A meta object or array being rebuilt: its kept keys (`null` for an array) and their values. */
interface CleanseFrame {
  node: object;
  keys: string[] | null;
  values: unknown[];
  next: number;
  out: Record<string, unknown> | unknown[];
}

/** The meta node budget of one operation, shared by its extension layers */
interface MetaBudget {
  maxNodes: number;
  nodes: number;
}

/** Rebuild a `_meta` contribution with pollution-gadget keys removed at every
 * level — untrusted specs cross a trust boundary here, and JSON/YAML parsing
 * creates `__proto__` as an own key that downstream deep-merges would follow.
 * Dereferencing resolves `$ref`s inside extensions too, so the value can be
 * circular (a reference back to an ancestor is dropped), deeply nested
 * (walked with an explicit stack — issue #50 — up to `MAX_META_DEPTH`), or
 * shared (copied per occurrence, so every copied object or array counts
 * against the budget). */
function cleanseMeta(root: object, budget: MetaBudget): unknown {
  // Objects on the path from the root to the node being rebuilt
  const path = new Set<object>();
  const frames: CleanseFrame[] = [];
  const pending = {};
  // A node's rebuilt value — or `pending`, with a frame pushed to rebuild it
  const enter = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    if (path.has(node)) return undefined;
    if (++budget.nodes > budget.maxNodes) {
      throw new SchemaError(
        `Extension meta exceeds the node budget of ${budget.maxNodes} (maxSchemaNodes): with its $refs resolved, ` +
          `the x-mcp/x-frontmcp meta expands into more nodes than allowed. Remove the references or raise ` +
          `maxSchemaNodes.`,
        { maxNodes: budget.maxNodes },
      );
    }
    if (frames.length >= MAX_META_DEPTH) {
      throw new SchemaError(`Extension meta (x-mcp/x-frontmcp) is nested more than ${MAX_META_DEPTH} levels deep.`, {
        maxDepth: MAX_META_DEPTH,
      });
    }
    path.add(node);
    if (Array.isArray(node)) {
      // JSON-cloned, so never sparse
      frames.push({ node, keys: null, values: node, next: 0, out: new Array<unknown>(node.length) });
      return pending;
    }
    // Literal comparisons (not a shared Set) so static analysis recognizes
    // the prototype-pollution sanitizer
    const keys = Object.keys(node).filter((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype');
    const record = node as Record<string, unknown>;
    frames.push({ node, keys, values: keys.map((key) => record[key]), next: 0, out: {} });
    return pending;
  };
  const store = (frame: CleanseFrame, index: number, value: unknown): void => {
    if (frame.keys) (frame.out as Record<string, unknown>)[frame.keys[index]] = value;
    else (frame.out as unknown[])[index] = value;
  };

  enter(root);
  for (;;) {
    const frame = frames[frames.length - 1];
    if (frame.next < frame.values.length) {
      const index = frame.next++;
      const value = enter(frame.values[index]);
      if (value !== pending) store(frame, index, value);
      continue;
    }
    frames.pop();
    path.delete(frame.node);
    const parent = frames[frames.length - 1];
    if (!parent) return frame.out;
    store(parent, parent.next - 1, frame.out);
  }
}

/** Accept only a plain (non-array) object as a `_meta` contribution,
 * rebuilding it with pollution keys stripped recursively. */
function sanitizeMeta(value: unknown, budget: MetaBudget): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return cleanseMeta(value, budget) as Record<string, unknown>;
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

  const operationDisabled = extractExtensionSettings(operation).disabled;
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
 *
 * Throws a `SchemaError` when the `meta` exceeds `options.maxMetaNodes` or
 * nests more than 1000 levels deep.
 */
export function extractExtensionOverrides(
  operation: OperationObject,
  options: ExtensionOverridesOptions = {},
): ExtensionToolOverrides {
  const { maxNodes } = resolveSchemaLimits({ maxSchemaNodes: options.maxMetaNodes });
  return readExtensionOverrides(operation, { maxNodes, nodes: 0 });
}

/**
 * The overrides without `meta` and `icons` — the only parts copied out of the
 * spec — for callers that read just `disabled` or `annotations` (operation
 * filters): oversized meta then fails only that tool's generation.
 */
export function extractExtensionSettings(operation: OperationObject): ExtensionToolOverrides {
  return readExtensionOverrides(operation, null);
}

function readExtensionOverrides(operation: OperationObject, metaBudget: MetaBudget | null): ExtensionToolOverrides {
  const meta = (value: unknown) => (metaBudget ? sanitizeMeta(value, metaBudget) : undefined);
  const icons = (value: unknown) => (metaBudget ? sanitizeIcons(value) : undefined);
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
      meta: meta(ext['meta']),
      icons: icons(ext['icons']),
    });
  }

  // 3. x-frontmcp (highest precedence): `annotations`, `meta`, and `icons`
  // map onto tool overrides; the rest of the extension (cache, codecall,
  // tags, ...) flows through `metadata.frontmcp` untouched.
  const frontmcp = op['x-frontmcp'] as FrontMcpExtensionData | undefined;
  if (frontmcp && typeof frontmcp === 'object') {
    const layer: ExtensionToolOverrides = {
      meta: meta(frontmcp.meta),
      icons: icons(frontmcp.icons),
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
