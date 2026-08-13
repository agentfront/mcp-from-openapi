/** Executes the secure-loading example against loopback and hostile URLs. */
import { createLoopbackServer, type LoopbackHandler } from '../../src/__tests__/helpers/loopback';
import { loadUntrustedSpec, tryLoad } from './example';

const spec = {
  openapi: '3.0.0',
  info: { title: 'Public API', version: '1.0.0' },
  paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'OK' } } } } },
};

describe('example: secure-loading', () => {
  const handler: LoopbackHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(spec));
  };
  const loopback = createLoopbackServer(() => handler);

  afterAll(() => loopback.close());

  it('blocks internal addresses by default and classifies the failure', async () => {
    // Cloud metadata endpoint — the classic SSRF target
    const result = await tryLoad('http://169.254.169.254/openapi.json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
    }
  });

  it('loads from an explicitly allowed loopback host', async () => {
    const baseUrl = await loopback.listen();
    // Internal access is opt-in, and the host allowlist restricts the
    // exception to loopback — never disable the block globally on its own
    const tools = await loadUntrustedSpec(`${baseUrl}/openapi.json`, {
      refResolution: { allowInternalIPs: true, allowedHosts: ['127.0.0.1'] },
    });
    expect(tools.map((tool) => tool.name)).toEqual(['ping']);
  });
});
