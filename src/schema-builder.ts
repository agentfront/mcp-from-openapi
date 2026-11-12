import type { JSONSchema } from 'zod/v4/core';
import { SchemaError } from './errors';
import { chargeBudget, copyJsonValue, type CopyBudget } from './json-copy';

/** JSON Schema type from Zod v4 */
type JsonSchema = JSONSchema.JSONSchema;

/** Options for {@link SchemaBuilder.truncateDepth} */
export interface TruncateDepthOptions {
  /**
   * Maximum number of nodes in the truncated tree — every JSON value in it:
   * schema objects, each of their keywords' values, and everything inside
   * those (`default`, `examples`, `enum`, `required`, `x-*`, ...); a
   * `SchemaError` is thrown as soon as it would contain more. Unbounded when
   * omitted.
   */
  maxNodes?: number;
}

/**
 * Default `GenerateOptions.maxSchemaNodes`. The largest schemas the vendored
 * real-world specs (GitHub, Discord) produce at the default depth have ~5k
 * nodes (~440 KB of JSON), so this only stops schemas no client could use.
 */
export const DEFAULT_MAX_SCHEMA_NODES = 100_000;

/**
 * Guard a depth bound: NaN/Infinity would disable truncation (`depth >= NaN`
 * is always false) and hang on circular graphs; fractional depths floor.
 * Non-finite input falls back to the documented default.
 */
function normalizeDepthBound(maxDepth: number): number {
  return Number.isFinite(maxDepth) ? Math.max(0, Math.floor(maxDepth)) : 10;
}

/**
 * The effective schema limits of a generation run: the depth `truncateDepth`
 * cuts at (clamped to at least 1 so the root keeps its properties) and the
 * node budget (`Infinity` disables it; absent or NaN uses the default).
 * Conversion and truncation must use the same depth, so both read it here.
 */
export function resolveSchemaLimits(options: { maxSchemaDepth?: number; maxSchemaNodes?: number }): {
  maxDepth: number;
  maxNodes: number;
} {
  const nodes = options.maxSchemaNodes;
  return {
    maxDepth: normalizeDepthBound(Math.max(1, options.maxSchemaDepth ?? 10)),
    maxNodes:
      nodes === undefined || Number.isNaN(nodes)
        ? DEFAULT_MAX_SCHEMA_NODES
        : nodes === Infinity
          ? Infinity
          : Math.max(1, Math.floor(nodes)),
  };
}

/** An object or array (a JSON container) */
function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/**
 * Helper class for building and manipulating JSON schemas
 */
export class SchemaBuilder {
  /**
   * Merge multiple schemas into one
   */
  static merge(schemas: JsonSchema[]): JsonSchema {
    if (schemas.length === 0) {
      return { type: 'object' };
    }

    if (schemas.length === 1) {
      return schemas[0];
    }

    const merged: JsonSchema = {
      type: 'object',
      properties: {},
      required: [],
    };

    const allRequired = new Set<string>();

    for (const schema of schemas) {
      if (schema.properties) {
        merged.properties = {
          ...merged.properties,
          ...schema.properties,
        };
      }

      if (schema.required) {
        schema.required.forEach((field) => allRequired.add(field));
      }
    }

    if (allRequired.size > 0) {
      merged.required = Array.from(allRequired);
    }

    return merged;
  }

  /**
   * Create a union schema (oneOf)
   */
  static union(schemas: JsonSchema[]): JsonSchema {
    if (schemas.length === 0) {
      return {};
    }

    if (schemas.length === 1) {
      return schemas[0];
    }

    return {
      oneOf: schemas,
    };
  }

  /**
   * Deep clone a schema
   */
  static clone(schema: JsonSchema): JsonSchema {
    return JSON.parse(JSON.stringify(schema));
  }

  /**
   * Remove $ref from schema (assumes already dereferenced)
   */
  static removeRefs(schema: JsonSchema): JsonSchema {
    const cloned = this.clone(schema);
    this.removeRefsRecursive(cloned);
    return cloned;
  }

  private static removeRefsRecursive(obj: any): void {
    /* c8 ignore next -- guard for non-object values in recursive traversal */
    if (!obj || typeof obj !== 'object') return;

    if (obj.$ref) {
      delete obj.$ref;
    }

    for (const key in obj) {
      if (key in obj) {
        const value = obj[key];
        if (value && typeof value === 'object') {
          this.removeRefsRecursive(value);
        }
      }
    }
  }

  /**
   * Add description to schema
   */
  static withDescription(schema: JsonSchema, description: string): JsonSchema {
    return {
      ...schema,
      description,
    };
  }

  /**
   * Add example to schema
   */
  static withExample(schema: JsonSchema, example: any): JsonSchema {
    const existingExamples = Array.isArray(schema.examples) ? schema.examples : [];
    return {
      ...schema,
      examples: [...existingExamples, example],
    };
  }

  /**
   * Add default value to schema
   */
  static withDefault(schema: JsonSchema, defaultValue: any): JsonSchema {
    return {
      ...schema,
      default: defaultValue,
    };
  }

  /**
   * Add format to schema
   */
  static withFormat(schema: JsonSchema, format: string): JsonSchema {
    return {
      ...schema,
      format,
    };
  }

  /**
   * Add pattern to schema
   */
  static withPattern(schema: JsonSchema, pattern: string): JsonSchema {
    return {
      ...schema,
      pattern,
    };
  }

  /**
   * Add enum to schema
   */
  static withEnum(schema: JsonSchema, values: any[]): JsonSchema {
    return {
      ...schema,
      enum: values,
    };
  }

  /**
   * Add minimum/maximum constraints
   */
  static withRange(schema: JsonSchema, min?: number, max?: number, options: { exclusive?: boolean } = {}): JsonSchema {
    const result = { ...schema };

    if (min !== undefined) {
      if (options.exclusive) {
        result.exclusiveMinimum = min;
      } else {
        result.minimum = min;
      }
    }

    if (max !== undefined) {
      if (options.exclusive) {
        result.exclusiveMaximum = max;
      } else {
        result.maximum = max;
      }
    }

    return result;
  }

  /**
   * Add minLength/maxLength constraints
   */
  static withLength(schema: JsonSchema, minLength?: number, maxLength?: number): JsonSchema {
    const result = { ...schema };

    if (minLength !== undefined) {
      result.minLength = minLength;
    }

    if (maxLength !== undefined) {
      result.maxLength = maxLength;
    }

    return result;
  }

  /**
   * Create object schema
   */
  static object(properties: Record<string, JsonSchema>, required?: string[]): JsonSchema {
    return {
      type: 'object',
      properties,
      ...(required && required.length > 0 && { required }),
      additionalProperties: false,
    };
  }

  /**
   * Create array schema
   */
  static array(
    items: JsonSchema,
    constraints?: {
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
    },
  ): JsonSchema {
    return {
      type: 'array',
      items,
      ...constraints,
    };
  }

  /**
   * Create string schema
   */
  static string(constraints?: {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
    enum?: string[];
  }): JsonSchema {
    return {
      type: 'string',
      ...constraints,
    };
  }

  /**
   * Create number schema
   */
  static number(constraints?: {
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
  }): JsonSchema {
    return {
      type: 'number',
      ...constraints,
    };
  }

  /**
   * Create integer schema
   */
  static integer(constraints?: {
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
  }): JsonSchema {
    return {
      type: 'integer',
      ...constraints,
    };
  }

  /**
   * Create boolean schema
   */
  static boolean(): JsonSchema {
    return {
      type: 'boolean',
    };
  }

  /**
   * Create null schema
   */
  static null(): JsonSchema {
    return {
      type: 'null',
    };
  }

  /**
   * Flatten nested oneOf/anyOf/allOf schemas
   */
  static flatten(schema: JsonSchema, maxDepth = 10): JsonSchema {
    if (maxDepth <= 0) return schema;

    const cloned = this.clone(schema);

    if (cloned.oneOf) {
      const flattened = cloned.oneOf.flatMap((s) => {
        const sub = this.flatten(s as JsonSchema, maxDepth - 1);
        return sub.oneOf ? sub.oneOf : [sub];
      });
      cloned.oneOf = flattened as JsonSchema[];
    }

    if (cloned.anyOf) {
      const flattened = cloned.anyOf.flatMap((s) => {
        const sub = this.flatten(s as JsonSchema, maxDepth - 1);
        return sub.anyOf ? sub.anyOf : [sub];
      });
      cloned.anyOf = flattened as JsonSchema[];
    }

    if (cloned.allOf) {
      const flattened = cloned.allOf.flatMap((s) => {
        const sub = this.flatten(s as JsonSchema, maxDepth - 1);
        return sub.allOf ? sub.allOf : [sub];
      });
      cloned.allOf = flattened as JsonSchema[];
    }

    return cloned;
  }

  /**
   * Truncate a schema tree to a maximum nesting depth.
   *
   * The root sits at depth 0; descending into `properties` values, `items`,
   * `additionalProperties`, composition members (`allOf`/`anyOf`/`oneOf`), or
   * `not` increments the depth. Nodes at `maxDepth` keep their scalar keywords
   * (type, description, format, ...) but have their child schemas stripped and
   * a truncation note appended to the description.
   *
   * The result is a fresh tree: it shares no object with the input or with
   * itself, even when the input reuses one subschema — or one value, such as a
   * `default` that a `$ref` resolved — in several places. `options.maxNodes`
   * caps the size of that tree — a `SchemaError` is thrown as soon as it would
   * contain more nodes (unbounded when omitted). A value nested more than 1000
   * levels deep, or circular, cannot be a JSON value: it throws, or (a cycle)
   * loses the reference back.
   */
  static truncateDepth(schema: JsonSchema, maxDepth: number, options: TruncateDepthOptions = {}): JsonSchema {
    const { maxNodes: limit } = options;
    const maxNodes = limit !== undefined && Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Infinity;
    const budget: CopyBudget = {
      maxNodes,
      nodes: 0,
      exceeded: () => {
        throw new SchemaError(
          `Schema exceeds the node budget of ${maxNodes} (maxSchemaNodes) after depth truncation: shared or ` +
            `recursive $refs expand into more schema nodes than allowed. Lower maxSchemaDepth or raise maxSchemaNodes.`,
          { maxNodes },
        );
      },
    };
    return this.truncateDepthRecursive(schema, 0, normalizeDepthBound(maxDepth), budget);
  }

  /** Keys whose value is a map of schemas (JSON Schema 2020-12) */
  private static readonly TRUNCATE_MAP_KEYS = [
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas',
  ] as const;

  /** Keys whose value is a single schema (or, for `items`, a tuple array) */
  private static readonly TRUNCATE_SCHEMA_KEYS = [
    'items',
    'additionalProperties',
    'not',
    'if',
    'then',
    'else',
    'propertyNames',
    'contains',
    'contentSchema',
    'unevaluatedProperties',
    'unevaluatedItems',
  ] as const;

  /** Keys whose value is an array of schemas */
  private static readonly TRUNCATE_LIST_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

  /** The keys that hold child schemas, by the shape of their value */
  private static readonly TRUNCATE_KEY_KINDS = new Map<string, 'map' | 'schema' | 'list'>([
    ...SchemaBuilder.TRUNCATE_MAP_KEYS.map((key) => [key, 'map'] as const),
    ...SchemaBuilder.TRUNCATE_SCHEMA_KEYS.map((key) => [key, 'schema'] as const),
    ...SchemaBuilder.TRUNCATE_LIST_KEYS.map((key) => [key, 'list'] as const),
  ]);

  // Copy-on-walk: never mutates the input and copies every node it keeps, so
  // shared subschemas come out as independent copies. Because the walk is
  // depth-bounded it terminates even on circular schema graphs (which
  // `clone()`'s JSON round-trip would reject), and its work is bounded by the
  // size of the tree it returns — which `budget.maxNodes` caps.
  private static truncateDepthRecursive(
    node: JsonSchema,
    depth: number,
    maxDepth: number,
    budget: CopyBudget,
  ): JsonSchema {
    if (!node || typeof node !== 'object') {
      // A boolean schema (`properties: { a: true }`) is one value
      chargeBudget(budget);
      return node;
    }
    // A tuple-of-tuples `items` element is an array, not a schema: a value
    if (Array.isArray(node)) {
      return copyJsonValue(node, budget, { label: 'An array in place of a schema' }) as JsonSchema;
    }

    chargeBudget(budget);
    const copy = { ...node } as JsonSchema;
    const copyRecord = copy as Record<string, unknown>;
    const kinds = this.TRUNCATE_KEY_KINDS;

    if (depth >= maxDepth) {
      let stripped = false;
      for (const key of Object.keys(copyRecord)) {
        if (kinds.has(key) && isObject(copyRecord[key])) {
          delete copyRecord[key];
          stripped = true;
        }
      }
      if (stripped) {
        // `required` refers to stripped properties; drop it alongside them
        delete copyRecord['required'];
        const note = '[Truncated: nested schema exceeds maxSchemaDepth]';
        copy.description = copy.description ? `${copy.description} ${note}` : note;
      }
    }

    // Every keyword value counts: a schema with thousands of keywords, shared
    // by many parents, is copied once per occurrence like any other
    const childDepth = depth + 1;
    for (const key of Object.keys(copyRecord)) {
      const value = copyRecord[key];
      if (!isObject(value)) {
        chargeBudget(budget);
        continue;
      }
      const kind = depth < maxDepth ? kinds.get(key) : undefined;
      if (kind === 'map' && !Array.isArray(value)) {
        chargeBudget(budget);
        const mapped: Record<string, JsonSchema> = {};
        for (const [name, sub] of Object.entries(value as Record<string, JsonSchema>)) {
          mapped[name] = this.truncateDepthRecursive(sub, childDepth, maxDepth, budget);
        }
        copyRecord[key] = mapped;
      } else if (kind === 'schema' && !Array.isArray(value)) {
        copyRecord[key] = this.truncateDepthRecursive(value as JsonSchema, childDepth, maxDepth, budget);
      } else if (kind === 'schema' || (kind === 'list' && Array.isArray(value))) {
        // A list of schemas — or `items` as a tuple array (pre-2020-12 style)
        chargeBudget(budget);
        copyRecord[key] = (value as JsonSchema[]).map((member) =>
          this.truncateDepthRecursive(member, childDepth, maxDepth, budget),
        );
      } else {
        // Any other object value (`default`, `examples`, `enum`, `x-*`, ...)
        // is copied too, so the tree shares nothing — and counted, as a `$ref`
        // resolved inside a value can expand like a schema can
        copyRecord[key] = copyJsonValue(value, budget, { label: `The \`${key}\` value of a schema` });
      }
    }
    return copy;
  }

  // Copy-on-walk over every structural keyword (same key groups as
  // truncateDepth): `visit` transforms each node top-down and must return a
  // new node when it changes anything.
  private static walkCopy(
    node: JsonSchema,
    visit: (node: JsonSchema) => JsonSchema,
    seen = new Map<JsonSchema, JsonSchema>(),
  ): JsonSchema {
    /* c8 ignore next -- guard for boolean/degenerate schemas in recursive traversal */
    if (!node || typeof node !== 'object') return node;
    // Circular/shared nodes reuse the copy already produced — the public
    // trimming statics accept raw dereferenced documents, which can be cyclic.
    const existing = seen.get(node);
    if (existing) return existing;

    const copy = visit({ ...node }) as Record<string, unknown>;
    seen.set(node, copy as JsonSchema);

    for (const key of this.TRUNCATE_MAP_KEYS) {
      const value = copy[key];
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const mapped: Record<string, JsonSchema> = {};
        for (const [name, sub] of Object.entries(value as Record<string, JsonSchema>)) {
          mapped[name] = this.walkCopy(sub, visit, seen);
        }
        copy[key] = mapped;
      }
    }
    for (const key of this.TRUNCATE_SCHEMA_KEYS) {
      const value = copy[key];
      if (Array.isArray(value)) {
        copy[key] = value.map((item) => this.walkCopy(item as JsonSchema, visit, seen));
      } else if (value !== null && typeof value === 'object') {
        copy[key] = this.walkCopy(value as JsonSchema, visit, seen);
      }
    }
    for (const key of this.TRUNCATE_LIST_KEYS) {
      const value = copy[key];
      if (Array.isArray(value)) {
        copy[key] = value.map((member) => this.walkCopy(member as JsonSchema, visit, seen));
      }
    }

    return copy as JsonSchema;
  }

  /**
   * Limit every object node to its first `max` properties (declaration
   * order). Dropped properties are pruned from `required` and counted in a
   * note appended to the node's description.
   */
  static limitProperties(schema: JsonSchema, max: number): JsonSchema {
    const bound = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : Number.MAX_SAFE_INTEGER;
    return this.walkCopy(schema, (node) => {
      const properties = node.properties;
      if (!properties || typeof properties !== 'object') return node;
      const entries = Object.entries(properties);
      if (entries.length <= bound) return node;

      const kept = entries.slice(0, bound);
      const keptNames = new Set(kept.map(([name]) => name));
      const dropped = entries.length - bound;
      const note = `[${dropped} additional propert${dropped === 1 ? 'y' : 'ies'} omitted: exceeds maxProperties]`;

      const next: JsonSchema = { ...node, properties: Object.fromEntries(kept) };
      if (Array.isArray(node.required)) {
        const required = node.required.filter((name) => keptNames.has(String(name)));
        if (required.length > 0) {
          next.required = required;
        } else {
          delete next.required;
        }
      }
      next.description = node.description ? `${node.description} ${note}` : note;
      return next;
    });
  }

  /**
   * Cap every description in the schema tree to `maxLength` characters,
   * truncating with an ellipsis.
   */
  static capDescriptions(schema: JsonSchema, maxLength: number): JsonSchema {
    const bound = Number.isFinite(maxLength) ? Math.max(1, Math.floor(maxLength)) : Number.MAX_SAFE_INTEGER;
    return this.walkCopy(schema, (node) => {
      if (typeof node.description === 'string' && node.description.length > bound) {
        // reserve one character for the ellipsis so the RESULT is <= bound
        return { ...node, description: `${node.description.slice(0, bound - 1)}…` };
      }
      return node;
    });
  }

  /**
   * Remove every `examples` array from the schema tree (a token-budget
   * trimming step — validation keywords are untouched).
   */
  static stripExamples(schema: JsonSchema): JsonSchema {
    return this.walkCopy(schema, (node) => {
      if ('examples' in node) {
        const { examples: _examples, ...rest } = node;
        return rest as JsonSchema;
      }
      return node;
    });
  }

  /**
   * Simplify schema by removing unnecessary fields
   */
  static simplify(schema: JsonSchema): JsonSchema {
    const cloned = this.clone(schema);

    // Remove empty arrays/objects
    if (Array.isArray(cloned.required) && cloned.required.length === 0) {
      delete cloned.required;
    }

    if (cloned.properties && Object.keys(cloned.properties).length === 0) {
      delete cloned.properties;
    }

    if (Array.isArray(cloned.examples) && cloned.examples.length === 0) {
      delete cloned.examples;
    }

    // Remove title if it matches description
    if (cloned.title && cloned.description && cloned.title === cloned.description) {
      delete cloned.title;
    }

    return cloned;
  }
}
