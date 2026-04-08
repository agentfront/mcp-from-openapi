import { BUILTIN_FORMAT_RESOLVERS, resolveSchemaFormats } from '../format-resolver';
import { OpenAPIToolGenerator } from '../generator';
import type { JsonSchema, FormatResolver } from '../types';

describe('BUILTIN_FORMAT_RESOLVERS', () => {
  describe('string formats', () => {
    it('should add uuid pattern and description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['uuid']({ type: 'string', format: 'uuid' });

      expect(result.pattern).toMatch(/^\^/);
      expect(result.description).toBe('UUID string (RFC 4122)');
    });

    it('should not overwrite existing uuid pattern', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['uuid']({
        type: 'string',
        format: 'uuid',
        pattern: '^custom-pattern$',
      });

      expect(result.pattern).toBe('^custom-pattern$');
    });

    it('should not overwrite existing description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['uuid']({
        type: 'string',
        format: 'uuid',
        description: 'Custom ID field',
      });

      expect(result.description).toBe('Custom ID field');
    });

    it('should add date-time description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['date-time']({ type: 'string', format: 'date-time' });

      expect(result.description).toContain('ISO 8601');
    });

    it('should add date pattern and description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['date']({ type: 'string', format: 'date' });

      expect(result.pattern).toBeDefined();
      expect(result.description).toContain('ISO 8601');
    });

    it('should add time pattern and description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['time']({ type: 'string', format: 'time' });

      expect(result.pattern).toBeDefined();
      expect(result.description).toContain('ISO 8601');
    });

    it('should add email description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['email']({ type: 'string', format: 'email' });

      expect(result.description).toContain('RFC 5322');
    });

    it('should add uri description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['uri']({ type: 'string', format: 'uri' });

      expect(result.description).toContain('RFC 3986');
    });

    it('should add uri-reference description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['uri-reference']({ type: 'string', format: 'uri-reference' });

      expect(result.description).toContain('URI reference');
    });

    it('should add hostname description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['hostname']({ type: 'string', format: 'hostname' });

      expect(result.description).toContain('hostname');
    });

    it('should add ipv4 pattern and description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['ipv4']({ type: 'string', format: 'ipv4' });

      expect(result.pattern).toBeDefined();
      expect(result.description).toBe('IPv4 address');
    });

    it('should add ipv6 description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['ipv6']({ type: 'string', format: 'ipv6' });

      expect(result.description).toContain('IPv6');
    });
  });

  describe('integer formats', () => {
    it('should add int32 min/max', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['int32']({ type: 'integer', format: 'int32' });

      expect(result.minimum).toBe(-2147483648);
      expect(result.maximum).toBe(2147483647);
    });

    it('should not overwrite existing int32 minimum', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['int32']({
        type: 'integer',
        format: 'int32',
        minimum: 0,
      });

      expect(result.minimum).toBe(0);
      expect(result.maximum).toBe(2147483647);
    });

    it('should not overwrite existing int32 maximum', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['int32']({
        type: 'integer',
        format: 'int32',
        maximum: 100,
      });

      expect(result.minimum).toBe(-2147483648);
      expect(result.maximum).toBe(100);
    });

    it('should add int64 min/max', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['int64']({ type: 'integer', format: 'int64' });

      expect(result.minimum).toBe(Number.MIN_SAFE_INTEGER);
      expect(result.maximum).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('binary/encoding formats', () => {
    it('should add byte pattern and description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['byte']({ type: 'string', format: 'byte' });

      expect(result.pattern).toBeDefined();
      expect(result.description).toContain('Base64');
    });

    it('should add binary description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['binary']({ type: 'string', format: 'binary' });

      expect(result.description).toBe('Binary data');
    });

    it('should add password description', () => {
      const result = BUILTIN_FORMAT_RESOLVERS['password']({ type: 'string', format: 'password' });

      expect(result.description).toContain('Password');
    });
  });
});

describe('resolveSchemaFormats', () => {
  const resolvers: Record<string, FormatResolver> = {
    uuid: (schema) => ({ ...schema, pattern: '^uuid$', description: 'test-uuid' }),
    email: (schema) => ({ ...schema, description: 'test-email' }),
  };

  it('should resolve format on a flat schema', () => {
    const schema: JsonSchema = { type: 'string', format: 'uuid' };
    const result = resolveSchemaFormats(schema, resolvers);

    expect(result.pattern).toBe('^uuid$');
    expect(result.description).toBe('test-uuid');
  });

  it('should resolve formats in properties', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        contact: { type: 'string', format: 'email' },
        name: { type: 'string' },
      },
    };
    const result = resolveSchemaFormats(schema, resolvers);

    expect((result.properties?.['id'] as any).pattern).toBe('^uuid$');
    expect((result.properties?.['contact'] as any).description).toBe('test-email');
    expect(result.properties?.['name']).toEqual({ type: 'string' });
  });

  it('should resolve formats in array items', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
    };
    const result = resolveSchemaFormats(schema, resolvers);

    expect((result.items as any).pattern).toBe('^uuid$');
  });

  it('should resolve formats in tuple items', () => {
    const schema: JsonSchema = {
      type: 'array',
      items: [
        { type: 'string', format: 'uuid' },
        { type: 'string', format: 'email' },
      ],
    } as any;
    const result = resolveSchemaFormats(schema, resolvers);

    expect((result.items as any[])[0].pattern).toBe('^uuid$');
    expect((result.items as any[])[1].description).toBe('test-email');
  });

  it('should resolve formats in additionalProperties', () => {
    const schema: JsonSchema = {
      type: 'object',
      additionalProperties: { type: 'string', format: 'uuid' },
    };
    const result = resolveSchemaFormats(schema, resolvers);

    expect((result.additionalProperties as any).pattern).toBe('^uuid$');
  });

  it('should resolve formats in allOf/anyOf/oneOf', () => {
    const schema: JsonSchema = {
      anyOf: [
        { type: 'string', format: 'uuid' },
        { type: 'string', format: 'email' },
      ],
    };
    const result = resolveSchemaFormats(schema, resolvers);

    expect((result.anyOf as any[])[0].pattern).toBe('^uuid$');
    expect((result.anyOf as any[])[1].description).toBe('test-email');
  });

  it('should resolve formats in not', () => {
    const schema: JsonSchema = {
      not: { type: 'string', format: 'uuid' },
    };
    const result = resolveSchemaFormats(schema, resolvers);

    expect((result.not as any).pattern).toBe('^uuid$');
  });

  it('should resolve nested properties recursively', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    };
    const result = resolveSchemaFormats(schema, resolvers);

    expect((result.properties?.['user'] as any).properties.id.pattern).toBe('^uuid$');
  });

  it('should skip formats without a matching resolver', () => {
    const schema: JsonSchema = { type: 'string', format: 'custom-unknown' };
    const result = resolveSchemaFormats(schema, resolvers);

    expect(result).toEqual(schema);
  });

  it('should handle null/undefined schema gracefully', () => {
    expect(resolveSchemaFormats(null as any, resolvers)).toBeNull();
    expect(resolveSchemaFormats(undefined as any, resolvers)).toBeUndefined();
  });

  it('should not mutate the original schema', () => {
    const schema: JsonSchema = { type: 'string', format: 'uuid' };
    const original = { ...schema };
    resolveSchemaFormats(schema, resolvers);

    expect(schema).toEqual(original);
  });

  it('should be a no-op with empty resolvers', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
      },
    };
    const result = resolveSchemaFormats(schema, {});

    expect(result).toEqual(schema);
  });
});

describe('Format resolution integration', () => {
  it('should resolve formats in inputSchema with resolveFormats: true', async () => {
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/users/{userId}': {
          get: {
            operationId: 'getUser',
            parameters: [
              {
                name: 'userId',
                in: 'path',
                required: true,
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        email: { type: 'string', format: 'email' },
                        createdAt: { type: 'string', format: 'date-time' },
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
    const tools = await generator.generateTools({ resolveFormats: true });

    expect(tools).toHaveLength(1);

    // Input schema should have uuid pattern
    const userIdSchema = tools[0].inputSchema.properties?.['userId'] as any;
    expect(userIdSchema.pattern).toMatch(/[0-9a-fA-F]/);

    // Output schema should have formats resolved
    const outputProps = (tools[0].outputSchema as any)?.properties;
    expect(outputProps?.id?.pattern).toMatch(/[0-9a-fA-F]/);
    expect(outputProps?.email?.description).toContain('RFC 5322');
    expect(outputProps?.createdAt?.description).toContain('ISO 8601');
  });

  it('should not resolve formats when resolveFormats is false (default)', async () => {
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/test': {
          get: {
            operationId: 'test',
            parameters: [
              {
                name: 'id',
                in: 'query',
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const generator = await OpenAPIToolGenerator.fromJSON(openapi);
    const tools = await generator.generateTools();

    const idSchema = tools[0].inputSchema.properties?.['id'] as any;
    expect(idSchema.format).toBe('uuid');
    expect(idSchema.pattern).toBeUndefined();
  });

  it('should apply custom formatResolvers', async () => {
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/test': {
          post: {
            operationId: 'createTest',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      phone: { type: 'string', format: 'phone' },
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

    const generator = await OpenAPIToolGenerator.fromJSON(openapi);
    const tools = await generator.generateTools({
      formatResolvers: {
        phone: (schema) => ({
          ...schema,
          pattern: '^\\+?[1-9]\\d{1,14}$',
          description: 'E.164 phone number',
        }),
      },
    });

    const phoneSchema = tools[0].inputSchema.properties?.['phone'] as any;
    expect(phoneSchema.pattern).toBe('^\\+?[1-9]\\d{1,14}$');
    expect(phoneSchema.description).toBe('E.164 phone number');
  });

  it('should let custom resolvers override built-in ones', async () => {
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {
        '/test': {
          get: {
            operationId: 'test',
            parameters: [
              {
                name: 'id',
                in: 'query',
                schema: { type: 'string', format: 'uuid' },
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    const generator = await OpenAPIToolGenerator.fromJSON(openapi);
    const tools = await generator.generateTools({
      resolveFormats: true,
      formatResolvers: {
        uuid: (schema) => ({
          ...schema,
          description: 'Custom UUID format',
        }),
      },
    });

    const idSchema = tools[0].inputSchema.properties?.['id'] as any;
    expect(idSchema.description).toBe('Custom UUID format');
    // Pattern should NOT be added because the custom resolver replaced the built-in
    expect(idSchema.pattern).toBeUndefined();
  });
});
