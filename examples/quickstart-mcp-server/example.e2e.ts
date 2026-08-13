/** Executes the quickstart example against a real loopback API. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLoopbackServer, type LoopbackHandler } from '../../src/__tests__/helpers/loopback';
import { createMcpServer } from './example';

/* eslint-disable @typescript-eslint/no-explicit-any */

const spec: any = {
  openapi: '3.0.0',
  info: { title: 'Widget API', version: '1.0.0' },
  components: { securitySchemes: { apiAuth: { type: 'apiKey', name: 'X-API-Key', in: 'header' } } },
  paths: {
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

  afterAll(() => loopback.close());

  it('serves generated tools over MCP and proxies calls with credentials', async () => {
    const apiBaseUrl = await loopback.listen();
    const { server, tools } = await createMcpServer({ spec, apiBaseUrl, auth: { apiKey: 'secret-key' } });
    expect(tools.map((t) => t.name)).toEqual(['getWidget']);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'example-client', version: '1.0.0' });
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(['getWidget']);

      const result = await client.callTool({ name: 'getWidget', arguments: { widgetId: 'w1' } });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual(widget);

      const captured = loopback.requests.at(-1)!;
      expect(captured.url).toBe('/widgets/w1');
      expect(captured.headers['x-api-key']).toBe('secret-key');

      const unknown = await client.callTool({ name: 'nope', arguments: {} });
      expect(unknown.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
