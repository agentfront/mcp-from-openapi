/**
 * Tests for types utility functions
 */

import { isReferenceObject, toJsonSchema } from '../types';
import type { SchemaObject, ReferenceObject } from '../types';

describe('isReferenceObject', () => {
  it('should return true for reference objects', () => {
    const ref: ReferenceObject = { $ref: '#/components/schemas/User' };
    expect(isReferenceObject(ref)).toBe(true);
  });

  it('should return falsy for null', () => {
    expect(isReferenceObject(null)).toBeFalsy();
  });

  it('should return falsy for undefined', () => {
    expect(isReferenceObject(undefined)).toBeFalsy();
  });

  it('should return false for primitives', () => {
    expect(isReferenceObject('string')).toBe(false);
    expect(isReferenceObject(42)).toBe(false);
    expect(isReferenceObject(true)).toBe(false);
  });

  it('should return false for objects without $ref', () => {
    const schema: SchemaObject = { type: 'string' };
    expect(isReferenceObject(schema)).toBe(false);
  });

  it('should return false for objects with empty $ref', () => {
    const obj = { $ref: '', type: 'string' };
    expect(isReferenceObject(obj)).toBe(true); // Has $ref key, even if empty
  });
});

describe('toJsonSchema', () => {
  describe('Reference Objects', () => {
    it('should convert reference to JSON Schema $ref', () => {
      const ref: ReferenceObject = { $ref: '#/components/schemas/User' };
      const result = toJsonSchema(ref);

      expect(result.$ref).toBe('#/components/schemas/User');
    });
  });

  describe('Basic Schemas', () => {
    it('should convert simple string schema', () => {
      const schema: SchemaObject = { type: 'string' };
      const result = toJsonSchema(schema);

      expect(result.type).toBe('string');
    });

    it('should convert string schema with constraints', () => {
      const schema: SchemaObject = {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        pattern: '^[a-z]+$',
      };
      const result = toJsonSchema(schema);

      expect(result.minLength).toBe(1);
      expect(result.maxLength).toBe(100);
      expect(result.pattern).toBe('^[a-z]+$');
    });

    it('should convert number schema', () => {
      const schema: SchemaObject = {
        type: 'number',
        minimum: 0,
        maximum: 100,
      };
      const result = toJsonSchema(schema);

      expect(result.type).toBe('number');
      expect(result.minimum).toBe(0);
      expect(result.maximum).toBe(100);
    });
  });

  describe('ExclusiveMinimum/Maximum Conversion', () => {
    it('should convert boolean exclusiveMaximum with maximum', () => {
      const schema: SchemaObject = {
        type: 'number',
        maximum: 100,
        exclusiveMaximum: true as any, // OpenAPI 3.0 style
      };
      const result = toJsonSchema(schema);

      expect(result.exclusiveMaximum).toBe(100);
      expect(result.maximum).toBeUndefined();
    });

    it('should keep maximum when exclusiveMaximum is false', () => {
      const schema: SchemaObject = {
        type: 'number',
        maximum: 100,
        exclusiveMaximum: false as any, // OpenAPI 3.0 style
      };
      const result = toJsonSchema(schema);

      expect(result.maximum).toBe(100);
      expect(result.exclusiveMaximum).toBeUndefined();
    });

    it('should convert boolean exclusiveMinimum with minimum', () => {
      const schema: SchemaObject = {
        type: 'number',
        minimum: 0,
        exclusiveMinimum: true as any, // OpenAPI 3.0 style
      };
      const result = toJsonSchema(schema);

      expect(result.exclusiveMinimum).toBe(0);
      expect(result.minimum).toBeUndefined();
    });

    it('should keep minimum when exclusiveMinimum is false', () => {
      const schema: SchemaObject = {
        type: 'number',
        minimum: 0,
        exclusiveMinimum: false as any, // OpenAPI 3.0 style
      };
      const result = toJsonSchema(schema);

      expect(result.minimum).toBe(0);
      expect(result.exclusiveMinimum).toBeUndefined();
    });

    it('should keep numeric exclusiveMaximum (OpenAPI 3.1)', () => {
      const schema: SchemaObject = {
        type: 'number',
        exclusiveMaximum: 100,
        maximum: 50,
      };
      const result = toJsonSchema(schema);

      expect(result.exclusiveMaximum).toBe(100);
      expect(result.maximum).toBe(50);
    });

    it('should keep numeric exclusiveMinimum (OpenAPI 3.1)', () => {
      const schema: SchemaObject = {
        type: 'number',
        exclusiveMinimum: 0,
        minimum: -10,
      };
      const result = toJsonSchema(schema);

      expect(result.exclusiveMinimum).toBe(0);
      expect(result.minimum).toBe(-10);
    });

    it('should handle only maximum without exclusiveMaximum', () => {
      const schema: SchemaObject = {
        type: 'number',
        maximum: 100,
      };
      const result = toJsonSchema(schema);

      expect(result.maximum).toBe(100);
      expect(result.exclusiveMaximum).toBeUndefined();
    });

    it('should handle only minimum without exclusiveMinimum', () => {
      const schema: SchemaObject = {
        type: 'number',
        minimum: 0,
      };
      const result = toJsonSchema(schema);

      expect(result.minimum).toBe(0);
      expect(result.exclusiveMinimum).toBeUndefined();
    });

    it('should handle boolean exclusiveMaximum true without maximum', () => {
      const schema: SchemaObject = {
        type: 'number',
        exclusiveMaximum: true as any,
      };
      const result = toJsonSchema(schema);

      // Boolean exclusive without value should not add anything
      expect(result.exclusiveMaximum).toBeUndefined();
      expect(result.maximum).toBeUndefined();
    });

    it('should handle boolean exclusiveMinimum true without minimum', () => {
      const schema: SchemaObject = {
        type: 'number',
        exclusiveMinimum: true as any,
      };
      const result = toJsonSchema(schema);

      // Boolean exclusive without value should not add anything
      expect(result.exclusiveMinimum).toBeUndefined();
      expect(result.minimum).toBeUndefined();
    });
  });

  describe('Nested Properties', () => {
    it('should recursively convert properties', () => {
      const schema: SchemaObject = {
        type: 'object',
        properties: {
          id: { type: 'string' },
          age: {
            type: 'number',
            minimum: 0,
            exclusiveMaximum: true as any,
            maximum: 150,
          },
        },
      };
      const result = toJsonSchema(schema) as any;

      expect(result.properties?.id.type).toBe('string');
      expect(result.properties?.age.exclusiveMaximum).toBe(150);
    });

    it('should recursively convert nested object properties', () => {
      const schema: SchemaObject = {
        type: 'object',
        properties: {
          address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
            },
          },
        },
      };
      const result = toJsonSchema(schema) as any;

      expect(result.properties?.address.properties?.street.type).toBe('string');
    });
  });

  describe('Array Items', () => {
    it('should convert single items schema', () => {
      const schema: SchemaObject = {
        type: 'array',
        items: { type: 'string' },
      };
      const result = toJsonSchema(schema) as any;

      expect(result.items?.type).toBe('string');
    });

    it('should convert array of items schemas', () => {
      const schema = {
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
      } as any;
      const result = toJsonSchema(schema) as any;

      expect(Array.isArray(result.items)).toBe(true);
      expect((result.items as any[])[0].type).toBe('string');
      expect((result.items as any[])[1].type).toBe('number');
    });

    it('should convert items with reference', () => {
      const schema: SchemaObject = {
        type: 'array',
        items: { $ref: '#/components/schemas/User' } as any,
      };
      const result = toJsonSchema(schema) as any;

      expect(result.items?.$ref).toBe('#/components/schemas/User');
    });
  });

  describe('Additional Properties', () => {
    it('should convert additionalProperties schema', () => {
      const schema: SchemaObject = {
        type: 'object',
        additionalProperties: { type: 'string' },
      };
      const result = toJsonSchema(schema) as any;

      expect(result.additionalProperties?.type).toBe('string');
    });

    it('should handle boolean additionalProperties', () => {
      const schema: SchemaObject = {
        type: 'object',
        additionalProperties: true,
      };
      const result = toJsonSchema(schema);

      expect(result.additionalProperties).toBe(true);
    });
  });

  describe('Composition Keywords', () => {
    it('should convert allOf schemas', () => {
      const schema: SchemaObject = {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'object', properties: { b: { type: 'number' } } },
        ],
      };
      const result = toJsonSchema(schema) as any;

      expect(result.allOf).toHaveLength(2);
      expect(result.allOf?.[0].properties?.a.type).toBe('string');
    });

    it('should convert anyOf schemas', () => {
      const schema: SchemaObject = {
        anyOf: [{ type: 'string' }, { type: 'number' }],
      };
      const result = toJsonSchema(schema);

      expect(result.anyOf).toHaveLength(2);
    });

    it('should convert oneOf schemas', () => {
      const schema: SchemaObject = {
        oneOf: [{ type: 'string' }, { type: 'null' as any }],
      };
      const result = toJsonSchema(schema);

      expect(result.oneOf).toHaveLength(2);
    });
  });

  describe('Not Keyword', () => {
    it('should convert not schema', () => {
      const schema: SchemaObject = {
        not: { type: 'null' as any },
      };
      const result = toJsonSchema(schema) as any;

      expect(result.not?.type).toBe('null');
    });

    it('should convert not with reference', () => {
      const schema: SchemaObject = {
        not: { $ref: '#/components/schemas/Forbidden' } as any,
      };
      const result = toJsonSchema(schema) as any;

      expect(result.not?.$ref).toBe('#/components/schemas/Forbidden');
    });
  });

  describe('Nullable Conversion (OpenAPI 3.0)', () => {
    it('should convert nullable:true with a single type to a type union', () => {
      const schema: SchemaObject = { type: 'string', nullable: true } as any;
      const result = toJsonSchema(schema);

      expect(result.type).toEqual(['string', 'null']);
      expect((result as any).nullable).toBeUndefined();
    });

    it('should drop nullable:false without changing the type', () => {
      const schema: SchemaObject = { type: 'string', nullable: false } as any;
      const result = toJsonSchema(schema);

      expect(result.type).toBe('string');
      expect((result as any).nullable).toBeUndefined();
    });

    it('should wrap type-less nullable schemas in an anyOf with null', () => {
      const schema = { nullable: true, description: 'anything' } as any;
      const result = toJsonSchema(schema) as any;

      expect((result as any).nullable).toBeUndefined();
      expect(result.anyOf).toHaveLength(2);
      expect(result.anyOf[1]).toEqual({ type: 'null' });
      // annotations are hoisted onto the wrapper, not buried in anyOf[0]
      expect(result.description).toBe('anything');
      expect(result.anyOf[0].description).toBeUndefined();
    });

    it('should hoist title and deprecated onto the nullable wrapper', () => {
      const schema = {
        oneOf: [{ type: 'string' }],
        nullable: true,
        title: 'Maybe',
        deprecated: true,
      } as any;
      const result = toJsonSchema(schema) as any;

      expect(result.title).toBe('Maybe');
      expect(result.deprecated).toBe(true);
      expect(result.anyOf[0].title).toBeUndefined();
      expect(result.anyOf[0].oneOf).toHaveLength(1);
    });

    it('should preserve nullability of compositions via anyOf wrapping', () => {
      const schema = { oneOf: [{ type: 'string' }, { type: 'integer' }], nullable: true } as any;
      const result = toJsonSchema(schema) as any;

      expect(result.anyOf).toHaveLength(2);
      expect(result.anyOf[0].oneOf).toHaveLength(2);
      expect(result.anyOf[1]).toEqual({ type: 'null' });
      expect(result.nullable).toBeUndefined();
    });

    it('should preserve nullability of enum-only schemas via anyOf wrapping', () => {
      const schema = { enum: ['a', 'b'], nullable: true } as any;
      const result = toJsonSchema(schema) as any;

      expect(result.anyOf[0].enum).toEqual(['a', 'b']);
      expect(result.anyOf[1]).toEqual({ type: 'null' });
    });

    it('should append null to an existing type array', () => {
      const schema = { type: ['string', 'number'], nullable: true } as any;
      const result = toJsonSchema(schema);

      expect(result.type).toEqual(['string', 'number', 'null']);
    });

    it('should not duplicate null in a type array that already includes it', () => {
      const schema = { type: ['string', 'null'], nullable: true } as any;
      const result = toJsonSchema(schema);

      expect(result.type).toEqual(['string', 'null']);
    });

    it('should leave type:null alone when nullable:true', () => {
      const schema = { type: 'null', nullable: true } as any;
      const result = toJsonSchema(schema);

      expect(result.type).toBe('null');
    });

    it('should convert nullable in nested properties', () => {
      const schema: SchemaObject = {
        type: 'object',
        properties: {
          name: { type: 'string', nullable: true } as any,
        },
      };
      const result = toJsonSchema(schema) as any;

      expect(result.properties?.name.type).toEqual(['string', 'null']);
      expect(result.properties?.name.nullable).toBeUndefined();
    });
  });

  describe('Example Normalization', () => {
    it('should convert singular example to an examples array', () => {
      const schema: SchemaObject = { type: 'string', example: 'hello' } as any;
      const result = toJsonSchema(schema);

      expect(result.examples).toEqual(['hello']);
      expect((result as any).example).toBeUndefined();
    });

    it('should keep an existing examples array and drop the singular example', () => {
      const schema = { type: 'string', example: 'a', examples: ['b', 'c'] } as any;
      const result = toJsonSchema(schema);

      expect(result.examples).toEqual(['b', 'c']);
      expect((result as any).example).toBeUndefined();
    });

    it('should preserve OpenAPI 3.1 examples arrays as-is', () => {
      const schema = { type: 'string', examples: ['x'] } as any;
      const result = toJsonSchema(schema);

      expect(result.examples).toEqual(['x']);
    });

    it('should convert falsy examples (0, false, null)', () => {
      expect(toJsonSchema({ type: 'integer', example: 0 } as any).examples).toEqual([0]);
      expect(toJsonSchema({ type: 'boolean', example: false } as any).examples).toEqual([false]);
      expect(toJsonSchema({ type: 'string', nullable: true, example: null } as any).examples).toEqual([null]);
    });

    it('should convert example in nested properties', () => {
      const schema: SchemaObject = {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'abc-123' } as any,
        },
      };
      const result = toJsonSchema(schema) as any;

      expect(result.properties?.id.examples).toEqual(['abc-123']);
    });
  });

  describe('XML Metadata Removal', () => {
    it('should drop the xml keyword', () => {
      const schema: SchemaObject = {
        type: 'object',
        xml: { name: 'user', wrapped: true },
        properties: {
          id: { type: 'string', xml: { attribute: true } } as any,
        },
      } as any;
      const result = toJsonSchema(schema) as any;

      expect(result.xml).toBeUndefined();
      expect(result.properties?.id.xml).toBeUndefined();
      expect(result.properties?.id.type).toBe('string');
    });
  });

  describe('Complex Schemas', () => {
    it('should handle deeply nested schema', () => {
      const schema: SchemaObject = {
        type: 'object',
        properties: {
          users: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                profile: {
                  type: 'object',
                  properties: {
                    score: {
                      type: 'number',
                      minimum: 0,
                      maximum: 100,
                      exclusiveMinimum: true as any,
                    },
                  },
                },
              },
            },
          },
        },
      };
      const result = toJsonSchema(schema) as any;

      const scoreSchema = result.properties?.users.items?.properties?.profile.properties?.score;
      expect(scoreSchema?.exclusiveMinimum).toBe(0);
      expect(scoreSchema?.maximum).toBe(100);
    });

    it('should handle schema with all composition keywords', () => {
      const schema: SchemaObject = {
        allOf: [{ type: 'object' }],
        anyOf: [{ type: 'object' }],
        oneOf: [{ type: 'object' }],
        not: { type: 'null' as any },
      };
      const result = toJsonSchema(schema);

      expect(result.allOf).toBeDefined();
      expect(result.anyOf).toBeDefined();
      expect(result.oneOf).toBeDefined();
      expect(result.not).toBeDefined();
    });
  });
});

describe('toJsonSchema 2020-12 keyword traversal', () => {
  const nullableString = { type: 'string', nullable: true, example: 'v', xml: { name: 'n' } } as any;
  const expectNormalized = (node: any) => {
    expect(node.type).toEqual(['string', 'null']);
    expect(node.nullable).toBeUndefined();
    expect(node.examples).toEqual(['v']);
    expect(node.example).toBeUndefined();
    expect(node.xml).toBeUndefined();
  };

  it('should normalize schemas under map-of-schemas keywords', () => {
    const result = toJsonSchema({
      type: 'object',
      patternProperties: { '^x-': nullableString },
      $defs: { Node: nullableString },
      definitions: { Legacy: nullableString },
      dependentSchemas: { flag: nullableString },
    } as any) as any;

    expectNormalized(result.patternProperties['^x-']);
    expectNormalized(result.$defs.Node);
    expectNormalized(result.definitions.Legacy);
    expectNormalized(result.dependentSchemas.flag);
  });

  it('should normalize schemas under single-schema keywords', () => {
    const result = toJsonSchema({
      contains: nullableString,
      propertyNames: { pattern: '^a' },
      if: nullableString,
      then: nullableString,
      else: nullableString,
      contentSchema: nullableString,
      unevaluatedItems: nullableString,
      unevaluatedProperties: false,
    } as any) as any;

    expectNormalized(result.contains);
    expectNormalized(result.if);
    expectNormalized(result.then);
    expectNormalized(result.else);
    expectNormalized(result.contentSchema);
    expectNormalized(result.unevaluatedItems);
    expect(result.propertyNames).toEqual({ pattern: '^a' });
    expect(result.unevaluatedProperties).toBe(false); // boolean form untouched
  });

  it('should normalize schemas under prefixItems', () => {
    const result = toJsonSchema({
      type: 'array',
      prefixItems: [nullableString, { type: 'number' }],
    } as any) as any;

    expectNormalized(result.prefixItems[0]);
    expect(result.prefixItems[1]).toEqual({ type: 'number' });
  });

  it('should hoist examples onto the nullable anyOf wrapper', () => {
    const result = toJsonSchema({ enum: ['a', 'b'], nullable: true, example: 'a' } as any) as any;

    expect(result.examples).toEqual(['a']);
    expect(result.anyOf[0].examples).toBeUndefined();
    expect(result.anyOf[0].enum).toEqual(['a', 'b']);
    expect(result.anyOf[1]).toEqual({ type: 'null' });
  });
});

describe('toJsonSchema cycle safety', () => {
  const { toJsonSchema } = require('../types');

  it('breaks true cycles with an unconstrained schema instead of recursing forever', () => {
    const message: any = { type: 'object', properties: {} };
    message.properties.referencedMessage = message;
    const result: any = toJsonSchema(message);
    expect(result.properties.referencedMessage).toEqual({});
  });

  it('converts a diamond-shared node once and reuses the result', () => {
    const shared: any = { type: 'string', nullable: true };
    const doc: any = { type: 'object', properties: { a: shared, b: shared } };
    const result: any = toJsonSchema(doc);
    expect(result.properties.a).toEqual({ type: ['string', 'null'] });
    expect(result.properties.a).toBe(result.properties.b);
  });

  it('always returns a fresh root, even for a schema converted before', () => {
    const shared: any = { type: 'object', properties: { id: { type: 'string' } } };
    expect(toJsonSchema(shared)).not.toBe(toJsonSchema(shared));
  });

  it('breaks mutual cycles through composition keywords', () => {
    const a: any = { type: 'object', properties: {} };
    const b: any = { anyOf: [a] };
    a.properties.b = b;
    const result: any = toJsonSchema(a);
    expect(result.properties.b.anyOf[0]).toEqual({});
  });
});

describe('toJsonSchema shared references and limits (issue #48)', () => {
  const { toJsonSchema } = require('../types');
  const { SchemaError } = require('../errors');
  const { SchemaBuilder } = require('../schema-builder');

  /**
   * What the pipeline emits: conversion bounded at maxDepth, then truncation
   * at the same depth (which discards everything conversion left past it —
   * placeholders, or deeper levels of a result reused from a shallower depth)
   */
  const convertAndTruncate = (schema: unknown, maxDepth: number): unknown =>
    SchemaBuilder.truncateDepth(toJsonSchema(schema, { maxDepth }), maxDepth);

  /** Each level has two properties that both reference the next level */
  function chain(levels: number, closeCycle = false): any {
    const nodes: any[] = Array.from({ length: levels }, () => ({ type: 'object', properties: {} }));
    const leaf = { type: 'string' };
    nodes.forEach((node, i) => {
      const next = i + 1 < levels ? nodes[i + 1] : closeCycle ? nodes[0] : leaf;
      node.properties.left = next;
      node.properties.right = next;
    });
    return nodes[0];
  }

  it('converts each shared node once: a 40-level chain stays within a 162-node budget', () => {
    // One visit per reference (81), plus the keywords of each node, converted
    // once (81); converting every occurrence would take 2^41
    const result: any = toJsonSchema(chain(40), { maxNodes: 162 });

    let node = result;
    for (let i = 0; i < 40; i++) {
      expect(node.properties.left).toBe(node.properties.right);
      node = node.properties.left;
    }
    expect(node).toEqual({ type: 'string' });
  });

  it('throws a SchemaError naming maxSchemaNodes once the node budget is exceeded', () => {
    expect(() => toJsonSchema(chain(40), { maxNodes: 10 })).toThrow(SchemaError);
    expect(() => toJsonSchema(chain(40), { maxNodes: 10 })).toThrow(/node budget of 10 \(maxSchemaNodes\)/);
  });

  it('stops descending below maxDepth, leaving {} placeholders', () => {
    const deep = {
      type: 'object',
      properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' } } } } } },
    };
    const result: any = toJsonSchema(deep, { maxDepth: 2 });

    expect(result.properties.a.properties.b.type).toBe('object');
    expect(result.properties.a.properties.b.properties.c).toEqual({});
  });

  it('does not count allOf members toward maxDepth (body flattening hoists them)', () => {
    const member = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } };

    const viaAllOf: any = toJsonSchema({ allOf: [{ allOf: [member] }] }, { maxDepth: 1 });
    expect(viaAllOf.allOf[0].allOf[0].properties.a.type).toBe('object');
    expect(viaAllOf.allOf[0].allOf[0].properties.a.properties.b).toEqual({});

    // anyOf members are not hoisted, so they do consume depth
    const viaAnyOf: any = toJsonSchema({ anyOf: [member] }, { maxDepth: 1 });
    expect(viaAnyOf.anyOf[0].properties.a).toEqual({});
  });

  it('reuses a depth-cut result only at the depth it was converted at or deeper', () => {
    const shared = { type: 'object', properties: { x: { type: 'object', properties: { y: { type: 'string' } } } } };

    // First reached deep (and cut there), then shallower: converted again, deeper
    const deepFirst: any = toJsonSchema(
      { type: 'object', properties: { a: { type: 'object', properties: { s: shared } }, s: shared } },
      { maxDepth: 3 },
    );
    expect(deepFirst.properties.a.properties.s.properties.x.properties.y).toEqual({});
    expect(deepFirst.properties.s.properties.x.properties.y).toEqual({ type: 'string' });

    // First reached shallow: the result is reused deeper
    const deeper = { type: 'object', properties: { x: { type: 'object', properties: { y: shared } } } };
    const shallowFirst: any = toJsonSchema(
      { type: 'object', properties: { s: deeper, a: { type: 'object', properties: { s: deeper } } } },
      { maxDepth: 3 },
    );
    expect(shallowFirst.properties.a.properties.s).toBe(shallowFirst.properties.s);
    expect(shallowFirst.properties.s.properties.x.properties.y.properties.x).toEqual({});
  });

  it('converts nodes on a cycle afresh for each path, cutting each at its own revisit', () => {
    const a: any = { type: 'object', properties: {} };
    const b: any = { type: 'object', properties: { a } };
    a.properties.b = b;
    const result: any = toJsonSchema({ type: 'object', properties: { x: a, y: b } });

    expect(result.properties.x).toEqual({ type: 'object', properties: { b: { type: 'object', properties: { a: {} } } } });
    expect(result.properties.y).toEqual({ type: 'object', properties: { a: { type: 'object', properties: { b: {} } } } });
  });

  it('still shares acyclic nodes reached from inside a cycle', () => {
    const leaf = { type: 'object', properties: { id: { type: 'string' } } };
    const a: any = { type: 'object', properties: { c: leaf } };
    const b: any = { type: 'object', properties: { a, c: leaf } };
    a.properties.b = b;
    const result: any = toJsonSchema(a);

    expect(result.properties.b.properties.a).toEqual({});
    expect(result.properties.c).toBe(result.properties.b.properties.c);
  });

  it('bounds a walkable cycle of shared references by maxDepth, converting it per path', () => {
    // Every level references the next twice and the root once: one strongly
    // connected component, so nothing is reused — but each path stops at maxDepth
    const nodes: any[] = Array.from({ length: 40 }, () => ({ type: 'object', properties: {} }));
    nodes.forEach((node, i) => {
      node.properties.left = nodes[(i + 1) % 40];
      node.properties.right = nodes[(i + 1) % 40];
      node.properties.back = nodes[0];
    });
    // 2^11 - 1 conversions with 3 child visits each
    const result: any = toJsonSchema(nodes[0], { maxDepth: 10, maxNodes: 10_000 });

    let node = result;
    for (let i = 0; i < 10; i++) node = node.properties.left;
    expect(node.properties.left).toEqual({});
    expect(result.properties.left).not.toBe(result.properties.right);
    expect(result.properties.left.properties.back).toEqual({});
    // 2^20 paths within depth 20 exceed the budget
    expect(() => toJsonSchema(nodes[0], { maxDepth: 20, maxNodes: 10_000 })).toThrow(SchemaError);
  });

  it('reuses nodes on a cycle too long to walk within maxDepth', () => {
    // The closing edge lies past maxDepth, so conversion never walks the cycle:
    // 11 conversions instead of 2^11
    const result: any = toJsonSchema(chain(40, true), { maxDepth: 10, maxNodes: 50 });

    let node = result;
    for (let i = 0; i < 10; i++) {
      expect(node.properties.left).toBe(node.properties.right);
      node = node.properties.left;
    }
    expect(node.properties.left).toEqual({});
  });

  it('confines the cycle analysis to the region within maxDepth, abandoning it past the node budget', () => {
    // `shared` is cut at maxDepth, so its revisit needs the cycle analysis. The
    // region holds 53 nodes; conversion charges 111 by reusing `shared` (117
    // without) — a visit per schema plus each converted schema's keywords —
    // and the 50 siblings put the region over a 40-node budget
    const shared = { type: 'object', properties: { y: { type: 'object', properties: { z: { type: 'string' } } } } };
    const properties: Record<string, unknown> = { a: shared, b: shared };
    for (let i = 0; i < 50; i++) properties[`w${i}`] = { type: 'string' };
    const root = { type: 'object', properties };

    const result: any = toJsonSchema(root, { maxDepth: 2, maxNodes: 111 });
    expect(result.properties.a).toBe(result.properties.b);
    expect(result.properties.a.properties.y.properties.z).toEqual({});
    // Past the budget nothing is reused (always correct), and conversion fails on its own budget
    expect(() => toJsonSchema(root, { maxDepth: 2, maxNodes: 40 })).toThrow(/node budget of 40 /);
  });

  it('emits shared, depth-cut schemas exactly like their fully expanded tree, across every keyword', () => {
    const deep = { type: 'object', properties: { x: { type: 'object', properties: { y: { type: 'string' } } } } };
    const sink = {
      type: 'object',
      properties: { a: deep, b: deep, flag: true, odd: { properties: 'invalid', $defs: [], items: true } },
      items: [deep, { type: 'string', nullable: true }],
      prefixItems: [deep],
      additionalProperties: { type: 'string' },
      allOf: [{ properties: { c: deep } }, deep],
      anyOf: [deep],
      oneOf: [{ type: 'null' }],
      not: { type: 'integer' },
      patternProperties: { '^x-': deep },
      $defs: { D: deep },
      definitions: { E: { type: 'string' } },
      dependentSchemas: { a: { required: ['b'] } },
      contains: deep,
      propertyNames: { pattern: '^[a-z]+$' },
      if: { properties: { a: { const: 1 } } },
      then: deep,
      else: { type: 'object', example: { a: 1 } },
      contentSchema: deep,
      unevaluatedItems: false,
      unevaluatedProperties: { type: 'string' },
    };
    const shared = { type: 'array', items: sink };
    const expanded = JSON.parse(JSON.stringify(shared)); // same schema, no shared objects

    for (const maxDepth of [1, 2, 3]) {
      expect(convertAndTruncate(shared, maxDepth)).toEqual(convertAndTruncate(expanded, maxDepth));
    }
  });

  it('walks a node reached through allOf at a shallower depth than first queued', () => {
    // `shared` is queued at depth 1 (properties) and then reached at depth 0 (allOf)
    const shared = { type: 'object', properties: { x: { type: 'object', properties: { y: { type: 'string' } } } } };
    const root = { type: 'object', properties: { a: shared, b: shared }, allOf: [shared] };
    const expanded = JSON.parse(JSON.stringify(root));

    expect(convertAndTruncate(root, 2)).toEqual(convertAndTruncate(expanded, 2));
  });

  it('analyzes cycles iteratively, so very deep schemas do not overflow the stack', () => {
    const root: any = { type: 'object', properties: {} };
    let tail = root;
    for (let i = 0; i < 50_000; i++) {
      tail.properties.next = { type: 'object', properties: {} };
      tail = tail.properties.next;
    }
    const result: any = toJsonSchema(root, { maxDepth: 2 });

    expect(result.properties.next.properties.next.properties.next).toEqual({});
  });

  it('charges cycle placeholders against the node budget', () => {
    // Two schemas referencing each other through 300 properties each: every one
    // of A's properties rebuilds B, whose 300 properties are cycle placeholders
    const a: any = { type: 'object', properties: {} };
    const b: any = { type: 'object', properties: {} };
    for (let i = 0; i < 300; i++) {
      a.properties[`b${i}`] = b;
      b.properties[`a${i}`] = a;
    }

    expect(() => toJsonSchema(a, { maxDepth: 10, maxNodes: 10_000 })).toThrow(/node budget of 10000 /);
    expect(() => toJsonSchema(a, { maxDepth: 10, maxNodes: 100_000 })).not.toThrow();
  });

  it('charges depth placeholders and reused results against the node budget', () => {
    const leaf = { type: 'string' };
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) properties[`p${i}`] = leaf;
    const wide = { type: 'object', properties };

    // The root with its 2 keywords (3), and 20 children past maxDepth: 23
    expect(() => toJsonSchema(wide, { maxDepth: 0, maxNodes: 22 })).toThrow(/node budget of 22 /);
    expect(toJsonSchema(wide, { maxDepth: 0, maxNodes: 23 }).properties.p0).toEqual({});
    // The root (3), 1 conversion of the shared leaf (2), and 19 reuses: 24
    expect(() => toJsonSchema(wide, { maxNodes: 23 })).toThrow(/node budget of 23 /);
    expect(toJsonSchema(wide, { maxNodes: 24 }).properties.p19).toEqual({ type: 'string' });
  });

  it('floors fractional limits and treats absent or non-finite ones as unbounded', () => {
    const deep = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } };

    expect(toJsonSchema(deep, { maxDepth: 1.9 })).toEqual(toJsonSchema(deep, { maxDepth: 1 }));
    expect(toJsonSchema(deep, { maxDepth: Infinity })).toEqual(toJsonSchema(deep));
    expect(toJsonSchema(deep, { maxDepth: NaN })).toEqual(toJsonSchema(deep));
    expect(toJsonSchema(deep, { maxDepth: -3 }).properties).toEqual({ a: {} });
    expect(() => toJsonSchema(chain(12), { maxNodes: NaN })).not.toThrow();
    expect(() => toJsonSchema(deep, { maxNodes: 0.5 })).toThrow(/node budget of 1 /);
  });

  it('keeps holes in sparse schema arrays, as before', () => {
    // `[, x]` has a hole at index 0
    const result: any = toJsonSchema({
      allOf: [, { type: 'string' }],
      items: [, { type: 'integer' }],
      prefixItems: [, { type: 'boolean' }],
    } as any);

    for (const key of ['allOf', 'items', 'prefixItems']) {
      expect(result[key]).toHaveLength(2);
      expect(0 in result[key]).toBe(false);
    }
    expect(result.allOf[1]).toEqual({ type: 'string' });
    expect(result.items[1]).toEqual({ type: 'integer' });
    expect(result.prefixItems[1]).toEqual({ type: 'boolean' });
  });

  it('treats boolean and reference subschemas as leaves', () => {
    expect(toJsonSchema({ type: 'array', items: true } as any)).toEqual({ type: 'array', items: {} });
    expect(toJsonSchema(true as any)).toEqual({});
    expect(toJsonSchema({ $ref: '#/components/schemas/Pet' })).toEqual({ $ref: '#/components/schemas/Pet' });
  });
});

describe('toJsonSchema on deeply nested schemas (issue #50)', () => {
  /** Follow `step` from `schema` `times` times, without recursing */
  const descend = (schema: any, times: number, step: (node: any) => any): any => {
    let node = schema;
    for (let i = 0; i < times; i++) node = step(node);
    return node;
  };

  it('converts an allOf chain of any length — allOf members do not consume maxDepth', () => {
    let schema: any = { type: 'object', properties: { id: { type: 'string', nullable: true } } };
    for (let i = 0; i < 20000; i++) schema = { allOf: [schema], description: `level ${i}` };

    const result = toJsonSchema(schema, { maxDepth: 10 });

    const leaf = descend(result, 20000, (node) => node.allOf[0]);
    expect(leaf).toEqual({ type: 'object', properties: { id: { type: ['string', 'null'] } } });
  });

  it('converts a schema of any depth when maxDepth is unbounded, normalizing every level', () => {
    let schema: any = { type: 'integer', example: 7, xml: { name: 'n' } };
    for (let i = 0; i < 20000; i++) {
      schema = { type: 'object', nullable: i % 2 === 1, properties: { next: { type: 'array', items: schema } } };
    }

    const result = toJsonSchema(schema);

    // Odd levels, the outermost among them, are nullable
    expect(result.type).toEqual(['object', 'null']);
    expect(result.properties!.next).toMatchObject({ items: { type: 'object' } });
    const leaf = descend(result, 20000, (node) => node.properties.next.items);
    expect(leaf).toEqual({ type: 'integer', examples: [7] });
  });

  it('still cuts a deep chain at maxDepth and reuses a shared subschema below it', () => {
    const shared = { type: 'object', properties: { a: { type: 'string' } } };
    let schema: any = shared;
    for (let i = 0; i < 20000; i++) schema = { allOf: [schema, shared] };

    // The chain is walked to its end, yet `shared` converts once
    const result = toJsonSchema(schema, { maxDepth: 1, maxNodes: 60005 });

    const leaf = descend(result, 20000, (node) => node.allOf[0]);
    expect(leaf).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
    expect(result.allOf![1]).toBe(leaf);
  });
});

describe('toJsonSchema charges every keyword it copies (issue #50)', () => {
  const { SchemaError } = require('../errors');

  it('charges a converted schema one node per keyword, on top of its visit', () => {
    const schema = { type: 'string', format: 'uuid', description: 'id' };

    expect(toJsonSchema(schema, { maxNodes: 4 })).toEqual(schema);
    expect(() => toJsonSchema(schema, { maxNodes: 3 })).toThrow(/node budget of 3 /);
  });

  it('charges each hole of a schema list, rejecting a long list before walking it', () => {
    // The root and its keyword (2), the hole (1), the member and its keyword (2)
    // eslint-disable-next-line no-sparse-arrays
    const schema = { allOf: [, { type: 'string' }] } as any;
    expect(() => toJsonSchema(schema, { maxNodes: 5 })).not.toThrow();
    expect(() => toJsonSchema(schema, { maxNodes: 4 })).toThrow(/node budget of 4 /);
    expect(() => toJsonSchema({ items: new Array(1e9) } as any, { maxNodes: 1000 })).toThrow(/node budget of 1000 /);
  });

  it('stops a schema with many keywords that a cycle makes it convert once per path', () => {
    // Seven levels of four properties, then a schema with 500 keywords that
    // leads back to the top: everything is on one cycle, so nothing is
    // reused, and the wide schema is converted once per path — 4^7 times
    const top: any = { type: 'object', properties: {} };
    let level = top;
    for (let i = 1; i < 7; i++) {
      const next: any = { type: 'object', properties: {} };
      for (const p of ['a', 'b', 'c', 'd']) level.properties[p] = next;
      level = next;
    }
    const wide: any = { type: 'object', properties: { back: top } };
    for (let k = 0; k < 500; k++) wide[`x-k${k}`] = k;
    for (const p of ['a', 'b', 'c', 'd']) level.properties[p] = wide;

    expect(() => toJsonSchema(top, { maxDepth: 10, maxNodes: 100000 })).toThrow(SchemaError);
  });
});
