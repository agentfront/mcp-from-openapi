import { OpenAPIToolGenerator } from '../generator';
import { ParameterResolver } from '../parameter-resolver';
import { ResponseBuilder } from '../response-builder';
import { ParseError, LoadError } from '../errors';
import type { OpenAPIDocument } from '../types';

type LoopbackHandler = (req: import('http').IncomingMessage, res: import('http').ServerResponse) => void;

/**
 * Shared loopback HTTP server for URL-loading / pinned-transport tests. A real 127.0.0.1 server
 * (paired with `allowInternalIPs`) replaces `global.fetch` / `$RefParser.dereference` mocks so the
 * tests exercise the actual SSRF guard and Node connection pinning. See CLAUDE.md "Testing Patterns".
 */
function createLoopbackServer(getHandler: () => LoopbackHandler): { listen: () => Promise<string>; close: () => Promise<void> } {
  const http = require('http') as typeof import('http');
  const server = http.createServer((req, res) => getHandler()(req, res));
  return {
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`),
        ),
      ),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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

      // Mock generateTool to fail
      const origGenerate = generator.generateTool.bind(generator);
      let first = true;
      jest.spyOn(generator, 'generateTool').mockImplementation(async (...args) => {
        if (first) {
          first = false;
          throw new Error('Simulated failure');
        }
        return origGenerate(...args);
      });

      const tools = await generator.generateTools();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to generate tool'), expect.any(String));

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
    expect(options?.resolve?.file).toBeUndefined(); // not blocked
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

  it('applies all three trims to input and output schemas', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(trimSpec);
    const tool = await generator.generateTool('/things', 'post', {
      maxProperties: 2,
      maxDescriptionLength: 10,
      stripExamples: true,
    });
    const input = tool.inputSchema as any;
    const output = tool.outputSchema as any;

    expect(Object.keys(input.properties)).toHaveLength(2);
    // caps run LAST so every description — including the omitted-note added
    // by limitProperties — respects the bound (10 chars + ellipsis)
    expect(input.description).toBe('[1 additio…');
    expect(input.properties.name.description!.length).toBeLessThanOrEqual(11);
    expect(input.properties.name.examples).toBeUndefined();
    expect(output.properties.id.examples).toBeUndefined();
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
    const describe = async (p: string) =>
      (await generator.generateTool(p, 'get', { appendResponseSummary: true })).description;

    expect(await describe('/typeless')).toContain('Returns: object with fields: a');
    expect(await describe('/bare-object')).toContain('Returns: object');
    expect(await describe('/object-array')).toContain('Returns: array of objects');
    // first union variant is type:null -> nothing sensible to say
    expect(await describe('/null-first')).not.toContain('Returns:');
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
