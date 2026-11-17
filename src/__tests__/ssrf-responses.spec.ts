import * as net from 'node:net';
import { LoadError, ParseError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import { normalizeSsrfOptions, safeFetch } from '../ssrf';

const INTERNAL_ALLOWED = normalizeSsrfOptions({ allowInternalIPs: true });

interface RawServer {
  baseUrl: string;
  close(): Promise<void>;
}

function startRawServer(statusLines: Record<string, string>): Promise<RawServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('data', (data) => {
      const requestPath = String(data).split(' ')[1].replace(/\.json$/, '');
      const statusLine = statusLines[requestPath] ?? 'HTTP/1.1 404 Not Found';
      if (requestPath === '/upgrade' || requestPath === '/interim') {
        socket.write(Buffer.from(`${statusLine}\r\n\r\n`, 'latin1'));
        return;
      }
      if (requestPath === '/close') {
        socket.destroy();
        return;
      }
      const head = `${statusLine}\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}`;
      socket.end(Buffer.from(head, 'latin1'));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

const STATUS_LINES: Record<string, string> = {
  '/status-999': 'HTTP/1.1 999 Request Denied',
  '/status-600': 'HTTP/1.1 600 Unknown',
  '/status-000': 'HTTP/1.1 000 Zero',
  '/reason-escape': 'HTTP/1.1 200 O\u001bK',
  '/reason-delete': 'HTTP/1.1 200 O\u007fK',
  '/reason-plain': 'HTTP/1.1 200 Fine',
  '/upgrade': 'HTTP/1.1 101 Switching Protocols\r\nupgrade: other\r\nconnection: upgrade',
  '/interim': 'HTTP/1.1 100 Continue',
};

describe('the pinned transport settles on every response a server can send', () => {
  let server: RawServer;
  let uncaught: unknown[];
  const recordUncaught = (error: unknown): void => {
    uncaught.push(error);
  };

  beforeAll(async () => {
    server = await startRawServer(STATUS_LINES);
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    uncaught = [];
    process.on('uncaughtException', recordUncaught);
  });

  afterEach(() => {
    process.off('uncaughtException', recordUncaught);
    expect(uncaught).toEqual([]);
  });

  it.each(['/status-999', '/status-600', '/status-000'])('rejects a final status outside 200-599 (%s)', async (path) => {
    await expect(safeFetch(`${server.baseUrl}${path}`, { ssrf: INTERNAL_ALLOWED, timeoutMs: 3000 })).rejects.toThrow(
      /status/,
    );
  });

  it.each(['/reason-escape', '/reason-delete'])('keeps the response and drops a reason phrase it cannot carry (%s)', async (path) => {
    const response = await safeFetch(`${server.baseUrl}${path}`, { ssrf: INTERNAL_ALLOWED, timeoutMs: 3000 });
    expect(response.status).toBe(200);
    expect(response.statusText).toBe('');
    expect(await response.text()).toBe('{}');
  });

  it('keeps a reason phrase it can carry', async () => {
    const response = await safeFetch(`${server.baseUrl}/reason-plain`, { ssrf: INTERNAL_ALLOWED, timeoutMs: 3000 });
    expect(response.statusText).toBe('Fine');
  });

  it('rejects a switch of protocols instead of waiting forever', async () => {
    const started = Date.now();
    await expect(safeFetch(`${server.baseUrl}/upgrade`, { ssrf: INTERNAL_ALLOWED, timeoutMs: 3000 })).rejects.toThrow(
      /switched protocols/,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects a connection closed before any response', async () => {
    await expect(safeFetch(`${server.baseUrl}/close`, { ssrf: INTERNAL_ALLOWED, timeoutMs: 3000 })).rejects.toThrow();
  });

  it('gives up on an interim response that is never followed by a final one, at the timeout', async () => {
    await expect(safeFetch(`${server.baseUrl}/interim`, { ssrf: INTERNAL_ALLOWED, timeoutMs: 300 })).rejects.toThrow();
  });

  it('fromURL rejects with a LoadError for a status outside 200-599', async () => {
    await expect(
      OpenAPIToolGenerator.fromURL(`${server.baseUrl}/status-999`, {
        refResolution: { allowInternalIPs: true },
        timeout: 3000,
      }),
    ).rejects.toThrow(LoadError);
  });

  it('a $ref answered with a status outside 200-599 is a ParseError with the fetch-failed rule', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: {
          '/p': {
            get: {
              responses: {
                200: {
                  description: 'ok',
                  content: { 'application/json': { schema: { $ref: `${server.baseUrl}/status-999.json` } } },
                },
              },
            },
          },
        },
      },
      { refResolution: { allowInternalIPs: true }, timeout: 3000 },
    );
    const failure = await generator.generateTools().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ParseError);
    expect((failure as ParseError).context).toMatchObject({ rule: 'fetch-failed' });
  });

  it('validate() reports a $ref that switches protocols as unreadable', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: {
          '/p': {
            get: {
              responses: {
                200: {
                  description: 'ok',
                  content: { 'application/json': { schema: { $ref: `${server.baseUrl}/upgrade.json` } } },
                },
              },
            },
          },
        },
      },
      { refResolution: { allowInternalIPs: true }, timeout: 3000 },
    );
    const result = await generator.validate();
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.code).toBe('UNREADABLE_REFERENCE');
  });
});
