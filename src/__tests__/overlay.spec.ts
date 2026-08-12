/**
 * Tests for OpenAPI Overlay 1.0 application and its JSONPath subset
 */

import { applyOverlay } from '../overlay';
import type { OverlayDocument } from '../overlay';
import { OverlayError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';

/* eslint-disable @typescript-eslint/no-explicit-any */

const overlayWith = (actions: OverlayDocument['actions']): OverlayDocument => ({
  overlay: '1.0.0',
  info: { title: 'Test overlay', version: '1.0.0' },
  actions,
});

const baseDoc = (): any => ({
  openapi: '3.0.0',
  info: { title: 'Base API', version: '1.0.0' },
  tags: [{ name: 'users' }],
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        description: 'Human docs.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
      post: {
        operationId: 'createUser',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
});

describe('applyOverlay', () => {
  it('deep-merges object updates and never mutates the input', () => {
    const doc = baseDoc();
    const result = applyOverlay(
      doc,
      overlayWith([{ target: '$.info', update: { title: 'Curated API', 'x-internal': true } }]),
    ) as any;

    expect(result.info).toEqual({ title: 'Curated API', version: '1.0.0', 'x-internal': true });
    expect(doc.info.title).toBe('Base API'); // input untouched
  });

  it('appends to array targets', () => {
    const result = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$.tags', update: { name: 'admin' } }]),
    ) as any;

    expect(result.tags).toEqual([{ name: 'users' }, { name: 'admin' }]);
  });

  it('replaces primitive targets via their parent', () => {
    const result = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$.info.title', update: 'Renamed' }]),
    ) as any;

    expect(result.info.title).toBe('Renamed');
  });

  it('removes object properties and splices array elements preserving order', () => {
    const result = applyOverlay(
      baseDoc(),
      overlayWith([
        { target: "$.paths['/users'].post", remove: true },
        { target: "$.paths['/users'].get.parameters[0]", remove: true },
      ]),
    ) as any;

    expect(result.paths['/users'].post).toBeUndefined();
    expect(result.paths['/users'].get.parameters.map((p: any) => p.name)).toEqual(['X-Trace']);
  });

  it('supports bracket-quoted names with special characters', () => {
    const result = applyOverlay(
      baseDoc(),
      overlayWith([{ target: "$.paths['/users/{id}'].get", update: { 'x-mcp': { name: 'user_get' } } }]),
    ) as any;

    expect(result.paths['/users/{id}'].get['x-mcp']).toEqual({ name: 'user_get' });
  });

  it('applies wildcard segments over object values', () => {
    const result = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$.paths.*.get', update: { 'x-audited': true } }]),
    ) as any;

    expect(result.paths['/users'].get['x-audited']).toBe(true);
    expect(result.paths['/users/{id}'].get['x-audited']).toBe(true);
    expect(result.paths['/users'].post['x-audited']).toBeUndefined();
  });

  it('filters array members by equality, inequality, and existence', () => {
    const eq = applyOverlay(
      baseDoc(),
      overlayWith([
        { target: "$.paths['/users'].get.parameters[?(@.name == 'limit')]", update: { description: 'Page size.' } },
      ]),
    ) as any;
    expect(eq.paths['/users'].get.parameters[0].description).toBe('Page size.');
    expect(eq.paths['/users'].get.parameters[1].description).toBeUndefined();

    const neq = applyOverlay(
      baseDoc(),
      overlayWith([{ target: "$.paths['/users'].get.parameters[?(@.in != 'query')]", remove: true }]),
    ) as any;
    expect(neq.paths['/users'].get.parameters.map((p: any) => p.name)).toEqual(['limit']);

    const exists = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$.paths.*[?(@.operationId)]', update: { 'x-known': true } }]),
    ) as any;
    expect(exists.paths['/users'].get['x-known']).toBe(true);
    expect(exists.paths['/users'].post['x-known']).toBe(true);
  });

  it('supports numeric and boolean filter literals and negative indices', () => {
    const doc: any = { items: [{ rank: 1, keep: true }, { rank: 2, keep: false }] };

    const num = applyOverlay(doc, overlayWith([{ target: '$.items[?(@.rank == 2)]', update: { hit: true } }])) as any;
    expect(num.items[1].hit).toBe(true);

    const bool = applyOverlay(doc, overlayWith([{ target: '$.items[?(@.keep == true)]', update: { hit: true } }])) as any;
    expect(bool.items[0].hit).toBe(true);

    const neg = applyOverlay(doc, overlayWith([{ target: '$.items[-1]', update: { last: true } }])) as any;
    expect(neg.items[1].last).toBe(true);
  });

  it('supports recursive descent with names and filters', () => {
    const named = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$..parameters[?(@.in == "header")]', remove: true }]),
    ) as any;
    expect(named.paths['/users'].get.parameters.map((p: any) => p.name)).toEqual(['limit']);
    expect(named.paths['/users/{id}'].get.parameters).toHaveLength(1);

    const deep = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$..operationId', update: 'renamed' }]),
    ) as any;
    expect(deep.paths['/users'].get.operationId).toBe('renamed');
    expect(deep.paths['/users/{id}'].get.operationId).toBe('renamed');
  });

  it('ignores targets that match nothing and applies actions in order', () => {
    const result = applyOverlay(
      baseDoc(),
      overlayWith([
        { target: '$.paths["/missing"].get', update: { ignored: true } },
        { target: '$.info', update: { title: 'First' } },
        { target: '$.info', update: { title: 'Second' } },
      ]),
    ) as any;

    expect(result.info.title).toBe('Second');
  });

  it('handles quoted brackets inside names and out-of-range indices', () => {
    const doc: any = { 'weird]name': { value: 1 }, list: [1] };

    const quoted = applyOverlay(doc, overlayWith([{ target: "$['weird]name']", update: { value: 2 } }])) as any;
    expect(quoted['weird]name'].value).toBe(2);

    const oob = applyOverlay(doc, overlayWith([{ target: '$.list[5]', update: 9 }])) as any;
    expect(oob.list).toEqual([1]);
  });

  it('supports bracket wildcards and wildcards over arrays', () => {
    const bracket = applyOverlay(
      baseDoc(),
      overlayWith([{ target: "$.paths[*].get", update: { 'x-b': true } }]),
    ) as any;
    expect(bracket.paths['/users'].get['x-b']).toBe(true);

    const arrayWild = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$.tags[*]', update: { seen: true } }]),
    ) as any;
    expect(arrayWild.tags[0].seen).toBe(true);
  });

  it('supports bracket-quoted filter fields', () => {
    const single = applyOverlay(
      baseDoc(),
      overlayWith([{ target: "$.paths['/users'].get.parameters[?(@['name'] == 'limit')]", update: { hit: 1 } }]),
    ) as any;
    expect(single.paths['/users'].get.parameters[0].hit).toBe(1);

    const double = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$.paths[\'/users\'].get.parameters[?(@["in"] == "header")]', update: { hit: 2 } }]),
    ) as any;
    expect(double.paths['/users'].get.parameters[1].hit).toBe(2);
  });

  it('filters skip primitive nodes and non-object members', () => {
    // primitive target node: no members, no matches, no throw
    const primitive = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$.info.title[?(@.x)]', update: { ignored: true } }]),
    ) as any;
    expect(primitive.info.title).toBe('Base API');

    // operation members include a parameters ARRAY and primitive strings —
    // both are skipped by the filter, and no member here carries .description
    const mixed = applyOverlay(
      baseDoc(),
      overlayWith([{ target: "$.paths['/users'].get[?(@.description)]", update: { hit: true } }]),
    ) as any;
    expect(JSON.stringify(mixed)).not.toContain('"hit"');

    // an object member that DOES carry the field matches
    const objectMember = applyOverlay(
      baseDoc(),
      overlayWith([{ target: "$.paths['/users'].get.responses[?(@.description)]", update: { hit: true } }]),
    ) as any;
    expect(objectMember.paths['/users'].get.responses['200'].hit).toBe(true);
  });

  it('recursively deep-merges nested update objects', () => {
    const result = applyOverlay(
      baseDoc(),
      overlayWith([
        {
          target: "$.paths['/users'].get",
          update: { responses: { '200': { description: 'Updated OK' }, '404': { description: 'Missing' } } },
        },
      ]),
    ) as any;
    const responses = result.paths['/users'].get.responses;

    expect(responses['200'].description).toBe('Updated OK');
    expect(responses['404'].description).toBe('Missing');
  });

  it('removes multiple elements of one array highest-index first', () => {
    const doc: any = {
      params: [
        { name: 'a', in: 'header' },
        { name: 'b', in: 'query' },
        { name: 'c', in: 'header' },
      ],
    };
    const result = applyOverlay(
      doc,
      overlayWith([{ target: "$.params[?(@.in == 'header')]", remove: true }]),
    ) as any;

    expect(result.params).toEqual([{ name: 'b', in: 'query' }]);
  });

  it('removes multiple object properties in one action', () => {
    const result = applyOverlay(
      baseDoc(),
      overlayWith([{ target: '$.paths.*[?(@.operationId)]', remove: true }]),
    ) as any;

    expect(result.paths['/users']).toEqual({});
    expect(result.paths['/users/{id}']).toEqual({});
  });

  describe('errors', () => {
    it.each([
      ['missing actions', { overlay: '1.0.0' } as any, /actions array/],
      ['action without target', overlayWith([{ update: 1 } as any]), /string target/],
      ['action without update or remove', overlayWith([{ target: '$.info' } as any]), /update.*remove/],
      ['path not starting with $', overlayWith([{ target: 'info', update: {} }]), /starting with '\$'/],
      ['bad dot segment', overlayWith([{ target: '$.info..', update: {} }]), /Invalid JSONPath/],
      ['dot followed by invalid name', overlayWith([{ target: '$.1bad', update: {} }]), /Invalid JSONPath segment after/],
      ['unterminated bracket', overlayWith([{ target: "$['unclosed", update: {} }]), /Unterminated/],
      ['unsupported selector', overlayWith([{ target: '$[1:3]', update: {} }]), /Unsupported JSONPath selector/],
      ['unsupported filter', overlayWith([{ target: '$.items[?(@.a > 1)]', update: {} }]), /Unsupported filter/],
      ['unsupported filter literal', overlayWith([{ target: '$.items[?(@.a == foo)]', update: {} }]), /filter literal/],
    ])('rejects %s', (_label, overlay, message) => {
      expect(() => applyOverlay(baseDoc(), overlay)).toThrow(OverlayError);
      expect(() => applyOverlay(baseDoc(), overlay)).toThrow(message);
    });

    it('rejects removing or scalar-replacing the document root', () => {
      expect(() => applyOverlay(baseDoc(), overlayWith([{ target: '$', remove: true }]))).toThrow(/document root/);
      expect(() => applyOverlay(baseDoc(), overlayWith([{ target: '$', update: 42 }]))).toThrow(/document root/);
    });
  });
});

describe('overlays LoadOption', () => {
  it('applies overlays before validation and generation, exactly once', async () => {
    const invalidDoc: any = {
      openapi: '3.0.0',
      info: { title: 'No version' }, // missing info.version -> invalid
      paths: {
        '/a': { get: { operationId: 'getA', responses: { '200': { description: 'OK' } } } },
      },
    };
    const overlay = overlayWith([
      { target: '$.info', update: { version: '9.9.9' } },
      { target: "$.paths['/a'].get", update: { description: 'Agent-tuned description.' } },
    ]);

    const generator = await OpenAPIToolGenerator.fromJSON(invalidDoc, { overlays: overlay });
    const tools = await generator.generateTools();
    expect(tools[0].description).toBe('Agent-tuned description.');

    // second generation: overlay is NOT re-applied (idempotent load)
    const again = await generator.generateTools();
    expect(again[0].description).toBe('Agent-tuned description.');
  });

  it('applies multiple overlays in order', async () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: { '/a': { get: { operationId: 'getA', responses: { '200': { description: 'OK' } } } } },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(doc, {
      overlays: [
        overlayWith([{ target: "$.paths['/a'].get", update: { summary: 'First' } }]),
        overlayWith([{ target: "$.paths['/a'].get", update: { summary: 'Second' } }]),
      ],
    });
    const tool = await generator.generateTool('/a', 'get');

    expect(tool.title).toBe('Second');
  });
});
