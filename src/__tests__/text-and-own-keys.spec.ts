import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseRuntimeExpression } from '../arazzo-expressions';
import { applyClientTarget } from '../client-targets';
import { ArazzoError, LoadError, ParseError, RequestBuildError } from '../errors';
import { BUILTIN_FORMAT_RESOLVERS, resolveSchemaFormats } from '../format-resolver';
import { OpenAPIToolGenerator } from '../generator';
import { buildHttpRequest } from '../request-builder';
import { SchemaBuilder } from '../schema-builder';
import { toJsonSchema, type McpOpenAPITool } from '../types';
import { createLoopbackServer, type LoopbackHandler } from './helpers/loopback';

const ok = { 200: { description: 'ok' } };
const info = { title: 't', version: '1' };
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/;

function protoProperties(): Record<string, unknown> {
  return JSON.parse('{"__proto__": {"type": "string", "description": "INHERITED-BY-MAP"}, "a": {"type": "string"}}');
}

describe('buildHttpRequest fails only with RequestBuildError', () => {
  const tool = (mapper: unknown[], contentType = 'application/json') =>
    ({
      name: 't',
      inputSchema: { type: 'object', properties: {} },
      mapper,
      metadata: {
        path: '/p',
        method: 'post',
        servers: [{ url: 'https://api.example.test' }],
        requestBodyContentType: contentType,
      },
    }) as unknown as McpOpenAPITool;

  it('refuses a security value that is not a primitive', () => {
    const secured = tool([
      {
        inputKey: 'bearer',
        type: 'header',
        key: 'Authorization',
        security: { scheme: 'bearer', type: 'http', httpScheme: 'bearer' },
      },
    ]);
    expect(() => buildHttpRequest(secured, { bearer: { toString: 1 } })).toThrow(RequestBuildError);
  });

  it.each(['application/json', 'text/plain'])('refuses a %s body nested deeper than it can write', (contentType) => {
    let deep: unknown = [];
    for (let level = 0; level < 200_000; level++) deep = [deep];
    const body = tool(
      [{ inputKey: 'body', type: 'body', key: 'body', wholeBody: true, serialization: { contentType } }],
      contentType,
    );
    expect(() => buildHttpRequest(body, { body: deep })).toThrow(RequestBuildError);
  });

  it('refuses a body media type that is not a header value', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info,
        servers: [{ url: 'https://api.example.test' }],
        paths: {
          '/p': {
            post: {
              operationId: 'p',
              requestBody: { content: { 'text/plain\r\nX-Injected: yes': { schema: { type: 'string' } } } },
              responses: ok,
            },
          },
        },
      },
      { validate: false },
    );
    const [built] = await generator.generateTools();
    expect(() => buildHttpRequest(built, { body: 'x' })).toThrow(RequestBuildError);
  });

  it('reads an Encoding Object by own key only', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.0.3',
      info,
      servers: [{ url: 'https://api.example.test' }],
      paths: {
        '/p': {
          post: {
            operationId: 'p',
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    properties: {
                      constructor: { type: 'string' },
                      toString: { type: 'string' },
                      tags: { type: 'array', items: { type: 'string' } },
                    },
                  },
                  encoding: { tags: { explode: false } },
                },
              },
            },
            responses: ok,
          },
        },
      },
    });
    const [built] = await generator.generateTools();
    const request = buildHttpRequest(built, { constructor: 'a', toString: 'b', tags: ['x', 'y'] });
    expect(request.body).toBe('constructor=a&toString=b&tags=x%2Cy');
  });
});

describe('a document key is never read or written through the prototype', () => {
  const ownMap = (map: unknown) => {
    expect(Object.getPrototypeOf(map)).toBe(Object.prototype);
    expect(Object.hasOwn(map as object, '__proto__')).toBe(true);
  };

  it('toJsonSchema keeps a __proto__ key of properties, $defs and patternProperties', () => {
    const converted = toJsonSchema({
      type: 'object',
      properties: protoProperties(),
      $defs: protoProperties(),
      patternProperties: protoProperties(),
    } as never) as Record<string, unknown>;
    for (const key of ['properties', '$defs', 'patternProperties']) ownMap(converted[key]);
  });

  it.each([
    ['truncateDepth', (schema: never) => SchemaBuilder.truncateDepth(schema, 5)],
    ['capDescriptions', (schema: never) => SchemaBuilder.capDescriptions(schema, 3)],
    ['stripExamples', (schema: never) => SchemaBuilder.stripExamples(schema)],
    ['limitProperties', (schema: never) => SchemaBuilder.limitProperties(schema, 5)],
    ['resolveSchemaFormats', (schema: never) => resolveSchemaFormats(schema, BUILTIN_FORMAT_RESOLVERS)],
    ['applyClientTarget', (schema: never) => applyClientTarget(schema, 'openai')],
  ])('%s keeps a __proto__ property', (_label, transform) => {
    const result = transform({ type: 'object', properties: protoProperties() } as never) as Record<string, unknown>;
    ownMap(result['properties']);
  });

  it('gives a parameter and a body property named __proto__ an input schema', async () => {
    const body = JSON.parse('{"type": "object", "properties": {"__proto__": {"type": "integer"}}}');
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info,
        paths: {
          '/p': {
            post: {
              operationId: 'p',
              parameters: [{ name: '__proto__', in: 'query', required: true, schema: { type: 'string' } }],
              requestBody: { content: { 'application/json': { schema: body } } },
              responses: ok,
            },
          },
        },
      },
      { validate: false },
    );
    const [tool] = await generator.generateTools();
    // One name in two locations: both renamed, each with its schema
    expect(Object.getPrototypeOf(tool.inputSchema.properties)).toBe(Object.prototype);
    expect(tool.inputSchema.properties).toEqual({
      query__proto__: expect.objectContaining({ type: 'string' }),
      body__proto__: expect.objectContaining({ type: 'integer' }),
    });
  });

  it.each(['toString', 'valueOf', '__proto__', 'constructor', 'hasOwnProperty'])(
    'leaves a schema with format %s as it is',
    async (format) => {
      const schema = { type: 'string', format, maxLength: 3 };
      expect(resolveSchemaFormats(schema as never, BUILTIN_FORMAT_RESOLVERS)).toEqual(schema);
      const generator = await OpenAPIToolGenerator.fromJSON({
        openapi: '3.0.3',
        info,
        paths: { '/p': { get: { operationId: 'p', parameters: [{ name: 'q', in: 'query', schema }], responses: ok } } },
      });
      const [tool] = await generator.generateTools({ resolveFormats: true });
      expect(tool.inputSchema.properties?.['q']).toMatchObject({ type: 'string', maxLength: 3 });
    },
  );

  it.each(['toString', '__proto__', 'constructor.a', 'hasOwnProperty.b'])(
    'refuses the runtime expression %p',
    (expression) => {
      expect(() => parseRuntimeExpression(expression)).toThrow(ArazzoError);
    },
  );
});

describe('document text is escaped in lint findings and loader errors', () => {
  const hostile = 'a\u001b[2K‮b\u0000\nc';

  it('escapes operation ids, path keys and parameter names in lint findings', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info,
        paths: {
          [`/x${hostile}`]: {
            get: { operationId: hostile, parameters: [{ name: hostile, in: 'query', schema: {} }], responses: ok },
          },
          '/y': { get: { operationId: hostile, responses: ok } },
        },
      },
      { validate: false },
    );
    const { findings } = await generator.lint();
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.message).not.toMatch(UNSAFE_TEXT);
      expect(finding.path).not.toMatch(UNSAFE_TEXT);
    }
  });

  it.each([
    ['fromJSON', () => OpenAPIToolGenerator.fromJSON(`{"openapi": ${hostile}` as never)],
    ['fromYAML', () => OpenAPIToolGenerator.fromYAML(`openapi: 3.0.3\ninfo: {title: "${hostile}", version: [1\n`)],
  ])('%s', async (_label, load) => {
    const failure = (await load().catch((error: unknown) => error)) as Error;
    expect(failure).toBeInstanceOf(ParseError);
    expect(failure.message).not.toMatch(UNSAFE_TEXT);
  });

  it('fromFile', async () => {
    const file = path.join(os.tmpdir(), `hostile-${process.pid}.json`);
    fs.writeFileSync(file, `{"openapi": ${hostile}`);
    try {
      const failure = (await OpenAPIToolGenerator.fromFile(file).catch((error: unknown) => error)) as Error;
      expect(failure).toBeInstanceOf(LoadError);
      expect(failure.message).not.toMatch(UNSAFE_TEXT);
      expect(JSON.stringify((failure as LoadError).context)).not.toMatch(/\\u001b/);
    } finally {
      fs.unlinkSync(file);
    }
  });

  describe('fromURL', () => {
    let handler: LoopbackHandler;
    const loopback = createLoopbackServer(() => handler);
    let baseUrl: string;

    beforeAll(async () => {
      baseUrl = await loopback.listen();
    });

    afterAll(async () => {
      await loopback.close();
    });

    it('escapes the body a parser quotes', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"openapi": ${hostile}`);
      };
      const failure = (await OpenAPIToolGenerator.fromURL(`${baseUrl}/spec.json`, {
        refResolution: { allowInternalIPs: true },
      }).catch((error: unknown) => error)) as Error;
      expect(failure).toBeInstanceOf(LoadError);
      expect(failure.message).not.toMatch(UNSAFE_TEXT);
    });
  });
});
