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
