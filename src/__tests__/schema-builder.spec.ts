/**
 * Tests for SchemaBuilder class
 */

import { SchemaBuilder } from '../schema-builder';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('SchemaBuilder', () => {
  describe('merge', () => {
    it('should return empty object for empty array', () => {
      const result = SchemaBuilder.merge([]);
      expect(result).toEqual({ type: 'object' });
    });

    it('should return single schema unchanged', () => {
      const schema = { type: 'object', properties: { id: { type: 'string' } } } as any;
      const result = SchemaBuilder.merge([schema]);
      expect(result).toEqual(schema);
    });

    it('should merge multiple schemas', () => {
      const schema1 = {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      } as any;
      const schema2 = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      } as any;
      const result = SchemaBuilder.merge([schema1, schema2]);

      expect(result.properties).toHaveProperty('id');
      expect(result.properties).toHaveProperty('name');
      expect(result.required).toContain('id');
      expect(result.required).toContain('name');
    });

    it('should handle schemas without properties', () => {
      const schema1 = { type: 'object' } as any;
      const schema2 = { type: 'object', properties: { id: { type: 'string' } } } as any;
      const result = SchemaBuilder.merge([schema1, schema2]);

      expect(result.properties).toHaveProperty('id');
    });

    it('should handle schemas without required', () => {
      const schema1 = { type: 'object', properties: { id: { type: 'string' } } } as any;
      const schema2 = { type: 'object', properties: { name: { type: 'string' } } } as any;
      const result = SchemaBuilder.merge([schema1, schema2]);

      expect(result.properties).toHaveProperty('id');
      expect(result.properties).toHaveProperty('name');
      expect(result.required).toEqual([]);
    });
  });

  describe('union', () => {
    it('should return empty object for empty array', () => {
      const result = SchemaBuilder.union([]);
      expect(result).toEqual({});
    });

    it('should return single schema unchanged', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.union([schema]);
      expect(result).toEqual(schema);
    });

    it('should create oneOf for multiple schemas', () => {
      const schemas = [{ type: 'string' }, { type: 'number' }] as any;
      const result = SchemaBuilder.union(schemas);

      expect(result.oneOf).toEqual(schemas);
    });
  });

  describe('clone', () => {
    it('should create deep copy', () => {
      const schema = {
        type: 'object',
        properties: {
          nested: { type: 'object', properties: { value: { type: 'string' } } },
        },
      } as any;
      const cloned = SchemaBuilder.clone(schema);

      expect(cloned).toEqual(schema);
      expect(cloned).not.toBe(schema);
      expect(cloned.properties).not.toBe(schema.properties);
    });
  });

  describe('removeRefs', () => {
    it('should remove $ref from schema', () => {
      const schema = {
        type: 'object',
        $ref: '#/components/schemas/User',
        properties: {
          nested: { $ref: '#/components/schemas/Address' },
        },
      } as any;
      const result = SchemaBuilder.removeRefs(schema);

      expect(result.$ref).toBeUndefined();
      expect((result as any).properties?.nested.$ref).toBeUndefined();
    });

    it('should handle null and primitive values', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: 42,
          nullable: null,
        },
      } as any;
      const result = SchemaBuilder.removeRefs(schema);

      expect(result.type).toBe('object');
      expect((result as any).properties?.count).toBe(42);
    });

    it('should handle arrays in schema', () => {
      const schema = {
        type: 'array',
        items: { $ref: '#/components/schemas/Item' },
      } as any;
      const result = SchemaBuilder.removeRefs(schema);

      expect((result as any).items.$ref).toBeUndefined();
    });

    it('should handle schema with primitive nested values', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        maxItems: 5,
        title: 'test',
      } as any;
      const result = SchemaBuilder.removeRefs(schema);

      expect(result.type).toBe('object');
      expect((result as any).maxItems).toBe(5);
    });
  });

  describe('withDescription', () => {
    it('should add description to schema', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.withDescription(schema, 'A test string');

      expect(result.description).toBe('A test string');
      expect(result.type).toBe('string');
    });
  });

  describe('withExample', () => {
    it('should add example to schema', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.withExample(schema, 'example value');

      expect(result.examples).toEqual(['example value']);
    });

    it('should append to existing examples', () => {
      const schema = { type: 'string', examples: ['existing'] } as any;
      const result = SchemaBuilder.withExample(schema, 'new example');

      expect(result.examples).toEqual(['existing', 'new example']);
    });

    it('should handle non-array examples gracefully', () => {
      const schema = { type: 'string', examples: 'not an array' } as any;
      const result = SchemaBuilder.withExample(schema, 'new example');

      expect(result.examples).toEqual(['new example']);
    });
  });

  describe('withDefault', () => {
    it('should add default value', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.withDefault(schema, 'default value');

      expect(result.default).toBe('default value');
    });
  });

  describe('withFormat', () => {
    it('should add format', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.withFormat(schema, 'email');

      expect(result.format).toBe('email');
    });
  });

  describe('withPattern', () => {
    it('should add pattern', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.withPattern(schema, '^[a-z]+$');

      expect(result.pattern).toBe('^[a-z]+$');
    });
  });

  describe('withEnum', () => {
    it('should add enum values', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.withEnum(schema, ['a', 'b', 'c']);

      expect(result.enum).toEqual(['a', 'b', 'c']);
    });
  });

  describe('withRange', () => {
    it('should add inclusive minimum and maximum', () => {
      const schema = { type: 'number' } as any;
      const result = SchemaBuilder.withRange(schema, 0, 100);

      expect(result.minimum).toBe(0);
      expect(result.maximum).toBe(100);
    });

    it('should add exclusive minimum and maximum', () => {
      const schema = { type: 'number' } as any;
      const result = SchemaBuilder.withRange(schema, 0, 100, { exclusive: true });

      expect(result.exclusiveMinimum).toBe(0);
      expect(result.exclusiveMaximum).toBe(100);
    });

    it('should handle only minimum', () => {
      const schema = { type: 'number' } as any;
      const result = SchemaBuilder.withRange(schema, 0, undefined);

      expect(result.minimum).toBe(0);
      expect(result.maximum).toBeUndefined();
    });

    it('should handle only maximum', () => {
      const schema = { type: 'number' } as any;
      const result = SchemaBuilder.withRange(schema, undefined, 100);

      expect(result.minimum).toBeUndefined();
      expect(result.maximum).toBe(100);
    });
  });

  describe('withLength', () => {
    it('should add minLength and maxLength', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.withLength(schema, 1, 100);

      expect(result.minLength).toBe(1);
      expect(result.maxLength).toBe(100);
    });

    it('should handle only minLength', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.withLength(schema, 1, undefined);

      expect(result.minLength).toBe(1);
      expect(result.maxLength).toBeUndefined();
    });

    it('should handle only maxLength', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.withLength(schema, undefined, 100);

      expect(result.minLength).toBeUndefined();
      expect(result.maxLength).toBe(100);
    });
  });

  describe('object', () => {
    it('should create object schema', () => {
      const result = SchemaBuilder.object({ id: { type: 'string' }, name: { type: 'string' } } as any, ['id']);

      expect(result.type).toBe('object');
      expect(result.properties).toHaveProperty('id');
      expect(result.properties).toHaveProperty('name');
      expect(result.required).toEqual(['id']);
      expect(result.additionalProperties).toBe(false);
    });

    it('should create object without required', () => {
      const result = SchemaBuilder.object({ id: { type: 'string' } } as any);

      expect(result.required).toBeUndefined();
    });

    it('should create object with empty required', () => {
      const result = SchemaBuilder.object({ id: { type: 'string' } } as any, []);

      expect(result.required).toBeUndefined();
    });
  });

  describe('array', () => {
    it('should create array schema', () => {
      const result = SchemaBuilder.array({ type: 'string' } as any);

      expect(result.type).toBe('array');
      expect(result.items).toEqual({ type: 'string' });
    });

    it('should add constraints', () => {
      const result = SchemaBuilder.array({ type: 'string' } as any, { minItems: 1, maxItems: 10, uniqueItems: true });

      expect(result.minItems).toBe(1);
      expect(result.maxItems).toBe(10);
      expect(result.uniqueItems).toBe(true);
    });
  });

  describe('string', () => {
    it('should create string schema', () => {
      const result = SchemaBuilder.string();

      expect(result.type).toBe('string');
    });

    it('should add constraints', () => {
      const result = SchemaBuilder.string({
        minLength: 1,
        maxLength: 100,
        pattern: '^[a-z]+$',
        format: 'email',
        enum: ['a', 'b'],
      });

      expect(result.minLength).toBe(1);
      expect(result.maxLength).toBe(100);
      expect(result.pattern).toBe('^[a-z]+$');
      expect(result.format).toBe('email');
      expect(result.enum).toEqual(['a', 'b']);
    });
  });

  describe('number', () => {
    it('should create number schema', () => {
      const result = SchemaBuilder.number();

      expect(result.type).toBe('number');
    });

    it('should add constraints', () => {
      const result = SchemaBuilder.number({
        minimum: 0,
        maximum: 100,
        exclusiveMinimum: -1,
        exclusiveMaximum: 101,
        multipleOf: 5,
      });

      expect(result.minimum).toBe(0);
      expect(result.maximum).toBe(100);
      expect(result.exclusiveMinimum).toBe(-1);
      expect(result.exclusiveMaximum).toBe(101);
      expect(result.multipleOf).toBe(5);
    });
  });

  describe('integer', () => {
    it('should create integer schema', () => {
      const result = SchemaBuilder.integer();

      expect(result.type).toBe('integer');
    });

    it('should add constraints', () => {
      const result = SchemaBuilder.integer({
        minimum: 0,
        maximum: 100,
      });

      expect(result.minimum).toBe(0);
      expect(result.maximum).toBe(100);
    });
  });

  describe('boolean', () => {
    it('should create boolean schema', () => {
      const result = SchemaBuilder.boolean();

      expect(result.type).toBe('boolean');
    });
  });

  describe('null', () => {
    it('should create null schema', () => {
      const result = SchemaBuilder.null();

      expect(result.type).toBe('null');
    });
  });

  describe('flatten', () => {
    it('should flatten nested oneOf', () => {
      const schema = {
        oneOf: [{ type: 'string' }, { oneOf: [{ type: 'number' }, { type: 'boolean' }] }],
      } as any;
      const result = SchemaBuilder.flatten(schema);

      expect(result.oneOf).toHaveLength(3);
    });

    it('should flatten nested anyOf', () => {
      const schema = {
        anyOf: [{ type: 'string' }, { anyOf: [{ type: 'number' }, { type: 'boolean' }] }],
      } as any;
      const result = SchemaBuilder.flatten(schema);

      expect(result.anyOf).toHaveLength(3);
    });

    it('should flatten nested allOf', () => {
      const schema = {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { allOf: [{ properties: { b: { type: 'number' } } }] },
        ],
      } as any;
      const result = SchemaBuilder.flatten(schema);

      expect(result.allOf).toHaveLength(2);
    });

    it('should respect maxDepth', () => {
      const schema = {
        oneOf: [{ oneOf: [{ oneOf: [{ type: 'string' }] }] }],
      } as any;
      const result = SchemaBuilder.flatten(schema, 1);

      // Should only flatten one level
      expect(result.oneOf).toBeDefined();
    });

    it('should handle schema without composition', () => {
      const schema = { type: 'string' } as any;
      const result = SchemaBuilder.flatten(schema);

      expect(result.type).toBe('string');
    });
  });

  describe('simplify', () => {
    it('should remove empty required array', () => {
      const schema = { type: 'object', required: [] } as any;
      const result = SchemaBuilder.simplify(schema);

      expect(result.required).toBeUndefined();
    });

    it('should remove empty properties object', () => {
      const schema = { type: 'object', properties: {} } as any;
      const result = SchemaBuilder.simplify(schema);

      expect(result.properties).toBeUndefined();
    });

    it('should remove empty examples array', () => {
      const schema = { type: 'string', examples: [] } as any;
      const result = SchemaBuilder.simplify(schema);

      expect(result.examples).toBeUndefined();
    });

    it('should remove duplicate title when matching description', () => {
      const schema = { type: 'string', title: 'Same', description: 'Same' } as any;
      const result = SchemaBuilder.simplify(schema);

      expect(result.title).toBeUndefined();
      expect(result.description).toBe('Same');
    });

    it('should keep title when different from description', () => {
      const schema = { type: 'string', title: 'Title', description: 'Desc' } as any;
      const result = SchemaBuilder.simplify(schema);

      expect(result.title).toBe('Title');
      expect(result.description).toBe('Desc');
    });

    it('should keep non-empty collections', () => {
      const schema = {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        examples: ['example'],
      } as any;
      const result = SchemaBuilder.simplify(schema);

      expect(result.properties).toHaveProperty('id');
      expect(result.required).toEqual(['id']);
      expect(result.examples).toEqual(['example']);
    });
  });

  describe('truncateDepth', () => {
    const deepSchema = () =>
      ({
        type: 'object',
        properties: {
          level1: {
            type: 'object',
            description: 'first level',
            properties: {
              level2: {
                type: 'object',
                properties: {
                  level3: { type: 'string' },
                },
                required: ['level3'],
              },
            },
          },
        },
      }) as any;

    it('should be a no-op when the schema is shallower than maxDepth', () => {
      const schema = deepSchema();
      const result = SchemaBuilder.truncateDepth(schema, 10);

      expect(result).toEqual(schema);
    });

    it('should not mutate the input schema', () => {
      const schema = deepSchema();
      const snapshot = JSON.parse(JSON.stringify(schema));
      SchemaBuilder.truncateDepth(schema, 1);

      expect(schema).toEqual(snapshot);
    });

    it('should strip children at maxDepth and append a truncation note', () => {
      const result = SchemaBuilder.truncateDepth(deepSchema(), 1) as any;

      const level1 = result.properties.level1;
      expect(level1.type).toBe('object');
      expect(level1.properties).toBeUndefined();
      expect(level1.description).toBe('first level [Truncated: nested schema exceeds maxSchemaDepth]');
    });

    it('should add a truncation note when there is no existing description', () => {
      const result = SchemaBuilder.truncateDepth(deepSchema(), 2) as any;

      const level2 = result.properties.level1.properties.level2;
      expect(level2.properties).toBeUndefined();
      expect(level2.required).toBeUndefined();
      expect(level2.description).toBe('[Truncated: nested schema exceeds maxSchemaDepth]');
    });

    it('should truncate the root at maxDepth 0', () => {
      const result = SchemaBuilder.truncateDepth(deepSchema(), 0) as any;

      expect(result.type).toBe('object');
      expect(result.properties).toBeUndefined();
      expect(result.description).toContain('Truncated');
    });

    it('should count array items as a depth level', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      } as any;
      const result = SchemaBuilder.truncateDepth(schema, 1) as any;

      expect(result.items.type).toBe('object');
      expect(result.items.properties).toBeUndefined();
      expect(result.items.description).toContain('Truncated');
    });

    it('should traverse tuple-style items arrays', () => {
      const schema = {
        type: 'array',
        items: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'number' }],
      } as any;
      const result = SchemaBuilder.truncateDepth(schema, 1) as any;

      expect(result.items[0].properties).toBeUndefined();
      expect(result.items[0].description).toContain('Truncated');
      expect(result.items[1]).toEqual({ type: 'number' });
    });

    it('should traverse composition members and not', () => {
      const schema = {
        oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
        anyOf: [{ type: 'object', properties: { b: { type: 'string' } } }],
        allOf: [{ type: 'object', properties: { c: { type: 'string' } } }],
        not: { type: 'object', properties: { d: { type: 'string' } } },
      } as any;
      const result = SchemaBuilder.truncateDepth(schema, 1) as any;

      expect(result.oneOf[0].properties).toBeUndefined();
      expect(result.anyOf[0].properties).toBeUndefined();
      expect(result.allOf[0].properties).toBeUndefined();
      expect(result.not.properties).toBeUndefined();
    });

    it('should traverse object-valued additionalProperties', () => {
      const schema = {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: { nested: { type: 'string' } },
        },
      } as any;
      const result = SchemaBuilder.truncateDepth(schema, 1) as any;

      expect(result.additionalProperties.properties).toBeUndefined();
      expect(result.additionalProperties.description).toContain('Truncated');
    });

    it('should leave leaf nodes and boolean additionalProperties untouched', () => {
      const schema = {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', description: 'kept' } },
      } as any;
      const result = SchemaBuilder.truncateDepth(schema, 5) as any;

      expect(result.additionalProperties).toBe(false);
      expect(result.properties.id).toEqual({ type: 'string', description: 'kept' });
    });
  });
});

describe('SchemaBuilder.truncateDepth cycle safety', () => {
  it('should terminate on circular schema graphs instead of throwing', () => {
    const node: any = { type: 'object', properties: { value: { type: 'string' } } };
    node.properties.next = node; // self-referential cycle

    const result = SchemaBuilder.truncateDepth(node, 3) as any;

    expect(result.properties.next.properties.next.properties.next.description).toContain('Truncated');
  });
});

describe('SchemaBuilder.truncateDepth 2020-12 keyword coverage', () => {
  const deep = { type: 'object', properties: { inner: { type: 'string' } } } as any;

  it('should truncate schemas under patternProperties', () => {
    const result = SchemaBuilder.truncateDepth({ type: 'object', patternProperties: { '^x-': deep } } as any, 1) as any;

    expect(result.patternProperties['^x-'].properties).toBeUndefined();
    expect(result.patternProperties['^x-'].description).toContain('Truncated');
  });

  it('should truncate schemas under $defs and definitions', () => {
    const result = SchemaBuilder.truncateDepth({ $defs: { Node: deep }, definitions: { Legacy: deep } } as any, 1) as any;

    expect(result.$defs.Node.properties).toBeUndefined();
    expect(result.definitions.Legacy.properties).toBeUndefined();
  });

  it('should truncate schemas under dependentSchemas', () => {
    const result = SchemaBuilder.truncateDepth({ type: 'object', dependentSchemas: { flag: deep } } as any, 1) as any;

    expect(result.dependentSchemas.flag.properties).toBeUndefined();
  });

  it('should truncate schemas under prefixItems', () => {
    const result = SchemaBuilder.truncateDepth({ type: 'array', prefixItems: [deep, { type: 'number' }] } as any, 1) as any;

    expect(result.prefixItems[0].properties).toBeUndefined();
    expect(result.prefixItems[1]).toEqual({ type: 'number' });
  });

  it('should truncate schemas under if/then/else, propertyNames, and contains', () => {
    const result = SchemaBuilder.truncateDepth(
      {
        if: deep,
        then: deep,
        else: deep,
        propertyNames: { pattern: '^a' },
        contains: deep,
      } as any,
      1,
    ) as any;

    expect(result.if.properties).toBeUndefined();
    expect(result.then.properties).toBeUndefined();
    expect(result.else.properties).toBeUndefined();
    expect(result.contains.properties).toBeUndefined();
    expect(result.propertyNames).toEqual({ pattern: '^a' }); // leaf: untouched
  });

  it('should strip deep keyword children at the truncation boundary', () => {
    const schema = {
      type: 'object',
      properties: {
        level1: { type: 'object', patternProperties: { '^x-': deep }, $defs: { N: deep } },
      },
    } as any;
    const result = SchemaBuilder.truncateDepth(schema, 1) as any;

    expect(result.properties.level1.patternProperties).toBeUndefined();
    expect(result.properties.level1.$defs).toBeUndefined();
    expect(result.properties.level1.description).toContain('Truncated');
  });
});

describe('SchemaBuilder.truncateDepth depth-bound validation', () => {
  const deep = { type: 'object', properties: { inner: { type: 'object', properties: { leaf: { type: 'string' } } } } } as any;

  it('should fall back to the default bound for NaN', () => {
    const node: any = { type: 'object', properties: { value: { type: 'string' } } };
    node.properties.next = node; // circular: unbounded traversal would hang

    const result = SchemaBuilder.truncateDepth(node, NaN) as any;

    expect(JSON.stringify(result)).toContain('Truncated'); // bounded at the default of 10
  });

  it('should fall back to the default bound for Infinity', () => {
    const node: any = { type: 'object', properties: { value: { type: 'string' } } };
    node.properties.next = node;

    const result = SchemaBuilder.truncateDepth(node, Infinity) as any;

    expect(JSON.stringify(result)).toContain('Truncated');
  });

  it('should floor fractional depths', () => {
    const result = SchemaBuilder.truncateDepth(deep, 1.9) as any;

    // floors to 1: level-1 children stripped
    expect(result.properties.inner.properties).toBeUndefined();
  });

  it('should clamp negative depths to 0 (root truncation)', () => {
    const result = SchemaBuilder.truncateDepth(deep, -5) as any;

    expect(result.properties).toBeUndefined();
    expect(result.description).toContain('Truncated');
  });

  it('should truncate schemas under contentSchema', () => {
    const schema = {
      type: 'string',
      contentMediaType: 'application/json',
      contentSchema: deep,
    } as any;
    const result = SchemaBuilder.truncateDepth(schema, 1) as any;

    expect(result.contentSchema.properties).toBeUndefined();
    expect(result.contentSchema.description).toContain('Truncated');
  });
});

describe('SchemaBuilder trimming transforms', () => {
  describe('limitProperties', () => {
    const wide = () =>
      ({
        type: 'object',
        description: 'A wide object.',
        properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' }, d: { type: 'string' } },
        required: ['a', 'c', 'd'],
      }) as any;

    it('keeps the first N properties, prunes required, and notes the drop', () => {
      const result = SchemaBuilder.limitProperties(wide(), 2) as any;

      expect(Object.keys(result.properties)).toEqual(['a', 'b']);
      expect(result.required).toEqual(['a']);
      expect(result.description).toBe('A wide object. [2 additional properties omitted: exceeds maxProperties]');
    });

    it('uses singular wording and adds a description when absent', () => {
      const schema = { type: 'object', properties: { a: {}, b: {} } } as any;
      const result = SchemaBuilder.limitProperties(schema, 1) as any;

      expect(result.description).toBe('[1 additional property omitted: exceeds maxProperties]');
    });

    it('drops required entirely when no kept property remains required', () => {
      const schema = { type: 'object', properties: { a: {}, b: {} }, required: ['b'] } as any;
      const result = SchemaBuilder.limitProperties(schema, 1) as any;

      expect(result.required).toBeUndefined();
    });

    it('is a no-op at or under the bound and walks nested objects', () => {
      const nested = {
        type: 'object',
        properties: {
          child: { type: 'object', properties: { x: {}, y: {}, z: {} } },
        },
      } as any;
      const result = SchemaBuilder.limitProperties(nested, 2) as any;

      expect(Object.keys(result.properties)).toEqual(['child']); // root under bound
      expect(Object.keys(result.properties.child.properties)).toEqual(['x', 'y']);
    });

    it('clamps non-finite and fractional bounds', () => {
      const schema = { type: 'object', properties: { a: {}, b: {}, c: {} } } as any;

      expect(Object.keys((SchemaBuilder.limitProperties(schema, NaN) as any).properties)).toHaveLength(3);
      expect(Object.keys((SchemaBuilder.limitProperties(schema, 2.9) as any).properties)).toHaveLength(2);
      expect(Object.keys((SchemaBuilder.limitProperties(schema, 0) as any).properties)).toHaveLength(1); // floor 1
    });

    it('skips nodes without properties', () => {
      const schema = { type: 'string', description: 'leaf' } as any;

      expect(SchemaBuilder.limitProperties(schema, 1)).toEqual(schema);
    });
  });

  describe('capDescriptions', () => {
    it('truncates long descriptions everywhere with an ellipsis', () => {
      const schema = {
        type: 'object',
        description: 'A very long root description indeed',
        properties: { a: { type: 'string', description: 'short' } },
      } as any;
      const result = SchemaBuilder.capDescriptions(schema, 10) as any;

      expect(result.description).toBe('A very lon…');
      expect(result.properties.a.description).toBe('short');
    });

    it('clamps non-finite bounds to no-op', () => {
      const schema = { type: 'string', description: 'keep me intact' } as any;

      expect((SchemaBuilder.capDescriptions(schema, Infinity) as any).description).toBe('keep me intact');
    });
  });

  describe('walker coverage across compositions and tuples', () => {
    it('applies transforms inside oneOf members and tuple items', () => {
      const schema = {
        oneOf: [{ type: 'string', examples: ['a'] }],
        anyOf: [{ type: 'integer', examples: [1] }],
        allOf: [{ type: 'object', examples: [{}] }],
        items: [{ type: 'string', examples: ['t'] }, { type: 'number' }],
      } as any;
      const result = SchemaBuilder.stripExamples(schema) as any;

      expect(result.oneOf[0].examples).toBeUndefined();
      expect(result.anyOf[0].examples).toBeUndefined();
      expect(result.allOf[0].examples).toBeUndefined();
      expect(result.items[0].examples).toBeUndefined();
      expect(result.items[1]).toEqual({ type: 'number' });
    });
  });

  describe('stripExamples', () => {
    it('removes examples arrays at every level', () => {
      const schema = {
        type: 'object',
        examples: [{ a: 1 }],
        properties: {
          a: { type: 'string', examples: ['x'], default: 'kept' },
          list: { type: 'array', items: { type: 'string', examples: ['y'] } },
        },
      } as any;
      const result = SchemaBuilder.stripExamples(schema) as any;

      expect(result.examples).toBeUndefined();
      expect(result.properties.a.examples).toBeUndefined();
      expect(result.properties.a.default).toBe('kept');
      expect(result.properties.list.items.examples).toBeUndefined();
    });
  });
});
