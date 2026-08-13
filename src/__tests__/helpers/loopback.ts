/**
 * Shared loopback HTTP server for URL-loading, pinned-transport, and e2e wire
 * tests. A real 127.0.0.1 server (paired with `allowInternalIPs`) replaces
 * `global.fetch` / `$RefParser.dereference` mocks so tests exercise the actual
 * SSRF guard, Node connection pinning, and — for e2e stories — the exact bytes
 * a built request puts on the wire. See CLAUDE.md "Testing Patterns".
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'http';

/**
 * Request handler. The third argument is the fully-buffered request body —
 * handlers that only serve GETs can ignore it (two-param handlers remain
 * assignable).
 */
export type LoopbackHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

/** One request as received on the wire. */
export interface CapturedRequest {
  method: string;
  /** Path + query exactly as received (raw — suitable for encoding assertions). */
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface LoopbackServer {
  /** Bind 127.0.0.1:0 and resolve the `http://127.0.0.1:<port>` base URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
  /** Every request received, in arrival order. */
  readonly requests: CapturedRequest[];
  reset(): void;
}

export function createLoopbackServer(getHandler: () => LoopbackHandler): LoopbackServer {
  const http = require('http') as typeof import('http');
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      getHandler()(req, res, body);
    });
  });
  return {
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`),
        ),
      ),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests,
    reset: () => {
      requests.length = 0;
    },
  };
}
