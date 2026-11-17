import { OpenAPIToolGenerator, fnv1aHex } from '../generator';
import { toPascalIdentifier } from '../type-signature';
import { ParameterResolver } from '../parameter-resolver';
import { ResponseBuilder } from '../response-builder';
import { ParseError, LoadError, SchemaError, GenerationError } from '../errors';
import { Validator } from '../validator';
import { DIAGNOSTIC_CODES, MAX_DIAGNOSTICS } from '../types';
import type { GenerateOptions, LoadOptions, McpOpenAPITool, OpenAPIDocument } from '../types';
import { createLoopbackServer, type LoopbackHandler } from './helpers/loopback';
import { makePinnedLookup } from '../ssrf';
import { describeValue } from '../spec';
import dns from 'node:dns';

describe('OpenAPIToolGenerator', () => {
  const simpleOpenAPI: OpenAPIDocument = {
    openapi: '3.0.0',
    info: {
      title: 'Test API',
      version: '1.0.0',
    },
    paths: {
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          summary: 'Get user by ID',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  describe('Factory Methods', () => {
    it('should create from JSON object', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(simpleOpenAPI);
      expect(generator).toBeInstanceOf(OpenAPIToolGenerator);
      expect(generator.getDocument()).toEqual(simpleOpenAPI);
    });

    it('should create from YAML string', async () => {
      const yaml = `
openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
paths:
  /test:
    get:
      operationId: test
      responses:
        '200':
          description: OK
`;
      const generator = await OpenAPIToolGenerator.fromYAML(yaml);
      expect(generator).toBeInstanceOf(OpenAPIToolGenerator);
      expect(generator.getDocument().info.title).toBe('Test API');
    });

    it('should throw ParseError on invalid YAML', async () => {
      const invalidYaml = 'invalid: yaml: content:';
      await expect(OpenAPIToolGenerator.fromYAML(invalidYaml)).rejects.toThrow(ParseError);
    });

    it('should throw ParseError with context on invalid YAML', async () => {
      const invalidYaml = '{ invalid: [[[';
      const promise = OpenAPIToolGenerator.fromYAML(invalidYaml);
      await expect(promise).rejects.toThrow(ParseError);
      await expect(OpenAPIToolGenerator.fromYAML(invalidYaml)).rejects.toMatchObject({
        message: expect.stringContaining('Failed to parse YAML'),
      });
    });
  });

  describe('URL Loading', () => {
    // The SSRF guard pins the connection to the validated IP via node:http, so these tests drive a
    // REAL loopback server (allowInternalIPs lets the guard accept 127.0.0.1) rather than mocking
    // global.fetch, which the pinned transport bypasses. See createLoopbackServer / CLAUDE.md.
    let handler: LoopbackHandler;
    const loopback = createLoopbackServer(() => handler);
    let baseUrl: string;

    const specJson = (title: string) =>
      JSON.stringify({
        openapi: '3.0.0',
        info: { title, version: '1.0.0' },
        paths: { '/test': { get: { operationId: 'test', responses: { '200': { description: 'OK' } } } } },
      });
    const internal = (extra: Record<string, unknown> = {}) => ({ refResolution: { allowInternalIPs: true }, ...extra });

    beforeAll(async () => {
      baseUrl = await loopback.listen();
    });

    afterAll(async () => {
      await loopback.close();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should load from URL with JSON content', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(specJson('URL API'));
      };
      const generator = await OpenAPIToolGenerator.fromURL(`${baseUrl}/api.json`, internal());
      expect(generator.getDocument().info.title).toBe('URL API');
    });

    it('should load YAML from URL based on content-type', async () => {
      const yamlSpec = `
openapi: '3.0.0'
info:
  title: YAML API
  version: '1.0.0'
paths:
  /test:
    get:
      operationId: test
      responses:
        '200':
          description: OK
`;
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/yaml' });
        res.end(yamlSpec);
      };
      const generator = await OpenAPIToolGenerator.fromURL(`${baseUrl}/api`, internal({ validate: false }));
      expect(generator.getDocument().info.title).toBe('YAML API');
    });

    it('should load YAML from URL based on URL extension', async () => {
      const yamlSpec = `
openapi: '3.0.0'
info:
  title: YAML Ext API
  version: '1.0.0'
paths:
  /test:
    get:
      operationId: test
      responses:
        '200':
          description: OK
`;
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(yamlSpec);
      };
      const generator = await OpenAPIToolGenerator.fromURL(`${baseUrl}/api.yaml`, internal({ validate: false }));
      expect(generator.getDocument().info.title).toBe('YAML Ext API');
    });

    it('should throw LoadError on HTTP error', async () => {
      handler = (_req, res) => {
        res.writeHead(404, 'Not Found');
        res.end();
      };
      await expect(OpenAPIToolGenerator.fromURL(`${baseUrl}/api.json`, internal())).rejects.toThrow(LoadError);
      await expect(OpenAPIToolGenerator.fromURL(`${baseUrl}/api.json`, internal())).rejects.toMatchObject({
        message: expect.stringContaining('404'),
      });
    });

    it('should throw LoadError on network error', async () => {
      // Nothing listening on port 1 -> connection refused -> wrapped as LoadError.
      await expect(OpenAPIToolGenerator.fromURL('http://127.0.0.1:1/api.json', internal())).rejects.toThrow(LoadError);
    });

    it('should refuse a spec URL pointing at a literal internal IP (SSRF guard)', async () => {
      // Literal internal IPs are rejected synchronously, before any connection.
      await expect(OpenAPIToolGenerator.fromURL('http://127.0.0.1:8080/openapi.json')).rejects.toThrow(/blocked/i);
      await expect(OpenAPIToolGenerator.fromURL('http://169.254.169.254/openapi.json')).rejects.toThrow(LoadError);
      await expect(OpenAPIToolGenerator.fromURL('http://[::1]/openapi.json')).rejects.toThrow(LoadError);
    });

    it('should refuse non-http(s) spec URLs', async () => {
      await expect(OpenAPIToolGenerator.fromURL('file:///etc/passwd')).rejects.toThrow(LoadError);
    });

    it('should allow internal spec URLs when allowInternalIPs is set', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'Local', version: '1.0.0' }, paths: {} }));
      };
      const generator = await OpenAPIToolGenerator.fromURL(`${baseUrl}/openapi.json`, internal());
      expect(generator.getDocument().info.title).toBe('Local');
    });

    it('should throw LoadError when YAML parse fails from URL', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/yaml' });
        res.end('{ invalid yaml: [[[');
      };
      await expect(OpenAPIToolGenerator.fromURL(`${baseUrl}/api.yaml`, internal())).rejects.toThrow(LoadError);
    });

    it('should throw LoadError when JSON parse fails from URL', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('not valid json at all');
      };
      await expect(OpenAPIToolGenerator.fromURL(`${baseUrl}/api.json`, internal())).rejects.toThrow(LoadError);
    });

    it('should wrap non-Error thrown values as LoadError', async () => {
      // A non-Error thrown while reading the body must still be wrapped.
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(specJson('X'));
      };
      jest.spyOn(Response.prototype, 'text').mockRejectedValueOnce('string error');
      const promise = OpenAPIToolGenerator.fromURL(`${baseUrl}/api.json`, internal());
      await expect(promise).rejects.toThrow(LoadError);
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('string error'),
      });
    });

    it('should handle timeout option', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(specJson('Test'));
      };
      const generator = await OpenAPIToolGenerator.fromURL(`${baseUrl}/api.json`, internal({ timeout: 5000 }));
      expect(generator).toBeInstanceOf(OpenAPIToolGenerator);
    });

    it('should pass custom headers through to the request', async () => {
      let receivedAuth: string | undefined;
      handler = (req, res) => {
        receivedAuth = req.headers['x-custom'] as string | undefined;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(specJson('Test'));
      };
      await OpenAPIToolGenerator.fromURL(`${baseUrl}/api.json`, internal({ headers: { 'X-Custom': 'value' } }));
      expect(receivedAuth).toBe('value');
    });

    it('should not forward caller headers to a cross-origin redirect target', async () => {
      const cdn = createLoopbackServer(() => (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(specJson('Redirected'));
      });
      const cdnBase = await cdn.listen();
      loopback.reset();
      handler = (_req, res) => {
        res.writeHead(302, { location: `${cdnBase}/spec.json` });
        res.end();
      };
      try {
        const generator = await OpenAPIToolGenerator.fromURL(
          `${baseUrl}/api.json`,
          internal({ headers: { Authorization: 'Bearer SECRET-TOKEN', 'X-API-Key': 'SECRET-KEY' } }),
        );
        expect(generator.getDocument().info.title).toBe('Redirected');
        expect(loopback.requests[0].headers.authorization).toBe('Bearer SECRET-TOKEN');
        expect(cdn.requests).toHaveLength(1);
        expect(cdn.requests[0].headers.authorization).toBeUndefined();
        expect(cdn.requests[0].headers['x-api-key']).toBeUndefined();
      } finally {
        await cdn.close();
      }
    });

    it('should apply blockedHosts to the trailing-dot form of the spec host', async () => {
      loopback.reset();
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(specJson('Blocked'));
      };
      const port = new URL(baseUrl).port;
      for (const host of ['localhost', 'localhost.', 'LOCALHOST.']) {
        await expect(
          OpenAPIToolGenerator.fromURL(`http://${host}:${port}/api.json`, {
            refResolution: { allowInternalIPs: true, blockedHosts: ['localhost'] },
          }),
        ).rejects.toThrow(/blocked/);
      }
      expect(loopback.requests).toHaveLength(0);
    });

    it('should not follow redirects when followRedirects is false', async () => {
      handler = (_req, res) => {
        res.writeHead(302, { location: `${baseUrl}/elsewhere` });
        res.end();
      };
      // With following disabled the 3xx surfaces (non-ok) as a LoadError instead
      // of being chased to another host.
      await expect(
        OpenAPIToolGenerator.fromURL(`${baseUrl}/api.json`, internal({ followRedirects: false })),
      ).rejects.toThrow(LoadError);
    });

    it('should handle missing content-type header', async () => {
      handler = (_req, res) => {
        res.writeHead(200);
        res.end(specJson('Test'));
      };
      const generator = await OpenAPIToolGenerator.fromURL(`${baseUrl}/api.json`, internal());
      expect(generator).toBeInstanceOf(OpenAPIToolGenerator);
    });
  });

  describe('File Loading', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const minimalSpec = {
      openapi: '3.0.0',
      info: { title: 'File Test', version: '1.0.0' },
      paths: {
        '/test': {
          get: {
            operationId: 'test',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    it('should throw LoadError on file read error', async () => {
      await expect(OpenAPIToolGenerator.fromFile('/nonexistent/path/api.json')).rejects.toThrow(LoadError);
    });

    it('should throw LoadError with context on file not found', async () => {
      await expect(OpenAPIToolGenerator.fromFile('/nonexistent/path/api.yaml')).rejects.toMatchObject({
        message: expect.stringContaining('Failed to load OpenAPI spec from file'),
      });
    });

    it('should load from JSON file', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-spec-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, JSON.stringify(minimalSpec));
      try {
        const generator = await OpenAPIToolGenerator.fromFile(tmpFile);
        expect(generator.getDocument().info.title).toBe('File Test');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('should load from YAML file', async () => {
      const yaml = require('yaml');
      const tmpFile = path.join(os.tmpdir(), `test-spec-${Date.now()}.yaml`);
      fs.writeFileSync(tmpFile, yaml.stringify(minimalSpec));
      try {
        const generator = await OpenAPIToolGenerator.fromFile(tmpFile);
        expect(generator.getDocument().info.title).toBe('File Test');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('should auto-detect JSON for unknown extension', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-spec-${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, JSON.stringify(minimalSpec));
      try {
        const generator = await OpenAPIToolGenerator.fromFile(tmpFile);
        expect(generator.getDocument().info.title).toBe('File Test');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('should fallback to YAML for unknown extension when JSON parse fails', async () => {
      const yaml = require('yaml');
      const tmpFile = path.join(os.tmpdir(), `test-spec-${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, yaml.stringify(minimalSpec));
      try {
        const generator = await OpenAPIToolGenerator.fromFile(tmpFile);
        expect(generator.getDocument().info.title).toBe('File Test');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('should throw LoadError with original error context', async () => {
      await expect(OpenAPIToolGenerator.fromFile('/nonexistent/absolute/path.json')).rejects.toMatchObject({
        context: expect.objectContaining({
          filePath: '/nonexistent/absolute/path.json',
        }),
      });
    });

    it('should load from relative file path', async () => {
      const fileName = `test-spec-relative-${Date.now()}.json`;
      const absolutePath = path.join(process.cwd(), fileName);
      fs.writeFileSync(absolutePath, JSON.stringify(minimalSpec));
      try {
        const generator = await OpenAPIToolGenerator.fromFile(fileName);
        expect(generator.getDocument().info.title).toBe('File Test');
      } finally {
        fs.unlinkSync(absolutePath);
      }
    });
  });

  describe('Custom Tool Naming', () => {
    it('should use custom toolNameGenerator when provided', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{id}': {
            get: {
              operationId: 'getUser',
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users/{id}', 'get', {
        namingStrategy: {
          conflictResolver: (name, loc, idx) => `${name}_${loc}_${idx}`,
          toolNameGenerator: (path, method, opId) => `custom_${method}_${opId}`,
        },
      });

      expect(tool.name).toBe('custom_get_getUser');
    });

    it('should fallback to operationId when no custom generator', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'listUsers',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get');

      expect(tool.name).toBe('listUsers');
    });

    it('should generate name from path when no operationId', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{userId}/posts': {
            get: {
              // No operationId
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi, { validate: false });
      const tool = await generator.generateTool('/users/{userId}/posts', 'get');

      expect(tool.name).toContain('users');
      expect(tool.name).toContain('posts');
    });
  });

  describe('Tool Generation', () => {
    it('should generate tool with correct structure', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(simpleOpenAPI);
      const tool = await generator.generateTool('/users/{id}', 'get');

      expect(tool).toMatchObject({
        name: 'getUser',
        description: 'Get user by ID',
        metadata: {
          path: '/users/{id}',
          method: 'get',
          operationId: 'getUser',
        },
      });

      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.mapper).toHaveLength(1);
    });

    it('should generate all tools', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(simpleOpenAPI);
      const tools = await generator.generateTools();

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('getUser');
    });

    it('should generate a tool from an Xquik OpenAPI 3.1 operation', async () => {
      const openapi: OpenAPIDocument = {
        openapi: '3.1.0',
        info: { title: 'Xquik API', version: '1.0' },
        servers: [{ url: 'https://xquik.com' }],
        security: [{ apiKey: [] }],
        components: {
          securitySchemes: {
            apiKey: {
              type: 'apiKey',
              name: 'X-API-Key',
              in: 'header',
            },
          },
        },
        paths: {
          '/api/v1/x/tweets/search': {
            get: {
              operationId: 'searchTweets',
              summary: 'Search recent public posts',
              parameters: [
                {
                  name: 'q',
                  in: 'query',
                  required: true,
                  schema: { type: 'string', minLength: 1 },
                },
                {
                  name: 'limit',
                  in: 'query',
                  schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                },
              ],
              responses: {
                '200': {
                  description: 'Search results',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['data'],
                        properties: {
                          data: {
                            type: 'array',
                            items: {
                              type: 'object',
                              required: ['id', 'text'],
                              properties: {
                                id: { type: 'string' },
                                text: { type: 'string' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools();
      const tool = tools[0];

      expect(tools).toHaveLength(1);
      expect(tool).toMatchObject({
        name: 'searchTweets',
        description: 'Search recent public posts',
        metadata: {
          path: '/api/v1/x/tweets/search',
          method: 'get',
          operationId: 'searchTweets',
        },
      });
      expect(tool.metadata.servers?.[0].url).toBe('https://xquik.com');
      expect(tool.metadata.security).toHaveLength(1);
      expect(tool.metadata.security?.[0]).toMatchObject({
        scheme: 'apiKey',
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
      });
      expect(tool.inputSchema.required).toContain('q');
      expect(tool.inputSchema.properties).toHaveProperty('q');
      expect(tool.inputSchema.properties).toHaveProperty('limit');
      expect(tool.mapper).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ inputKey: 'q', key: 'q', type: 'query', required: true }),
          expect.objectContaining({ inputKey: 'limit', key: 'limit', type: 'query' }),
        ]),
      );
      expect(tool.outputSchema?.type).toBe('object');
      expect(tool.outputSchema?.properties).toHaveProperty('data');
    });

    it('should filter deprecated operations', async () => {
      const openapi: OpenAPIDocument = {
        ...simpleOpenAPI,
        paths: {
          '/test': {
            get: {
              operationId: 'test',
              deprecated: true,
              responses: {
                '200': { description: 'OK' },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools({ includeDeprecated: false });

      expect(tools).toHaveLength(0);
    });

    it('should include deprecated operations when configured', async () => {
      const openapi: OpenAPIDocument = {
        ...simpleOpenAPI,
        paths: {
          '/test': {
            get: {
              operationId: 'test',
              deprecated: true,
              responses: {
                '200': { description: 'OK' },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools({ includeDeprecated: true });

      expect(tools).toHaveLength(1);
      expect(tools[0].metadata.deprecated).toBe(true);
    });
  });

  describe('Parameter Conflict Resolution', () => {
    it('should handle parameter name conflicts', async () => {
      const openapi: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{id}': {
            post: {
              operationId: 'createUser',
              parameters: [
                {
                  name: 'id',
                  in: 'path',
                  required: true,
                  schema: { type: 'string' },
                },
                {
                  name: 'id',
                  in: 'query',
                  schema: { type: 'string' },
                },
              ],
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                      },
                    },
                  },
                },
              },
              responses: {
                '200': { description: 'OK' },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users/{id}', 'post');

      // Check that all 'id' parameters are present with different names
      expect(tool.mapper).toHaveLength(4); // path id, query id, body id, body name

      const pathParam = tool.mapper.find((m) => m.type === 'path' && m.key === 'id');
      const queryParam = tool.mapper.find((m) => m.type === 'query' && m.key === 'id');
      const bodyParam = tool.mapper.find((m) => m.type === 'body' && m.key === 'id');

      expect(pathParam).toBeDefined();
      expect(queryParam).toBeDefined();
      expect(bodyParam).toBeDefined();

      // All should have different inputKeys
      expect(pathParam!.inputKey).not.toBe(queryParam!.inputKey);
      expect(pathParam!.inputKey).not.toBe(bodyParam!.inputKey);
      expect(queryParam!.inputKey).not.toBe(bodyParam!.inputKey);
    });
  });

  describe('Response Schema Generation', () => {
    it('should generate output schema for single response', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(simpleOpenAPI);
      const tool = await generator.generateTool('/users/{id}', 'get');

      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.type).toBe('object');
      expect(tool.outputSchema?.properties).toHaveProperty('id');
      expect(tool.outputSchema?.properties).toHaveProperty('name');
    });

    it('should generate union for multiple responses', async () => {
      const openapi: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{id}': {
            get: {
              operationId: 'getUser',
              parameters: [
                {
                  name: 'id',
                  in: 'path',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
              responses: {
                '200': {
                  description: 'Success',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                        },
                      },
                    },
                  },
                },
                '404': {
                  description: 'Not found',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          error: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users/{id}', 'get');

      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.oneOf).toBeDefined();
      expect(tool.outputSchema?.oneOf).toHaveLength(2);
    });

    it('should handle responses with no content', async () => {
      const openapi: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{id}': {
            delete: {
              operationId: 'deleteUser',
              parameters: [
                {
                  name: 'id',
                  in: 'path',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
              responses: {
                '204': {
                  description: 'No content',
                },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users/{id}', 'delete');

      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.type).toBe('null');
    });
  });

  describe('Custom Naming Strategy', () => {
    it('should use custom conflict resolver', async () => {
      const openapi: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{id}': {
            post: {
              operationId: 'createUser',
              parameters: [
                {
                  name: 'id',
                  in: 'path',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                      },
                    },
                  },
                },
              },
              responses: {
                '200': { description: 'OK' },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users/{id}', 'post', {
        namingStrategy: {
          conflictResolver: (name, location, index) => `${location}_${name}_${index}`,
        },
      });

      const pathParam = tool.mapper.find((m) => m.type === 'path');
      const bodyParam = tool.mapper.find((m) => m.type === 'body');

      expect(pathParam?.inputKey).toMatch(/^path_id_\d+$/);
      expect(bodyParam?.inputKey).toMatch(/^body_id_\d+$/);
    });

    it('should use custom tool name generator', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(simpleOpenAPI);
      const tool = await generator.generateTool('/users/{id}', 'get', {
        namingStrategy: {
          conflictResolver: (name, location) => `${location}_${name}`,
          toolNameGenerator: (path, method) => `${method}_${path.replace(/\//g, '_')}`,
        },
      });

      // Custom generator output is still normalized to MCP name rules:
      // `{`/`}` are invalid characters and consecutive underscores collapse.
      expect(tool.name).toBe('get_users_id');
    });
  });

  describe('Metadata Extraction', () => {
    it('should extract security requirements', async () => {
      const openapi: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        components: {
          securitySchemes: {
            apiKey: {
              type: 'apiKey',
              name: 'X-API-Key',
              in: 'header',
            },
          },
        },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              security: [{ apiKey: [] }],
              responses: {
                '200': { description: 'OK' },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get');

      expect(tool.metadata.security).toBeDefined();
      expect(tool.metadata.security).toHaveLength(1);
      expect(tool.metadata.security![0]).toMatchObject({
        scheme: 'apiKey',
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
      });
    });

    it('should extract server information', async () => {
      const openapi: OpenAPIDocument = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        servers: [
          {
            url: 'https://api.example.com',
            description: 'Production server',
          },
        ],
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              responses: {
                '200': { description: 'OK' },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get');

      expect(tool.metadata.servers).toBeDefined();
      expect(tool.metadata.servers).toHaveLength(1);
      expect(tool.metadata.servers![0].url).toBe('https://api.example.com');
    });

    it('should override servers with baseUrl option', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(simpleOpenAPI, {
        baseUrl: 'https://custom.example.com',
      });
      const tool = await generator.generateTool('/users/{id}', 'get');

      expect(tool.metadata.servers).toBeDefined();
      expect(tool.metadata.servers![0].url).toBe('https://custom.example.com');
    });
  });
});

describe('ParameterResolver', () => {
  it('should resolve simple parameters', () => {
    const resolver = new ParameterResolver();
    const { inputSchema, mapper } = resolver.resolve({
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer' },
        },
      ],
    });

    expect(inputSchema.properties).toHaveProperty('id');
    expect(inputSchema.properties).toHaveProperty('limit');
    expect(inputSchema.required).toContain('id');
    expect(mapper).toHaveLength(2);
  });

  it('should handle request body', () => {
    const resolver = new ParameterResolver();
    const { inputSchema, mapper } = resolver.resolve({
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string', format: 'email' },
              },
              required: ['name'],
            },
          },
        },
      },
    });

    expect(inputSchema.properties).toHaveProperty('name');
    expect(inputSchema.properties).toHaveProperty('email');
    expect(inputSchema.required).toContain('name');
    expect(mapper.filter((m) => m.type === 'body')).toHaveLength(2);
  });

  describe('Additional Coverage', () => {
    it('should handle non-object body (array)', () => {
      const resolver = new ParameterResolver();
      const { inputSchema, mapper } = resolver.resolve({
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      });

      expect(inputSchema.properties).toHaveProperty('body');
      expect(mapper.find((m) => m.type === 'body')).toBeDefined();
    });

    it('should include body parameter description', () => {
      const resolver = new ParameterResolver();
      const { inputSchema } = resolver.resolve({
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'The user name' },
                },
              },
            },
          },
        },
      });

      const nameSchema = inputSchema.properties?.['name'] as any;
      expect(nameSchema.description).toBe('The user name');
    });

    it('should handle object body without properties', () => {
      const resolver = new ParameterResolver();
      const { inputSchema, mapper } = resolver.resolve({
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
              },
            },
          },
        },
      });

      // Object without properties falls through to the non-object body path
      expect(inputSchema.properties).toHaveProperty('body');
      expect(mapper.find((m) => m.type === 'body')).toBeDefined();
    });

    it('should handle deprecated parameters', () => {
      const resolver = new ParameterResolver();
      const { inputSchema, mapper } = resolver.resolve({
        parameters: [
          {
            name: 'oldParam',
            in: 'query',
            deprecated: true,
            schema: { type: 'string' },
          },
        ],
      });

      const schema = inputSchema.properties?.['oldParam'] as any;
      expect(schema['deprecated']).toBe(true);
    });

    it('should handle parameters with style and explode', () => {
      const resolver = new ParameterResolver();
      const { inputSchema, mapper } = resolver.resolve({
        parameters: [
          {
            name: 'ids',
            in: 'query',
            style: 'form',
            explode: true,
            schema: { type: 'array', items: { type: 'string' } },
          },
        ],
      });

      const param = mapper.find((m) => m.inputKey === 'ids');
      expect(param?.style).toBe('form');
      expect(param?.explode).toBe(true);
    });

    it('should handle form-urlencoded content type', () => {
      const resolver = new ParameterResolver();
      const { inputSchema, mapper } = resolver.resolve({
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                properties: {
                  username: { type: 'string' },
                },
              },
            },
          },
        },
      });

      expect(inputSchema.properties).toHaveProperty('username');
    });

    it('should handle multipart/form-data content type', () => {
      const resolver = new ParameterResolver();
      const { inputSchema, mapper } = resolver.resolve({
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  file: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
      });

      expect(inputSchema.properties).toHaveProperty('file');
    });

    it('should handle security requirements with includeSecurityInInput', () => {
      const resolver = new ParameterResolver();
      const securityRequirements = [
        { scheme: 'bearerAuth', type: 'http' as const },
        { scheme: 'apiKey', type: 'apiKey' as const, name: 'X-API-Key', in: 'header' as const },
        { scheme: 'oauth2', type: 'oauth2' as const, scopes: ['read', 'write'] },
      ];

      const { inputSchema, mapper } = resolver.resolve({ parameters: [] }, undefined, securityRequirements, true);

      expect(inputSchema.properties).toHaveProperty('bearerAuth');
      expect(inputSchema.properties).toHaveProperty('apiKey');
      expect(inputSchema.properties).toHaveProperty('oauth2');
      expect(inputSchema.required).toContain('bearerAuth');
    });

    it('should handle security requirements without includeSecurityInInput', () => {
      const resolver = new ParameterResolver();
      const securityRequirements = [{ scheme: 'bearerAuth', type: 'http' as const }];

      const { inputSchema, mapper } = resolver.resolve({ parameters: [] }, undefined, securityRequirements, false);

      // Should add to mapper but not to inputSchema
      expect(inputSchema.properties?.['bearerAuth']).toBeUndefined();
      expect(mapper.find((m) => m.security?.scheme === 'bearerAuth')).toBeDefined();
    });

    it('should handle HTTP security with bearerFormat', () => {
      const resolver = new ParameterResolver();
      const securityRequirements = [
        { scheme: 'jwt', type: 'http' as const, httpScheme: 'bearer', bearerFormat: 'JWT' },
      ];

      const { inputSchema, mapper } = resolver.resolve({ parameters: [] }, undefined, securityRequirements, true);

      const jwtSchema = inputSchema.properties?.['jwt'] as any;
      expect(jwtSchema.description).toContain('JWT');
    });

    it('should handle unknown security type', () => {
      const resolver = new ParameterResolver();
      const securityRequirements = [{ scheme: 'mutualTLS', type: 'mutualTLS' as const }];

      const { mapper } = resolver.resolve({ parameters: [] }, undefined, securityRequirements, true);

      // Unknown type should be skipped
      expect(mapper.find((m) => m.security?.scheme === 'mutualTLS')).toBeUndefined();
    });

    it('should handle openIdConnect security type', () => {
      const resolver = new ParameterResolver();
      const securityRequirements = [{ scheme: 'oidc', type: 'openIdConnect' as const, scopes: ['openid', 'profile'] }];

      const { inputSchema, mapper } = resolver.resolve({ parameters: [] }, undefined, securityRequirements, true);

      const oidcSchema = inputSchema.properties?.['oidc'] as any;
      expect(oidcSchema.description).toContain('openid, profile');
    });

    it('should handle requestBody with boolean schema (true)', () => {
      const resolver = new ParameterResolver();
      const { inputSchema } = resolver.resolve({
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: true,
            },
          },
        },
      } as any);

      // boolean schema is not an object, so extractBodyParameters returns early
      expect(Object.keys(inputSchema.properties ?? {})).toHaveLength(0);
    });

    it('should handle non-required body with required fields', () => {
      const resolver = new ParameterResolver();
      const { inputSchema } = resolver.resolve({
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string' },
                  age: { type: 'integer' },
                },
              },
            },
          },
        },
      });

      // requestBody is not required, so even required fields should not be in top-level required
      expect(inputSchema.required ?? []).not.toContain('name');
    });

    it('should handle apiKey security without name or in fields', () => {
      const resolver = new ParameterResolver();
      const securityRequirements = [{
        scheme: 'myApiKey',
        type: 'apiKey' as const,
      }];

      const { mapper } = resolver.resolve({ parameters: [] }, undefined, securityRequirements, true);

      const secMapper = mapper.find((m) => m.security?.scheme === 'myApiKey');
      expect(secMapper).toBeDefined();
    });

    it('should handle parameter without schema (defaults to string)', () => {
      const resolver = new ParameterResolver();
      const { inputSchema } = resolver.resolve({
        parameters: [
          {
            name: 'q',
            in: 'query',
          },
        ],
      });

      const qSchema = inputSchema.properties?.['q'] as any;
      expect(qSchema.type).toBe('string');
    });

    it('should default required to false for query params without required field', () => {
      const resolver = new ParameterResolver();
      const { inputSchema } = resolver.resolve({
        parameters: [
          {
            name: 'filter',
            in: 'query',
            schema: { type: 'string' },
          },
        ],
      });

      expect(inputSchema.required ?? []).not.toContain('filter');
    });

    it('should handle oauth2 security with empty scopes', () => {
      const resolver = new ParameterResolver();
      const securityRequirements = [{
        scheme: 'oauth2',
        type: 'oauth2' as const,
        scopes: [],
      }];

      const { inputSchema } = resolver.resolve({ parameters: [] }, undefined, securityRequirements, true);

      const oauthSchema = inputSchema.properties?.['oauth2'] as any;
      expect(oauthSchema.description).not.toContain('scopes:');
    });

    it('should throw when request body has empty content', () => {
      const resolver = new ParameterResolver();
      expect(() => resolver.resolve({
        requestBody: {
          required: true,
          content: {},
        },
      })).toThrow('No content type available in request body');
    });

    it('should use fallback content type when none match preferences', () => {
      const resolver = new ParameterResolver();
      const { inputSchema, mapper } = resolver.resolve({
        requestBody: {
          required: true,
          content: {
            'application/custom-type': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'string' },
                },
              },
            },
          },
        },
      });

      expect(inputSchema.properties).toHaveProperty('data');
    });
  });
});

describe('OpenAPIToolGenerator - Additional Coverage', () => {
  describe('Operation Filtering', () => {
    it('should filter by includeOperations', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/a': {
            get: {
              operationId: 'opA',
              responses: { '200': { description: 'OK' } },
            },
          },
          '/b': {
            get: {
              operationId: 'opB',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools({ includeOperations: ['opA'] });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('opA');
    });

    it('should filter by excludeOperations', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/a': {
            get: {
              operationId: 'opA',
              responses: { '200': { description: 'OK' } },
            },
          },
          '/b': {
            get: {
              operationId: 'opB',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools({ excludeOperations: ['opA'] });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('opB');
    });

    it('should filter by custom filterFn', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              tags: ['users'],
              responses: { '200': { description: 'OK' } },
            },
          },
          '/admin': {
            get: {
              operationId: 'getAdmin',
              tags: ['admin'],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools({
        filterFn: (op) => op.tags?.includes('users') ?? false,
      });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('getUsers');
    });

    it('should include operation when filterFn returns true', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              responses: { '200': { description: 'OK' } },
            },
          },
          '/admin': {
            get: {
              operationId: 'getAdmin',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools({
        filterFn: () => true,
      });

      expect(tools).toHaveLength(2);
    });
  });

  describe('Tool Name Generation', () => {
    it('should generate name from path when operationId is missing', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{userId}/posts': {
            get: {
              parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools();

      expect(tools[0].name).toMatch(/^get_users_By_userId_posts$/);
    });
  });

  describe('Security Requirements Extraction', () => {
    it('should extract HTTP bearer authentication with bearerFormat', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'JWT Bearer token',
            },
          },
        },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              security: [{ bearerAuth: [] }],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get');

      expect(tool.metadata.security).toBeDefined();
      expect(tool.metadata.security![0].httpScheme).toBe('bearer');
      expect(tool.metadata.security![0].bearerFormat).toBe('JWT');
      expect(tool.metadata.security![0].description).toBe('JWT Bearer token');
    });

    it('should handle security reference object', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        components: {
          securitySchemes: {
            refAuth: {
              $ref: '#/components/securitySchemes/otherAuth',
            },
            otherAuth: {
              type: 'http',
              scheme: 'bearer',
            },
          },
        },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              security: [{ refAuth: [] }],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get');

      // Should handle reference with default type
      expect(tool.metadata.security).toBeDefined();
      expect(tool.metadata.security![0].type).toBe('http');
    });

    it('should use global security when operation security is not defined', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        security: [{ apiKey: [] }],
        components: {
          securitySchemes: {
            apiKey: {
              type: 'apiKey',
              name: 'X-API-Key',
              in: 'header',
            },
          },
        },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get');

      expect(tool.metadata.security).toBeDefined();
      expect(tool.metadata.security![0].type).toBe('apiKey');
    });
  });

  describe('Metadata Extraction', () => {
    it('should extract external docs', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              externalDocs: {
                url: 'https://docs.example.com/users',
                description: 'User API documentation',
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get');

      expect(tool.metadata.externalDocs).toBeDefined();
      expect(tool.metadata.externalDocs?.url).toBe('https://docs.example.com/users');
    });

    it('should extract x-frontmcp extension', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              'x-frontmcp': {
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                },
                cache: {
                  ttl: 60,
                },
              },
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get');

      expect(tool.metadata.frontmcp).toBeDefined();
      expect(tool.metadata.frontmcp?.annotations?.readOnlyHint).toBe(true);
      expect(tool.metadata.frontmcp?.cache?.ttl).toBe(60);
    });

    it('should extract response status codes from oneOf', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              responses: {
                '200': {
                  description: 'OK',
                  content: { 'application/json': { schema: { type: 'object' } } },
                },
                '404': {
                  description: 'Not Found',
                  content: { 'application/json': { schema: { type: 'object' } } },
                },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get', { includeAllResponses: true });

      expect(tool.metadata.responseStatusCodes).toBeDefined();
      expect(tool.metadata.responseStatusCodes).toContain(200);
      expect(tool.metadata.responseStatusCodes).toContain(404);
    });

    it('should use operation servers over document servers', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              servers: [{ url: 'https://special.example.com', description: 'Special server' }],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tool = await generator.generateTool('/users', 'get');

      expect(tool.metadata.servers).toBeDefined();
      expect(tool.metadata.servers![0].url).toBe('https://special.example.com');
    });
  });

  describe('Path Parameters Handling', () => {
    it('should handle path-level parameters', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users/{id}': {
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' },
              },
            ],
            get: {
              operationId: 'getUser',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      // Use validate: false since path-level params aren't checked by the simple validator
      const generator = await OpenAPIToolGenerator.fromJSON(openapi, { validate: false });
      const tool = await generator.generateTool('/users/{id}', 'get');

      expect(tool.mapper).toHaveLength(1);
      expect(tool.mapper[0].key).toBe('id');
      expect(tool.mapper[0].type).toBe('path');
    });

    it('should skip path with $ref', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/ref': { $ref: '#/components/pathItems/refPath' },
          '/normal': {
            get: {
              operationId: 'normalOp',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
        components: {
          pathItems: {
            refPath: {
              get: {
                operationId: 'refOp',
                responses: { '200': { description: 'OK' } },
              },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi, { dereference: false });
      const tools = await generator.generateTools();

      // With dereference: false, the $ref path should be skipped
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('normalOp');
    });
  });

  describe('Error Handling', () => {
    it('should throw error when operation not found', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);

      await expect(generator.generateTool('/users', 'post')).rejects.toThrow('Operation not found');
    });

    it('should throw error when no paths defined', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi, { validate: false });

      await expect(generator.generateTool('/users', 'get')).rejects.toThrow('No paths defined');
    });

    it('should return empty tools when no paths', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi, { validate: false });
      const tools = await generator.generateTools();

      expect(tools).toEqual([]);
    });

    it('should warn and continue when tool generation fails', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } } },
        paths: {
          '/users': {
            // `security` must be a list: with schemes defined, this tool fails
            get: { operationId: 'getUsers', security: { token: [] }, responses: { '200': { description: 'OK' } } },
            post: { operationId: 'createUser', responses: { '200': { description: 'OK' } } },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools();

      expect(tools.map((t) => t.name)).toEqual(['createUser']);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to generate tool for GET /users:',
        '/paths/~1users/get/security must be an array of Security Requirement Objects, found an object',
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Validation', () => {
    it('should validate document and return result', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        paths: {
          '/users': {
            get: {
              operationId: 'getUsers',
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const result = await generator.validate();

      expect(result.valid).toBe(true);
    });

    it('should throw ParseError for invalid document during initialization', async () => {
      const invalidOpenapi = {
        openapi: '2.0.0', // Invalid version
        info: { title: 'Test', version: '1.0.0' },
        paths: {},
      };

      const generator = await OpenAPIToolGenerator.fromJSON(invalidOpenapi);

      await expect(generator.generateTools()).rejects.toThrow(ParseError);
    });

    it('should validate dereferenced document so $ref parameters pass validation', async () => {
      const openapi = {
        openapi: '3.0.0',
        info: { title: 'Test', version: '1.0.0' },
        components: {
          parameters: {
            UserId: {
              name: 'userId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          },
        },
        paths: {
          '/users/{userId}': {
            get: {
              operationId: 'getUser',
              parameters: [{ $ref: '#/components/parameters/UserId' }],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      };

      // With validate: true (default), this should pass because
      // dereferencing resolves the $ref before validation runs
      const generator = await OpenAPIToolGenerator.fromJSON(openapi);
      const tools = await generator.generateTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('getUser');
    });
  });
});

describe('ResponseBuilder', () => {
  it('should build schema from single response', () => {
    const builder = new ResponseBuilder();
    const schema = builder.build({
      '200': {
        description: 'Success',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
            },
          },
        },
      },
    });

    expect(schema).toBeDefined();
    expect(schema?.type).toBe('object');
    expect(schema?.properties).toHaveProperty('id');
  });

  it('should prefer specified status codes', () => {
    const builder = new ResponseBuilder({
      preferredStatusCodes: [201],
      includeAllResponses: false,
    });

    const schema = builder.build({
      '200': {
        description: 'OK',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { status: { type: 'string' } } },
          },
        },
      },
      '201': {
        description: 'Created',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      },
    });

    expect(schema).toBeDefined();
    expect((schema as any)['x-status-code']).toBe(201);
    expect(schema?.properties).toHaveProperty('id');
  });

  it('should create union for multiple responses', () => {
    const builder = new ResponseBuilder({ includeAllResponses: true });
    const schema = builder.build({
      '200': {
        description: 'Success',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { data: { type: 'string' } } },
          },
        },
      },
      '400': {
        description: 'Error',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { error: { type: 'string' } } },
          },
        },
      },
    });

    expect(schema?.oneOf).toBeDefined();
    expect(schema?.oneOf).toHaveLength(2);
  });
});

describe('SSRF Prevention - $ref resolution security', () => {
  let derefSpy: jest.SpyInstance;

  beforeEach(() => {
    // Mock the resolver: these tests inspect the SSRF options passed to
    // `$RefParser.dereference` (the `canRead`/resolve config) — they must not
    // perform a real external fetch. Returning the doc unchanged captures the
    // options without resolving. (Error-handling tests override per-call with
    // `mockRejectedValueOnce`.)
    derefSpy = jest
      .spyOn(
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('@apidevtools/json-schema-ref-parser').default,
        'dereference',
      )
      .mockImplementation(async (doc: unknown) => doc);
  });

  afterEach(() => {
    derefSpy.mockRestore();
  });

  // SSRF protection applies only to EXTERNAL `$ref`s — so this fixture carries
  // one, which routes dereference through `$RefParser` (internal-only docs use
  // the dependency-free dereferencer and never touch `$RefParser`).
  const minimalSpec: OpenAPIDocument = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: {
      '/test': {
        get: {
          operationId: 'getTest',
          summary: 'test',
          responses: { '200': { description: 'OK' } },
        },
      },
    },
    components: {
      schemas: {
        External: { $ref: 'https://api.example.com/schemas/external.json' },
      },
    },
  };

  it('should block file:// protocol by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const callArgs = derefSpy.mock.calls[0];
    const options = callArgs[1];
    expect(options?.resolve?.file).toBe(false);
  });

  it('should pass canRead filter for http resolver by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const callArgs = derefSpy.mock.calls[0];
    const options = callArgs[1];
    expect(options?.resolve?.http?.canRead).toBeInstanceOf(Function);
  });

  it('should allow external HTTPS refs to public hosts by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'https://api.example.com/schemas/user.json' })).toBe(true);
  });

  it('should allow external HTTP refs to public hosts by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'http://api.example.com/schemas/user.json' })).toBe(true);
  });

  it('should block cloud metadata endpoint (169.254.169.254) by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' })).toBe(false);
  });

  it('should block localhost by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'http://localhost/admin' })).toBe(false);
    expect(canRead({ url: 'http://127.0.0.1/admin' })).toBe(false);
  });

  it('should block private IP ranges by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'http://10.0.0.1/internal' })).toBe(false);
    expect(canRead({ url: 'http://172.16.0.1/internal' })).toBe(false);
    expect(canRead({ url: 'http://192.168.1.1/internal' })).toBe(false);
  });

  it('should block Google cloud metadata hostname by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'http://metadata.google.internal/computeMetadata/v1/' })).toBe(false);
  });

  it('should disable redirect-following on the http resolver (SSRF redirect-bypass guard)', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    // redirects:0 prevents the resolver from following a 3xx to a blocked target
    // without re-running canRead.
    expect(derefSpy.mock.calls[0][1]?.resolve?.http?.redirects).toBe(0);
  });

  it('should provide an SSRF-safe async read for the http resolver (DNS-validated $ref fetch)', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    // The custom `read` performs the actual $ref fetch through `safeFetch`,
    // which resolves DNS and rejects names mapping to internal addresses —
    // closing the `127.0.0.1.nip.io` bypass that the sync `canRead` can't catch.
    expect(derefSpy.mock.calls[0][1]?.resolve?.http?.read).toBeInstanceOf(Function);
  });

  it('should block IPv4-mapped IPv6 to cloud metadata / private ranges', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    // Dotted-quad and hex forms of ::ffff:169.254.169.254 (URL normalizes the
    // dotted form to the hex form) must both be blocked.
    expect(canRead({ url: 'http://[::ffff:169.254.169.254]/latest/meta-data/' })).toBe(false);
    expect(canRead({ url: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/' })).toBe(false);
    // IPv4-mapped private range too.
    expect(canRead({ url: 'http://[::ffff:10.0.0.1]/internal' })).toBe(false);
    // A mapped PUBLIC address is still allowed (no over-blocking).
    expect(canRead({ url: 'http://[::ffff:8.8.8.8]/schema.json' })).toBe(true);
  });

  it('should allow file:// when explicitly in allowedProtocols', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      refResolution: { allowedProtocols: ['file', 'http', 'https'] },
    });
    await generator.generateTools();

    const options = derefSpy.mock.calls[0][1];
    // Not blocked: `$RefParser`'s own file resolver, its `read` wrapped to report failures in order
    expect(options?.resolve?.file).toEqual({ read: expect.any(Function) });
  });

  it('should restrict to allowedHosts when configured', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      refResolution: { allowedHosts: ['schemas.example.com'] },
    });
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'https://schemas.example.com/user.json' })).toBe(true);
    expect(canRead({ url: 'https://evil.com/schema.json' })).toBe(false);
  });

  it('should match allowedHosts / blockedHosts regardless of case and trailing root dots', async () => {
    const allowGen = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      refResolution: { allowedHosts: ['Schemas.Example.com.'] },
    });
    await allowGen.generateTools();
    const allowCanRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(allowCanRead({ url: 'https://schemas.example.com/user.json' })).toBe(true);
    expect(allowCanRead({ url: 'https://schemas.example.com./user.json' })).toBe(true);
    expect(allowCanRead({ url: 'https://schemas.example.org/user.json' })).toBe(false);

    const blockGen = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      refResolution: { blockedHosts: ['Evil.com'] },
    });
    await blockGen.generateTools();
    const blockCanRead = derefSpy.mock.calls[1][1]?.resolve?.http?.canRead;
    expect(blockCanRead({ url: 'https://evil.com/schema.json' })).toBe(false);
    expect(blockCanRead({ url: 'https://evil.com./schema.json' })).toBe(false);
    expect(blockCanRead({ url: 'https://EVIL.COM../schema.json' })).toBe(false);
    expect(blockCanRead({ url: 'https://good.com/schema.json' })).toBe(true);
  });

  it('should support exotic protocols in allowedProtocols', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      refResolution: { allowedProtocols: ['https', 'ftp'] },
    });
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'https://example.com/schema.json' })).toBe(true);
    expect(canRead({ url: 'ftp://example.com/schema.json' })).toBe(true);
    expect(canRead({ url: 'http://example.com/schema.json' })).toBe(false);
  });

  it('should block custom blockedHosts', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      refResolution: { blockedHosts: ['evil.com', 'malicious.io'] },
    });
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'https://evil.com/schema.json' })).toBe(false);
    expect(canRead({ url: 'https://malicious.io/schema.json' })).toBe(false);
    expect(canRead({ url: 'https://good.com/schema.json' })).toBe(true);
  });

  it('should allow internal IPs when allowInternalIPs is true', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      refResolution: { allowInternalIPs: true },
    });
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'http://169.254.169.254/latest/meta-data/' })).toBe(true);
    expect(canRead({ url: 'http://127.0.0.1/admin' })).toBe(true);
    expect(canRead({ url: 'http://10.0.0.1/internal' })).toBe(true);
  });

  it('should disable all external resolution when allowedProtocols is empty', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      refResolution: { allowedProtocols: [] },
    });
    await generator.generateTools();

    const options = derefSpy.mock.calls[0][1];
    expect(options?.resolve?.external).toBe(false);
  });

  it('should still resolve internal #/ refs with default settings', async () => {
    const specWithInternalRef: OpenAPIDocument = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            summary: 'test',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/TestResponse' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          TestResponse: {
            type: 'object',
            properties: { id: { type: 'string' } },
          },
        },
      },
    };

    // Don't spy - let actual dereference run to verify internal refs work
    derefSpy.mockRestore();
    const generator = await OpenAPIToolGenerator.fromJSON(specWithInternalRef);
    const tools = await generator.generateTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema).toBeDefined();
  });

  it('should still skip all dereferencing when dereference: false', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      dereference: false,
    });
    await generator.generateTools();

    expect(derefSpy).not.toHaveBeenCalled();
  });

  it('should return false for malformed URLs', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await generator.generateTools();

    const canRead = derefSpy.mock.calls[0][1]?.resolve?.http?.canRead;
    expect(canRead({ url: 'not-a-valid-url' })).toBe(false);
    expect(canRead({ url: '' })).toBe(false);
  });

  it('should disable http resolver when only file protocol is allowed', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec, {
      refResolution: { allowedProtocols: ['file'] },
    });
    await generator.generateTools();

    const options = derefSpy.mock.calls[0][1];
    expect(options?.resolve?.http).toBe(false);
    expect(options?.resolve?.external).toBe(true);
  });

  it('should throw ParseError when dereference fails', async () => {
    derefSpy.mockRejectedValueOnce(new Error('Circular $ref detected'));

    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await expect(generator.generateTools()).rejects.toThrow('Failed to dereference OpenAPI document');
  });

  it('should handle non-Error thrown during dereference', async () => {
    derefSpy.mockRejectedValueOnce('string dereference error');

    const generator = await OpenAPIToolGenerator.fromJSON(minimalSpec);
    await expect(generator.generateTools()).rejects.toThrow('string dereference error');
  });

  it('should handle security with reference object and dereference disabled', async () => {
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      components: {
        securitySchemes: {
          refAuth: {
            $ref: '#/components/securitySchemes/otherAuth',
          },
        },
      },
      paths: {
        '/users': {
          get: {
            operationId: 'getUsers',
            security: [{ refAuth: [] }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const generator = await OpenAPIToolGenerator.fromJSON(openapi, { dereference: false });
    const tool = await generator.generateTool('/users', 'get');

    // With dereference disabled, the $ref is not resolved, so it hits the reference fallback
    expect(tool.metadata.security).toBeDefined();
    expect(tool.metadata.security![0].type).toBe('http');
  });

  it('should return empty security when no securitySchemes defined', async () => {
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/users': {
          get: {
            operationId: 'getUsers',
            security: [{ apiKey: [] }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const generator = await OpenAPIToolGenerator.fromJSON(openapi);
    const tool = await generator.generateTool('/users', 'get');

    expect(tool.metadata.security).toEqual([]);
  });

  it('should handle apiKey securityScheme with invalid in value', async () => {
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'X-Key',
            in: 'invalid-location',
          },
        },
      },
      paths: {
        '/test': {
          get: {
            operationId: 'test',
            security: [{ apiKey: [] }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const generator = await OpenAPIToolGenerator.fromJSON(openapi, { dereference: false });
    const tool = await generator.generateTool('/test', 'get');

    expect(tool.metadata.security![0].in).toBeUndefined();
  });

  it('should handle http securityScheme without scheme property', async () => {
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      components: {
        securitySchemes: {
          auth: {
            type: 'http',
          },
        },
      },
      paths: {
        '/test': {
          get: {
            operationId: 'test',
            security: [{ auth: [] }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const generator = await OpenAPIToolGenerator.fromJSON(openapi, { dereference: false });
    const tool = await generator.generateTool('/test', 'get');

    expect(tool.metadata.security![0].type).toBe('http');
    expect(tool.metadata.security![0].httpScheme).toBeUndefined();
  });

  it('should warn and continue when generateTool fails for an operation', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/test': {
          get: {
            operationId: 'test',
            responses: { '200': { description: 'OK' } },
          },
          // post has no responses, which causes an error during validation
          post: {
            operationId: 'createTest',
          },
        },
      },
    };

    const generator = await OpenAPIToolGenerator.fromJSON(openapi, { validate: false });
    const tools = await generator.generateTools();

    // Should have at least one tool (get) and warned about the other
    expect(tools.length).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });
});

describe('Worker-safe dereference (internal $refs without $RefParser)', () => {
  const internalRefSpec: OpenAPIDocument = {
    openapi: '3.0.0',
    info: { title: 'Internal', version: '1.0.0' },
    paths: {
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          summary: 'Get a user',
          parameters: [{ $ref: '#/components/parameters/UserId' }],
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
            },
          },
        },
      },
    },
    components: {
      parameters: {
        UserId: { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      },
      schemas: {
        User: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
      },
    },
  };

  it('resolves internal $refs WITHOUT invoking $RefParser (V8-isolate safe)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const spy = jest.spyOn(require('@apidevtools/json-schema-ref-parser').default, 'dereference');
    const generator = await OpenAPIToolGenerator.fromJSON(internalRefSpec);
    const tools = await generator.generateTools();

    // The whole point: no Node-coupled $RefParser on the internal-only path.
    expect(spy).not.toHaveBeenCalled();

    // …and the internal $refs were still resolved (param + response schema).
    const tool = tools.find((t) => t.metadata.operationId === 'getUser');
    expect(tool).toBeDefined();
    expect((tool!.inputSchema as { properties?: Record<string, unknown> }).properties?.['id']).toBeDefined();
    spy.mockRestore();
  });

  it('resolves circular internal $refs to a shared reference (no infinite recursion)', async () => {
    const circular: OpenAPIDocument = {
      openapi: '3.0.0',
      info: { title: 'Circular', version: '1.0.0' },
      paths: {
        '/node': {
          get: {
            operationId: 'getNode',
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: { value: { type: 'string' }, next: { $ref: '#/components/schemas/Node' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(circular);
    // The property this locks: the dependency-free dereferencer resolves a
    // self-referential `$ref` to a shared object instead of recursing forever —
    // so generation COMPLETES (returns an array) rather than hanging or throwing.
    const tools = await generator.generateTools();
    expect(Array.isArray(tools)).toBe(true);
  });
});

describe('External $ref resolution over the SSRF-safe pinned transport', () => {
  let handler: LoopbackHandler;
  const loopback = createLoopbackServer(() => handler);
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await loopback.listen();
  });

  afterAll(async () => {
    await loopback.close();
  });

  const specWithRef = (refUrl: string) => ({
    openapi: '3.0.0',
    info: { title: 'Ref API', version: '1.0.0' },
    paths: {
      '/thing': {
        get: {
          operationId: 'getThing',
          parameters: [{ name: 'q', in: 'query', schema: { $ref: refUrl } }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });

  it('fetches an external $ref through safeFetch and inlines the resolved schema', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'string', maxLength: 42 }));
    };
    const generator = await OpenAPIToolGenerator.fromJSON(specWithRef(`${baseUrl}/schema.json`), {
      refResolution: { allowInternalIPs: true },
      validate: false,
    });
    const tools = await generator.generateTools();
    expect(tools).toHaveLength(1);
    expect(JSON.stringify(tools[0].inputSchema)).toContain('42'); // the resolved maxLength
  });

  it('throws when the external $ref responds non-OK', async () => {
    handler = (_req, res) => {
      res.writeHead(404, 'Not Found');
      res.end();
    };
    const generator = await OpenAPIToolGenerator.fromJSON(specWithRef(`${baseUrl}/missing.json`), {
      refResolution: { allowInternalIPs: true },
      validate: false,
    });
    await expect(generator.generateTools()).rejects.toThrow(/dereference/i);
  });
});

describe('DNS rebinding against spec and external $ref fetches', () => {
  const loopback = createLoopbackServer(() => (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'string' }));
  });
  let reboundOrigin: string;

  beforeAll(async () => {
    const port = new URL(await loopback.listen()).port;
    reboundOrigin = `http://rebind.attacker.invalid:${port}`;
  });

  afterAll(async () => {
    await loopback.close();
  });

  beforeEach(() => {
    jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '203.0.113.7', family: 4 }] as never);
    jest
      .spyOn(dns, 'lookup')
      .mockImplementation(makePinnedLookup([{ address: '127.0.0.1', family: 4 }]) as unknown as typeof dns.lookup);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    loopback.reset();
  });

  it('fromURL never reaches the address a connect-time lookup would return', async () => {
    await expect(OpenAPIToolGenerator.fromURL(`${reboundOrigin}/openapi.json`, { timeout: 300 })).rejects.toThrow(
      LoadError,
    );
    expect(loopback.requests).toHaveLength(0);
  });

  it('external $ref resolution never reaches the address a connect-time lookup would return', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.0',
        info: { title: 'Rebind API', version: '1.0.0' },
        paths: {
          '/thing': {
            get: {
              operationId: 'getThing',
              parameters: [{ name: 'q', in: 'query', schema: { $ref: `${reboundOrigin}/schema.json` } }],
              responses: { '200': { description: 'OK' } },
            },
          },
        },
      },
      { timeout: 300, validate: false },
    );
    await expect(generator.generateTools()).rejects.toThrow();
    expect(loopback.requests).toHaveLength(0);
  });
});

describe('includeExamples option', () => {
  const specWithExamples: any = {
    openapi: '3.0.0',
    info: { title: 'Examples API', version: '1.0.0' },
    paths: {
      '/search': {
        get: {
          operationId: 'search',
          parameters: [
            {
              name: 'q',
              in: 'query',
              schema: { type: 'string' },
              example: 'hello world',
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', example: 5 },
              examples: {
                small: { value: 10 },
                large: { value: 100 },
              },
            },
          ],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/import': {
        post: {
          operationId: 'importItems',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'string' } },
                example: ['a', 'b'],
              },
            },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  };

  it('should omit parameter-level examples by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithExamples);
    const tool = await generator.generateTool('/search', 'get');
    const props = (tool.inputSchema as any).properties;

    expect(props.q.examples).toBeUndefined();
  });

  it('should include singular parameter examples when enabled', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithExamples);
    const tool = await generator.generateTool('/search', 'get', { includeExamples: true });
    const props = (tool.inputSchema as any).properties;

    expect(props.q.examples).toEqual(['hello world']);
  });

  it('should prefer the parameter examples map over schema-level example', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithExamples);
    const tool = await generator.generateTool('/search', 'get', { includeExamples: true });
    const props = (tool.inputSchema as any).properties;

    expect(props.limit.examples).toEqual([10, 100]);
  });

  it('should attach media-type examples to non-object whole-body parameters', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithExamples);
    const tool = await generator.generateTool('/import', 'post', { includeExamples: true });
    const props = (tool.inputSchema as any).properties;

    expect(props.body.examples).toEqual([['a', 'b']]);
  });

  it('should still normalize schema-level example to examples without the option', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithExamples);
    const tool = await generator.generateTool('/search', 'get');
    const props = (tool.inputSchema as any).properties;

    // schema-level example on `limit` is normalized by toJsonSchema regardless
    expect(props.limit.examples).toEqual([5]);
  });
});

describe('maxSchemaDepth option', () => {
  const nested = (depth: number): any => {
    let schema: any = { type: 'string' };
    for (let i = 0; i < depth; i++) {
      schema = { type: 'object', properties: { [`level${depth - i}`]: schema } };
    }
    return schema;
  };

  const specWithDeepBody: any = {
    openapi: '3.0.0',
    info: { title: 'Deep API', version: '1.0.0' },
    paths: {
      '/deep': {
        post: {
          operationId: 'createDeep',
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { root: nested(15) } },
              },
            },
          },
          responses: {
            '200': {
              description: 'OK',
              content: { 'application/json': { schema: nested(15) } },
            },
          },
        },
      },
    },
  };

  const depthOf = (schema: any): number => {
    let depth = 0;
    let node = schema;
    while (node && typeof node === 'object' && node.properties) {
      depth++;
      node = Object.values(node.properties)[0];
    }
    return depth;
  };

  it('should truncate schemas deeper than the default of 10', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithDeepBody);
    const tool = await generator.generateTool('/deep', 'post');

    expect(depthOf(tool.inputSchema)).toBeLessThanOrEqual(10);
    expect(depthOf(tool.outputSchema)).toBeLessThanOrEqual(10);
    expect(JSON.stringify(tool.inputSchema)).toContain('Truncated');
    expect(JSON.stringify(tool.outputSchema)).toContain('Truncated');
  });

  it('should respect a custom maxSchemaDepth', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithDeepBody);
    const tool = await generator.generateTool('/deep', 'post', { maxSchemaDepth: 3 });

    expect(depthOf(tool.inputSchema)).toBeLessThanOrEqual(3);
    expect(depthOf(tool.outputSchema)).toBeLessThanOrEqual(3);
  });

  it('should not modify schemas shallower than maxSchemaDepth', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Shallow API', version: '1.0.0' },
      paths: {
        '/shallow': {
          get: {
            operationId: 'getShallow',
            parameters: [{ name: 'id', in: 'query', schema: { type: 'string' } }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/shallow', 'get');

    expect(JSON.stringify(tool.inputSchema)).not.toContain('Truncated');
    expect((tool.inputSchema as any).properties.id).toEqual({
      type: 'string',
      'x-parameter-location': 'query',
    });
  });
});

describe('Tool name normalization (MCP name rules)', () => {
  const specWithOp = (operationId: string | undefined, path = '/things'): any => ({
    openapi: '3.0.0',
    info: { title: 'Naming API', version: '1.0.0' },
    paths: {
      [path]: {
        get: {
          ...(operationId ? { operationId } : {}),
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });

  it('should sanitize invalid characters to underscores', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithOp('get user (v2)!'));
    const tool = await generator.generateTool('/things', 'get');

    expect(tool.name).toBe('get_user_v2');
  });

  it('should leave valid names unchanged', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithOp('billing.invoices-list_v2'));
    const tool = await generator.generateTool('/things', 'get');

    expect(tool.name).toBe('billing.invoices-list_v2');
  });

  it('should truncate long names to 64 chars with a stable hash suffix', async () => {
    const longId = 'veryLongOperationName'.repeat(5); // 105 chars
    const generator = await OpenAPIToolGenerator.fromJSON(specWithOp(longId));
    const tool1 = await generator.generateTool('/things', 'get');
    const tool2 = await generator.generateTool('/things', 'get');

    expect(tool1.name).toHaveLength(64);
    expect(tool1.name).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(tool1.name).toMatch(/_[0-9a-f]{8}$/);
    expect(tool1.name.startsWith('veryLongOperationName')).toBe(true);
    expect(tool2.name).toBe(tool1.name); // deterministic
  });

  it('should clamp maxToolNameLength to the MCP hard limit of 128', async () => {
    const longId = 'x'.repeat(150);
    const generator = await OpenAPIToolGenerator.fromJSON(specWithOp(longId));
    const tool = await generator.generateTool('/things', 'get', { maxToolNameLength: 500 });

    expect(tool.name).toHaveLength(128);
  });

  it('should honor a custom maxToolNameLength', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithOp('someReasonablyLongOperationId'));
    const tool = await generator.generateTool('/things', 'get', { maxToolNameLength: 20 });

    expect(tool.name).toHaveLength(20);
    expect(tool.name).toMatch(/_[0-9a-f]{8}$/);
  });

  it('should fall back to a bare hash for tiny maxToolNameLength values', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithOp('someReasonablyLongOperationId'));
    const tool = await generator.generateTool('/things', 'get', { maxToolNameLength: 8 });

    expect(tool.name).toHaveLength(8);
    expect(tool.name).toMatch(/^[0-9a-f]{8}$/);
  });

  it('should generate a fallback name when sanitization leaves nothing', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithOp('!!!'));
    const tool = await generator.generateTool('/things', 'get');

    expect(tool.name).toMatch(/^tool_[0-9a-f]{8}$/);
  });

  it('should sanitize custom toolNameGenerator output too', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithOp('getThings'));
    const tool = await generator.generateTool('/things', 'get', {
      namingStrategy: {
        conflictResolver: (name) => name,
        toolNameGenerator: () => 'my tool!',
      },
    });

    expect(tool.name).toBe('my_tool');
  });

  it('should deduplicate colliding names with a stable content-derived suffix', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Dup API', version: '1.0.0' },
      paths: {
        '/a': { get: { operationId: 'dupOp', responses: { '200': { description: 'OK' } } } },
        '/b': { post: { operationId: 'dupOp', responses: { '200': { description: 'OK' } } } },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tools = await generator.generateTools();
    const names = tools.map((t) => t.name);

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toBe('dupOp');
    expect(names[1]).toMatch(/^dupOp_[0-9a-f]{8}$/);

    // deterministic across regenerations
    const again = (await generator.generateTools()).map((t) => t.name);
    expect(again).toEqual(names);
  });

  it('should keep deduplicated names within the length cap', async () => {
    const longId = 'duplicatedVeryLongOperationName'.repeat(3); // 93 chars
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Dup API', version: '1.0.0' },
      paths: {
        '/a': { get: { operationId: longId, responses: { '200': { description: 'OK' } } } },
        '/b': { post: { operationId: longId, responses: { '200': { description: 'OK' } } } },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tools = await generator.generateTools();

    expect(tools.map((t) => t.name.length)).toEqual([64, 64]);
    expect(new Set(tools.map((t) => t.name)).size).toBe(2);
  });
});

describe('Tool title and annotations', () => {
  const annotatedSpec: any = {
    openapi: '3.0.0',
    info: { title: 'Annotated API', version: '1.0.0' },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          summary: 'List all items',
          responses: { '200': { description: 'OK' } },
        },
        post: {
          operationId: 'createItem',
          responses: { '201': { description: 'Created' } },
        },
        delete: {
          operationId: 'clearItems',
          responses: { '204': { description: 'Cleared' } },
        },
      },
      '/hidden': {
        get: {
          operationId: 'hiddenOp',
          'x-mcp': false,
          responses: { '200': { description: 'OK' } },
        },
      },
      '/legacy-hidden': {
        get: {
          operationId: 'legacyHiddenOp',
          'x-speakeasy-mcp': { disabled: true },
          responses: { '200': { description: 'OK' } },
        },
      },
      '/customized': {
        post: {
          operationId: 'rawName',
          summary: 'Original summary',
          'x-mcp': {
            name: 'custom name!',
            title: 'Custom Title',
            description: 'Agent-facing description',
            annotations: { destructiveHint: false, idempotentHint: true },
          },
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  };

  it('should infer annotations from the HTTP method by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(annotatedSpec, { validate: false });

    const get = await generator.generateTool('/items', 'get');
    expect(get.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });

    const post = await generator.generateTool('/items', 'post');
    expect(post.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });

    const del = await generator.generateTool('/items', 'delete');
    expect(del.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('should set title from the operation summary', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(annotatedSpec, { validate: false });
    const tool = await generator.generateTool('/items', 'get');

    expect(tool.title).toBe('List all items');
  });

  it('should omit title when there is no summary or override', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(annotatedSpec, { validate: false });
    const tool = await generator.generateTool('/items', 'post');

    expect(tool.title).toBeUndefined();
    expect('title' in tool).toBe(false);
  });

  it('should not infer annotations when inferAnnotations is false', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(annotatedSpec, { validate: false });
    const tool = await generator.generateTool('/items', 'get', { inferAnnotations: false });

    expect(tool.annotations).toBeUndefined();
  });

  it('should keep extension annotations when inference is disabled', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(annotatedSpec, { validate: false });
    const tool = await generator.generateTool('/customized', 'post', { inferAnnotations: false });

    expect(tool.annotations).toEqual({ destructiveHint: false, idempotentHint: true });
  });

  it('should apply extension overrides for name, title, description, and annotations', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(annotatedSpec, { validate: false });
    const tool = await generator.generateTool('/customized', 'post');

    expect(tool.name).toBe('custom_name'); // override still normalized
    expect(tool.title).toBe('Custom Title');
    expect(tool.description).toBe('Agent-facing description');
    // inferred POST annotations with extension overrides merged on top
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('should exclude x-mcp:false and x-speakeasy-mcp disabled operations from generateTools', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(annotatedSpec, { validate: false });
    const tools = await generator.generateTools();
    const names = tools.map((t) => t.name);

    expect(names).not.toContain('hiddenOp');
    expect(names).not.toContain('legacyHiddenOp');
    expect(names).toContain('listItems');
  });
});

describe('Tool annotations with uppercase method argument', () => {
  it('should infer annotations when generateTool receives an uppercase method', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Case API', version: '1.0.0' },
      paths: {
        '/items': { get: { operationId: 'listItems', responses: { '200': { description: 'OK' } } } },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/items', 'GET');

    expect(tool.annotations?.readOnlyHint).toBe(true);
  });
});

describe('Deterministic tool ordering', () => {
  it('should order tools by path, then canonical method order, regardless of spec key order', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Order API', version: '1.0.0' },
      paths: {
        '/zebra': { get: { operationId: 'zebraGet', responses: { '200': { description: 'OK' } } } },
        '/alpha': {
          // post declared before get: canonical method order must win
          post: { operationId: 'alphaPost', responses: { '200': { description: 'OK' } } },
          get: { operationId: 'alphaGet', responses: { '200': { description: 'OK' } } },
        },
        '/mango': { delete: { operationId: 'mangoDelete', responses: { '204': { description: 'OK' } } } },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const names = (await generator.generateTools()).map((t) => t.name);

    expect(names).toEqual(['alphaGet', 'alphaPost', 'mangoDelete', 'zebraGet']);
  });

  it('should produce identical ordering for re-serialized specs with different key order', async () => {
    const opsA: any = {
      '/b': { get: { operationId: 'bGet', responses: { '200': { description: 'OK' } } } },
      '/a': { get: { operationId: 'aGet', responses: { '200': { description: 'OK' } } } },
    };
    const opsB: any = {
      '/a': { get: { operationId: 'aGet', responses: { '200': { description: 'OK' } } } },
      '/b': { get: { operationId: 'bGet', responses: { '200': { description: 'OK' } } } },
    };
    const base = { openapi: '3.0.0', info: { title: 'Order API', version: '1.0.0' } };

    const genA = await OpenAPIToolGenerator.fromJSON({ ...base, paths: opsA } as any);
    const genB = await OpenAPIToolGenerator.fromJSON({ ...base, paths: opsB } as any);

    expect((await genA.generateTools()).map((t) => t.name)).toEqual(
      (await genB.generateTools()).map((t) => t.name),
    );
  });
});

describe('Deep request-body handling', () => {
  const bodySpec = (requestBody: any): any => ({
    openapi: '3.0.0',
    info: { title: 'Body API', version: '1.0.0' },
    paths: {
      '/submit': {
        post: {
          operationId: 'submit',
          requestBody,
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });

  it('should flatten allOf request bodies into named parameters', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        required: true,
        content: {
          'application/json': {
            schema: {
              allOf: [
                { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                { type: 'object', properties: { age: { type: 'integer' } }, required: ['age'] },
              ],
            },
          },
        },
      }),
      { dereference: false },
    );
    const tool = await generator.generateTool('/submit', 'post');
    const props = (tool.inputSchema as any).properties;

    expect(Object.keys(props).sort()).toEqual(['age', 'name']);
    expect((tool.inputSchema as any).required.sort()).toEqual(['age', 'name']);
    expect(tool.mapper.filter((m) => m.type === 'body')).toHaveLength(2);
    expect(tool.mapper.every((m) => !m.wholeBody)).toBe(true);
  });

  it('should merge nested allOf members and direct properties', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        content: {
          'application/json': {
            schema: {
              allOf: [
                {
                  allOf: [{ type: 'object', properties: { deep: { type: 'string' } } }],
                },
                { type: 'object', properties: { shallow: { type: 'boolean' } } },
              ],
              properties: { direct: { type: 'number' } },
            },
          },
        },
      }),
      { dereference: false },
    );
    const tool = await generator.generateTool('/submit', 'post');
    const props = (tool.inputSchema as any).properties;

    expect(Object.keys(props).sort()).toEqual(['deep', 'direct', 'shallow']);
  });

  it('should flatten object bodies that declare properties without an explicit type', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        content: {
          'application/json': {
            schema: { properties: { untyped: { type: 'string' } } },
          },
        },
      }),
    );
    const tool = await generator.generateTool('/submit', 'post');

    expect((tool.inputSchema as any).properties.untyped).toBeDefined();
  });

  it('should keep oneOf union bodies whole with a wholeBody mapper flag', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        required: true,
        content: {
          'application/json': {
            schema: {
              oneOf: [
                { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] },
                { type: 'object', properties: { phone: { type: 'string' } }, required: ['phone'] },
              ],
            },
          },
        },
      }),
      { dereference: false },
    );
    const tool = await generator.generateTool('/submit', 'post');
    const props = (tool.inputSchema as any).properties;
    const bodyMapper = tool.mapper.find((m) => m.type === 'body');

    expect(Object.keys(props)).toEqual(['body']);
    expect(props.body.oneOf).toHaveLength(2);
    expect(bodyMapper?.wholeBody).toBe(true);
    expect(bodyMapper?.required).toBe(true);
  });

  it('should keep anyOf union bodies whole', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        content: {
          'application/json': {
            schema: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          },
        },
      }),
      { dereference: false },
    );
    const tool = await generator.generateTool('/submit', 'post');
    const bodyMapper = tool.mapper.find((m) => m.type === 'body');

    expect((tool.inputSchema as any).properties.body.anyOf).toHaveLength(2);
    expect(bodyMapper?.wholeBody).toBe(true);
  });

  it('should flag array bodies as wholeBody', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        content: {
          'application/json': {
            schema: { type: 'array', items: { type: 'string' } },
          },
        },
      }),
    );
    const tool = await generator.generateTool('/submit', 'post');
    const bodyMapper = tool.mapper.find((m) => m.type === 'body');

    expect(bodyMapper?.wholeBody).toBe(true);
  });

  it('should mark multipart file parts as binary and propagate encoding', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                file: { type: 'string', format: 'binary' },
                caption: { type: 'string' },
              },
              required: ['file'],
            },
            encoding: {
              file: { contentType: 'application/octet-stream' },
            },
          },
        },
      }),
    );
    const tool = await generator.generateTool('/submit', 'post');
    const fileMapper = tool.mapper.find((m) => m.inputKey === 'file');
    const captionMapper = tool.mapper.find((m) => m.inputKey === 'caption');

    expect(fileMapper?.serialization?.contentType).toBe('multipart/form-data');
    expect(fileMapper?.serialization?.binary).toBe(true);
    expect(fileMapper?.serialization?.encoding).toEqual({ file: { contentType: 'application/octet-stream' } });
    expect(fileMapper?.required).toBe(true);
    expect(captionMapper?.serialization?.binary).toBeUndefined();
    expect(captionMapper?.serialization?.encoding).toBeUndefined();
  });

  it('should mark raw binary whole bodies as binary', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        content: {
          'application/octet-stream': {
            schema: { type: 'string', format: 'binary' },
          },
        },
      }),
    );
    const tool = await generator.generateTool('/submit', 'post');
    const bodyMapper = tool.mapper.find((m) => m.type === 'body');

    expect(bodyMapper?.wholeBody).toBe(true);
    expect(bodyMapper?.serialization?.binary).toBe(true);
    expect(bodyMapper?.serialization?.contentType).toBe('application/octet-stream');
  });

  it('should mark OpenAPI 3.1 contentMediaType schemas as binary only when type is omitted', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                // 3.1 raw binary: contentMediaType with NO declared type
                image: { contentMediaType: 'image/png' },
                // base64-encoded content is a string payload, not raw binary
                doc: { type: 'string', contentMediaType: 'text/plain', contentEncoding: 'base64' },
                // an ordinary string that HAPPENS to carry embedded content
                html: { type: 'string', contentMediaType: 'text/html' },
              },
            },
          },
        },
      }),
    );
    const tool = await generator.generateTool('/submit', 'post');

    expect(tool.mapper.find((m) => m.inputKey === 'image')?.serialization?.binary).toBe(true);
    expect(tool.mapper.find((m) => m.inputKey === 'doc')?.serialization?.binary).toBeUndefined();
    expect(tool.mapper.find((m) => m.inputKey === 'html')?.serialization?.binary).toBeUndefined();
  });

  it('should keep required fields contributed by properties-less allOf members', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        required: true,
        content: {
          'application/json': {
            schema: {
              allOf: [
                { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } } },
                { required: ['x'] }, // base-$ref + required-tightening pattern
              ],
            },
          },
        },
      }),
      { dereference: false },
    );
    const tool = await generator.generateTool('/submit', 'post');

    expect((tool.inputSchema as any).required).toEqual(['x']);
  });

  it('should keep the body whole when an allOf member is a union', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        required: true,
        content: {
          'application/json': {
            schema: {
              allOf: [
                { type: 'object', properties: { a: { type: 'string' } } },
                {
                  oneOf: [
                    { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
                    { type: 'object', properties: { c: { type: 'string' } }, required: ['c'] },
                  ],
                },
              ],
            },
          },
        },
      }),
      { dereference: false },
    );
    const tool = await generator.generateTool('/submit', 'post');
    const props = (tool.inputSchema as any).properties;
    const bodyMapper = tool.mapper.find((m) => m.type === 'body');

    // the union constraint survives intact instead of being flattened away
    expect(Object.keys(props)).toEqual(['body']);
    expect(props.body.allOf).toHaveLength(2);
    expect(props.body.allOf[1].oneOf).toHaveLength(2);
    expect(bodyMapper?.wholeBody).toBe(true);
  });

  it('should distribute media-type examples onto flattened body properties', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        content: {
          'application/json': {
            schema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } },
            example: { name: 'Ada' }, // no age key on purpose
          },
        },
      }),
    );
    const tool = await generator.generateTool('/submit', 'post', { includeExamples: true });
    const props = (tool.inputSchema as any).properties;

    expect(props.name.examples).toEqual(['Ada']);
    expect(props.age.examples).toBeUndefined();
  });

  it('should ignore non-object media-type examples for flattened bodies', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      bodySpec({
        content: {
          'application/json': {
            schema: { type: 'object', properties: { name: { type: 'string' } } },
            example: 'not-an-object',
          },
        },
      }),
    );
    const tool = await generator.generateTool('/submit', 'post', { includeExamples: true });

    expect(((tool.inputSchema as any).properties.name as any).examples).toBeUndefined();
  });
});

describe('Whole-body parameters in edge positions', () => {
  it('should keep the wholeBody flag through name-conflict resolution', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Conflict API', version: '1.0.0' },
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            parameters: [{ name: 'body', in: 'query', schema: { type: 'string' } }],
            requestBody: {
              content: {
                'application/json': { schema: { type: 'array', items: { type: 'string' } } },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/things', 'post');

    const bodyEntry = tool.mapper.find((m) => m.type === 'body');
    const queryEntry = tool.mapper.find((m) => m.type === 'query');

    expect(bodyEntry?.wholeBody).toBe(true);
    expect(queryEntry?.wholeBody).toBeUndefined();
    // conflict resolution renamed both sides
    expect(bodyEntry?.inputKey).not.toBe(queryEntry?.inputKey);
  });

  it('should carry the full encoding map on whole-body parameters', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Encoding API', version: '1.0.0' },
      paths: {
        '/upload': {
          post: {
            operationId: 'upload',
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'string' } },
                  encoding: { part: { contentType: 'text/plain' } },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/upload', 'post');
    const bodyEntry = tool.mapper.find((m) => m.type === 'body');

    expect(bodyEntry?.serialization?.encoding).toEqual({ part: { contentType: 'text/plain' } });
  });
});

describe('Collision dedup recheck', () => {
  // replicate the library's FNV-1a suffix so the test can pre-take the renamed slot
  const fnv1aHex = (input: string): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  it('should re-resolve when the deduplicated name is itself already taken', async () => {
    // '/a' pre-takes the exact name that deduping POST /b would produce
    const stolen = `foo_${fnv1aHex('post /b')}`;
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Dup API', version: '1.0.0' },
      paths: {
        '/a': { get: { operationId: stolen, responses: { '200': { description: 'OK' } } } },
        '/b': {
          get: { operationId: 'foo', responses: { '200': { description: 'OK' } } },
          post: { operationId: 'foo', responses: { '200': { description: 'OK' } } },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const names = (await generator.generateTools()).map((t) => t.name);

    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3); // no silent duplicates
    expect(names).toContain(stolen);
    expect(names).toContain('foo');
  });
});

describe('maxSchemaDepth floor', () => {
  it('should clamp maxSchemaDepth 0 to 1 so the root inputSchema keeps its properties', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Floor API', version: '1.0.0' },
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/things', 'get', { maxSchemaDepth: 0 });

    // the mapper lists `id`, so the root schema must still declare it
    expect((tool.inputSchema as any).properties.id).toBeDefined();
    expect((tool.inputSchema as any).required).toEqual(['id']);
  });
});

describe('hasExternalRefs cycle guard', () => {
  // The public API JSON-round-trips documents before this walk (cycles throw,
  // shared refs get duplicated), so the guard is exercised directly: it is the
  // property that keeps the walk terminating on shared/cyclic object graphs.
  const hasExternalRefs = (node: unknown) => (OpenAPIToolGenerator as any).hasExternalRefs(node);

  it('terminates on cyclic documents', () => {
    const node: any = { a: { type: 'string' } };
    node.self = node;

    expect(hasExternalRefs(node)).toBe(false);
  });

  it('visits shared nodes once and still detects external refs elsewhere', () => {
    const shared: any = { $ref: '#/components/schemas/X' };
    expect(hasExternalRefs({ one: shared, two: shared })).toBe(false);

    const cyclic: any = { ref: { $ref: 'https://example.com/schema.json' } };
    cyclic.self = cyclic;
    expect(hasExternalRefs(cyclic)).toBe(true);
  });
});

describe('Tool name hashing uses the raw name', () => {
  const specFor = (operationId: string): any => ({
    openapi: '3.0.0',
    info: { title: 'Raw Hash API', version: '1.0.0' },
    paths: {
      '/things': { get: { operationId, responses: { '200': { description: 'OK' } } } },
    },
  });

  it('should give distinct suffixes to long names differing only by invalid characters', async () => {
    const base = 'y'.repeat(70);
    const genA = await OpenAPIToolGenerator.fromJSON(specFor(`${base}!end`));
    const genB = await OpenAPIToolGenerator.fromJSON(specFor(`${base}?end`));

    const nameA = (await genA.generateTool('/things', 'get')).name;
    const nameB = (await genB.generateTool('/things', 'get')).name;

    // both sanitize to the same base, so only the raw-name hash separates them
    expect(nameA).toHaveLength(64);
    expect(nameB).toHaveLength(64);
    expect(nameA.slice(0, 55)).toBe(nameB.slice(0, 55));
    expect(nameA).not.toBe(nameB);
  });

  it('should use the fallback seed for empty-sanitized names under tiny caps', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specFor('!!!'));
    const tool = await generator.generateTool('/things', 'get', { maxToolNameLength: 8 });

    expect(tool.name).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('Collision dedup exhaustion', () => {
  it('should fail loudly (per-tool) when a tiny cap exhausts the name space', async () => {
    // 17 operations, all colliding, under a 1-char cap: only 16 hex names exist
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 17; i++) {
      paths[`/p${i}`] = { get: { operationId: 'same', responses: { '200': { description: 'OK' } } } };
    }
    const spec: any = { openapi: '3.0.0', info: { title: 'Exhaust API', version: '1.0.0' }, paths };

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
      const tools = await generator.generateTools({ maxToolNameLength: 1 });
      const names = tools.map((t) => t.name);

      // all 16 possible names taken, every emitted name unique, 17th dropped
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBeLessThan(17);
      const messages = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(messages).toContain('name space');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('Curation filtering (Tier 2)', () => {
  const filterSpec: any = {
    openapi: '3.0.0',
    info: { title: 'Filter API', version: '1.0.0' },
    paths: {
      '/users': {
        get: { operationId: 'listUsers', tags: ['users', 'public'], responses: { '200': { description: 'OK' } } },
        post: { operationId: 'createUser', tags: ['users', 'admin'], responses: { '201': { description: 'OK' } } },
      },
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          tags: ['users', 'public'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
        delete: {
          operationId: 'deleteUser',
          tags: ['users', 'admin'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '204': { description: 'OK' } },
        },
      },
      '/admin/settings': {
        get: { operationId: 'getSettings', tags: ['admin'], responses: { '200': { description: 'OK' } } },
      },
      '/health': {
        get: { operationId: 'health', responses: { '200': { description: 'OK' } } },
      },
    },
  };

  const namesFor = async (options: any): Promise<string[]> => {
    const generator = await OpenAPIToolGenerator.fromJSON(filterSpec);
    return (await generator.generateTools(options)).map((t) => t.name);
  };

  it('filters by includeTags / excludeTags', async () => {
    expect(await namesFor({ includeTags: ['public'] })).toEqual(['listUsers', 'getUser']);
    expect(await namesFor({ excludeTags: ['admin'] })).toEqual(['health', 'listUsers', 'getUser']);
  });

  it('filters by includeMethods / excludeMethods', async () => {
    expect(await namesFor({ includeMethods: ['delete'] })).toEqual(['deleteUser']);
    expect(await namesFor({ excludeMethods: ['get'] })).toEqual(['createUser', 'deleteUser']);
  });

  it('filters by path globs', async () => {
    expect(await namesFor({ includePaths: ['/users/*'] })).toEqual(['getUser', 'deleteUser']);
    expect(await namesFor({ excludePaths: ['/admin/**', '/health'] })).toEqual([
      'listUsers',
      'createUser',
      'getUser',
      'deleteUser',
    ]);
  });

  it('glob semantics: * stays within a segment, ** crosses, ? is one char', async () => {
    // /users/* matches /users/{id} but not /users (no trailing segment)
    expect(await namesFor({ includePaths: ['/users/*'] })).not.toContain('listUsers');
    // ** matches everything below
    expect(await namesFor({ includePaths: ['/users/**'] })).toEqual(['getUser', 'deleteUser']);
    // ? matches exactly one character
    expect(await namesFor({ includePaths: ['/healt?'] })).toEqual(['health']);
  });

  it('applies readOnlyOnly as a safety switch', async () => {
    expect(await namesFor({ readOnlyOnly: true })).toEqual(['getSettings', 'health', 'listUsers', 'getUser']);
  });

  it('readOnlyOnly honors extension overrides in both directions', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'RO API', version: '1.0.0' },
      paths: {
        '/reports': {
          // POST that an extension declares read-only (e.g. a search endpoint)
          post: {
            operationId: 'searchReports',
            'x-mcp': { annotations: { readOnlyHint: true } },
            responses: { '200': { description: 'OK' } },
          },
        },
        '/cache': {
          // GET that an extension declares NOT read-only
          get: {
            operationId: 'rotateCache',
            'x-mcp': { annotations: { readOnlyHint: false } },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const names = (await generator.generateTools({ readOnlyOnly: true })).map((t) => t.name);

    expect(names).toEqual(['searchReports']);
  });

  it('combines filters (intersection semantics)', async () => {
    expect(await namesFor({ includeTags: ['users'], includeMethods: ['get'], excludePaths: ['/users/*'] })).toEqual([
      'listUsers',
    ]);
  });

  it('still applies filterFn last', async () => {
    expect(
      await namesFor({ includeTags: ['users'], filterFn: (op: any) => op.operationId !== 'createUser' }),
    ).toEqual(['listUsers', 'getUser', 'deleteUser']);
  });
});

describe('x-mcp precedence across root, path, and operation', () => {
  it('root x-mcp:false makes generation opt-in; path and operation levels re-enable', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'OptIn API', version: '1.0.0' },
      'x-mcp': false,
      paths: {
        '/excluded': {
          get: { operationId: 'excludedByRoot', responses: { '200': { description: 'OK' } } },
        },
        '/path-enabled': {
          'x-mcp': true,
          get: { operationId: 'enabledByPath', responses: { '200': { description: 'OK' } } },
          post: {
            operationId: 'reDisabledByOp',
            'x-mcp': false,
            responses: { '200': { description: 'OK' } },
          },
        },
        '/op-enabled': {
          get: {
            operationId: 'enabledByOp',
            'x-mcp': { enabled: true },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const names = (await generator.generateTools()).map((t) => t.name);

    expect(names).toEqual(['enabledByOp', 'enabledByPath']);
  });

  it('path-level x-mcp:false disables its operations unless the operation re-enables', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'PathOff API', version: '1.0.0' },
      paths: {
        '/internal': {
          'x-mcp': { enabled: false },
          get: { operationId: 'hiddenOp', responses: { '200': { description: 'OK' } } },
          post: { operationId: 'visibleOp', 'x-mcp': true, responses: { '200': { description: 'OK' } } },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const names = (await generator.generateTools()).map((t) => t.name);

    expect(names).toEqual(['visibleOp']);
  });
});

describe('includeSecurityInInput per-scheme selection', () => {
  const securedSpec: any = {
    openapi: '3.0.0',
    info: { title: 'Secured API', version: '1.0.0' },
    security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
    components: {
      securitySchemes: {
        BearerAuth: { type: 'http', scheme: 'bearer' },
        ApiKeyAuth: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      },
    },
    paths: {
      '/data': { get: { operationId: 'getData', responses: { '200': { description: 'OK' } } } },
    },
  };

  it('true puts every scheme in the input schema', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(securedSpec);
    const tool = await generator.generateTool('/data', 'get', { includeSecurityInInput: true });
    const props = Object.keys((tool.inputSchema as any).properties);

    expect(props).toEqual(expect.arrayContaining(['BearerAuth', 'ApiKeyAuth']));
  });

  it('an array selects which schemes appear in input while the mapper keeps all', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(securedSpec);
    const tool = await generator.generateTool('/data', 'get', { includeSecurityInInput: ['ApiKeyAuth'] });
    const props = Object.keys((tool.inputSchema as any).properties);
    const securitySchemes = tool.mapper.filter((m) => m.security).map((m) => m.security!.scheme);

    expect(props).toContain('ApiKeyAuth');
    expect(props).not.toContain('BearerAuth');
    expect((tool.inputSchema as any).required).toEqual(['ApiKeyAuth']);
    expect(securitySchemes).toEqual(expect.arrayContaining(['BearerAuth', 'ApiKeyAuth']));
  });

  it('an empty array behaves like false for the input schema', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(securedSpec);
    const tool = await generator.generateTool('/data', 'get', { includeSecurityInInput: [] });

    expect(Object.keys((tool.inputSchema as any).properties)).toHaveLength(0);
    expect(tool.mapper.filter((m) => m.security)).toHaveLength(2);
  });
});

describe('secureDefaults load preset', () => {
  it('disables external $ref resolution', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Ref API', version: '1.0.0' },
      paths: {
        '/thing': {
          get: {
            operationId: 'getThing',
            parameters: [{ name: 'q', in: 'query', schema: { $ref: 'https://schemas.example.com/q.json' } }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { secureDefaults: true, validate: false });
    const tools = await generator.generateTools();

    // the external ref is left unresolved instead of being fetched
    expect(JSON.stringify(tools[0].inputSchema)).toContain('https://schemas.example.com/q.json');
  });

  it('refuses spec-URL redirects', async () => {
    let redirected = false;
    const handler: LoopbackHandler = (req, res) => {
      if (req.url === '/spec.json') {
        res.writeHead(302, { Location: '/real.json' });
        res.end();
      } else {
        redirected = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} }));
      }
    };
    const loopback = createLoopbackServer(() => handler);
    const baseUrl = await loopback.listen();
    try {
      await expect(
        OpenAPIToolGenerator.fromURL(`${baseUrl}/spec.json`, {
          secureDefaults: true,
          refResolution: { allowInternalIPs: true },
        }),
      ).rejects.toThrow();
      expect(redirected).toBe(false);
    } finally {
      await loopback.close();
    }
  });

  it('lets explicit options win over the preset', async () => {
    const handler: LoopbackHandler = (req, res) => {
      if (req.url === '/spec.json') {
        res.writeHead(302, { Location: '/real.json' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1.0.0' }, paths: {} }));
      }
    };
    const loopback = createLoopbackServer(() => handler);
    const baseUrl = await loopback.listen();
    try {
      const generator = await OpenAPIToolGenerator.fromURL(`${baseUrl}/spec.json`, {
        secureDefaults: true,
        followRedirects: true, // explicit value beats the preset
        refResolution: { allowInternalIPs: true },
      });
      expect(generator).toBeInstanceOf(OpenAPIToolGenerator);
    } finally {
      await loopback.close();
    }
  });
});

describe('Generic tool metadata (McpOpenAPITool<TMeta>)', () => {
  it('lets frameworks extend metadata without casting through unknown', async () => {
    type ExtendedMeta = import('../types').ToolMetadata & { adapterState?: { cached: boolean } };

    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Meta API', version: '1.0.0' },
      paths: { '/x': { get: { operationId: 'getX', responses: { '200': { description: 'OK' } } } } },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const base = await generator.generateTool('/x', 'get');

    // a framework layers its own metadata on top, typed end to end
    const extended: import('../types').McpOpenAPITool<ExtendedMeta> = {
      ...base,
      metadata: { ...base.metadata, adapterState: { cached: true } },
    };

    expect(extended.metadata.adapterState?.cached).toBe(true);
    expect(extended.metadata.path).toBe('/x');
  });
});

describe('secureDefaults per-key refResolution merge', () => {
  it('keeps the external-ref lockdown when refResolution tightens other knobs', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Ref API', version: '1.0.0' },
      paths: {
        '/thing': {
          get: {
            operationId: 'getThing',
            parameters: [{ name: 'q', in: 'query', schema: { $ref: 'https://attacker.example/exfil.json' } }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, {
      secureDefaults: true,
      refResolution: { blockedHosts: ['internal.corp'] }, // tightening, not loosening
      validate: false,
    });
    const tools = await generator.generateTools();

    // the external ref must remain unfetched/unresolved
    expect(JSON.stringify(tools[0].inputSchema)).toContain('attacker.example');
  });

  it('lets an explicit allowedProtocols override the preset', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      { openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} } as any,
      { secureDefaults: true, refResolution: { allowedProtocols: ['https'] } },
    );

    // the normalized options must carry the explicit override verbatim
    expect((generator as any).options.refResolution.allowedProtocols).toEqual(['https']);
    expect((generator as any).options.followRedirects).toBe(false);
  });

  it('treats an explicitly undefined allowedProtocols as unset (lockdown preserved)', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      { openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} } as any,
      // programmatic option building: the key exists but the value is undefined
      { secureDefaults: true, refResolution: { allowedProtocols: undefined } },
    );

    expect((generator as any).options.refResolution.allowedProtocols).toEqual([]);
  });
});

describe('Trimming options (maxProperties, maxDescriptionLength, stripExamples)', () => {
  const trimSpec: any = {
    openapi: '3.0.0',
    info: { title: 'Trim API', version: '1.0.0' },
    paths: {
      '/things': {
        post: {
          operationId: 'createThing',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'A longer-than-ten-chars description', example: 'Ada' },
                    kind: { type: 'string' },
                    extra: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { id: { type: 'string', example: 'x1' } } },
                },
              },
            },
          },
        },
      },
    },
  };

  it('applies all three trims — but never drops mapper-backed root parameters', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(trimSpec);
    const tool = await generator.generateTool('/things', 'post', {
      maxProperties: 2,
      maxDescriptionLength: 10,
      stripExamples: true,
    });
    const input = tool.inputSchema as any;
    const output = tool.outputSchema as any;

    // ROOT input parameters are mapper-backed: all three survive the cap
    expect(Object.keys(input.properties)).toEqual(['name', 'kind', 'extra']);
    expect(input.properties.name.description!.length).toBeLessThanOrEqual(10); // cap INCLUDES the ellipsis
    expect(input.properties.name.examples).toBeUndefined();
    // output schemas trim from the root as usual
    expect(output.properties.id.examples).toBeUndefined();
  });

  it('trims nested objects under root parameters and keeps omission notes intact', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Nested Trim API', version: '1.0.0' },
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      payload: {
                        type: 'object',
                        properties: { a: {}, b: {}, c: {}, d: {} },
                        required: ['a', 'd'],
                      },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/things', 'post', {
      maxProperties: 2,
      maxDescriptionLength: 200,
    });
    const payload = (tool.inputSchema as any).properties.payload;

    expect(Object.keys(payload.properties)).toEqual(['a', 'b']);
    expect(payload.required).toEqual(['a']);
    // caps run BEFORE limitProperties, so the omission note survives intact
    expect(payload.description).toBe('[2 additional properties omitted: exceeds maxProperties]');
  });

  it('leaves schemas untouched when no trim option is set', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(trimSpec);
    const tool = await generator.generateTool('/things', 'post');

    expect(Object.keys((tool.inputSchema as any).properties)).toHaveLength(3);
    expect((tool.inputSchema as any).properties.name.examples).toEqual(['Ada']);
  });
});

describe('Description strategies and response summaries', () => {
  const describedSpec: any = {
    openapi: '3.0.0',
    info: { title: 'Desc API', version: '1.0.0' },
    paths: {
      '/full': {
        get: {
          operationId: 'getFull',
          summary: 'Short summary.',
          description: 'Longer operation description with details.',
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'string' }, name: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/summary-only': {
        get: { operationId: 'getSummaryOnly', summary: 'Only a summary.', responses: { '200': { description: 'OK' } } },
      },
      '/bare': {
        get: { operationId: 'getBare', responses: { '200': { description: 'OK' } } },
      },
    },
  };

  const descriptionFor = async (path: string, options: any = {}): Promise<string> => {
    const generator = await OpenAPIToolGenerator.fromJSON(describedSpec);
    return (await generator.generateTool(path, 'get', options)).description;
  };

  it('summaryOnly (default) prefers the summary', async () => {
    expect(await descriptionFor('/full')).toBe('Short summary.');
    expect(await descriptionFor('/bare')).toBe('GET /bare');
  });

  it('descriptionOnly prefers the description with summary fallback', async () => {
    expect(await descriptionFor('/full', { descriptionStrategy: 'descriptionOnly' })).toBe(
      'Longer operation description with details.',
    );
    expect(await descriptionFor('/summary-only', { descriptionStrategy: 'descriptionOnly' })).toBe('Only a summary.');
    expect(await descriptionFor('/bare', { descriptionStrategy: 'descriptionOnly' })).toBe('GET /bare');
  });

  it('combined joins summary and description', async () => {
    expect(await descriptionFor('/full', { descriptionStrategy: 'combined' })).toBe(
      'Short summary.\n\nLonger operation description with details.',
    );
    expect(await descriptionFor('/summary-only', { descriptionStrategy: 'combined' })).toBe('Only a summary.');
    expect(await descriptionFor('/bare', { descriptionStrategy: 'combined' })).toBe('GET /bare');
  });

  it('full includes the operation id and route', async () => {
    expect(await descriptionFor('/full', { descriptionStrategy: 'full' })).toBe(
      'Short summary.\n\nLonger operation description with details.\n\nOperation: getFull\n\nGET /full',
    );
    expect(await descriptionFor('/bare', { descriptionStrategy: 'full' })).toBe('Operation: getBare\n\nGET /bare');
  });

  it('extension description overrides beat the strategy', async () => {
    const spec = JSON.parse(JSON.stringify(describedSpec));
    spec.paths['/full'].get['x-mcp'] = { description: 'From extension.' };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await generator.generateTool('/full', 'get', { descriptionStrategy: 'full' });

    expect(tool.description).toBe('From extension.');
  });

  it('appendResponseSummary adds a compact Returns line', async () => {
    const description = await descriptionFor('/full', { appendResponseSummary: true });

    expect(description).toBe('Short summary.\n\nReturns: object with fields: id, name');
  });

  it('appendResponseSummary is silent without an output schema', async () => {
    expect(await descriptionFor('/summary-only', { appendResponseSummary: true })).toBe('Only a summary.');
  });

  it('says nothing for no-content and unrecognizable schemas', async () => {
    // '/summary-only' has a 200 WITHOUT content -> outputSchema { type: 'null' }
    const generator = await OpenAPIToolGenerator.fromJSON(describedSpec);
    const tool = await generator.generateTool('/summary-only', 'get', { appendResponseSummary: true });

    expect(tool.outputSchema).toBeDefined();
    expect(tool.description).toBe('Only a summary.');
  });

  it('summarizes primitive responses', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Prim API', version: '1.0.0' },
      paths: {
        '/count': {
          get: {
            operationId: 'getCount',
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema: { type: 'integer' } } } },
            },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/count', 'get', { appendResponseSummary: true });

    expect(tool.description).toContain('Returns: integer');
  });

  it('summarizes arrays, unions, primitives, and wide objects', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Shapes API', version: '1.0.0' },
      paths: {
        '/objects': {
          get: {
            operationId: 'listObjects',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { type: 'object', properties: { a: {}, b: {} } } },
                  },
                },
              },
            },
          },
        },
        '/strings': {
          get: {
            operationId: 'listStrings',
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } },
              },
              '404': {
                description: 'NF',
                content: { 'application/json': { schema: { type: 'string' } } },
              },
            },
          },
        },
        '/wide': {
          get: {
            operationId: 'getWide',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { type: 'string' }])),
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);

    const objects = await generator.generateTool('/objects', 'get', { appendResponseSummary: true });
    expect(objects.description).toContain('Returns: array of objects with fields: a, b');

    // two responses -> oneOf union summarized via its first variant
    const strings = await generator.generateTool('/strings', 'get', { appendResponseSummary: true });
    expect(strings.description).toContain('Returns: array of string (2 response variants)');

    const wide = await generator.generateTool('/wide', 'get', { appendResponseSummary: true });
    expect(wide.description).toContain('f7, …'); // capped at 8 names
  });

  it('covers typeless objects, bare objects, bare object arrays, and null-first unions', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Shape Edge API', version: '1.0.0' },
      paths: {
        '/typeless': {
          get: {
            operationId: 'getTypeless',
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema: { properties: { a: {} } } } } },
            },
          },
        },
        '/bare-object': {
          get: {
            operationId: 'getBareObject',
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
            },
          },
        },
        '/object-array': {
          get: {
            operationId: 'getObjectArray',
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } },
              },
            },
          },
        },
        '/null-first': {
          get: {
            operationId: 'getNullFirst',
            responses: {
              '204': { description: 'No content' }, // -> { type: 'null' } variant first
              '404': { description: 'NF', content: { 'application/json': { schema: { type: 'string' } } } },
            },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const describeShape = async (p: string) =>
      (await generator.generateTool(p, 'get', { appendResponseSummary: true })).description;

    expect(await describeShape('/typeless')).toContain('Returns: object with fields: a');
    expect(await describeShape('/bare-object')).toContain('Returns: object');
    expect(await describeShape('/object-array')).toContain('Returns: array of objects');
    // first union variant is type:null -> nothing sensible to say
    expect(await describeShape('/null-first')).not.toContain('Returns:');
  });

  it('summarizes itemless arrays plainly', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Bare Array API', version: '1.0.0' },
      paths: {
        '/raw': {
          get: {
            operationId: 'getRaw',
            responses: {
              '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array' } } } },
            },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/raw', 'get', { appendResponseSummary: true });

    expect(tool.description).toContain('Returns: array');
  });
});

describe('Response-shaping metadata hints', () => {
  const hintSpec = (params: any[], schema: any): any => ({
    openapi: '3.0.0',
    info: { title: 'Hints API', version: '1.0.0' },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          parameters: params,
          responses: {
            '200': { description: 'OK', content: { 'application/json': { schema } } },
          },
        },
      },
    },
  });

  const hintsFor = async (params: any[], schema: any) => {
    const generator = await OpenAPIToolGenerator.fromJSON(hintSpec(params, schema));
    return (await generator.generateTool('/items', 'get')).metadata.responseHints;
  };

  it('flags unbounded arrays with no pagination as large-response risks', async () => {
    const hints = await hintsFor([], { type: 'array', items: { type: 'string' } });

    expect(hints).toEqual({ unboundedArray: true, largeResponseRisk: true });
  });

  it('lists pagination params and clears the risk flag', async () => {
    const hints = await hintsFor(
      [
        { name: 'limit', in: 'query', schema: { type: 'integer' } },
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'q', in: 'query', schema: { type: 'string' } },
      ],
      { type: 'array', items: { type: 'string' } },
    );

    expect(hints).toEqual({ unboundedArray: true, paginationParams: ['limit', 'cursor'] });
  });

  it('respects maxItems bounds and nested arrays', async () => {
    const bounded = await hintsFor([], { type: 'array', items: { type: 'string' }, maxItems: 100 });
    expect(bounded).toBeUndefined();

    const nested = await hintsFor([], {
      type: 'object',
      properties: { results: { type: 'array', items: { type: 'string' } } },
    });
    expect(nested).toEqual({ unboundedArray: true, largeResponseRisk: true });
  });

  it('reports pagination params even for bounded responses', async () => {
    const hints = await hintsFor(
      [{ name: 'page', in: 'query', schema: { type: 'integer' } }],
      { type: 'object', properties: { total: { type: 'integer' } } },
    );

    expect(hints).toEqual({ paginationParams: ['page'] });
  });

  it('detects nullable type-array lists and ignores non-array type unions', async () => {
    expect(await hintsFor([], { type: ['array', 'null'], items: { type: 'string' } })).toEqual({
      unboundedArray: true,
      largeResponseRisk: true,
    });
    expect(await hintsFor([], { type: ['string', 'null'] })).toBeUndefined();
  });

  it('omits hints entirely when there is nothing to say', async () => {
    const hints = await hintsFor([], { type: 'object', properties: { id: { type: 'string' } } });

    expect(hints).toBeUndefined();
  });

  it('ignores pagination-named path params and security query params', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Hints API', version: '1.0.0' },
      security: [{ LimitKey: [] }],
      components: {
        securitySchemes: { LimitKey: { type: 'apiKey', name: 'limit', in: 'query' } },
      },
      paths: {
        '/deep/{limit}': {
          get: {
            operationId: 'getDeep',
            parameters: [{ name: 'limit', in: 'path', required: true, schema: { type: 'string' } }],
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
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/deep/{limit}', 'get');

    // the path param and the security query param named 'limit' don't count as pagination
    expect(tool.metadata.responseHints).toEqual({ unboundedArray: true, largeResponseRisk: true });
  });
});

describe('Review-fix regressions: lint on invalid specs, eager overlays', () => {
  const invalidDoc = (): any => ({
    openapi: '3.0.0',
    info: { title: 'No version' }, // missing info.version -> invalid
    paths: {
      '/a': { get: { responses: { '200': { description: 'OK' } } } }, // no operationId either
    },
  });

  it('lint() reports findings on an invalid spec instead of throwing', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(invalidDoc()); // validate defaults to true
    const result = await generator.lint();

    expect(result.findings.map((f) => f.code)).toContain('missing-operation-id');
    // ...while generation still enforces validation
    await expect(generator.generateTools()).rejects.toThrow(/Invalid OpenAPI document/);
  });

  it('validate() and getDocument() see the overlay-curated document immediately', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(invalidDoc(), {
      overlays: {
        overlay: '1.0.0',
        actions: [{ target: '$.info', update: { version: '9.9.9' } }],
      },
    });

    // no other method has run — the getter and validator agree with generation
    expect((generator.getDocument() as any).info.version).toBe('9.9.9');
    expect((await generator.validate()).valid).toBe(true);
  });

  it('malformed overlays fail at construction, not at first use', async () => {
    await expect(
      OpenAPIToolGenerator.fromJSON(invalidDoc(), { overlays: { overlay: '1.0.0' } as any }),
    ).rejects.toThrow(/actions array/);
  });
});

describe('Response hints inside tuple-style items', () => {
  it('detects unbounded arrays nested in tuple members', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Tuple API', version: '1.0.0' },
      paths: {
        '/tuple': {
          get: {
            operationId: 'getTuple',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        pair: {
                          type: 'array',
                          maxItems: 2, // the tuple itself is bounded...
                          items: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const tool = await generator.generateTool('/tuple', 'get');

    // ...but the second tuple member is an unbounded array
    expect(tool.metadata.responseHints).toEqual({ unboundedArray: true, largeResponseRisk: true });
  });
});

describe('OverlayError identity through factory methods', () => {
  const badOverlay: any = { overlay: '1.0.0' }; // missing actions

  it('propagates OverlayError unchanged from fromFile', async () => {
    const os = require('os') as typeof import('os');
    const fs = require('fs/promises') as typeof import('fs/promises');
    const path = require('path') as typeof import('path');
    const file = path.join(os.tmpdir(), `overlay-err-${process.pid}.json`);
    await fs.writeFile(file, JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} }));
    try {
      const { OverlayError } = require('../errors');
      await expect(OpenAPIToolGenerator.fromFile(file, { overlays: badOverlay })).rejects.toBeInstanceOf(OverlayError);
    } finally {
      await fs.unlink(file);
    }
  });

  it('propagates OverlayError unchanged from fromURL', async () => {
    let handler: LoopbackHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} }));
    };
    const loopback = createLoopbackServer(() => handler);
    const baseUrl = await loopback.listen();
    try {
      const { OverlayError } = require('../errors');
      await expect(
        OpenAPIToolGenerator.fromURL(`${baseUrl}/spec.json`, {
          overlays: badOverlay,
          refResolution: { allowInternalIPs: true },
        }),
      ).rejects.toBeInstanceOf(OverlayError);
    } finally {
      await loopback.close();
    }
  });
});

describe('TypeScript signature emission (emitTypeSignatures)', () => {
  const spec: any = {
    openapi: '3.0.0',
    info: { title: 'Sig API', version: '1.0.0' },
    paths: {
      '/users/{id}': {
        get: {
          operationId: 'getUser',
          summary: 'Get a user',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                },
              },
            },
          },
        },
      },
    },
  };

  it('emits metadata.typescript from the final schemas when enabled', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await generator.generateTool('/users/{id}', 'get', { emitTypeSignatures: true });

    expect(tool.metadata.typescript).toBeDefined();
    expect(tool.metadata.typescript?.signature).toBe('(input: { id: string }) => Promise<{ name: string }>');
    expect(tool.metadata.typescript?.declaration).toContain('interface GetUserInput {');
    expect(tool.metadata.typescript?.declaration).toContain('declare function getUser(input: GetUserInput): Promise<GetUserOutput>;');
    // the tool description leads the declaration as JSDoc
    expect(tool.metadata.typescript?.declaration).toContain('/** Get a user */');
  });

  it('does not emit metadata.typescript by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await generator.generateTool('/users/{id}', 'get');
    expect(tool.metadata.typescript).toBeUndefined();
  });

  it('recomputes the declaration when collision dedup renames a tool', async () => {
    const dupSpec: any = {
      openapi: '3.0.0',
      info: { title: 'Dup API', version: '1.0.0' },
      paths: {
        '/a': { get: { operationId: 'dupOp', responses: { '200': { description: 'OK' } } } },
        '/b': { post: { operationId: 'dupOp', responses: { '200': { description: 'OK' } } } },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(dupSpec, { validate: false });
    const tools = await generator.generateTools({ emitTypeSignatures: true });

    expect(tools[1].name).toMatch(/^dupOp_[0-9a-f]{8}$/);
    expect(tools[0].metadata.typescript?.declaration).toContain('DupOpInput');
    const dedupedPascal = toPascalIdentifier(tools[1].name);
    expect(dedupedPascal).not.toBe('DupOp');
    expect(tools[1].metadata.typescript?.declaration).toContain(`${dedupedPascal}Input`);
    expect(tools[1].metadata.typescript?.declaration).not.toContain('DupOpInput =');
  });
});

describe('Type-signature depth follows maxSchemaDepth', () => {
  it('prints levels beyond the old printer default when the schema carries them', async () => {
    // Build a 9-level-deep response schema: l1.l2....l9: string
    let leaf: any = { type: 'string' };
    for (let i = 9; i >= 1; i--) {
      leaf = { type: 'object', properties: { [`l${i}`]: leaf } };
    }
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Deep API', version: '1.0.0' },
      paths: {
        '/deep': {
          get: {
            operationId: 'getDeep',
            responses: { '200': { description: 'OK', content: { 'application/json': { schema: leaf } } } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await generator.generateTool('/deep', 'get', { emitTypeSignatures: true });
    // depth 10 default: all 9 object levels print; the leaf string survives
    expect(tool.metadata.typescript?.signature).toContain('l9?: string');
  });
});

describe('Modern-spec surface: _meta, icons, x-mcp-header', () => {
  const baseSpec = (): any => ({
    openapi: '3.0.0',
    info: { title: 'Meta API', version: '2.0.0', 'x-logo': { url: 'https://example.com/logo.png' } },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          tags: ['items'],
          deprecated: true,
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  });

  it('emits the namespaced operation _meta entry when emitMeta is set', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(baseSpec(), { validate: false });
    const tool = await generator.generateTool('/items', 'get', { emitMeta: true });
    expect(tool._meta).toEqual({
      'dev.agentfront.openapi/operation': {
        path: '/items',
        method: 'get',
        operationId: 'listItems',
        tags: ['items'],
        deprecated: true,
        specTitle: 'Meta API',
        specVersion: '2.0.0',
      },
    });
  });

  it('elides absent operation fields from the _meta entry', async () => {
    const spec = baseSpec();
    spec.info = { title: 'Meta API', version: '2.0.0' };
    spec.paths['/items'].get = { responses: { '200': { description: 'OK' } } };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await generator.generateTool('/items', 'get', { emitMeta: true });
    const entry = (tool._meta as any)['dev.agentfront.openapi/operation'];
    expect(entry).toEqual({ path: '/items', method: 'get', specTitle: 'Meta API', specVersion: '2.0.0' });
  });

  it('omits _meta entirely by default and passes extension meta through even then', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(baseSpec(), { validate: false });
    const plain = await generator.generateTool('/items', 'get');
    expect(plain._meta).toBeUndefined();

    const spec = baseSpec();
    spec.paths['/items'].get['x-mcp'] = { meta: { 'com.example/flag': true } };
    const extGenerator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await extGenerator.generateTool('/items', 'get');
    expect(tool._meta).toEqual({ 'com.example/flag': true });
  });

  it('protects the generated reserved namespace from extension spoofing', async () => {
    const spec = baseSpec();
    spec.paths['/items'].get['x-frontmcp'] = {
      meta: { 'dev.agentfront.openapi/operation': { path: '/FAKE', method: 'delete' }, 'com.example/ok': 1 },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const withFlag = await generator.generateTool('/items', 'get', { emitMeta: true });
    expect((withFlag._meta as any)['dev.agentfront.openapi/operation'].path).toBe('/items');
    expect((withFlag._meta as any)['com.example/ok']).toBe(1);

    const withoutFlag = await generator.generateTool('/items', 'get');
    expect((withoutFlag._meta as any)['dev.agentfront.openapi/operation']).toBeUndefined();
    expect((withoutFlag._meta as any)['com.example/ok']).toBe(1);

    // Only reserved keys supplied and flag off -> no _meta at all
    const onlyReserved = baseSpec();
    onlyReserved.paths['/items'].get['x-mcp'] = { meta: { 'dev.agentfront.openapi/operation': { path: '/FAKE' } } };
    const g2 = await OpenAPIToolGenerator.fromJSON(onlyReserved, { validate: false });
    expect((await g2.generateTool('/items', 'get'))._meta).toBeUndefined();
  });

  it('rejects non-https document logos', async () => {
    const spec = baseSpec();
    spec.info['x-logo'] = 'javascript:alert(1)';
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    expect((await generator.generateTool('/items', 'get', { inheritDocumentIcons: true })).icons).toBeUndefined();
  });

  it('merges extension meta over the generated entry with x-frontmcp winning', async () => {
    const spec = baseSpec();
    spec.paths['/items'].get['x-mcp'] = { meta: { 'com.example/flag': true, 'com.example/level': 1 } };
    spec.paths['/items'].get['x-frontmcp'] = { meta: { 'com.example/level': 2 } };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await generator.generateTool('/items', 'get', { emitMeta: true });
    expect((tool._meta as any)['com.example/flag']).toBe(true);
    expect((tool._meta as any)['com.example/level']).toBe(2);
    expect((tool._meta as any)['dev.agentfront.openapi/operation']).toBeDefined();
  });

  it('emits extension icons always, and the document logo only on opt-in', async () => {
    const spec = baseSpec();
    spec.paths['/items'].get['x-mcp'] = { icons: [{ src: 'https://example.com/op.png', mimeType: 'image/png' }] };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await generator.generateTool('/items', 'get');
    expect(tool.icons).toEqual([{ src: 'https://example.com/op.png', mimeType: 'image/png' }]);

    const plainGenerator = await OpenAPIToolGenerator.fromJSON(baseSpec(), { validate: false });
    expect((await plainGenerator.generateTool('/items', 'get')).icons).toBeUndefined();
    const inherited = await plainGenerator.generateTool('/items', 'get', { inheritDocumentIcons: true });
    expect(inherited.icons).toEqual([{ src: 'https://example.com/logo.png' }]);
  });

  it('supports string x-logo and ignores malformed logos', async () => {
    const stringLogo = baseSpec();
    stringLogo.info['x-logo'] = 'https://example.com/s.svg';
    const g1 = await OpenAPIToolGenerator.fromJSON(stringLogo, { validate: false });
    expect((await g1.generateTool('/items', 'get', { inheritDocumentIcons: true })).icons).toEqual([
      { src: 'https://example.com/s.svg' },
    ]);

    const badLogo = baseSpec();
    badLogo.info['x-logo'] = { alt: 'no url' };
    const g2 = await OpenAPIToolGenerator.fromJSON(badLogo, { validate: false });
    expect((await g2.generateTool('/items', 'get', { inheritDocumentIcons: true })).icons).toBeUndefined();

    const emptyLogo = baseSpec();
    emptyLogo.info['x-logo'] = '';
    const g3 = await OpenAPIToolGenerator.fromJSON(emptyLogo, { validate: false });
    expect((await g3.generateTool('/items', 'get', { inheritDocumentIcons: true })).icons).toBeUndefined();

    const noInfo = baseSpec();
    delete noInfo.info;
    const g4 = await OpenAPIToolGenerator.fromJSON(noInfo, { validate: false });
    expect((await g4.generateTool('/items', 'get', { inheritDocumentIcons: true })).icons).toBeUndefined();
  });

  it('marks header parameters with x-mcp-header, surviving conflict renames and client targets', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Header API', version: '1.0.0' },
      components: { securitySchemes: { apiAuth: { type: 'apiKey', name: 'X-Auth', in: 'header' } } },
      paths: {
        '/data/{trace}': {
          get: {
            operationId: 'getData',
            security: [{ apiAuth: [] }],
            parameters: [
              { name: 'trace', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'trace', in: 'header', schema: { type: 'string' } },
              { name: 'limit', in: 'query', schema: { type: 'integer' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await generator.generateTool('/data/{trace}', 'get', {
      includeSecurityInInput: true,
      target: 'gemini',
    });
    const props = (tool.inputSchema as any).properties;
    expect(props.headerTrace['x-mcp-header']).toBe('trace');
    expect(props.limit['x-mcp-header']).toBeUndefined();
    expect(props.apiAuth['x-mcp-header']).toBe('X-Auth');
  });
});

describe('Shared $ref expansion stays bounded (issue #48)', () => {
  /** Issue #48's repro: each schema has `width` properties that all reference the next one */
  const specWithChain = (levels: number, { width = 2, closeCycle = false } = {}): any => {
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < levels; i++) {
      const next =
        i + 1 < levels || closeCycle ? { $ref: `#/components/schemas/S${(i + 1) % levels}` } : { type: 'string' };
      const properties: Record<string, unknown> = {};
      for (let p = 0; p < width; p++) properties[`p${p}`] = next;
      schemas[`S${i}`] = { type: 'object', properties };
    }
    const ref = { $ref: '#/components/schemas/S0' };
    return {
      openapi: '3.0.3',
      info: { title: 'chain', version: '1.0.0' },
      paths: {
        '/item': {
          get: {
            operationId: 'getItem',
            responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref } } } },
          },
          post: {
            operationId: 'putItem',
            requestBody: { required: true, content: { 'application/json': { schema: ref } } },
            responses: { 204: { description: 'done' } },
          },
        },
      },
      components: { schemas },
    };
  };

  it('generates the issue repro with bounded work, identical to a chain just past maxSchemaDepth', async () => {
    // A 10,000-node budget covers the output's ~6,100 JSON values; converting
    // each occurrence separately would need 2^40 conversions
    const options = { includeAllResponses: true, maxSchemaNodes: 10000 };
    const long = await (await OpenAPIToolGenerator.fromJSON(specWithChain(40))).generateTools(options);
    const short = await (await OpenAPIToolGenerator.fromJSON(specWithChain(12))).generateTools(options);

    expect(long).toHaveLength(2);
    expect(JSON.stringify(long)).toBe(JSON.stringify(short));
    expect(JSON.stringify(long)).toContain('[Truncated: nested schema exceeds maxSchemaDepth]');
  });

  it('bounds a reference cycle of shared schemas by maxSchemaDepth during conversion', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithChain(40, { closeCycle: true }));
    const tool = await generator.generateTool('/item', 'get', { maxSchemaDepth: 4, maxSchemaNodes: 500 });

    let node: any = tool.outputSchema;
    for (let i = 0; i < 4; i++) node = node.properties.p0;
    expect(node.properties).toBeUndefined();
    expect(node.description).toContain('Truncated');
  });

  it('never aliases one schema object between occurrences of the same $ref target', async () => {
    const money = { type: 'object', properties: { amount: { type: 'integer' }, currency: { type: 'string' } } };
    const twoMoneys = {
      type: 'object',
      properties: { price: { $ref: '#/components/schemas/Money' }, cost: { $ref: '#/components/schemas/Money' } },
    };
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.0.3',
      info: { title: 'money', version: '1.0.0' },
      paths: {
        '/order': {
          post: {
            requestBody: { content: { 'application/json': { schema: twoMoneys } } },
            responses: { 200: { description: 'ok', content: { 'application/json': { schema: twoMoneys } } } },
          },
        },
      },
      components: { schemas: { Money: money } },
    } as any);
    const tool = await generator.generateTool('/order', 'post');
    const input = tool.inputSchema as any;
    const output = tool.outputSchema as any;

    expect(input.properties.price.properties).toEqual(money.properties);
    expect(input.properties.price.properties).not.toBe(input.properties.cost.properties);
    expect(output.properties.price).not.toBe(output.properties.cost);
    expect(output.properties.price.properties.amount).not.toBe(output.properties.cost.properties.amount);
    output.properties.price.properties.amount.description = 'cents';
    expect(output.properties.cost.properties.amount.description).toBeUndefined();
  });

  it('fails a tool whose truncated schema exceeds maxSchemaNodes with a SchemaError', async () => {
    const { SchemaError } = require('../errors');
    // 5 references per level: 5^10 nodes survive the default depth truncation
    const generator = await OpenAPIToolGenerator.fromJSON(specWithChain(12, { width: 5 }));

    await expect(generator.generateTool('/item', 'get')).rejects.toThrow(SchemaError);
    await expect(generator.generateTool('/item', 'get')).rejects.toThrow(
      /node budget of 100000 \(maxSchemaNodes\) after depth truncation/,
    );
    // Within the same budget, a shallower depth keeps the output small enough
    await expect(generator.generateTool('/item', 'get', { maxSchemaDepth: 5 })).resolves.toBeDefined();
  });

  it('stops converting a cycle of wide shared references at the node budget', async () => {
    // A 10-schema cycle closes within the default depth, so conversion walks it
    // per path (5^9 paths) and stops at the budget
    const generator = await OpenAPIToolGenerator.fromJSON(specWithChain(10, { width: 5, closeCycle: true }));

    await expect(generator.generateTool('/item', 'get')).rejects.toThrow(
      /Schema conversion exceeded the node budget of 100000 \(maxSchemaNodes\)/,
    );
  });

  it('generates a cycle that closes past maxSchemaDepth exactly like the open chain', async () => {
    const options = { maxSchemaNodes: 10000 };
    const cyclic = await (await OpenAPIToolGenerator.fromJSON(specWithChain(40, { closeCycle: true }))).generateTools(options);
    const open = await (await OpenAPIToolGenerator.fromJSON(specWithChain(40))).generateTools(options);

    expect(cyclic.map((t) => t.name)).toEqual(['getItem', 'putItem']);
    expect(open.map((t) => t.name)).toEqual(['getItem', 'putItem']);
    expect(JSON.stringify(cyclic)).toBe(JSON.stringify(open));
  });

  it('converts only the preferred response when includeAllResponses is false', async () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 41; i++) wide[`field${i}`] = { type: 'string' };
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.0.3',
      info: { title: 'errors', version: '1.0.0' },
      paths: {
        '/x': {
          get: {
            responses: {
              200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } },
              400: { description: 'bad', content: { 'application/json': { schema: { type: 'object', properties: wide } } } },
            },
          },
        },
      },
    } as any);

    // The 400 schema alone exceeds the budget, but it is never emitted
    const tool = await generator.generateTool('/x', 'get', { includeAllResponses: false, maxSchemaNodes: 40 });
    expect((tool.outputSchema as any)['x-status-code']).toBe(200);
    await expect(generator.generateTool('/x', 'get', { includeAllResponses: true, maxSchemaNodes: 40 })).rejects.toThrow(
      /maxSchemaNodes/,
    );
  });

  it('generateTools skips an over-budget tool with a warning and keeps the others', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spec = specWithChain(12, { width: 5 });
      spec.paths['/item'].post.requestBody.content['application/json'].schema = {
        type: 'object',
        properties: { id: { type: 'string' } },
      };
      const generator = await OpenAPIToolGenerator.fromJSON(spec);
      const tools = await generator.generateTools();

      expect(tools.map((t) => t.name)).toEqual(['putItem']);
      expect(warnSpy).toHaveBeenCalledWith('Failed to generate tool for GET /item:', expect.stringContaining('maxSchemaNodes'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('honors a custom maxSchemaNodes, with Infinity disabling the budget', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithChain(3));

    await expect(generator.generateTool('/item', 'get', { maxSchemaNodes: 5 })).rejects.toThrow(/node budget of 5 /);
    await expect(generator.generateTool('/item', 'get', { maxSchemaNodes: Infinity })).resolves.toBeDefined();
  });

  it('flattens allOf request bodies against the same depth bound as plain bodies', async () => {
    let deep: any = { type: 'string' };
    for (let i = 0; i < 12; i++) deep = { type: 'object', properties: { [`level${12 - i}`]: deep } };
    const plain = { type: 'object', properties: { root: deep } };
    const specWithBody = (schema: unknown): any => ({
      openapi: '3.0.3',
      info: { title: 'deep', version: '1.0.0' },
      paths: {
        '/deep': {
          post: { requestBody: { content: { 'application/json': { schema } } }, responses: { 204: { description: 'ok' } } },
        },
      },
    });
    const generate = async (schema: unknown) =>
      (await OpenAPIToolGenerator.fromJSON(specWithBody(schema))).generateTool('/deep', 'post', { maxSchemaDepth: 4 });

    const flat = await generate(plain);
    const composed = await generate({ allOf: [{ allOf: [plain] }] });

    expect(composed.inputSchema).toEqual(flat.inputSchema);
    expect(JSON.stringify(flat.inputSchema)).toContain('Truncated');
  });

  it('flattens a chain of allOf diamonds once per shared member', async () => {
    const schemas: Record<string, unknown> = {
      L30: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    };
    for (let i = 0; i < 30; i++) {
      const next = { $ref: `#/components/schemas/L${i + 1}` };
      schemas[`L${i}`] = { allOf: [next, next] };
    }
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.0.3',
      info: { title: 'diamonds', version: '1.0.0' },
      paths: {
        '/x': {
          post: {
            requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/L0' } } } },
            responses: { 204: { description: 'ok' } },
          },
        },
      },
      components: { schemas },
    } as any);
    const tool = await generator.generateTool('/x', 'post', { maxSchemaNodes: 200 });

    expect(tool.inputSchema.properties).toEqual({
      name: { type: 'string', 'x-parameter-location': 'body' },
    });
    expect(tool.inputSchema.required).toEqual(['name']);
  });
});

describe('ParameterResolver schemaConversion option', () => {
  const operation = {
    parameters: [
      {
        name: 'filter',
        in: 'query',
        schema: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } },
      },
    ],
  };

  it('converts without limits by default', () => {
    const { inputSchema } = new ParameterResolver().resolve(operation);
    expect((inputSchema.properties as any).filter.properties.a.properties.b).toEqual({ type: 'string' });
  });

  it('applies maxDepth and maxNodes to parameter schemas', () => {
    const shallow = new ParameterResolver(undefined, { schemaConversion: { maxDepth: 1 } }).resolve(operation);
    expect((shallow.inputSchema.properties as any).filter.properties.a.properties.b).toEqual({});

    expect(() => new ParameterResolver(undefined, { schemaConversion: { maxNodes: 2 } }).resolve(operation)).toThrow(
      /maxSchemaNodes/,
    );
  });
});

describe('Deeply nested schemas (issue #50)', () => {
  const LINKS = ['allOf', 'properties', 'items', 'anyOf', 'additionalProperties', 'not'] as const;
  type Kind = (typeof LINKS)[number] | 'mixed';

  /** One schema per level, each linking to the next by `kind` (`mixed` cycles through every link) */
  const specWithChain = (kind: Kind, levels: number): any => {
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < levels; i++) {
      const next =
        i + 1 < levels
          ? { $ref: `#/components/schemas/S${i + 1}` }
          : { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] };
      const link = kind === 'mixed' ? LINKS[i % LINKS.length] : kind;
      schemas[`S${i}`] = {
        allOf: { allOf: [next], description: `level ${i}` },
        properties: { type: 'object', properties: { next, [`p${i}`]: { type: 'string', example: 'x' } } },
        items: { type: 'array', items: next },
        anyOf: { anyOf: [next, { type: 'null' }] },
        additionalProperties: { type: 'object', additionalProperties: next },
        not: { not: next },
      }[link];
    }
    const ref = { $ref: '#/components/schemas/S0' };
    return {
      openapi: '3.0.3',
      info: { title: 'chain', version: '1.0.0' },
      paths: {
        '/item': {
          get: {
            operationId: 'getItem',
            responses: { 200: { description: 'ok', content: { 'application/json': { schema: ref } } } },
          },
          post: {
            operationId: 'putItem',
            requestBody: { required: true, content: { 'application/json': { schema: ref } } },
            responses: { 204: { description: 'done' } },
          },
        },
      },
      components: { schemas },
    };
  };

  it.each<Kind>([...LINKS, 'mixed'])(
    'generates a %s chain 5000 $refs long, identical to one just past maxSchemaDepth',
    async (kind) => {
      // Each link used to cost several stack frames when dereferencing, and an
      // allOf link (which doesn't consume depth) more again in conversion,
      // body flattening, and format resolution — v2.9.2 overflowed the call
      // stack below 1100 links
      const options = { resolveFormats: true, includeExamples: true };
      const long = await (await OpenAPIToolGenerator.fromJSON(specWithChain(kind, 5000))).generateTools(options);
      const short = await (await OpenAPIToolGenerator.fromJSON(specWithChain(kind, 40))).generateTools(options);

      expect(long.map((tool) => tool.name)).toEqual(['getItem', 'putItem']);
      expect(JSON.stringify(long)).toBe(JSON.stringify(short));
    },
  );

  it('hoists the properties at the end of a 5000-link allOf request body', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(specWithChain('allOf', 5000));
    const tool = await generator.generateTool('/item', 'post');

    expect(Object.keys(tool.inputSchema.properties!)).toEqual(['id']);
    expect(tool.inputSchema.required).toEqual(['id']);
  });

  it('flattens an 8000-link allOf request body that adds a property per link, in linear time', async () => {
    // Merging a full property map per link took quadratic time and memory:
    // 5000 links took 2.8 s, 8000 would take about 7 s. The mapper's 8000
    // entries must not exhaust the default node budget either.
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 8000; i++) {
      const own = { type: 'object', properties: { [`p${i}`]: { type: 'string' }, shared: { description: `link ${i}` } } };
      schemas[`S${i}`] = i < 7999 ? { allOf: [{ $ref: `#/components/schemas/S${i + 1}` }, own] } : own;
    }
    const spec = specWithChain('allOf', 1);
    Object.assign(spec.components.schemas, schemas);
    spec.paths['/item'].post.requestBody.content['application/json'].schema = { $ref: '#/components/schemas/S0' };

    const tool = await (await OpenAPIToolGenerator.fromJSON(spec)).generateTool('/item', 'post');

    // Keys in the order they are first assigned — the deepest link first — and
    // each with the value assigned last, by the shallowest link
    const keys = Object.keys(tool.inputSchema.properties!);
    expect(keys).toHaveLength(8001);
    expect(keys.slice(0, 3)).toEqual(['p7999', 'shared', 'p7998']);
    expect(keys[keys.length - 1]).toBe('p0');
    expect((tool.inputSchema.properties as any).shared).toMatchObject({ description: 'link 0' });
    expect(tool.mapper).toHaveLength(8001);
  });

  it('merges a member repeated in an allOf list as assigning its properties again would', async () => {
    const spec = specWithChain('allOf', 1);
    spec.components.schemas.A = { type: 'object', properties: { a: { type: 'string' }, both: { description: 'A' } } };
    spec.components.schemas.B = { type: 'object', properties: { both: { description: 'B' }, b: { type: 'string' } } };
    spec.paths['/item'].post.requestBody.content['application/json'].schema = {
      allOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }, { $ref: '#/components/schemas/A' }],
    };

    const tool = await (await OpenAPIToolGenerator.fromJSON(spec)).generateTool('/item', 'post');

    expect(tool.inputSchema.properties).toMatchObject({
      a: { type: 'string' },
      both: { description: 'A' },
      b: { type: 'string' },
    });
    expect(Object.keys(tool.inputSchema.properties!)).toEqual(['a', 'both', 'b']);
  });

  it('lints a chain 5000 $refs long', async () => {
    const { findings } = await (await OpenAPIToolGenerator.fromJSON(specWithChain('mixed', 5000))).lint();
    const deep = findings.filter((finding) => finding.code === 'deep-schema');

    expect(deep.map((finding) => finding.path)).toEqual(['GET /item', 'POST /item']);
    // 5000 linked schemas, then the leaf object and its `id` property
    expect(deep[0].message).toContain('depth 5002');
  });

  it('fails with a SchemaError, not a stack overflow, when maxSchemaDepth keeps too much nesting', async () => {
    // Steps after depth truncation recurse once per level of the truncated
    // schema; the default depth (10) keeps them shallow
    const generator = await OpenAPIToolGenerator.fromJSON(specWithChain('properties', 20000));
    const options = { maxSchemaDepth: 100000, maxSchemaNodes: Infinity };

    const failure = generator.generateTool('/item', 'get', options);
    await expect(failure).rejects.toThrow(SchemaError);
    await expect(failure).rejects.toThrow(
      'Schemas of GET /item are nested too deeply to process at maxSchemaDepth 100000 (maximum call stack size ' +
        'exceeded); lower maxSchemaDepth.',
    );

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await generator.generateTools(options)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        'Failed to generate tool for POST /item:',
        expect.stringContaining('nested too deeply to process at maxSchemaDepth 100000'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('passes x-mcp meta through from a long $ref chain, failing just that tool past 1000 levels', async () => {
    const withMeta = (levels: number): any => {
      const spec = specWithChain('properties', levels);
      spec.paths['/item'].get['x-mcp'] = { meta: { 'acme/schema': { $ref: '#/components/schemas/S0' } } };
      return spec;
    };

    // Each chain link nests two levels: the schema and its `properties`
    const tool = await (await OpenAPIToolGenerator.fromJSON(withMeta(300))).generateTool('/item', 'get');
    let node: any = tool._meta!['acme/schema'];
    for (let i = 0; i < 300; i++) node = node.properties.next;
    expect(node).toEqual({ type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] });

    const generator = await OpenAPIToolGenerator.fromJSON(withMeta(5000));
    await expect(generator.generateTool('/item', 'get')).rejects.toThrow(
      'Extension meta (x-mcp/x-frontmcp) is nested more than 1000 levels deep.',
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await generator.generateTools()).map((t) => t.name)).toEqual(['putItem']);
      expect(warn).toHaveBeenCalledWith(
        'Failed to generate tool for GET /item:',
        'Extension meta (x-mcp/x-frontmcp) is nested more than 1000 levels deep.',
      );
    } finally {
      warn.mockRestore();
    }
  });

  /** The chain spec with GET's x-mcp meta $ref-ing M0, where Mi = { left: Mi+1, right: Mi+1 } */
  const specWithSharedMeta = (levels: number): any => {
    const spec = specWithChain('properties', 1);
    for (let i = 0; i < levels; i++) {
      const next = { $ref: `#/components/schemas/M${i + 1}` };
      spec.components.schemas[`M${i}`] = { left: next, right: next };
    }
    spec.components.schemas[`M${levels}`] = { leaf: true };
    spec.paths['/item'].get['x-mcp'] = { meta: { 'acme/tree': { $ref: '#/components/schemas/M0' } } };
    return spec;
  };

  it('bounds x-mcp meta that $refs schemas sharing a child, which is copied per occurrence', async () => {
    // 2^41 copies without a budget; the operation filters never copy meta,
    // so the other tools still generate
    const generator = await OpenAPIToolGenerator.fromJSON(specWithSharedMeta(40));
    await expect(generator.generateTool('/item', 'get')).rejects.toThrow(
      'Extension meta exceeds the node budget of 100000 (maxSchemaNodes)',
    );

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await generator.generateTools()).map((t) => t.name)).toEqual(['putItem']);
      expect(await generator.generateTools({ readOnlyOnly: true })).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        'Failed to generate tool for GET /item:',
        expect.stringContaining('Extension meta exceeds the node budget of 100000'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('charges x-mcp meta against maxSchemaNodes: every copied value, the meta object included', async () => {
    // The meta object, 2^11 - 1 copied objects of the shared tree, and the
    // `true` in each of its 2^10 leaves
    const generator = await OpenAPIToolGenerator.fromJSON(specWithSharedMeta(10));

    const tool = await generator.generateTool('/item', 'get', { maxSchemaNodes: 3072 });
    expect(JSON.stringify(tool._meta)).toContain('"leaf":true');
    await expect(generator.generateTool('/item', 'get', { maxSchemaNodes: 3071 })).rejects.toThrow(
      'Extension meta exceeds the node budget of 3071 (maxSchemaNodes)',
    );
  });

  it('drops the reference back to an ancestor when x-mcp meta $refs a recursive schema', async () => {
    const spec = specWithChain('properties', 1);
    spec.components.schemas.Tree = { type: 'object', properties: { child: { $ref: '#/components/schemas/Tree' } } };
    spec.paths['/item'].get['x-mcp'] = { meta: { 'acme/tree': { $ref: '#/components/schemas/Tree' } } };
    const tool = await (await OpenAPIToolGenerator.fromJSON(spec)).generateTool('/item', 'get');

    expect(JSON.stringify(tool._meta)).toBe('{"acme/tree":{"type":"object","properties":{}}}');
  });
});

describe('Values copied from the spec into a tool (issue #50)', () => {
  type Place = 'default' | 'example' | 'x-frontmcp' | 'tags';

  /**
   * POST /item with a `$ref` to M0 in `place`, where Mi = { left: Mi+1, right: Mi+1 }:
   * 2^(levels + 1) values once copied per occurrence — or serialized
   */
  const specWithSharedValue = (place: Place, levels: number): any => {
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < levels; i++) {
      const next = { $ref: `#/components/schemas/M${i + 1}` };
      schemas[`M${i}`] = { left: next, right: next };
    }
    schemas[`M${levels}`] = { leaf: true };
    const ref = { $ref: '#/components/schemas/M0' };
    const body: any = { type: 'object', properties: { a: { type: 'object' } } };
    const media: any = { schema: body };
    const post: any = {
      operationId: 'postItem',
      requestBody: { content: { 'application/json': media } },
      responses: { 204: { description: 'done' } },
    };
    if (place === 'default') body.properties.a.default = ref;
    if (place === 'example') media.example = { a: ref };
    if (place === 'x-frontmcp') post['x-frontmcp'] = { cache: ref };
    if (place === 'tags') post.tags = ['items', ref];
    return {
      openapi: '3.0.3',
      info: { title: 'values', version: '1.0.0' },
      paths: { '/item': { post, get: { operationId: 'getItem', responses: { 204: { description: 'ok' } } } } },
      components: { schemas },
    };
  };

  it.each<[Place, string]>([
    ['default', 'Schema exceeds the node budget of 100000 (maxSchemaNodes) after depth truncation'],
    ['example', 'Schema exceeds the node budget of 100000 (maxSchemaNodes) after depth truncation'],
    ['x-frontmcp', 'The metadata of POST /item exceeds the node budget of 100000 (maxSchemaNodes)'],
    ['tags', 'The metadata of POST /item exceeds the node budget of 100000 (maxSchemaNodes)'],
  ])('fails just the tool whose %s $refs a value expanding past maxSchemaNodes', async (place, message) => {
    // v2.9.2 returned this tool, sharing the value: serializing it took 2^41 values
    const generator = await OpenAPIToolGenerator.fromJSON(specWithSharedValue(place, 40));
    const options = { includeExamples: true, emitMeta: true };
    await expect(generator.generateTool('/item', 'post', options)).rejects.toThrow(message);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await generator.generateTools(options)).map((tool) => tool.name)).toEqual(['getItem']);
    } finally {
      warn.mockRestore();
    }
  });

  it('copies a shared value per occurrence within the budget', async () => {
    const tool = await (await OpenAPIToolGenerator.fromJSON(specWithSharedValue('default', 8))).generateTool(
      '/item',
      'post',
    );
    const value = (tool.inputSchema.properties!.a as any).default;

    expect(value.left).not.toBe(value.right);
    expect(JSON.stringify(value).match(/"leaf":true/g)).toHaveLength(256);
  });

  it('drops the reference back when a value $refs a recursive schema, so the tool stays serializable', async () => {
    const spec = specWithSharedValue('default', 0);
    spec.components.schemas.Tree = { type: 'object', properties: { child: { $ref: '#/components/schemas/Tree' } } };
    spec.paths['/item'].post.requestBody.content['application/json'].schema.properties.a.default = {
      $ref: '#/components/schemas/Tree',
    };
    const tool = await (await OpenAPIToolGenerator.fromJSON(spec)).generateTool('/item', 'post');

    expect(JSON.stringify((tool.inputSchema.properties!.a as any).default)).toBe(
      '{"type":"object","properties":{}}',
    );
  });

  it('drops the reference back in x-frontmcp data that $refs a recursive schema, as metadata.frontmcp', async () => {
    const spec = specWithSharedValue('x-frontmcp', 0);
    spec.components.schemas.Tree = { type: 'object', properties: { child: { $ref: '#/components/schemas/Tree' } } };
    spec.paths['/item'].post['x-frontmcp'] = { meta: { 'acme/tree': { $ref: '#/components/schemas/Tree' } } };
    const tool = await (await OpenAPIToolGenerator.fromJSON(spec)).generateTool('/item', 'post');

    const tree = '{"acme/tree":{"type":"object","properties":{}}}';
    expect(JSON.stringify((tool.metadata.frontmcp as any).meta)).toBe(tree);
    expect(JSON.stringify(tool._meta)).toBe(tree);
  });

  it('shares no object with the document, so changing one tool cannot change the next', async () => {
    const spec = specWithSharedValue('x-frontmcp', 0);
    spec.paths['/item'].post.requestBody.content['application/json'].schema.properties.a.default = { k: 1 };
    spec.paths['/item'].post.servers = [{ url: 'https://api.example.com', variables: { v: { default: 'a' } } }];
    const generator = await OpenAPIToolGenerator.fromJSON(spec);

    const first = await generator.generateTool('/item', 'post', { emitMeta: true });
    (first.inputSchema.properties!.a as any).default.k = 2;
    (first.metadata.frontmcp as any).cache.leaf = false;
    (first.metadata.servers![0] as any).variables.v.default = 'changed';

    const second = await generator.generateTool('/item', 'post', { emitMeta: true });
    expect((second.inputSchema.properties!.a as any).default).toEqual({ k: 1 });
    expect(second.metadata.frontmcp).toEqual({ cache: { leaf: true } });
    expect(second.metadata.servers).toEqual([
      { url: 'https://api.example.com', variables: { v: { default: 'a' } } },
    ]);
  });
});

describe('Wide schemas and inlined definitions stay bounded (issue #50)', () => {
  /**
   * GET /x returning L0: seven levels of four properties, then F — a schema
   * with `keywords` keywords, which leads back to L0 when `cycle` is set
   */
  const specWithWideLeaf = (keywords: number, cycle: boolean): any => {
    const wide: any = { type: 'object', properties: cycle ? { back: { $ref: '#/components/schemas/L0' } } : {} };
    for (let k = 0; k < keywords; k++) wide[`x-k${k}`] = k;
    const schemas: Record<string, unknown> = { F: wide };
    for (let i = 0; i < 7; i++) {
      const next = { $ref: i < 6 ? `#/components/schemas/L${i + 1}` : '#/components/schemas/F' };
      schemas[`L${i}`] = { type: 'object', properties: { a: next, b: next, c: next, d: next } };
    }
    return {
      openapi: '3.0.3',
      info: { title: 'wide', version: '1.0.0' },
      paths: {
        '/x': {
          get: {
            operationId: 'getX',
            responses: {
              200: {
                description: 'ok',
                content: { 'application/json': { schema: { $ref: '#/components/schemas/L0' } } },
              },
            },
          },
        },
      },
      components: { schemas },
    };
  };

  it('counts every keyword of a schema that the output copies once per occurrence', async () => {
    // 4^7 copies of a schema with 2000 keywords: v2.9.2 produced 456 MB in 5 s
    const generator = await OpenAPIToolGenerator.fromJSON(specWithWideLeaf(2000, false));

    await expect(generator.generateTool('/x', 'get')).rejects.toThrow(
      'Schema exceeds the node budget of 100000 (maxSchemaNodes) after depth truncation',
    );
  });

  it('charges every keyword of a schema that a cycle makes conversion rebuild once per path', async () => {
    // v2.9.2 took 17.7 s and produced 456 MB
    const generator = await OpenAPIToolGenerator.fromJSON(specWithWideLeaf(2000, true));

    await expect(generator.generateTool('/x', 'get')).rejects.toThrow(
      'Schema conversion exceeded the node budget of 100000 (maxSchemaNodes)',
    );
  });

  it('bounds a client target inlining definitions that reference each other twice', async () => {
    // With dereferencing off, the target inlines a definition once per $ref to it: 2^40 copies
    const $defs: Record<string, unknown> = { A40: { type: 'string' } };
    for (let i = 0; i < 40; i++) {
      const next = { $ref: `#/$defs/A${i + 1}` };
      $defs[`A${i}`] = { type: 'object', properties: { x: next, y: next } };
    }
    const schema = { $defs, type: 'object', properties: { root: { $ref: '#/$defs/A0' } } };
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.1.0',
        info: { title: 'defs', version: '1.0.0' },
        paths: {
          '/x': {
            get: {
              operationId: 'getX',
              responses: { 200: { description: 'ok', content: { 'application/json': { schema } } } },
            },
          },
        },
      },
      { dereference: false },
    );

    await expect(generator.generateTool('/x', 'get', { target: 'claude' })).rejects.toThrow(
      'Inlining the local $refs of a schema exceeds the node budget of 100000 (maxSchemaNodes)',
    );
  });
});


// ---------------------------------------------------------------------------
// OpenAPI 3.2 operations, versions and diagnostics (issue #55)
// ---------------------------------------------------------------------------

describe('OpenAPI 3.2 operations, versions and diagnostics (issue #55)', () => {
  const ok = { '200': { description: 'OK' } };
  const op = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ responses: ok, ...extra });
  const LEGACY_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
  /** A document no validator warning fires on: servers, operationIds, responses */
  const clean = (openapi: unknown, paths: Record<string, unknown>, extra: Record<string, unknown> = {}): any => ({
    openapi,
    info: { title: 'T', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    paths,
    ...extra,
  });
  const codes = (generator: OpenAPIToolGenerator): string[] => generator.getDiagnostics().map((d) => d.code);
  const names = async (generator: OpenAPIToolGenerator, options?: GenerateOptions): Promise<string[]> =>
    (await generator.generateTools(options)).map((t) => t.name);
  const silenceWarnings = (): jest.SpyInstance => jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  describe('tool order and names', () => {
    // Every legacy method on one path without operationIds (names from method + path), and on another with them
    const legacyPaths = (): Record<string, any> => ({
      '/items/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        ...Object.fromEntries(LEGACY_METHODS.map((method) => [method, op()])),
      },
      '/named': Object.fromEntries(LEGACY_METHODS.map((method) => [method, op({ operationId: `${method}Named` })])),
    });
    const legacyNames = [
      'get_items_By_id',
      'post_items_By_id',
      'put_items_By_id',
      'patch_items_By_id',
      'delete_items_By_id',
      'head_items_By_id',
      'options_items_By_id',
      'trace_items_By_id',
      ...LEGACY_METHODS.map((method) => `${method}Named`),
    ];

    it('keeps the exact names and order of the eight legacy methods', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(clean('3.0.3', legacyPaths()));
      const tools = await generator.generateTools();
      expect(tools.map((t) => t.name)).toEqual(legacyNames);
      expect(tools.map((t) => t.metadata.method)).toEqual([...LEGACY_METHODS, ...LEGACY_METHODS]);
    });

    it('appends query, then additionalOperations sorted by method, without changing the legacy tools', async () => {
      const paths = legacyPaths();
      paths['/items/{id}'].query = op();
      // key order in the document is irrelevant: code-unit order puts upper case first
      paths['/items/{id}'].additionalOperations = { purge: op(), LINK: op(), COPY: op() };
      const generator = await OpenAPIToolGenerator.fromJSON(clean('3.2.0', paths));
      const tools = await generator.generateTools();

      expect(tools.map((t) => t.name)).toEqual([
        ...legacyNames.slice(0, 8),
        'query_items_By_id',
        'COPY_items_By_id',
        'LINK_items_By_id',
        'purge_items_By_id',
        ...legacyNames.slice(8),
      ]);
      const added = tools.slice(8, 12);
      expect(added.map((t) => t.metadata.method)).toEqual(['query', 'COPY', 'LINK', 'purge']);
      // the description fallback names the method as sent: standard upper-cased, additional as written
      expect(added.map((t) => t.description)).toEqual([
        'QUERY /items/{id}',
        'COPY /items/{id}',
        'LINK /items/{id}',
        'purge /items/{id}',
      ]);
      // QUERY is safe; a method of unknown semantics gets the conservative POST profile
      expect(added.map((t) => t.annotations?.readOnlyHint)).toEqual([true, false, false, false]);
      // the only findings are the missing operationIds this spec relies on for its names
      expect(new Set(codes(generator))).toEqual(new Set(['NO_OPERATION_ID']));
    });

    it('gives an additional method that normalizes onto a fixed one a deduplicated name', async () => {
      // `get!` is a valid method token; its raw name `get!_items` normalizes to `get_items`
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', { '/items': { get: op(), additionalOperations: { 'get!': op() } } }),
      );
      const tools = await generator.generateTools();
      expect(tools.map((t) => t.name)).toEqual(['get_items', `get_items_${fnv1aHex('get! /items')}`]);
      expect(tools.map((t) => t.metadata.method)).toEqual(['get', 'get!']);
    });

    it('keeps additional methods that differ only by case apart', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', { '/items': { additionalOperations: { link: op(), LINK: op() } } }),
      );
      const tools = await generator.generateTools();
      expect(tools.map((t) => t.name)).toEqual(['LINK_items', 'link_items']);
      expect(tools.map((t) => t.metadata.method)).toEqual(['LINK', 'link']);
    });

    it('passes the canonical method to toolNameGenerator, filterFn and the _meta operation entry', async () => {
      const seen: string[] = [];
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', { '/items': { get: op(), query: op(), additionalOperations: { LINK: op() } } }),
      );
      const tools = await generator.generateTools({
        emitMeta: true,
        filterFn: (operation) => {
          seen.push(operation.method);
          return true;
        },
        namingStrategy: {
          conflictResolver: (name) => name,
          toolNameGenerator: (path, method) => `${method}${path.replace(/\//g, '-')}`,
        },
      });
      expect(seen).toEqual(['get', 'query', 'LINK']);
      expect(tools.map((t) => t.name)).toEqual(['get-items', 'query-items', 'LINK-items']);
      expect(tools.map((t) => (t._meta?.['dev.agentfront.openapi/operation'] as { method: string }).method)).toEqual([
        'get',
        'query',
        'LINK',
      ]);
    });
  });

  describe('operations follow the declared version', () => {
    const paths = (): Record<string, unknown> => ({
      '/items': {
        get: op({ operationId: 'list' }),
        query: op({ operationId: 'search' }),
        additionalOperations: { PURGE: op({ operationId: 'purge' }) },
      },
    });
    const skippedMessages = (declared: string) => [
      `The \`query\` operation needs OpenAPI 3.2 or later, but the document declares OpenAPI "${declared}", so it is ignored (no tool); declare OpenAPI 3.2 or later to read it`,
      `Path Item \`additionalOperations\` needs OpenAPI 3.2 or later, but the document declares OpenAPI "${declared}", so it is ignored (no tool); declare OpenAPI 3.2 or later to read it`,
    ];

    it.each([
      // declared, validate, tools, diagnostic codes
      ['3.0.3', true, ['list'], ['FEATURE_NEWER_THAN_DECLARED_VERSION', 'FEATURE_NEWER_THAN_DECLARED_VERSION']],
      ['3.1.0', true, ['list'], ['FEATURE_NEWER_THAN_DECLARED_VERSION', 'FEATURE_NEWER_THAN_DECLARED_VERSION']],
      ['3.1.0', false, ['list'], ['FEATURE_NEWER_THAN_DECLARED_VERSION', 'FEATURE_NEWER_THAN_DECLARED_VERSION']],
      ['3.2.0', true, ['list', 'search', 'purge'], []],
      ['3.3.0', true, ['list', 'search', 'purge'], ['NEWER_OPENAPI_VERSION']],
      // a version that cannot be processed reads what the library always read
      [undefined, false, ['list'], ['MISSING_OPENAPI_VERSION']],
      ['4.0.0', false, ['list'], ['INVALID_OPENAPI_VERSION']],
      ['3.1', false, ['list'], ['INVALID_OPENAPI_VERSION']],
    ] as const)('declared %s (validate: %s) makes the tools %j', async (declared, validate, tools, diagnostics) => {
      const generator = await OpenAPIToolGenerator.fromJSON(clean(declared, paths()), { validate });
      expect(await names(generator)).toEqual(tools);
      expect(codes(generator)).toEqual(diagnostics);
    });

    it('says why a query operation or additionalOperations of an older document is ignored', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(clean('3.1.0', paths()));
      await generator.generateTools();
      expect(generator.getDiagnostics()).toEqual([
        {
          severity: 'warning',
          code: 'FEATURE_NEWER_THAN_DECLARED_VERSION',
          message: skippedMessages('3.1.0')[0],
          path: '/paths/~1items/query',
        },
        {
          severity: 'warning',
          code: 'FEATURE_NEWER_THAN_DECLARED_VERSION',
          message: skippedMessages('3.1.0')[1],
          path: '/paths/~1items/additionalOperations',
        },
      ]);
    });

    it('never finds those operations through generateTool, but records why', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(clean('3.1.0', paths()));
      await expect(generator.generateTool('/items', 'query')).rejects.toThrow('Operation not found: QUERY /items');
      await expect(generator.generateTool('/items', 'PURGE')).rejects.toThrow('Operation not found: PURGE /items');
      expect(codes(generator)).toEqual(['FEATURE_NEWER_THAN_DECLARED_VERSION', 'FEATURE_NEWER_THAN_DECLARED_VERSION']);
    });

    it('lets an excludeMethods denylist of an older document stand: additional operations make no tool', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.1.0', {
          '/items': {
            get: op({ operationId: 'list' }),
            delete: op({ operationId: 'remove' }),
            additionalOperations: { DESTROY: op({ operationId: 'destroy' }) },
          },
        }),
      );
      expect(await names(generator, { excludeMethods: ['delete'] })).toEqual(['list']);
    });

    it('accepts and ignores a malformed additionalOperations in an older document', async () => {
      const spec = clean('3.1.0', { '/items': { get: op({ operationId: 'list' }), additionalOperations: 'junk' } });
      const generator = await OpenAPIToolGenerator.fromJSON(spec);
      expect(await generator.validate()).toMatchObject({ valid: true });
      expect(await names(generator)).toEqual(['list']);
      expect(codes(generator)).toEqual(['FEATURE_NEWER_THAN_DECLARED_VERSION']);
    });

    it('maps a querystring parameter in an older document too (feature-driven), with a warning', async () => {
      const spec = clean('3.1.0', {
        '/items': {
          get: op({
            operationId: 'list',
            parameters: [{ name: 'q', in: 'querystring', content: { 'application/json': { schema: {} } } }],
          }),
        },
      });
      const generator = await OpenAPIToolGenerator.fromJSON(spec);
      const [tool] = await generator.generateTools();
      expect(tool.name).toBe('list');
      expect(tool.mapper).toEqual([
        {
          inputKey: 'q',
          type: 'query',
          key: 'q',
          required: false,
          serialization: { contentType: 'application/json' },
          wholeQuery: true,
        },
      ]);
      expect(codes(generator)).toEqual(['FEATURE_NEWER_THAN_DECLARED_VERSION']);
    });
  });

  describe('generateTool method lookup', () => {
    const spec = clean('3.2.0', { '/items': { get: op(), additionalOperations: { LINK: op() } } });

    it('normalizes a standard method given in any case to its lowercase field name', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(spec);
      const tool = await generator.generateTool('/items', 'GET');
      expect(tool.name).toBe('get_items');
      expect(tool.metadata.method).toBe('get');
      expect(tool.description).toBe('GET /items');
    });

    it('finds an additional method exactly as written only', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(spec);
      expect((await generator.generateTool('/items', 'LINK')).metadata.method).toBe('LINK');
      await expect(generator.generateTool('/items', 'link')).rejects.toThrow('Operation not found: link /items');
    });

    it('never resolves a path or a method through the prototype chain', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(spec);
      await expect(generator.generateTool('/items', 'constructor')).rejects.toThrow(
        'Operation not found: constructor /items',
      );
      await expect(generator.generateTool('constructor', 'get')).rejects.toThrow('Operation not found: GET constructor');
      await expect(generator.generateTool('/items', 5 as unknown as string)).rejects.toThrow(
        'Operation not found: 5 /items',
      );
    });

    it('records the diagnostics of the path item it builds from, once', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/items': { get: op({ operationId: 'a' }), additionalOperations: { GET: op(), Get: op(), LINK: op({ operationId: 'b' }) } },
          '/other': { additionalOperations: { CONNECT: op() } },
        }),
        { validate: false },
      );
      await generator.generateTool('/items', 'LINK');
      await generator.generateTool('/items', 'get');
      await generator.generateTool('/items', 'LINK');
      expect(generator.getDiagnostics().map((d) => [d.code, d.path])).toEqual([
        ['DUPLICATE_FIXED_METHOD', '/paths/~1items/additionalOperations/GET'],
        ['METHOD_CASE_VARIANT', '/paths/~1items/additionalOperations/Get'],
      ]);
      // a path never built from is not walked; a missing path records nothing
      await expect(generator.generateTool('/nope', 'get')).rejects.toThrow('Operation not found');
      expect(generator.getDiagnostics()).toHaveLength(2);
    });
  });

  describe('hostile path items', () => {
    it('reads only method fields and usable additionalOperations keys', async () => {
      // JSON.parse creates own `__proto__` keys, which survive the generator's JSON clone
      const document = JSON.parse(`{
        "openapi": "3.2.0",
        "info": { "title": "T", "version": "1.0.0" },
        "servers": [{ "url": "https://api.example.com" }],
        "paths": {
          "/items": {
            "constructor": { "operationId": "fake1", "responses": { "200": { "description": "OK" } } },
            "__proto__": { "operationId": "fake2", "responses": { "200": { "description": "OK" } } },
            "get": { "operationId": "listItems", "responses": { "200": { "description": "OK" } } },
            "additionalOperations": {
              "GET": { "operationId": "dupGet", "responses": { "200": { "description": "OK" } } },
              "CONNECT": { "operationId": "tunnel", "responses": { "200": { "description": "OK" } } },
              "in valid token": { "operationId": "spaced", "responses": { "200": { "description": "OK" } } },
              "constructor": { "responses": { "200": { "description": "OK" } } },
              "__proto__": { "responses": { "200": { "description": "OK" } } }
            }
          }
        }
      }`);
      expect(Object.hasOwn(document.paths['/items'], '__proto__')).toBe(true);

      const generator = await OpenAPIToolGenerator.fromJSON(document, { validate: false });
      const tools = await generator.generateTools();
      // `constructor` and `__proto__` are valid method tokens: as additionalOperations keys they are operations
      expect(tools.map((t) => [t.name, t.metadata.method])).toEqual([
        ['listItems', 'get'],
        ['proto_items', '__proto__'],
        ['constructor_items', 'constructor'],
      ]);
      // in the document's key order
      expect(generator.getDiagnostics().map((d) => [d.code, d.path])).toEqual([
        ['DUPLICATE_FIXED_METHOD', '/paths/~1items/additionalOperations/GET'],
        ['REFUSED_METHOD', '/paths/~1items/additionalOperations/CONNECT'],
        ['INVALID_METHOD_TOKEN', '/paths/~1items/additionalOperations/in valid token'],
      ]);
      // the fixed `get`, never the `GET` key; `constructor` is the additional operation, not Object's
      expect((await generator.generateTool('/items', 'GET')).name).toBe('listItems');
      expect((await generator.generateTool('/items', 'constructor')).metadata.method).toBe('constructor');
    });

    it('keeps own __proto__ keys own through the internal dereferencer', async () => {
      // A path item key `__proto__` once became the path item's prototype, so its `x-mcp` was inherited
      const document = JSON.parse(`{
        "openapi": "3.2.0",
        "info": { "title": "T", "version": "1.0.0" },
        "components": { "pathItems": { "P": { "__proto__": { "x-mcp": { "enabled": false } },
          "post": { "operationId": "viaRef", "responses": { "200": { "description": "OK" } } } } } },
        "paths": {
          "/a": { "__proto__": { "x-mcp": { "enabled": false } },
            "get": { "operationId": "direct", "responses": { "200": { "description": "OK" } } } },
          "/b": { "$ref": "#/components/pathItems/P" }
        }
      }`);
      for (const dereference of [true, false]) {
        const generator = await OpenAPIToolGenerator.fromJSON(document, { dereference, validate: false });
        // without dereferencing, a path item that is a reference is skipped, as before
        expect(await names(generator)).toEqual(dereference ? ['direct', 'viaRef'] : ['direct']);
      }
      const generator = await OpenAPIToolGenerator.fromJSON(document, { validate: false });
      await generator.generateTools();
      for (const path of ['/a', '/b']) {
        const pathItem = generator.getDocument().paths![path]!;
        expect(Object.getPrototypeOf(pathItem)).toBe(Object.prototype);
        expect(Object.hasOwn(pathItem, '__proto__')).toBe(true);
      }
    });

    it('rejects invalid additionalOperations keys when validating, without saying they are ignored', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', { '/items': { get: op(), additionalOperations: { GET: op(), 'in valid': op() } } }),
      );
      await expect(generator.generateTools()).rejects.toThrow(ParseError);
      await expect(generator.generateTools()).rejects.toThrow(
        'Invalid OpenAPI document: additionalOperations key "GET" is the method of the fixed `get` field, which the ' +
          "specification forbids (and 1 more; see the error's context.errors)",
      );
    });

    it('reports a path item that is not an object, and ignores paths that are not an object', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.0.3', { '/a': null, '/b': { get: op({ operationId: 'b' }) } }),
        { validate: false },
      );
      expect(await names(generator)).toEqual(['b']);
      expect(generator.getDiagnostics()).toEqual([
        expect.objectContaining({ code: 'PATH_ITEM_NOT_OBJECT', path: '/paths/~1a', severity: 'warning' }),
      ]);

      const noPaths = await OpenAPIToolGenerator.fromJSON({ ...clean('3.0.3', {}), paths: 'nope' }, { validate: false });
      expect(await noPaths.generateTools()).toEqual([]);
    });
  });

  describe('bounded work and output on hostile documents', () => {
    it('generates thousands of additional operations on one path in linear time', async () => {
      const count = 4000;
      const additionalOperations = Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`M${String(i).padStart(4, '0')}`, op({ operationId: `op${i}` })]),
      );
      const generator = await OpenAPIToolGenerator.fromJSON(clean('3.2.0', { '/x': { additionalOperations } }));
      const started = Date.now();
      const tools = await generator.generateTools();
      expect(tools).toHaveLength(count);
      expect(tools[count - 1].metadata.method).toBe('M3999');
      // generateTool looks one key up and walks the path item once, not per call
      for (let i = 0; i < count; i += 4) {
        await generator.generateTool('/x', `M${String(i).padStart(4, '0')}`);
      }
      // generous backstop: the quadratic lookup took ~15 s for this size
      expect(Date.now() - started).toBeLessThan(10_000);
    }, 30_000);

    it('keeps at most MAX_DIAGNOSTICS diagnostics, then one DIAGNOSTICS_TRUNCATED entry', async () => {
      const additionalOperations = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`bad key ${i}`, op()]));
      const generator = await OpenAPIToolGenerator.fromJSON(clean('3.2.0', { '/x': { additionalOperations } }), {
        validate: false,
      });
      expect(await generator.generateTools()).toEqual([]);
      const diagnostics = generator.getDiagnostics();
      expect(diagnostics).toHaveLength(MAX_DIAGNOSTICS + 1);
      expect(diagnostics.slice(0, -1).every((d) => d.code === 'INVALID_METHOD_TOKEN')).toBe(true);
      expect(diagnostics[MAX_DIAGNOSTICS]).toEqual({
        severity: 'warning',
        code: 'DIAGNOSTICS_TRUNCATED',
        message: `Only the first ${MAX_DIAGNOSTICS} diagnostics are kept; later findings were not recorded`,
      });
      // a duplicate of a kept finding is still recognised, and the truncation entry stays single
      await generator.generateTools();
      expect(generator.getDiagnostics()).toEqual(diagnostics);
    });

    it('bounds and escapes document text in diagnostics and error messages', async () => {
      const hostile = `/${'a'.repeat(200_000)}\n\u001b[31mred`;
      const spec = clean('3.2.0', {
        [hostile]: { get: op({ operationId: 'a', parameters: [{ name: 'q', in: 'querystring', content: {} }] }) },
      });
      const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
      expect(await generator.generateTools()).toEqual([]);
      const [diagnostic] = generator.getDiagnostics();
      expect(diagnostic.code).toBe('QUERYSTRING_PARAMETER_WITHOUT_CONTENT');
      expect(diagnostic.message.length).toBeLessThan(1300);
      expect(diagnostic.path!.length).toBeLessThan(400);
      for (const text of [diagnostic.message, diagnostic.path!]) expect(text).not.toMatch(/[\u0000-\u001f]/);

      // a key that is not a path, cut and escaped in the ParseError message; in full in context.errors
      const invalid = await OpenAPIToolGenerator.fromJSON(clean('3.0.3', { [hostile.slice(1)]: { get: op() } }));
      const error = await invalid.generateTools().catch((e: unknown) => e as ParseError);
      expect(error).toBeInstanceOf(ParseError);
      expect(error.message.length).toBeLessThan(700);
      expect(error.message).toMatch(/^Invalid OpenAPI document: Path must start with '\/': a+\.\.\.$/);
      expect(error.message).not.toMatch(/[\u0000-\u001f]/);
      expect(error.context!['errors'][0].path.length).toBe('/paths/'.length + 1024 + 3);
    });
  });

  describe('declared versions', () => {
    const paths = { '/items': { get: op({ operationId: 'listItems' }) } };

    it.each(['3.0.4', '3.1.2', '3.2.0', '3.2.1-rc1'])('loads %s without diagnostics', async (version) => {
      const generator = await OpenAPIToolGenerator.fromJSON(clean(version, paths));
      expect(await names(generator)).toEqual(['listItems']);
      expect(generator.getDiagnostics()).toEqual([]);
      expect(generator.getSpecVersion().status).toBe('supported');
    });

    it('loads a newer 3.x minor version with exactly one diagnostic', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(clean('3.3.0', paths));
      expect(codes(generator)).toEqual(['NEWER_OPENAPI_VERSION']);
      expect(await names(generator)).toEqual(['listItems']);
      // the validator reports the same warning; it is kept once
      expect(generator.getDiagnostics()).toEqual([
        {
          severity: 'warning',
          code: 'NEWER_OPENAPI_VERSION',
          message: expect.stringContaining('newer than the latest version this library knows (3.2)'),
          path: '/openapi',
        },
      ]);
      expect(generator.getSpecVersion()).toMatchObject({ status: 'newer-minor', family: '3.2', major: 3, minor: 3 });
    });

    it('rejects another major version with a clear error, and reports it when validation is off', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(clean('4.0.0', paths));
      await expect(generator.generateTools()).rejects.toThrow(
        'Invalid OpenAPI document: Unsupported version: OpenAPI "4.0.0". Expected OpenAPI 3.0.x, 3.1.x or 3.2.x',
      );

      const lenient = await OpenAPIToolGenerator.fromJSON(clean('4.0.0', paths), { validate: false });
      expect(await names(lenient)).toEqual(['listItems']);
      expect(lenient.getDiagnostics()).toEqual([
        expect.objectContaining({ code: 'INVALID_OPENAPI_VERSION', path: '/openapi', severity: 'warning' }),
      ]);
      expect(lenient.getSpecVersion()).toMatchObject({ status: 'unsupported', major: 4, minor: 0 });
      expect(lenient.getSpecVersion().family).toBeUndefined();
    });

    it('names Swagger 2.0 and a missing version in its diagnostics', async () => {
      const swagger = await OpenAPIToolGenerator.fromJSON(
        { swagger: '2.0', info: { title: 'T', version: '1' }, paths: {} },
        { validate: false },
      );
      expect(swagger.getDiagnostics()).toEqual([
        expect.objectContaining({
          code: 'INVALID_OPENAPI_VERSION',
          path: '/swagger',
          message: expect.stringContaining('Swagger 2.0 documents are not supported'),
        }),
      ]);
      const missing = await OpenAPIToolGenerator.fromJSON(
        { info: { title: 'T', version: '1' }, paths: {} },
        { validate: false },
      );
      expect(missing.getDiagnostics()).toEqual([
        expect.objectContaining({ code: 'MISSING_OPENAPI_VERSION', path: '/openapi' }),
      ]);
      expect(missing.getSpecVersion().status).toBe('missing');
    });

    it('reports conflicting version fields, and returns copies', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(clean('3.1.0', paths, { swagger: '2.0' }));
      const version = generator.getSpecVersion();
      expect(version.diagnostics.map((d) => d.code)).toEqual(['CONFLICTING_VERSION_FIELDS']);
      version.diagnostics[0].message = 'changed';
      version.status = 'malformed';
      const diagnostics = generator.getDiagnostics();
      diagnostics[0].message = 'changed';
      diagnostics.push({ severity: 'info', code: 'X', message: 'x' });

      expect(generator.getSpecVersion().status).toBe('supported');
      expect(generator.getSpecVersion().diagnostics[0].message).not.toBe('changed');
      expect(generator.getDiagnostics()).toEqual([
        expect.objectContaining({ code: 'CONFLICTING_VERSION_FIELDS', message: expect.not.stringContaining('changed') }),
      ]);
    });

    it('reads the version after overlays', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(clean('3.0.3', paths), {
        overlays: {
          overlay: '1.0.0',
          info: { title: 'o', version: '1' },
          actions: [{ target: '$', update: { openapi: '3.3.0' } }],
        },
      });
      expect(generator.getSpecVersion().declared).toBe('3.3.0');
    });
  });

  describe('diagnostics channel', () => {
    it('adds validator warnings once validation has run, never twice', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON({
        openapi: '3.0.3',
        info: { title: 'T', version: '1.0.0' },
        paths: { '/items': { get: op() } },
      });
      expect(generator.getDiagnostics()).toEqual([]);
      await generator.lint(); // lint never validates
      expect(generator.getDiagnostics()).toEqual([]);

      await generator.generateTools();
      const first = generator.getDiagnostics();
      // a forwarded legacy validator code keeps its historical path
      expect(first.map((d) => [d.code, d.path])).toEqual([
        ['NO_OPERATION_ID', '/paths//items/get/operationId'],
        ['NO_SERVERS', '/servers'],
      ]);
      await generator.generateTools();
      await generator.generateTool('/items', 'get');
      expect(generator.getDiagnostics()).toEqual(first);
    });

    it('validates once per generator', async () => {
      const spy = jest.spyOn(Validator.prototype, 'validate');
      try {
        const generator = await OpenAPIToolGenerator.fromJSON(
          clean('3.0.3', { '/a': { get: op({ operationId: 'a' }), post: op({ operationId: 'b' }) } }),
        );
        await generator.generateTools();
        await generator.generateTools();
        await generator.generateTool('/a', 'post');
        expect(spy).toHaveBeenCalledTimes(1);
        // the public validate() still runs on demand
        await generator.validate();
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('keeps a finding reported by both the validator and the walker once', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', { '/items': { get: op({ operationId: 'a' }), additionalOperations: { CONNECT: op(), Post: op() } } }),
      );
      expect(await names(generator)).toEqual(['a']);
      expect(generator.getDiagnostics().map((d) => [d.code, d.path])).toEqual([
        ['REFUSED_METHOD', '/paths/~1items/additionalOperations/CONNECT'],
        ['METHOD_CASE_VARIANT', '/paths/~1items/additionalOperations/Post'],
      ]);
    });

    it('reports a fixed field holding null, which validation skips silently', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.0.3', { '/items': { get: op({ operationId: 'a' }), put: null } }),
      );
      expect(await generator.validate()).toEqual({ valid: true, errors: undefined, warnings: undefined });
      expect(await names(generator)).toEqual(['a']);
      expect(generator.getDiagnostics().map((d) => [d.code, d.path])).toEqual([['OPERATION_NOT_OBJECT', '/paths/~1items/put']]);
    });

    it('accepts an operation without responses from 3.1 on, and requires it in 3.0', async () => {
      const paths = { '/items': { get: { operationId: 'listItems' } } };
      const v31 = await OpenAPIToolGenerator.fromJSON(clean('3.1.0', paths));
      expect(await names(v31)).toEqual(['listItems']);
      const v30 = await OpenAPIToolGenerator.fromJSON(clean('3.0.3', paths));
      await expect(v30.generateTools()).rejects.toThrow(
        'Invalid OpenAPI document: Operation missing responses: GET /items',
      );
    });

    it('lists only codes of the DIAGNOSTIC_CODES registry', async () => {
      const spec = clean(
        '3.2.0',
        {
          '/a': null,
          '/b': {
            get: op(),
            put: 'x',
            query: op({ parameters: [{ name: 'q', in: 'querystring', content: {} }] }),
            additionalOperations: { GET: op(), Get: op(), CONNECT: op(), 'a b': op(), LINK: 5 },
          },
          '/c': { additionalOperations: [] },
          '/d': { get: op({ security: [{ nope: [] }] }), post: op({ security: [null, { k: [] }] }) },
        },
        { swagger: '2.0', components: { securitySchemes: { k: { type: 'http', scheme: 'basic' } } } },
      );
      const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
      await generator.generateTools();
      const found = new Set(codes(generator));
      const registry = new Set<string>(Object.values(DIAGNOSTIC_CODES));
      expect([...found].filter((code) => !registry.has(code))).toEqual([]);
      expect(found.size).toBeGreaterThanOrEqual(12);
    });
  });

  describe('security requirements naming unknown schemes', () => {
    const schemes = { components: { securitySchemes: { basic: { type: 'http', scheme: 'basic' } } } };
    const securedSpec = (security: unknown, extra: Record<string, unknown> = schemes) =>
      clean('3.2.0', { '/pets': { put: op({ operationId: 'updatePet', security }) } }, extra);

    it('keeps the resolvable alternative when another names a scheme by URI', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        securedSpec([{ basic: ['write'] }, { 'otherapi#/components/securitySchemes/generic_auth': ['read'] }]),
      );
      const tools = await generator.generateTools();
      expect(tools.map((t) => t.name)).toEqual(['updatePet']);
      expect(tools[0].metadata.security?.map((s) => s.scheme)).toEqual(['basic']);
      expect(tools[0].mapper.filter((m) => m.security).map((m) => m.security!.scheme)).toEqual(['basic']);
      expect(generator.getDiagnostics()).toEqual([
        {
          severity: 'warning',
          code: 'UNRESOLVED_SECURITY_SCHEME',
          message:
            'Security Requirement names scheme "otherapi#/components/securitySchemes/generic_auth", which ' +
            'components.securitySchemes does not define, and read as a URI it cannot be resolved: the document has ' +
            'no base URI (load it with fromURL or fromFile, or pass LoadOptions.documentUri); the requirement ' +
            'cannot be satisfied and is dropped with every scheme it combines',
          path: '/paths/~1pets/put/security/1/otherapi#~1components~1securitySchemes~1generic_auth',
        },
      ]);
      // generateTool directly no longer throws a TypeError either
      expect((await generator.generateTool('/pets', 'put')).name).toBe('updatePet');
    });

    it.each([
      ['a single missing scheme', [{ missing: [] }], [['UNRESOLVED_SECURITY_SCHEME', '/paths/~1pets/put/security/0/missing']]],
      [
        'a resolvable scheme required together with a missing one',
        [{ basic: [], missing: [] }],
        [['UNRESOLVED_SECURITY_SCHEME', '/paths/~1pets/put/security/0/missing']],
      ],
      [
        'only unresolvable alternatives',
        [{ a: [] }, { b: [] }, null],
        [
          ['UNRESOLVED_SECURITY_SCHEME', '/paths/~1pets/put/security/0/a'],
          ['UNRESOLVED_SECURITY_SCHEME', '/paths/~1pets/put/security/1/b'],
          ['INVALID_SECURITY_REQUIREMENT', '/paths/~1pets/put/security/2'],
        ],
      ],
    ])('makes no tool for %s, without a console warning', async (_label, security, findings) => {
      const warn = silenceWarnings();
      try {
        const generator = await OpenAPIToolGenerator.fromJSON(securedSpec(security), { validate: false });
        expect(await names(generator)).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
        expect(generator.getDiagnostics().map((d) => [d.code, d.path])).toEqual([
          ...findings,
          ['UNSATISFIABLE_SECURITY', '/paths/~1pets/put'],
        ]);
        expect(generator.getDiagnostics().at(-1)!.message).toMatch(
          /^PUT \/pets: none of its Security Requirements can be satisfied .*; the operation makes no tool$/,
        );
        await expect(generator.generateTool('/pets', 'put')).rejects.toThrow(GenerationError);
        await expect(generator.generateTool('/pets', 'put')).rejects.toThrow('PUT /pets: none of its Security');
      } finally {
        warn.mockRestore();
      }
    });

    it('keeps the meaning of an empty requirement and of an empty security list', async () => {
      const optional = await OpenAPIToolGenerator.fromJSON(securedSpec([{ missing: [] }, {}]));
      const [optionalTool] = await optional.generateTools();
      expect(optionalTool.metadata.security).toEqual([]);
      expect(codes(optional)).toEqual(['UNRESOLVED_SECURITY_SCHEME']);

      const open = await OpenAPIToolGenerator.fromJSON(securedSpec([]));
      const [openTool] = await open.generateTools();
      expect(openTool.metadata.security).toEqual([]);
      expect(codes(open)).toEqual([]);
    });

    it('reports a document-level unknown scheme once for every tool it applies to', async () => {
      const spec = clean(
        '3.0.3',
        { '/a': { get: op({ operationId: 'a' }) }, '/b': { get: op({ operationId: 'b' }) } },
        { security: [{ missing: [], constructor: [] }, { basic: [] }], ...schemes },
      );
      const generator = await OpenAPIToolGenerator.fromJSON(spec);
      const tools = await generator.generateTools();
      expect(tools.map((t) => t.metadata.security?.map((s) => s.scheme))).toEqual([['basic'], ['basic']]);
      expect(generator.getDiagnostics().map((d) => [d.code, d.path, d.message.includes('URI')])).toEqual([
        ['UNRESOLVED_SECURITY_SCHEME', '/security/0/missing', false],
        ['UNRESOLVED_SECURITY_SCHEME', '/security/0/constructor', false],
      ]);
    });

    it('keeps generating, as before, when the document defines no security schemes at all', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(securedSpec([{ token: [] }, null], {}), { validate: false });
      const [tool] = await generator.generateTools();
      expect(tool.metadata.security).toEqual([]);
      expect(codes(generator)).toEqual(['UNRESOLVED_SECURITY_SCHEME', 'INVALID_SECURITY_REQUIREMENT']);
    });

    it('fails a tool whose security is not a list when schemes exist, as before, with a typed error', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(securedSpec({ basic: [] }), { validate: false });
      await expect(generator.generateTool('/pets', 'put')).rejects.toThrow(GenerationError);
      await expect(generator.generateTool('/pets', 'put')).rejects.toThrow(
        '/paths/~1pets/put/security must be an array of Security Requirement Objects, found an object',
      );
      const warn = silenceWarnings();
      try {
        expect(await generator.generateTools()).toEqual([]);
        expect(warn).toHaveBeenCalledWith('Failed to generate tool for PUT /pets:', expect.any(String));
      } finally {
        warn.mockRestore();
      }

      // without schemes there was never anything to read: the tool is generated
      const noSchemes = await OpenAPIToolGenerator.fromJSON(securedSpec({ basic: [] }, {}), { validate: false });
      expect((await noSchemes.generateTool('/pets', 'put')).metadata.security).toEqual([]);
    });
  });

  describe('parameters in a location the generator does not map', () => {
    // A Swagger 2.0-style body parameter, which no OpenAPI 3 location maps
    const bodyParameter = { name: 'filter', in: 'body', schema: { type: 'object' } };

    it('skips the operation with a diagnostic instead of leaking into the mapper', async () => {
      const spec = clean('3.2.0', {
        '/search': {
          get: op({ operationId: 'plain' }),
          query: op({ operationId: 'search', parameters: [bodyParameter] }),
        },
      });
      const warn = silenceWarnings();
      try {
        const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
        expect(await names(generator)).toEqual(['plain']);
        expect(warn).not.toHaveBeenCalled();
        expect(generator.getDiagnostics()).toEqual([
          {
            severity: 'warning',
            code: 'UNSUPPORTED_PARAMETER_LOCATION',
            message:
              'QUERY /search: parameter "filter" has location (in) "body", which is not mapped to a request ' +
              '(supported: path, query, querystring, header, cookie); the operation makes no tool',
            path: '/paths/~1search/query/parameters/0',
          },
        ]);
        await expect(generator.generateTool('/search', 'query')).rejects.toThrow(GenerationError);
        await expect(generator.generateTool('/search', 'query')).rejects.toThrow('QUERY /search: parameter "filter"');
        expect(generator.getDiagnostics()).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('checks path-level and additional-operation parameters, and any unmapped location', async () => {
      const spec = clean('3.2.0', {
        '/a': { parameters: [{ name: 'p', in: 'body', schema: {} }], get: op({ operationId: 'a' }) },
        '/b': { additionalOperations: { LINK: op({ operationId: 'b', parameters: [{ name: 'q', schema: {} }] }) } },
        '/c': { get: op({ operationId: 'c', parameters: [null] }) },
      });
      const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
      expect(await generator.generateTools()).toEqual([]);
      expect(generator.getDiagnostics().map((d) => [d.path, d.message.split(', which')[0]])).toEqual([
        ['/paths/~1a/parameters/0', 'GET /a: parameter "p" has location (in) "body"'],
        ['/paths/~1b/additionalOperations/LINK/parameters/0', 'LINK /b: parameter "q" has location (in) undefined'],
        ['/paths/~1c/get/parameters/0', 'GET /c: parameter undefined has location (in) undefined'],
      ]);
    });

    it('applies after the filters, and leaves unresolved references to the resolver as before', async () => {
      const spec = clean(
        '3.0.3',
        {
          '/a': {
            get: op({ operationId: 'a', parameters: [{ $ref: '#/components/parameters/P' }] }),
            post: op({ operationId: 'b', parameters: [{ name: 'x', in: 'body', schema: {} }] }),
          },
        },
        { components: { parameters: { P: { name: 'p', in: 'query', schema: { type: 'string' } } } } },
      );
      const generator = await OpenAPIToolGenerator.fromJSON(spec, { dereference: false, validate: false });
      expect(await names(generator, { includeMethods: ['get'] })).toEqual(['a']);
      expect(generator.getDiagnostics()).toEqual([]);
    });
  });

  describe('method filters', () => {
    const spec = clean('3.2.0', {
      '/items': {
        get: op({ operationId: 'list' }),
        post: op({ operationId: 'create' }),
        query: op({ operationId: 'search' }),
        additionalOperations: { LINK: op({ operationId: 'link' }) },
      },
    });
    const namesFor = async (options: GenerateOptions): Promise<string[]> =>
      names(await OpenAPIToolGenerator.fromJSON(spec), options);

    it('match standard methods in any case', async () => {
      expect(await namesFor({ includeMethods: ['GET'] })).toEqual(['list']);
      expect(await namesFor({ includeMethods: ['Get', 'QUERY'] })).toEqual(['list', 'search']);
      expect(await namesFor({ excludeMethods: ['POST', 'query'] })).toEqual(['list', 'link']);
    });

    it('match additional methods exactly as written', async () => {
      expect(await namesFor({ includeMethods: ['LINK'] })).toEqual(['link']);
      expect(await namesFor({ includeMethods: ['link'] })).toEqual([]);
      expect(await namesFor({ excludeMethods: ['LINK'] })).toEqual(['list', 'create', 'search']);
    });

    it('treat query as read-only and an additional method as not', async () => {
      expect(await namesFor({ readOnlyOnly: true })).toEqual(['list', 'search']);
    });
  });
});

describe('OpenAPI 3.2 parameters and responses (issue #55)', () => {
  const ok = { '200': { description: 'OK' } };
  const op = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ responses: ok, ...extra });
  const clean = (openapi: string, paths: Record<string, unknown>, extra: Record<string, unknown> = {}): any => ({
    openapi,
    info: { title: 'T', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    paths,
    ...extra,
  });
  const diagnostics = (generator: OpenAPIToolGenerator) => generator.getDiagnostics().map((d) => [d.code, d.path]);
  const qs = (name = 'q', content: unknown = { 'application/json': { schema: { type: 'object' } } }) => ({
    name,
    in: 'querystring',
    content,
  });

  describe('parameters defined with content', () => {
    it('types the input from the media type and serializes the value in it (any version)', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.0.3', {
          '/pets': {
            get: op({
              operationId: 'listPets',
              parameters: [
                {
                  name: 'filter',
                  in: 'query',
                  content: {
                    'application/json': {
                      schema: { type: 'object', properties: { color: { type: 'string', nullable: true } } },
                    },
                  },
                },
              ],
            }),
          },
        }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.inputSchema.properties).toEqual({
        filter: {
          type: 'object',
          properties: { color: { type: ['string', 'null'] } },
          'x-parameter-location': 'query',
          'x-parameter-content-type': 'application/json',
        },
      });
      expect(tool.mapper).toEqual([
        { inputKey: 'filter', type: 'query', key: 'filter', required: false, serialization: { contentType: 'application/json' } },
      ]);
      expect(generator.getDiagnostics()).toEqual([]);
    });

    it('copies the media type encoding into the mapper, sharing nothing with the document', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/s': {
            get: op({
              operationId: 's',
              parameters: [
                qs('search', {
                  'application/x-www-form-urlencoded': {
                    schema: { type: 'object' },
                    encoding: { tags: { style: 'pipeDelimited', explode: false } },
                  },
                }),
              ],
            }),
          },
        }),
      );
      const [tool] = await generator.generateTools();
      const encoding = tool.mapper[0].serialization!.encoding!;
      expect(encoding).toEqual({ tags: { style: 'pipeDelimited', explode: false } });
      const documentEncoding = (generator.getDocument() as any).paths['/s'].get.parameters[0].content[
        'application/x-www-form-urlencoded'
      ].encoding;
      expect(encoding).not.toBe(documentEncoding);
      expect(encoding.tags).not.toBe(documentEncoding.tags);
    });

    it('reads one of several media types with an INVALID_PARAMETER_CONTENT warning, recorded once', async () => {
      const spec = clean('3.1.0', {
        '/a': {
          parameters: [{ name: 'f', in: 'header', content: { 'text/plain': {}, 'application/json': {} } }],
          get: op({ operationId: 'a' }),
          post: op({ operationId: 'b' }),
        },
      });
      for (const validate of [true, false]) {
        const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate });
        const tools = await generator.generateTools();
        expect(tools.map((t) => t.mapper[0].serialization)).toEqual([
          { contentType: 'application/json' },
          { contentType: 'application/json' },
        ]);
        expect(generator.getDiagnostics()).toEqual([
          {
            severity: 'warning',
            code: 'INVALID_PARAMETER_CONTENT',
            message:
              'Parameter "f" (in: "header"): content must hold exactly one media type, found 2 media types; ' +
              '"application/json" is used',
            path: '/paths/~1a/parameters/0',
          },
        ]);
      }
    });

    it('reports content of a parameter that applies only, pointing at the operation list', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.0.3', {
          '/a': {
            parameters: [{ name: 'f', in: 'query', content: {} }],
            get: op({ operationId: 'a', parameters: [{ name: 'f', in: 'query', content: 'text/plain' }] }),
          },
        }),
        { validate: false },
      );
      const [tool] = await generator.generateTools();
      expect(tool.inputSchema.properties).toEqual({ f: { type: 'string', 'x-parameter-location': 'query' } });
      expect(diagnostics(generator)).toEqual([['INVALID_PARAMETER_CONTENT', '/paths/~1a/get/parameters/0']]);
    });
  });

  describe('in: querystring', () => {
    it('makes a whole-query mapper entry, alongside path, header and cookie parameters', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/items/{id}': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            query: op({
              operationId: 'searchItems',
              parameters: [qs('page'), { name: 'X-Trace', in: 'header', schema: { type: 'string' } }],
            }),
          },
        }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.mapper.map((m) => [m.inputKey, m.type, m.wholeQuery])).toEqual([
        ['id', 'path', undefined],
        ['page', 'query', true],
        ['X-Trace', 'header', undefined],
      ]);
      // its key is never sent, so it is not a pagination control
      expect(tool.metadata.responseHints).toBeUndefined();
      expect(generator.getDiagnostics()).toEqual([]);
    });

    it('skips an operation with more than one, path-level ones included (validate: false)', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/s': { parameters: [qs('q')], get: op({ operationId: 's', parameters: [qs('r')] }), post: op({ operationId: 'p' }) },
        }),
        { validate: false },
      );
      expect((await generator.generateTools()).map((t) => t.name)).toEqual(['p']);
      expect(generator.getDiagnostics()).toEqual([
        {
          severity: 'warning',
          code: 'MULTIPLE_QUERYSTRING_PARAMETERS',
          message:
            'GET /s: 2 parameters are in: querystring (path-level ones included), but at most one is allowed, as ' +
            'each holds the whole query string; the operation makes no tool',
          path: '/paths/~1s/get/parameters/0',
        },
      ]);
      await expect(generator.generateTool('/s', 'get')).rejects.toThrow(GenerationError);
      // the validator rejects the same document
      await expect((await OpenAPIToolGenerator.fromJSON(clean('3.2.0', { '/s': { parameters: [qs('q')], get: op({ operationId: 's', parameters: [qs('r')] }) } }))).generateTools()).rejects.toThrow(ParseError);
    });

    it('skips an operation combining it with query parameters, path-level ones included', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/s': {
            parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
            get: op({ operationId: 's', parameters: [qs('filter')] }),
          },
        }),
        { validate: false },
      );
      expect(await generator.generateTools()).toEqual([]);
      expect(generator.getDiagnostics()).toEqual([
        {
          severity: 'warning',
          code: 'QUERYSTRING_WITH_QUERY_PARAMETERS',
          message:
            'GET /s: parameter "filter" is in: querystring, which holds the whole query string, but the operation ' +
            'also has parameters in: query (path-level ones included); the operation makes no tool',
          path: '/paths/~1s/get/parameters/0',
        },
      ]);
    });

    it('skips an operation whose querystring parameter has no media type', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/a': { parameters: [{ name: 'q', in: 'querystring', schema: { type: 'string' } }], get: op({ operationId: 'a' }) },
          '/b': { get: op({ operationId: 'b', parameters: [qs('q', {})] }) },
          '/c': { get: op({ operationId: 'c', parameters: [qs('q', ['application/json'])] }) },
        }),
        { validate: false },
      );
      expect(await generator.generateTools()).toEqual([]);
      expect(generator.getDiagnostics().map((d) => [d.path, d.message])).toEqual([
        [
          '/paths/~1a/parameters/0',
          'GET /a: parameter "q" is in: querystring but has no content; it must define content with one media type, ' +
            'which serializes the whole query string; the operation makes no tool',
        ],
        [
          '/paths/~1b/get/parameters/0',
          'GET /b: parameter "q" is in: querystring but has a content with no media type; it must define content ' +
            'with one media type, which serializes the whole query string; the operation makes no tool',
        ],
        [
          '/paths/~1c/get/parameters/0',
          'GET /c: parameter "q" is in: querystring but has a content that is not a map of media types (an array); ' +
            'it must define content with one media type, which serializes the whole query string; the operation ' +
            'makes no tool',
        ],
      ]);
    });

    it('lets an operation querystring parameter override the path-level one', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/s': {
            parameters: [qs('q', { 'text/plain': {} })],
            get: op({ operationId: 's', parameters: [qs('q', { 'application/json': { schema: { type: 'object' } } })] }),
          },
        }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.mapper).toEqual([
        expect.objectContaining({ inputKey: 'q', wholeQuery: true, serialization: { contentType: 'application/json' } }),
      ]);
    });
  });

  describe('path-level and operation-level parameters', () => {
    it('lets the operation parameter override the path-level one: one input key, sent once', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.1.0', {
          '/pets': {
            parameters: [
              { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
              { name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' } },
            ],
            get: op({
              operationId: 'listPets',
              parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer', maximum: 20 } }],
            }),
          },
        }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.mapper.map((m) => [m.inputKey, m.type, m.key, m.required])).toEqual([
        ['X-Tenant', 'header', 'X-Tenant', true],
        ['limit', 'query', 'limit', true],
      ]);
      expect((tool.inputSchema.properties as any).limit.maximum).toBe(20);
      expect(tool.metadata.responseHints).toEqual({ paginationParams: ['limit'] });
      expect(generator.getDiagnostics()).toEqual([]);
    });

    it('uses the last of a repeated parameter with a DUPLICATE_PARAMETER warning, once per finding', async () => {
      const page = (type: string) => ({ name: 'page', in: 'query', schema: { type } });
      const spec = clean('3.0.3', {
        '/a': {
          parameters: [page('string'), page('number')],
          get: op({ operationId: 'a' }),
          put: op({ operationId: 'b', parameters: [page('boolean'), page('integer')] }),
        },
      });
      for (const validate of [true, false]) {
        const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate });
        const tools = await generator.generateTools();
        expect(tools.map((t) => [t.name, (t.inputSchema.properties as any).page.type, t.mapper.length])).toEqual([
          ['a', 'number', 1],
          ['b', 'integer', 1],
        ]);
        expect(diagnostics(generator)).toEqual([
          ['DUPLICATE_PARAMETER', '/paths/~1a/parameters/0'],
          ['DUPLICATE_PARAMETER', '/paths/~1a/put/parameters/0'],
        ]);
      }
    });

    it('handles parameters named after Object.prototype members', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        JSON.parse(
          JSON.stringify(
            clean('3.0.3', {
              '/a': {
                parameters: [
                  { name: 'constructor', in: 'query', schema: { type: 'string' } },
                  { name: 'toString', in: 'header', schema: { type: 'string' } },
                ],
                get: op({ operationId: 'a', parameters: [{ name: 'constructor', in: 'query', schema: { type: 'integer' } }] }),
              },
            }),
          ),
        ),
      );
      const [tool] = await generator.generateTools();
      expect(tool.mapper.map((m) => m.inputKey)).toEqual(['toString', 'constructor']);
      expect((tool.inputSchema.properties as any).constructor.type).toBe('integer');
      expect(({} as any).type).toBeUndefined();
    });
  });

  describe('request bodies with only itemSchema', () => {
    it('records UNSUPPORTED_STREAMING_REQUEST_BODY and makes the tool without a body input', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/upload': {
            post: op({
              operationId: 'upload',
              requestBody: { required: true, content: { 'application/jsonl': { itemSchema: { type: 'object' } } } },
            }),
          },
        }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.mapper).toEqual([]);
      expect(generator.getDiagnostics()).toEqual([
        {
          severity: 'warning',
          code: 'UNSUPPORTED_STREAMING_REQUEST_BODY',
          message:
            'POST /upload: the request body\'s media type "application/jsonl" declares only itemSchema (a streamed ' +
            'body), which is not supported; the tool takes no body input',
          path: '/paths/~1upload/post/requestBody/content/application~1jsonl/itemSchema',
        },
      ]);
    });

    it('stays silent when the body is read or has nothing to stream', async () => {
      const body = (content: unknown) => op({ requestBody: { content } });
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/a': { post: body({ 'application/json': { schema: { type: 'string' }, itemSchema: { type: 'string' } } }) },
          '/b': { post: body({ 'application/json': {}, 'text/event-stream': { itemSchema: {} } }) },
          '/c': { post: body({ 'text/plain': 'junk' }) },
          '/d': { post: body({ 'text/plain': { itemSchema: null } }) },
          '/e': { post: body('junk') },
          '/f': { post: op({ requestBody: { $ref: '#/nope' } }) },
        }),
        { validate: false, dereference: false },
      );
      expect((await generator.generateTools()).map((t) => t.metadata.path)).toEqual(['/a', '/b', '/c', '/d', '/e', '/f']);
      expect(generator.getDiagnostics().filter((d) => d.code === 'UNSUPPORTED_STREAMING_REQUEST_BODY')).toEqual([]);
    });

    it('keeps the earlier outcome for a request body with an empty content map', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const generator = await OpenAPIToolGenerator.fromJSON(
          clean('3.2.0', { '/a': { post: op({ operationId: 'a', requestBody: { content: {} } }) } }),
          { validate: false },
        );
        expect(await generator.generateTools()).toEqual([]);
        expect(warn).toHaveBeenCalledWith('Failed to generate tool for POST /a:', 'No content type available in request body');
        expect(generator.getDiagnostics()).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('streamed responses (itemSchema)', () => {
    const event = {
      type: 'object',
      required: ['data'],
      properties: {
        data: { type: 'string', example: 'tick', format: 'uuid' },
        id: { type: 'string' },
        retry: { type: 'integer', minimum: 0 },
      },
    };
    const streamDoc = (responses: Record<string, unknown>) =>
      clean('3.2.0', { '/events': { get: { operationId: 'events', responses } } });

    it('exposes the item schema in metadata, with no outputSchema and a streaming hint', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        streamDoc({ 200: { description: 'Events', content: { 'text/event-stream': { itemSchema: event } } } }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.outputSchema).toBeUndefined();
      expect(tool.metadata.responseStatusCodes).toBeUndefined();
      expect(tool.metadata.responseHints).toEqual({ streaming: true });
      expect(tool.metadata.responseStream).toEqual({
        statusCode: 200,
        contentType: 'text/event-stream',
        itemSchema: {
          type: 'object',
          required: ['data'],
          properties: {
            data: { type: 'string', examples: ['tick'], format: 'uuid' },
            id: { type: 'string' },
            retry: { type: 'integer', minimum: 0 },
          },
        },
      });
      // a fresh tree: changing the document afterwards does not reach the tool
      (generator.getDocument() as any).paths['/events'].get.responses[200].content['text/event-stream'].itemSchema.type =
        'string';
      expect(tool.metadata.responseStream!.itemSchema.type).toBe('object');
    });

    it('leaves the other responses as they were', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        streamDoc({
          200: { description: 'Events', content: { 'text/event-stream': { itemSchema: event } } },
          400: { description: 'Bad', content: { 'application/json': { schema: { type: 'object' } } } },
        }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.outputSchema).toEqual({
        type: 'object',
        'x-status-code': 400,
        description: 'Bad',
        'x-content-type': 'application/json',
      });
      expect(tool.metadata.responseStatusCodes).toEqual([400]);
      expect(tool.metadata.responseStream?.statusCode).toBe(200);
    });

    it('keeps outputSchema from schema when the media type has both, and adds the stream', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        streamDoc({
          200: {
            description: 'Lines',
            content: { 'application/jsonl': { schema: { type: 'array', items: event }, itemSchema: event } },
          },
        }),
      );
      const [tool] = await generator.generateTools({ emitTypeSignatures: true });
      expect(tool.outputSchema).toMatchObject({ type: 'array', 'x-content-type': 'application/jsonl' });
      expect(tool.metadata.responseHints).toEqual({ unboundedArray: true, largeResponseRisk: true, streaming: true });
      expect(tool.metadata.responseStream).toMatchObject({ statusCode: 200, contentType: 'application/jsonl' });
      expect(tool.metadata.typescript?.signature).toEqual(expect.any(String));
    });

    it('runs the item schema through formats, depth, trimming and the client target', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        streamDoc({
          200: {
            description: 'Events',
            content: {
              'text/event-stream': {
                itemSchema: {
                  ...event,
                  description: 'One server-sent event, described at length',
                  properties: { ...event.properties, nested: { type: 'object', properties: { deep: { type: 'string' } } } },
                },
              },
            },
          },
        }),
      );
      const [tool] = await generator.generateTools({
        resolveFormats: true,
        maxSchemaDepth: 1,
        stripExamples: true,
        maxDescriptionLength: 10,
        target: 'openai',
      });
      const item = tool.metadata.responseStream!.itemSchema as any;
      expect(item.properties.data.examples).toBeUndefined();
      expect(item.properties.data.pattern).toBeDefined();
      expect(item.description.length).toBeLessThanOrEqual(10);
      expect(item.properties.nested.properties).toBeUndefined();
      expect(item.additionalProperties).toBe(false);
    });

    it('fails the tool like an output schema when the item schema exceeds the node budget', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const generator = await OpenAPIToolGenerator.fromJSON(
          streamDoc({ 200: { description: 'Events', content: { 'text/event-stream': { itemSchema: event } } } }),
        );
        expect(await generator.generateTools({ maxSchemaNodes: 6 })).toEqual([]);
        expect(String(warn.mock.calls[0][1])).toMatch(/maxSchemaNodes/);
        await expect(generator.generateTool('/events', 'get', { maxSchemaNodes: 6 })).rejects.toThrow(SchemaError);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('response summary', () => {
    it('describes a response by its summary when it has no description', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/a': {
            delete: { operationId: 'a', responses: { 204: { summary: 'Deleted' } } },
            get: {
              operationId: 'b',
              responses: { 200: { summary: 'A pet', content: { 'application/json': { schema: { type: 'object' } } } } },
            },
          },
        }),
      );
      const tools = await generator.generateTools();
      expect(tools.map((t) => (t.outputSchema as any).description)).toEqual(['A pet', 'Deleted']);
    });
  });

  describe('server name', () => {
    it('surfaces a string name in metadata.servers, kept when baseUrl replaces the URL', async () => {
      const spec = clean(
        '3.2.0',
        { '/a': { get: op({ operationId: 'a' }) } },
        {
          servers: [
            { url: 'https://eu.example.com', name: 'eu', description: 'Europe' },
            { url: 'https://us.example.com', name: 7 },
            { url: 'https://other.example.com' },
          ],
        },
      );
      const [tool] = await (await OpenAPIToolGenerator.fromJSON(spec)).generateTools();
      expect(tool.metadata.servers).toEqual([
        { url: 'https://eu.example.com', name: 'eu', description: 'Europe' },
        { url: 'https://us.example.com' },
        { url: 'https://other.example.com' },
      ]);
      expect(Object.keys(tool.metadata.servers![0]).slice(0, 3)).toEqual(['url', 'name', 'description']);
      expect('name' in tool.metadata.servers![1]).toBe(false);

      const [based] = await (await OpenAPIToolGenerator.fromJSON(spec, { baseUrl: 'https://proxy.example.com' })).generateTools();
      expect(based.metadata.servers![0]).toEqual({ url: 'https://proxy.example.com', name: 'eu', description: 'Europe' });
    });
  });

  describe('Example Object dataValue', () => {
    it('prefers dataValue over value in parameter and media type examples', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/a': {
            post: op({
              operationId: 'a',
              parameters: [
                {
                  name: 'color',
                  in: 'query',
                  schema: { type: 'array', items: { type: 'string' } },
                  examples: {
                    list: { dataValue: ['blue', 'black'], serializedValue: 'color=blue,black' },
                    legacy: { value: ['red'] },
                    serializedOnly: { serializedValue: 'color=green' },
                  },
                },
              ],
              requestBody: {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { name: { type: 'string' } } },
                    examples: { ada: { dataValue: { name: 'Ada' }, value: { name: 'not used' } } },
                  },
                },
              },
            }),
          },
        }),
      );
      const [tool] = await generator.generateTools({ includeExamples: true });
      expect((tool.inputSchema.properties as any).color.examples).toEqual([['blue', 'black'], ['red']]);
      expect((tool.inputSchema.properties as any).name.examples).toEqual(['Ada']);
    });
  });

  describe('hostile shapes', () => {
    it('reads an enormous content map once, bounded in time and in the diagnostic', async () => {
      const content = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`x-type/${i}`, {}]));
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', { '/a': { get: op({ operationId: 'a', parameters: [{ name: 'f', in: 'query', content }] }) } }),
        { validate: false },
      );
      const started = Date.now();
      const [tool] = await generator.generateTools();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(tool.mapper[0].serialization).toEqual({ contentType: 'x-type/0' });
      const [diagnostic] = generator.getDiagnostics();
      expect(diagnostic.message).toContain('found 50000 media types; "x-type/0" is used');
    });

    it('never throws on content, media types and parameters of the wrong shape', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const parameters = [
          { name: 'a', in: 'query', content: 5 },
          { name: 'b', in: 'query', content: { 'application/json': null } },
          { name: 'c', in: 'cookie', content: { 'application/json': [] } },
          { name: 'd', in: 'query', content: { 'application/json': { schema: 'junk', encoding: 5, examples: 'x' } } },
          { name: 5, in: 'query', content: { 'text/plain': {} } },
        ];
        const generator = await OpenAPIToolGenerator.fromJSON(
          clean('3.2.0', { '/a': { get: op({ operationId: 'a', parameters }) } }),
          { validate: false },
        );
        const [tool] = await generator.generateTools({ includeExamples: true });
        expect(warn).not.toHaveBeenCalled();
        expect(tool.mapper.map((m) => [m.inputKey, m.type, m.serialization?.contentType ?? null, m.wholeQuery ?? false])).toEqual([
          ['a', 'query', null, false],
          ['b', 'query', 'application/json', false],
          ['c', 'cookie', 'application/json', false],
          ['d', 'query', 'application/json', false],
          // a name that is not a string is kept as it was
          [5, 'query', 'text/plain', false],
        ]);
        expect(diagnostics(generator)).toEqual([
          ['INVALID_PARAMETER_CONTENT', '/paths/~1a/get/parameters/0'],
          ['INVALID_PARAMETER_CONTENT', '/paths/~1a/get/parameters/1'],
          ['INVALID_PARAMETER_CONTENT', '/paths/~1a/get/parameters/2'],
          // no Media Type Object: the JSON value is unconstrained, so it may be a string
          ['COOKIE_CONTENT_NOT_SENDABLE', '/paths/~1a/get/parameters/2'],
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    it('lists only codes of the DIAGNOSTIC_CODES registry for the new findings', () => {
      for (const code of [
        'MULTIPLE_QUERYSTRING_PARAMETERS',
        'QUERYSTRING_WITH_QUERY_PARAMETERS',
        'QUERYSTRING_PARAMETER_WITHOUT_CONTENT',
        'INVALID_PARAMETER_CONTENT',
        'DUPLICATE_PARAMETER',
        'UNSUPPORTED_STREAMING_REQUEST_BODY',
      ]) {
        expect(DIAGNOSTIC_CODES).toHaveProperty(code, code);
      }
    });
  });
});

describe('OpenAPI 3.2 parameters and responses: review fixes (issue #55)', () => {
  const ok = { '200': { description: 'OK' } };
  const op = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ responses: ok, ...extra });
  const clean = (openapi: string, paths: Record<string, unknown>, extra: Record<string, unknown> = {}): any => ({
    openapi,
    info: { title: 'T', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    paths,
    ...extra,
  });
  const diagnostics = (generator: OpenAPIToolGenerator) => generator.getDiagnostics().map((d) => [d.code, d.path]);
  const json = (schema: unknown = { type: 'object' }) => ({ 'application/json': { schema } });

  describe('header names in any case', () => {
    it('lets an operation header override a path-level one spelt differently, sending the operation spelling once', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.1.0', {
          '/a': {
            parameters: [{ name: 'X-Id', in: 'header', required: true, schema: { type: 'string' } }],
            get: op({ operationId: 'a', parameters: [{ name: 'x-id', in: 'header', schema: { type: 'integer' } }] }),
          },
        }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.mapper).toEqual([
        { inputKey: 'x-id', type: 'header', key: 'x-id', required: false, serialization: undefined },
      ]);
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { 'x-id': { type: 'integer', 'x-parameter-location': 'header', 'x-mcp-header': 'x-id' } },
        additionalProperties: false,
      });
      expect(generator.getDiagnostics()).toEqual([]);
    });

    it('reports a header repeated in one list in another case, and keeps query and cookie names exact', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.1.0', {
          '/a': {
            get: op({
              operationId: 'a',
              parameters: [
                { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
                { name: 'x-trace', in: 'header', schema: { type: 'string' } },
                { name: 'id', in: 'query', schema: { type: 'string' } },
                { name: 'ID', in: 'query', schema: { type: 'string' } },
                { name: 'sid', in: 'cookie', schema: { type: 'string' } },
                { name: 'SID', in: 'cookie', schema: { type: 'string' } },
              ],
            }),
          },
        }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.mapper.map((m) => [m.key, m.type])).toEqual([
        ['x-trace', 'header'],
        ['id', 'query'],
        ['ID', 'query'],
        ['sid', 'cookie'],
        ['SID', 'cookie'],
      ]);
      expect(diagnostics(generator)).toEqual([['DUPLICATE_PARAMETER', '/paths/~1a/get/parameters/0']]);
    });
  });

  describe('content without a media schema', () => {
    it('keeps a string for a non-JSON media type, so the type signature stays string', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.0.3', {
          '/a': {
            get: op({
              operationId: 'getA',
              parameters: [
                { name: 'token', in: 'cookie', required: true, content: { 'text/plain': {} } },
                { name: 'filter', in: 'query', required: true, content: { 'application/json': {} } },
              ],
            }),
          },
        }),
      );
      const [tool] = await generator.generateTools({ emitTypeSignatures: true });
      expect((tool.inputSchema.properties as any).token).toEqual({
        type: 'string',
        'x-parameter-location': 'cookie',
        'x-parameter-content-type': 'text/plain',
      });
      expect((tool.inputSchema.properties as any).filter).toEqual({
        'x-parameter-location': 'query',
        'x-parameter-content-type': 'application/json',
      });
      expect(tool.metadata.typescript?.signature).toMatch(/token: string/);
    });
  });

  describe('schema and content together', () => {
    it('warns, reads schema, and records the finding once whether validating or not', async () => {
      const spec = clean('3.1.0', {
        '/a': {
          get: op({
            operationId: 'a',
            parameters: [{ name: 'f', in: 'query', schema: { type: 'string' }, content: json() }],
          }),
        },
      });
      for (const validate of [true, false]) {
        const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate });
        const [tool] = await generator.generateTools();
        expect((tool.inputSchema.properties as any).f.type).toBe('string');
        expect(generator.getDiagnostics()).toEqual([
          {
            severity: 'warning',
            code: 'INVALID_PARAMETER_CONTENT',
            message:
              'Parameter "f" (in: "query"): defines both schema and content, but must define only one; content is ' +
              'ignored and schema is used',
            path: '/paths/~1a/get/parameters/0',
          },
        ]);
      }
    });
  });

  describe('media types that give no schema', () => {
    it('reports a media type left as an unresolved reference (generation only)', async () => {
      const ref = { $ref: '#/components/mediaTypes/Filter' };
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/a': {
            get: op({
              operationId: 'a',
              parameters: [
                { name: 'j', in: 'query', content: { 'application/json': ref } },
                { name: 't', in: 'query', content: { 'text/plain': ref } },
                { name: 'c', in: 'cookie', content: { 'application/json': ref } },
                { $ref: '#/components/parameters/P' },
              ],
            }),
          },
        }),
        { validate: false, dereference: false },
      );
      const [tool] = await generator.generateTools();
      expect((tool.inputSchema.properties as any).t.type).toBe('string');
      expect(generator.getDiagnostics().map((d) => [d.path, d.message.slice(d.message.indexOf('): ') + 3)])).toEqual([
        [
          '/paths/~1a/get/parameters/0',
          'the media type "application/json" is a reference that is not resolved, so its schema is not read; the value is unconstrained',
        ],
        [
          '/paths/~1a/get/parameters/1',
          'the media type "text/plain" is a reference that is not resolved, so its schema is not read; the value is read as a string',
        ],
        [
          '/paths/~1a/get/parameters/2',
          'the media type "application/json" is a reference that is not resolved, so its schema is not read; the value is unconstrained',
        ],
      ]);
    });

    it('reports a null media type and an itemSchema in a parameter, with the validator, once', async () => {
      const spec = clean('3.2.0', {
        '/a': {
          get: op({
            operationId: 'a',
            parameters: [
              { name: 'n', in: 'query', content: { 'application/json': null } },
              { name: 'i', in: 'query', content: { 'application/jsonl': { itemSchema: { type: 'string' } } } },
            ],
          }),
        },
      });
      for (const validate of [true, false]) {
        const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate });
        await generator.generateTools();
        expect(diagnostics(generator)).toEqual([
          ['INVALID_PARAMETER_CONTENT', '/paths/~1a/get/parameters/0'],
          ['INVALID_PARAMETER_CONTENT', '/paths/~1a/get/parameters/1'],
        ]);
      }
    });
  });

  describe('streams next to an output schema', () => {
    it('gives the output schema from JSON and the stream from SSE in one response', async () => {
      const event = { type: 'object', properties: { data: { type: 'string' } } };
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.2.0', {
          '/chat': {
            post: op({
              operationId: 'chat',
              responses: {
                200: {
                  description: 'A reply, whole or streamed',
                  content: {
                    'application/json': { schema: { type: 'object', properties: { reply: { type: 'string' } } } },
                    'text/event-stream': { itemSchema: event },
                  },
                },
              },
            }),
          },
        }),
      );
      const [tool] = await generator.generateTools();
      expect(tool.outputSchema).toMatchObject({ 'x-content-type': 'application/json', 'x-status-code': 200 });
      expect(tool.metadata.responseStream).toEqual({ statusCode: 200, contentType: 'text/event-stream', itemSchema: event });
      expect(tool.metadata.responseHints).toEqual({ streaming: true });
    });
  });

  describe('JSON cookie values', () => {
    it('warns when the schema allows a value whose JSON text a cookie cannot carry, once per parameter', async () => {
      const cookie = (name: string, content: unknown, extra: Record<string, unknown> = {}) => ({
        name,
        in: 'cookie',
        content,
        ...extra,
      });
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean('3.0.3', {
          '/a': {
            parameters: [cookie('prefs', json({ type: 'object' }))],
            get: op({
              operationId: 'a',
              parameters: [
                cookie('count', json({ type: 'integer' })),
                cookie('ratio', json({ type: ['number', 'null'] })),
                cookie('flag', json({ type: 'boolean' })),
                cookie('any', json({})),
                cookie('none', json({ type: [] })),
                cookie('name', { 'application/vnd.x+json': { schema: { type: 'string' } } }),
                cookie('plain', { 'text/plain': { schema: { type: 'string' } } }),
                cookie('styled', undefined, { schema: { type: 'string' } }),
                { name: 'h', in: 'header', content: json({ type: 'object' }) },
              ],
            }),
            put: op({ operationId: 'b' }),
          },
        }),
      );
      const tools = await generator.generateTools();
      expect(tools).toHaveLength(2);
      expect(diagnostics(generator)).toEqual([
        ['COOKIE_CONTENT_NOT_SENDABLE', '/paths/~1a/parameters/0'],
        ['COOKIE_CONTENT_NOT_SENDABLE', '/paths/~1a/get/parameters/3'],
        ['COOKIE_CONTENT_NOT_SENDABLE', '/paths/~1a/get/parameters/4'],
        ['COOKIE_CONTENT_NOT_SENDABLE', '/paths/~1a/get/parameters/5'],
      ]);
      expect(generator.getDiagnostics()[0].message).toBe(
        'Parameter "prefs" (in: "cookie") is sent as "application/json", but its schema allows a string, an object ' +
          'or an array, whose JSON text holds characters a cookie value cannot carry (\'"\', \',\'); a call with such a ' +
          'value fails, only a number, boolean or null can be sent',
      );
    });
  });

  describe('a whole query string next to a query credential', () => {
    const schemes = {
      securitySchemes: {
        key: { type: 'apiKey', in: 'query', name: 'api_key' },
        other: { type: 'apiKey', in: 'query', name: 'token' },
        hdr: { type: 'apiKey', in: 'header', name: 'X-Key' },
      },
    };
    const search = (contentType: string, security?: unknown[]) =>
      op({
        operationId: `s${Math.abs(contentType.length)}`,
        parameters: [{ name: 'q', in: 'querystring', content: { [contentType]: { schema: { type: 'object' } } } }],
        ...(security && { security }),
      });

    it('warns once per scheme that can put a credential in the query, naming it', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean(
          '3.2.0',
          { '/s': { get: search('application/json', [{ key: [] }, { hdr: [] }, { key: [], other: [] }]) } },
          { components: schemes },
        ),
      );
      const [tool] = await generator.generateTools();
      expect(tool.mapper.map((m) => m.inputKey)).toEqual(['q', 'key', 'hdr', 'key', 'other']);
      expect(generator.getDiagnostics()).toEqual([
        {
          severity: 'warning',
          code: 'QUERYSTRING_WITH_QUERY_CREDENTIAL',
          message:
            'GET /s: parameter "q" holds the whole query string as "application/json", which has no name=value pairs, ' +
            'but security scheme "key" sends its API key in the query string; a call using that scheme cannot be ' +
            'built (send the key in a header or a cookie, or use application/x-www-form-urlencoded)',
          path: '/paths/~1s/get/parameters/0',
        },
        expect.objectContaining({ code: 'QUERYSTRING_WITH_QUERY_CREDENTIAL', message: expect.stringContaining('"other"') }),
      ]);
    });

    it('stays silent for a form-encoded query string, a header credential, or no security', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        clean(
          '3.2.0',
          {
            '/a': { get: search('application/x-www-form-urlencoded; charset=utf-8', [{ key: [] }]) },
            '/b': { get: search('application/json', [{ hdr: [] }]) },
            '/c': { get: search('text/plain') },
            '/d': { get: op({ operationId: 'd', security: [{ key: [] }] }) },
          },
          { components: schemes },
        ),
      );
      expect(await generator.generateTools()).toHaveLength(4);
      expect(generator.getDiagnostics()).toEqual([]);
    });
  });
});

describe('Base URI, $self and references to other documents', () => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const { pathToFileURL } = require('url') as typeof import('url');
  const refParser = () => require('@apidevtools/json-schema-ref-parser').default;

  const info = { title: 'Pets', version: '1' };
  const servers = [{ url: 'https://api.example.com' }];
  const pet = { type: 'object', properties: { name: { type: 'string', maxLength: 42 } } };
  const ok = { 200: { description: 'ok' } };
  /** A document whose one operation takes a body of schema `$ref: petRef`. */
  const entry = (petRef: string, extra: Record<string, unknown> = {}, openapi = '3.0.3') => ({
    openapi,
    info,
    servers,
    paths: {
      '/pets': {
        post: {
          operationId: 'createPet',
          requestBody: { content: { 'application/json': { schema: { $ref: petRef } } } },
          responses: ok,
        },
      },
    },
    components: { schemas: { Pet: pet } },
    ...extra,
  });
  /** Whether the tool's input carries the Pet schema (its `maxLength: 42`). */
  const hasPet = (tool: { inputSchema: unknown }) => JSON.stringify(tool.inputSchema).includes('"maxLength":42');
  const codes = (generator: OpenAPIToolGenerator) => generator.getDiagnostics().map((d) => d.code);
  const rejection = async (promise: Promise<unknown>): Promise<ParseError> => {
    try {
      await promise;
    } catch (error) {
      return error as ParseError;
    }
    throw new Error('expected a rejection');
  };

  /** Runs `run` with `files` written under a fresh temp directory, removed afterwards (that directory only). */
  const withFiles = async (files: Record<string, unknown>, run: (dir: string) => Promise<void>): Promise<void> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-from-openapi-base-uri-'));
    try {
      for (const [name, content] of Object.entries(files)) {
        const file = path.join(dir, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
      }
      await run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  /** A loopback server answering from a path → body (or status) table, recording every request. */
  const routes: Record<string, unknown> = {};
  const loopback = createLoopbackServer(() => (req, res) => {
    const route = routes[req.url ?? ''];
    if (route === undefined) {
      res.writeHead(404, 'Not Found');
      res.end();
    } else if (typeof route === 'function') {
      (route as LoopbackHandler)(req, res, Buffer.alloc(0));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(typeof route === 'string' ? route : JSON.stringify(route));
    }
  });
  let origin: string;
  const internal = { allowInternalIPs: true };
  const requested = () => loopback.requests.map((r) => r.url);

  beforeAll(async () => {
    origin = await loopback.listen();
  });

  afterAll(async () => {
    await loopback.close();
  });

  beforeEach(() => {
    for (const key of Object.keys(routes)) delete routes[key];
    loopback.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('files', () => {
    const files = {
      'api/openapi.yaml': {
        ...entry('schemas/pet.yaml'),
        paths: {
          ...entry('schemas/pet.yaml').paths,
          '/owners': { $ref: 'paths/owners.yaml' },
          // An operation kept in its own file, as some large APIs do
          '/pets/{id}': { get: { $ref: 'operations/get-pet.yaml' } },
        },
      },
      'api/operations/get-pet.yaml': {
        operationId: 'getPet',
        parameters: [{ $ref: '../parameters.yaml#/PetId' }],
        responses: { 200: { $ref: '../responses.yaml#/Pet' } },
      },
      'api/schemas/pet.yaml': pet,
      'api/paths/owners.yaml': { get: { operationId: 'listOwners', responses: ok } },
      'api/parameters.yaml': { PetId: { name: 'id', in: 'path', required: true, schema: { type: 'string' } } },
      'api/responses.yaml': {
        Pet: { description: 'ok', content: { 'application/json': { schema: { $ref: 'schemas/pet.yaml' } } } },
      },
    };
    const allowFile = { refResolution: { allowedProtocols: ['file'] } };

    it('resolves relative refs next to the file, whatever the working directory', async () => {
      await withFiles(files, async (dir) => {
        expect(process.cwd()).not.toBe(path.join(dir, 'api'));
        const generator = await OpenAPIToolGenerator.fromFile(path.join(dir, 'api/openapi.yaml'), allowFile);
        const tools = await generator.generateTools();
        expect(tools.map((t) => t.name)).toEqual(['listOwners', 'createPet', 'getPet']);
        expect(hasPet(tools[1])).toBe(true);
        expect(JSON.stringify(tools[2].outputSchema)).toContain('"maxLength":42');
        expect(tools[2].mapper.map((m) => `${m.type}:${m.key}`)).toEqual(['path:id']);
        expect(generator.getDiagnostics()).toEqual([]);
      });
    });

    it('refuses them when file is not allowed, naming the reference, the base, the rule and the option', async () => {
      await withFiles(files, async (dir) => {
        const entryPath = path.join(dir, 'api/openapi.yaml');
        const generator = await OpenAPIToolGenerator.fromFile(entryPath);
        const error = await rejection(generator.generateTools());
        expect(error).toBeInstanceOf(ParseError);
        expect(error.message).toBe(
          `Failed to dereference OpenAPI document: Cannot read $ref "schemas/pet.yaml" at ` +
            `"#/paths/~1pets/post/requestBody/content/application~1json/schema" resolved against ${JSON.stringify(entryPath)} ` +
            `to ${JSON.stringify(path.join(dir, 'api/schemas/pet.yaml'))}: it is read as a local file, and ` +
            `refResolution.allowedProtocols ("http", "https") does not include "file"; add "file" to ` +
            `refResolution.allowedProtocols to read it`,
        );
        expect(error.context).toMatchObject({
          reference: 'schemas/pet.yaml',
          base: entryPath,
          resolved: path.join(dir, 'api/schemas/pet.yaml'),
          rule: 'protocol',
        });
        expect(error.context).toEqual({
          rule: 'protocol',
          reference: 'schemas/pet.yaml',
          base: entryPath,
          resolved: path.join(dir, 'api/schemas/pet.yaml'),
          path: '/paths/~1pets/post/requestBody/content/application~1json/schema',
        });
        // validate() reads what generation reads; an unreadable reference is a result, not a throw
        expect(await generator.validate()).toEqual({
          valid: false,
          errors: [
            {
              code: 'UNREADABLE_REFERENCE',
              message: error.message.slice('Failed to dereference OpenAPI document: '.length),
              path: '/paths/~1pets/post/requestBody/content/application~1json/schema',
            },
          ],
        });
      });
    });

    it('resolves a $ref cycle across two files', async () => {
      const cyclic = {
        'openapi.json': {
          ...entry('nodes.json#/Node'),
          components: { schemas: { Root: { type: 'object', properties: { child: { $ref: 'nodes.json#/Node' } } } } },
        },
        'nodes.json': {
          Node: {
            type: 'object',
            properties: {
              parent: { $ref: 'openapi.json#/components/schemas/Root' },
              next: { $ref: '#/Node' },
              label: { type: 'string', maxLength: 42 },
            },
          },
        },
      };
      await withFiles(cyclic, async (dir) => {
        const generator = await OpenAPIToolGenerator.fromFile(path.join(dir, 'openapi.json'), allowFile);
        const tools = await generator.generateTools();
        expect(tools.map((t) => t.name)).toEqual(['createPet']);
        expect(hasPet(tools[0])).toBe(true);
        expect(JSON.stringify(tools[0].inputSchema)).toContain('"parent"');
      });
    });

    it('keeps resolving against the working directory without a base URI, and says so', async () => {
      await withFiles(files, async (dir) => {
        const document = JSON.parse(fs.readFileSync(path.join(dir, 'api/openapi.yaml'), 'utf8'));
        const cwdBase = `${process.cwd()}${path.sep}`;
        // Refused: the message says why relative references land in the working directory
        const refused = await rejection((await OpenAPIToolGenerator.fromJSON(document)).generateTools());
        expect(refused.message).toContain(`resolved against ${JSON.stringify(cwdBase)}`);
        expect(refused.message).toContain(
          '(the document has no base URI, so its relative references resolve against the working directory: ' +
            'load it with fromFile or fromURL, or pass LoadOptions.documentUri)',
        );
        expect(refused.context).toMatchObject({ reference: 'schemas/pet.yaml', base: cwdBase, rule: 'protocol' });
        // Allowed: read from the working directory, as in earlier releases
        const missing = await rejection((await OpenAPIToolGenerator.fromJSON(document, allowFile)).generateTools());
        expect(missing.message).toContain(
          `resolved against ${JSON.stringify(cwdBase)} to ${JSON.stringify(path.join(process.cwd(), 'schemas/pet.yaml'))}: ` +
            'the file cannot be read (ENOENT)',
        );
        expect(missing.context).toMatchObject({ rule: 'file-error' });
      });
    });

    it('resolves them against LoadOptions.documentUri in fromJSON and fromYAML', async () => {
      await withFiles(files, async (dir) => {
        const documentUri = pathToFileURL(path.join(dir, 'api/openapi.yaml')).href;
        const text = fs.readFileSync(path.join(dir, 'api/openapi.yaml'), 'utf8');
        for (const generator of [
          await OpenAPIToolGenerator.fromJSON(JSON.parse(text), { ...allowFile, documentUri }),
          await OpenAPIToolGenerator.fromYAML(text, { ...allowFile, documentUri }),
        ]) {
          expect((await generator.generateTools()).map((t) => t.name)).toEqual(['listOwners', 'createPet', 'getPet']);
        }
      });
    });

    it('lets LoadOptions.documentUri replace the file a document was read from', async () => {
      await withFiles({ ...files, 'copy/openapi.yaml': files['api/openapi.yaml'] }, async (dir) => {
        const copy = path.join(dir, 'copy/openapi.yaml');
        await expect((await OpenAPIToolGenerator.fromFile(copy, allowFile)).generateTools()).rejects.toThrow(
          'the file cannot be read (ENOENT)',
        );
        const documentUri = pathToFileURL(path.join(dir, 'api/openapi.yaml')).href;
        const generator = await OpenAPIToolGenerator.fromFile(copy, { ...allowFile, documentUri });
        expect(await generator.generateTools()).toHaveLength(3);
      });
    });

    it('refuses a file documentUri that names a host (a network share)', async () => {
      await expect(
        OpenAPIToolGenerator.fromJSON(entry('schemas/pet.yaml'), {
          ...allowFile,
          documentUri: 'file://fileserver/share/openapi.yaml',
        }),
      ).rejects.toThrow('LoadOptions.documentUri must not name a host in a file URI');
    });

    it('validates a multi-file document as generation reads it', async () => {
      await withFiles(files, async (dir) => {
        const generator = await OpenAPIToolGenerator.fromFile(path.join(dir, 'api/openapi.yaml'), allowFile);
        // As written, the operation is in another file: the raw document has an operation without
        // responses, and a path template without its parameter
        const raw = await new Validator().validate(generator.getDocument());
        expect(raw.valid).toBe(false);
        expect(raw.errors?.map((e) => e.code)).toEqual(['NO_RESPONSES', 'MISSING_PATH_PARAMETER']);

        const spy = jest.spyOn(refParser(), 'dereference');
        expect(await generator.validate()).toEqual({ valid: true });
        // Generation reuses the dereferenced document: one dereference in all
        expect(await generator.generateTools()).toHaveLength(3);
        expect(await generator.validate()).toEqual({ valid: true });
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });

    it('shares one dereference between concurrent callers, and retries one that failed', async () => {
      await withFiles(files, async (dir) => {
        const missing = path.join(dir, 'api/schemas/pet.yaml');
        fs.renameSync(missing, `${missing}.bak`);
        const generator = await OpenAPIToolGenerator.fromFile(path.join(dir, 'api/openapi.yaml'), allowFile);
        const failed = await generator.validate();
        expect(failed.errors?.map((e) => [e.code, e.path])).toEqual([
          ['UNREADABLE_REFERENCE', '/paths/~1pets/post/requestBody/content/application~1json/schema'],
        ]);
        expect(failed.errors?.[0].message).toContain('the file cannot be read (ENOENT)');
        await expect(generator.generateTools()).rejects.toThrow('the file cannot be read (ENOENT)');
        fs.renameSync(`${missing}.bak`, missing);

        const spy = jest.spyOn(refParser(), 'dereference');
        const [validation, tools, lint] = await Promise.all([
          generator.validate(),
          generator.generateTools(),
          generator.lint(),
        ]);
        expect(validation.valid).toBe(true);
        expect(tools).toHaveLength(3);
        expect(lint).toBeDefined();
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });

    it('validates a document without references to other documents as loaded, reading nothing', async () => {
      const spy = jest.spyOn(refParser(), 'dereference');
      // Internal references only, a self-reference by URI, and dereferencing turned off
      const internalOnly = entry('#/components/schemas/Pet');
      const selfOnly = entry('https://example.com/api/openapi.json#/components/schemas/Pet');
      const cases: Array<[object, LoadOptions]> = [
        [internalOnly, {}],
        [selfOnly, { documentUri: 'https://example.com/api/openapi.json' }],
        [{ ...entry('other.json#/Pet'), paths: { '/x/{id}': { get: { responses: ok } } } }, { dereference: false }],
      ];
      for (const [document, options] of cases) {
        const generator = await OpenAPIToolGenerator.fromJSON(document, options);
        expect(await generator.validate()).toEqual(await new Validator().validate(document));
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it('throws a ParseError, not a TypeError, for a document JSON cannot copy', async () => {
      const yamlText =
        'openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths: {/a: {get: {responses: {"200": {description: ok}}}}}\n' +
        'components:\n  schemas:\n    A: &a\n      properties:\n        self: *a\n';
      const generator = await OpenAPIToolGenerator.fromYAML(yamlText);
      await expect(generator.generateTools()).rejects.toThrow(ParseError);
      // validate() reads nothing for it, as before
      expect((await generator.validate()).valid).toBe(true);
    });
  });

  describe('URLs', () => {
    it('resolves relative refs against the spec URL (Appendix F: base URI from the retrieval URI)', async () => {
      routes['/api/openapis.yaml'] = entry('schemas/foo');
      routes['/api/schemas/foo'] = pet;
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/api/openapis.yaml`, { refResolution: internal });
      const [tool] = await generator.generateTools();
      expect(hasPet(tool)).toBe(true);
      expect(requested()).toEqual(['/api/openapis.yaml', '/api/schemas/foo']);
    });

    it('uses the final URL after redirects as the base, and never sends spec credentials with a $ref', async () => {
      routes['/start'] = (_req: unknown, res: import('http').ServerResponse) => {
        res.writeHead(302, { location: '/v2/openapi.json' });
        res.end();
      };
      routes['/v2/openapi.json'] = entry('schemas/pet.json');
      routes['/v2/schemas/pet.json'] = pet;
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/start`, {
        headers: { Authorization: 'Bearer SPEC-SECRET' },
        refResolution: internal,
      });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);
      expect(requested()).toEqual(['/start', '/v2/openapi.json', '/v2/schemas/pet.json']);
      const auth = loopback.requests.map((r) => r.headers.authorization);
      expect(auth).toEqual(['Bearer SPEC-SECRET', 'Bearer SPEC-SECRET', undefined]);
    });

    it('resolves against another origin a redirect lands on, without credentials there', async () => {
      const cdnRoutes: Record<string, unknown> = { '/v2/openapi.json': entry('schemas/pet.json'), '/v2/schemas/pet.json': pet };
      const cdn = createLoopbackServer(() => (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(cdnRoutes[req.url ?? '']));
      });
      const cdnOrigin = await cdn.listen();
      routes['/start'] = (_req: unknown, res: import('http').ServerResponse) => {
        res.writeHead(302, { location: `${cdnOrigin}/v2/openapi.json` });
        res.end();
      };
      try {
        const generator = await OpenAPIToolGenerator.fromURL(`${origin}/start`, {
          headers: { Authorization: 'Bearer SPEC-SECRET' },
          refResolution: internal,
        });
        expect(hasPet((await generator.generateTools())[0])).toBe(true);
        expect(requested()).toEqual(['/start']);
        expect(cdn.requests.map((r) => [r.url, r.headers.authorization])).toEqual([
          ['/v2/openapi.json', undefined],
          ['/v2/schemas/pet.json', undefined],
        ]);
      } finally {
        await cdn.close();
      }
    });

    it('drops user information of the spec URL from the base: it authenticates the spec only', async () => {
      routes['/api/openapi.json'] = entry('schemas/pet.json');
      routes['/api/schemas/pet.json'] = pet;
      const withUser = origin.replace('http://', 'http://user:secret@');
      const generator = await OpenAPIToolGenerator.fromURL(`${withUser}/api/openapi.json#ignored`, {
        refResolution: internal,
      });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);
      expect(loopback.requests.map((r) => [r.url, r.headers.authorization])).toEqual([
        ['/api/openapi.json', `Basic ${Buffer.from('user:secret').toString('base64')}`],
        ['/api/schemas/pet.json', undefined],
      ]);
    });

    it('does not show the query of the spec URL in a refusal: it can hold a token', async () => {
      routes['/api/openapi.json?token=SPEC-SECRET'] = entry('schemas/pet.json');
      // `allowedProtocols` gates references only: the spec itself is read over http
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/api/openapi.json?token=SPEC-SECRET`, {
        refResolution: { ...internal, allowedProtocols: ['https'] },
      });
      const error = await rejection(generator.generateTools());
      expect(error.message).toContain(`resolved against "${origin}/api/openapi.json?..." to "${origin}/api/schemas/pet.json"`);
      expect(JSON.stringify({ message: error.message, ...error.context, originalError: undefined })).not.toContain(
        'SPEC-SECRET',
      );
      expect(error.context).toMatchObject({ base: `${origin}/api/openapi.json?...`, rule: 'protocol' });
    });

    it('keeps the redirect limit', async () => {
      for (let hop = 0; hop < 7; hop++) {
        routes[`/r${hop}`] = (_req: unknown, res: import('http').ServerResponse) => {
          res.writeHead(302, { location: `/r${hop + 1}` });
          res.end();
        };
      }
      await expect(OpenAPIToolGenerator.fromURL(`${origin}/r0`, { refResolution: internal })).rejects.toThrow(
        /Too many redirects/,
      );
      expect(requested()).toEqual(['/r0', '/r1', '/r2', '/r3', '/r4', '/r5']);
    });

    it('keeps a reference to the document itself local, also under secureDefaults', async () => {
      const spy = jest.spyOn(refParser(), 'dereference');
      routes['/api/openapi.json'] = {
        ...entry(`${origin}/api/openapi.json#/components/schemas/Pet`),
        paths: {
          ...entry('').paths,
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: {
                content: { 'application/json': { schema: { $ref: `${origin}/api/openapi.json#/components/schemas/Pet` } } },
              },
              responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: './openapi.json#/components/schemas/Pet' } } } } },
            },
          },
        },
      };
      for (const options of [{ refResolution: internal }, { secureDefaults: true, refResolution: internal }]) {
        loopback.reset();
        const generator = await OpenAPIToolGenerator.fromURL(`${origin}/api/openapi.json`, options);
        const [tool] = await generator.generateTools();
        expect(hasPet(tool)).toBe(true);
        expect(JSON.stringify(tool.outputSchema)).toContain('"maxLength":42');
        expect(requested()).toEqual(['/api/openapi.json']);
      }
      expect(spy).not.toHaveBeenCalled();
    });

    // Appendix F, "Resolving Relative $self and $id"
    it('resolves references against a relative $self resolved against the retrieval URI', async () => {
      routes['/api/openapi'] = {
        openapi: '3.2.0',
        $self: '/api/openapi',
        info,
        servers,
        paths: {
          '/foo': {
            post: { operationId: 'postFoo', requestBody: { $ref: 'shared/foo#/components/requestBodies/Foo' }, responses: ok },
          },
        },
      };
      routes['/api/shared/foo'] = {
        openapi: '3.2.0',
        $self: '/api/shared/foo',
        info,
        components: {
          requestBodies: { Foo: { content: { 'application/json': { schema: { $ref: '../schemas/foo' } } } } },
        },
      };
      routes['/api/schemas/foo'] = pet;
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/api/openapi`, { refResolution: internal });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);
      expect(requested()).toEqual(['/api/openapi', '/api/shared/foo', '/api/schemas/foo']);
      expect(generator.getDiagnostics()).toEqual([]);
    });

    it('resolves a reference cycle back to the entry document without fetching it again', async () => {
      routes['/api/openapi.json'] = {
        ...entry('nodes.json#/Node'),
        components: { schemas: { Root: { type: 'object', properties: { child: { $ref: 'nodes.json#/Node' } } } } },
      };
      routes['/api/nodes.json'] = {
        Node: {
          type: 'object',
          properties: { parent: { $ref: 'openapi.json#/components/schemas/Root' }, label: pet.properties.name },
        },
      };
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/api/openapi.json`, { refResolution: internal });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);
      expect(requested()).toEqual(['/api/openapi.json', '/api/nodes.json']);
    });

    it('leaves references under a schema with its own $id to that $id (OpenAPI 3.1)', async () => {
      routes['/api/openapi.json'] = entry('#/components/schemas/Foo', {
        components: {
          schemas: { Foo: { $id: `${origin}/schemas/foo`, type: 'object', properties: { bar: { $ref: 'bar' } } } },
        },
      }, '3.1.0');
      routes['/schemas/bar'] = pet;
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/api/openapi.json`, { refResolution: internal });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);
      expect(requested()).toEqual(['/api/openapi.json', '/schemas/bar']);
    });
  });

  describe('$self', () => {
    // Appendix F, "Base URI Within Content": a file document whose $self names a network location.
    // Identity follows the specification: a reference to the $self URI is this document. Where a
    // relative reference is read from is an implementation choice the specification leaves open:
    // the specification resolves it against $self (the network), this library against the file it
    // was read from, so a local copy reads the files next to it and never reaches the network
    it('reads the relative references of a file document next to the file, whatever its $self says', async () => {
      routes['/api/shared/foo'] = { never: 'fetched' };
      const document = {
        openapi: '3.2.0',
        $self: `${origin}/api/openapi`,
        info,
        servers,
        paths: {
          '/foo': {
            post: {
              operationId: 'postFoo',
              requestBody: { $ref: 'shared/foo#/components/requestBodies/Foo' },
              responses: {
                200: { description: 'ok', content: { 'application/json': { schema: { $ref: `${origin}/api/openapi#/components/schemas/Pet` } } } },
              },
            },
          },
        },
        components: { schemas: { Pet: pet } },
      };
      const shared = {
        openapi: '3.2.0',
        info,
        components: {
          requestBodies: { Foo: { content: { 'application/json': { schema: { $ref: '../schemas/foo' } } } } },
        },
      };
      await withFiles(
        { 'src/api/openapi.yaml': document, 'src/api/shared/foo': shared, 'src/api/schemas/foo': pet },
        async (dir) => {
          const generator = await OpenAPIToolGenerator.fromFile(path.join(dir, 'src/api/openapi.yaml'), {
            refResolution: { ...internal, allowedProtocols: ['file', 'http', 'https'] },
          });
          const [tool] = await generator.generateTools();
          expect(hasPet(tool)).toBe(true);
          // The reference by $self stayed local
          expect(JSON.stringify(tool.outputSchema)).toContain('"maxLength":42');
          expect(requested()).toEqual([]);
        },
      );
    });

    it('lets a mirror serve its own copies: a URL document reads next to where it was read from', async () => {
      routes['/mirror/openapi.json'] = entry('schemas/pet.json', { $self: 'https://specs.example.com/api/openapi' }, '3.2.0');
      routes['/mirror/schemas/pet.json'] = pet;
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/mirror/openapi.json`, { refResolution: internal });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);
      expect(requested()).toEqual(['/mirror/openapi.json', '/mirror/schemas/pet.json']);
    });

    it('keeps a reference by $self local under secureDefaults: nothing is fetched', async () => {
      const spy = jest.spyOn(refParser(), 'dereference');
      const document = entry(`${origin}/api/openapi#/components/schemas/Pet`, { $self: `${origin}/api/openapi` }, '3.2.0');
      (document.paths['/pets'].post as Record<string, unknown>)['responses'] = {
        200: { description: 'ok', content: { 'application/json': { schema: { $ref: 'openapi#/components/schemas/Pet' } } } },
      };
      for (const options of [{ secureDefaults: true }, {}]) {
        const generator = await OpenAPIToolGenerator.fromJSON(document, { ...options, refResolution: internal });
        const [tool] = await generator.generateTools();
        expect(hasPet(tool)).toBe(true);
        expect(JSON.stringify(tool.outputSchema)).toContain('"maxLength":42');
        expect(generator.getDiagnostics()).toEqual([]);
      }
      expect(loopback.requests).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it.each<[string, unknown, string]>([
      ['user information', `http://user:pw@127.0.0.1:1/x/openapi`, 'REFUSED_SELF'],
      ['a fragment', '/x/openapi#/info', 'INVALID_SELF'],
      ['a file URI', 'file:///etc/', 'REFUSED_SELF'],
      ['a javascript: URI', 'javascript:alert(1)', 'REFUSED_SELF'],
      ['CR/LF', '/x/openapi\r\nX-Injected: 1', 'INVALID_SELF'],
      ['a very long value', `/x/${'a'.repeat(9000)}`, 'REFUSED_SELF'],
      ['a non-string', { href: '/x/openapi' }, 'INVALID_SELF'],
    ])('ignores a $self with %s, keeping the retrieval URI as the base', async (_what, self, code) => {
      routes['/api/openapi.json'] = entry('schemas/pet.json', { $self: self }, '3.2.0');
      routes['/api/schemas/pet.json'] = pet;
      // `file` is allowed: a file $self, if honoured, would read local files
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/api/openapi.json`, {
        validate: false,
        refResolution: { ...internal, allowedProtocols: ['http', 'file'] },
      });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);
      expect(requested()).toEqual(['/api/openapi.json', '/api/schemas/pet.json']);
      expect(codes(generator)).toEqual([code]);
      const message = generator.getDiagnostics()[0].message;
      expect(message.length).toBeLessThan(600);
      expect(message).not.toMatch(/[\r\n]/);
      expect(message).not.toContain('user:pw');
    });

    it('rejects an invalid $self when validating', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        entry('#/components/schemas/Pet', { $self: 'https://example.com/api#/info' }, '3.2.0'),
      );
      await expect(generator.generateTools()).rejects.toThrow(
        'Invalid OpenAPI document: `$self` must not contain a fragment, found "https://example.com/api#/info"',
      );
      expect((await generator.validate()).errors).toEqual([
        {
          message: '`$self` must not contain a fragment, found "https://example.com/api#/info"',
          path: '/$self',
          code: 'INVALID_SELF',
        },
      ]);
    });

    it('refuses references resolved against a $self naming an internal address, fetching nothing', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        entry('schemas/pet.json', { $self: 'http://10.0.0.1/api/openapi' }, '3.2.0'),
      );
      const error = await rejection(generator.generateTools());
      expect(error.message).toBe(
        'Failed to dereference OpenAPI document: Cannot read $ref "schemas/pet.json" at ' +
          '"#/paths/~1pets/post/requestBody/content/application~1json/schema" resolved against ' +
          '"http://10.0.0.1/api/openapi" to "http://10.0.0.1/api/schemas/pet.json": its host "10.0.0.1" is an internal ' +
          'address (loopback, private, link-local or cloud metadata); refResolution.allowInternalIPs would allow it ' +
          '(unsafe for documents you do not trust)',
      );
      expect(error.context).toMatchObject({ rule: 'internal-address', base: 'http://10.0.0.1/api/openapi' });
    });

    it('refuses references resolved against a $self outside allowedHosts, when $self is the only base', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        entry('schemas/pet.json', { $self: 'http://schemas.example.org/api/openapi' }, '3.2.0'),
        { refResolution: { allowedHosts: ['example.com'] } },
      );
      const error = await rejection(generator.generateTools());
      expect(error.message).toContain(
        'to "http://schemas.example.org/api/schemas/pet.json": its host "schemas.example.org" is not in ' +
          'refResolution.allowedHosts; add the host to refResolution.allowedHosts to read it',
      );
      expect(error.context).toMatchObject({ rule: 'host-not-allowed', base: 'http://schemas.example.org/api/openapi' });
    });

    it('never turns a file document network-bound: with only file allowed, its siblings are read', async () => {
      await withFiles(
        {
          'openapi.json': entry('schemas/pet.json', { $self: 'https://example.com/api/openapi' }, '3.2.0'),
          'schemas/pet.json': pet,
        },
        async (dir) => {
          const generator = await OpenAPIToolGenerator.fromFile(path.join(dir, 'openapi.json'), {
            refResolution: { allowedProtocols: ['file'] },
          });
          expect(hasPet((await generator.generateTools())[0])).toBe(true);
          expect(await generator.validate()).toEqual({ valid: true });
        },
      );
    });

    it('ignores $self in a document declaring 3.1', async () => {
      routes['/api/openapi'] = entry('#/components/schemas/Pet');
      const document = entry(`${origin}/api/openapi#/components/schemas/Pet`, { $self: `${origin}/api/openapi` }, '3.1.0');
      const generator = await OpenAPIToolGenerator.fromJSON(document, { refResolution: internal });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);
      // Not a self-reference in 3.1: the URL is fetched like any other document
      expect(requested()).toEqual(['/api/openapi']);
      expect(codes(generator)).toEqual(['FEATURE_NEWER_THAN_DECLARED_VERSION']);
    });
  });

  describe('security schemes named by URI (OpenAPI 3.2)', () => {
    const schemes = {
      bearer: { type: 'http', scheme: 'bearer' },
      foo: { type: 'apiKey', name: 'X-Foo', in: 'header' },
      oauth: {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: 'https://example.com/token', scopes: { a: 'a', b: 'b' } } },
      },
      '#/components/securitySchemes/bearer-alias': { type: 'apiKey', name: 'X-Alias', in: 'query' },
    };
    const secured = (security: unknown, extra: Record<string, unknown> = {}, openapi = '3.2.0') =>
      entry('#/components/schemas/Pet', { components: { schemas: { Pet: pet }, securitySchemes: schemes }, security, ...extra }, openapi);
    const schemesOf = (tool: McpOpenAPITool) => tool.metadata.security?.map((s) => s.scheme);

    it.each<[string, LoadOptions, Record<string, unknown>]>([
      ['#/components/securitySchemes/bearer', {}, {}],
      ['openapi.yaml#/components/securitySchemes/bearer', { documentUri: 'https://example.com/api/openapi.yaml' }, {}],
      ['./openapi.yaml#/components/securitySchemes/bearer', { documentUri: 'https://example.com/api/openapi.yaml' }, {}],
      [
        'https://EXAMPLE.com:443/api/./openapi.yaml#/components/securitySchemes/bearer',
        { documentUri: 'https://example.com/api/openapi.yaml' },
        {},
      ],
      ['https://example.com/api/openapi#/components/securitySchemes/bearer', {}, { $self: 'https://example.com/api/openapi' }],
    ])('resolves %s to the component it names', async (key, options, extra) => {
      const generator = await OpenAPIToolGenerator.fromJSON(secured([{ [key]: [] }], extra), options);
      const [tool] = await generator.generateTools();
      expect(schemesOf(tool)).toEqual(['bearer']);
      expect(tool.mapper.filter((m) => m.security).map((m) => [m.inputKey, m.key])).toEqual([['bearer', 'Authorization']]);
      expect(generator.getDiagnostics()).toEqual([]);
    });

    it('reads ./foo as another document, and foo as the component', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(secured([{ './foo': [] }, { foo: [] }]), {
        documentUri: 'https://example.com/api/openapi.yaml',
      });
      const [tool] = await generator.generateTools();
      expect(schemesOf(tool)).toEqual(['foo']);
      expect(generator.getDiagnostics()).toEqual([
        {
          severity: 'warning',
          code: 'UNRESOLVED_SECURITY_SCHEME',
          message:
            'Security Requirement names scheme "./foo", which components.securitySchemes does not define, and read as ' +
            'a URI it names a scheme in another document, which is not read; the requirement cannot be satisfied ' +
            'and is dropped with every scheme it combines',
          path: '/security/0/.~1foo',
        },
      ]);
    });

    it('gives a component name precedence over the URI it looks like', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(secured([{ '#/components/securitySchemes/bearer-alias': [] }]));
      const [tool] = await generator.generateTools();
      expect(schemesOf(tool)).toEqual(['#/components/securitySchemes/bearer-alias']);
      expect(tool.metadata.security?.[0]).toMatchObject({ type: 'apiKey', name: 'X-Alias', in: 'query' });
    });

    it('counts a scheme named twice in one requirement once, with the scopes of both', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        secured([{ oauth: ['a'], '#/components/securitySchemes/oauth': ['b', 'a'], bearer: [] }]),
      );
      const [tool] = await generator.generateTools();
      expect(tool.metadata.security?.map((s) => [s.scheme, s.scopes])).toEqual([
        ['oauth', ['a', 'b']],
        ['bearer', []],
      ]);
      expect(tool.mapper.filter((m) => m.security).map((m) => m.inputKey)).toEqual(['oauth', 'bearer']);
    });

    it('keeps the first scopes when a repeated scheme lists none, or the first are not a list', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        secured([{ oauth: 'x', '#/components/securitySchemes/oauth': ['b'], bearer: ['r'], '#/components/securitySchemes/bearer': 'y' }]),
        { validate: false },
      );
      const [tool] = await generator.generateTools();
      expect(tool.metadata.security?.map((s) => [s.scheme, s.scopes])).toEqual([
        ['oauth', ['b']],
        ['bearer', ['r']],
      ]);
    });

    it.each<[string, string, string, Record<string, unknown>?]>([
      [
        '3.1.0',
        '#/components/securitySchemes/bearer',
        'components.securitySchemes does not define (a scheme named by URI needs OpenAPI 3.2 or later)',
      ],
      [
        '3.2.0',
        '#/components/securitySchemes/missing',
        'names the scheme "missing" of this document by URI, but components.securitySchemes does not define it',
      ],
      [
        '3.2.0',
        '#/components/schemas/Pet',
        'components.securitySchemes does not define, and read as a URI it points to "#/components/schemas/Pet" in ' +
          'this document, which is not under /components/securitySchemes',
      ],
      [
        '3.2.0',
        'https://example.com/api/openapi.yaml#/components/securitySchemes/bearer',
        'components.securitySchemes does not define, and read as a URI it cannot be resolved: the document has no ' +
          'base URI (load it with fromURL or fromFile, or pass LoadOptions.documentUri)',
      ],
    ])('leaves an unresolvable key unresolved (%s, %s)', async (openapi, key, problem) => {
      const generator = await OpenAPIToolGenerator.fromJSON(secured([{ [key]: [] }], {}, openapi));
      await expect(generator.generateTools()).resolves.toEqual([]);
      const diagnostics = generator.getDiagnostics().filter((d) => d.code === 'UNRESOLVED_SECURITY_SCHEME');
      expect(diagnostics.map((d) => d.message)).toEqual([
        `Security Requirement names scheme ${describeValue(key)}, which ${problem}; the requirement cannot be ` +
          'satisfied and is dropped with every scheme it combines',
      ]);
      expect(codes(generator)).toContain('UNSATISFIABLE_SECURITY');
    });
  });

  describe('references that cannot be read', () => {
    const refusedFor = async (ref: string, options: LoadOptions = {}): Promise<ParseError> =>
      rejection((await OpenAPIToolGenerator.fromJSON(entry(ref), options)).generateTools());

    it.each<[string, LoadOptions, string, string]>([
      [
        'https://example.com/pet.json',
        { refResolution: { allowedProtocols: ['http'] } },
        'protocol',
        'its protocol "https" is not in refResolution.allowedProtocols ("http"); add "https" to refResolution.allowedProtocols to read it',
      ],
      [
        'file:///etc/passwd',
        {},
        'protocol',
        'it is read as a local file, and refResolution.allowedProtocols ("http", "https") does not include "file"; add "file" to refResolution.allowedProtocols to read it',
      ],
      [
        'https://evil.example/pet.json',
        { refResolution: { allowedHosts: ['schemas.example.com'] } },
        'host-not-allowed',
        'its host "evil.example" is not in refResolution.allowedHosts; add the host to refResolution.allowedHosts to read it',
      ],
      [
        'https://evil.example/pet.json',
        { refResolution: { blockedHosts: ['EVIL.example.'] } },
        'host-blocked',
        'its host "evil.example" is in refResolution.blockedHosts',
      ],
      [
        'http://169.254.169.254/latest/meta-data/',
        {},
        'internal-address',
        'its host "169.254.169.254" is an internal address (loopback, private, link-local or cloud metadata); refResolution.allowInternalIPs would allow it (unsafe for documents you do not trust)',
      ],
    ])('says why %s is refused', async (ref, options, rule, reason) => {
      const error = await refusedFor(ref, options);
      expect(error).toBeInstanceOf(ParseError);
      expect(error.message).toMatch(/^Failed to dereference OpenAPI document: Cannot read \$ref /);
      expect(error.message.endsWith(`: ${reason}`)).toBe(true);
      expect(error.context).toMatchObject({ reference: ref.replace(/#.*/, ''), rule });
    });

    it('says when an address the host resolves to is refused', async () => {
      jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
      const error = await refusedFor('http://schemas.internal.example/pet.json');
      expect(error.message).toContain(
        'to "http://schemas.internal.example/pet.json": Host "schemas.internal.example" resolves to blocked address 10.0.0.5',
      );
      expect(error.context).toMatchObject({ rule: 'resolved-address' });
    });

    it('says when the server refuses the document', async () => {
      const error = await refusedFor(`${origin}/missing.json`, { refResolution: internal });
      expect(error.message.endsWith(': the server answered 404 "Not Found"')).toBe(true);
      expect(error.context).toMatchObject({ rule: 'response', resolved: `${origin}/missing.json` });
    });

    it('says when the fetch fails', async () => {
      const error = await refusedFor('http://127.0.0.1:1/pet.json', { refResolution: internal });
      expect(error.message).toMatch(/^Failed to dereference OpenAPI document: Cannot read \$ref .*: .*ECONNREFUSED/);
      expect(error.context).toMatchObject({ rule: 'fetch-failed', resolved: 'http://127.0.0.1:1/pet.json' });
    });

    it('quotes the document bounded and escaped', async () => {
      const ref = `https://evil.example/${'x'.repeat(3000)}\u001b[31m\n.json`;
      const error = await refusedFor(ref, { refResolution: { allowedHosts: ['good.example'] } });
      expect(error.message.length).toBeLessThan(1200);
      expect(error.message).not.toMatch(/[\u0000-\u001f]/);
    });

    it('names the reference alone when the resolver is not told where it came from', async () => {
      const spy = jest.spyOn(refParser(), 'dereference').mockImplementation(async (doc: unknown) => doc);
      // A fresh set of resolvers (and read queue) for each call
      const refusedOf = async (options: LoadOptions = {}) => {
        spy.mockClear();
        await (await OpenAPIToolGenerator.fromJSON(entry('https://example.com/pet.json'), options)).generateTools();
        return (spy.mock.calls[0][1] as any).resolve.refused;
      };
      const refused = await refusedOf();
      expect(refused.canRead({ url: 'http://10.0.0.1/a.json' })).toBe(true);
      expect(refused.canRead({ url: 'https://example.com/a.json' })).toBe(false);
      expect(refused.canRead({ url: '/srv/a.json' })).toBe(true);
      await expect(refused.read({ url: 'http://[zz]/a.json' })).rejects.toThrow(
        'Cannot read external $ref "http://[zz]/a.json": it is not a valid URL',
      );
      // Once a read failed, the reads asked for after it are not started
      await expect(refused.read({ url: '/srv/a.json' })).rejects.toThrow(
        'Not read: an earlier reference could not be read',
      );
      await expect(
        (await refusedOf()).read({ url: 'file:///a.json', reference: '/a.json', baseUrl: 'https://example.com/x' }),
      ).rejects.toThrow(
        'Cannot read $ref "/a.json" resolved against "https://example.com/x" to "file:///a.json": it is read as a local file',
      );
      await expect((await refusedOf()).read({ url: '/srv/a.json', reference: 'a.json' })).rejects.toThrow(
        /^Cannot read \$ref "a.json" to "\/srv\/a.json": it is read as a local file.*\(the document has no base URI/,
      );
      // Where the $ref is: known in the entry document only
      await expect(
        (await refusedOf()).read({ url: '/a.json', reference: '/a.json', baseUrl: 'https://example.com/root.json#/x/a%25b~1c' }, undefined, {
          _root$Ref: { path: 'https://example.com/root.json' },
        }),
      ).rejects.toMatchObject({ pointer: '/x/a%b~1c' });
      const elsewhere = (await rejection(
        (await refusedOf()).read({ url: '/a.json', reference: '/a.json', baseUrl: 'https://example.com/other.json#/x' }, undefined, {
          _root$Ref: { path: 'https://example.com/root.json' },
        }),
      )) as unknown as { pointer?: string };
      expect(elsewhere.pointer).toBeUndefined();

      // A local path is the file resolver's when file is allowed
      expect((await refusedOf({ refResolution: { allowedProtocols: ['file', 'https'] } })).canRead({ url: '/srv/a.json' })).toBe(
        false,
      );
    });

    it('stops looking through causes after a few levels', async () => {
      let error: Error = new Error('innermost');
      for (let level = 0; level < 10; level++) error = new Error(`level ${level}`, { cause: error });
      jest.spyOn(refParser(), 'dereference').mockRejectedValueOnce(error);
      await expect((await OpenAPIToolGenerator.fromJSON(entry('https://example.com/pet.json'))).generateTools()).rejects.toThrow(
        'Failed to dereference OpenAPI document: level 9',
      );
    });
  });

  describe('LoadOptions.documentUri', () => {
    it.each<[string, (options: LoadOptions) => Promise<OpenAPIToolGenerator>]>([
      ['fromJSON', (options) => OpenAPIToolGenerator.fromJSON(entry('#/components/schemas/Pet'), options)],
      ['fromYAML', (options) => OpenAPIToolGenerator.fromYAML(JSON.stringify(entry('#/components/schemas/Pet')), options)],
    ])('is checked by %s with a LoadError', async (_factory, load) => {
      await expect(load({ documentUri: 'openapi.yaml' })).rejects.toThrow(LoadError);
      await expect(load({ documentUri: 'https://user:pw@example.com/openapi.yaml' })).rejects.toThrow(
        'LoadOptions.documentUri must not contain user information',
      );
      await expect(load({ documentUri: 'https://example.com/openapi.yaml' })).resolves.toBeInstanceOf(
        OpenAPIToolGenerator,
      );
    });

    it('is checked by fromFile with a LoadError', async () => {
      await withFiles({ 'openapi.json': entry('#/components/schemas/Pet') }, async (dir) => {
        await expect(
          OpenAPIToolGenerator.fromFile(path.join(dir, 'openapi.json'), { documentUri: 'ftp://example.com/x' }),
        ).rejects.toThrow('LoadOptions.documentUri must be an http, https or file URI');
      });
    });

    it('never changes servers', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        entry('#/components/schemas/Pet', { servers: [{ url: '/v1' }], $self: 'https://self.example/api' }, '3.2.0'),
        { documentUri: 'https://docs.example/openapi.yaml' },
      );
      const [tool] = await generator.generateTools();
      expect(tool.metadata.servers).toEqual([{ url: '/v1' }]);
    });
  });

  describe('deeply nested documents', () => {
    /** A document whose schema `Deep` nests `depth` levels, as JSON text (JSON.stringify cannot go that deep). */
    const deepJson = (depth: number, extra = ''): string => {
      let schema = '{"type":"string"}';
      for (let level = 0; level < depth; level++) schema = `{"type":"object","properties":{"a":${schema}}}`;
      return (
        '{"openapi":"3.0.3","info":{"title":"Deep","version":"1"},"servers":[{"url":"https://api.example.com"}],' +
        `"paths":{"/a":{"get":{"operationId":"getA","responses":{"200":{"description":"ok"}}}}},` +
        `"components":{"schemas":{"Deep":${schema}${extra}}}}`
      );
    };

    it.each<[string, LoadOptions]>([
      ['default options', {}],
      ['secureDefaults', { secureDefaults: true }],
      ['dereference: false', { dereference: false }],
    ])('validates a document nested 10,000 deep without a $ref (%s)', async (_label, options) => {
      await withFiles({ 'deep.json': deepJson(10000) }, async (dir) => {
        const generator = await OpenAPIToolGenerator.fromFile(path.join(dir, 'deep.json'), options);
        const result = await generator.validate();
        expect(result.valid).toBe(true);
        expect(result).toEqual(await new Validator().validate(generator.getDocument()));
      });
    });

    it('validates one nested 2,500 deep loaded with fromJSON', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(JSON.parse(deepJson(2500)));
      expect((await generator.validate()).valid).toBe(true);
    });

    it('still throws, as generation does, for one too deep to be copied that references another document', async () => {
      await withFiles({ 'deep.json': deepJson(10000, ',"Other":{"$ref":"other.json"}') }, async (dir) => {
        const generator = await OpenAPIToolGenerator.fromFile(path.join(dir, 'deep.json'));
        await expect(generator.validate()).rejects.toThrow(ParseError);
        await expect(generator.generateTools()).rejects.toThrow(ParseError);
      });
    });
  });

  describe('references to the document itself', () => {
    const own = 'https://example.com/api/openapi.json';
    const schemas = {
      Pet: pet,
      'A B': pet,
      '50%': pet,
      '': pet,
      Ref: { $ref: '#/components/schemas/Pet', title: 'through' },
    };
    /** `entry(petRef)` with more schemas; `extra` adds a reference to another document, read from the loopback */
    const document = (petRef: string, extra: Record<string, unknown> = {}) =>
      entry(petRef, { components: { schemas: { ...schemas, ...extra } } });
    const otherDocument = () => ({ Extra: { $ref: `${origin}/extra.json` } });
    const paths = [
      ['the internal dereferencer', {}],
      ['$RefParser (another document is referenced too)', { other: true }],
    ] as const;

    it.each(paths)('percent-decodes the fragment, whichever dereferencer runs: %s', async (_label, variant) => {
      routes['/extra.json'] = { type: 'string' };
      const spy = jest.spyOn(refParser(), 'dereference');
      for (const fragment of ['A%20B', '50%25', '', 'Pet']) {
        const generator = await OpenAPIToolGenerator.fromJSON(
          document(`${own}#/components/schemas/${fragment}`, 'other' in variant ? otherDocument() : {}),
          { documentUri: own, refResolution: internal },
        );
        expect(hasPet((await generator.generateTools())[0])).toBe(true);
      }
      expect(spy).toHaveBeenCalledTimes('other' in variant ? 4 : 0);
    });

    it.each(paths)('fails the load for a pointer that leads nowhere, whichever dereferencer runs: %s', async (_label, variant) => {
      routes['/extra.json'] = { type: 'string' };
      const generator = await OpenAPIToolGenerator.fromJSON(
        document(`${own}#/components/schemas/Nope`, 'other' in variant ? otherDocument() : {}),
        { documentUri: own, refResolution: internal },
      );
      const error = await rejection(generator.generateTools());
      expect(error.message).toBe(
        `Failed to dereference OpenAPI document: Cannot read $ref "${own}#/components/schemas/Nope" at ` +
          `"#/paths/~1pets/post/requestBody/content/application~1json/schema" resolved against "${own}" to ` +
          `"${own}#/components/schemas/Nope": it names this document, but "#/components/schemas/Nope" points to ` +
          'nothing in it',
      );
      expect(error.context).toEqual({
        rule: 'missing-target',
        reference: `${own}#/components/schemas/Nope`,
        base: own,
        resolved: `${own}#/components/schemas/Nope`,
        path: '/paths/~1pets/post/requestBody/content/application~1json/schema',
      });
      expect(await generator.validate()).toEqual({
        valid: false,
        errors: [
          {
            code: 'UNREADABLE_REFERENCE',
            message: error.message.slice('Failed to dereference OpenAPI document: '.length),
            path: '/paths/~1pets/post/requestBody/content/application~1json/schema',
          },
        ],
      });
      // Nothing was read: the check runs before either dereferencer
      expect(loopback.requests).toHaveLength(0);
    });

    it('fails the load for a pointer that goes through another $ref', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(document(`${own}#/components/schemas/Ref/title`), {
        documentUri: own,
      });
      await expect(generator.generateTools()).rejects.toThrow(
        'it names this document, but its pointer goes through another $ref (at "#/components/schemas/Ref"), which is not followed',
      );
    });

    it('leaves a local reference that leads nowhere as it always was', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(document('#/components/schemas/Nope'), { documentUri: own });
      const [tool] = await generator.generateTools();
      expect(tool.name).toBe('createPet');
    });

    it('reads $ref "" as the whole document, with a base URI only', async () => {
      const whole = { ...entry('#/components/schemas/Pet'), components: { schemas: { Pet: pet, Doc: { $ref: '' } } } };
      const withBase = await OpenAPIToolGenerator.fromJSON(whole, { documentUri: own });
      await withBase.lint();
      const doc = withBase.getDocument() as any;
      expect(doc.components.schemas.Doc.openapi).toBe('3.0.3');
      const withoutBase = await OpenAPIToolGenerator.fromJSON(whole);
      await withoutBase.lint();
      expect((withoutBase.getDocument() as any).components.schemas.Doc).toEqual({ $ref: '' });
    });

    it('drops the keywords next to the $ref, as for a local reference', async () => {
      for (const ref of [`${own}#/components/schemas/Pet`, '#/components/schemas/Pet']) {
        const withSibling = entry('#/components/schemas/Pet');
        (withSibling.paths['/pets'].post.requestBody.content['application/json'] as Record<string, unknown>)['schema'] = {
          $ref: ref,
          description: 'a sibling keyword',
        };
        const generator = await OpenAPIToolGenerator.fromJSON(withSibling, { documentUri: own });
        await generator.generateTools();
        const schema = (generator.getDocument() as any).paths['/pets'].post.requestBody.content['application/json'].schema;
        expect(schema).toEqual(pet);
      }
    });

    it('validates what generation reads when the only references are to the document itself', async () => {
      const spy = jest.spyOn(refParser(), 'dereference');
      const selfOnly = {
        ...entry('#/components/schemas/Pet'),
        paths: { '/pets': { get: { $ref: `${own}#/components/x-operations/listPets` } } },
        components: { schemas: { Pet: pet }, 'x-operations': { listPets: { operationId: 'listPets', responses: ok } } },
      };
      // As written, the operation is a bare $ref: no responses, which OpenAPI 3.0 requires
      expect((await new Validator().validate(selfOnly)).errors?.map((e) => e.code)).toEqual(['NO_RESPONSES']);
      const generator = await OpenAPIToolGenerator.fromJSON(selfOnly, { documentUri: own });
      expect(await generator.validate()).toEqual({ valid: true });
      expect((await generator.generateTools()).map((t) => t.name)).toEqual(['listPets']);
      expect(spy).not.toHaveBeenCalled();
    });

    it('makes 100,000 references to the document local quickly, with a base near the length limit', async () => {
      const longOwn = `https://example.com/${'p/'.repeat(990)}openapi.json`;
      expect(longOwn.length).toBeLessThanOrEqual(2048);
      const many = entry('#/components/schemas/Pet');
      (many.components as Record<string, unknown>)['x-many'] = Array.from({ length: 100000 }, () => ({
        $ref: `${longOwn}#/components/schemas/Pet`,
      }));
      const spy = jest.spyOn(refParser(), 'dereference');
      const started = Date.now();
      const generator = await OpenAPIToolGenerator.fromJSON(many, { documentUri: longOwn });
      expect((await generator.validate()).valid).toBe(true);
      expect(await generator.generateTools()).toHaveLength(1);
      expect(Date.now() - started).toBeLessThan(30000);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('URIs too long to be used', () => {
    const longPath = `/api/openapi.json?sig=${'s'.repeat(3000)}`;

    it('does not use a retrieval URI past the limit: relative references are refused, absolute ones read', async () => {
      routes['/start'] = (_req: unknown, res: import('http').ServerResponse) => {
        res.writeHead(302, { location: longPath });
        res.end();
      };
      routes[longPath] = entry('schemas/pet.json');
      routes['/api/schemas/pet.json'] = pet;
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/start`, { refResolution: internal });
      expect(codes(generator)).toEqual(['BASE_URI_TOO_LONG']);
      const error = await rejection(generator.generateTools());
      expect(error.message).toBe(
        'Failed to dereference OpenAPI document: Cannot read $ref "schemas/pet.json" at ' +
          '"#/paths/~1pets/post/requestBody/content/application~1json/schema" to "schemas/pet.json": it is relative, ' +
          'and the URI the document was retrieved from is too long to be used as its base (BASE_URI_TOO_LONG)',
      );
      expect(error.context).toMatchObject({ rule: 'base-too-long' });
      expect(requested()).toEqual(['/start', longPath]);

      loopback.reset();
      routes[longPath] = entry(`${origin}/api/schemas/pet.json`);
      const absolute = await OpenAPIToolGenerator.fromURL(`${origin}/start`, { refResolution: internal });
      expect(hasPet((await absolute.generateTools())[0])).toBe(true);
    });

    it('still knows the document by an absolute $self, and checks its references', async () => {
      routes['/start'] = (_req: unknown, res: import('http').ServerResponse) => {
        res.writeHead(302, { location: longPath });
        res.end();
      };
      const self = 'https://example.com/api/openapi';
      routes[longPath] = entry(`${self}#/components/schemas/Pet`, { $self: self }, '3.2.0');
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/start`, { refResolution: internal });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);

      routes[longPath] = entry(`${self}#/components/schemas/Nope`, { $self: self }, '3.2.0');
      const missing = await OpenAPIToolGenerator.fromURL(`${origin}/start`, { refResolution: internal });
      const error = await rejection(missing.generateTools());
      expect(error.message).toContain(`Cannot read $ref "${self}#/components/schemas/Nope" at`);
      expect(error.context).toEqual({
        rule: 'missing-target',
        reference: `${self}#/components/schemas/Nope`,
        resolved: `${self}#/components/schemas/Nope`,
        path: '/paths/~1pets/post/requestBody/content/application~1json/schema',
      });
    });

    it('refuses a documentUri past the limit before reading anything', async () => {
      await expect(
        OpenAPIToolGenerator.fromURL(`${origin}/api/openapi.json`, {
          documentUri: `https://example.com/${'x'.repeat(3000)}`,
          refResolution: internal,
        }),
      ).rejects.toThrow('LoadOptions.documentUri must be at most 2048 characters');
      expect(loopback.requests).toHaveLength(0);
    });
  });

  describe('failures, in order and with accurate rules', () => {
    const failing = (refs: Record<string, string>, options: LoadOptions = { refResolution: internal }) =>
      OpenAPIToolGenerator.fromJSON(
        entry('#/components/schemas/Pet', {
          components: {
            schemas: { Pet: pet, ...Object.fromEntries(Object.entries(refs).map(([name, ref]) => [name, { $ref: ref }])) },
          },
        }),
        options,
      );

    it('reports the first reference in document order that cannot be read, whatever answers first', async () => {
      const policy = { refResolution: { ...internal, blockedHosts: ['refused.example'] } };
      routes['/slow.json'] = (_req: unknown, res: import('http').ServerResponse) => {
        setTimeout(() => {
          res.writeHead(404, 'Not Found');
          res.end();
        }, 150);
      };
      for (let run = 0; run < 3; run++) {
        const generator = await failing(
          { A: `${origin}/slow.json`, B: 'http://refused.example/refused.json', C: `${origin}/fast-missing.json` },
          policy,
        );
        const error = await rejection(generator.generateTools());
        expect(error.context).toMatchObject({ rule: 'response', path: '/components/schemas/A', resolved: `${origin}/slow.json` });
      }
      const refusedFirst = await rejection(
        (await failing({ B: 'http://refused.example/refused.json', A: `${origin}/slow.json` }, policy)).generateTools(),
      );
      expect(refusedFirst.context).toMatchObject({ rule: 'host-blocked', path: '/components/schemas/B' });
    });

    it('keeps that order into referenced documents', async () => {
      routes['/a.json'] = { type: 'object', properties: { x: { $ref: 'slow-missing.json' } } };
      routes['/b.json'] = { type: 'object', properties: { y: { $ref: 'fast-missing.json' } } };
      routes['/slow-missing.json'] = (_req: unknown, res: import('http').ServerResponse) => {
        setTimeout(() => {
          res.writeHead(404, 'Not Found');
          res.end();
        }, 150);
      };
      for (let run = 0; run < 3; run++) {
        const error = await rejection((await failing({ A: `${origin}/a.json`, B: `${origin}/b.json` })).generateTools());
        expect(error.context).toMatchObject({ reference: 'slow-missing.json', base: `${origin}/a.json` });
      }
    });

    it.each<[string, () => void, string, LoadOptions]>([
      [
        'a body over the size limit',
        () => {
          routes['/huge.json'] = `"${'x'.repeat(11 * 1024 * 1024)}"`;
        },
        'too-large',
        { refResolution: internal },
      ],
      [
        'no answer in time',
        () => {
          routes['/huge.json'] = (_req: unknown, res: import('http').ServerResponse) => {
            setTimeout(() => res.end('{}'), 1500);
          };
        },
        'timeout',
        { timeout: 200, refResolution: internal },
      ],
      [
        'a document that is not JSON or YAML',
        () => {
          routes['/huge.json'] = '{"type": ';
        },
        'invalid-document',
        { refResolution: internal },
      ],
    ])('labels %s', async (_label, setUp, rule, options) => {
      setUp();
      const error = await rejection((await failing({ A: `${origin}/huge.json` }, options)).generateTools());
      expect(error.context).toMatchObject({ rule });
    });

    it('labels a pointer that leads nowhere in another document', async () => {
      routes['/doc.json'] = { a: 1 };
      const error = await rejection((await failing({ A: `${origin}/doc.json#/nope` })).generateTools());
      expect(error.context).toEqual({ rule: 'missing-target' });
    });

    it('labels a name that does not resolve', async () => {
      jest.spyOn(dns.promises, 'lookup').mockRejectedValue(new Error('getaddrinfo ENOTFOUND schemas.invalid'));
      const error = await rejection((await failing({ A: 'http://schemas.invalid/pet.json' }, {})).generateTools());
      expect(error.context).toMatchObject({ rule: 'dns-failed' });
    });

    it('labels anything else unreadable', async () => {
      jest.spyOn(refParser(), 'dereference').mockRejectedValueOnce('string dereference error');
      const error = await rejection((await failing({ A: 'https://example.com/pet.json' }, {})).generateTools());
      expect(error.context).toEqual({ rule: 'unreadable' });
    });

    it('bounds and escapes the context, and hides the query of the URLs', async () => {
      const ref = `${origin}/${'x'.repeat(3000)}\u001b[31m.json?token=REF-SECRET`;
      const error = await rejection((await failing({ A: ref })).generateTools());
      for (const key of ['reference', 'resolved']) {
        expect((error.context?.[key] as string).length).toBeLessThanOrEqual(259);
        expect(error.context?.[key]).not.toMatch(/[\u0000-\u001f]/);
      }
      const withQuery = await rejection(
        (await failing({ A: `${origin}/pet.json?token=REF-SECRET` })).generateTools(),
      );
      // The reference is quoted as the document wrote it; the URL it resolved to is shown without its query
      expect(withQuery.context).toMatchObject({
        rule: 'response',
        reference: `${origin}/pet.json?token=REF-SECRET`,
        resolved: `${origin}/pet.json?...`,
      });
      expect(withQuery.message).toContain(`to "${origin}/pet.json?..."`);
    });

    it('locates a failure in another document by the reference alone', async () => {
      routes['/a.json'] = { type: 'object', properties: { b: { $ref: 'missing.json' } } };
      const generator = await failing({ A: `${origin}/a.json` });
      const error = await rejection(generator.generateTools());
      expect(error.message).toContain(`Cannot read $ref "missing.json" at "#/properties/b" resolved against "${origin}/a.json"`);
      expect(error.context).toEqual({
        rule: 'response',
        reference: 'missing.json',
        base: `${origin}/a.json`,
        resolved: `${origin}/missing.json`,
      });
      const result = await generator.validate();
      expect(result.errors).toEqual([{ code: 'UNREADABLE_REFERENCE', message: expect.stringContaining('missing.json') }]);
    });

    it('returns a 404 from validate() and throws it from generation', async () => {
      const generator = await failing({ A: `${origin}/missing.json` });
      const result = await generator.validate();
      expect(result.errors?.map((e) => [e.code, e.path])).toEqual([['UNREADABLE_REFERENCE', '/components/schemas/A']]);
      await expect(generator.generateTools()).rejects.toThrow(ParseError);
    });

    it('throws from validate() for a document JSON cannot copy that references another document', async () => {
      const yamlText =
        'openapi: 3.0.3\ninfo: {title: t, version: "1"}\npaths: {/a: {get: {responses: {"200": {description: ok}}}}}\n' +
        'components:\n  schemas:\n    A: &a\n      properties:\n        self: *a\n    B: {$ref: "other.json"}\n';
      const generator = await OpenAPIToolGenerator.fromYAML(yamlText);
      await expect(generator.validate()).rejects.toThrow(ParseError);
    });
  });

  describe('LoadOptions.documentUri, checked first', () => {
    it('is checked before fromURL fetches or fromFile reads', async () => {
      await expect(
        OpenAPIToolGenerator.fromURL(`${origin}/api/openapi.json`, { documentUri: 'openapi.json', refResolution: internal }),
      ).rejects.toThrow('LoadOptions.documentUri must be an absolute URI');
      expect(loopback.requests).toHaveLength(0);
      await expect(
        OpenAPIToolGenerator.fromFile('/nonexistent/openapi.json', { documentUri: 'openapi.json' }),
      ).rejects.toThrow('LoadOptions.documentUri must be an absolute URI');
    });

    it('never quotes its user information', async () => {
      const error = await rejection(
        OpenAPIToolGenerator.fromJSON(entry('#/components/schemas/Pet'), { documentUri: 'https://admin:hunter2@example.com/x' }),
      );
      expect(error).toBeInstanceOf(LoadError);
      expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain('hunter2');
    });
  });

  it('does not confine file reads to the folder of the document (with file allowed, any local file is readable)', async () => {
    await withFiles({ 'api/openapi.json': entry('../outside/pet.json'), 'outside/pet.json': pet }, async (dir) => {
      const generator = await OpenAPIToolGenerator.fromFile(path.join(dir, 'api/openapi.json'), {
        refResolution: { allowedProtocols: ['file'] },
      });
      expect(hasPet((await generator.generateTools())[0])).toBe(true);
    });
  });
});
