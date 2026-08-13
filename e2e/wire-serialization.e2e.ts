/**
 * Wire story: buildHttpRequest output fetched for real, asserted as the raw
 * bytes/headers/paths the loopback server received — the OpenAPI
 * serialization table on the wire instead of as data structures.
 */
import { OpenAPIToolGenerator, SecurityResolver, buildHttpRequest, createSecurityContext } from '../src';
import type { McpOpenAPITool } from '../src';
import { createLoopbackServer, type LoopbackHandler } from '../src/__tests__/helpers/loopback';
import { sendBuiltRequest } from './helpers/http';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Inline spec on purpose: this story needs surgical control of styles.
const wireSpec: any = {
  openapi: '3.0.0',
  info: { title: 'Wire API', version: '1.0.0' },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      basicAuth: { type: 'http', scheme: 'basic' },
      headerKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      queryKey: { type: 'apiKey', name: 'api_key', in: 'query' },
    },
  },
  paths: {
    '/search': {
      get: {
        operationId: 'search',
        parameters: [
          { name: 'filter', in: 'query', style: 'deepObject', explode: true, schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } } },
          { name: 'ids', in: 'query', style: 'pipeDelimited', explode: false, schema: { type: 'array', items: { type: 'integer' } } },
          { name: 'names', in: 'query', style: 'spaceDelimited', explode: false, schema: { type: 'array', items: { type: 'string' } } },
          { name: 'tag', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
          { name: 'path', in: 'query', allowReserved: true, schema: { type: 'string' } },
          { name: 'quoted', in: 'query', schema: { type: 'string' } },
          { name: 'session', in: 'cookie', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/files/{fileId}': {
      post: {
        operationId: 'uploadFile',
        parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  file: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/forms': {
      post: {
        operationId: 'submitForm',
        requestBody: {
          content: {
            'application/x-www-form-urlencoded': {
              schema: { type: 'object', properties: { name: { type: 'string' }, tags: { type: 'string' } } },
            },
          },
        },
        responses: { '200': { description: 'OK' } },
      },
    },
    '/secure': {
      get: {
        operationId: 'secure',
        security: [{ bearerAuth: [] }, { basicAuth: [] }, { headerKey: [] }, { queryKey: [] }],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};

describe('story: serialization on the wire', () => {
  let byName: Map<string, McpOpenAPITool>;
  let baseUrl: string;
  const handler: LoopbackHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  };
  const loopback = createLoopbackServer(() => handler);

  beforeAll(async () => {
    baseUrl = await loopback.listen();
    const generator = await OpenAPIToolGenerator.fromJSON(wireSpec);
    byName = new Map((await generator.generateTools()).map((tool) => [tool.name, tool]));
  });

  afterAll(() => loopback.close());
  beforeEach(() => loopback.reset());

  const send = async (name: string, input: Record<string, unknown>) => {
    await sendBuiltRequest(buildHttpRequest(byName.get(name)!, input, { baseUrl }));
    return loopback.requests.at(-1)!;
  };

  it('serializes query styles per the OpenAPI table', async () => {
    const captured = await send('search', {
      filter: { a: '1', b: '2' },
      ids: [1, 2, 3],
      names: ['x', 'y'],
      tag: ['red', 'blue'],
    });

    const params = new URL(`http://x${captured.url}`).searchParams;
    expect(params.get('filter[a]')).toBe('1');
    expect(params.get('filter[b]')).toBe('2');
    expect(params.get('ids')).toBe('1|2|3');
    expect(params.get('names')).toBe('x y');
    expect(params.getAll('tag')).toEqual(['red', 'blue']); // form + explode default

    // raw wire form of the delimiters
    expect(captured.url).toContain('ids=1%7C2%7C3');
    expect(captured.url).toContain('names=x%20y');
  });

  it('honors allowReserved on the raw query string', async () => {
    const captured = await send('search', { path: '/a/b:c$d', quoted: '/a/b:c$d' });
    expect(captured.url).toContain('path=/a/b:c$d'); // reserved chars kept
    expect(captured.url).toContain('quoted=%2Fa%2Fb%3Ac%24d'); // percent-encoded otherwise
  });

  it('sends cookie parameters in the Cookie header', async () => {
    const captured = await send('search', { session: 'abc123' });
    expect(captured.headers.cookie).toBe('session=abc123');
  });

  it('encodes path parameters exactly once', async () => {
    const captured = await send('uploadFile', { fileId: 'a b/c', file: new Uint8Array([1]) });
    expect(captured.url.split('?')[0]).toBe('/files/a%20b%2Fc');
  });

  it('uploads multipart bodies with exact binary bytes and an undici boundary', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const captured = await send('uploadFile', { fileId: 'f1', label: 'a png', file: bytes });

    expect(captured.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const body = captured.body;
    expect(body.includes('Content-Disposition: form-data; name="label"')).toBe(true);
    expect(body.includes('Content-Disposition: form-data; name="file"')).toBe(true);
    expect(body.includes(Buffer.from(bytes))).toBe(true); // binary payload survives verbatim
  });

  it('serializes form-urlencoded bodies', async () => {
    const captured = await send('submitForm', { name: 'Ada Lovelace', tags: 'a&b=c' });
    expect(captured.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const params = new URLSearchParams(captured.body.toString());
    expect(params.get('name')).toBe('Ada Lovelace');
    expect(params.get('tags')).toBe('a&b=c');
  });

  it('lands resolved security credentials on the wire', async () => {
    const tool = byName.get('secure')!;
    const resolver = new SecurityResolver();

    const bearer = await resolver.resolve(tool.mapper, createSecurityContext({ jwt: 'tok-123' }));
    await sendBuiltRequest(buildHttpRequest(tool, {}, { baseUrl }), bearer);
    expect(loopback.requests.at(-1)!.headers.authorization).toBe('Bearer tok-123');

    const basic = await resolver.resolve(
      tool.mapper,
      createSecurityContext({ basic: { username: 'ada', password: 's3cret' } }),
    );
    await sendBuiltRequest(buildHttpRequest(tool, {}, { baseUrl }), basic);
    expect(loopback.requests.at(-1)!.headers.authorization).toBe(
      `Basic ${Buffer.from('ada:s3cret').toString('base64')}`,
    );

    const keys = await resolver.resolve(
      tool.mapper,
      createSecurityContext({ apiKeys: { headerKey: 'hk-1', queryKey: 'qk-2' } }),
    );
    await sendBuiltRequest(buildHttpRequest(tool, {}, { baseUrl }), keys);
    const captured = loopback.requests.at(-1)!;
    expect(captured.headers['x-api-key']).toBe('hk-1');
    expect(new URL(`http://x${captured.url}`).searchParams.get('api_key')).toBe('qk-2');
  });
});
