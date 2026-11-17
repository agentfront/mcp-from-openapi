/**
 * Tests for Validator class
 */

import { Validator } from '../validator';
import { swagger2SkippedOperations } from '../spec';
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
      [
        'another major',
        doc('4.0.0'),
        '/openapi',
        'Unsupported version: OpenAPI "4.0.0". Expected Swagger 2.0 or OpenAPI 3.0.x, 3.1.x or 3.2.x (a later 3.x is read with the 3.2 rules)',
      ],
      ['an old major', doc('2.0.0'), '/openapi', 'Unsupported version: OpenAPI "2.0.0".'],
      ['a version without a patch', doc('3.1'), '/openapi', 'Malformed version: `openapi` must be a version string'],
      ['a number', doc(3.1), '/openapi', 'found 3.1.'],
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
        message:
          'Missing version: the document has neither an `openapi` nor a `swagger` field. Expected Swagger 2.0 or ' +
          'OpenAPI 3.0.x, 3.1.x or 3.2.x (a later 3.x is read with the 3.2 rules)',
      });
    });

    it('warns about conflicting version fields', async () => {
      expect(await warningCodes(doc('3.1.0', {}, { swagger: '2.0' }))).toContain('CONFLICTING_VERSION_FIELDS');
    });
  });

  describe('$self', () => {
    const paths = { '/a': { get: { operationId: 'a', responses: ok } } };

    it.each(['https://example.com/api/openapi', '/api/openapi', '', 'https://user:pw@example.com/api', 'javascript:x'])(
      'accepts a URI reference without a fragment in 3.2 (%p): the base rules are the generator\'s',
      async (self) => {
        expect(await validate(doc('3.2.0', paths, { $self: self }))).toEqual(VALID);
      },
    );

    it.each<[unknown, string]>([
      [42, '`$self` must be a string holding a URI reference, found 42'],
      ['https://example.com/a b', '`$self` must be a URI reference (RFC 3986), found "https://example.com/a b"'],
      ['/api\r\nX: 1', '`$self` must be a URI reference (RFC 3986), found "/api\\r\\nX: 1"'],
      ['https://example.com/api#/info', '`$self` must not contain a fragment, found "https://example.com/api#/info"'],
    ])('rejects %p in 3.2 with INVALID_SELF', async (self, message) => {
      const result = await validate(doc('3.2.0', paths, { $self: self }));
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([{ code: 'INVALID_SELF', path: '/$self', message }]);
      // The same rule applies to a newer minor version
      expect(await errorCodes(doc('3.3.0', paths, { $self: self }))).toEqual(['INVALID_SELF']);
    });

    it.each(['3.0.3', '3.1.1'])('warns that %s does not read $self, whatever its value', async (version) => {
      const result = await validate(doc(version, paths, { $self: 'https://example.com/api#bad' }));
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'FEATURE_NEWER_THAN_DECLARED_VERSION',
          path: '/$self',
          message:
            `The \`$self\` field needs OpenAPI 3.2 or later, but the document declares OpenAPI "${version}"; it is ` +
            'ignored, and references resolve as if it were absent',
        },
      ]);
    });

    it('says nothing about $self when the version cannot be processed', async () => {
      expect(await errorCodes(doc('4.0.0', paths, { $self: 5 }))).toEqual(['INVALID_OPENAPI_VERSION']);
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

    it('matches path parameters by the text of a number or boolean name', async () => {
      const result = await validate(
        doc('3.0.3', { '/a/{5}': { get: { operationId: 'a', responses: ok, parameters: [{ name: 5, in: 'path', required: true, schema: {} }] } } }),
      );
      expect(result).toEqual({
        valid: true,
        errors: undefined,
        warnings: [
          {
            code: 'PARAMETER_NAME_NOT_STRING',
            path: '/paths/~1a~1{5}/get/parameters/0/name',
            message: 'Parameter name 5 is a number, not a string (YAML reads an unquoted number so); it is read as "5"',
          },
        ],
      });
      const object = await validate(
        doc('3.0.3', { '/a/{5}': { get: { operationId: 'a', responses: ok, parameters: [{ name: {}, in: 'path', required: true, schema: {} }] } } }),
      );
      expect(object.errors?.map((e) => e.code)).toEqual(['INVALID_PARAMETER_NAME', 'MISSING_PATH_PARAMETER']);
    });

    it('reads a number or boolean name as its text, so it merges and repeats like any name', async () => {
      const result = await validate(
        doc('3.1.0', {
          '/a': {
            parameters: [{ name: 2024, in: 'query', schema: {} }],
            get: {
              operationId: 'a',
              responses: ok,
              parameters: [{ name: '2024', in: 'query', schema: {} }, { name: 0, in: 'header', schema: {} }, { name: false, in: 'header', schema: {} }, { name: '0', in: 'header', schema: {} }],
            },
          },
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.warnings?.map((w) => [w.code, w.path])).toEqual([
        ['PARAMETER_NAME_NOT_STRING', '/paths/~1a/parameters/0/name'],
        ['PARAMETER_NAME_NOT_STRING', '/paths/~1a/get/parameters/1/name'],
        ['PARAMETER_NAME_NOT_STRING', '/paths/~1a/get/parameters/2/name'],
        ['DUPLICATE_PARAMETER', '/paths/~1a/get/parameters/1'],
      ]);
    });

    it('rejects a parameter name that is not a string, never coercing it', async () => {
      const hostile = {
        toString() {
          throw new Error('coerced');
        },
      };
      const names: unknown[] = [{ toString: 0 }, hostile, Object.create(null), ['a']];
      const result = await validate(
        doc('3.1.0', {
          '/a': {
            parameters: names.map((name) => ({ name, in: 'query', schema: {} })),
            get: { operationId: 'a', responses: ok, parameters: names.map((name) => ({ name, in: 'header', schema: {} })) },
          },
        }),
      );
      expect(result.valid).toBe(false);
      const errors = result.errors!.filter((e) => e.code === 'INVALID_PARAMETER_NAME');
      expect(errors).toHaveLength(names.length * 2);
      expect(errors.slice(0, names.length)).toEqual(
        ['an object', 'an object', 'an object', 'an array'].map((found, index) => ({
          message: `Parameter name must be a string, found ${found}`,
          path: `/paths/~1a/parameters/${index}/name`,
          code: 'INVALID_PARAMETER_NAME',
        })),
      );
      expect(errors[names.length].path).toBe('/paths/~1a/get/parameters/0/name');
      // A missing or empty name keeps its own code
      const missing = await validate(opParameters('3.1.0', [{ name: '', in: 'query', schema: {} }, { in: 'query', schema: {} }]));
      expect(missing.errors?.map((e) => e.code)).toEqual(['MISSING_PARAMETER_NAME', 'MISSING_PARAMETER_NAME']);
    });

    it('reads a boolean parameter schema as a schema', async () => {
      const result = await validate(
        opParameters('3.1.0', [
          { name: 'a', in: 'query', schema: false },
          { name: 'b', in: 'query', schema: true },
        ]),
      );
      expect(result.errors).toBeUndefined();
      // Still missing: no schema, or a value that is not one
      for (const schema of [undefined, null, 0, '']) {
        const missing = await validate(opParameters('3.1.0', [{ name: 'a', in: 'query', schema }]));
        expect(missing.errors?.map((e) => e.code)).toEqual(['MISSING_PARAMETER_SCHEMA']);
      }
    });

    it('requires a querystring parameter content to hold a media type', async () => {
      const result = await validate(
        opParameters('3.2.0', [
          { name: 'q', in: 'querystring', content: {} },
          { name: 'r', in: 'querystring', content: 'application/json' },
        ]),
      );
      expect(result.errors).toEqual([
        {
          code: 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT',
          path: '/paths/~1a/get/parameters/0/content',
          message: "Parameter 'q' in: querystring must define content with one media type, found none",
        },
        {
          code: 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT',
          path: '/paths/~1a/get/parameters/1/content',
          message: 'Parameter \'r\' in: querystring must define content with one media type, found "application/json"',
        },
        expect.objectContaining({ code: 'MULTIPLE_QUERYSTRING_PARAMETERS' }),
      ]);
      // covered by the error, so no content warning on top
      expect(result.warnings).toBeUndefined();
      // `content: null` is no content
      expect(
        (await validate(opParameters('3.2.0', [{ name: 'q', in: 'querystring', content: null }]))).errors?.[0].message,
      ).toBe("Parameter 'q' in: querystring must define content (a media type and its schema), not schema");
    });
  });

  describe('parameter content and duplicates (warnings)', () => {
    const opParameters = (version: string, parameters: unknown[]) =>
      doc(version, { '/a': { get: { operationId: 'a', responses: ok, parameters } } });
    const json = { schema: { type: 'object' } };

    it('warns about a content that does not hold exactly one media type, saying what generation does', async () => {
      const result = await validate(
        opParameters('3.0.3', [
          { name: 'several', in: 'query', content: { 'text/plain': json, 'application/json': json } },
          { name: 'empty', in: 'query', content: {} },
          { name: 'notAMap', in: 'header', content: ['application/json'] },
          { name: 'withSchema', in: 'query', schema: { type: 'string' }, content: { 'a/b': json, 'c/d': json } },
          { name: 'one', in: 'cookie', content: { 'application/json': json } },
          { name: 'none', in: 'query', schema: { type: 'string' }, content: null },
        ]),
      );
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'INVALID_PARAMETER_CONTENT',
          path: '/paths/~1a/get/parameters/0',
          message:
            'Parameter "several" (in: "query"): content must hold exactly one media type, found 2 media types; ' +
            '"application/json" is used',
        },
        {
          code: 'INVALID_PARAMETER_CONTENT',
          path: '/paths/~1a/get/parameters/1',
          message:
            'Parameter "empty" (in: "query"): content must hold exactly one media type, found no media type; ' +
            'content is ignored and the value is read as a string',
        },
        {
          code: 'INVALID_PARAMETER_CONTENT',
          path: '/paths/~1a/get/parameters/2',
          message:
            'Parameter "notAMap" (in: "header"): content must hold exactly one media type, found an array; ' +
            'content is ignored and the value is read as a string',
        },
        {
          code: 'INVALID_PARAMETER_CONTENT',
          path: '/paths/~1a/get/parameters/3',
          message:
            'Parameter "withSchema" (in: "query"): defines both schema and content, but must define only one; ' +
            'content is ignored and schema is used',
        },
      ]);
    });

    it('warns, without rejecting, about a parameter defining both schema and content', async () => {
      const result = await validate(
        opParameters('3.1.0', [
          { name: 'a', in: 'header', schema: { type: 'string' }, content: { 'application/json': json } },
          { name: 'b', in: 'query', schema: { type: 'string' }, content: {} },
        ]),
      );
      expect(result.valid).toBe(true);
      expect(result.warnings?.map((w) => [w.path, w.message.slice(w.message.indexOf('): ') + 3)])).toEqual([
        ['/paths/~1a/get/parameters/0', 'defines both schema and content, but must define only one; content is ignored and schema is used'],
        ['/paths/~1a/get/parameters/1', 'defines both schema and content, but must define only one; content is ignored and schema is used'],
      ]);
    });

    it('warns about a media type that is not a Media Type Object, or declares itemSchema', async () => {
      const result = await validate(
        opParameters('3.2.0', [
          { name: 'a', in: 'query', content: { 'application/json': null } },
          { name: 'b', in: 'query', content: { 'text/plain': 'x' } },
          { name: 'c', in: 'query', content: { 'application/jsonl': { itemSchema: { type: 'string' } } } },
          { name: 'd', in: 'query', content: { 'application/json': { schema: { type: 'object' }, itemSchema: {} } } },
          // before dereferencing a reference is normal: no warning
          { name: 'e', in: 'query', content: { 'application/json': { $ref: '#/components/mediaTypes/M' } } },
        ]),
      );
      expect(result.valid).toBe(true);
      expect(result.warnings?.map((w) => w.message.slice(w.message.indexOf('): ') + 3))).toEqual([
        'the media type "application/json" is not a Media Type Object (found null); the value is unconstrained',
        'the media type "text/plain" is not a Media Type Object (found "x"); the value is read as a string',
        'the media type "application/jsonl" declares itemSchema, which describes the items of a stream and is not ' +
          'read for a parameter; the value is read as a string',
        'the media type "application/json" declares itemSchema, which describes the items of a stream and is not ' +
          'read for a parameter; its schema is used',
      ]);
    });

    it('reads header names in any case for duplicates, and a list duplicate no longer counts twice for querystring', async () => {
      const header = (name: string) => ({ name, in: 'header', schema: { type: 'string' } });
      const qs = { name: 'q', in: 'querystring', content: { 'application/json': json } };
      const result = await validate(opParameters('3.2.0', [header('X-Id'), header('x-id'), qs, qs]));
      expect(result.valid).toBe(true);
      expect(result.warnings?.map((w) => [w.code, w.path])).toEqual([
        ['DUPLICATE_PARAMETER', '/paths/~1a/get/parameters/0'],
        ['DUPLICATE_PARAMETER', '/paths/~1a/get/parameters/2'],
      ]);
      // query names stay case-sensitive
      expect(
        await validate(opParameters('3.0.3', [{ name: 'id', in: 'query', schema: {} }, { name: 'ID', in: 'query', schema: {} }])),
      ).toEqual({ valid: true, errors: undefined, warnings: undefined });
    });

    it('warns about several media types on a querystring parameter, which reads content whatever its schema', async () => {
      const result = await validate(
        opParameters('3.2.0', [
          {
            name: 'q',
            in: 'querystring',
            schema: { type: 'string' },
            content: { 'text/plain': json, 'application/x-www-form-urlencoded': json },
          },
        ]),
      );
      expect(result.valid).toBe(true);
      expect(result.warnings?.map((w) => w.message)).toEqual([
        'Parameter "q" (in: "querystring"): defines both schema and content, but must define only one; schema is ' +
          'ignored and content is used',
        'Parameter "q" (in: "querystring"): content must hold exactly one media type, found 2 media types; ' +
          '"application/x-www-form-urlencoded" is used',
      ]);
    });

    it('warns about a parameter listed twice in one list, at each one ignored, but not across levels', async () => {
      const limit = { name: 'limit', in: 'query', schema: { type: 'integer' } };
      const result = await validate(
        doc('3.1.0', {
          '/a': {
            parameters: [limit, { ...limit, in: 'header' }, limit],
            get: {
              operationId: 'a',
              responses: ok,
              parameters: [limit, { name: 'x', in: 'query', schema: {} }, limit, limit, { $ref: '#/x' }, { $ref: '#/x' }],
            },
          },
        }),
      );
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([
        {
          code: 'DUPLICATE_PARAMETER',
          path: '/paths/~1a/parameters/0',
          message:
            'Parameter "limit" (in: "query") appears again at index 2 of the same list, but a parameter list must not ' +
            'repeat a name and location; this one is ignored',
        },
        expect.objectContaining({ code: 'DUPLICATE_PARAMETER', path: '/paths/~1a/get/parameters/0' }),
        expect.objectContaining({ code: 'DUPLICATE_PARAMETER', path: '/paths/~1a/get/parameters/2' }),
      ]);
      expect(result.warnings![1].message).toContain('appears again at index 3');
    });

    it('bounds and escapes the parameter text in these warnings', async () => {
      const name = `${'n'.repeat(10_000)}\u001b[31m`;
      const result = await validate(
        opParameters('3.0.3', [
          { name, in: 'query', schema: {} },
          { name, in: 'query', content: { [`${'m'.repeat(10_000)}\n`]: {}, 'x/y': {} } },
        ]),
      );
      for (const warning of result.warnings!) {
        expect(warning.message.length).toBeLessThan(400);
        expect(warning.message).not.toMatch(/[\u0000-\u001f]/);
      }
      expect(result.warnings!.map((w) => w.code)).toEqual(['INVALID_PARAMETER_CONTENT', 'DUPLICATE_PARAMETER']);
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

// ---------------------------------------------------------------------------
// Swagger 2.0 (validated with its own rules, as written)
// ---------------------------------------------------------------------------

describe('Swagger 2.0 validation', () => {
  const ok = { '200': { description: 'OK' } };
  const swagger = (paths: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): any => ({
    swagger: '2.0',
    info: { title: 'T', version: '1.0.0' },
    host: 'api.example.com',
    paths,
    ...extra,
  });
  const operation = (parameters: unknown[], extra: Record<string, unknown> = {}) => ({
    operationId: 'op',
    parameters,
    responses: ok,
    ...extra,
  });
  const validate = (document: object) => new Validator().validate(document);
  const errors = async (document: object) => (await validate(document)).errors ?? [];
  const errorCodes = async (document: object) => (await errors(document)).map((e) => e.code);
  const warningCodes = async (document: object) => ((await validate(document)).warnings ?? []).map((w) => w.code);
  const VALID = { valid: true, errors: undefined, warnings: undefined };

  it('accepts a Swagger 2.0 document, declared as text or as the number YAML reads', async () => {
    const pets = {
      '/pets/{petId}': {
        parameters: [{ name: 'petId', in: 'path', required: true, type: 'string' }],
        get: operation([{ name: 'limit', in: 'query', type: 'integer', format: 'int32' }], { operationId: 'getPet' }),
        put: operation([{ name: 'pet', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }], {
          operationId: 'putPet',
        }),
        post: operation(
          [
            { name: 'name', in: 'formData', type: 'string' },
            { name: 'photo', in: 'formData', type: 'file' },
            { name: 'X-Trace', in: 'header', type: 'string' },
          ],
          { operationId: 'postPet' },
        ),
      },
    };
    const definitions = { Pet: { type: 'object', discriminator: 'kind', properties: { kind: { type: 'string' } } } };
    expect(await validate(swagger(pets, { definitions }))).toEqual(VALID);
    expect(await validate({ ...swagger(pets, { definitions }), swagger: 2 })).toEqual(VALID);
  });

  it('allows the 2.0 locations and no other, naming Swagger 2.0', async () => {
    const result = await validate(
      swagger({
        '/a': {
          get: operation([
            { name: 'c', in: 'cookie', type: 'string' },
            { name: 'q', in: 'querystring', content: { 'application/json': { schema: {} } } },
          ]),
        },
      }),
    );
    // `querystring` is not a newer feature here: a 2.0 parameter is converted, not read as OpenAPI 3
    expect(result.errors).toEqual([
      {
        code: 'INVALID_PARAMETER_IN',
        path: '/paths//a/get/parameters/0/in',
        message: 'Invalid parameter location: cookie. Swagger 2.0 allows path, query, header, formData, body',
      },
      {
        code: 'INVALID_PARAMETER_IN',
        path: '/paths//a/get/parameters/1/in',
        message: 'Invalid parameter location: querystring. Swagger 2.0 allows path, query, header, formData, body',
      },
      {
        code: 'MISSING_PARAMETER_SCHEMA',
        path: '/paths//a/get/parameters/1',
        message: "Parameter 'q' missing type: a parameter not in: body is described by type",
      },
    ]);
    expect(result.warnings).toBeUndefined();
  });

  it('needs type for a parameter not in: body, and a Schema Object for one in: body', async () => {
    const result = await validate(
      swagger({
        '/a': {
          get: operation([
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'h', in: 'header' },
            { name: 'b', in: 'body' },
            { name: 'c', in: 'body', schema: true },
          ]),
        },
      }),
    );
    expect(result.errors).toEqual([
      {
        code: 'MISSING_PARAMETER_SCHEMA',
        path: '/paths//a/get/parameters/0',
        message: "Parameter 'q' missing type: a parameter not in: body is described by type (Swagger 2.0 has no schema for it)",
      },
      {
        code: 'MISSING_PARAMETER_SCHEMA',
        path: '/paths//a/get/parameters/1',
        message: "Parameter 'h' missing type: a parameter not in: body is described by type",
      },
      {
        code: 'MISSING_PARAMETER_SCHEMA',
        path: '/paths//a/get/parameters/2',
        message: "Parameter 'b' (in: body) missing schema: a body parameter is described by a Schema Object",
      },
      {
        code: 'MISSING_PARAMETER_SCHEMA',
        path: '/paths//a/get/parameters/3',
        message: "Parameter 'c' (in: body) missing schema: a body parameter is described by a Schema Object",
      },
      // Two body parameters as well
      expect.objectContaining({ code: 'SWAGGER_MULTIPLE_BODY_PARAMETERS' }),
    ]);
    // `content` is not a 2.0 field: no OpenAPI 3 content warning
    expect(await warningCodes(swagger({ '/a': { get: operation([{ name: 'q', in: 'query', type: 'string', content: {} }]) } }))).toEqual([]);
  });

  it('allows one body parameter per operation, path-level ones included, and none with formData', async () => {
    const body = (name: string) => ({ name, in: 'body', schema: { type: 'object' } });
    const form = { name: 'f', in: 'formData', type: 'string' };
    // An operation-level body of the same name overrides the path-level one
    expect(await validate(swagger({ '/a': { parameters: [body('b')], post: operation([body('b')]) } }))).toEqual(VALID);
    expect(await errors(swagger({ '/a': { parameters: [body('b')], post: operation([body('c')]) } }))).toEqual([
      {
        code: 'SWAGGER_MULTIPLE_BODY_PARAMETERS',
        path: '/paths/~1a/post/parameters',
        message: 'Operation POST /a: 2 parameters are in: body (path-level ones included), but a request has one body',
      },
    ]);
    expect(await errors(swagger({ '/a': { parameters: [form], post: operation([body('b')]) } }))).toEqual([
      {
        code: 'SWAGGER_BODY_AND_FORM_DATA',
        path: '/paths/~1a/post/parameters',
        message:
          'Operation POST /a: a parameter in: body and parameters in: formData cannot be declared together ' +
          '(path-level ones included)',
      },
    ]);
    // Form parameters alone, and references to the root `parameters`
    expect(await validate(swagger({ '/a': { post: operation([form, { ...form, name: 'g' }]) } }))).toEqual(VALID);
    const parameters = { B: body('b'), C: body('c') };
    expect(
      await errorCodes(swagger({ '/a': { post: operation([{ $ref: '#/parameters/B' }, { $ref: '#/parameters/C' }]) } }, { parameters })),
    ).toEqual(['SWAGGER_MULTIPLE_BODY_PARAMETERS']);
  });

  it('applies the rules 2.0 shares with OpenAPI 3: required path parameters and responses', async () => {
    expect(
      await errorCodes(swagger({ '/a/{id}': { get: operation([{ name: 'id', in: 'path', type: 'string' }]) } })),
    ).toEqual(['PATH_PARAMETER_NOT_REQUIRED']);
    expect(await errorCodes(swagger({ '/a': { get: { operationId: 'a' } } }))).toEqual(['NO_RESPONSES']);
    expect(await errorCodes(swagger({ '/a': { get: { operationId: 'a', responses: {} } } }))).toEqual(['NO_RESPONSES']);
    expect(await errorCodes(swagger({ '/a/{id}': { get: operation([]) } }))).toEqual(['MISSING_PATH_PARAMETER']);
  });

  it('reads local parameter references in #/parameters', async () => {
    const parameters = { Id: { name: 'id', in: 'path', required: true, type: 'string' } };
    expect(await validate(swagger({ '/a/{id}': { get: operation([{ $ref: '#/parameters/Id' }]) } }, { parameters }))).toEqual(VALID);
    // A 3.x pointer names nothing in a 2.0 document: the path check waits for dereferencing
    expect(
      await errorCodes(swagger({ '/a/{id}': { get: operation([{ $ref: '#/components/parameters/Id' }]) } }, { parameters })),
    ).toEqual([]);
    expect(await errorCodes(swagger({ '/a/{id}': { get: operation([{ $ref: '#/parameters/Other' }]) } }, { parameters }))).toEqual([]);
  });

  it('warns about the operation fields Swagger 2.0 does not have, as the converter does', async () => {
    const result = await validate(
      swagger({ '/a': { get: operation([]), trace: operation([]), query: operation([]), additionalOperations: { LINK: {} } } }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(
      swagger2SkippedOperations({ trace: {}, query: {}, additionalOperations: {} }, '/paths/~1a').map((d) => ({
        message: d.message,
        path: d.path,
        code: d.code,
      })),
    );
    expect(result.warnings!.map((w) => w.path)).toEqual(['/paths/~1a/trace', '/paths/~1a/query', '/paths/~1a/additionalOperations']);
    expect(result.warnings![0].message).toBe(
      'The `trace` operation needs OpenAPI 3.0 or later and is not part of Swagger 2.0; it is not converted',
    );
    // A path holding only them has no operation
    expect(await warningCodes(swagger({ '/b': { trace: operation([]) } }))).toEqual([
      'FEATURE_NEWER_THAN_DECLARED_VERSION',
      'NO_OPERATIONS',
    ]);
  });

  it('warns about a missing host and about security without securityDefinitions', async () => {
    const { host: _host, ...hostless } = swagger({ '/a': { get: operation([]) } });
    expect((await validate(hostless)).warnings).toEqual([
      {
        code: 'NO_SERVERS',
        path: '/host',
        message:
          'No host defined: the API is on the host serving the document, known only when it is loaded with fromURL ' +
          'or LoadOptions.documentUri. You may need to provide a baseUrl option.',
      },
    ]);
    // `servers` means nothing in 2.0
    expect(await warningCodes({ ...hostless, servers: [{ url: 'https://x' }] })).toEqual(['NO_SERVERS']);
    const secured = swagger({ '/a': { get: operation([]) } }, { security: [{ key: [] }] });
    expect(await warningCodes(secured)).toEqual(['NO_SECURITY_SCHEMES']);
    expect(await validate({ ...secured, securityDefinitions: { key: { type: 'apiKey', name: 'k', in: 'header' } } })).toEqual(VALID);
    expect(await warningCodes({ ...secured, components: { securitySchemes: { key: {} } } })).toEqual(['NO_SECURITY_SCHEMES']);
  });

  it('rejects a basePath without a leading "/" or that a URL cannot carry (the official pattern is ^/)', async () => {
    const pets = { '/a': { get: operation([]) } };
    expect(await validate(swagger(pets, { basePath: '/api/v1/' }))).toEqual(VALID);
    expect(await errors(swagger(pets, { basePath: 'api/v1' }))).toEqual([
      { code: 'INVALID_BASE_PATH', path: '/basePath', message: 'basePath must start with "/", found "api/v1"' },
    ]);
    for (const basePath of ['/{v}', '/a b', '/a?x', '/a#f', '/a/../b', '/%2e', 7]) {
      const [error] = await errors(swagger(pets, { basePath }));
      expect(error).toMatchObject({ code: 'INVALID_BASE_PATH', path: '/basePath', message: expect.stringMatching(/^basePath cannot be used: it /) });
    }
    // Not a 2.0 field in OpenAPI 3: not checked there
    expect((await validate({ openapi: '3.0.3', info: { title: 'T', version: '1' }, servers: [{ url: 'https://x' }], paths: pets, basePath: 'x' })).valid).toBe(true);
  });

  it('no longer reports the OpenAPI 3 findings a Swagger 2.0 document used to get', async () => {
    const result = await validate(
      swagger({
        '/pets': {
          post: operation([
            { name: 'pet', in: 'body', schema: { type: 'object' } },
            { name: 'limit', in: 'query', type: 'integer' },
          ]),
        },
      }),
    );
    expect(result).toEqual(VALID);
  });
});
