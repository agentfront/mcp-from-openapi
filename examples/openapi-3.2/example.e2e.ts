/** Executes the openapi-3.2 example and asserts what reaches the wire. */
import { createLoopbackServer, type LoopbackHandler } from '../../src/__tests__/helpers/loopback';
import { callTool, diagnosticsOf, filesApi, loadTools, streamItems, type EventItem } from './example';

describe('example: openapi-3.2', () => {
  // The stream handler writes the first event, then waits for the test before
  // writing the second: the test can only see the first item if it is read
  // while the response is still open.
  let releaseSecondEvent!: () => void;
  const secondEventReleased = new Promise<void>((resolve) => (releaseSecondEvent = resolve));

  const handler: LoopbackHandler = (req, res) => {
    const target = `${req.method} ${req.url}`;
    if (target === 'GET /files/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive\n\nevent: created\ndata: {"name":"a.txt"}\nid: 1\n\n');
      void secondEventReleased.then(() => res.end('event: deleted\ndata: {"name":"a.txt"}\nid: 2\n\n'));
    } else if (target === 'QUERY /files/search' || target.startsWith('GET /files?')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ total: 2 }));
    } else if (target === 'LINK /files/7') {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  };
  const loopback = createLoopbackServer(() => handler);
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await loopback.listen();
  });
  afterAll(async () => {
    // A test that failed before releasing the gate leaves a response open, and close() waits for it
    releaseSecondEvent();
    await loopback.close();
  });
  beforeEach(() => loopback.reset());

  it('generates a tool for each 3.2 shape', async () => {
    const { tools, generator } = await loadTools(filesApi('3.2.0'));

    expect([...tools.values()].map((t) => [t.name, t.metadata.method, t.annotations?.readOnlyHint])).toEqual([
      ['listFiles', 'get', true],
      ['watchFiles', 'get', true],
      ['searchFiles', 'query', true], // safe and idempotent, like GET
      ['linkFile', 'LINK', false], // an unknown method is treated like POST
    ]);
    expect(generator.getDiagnostics()).toEqual([]);
  });

  it('sends the QUERY operation with its JSON body', async () => {
    const { tools } = await loadTools(filesApi('3.2.0'));

    const result = await callTool(tools.get('searchFiles')!, { text: 'report', limit: 5 }, baseUrl);

    expect(result).toEqual({ status: 200, body: '{"total":2}' });
    const wire = loopback.requests.at(-1)!;
    expect(wire.method).toBe('QUERY');
    expect(wire.url).toBe('/files/search');
    expect(wire.headers['content-type']).toBe('application/json');
    expect(wire.body.toString()).toBe('{"text":"report","limit":5}');
  });

  it('sends the additionalOperations method exactly as written', async () => {
    const { tools } = await loadTools(filesApi('3.2.0'));

    const result = await callTool(tools.get('linkFile')!, { id: '7', Link: '<https://example.com/b>; rel="related"' }, baseUrl);

    expect(result.status).toBe(204);
    const wire = loopback.requests.at(-1)!;
    expect(wire.method).toBe('LINK');
    expect(wire.url).toBe('/files/7');
    expect(wire.headers['link']).toBe('<https://example.com/b>; rel="related"');
  });

  it('turns the querystring parameter into one input that is the whole query string', async () => {
    const { tools } = await loadTools(filesApi('3.2.0'));
    const list = tools.get('listFiles')!;

    expect(list.mapper).toEqual([
      {
        inputKey: 'filter',
        type: 'query',
        key: 'filter',
        required: false,
        serialization: { contentType: 'application/x-www-form-urlencoded' },
        wholeQuery: true,
      },
    ]);

    await callTool(list, { filter: { name: 'annual report', tag: ['a', 'b'] } }, baseUrl);

    // The properties of the one input are the name=value pairs, form-encoded
    expect(loopback.requests.at(-1)!.url).toBe('/files?name=annual+report&tag=a&tag=b');
  });

  it('describes the stream in metadata instead of an outputSchema, and consumes it item by item', async () => {
    const { tools } = await loadTools(filesApi('3.2.0'));
    const watch = tools.get('watchFiles')!;

    expect(watch.outputSchema).toBeUndefined();
    expect(watch.metadata.responseHints?.streaming).toBe(true);
    expect(watch.metadata.responseStream).toEqual({
      statusCode: 200,
      contentType: 'text/event-stream',
      itemSchema: {
        type: 'object',
        properties: {
          event: { type: 'string', enum: ['created', 'deleted'] },
          data: { type: 'string' },
          id: { type: 'string' },
        },
        required: ['event', 'data'],
      },
    });

    const items = streamItems(watch, baseUrl);
    // The first item arrives while the server is still holding the response open
    const first = await items.next();
    expect(first.value).toEqual({ event: 'created', data: '{"name":"a.txt"}', id: '1' });

    releaseSecondEvent();
    const rest: EventItem[] = [];
    for await (const item of items) rest.push(item);
    expect(rest).toEqual([{ event: 'deleted', data: '{"name":"a.txt"}', id: '2' }]);

    const wire = loopback.requests.at(-1)!;
    expect(wire.method).toBe('GET');
    expect(wire.headers.accept).toBe('text/event-stream');
  });

  it('yields only the events a stream dispatches, and reads their fields as the SSE rules do', async () => {
    const { tools } = await loadTools(filesApi('3.2.0'));
    const blocks = [
      ': keepalive', // a comment
      'retry: 3000', // no data: sets the reconnection time, dispatches nothing
      'id: 9', // no data
      'event: created', // no data: not an event, whatever its other fields
      'event: created\ndata: {"name":"a.txt"}\nid: 1\nretry: 3000', // retry is an integer
      'event: deleted\ndata', // a field name with no colon has an empty value, so data is ''
      'event: deleted\ndata: line one\ndata: line two\nretry: soon\nunknown: ignored', // data joins with LF; a retry that is not digits is ignored
    ];
    const serve: LoopbackHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(blocks.map((block) => `${block}\n\n`).join(''));
    };
    const other = createLoopbackServer(() => serve);
    try {
      const items: EventItem[] = [];
      for await (const item of streamItems(tools.get('watchFiles')!, await other.listen())) items.push(item);
      expect(items).toEqual([
        { event: 'created', data: '{"name":"a.txt"}', id: '1', retry: 3000 },
        { event: 'deleted', data: '' },
        { event: 'deleted', data: 'line one\nline two' },
      ]);
    } finally {
      await other.close();
    }
  });

  it('rejects an item that does not match the itemSchema', async () => {
    const { tools } = await loadTools(filesApi('3.2.0'));
    const bad: LoopbackHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: renamed\ndata: x\n\n'); // not in the event enum
    };
    const other = createLoopbackServer(() => bad);
    try {
      const items = streamItems(tools.get('watchFiles')!, await other.listen());
      await expect(items.next()).rejects.toThrow(/does not match itemSchema.*\/event must be equal to one of the allowed values/);
    } finally {
      await other.close();
    }
  });

  it('ignores query and additionalOperations when the document declares 3.1, and says so', async () => {
    const { tools } = await loadTools(filesApi('3.1.0'));
    expect([...tools.keys()]).toEqual(['listFiles', 'watchFiles']);

    expect(await diagnosticsOf(filesApi('3.1.0'))).toEqual([
      'warning FEATURE_NEWER_THAN_DECLARED_VERSION /paths/~1files/get/parameters/0/in',
      'warning FEATURE_NEWER_THAN_DECLARED_VERSION /paths/~1files~1search/query',
      'warning NO_OPERATIONS /paths//files/search',
      'warning FEATURE_NEWER_THAN_DECLARED_VERSION /paths/~1files~1{id}/additionalOperations',
      'warning NO_OPERATIONS /paths//files/{id}',
    ]);
    expect(await diagnosticsOf(filesApi('3.2.0'))).toEqual([]);
  });
});
