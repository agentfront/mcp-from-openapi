/**
 * Arazzo story: a workflow IR produced by fromArazzo() is genuinely
 * executable — a minimal in-test executor drives it over real loopback HTTP,
 * proving `$inputs`, `$steps.*.outputs.*`, and `$response.body#/pointers`
 * evaluate all the way onto the wire.
 */
import { fromArazzo } from '../src';
import type { ArazzoDocument } from '../src';
import { createLoopbackServer, type LoopbackHandler } from '../src/__tests__/helpers/loopback';
import { loadFixture } from './helpers/fixtures';
import { executeWorkflow } from './helpers/arazzo-executor';
import * as yaml from 'yaml';

const arazzoDoc: ArazzoDocument = {
  arazzo: '1.0.0',
  info: { title: 'Order flows', version: '1.0.0' },
  sourceDescriptions: [{ name: 'petstore', url: 'https://example.com/petstore.yaml' }],
  workflows: [
    {
      workflowId: 'orderAndFetch',
      summary: 'Place an order, then fetch it back',
      inputs: {
        type: 'object',
        properties: { petId: { type: 'integer' }, quantity: { type: 'integer' } },
        required: ['petId', 'quantity'],
      },
      steps: [
        {
          stepId: 'place',
          operationId: 'placeOrder',
          requestBody: {
            contentType: 'application/json',
            payload: { petId: '$inputs.petId', quantity: '$inputs.quantity', status: 'placed' },
          },
          outputs: { orderId: '$response.body#/id' },
        },
        {
          stepId: 'fetch',
          operationId: 'getOrderById',
          parameters: [{ name: 'orderId', in: 'path', value: '$steps.place.outputs.orderId' }],
          outputs: { order: '$response.body', code: '$statusCode' },
        },
      ],
      outputs: { order: '$steps.fetch.outputs.order', orderId: '$steps.place.outputs.orderId' },
    },
  ],
};

describe('story: Arazzo workflow IR drives real HTTP', () => {
  const orders = new Map<number, Record<string, unknown>>();
  let nextId = 7;
  const handler: LoopbackHandler = (req, res, body) => {
    if (req.method === 'POST' && req.url === '/store/order') {
      const order = { id: nextId++, ...JSON.parse(body.toString()), complete: false };
      orders.set(order.id as number, order);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(order));
      return;
    }
    const match = req.url?.match(/^\/store\/order\/(\d+)$/);
    if (req.method === 'GET' && match) {
      const order = orders.get(Number(match[1]));
      res.writeHead(order ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(order ?? { message: 'not found' }));
      return;
    }
    res.writeHead(500);
    res.end();
  };
  const loopback = createLoopbackServer(() => handler);

  afterAll(() => loopback.close());

  it('realizes workflow outputs end-to-end', async () => {
    const baseUrl = await loopback.listen();
    const petstore = yaml.parse(loadFixture('petstore-3.0.yaml'));
    const [workflowTool] = await fromArazzo(arazzoDoc, { sources: { petstore } });

    expect(workflowTool.name).toBe('orderAndFetch');
    expect(workflowTool.metadata.workflow!.steps).toHaveLength(2);

    const run = await executeWorkflow(workflowTool, { petId: 42, quantity: 2 }, baseUrl);

    // step 1: the payload with $inputs substituted reached the wire
    const posted = loopback.requests[0];
    expect(posted.method).toBe('POST');
    expect(posted.url).toBe('/store/order');
    expect(JSON.parse(posted.body.toString())).toEqual({ petId: 42, quantity: 2, status: 'placed' });

    // step 2: $response.body#/id from step 1 became the path parameter
    const fetched = loopback.requests[1];
    expect(fetched.method).toBe('GET');
    expect(fetched.url).toBe('/store/order/7');

    expect(run.steps['place'].outputs['orderId']).toBe(7);
    expect(run.steps['fetch'].outputs['code']).toBe(200);
    expect(run.outputs['orderId']).toBe(7);
    expect(run.outputs['order']).toEqual({ id: 7, petId: 42, quantity: 2, status: 'placed', complete: false });
  });
});
