/** Executes the http-requests example and asserts the wire traffic. */
import { RequestBuildError, SecurityResolver, buildHttpRequest, createSecurityContext } from 'mcp-from-openapi';
import { sendBuiltRequest } from '../../e2e/helpers/http';
import { createLoopbackServer, type LoopbackHandler } from '../../src/__tests__/helpers/loopback';
import { callTool, loadTools } from './example';

/* eslint-disable @typescript-eslint/no-explicit-any */

const spec: any = {
  openapi: '3.0.0',
  info: { title: 'Search API', version: '1.0.0' },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/search': {
      get: {
        operationId: 'search',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'filter', in: 'query', style: 'deepObject', explode: true, schema: { type: 'object', properties: { status: { type: 'string' } } } },
          { name: 'ids', in: 'query', style: 'pipeDelimited', explode: false, schema: { type: 'array', items: { type: 'integer' } } },
        ],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object', properties: { total: { type: 'integer' } } } } },
          },
        },
      },
    },
  },
};

describe('example: http-requests', () => {
  const handler: LoopbackHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ total: 2 }));
  };
  const loopback = createLoopbackServer(() => handler);

  afterAll(() => loopback.close());

  it('serializes styled parameters and credentials onto the wire', async () => {
    const apiBaseUrl = await loopback.listen();
    const tools = await loadTools(spec);
    const search = tools.get('search')!;

    const result = await callTool(search, { filter: { status: 'active' }, ids: [1, 2, 3] }, {
      apiBaseUrl,
      auth: { jwt: 'jwt-token' },
    });

    expect(result).toEqual({ status: 200, body: { total: 2 } });
    const captured = loopback.requests.at(-1)!;
    const params = new URL(`http://x${captured.url}`).searchParams;
    expect(params.get('filter[status]')).toBe('active'); // deepObject
    expect(params.get('ids')).toBe('1|2|3'); // pipeDelimited
    expect(captured.headers.authorization).toBe('Bearer jwt-token');
  });
});

describe('example: http-requests, query credentials', () => {
  // An API key in the query, on an operation whose whole query string is ONE
  // `in: querystring` parameter (OpenAPI 3.2), serialized as JSON or as a form
  const operation = (operationId: string, contentType: string) => ({
    get: {
      operationId,
      security: [{ keyAuth: [] }],
      parameters: [
        {
          name: 'q',
          in: 'querystring',
          content: { [contentType]: { schema: { type: 'object', properties: { a: { type: 'integer' }, tag: { type: 'array', items: { type: 'string' } } } } } },
        },
      ],
      responses: { '200': { description: 'OK' } },
    },
  });
  const spec: any = {
    openapi: '3.2.0',
    info: { title: 'Query API', version: '1.0.0' },
    components: { securitySchemes: { keyAuth: { type: 'apiKey', in: 'query', name: 'api_key' } } },
    paths: {
      '/json': operation('byJson', 'application/json'),
      '/form': operation('byForm', 'application/x-www-form-urlencoded'),
      '/plain': {
        get: {
          operationId: 'byPlain',
          security: [{ keyAuth: [] }],
          parameters: [{ name: 'path', in: 'query', allowReserved: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  };

  const loopback = createLoopbackServer(() => (_req, res) => {
    res.writeHead(204);
    res.end();
  });
  let apiBaseUrl: string;
  beforeAll(async () => {
    apiBaseUrl = await loopback.listen();
  });
  afterAll(() => loopback.close());
  beforeEach(() => loopback.reset());

  const auth = { apiKeys: { api_key: 'k 1' } }; // keyed by the wire name of the parameter

  it('places a query credential among name=value pairs, and leaves the other pairs as built', async () => {
    const tools = await loadTools(spec);

    await callTool(tools.get('byForm')!, { q: { a: 1, tag: ['x', 'y z'] } }, { apiBaseUrl, auth });
    expect(loopback.requests.at(-1)!.url).toBe('/form?a=1&tag=x&tag=y+z&api_key=k+1');

    // allowReserved keeps `/` as written: the credential joins the query by buildHttpRequest, not by re-parsing the URL
    await callTool(tools.get('byPlain')!, { path: 'a/b' }, { apiBaseUrl, auth });
    expect(loopback.requests.at(-1)!.url).toBe('/plain?path=a/b&api_key=k%201');
  });

  it('sends a JSON query string unchanged, and refuses to add a query credential to it', async () => {
    const tools = await loadTools(spec);
    const json = tools.get('byJson')!;

    // No credential in the context: nothing to add, the JSON text is the whole query string
    await callTool(json, { q: { a: 1 } }, { apiBaseUrl });
    expect(loopback.requests.at(-1)!.url).toBe('/json?%7B%22a%22%3A1%7D');
    loopback.reset();

    // A credential would have to become a pair of that JSON text: refused, nothing is sent
    await expect(callTool(json, { q: { a: 1 } }, { apiBaseUrl, auth })).rejects.toThrow(RequestBuildError);
    await expect(callTool(json, { q: { a: 1 } }, { apiBaseUrl, auth })).rejects.toThrow(
      /Security parameter 'api_key' cannot be added to the query string.*send the credential in a header or a cookie/,
    );
    expect(loopback.requests).toHaveLength(0);

    // A credential in the tool's own arguments (the model's input) is never sent
    await callTool(json, { q: { a: 1 }, keyAuth: 'from-the-model' }, { apiBaseUrl });
    expect(loopback.requests.at(-1)!.url).toBe('/json?%7B%22a%22%3A1%7D');
  });

  it('shows why the query is not rewritten through URL.searchParams', async () => {
    const tools = await loadTools(spec);
    const built = buildHttpRequest(tools.get('byJson')!, { q: { a: 1 } }, { baseUrl: apiBaseUrl });
    expect(built.queryString).toBe('%7B%22a%22%3A1%7D');

    // The JSON text is read as a parameter NAME with an empty value, and the pair is added after it
    const url = new URL(built.url);
    url.searchParams.append('api_key', 'k');
    expect(url.search).toBe('?%7B%22a%22%3A1%7D=&api_key=k');
  });
});

describe('e2e helper: sendBuiltRequest, query credentials', () => {
  const spec: any = {
    openapi: '3.2.0',
    info: { title: 'Query API', version: '1.0.0' },
    components: { securitySchemes: { keyAuth: { type: 'apiKey', in: 'query', name: 'api_key' } } },
    paths: {
      '/json': {
        get: {
          operationId: 'byJson',
          security: [{ keyAuth: [] }],
          parameters: [{ name: 'q', in: 'querystring', content: { 'application/json': { schema: { type: 'object' } } } }],
          responses: { '200': { description: 'OK' } },
        },
      },
      '/plain': {
        get: {
          operationId: 'byPlain',
          security: [{ keyAuth: [] }],
          parameters: [{ name: 'path', in: 'query', allowReserved: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'OK' } },
        },
      },
    },
  };

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

  it('appends to the built query without re-encoding it, and refuses a query that is not pairs', async () => {
    const tools = await loadTools(spec);
    const security = await new SecurityResolver().resolve(
      tools.get('byPlain')!.mapper,
      createSecurityContext({ apiKeys: { api_key: 'k 1' } }),
    );

    await sendBuiltRequest(buildHttpRequest(tools.get('byPlain')!, { path: 'a/b' }, { baseUrl }), security);
    expect(loopback.requests.at(-1)!.url).toBe('/plain?path=a/b&api_key=k%201');

    // Nothing to append a pair to: an error, not a corrupted query on the wire
    loopback.reset();
    const json = buildHttpRequest(tools.get('byJson')!, { q: { a: 1 } }, { baseUrl });
    await expect(sendBuiltRequest(json, security)).rejects.toThrow(/Cannot append the query credential\(s\) 'api_key'/);
    expect(loopback.requests).toHaveLength(0);

    // Without a query credential the same request is sent as built
    await sendBuiltRequest(json);
    expect(loopback.requests.at(-1)!.url).toBe('/json?%7B%22a%22%3A1%7D');
  });
});
