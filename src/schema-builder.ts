import type { JSONSchema } from 'zod/v4/core';

/** JSON Schema type from Zod v4 */
type JsonSchema = JSONSchema.JSONSchema;

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
   */
  static truncateDepth(schema: JsonSchema, maxDepth: number): JsonSchema {
    return this.truncateDepthRecursive(schema, 0, maxDepth);
  }

  // Copy-on-walk: never mutates the input, only copies nodes that have schema
  // children, and — because the walk is depth-bounded — terminates even on
  // circular schema graphs (which `clone()`'s JSON round-trip would reject).
  private static truncateDepthRecursive(node: JsonSchema, depth: number, maxDepth: number): JsonSchema {
    /* c8 ignore next -- guard for boolean/degenerate schemas in recursive traversal */
    if (!node || typeof node !== 'object') return node;

    const childKeys = ['properties', 'items', 'additionalProperties', 'allOf', 'anyOf', 'oneOf', 'not'] as const;
    const hasChildren = childKeys.some((key) => {
      const value = (node as Record<string, unknown>)[key];
      return value !== null && typeof value === 'object';
    });

    if (!hasChildren) return node;

    const copy = { ...node } as JsonSchema;

    if (depth >= maxDepth) {
      for (const key of childKeys) {
        const value = (copy as Record<string, unknown>)[key];
        if (value !== null && typeof value === 'object') {
          delete (copy as Record<string, unknown>)[key];
        }
      }
      // `required` refers to stripped properties; drop it alongside them
      delete (copy as Record<string, unknown>)['required'];
      const note = '[Truncated: nested schema exceeds maxSchemaDepth]';
      copy.description = copy.description ? `${copy.description} ${note}` : note;
      return copy;
    }

    if (copy.properties && typeof copy.properties === 'object') {
      const props: Record<string, JsonSchema> = {};
      for (const [key, value] of Object.entries(copy.properties)) {
        props[key] = this.truncateDepthRecursive(value as JsonSchema, depth + 1, maxDepth);
      }
      copy.properties = props;
    }

    if (copy.items && typeof copy.items === 'object') {
      if (Array.isArray(copy.items)) {
        copy.items = copy.items.map((item) =>
          this.truncateDepthRecursive(item as JsonSchema, depth + 1, maxDepth),
        ) as JsonSchema['items'];
      } else {
        copy.items = this.truncateDepthRecursive(copy.items as JsonSchema, depth + 1, maxDepth);
      }
    }

    if (copy.additionalProperties && typeof copy.additionalProperties === 'object') {
      copy.additionalProperties = this.truncateDepthRecursive(copy.additionalProperties as JsonSchema, depth + 1, maxDepth);
    }

    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      const members = copy[key];
      if (Array.isArray(members)) {
        copy[key] = members.map((member) =>
          this.truncateDepthRecursive(member as JsonSchema, depth + 1, maxDepth),
        ) as JsonSchema[];
      }
    }

    if (copy.not && typeof copy.not === 'object') {
      copy.not = this.truncateDepthRecursive(copy.not as JsonSchema, depth + 1, maxDepth);
    }

    return copy;
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
