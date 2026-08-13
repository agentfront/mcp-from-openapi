/** Executes the arazzo-workflow example against a loopback API. */
import { createLoopbackServer, type LoopbackHandler } from '../../src/__tests__/helpers/loopback';
import type { ArazzoDocument } from 'mcp-from-openapi';
import { loadWorkflowTools, runWorkflow } from './example';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ordersApi: any = {
  openapi: '3.0.0',
  info: { title: 'Orders API', version: '1.0.0' },
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer' } }, required: ['sku'] },
            },
          },
        },
        responses: {
          '201': {
            description: 'Created',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
          },
        },
      },
    },
    '/orders/{orderId}/status': {
      get: {
        operationId: 'getOrderStatus',
        parameters: [{ name: 'orderId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' } } } } },
          },
        },
      },
    },
  },
};

const workflow: ArazzoDocument = {
  arazzo: '1.0.0',
  info: { title: 'Order flows', version: '1.0.0' },
  sourceDescriptions: [{ name: 'orders', url: 'https://example.com/orders.json' }],
  workflows: [
    {
      workflowId: 'placeAndTrack',
      summary: 'Place an order and report its status',
      inputs: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'integer' } }, required: ['sku'] },
      steps: [
        {
          stepId: 'place',
          operationId: 'createOrder',
          requestBody: { contentType: 'application/json', payload: { sku: '$inputs.sku', quantity: '$inputs.quantity' } },
          outputs: { orderId: '$response.body#/id' },
        },
        {
          stepId: 'track',
          operationId: 'getOrderStatus',
          parameters: [{ name: 'orderId', in: 'path', value: '$steps.place.outputs.orderId' }],
          outputs: { status: '$response.body#/status' },
        },
      ],
      outputs: { orderId: '$steps.place.outputs.orderId', status: '$steps.track.outputs.status' },
    },
  ],
};

describe('example: arazzo-workflow', () => {
  const handler: LoopbackHandler = (req, res, body) => {
    if (req.method === 'POST' && req.url === '/orders') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'ord-42', ...JSON.parse(body.toString()) }));
      return;
    }
    if (req.method === 'GET' && req.url === '/orders/ord-42/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'shipped' }));
      return;
    }
    res.writeHead(404);
    res.end();
  };
  const loopback = createLoopbackServer(() => handler);

  afterAll(() => loopback.close());

  it('consolidates the workflow into one tool and executes its IR', async () => {
    const apiBaseUrl = await loopback.listen();

    const [tool] = await loadWorkflowTools(workflow, { orders: ordersApi });
    expect(tool.name).toBe('placeAndTrack');
    // One consolidated tool: workflow inputs are the tool's input schema
    expect(Object.keys((tool.inputSchema as any).properties)).toEqual(['sku', 'quantity']);

    const outputs = await runWorkflow(tool, { sku: 'FLUX-1', quantity: 3 }, apiBaseUrl);
    expect(outputs).toEqual({ orderId: 'ord-42', status: 'shipped' });

    // Step 2's path was built from step 1's response ($response.body#/id)
    expect(loopback.requests.map((request) => request.url)).toEqual(['/orders', '/orders/ord-42/status']);
    expect(JSON.parse(loopback.requests[0].body.toString())).toEqual({ sku: 'FLUX-1', quantity: 3 });
  });
});
