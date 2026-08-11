/**
 * Tests for client compatibility targets — per-client schema dialect transforms
 */

import {
  applyClientTarget,
  inlineLocalRefs,
  ensureArrayItems,
  collapseRootCompositions,
  collapseNestedUnions,
  demoteFormats,
  enforceClosedObjects,
  requireAllProperties,
} from '../client-targets';
import { OpenAPIToolGenerator } from '../generator';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('inlineLocalRefs', () => {
  it('resolves $defs pointers and strips the definition blocks', () => {
    const schema: any = {
      type: 'object',
      properties: { user: { $ref: '#/$defs/User' } },
      $defs: { User: { type: 'object', properties: { name: { type: 'string' } } } },
    };
    const result = inlineLocalRefs(schema) as any;

    expect(result.properties.user.type).toBe('object');
    expect(result.properties.user.properties.name.type).toBe('string');
    expect(result.$defs).toBeUndefined();
  });

  it('resolves legacy definitions pointers and JSON-pointer escapes', () => {
    const schema: any = {
      properties: {
        a: { $ref: '#/definitions/weird~1name' },
      },
      definitions: { 'weird/name': { type: 'integer' } },
    };
    const result = inlineLocalRefs(schema) as any;

    expect(result.properties.a.type).toBe('integer');
    expect(result.definitions).toBeUndefined();
  });

  it('replaces circular refs with a permissive note', () => {
    const schema: any = {
      properties: { node: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { next: { $ref: '#/$defs/Node' } } } },
    };
    const result = inlineLocalRefs(schema) as any;

    expect(result.properties.node.type).toBe('object');
    expect(result.properties.node.properties.next.description).toContain('Circular');
  });

  it('replaces unresolvable refs with a note', () => {
    const schema: any = { properties: { x: { $ref: '#/$defs/Missing' } } };
    const result = inlineLocalRefs(schema) as any;

    expect(result.properties.x.description).toContain('Unresolvable');
  });

  it('walks refs inside items, compositions, and maps', () => {
    const schema: any = {
      $defs: { S: { type: 'string' } },
      properties: {
        list: { type: 'array', items: { $ref: '#/$defs/S' } },
        union: { oneOf: [{ $ref: '#/$defs/S' }] },
        patterned: { patternProperties: { '^x-': { $ref: '#/$defs/S' } } },
      },
    };
    const result = inlineLocalRefs(schema) as any;

    expect(result.properties.list.items.type).toBe('string');
    expect(result.properties.union.oneOf[0].type).toBe('string');
    expect(result.properties.patterned.patternProperties['^x-'].type).toBe('string');
  });
});

describe('ensureArrayItems', () => {
  it('adds permissive items to arrays lacking them', () => {
    const result = ensureArrayItems({ type: 'array' } as any) as any;

    expect(result.items).toEqual({});
  });

  it('handles type unions containing array and leaves existing items alone', () => {
    const union = ensureArrayItems({ type: ['array', 'null'] } as any) as any;
    expect(union.items).toEqual({});

    const typed = ensureArrayItems({ type: 'array', items: { type: 'string' } } as any) as any;
    expect(typed.items).toEqual({ type: 'string' });
  });

  it('walks nested arrays', () => {
    const result = ensureArrayItems({
      type: 'object',
      properties: { tags: { type: 'array' } },
    } as any) as any;

    expect(result.properties.tags.items).toEqual({});
  });
});

describe('collapseRootCompositions', () => {
  it('merges root allOf members', () => {
    const result = collapseRootCompositions({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { properties: { b: { type: 'integer' } }, required: ['b'], description: 'from member' },
      ],
      title: 'Own title',
    } as any) as any;

    expect(Object.keys(result.properties).sort()).toEqual(['a', 'b']);
    expect(result.required.sort()).toEqual(['a', 'b']);
    expect(result.title).toBe('Own title');
    expect(result.allOf).toBeUndefined();
  });

  it('unwraps the nullable anyOf wrapper with a note', () => {
    const result = collapseRootCompositions({
      anyOf: [{ type: 'string', maxLength: 5 }, { type: 'null' }],
      description: 'A name.',
    } as any) as any;

    expect(result.type).toBe('string');
    expect(result.maxLength).toBe(5);
    expect(result.description).toBe('A name. May be null.');
    expect(result.anyOf).toBeUndefined();
  });

  it('collapses root oneOf into a documented permissive node with x-variants', () => {
    const result = collapseRootCompositions({
      oneOf: [
        { title: 'Success', type: 'object' },
        { description: 'Error payload', type: 'object' },
        { type: 'string' },
        { minimum: 1 },
      ],
    } as any) as any;

    expect(result.oneOf).toBeUndefined();
    expect(result['x-variants']).toHaveLength(4);
    expect(result.description).toContain('Accepts one of 4 variants');
    expect(result.description).toContain('Success');
    expect(result.description).toContain('Error payload');
    expect(result.description).toContain('type string');
    expect(result.description).toContain('variant 4');
  });

  it('collapses root anyOf (non-nullable-wrapper) the same way', () => {
    const result = collapseRootCompositions({
      anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }],
      description: 'Pick.',
    } as any) as any;

    expect(result['x-variants']).toHaveLength(3);
    expect(result.description).toContain('Pick.');
  });

  it('leaves plain objects untouched', () => {
    const schema: any = { type: 'object', properties: { a: { type: 'string' } } };

    expect(collapseRootCompositions(schema)).toEqual(schema);
  });
});

describe('collapseNestedUnions', () => {
  it('unwraps nullable wrappers at any depth', () => {
    const result = collapseNestedUnions({
      type: 'object',
      properties: {
        name: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'A name.' },
      },
    } as any) as any;

    expect(result.properties.name.type).toBe('string');
    expect(result.properties.name.description).toBe('A name. May be null.');
  });

  it('keeps the first variant of nested unions and documents the omitted rest', () => {
    const result = collapseNestedUnions({
      type: 'object',
      properties: {
        contact: {
          oneOf: [
            { type: 'object', properties: { email: { type: 'string' } }, title: 'Email' },
            { type: 'object', properties: { phone: { type: 'string' } }, title: 'Phone' },
          ],
        },
      },
    } as any) as any;

    const contact = result.properties.contact;
    expect(contact.oneOf).toBeUndefined();
    expect(contact.properties.email).toBeDefined();
    expect(contact.description).toContain('1 alternative schema variant(s) omitted');
    expect(contact.description).toContain('Phone');
  });

  it('collapses single-member unions without a note', () => {
    const result = collapseNestedUnions({
      properties: { only: { anyOf: [{ type: 'string' }] } },
    } as any) as any;

    expect(result.properties.only.type).toBe('string');
    expect(result.properties.only.description).toBeUndefined();
  });

  it('collapses type arrays keeping the first non-null type', () => {
    const result = collapseNestedUnions({
      type: 'object',
      properties: {
        maybe: { type: ['string', 'null'], description: 'A value.' },
        multi: { type: ['string', 'integer', 'null'] },
        onlyNull: { type: ['null'] },
      },
    } as any) as any;

    expect(result.properties.maybe.type).toBe('string');
    expect(result.properties.maybe.description).toBe('A value. May be null.');
    expect(result.properties.multi.type).toBe('string');
    expect(result.properties.multi.description).toContain('Alternative types accepted: integer.');
    expect(result.properties.multi.description).toContain('May be null.');
    expect(result.properties.onlyNull.type).toBe('null');
  });

  it('merges nested allOf', () => {
    const result = collapseNestedUnions({
      properties: {
        merged: {
          allOf: [{ properties: { a: { type: 'string' } } }, { properties: { b: { type: 'integer' } } }],
        },
      },
    } as any) as any;

    expect(Object.keys(result.properties.merged.properties).sort()).toEqual(['a', 'b']);
  });
});

describe('demoteFormats', () => {
  it('demotes unsupported formats into descriptions and keeps date-time', () => {
    const result = demoteFormats({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', description: 'The id.' },
        at: { type: 'string', format: 'date-time' },
      },
    } as any) as any;

    expect(result.properties.id.format).toBeUndefined();
    expect(result.properties.id.description).toBe('The id. (format: uuid)');
    expect(result.properties.at.format).toBe('date-time');
  });

  it('adds a description when none exists', () => {
    const result = demoteFormats({ type: 'string', format: 'email' } as any) as any;

    expect(result.description).toBe('(format: email)');
  });
});

describe('enforceClosedObjects', () => {
  it('closes open objects at every level', () => {
    const result = enforceClosedObjects({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { x: { type: 'string' } } },
        open: { type: 'object', additionalProperties: true },
        typedMap: { type: 'object', additionalProperties: { type: 'string' } },
        alreadyClosed: { type: 'object', additionalProperties: false },
        untyped: { properties: { y: { type: 'string' } } },
      },
    } as any) as any;

    expect(result.additionalProperties).toBe(false);
    expect(result.properties.nested.additionalProperties).toBe(false);
    expect(result.properties.open.additionalProperties).toBe(false);
    expect(result.properties.typedMap.additionalProperties).toEqual({ type: 'string' });
    expect(result.properties.alreadyClosed.additionalProperties).toBe(false);
    expect(result.properties.untyped.additionalProperties).toBe(false);
  });
});

describe('applyClientTarget pipelines', () => {
  const unionSchema = (): any => ({
    $defs: { Tag: { type: 'string', format: 'uuid' } },
    type: 'object',
    properties: {
      tags: { type: 'array' },
      ref: { $ref: '#/$defs/Tag' },
      maybe: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    },
  });

  it('strict: inlines refs, fixes arrays, keeps nested unions', () => {
    const result = applyClientTarget(unionSchema(), 'strict') as any;

    expect(result.$defs).toBeUndefined();
    expect(result.properties.ref.type).toBe('string');
    expect(result.properties.tags.items).toEqual({});
    expect(result.properties.maybe.anyOf).toHaveLength(2); // nested unions survive
    expect(result.additionalProperties).toBeUndefined();
  });

  it('claude: same pipeline as strict', () => {
    expect(applyClientTarget(unionSchema(), 'claude')).toEqual(applyClientTarget(unionSchema(), 'strict'));
  });

  it('openai: strict + closed objects', () => {
    const result = applyClientTarget(unionSchema(), 'openai') as any;

    expect(result.additionalProperties).toBe(false);
  });

  it('gemini: strict + nested unions collapsed + formats demoted', () => {
    const result = applyClientTarget(unionSchema(), 'gemini') as any;

    expect(result.properties.maybe.anyOf).toBeUndefined();
    expect(result.properties.maybe.type).toBe('integer');
    expect(result.properties.ref.format).toBeUndefined();
    expect(result.properties.ref.description).toContain('format: uuid');
  });
});

describe('target option in the generator', () => {
  const spec: any = {
    openapi: '3.0.0',
    info: { title: 'Target API', version: '1.0.0' },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          parameters: [
            { name: 'when', in: 'query', schema: { type: 'string', format: 'date', nullable: true } },
          ],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
            },
            '404': {
              description: 'Not found',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };

  it('applies gemini transforms to generated input and output schemas', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/items', 'get', { target: 'gemini' });
    const when = (tool.inputSchema as any).properties.when;

    // nullable wrapper collapsed, date format demoted
    expect(when.anyOf).toBeUndefined();
    expect(when.type).toBe('string');
    expect(when.description).toContain('May be null.');
    expect(when.format).toBeUndefined();

    // output root oneOf (two status codes) collapsed to the first variant —
    // Gemini never receives x-variants metadata
    const output = tool.outputSchema as any;
    expect(output.oneOf).toBeUndefined();
    expect(output['x-variants']).toBeUndefined();
    expect(output.type).toBe('array');
    expect(output.description).toContain('alternative schema variant');
  });

  it('leaves schemas untouched without a target', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/items', 'get');
    const when = (tool.inputSchema as any).properties.when;

    // exact untransformed shape: nullable type union with format intact
    expect(when).toEqual({
      type: ['string', 'null'],
      format: 'date',
      'x-parameter-location': 'query',
    });
    expect((tool.outputSchema as any).oneOf).toHaveLength(2);
  });
});

describe('edge coverage', () => {
  it('walks tuple-style items arrays in generic transforms', () => {
    const result = demoteFormats({
      type: 'array',
      items: [{ type: 'string', format: 'uuid' }, { type: 'number' }],
    } as any) as any;

    expect(result.items[0].format).toBeUndefined();
    expect(result.items[0].description).toContain('format: uuid');
    expect(result.items[1]).toEqual({ type: 'number' });
  });

  it('inlines refs inside tuple-style items arrays', () => {
    const result = inlineLocalRefs({
      $defs: { S: { type: 'string' } },
      type: 'array',
      items: [{ $ref: '#/$defs/S' }],
    } as any) as any;

    expect(result.items[0].type).toBe('string');
  });

  it('merges allOf members with the node own properties and required', () => {
    const result = collapseRootCompositions({
      allOf: [{ properties: { fromMember: { type: 'string' } }, required: ['fromMember'] }],
      properties: { own: { type: 'integer' } },
      required: ['own'],
    } as any) as any;

    expect(Object.keys(result.properties).sort()).toEqual(['fromMember', 'own']);
    expect(result.required.sort()).toEqual(['fromMember', 'own']);
  });

  it('does not treat two-member unions without null as nullable wrappers', () => {
    const result = collapseRootCompositions({
      anyOf: [{ type: 'string' }, { type: 'integer' }],
    } as any) as any;

    expect(result['x-variants']).toHaveLength(2);
  });

  it('does not treat boolean-member unions as nullable wrappers', () => {
    const result = collapseRootCompositions({
      anyOf: [true, { type: 'null' }],
    } as any) as any;

    expect(result['x-variants']).toHaveLength(2);
  });

  it('unwraps nullable wrappers without a description', () => {
    const result = collapseRootCompositions({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    } as any) as any;

    expect(result.type).toBe('string');
    expect(result.description).toBe('May be null.');
  });

  it('appends the omitted-variants note to an existing union description', () => {
    const result = collapseNestedUnions({
      properties: {
        u: { oneOf: [{ type: 'string' }, { type: 'integer' }], description: 'Pick one.' },
      },
    } as any) as any;

    expect(result.properties.u.description).toContain('Pick one.');
    expect(result.properties.u.description).toContain('1 alternative schema variant(s) omitted');
  });
});

describe('external refs, enum nullability, gemini metadata, numeric formats', () => {
  it('removes non-local $refs with a note, keeping siblings', () => {
    const result = inlineLocalRefs({
      properties: {
        remote: { $ref: 'https://example.com/schemas/User.json', description: 'site doc' },
        relative: { $ref: './common.yaml#/User' },
      },
    } as any) as any;

    expect(result.properties.remote.$ref).toBeUndefined();
    expect(result.properties.remote.description).toBe('site doc');
    expect(result.properties.relative.$ref).toBeUndefined();
    expect(result.properties.relative.description).toContain('External $ref');
  });

  it('resolves local refs inside the siblings of a removed external $ref', () => {
    const result = inlineLocalRefs({
      $defs: { Inner: { type: 'string' } },
      properties: {
        combo: {
          $ref: 'https://example.com/base.json',
          properties: { local: { $ref: '#/$defs/Inner' } },
        },
      },
    } as any) as any;

    expect(result.properties.combo.$ref).toBeUndefined();
    expect(result.properties.combo.properties.local).toEqual({ type: 'string' });
    expect(result.$defs).toBeUndefined();
  });

  it('extends enums with null in the openai nullable rewrite and skips const', () => {
    const result = requireAllProperties({
      type: 'object',
      properties: {
        pick: { type: 'string', enum: ['a', 'b'] },
        pinned: { type: 'string', const: 'fixed' },
        bare: { enum: [1, 2] },
      },
      required: [],
    } as any) as any;

    expect(result.properties.pick.type).toEqual(['string', 'null']);
    expect(result.properties.pick.enum).toEqual(['a', 'b', null]);
    expect(result.properties.pinned).toEqual({ type: 'string', const: 'fixed' }); // untouched
    expect(result.properties.bare.enum).toEqual([1, 2, null]);
    expect(result.required.sort()).toEqual(['bare', 'pick', 'pinned']);
  });

  it('gemini collapses root unions without emitting x-variants', () => {
    const result = applyClientTarget(
      { oneOf: [{ type: 'string', title: 'S' }, { type: 'integer', title: 'I' }] } as any,
      'gemini',
    ) as any;

    expect(result['x-variants']).toBeUndefined();
    expect(result.oneOf).toBeUndefined();
    expect(result.type).toBe('string');
    expect(result.description).toContain('I');
  });

  it('keeps numeric formats on numeric nodes and demotes them elsewhere', () => {
    const result = demoteFormats({
      type: 'object',
      properties: {
        count: { type: 'integer', format: 'int32' },
        big: { type: ['integer', 'null'], format: 'int64' },
        ratio: { type: 'number', format: 'double' },
        maybeRatio: { type: ['number', 'null'], format: 'float' },
        odd: { type: 'string', format: 'int64' },
      },
    } as any) as any;

    expect(result.properties.count.format).toBe('int32');
    expect(result.properties.big.format).toBe('int64');
    expect(result.properties.ratio.format).toBe('double');
    expect(result.properties.maybeRatio.format).toBe('float');
    expect(result.properties.odd.format).toBeUndefined();
    expect(result.properties.odd.description).toContain('format: int64');
  });
});

describe('nested compositions and strict-mode rewrites', () => {
  it('mergeAllOf recursively merges nested allOf members without leaking composition keys', () => {
    const result = collapseRootCompositions({
      allOf: [
        { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }] },
        { type: 'object', properties: { b: { type: 'integer' } } },
      ],
    } as any) as any;

    expect(result.allOf).toBeUndefined();
    expect(Object.keys(result.properties).sort()).toEqual(['a', 'b']);
  });

  it('collapseRootCompositions re-enters when an allOf member contributes a union', () => {
    const result = collapseRootCompositions({
      allOf: [{ oneOf: [{ type: 'string' }, { type: 'integer' }] }, { description: 'combo' }],
    } as any) as any;

    expect(result.allOf).toBeUndefined();
    expect(result.oneOf).toBeUndefined();
    expect(result['x-variants']).toHaveLength(2);
  });

  it('collapseNestedUnions reaches a fixpoint on unions exposed by unwrapping', () => {
    const result = collapseNestedUnions({
      anyOf: [{ anyOf: [{ type: 'string' }, { type: 'integer' }] }, { type: 'null' }],
    } as any) as any;

    expect(result.anyOf).toBeUndefined();
    expect(result.oneOf).toBeUndefined();
    expect(result.type).toBe('string');
    expect(result.description).toContain('May be null.');
    expect(result.description).toContain('alternative schema variant');
  });

  it('inlineLocalRefs keeps $ref sibling keywords, siblings winning', () => {
    const result = inlineLocalRefs({
      $defs: { S: { type: 'string', description: 'from def' } },
      properties: {
        described: { $ref: '#/$defs/S', description: 'from site' },
        missing: { $ref: '#/$defs/Nope', title: 'Kept' },
      },
    } as any) as any;

    expect(result.properties.described.type).toBe('string');
    expect(result.properties.described.description).toBe('from site');
    expect(result.properties.missing.title).toBe('Kept');
  });

  it('enforceClosedObjects closes nullable object type arrays', () => {
    const result = enforceClosedObjects({
      type: ['object', 'null'],
      properties: { a: { type: 'string' } },
    } as any) as any;

    expect(result.additionalProperties).toBe(false);
  });

  it('requireAllProperties makes optionals required-but-nullable (openai strict)', () => {
    const result = requireAllProperties({
      type: 'object',
      properties: {
        must: { type: 'string' },
        maybe: { type: 'string' },
        multi: { type: ['string', 'integer'] },
        already: { type: ['string', 'null'] },
        untyped: {},
      },
      required: ['must'],
    } as any) as any;

    expect(result.required.sort()).toEqual(['already', 'maybe', 'multi', 'must', 'untyped']);
    expect(result.properties.must.type).toBe('string'); // originally required: untouched
    expect(result.properties.maybe.type).toEqual(['string', 'null']);
    expect(result.properties.multi.type).toEqual(['string', 'integer', 'null']);
    expect(result.properties.already.type).toEqual(['string', 'null']);
    expect(result.properties.untyped).toEqual({});
  });

  it('openai target output passes strict-mode requirements end to end', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Strict API', version: '1.0.0' },
      paths: {
        '/search': {
          get: {
            operationId: 'search',
            parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }], // optional
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/search', 'get', { target: 'openai' });
    const input = tool.inputSchema as any;

    expect(input.additionalProperties).toBe(false);
    expect(input.required).toEqual(['q']);
    expect(input.properties.q.type).toEqual(['string', 'null']);
  });
});
