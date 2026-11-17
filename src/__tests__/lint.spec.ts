/**
 * Tests for the agent-readiness lint
 */

import { lintDocument } from '../lint';
import { OpenAPIToolGenerator } from '../generator';

/* eslint-disable @typescript-eslint/no-explicit-any */

const codesFor = (doc: any, path?: string): string[] =>
  lintDocument(doc)
    .findings.filter((f) => !path || f.path === path)
    .map((f) => f.code);

describe('lintDocument', () => {
  it('returns no findings for a well-described spec', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'Clean API', version: '1.0.0' },
      paths: {
        '/users': {
          get: {
            operationId: 'listUsers',
            summary: 'List users with cursor-based pagination support.',
            parameters: [
              { name: 'cursor', in: 'query', description: 'Opaque pagination cursor.', schema: { type: 'string' } },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = lintDocument(doc);

    expect(result.findings).toEqual([]);
    expect(result.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it('flags missing and duplicate operationIds', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/a': {
          get: { summary: 'A perfectly reasonable summary.', responses: { '200': { description: 'OK' } } },
        },
        '/b': {
          get: { operationId: 'dup', summary: 'A perfectly reasonable summary.', responses: { '200': { description: 'OK' } } },
          post: { operationId: 'dup', summary: 'A perfectly reasonable summary.', responses: { '200': { description: 'OK' } } },
        },
      },
    };
    const result = lintDocument(doc);

    expect(result.findings[0].code).toBe('duplicate-operation-id'); // errors sort first
    expect(result.findings[0].severity).toBe('error');
    expect(result.findings[0].message).toContain('GET /b, POST /b');
    expect(codesFor(doc, 'GET /a')).toContain('missing-operation-id');
    expect(result.counts.error).toBe(1);
  });

  it('flags missing, vague, and parameter-less descriptions', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/bare': {
          get: { operationId: 'bareOp', responses: { '200': { description: 'OK' } } },
        },
        '/vague': {
          get: { operationId: 'vagueOp', summary: 'Gets it.', responses: { '200': { description: 'OK' } } },
        },
        '/params': {
          get: {
            operationId: 'paramsOp',
            summary: 'A perfectly reasonable summary.',
            parameters: [
              { name: 'q', in: 'query', schema: { type: 'string' } },
              { name: 'sort', in: 'query', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    expect(codesFor(doc, 'GET /bare')).toContain('missing-description');
    expect(codesFor(doc, 'GET /vague')).toContain('vague-description');
    const paramFinding = lintDocument(doc).findings.find((f) => f.code === 'missing-parameter-description');
    expect(paramFinding?.message).toContain('q, sort');
  });

  it('flags unpaginated list endpoints but accepts pagination params', () => {
    const listOp = (params: any[]) => ({
      operationId: 'list',
      summary: 'A perfectly reasonable summary.',
      parameters: params,
      responses: {
        '200': {
          description: 'OK',
          content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
        },
      },
    });
    const docWith = (params: any[]): any => ({
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: { '/items': { get: listOp(params) } },
    });

    expect(codesFor(docWith([]))).toContain('unpaginated-list');
    expect(
      codesFor(docWith([{ name: 'pageSize', in: 'query', description: 'Max results.', schema: { type: 'integer' } }])),
    ).not.toContain('unpaginated-list');
    // pagination-named PATH params don't count
    expect(
      codesFor(docWith([{ name: 'limit', in: 'path', description: 'Not pagination.', schema: { type: 'string' } }])),
    ).toContain('unpaginated-list');
  });

  it('flags missing success responses, deep schemas, wide schemas, and missing examples', () => {
    const deep = (depth: number): any =>
      depth === 0 ? { type: 'string' } : { type: 'object', properties: { next: deep(depth - 1) } };
    const wideProperties = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`p${i}`, { type: 'string' }]));

    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/no-success': {
          get: { operationId: 'noSuccess', summary: 'A perfectly reasonable summary.', responses: { '404': { description: 'NF' } } },
        },
        '/deep': {
          post: {
            operationId: 'deepOp',
            summary: 'A perfectly reasonable summary.',
            requestBody: { content: { 'application/json': { schema: deep(10), example: { next: {} } } } },
            responses: { '200': { description: 'OK' } },
          },
        },
        '/wide': {
          get: {
            operationId: 'wideOp',
            summary: 'A perfectly reasonable summary.',
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'object', properties: wideProperties } } },
              },
            },
          },
        },
        '/no-example': {
          post: {
            operationId: 'noExample',
            summary: 'A perfectly reasonable summary.',
            requestBody: {
              content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } } } } },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    expect(codesFor(doc, 'GET /no-success')).toContain('missing-success-response');
    expect(codesFor(doc, 'POST /deep')).toContain('deep-schema');
    expect(codesFor(doc, 'POST /deep')).not.toContain('missing-request-example');
    expect(codesFor(doc, 'GET /wide')).toContain('wide-schema');
    expect(codesFor(doc, 'POST /no-example')).toContain('missing-request-example');
  });

  it('flags over-long operationIds', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/x': {
          get: {
            operationId: 'x'.repeat(70),
            summary: 'A perfectly reasonable summary.',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    expect(codesFor(doc)).toContain('long-operation-id');
  });

  it('survives circular dereferenced schemas', () => {
    const node: any = { type: 'object', properties: {} };
    node.properties.next = node;
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/circ': {
          get: {
            operationId: 'circOp',
            summary: 'A perfectly reasonable summary.',
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: node } } } },
          },
        },
      },
    };

    expect(() => lintDocument(doc)).not.toThrow();
  });

  it('handles $ref path items, ref parameters, ref responses, and empty documents', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/reffed': { $ref: '#/components/pathItems/X' },
        '/mixed': {
          get: {
            operationId: 'mixedOp',
            summary: 'A perfectly reasonable summary.',
            parameters: [{ $ref: '#/components/parameters/P' }],
            responses: { '200': { $ref: '#/components/responses/R' }, '201': { description: 'Created' } },
          },
        },
      },
    };

    expect(() => lintDocument(doc)).not.toThrow();
    expect(lintDocument({ openapi: '3.0.0', info: { title: 'T', version: '1' } } as any).findings).toEqual([]);
  });

  it('sorts findings by severity, then path, then code', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/z': { get: { operationId: 'dup', responses: { '200': { description: 'OK' } } } },
        '/a': { get: { operationId: 'dup', responses: { '200': { description: 'OK' } } } },
      },
    };
    const result = lintDocument(doc);

    expect(result.findings[0].severity).toBe('error');
    const warnings = result.findings.filter((f) => f.severity === 'warning');
    expect(warnings.map((f) => f.path)).toEqual(['GET /a', 'GET /z']);
  });
});

describe('review-fix regressions', () => {
  it('survives circular request-body schemas and detects real examples cycle-safely', () => {
    const node: any = { type: 'object', properties: {} };
    node.properties.child = node; // circular dereferenced schema
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/circ': {
          post: {
            operationId: 'circPost',
            summary: 'A perfectly reasonable summary.',
            requestBody: { content: { 'application/json': { schema: node } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    expect(() => lintDocument(doc)).not.toThrow();
    expect(lintDocument(doc).findings.map((f) => f.code)).toContain('missing-request-example');
  });

  it('does not mistake a property NAMED example for an example', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/named': {
          post: {
            operationId: 'namedPost',
            summary: 'A perfectly reasonable summary.',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { example: { type: 'string' } } },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    expect(lintDocument(doc).findings.map((f) => f.code)).toContain('missing-request-example');
  });

  it('finds examples under items, tuple items, and compositions', () => {
    const bodyDoc = (schema: any): any => ({
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/x': {
          post: {
            operationId: 'postX',
            summary: 'A perfectly reasonable summary.',
            requestBody: { content: { 'application/json': { schema } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });
    const hasFinding = (schema: any) =>
      lintDocument(bodyDoc(schema)).findings.some((f) => f.code === 'missing-request-example');

    expect(hasFinding({ type: 'array', items: { type: 'string', example: 'a' } })).toBe(false);
    expect(hasFinding({ type: 'array', items: [{ type: 'string', example: 'a' }] })).toBe(false);
    expect(hasFinding({ allOf: [{ type: 'object', properties: { a: { type: 'string', example: 'x' } } }] })).toBe(false);
    expect(hasFinding({ type: 'array', items: [{ type: 'string' }] })).toBe(true);
  });

  it('finds nested schema-level examples', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/nested': {
          post: {
            operationId: 'nestedPost',
            summary: 'A perfectly reasonable summary.',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string', example: 'Ada' } } },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    expect(lintDocument(doc).findings.map((f) => f.code)).not.toContain('missing-request-example');
  });

  it('accepts 2XX range codes as success responses', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/range': {
          get: {
            operationId: 'rangeGet',
            summary: 'A perfectly reasonable summary.',
            responses: {
              '2XX': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
            },
          },
        },
      },
    };

    expect(lintDocument(doc).findings.map((f) => f.code)).not.toContain('missing-success-response');
  });

  it('sees path-item-level parameters for pagination and description checks', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/items': {
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer' } }, // no description
          ],
          get: {
            operationId: 'listItems',
            summary: 'A perfectly reasonable summary.',
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
              },
            },
          },
        },
      },
    };
    const codes = lintDocument(doc).findings.map((f) => f.code);

    expect(codes).not.toContain('unpaginated-list'); // path-level 'limit' counts
    expect(codes).toContain('missing-parameter-description'); // and gets checked
  });

  it('checks the parameters that apply: an operation parameter overrides the path-level one', () => {
    const doc: any = {
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/items': {
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer' } }, // overridden: not checked
            { name: 'X-Tenant', in: 'header', schema: { type: 'string' } }, // overridden in another case
            { name: 'sort', in: 'query', schema: { type: 'string' } }, // applies
          ],
          get: {
            operationId: 'listItems',
            summary: 'A perfectly reasonable summary.',
            parameters: [
              { name: 'limit', in: 'query', description: 'Page size.', schema: { type: 'integer' } },
              { name: 'x-tenant', in: 'header', description: 'Tenant.', schema: { type: 'string' } },
              { name: 'q', in: 'query', schema: { type: 'string' } },
              { name: 'q', in: 'query', description: 'Search terms.', schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const findings = lintDocument(doc).findings.filter((f) => f.code === 'missing-parameter-description');
    expect(findings.map((f) => f.message)).toEqual(['Parameter(s) without description: sort.']);
  });
});

describe('shared dereferenced nodes', () => {
  it('measures a shared deep component at full depth from every reference site', () => {
    // dereferenceInternal reuses ONE object per component — simulate that
    const deep = (depth: number): any =>
      depth === 0 ? { type: 'string' } : { type: 'object', properties: { next: deep(depth - 1) } };
    const shared = deep(10);
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/first': {
          post: {
            operationId: 'firstPost',
            summary: 'A perfectly reasonable summary.',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { a: shared }, example: {} } } } },
            responses: { '200': { description: 'OK' } },
          },
        },
        '/second': {
          post: {
            operationId: 'secondPost',
            summary: 'A perfectly reasonable summary.',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { b: shared }, example: {} } } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const findings = lintDocument(doc).findings.filter((f) => f.code === 'deep-schema');

    // BOTH operations report the deep schema, not just the first visitor
    expect(findings.map((f) => f.path).sort()).toEqual(['POST /first', 'POST /second']);
  });
});

describe('lintDocument edge shapes', () => {
  it('handles degenerate media entries, tuple items, type arrays, and same-path ordering', () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/edge': {
          get: { operationId: 'edgeOp' }, // no prose, no responses at all
          post: {
            operationId: 'edgePost',
            summary: 'A perfectly reasonable summary.',
            requestBody: {
              content: {
                'application/json': null, // degenerate media entry
                'text/plain': {}, // media without schema or example
                'application/xml': {
                  schema: {
                    allOf: [{ type: 'object', properties: { t: { type: 'string' } } }],
                    items: [{ type: 'string' }], // tuple-style items
                  },
                },
              },
            },
            responses: {
              '200': { description: 'OK', content: { 'application/json': null, 'text/plain': {} } },
            },
          },
        },
        '/multi': {
          get: {
            operationId: 'multiWarn',
            // no prose -> missing-description; deep unpaginated array response
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: (function deep(depth: number): any {
                      return depth === 0
                        ? { type: 'array', items: { type: 'string' } }
                        : { type: 'object', properties: { next: deep(depth - 1) } };
                    })(9),
                  },
                },
              },
            },
          },
        },
        '/typed': {
          get: {
            operationId: 'typedList',
            summary: 'A perfectly reasonable summary.',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': { schema: { type: ['array', 'null'], items: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    };
    const result = lintDocument(doc);
    const codes = result.findings.map((f) => f.code);

    // nullable type ARRAYS still count as list responses
    expect(result.findings.some((f) => f.code === 'unpaginated-list' && f.path === 'GET /typed')).toBe(true);
    // degenerate media entries neither crash nor produce false examples
    expect(codes).toContain('missing-request-example');
    // two same-path warnings sort by code
    const edgeWarnings = result.findings.filter((f) => f.path === 'GET /edge' && f.severity === 'warning');
    expect(edgeWarnings.map((f) => f.code)).toEqual(['missing-description', 'missing-success-response']);
    // three same-path warnings force code comparisons in both directions
    const multiWarnings = result.findings.filter((f) => f.path === 'GET /multi' && f.severity === 'warning');
    expect(multiWarnings.map((f) => f.code)).toEqual(['deep-schema', 'missing-description', 'unpaginated-list']);
  });
});

describe('lintDocument operations in OpenAPI 3.2 places', () => {
  const listResponses = {
    '200': {
      description: 'OK',
      content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
    },
  };
  const bare = (): any => ({ responses: { '200': { description: 'OK' } } });
  const docWith = (pathItem: any, openapi: unknown = '3.2.0'): any => ({
    openapi,
    info: { title: 'T', version: '1' },
    paths: { '/items': pathItem },
  });

  it('lints the query operation and labels it QUERY', () => {
    const result = lintDocument(docWith({ query: bare() }));

    expect(result.findings.map((f) => [f.code, f.path])).toEqual([
      ['missing-description', 'QUERY /items'],
      ['missing-operation-id', 'QUERY /items'],
    ]);
  });

  it('lints additionalOperations and labels each with its method as written', () => {
    const result = lintDocument(docWith({ additionalOperations: { LINK: bare(), purge: bare() } }));

    expect(result.findings.map((f) => f.path)).toEqual([
      'LINK /items',
      'LINK /items',
      'purge /items',
      'purge /items',
    ]);
  });

  it('keeps the fixed methods first, in their order, then query, then additional operations by key', () => {
    const result = lintDocument(
      docWith({
        additionalOperations: { LINK: { ...bare(), operationId: 'same' }, BIND: { ...bare(), operationId: 'same' } },
        query: { ...bare(), operationId: 'same' },
        delete: { ...bare(), operationId: 'same' },
        get: { ...bare(), operationId: 'same' },
      }),
    );
    const duplicate = result.findings.find((f) => f.code === 'duplicate-operation-id')!;
    const labels = duplicate.message.replace(/^.*operations: /, '').replace(/\.$/, '').split(', ');

    expect(labels).toEqual(['GET /items', 'DELETE /items', 'QUERY /items', 'BIND /items', 'LINK /items']);
    expect(duplicate.path).toBe('GET /items');
  });

  it.each([
    ['query', { query: { operationId: 'search', summary: 'Search items by body.', responses: listResponses } }],
    ['get', { get: { operationId: 'search', summary: 'Search items by body.', responses: listResponses } }],
  ])('flags an unpaginated list on %s with the method in the message', (method, pathItem) => {
    const findings = lintDocument(docWith(pathItem)).findings.filter((f) => f.code === 'unpaginated-list');

    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe(`${method.toUpperCase()} /items`);
    expect(findings[0].message.startsWith(`${method.toUpperCase()} returns an array`)).toBe(true);
  });

  it('accepts a pagination parameter on query', () => {
    const query = {
      operationId: 'search',
      summary: 'Search items by body.',
      parameters: [{ name: 'limit', in: 'query', description: 'Max results.', schema: { type: 'integer' } }],
      responses: listResponses,
    };

    expect(lintDocument(docWith({ query })).findings.map((f) => f.code)).not.toContain('unpaginated-list');
  });

  it('does not apply the pagination rule to an additional operation', () => {
    const link = { operationId: 'link', summary: 'Link two items.', responses: listResponses };

    expect(lintDocument(docWith({ additionalOperations: { LINK: link } })).findings.map((f) => f.code)).not.toContain(
      'unpaginated-list',
    );
  });

  it('ignores hostile additionalOperations keys and values without throwing', () => {
    const additionalOperations = JSON.parse(
      '{"constructor": {"operationId": "ctor"}, "__proto__": {"operationId": "proto"}, "CONNECT": {}, "bad method": {}, "": {}, "line\\r\\nbreak": {}, "GET": {}, "text": "not an operation"}',
    );
    const result = lintDocument(docWith({ additionalOperations }));

    // only the two token-valid keys that name no fixed field and are not CONNECT are operations
    expect(result.findings.filter((f) => f.code === 'missing-description').map((f) => f.path)).toEqual([
      '__proto__ /items',
      'constructor /items',
    ]);
    expect(result.findings.some((f) => f.path.startsWith('GET'))).toBe(false);
  });

  it('does not read operations off the prototype of a path item', () => {
    const pathItem = Object.create({ get: bare(), additionalOperations: { LINK: bare() } });

    expect(lintDocument(docWith(pathItem)).findings).toEqual([]);
  });

  it('ignores a path item that is not an object', () => {
    expect(lintDocument(docWith([bare()])).findings).toEqual([]);
  });
});

describe('lintDocument operations follow the declared version', () => {
  const bare = (): any => ({ responses: { '200': { description: 'OK' } } });
  const pathItem = (): any => ({ get: bare(), query: bare(), additionalOperations: { LINK: bare() } });
  const labelsFor = (openapi: unknown): string[] => {
    const doc: any = { openapi, info: { title: 'T', version: '1' }, paths: { '/items': pathItem() } };
    // findings are sorted by path
    return [...new Set(lintDocument(doc).findings.map((f) => f.path))];
  };

  it.each(['3.2.0', '3.2.1', '3.2.0-rc1', '3.3.0', '3.12.4'])(
    'lints query and additionalOperations in a document declaring %s',
    (openapi) => {
      expect(labelsFor(openapi)).toEqual(['GET /items', 'LINK /items', 'QUERY /items']);
    },
  );

  it.each(['3.0.0', '3.0.3', '3.1.0', '3.1.1'])(
    'ignores query and additionalOperations in a document declaring %s',
    (openapi) => {
      expect(labelsFor(openapi)).toEqual(['GET /items']);
    },
  );

  it.each([
    ['no version', undefined],
    ['a malformed version', 'banana'],
    ['a version that is not a string', 3.2],
    ['a version with no patch', '3.2'],
    ['another major version', '4.0.0'],
  ])('reads only the eight historical methods when the document has %s', (_label, openapi) => {
    expect(labelsFor(openapi)).toEqual(['GET /items']);
  });

  it('reads only the eight historical methods for a Swagger 2.0 document', () => {
    const doc: any = { swagger: '2.0', info: { title: 'T', version: '1' }, paths: { '/items': pathItem() } };

    expect([...new Set(lintDocument(doc).findings.map((f) => f.path))]).toEqual(['GET /items']);
  });

  it('applies the same rule through generator.lint()', async () => {
    const lint = async (openapi: string) =>
      [
        ...new Set(
          (
            await (
              await OpenAPIToolGenerator.fromJSON(
                { openapi, info: { title: 'T', version: '1' }, paths: { '/items': pathItem() } } as any,
                { validate: false },
              )
            ).lint()
          ).findings.map((f) => f.path),
        ),
      ];

    expect(await lint('3.1.0')).toEqual(['GET /items']);
    expect(await lint('3.2.0')).toEqual(['GET /items', 'LINK /items', 'QUERY /items']);
  });
});

describe('lintDocument on malformed input', () => {
  const clean = (): any => ({
    operationId: 'listThings',
    summary: 'A perfectly reasonable summary.',
    responses: { '200': { description: 'OK' } },
  });
  const docWith = (paths: unknown): any => ({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths });
  const codes = (doc: any): string[] => lintDocument(doc).findings.map((f) => f.code);

  it.each([
    ['a string', 'abc'],
    ['a number', 5],
    ['a boolean', true],
    ['null', null],
    ['an array', [{ '/x': { get: clean() } }]],
  ])('skips paths that is %s', (_label, paths) => {
    expect(lintDocument(docWith(paths))).toEqual({ findings: [], counts: { error: 0, warning: 0, info: 0 } });
  });

  it.each([
    ['null', null],
    ['a string', 'abc'],
    ['an array', [clean()]],
    ['undefined', undefined],
  ])('skips a document that is %s', (_label, document) => {
    expect(lintDocument(document as any).findings).toEqual([]);
  });

  it.each([
    ['a string', 'abc'],
    ['a number', 5],
    ['a boolean', false],
    ['null', null],
    ['an array', [clean()]],
  ])('skips a path item that is %s and still lints the other paths', (_label, pathItem) => {
    const doc = docWith({ '/bad': pathItem, '/good': { get: { responses: {} } } });

    expect(lintDocument(doc).findings.map((f) => f.path)).not.toContain('GET /bad');
    expect(codes(doc)).toContain('missing-operation-id');
  });

  it.each([
    ['an object', {}],
    ['a string', 'abc'],
    ['a number', 5],
    ['null', null],
  ])('ignores path-level parameters that are %s', (_label, parameters) => {
    expect(codes(docWith({ '/x': { parameters, get: clean() } }))).toEqual([]);
  });

  it.each([
    ['an object', {}],
    ['a string', 'abc'],
    ['a number', 5],
    ['null', null],
  ])('ignores operation-level parameters that are %s', (_label, parameters) => {
    expect(codes(docWith({ '/x': { get: { ...clean(), parameters } } }))).toEqual([]);
  });

  it.each([[null], [5], ['abc'], [[]], [true]])('skips the parameter entry %j', (entry) => {
    const described = { name: 'id', in: 'path', description: 'The id.', schema: { type: 'string' } };
    const doc = docWith({
      '/x': { parameters: [entry, described], get: { ...clean(), parameters: [entry, described] } },
    });

    expect(codes(doc)).toEqual([]);
  });

  it('still reports the undescribed parameters next to skipped entries', () => {
    const doc = docWith({
      '/x': { parameters: [null, { name: 'a', in: 'query' }], get: { ...clean(), parameters: [5, { name: 'b', in: 'query' }] } },
    });

    expect(lintDocument(doc).findings.map((f) => f.message)).toEqual(['Parameter(s) without description: a, b.']);
  });

  it.each([[5], [{ length: 100 }], [['x'.repeat(70)]], [true]])(
    'treats the operationId %j, which is not a string, as missing',
    (operationId) => {
      const doc = docWith({ '/x': { get: { ...clean(), operationId } } });

      expect(codes(doc)).toEqual(['missing-operation-id']);
    },
  );

  it('lints the same shapes through generator.lint()', async () => {
    const doc = docWith({
      '/string': 'abc',
      '/null': null,
      '/params': {
        parameters: {},
        get: { ...clean(), parameters: [null, { name: 'q', in: 'query' }] },
      },
    });
    const result = await (await OpenAPIToolGenerator.fromJSON(doc, { validate: false })).lint();

    expect(result.findings.map((f) => [f.code, f.path])).toEqual([['missing-parameter-description', 'GET /params']]);
  });

  it('lints a document whose paths is not an object through generator.lint()', async () => {
    const result = await (await OpenAPIToolGenerator.fromJSON(docWith('abc'), { validate: false })).lint();

    expect(result.findings).toEqual([]);
  });
});

describe('generator.lint()', () => {
  it('lints the overlay-patched document', async () => {
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/a': { get: { operationId: 'getA', responses: { '200': { description: 'OK' } } } },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(doc, {
      overlays: {
        overlay: '1.0.0',
        actions: [
          { target: "$.paths['/a'].get", update: { summary: 'A perfectly reasonable overlay-added summary.' } },
        ],
      },
    });
    const result = await generator.lint();

    // the missing-description finding is fixed by the overlay before linting
    expect(result.findings.map((f) => f.code)).not.toContain('missing-description');
    expect(result.findings).toEqual([]);
  });
});

describe('lintDocument on deeply nested schemas (issue #50)', () => {
  it('measures a schema 20000 levels deep and finds an example at its bottom', () => {
    let schema: any = { type: 'string', example: 'x' };
    for (let i = 0; i < 20000; i++) schema = { type: 'object', properties: { next: schema } };
    const doc: any = {
      openapi: '3.0.0',
      info: { title: 'T', version: '1' },
      paths: {
        '/deep': {
          post: {
            operationId: 'postDeep',
            summary: 'A perfectly reasonable summary.',
            requestBody: { content: { 'application/json': { schema } } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const findings = lintDocument(doc).findings;

    expect(findings.find((f) => f.code === 'deep-schema')?.message).toContain('depth 20001');
    expect(findings.map((f) => f.code)).not.toContain('missing-request-example');
  });
});

describe('lintDocument on a Swagger 2.0 document', () => {
  it('lints its OpenAPI 3.0 conversion, as generator.lint() does', async () => {
    const swagger: any = {
      swagger: '2.0',
      info: { title: 'Pets', version: '1' },
      host: 'api.example.com',
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            summary: 'List every pet of the store',
            responses: { 200: { description: 'ok', schema: { type: 'array', items: { type: 'string' } } } },
          },
          post: {
            operationId: 'createPet',
            summary: 'Create a pet in the store',
            parameters: [{ name: 'pet', in: 'body', schema: { type: 'object', properties: { name: { type: 'string' } } } }],
            responses: { 201: { description: 'created' } },
          },
        },
      },
    };
    const codes = lintDocument(swagger).findings.map((f) => [f.code, f.path]);
    // The response schema and the request body are read from their 3.0 places
    expect(codes).toEqual([
      ['unpaginated-list', 'GET /pets'],
      ['missing-request-example', 'POST /pets'],
    ]);
    const generator = await OpenAPIToolGenerator.fromJSON(swagger);
    expect(await generator.lint()).toEqual(lintDocument(swagger));
  });

  it('is one error, not a clean result, when the conversion is abandoned at MAX_CONVERSION_ENTRIES', async () => {
    // 100 operations, each with its own 32-type produces list, x 330 shared responses: 1,056,000 content entries
    const types = Array.from({ length: 32 }, (_, i) => `application/vnd.t${i}+json`);
    const responses = Object.fromEntries(
      Array.from({ length: 330 }, (_, i) => [String(200 + i), { description: 'r', schema: { type: 'string' } }]),
    );
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) paths[`/p${i}`] = { get: { produces: [...types], responses } };
    const swagger: any = { swagger: '2.0', info: { title: 'T', version: '1' }, host: 'api.example.com', paths };

    const result = lintDocument(swagger);
    expect(result.counts).toEqual({ error: 1, warning: 0, info: 0 });
    expect(result.findings).toEqual([
      {
        severity: 'error',
        code: 'swagger-conversion-too-large',
        message:
          'The Swagger 2.0 document cannot be converted to OpenAPI 3.0: it needs more than 1000000 media type, ' +
          'encoding, header and form property entries (MAX_CONVERSION_ENTRIES), as its `consumes`, `produces` and ' +
          'path-level parameters apply to every operation. No operation was linted, and no tool can be generated from it.',
        path: '',
        hint: 'Shorten the root `consumes`/`produces` lists (or give the operations their own), or convert the document to OpenAPI 3 first.',
      },
    ]);
    // generator.lint() refuses the same document with the ParseError generation throws
    const generator = await OpenAPIToolGenerator.fromJSON(swagger, { validate: false });
    await expect(generator.lint()).rejects.toMatchObject({ context: { code: 'SWAGGER_CONVERSION_TOO_LARGE' } });
  });
});
