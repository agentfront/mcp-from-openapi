/**
 * Integration tests — exercise the full pipeline end-to-end:
 * spec loading → dereferencing → validation → tool generation → security resolution
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  OpenAPIToolGenerator,
  SecurityResolver,
  createSecurityContext,
  ParseError,
} from '../index';
import type { OpenAPIDocument, McpOpenAPITool } from '../index';

// ---------------------------------------------------------------------------
// Realistic fixture: a "User Management API" with comprehensive OpenAPI features
// ---------------------------------------------------------------------------
const userManagementApi: OpenAPIDocument = {
  openapi: '3.0.3',
  info: {
    title: 'User Management API',
    version: '2.1.0',
    description: 'A comprehensive API for managing users',
  },
  servers: [
    { url: 'https://api.example.com/v2', description: 'Production' },
    { url: 'https://staging-api.example.com/v2', description: 'Staging' },
  ],
  externalDocs: {
    url: 'https://docs.example.com',
    description: 'Full documentation',
  },
  tags: [
    { name: 'users', description: 'User operations' },
    { name: 'admin', description: 'Admin operations' },
  ],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      apiKeyAuth: {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
      },
      oauth2Auth: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://auth.example.com/token',
            scopes: {
              'read:users': 'Read user data',
              'write:users': 'Modify user data',
            },
          },
        },
      },
    },
    schemas: {
      User: {
        type: 'object',
        required: ['id', 'email', 'name'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string', minLength: 1, maxLength: 100 },
          age: { type: 'integer', format: 'int32', minimum: 0 },
          createdAt: { type: 'string', format: 'date-time' },
          role: { type: 'string', enum: ['user', 'admin', 'moderator'] },
        },
      },
      CreateUserRequest: {
        type: 'object',
        required: ['email', 'name'],
        properties: {
          email: { type: 'string', format: 'email' },
          name: { type: 'string', minLength: 1 },
          age: { type: 'integer', format: 'int32', minimum: 0 },
          role: { type: 'string', enum: ['user', 'admin', 'moderator'] },
        },
      },
      UserList: {
        type: 'object',
        properties: {
          users: {
            type: 'array',
            items: { $ref: '#/components/schemas/User' },
          },
          total: { type: 'integer' },
          page: { type: 'integer' },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          code: { type: 'integer' },
          message: { type: 'string' },
        },
      },
    },
    parameters: {
      UserId: {
        name: 'userId',
        in: 'path',
        required: true,
        description: 'The user ID',
        schema: { type: 'string', format: 'uuid' },
      },
      PageParam: {
        name: 'page',
        in: 'query',
        schema: { type: 'integer', minimum: 1, default: 1 },
      },
      LimitParam: {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
    },
    responses: {
      NotFound: {
        description: 'Resource not found',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ErrorResponse' },
          },
        },
      },
    },
  },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List all users',
        tags: ['users'],
        parameters: [
          { $ref: '#/components/parameters/PageParam' },
          { $ref: '#/components/parameters/LimitParam' },
          {
            name: 'sort',
            in: 'query',
            schema: { type: 'string', enum: ['name', 'email', 'createdAt'] },
          },
          {
            name: 'X-Request-ID',
            in: 'header',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UserList' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createUser',
        summary: 'Create a new user',
        tags: ['users'],
        security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateUserRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'User created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' },
              },
            },
          },
          '400': {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/users/{userId}': {
      get: {
        operationId: 'getUser',
        summary: 'Get user by ID',
        tags: ['users'],
        parameters: [{ $ref: '#/components/parameters/UserId' }],
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      put: {
        operationId: 'updateUser',
        summary: 'Update user',
        tags: ['users'],
        parameters: [{ $ref: '#/components/parameters/UserId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateUserRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'User updated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/User' },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        operationId: 'deleteUser',
        summary: 'Delete user',
        tags: ['admin'],
        security: [{ oauth2Auth: ['write:users'] }],
        parameters: [{ $ref: '#/components/parameters/UserId' }],
        responses: {
          '204': { description: 'User deleted' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/users/{userId}/avatar': {
      post: {
        operationId: 'uploadAvatar',
        summary: 'Upload user avatar (deprecated)',
        tags: ['users'],
        deprecated: true,
        parameters: [{ $ref: '#/components/parameters/UserId' }],
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
        responses: {
          '200': { description: 'Avatar uploaded' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// 1. Full pipeline: spec → tools
// ---------------------------------------------------------------------------
describe('Integration: Full Pipeline', () => {
  it('should generate all tools from JSON spec', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools();

    // 5 non-deprecated operations: listUsers, createUser, getUser, updateUser, deleteUser
    expect(tools).toHaveLength(5);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['createUser', 'deleteUser', 'getUser', 'listUsers', 'updateUser']);
  });

  it('should generate same tools from YAML string', async () => {
    const yamlString = yaml.stringify(userManagementApi);
    const generator = await OpenAPIToolGenerator.fromYAML(yamlString);
    const tools = await generator.generateTools();

    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['createUser', 'deleteUser', 'getUser', 'listUsers', 'updateUser'],
    );
  });

  it('should generate same tools from file', async () => {
    const tmpFile = path.join(os.tmpdir(), `integration-spec-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(userManagementApi));
    try {
      const generator = await OpenAPIToolGenerator.fromFile(tmpFile);
      const tools = await generator.generateTools();

      expect(tools).toHaveLength(5);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('should generate same tools from YAML file', async () => {
    const tmpFile = path.join(os.tmpdir(), `integration-spec-${Date.now()}.yaml`);
    fs.writeFileSync(tmpFile, yaml.stringify(userManagementApi));
    try {
      const generator = await OpenAPIToolGenerator.fromFile(tmpFile);
      const tools = await generator.generateTools();

      expect(tools).toHaveLength(5);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('should include deprecated operations when configured', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({ includeDeprecated: true });

    // 6 total: 5 + uploadAvatar (deprecated)
    expect(tools).toHaveLength(6);
    expect(tools.find((t) => t.name === 'uploadAvatar')).toBeDefined();
    expect(tools.find((t) => t.name === 'uploadAvatar')!.metadata.deprecated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. $ref resolution end-to-end
// ---------------------------------------------------------------------------
describe('Integration: $ref Resolution', () => {
  it('should resolve all $ref pointers in schemas', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tool = await generator.generateTool('/users', 'get');

    // Output schema should have resolved UserList → User $ref
    const outputStr = JSON.stringify(tool.outputSchema);
    expect(outputStr).not.toContain('$ref');

    // UserList.users.items should be the resolved User schema
    const usersItems = (tool.outputSchema as any)?.anyOf?.[0]?.properties?.users?.items
      ?? (tool.outputSchema as any)?.properties?.users?.items;

    if (usersItems) {
      expect(usersItems.properties).toHaveProperty('id');
      expect(usersItems.properties).toHaveProperty('email');
      expect(usersItems.properties).toHaveProperty('name');
    }
  });

  it('should resolve $ref in parameters', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tool = await generator.generateTool('/users/{userId}', 'get');

    // userId parameter should be resolved from $ref
    expect(tool.inputSchema.properties).toHaveProperty('userId');
    const userIdSchema = tool.inputSchema.properties!['userId'] as any;
    expect(userIdSchema.type).toBe('string');
    expect(userIdSchema.format).toBe('uuid');
  });

  it('should resolve $ref in responses', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tool = await generator.generateTool('/users/{userId}', 'get');

    // Output schema (union of 200 + 404) should be resolved
    const outputStr = JSON.stringify(tool.outputSchema);
    expect(outputStr).not.toContain('$ref');
  });

  it('should preserve $ref when dereference is disabled', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi, { dereference: false });
    const doc = generator.getDocument();

    // $ref pointers should still be present
    const listUsersParams = (doc.paths as any)['/users'].get.parameters;
    expect(listUsersParams[0]).toHaveProperty('$ref');
  });
});

// ---------------------------------------------------------------------------
// 3. Parameter mapping end-to-end
// ---------------------------------------------------------------------------
describe('Integration: Parameter Mapping', () => {
  let tools: McpOpenAPITool[];

  beforeAll(async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    tools = await generator.generateTools();
  });

  it('should map path parameters correctly', () => {
    const getUserTool = tools.find((t) => t.name === 'getUser')!;

    const userIdMapper = getUserTool.mapper.find((m) => m.key === 'userId');
    expect(userIdMapper).toBeDefined();
    expect(userIdMapper!.type).toBe('path');
    expect(userIdMapper!.required).toBe(true);
  });

  it('should map query parameters correctly', () => {
    const listUsersTool = tools.find((t) => t.name === 'listUsers')!;

    const pageMapper = listUsersTool.mapper.find((m) => m.key === 'page');
    expect(pageMapper).toBeDefined();
    expect(pageMapper!.type).toBe('query');

    const sortMapper = listUsersTool.mapper.find((m) => m.key === 'sort');
    expect(sortMapper).toBeDefined();
    expect(sortMapper!.type).toBe('query');
  });

  it('should map header parameters correctly', () => {
    const listUsersTool = tools.find((t) => t.name === 'listUsers')!;

    const requestIdMapper = listUsersTool.mapper.find((m) => m.key === 'X-Request-ID');
    expect(requestIdMapper).toBeDefined();
    expect(requestIdMapper!.type).toBe('header');
  });

  it('should map body parameters correctly', () => {
    const createUserTool = tools.find((t) => t.name === 'createUser')!;

    const bodyMappers = createUserTool.mapper.filter((m) => m.type === 'body');
    expect(bodyMappers.length).toBeGreaterThan(0);

    // CreateUserRequest has email, name, age, role
    expect(createUserTool.inputSchema.properties).toHaveProperty('email');
    expect(createUserTool.inputSchema.properties).toHaveProperty('name');
  });

  it('should mark required parameters correctly', () => {
    const createUserTool = tools.find((t) => t.name === 'createUser')!;

    // email and name are required in CreateUserRequest
    expect(createUserTool.inputSchema.required).toContain('email');
    expect(createUserTool.inputSchema.required).toContain('name');
  });

  it('should map path + body together for update operations', () => {
    const updateUserTool = tools.find((t) => t.name === 'updateUser')!;

    // Should have userId (path) + email, name, age, role (body)
    expect(updateUserTool.inputSchema.properties).toHaveProperty('userId');
    expect(updateUserTool.inputSchema.properties).toHaveProperty('email');

    const pathMapper = updateUserTool.mapper.find((m) => m.type === 'path');
    const bodyMappers = updateUserTool.mapper.filter((m) => m.type === 'body');
    expect(pathMapper).toBeDefined();
    expect(bodyMappers.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Security resolution end-to-end
// ---------------------------------------------------------------------------
describe('Integration: Security Resolution', () => {
  it('should extract security requirements from tools', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools();

    // listUsers uses global security (bearerAuth)
    const listUsers = tools.find((t) => t.name === 'listUsers')!;
    expect(listUsers.metadata.security).toBeDefined();
    expect(listUsers.metadata.security!.some((s) => s.scheme === 'bearerAuth')).toBe(true);

    // deleteUser uses operation-level oauth2
    const deleteUser = tools.find((t) => t.name === 'deleteUser')!;
    expect(deleteUser.metadata.security!.some((s) => s.type === 'oauth2')).toBe(true);
  });

  it('should resolve Bearer auth with SecurityResolver', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({ includeSecurityInInput: true });

    const listUsers = tools.find((t) => t.name === 'listUsers')!;
    const securityMappers = listUsers.mapper.filter((m) => m.security);

    const resolver = new SecurityResolver();
    const context = createSecurityContext({ jwt: 'my-jwt-token' });
    const resolved = await resolver.resolve(securityMappers, context);

    // The header key is the mapper's key (original parameter name)
    const bearerMapper = securityMappers.find((m) => m.security?.scheme === 'bearerAuth')!;
    expect(resolved.headers[bearerMapper.key]).toBe('Bearer my-jwt-token');
  });

  it('should resolve API Key auth with SecurityResolver', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({ includeSecurityInInput: true });

    const createUser = tools.find((t) => t.name === 'createUser')!;
    const apiKeyMappers = createUser.mapper.filter(
      (m) => m.security?.type === 'apiKey',
    );

    const resolver = new SecurityResolver();
    const context = createSecurityContext({ apiKey: 'my-api-key-123' });
    const resolved = await resolver.resolve(apiKeyMappers, context);

    // API key resolved to the header key from the mapper
    const apiKeyMapper = apiKeyMappers[0];
    expect(resolved.headers[apiKeyMapper.key]).toBe('my-api-key-123');
  });

  it('should report missing security when no credentials provided', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({ includeSecurityInInput: true });

    const listUsers = tools.find((t) => t.name === 'listUsers')!;
    const securityMappers = listUsers.mapper.filter((m) => m.security);

    const resolver = new SecurityResolver();
    const missing = await resolver.checkMissingSecurity(securityMappers, {});

    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('bearerAuth');
  });
});

// ---------------------------------------------------------------------------
// 5. Format resolution end-to-end
// ---------------------------------------------------------------------------
describe('Integration: Format Resolution', () => {
  it('should enrich schemas with format constraints when enabled', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({ resolveFormats: true });

    const getUser = tools.find((t) => t.name === 'getUser')!;

    // userId param (format: uuid) should have pattern added
    const userIdSchema = getUser.inputSchema.properties!['userId'] as any;
    expect(userIdSchema.format).toBe('uuid');
    expect(userIdSchema.pattern).toMatch(/[0-9a-fA-F]/);
    // description is preserved from the spec ('The user ID'), not overwritten
    expect(userIdSchema.description).toBe('The user ID');
  });

  it('should resolve formats in output schema', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({ resolveFormats: true });

    const getUser = tools.find((t) => t.name === 'getUser')!;

    // Output schema should have format-enriched User fields
    const outputStr = JSON.stringify(getUser.outputSchema);
    // email should have RFC description, date-time should have ISO description
    expect(outputStr).toContain('RFC');
    expect(outputStr).toContain('ISO 8601');
  });

  it('should NOT resolve formats when disabled (default)', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools();

    const getUser = tools.find((t) => t.name === 'getUser')!;
    const userIdSchema = getUser.inputSchema.properties!['userId'] as any;

    expect(userIdSchema.format).toBe('uuid');
    expect(userIdSchema.pattern).toBeUndefined(); // no pattern added
  });

  it('should apply custom format resolvers', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({
      resolveFormats: true,
      formatResolvers: {
        uuid: (schema) => ({ ...schema, description: 'Custom UUID' }),
      },
    });

    const getUser = tools.find((t) => t.name === 'getUser')!;
    const userIdSchema = getUser.inputSchema.properties!['userId'] as any;

    expect(userIdSchema.description).toBe('Custom UUID');
  });
});

// ---------------------------------------------------------------------------
// 6. Validation end-to-end
// ---------------------------------------------------------------------------
describe('Integration: Validation', () => {
  it('should dereference then validate and generate tools successfully', async () => {
    // generateTools() dereferences first, then validates the resolved document
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools();

    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toHaveLength(5);
  });

  it('should throw ParseError for invalid spec during generation', async () => {
    const invalidSpec = {
      openapi: '2.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {},
    };

    const generator = await OpenAPIToolGenerator.fromJSON(invalidSpec);
    await expect(generator.generateTools()).rejects.toThrow(ParseError);
  });

  it('should catch missing path parameters during validation', async () => {
    const specWithMissingParam = {
      openapi: '3.0.3',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/users/{userId}': {
          get: {
            operationId: 'getUser',
            // Missing userId parameter definition!
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const generator = await OpenAPIToolGenerator.fromJSON(specWithMissingParam);
    const result = await generator.validate();

    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.code === 'MISSING_PATH_PARAMETER')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Filtering and options end-to-end
// ---------------------------------------------------------------------------
describe('Integration: Filtering & Options', () => {
  it('should include only specified operations', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({
      includeOperations: ['getUser', 'listUsers'],
    });

    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(['getUser', 'listUsers']);
  });

  it('should exclude specified operations', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({
      excludeOperations: ['deleteUser'],
    });

    expect(tools.find((t) => t.name === 'deleteUser')).toBeUndefined();
    expect(tools.length).toBe(4);
  });

  it('should filter by custom function', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tools = await generator.generateTools({
      filterFn: (op) => op.tags?.includes('admin') ?? false,
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('deleteUser');
  });

  it('should override servers with baseUrl', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi, {
      baseUrl: 'https://custom-api.example.com',
    });
    const tools = await generator.generateTools();

    const tool = tools[0];
    expect(tool.metadata.servers).toBeDefined();
    expect(tool.metadata.servers![0].url).toBe('https://custom-api.example.com');
  });

  it('should extract metadata correctly', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(userManagementApi);
    const tool = await generator.generateTool('/users', 'get');

    expect(tool.metadata.path).toBe('/users');
    expect(tool.metadata.method).toBe('get');
    expect(tool.metadata.operationId).toBe('listUsers');
    expect(tool.metadata.tags).toContain('users');
    expect(tool.metadata.servers).toBeDefined();
    expect(tool.metadata.servers!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Entrypoint exports
// ---------------------------------------------------------------------------
describe('Integration: Entrypoint Exports', () => {
  it('should export all public APIs from the entrypoint', () => {
    const lib = require('../index');

    expect(typeof lib.OpenAPIToolGenerator).toBe('function');
    expect(typeof lib.SecurityResolver).toBe('function');
    expect(typeof lib.SchemaBuilder).toBe('function');
    expect(typeof lib.ParameterResolver).toBe('function');
    expect(typeof lib.ResponseBuilder).toBe('function');
    expect(typeof lib.Validator).toBe('function');
    expect(typeof lib.resolveSchemaFormats).toBe('function');
    expect(typeof lib.BUILTIN_FORMAT_RESOLVERS).toBe('object');
    expect(typeof lib.isReferenceObject).toBe('function');
    expect(typeof lib.toJsonSchema).toBe('function');
    expect(typeof lib.createSecurityContext).toBe('function');

    // Error classes
    expect(typeof lib.OpenAPIToolError).toBe('function');
    expect(typeof lib.LoadError).toBe('function');
    expect(typeof lib.ParseError).toBe('function');
    expect(typeof lib.ValidationError).toBe('function');
    expect(typeof lib.GenerationError).toBe('function');
    expect(typeof lib.SchemaError).toBe('function');
  });
});
