/**
 * Wire story: buildHttpRequest output fetched for real, asserted as the raw
 * bytes/headers/paths the loopback server received — the OpenAPI
 * serialization table on the wire instead of as data structures.
 */
import { createServer, type AddressInfo, type Server } from 'net';
import { OpenAPIToolGenerator, RequestBuildError, SecurityResolver, buildHttpRequest, createSecurityContext } from '../src';
import type { McpOpenAPITool, ParameterMapper } from '../src';
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

    // SecurityContext.basic is the PRE-ENCODED base64 "username:password"
    const basic = await resolver.resolve(
      tool.mapper,
      createSecurityContext({ basic: Buffer.from('ada:s3cret').toString('base64') }),
    );
    await sendBuiltRequest(buildHttpRequest(tool, {}, { baseUrl }), basic);
    expect(loopback.requests.at(-1)!.headers.authorization).toBe(
      `Basic ${Buffer.from('ada:s3cret').toString('base64')}`,
    );

    // apiKeys is keyed by the WIRE parameter name (apiKeyName), not the scheme
    const keys = await resolver.resolve(
      tool.mapper,
      createSecurityContext({ apiKeys: { 'X-API-Key': 'hk-1', api_key: 'qk-2' } }),
    );
    await sendBuiltRequest(buildHttpRequest(tool, {}, { baseUrl }), keys);
    const captured = loopback.requests.at(-1)!;
    expect(captured.headers['x-api-key']).toBe('hk-1');
    expect(new URL(`http://x${captured.url}`).searchParams.get('api_key')).toBe('qk-2');
  });
});

describe('story: OpenAPI 3.2 parameter serialization on the wire', () => {
  // Expected bytes are the OpenAPI 3.2.1 specification's own examples where
  // it gives one ("Parameter Object Examples", "Style Examples"). The server
  // records the raw request target and headers, before any decoding.
  const tool = (path: string, mapper: ParameterMapper[], method = 'get'): McpOpenAPITool => ({
    name: 'hand_made',
    description: 'hand made',
    inputSchema: { type: 'object', properties: {} },
    mapper,
    metadata: { path, method },
  });
  const wholeQuery = (contentType: string): ParameterMapper => ({
    inputKey: 'q',
    type: 'query',
    key: 'q',
    wholeQuery: true,
    serialization: { contentType },
  });

  const loopback = createLoopbackServer(() => (_req, res) => {
    res.writeHead(204);
    res.end();
  });
  let baseUrl: string;
  beforeAll(async () => {
    baseUrl = await loopback.listen();
  });
  afterAll(() => loopback.close());
  beforeEach(() => loopback.reset());

  const send = async (built: ReturnType<typeof buildHttpRequest>) => {
    await sendBuiltRequest(built);
    return loopback.requests.at(-1)!;
  };

  it('sends a form-urlencoded whole query as the query string, credentials appended as pairs', async () => {
    // in: querystring, content: application/x-www-form-urlencoded
    //   dataValue: { foo: 'a + b', bar: true }   serializedValue: foo=a+%2B+b&bar=true
    const plain = await send(buildHttpRequest(tool('/foo', [wholeQuery('application/x-www-form-urlencoded')]), { q: { foo: 'a + b', bar: true } }, { baseUrl }));
    expect(plain.url).toBe('/foo?foo=a+%2B+b&bar=true');

    const withKey = await send(
      buildHttpRequest(
        tool('/foo', [
          wholeQuery('application/x-www-form-urlencoded'),
          { inputKey: 'key', type: 'query', key: 'api_key', security: { scheme: 'k', type: 'apiKey', apiKeyIn: 'query' } },
        ]),
        { q: { tags: ['x', 'y z'] }, key: 'k 1' },
        { baseUrl },
      ),
    );
    expect(withKey.url).toBe('/foo?tags=x&tags=y+z&api_key=k+1');
    expect([...new URL(`http://x${withKey.url}`).searchParams]).toEqual([
      ['tags', 'x'],
      ['tags', 'y z'],
      ['api_key', 'k 1'],
    ]);
  });

  it('sends a JSON whole query as the percent-encoded JSON text', async () => {
    // in: querystring, content: application/json, dataValue: { numbers: [1, 2], flag: null }
    //   https://example.com/foo?%7B%22numbers%22%3A%5B1%2C2%5D%2C%22flag%22%3Anull%7D
    const captured = await send(
      buildHttpRequest(tool('/foo', [wholeQuery('application/json')]), { q: { numbers: [1, 2], flag: null } }, { baseUrl }),
    );

    expect(captured.url).toBe('/foo?%7B%22numbers%22%3A%5B1%2C2%5D%2C%22flag%22%3Anull%7D');
    expect(JSON.parse(decodeURIComponent(captured.url.slice('/foo?'.length)))).toEqual({ numbers: [1, 2], flag: null });
  });

  it('sends any other whole query media type percent-encoded (the JSONPath example)', async () => {
    // in: querystring, content: application/jsonpath, example: $.a.b[1:1]
    //   https://example.com/foo?%24.a.b%5B1%3A1%5D
    const captured = await send(buildHttpRequest(tool('/foo', [wholeQuery('application/jsonpath')]), { q: '$.a.b[1:1]' }, { baseUrl }));

    expect(captured.url).toBe('/foo?%24.a.b%5B1%3A1%5D');
  });

  it('sends nothing when a query credential cannot join a whole query that has no pairs', () => {
    const json = tool('/foo', [
      wholeQuery('application/json'),
      { inputKey: 'key', type: 'query', key: 'api_key', security: { scheme: 'k', type: 'apiKey', apiKeyIn: 'query' } },
    ]);

    expect(() => buildHttpRequest(json, { q: { a: 1 }, key: 'k' }, { baseUrl })).toThrow(RequestBuildError);
    expect(loopback.requests).toHaveLength(0);
  });

  it('sends nothing when the input names a credential or a sibling cookie', () => {
    const queryKey: ParameterMapper = {
      inputKey: 'key',
      type: 'query',
      key: 'api_key',
      security: { scheme: 'k', type: 'apiKey', apiKeyIn: 'query' },
    };
    const sessionCookie: ParameterMapper = {
      inputKey: 'session',
      type: 'cookie',
      key: 'session',
      security: { scheme: 's', type: 'apiKey', apiKeyIn: 'cookie' },
    };
    const attempts: Array<[McpOpenAPITool, Record<string, unknown>]> = [
      [tool('/foo', [wholeQuery('application/x-www-form-urlencoded'), queryKey]), { q: { api_key: 'attacker' }, key: 'real' }],
      [tool('/foo', [wholeQuery('application/x-www-form-urlencoded'), queryKey]), { q: { api_key: 'attacker' } }],
      [tool('/k', [{ inputKey: 'c', type: 'cookie', key: 'c', style: 'cookie' }, sessionCookie]), { c: { session: 'attacker' } }],
      [tool('/k', [{ inputKey: 'theme', type: 'cookie', key: 'theme' }, { inputKey: 'c', type: 'cookie', key: 'c', style: 'cookie' }]), { theme: 'dark', c: { theme: 'evil' } }],
      [tool('/q', [{ inputKey: 'o', type: 'query', key: 'o' }, queryKey]), { o: { api_key: 'attacker' } }],
    ];

    for (const [unsafe, input] of attempts) {
      expect(() => buildHttpRequest(unsafe, input, { baseUrl })).toThrow(/which this tool reserves for/);
    }
    expect(loopback.requests).toHaveLength(0);
  });

  it('sends a JSON header with non-ASCII text as ASCII escapes, which fetch would otherwise refuse', async () => {
    const header = tool('/h', [{ inputKey: 'f', type: 'header', key: 'X-Filter', serialization: { contentType: 'application/json' } }]);
    const captured = await send(buildHttpRequest(header, { f: { name: 'Zoë 中 😀' } }, { baseUrl }));

    expect(captured.headers['x-filter']).toBe('{"name":"Zo\\u00eb \\u4e2d \\ud83d\\ude00"}');
    expect(JSON.parse(captured.headers['x-filter'] as string)).toEqual({ name: 'Zoë 中 😀' });
  });

  it('sends a content: application/json query parameter as its percent-encoded JSON text', async () => {
    // in: query, name: coordinates, content: application/json, dataValue: { lat: 40.6, long: -73.9 }
    //   serializedValue: coordinates=%7B%22lat%22%3A40.6%2C%22long%22%3A-73.9%7D
    const captured = await send(
      buildHttpRequest(
        tool('/c', [{ inputKey: 'coordinates', type: 'query', key: 'coordinates', serialization: { contentType: 'application/json' } }]),
        { coordinates: { lat: 40.6, long: -73.9 } },
        { baseUrl },
      ),
    );

    expect(captured.url).toBe('/c?coordinates=%7B%22lat%22%3A40.6%2C%22long%22%3A-73.9%7D');
    expect(JSON.parse(new URL(`http://x${captured.url}`).searchParams.get('coordinates')!)).toEqual({ lat: 40.6, long: -73.9 });
  });

  it('sends a JSON header parameter as the JSON text, unencoded, with CR and LF escaped by JSON', async () => {
    const header = tool('/h', [{ inputKey: 'f', type: 'header', key: 'X-Filter', serialization: { contentType: 'application/json' } }]);

    const plain = await send(buildHttpRequest(header, { f: { name: 'Ada Lovelace', tags: ['a', 'b'] } }, { baseUrl }));
    expect(plain.headers['x-filter']).toBe('{"name":"Ada Lovelace","tags":["a","b"]}');

    const hostile = await send(buildHttpRequest(header, { f: { s: 'x\r\nX-Injected: 1' } }, { baseUrl }));
    expect(hostile.headers['x-filter']).toBe('{"s":"x\\r\\nX-Injected: 1"}');
    expect(hostile.headers['x-injected']).toBeUndefined();
    expect(JSON.parse(hostile.headers['x-filter'] as string)).toEqual({ s: 'x\r\nX-Injected: 1' });
  });

  // Style Examples, `color` = "blue" / ["blue", "black", "brown"] / { "R": 100, "G": 200, "B": 150 }:
  //   | cookie | true | color= | color=blue | color=blue; color=black; color=brown | R=100; G=200; B=150 |
  it.each([
    ['a primitive', 'blue', 'color=blue'],
    ['an array', ['blue', 'black', 'brown'], 'color=blue; color=black; color=brown'],
    ['an object', { R: 100, G: 200, B: 150 }, 'R=100; G=200; B=150'],
  ])('sends style: cookie for %s as the specification table gives it', async (_label, color, expected) => {
    const captured = await send(
      buildHttpRequest(tool('/k', [{ inputKey: 'color', type: 'cookie', key: 'color', style: 'cookie' }]), { color }, { baseUrl }),
    );

    expect(captured.headers.cookie).toBe(expected);
  });

  it('sends the parameters of a tool generated from an OpenAPI 3.2 document', async () => {
    // Generated, not hand-made: the mapper comes from the generation side
    // (in: querystring -> wholeQuery, content -> serialization.contentType,
    // style: cookie carried on the cookie entry)
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.2.0',
      info: { title: 'Search', version: '1.0.0' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/search': {
          get: {
            operationId: 'search',
            parameters: [
              {
                name: 'filter',
                in: 'querystring',
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: { type: 'object', properties: { foo: { type: 'string' }, bar: { type: 'boolean' } } },
                  },
                },
              },
              {
                name: 'X-Context',
                in: 'header',
                content: { 'application/json': { schema: { type: 'object', properties: { tenant: { type: 'string' } } } } },
              },
              { name: 'prefs', in: 'cookie', style: 'cookie', schema: { type: 'object', properties: { theme: { type: 'string' }, size: { type: 'integer' } } } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
        '/near': {
          get: {
            operationId: 'near',
            parameters: [
              {
                name: 'coordinates',
                in: 'query',
                content: { 'application/json': { schema: { type: 'object', properties: { lat: { type: 'number' }, long: { type: 'number' } } } } },
              },
              { name: 'json', in: 'cookie', style: 'cookie', schema: { type: 'array', items: { type: 'string' } } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });
    const tools = new Map((await generator.generateTools()).map((generated) => [generated.name, generated]));

    const search = await send(
      buildHttpRequest(
        tools.get('search')!,
        { filter: { foo: 'a + b', bar: true }, 'X-Context': { tenant: 'acme' }, prefs: { theme: 'dark', size: 2 } },
        { baseUrl },
      ),
    );
    expect(search.url).toBe('/search?foo=a+%2B+b&bar=true');
    expect(search.headers['x-context']).toBe('{"tenant":"acme"}');
    expect(search.headers.cookie).toBe('theme=dark; size=2');

    const near = await send(
      buildHttpRequest(tools.get('near')!, { coordinates: { lat: 40.6, long: -73.9 }, json: ['a', 'b'] }, { baseUrl }),
    );
    expect(near.url).toBe('/near?coordinates=%7B%22lat%22%3A40.6%2C%22long%22%3A-73.9%7D');
    expect(near.headers.cookie).toBe('json=a; json=b');
  });
});

describe('story: methods beyond the original eight on the wire', () => {
  // Hand-made tools, not generated: this story is about what buildHttpRequest
  // puts on the request line, whatever produced `metadata.method`. Node's
  // global fetch passes `QUERY` and `LINK` through untouched (it only
  // normalizes the case of the six methods in the Fetch standard, and refuses
  // CONNECT and TRACE), so sendBuiltRequest needs no special case.
  const handTool = (method: string, path: string, mapper: ParameterMapper[]): McpOpenAPITool => ({
    name: 'hand_made',
    description: 'hand made',
    inputSchema: { type: 'object', properties: {} },
    mapper,
    metadata: { path, method },
  });

  const loopback = createLoopbackServer(() => (_req, res) => {
    res.writeHead(204);
    res.end();
  });
  let baseUrl: string;
  beforeAll(async () => {
    baseUrl = await loopback.listen();
  });
  afterAll(() => loopback.close());
  beforeEach(() => loopback.reset());

  it('sends a query operation as QUERY with its JSON body', async () => {
    const tool = handTool('query', '/search', [
      { inputKey: 'filter', type: 'body', key: 'filter' },
      { inputKey: 'limit', type: 'body', key: 'limit' },
    ]);
    await sendBuiltRequest(buildHttpRequest(tool, { filter: { name: 'ada' }, limit: 5 }, { baseUrl }));

    const captured = loopback.requests.at(-1)!;
    expect(captured.method).toBe('QUERY');
    expect(captured.url).toBe('/search');
    expect(captured.headers['content-type']).toBe('application/json');
    expect(JSON.parse(captured.body.toString())).toEqual({ filter: { name: 'ada' }, limit: 5 });
  });

  it('sends an additional operation under its own method, with path, query and header parameters', async () => {
    const tool = handTool('LINK', '/items/{id}', [
      { inputKey: 'id', type: 'path', key: 'id', required: true },
      { inputKey: 'rel', type: 'query', key: 'rel' },
      { inputKey: 'link', type: 'header', key: 'Link' },
    ]);
    await sendBuiltRequest(
      buildHttpRequest(tool, { id: 'a b', rel: 'related', link: '<https://example.com/other>; rel="related"' }, { baseUrl }),
    );

    const captured = loopback.requests.at(-1)!;
    expect(captured.method).toBe('LINK');
    expect(captured.url).toBe('/items/a%20b?rel=related');
    expect(captured.headers['link']).toBe('<https://example.com/other>; rel="related"');
    expect(captured.body.length).toBe(0);
  });

  it('sends the original eight methods exactly as before', async () => {
    // TRACE is left out: fetch refuses to send it
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      await sendBuiltRequest(buildHttpRequest(handTool(method, '/m', []), {}, { baseUrl }));
      expect(loopback.requests.at(-1)!.method).toBe(method.toUpperCase());
    }
  });

  describe('methods Node\'s HTTP parser would refuse', () => {
    // Node's HTTP server only parses the methods in http.METHODS (and in
    // upper case), so the request line of any other additional method is
    // captured with a raw socket instead.
    let server: Server;
    let port: number;
    const requestLines: string[] = [];

    beforeAll(async () => {
      server = createServer((socket) => {
        socket.once('data', (chunk) => {
          requestLines.push(chunk.toString('latin1').split('\r\n')[0]);
          socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
    beforeEach(() => {
      requestLines.length = 0;
    });

    it.each(['Link', 'link', 'X-CUSTOM', 'FOO'])('puts the additional method %s on the request line as written', async (method) => {
      const built = buildHttpRequest(handTool(method, '/things', []), {}, { baseUrl: `http://127.0.0.1:${port}` });
      await sendBuiltRequest(built);

      expect(requestLines).toEqual([`${method} /things HTTP/1.1`]);
    });
  });

  it.each(['CONNECT', 'connect', 'LINK\r\nX-Injected: 1', 'LINK /x'])(
    'sends nothing for the method %j',
    (method) => {
      expect(() => buildHttpRequest(handTool(method, '/things', []), {}, { baseUrl })).toThrow(RequestBuildError);
      expect(loopback.requests).toHaveLength(0);
    },
  );
});
