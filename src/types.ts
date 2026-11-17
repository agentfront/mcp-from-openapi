import type { JSONSchema } from 'zod/v4/core';

/** JSON Schema type from Zod v4 */
export type JsonSchema = JSONSchema.JSONSchema;
import type {
  OpenAPIDocument,
  OperationObject,
  ParameterObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  MediaTypeObject,
  HeaderObject,
  ExampleObject,
  PathItemObject,
  PathsObject,
  ServerObject,
  SecuritySchemeObject,
  ReferenceObject,
  TagObject,
  ExternalDocumentationObject,
  ServerVariableObject,
  EncodingObject,
  SecurityRequirementObject,
  SchemaObject,
  SchemaOrBoolean,
  StandardMethod,
} from './spec';
import { SPEC_DIAGNOSTIC_CODES } from './spec';
import { SchemaError } from './errors';
import { isExtensionKey, referenceAt } from './reference-sites';

/**
 * An OpenAPI version string of a supported `major.minor`: any `3.0.x`,
 * `3.1.x` or `3.2.x` (`'3.0.3'`, `'3.1.0'`, `'3.2.0'`, `'3.2.0-rc1'`). The
 * patch is not checked here: the specification says tooling should ignore
 * it, and `detectSpecVersion` reads the value at runtime.
 */
export type OpenAPIVersion = `3.0.${string}` | `3.1.${string}` | `3.2.${string}`;

// OpenAPI object types (cross-version unions of the `src/spec` types): the
// document, and the objects within it that the library reads
export type {
  OpenAPIDocument,
  OperationObject,
  ParameterObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  MediaTypeObject,
  HeaderObject,
  ExampleObject,
  PathItemObject,
  PathsObject,
  ServerObject,
  SecuritySchemeObject,
  ReferenceObject,
  TagObject,
  ExternalDocumentationObject,
  ServerVariableObject,
  EncodingObject,
  SecurityRequirementObject,
  SchemaObject,
  SchemaOrBoolean,
};

/**
 * The HTTP method of an operation.
 *
 * - A method with a fixed Path Item field (`get`, `post`, `put`, `patch`,
 *   `delete`, `head`, `options`, `trace`, and `query` from OpenAPI 3.2) is
 *   the lowercase field name.
 * - An OpenAPI 3.2 `additionalOperations` method (`LINK`, `PURGE`, ...) is the
 *   key exactly as written: HTTP methods are case-sensitive, and it is sent
 *   as written.
 *
 * The type is open (`(string & {})`) so additional methods type-check while
 * the standard ones still autocomplete. `isStandardMethod` tells them apart.
 */
export type HTTPMethod = StandardMethod | (string & {});

/**
 * Parameter location types
 */
export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie' | 'body';

/**
 * Authentication types supported
 */
export type AuthType = 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS';

/**
 * Helper to check if an object is a ReferenceObject
 */
export function isReferenceObject(obj: any): obj is ReferenceObject {
  return obj && typeof obj === 'object' && '$ref' in obj;
}

/**
 * Limits for {@link toJsonSchema} (and the `ParameterResolver` /
 * `ResponseBuilder` conversions built on it). `OpenAPIToolGenerator` derives
 * them from `GenerateOptions.maxSchemaDepth` / `maxSchemaNodes`.
 */
export interface SchemaConversionOptions {
  /**
   * Stop descending below this nesting depth: deeper subschemas become `{}`
   * placeholders. `allOf` members do not consume depth, because request-body
   * flattening hoists their properties to the top of the input schema — so
   * the bound never cuts anything `SchemaBuilder.truncateDepth(schema,
   * maxDepth)` keeps, and that call removes every placeholder.
   * Unbounded when omitted.
   */
  maxDepth?: number;

  /**
   * Throw a `SchemaError` once a single conversion has charged more than this
   * many nodes, so its time and memory stay bounded. Every schema visited
   * costs one — converted, reused, or placeholder alike, since each one fills
   * a slot in the result — and a converted schema costs one more per keyword,
   * as converting copies every keyword (and a schema on a cycle can be
   * converted once per path). Unbounded when omitted.
   */
  maxNodes?: number;

  /** A budget several conversions share (all parameters of one tool, all its responses), so their sum stays bounded */
  sharedBudget?: { nodes: number; readonly maxNodes: number };
}

/** Structural keywords whose value is a map of subschemas (besides `properties`). */
const SCHEMA_MAP_KEYWORDS = ['patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const;

/** Single-subschema keywords (besides `items`/`additionalProperties`/`not`); `unevaluated*` may be boolean. */
const SCHEMA_SINGLE_KEYWORDS = [
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
  'contentSchema',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;

/**
 * Convert OpenAPI schema to JsonSchema
 * Note: OpenAPI 3.0 uses a subset of JSON Schema Draft 4
 * OpenAPI 3.1 uses JSON Schema Draft 2020-12
 *
 * Normalizations applied for clean JSON Schema 2020-12 output (MCP's default
 * dialect since spec revision 2025-11-25):
 * - OpenAPI 3.0 `nullable: true` -> `type: [..., 'null']` union
 * - OpenAPI 3.0 boolean `exclusiveMinimum`/`exclusiveMaximum` -> numeric form
 * - OpenAPI `example` (singular) -> `examples` array (2020-12 keyword)
 * - OpenAPI-only `xml` metadata is dropped
 * - Swagger 2.0 constructs, whatever version the document declares:
 *   `x-nullable` (without `nullable`) reads as `nullable`, `type: file` is
 *   `type: string, format: binary`, and a string `discriminator` becomes
 *   `{ propertyName }`
 * - A boolean schema (JSON Schema 2020-12, so OpenAPI 3.1 and later) becomes
 *   an object schema with the same meaning: `true` (any value) converts to
 *   `{}`, `false` (no value) to `{ not: {} }`. This holds at the root and
 *   wherever a subschema is converted (`properties`, `items`, `prefixItems`,
 *   `allOf`/`anyOf`/`oneOf` members, `not: true`, `$defs`, `definitions`,
 *   `patternProperties`, `dependentSchemas`); where JSON Schema allows a
 *   boolean keyword value and conversion copies it (`additionalProperties`,
 *   `items: false`, `not: false`, `contains`, `propertyNames`, `if`/`then`/
 *   `else`, `contentSchema`, `unevaluated*`), the boolean is kept as written
 *
 * A subschema shared by several parents (a `$ref` target, after
 * dereferencing) is converted once and the result is reused, so the output
 * may share nested objects — treat it as immutable below the root, or
 * materialize a fresh tree with `SchemaBuilder.truncateDepth`. The root is
 * always a fresh object.
 */
export function toJsonSchema(schema: object | boolean, options: SchemaConversionOptions = {}): JsonSchema {
  const state: ConversionState = {
    root: schema,
    maxDepth: normalizeConversionLimit(options.maxDepth, 0),
    maxNodes: normalizeConversionLimit(options.maxNodes, 1),
    nodes: 0,
    sharedBudget: options.sharedBudget,
    stack: new Map(),
    cache: new Map(),
    cyclic: undefined,
    cut: false,
    lowWater: Infinity,
  };
  // Any object converts (a Schema or Reference Object of any version, or a
  // schema-shaped object the caller built); a boolean becomes its object form
  return convertSchema(schema as SchemaObject | ReferenceObject, 0, state);
}

/**
 * Whether a media type's `schema` is read: any truthy value, as always, and
 * the boolean schema `false` (OpenAPI 3.1 and later), which `toJsonSchema`
 * converts to `{ not: {} }`. A request body, a response and the stream check
 * of a request body all decide by it. Internal (not part of the public barrel).
 */
export function isPresentSchema(value: unknown): boolean {
  return Boolean(value) || value === false;
}

/**
 * Whether a converted schema accepts no value because of its `not`: `{ not: {} }`
 * (what `toJsonSchema` makes of `false`, and how OpenAPI 3.0 writes "never"),
 * or `{ not: true }`, whatever other keywords it has. Internal.
 */
export function isNeverSchema(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const not = (value as Record<string, unknown>)['not'];
  return (
    not === true ||
    (not !== null && typeof not === 'object' && !Array.isArray(not) && Object.keys(not).length === 0)
  );
}

/** Absent or non-finite limits mean "unbounded"; finite ones floor, with a minimum. */
function normalizeConversionLimit(value: number | undefined, min: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : Infinity;
}

interface ConversionState {
  readonly root: unknown;
  readonly maxDepth: number;
  readonly maxNodes: number;
  /** Nodes charged so far: one per schema visited, plus one per keyword of each schema converted. */
  nodes: number;
  readonly sharedBudget: { nodes: number; readonly maxNodes: number } | undefined;
  /** Ancestors on the current path, with their stack index: a revisit is a cycle, cut with `{}`. */
  readonly stack: Map<object, number>;
  /** The latest result for every converted node; reused only when it is valid anywhere. */
  readonly cache: Map<object, CachedConversion>;
  /**
   * Nodes on a cycle conversion can walk — their result depends on the path,
   * so it is never reused. Computed only when a result that is not
   * `selfContained` is revisited (`undefined` until then); `null` when the
   * analysis was abandoned at the node budget.
   */
  cyclic: Set<object> | null | undefined;
  /** Whether the subtree being converted was cut at `maxDepth`. */
  cut: boolean;
  /** Lowest stack index a cycle cut in the subtree being converted pointed at. */
  lowWater: number;
}

interface CachedConversion {
  result: JsonSchema;
  /** Depth the result was converted at; -1 when nothing below it was cut (valid at any depth). */
  depth: number;
  cut: boolean;
  /**
   * The conversion explored everything below the node — nothing was cut at
   * `maxDepth` and no path led back to the node or above it — so the node is
   * on no cycle and the result is valid anywhere, without a cycle analysis.
   */
  selfContained: boolean;
}

/**
 * A schema whose conversion is in progress: its result, built before its
 * children are converted, and the slots their results fill.
 */
interface ConversionFrame {
  /** The source schema; `null` for a non-object one, which needs no cycle or sharing bookkeeping */
  node: object | null;
  depth: number;
  result: Record<string, unknown>;
  /** Wrap the finished result in `anyOf: [result, {type: 'null'}]` (a type-less `nullable`) */
  wrapNullable: boolean;
  /**
   * The children to convert, in order, four entries each: the container and
   * key their result is stored at, the child schema, and its depth
   */
  slots: unknown[];
  /** Index (into `slots`) of the next child; the one before it is being converted */
  next: number;
  /** `state.cut` / `state.lowWater` of the enclosing subtree, restored when this one finishes */
  outerCut: boolean;
  outerLowWater: number;
  /** Position on `state.stack` */
  index: number;
}

/** Returned for a child whose conversion was pushed as a frame: its slot is filled when that frame finishes. */
const PENDING: unique symbol = Symbol('pending');

/**
 * Core of `toJsonSchema`.
 *
 * - Cycles: dereferenced real-world specs can be cyclic (self-referential
 *   schemas); a revisit within the same path breaks the cycle with an
 *   unconstrained schema instead of recursing forever.
 * - Sharing: an acyclic node converts to the same result wherever it appears
 *   (it cannot reach any of its ancestors), so the first result is reused.
 *   Without this, a schema whose properties reference the same child twice,
 *   chained N levels deep, costs 2^N conversions.
 * - Depth: below `maxDepth` the conversion stops with `{}` placeholders. A
 *   cut result depends on the depth it started at, so it is reused only at
 *   that depth or deeper (where it is at least as deep as needed).
 * - Cyclic nodes are converted afresh on every visit; `maxDepth` bounds that
 *   walk and `maxNodes` stops pathological ones with a clear error.
 * - Nesting: the walk keeps its own stack of frames instead of recursing, so
 *   no schema is nested too deeply to convert. `allOf` members don't consume
 *   depth, so `maxDepth` doesn't bound an `allOf` chain; a call per level
 *   would overflow the call stack after about a thousand levels (issue #50).
 *   Children are converted depth-first in a fixed order, so the visits and
 *   the cache evolve as a recursive walk's would.
 */
function convertSchema(schema: SchemaObject | ReferenceObject, depth: number, state: ConversionState): JsonSchema {
  const frames: ConversionFrame[] = [];
  const root = visitSchema(schema, depth, state, frames);
  if (root !== PENDING) return root;
  for (;;) {
    const frame = frames[frames.length - 1];
    const slots = frame.slots;
    if (frame.next < slots.length) {
      const at = frame.next;
      frame.next = at + 4;
      const value = visitSchema(
        slots[at + 2] as SchemaObject | ReferenceObject,
        slots[at + 3] as number,
        state,
        frames,
      );
      if (value !== PENDING) (slots[at] as Record<string, unknown>)[slots[at + 1] as string] = value;
      continue;
    }
    frames.pop();
    const result = finishSchema(frame, state);
    const parent = frames[frames.length - 1];
    if (!parent) return result;
    const at = parent.next - 4;
    (parent.slots[at] as Record<string, unknown>)[parent.slots[at + 1] as string] = result;
  }
}

/**
 * Visit one schema: its converted result when it is known right away — a
 * `$ref` leaf, a depth or cycle placeholder, a reused result, or a schema
 * without children — or `PENDING` once a frame converting it is pushed.
 */
function visitSchema(
  schema: SchemaObject | ReferenceObject,
  depth: number,
  state: ConversionState,
  frames: ConversionFrame[],
): JsonSchema | typeof PENDING {
  // Charge every visit, not just conversions: a reused result or a `{}`
  // placeholder still fills a slot in the parent being built, and a node on a
  // cycle can be rebuilt once per path — so only counting every visit bounds
  // the conversion's time and memory
  charge(state, 1);
  if (isReferenceObject(schema)) {
    return { $ref: schema.$ref } as JsonSchema;
  }
  if (depth > state.maxDepth) {
    state.cut = true;
    return {} as JsonSchema;
  }
  const node: unknown = schema;
  if (typeof node === 'boolean') {
    // A boolean schema keeps its meaning as an object schema, so every later
    // step sees objects: `true` accepts any value (`{}`), `false` none. Its
    // one keyword is charged like a converted schema's
    if (node) return {} as JsonSchema;
    charge(state, 1);
    return { not: {} } as JsonSchema;
  }
  if (node === null || typeof node !== 'object') {
    // Degenerate schemas have no children to share or cycle through
    return enterSchema(schema, depth, null, state, frames);
  }
  const cached = state.cache.get(node);
  if (cached && cached.depth <= depth && (cached.selfContained || isReusable(node, state))) {
    state.cut ||= cached.cut;
    return cached.result;
  }
  const onStack = state.stack.get(node);
  if (onStack !== undefined) {
    state.lowWater = Math.min(state.lowWater, onStack);
    return {} as JsonSchema;
  }
  return enterSchema(schema, depth, node, state, frames);
}

/** Charge `cost` nodes against the conversion's budget, throwing once it is exceeded */
function charge(state: ConversionState, cost: number): void {
  const shared = state.sharedBudget;
  const sharedExceeded = shared !== undefined && (shared.nodes += cost) > shared.maxNodes;
  if ((state.nodes += cost) > state.maxNodes || sharedExceeded) {
    const maxNodes = sharedExceeded ? shared.maxNodes : state.maxNodes;
    throw new SchemaError(
      `Schema conversion exceeded the node budget of ${maxNodes} (maxSchemaNodes): shared or recursive ` +
        `$refs expand into more schema nodes than allowed. Lower maxSchemaDepth or raise maxSchemaNodes.`,
      { maxNodes },
    );
  }
}

/**
 * The array a schema list (`items` tuple, `allOf`/`anyOf`/`oneOf`,
 * `prefixItems`) converts into, with a slot queued for each member at
 * `depth`. Holes stay holes, as with `.map`, but each costs a node like a
 * member — it serializes as `null` — so an array longer than the budget left
 * is rejected before it is walked.
 */
function queueMembers(members: unknown[], depth: number, slots: unknown[], state: ConversionState): JsonSchema[] {
  const shared = state.sharedBudget;
  const sharedFull = shared !== undefined && shared.nodes + members.length > shared.maxNodes;
  if (state.nodes + members.length > state.maxNodes || sharedFull) charge(state, members.length);
  const converted: JsonSchema[] = new Array(members.length);
  let holes = 0;
  for (let i = 0; i < members.length; i++) {
    if (i in members) slots.push(converted, i, members[i], depth);
    else holes++;
  }
  charge(state, holes);
  return converted;
}

/**
 * Finish a frame once its children are converted: wrap a type-less nullable
 * result, store the result for reuse, and pop the node off the path.
 */
function finishSchema(frame: ConversionFrame, state: ConversionState): JsonSchema {
  let result = frame.result as JsonSchema;
  if (frame.wrapNullable) {
    // Hoist pure annotation keywords onto the wrapper so descriptions and
    // examples stay visible at the top level instead of buried in anyOf[0].
    const inner = frame.result;
    const wrapper: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'deprecated', 'examples'] as const) {
      if (inner[key] !== undefined) {
        wrapper[key] = inner[key];
        delete inner[key];
      }
    }
    wrapper['anyOf'] = [inner, { type: 'null' }];
    result = wrapper as JsonSchema;
  }
  const node = frame.node;
  if (node) {
    state.cache.set(node, {
      result,
      depth: state.cut ? frame.depth : -1,
      cut: state.cut,
      selfContained: !state.cut && state.lowWater > frame.index,
    });
    state.stack.delete(node);
    state.cut ||= frame.outerCut;
    state.lowWater = Math.min(state.lowWater, frame.outerLowWater);
  }
  return result;
}

/**
 * Whether a stored result for `node` that is not `selfContained` (its
 * conversion was cut at `maxDepth`, or cycled) is still valid wherever it
 * appears: true unless `node` lies on a cycle conversion can walk. The cycle
 * analysis runs at most once per conversion, and only when such a result is
 * revisited — most conversions never need it.
 */
function isReusable(node: object, state: ConversionState): boolean {
  if (state.cyclic === undefined) {
    // A revisit implies the root is an object schema
    state.cyclic = findCyclicNodes(state.root as object, state.maxDepth, state.maxNodes);
  }
  return state.cyclic !== null && !state.cyclic.has(node);
}

/**
 * Visit the object-valued child schemas `enterSchema` converts —
 * the edges of the schema graph — with the depth each one adds (`allOf`
 * members add none, as in conversion). Reference objects are leaves.
 */
function forEachChildSchema(node: object, visit: (child: object, weight: 0 | 1) => void): void {
  const record = node as Record<string, unknown>;
  const edge = (child: unknown, weight: 0 | 1): void => {
    if (child !== null && typeof child === 'object' && !isReferenceObject(child)) visit(child, weight);
  };
  const properties = record['properties'];
  if (properties && typeof properties === 'object') {
    for (const child of Object.values(properties)) edge(child, 1);
  }
  const items = record['items'];
  if (Array.isArray(items)) {
    for (const child of items) edge(child, 1);
  } else {
    edge(items, 1);
  }
  edge(record['additionalProperties'], 1);
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const) {
    const members = record[key];
    if (Array.isArray(members)) {
      for (const child of members) edge(child, key === 'allOf' ? 0 : 1);
    }
  }
  edge(record['not'], 1);
  for (const key of SCHEMA_MAP_KEYWORDS) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const child of Object.values(value)) edge(child, 1);
    }
  }
  for (const key of SCHEMA_SINGLE_KEYWORDS) edge(record[key], 1);
}

/**
 * The shallowest depth at which conversion can reach each node from `root`,
 * for the nodes within `maxDepth` (depth counted exactly as conversion counts
 * it). `null` once that region holds more than `maxNodes` nodes: conversion
 * visits every node of the region, so it would exceed the budget anyway.
 */
function reachableRegion(root: object, maxDepth: number, maxNodes: number): Map<object, number> | null {
  const depthOf = new Map<object, number>([[root, 0]]);
  let level: object[] = [root];
  for (let depth = 0; level.length > 0; depth++) {
    const next: object[] = [];
    // allOf members join the level being walked, so it grows while iterating
    for (let i = 0; i < level.length; i++) {
      const node = level[i];
      // Queued for this level, then reached through allOf at a shallower one
      if (depthOf.get(node) !== depth) continue;
      forEachChildSchema(node, (child, weight) => {
        const childDepth = depth + weight;
        const known = depthOf.get(child);
        if (childDepth > maxDepth || (known !== undefined && known <= childDepth)) return;
        depthOf.set(child, childDepth);
        (weight === 0 ? level : next).push(child);
      });
      if (depthOf.size > maxNodes) return null;
    }
    level = next;
  }
  return depthOf;
}

/**
 * Nodes on a cycle that conversion can walk (Tarjan's strongly-connected-
 * components algorithm, iterative so deep specs cannot overflow the call
 * stack). Only these convert differently depending on the path that reaches
 * them. A cycle is walkable only if each of its edges can be followed within
 * `maxDepth` — i.e. from its source's shallowest depth — so the analysis
 * stays inside that region, and a large subgraph past `maxDepth` costs
 * nothing. `null` when the region exceeds `maxNodes`: then no result is
 * reused, which is always correct, and the budget still bounds the work.
 */
function findCyclicNodes(root: object, maxDepth: number, maxNodes: number): Set<object> | null {
  const region = reachableRegion(root, maxDepth, maxNodes);
  if (!region) return null;

  const cyclic = new Set<object>();
  const index = new Map<object, number>();
  const low = new Map<object, number>();
  const open: object[] = [];
  const onOpen = new Set<object>();
  const frames: { node: object; children: object[]; next: number }[] = [];
  const enter = (node: object): void => {
    index.set(node, index.size);
    low.set(node, index.size - 1);
    open.push(node);
    onOpen.add(node);
    const children: object[] = [];
    const nodeDepth = region.get(node)!;
    forEachChildSchema(node, (child, weight) => {
      if (nodeDepth + weight <= maxDepth) children.push(child);
    });
    frames.push({ node, children, next: 0 });
  };

  enter(root);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.next < frame.children.length) {
      const child = frame.children[frame.next++];
      if (!index.has(child)) {
        enter(child);
      } else if (onOpen.has(child)) {
        low.set(frame.node, Math.min(low.get(frame.node)!, index.get(child)!));
      }
      continue;
    }
    frames.pop();
    const nodeLow = low.get(frame.node)!;
    const parent = frames[frames.length - 1];
    if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, nodeLow));
    if (nodeLow === index.get(frame.node)) {
      const component: object[] = [];
      let member: object;
      do {
        member = open.pop()!;
        onOpen.delete(member);
        component.push(member);
      } while (member !== frame.node);
      if (component.length > 1 || frame.children.includes(frame.node)) {
        component.forEach((m) => cyclic.add(m));
      }
    }
  }
  return cyclic;
}

/**
 * Rewrites, in a schema's result being built, the Swagger 2.0 constructs that
 * OpenAPI 3 spells differently, and returns whether the schema is nullable.
 * Applied whatever version the document declares, like `nullable` itself:
 *
 * - `x-nullable: <boolean>` stands for `nullable` when the schema has no
 *   `nullable` (the extension is then dropped, as `nullable` is);
 * - `type: file` (or `file` in a `type` list) is a binary string: `type:
 *   string, format: binary`;
 * - a string `discriminator` (the 2.0 form, a property name) becomes the
 *   OpenAPI 3 object `{ propertyName }`, so no later step meets a string.
 *
 * `nullable` is the schema's own `nullable` keyword (already taken out).
 */
function normalizeSwaggerKeywords(result: Record<string, unknown>, nullable: unknown): boolean {
  let effective = nullable;
  const xNullable = result['x-nullable'];
  if (nullable === undefined && typeof xNullable === 'boolean') {
    effective = xNullable;
    delete result['x-nullable'];
  }

  const type = result['type'];
  if (type === 'file') {
    result['type'] = 'string';
    result['format'] = 'binary';
  } else if (Array.isArray(type) && type.includes('file')) {
    result['type'] = [...new Set(type.map((name: unknown) => (name === 'file' ? 'string' : name)))];
    result['format'] = 'binary';
  }

  const discriminator = result['discriminator'];
  if (typeof discriminator === 'string') result['discriminator'] = { propertyName: discriminator };
  return effective === true;
}

/**
 * Start converting a schema: build its result without the children, and list
 * the children to convert — returning the finished result right away when
 * there are none, or `PENDING` with the frame pushed.
 */
function enterSchema(
  schema: SchemaObject,
  depth: number,
  node: object | null,
  state: ConversionState,
  frames: ConversionFrame[],
): JsonSchema | typeof PENDING {
  // Converting copies every keyword: a schema with thousands of them, reached
  // by many paths, must not slip under the budget by counting once each time
  if (node) charge(state, Object.keys(node).length);
  const frame: ConversionFrame = {
    node,
    depth,
    result: {},
    wrapNullable: false,
    slots: [],
    next: 0,
    outerCut: state.cut,
    outerLowWater: state.lowWater,
    index: state.stack.size,
  };
  if (node) {
    // The subtree below this node tracks its own depth cuts and cycle targets
    state.cut = false;
    state.lowWater = Infinity;
    state.stack.set(node, frame.index);
  }
  const childDepth = depth + 1;
  const slots = frame.slots;

  // Handle OpenAPI 3.0 boolean exclusiveMaximum/exclusiveMinimum
  // by converting them to JSON Schema Draft 7 numeric format
  const { exclusiveMaximum, exclusiveMinimum, maximum, minimum, ...rest } = schema;
  // OpenAPI-only keywords pulled out of the JSON Schema output. `nullable` and
  // `example` carry validation/annotation meaning and are converted below; `xml`
  // is serialization metadata with no JSON Schema equivalent.
  const { nullable, example, ...cleanRest } = rest as Record<string, unknown> & {
    nullable?: boolean;
    example?: unknown;
  };

  const result: Record<string, unknown> = { ...cleanRest };
  delete result['xml'];
  frame.result = result;

  // Swagger 2.0 constructs, read whatever version the document declares (a
  // 2.0 document is converted before this, but a 3.x one can carry them too)
  const isNullable = normalizeSwaggerKeywords(result, nullable);

  // A specification extension the document wrote as a `$ref` is given back as
  // written: a `$ref` there is no Reference Object, and the value resolved in
  // its place can be a whole schema graph (src/reference-sites.ts). A `$ref`
  // deeper inside an extension is given back when the value is copied
  // (`SchemaBuilder.truncateDepth`)
  if (node) {
    for (const key of Object.keys(result)) {
      if (!isExtensionKey(key)) continue;
      const ref = referenceAt(node, key, result[key]);
      if (ref !== undefined) result[key] = { $ref: ref };
    }
  }

  // OpenAPI 3.0 `nullable: true` -> JSON Schema type union with 'null'.
  // Type-less nullable schemas (compositions, enum-only) can't take a type
  // union — they are wrapped in `anyOf: [<schema>, { type: 'null' }]` at the
  // end of processing instead, so nullability is never silently lost.
  if (isNullable) {
    const type = result['type'];
    if (type === undefined) {
      frame.wrapNullable = true;
    } else if (Array.isArray(type)) {
      if (!type.includes('null')) {
        result['type'] = [...type, 'null'];
      }
    } else if (type !== 'null') {
      result['type'] = [type, 'null'];
    }
  }

  // OpenAPI `example` (singular) -> JSON Schema 2020-12 `examples` array.
  // When the schema already declares an `examples` array (OpenAPI 3.1), it wins.
  if (example !== undefined && !Array.isArray(result['examples'])) {
    result['examples'] = [example];
  }

  // Handle exclusiveMaximum conversion
  if (typeof exclusiveMaximum === 'boolean') {
    if (exclusiveMaximum && maximum !== undefined) {
      // true + maximum present -> convert to numeric exclusiveMaximum
      result['exclusiveMaximum'] = maximum;
    } else if (maximum !== undefined) {
      // false or true without maximum -> keep maximum only
      result['maximum'] = maximum;
    }
    // Boolean exclusiveMaximum is never added (invalid in JSON Schema 7)
  } else if (exclusiveMaximum !== undefined) {
    // Already numeric (OpenAPI 3.1) - keep as is
    result['exclusiveMaximum'] = exclusiveMaximum;
    if (maximum !== undefined) {
      result['maximum'] = maximum;
    }
  } else if (maximum !== undefined) {
    // No exclusiveMaximum, just maximum
    result['maximum'] = maximum;
  }

  // Handle exclusiveMinimum conversion
  if (typeof exclusiveMinimum === 'boolean') {
    if (exclusiveMinimum && minimum !== undefined) {
      // true + minimum present -> convert to numeric exclusiveMinimum
      result['exclusiveMinimum'] = minimum;
    } else if (minimum !== undefined) {
      // false or true without minimum -> keep minimum only
      result['minimum'] = minimum;
    }
    // Boolean exclusiveMinimum is never added (invalid in JSON Schema 7)
  } else if (exclusiveMinimum !== undefined) {
    // Already numeric (OpenAPI 3.1) - keep as is
    result['exclusiveMinimum'] = exclusiveMinimum;
    if (minimum !== undefined) {
      result['minimum'] = minimum;
    }
  } else if (minimum !== undefined) {
    // No exclusiveMinimum, just minimum
    result['minimum'] = minimum;
  }

  // Nested schemas are converted too, so all of them are valid JSON Schema.
  // Their containers are built now; each slot is filled as its child finishes.
  if (result['properties'] && typeof result['properties'] === 'object') {
    const props: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(result['properties'] as Record<string, SchemaObject | ReferenceObject>)) {
      slots.push(props, key, value, childDepth);
    }
    result['properties'] = props;
  }

  const items = result['items'];
  if (items) {
    if (Array.isArray(items)) {
      result['items'] = queueMembers(items, childDepth, slots, state);
    } else {
      slots.push(result, 'items', items, childDepth);
    }
  }

  if (result['additionalProperties'] && typeof result['additionalProperties'] === 'object') {
    slots.push(result, 'additionalProperties', result['additionalProperties'], childDepth);
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const members = result[key];
    if (members && Array.isArray(members)) {
      // allOf members merge into their parent (request-body flattening hoists
      // them), so they don't consume depth — see SchemaConversionOptions.maxDepth
      result[key] = queueMembers(members, key === 'allOf' ? depth : childDepth, slots, state);
    }
  }

  if (result['not']) {
    slots.push(result, 'not', result['not'], childDepth);
  }

  // Remaining JSON Schema 2020-12 structural keywords, so nested `nullable`/
  // `example`/`xml` under them receive the same normalization as the root.
  // Map-of-schemas keywords:
  for (const key of SCHEMA_MAP_KEYWORDS) {
    const value = result[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const mapped: Record<string, JsonSchema> = {};
      for (const [name, sub] of Object.entries(value as Record<string, SchemaObject | ReferenceObject>)) {
        slots.push(mapped, name, sub, childDepth);
      }
      result[key] = mapped;
    }
  }
  // Single-schema keywords (`unevaluated*` may be boolean — object guard skips those):
  for (const key of SCHEMA_SINGLE_KEYWORDS) {
    const value = result[key];
    if (value && typeof value === 'object') {
      slots.push(result, key, value, childDepth);
    }
  }
  // Array-of-schemas keyword:
  const prefixItems = result['prefixItems'];
  if (Array.isArray(prefixItems)) {
    result['prefixItems'] = queueMembers(prefixItems, childDepth, slots, state);
  }

  if (slots.length === 0) return finishSchema(frame, state);
  frames.push(frame);
  return PENDING;
}

/**
 * MCP tool annotations — behavior hints for clients (MCP spec 2025-03-26).
 * Hints are advisory: clients must not treat them as security guarantees.
 */
export interface ToolAnnotations {
  /**
   * Legacy display-name slot inside annotations. Prefer the tool-level `title`.
   */
  title?: string;

  /**
   * Tool only reads data, never modifies state.
   */
  readOnlyHint?: boolean;

  /**
   * Tool may perform destructive updates (delete, overwrite).
   */
  destructiveHint?: boolean;

  /**
   * Calling repeatedly with the same arguments has no additional effect.
   */
  idempotentHint?: boolean;

  /**
   * Tool interacts with an open world of external entities.
   */
  openWorldHint?: boolean;
}

/**
 * Tool icon (MCP spec 2025-11-25).
 */
export interface ToolIcon {
  /**
   * Icon URI (`https:` or `data:`).
   */
  src: string;

  /**
   * MIME type, e.g. `image/png`.
   */
  mimeType?: string;

  /**
   * Sizes the icon is available in, e.g. `['48x48', 'any']`.
   */
  sizes?: string[];
}

/**
 * Main MCP Tool definition generated from OpenAPI.
 *
 * `TMeta` lets embedding frameworks extend the metadata contract without
 * casting — e.g. `McpOpenAPITool<ToolMetadata & { adapter: AdapterState }>`.
 */
export interface McpOpenAPITool<TMeta extends ToolMetadata = ToolMetadata> {
  /**
   * Unique tool name (from operationId or generated)
   */
  name: string;

  /**
   * Human-readable display name (MCP `Tool.title`, spec 2025-06-18).
   * From extension overrides or the operation summary.
   */
  title?: string;

  /**
   * Tool description (from operation summary/description)
   */
  description: string;

  /**
   * MCP tool annotations. Inferred from HTTP method semantics by default
   * (see `GenerateOptions.inferAnnotations`) and overridable via the
   * `x-speakeasy-mcp` / `x-mcp` / `x-frontmcp` extensions (in ascending
   * precedence).
   */
  annotations?: ToolAnnotations;

  /**
   * MCP `_meta` (spec 2025-06-18): namespaced, client-visible metadata.
   * Contains the `dev.agentfront.openapi/operation` entry when
   * `GenerateOptions.emitMeta` is set, plus any `meta` object supplied via
   * the `x-mcp` / `x-frontmcp` extensions (emitted even when the flag is
   * off). Extension keys under `dev.agentfront.openapi/` are ignored, and
   * pollution-gadget keys are stripped recursively.
   */
  _meta?: Record<string, unknown>;

  /**
   * Tool icons (MCP spec 2025-11-25). From `x-frontmcp.icons` /
   * `x-mcp.icons`, or the document's `info['x-logo']` when
   * `GenerateOptions.inheritDocumentIcons` is set.
   */
  icons?: ToolIcon[];

  /**
   * Combined input schema including all parameters
   * (path, query, header, cookie, body)
   */
  inputSchema: JsonSchema;

  /**
   * Output schema based on response definitions
   * Can be a union of multiple status codes
   */
  outputSchema?: JsonSchema;

  /**
   * Mapping from input schema properties to actual request parameters
   */
  mapper: ParameterMapper[];

  /**
   * Additional metadata about the tool
   */
  metadata: TMeta;
}

/**
 * Maps input schema properties to their actual request locations
 */
export interface ParameterMapper {
  /**
   * Property name in the input schema
   */
  inputKey: string;

  /**
   * Where this parameter should be placed in the request
   */
  type: ParameterLocation;

  /**
   * Original parameter name (before conflict resolution)
   */
  key: string;

  /**
   * Whether this parameter is required
   */
  required?: boolean;

  /**
   * Parameter style (for path/query parameters). Absent for a parameter
   * defined with `content`: OpenAPI says `style`, `explode` and
   * `allowReserved` do not apply to it (see `serialization.contentType`).
   */
  style?: string;

  /**
   * Whether to explode arrays/objects. Absent for a parameter defined with
   * `content`.
   */
  explode?: boolean;

  /**
   * Whether RFC 3986 reserved characters may appear unencoded in the value
   * (query parameters only, OpenAPI `allowReserved`). Absent for a parameter
   * defined with `content`.
   */
  allowReserved?: boolean;

  /**
   * Custom serialization info. For a `path`/`query`/`header`/`cookie`
   * parameter it is present only when the parameter is defined with
   * `content` (a media type) instead of `schema`, or is a whole-query
   * parameter (`wholeQuery`): `serialization.contentType` is then the media
   * type the value is serialized in.
   */
  serialization?: SerializationInfo;

  /**
   * When true, this input value IS the entire request body — set for
   * non-object bodies (arrays, primitives, binary) and for `oneOf`/`anyOf`
   * union bodies that cannot be flattened into named properties. Consumers
   * building requests must send the value directly as the body instead of
   * wrapping it in an object keyed by `key`.
   */
  wholeBody?: boolean;

  /**
   * When true, this input value IS the entire query string — set only on a
   * `type: 'query'` entry, for an OpenAPI 3.2 parameter `in: querystring`.
   * Such a parameter is defined with `content` holding one media type:
   * `serialization.contentType` is that media type, and the value is
   * serialized in it to form the whole query string (for
   * `application/x-www-form-urlencoded`, `serialization.encoding` carries the
   * media type's Encoding Objects, as for a body). `key` is the parameter's
   * name, which is not sent. Mirrors `wholeBody`. An operation has at most
   * one such entry and then no other `query` parameter (security `apiKey`
   * entries in the query aside).
   */
  wholeQuery?: true;

  /**
   * Security scheme information (if this is an auth parameter)
   * This allows frameworks to resolve auth from context, env vars, etc.
   */
  security?: SecurityParameterInfo;
}

/**
 * Serialization information for complex parameters
 */
export interface SerializationInfo {
  /**
   * The media type the value is serialized in:
   *
   * - a body parameter: the request body's media type;
   * - a `path`/`query`/`header`/`cookie` parameter defined with `content`
   *   instead of `schema` (any OpenAPI 3 version): the media type of its
   *   `content` entry. The value is serialized in that media type (for
   *   example `application/json` gives the JSON text), and `style`,
   *   `explode` and `allowReserved` do not apply;
   * - a whole-query parameter (`ParameterMapper.wholeQuery`, OpenAPI 3.2
   *   `in: querystring`): the media type of the whole query string.
   */
  contentType?: string;

  /**
   * Encoding rules from the media type (OpenAPI `encoding`). For a
   * flattened body-property parameter this contains only that property's
   * entry; for a whole-body parameter it is the full map. A parameter
   * defined with `content` (whole-query parameters included) carries its
   * media type's full map too, as a whole body does — it applies to
   * `application/x-www-form-urlencoded` content.
   */
  encoding?: Record<string, EncodingObject>;

  /**
   * File-upload marker: the parameter schema declares binary content
   * (`format: binary`), e.g. a multipart file part or a raw binary body.
   */
  binary?: boolean;
}

/**
 * Security parameter information for framework-agnostic auth resolution
 */
export interface SecurityParameterInfo {
  /**
   * Security scheme name from OpenAPI (e.g., "BearerAuth")
   */
  scheme: string;

  /**
   * Security type (apiKey, http, oauth2, openIdConnect)
   */
  type: AuthType;

  /**
   * HTTP authentication scheme (for type: "http")
   * e.g., "bearer", "basic"
   */
  httpScheme?: string;

  /**
   * Bearer token format (e.g., "JWT")
   */
  bearerFormat?: string;

  /**
   * Required OAuth2 scopes
   */
  scopes?: string[];

  /**
   * API key parameter name (for type: "apiKey")
   */
  apiKeyName?: string;

  /**
   * API key location (for type: "apiKey")
   */
  apiKeyIn?: 'query' | 'header' | 'cookie';

  /**
   * Description of the security scheme
   */
  description?: string;
}

/**
 * Additional metadata about the generated tool
 */
export interface ToolMetadata {
  /**
   * Original OpenAPI path
   */
  path: string;

  /**
   * HTTP method: the lowercase field name for a fixed operation (`get`,
   * `query`, ...), the `additionalOperations` key exactly as written
   * otherwise (`LINK`)
   */
  method: HTTPMethod;

  /**
   * Operation ID from OpenAPI
   */
  operationId?: string;

  /**
   * Operation summary from OpenAPI (short description)
   */
  operationSummary?: string;

  /**
   * Operation description from OpenAPI (detailed description)
   */
  operationDescription?: string;

  /**
   * Tags from OpenAPI
   */
  tags?: string[];

  /**
   * Whether operation is deprecated
   */
  deprecated?: boolean;

  /**
   * Security requirements
   */
  security?: SecurityRequirement[];

  /**
   * Server information
   */
  servers?: ServerInfo[];

  /**
   * Response status codes included in output schema: each explicit code
   * (`200`), and 0 for `default`. A range (`2XX`) is not a number, so it is
   * listed in `responseStatusRanges` instead.
   */
  responseStatusCodes?: number[];

  /**
   * Response status ranges included in output schema (`2XX`, `4XX`: OpenAPI
   * range keys, any case in the document, upper-cased here), in output order.
   * Absent when the output holds no range.
   */
  responseStatusRanges?: ResponseStatusRange[];

  /**
   * External documentation
   */
  externalDocs?: ExternalDocumentationObject;

  /**
   * FrontMCP extension data from x-frontmcp in the OpenAPI operation.
   * Contains annotations, cache config, codecall config, tags, etc.
   */
  frontmcp?: FrontMcpExtensionData;

  /**
   * Response-shaping signals for consumers that paginate, truncate, or cache:
   * present only when there is something to know.
   */
  responseHints?: ResponseHints;

  /**
   * The streamed response of the operation (OpenAPI 3.2): a response with a
   * media type that declares `itemSchema`, the schema of each item of a
   * sequential media type such as `text/event-stream` (Server-Sent Events),
   * `application/jsonl`, `application/x-ndjson`, `application/json-seq` or
   * `multipart/mixed`. Present only then, with `responseHints.streaming`.
   *
   * The stream is not part of `outputSchema`: an MCP tool that declares an
   * output schema must return its complete result as structured content,
   * which an unbounded stream is not. A media type with only `itemSchema`
   * therefore contributes nothing to `outputSchema` (which is absent when no
   * other media type or response has a schema); one with both `schema` and
   * `itemSchema` gives `outputSchema` from `schema` and this from
   * `itemSchema`. The stream's media type is chosen apart from the output
   * schema's, so a response offering `application/json` (with `schema`) and
   * `text/event-stream` (with `itemSchema`) gives both. Of several streamed
   * responses, the preferred one; of several media types, the first with
   * `itemSchema` in document order (see `ResponseStreamInfo`).
   */
  responseStream?: ResponseStreamInfo;

  /**
   * TypeScript rendering of the tool's call contract — present when
   * `GenerateOptions.emitTypeSignatures` is set. Computed on the FINAL
   * schemas (after formats, depth truncation, trimming, and client-target
   * transforms). The return type is the UNWRAPPED response type.
   */
  typescript?: import('./type-signature').ToolTypeScriptInfo;

  /**
   * Arazzo workflow IR — present only on tools produced by `fromArazzo()`.
   * When set, `path`/`method` are non-HTTP placeholders
   * (`arazzo:<workflowId>` / `'post'`); executors must drive requests from
   * `workflow.steps[*].operation.mapper`, never from this tool's (empty)
   * top-level mapper.
   */
  workflow?: import('./arazzo-types').WorkflowIR;
}

/**
 * Detected response-shaping signals. Clients cap tool results hard (Claude
 * Code: 25K tokens) — these hints tell a consumer WHICH tools need paging or
 * truncation before the first oversized response happens.
 */
export interface ResponseHints {
  /** The success response contains an array without `maxItems` */
  unboundedArray?: boolean;

  /** Query parameters that look like pagination controls (limit, cursor, ...) */
  paginationParams?: string[];

  /** Unbounded array AND no pagination controls: truncate or shape server-side */
  largeResponseRisk?: boolean;

  /**
   * The operation streams its response (OpenAPI 3.2 `itemSchema`): read it
   * item by item; `ToolMetadata.responseStream` describes the items
   */
  streaming?: boolean;
}

/**
 * An OpenAPI response range key (`1XX` to `5XX`; the document may write it in
 * any case), as the output gives it: `x-status-code` of an output schema,
 * `ToolMetadata.responseStatusRanges`, `ResponseStreamInfo.statusCode`.
 */
export type ResponseStatusRange = '1XX' | '2XX' | '3XX' | '4XX' | '5XX';

/**
 * A streamed response (`ToolMetadata.responseStream`): an OpenAPI 3.2 Media
 * Type Object with `itemSchema`.
 *
 * - The response is chosen among an operation's streamed responses as
 *   `GenerateOptions.includeAllResponses: false` chooses one output schema
 *   (see `GenerateOptions.preferredStatusCodes`; `default` only when no
 *   status code or range streams).
 * - Within it, the media type is the first one in the response's `content`, in
 *   the document's key order, that declares `itemSchema`; it is chosen
 *   independently of the media type the output schema comes from.
 */
export interface ResponseStreamInfo {
  /**
   * The response's status code as the output schema's `x-status-code` gives
   * it: the code (`200`), the range upper-cased (`'2XX'`), or 0 for `default`
   */
  statusCode: number | ResponseStatusRange;

  /** The sequential media type, as the document writes it (`text/event-stream`, `application/jsonl`, ...) */
  contentType: string;

  /**
   * The schema of each item, converted like an output schema: JSON Schema
   * 2020-12, with the same format resolution, `maxSchemaDepth` /
   * `maxSchemaNodes` limits, trimming options and client `target`. For
   * `text/event-stream`, an item is one parsed event (`data`, `event`, `id`,
   * `retry`)
   */
  itemSchema: JsonSchema;
}

/**
 * FrontMCP extension data extracted from x-frontmcp in OpenAPI operations.
 * This provides declarative configuration for tools directly in the OpenAPI spec.
 */
export interface FrontMcpExtensionData {
  /**
   * Tool annotations for AI behavior hints (same contract as the tool-level
   * `annotations` field).
   */
  annotations?: ToolAnnotations;

  /**
   * Cache configuration for response caching.
   */
  cache?: {
    ttl?: number;
    slideWindow?: boolean;
  };

  /**
   * CodeCall-specific configuration.
   */
  codecall?: {
    enabledInCodeCall?: boolean;
    visibleInListTools?: boolean;
  };

  /**
   * Tags/labels for categorization.
   */
  tags?: string[];

  /**
   * If true, hide tool from discovery.
   */
  hideFromDiscovery?: boolean;

  /**
   * Usage examples.
   */
  examples?: Array<{
    description: string;
    input: Record<string, unknown>;
    output?: unknown;
  }>;

  /**
   * MCP `_meta` entries to emit on the tool.
   */
  meta?: Record<string, unknown>;

  /**
   * Tool icons to emit on the tool.
   */
  icons?: ToolIcon[];
}

/**
 * Security requirement definition
 */
export interface SecurityRequirement {
  /**
   * Security scheme name
   */
  scheme: string;

  /**
   * Security type
   */
  type: AuthType;

  /**
   * Scopes required (for OAuth2/OpenID Connect)
   */
  scopes?: string[];

  /**
   * Parameter name (for API key)
   */
  name?: string;

  /**
   * Parameter location (for API key)
   */
  in?: 'query' | 'header' | 'cookie';

  /**
   * HTTP authentication scheme (for type: "http")
   * e.g., "bearer", "basic"
   */
  httpScheme?: string;

  /**
   * Bearer token format (e.g., "JWT")
   */
  bearerFormat?: string;

  /**
   * Description of the security scheme
   */
  description?: string;
}

/**
 * Server information
 */
export interface ServerInfo {
  /**
   * Server URL
   */
  url: string;

  /**
   * The server's unique name (OpenAPI 3.2 Server Object `name`), when the
   * document gives one. Kept when `LoadOptions.baseUrl` replaces the URL,
   * like `description`
   */
  name?: string;

  /**
   * Server description
   */
  description?: string;

  /**
   * Server variables
   */
  variables?: Record<string, ServerVariableObject>;
}

/**
 * Controls how external `$ref` pointers are resolved during dereferencing, and
 * the host policy applied to the initial spec-URL fetch in `fromURL`.
 *
 * By default only http/https protocols are allowed and internal/private targets
 * are blocked to prevent SSRF. As of 2.5.0 the guard validates the **resolved
 * IP** (it resolves DNS and rejects hostnames that map to internal addresses —
 * e.g. `127.0.0.1.nip.io`), normalizes IPv4-mapped IPv6, and re-validates every
 * HTTP redirect hop. `allowedHosts` / `blockedHosts` / `allowInternalIPs` apply
 * to both the spec URL and external `$ref`s.
 */
export interface RefResolutionOptions {
  /**
   * Protocols allowed for external $ref resolution.
   * Any protocol string is accepted (http, https, ftp, ws, wss, etc.).
   * A relative `$ref` is retrieved against the document's retrieval URI
   * (its file for `fromFile`, its final URL for `fromURL`, or
   * `LoadOptions.documentUri`) whenever one is known; `$self` (OpenAPI 3.2)
   * is the retrieval base only for `fromJSON`/`fromYAML` without
   * `documentUri`, and then only when absolute. The result must pass these
   * rules like an absolute one: a multi-file description on disk needs
   * `file`. Allowing `file` allows
   * every local file the process can read: references are not confined to
   * the document's folder (`../../etc/hosts` is read too), so do not allow
   * it for documents you do not trust. A `$ref` to the document itself is
   * resolved locally and needs no protocol. A refused `$ref` fails with a
   * `ParseError` naming the reference, its base, the rule
   * (`context.rule`) and the option that would allow it.
   * @default ['http', 'https']
   */
  allowedProtocols?: string[];

  /**
   * Hostnames allowed for external $ref resolution (network protocols only).
   * When set, only refs pointing to these hosts are resolved.
   * When not set, all hosts are allowed except blocked internal ranges.
   * Matched case-insensitively, ignoring trailing root dots and IPv6 brackets.
   */
  allowedHosts?: string[];

  /**
   * Additional hostnames/IPs to block. Applied on top of the built-in
   * internal IP block list (localhost, 169.254.x.x, 10.x.x.x, etc.).
   * Matched case-insensitively, ignoring trailing root dots and IPv6 brackets,
   * so `internal.corp` also blocks `internal.corp.`.
   */
  blockedHosts?: string[];

  /**
   * Disable the built-in internal/private IP block list.
   * WARNING: Enabling this may expose your application to SSRF attacks
   * against cloud metadata endpoints and internal services.
   * @default false
   */
  allowInternalIPs?: boolean;

  /**
   * The most referenced documents one dereference reads; past it the load fails (rule `too-many-documents`).
   * @default 10000
   */
  maxDocuments?: number;

  /**
   * The most bytes all referenced documents of one dereference may hold together; past it the load fails (rule `too-large`).
   * @default 104857600
   */
  maxTotalBytes?: number;
}

/** Default `RefResolutionOptions.maxDocuments` */
export const DEFAULT_MAX_REFERENCED_DOCUMENTS = 10_000;

/** Default `RefResolutionOptions.maxTotalBytes`: 100 MiB */
export const DEFAULT_MAX_REFERENCED_BYTES = 100 * 1024 * 1024;

/**
 * Options for loading OpenAPI specifications
 */
export interface LoadOptions {
  /**
   * Whether to dereference $refs in schemas
   * @default true
   */
  dereference?: boolean;

  /**
   * Base URL for API requests
   * Overrides servers in OpenAPI spec
   */
  baseUrl?: string;

  /**
   * The URI the document was retrieved from. Relative `$ref`s (and a
   * relative `$self`) are resolved against it to be read, and it names the
   * document, so a `$ref` to it stays local instead of being fetched. An
   * absolute `http`, `https` or `file` URI of at most 2,048 characters,
   * without user information, fragment or (for a file URI) host; anything
   * else throws a `LoadError` before anything is read (user information is
   * never quoted back).
   *
   * `fromURL` sets it to the final URL of the spec (after redirects, without
   * user information) and `fromFile` to the file's `file:` URL; passing it
   * replaces that, for example to resolve a local copy as if it were read
   * from where it is published. `fromJSON` and `fromYAML` have none unless it
   * is passed: then relative external `$ref`s resolve against an absolute
   * `$self` (OpenAPI 3.2), or else against the process working directory, as
   * in earlier releases. With a retrieval URI, `$self` only names the
   * document: it never moves where relative references are read from. It is
   * not `baseUrl`, the API's address, and never changes `servers`.
   */
  documentUri?: string;

  /**
   * Custom HTTP headers for loading from URL (e.g. the spec host's
   * `Authorization`). Sent only to the spec URL's origin: if a redirect leaves
   * that origin (host, port, or scheme), they are dropped for every remaining
   * hop. Never sent to external `$ref` hosts.
   */
  headers?: Record<string, string>;

  /**
   * Request timeout in milliseconds
   * @default 30000
   */
  timeout?: number;

  /**
   * Whether to validate the OpenAPI document
   * @default true
   */
  validate?: boolean;

  /**
   * Whether to follow HTTP redirects when fetching the spec URL. Each redirect
   * hop is re-validated against the SSRF guard before being followed (a 3xx to
   * an internal target is refused), so following is safe by default.
   * @default true (false when `secureDefaults` is set)
   */
  followRedirects?: boolean;

  /**
   * OpenAPI Overlay 1.0 document(s) applied to the spec at load time, BEFORE
   * dereferencing and validation, in order. Overlays keep curation
   * (agent-tuned descriptions, `x-mcp` flags) in a separate file that
   * survives spec regeneration. See `applyOverlay` for the supported
   * JSONPath subset.
   */
  overlays?: import('./overlay').OverlayDocument | import('./overlay').OverlayDocument[];

  /**
   * Opt into the strictest loading posture in one flag: redirects are not
   * followed and external `$ref` resolution is disabled entirely
   * (`refResolution.allowedProtocols: []`) — the right default when loading
   * untrusted specs. A `$ref` to the document's own URI (its retrieval URI
   * or `$self`) is not external: it is still resolved, without a fetch.
   * Explicitly-set `followRedirects`/`refResolution` values still win over
   * the preset.
   * @default false
   */
  secureDefaults?: boolean;

  /**
   * Controls spec-loading security: external `$ref` resolution AND the host
   * policy for the initial spec-URL fetch. By default `file://` is blocked,
   * internal/private targets are blocked, and hostnames are DNS-resolved and
   * re-checked against the internal-address ranges.
   * @see RefResolutionOptions
   */
  refResolution?: RefResolutionOptions;
}

/**
 * Operation object with additional context for filtering
 */
export type OperationWithContext = OperationObject & {
  path: string;
  method: string;
};

/**
 * Options for generating tools
 */
export interface GenerateOptions {
  /**
   * Include only these operation IDs
   */
  includeOperations?: string[];

  /**
   * Exclude these operation IDs
   */
  excludeOperations?: string[];

  /**
   * Custom filter function
   */
  filterFn?: (operation: OperationWithContext) => boolean;

  /**
   * Include only operations carrying at least one of these OpenAPI tags
   */
  includeTags?: string[];

  /**
   * Exclude operations carrying any of these OpenAPI tags
   */
  excludeTags?: string[];

  /**
   * Include only these HTTP methods. A standard method matches in any case
   * (`'GET'` and `'get'` both match the `get` operations); an
   * `additionalOperations` method matches only exactly as written (`'LINK'`)
   */
  includeMethods?: HTTPMethod[];

  /**
   * Exclude these HTTP methods; matched like `includeMethods`
   */
  excludeMethods?: HTTPMethod[];

  /**
   * Include only paths matching at least one of these globs.
   * `*` matches within a path segment, `**` across segments, `?` one character
   * (e.g. `/users/*`, `/admin/**`).
   */
  includePaths?: string[];

  /**
   * Exclude paths matching any of these globs
   */
  excludePaths?: string[];

  /**
   * Safety switch: include only operations whose effective annotations say
   * `readOnlyHint: true` (HTTP-method inference merged with extension
   * overrides, regardless of `inferAnnotations`).
   */
  readOnlyOnly?: boolean;

  /**
   * Naming strategy for resolving conflicts
   */
  namingStrategy?: NamingStrategy;

  /**
   * Preferred response status codes (in order of preference), for the one
   * output schema of `includeAllResponses: false` and for the streamed
   * response. The response chosen is the first that matches:
   *
   * 1. an explicit status code in this list, in its order;
   * 2. any explicit 2xx status code (the success class);
   * 3. a range key (`2XX`, any case) covering a code in this list, in its
   *    order, else the `2XX` range;
   * 4. any explicit 3xx status code, else the `3XX` range;
   * 5. the first response with a schema (`default` only when nothing else
   *    has one).
   *
   * So an explicit code wins over the range of its class when the code is in
   * this list (rule 1) and whenever it is a 2xx (rule 2: `{ 299, 2XX }` gives
   * 299, although `2XX` covers the preferred 200). A 3xx code wins over `3XX`
   * only while no range covers a code of this list (rule 3 comes first:
   * `{ 399, 3XX }` gives `3XX` with `[301]`, 399 with the default). In the
   * other classes the range wins when it covers a code of this list
   * (`{ 499, 4XX }` gives `4XX` with `[404]`); otherwise rule 5 takes the
   * first in key order (integer keys first, so 499 with the default).
   * @default [200, 201, 204, 202, 203, 206]
   */
  preferredStatusCodes?: number[];

  /**
   * Whether to include deprecated operations
   * @default false
   */
  includeDeprecated?: boolean;

  /**
   * Whether to include all response codes in output schema
   * If false, only preferred status code is used
   * @default true
   */
  includeAllResponses?: boolean;

  /**
   * Maximum schema nesting depth retained in generated input/output schemas.
   * Structures nested deeper than this are truncated: child schemas are
   * stripped and a truncation note is appended to the node's description.
   * Clamped to a minimum of 1 so the root schema always keeps its properties.
   * @default 10
   */
  maxSchemaDepth?: number;

  /**
   * Node budget for each generated input/output schema. Shared `$ref` targets
   * are converted once, but the emitted schema spells every occurrence out,
   * so a small spec that references the same schema many times can still
   * expand into an enormous tree. The budget bounds each of the tool's
   * schemas — every JSON value in it counts — and the conversion work for one
   * parameter, request body, or response (each schema visited, plus each
   * keyword of each schema converted). A schema over it at `maxSchemaDepth`
   * is built again at the deepest depth that fits, with a
   * `SCHEMA_DEPTH_REDUCED` warning. Generating the tool fails with a
   * `SchemaError` when not even depth 1 fits, or when the spec values the
   * tool copies (title, metadata, mapper objects, extension meta) or a client
   * target's inlining of local `$ref`s exceed it; `generateTools()` skips that
   * tool with a warning, like any other per-tool failure. A `$ref` inside a
   * schema's `x-` extension is kept as written, so it costs two nodes, not
   * the graph it names. `Infinity` disables the budget.
   * @default 25000
   */
  maxSchemaNodes?: number;

  /**
   * The most schema nodes all generated tools may hold together (input, output and stream item schemas).
   * Past it generation stops with a `SchemaError`. Unlimited by default; `SECURE_MAX_TOTAL_SCHEMA_NODES`
   * for a generator loaded with `secureDefaults: true`.
   */
  maxTotalSchemaNodes?: number;

  /**
   * How the tool description is assembled from the operation:
   * - `summaryOnly` (default): summary, else description, else `METHOD path`
   * - `descriptionOnly`: description, else summary, else `METHOD path`
   * - `combined`: summary + blank line + description (whichever exist)
   * - `full`: summary, description, `Operation: <id>`, and `METHOD path`
   * An `x-mcp`-family description override always wins over the strategy.
   * @default 'summaryOnly'
   */
  descriptionStrategy?: 'summaryOnly' | 'descriptionOnly' | 'combined' | 'full';

  /**
   * Append a compact `Returns: ...` line to each tool description,
   * summarizing the output schema (top-level shape and field names) — cheap
   * context that measurably improves result-handling without shipping the
   * whole response schema in prose.
   * @default false
   */
  appendResponseSummary?: boolean;

  /**
   * Limit object nodes in generated schemas to their first N properties
   * (declaration order). Dropped properties are pruned from `required` and
   * counted in a description note. The ROOT of `inputSchema` is exempt: its
   * properties are mapper-backed parameters, so the cap applies inside each
   * parameter subtree (and throughout output schemas). Unset = no limit.
   */
  maxProperties?: number;

  /**
   * Cap every description in generated schemas to N characters (ellipsis
   * truncation). Unset = no cap.
   */
  maxDescriptionLength?: number;

  /**
   * Remove all `examples` arrays from generated schemas — a token-budget
   * trimming step that leaves validation keywords untouched.
   * @default false
   */
  stripExamples?: boolean;

  /**
   * Include OpenAPI parameter-level and media-type-level `example`/`examples`
   * values in generated schemas (as JSON Schema `examples` arrays). These
   * override schema-level examples where present. Schema-level `example`
   * keywords are always normalized to `examples` regardless of this option.
   * @default false
   */
  includeExamples?: boolean;

  /**
   * Whether to include security requirements as input parameters.
   * - `false` (default): security lives only in the mapper (frameworks
   *   resolve credentials from context/env/vaults)
   * - `true`: every security scheme is added to inputSchema as a required
   *   string property
   * - `string[]`: only the named schemes appear in inputSchema; the rest stay
   *   mapper-only (all schemes are always present in the mapper)
   * @default false
   */
  includeSecurityInInput?: boolean | string[];

  /**
   * Target client schema dialect. Every MCP client accepts a different JSON
   * Schema subset; setting a target applies the transforms that make the
   * generated input/output schemas valid for it: `strict` (safe baseline —
   * local $refs inlined, arrays get `items`, root compositions collapsed),
   * `claude` (= strict), `openai` (strict + closed objects), `gemini`
   * (strict + all unions collapsed + unsupported formats demoted).
   * See `applyClientTarget` for standalone use.
   */
  target?: import('./client-targets').ClientTarget;

  /**
   * Infer MCP tool annotations from HTTP method semantics:
   * GET/HEAD/OPTIONS/TRACE -> read-only + idempotent; PUT/DELETE ->
   * destructive + idempotent; POST/PATCH -> destructive, not idempotent.
   * `openWorldHint` defaults to false (a known API backend is a closed world).
   * Extension overrides (`x-speakeasy-mcp`, `x-mcp`, `x-frontmcp`) are applied
   * on top of the inferred values regardless of this flag.
   * @default true
   */
  inferAnnotations?: boolean;

  /**
   * Maximum length for generated tool names. Names longer than this are
   * truncated and given a short hash suffix derived from the full name, so
   * truncated names stay unique and stable across regenerations.
   *
   * MCP tool names may be 1-128 characters of `[A-Za-z0-9_.-]` (values above
   * 128 are clamped to 128). The default of 64 matches the strictest common
   * client limits (Claude / Bedrock cap tool names at 64 characters).
   * @default 64
   */
  maxToolNameLength?: number;

  /**
   * Enable built-in format-to-schema resolution.
   * Enriches schemas with concrete constraints (patterns, descriptions, min/max)
   * based on OpenAPI format values (uuid, date-time, email, int32, etc.).
   * @default false
   */
  resolveFormats?: boolean;

  /**
   * Custom format resolvers. Keys are format names, values are functions
   * that receive the original schema and return an enriched schema.
   *
   * When used with `resolveFormats: true`, custom resolvers are merged with
   * built-in resolvers (custom takes precedence for the same format).
   * When used without `resolveFormats`, only custom resolvers are applied.
   */
  formatResolvers?: Record<string, FormatResolver>;

  /**
   * Emit a TypeScript rendering of each tool's call contract as
   * `metadata.typescript = { signature, declaration }`. The signature is a
   * one-line arrow type with inline anonymous types; the declaration is a
   * self-contained block with named `<ToolName>Input` / `<ToolName>Output`
   * types and JSDoc from schema descriptions. Computed on the FINAL schemas
   * (after format resolution, depth truncation, trimming, and client-target
   * transforms). The return type is the unwrapped OpenAPI response type —
   * consumers that wrap results must wrap the type themselves.
   * @default false
   */
  emitTypeSignatures?: boolean;

  /**
   * Emit `_meta['dev.agentfront.openapi/operation']` on every tool with the
   * source operation's coordinates: `{ path, method, operationId?, tags?,
   * deprecated?, specTitle?, specVersion? }` (reverse-DNS key per MCP `_meta`
   * conventions). Extension-supplied `meta` (`x-mcp` / `x-frontmcp`) merges
   * on top and is emitted even when this flag is off.
   * @default false
   */
  emitMeta?: boolean;

  /**
   * When an operation has no extension-supplied icons, fall back to the
   * document's `info['x-logo']` (Redoc convention) as a single icon applied
   * to every tool. Off by default so one logo doesn't silently inflate all
   * tool definitions.
   * @default false
   */
  inheritDocumentIcons?: boolean;
}

/**
 * A function that enriches a JSON Schema based on its format field.
 * Receives the schema and returns a new schema with additional constraints.
 */
export type FormatResolver = (schema: JsonSchema) => JsonSchema;

/**
 * Naming strategy for resolving parameter conflicts
 */
export interface NamingStrategy {
  /**
   * Resolver function for parameter name conflicts.
   * @param paramName - Original parameter name
   * @param location - Parameter location
   * @param index - Index of conflicting parameter (0-based)
   * @returns New parameter name
   * @default a location-prefix resolver (`headerX_Trace`-style)
   */
  conflictResolver?: (paramName: string, location: ParameterLocation, index: number) => string;

  /**
   * Function to generate tool names
   * @param path - OpenAPI path
   * @param method - HTTP method
   * @param operationId - Operation ID if available (an `x-mcp` family name
   *   override arrives through this argument in place of the operationId)
   * @param operation - The full operation object (for tag-aware strategies)
   * @returns Tool name
   */
  toolNameGenerator?: (path: string, method: HTTPMethod, operationId?: string, operation?: OperationObject) => string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  /**
   * Whether the document is valid
   */
  valid: boolean;

  /**
   * Validation errors
   */
  errors?: ValidationErrorDetail[];

  /**
   * Validation warnings
   */
  warnings?: ValidationWarning[];
}

/**
 * Validation error detail
 */
export interface ValidationErrorDetail {
  /**
   * Error message
   */
  message: string;

  /**
   * Where the error is, in one of two forms:
   *
   * - The codes that predate OpenAPI 3.2 support (`INVALID_PATH_FORMAT`,
   *   `NO_OPERATIONS`, `NO_OPERATION_ID`, `NO_RESPONSES`,
   *   `MISSING_PATH_PARAMETER`, `MISSING_PARAMETER_NAME`,
   *   `MISSING_PARAMETER_IN`, `INVALID_PARAMETER_IN`,
   *   `PATH_PARAMETER_NOT_REQUIRED`, `MISSING_PARAMETER_SCHEMA`) keep their
   *   historical form: `/paths/` and the path key as written, NOT escaped
   *   (`/paths//pets/{id}/get/responses`). A path key longer than
   *   `LEGACY_PATH_KEY_MAX_LENGTH` characters is cut.
   * - Every other code uses an RFC 6901 JSON Pointer
   *   (`/paths/~1pets~1{id}/get/parameters/0`), whose segments are capped.
   */
  path?: string;

  /**
   * Error code
   */
  code?: string;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  /**
   * Warning message
   */
  message: string;

  /**
   * Where the warning is; the two forms are those of
   * `ValidationErrorDetail.path` (historical for the codes that predate
   * OpenAPI 3.2 support, RFC 6901 JSON Pointers for the others)
   */
  path?: string;

  /**
   * Warning code
   */
  code?: string;
}

/**
 * The most findings one list keeps: `generator.getDiagnostics()`, and each of
 * a `ValidationResult`'s `errors` and `warnings`. Past it, one final entry
 * with code `DIAGNOSTICS_TRUNCATED` says the list was cut. A document is
 * untrusted: thousands of bad entries must not grow memory without bound.
 */
export const MAX_DIAGNOSTICS = 1000;

/**
 * The longest path key the historical validation paths
 * (`ValidationErrorDetail.path`) and messages quote; a longer one is cut
 * (with `...`). No real API path comes close.
 */
export const LEGACY_PATH_KEY_MAX_LENGTH = 1024;

/**
 * Every code a diagnostic from `generator.getDiagnostics()` can carry, with
 * what it means (the Swagger 2.0 conversion's `SWAGGER_*` codes among them),
 * and the two validation errors only `generator.validate()` returns:
 * `UNREADABLE_REFERENCE` for a reference it cannot read and
 * `DEREFERENCE_REQUIRED` for a Swagger 2.0 document loaded with
 * `dereference: false`. Values never change once released.
 */
export const DIAGNOSTIC_CODES = Object.freeze({
  // Spec layer: the declared version, the Path Item walk, newer features
  ...SPEC_DIAGNOSTIC_CODES,
  /** The declared version cannot be processed (recorded at load; validation rejects it). */
  INVALID_OPENAPI_VERSION: 'INVALID_OPENAPI_VERSION',
  /** The document declares no version (recorded at load; validation rejects it). */
  MISSING_OPENAPI_VERSION: 'MISSING_OPENAPI_VERSION',
  /** Validator warning: the document defines no paths. */
  NO_PATHS: 'NO_PATHS',
  /** Validator warning: a path item holds no operation. */
  NO_OPERATIONS: 'NO_OPERATIONS',
  /** Validator warning: an operation has no `operationId` (its tool name comes from the method and path). */
  NO_OPERATION_ID: 'NO_OPERATION_ID',
  /** An operation `generateTools` could not turn into a tool, for a reason no other code names. */
  TOOL_GENERATION_FAILED: 'TOOL_GENERATION_FAILED',
  /** A parameter, request body or response generation needs is a reference that was not resolved. */
  UNRESOLVED_REFERENCE: 'UNRESOLVED_REFERENCE',
  /** A parameter left out of the tool: a header the HTTP client or a credential sets, or where a credential is sent. */
  PARAMETER_IGNORED: 'PARAMETER_IGNORED',
  /** Validator warning: two operations share an `operationId`, which must be unique. */
  DUPLICATE_OPERATION_ID: 'DUPLICATE_OPERATION_ID',
  /** Validator warning: the document defines no servers. */
  NO_SERVERS: 'NO_SERVERS',
  /** Validator warning: the document has security requirements but no security schemes. */
  NO_SECURITY_SCHEMES: 'NO_SECURITY_SCHEMES',
  /**
   * A Security Requirement names a scheme that cannot be found: no component
   * of `components.securitySchemes` has the name, and (OpenAPI 3.2 or later)
   * read as a URI it does not name a scheme of this document (another
   * document's schemes are not read). The requirement object cannot be
   * satisfied and is dropped.
   */
  UNRESOLVED_SECURITY_SCHEME: 'UNRESOLVED_SECURITY_SCHEME',
  /**
   * `$self` breaks the specification: it is not a string in the form of a URI
   * reference, or it has a fragment. It is ignored; a validation error.
   */
  INVALID_SELF: 'INVALID_SELF',
  /**
   * `$self` is a URI reference this library does not use as a base: it has
   * user information, its scheme is not http, https or file, it is a file
   * URI naming a host or in a document retrieved over the network, or it (or
   * the URI it resolves to) is longer than `MAX_BASE_URI_LENGTH` (2,048)
   * characters. It is ignored.
   */
  REFUSED_SELF: 'REFUSED_SELF',
  /**
   * `$self` is a relative reference and the document has no retrieval URI
   * to resolve it against (loaded with `fromJSON`/`fromYAML` without
   * `LoadOptions.documentUri`), or only one too long to be used. It is
   * ignored.
   */
  UNRESOLVABLE_SELF: 'UNRESOLVABLE_SELF',
  /**
   * The URI the document was retrieved from (the final URL of `fromURL`, a
   * redirect included, or the file of `fromFile`) is longer than 2,048
   * characters, so it is not used: a reference to the document by that URI
   * is not recognised as local, and a relative reference to another
   * document fails the load (it is never resolved against the working
   * directory instead). Recorded at load, without a `path`.
   */
  BASE_URI_TOO_LONG: 'BASE_URI_TOO_LONG',
  /**
   * `generator.validate()` could not read a reference the document holds
   * (refused by a `refResolution` rule, missing, not JSON or YAML, a pointer
   * that leads nowhere, ...): the validation error it returns instead of
   * throwing. The message is the one the `ParseError` of generation carries;
   * `path` locates the `$ref` when it is in the document itself. Never a
   * `getDiagnostics()` entry.
   */
  UNREADABLE_REFERENCE: 'UNREADABLE_REFERENCE',
  /**
   * A Swagger 2.0 document was loaded with `LoadOptions.dereference: false`:
   * it is converted to OpenAPI 3.0 once its references are resolved, so it
   * cannot be read. The one error `generator.validate()` returns, and the
   * `context.errors` entry of the `ParseError` that generation and
   * `generator.lint()` throw. Never a `getDiagnostics()` entry.
   */
  DEREFERENCE_REQUIRED: 'DEREFERENCE_REQUIRED',
  /** A Security Requirement is not an object; it is dropped. */
  INVALID_SECURITY_REQUIREMENT: 'INVALID_SECURITY_REQUIREMENT',
  /**
   * A parameter's `name` cannot be a name: absent, `null`, `''`, an object or
   * an array (a number or a boolean is read as its text, see
   * `PARAMETER_NAME_NOT_STRING`). The operation makes no tool. A validation
   * error (`MISSING_PARAMETER_NAME` for an absent, `null` or empty one).
   */
  INVALID_PARAMETER_NAME: 'INVALID_PARAMETER_NAME',
  /**
   * A required input of a tool (a parameter, a body property, a whole body)
   * has a schema that accepts no value (`false`, or `{ not: {} }`), so no
   * call of the tool can succeed. The tool is still made.
   */
  REQUIRED_INPUT_ACCEPTS_NOTHING: 'REQUIRED_INPUT_ACCEPTS_NOTHING',
  /**
   * A tool's input, output or stream item schema exceeds `maxSchemaNodes` at
   * `maxSchemaDepth`, so it is cut at the deepest depth where it fits (the
   * message names it). The tool is still made; when not even depth 1 fits,
   * generating the tool fails with a `SchemaError`.
   */
  SCHEMA_DEPTH_REDUCED: 'SCHEMA_DEPTH_REDUCED',
  /**
   * Every Security Requirement of an operation was dropped, so no way to
   * authenticate is known: the operation makes no tool.
   */
  UNSATISFIABLE_SECURITY: 'UNSATISFIABLE_SECURITY',
  /**
   * An operation has a parameter in a location the generator does not map to
   * a request (a Swagger-style `body`, a missing `in`): the operation makes
   * no tool.
   */
  UNSUPPORTED_PARAMETER_LOCATION: 'UNSUPPORTED_PARAMETER_LOCATION',
  /**
   * An operation has more than one `in: querystring` parameter (path-level
   * ones included), which OpenAPI forbids: the operation makes no tool. A
   * validation error.
   */
  MULTIPLE_QUERYSTRING_PARAMETERS: 'MULTIPLE_QUERYSTRING_PARAMETERS',
  /**
   * An operation has an `in: querystring` parameter, which holds the whole
   * query string, and `in: query` parameters (path-level ones included),
   * which OpenAPI forbids: the operation makes no tool. A validation error.
   */
  QUERYSTRING_WITH_QUERY_PARAMETERS: 'QUERYSTRING_WITH_QUERY_PARAMETERS',
  /**
   * An `in: querystring` parameter has no `content` with a media type (it
   * must not use `schema`), so its value cannot be serialized: the operation
   * makes no tool. A validation error.
   */
  QUERYSTRING_PARAMETER_WITHOUT_CONTENT: 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT',
  /**
   * A parameter's `content` cannot be read as OpenAPI defines it; the
   * message says which problem and what is done instead. A validation
   * warning (except the unresolved reference, which only generation sees):
   *
   * - the parameter defines both `schema` and `content`, which OpenAPI
   *   forbids: `content` is ignored (for `in: querystring`, `schema` is);
   * - `content` does not hold exactly one media type: of several, one is
   *   used (`application/json`, then `application/x-www-form-urlencoded`,
   *   `multipart/form-data`, `application/xml`, `text/plain`, else the
   *   first); one that is empty or not a map is ignored;
   * - the media type used is not a Media Type Object (`null`, ...), or is a
   *   Reference Object left unresolved, so no schema is read: the value is
   *   unconstrained for a JSON media type, a string otherwise;
   * - the media type used declares `itemSchema`, which describes the items
   *   of a stream and is not read for a parameter.
   */
  INVALID_PARAMETER_CONTENT: 'INVALID_PARAMETER_CONTENT',
  /**
   * A cookie parameter is sent as JSON (`content` with a JSON media type)
   * and its schema allows a string, an object or an array, whose JSON text
   * holds characters a cookie value cannot carry (`"`, `,`):
   * `buildHttpRequest` refuses such a value, so only numbers, booleans and
   * `null` can be sent. The tool is still made.
   */
  COOKIE_CONTENT_NOT_SENDABLE: 'COOKIE_CONTENT_NOT_SENDABLE',
  /**
   * An operation's whole-query parameter (`in: querystring`) is serialized in
   * a media type other than `application/x-www-form-urlencoded`, and one of
   * its security schemes sends an API key in the query string (named in the
   * message): the query string has no name=value pairs to add the key to,
   * so `buildHttpRequest` refuses a call that uses that scheme. The tool is
   * still made.
   */
  QUERYSTRING_WITH_QUERY_CREDENTIAL: 'QUERYSTRING_WITH_QUERY_CREDENTIAL',
  /**
   * A parameter list (a path item's or an operation's) has two parameters
   * with the same `name` and `in`, which OpenAPI forbids: the last one is
   * used. A validation warning.
   */
  DUPLICATE_PARAMETER: 'DUPLICATE_PARAMETER',
  /**
   * A request body's media type declares only `itemSchema` (OpenAPI 3.2, a
   * streamed upload), which is not supported: the tool takes no body input.
   */
  UNSUPPORTED_STREAMING_REQUEST_BODY: 'UNSUPPORTED_STREAMING_REQUEST_BODY',
  /** The list reached `MAX_DIAGNOSTICS`; later findings are not recorded. */
  DIAGNOSTICS_TRUNCATED: 'DIAGNOSTICS_TRUNCATED',
} as const);

/** A code of `DIAGNOSTIC_CODES`. */
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];
