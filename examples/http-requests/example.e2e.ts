/** Executes the http-requests example and asserts the wire traffic. */
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
