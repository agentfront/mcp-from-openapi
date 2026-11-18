/**
 * Wire story: buildHttpRequest output fetched for real, asserted as the raw
 * bytes/headers/paths the loopback server received — the OpenAPI
 * serialization table on the wire instead of as data structures. A section
 * does the same for Swagger 2.0 documents, with the expected bytes written
 * from the 2.0 specification, and the last one for the Encoding Objects of
 * OpenAPI 3.x form bodies (urlencoded and multipart).
 */
import { createServer, type AddressInfo, type Server } from 'net';
import { OpenAPIToolGenerator, RequestBuildError, SecurityResolver, buildHttpRequest, createSecurityContext } from '../src';
import type { McpOpenAPITool, ParameterMapper } from '../src';
import { createLoopbackServer, type CapturedRequest, type LoopbackHandler } from '../src/__tests__/helpers/loopback';
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

    // apiKeys is keyed by the WIRE parameter name (apiKeyName), not the scheme. The four requirements are
    // alternatives: only the first one the context fills is sent, the header key, not the query key too
    const keys = await resolver.resolve(
      tool.mapper,
      createSecurityContext({ apiKeys: { 'X-API-Key': 'hk-1', api_key: 'qk-2' } }),
    );
    await sendBuiltRequest(buildHttpRequest(tool, {}, { baseUrl }), keys);
    const captured = loopback.requests.at(-1)!;
    expect(captured.headers['x-api-key']).toBe('hk-1');
    expect(new URL(`http://x${captured.url}`).searchParams.get('api_key')).toBeNull();

    const queryOnly = await resolver.resolve(tool.mapper, createSecurityContext({ apiKeys: { api_key: 'qk-2' } }));
    await sendBuiltRequest(buildHttpRequest(tool, {}, { baseUrl }), queryOnly);
    expect(new URL(`http://x${loopback.requests.at(-1)!.url}`).searchParams.get('api_key')).toBe('qk-2');
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

  it('sends an allowReserved query value that cannot add a pair or cut the query (the raw request line)', async () => {
    // OpenAPI 3.2.1 allowReserved: "Applications are still responsible for percent-encoding reserved characters
    // that are not allowed by the rules of the `in` destination or media type": `&`, `=`, `+`, `#`, `[`, `]` stay
    // percent-encoded; `/`, `?`, `:` and the other reserved characters a query allows pass through
    const queryKey: ParameterMapper = { inputKey: 'key', type: 'query', key: 'api_key', security: { scheme: 'k', type: 'apiKey', apiKeyIn: 'query' } };
    const redirect = tool('/login', [{ inputKey: 'next', type: 'query', key: 'next', allowReserved: true }, { inputKey: 'page', type: 'query', key: 'page' }, queryKey]);

    const injected = await send(buildHttpRequest(redirect, { next: 'x&api_key=attacker', key: 'real' }, { baseUrl }));
    expect(`${injected.method} ${injected.url}`).toBe('GET /login?next=x%26api_key%3Dattacker&api_key=real');
    expect(new URL(`http://x${injected.url}`).searchParams.getAll('api_key')).toEqual(['real']); // exactly one, the real one

    const fragment = await send(buildHttpRequest(redirect, { next: '/home?tab=a#b+c', page: 2 }, { baseUrl }));
    expect(`${fragment.method} ${fragment.url}`).toBe('GET /login?next=/home?tab%3Da%23b%2Bc&page=2');
    expect([...new URL(`http://x${fragment.url}`).searchParams]).toEqual([
      ['next', '/home?tab=a#b+c'],
      ['page', '2'],
    ]);

    // a path value stays percent-encoded whatever allowReserved says (path templating forbids unescaped / ? #)
    const file = tool('/files/{id}', [{ inputKey: 'id', type: 'path', key: 'id', required: true, allowReserved: true }]);
    const path = await send(buildHttpRequest(file, { id: 'a/b?c#d%e' }, { baseUrl }));
    expect(`${path.method} ${path.url}`).toBe('GET /files/a%2Fb%3Fc%23d%25e');
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

describe('story: Swagger 2.0 on the wire', () => {
  // Tools come from inline Swagger 2.0 documents through the real generator
  // (the document is converted to OpenAPI 3.0, then turned into tools). The
  // expected bytes are written from the Swagger 2.0 specification's own rules,
  // not from what the library sends:
  //   - Parameter Object `collectionFormat`: csv `foo,bar`, ssv `foo bar`, tsv `foo<TAB>bar`, pipes `foo|bar`,
  //     multi `foo=bar&foo=baz` (valid only in query and formData); the default is csv
  //   - in a header and in a path: csv, ssv, tsv and pipes (not multi)
  //   - `in: formData`: application/x-www-form-urlencoded or multipart/form-data; `type: file` only in multipart
  //   - an Operation Object's `consumes` overrides the Swagger Object's
  //   - the URL is scheme + host + basePath + the path
  //   - Security Scheme Object: `basic` (RFC 7617), `apiKey` named by `name`, in the header or in the query
  // The specification says nothing about percent-encoding, so a query value is compared decoded (a space or a
  // comma may travel as %20 or %2C); the raw request target is pinned only where the library's own choice is the point.
  let served: object | undefined;
  const loopback = createLoopbackServer(() => (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(served !== undefined && req.url === '/spec/swagger.json' ? JSON.stringify(served) : '{}');
  });
  let origin: string;
  let host: string;

  beforeAll(async () => {
    origin = await loopback.listen();
    host = new URL(origin).host;
  });
  afterAll(() => loopback.close());
  beforeEach(() => {
    loopback.reset();
    served = undefined;
  });

  const OK = { 200: { description: 'OK' } };
  const strings = (collectionFormat?: string) => ({
    type: 'array',
    items: { type: 'string' },
    ...(collectionFormat === undefined ? {} : { collectionFormat }),
  });

  /** A Swagger 2.0 document whose server is the loopback server: http://127.0.0.1:<port>/v2 */
  const swagger = (paths: object, extra: object = {}): object => ({
    swagger: '2.0',
    info: { title: 'Wire API', version: '1.0.0' },
    host,
    basePath: '/v2',
    schemes: ['http'],
    paths,
    ...extra,
  });

  const generate = async (document: object) => {
    const generator = await OpenAPIToolGenerator.fromJSON(document);
    const tools = new Map((await generator.generateTools()).map((tool) => [tool.name, tool]));
    return { generator, tools };
  };

  /** Sends to the tool's own server (no baseUrl): the document's schemes, host and basePath are the URL. */
  const send = async (
    tool: McpOpenAPITool,
    input: Record<string, unknown>,
    security?: Parameters<typeof sendBuiltRequest>[1],
  ) => {
    await sendBuiltRequest(buildHttpRequest(tool, input), security);
    return loopback.requests.at(-1)!;
  };

  const queryOf = (wire: CapturedRequest) => [...new URL(`http://x${wire.url}`).searchParams];
  const formOf = async (wire: CapturedRequest) =>
    [
      ...(
        await new Response(wire.body, { headers: { 'content-type': String(wire.headers['content-type']) } }).formData()
      ).entries(),
    ];

  describe('the URL: schemes, host and basePath', () => {
    it('sends to scheme://host + basePath + path', async () => {
      const { tools } = await generate(swagger({ '/pets': { get: { operationId: 'list', responses: OK } } }));

      const wire = await send(tools.get('list')!, {});

      expect(wire.method).toBe('GET');
      expect(wire.url).toBe('/v2/pets');
      expect(wire.headers.host).toBe(host);
    });

    it.each([
      [
        'https first of two schemes',
        { host: 'api.example.com', basePath: '/v1', schemes: ['https', 'http'] },
        ['https://api.example.com/v1', 'http://api.example.com/v1'],
        'https://api.example.com/v1/pets',
      ],
      [
        'a port and a trailing slash on basePath',
        { host: 'api.example.com:8443', basePath: '/v1/', schemes: ['http'] },
        ['http://api.example.com:8443/v1'],
        'http://api.example.com:8443/v1/pets',
      ],
      [
        'no basePath: served directly under the host',
        { host: 'api.example.com', schemes: ['https'] },
        ['https://api.example.com'],
        'https://api.example.com/pets',
      ],
      [
        'the basePath "/"',
        { host: 'api.example.com', basePath: '/', schemes: ['https'] },
        ['https://api.example.com'],
        'https://api.example.com/pets',
      ],
    ])('forms the server URL from %s', async (_label, fields, servers, url) => {
      const { tools } = await generate({
        swagger: '2.0',
        info: { title: 'URL API', version: '1.0.0' },
        ...fields,
        paths: { '/pets': { get: { operationId: 'list', responses: OK } } },
      });
      const list = tools.get('list')!;

      expect(list.metadata.servers).toEqual(servers.map((server) => ({ url: server })));
      expect(buildHttpRequest(list, {}).url).toBe(url); // assembled, not sent: the host is not ours
    });

    it('lets an operation name its own schemes', async () => {
      const { tools } = await generate({
        swagger: '2.0',
        info: { title: 'URL API', version: '1.0.0' },
        host: 'api.example.com',
        basePath: '/v1',
        schemes: ['https'],
        paths: {
          '/a': { get: { operationId: 'a', schemes: ['http'], responses: OK } },
          '/b': { get: { operationId: 'b', responses: OK } },
        },
      });

      expect(buildHttpRequest(tools.get('a')!, {}).url).toBe('http://api.example.com/v1/a');
      expect(buildHttpRequest(tools.get('b')!, {}).url).toBe('https://api.example.com/v1/b');
    });

    it('takes the host and the scheme of the place the document was served from when it names neither', async () => {
      // 2.0: "If the host is not included, the host serving the documentation is to be used" and, without
      // `schemes`, "the scheme used to access the Swagger definition itself"
      served = {
        swagger: '2.0',
        info: { title: 'Hostless API', version: '1.0.0' },
        basePath: '/api',
        paths: { '/pets': { get: { operationId: 'list', responses: OK } } },
      };
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/spec/swagger.json`, {
        refResolution: { allowInternalIPs: true },
      });
      const [list] = await generator.generateTools();

      expect(list.metadata.servers).toEqual([{ url: `${origin}/api` }]);
      const wire = await send(list, {});
      expect(wire.url).toBe('/api/pets');
      expect(wire.headers.host).toBe(host);
    });
  });

  describe('collectionFormat of a query array', () => {
    it('sends csv (also the default), ssv, pipes and multi as the specification writes them', async () => {
      const { tools } = await generate(
        swagger({
          '/search': {
            get: {
              operationId: 'search',
              parameters: [
                { name: 'omitted', in: 'query', ...strings() },
                { name: 'csv', in: 'query', ...strings('csv') },
                { name: 'ssv', in: 'query', ...strings('ssv') },
                { name: 'pipes', in: 'query', ...strings('pipes') },
                { name: 'multi', in: 'query', ...strings('multi') },
              ],
              responses: OK,
            },
          },
        }),
      );
      const items = ['a', 'b'];

      const wire = await send(tools.get('search')!, { omitted: items, csv: items, ssv: items, pipes: items, multi: items });

      expect(queryOf(wire)).toEqual([
        ['omitted', 'a,b'], // csv is the default
        ['csv', 'a,b'],
        ['ssv', 'a b'],
        ['pipes', 'a|b'],
        ['multi', 'a'], // multi: one instance per item
        ['multi', 'b'],
      ]);
      // the library's own choice of percent-encoding for the delimiters
      expect(wire.url).toBe('/v2/search?omitted=a%2Cb&csv=a%2Cb&ssv=a%20b&pipes=a%7Cb&multi=a&multi=b');
    });

    it('keeps the items of a multi array apart whatever they contain', async () => {
      const { tools } = await generate(
        swagger({
          '/search': { get: { operationId: 'search', parameters: [{ name: 'q', in: 'query', ...strings('multi') }], responses: OK } },
        }),
      );

      const wire = await send(tools.get('search')!, { q: ['a&b=c', 'x y', 'é', '1+1'] });

      expect(queryOf(wire)).toEqual([['q', 'a&b=c'], ['q', 'x y'], ['q', 'é'], ['q', '1+1']]);
    });

    it('writes the items of a numeric or boolean array as their JSON text', async () => {
      const { tools } = await generate(
        swagger({
          '/search': {
            get: {
              operationId: 'search',
              parameters: [
                { name: 'ids', in: 'query', type: 'array', items: { type: 'integer' } },
                { name: 'flags', in: 'query', type: 'array', items: { type: 'boolean' }, collectionFormat: 'multi' },
              ],
              responses: OK,
            },
          },
        }),
      );

      const wire = await send(tools.get('search')!, { ids: [1, 2, 3], flags: [true, false] });

      expect(queryOf(wire)).toEqual([['ids', '1,2,3'], ['flags', 'true'], ['flags', 'false']]);
    });
  });

  describe('collectionFormat of a header and of a path parameter', () => {
    it('sends csv, also the default, comma-separated', async () => {
      const { tools } = await generate(
        swagger({
          '/items/{ids}/{codes}': {
            get: {
              operationId: 'items',
              parameters: [
                { name: 'ids', in: 'path', required: true, ...strings('csv') },
                { name: 'codes', in: 'path', required: true, ...strings() },
                { name: 'X-Ids', in: 'header', ...strings('csv') },
                { name: 'X-Codes', in: 'header', ...strings() },
              ],
              responses: OK,
            },
          },
        }),
      );

      const wire = await send(tools.get('items')!, {
        ids: ['1', '2', '3'],
        codes: ['a b', 'c'],
        'X-Ids': ['1', '2', '3'],
        'X-Codes': ['x', 'y'],
      });

      expect(decodeURIComponent(wire.url)).toBe('/v2/items/1,2,3/a b,c');
      expect(wire.headers['x-ids']).toBe('1,2,3');
      expect(wire.headers['x-codes']).toBe('x,y');
    });
  });

  describe('a collectionFormat OpenAPI 3.0 has no style for', () => {
    // The 2.0 text allows ssv, tsv and pipes in a header and a path, and tsv in a query (`foo bar`, `foo<TAB>bar`,
    // `foo|bar`). OpenAPI 3.0 has no style for them, so the conversion sends the nearest one it has, comma-separated,
    // and says so in the generator's diagnostics: never silently.
    it.each([
      ['a tsv query parameter', 'query', 'tsv'],
      ['an ssv header', 'header', 'ssv'],
      ['a tsv header', 'header', 'tsv'],
      ['a pipes header', 'header', 'pipes'],
      ['an ssv path parameter', 'path', 'ssv'],
      ['a tsv path parameter', 'path', 'tsv'],
      ['a pipes path parameter', 'path', 'pipes'],
    ])('sends %s comma-separated and reports it', async (_label, location, collectionFormat) => {
      const name = location === 'header' ? 'X-P' : 'p';
      const { generator, tools } = await generate(
        swagger({
          [location === 'path' ? '/things/{p}' : '/things']: {
            get: {
              operationId: 'things',
              parameters: [{ name, in: location, ...(location === 'path' ? { required: true } : {}), ...strings(collectionFormat) }],
              responses: OK,
            },
          },
        }),
      );

      const wire = await send(tools.get('things')!, { [name]: ['a', 'b'] });

      const received = {
        query: () => new URL(`http://x${wire.url}`).searchParams.get(name),
        header: () => wire.headers['x-p'],
        path: () => decodeURIComponent(wire.url).split('/').pop(),
      }[location]!();
      expect(received).toBe('a,b');
      expect(generator.getDiagnostics().map((d) => d.code)).toEqual(['SWAGGER_UNSUPPORTED_COLLECTION_FORMAT']);
    });
  });

  describe('in: body', () => {
    it('sends the body as JSON next to the parameters of the other locations', async () => {
      const { tools } = await generate(
        swagger({
          '/pets/{id}': {
            put: {
              operationId: 'update',
              parameters: [
                { name: 'id', in: 'path', required: true, type: 'integer' },
                { name: 'dryRun', in: 'query', type: 'boolean' },
                { name: 'X-Trace', in: 'header', type: 'string' },
                {
                  name: 'pet',
                  in: 'body',
                  required: true,
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                      name: { type: 'string' },
                      tags: { type: 'array', items: { type: 'string' } },
                      owner: { type: 'object', properties: { id: { type: 'integer' } } },
                    },
                  },
                },
              ],
              responses: OK,
            },
          },
        }),
        // no `consumes` anywhere: the body is JSON
      );

      const wire = await send(tools.get('update')!, {
        id: 7,
        dryRun: true,
        'X-Trace': 't-1',
        name: 'Rex',
        tags: ['a', 'b'],
        owner: { id: 1 },
      });

      expect(wire.method).toBe('PUT');
      expect(wire.url).toBe('/v2/pets/7?dryRun=true');
      expect(wire.headers['x-trace']).toBe('t-1');
      expect(wire.headers['content-type']).toBe('application/json');
      expect(JSON.parse(wire.body.toString())).toEqual({ name: 'Rex', tags: ['a', 'b'], owner: { id: 1 } });
    });

    it('sends a body that is not an object as the whole body', async () => {
      const { tools } = await generate(
        swagger({
          '/tags': {
            post: {
              operationId: 'setTags',
              parameters: [{ name: 'tags', in: 'body', required: true, schema: { type: 'array', items: { type: 'string' } } }],
              responses: OK,
            },
          },
        }),
      );

      const wire = await send(tools.get('setTags')!, { body: ['a', 'b'] });

      expect(wire.headers['content-type']).toBe('application/json');
      expect(wire.body.toString()).toBe('["a","b"]');
    });

    it('sends nothing when a required body property is missing', async () => {
      const { tools } = await generate(
        swagger({
          '/pets': {
            post: {
              operationId: 'add',
              parameters: [
                { name: 'pet', in: 'body', required: true, schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } },
              ],
              responses: OK,
            },
          },
        }),
      );

      expect(tools.get('add')!.inputSchema.required).toEqual(['name']);
      expect(() => buildHttpRequest(tools.get('add')!, {})).toThrow(RequestBuildError);
      expect(loopback.requests).toHaveLength(0);
    });
  });

  describe('in: formData, form-urlencoded', () => {
    const formDocument = (array?: string) =>
      swagger({
        '/forms': {
          post: {
            operationId: 'form',
            consumes: ['application/x-www-form-urlencoded'],
            parameters: [
              { name: 'name', in: 'formData', type: 'string', required: true },
              { name: 'age', in: 'formData', type: 'integer' },
              { name: 'subscribed', in: 'formData', type: 'boolean' },
              { name: 'tags', in: 'formData', ...strings(array) },
              { name: 'note', in: 'formData', type: 'string' },
            ],
            responses: OK,
          },
        },
      });

    it('sends the fields as one form, each value form-encoded, a multi array as repeated fields', async () => {
      const { tools } = await generate(formDocument('multi'));

      const wire = await send(tools.get('form')!, {
        name: 'Ada Lovelace',
        age: 36,
        subscribed: false,
        tags: ['x', 'y z'],
        note: 'a&b=c é',
      });

      expect(wire.method).toBe('POST');
      expect(wire.url).toBe('/v2/forms');
      expect(wire.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect([...new URLSearchParams(wire.body.toString())]).toEqual([
        ['name', 'Ada Lovelace'],
        ['age', '36'],
        ['subscribed', 'false'],
        ['tags', 'x'],
        ['tags', 'y z'],
        ['note', 'a&b=c é'],
      ]);
      // `&`, `=` and non-ASCII text travel percent-encoded, so they cannot split or forge a field
      expect(wire.body.toString()).toContain('note=a%26b%3Dc+%C3%A9');
    });

    it('sends nothing when a required field is missing', async () => {
      const { tools } = await generate(formDocument('multi'));

      expect(tools.get('form')!.inputSchema.required).toEqual(['name']);
      expect(() => buildHttpRequest(tools.get('form')!, { age: 3 })).toThrow(RequestBuildError);
      expect(loopback.requests).toHaveLength(0);
    });
  });

  describe('in: formData with type: file, multipart', () => {
    const uploadDocument = () =>
      swagger({
        '/pets/{id}/photo': {
          post: {
            operationId: 'upload',
            consumes: ['multipart/form-data'],
            parameters: [
              { name: 'id', in: 'path', required: true, type: 'integer' },
              { name: 'label', in: 'formData', type: 'string' },
              { name: 'file', in: 'formData', type: 'file', required: true },
            ],
            responses: OK,
          },
        },
      });
    // not valid UTF-8, so a text round trip would change it
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff]);

    it('sends a text part and a file part with its name, content type and bytes', async () => {
      const { tools } = await generate(uploadDocument());

      const wire = await send(tools.get('upload')!, {
        id: 7,
        label: 'a png',
        file: new File([png], 'photo.png', { type: 'image/png' }),
      });

      expect(wire.method).toBe('POST');
      expect(wire.url).toBe('/v2/pets/7/photo');
      expect(wire.headers['content-type']).toMatch(/^multipart\/form-data; boundary=\S+$/);
      const parts = await formOf(wire);
      expect(parts.map(([name]) => name)).toEqual(['label', 'file']);
      expect(parts[0][1]).toBe('a png');
      const file = parts[1][1] as File;
      expect(file.name).toBe('photo.png');
      expect(file.type).toBe('image/png');
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
      expect(wire.body.includes(Buffer.from(png))).toBe(true); // verbatim in the body, not re-encoded
    });

    it('sends bytes with no type as application/octet-stream', async () => {
      const { tools } = await generate(uploadDocument());

      const wire = await send(tools.get('upload')!, { id: 7, file: png });

      const parts = await formOf(wire);
      expect(parts.map(([name]) => name)).toEqual(['file']);
      const file = parts[0][1] as File;
      expect(file.type).toBe('application/octet-stream');
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(png);
    });

    it('sends nothing when the required file is missing', async () => {
      const { tools } = await generate(uploadDocument());

      expect(tools.get('upload')!.inputSchema.required).toEqual(['id', 'file']);
      expect(() => buildHttpRequest(tools.get('upload')!, { id: 7, label: 'no file' })).toThrow(RequestBuildError);
      expect(loopback.requests).toHaveLength(0);
    });
  });

  describe('securityDefinitions', () => {
    const resolver = new SecurityResolver();
    const document = () =>
      swagger(
        {
          '/inherits': { get: { operationId: 'inherits', responses: OK } },
          '/basic': { get: { operationId: 'basic', security: [{ basicAuth: [] }], responses: OK } },
          '/header-key': { get: { operationId: 'headerKey', security: [{ headerKey: [] }], responses: OK } },
          '/query-key': {
            get: {
              operationId: 'queryKey',
              security: [{ queryKey: [] }],
              parameters: [{ name: 'limit', in: 'query', type: 'integer' }],
              responses: OK,
            },
          },
          '/public': { get: { operationId: 'publicOp', security: [], responses: OK } },
        },
        {
          securityDefinitions: {
            basicAuth: { type: 'basic' },
            headerKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
            queryKey: { type: 'apiKey', name: 'api_key', in: 'query' },
          },
          security: [{ headerKey: [] }],
        },
      );
    const context = createSecurityContext({
      // the PRE-ENCODED base64 of "username:password" (RFC 7617)
      basic: Buffer.from('ada:s3cret').toString('base64'),
      // keyed by the wire name of the key, which is `name` in the Security Scheme Object
      apiKeys: { 'X-API-Key': 'hk-1', api_key: 'q k&1' },
    });

    it('sends basic as an Authorization header', async () => {
      const { tools } = await generate(document());
      const tool = tools.get('basic')!;

      const wire = await send(tool, {}, await resolver.resolve(tool.mapper, context));

      expect(wire.headers.authorization).toBe('Basic YWRhOnMzY3JldA=='); // base64("ada:s3cret")
      expect(wire.headers['x-api-key']).toBeUndefined();
      expect(queryOf(wire)).toEqual([]);
    });

    it('sends an apiKey in the header it names', async () => {
      const { tools } = await generate(document());
      const tool = tools.get('headerKey')!;

      const wire = await send(tool, {}, await resolver.resolve(tool.mapper, context));

      expect(wire.headers['x-api-key']).toBe('hk-1');
      expect(wire.headers.authorization).toBeUndefined();
      expect(queryOf(wire)).toEqual([]);
    });

    it('sends an apiKey in the query parameter it names, after the operation\'s own', async () => {
      const { tools } = await generate(document());
      const tool = tools.get('queryKey')!;

      const wire = await send(tool, { limit: 5 }, await resolver.resolve(tool.mapper, context));

      expect(queryOf(wire)).toEqual([['limit', '5'], ['api_key', 'q k&1']]);
      expect(wire.headers['x-api-key']).toBeUndefined();
    });

    it('applies the document\'s security to an operation that names none, and none to `security: []`', async () => {
      const { tools } = await generate(document());

      const inherits = tools.get('inherits')!;
      const inherited = await send(inherits, {}, await resolver.resolve(inherits.mapper, context));
      expect(inherited.headers['x-api-key']).toBe('hk-1');

      const open = tools.get('publicOp')!;
      expect(open.mapper.filter((entry) => entry.security)).toEqual([]);
      const wire = await send(open, {}, await resolver.resolve(open.mapper, context));
      expect(wire.headers['x-api-key']).toBeUndefined();
      expect(wire.headers.authorization).toBeUndefined();
    });
  });

  describe('consumes: the operation overrides the document', () => {
    const body = { type: 'object', properties: { a: { type: 'string' } } };

    it('sends a body under the media type of the operation, not the document\'s', async () => {
      const { tools } = await generate(
        swagger(
          {
            '/json': { post: { operationId: 'json', parameters: [{ name: 'b', in: 'body', schema: body }], responses: OK } },
            '/note': {
              post: {
                operationId: 'note',
                consumes: ['text/plain'],
                parameters: [{ name: 'b', in: 'body', required: true, schema: { type: 'string' } }],
                responses: OK,
              },
            },
          },
          { consumes: ['application/json'] },
        ),
      );

      const inherited = await send(tools.get('json')!, { a: 'x' });
      expect(inherited.headers['content-type']).toBe('application/json');
      expect(inherited.body.toString()).toBe('{"a":"x"}');

      const overridden = await send(tools.get('note')!, { body: 'hello' });
      expect(overridden.headers['content-type']).toBe('text/plain');
      expect(overridden.body.toString()).toBe('hello');
    });

    it('sends one of the media types the operation lists, JSON when it is among them', async () => {
      // any listed type is allowed by the specification; the library takes JSON
      const { tools } = await generate(
        swagger({
          '/pick': {
            post: {
              operationId: 'pick',
              consumes: ['application/xml', 'application/json'],
              parameters: [{ name: 'b', in: 'body', schema: body }],
              responses: OK,
            },
          },
        }),
      );

      const wire = await send(tools.get('pick')!, { a: 'x' });

      expect(wire.headers['content-type']).toBe('application/json');
      expect(JSON.parse(wire.body.toString())).toEqual({ a: 'x' });
    });

    it('sends form fields as a multipart body when the operation overrides the document\'s urlencoded form', async () => {
      const { tools } = await generate(
        swagger(
          {
            '/urlencoded': {
              post: { operationId: 'urlencoded', parameters: [{ name: 'name', in: 'formData', type: 'string' }], responses: OK },
            },
            '/multipart': {
              post: {
                operationId: 'multipart',
                consumes: ['multipart/form-data'],
                parameters: [{ name: 'name', in: 'formData', type: 'string' }],
                responses: OK,
              },
            },
          },
          { consumes: ['application/x-www-form-urlencoded'] },
        ),
      );

      const inherited = await send(tools.get('urlencoded')!, { name: 'Ada' });
      expect(inherited.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect(inherited.body.toString()).toBe('name=Ada');

      const overridden = await send(tools.get('multipart')!, { name: 'Ada' });
      expect(overridden.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
      expect(await formOf(overridden)).toEqual([['name', 'Ada']]);
    });
  });

  describe('an array in a form body', () => {
    // The 2.0 text gives a form field the same collectionFormat as a query parameter: csv `foo=a,b` (the default),
    // ssv `foo=a b`, pipes `foo=a|b`, multi `foo=a&foo=b`; a multipart body repeats the part for multi. The converter
    // writes an Encoding Object (style/explode) for each array, urlencoded or multipart, and the request builder
    // applies it (in multipart as OpenAPI 3.2 says, Appendix C: one part per name/value pair, never percent-encoded).
    const formDocument = (consumes: string, collectionFormat?: string) =>
      swagger({
        '/tags': {
          post: {
            operationId: 'tags',
            consumes: [consumes],
            parameters: [{ name: 'tags', in: 'formData', ...strings(collectionFormat) }],
            responses: OK,
          },
        },
      });

    it.each([
      ['the default (csv)', undefined, 'x,y', 'tags=x%2Cy'],
      ['csv', 'csv', 'x,y', 'tags=x%2Cy'],
      ['ssv', 'ssv', 'x y', 'tags=x+y'],
      ['pipes', 'pipes', 'x|y', 'tags=x%7Cy'],
    ])('sends a urlencoded array with collectionFormat %s as one field', async (_label, collectionFormat, value, bytes) => {
      const { tools } = await generate(formDocument('application/x-www-form-urlencoded', collectionFormat));

      const wire = await send(tools.get('tags')!, { tags: ['x', 'y'] });

      expect([...new URLSearchParams(wire.body.toString())]).toEqual([['tags', value]]);
      // the library's own choice of encoding for the delimiters (form-urlencoded: `+` for a space)
      expect(wire.body.toString()).toBe(bytes);
    });

    it('sends a multipart multi array as one part per item', async () => {
      const { tools } = await generate(formDocument('multipart/form-data', 'multi'));

      const wire = await send(tools.get('tags')!, { tags: ['x', 'y'] });

      expect(await formOf(wire)).toEqual([['tags', 'x'], ['tags', 'y']]);
    });

    it('sends a multipart csv array as one part of comma-separated values', async () => {
      const { tools } = await generate(formDocument('multipart/form-data', 'csv'));

      const wire = await send(tools.get('tags')!, { tags: ['x', 'y'] });

      expect(await formOf(wire)).toEqual([['tags', 'x,y']]);
    });
  });
});

describe('story: Encoding Objects of an OpenAPI 3.x form body on the wire', () => {
  // Tools generated from inline documents through the real generator, whose mapper carries each field's Encoding
  // Object; the expected bytes follow the OpenAPI 3.2.1 "Style Examples" table and "Encoding the
  // x-www-form-urlencoded Media Type" / "Encoding multipart Media Types" (Appendix C for style in multipart).
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

  const OK = { '200': { description: 'OK' } };
  const toolsOf = async (document: object) =>
    new Map((await (await OpenAPIToolGenerator.fromJSON(document)).generateTools()).map((tool) => [tool.name, tool]));
  const send = async (tool: McpOpenAPITool, input: Record<string, unknown>) => {
    await sendBuiltRequest(buildHttpRequest(tool, input, { baseUrl }));
    return loopback.requests.at(-1)!;
  };

  const urlencodedDocument = {
    openapi: '3.0.3',
    info: { title: 'Billing', version: '1.0.0' },
    paths: {
      '/customers': {
        post: {
          operationId: 'createCustomer',
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    metadata: { type: 'object', additionalProperties: { type: 'string' } },
                    address: { type: 'object', properties: { city: { type: 'string' }, geo: { type: 'object' } } },
                    ids: { type: 'array', items: { type: 'integer' } },
                    tags: { type: 'array', items: { type: 'string' } },
                    plain: { type: 'array', items: { type: 'string' } },
                    next: { type: 'string' },
                    raw: { type: 'object' },
                  },
                },
                encoding: {
                  metadata: { style: 'deepObject', explode: true },
                  address: { style: 'deepObject', explode: true },
                  ids: { style: 'pipeDelimited', explode: false },
                  tags: { style: 'form', explode: false },
                  next: { allowReserved: true },
                },
              },
            },
          },
          responses: OK,
        },
      },
    },
  };

  it('sends each urlencoded field as its Encoding Object says, and a field without one as before', async () => {
    const tools = await toolsOf(urlencodedDocument);

    const wire = await send(tools.get('createCustomer')!, {
      name: 'Ada Lovelace',
      metadata: { plan: 'pro', 'order id': '7&8' },
      address: { city: 'Paris', geo: { lat: '48.8' } },
      ids: [1, 2, 3],
      tags: ['calm', 'small'],
      plain: ['a', 'b'],
      next: '/home?x=1&y=2',
      raw: { a: 1 },
    });

    expect(wire.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(wire.body.toString()).toBe(
      'name=Ada+Lovelace' +
        '&metadata%5Bplan%5D=pro&metadata%5Border+id%5D=7%268' + // deepObject: color%5BR%5D=100
        '&address%5Bcity%5D=Paris&address%5Bgeo%5D%5Blat%5D=48.8' + // nested brackets, as a deepObject query parameter gets
        '&ids=1%7C2%7C3' + // pipeDelimited: color=blue%7Cblack%7Cbrown
        '&tags=calm%2Csmall' + // form, explode false: color=blue,black,brown
        '&plain=a&plain=b' + // no Encoding Object: one pair per item, as before
        '&next=/home?x%3D1%26y%3D2' + // allowReserved keeps / and ?, never & = + (they would add a field)
        '&raw=%7B%22a%22%3A1%7D', // no Encoding Object: JSON text, as before
    );
    expect([...new URLSearchParams(wire.body.toString())]).toEqual([
      ['name', 'Ada Lovelace'],
      ['metadata[plan]', 'pro'],
      ['metadata[order id]', '7&8'],
      ['address[city]', 'Paris'],
      ['address[geo][lat]', '48.8'],
      ['ids', '1|2|3'],
      ['tags', 'calm,small'],
      ['plain', 'a'],
      ['plain', 'b'],
      ['next', '/home?x=1&y=2'],
      ['raw', '{"a":1}'],
    ]);
  });

  it('sends nothing when a deepObject or exploded field would name another field', async () => {
    const tools = await toolsOf({
      openapi: '3.1.0',
      info: { title: 'Forms', version: '1.0.0' },
      paths: {
        '/f': {
          post: {
            operationId: 'submit',
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: { type: 'object', properties: { opts: { type: 'object' }, role: { type: 'string' } } },
                  encoding: { opts: { style: 'form', explode: true } },
                },
              },
            },
            responses: OK,
          },
        },
      },
    });

    expect(() => buildHttpRequest(tools.get('submit')!, { opts: { role: 'admin' } }, { baseUrl })).toThrow(
      "The input of body parameter 'opts' (input key 'opts') names the form field 'role', which this tool reserves for the body parameter 'role' (input key 'role')",
    );
    expect(loopback.requests).toHaveLength(0);

    const wire = await send(tools.get('submit')!, { opts: { page: 2, opts: 'own' }, role: 'user' });
    expect(wire.body.toString()).toBe('page=2&opts=own&role=user');
  });

  it('sends a multipart body with a typed JSON part, a pinned part header, an exploded array and a file', async () => {
    const tools = await toolsOf({
      openapi: '3.0.3',
      info: { title: 'Uploads', version: '1.0.0' },
      paths: {
        '/documents': {
          post: {
            operationId: 'upload',
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    properties: {
                      title: { type: 'string' },
                      metadata: { type: 'object', properties: { author: { type: 'string' } } },
                      tags: { type: 'array', items: { type: 'string' } },
                      legacy: { type: 'array', items: { type: 'string' } },
                      file: { type: 'string', format: 'binary' },
                    },
                  },
                  encoding: {
                    metadata: {
                      contentType: 'application/json',
                      headers: {
                        'X-Part-Version': { schema: { type: 'string', enum: ['2'] } },
                        'X-Unpinned': { schema: { type: 'string' } },
                      },
                    },
                    tags: { style: 'form', explode: true },
                    file: { contentType: 'application/pdf' },
                  },
                },
              },
            },
            responses: OK,
          },
        },
      },
    });
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);

    const wire = await send(tools.get('upload')!, {
      title: 'Notes',
      metadata: { author: 'Ada' },
      tags: ['x', 'y z'],
      legacy: ['a', 'b'],
      file: pdf,
    });

    const contentType = String(wire.headers['content-type']);
    const boundary = /^multipart\/form-data; boundary=(mcp-from-openapi-[0-9a-f]{32})$/.exec(contentType)![1];
    const text = wire.body.toString('latin1').split(boundary).join('BOUNDARY');
    expect(text).toBe(
      '--BOUNDARY\r\nContent-Disposition: form-data; name="title"\r\n\r\nNotes\r\n' +
        '--BOUNDARY\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\nX-Part-Version: 2\r\n\r\n{"author":"Ada"}\r\n' +
        '--BOUNDARY\r\nContent-Disposition: form-data; name="tags"\r\n\r\nx\r\n' + // exploded: one part per item
        '--BOUNDARY\r\nContent-Disposition: form-data; name="tags"\r\n\r\ny z\r\n' + // never percent-encoded
        '--BOUNDARY\r\nContent-Disposition: form-data; name="legacy"\r\n\r\n["a","b"]\r\n' + // no Encoding Object: as before
        '--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/pdf\r\n\r\n' +
        '%PDF\u0000ÿ\r\n' +
        '--BOUNDARY--\r\n',
    );
    expect(wire.body.includes(Buffer.from(pdf))).toBe(true); // the file's bytes verbatim

    // and a server reads the parts back
    const form = await new Response(wire.body, { headers: { 'content-type': contentType } }).formData();
    expect([...form.keys()]).toEqual(['title', 'metadata', 'tags', 'tags', 'legacy', 'file']);
    expect(JSON.parse(form.get('metadata') as string)).toEqual({ author: 'Ada' });
    expect((form.get('file') as File).type).toBe('application/pdf');
  });

  it('sends a multipart body as FormData when no part needs a header FormData cannot write', async () => {
    const tools = await toolsOf({
      openapi: '3.1.0',
      info: { title: 'Uploads', version: '1.0.0' },
      paths: {
        '/files': {
          post: {
            operationId: 'upload',
            requestBody: {
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    properties: { file_link_data: { type: 'object' }, expand: { type: 'array', items: { type: 'string' } } },
                  },
                  // Stripe's /v1/files encodes these two with deepObject
                  encoding: { file_link_data: { style: 'deepObject', explode: true }, expand: { style: 'deepObject', explode: true } },
                },
              },
            },
            responses: OK,
          },
        },
      },
    });

    const wire = await send(tools.get('upload')!, { file_link_data: { create: true, metadata: { k: 'v' } }, expand: ['link'] });

    expect(String(wire.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=----formdata-undici-/);
    const form = await new Response(wire.body, { headers: { 'content-type': String(wire.headers['content-type']) } }).formData();
    expect([...form.entries()]).toEqual([
      ['file_link_data[create]', 'true'],
      ['file_link_data[metadata][k]', 'v'],
      ['expand', 'link'],
    ]);
  });
});
