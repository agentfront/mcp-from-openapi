/** Executes the quickstart example against a real loopback API. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLoopbackServer, type LoopbackHandler } from '../../src/__tests__/helpers/loopback';
import { createMcpServer } from './example';

/* eslint-disable @typescript-eslint/no-explicit-any */

const spec: any = {
  openapi: '3.0.0',
  info: { title: 'Widget API', version: '1.0.0' },
  components: {
    securitySchemes: {
      apiAuth: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      queryAuth: { type: 'apiKey', name: 'api_key', in: 'query' },
      cookieAuth: { type: 'apiKey', name: 'sid', in: 'cookie' },
    },
  },
  paths: {
    '/widgets': {
      get: {
        operationId: 'findWidgets',
        security: [{ queryAuth: [] }],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
          },
        },
      },
    },
    '/me': {
      get: {
        operationId: 'getProfile',
        security: [{ cookieAuth: [] }],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
          },
        },
      },
    },
    '/widgets/{widgetId}': {
      get: {
        operationId: 'getWidget',
        security: [{ apiAuth: [] }],
        parameters: [{ name: 'widgetId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id'] },
              },
            },
          },
        },
      },
    },
  },
};

describe('example: quickstart-mcp-server', () => {
  const widget = { id: 'w1', name: 'Flux Widget' };
  const handler: LoopbackHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(widget));
  };
  const loopback = createLoopbackServer(() => handler);
  let apiBaseUrl: string;

  beforeAll(async () => {
    apiBaseUrl = await loopback.listen();
  });
  afterAll(() => loopback.close());

  it('serves generated tools over MCP and proxies calls with credentials', async () => {
    const { server, tools } = await createMcpServer({ spec, apiBaseUrl, auth: { apiKey: 'secret-key' } });
    expect(tools.map((t) => t.name)).toEqual(['getProfile', 'findWidgets', 'getWidget']);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'example-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(['getProfile', 'findWidgets', 'getWidget']);

      const result = await client.callTool({ name: 'getWidget', arguments: { widgetId: 'w1' } });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual(widget);

      const captured = loopback.requests.at(-1)!;
      expect(captured.url).toBe('/widgets/w1');
      expect(captured.headers['x-api-key']).toBe('secret-key');

      // A query credential joins the query buildHttpRequest built, next to the tool's own parameter
      const found = await client.callTool({ name: 'findWidgets', arguments: { limit: 2 } });
      expect(found.isError).toBe(false);
      expect(loopback.requests.at(-1)!.url).toBe('/widgets?limit=2&api_key=secret-key');

      const unknown = await client.callTool({ name: 'nope', arguments: {} });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  describe('cookies from the security context', () => {
    // A server and a connected client for one set of credentials
    async function connect(auth: Parameters<typeof createMcpServer>[0]['auth']) {
      const { server } = await createMcpServer({ spec, apiBaseUrl, auth });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: 'example-client', version: '1.0.0' });
      await client.connect(clientTransport);
      return { client, close: () => Promise.all([client.close(), server.close()]) };
    }

    beforeEach(() => loopback.reset());

    it('sends a context cookie that no security scheme names, alongside the credentials that are', async () => {
      const { client, close } = await connect({ apiKey: 'secret-key', cookies: { session: 's1', locale: 'en' } });
      try {
        // getWidget has a header scheme and no cookie scheme: the context cookies still go out
        await client.callTool({ name: 'getWidget', arguments: { widgetId: 'w1' } });
        let captured = loopback.requests.at(-1)!;
        expect(captured.url).toBe('/widgets/w1');
        expect(captured.headers['x-api-key']).toBe('secret-key');
        expect(captured.headers.cookie).toBe('session=s1; locale=en');

        // They never reach the query string: the credential and the tool's own parameter are as built
        await client.callTool({ name: 'findWidgets', arguments: { limit: 2 } });
        captured = loopback.requests.at(-1)!;
        expect(captured.url).toBe('/widgets?limit=2&api_key=secret-key');
        expect(captured.headers.cookie).toBe('session=s1; locale=en');

        // getProfile has a cookie scheme: its cookie is placed by buildHttpRequest, the others join it
        await client.callTool({ name: 'getProfile', arguments: {} });
        expect(loopback.requests.at(-1)!.headers.cookie).toBe('sid=secret-key; session=s1; locale=en');
      } finally {
        await close();
      }
    });

    it('sends a cookie once when the context names the one a scheme places', async () => {
      const { client, close } = await connect({ apiKey: 'secret-key', cookies: { sid: 'from-context', session: 's1' } });
      try {
        await client.callTool({ name: 'getProfile', arguments: {} });
        expect(loopback.requests.at(-1)!.headers.cookie).toBe('sid=from-context; session=s1');
      } finally {
        await close();
      }
    });

    it('sends no Cookie header when the context has no cookies', async () => {
      const { client, close } = await connect({ apiKey: 'secret-key' });
      try {
        await client.callTool({ name: 'getWidget', arguments: { widgetId: 'w1' } });
        expect(loopback.requests.at(-1)!.headers.cookie).toBeUndefined();
      } finally {
        await close();
      }
    });

    it('refuses a context cookie that would forge another, and sends nothing', async () => {
      const { client, close } = await connect({ apiKey: 'secret-key', cookies: { session: 's1; admin=1' } });
      try {
        await expect(client.callTool({ name: 'getWidget', arguments: { widgetId: 'w1' } })).rejects.toThrow(
          /Cookie 'session' cannot be sent/,
        );
        expect(loopback.requests).toHaveLength(0);
      } finally {
        await close();
      }
    });
  });
});
