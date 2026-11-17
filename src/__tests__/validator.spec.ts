/**
 * Tests for Validator class
 */

import { Validator } from '../validator';
import { LEGACY_PATH_KEY_MAX_LENGTH, MAX_DIAGNOSTICS } from '../types';
import type { OpenAPIDocument } from '../types';

describe('Validator', () => {
  let validator: Validator;

  beforeEach(() => {
    validator = new Validator();
  });

  describe('validate', () => {
    describe('OpenAPI Version', () => {
      it('should fail when openapi field is missing', async () => {
        const doc = {
          info: { title: 'Test', version: '1.0.0' },
          paths: {},
        } as any;

        const result = await validator.validate(doc);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'MISSING_OPENAPI_VERSION',
          }),
        );
      });

      it('should fail for unsupported OpenAPI version', async () => {
        const doc = {
          openapi: '2.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {},
        } as any;

        const result = await validator.validate(doc);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'INVALID_OPENAPI_VERSION',
          }),
        );
      });

      it('should pass for valid OpenAPI 3.0.x versions', async () => {
        const versions = ['3.0.0', '3.0.1', '3.0.2', '3.0.3'];

        for (const version of versions) {
          const doc: OpenAPIDocument = {
            openapi: version as any,
            info: { title: 'Test', version: '1.0.0' },
            paths: {
              '/test': {
                get: {
                  operationId: 'test',
                  responses: { '200': { description: 'OK' } },
                },
              },
            },
          };

          const result = await validator.validate(doc);
          expect(result.errors?.some((e) => e.code === 'INVALID_OPENAPI_VERSION')).toBeFalsy();
        }
      });

      it('should pass for valid OpenAPI 3.1.x versions', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.1.0' as any,
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        };

        const result = await validator.validate(doc);
        expect(result.errors?.some((e) => e.code === 'INVALID_OPENAPI_VERSION')).toBeFalsy();
      });
    });

    describe('Info Object', () => {
      it('should fail when info is missing', async () => {
        const doc = {
          openapi: '3.0.0',
          paths: {},
        } as any;

        const result = await validator.validate(doc);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'MISSING_INFO',
          }),
        );
      });

      it('should fail when info.title is missing', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { version: '1.0.0' },
          paths: {},
        } as any;

        const result = await validator.validate(doc);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'MISSING_TITLE',
          }),
        );
      });

      it('should fail when info.version is missing', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test' },
          paths: {},
        } as any;

        const result = await validator.validate(doc);

        expect(result.valid).toBe(false);
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'MISSING_VERSION',
          }),
        );
      });
    });

    describe('Paths', () => {
      it('should warn when no paths are defined', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {},
        };

        const result = await validator.validate(doc);

        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            code: 'NO_PATHS',
          }),
        );
      });

      it('should error when path does not start with /', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            'invalid-path': {
              get: {
                operationId: 'test',
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        } as any;

        const result = await validator.validate(doc);

        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'INVALID_PATH_FORMAT',
          }),
        );
      });

      it('should warn when path has no operations', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/empty': {},
          },
        };

        const result = await validator.validate(doc);

        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            code: 'NO_OPERATIONS',
          }),
        );
      });

      it('should not warn for path with $ref', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/ref': { $ref: '#/components/pathItems/test' },
          },
        } as any;

        const result = await validator.validate(doc);

        expect(result.warnings?.some((w) => w.code === 'NO_OPERATIONS')).toBeFalsy();
      });

      it('should skip null/undefined path items', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/valid': {
              get: {
                operationId: 'test',
                responses: { '200': { description: 'OK' } },
              },
            },
            '/null': null,
          },
        } as any;

        const result = await validator.validate(doc);

        // Should not throw and should process the valid path
        expect(result.valid).toBe(true);
      });
    });

    describe('Operations', () => {
      it('should warn when operationId is missing', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        };

        const result = await validator.validate(doc);

        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            code: 'NO_OPERATION_ID',
          }),
        );
      });

      it('should error when responses are missing', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
              },
            },
          },
        } as any;

        const result = await validator.validate(doc);

        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'NO_RESPONSES',
          }),
        );
      });

      it('should error when responses is empty', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                responses: {},
              },
            },
          },
        } as any;

        const result = await validator.validate(doc);

        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'NO_RESPONSES',
          }),
        );
      });

      it('should validate all HTTP methods', async () => {
        const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
        const paths: any = {};

        for (const method of methods) {
          paths[`/${method}`] = {
            [method]: {
              operationId: `${method}Test`,
              responses: { '200': { description: 'OK' } },
            },
          };
        }

        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths,
        };

        const result = await validator.validate(doc);

        expect(result.valid).toBe(true);
      });

      it('should error when path parameter is not defined', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/users/{id}': {
              get: {
                operationId: 'getUser',
                responses: { '200': { description: 'OK' } },
                // Missing parameter definition for 'id'
              },
            },
          },
        };

        const result = await validator.validate(doc);

        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'MISSING_PATH_PARAMETER',
          }),
        );
      });

      it('should pass when all path parameters are defined', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/users/{id}/posts/{postId}': {
              get: {
                operationId: 'getUserPost',
                parameters: [
                  { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                  { name: 'postId', in: 'path', required: true, schema: { type: 'string' } },
                ],
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        };

        const result = await validator.validate(doc);

        expect(result.errors?.some((e) => e.code === 'MISSING_PATH_PARAMETER')).toBeFalsy();
      });
    });

    describe('Parameters', () => {
      it('should error when parameter name is missing', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                parameters: [{ in: 'query', schema: { type: 'string' } }],
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        } as any;

        const result = await validator.validate(doc);

        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'MISSING_PARAMETER_NAME',
          }),
        );
      });

      it('should error when parameter "in" is missing', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                parameters: [{ name: 'id', schema: { type: 'string' } }],
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        } as any;

        const result = await validator.validate(doc);

        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'MISSING_PARAMETER_IN',
          }),
        );
      });

      it('should error when parameter "in" is invalid', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                parameters: [{ name: 'id', in: 'body', schema: { type: 'string' } }],
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        } as any;

        const result = await validator.validate(doc);

        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'INVALID_PARAMETER_IN',
          }),
        );
      });

      it('should error when path parameter is not required', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/users/{id}': {
              get: {
                operationId: 'getUser',
                parameters: [{ name: 'id', in: 'path', required: false, schema: { type: 'string' } }],
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        };

        const result = await validator.validate(doc);

        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'PATH_PARAMETER_NOT_REQUIRED',
          }),
        );
      });

      it('should error when parameter schema and content are missing', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                parameters: [{ name: 'id', in: 'query' }],
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        } as any;

        const result = await validator.validate(doc);

        expect(result.errors).toContainEqual(
          expect.objectContaining({
            code: 'MISSING_PARAMETER_SCHEMA',
          }),
        );
      });

      it('should pass when parameter has content instead of schema', async () => {
        const doc = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                parameters: [
                  {
                    name: 'filter',
                    in: 'query',
                    content: {
                      'application/json': { schema: { type: 'object' } },
                    },
                  },
                ],
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        } as any;

        const result = await validator.validate(doc);

        expect(result.errors?.some((e) => e.code === 'MISSING_PARAMETER_SCHEMA')).toBeFalsy();
      });
    });

    describe('Servers', () => {
      it('should warn when no servers are defined', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        };

        const result = await validator.validate(doc);

        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            code: 'NO_SERVERS',
          }),
        );
      });

      it('should not warn when servers are defined', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          servers: [{ url: 'https://api.example.com' }],
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        };

        const result = await validator.validate(doc);

        expect(result.warnings?.some((w) => w.code === 'NO_SERVERS')).toBeFalsy();
      });
    });

    describe('Security', () => {
      it('should warn when security is defined but no schemes exist', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          security: [{ apiKey: [] }],
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        };

        const result = await validator.validate(doc);

        expect(result.warnings).toContainEqual(
          expect.objectContaining({
            code: 'NO_SECURITY_SCHEMES',
          }),
        );
      });

      it('should not warn when security schemes are defined', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.0',
          info: { title: 'Test', version: '1.0.0' },
          security: [{ apiKey: [] }],
          components: {
            securitySchemes: {
              apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
            },
          },
          paths: {
            '/test': {
              get: {
                operationId: 'test',
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        };

        const result = await validator.validate(doc);

        expect(result.warnings?.some((w) => w.code === 'NO_SECURITY_SCHEMES')).toBeFalsy();
      });
    });

    describe('Valid Document', () => {
      it('should pass for a complete valid document', async () => {
        const doc: OpenAPIDocument = {
          openapi: '3.0.3',
          info: { title: 'Test API', version: '1.0.0', description: 'Test Description' },
          servers: [{ url: 'https://api.example.com', description: 'Production' }],
          paths: {
            '/users/{id}': {
              get: {
                operationId: 'getUser',
                summary: 'Get user by ID',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                responses: {
                  '200': {
                    description: 'Success',
                    content: {
                      'application/json': {
                        schema: { type: 'object', properties: { id: { type: 'string' } } },
                      },
                    },
                  },
                },
              },
            },
          },
        };

        const result = await validator.validate(doc);

        expect(result.valid).toBe(true);
        expect(result.errors).toBeUndefined();
      });
    });
  });
});

describe('path-item-level parameters', () => {
  const { Validator } = require('../validator');

  it('counts path-level parameters toward path template coverage', async () => {
    const validator = new Validator();
    const result = await validator.validate({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0.0' },
      paths: {
        '/channels/{channel_id}': {
          parameters: [{ name: 'channel_id', in: 'path', required: true, schema: { type: 'string' } }],
          get: { operationId: 'getChannel', responses: { '200': { description: 'OK' } } },
        },
      },
    } as any);
    expect(result.valid).toBe(true);
    expect((result.errors ?? []).filter((e: any) => e.code === 'MISSING_PATH_PARAMETER')).toEqual([]);
  });

  it('validates path-level parameters with the path-item location', async () => {
    const validator = new Validator();
    const result = await validator.validate({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0.0' },
      paths: {
        '/things/{id}': {
          parameters: [
            { name: 'id', in: 'path', required: false, schema: { type: 'string' } },
            { name: 'filter', in: 'query' },
          ],
          get: { operationId: 'getThing', responses: { '200': { description: 'OK' } } },
        },
      },
    } as any);

    // a non-required path-level path parameter satisfies coverage but is flagged
    expect(result.errors ?? []).toContainEqual(
      expect.objectContaining({ code: 'PATH_PARAMETER_NOT_REQUIRED', path: '/paths//things/{id}/parameters/0/required' }),
    );
    expect((result.errors ?? []).some((e: any) => e.code === 'MISSING_PATH_PARAMETER')).toBe(false);
    // a path-level parameter without schema/content is flagged at the path-item location
    expect(result.errors ?? []).toContainEqual(
      expect.objectContaining({ code: 'MISSING_PARAMETER_SCHEMA', path: '/paths//things/{id}/parameters/1' }),
    );
  });

  it('still flags genuinely undeclared path parameters', async () => {
    const validator = new Validator();
    const result = await validator.validate({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0.0' },
      paths: {
        '/things/{id}': {
          parameters: [{ name: 'other', in: 'query', schema: { type: 'string' } }],
          get: { operationId: 'getThing', responses: { '200': { description: 'OK' } } },
        },
      },
    } as any);
    expect(result.errors.some((e: any) => e.code === 'MISSING_PATH_PARAMETER')).toBe(true);
  });
});

describe('reference-object parameters', () => {
  const { Validator: V } = require('../validator');

  it('accepts valid path-level parameter references without false positives', async () => {
    const result = await new V().validate({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0.0' },
      components: { parameters: { Id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } } } },
      paths: {
        '/things/{id}': {
          parameters: [{ $ref: '#/components/parameters/Id' }],
          get: { operationId: 'getThing', responses: { '200': { description: 'OK' } } },
        },
      },
    } as any);
    expect(result.valid).toBe(true);
    expect(result.errors ?? []).toEqual([]);
  });

  it('accepts operation-level parameter references the same way', async () => {
    const result = await new V().validate({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0.0' },
      components: { parameters: { Id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } } } },
      paths: {
        '/things/{id}': {
          get: {
            operationId: 'getThing',
            parameters: [{ $ref: '#/components/parameters/Id' }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    } as any);
    expect(result.errors ?? []).toEqual([]);
  });

  it('does not let a resolvable query-param reference mask a missing path variable', async () => {
    const result = await new V().validate({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0.0' },
      components: { parameters: { Filter: { name: 'filter', in: 'query', schema: { type: 'string' } } } },
      paths: {
        '/things/{id}': {
          get: {
            operationId: 'getThing',
            parameters: [{ $ref: '#/components/parameters/Filter' }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    } as any);
    expect((result.errors ?? []).some((e: any) => e.code === 'MISSING_PATH_PARAMETER')).toBe(true);
  });

  it('defers coverage only for unresolvable references', async () => {
    for (const ref of ['./external.yaml#/components/parameters/Id', '#/components/parameters/Ghost']) {
      const result = await new V().validate({
        openapi: '3.0.0',
        info: { title: 'T', version: '1.0.0' },
        paths: {
          '/things/{id}': {
            get: { operationId: 'getThing', parameters: [{ $ref: ref }], responses: { '200': { description: 'OK' } } },
          },
        },
      } as any);
      expect((result.errors ?? []).some((e: any) => e.code === 'MISSING_PATH_PARAMETER')).toBe(false);
    }
  });

  it('resolves pointer-escaped component parameter names', async () => {
    const result = await new V().validate({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0.0' },
      components: { parameters: { 'a/b': { name: 'id', in: 'path', required: true, schema: { type: 'string' } } } },
      paths: {
        '/things/{id}': {
          get: {
            operationId: 'getThing',
            parameters: [{ $ref: '#/components/parameters/a~1b' }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    } as any);
    expect((result.errors ?? []).some((e: any) => e.code === 'MISSING_PATH_PARAMETER')).toBe(false);
  });

  it('still flags missing path parameters when no references are involved', async () => {
    const result = await new V().validate({
      openapi: '3.0.0',
      info: { title: 'T', version: '1.0.0' },
      paths: {
        '/things/{id}': {
          get: { operationId: 'getThing', responses: { '200': { description: 'OK' } } },
        },
      },
    } as any);
    expect((result.errors ?? []).some((e: any) => e.code === 'MISSING_PATH_PARAMETER')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Version-aware validation (issue #55)
// ---------------------------------------------------------------------------

describe('version-aware validation (issue #55)', () => {
  const ok = { '200': { description: 'OK' } };
  const doc = (openapi: unknown, paths: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): any => ({
    openapi,
    info: { title: 'T', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    paths,
    ...extra,
  });
  const validate = (document: object) => new Validator().validate(document);
  const errorCodes = async (document: object): Promise<string[]> =>
    ((await validate(document)).errors ?? []).map((e) => e.code!);
  const warningCodes = async (document: object): Promise<string[]> =>
    ((await validate(document)).warnings ?? []).map((w) => w.code!);
  const VALID = { valid: true, errors: undefined, warnings: undefined };

  describe('declared version', () => {
    it.each(['3.0.0', '3.0.4', '3.1.0', '3.1.2', '3.2.0', '3.2.1-rc1'])('accepts %s', async (version) => {
      expect(await validate(doc(version, { '/a': { get: { operationId: 'a', responses: ok } } }))).toEqual(VALID);
    });

    it('accepts a newer 3.x minor version with a warning', async () => {
      const result = await validate(doc('3.3.0', { '/a': { get: { operationId: 'a', responses: ok } } }));
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'NEWER_OPENAPI_VERSION',
          path: '/openapi',
          message: expect.stringContaining('it is processed with the OpenAPI 3.2 rules'),
        },
      ]);
    });

    it('applies the latest rules to a newer minor version (responses optional, querystring allowed)', async () => {
      const result = await validate(
        doc('3.7.0', {
          '/a': {
            get: {
              operationId: 'a',
              parameters: [{ name: 'q', in: 'querystring', content: { 'application/json': { schema: {} } } }],
            },
          },
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.warnings?.map((w) => w.code)).toEqual(['NEWER_OPENAPI_VERSION']);
    });

    it.each([
      ['another major', doc('4.0.0'), '/openapi', 'Unsupported version: OpenAPI "4.0.0". Expected OpenAPI 3.0.x, 3.1.x or 3.2.x'],
      ['an old major', doc('2.0.0'), '/openapi', 'Unsupported version: OpenAPI "2.0.0".'],
      ['a version without a patch', doc('3.1'), '/openapi', 'Malformed version: `openapi` must be a version string'],
      ['a number', doc(3.1), '/openapi', 'found 3.1.'],
      ['Swagger 2.0', { swagger: '2.0', info: { title: 'T', version: '1' }, paths: {} }, '/swagger', 'Swagger 2.0 documents are not supported'],
      ['Swagger 1.2', { swagger: '1.2', info: { title: 'T', version: '1' }, paths: {} }, '/swagger', 'Unsupported version: Swagger "1.2".'],
    ])('rejects %s with INVALID_OPENAPI_VERSION', async (_label, document, path, message) => {
      const result = await validate(document);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({ code: 'INVALID_OPENAPI_VERSION', path, message: expect.stringContaining(message) });
    });

    it('rejects a missing version with MISSING_OPENAPI_VERSION and a message naming the supported versions', async () => {
      const result = await validate({ info: { title: 'T', version: '1' }, paths: {} });
      expect(result.errors).toContainEqual({
        code: 'MISSING_OPENAPI_VERSION',
        path: '/openapi',
        message: expect.stringContaining('Missing version: the document has no `openapi` field. Expected OpenAPI 3.0.x'),
      });
    });

    it('warns about conflicting version fields', async () => {
      expect(await warningCodes(doc('3.1.0', {}, { swagger: '2.0' }))).toContain('CONFLICTING_VERSION_FIELDS');
    });
  });

  describe('responses', () => {
    const withoutResponses = (version: string) => doc(version, { '/a': { get: { operationId: 'a' } } });

    it('requires responses in 3.0 only', async () => {
      expect(await errorCodes(withoutResponses('3.0.3'))).toEqual(['NO_RESPONSES']);
      expect(await errorCodes(withoutResponses('3.1.0'))).toEqual([]);
      expect(await errorCodes(withoutResponses('3.2.0'))).toEqual([]);
    });

    it('rejects present but empty responses in every version', async () => {
      for (const version of ['3.0.3', '3.1.0', '3.2.0']) {
        for (const responses of [{}, null]) {
          const result = await validate(doc(version, { '/a': { get: { operationId: 'a', responses } } }));
          expect(result.errors).toEqual([
            { code: 'NO_RESPONSES', path: '/paths//a/get/responses', message: 'Operation missing responses: GET /a' },
          ]);
        }
      }
    });
  });

  describe('operations follow the declared version', () => {
    it('validates query and additionalOperations like any operation from 3.2 on', async () => {
      const result = await validate(
        doc('3.2.0', {
          '/a/{id}': {
            query: {},
            additionalOperations: { LINK: { parameters: [{ name: 'x', in: 'query' }] } },
          },
        }),
      );
      expect(result.errors).toEqual([
        {
          code: 'MISSING_PATH_PARAMETER',
          path: '/paths//a/{id}/query/parameters',
          message: "Path parameter 'id' not defined in parameters: QUERY /a/{id}",
        },
        {
          code: 'MISSING_PARAMETER_SCHEMA',
          path: '/paths//a/{id}/additionalOperations/LINK/parameters/0',
          message: "Parameter 'x' missing schema or content",
        },
        {
          code: 'MISSING_PATH_PARAMETER',
          path: '/paths//a/{id}/additionalOperations/LINK/parameters',
          message: "Path parameter 'id' not defined in parameters: LINK /a/{id}",
        },
      ]);
      expect(result.warnings?.map((w) => [w.code, w.path])).toEqual([
        ['NO_OPERATION_ID', '/paths//a/{id}/query/operationId'],
        ['NO_OPERATION_ID', '/paths//a/{id}/additionalOperations/LINK/operationId'],
      ]);
    });

    it.each(['3.0.3', '3.1.0'])('does not read them in a document declaring %s, and says so', async (version) => {
      const result = await validate(
        doc(version, {
          '/a': { get: { operationId: 'g', responses: ok }, query: 'junk', additionalOperations: { GET: 5, 'a b': {} } },
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'FEATURE_NEWER_THAN_DECLARED_VERSION',
          path: '/paths/~1a/query',
          message: `The \`query\` operation needs OpenAPI 3.2 or later, but the document declares OpenAPI "${version}", so it is ignored (no tool); declare OpenAPI 3.2 or later to read it`,
        },
        {
          code: 'FEATURE_NEWER_THAN_DECLARED_VERSION',
          path: '/paths/~1a/additionalOperations',
          message: `Path Item \`additionalOperations\` needs OpenAPI 3.2 or later, but the document declares OpenAPI "${version}", so it is ignored (no tool); declare OpenAPI 3.2 or later to read it`,
        },
      ]);
    });

    it('accepts a 3.1 document whose additionalOperations is not even an object', async () => {
      expect(
        await errorCodes(doc('3.1.0', { '/a': { get: { operationId: 'g', responses: ok }, additionalOperations: 'junk' } })),
      ).toEqual([]);
    });

    it('reads what the library always read when the version cannot be processed', async () => {
      const result = await validate(
        doc('4.0.0', { '/a': { get: { operationId: 'g', responses: ok }, additionalOperations: { GET: {} } } }),
      );
      expect(result.errors?.map((e) => e.code)).toEqual(['INVALID_OPENAPI_VERSION']);
      expect(result.warnings).toBeUndefined();
    });

    it('counts query and additional operations for NO_OPERATIONS from 3.2 on, but not ignored ones', async () => {
      expect(await warningCodes(doc('3.2.0', { '/a': { query: { operationId: 'a' } } }))).toEqual([]);
      expect(await warningCodes(doc('3.2.0', { '/a': { additionalOperations: { LINK: { operationId: 'a' } } } }))).toEqual([]);
      expect(await warningCodes(doc('3.2.0', { '/a': { additionalOperations: { CONNECT: { operationId: 'a' } } } }))).toEqual([
        'REFUSED_METHOD',
        'NO_OPERATIONS',
      ]);
      expect(await warningCodes(doc('3.1.0', { '/a': { query: { operationId: 'a' } } }))).toEqual([
        'FEATURE_NEWER_THAN_DECLARED_VERSION',
        'NO_OPERATIONS',
      ]);
    });

    it('rejects what breaks the specification, and warns about what the library declines', async () => {
      const result = await validate(
        doc('3.2.0', {
          '/a': {
            get: null,
            post: 'x',
            additionalOperations: { GET: { operationId: 'g' }, 'in valid': {}, LINK: 'nope', Get: {}, CONNECT: {} },
          },
          '/b': { additionalOperations: [] },
          '/c': null,
          d: 'not a path item',
        }),
      );
      // the walker's "; the operation is ignored" is dropped from errors: the document is rejected
      expect(result.errors).toEqual([
        { code: 'OPERATION_NOT_OBJECT', path: '/paths/~1a/post', message: 'The `post` field must hold an Operation Object, found "x"' },
        {
          code: 'DUPLICATE_FIXED_METHOD',
          path: '/paths/~1a/additionalOperations/GET',
          message: 'additionalOperations key "GET" is the method of the fixed `get` field, which the specification forbids',
        },
        {
          code: 'INVALID_METHOD_TOKEN',
          path: '/paths/~1a/additionalOperations/in valid',
          message: 'additionalOperations key "in valid" is not an HTTP method (RFC 9110 token)',
        },
        {
          code: 'OPERATION_NOT_OBJECT',
          path: '/paths/~1a/additionalOperations/LINK',
          message: 'additionalOperations key "LINK" must hold an Operation Object, found "nope"',
        },
        {
          code: 'ADDITIONAL_OPERATIONS_NOT_OBJECT',
          path: '/paths/~1b/additionalOperations',
          message: 'additionalOperations must be an object mapping methods to operations, found an array',
        },
        { code: 'INVALID_PATH_FORMAT', path: '/paths/d', message: "Path must start with '/': d" },
      ]);
      // `get: null` stays silent, as it always was
      expect(result.warnings?.map((w) => [w.code, w.path])).toEqual([
        ['METHOD_CASE_VARIANT', '/paths/~1a/additionalOperations/Get'],
        ['REFUSED_METHOD', '/paths/~1a/additionalOperations/CONNECT'],
        ['NO_OPERATIONS', '/paths//a'],
        ['NO_OPERATIONS', '/paths//b'],
        ['PATH_ITEM_NOT_OBJECT', '/paths/~1c'],
        ['PATH_ITEM_NOT_OBJECT', '/paths/d'],
      ]);
    });

    it('keeps a fixed field that is not an operation invalid in 3.0 and 3.1, and null valid', async () => {
      for (const version of ['3.0.3', '3.1.0']) {
        expect(await errorCodes(doc(version, { '/a': { get: 'x' } }))).toEqual(['OPERATION_NOT_OBJECT']);
        expect(await validate(doc(version, { '/a': { get: null, post: { operationId: 'p', responses: ok } } }))).toEqual(
          VALID,
        );
      }
    });
  });

  describe('parameter locations', () => {
    const querystring = { name: 'q', in: 'querystring', content: { 'application/json': { schema: { type: 'object' } } } };
    const query = { name: 'limit', in: 'query', schema: { type: 'integer' } };
    const withParameters = (version: string, pathItem: Record<string, unknown>) =>
      doc(version, { '/a': { get: { operationId: 'a', responses: ok }, ...pathItem } });
    const opParameters = (version: string, parameters: unknown[]) =>
      doc(version, { '/a': { get: { operationId: 'a', responses: ok, parameters } } });

    it('accepts in: querystring with content in 3.2', async () => {
      expect(await validate(opParameters('3.2.0', [querystring]))).toEqual(VALID);
    });

    it('warns, rather than errors, about in: querystring in a document declaring an older version', async () => {
      for (const version of ['3.0.3', '3.1.0']) {
        const result = await validate(opParameters(version, [querystring]));
        expect(result.valid).toBe(true);
        expect(result.warnings).toEqual([
          {
            code: 'FEATURE_NEWER_THAN_DECLARED_VERSION',
            path: '/paths/~1a/get/parameters/0/in',
            message: `A parameter \`in: querystring\` needs OpenAPI 3.2 or later, but the document declares OpenAPI "${version}"`,
          },
        ]);
      }
    });

    it('rejects a location no version defines, naming the allowed ones', async () => {
      const result = await validate(opParameters('3.1.0', [{ name: 'b', in: 'body', schema: {} }]));
      expect(result.errors).toEqual([
        {
          code: 'INVALID_PARAMETER_IN',
          path: '/paths//a/get/parameters/0/in',
          message: 'Invalid parameter location: body. OpenAPI 3.1 allows path, query, header, cookie',
        },
      ]);
      const notAString = await validate(opParameters('3.2.0', [{ name: 'b', in: { x: 1 }, schema: {} }]));
      expect(notAString.errors?.[0].message).toBe(
        'Invalid parameter location: an object. OpenAPI 3.2 allows path, query, querystring, header, cookie',
      );
    });

    it('requires content on a querystring parameter', async () => {
      const result = await validate(opParameters('3.2.0', [{ name: 'q', in: 'querystring', schema: { type: 'object' } }]));
      expect(result.errors).toEqual([
        {
          code: 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT',
          path: '/paths/~1a/get/parameters/0',
          message: "Parameter 'q' in: querystring must define content (a media type and its schema), not schema",
        },
      ]);
    });

    it('allows at most one querystring parameter per operation, counting path-level ones', async () => {
      expect(await errorCodes(opParameters('3.2.0', [querystring, { ...querystring, name: 'r' }]))).toEqual([
        'MULTIPLE_QUERYSTRING_PARAMETERS',
      ]);
      const merged = await validate(withParameters('3.2.0', { parameters: [{ ...querystring, name: 'r' }] }));
      expect(merged.valid).toBe(true);
      const result = await validate(
        doc('3.2.0', {
          '/a': {
            parameters: [{ ...querystring, name: 'r' }],
            get: { operationId: 'a', responses: ok, parameters: [querystring] },
          },
        }),
      );
      expect(result.errors).toEqual([
        {
          code: 'MULTIPLE_QUERYSTRING_PARAMETERS',
          path: '/paths/~1a/get/parameters',
          message: 'Operation GET /a: 2 parameters are in: querystring; at most one is allowed',
        },
      ]);
    });

    it('lets an operation parameter override the path-level one with the same name', async () => {
      const result = await validate(
        doc('3.2.0', {
          '/a': { parameters: [querystring], get: { operationId: 'a', responses: ok, parameters: [querystring] } },
        }),
      );
      expect(result.valid).toBe(true);
    });

    it('rejects querystring together with query parameters, across levels', async () => {
      expect(await errorCodes(opParameters('3.2.0', [querystring, query]))).toEqual(['QUERYSTRING_WITH_QUERY_PARAMETERS']);
      const result = await validate(
        doc('3.2.0', { '/a': { parameters: [query], get: { operationId: 'a', responses: ok, parameters: [querystring] } } }),
      );
      expect(result.errors).toEqual([
        {
          code: 'QUERYSTRING_WITH_QUERY_PARAMETERS',
          path: '/paths/~1a/get/parameters',
          message:
            'Operation GET /a: a parameter in: querystring is combined with parameters in: query, but a querystring ' +
            'parameter holds the whole query string',
        },
      ]);
    });

    it('reports a path-level violation once, not again for each operation', async () => {
      const result = await validate(
        doc('3.2.0', {
          '/a': {
            parameters: [querystring, { ...querystring, name: 'r' }, query],
            get: { operationId: 'a', responses: ok },
            post: { operationId: 'b', responses: ok },
          },
        }),
      );
      expect(result.errors?.map((e) => [e.code, e.path, e.message.split(':')[0]])).toEqual([
        ['MULTIPLE_QUERYSTRING_PARAMETERS', '/paths/~1a/parameters', 'Path /a'],
        ['QUERYSTRING_WITH_QUERY_PARAMETERS', '/paths/~1a/parameters', 'Path /a'],
      ]);
    });

    it('rejects a parameter that is not an object instead of throwing', async () => {
      const result = await validate(opParameters('3.0.3', [null, 'x']));
      expect(result.errors).toEqual([
        {
          code: 'INVALID_PARAMETER',
          path: '/paths/~1a/get/parameters/0',
          message: 'Parameter must be a Parameter Object or a Reference Object, found null',
        },
        {
          code: 'INVALID_PARAMETER',
          path: '/paths/~1a/get/parameters/1',
          message: 'Parameter must be a Parameter Object or a Reference Object, found "x"',
        },
      ]);
    });

    it('ignores parameters that are not a list, and never resolves references through the prototype', async () => {
      expect(await errorCodes(doc('3.0.3', { '/a': { get: { operationId: 'a', responses: ok, parameters: {} } } }))).toEqual(
        [],
      );
      // `#/components/parameters/constructor` is dangling: the coverage check is deferred, not fed Object's constructor
      const result = await validate(
        doc('3.0.3', {
          '/a/{id}': { get: { operationId: 'a', responses: ok, parameters: [{ $ref: '#/components/parameters/constructor' }] } },
        }, { components: { parameters: {} } }),
      );
      expect(result.errors).toBeUndefined();
    });

    it('matches path parameters by name only when the name is a string', async () => {
      const result = await validate(
        doc('3.0.3', { '/a/{5}': { get: { operationId: 'a', responses: ok, parameters: [{ name: 5, in: 'path', required: true, schema: {} }] } } }),
      );
      expect(result.errors?.map((e) => e.code)).toEqual(['MISSING_PATH_PARAMETER']);
    });
  });

  describe('bounded findings on hostile documents', () => {
    it('caps errors and the historical paths, and escapes document text in messages', async () => {
      const path = `/${'p'.repeat(50_000)}\u001b[31m`;
      const parameters = Array.from({ length: 5000 }, () => ({}));
      const result = await validate(doc('3.0.3', { [path]: { get: { operationId: 'a', responses: ok, parameters } } }));

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(MAX_DIAGNOSTICS + 1);
      expect(result.errors![MAX_DIAGNOSTICS]).toEqual({
        code: 'DIAGNOSTICS_TRUNCATED',
        message: `Only the first ${MAX_DIAGNOSTICS} errors are listed; the document has more`,
      });
      // historical form, unescaped, with the path key cut
      expect(result.errors![0]).toEqual({
        code: 'MISSING_PARAMETER_NAME',
        path: `/paths/${path.slice(0, LEGACY_PATH_KEY_MAX_LENGTH)}.../get/parameters/0/name`,
        message: 'Parameter missing name',
      });
      expect(JSON.stringify(result).length).toBeLessThan(2_000_000);

      const label = await validate(doc('3.0.3', { [path]: { get: { responses: ok } } }));
      const [warning] = label.warnings!;
      expect(warning.code).toBe('NO_OPERATION_ID');
      expect(warning.message).toBe(`Operation missing operationId: GET /${'p'.repeat(LEGACY_PATH_KEY_MAX_LENGTH - 1)}...`);
      const escaped = await validate(doc('3.0.3', { '/a\u001b[31m\n': { get: { responses: ok } } }));
      expect(escaped.warnings![0].message).toBe('Operation missing operationId: GET /a\\u001b[31m\\u000a');
    });

    it('caps warnings the same way', async () => {
      const paths = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`/p${i}`, { get: { responses: ok } }]));
      const result = await validate(doc('3.0.3', paths));
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(MAX_DIAGNOSTICS + 1);
      expect(result.warnings!.at(-1)).toEqual({
        code: 'DIAGNOSTICS_TRUNCATED',
        message: `Only the first ${MAX_DIAGNOSTICS} warnings are listed; the document has more`,
      });
    });
  });
});
