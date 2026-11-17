/**
 * Tests for ResponseBuilder class
 */

import { ResponseBuilder } from '../response-builder';

describe('ResponseBuilder', () => {
  describe('Constructor', () => {
    it('should use default options', () => {
      const builder = new ResponseBuilder();
      // Test behavior through build method
      expect(builder).toBeDefined();
    });

    it('should accept custom preferredStatusCodes', () => {
      const builder = new ResponseBuilder({ preferredStatusCodes: [201, 200] });
      expect(builder).toBeDefined();
    });

    it('should accept includeAllResponses option', () => {
      const builder = new ResponseBuilder({ includeAllResponses: false });
      expect(builder).toBeDefined();
    });
  });

  describe('build()', () => {
    it('should return undefined for empty responses', () => {
      const builder = new ResponseBuilder();
      expect(builder.build({})).toBeUndefined();
    });

    it('should return undefined for undefined responses', () => {
      const builder = new ResponseBuilder();
      expect(builder.build(undefined)).toBeUndefined();
    });

    it('should return undefined when no valid schemas extracted', () => {
      const builder = new ResponseBuilder();
      // All responses are references (which are skipped)
      const result = builder.build({
        '200': { $ref: '#/components/responses/Success' },
        '404': { $ref: '#/components/responses/NotFound' },
      } as any);
      expect(result).toBeUndefined();
    });

    it('should return single schema directly', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        },
      });

      expect(result).toBeDefined();
      expect(result?.type).toBe('object');
      expect((result as any)['x-status-code']).toBe(200);
    });

    it('should return oneOf for multiple responses with includeAllResponses=true', () => {
      const builder = new ResponseBuilder({ includeAllResponses: true });
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'application/json': { schema: { type: 'object' } },
          },
        },
        '201': {
          description: 'Created',
          content: {
            'application/json': { schema: { type: 'string' } },
          },
        },
      });

      expect(result).toBeDefined();
      expect(result?.oneOf).toHaveLength(2);
      expect(result?.description).toBe('Response can be one of multiple status codes');
    });

    it('should return preferred schema when includeAllResponses=false', () => {
      const builder = new ResponseBuilder({
        includeAllResponses: false,
        preferredStatusCodes: [201],
      });
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'application/json': { schema: { type: 'object' } },
          },
        },
        '201': {
          description: 'Created',
          content: {
            'application/json': { schema: { type: 'string' } },
          },
        },
      });

      expect(result).toBeDefined();
      expect(result?.type).toBe('string');
      expect(result?.oneOf).toBeUndefined();
    });
  });

  describe('extractResponseSchemas()', () => {
    it('should skip reference objects', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': { $ref: '#/components/responses/Success' },
        '201': {
          description: 'Created',
          content: {
            'application/json': { schema: { type: 'string' } },
          },
        },
      } as any);

      expect(result).toBeDefined();
      expect(result?.type).toBe('string');
    });

    it('should skip default status code initially', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        default: {
          description: 'Default response',
          content: {
            'application/json': { schema: { type: 'object' } },
          },
        },
        '200': {
          description: 'Success',
          content: {
            'application/json': { schema: { type: 'string' } },
          },
        },
      });

      // Should prefer the 200 response over default
      expect(result?.type).toBe('string');
    });

    it('should use default response when no other schemas available', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        default: {
          description: 'Default response',
          content: {
            'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } },
          },
        },
      });

      expect(result).toBeDefined();
      expect(result?.type).toBe('object');
      expect((result as any)['x-status-code']).toBe(0);
    });

    it('should skip default response if it is a reference', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        default: { $ref: '#/components/responses/Error' },
      } as any);

      expect(result).toBeUndefined();
    });

    it('should skip NaN status codes', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        invalid: {
          description: 'Invalid status code',
          content: {
            'application/json': { schema: { type: 'string' } },
          },
        },
        '200': {
          description: 'Success',
          content: {
            'application/json': { schema: { type: 'object' } },
          },
        },
      } as any);

      // Should only have the valid 200 response
      expect(result?.type).toBe('object');
    });

    it('should handle schema extraction failure gracefully', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'application/json': {}, // No schema
          },
        },
        '201': {
          description: 'Created',
          content: {
            'application/json': { schema: { type: 'string' } },
          },
        },
      });

      // Should only have the 201 response since 200 has no schema
      expect(result?.type).toBe('string');
    });
  });

  describe('extractResponseSchema()', () => {
    it('should handle response with no content (204 No Content)', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '204': {
          description: 'No Content',
        },
      });

      expect(result).toBeDefined();
      expect(result?.type).toBe('null');
      expect(result?.description).toBe('No Content');
      expect((result as any)['x-status-code']).toBe(204);
    });

    it('should return null for response with content but no schema', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'application/json': {}, // No schema property
          },
        },
      });

      expect(result).toBeUndefined();
    });

    it('should add description from response if schema has none', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Response description',
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
      });

      expect(result?.description).toBe('Response description');
    });

    it('should preserve schema description over response description', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Response description',
          content: {
            'application/json': {
              schema: { type: 'object', description: 'Schema description' },
            },
          },
        },
      });

      expect(result?.description).toBe('Schema description');
    });

    it('should add x-content-type metadata', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'application/json': {
              schema: { type: 'object' },
            },
          },
        },
      });

      expect((result as any)['x-content-type']).toBe('application/json');
    });
  });

  describe('selectContentType()', () => {
    it('should prefer application/json', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'text/plain': { schema: { type: 'string' } },
            'application/json': { schema: { type: 'object' } },
            'application/xml': { schema: { type: 'object' } },
          },
        },
      });

      expect((result as any)['x-content-type']).toBe('application/json');
    });

    it('should prefer application/hal+json over xml', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'application/xml': { schema: { type: 'object' } },
            'application/hal+json': { schema: { type: 'object' } },
          },
        },
      });

      expect((result as any)['x-content-type']).toBe('application/hal+json');
    });

    it('should prefer application/problem+json', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'text/plain': { schema: { type: 'string' } },
            'application/problem+json': { schema: { type: 'object' } },
          },
        },
      });

      expect((result as any)['x-content-type']).toBe('application/problem+json');
    });

    it('should prefer application/xml over text/plain', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'text/plain': { schema: { type: 'string' } },
            'application/xml': { schema: { type: 'object' } },
          },
        },
      });

      expect((result as any)['x-content-type']).toBe('application/xml');
    });

    it('should prefer text/plain over text/html', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'text/html': { schema: { type: 'string' } },
            'text/plain': { schema: { type: 'string' } },
          },
        },
      });

      expect((result as any)['x-content-type']).toBe('text/plain');
    });

    it('should use text/html as last preference', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'text/html': { schema: { type: 'string' } },
            'application/octet-stream': { schema: { type: 'string' } },
          },
        },
      });

      expect((result as any)['x-content-type']).toBe('text/html');
    });

    it('should fallback to first available content type', () => {
      const builder = new ResponseBuilder();
      const result = builder.build({
        '200': {
          description: 'Success',
          content: {
            'application/octet-stream': { schema: { type: 'string' } },
          },
        },
      });

      expect((result as any)['x-content-type']).toBe('application/octet-stream');
    });
  });

  describe('selectPreferredSchema()', () => {
    it('should select exact match from preferred status codes', () => {
      const builder = new ResponseBuilder({
        includeAllResponses: false,
        preferredStatusCodes: [201, 200],
      });
      const result = builder.build({
        '200': {
          description: 'OK',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        '201': {
          description: 'Created',
          content: { 'application/json': { schema: { type: 'string' } } },
        },
      });

      expect((result as any)['x-status-code']).toBe(201);
    });

    it('should fallback to any 2xx response', () => {
      const builder = new ResponseBuilder({
        includeAllResponses: false,
        preferredStatusCodes: [201], // Not in responses
      });
      const result = builder.build({
        '202': {
          description: 'Accepted',
          content: { 'application/json': { schema: { type: 'string' } } },
        },
        '400': {
          description: 'Bad Request',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      });

      expect((result as any)['x-status-code']).toBe(202);
    });

    it('should fallback to any 3xx response if no 2xx', () => {
      const builder = new ResponseBuilder({
        includeAllResponses: false,
        preferredStatusCodes: [200], // Not in responses
      });
      const result = builder.build({
        '301': {
          description: 'Moved Permanently',
          content: { 'application/json': { schema: { type: 'string' } } },
        },
        '400': {
          description: 'Bad Request',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      });

      expect((result as any)['x-status-code']).toBe(301);
    });

    it('should fallback to first response if no 2xx or 3xx', () => {
      const builder = new ResponseBuilder({
        includeAllResponses: false,
        preferredStatusCodes: [200], // Not in responses
      });
      const result = builder.build({
        '400': {
          description: 'Bad Request',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        '500': {
          description: 'Server Error',
          content: { 'application/json': { schema: { type: 'string' } } },
        },
      });

      // Should get the first one (order might vary, but should be one of them)
      expect([400, 500]).toContain((result as any)['x-status-code']);
    });
  });

  describe('includeExamples', () => {
    const responseWith = (mediaExtras: Record<string, unknown>) => ({
      '200': {
        description: 'Success',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { id: { type: 'string' } } },
            ...mediaExtras,
          },
        },
      },
    });

    it('should ignore media-type examples by default', () => {
      const builder = new ResponseBuilder();
      const result = builder.build(responseWith({ example: { id: '1' } }));

      expect((result as any).examples).toBeUndefined();
    });

    it('should include a singular media-type example when enabled', () => {
      const builder = new ResponseBuilder({ includeExamples: true });
      const result = builder.build(responseWith({ example: { id: '1' } }));

      expect((result as any).examples).toEqual([{ id: '1' }]);
    });

    it('should include named media-type examples when enabled', () => {
      const builder = new ResponseBuilder({ includeExamples: true });
      const result = builder.build(
        responseWith({
          examples: {
            first: { value: { id: '1' } },
            second: { value: { id: '2' } },
            ref: { $ref: '#/components/examples/Skipped' },
            noValue: { summary: 'no value key' },
          },
        }),
      );

      expect((result as any).examples).toEqual([{ id: '1' }, { id: '2' }]);
    });

    it('should override schema-level examples with media-type examples', () => {
      const builder = new ResponseBuilder({ includeExamples: true });
      const result = builder.build(
        responseWith({
          schema: { type: 'string', example: 'from-schema' },
          example: 'from-media-type',
        }),
      );

      expect((result as any).examples).toEqual(['from-media-type']);
    });

    it('should keep schema-derived examples when the media type has none', () => {
      const builder = new ResponseBuilder({ includeExamples: true });
      const result = builder.build(responseWith({ schema: { type: 'string', example: 'from-schema' } }));

      expect((result as any).examples).toEqual(['from-schema']);
    });
  });
});

describe('ResponseBuilder schemaConversion limits', () => {
  const responses: any = {
    200: {
      description: 'ok',
      content: {
        'application/json': {
          schema: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } },
        },
      },
    },
  };

  it('converts without limits by default', () => {
    const schema: any = new ResponseBuilder().build(responses);
    expect(schema.properties.a.properties.b).toEqual({ type: 'string' });
  });

  it('converts only the response it emits when includeAllResponses is false', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) wide[`f${i}`] = { type: 'string' };
    const withError: any = {
      ...responses,
      400: { description: 'bad', content: { 'application/json': { schema: { type: 'object', properties: wide } } } },
    };

    // Converting the 200 schema charges 8 nodes, the 400 one 23
    const preferred: any = new ResponseBuilder({ includeAllResponses: false }, { maxNodes: 10 }).build(withError);
    expect(preferred['x-status-code']).toBe(200);
    expect(() => new ResponseBuilder({ includeAllResponses: true }, { maxNodes: 10 }).build(withError)).toThrow(
      /maxSchemaNodes/,
    );
  });

  it('applies maxDepth and maxNodes when given', () => {
    const schema: any = new ResponseBuilder({}, { maxDepth: 1 }).build(responses);
    expect(schema.properties.a.properties.b).toEqual({});

    expect(() => new ResponseBuilder({}, { maxNodes: 2 }).build(responses)).toThrow(/maxSchemaNodes/);
  });
});

describe('ResponseBuilder: OpenAPI 3.2 responses (issue #55)', () => {
  const event = {
    type: 'object',
    required: ['data'],
    properties: { data: { type: 'string' }, event: { type: 'string' }, retry: { type: 'integer', minimum: 0 } },
  };
  const sse = (extra: Record<string, unknown> = {}) => ({
    description: 'Events',
    content: { 'text/event-stream': { itemSchema: event, ...extra } },
  });
  const json = (description: string) => ({
    description,
    content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } } },
  });

  describe('summary as the description fallback', () => {
    it('describes a response by its summary when it has no description', () => {
      const builder = new ResponseBuilder();
      expect(builder.build({ 204: { summary: 'Deleted' } } as any)).toEqual({
        type: 'null',
        description: 'Deleted',
        'x-status-code': 204,
      });
      expect(
        builder.build({ 200: { summary: 'A pet', content: { 'application/json': { schema: { type: 'object' } } } } } as any),
      ).toMatchObject({ type: 'object', description: 'A pet', 'x-status-code': 200 });
    });

    it('keeps description first, as written, and ignores a summary that is not a string', () => {
      const builder = new ResponseBuilder();
      expect(builder.build({ 204: { description: 'Gone', summary: 'Deleted' } } as any)).toMatchObject({
        description: 'Gone',
      });
      // an empty description is still the description, as before
      expect(builder.build({ 204: { description: '', summary: 'Deleted' } } as any)).toMatchObject({ description: '' });
      expect(builder.build({ 204: { description: null, summary: 'Deleted' } } as any)).toMatchObject({
        description: null,
      });
      const noText: any = builder.build({ 204: { summary: { text: 'x' } } } as any);
      expect(noText.description).toBeUndefined();
      expect('description' in noText).toBe(true);
    });
  });

  describe('buildStream', () => {
    it('returns undefined without responses, or when no chosen media type declares itemSchema', () => {
      const builder = new ResponseBuilder();
      expect(builder.buildStream(undefined)).toBeUndefined();
      expect(builder.buildStream('x' as any)).toBeUndefined();
      expect(builder.buildStream({ 200: json('ok') } as any)).toBeUndefined();
      expect(
        builder.buildStream({
          200: { description: 'no content' },
          201: null,
          202: { $ref: '#/components/responses/Stream' },
          203: { description: 'x', content: [] },
          204: { description: 'x', content: {} },
          205: { description: 'x', content: { 'text/event-stream': 'junk' } },
          206: { description: 'x', content: { 'text/event-stream': { itemSchema: 'a string' } } },
          207: { description: 'x', content: { 'text/event-stream': { itemSchema: null } } },
          208: { description: 'x', content: { 'text/event-stream': { itemSchema: [event] } } },
          nope: sse(),
        } as any),
      ).toBeUndefined();
    });

    it('converts the item schema of the chosen media type, and never adds it to build()', () => {
      const builder = new ResponseBuilder();
      const responses = { 200: sse() } as any;
      expect(builder.build(responses)).toBeUndefined();
      expect(builder.buildStream(responses)).toEqual({
        statusCode: 200,
        contentType: 'text/event-stream',
        itemSchema: event,
      });
    });

    it('reads a media type with both schema and itemSchema both ways', () => {
      const builder = new ResponseBuilder();
      const responses = {
        200: {
          description: 'Lines',
          content: { 'application/jsonl': { schema: { type: 'array', items: { type: 'integer' } }, itemSchema: { type: 'integer' } } },
        },
      } as any;
      expect(builder.build(responses)).toMatchObject({ type: 'array', 'x-content-type': 'application/jsonl' });
      expect(builder.buildStream(responses)).toEqual({
        statusCode: 200,
        contentType: 'application/jsonl',
        itemSchema: { type: 'integer' },
      });
    });

    it('chooses the stream media type apart from the output schema one: JSON next to SSE gives both', () => {
      const responses = {
        200: { description: 'x', content: { 'application/json': { schema: { type: 'object' } }, 'text/event-stream': { itemSchema: event } } },
      } as any;
      const builder = new ResponseBuilder();
      expect(builder.build(responses)).toMatchObject({ type: 'object', 'x-content-type': 'application/json' });
      expect(builder.buildStream(responses)).toEqual({ statusCode: 200, contentType: 'text/event-stream', itemSchema: event });
    });

    it('takes the first media type with itemSchema in document order, whatever the media type', () => {
      const stream = (content: Record<string, unknown>) =>
        new ResponseBuilder().buildStream({ 200: { description: 'x', content } } as any)?.contentType;
      const item = { itemSchema: { type: 'string' } };
      // no preference for any media type: the first listed wins
      expect(stream({ 'text/event-stream': item, 'application/jsonl': item })).toBe('text/event-stream');
      expect(stream({ 'application/jsonl': item, 'text/event-stream': item, 'application/json': {} })).toBe('application/jsonl');
      expect(stream({ 'multipart/mixed': item, 'application/x-ndjson': item, 'application/jsonl': item })).toBe('multipart/mixed');
      expect(stream({ 'application/geo+json-seq': item, 'application/json-seq': item })).toBe('application/geo+json-seq');
      // the key is reported as written, with its parameters and case
      expect(stream({ 'Text/Event-Stream; charset=utf-8': item, 'application/jsonl': item })).toBe(
        'Text/Event-Stream; charset=utf-8',
      );
      // two vendor media types: the first
      expect(stream({ 'application/vnd.acme.events+json': item, 'application/vnd.acme.rows+json': item })).toBe(
        'application/vnd.acme.events+json',
      );
      // an unknown media type before a well-known sequential one still wins
      expect(stream({ 'application/x-custom-stream': item, 'multipart/mixed': item })).toBe('application/x-custom-stream');
    });

    it('skips media types without itemSchema, wherever they are listed', () => {
      const stream = (content: Record<string, unknown>) =>
        new ResponseBuilder().buildStream({ 200: { description: 'x', content } } as any)?.contentType;
      const item = { itemSchema: { type: 'string' } };
      expect(stream({ 'application/json': {}, 'application/x-a': item, 'application/x-b': item })).toBe('application/x-a');
      expect(stream({ 'text/event-stream': { schema: { type: 'string' } }, 'application/jsonl': item })).toBe('application/jsonl');
      expect(stream({ 'application/json': { schema: { type: 'object' } }, 'text/event-stream': item })).toBe('text/event-stream');
    });

    it('prefers a stream like includeAllResponses: false prefers a schema, and default only as a fallback', () => {
      const responses = {
        201: { description: 'x', content: { 'application/x-ndjson': { itemSchema: { type: 'string' } } } },
        200: sse(),
        400: { description: 'x', content: { 'text/event-stream': { itemSchema: { type: 'number' } } } },
        default: { description: 'x', content: { 'application/json-seq': { itemSchema: { type: 'boolean' } } } },
      } as any;
      expect(new ResponseBuilder().buildStream(responses)).toMatchObject({ statusCode: 200 });
      expect(new ResponseBuilder({ preferredStatusCodes: [201] }).buildStream(responses)).toMatchObject({
        statusCode: 201,
        contentType: 'application/x-ndjson',
      });
      expect(new ResponseBuilder().buildStream({ 400: responses[400], default: responses.default })).toMatchObject({
        statusCode: 400,
      });
      expect(new ResponseBuilder().buildStream({ default: responses.default, 204: { description: 'x' } })).toEqual({
        statusCode: 0,
        contentType: 'application/json-seq',
        itemSchema: { type: 'boolean' },
      });
      expect(new ResponseBuilder().buildStream({ default: null } as any)).toBeUndefined();
    });

    it('accepts a boolean item schema and applies the conversion limits', () => {
      const boolean = { 200: { description: 'x', content: { 'multipart/mixed': { itemSchema: true } } } } as any;
      expect(new ResponseBuilder().buildStream(boolean)?.itemSchema).toEqual({});
      // `false`: no item is valid
      const never = { 200: { description: 'x', content: { 'multipart/mixed': { itemSchema: false } } } } as any;
      expect(new ResponseBuilder().buildStream(never)?.itemSchema).toEqual({ not: {} });

      const deep = { 200: sse({ itemSchema: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } } }) } as any;
      expect((new ResponseBuilder({}, { maxDepth: 1 }).buildStream(deep)?.itemSchema as any).properties.a.properties.b).toEqual({});
      expect(() => new ResponseBuilder({}, { maxNodes: 2 }).buildStream(deep)).toThrow(/maxSchemaNodes/);
    });
  });
});

describe('ResponseBuilder: boolean response schemas', () => {
  const json = (schema: unknown, description = 'x') => ({ description, content: { 'application/json': { schema } } });

  it('builds { not: {} } for a response whose schema is false, and {} for true', () => {
    expect(new ResponseBuilder().build({ 200: json(false, 'never') } as any)).toEqual({
      not: {},
      'x-status-code': 200,
      description: 'never',
      'x-content-type': 'application/json',
    });
    expect(new ResponseBuilder().build({ 200: json(true, 'any') } as any)).toEqual({
      'x-status-code': 200,
      description: 'any',
      'x-content-type': 'application/json',
    });
  });

  it('keeps a false response among the candidates, so it is preferred like any other', () => {
    const responses = { 200: json(false), 404: json({ type: 'object' }) } as any;
    expect(new ResponseBuilder({ includeAllResponses: false }).build(responses)).toMatchObject({
      not: {},
      'x-status-code': 200,
    });
    const union = new ResponseBuilder().build(responses) as any;
    expect(union.oneOf.map((variant: any) => variant['x-status-code'])).toEqual([200, 404]);
    expect(union.oneOf[0].not).toEqual({});
  });
});

describe('ResponseBuilder: response status ranges', () => {
  const json = (type: string) => ({ description: type, content: { 'application/json': { schema: { type } } } });
  const status = (builder: ResponseBuilder, responses: Record<string, unknown>) =>
    (builder.build(responses as any) as any)?.['x-status-code'];
  const preferred = (responses: Record<string, unknown>, preferredStatusCodes?: number[]) =>
    status(new ResponseBuilder({ includeAllResponses: false, preferredStatusCodes }), responses);

  it('keeps a range key as an upper-cased string, in any case it is written', () => {
    for (const key of ['2XX', '2xx', '2xX', '2Xx']) expect(status(new ResponseBuilder(), { [key]: json('string') })).toBe('2XX');
    for (const digit of ['1', '3', '4', '5']) {
      expect(status(new ResponseBuilder(), { [`${digit}XX`]: json('string') })).toBe(`${digit}XX`);
    }
    const union = new ResponseBuilder().build({ 200: json('object'), '4XX': json('string'), default: json('number') } as any) as any;
    expect(union.oneOf.map((variant: any) => variant['x-status-code'])).toEqual([200, '4XX']);
  });

  it('reads any other key as it always has', () => {
    // Not range keys: parseInt reads what it can, and a key without a number is skipped
    expect(status(new ResponseBuilder(), { '6XX': json('string') })).toBe(6);
    expect(status(new ResponseBuilder(), { '0XX': json('string') })).toBe(0);
    expect(status(new ResponseBuilder(), { '20X': json('string') })).toBe(20);
    expect(status(new ResponseBuilder(), { '2XXX': json('string') })).toBe(2);
    expect(new ResponseBuilder().build({ XX: json('string') } as any)).toBeUndefined();
  });

  it('prefers an explicit code over the range of its class', () => {
    expect(preferred({ '2XX': json('string'), 200: json('object') })).toBe(200);
    // A preferred explicit code wins even over a range covering an earlier preference
    expect(preferred({ '2XX': json('string'), 201: json('object') })).toBe(201);
    // Without preferences, an explicit 2xx before the 2XX range, an explicit 3xx before 3XX
    expect(preferred({ '2XX': json('string'), 299: json('object') }, [])).toBe(299);
    expect(preferred({ '3XX': json('string'), 302: json('object'), '4XX': json('number') }, [])).toBe(302);
  });

  it('lets a range stand for a preferred code when no explicit code matches', () => {
    // A success range is preferred over an explicit error
    expect(preferred({ 500: json('object'), '2XX': json('string') })).toBe('2XX');
    expect(preferred({ 302: json('object'), '2XX': json('string') })).toBe('2XX');
    // The range covering the earliest preference
    expect(preferred({ '3XX': json('string'), '2XX': json('object') }, [301, 200])).toBe('3XX');
    // A range with no preference is still a success, then a redirect
    expect(preferred({ 404: json('object'), '3XX': json('string') }, [])).toBe('3XX');
    expect(preferred({ '5XX': json('object'), '2XX': json('string') }, [])).toBe('2XX');
    // Neither: the first
    expect(preferred({ '5XX': json('object'), '4XX': json('string') })).toBe('5XX');
    // A preference that is not a whole status code covers no range
    expect(preferred({ '4XX': json('object'), '2XX': json('string') }, [200.5, 404])).toBe('4XX');
  });

  // The order, one rule per row: a preferred explicit code; any explicit 2xx;
  // a range covering a preferred code, else 2XX; an explicit 3xx, else 3XX; the first
  it.each<[string, Record<string, unknown>, number[] | undefined, number | string]>([
    ['an explicit code wins over a range of its class that covers a preference', { 299: 0, '2XX': 0 }, undefined, 299],
    ['the same, whatever the key order', { '2XX': 0, 299: 0 }, undefined, 299],
    ['a preferred explicit code before any other explicit 2xx', { 299: 0, 201: 0, '2XX': 0 }, undefined, 201],
    ['an explicit 2xx before a range covering a preferred error', { '4XX': 0, 250: 0 }, [404], 250],
    ['the first explicit 2xx in key order (integer keys ascending)', { 299: 0, 250: 0, '2XX': 0 }, undefined, 250],
    ['a range covering a preference when no explicit 2xx exists', { 302: 0, '2XX': 0 }, undefined, '2XX'],
    ['a range covering the earliest preference', { '4XX': 0, '2XX': 0, 500: 0 }, [404, 200], '4XX'],
    ['the 2XX range when no range covers a preference', { 302: 0, '2XX': 0 }, [404], '2XX'],
    ['the 2XX range before an explicit redirect', { 301: 0, '2XX': 0 }, [], '2XX'],
    ['an explicit redirect before the 3XX range', { '3XX': 0, 304: 0 }, [], 304],
    ['the 3XX range when nothing else matches', { 500: 0, '3XX': 0 }, [], '3XX'],
    ['the first candidate otherwise', { 503: 0, '4XX': 0 }, [], 503],
  ])('selects %s', (_label, keys, preferredStatusCodes, expected) => {
    const responses = Object.fromEntries(Object.keys(keys).map((key) => [key, json('object')]));
    expect(preferred(responses, preferredStatusCodes)).toBe(expected);
    // The streamed response is chosen by the same rules
    const sse = { description: 's', content: { 'text/event-stream': { itemSchema: { type: 'string' } } } };
    const streams = Object.fromEntries(Object.keys(keys).map((key) => [key, sse]));
    expect(new ResponseBuilder({ preferredStatusCodes }).buildStream(streams as any)?.statusCode).toBe(expected);
  });

  it('selects and reports a streamed range response the same way', () => {
    const sse = (type: string) => ({ description: type, content: { 'text/event-stream': { itemSchema: { type } } } });
    expect(new ResponseBuilder().buildStream({ 500: sse('number'), '2xx': sse('string') } as any)).toEqual({
      statusCode: '2XX',
      contentType: 'text/event-stream',
      itemSchema: { type: 'string' },
    });
    expect(new ResponseBuilder().buildStream({ '2XX': sse('number'), 200: sse('string') } as any)?.statusCode).toBe(200);
  });
});
