import * as httpMod from 'node:http';
import * as httpsMod from 'node:https';
import { createLoopbackServer, type LoopbackHandler } from './helpers/loopback';
import {
  assertUrlSafe,
  safeFetch,
  isBlockedAddress,
  isBlockedHostname,
  decodeIpv4MappedIpv6,
  normalizeSsrfOptions,
  defaultLookup,
  makePinnedLookup,
  pickHttpModule,
  nodePinnedTransport,
  SsrfResolverUnavailableError,
  type ResolvedSsrfOptions,
  type ResolvedAddress,
  type NodeHttpModules,
} from '../ssrf';
import { SsrfError } from '../errors';

const OPEN: ResolvedSsrfOptions = { allowedHosts: [], blockedHosts: [], allowInternalIPs: false };

const lookupTo = (...addresses: string[]) => {
  return jest.fn(async (): Promise<ResolvedAddress[]> => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
};

interface MockRes {
  status?: number;
  ok?: boolean;
  location?: string;
  body?: string;
}
const mockResponse = (r: MockRes) =>
  ({
    status: r.status,
    ok: r.ok ?? (typeof r.status === 'number' ? r.status >= 200 && r.status < 300 : true),
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? r.location ?? null : null) },
    text: async () => r.body ?? '',
  }) as unknown as Response;

// A shared real HTTP server on loopback, used by the connection-pinning tests.
let serverPort: number;
let serverHandler: LoopbackHandler = (_req, res) => {
  res.writeHead(200);
  res.end('default');
};
const loopback = createLoopbackServer(() => serverHandler);

beforeAll(async () => {
  const baseUrl = await loopback.listen();
  serverPort = Number(new URL(baseUrl).port);
});

afterAll(async () => {
  await loopback.close();
});

beforeEach(() => {
  loopback.reset();
});

describe('ssrf: isBlockedAddress (IP literal ranges)', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '192.0.0.1', // 192.0.0.0/24 IETF protocol assignments
    '198.18.0.1', // benchmarking
    '198.19.255.1', // benchmarking (upper half of 198.18.0.0/15)
    '224.0.0.1', // multicast
    '255.255.255.255',
  ])('blocks internal/reserved IPv4 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '192.0.1.1', '198.20.0.1'])(
    'allows public IPv4 %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it.each(['::1', '[::1]', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1'])('blocks internal IPv6 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '[2001:4860:4860::8888]'])('allows public IPv6 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it('blocks IPv4-mapped IPv6 (dotted and hex) to loopback/metadata', () => {
    expect(isBlockedAddress('[::ffff:127.0.0.1]')).toBe(true);
    expect(isBlockedAddress('[::ffff:7f00:1]')).toBe(true); // hex form of 127.0.0.1
    expect(isBlockedAddress('[::ffff:169.254.169.254]')).toBe(true);
    expect(isBlockedAddress('[::ffff:a9fe:a9fe]')).toBe(true); // hex form of 169.254.169.254
  });

  it('returns false for non-IP hostnames', () => {
    expect(isBlockedAddress('example.com')).toBe(false);
    expect(isBlockedAddress('127.0.0.1.nip.io')).toBe(false); // string is not an IP literal
    expect(isBlockedAddress('256.1.1.1')).toBe(false); // octet out of range -> not a valid IPv4 literal
  });
});

describe('ssrf: decodeIpv4MappedIpv6', () => {
  it('decodes dotted and hex mapped forms', () => {
    expect(decodeIpv4MappedIpv6('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(decodeIpv4MappedIpv6('[::ffff:7f00:1]')).toBe('127.0.0.1');
    expect(decodeIpv4MappedIpv6('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
  });
  it('returns null for non-mapped hosts', () => {
    expect(decodeIpv4MappedIpv6('::1')).toBeNull();
    expect(decodeIpv4MappedIpv6('example.com')).toBeNull();
  });
  it('returns null when the ::ffff: marker is present but the tail is not an IPv4', () => {
    expect(decodeIpv4MappedIpv6('::ffff:not-an-ip')).toBeNull();
    expect(decodeIpv4MappedIpv6('[::ffff:xyz]')).toBeNull();
  });
});

describe('ssrf: isBlockedHostname', () => {
  it('blocks known internal names + literal IPs by default', () => {
    expect(isBlockedHostname('localhost', OPEN)).toBe(true);
    expect(isBlockedHostname('metadata.google.internal', OPEN)).toBe(true);
    expect(isBlockedHostname('127.0.0.1', OPEN)).toBe(true);
    expect(isBlockedHostname('api.example.com', OPEN)).toBe(false);
  });
  it('honors blockedHosts and allowInternalIPs', () => {
    expect(isBlockedHostname('api.example.com', { ...OPEN, blockedHosts: ['api.example.com'] })).toBe(true);
    // allowInternalIPs disables built-in ranges but still honors explicit blockedHosts
    expect(isBlockedHostname('127.0.0.1', { ...OPEN, allowInternalIPs: true })).toBe(false);
    expect(isBlockedHostname('127.0.0.1', { ...OPEN, allowInternalIPs: true, blockedHosts: ['127.0.0.1'] })).toBe(true);
  });
});

describe('ssrf: normalizeSsrfOptions', () => {
  it('fills defaults', () => {
    expect(normalizeSsrfOptions(undefined)).toEqual({ allowedHosts: [], blockedHosts: [], allowInternalIPs: false });
    expect(normalizeSsrfOptions({ allowInternalIPs: true })).toEqual({
      allowedHosts: [],
      blockedHosts: [],
      allowInternalIPs: true,
    });
  });
});

describe('ssrf: assertUrlSafe', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertUrlSafe('file:///etc/passwd', OPEN, lookupTo())).rejects.toThrow(SsrfError);
    await expect(assertUrlSafe('ftp://example.com/x', OPEN, lookupTo())).rejects.toThrow(SsrfError);
  });

  it('rejects literal internal IPs without resolving DNS', async () => {
    const lookup = lookupTo('8.8.8.8');
    await expect(assertUrlSafe('http://127.0.0.1/x', OPEN, lookup)).rejects.toThrow(SsrfError);
    await expect(assertUrlSafe('http://[::1]/x', OPEN, lookup)).rejects.toThrow(SsrfError);
    expect(lookup).not.toHaveBeenCalled(); // literal IPs are decided synchronously
  });

  it('returns [] (nothing to pin) for a public literal IP', async () => {
    const lookup = lookupTo('8.8.8.8');
    await expect(assertUrlSafe('http://93.184.216.34/x', OPEN, lookup)).resolves.toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('returns [] for a public bracketed IPv6 literal (no DNS)', async () => {
    const lookup = lookupTo('::1');
    await expect(assertUrlSafe('http://[2606:4700:4700::1111]/x', OPEN, lookup)).resolves.toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects DNS names that resolve to internal addresses (nip.io class)', async () => {
    const lookup = lookupTo('127.0.0.1');
    await expect(assertUrlSafe('http://127.0.0.1.nip.io/schema.json', OPEN, lookup)).rejects.toThrow(SsrfError);
    expect(lookup).toHaveBeenCalledWith('127.0.0.1.nip.io');
  });

  it('rejects when ANY resolved address is internal (mixed records)', async () => {
    const lookup = lookupTo('93.184.216.34', '10.0.0.5');
    await expect(assertUrlSafe('http://rebind.example/x', OPEN, lookup)).rejects.toThrow(SsrfError);
  });

  it('returns the validated addresses (to pin) for public DNS names', async () => {
    const lookup = lookupTo('93.184.216.34');
    await expect(assertUrlSafe('https://api.example.com/openapi.json', OPEN, lookup)).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('rejects a name that resolves to no address (fail closed)', async () => {
    const lookup = lookupTo(); // resolves to []
    await expect(assertUrlSafe('https://empty.example/x', OPEN, lookup)).rejects.toThrow(/did not resolve/i);
  });

  it('enforces allowedHosts allow-list', async () => {
    const cfg: ResolvedSsrfOptions = { ...OPEN, allowedHosts: ['api.example.com'] };
    await expect(assertUrlSafe('https://evil.example/x', cfg, lookupTo('93.184.216.34'))).rejects.toThrow(SsrfError);
    await expect(assertUrlSafe('https://api.example.com/x', cfg, lookupTo('93.184.216.34'))).resolves.toEqual([
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('honors blockedHosts', async () => {
    const cfg: ResolvedSsrfOptions = { ...OPEN, blockedHosts: ['api.example.com'] };
    await expect(assertUrlSafe('https://api.example.com/x', cfg, lookupTo('93.184.216.34'))).rejects.toThrow(SsrfError);
  });

  it('allowInternalIPs bypasses range + DNS checks (no pinning)', async () => {
    const lookup = lookupTo('127.0.0.1');
    await expect(assertUrlSafe('http://localhost:3000/openapi.json', { ...OPEN, allowInternalIPs: true }, lookup)).resolves.toEqual([]);
    await expect(assertUrlSafe('http://127.0.0.1/x', { ...OPEN, allowInternalIPs: true }, lookup)).resolves.toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('allowInternalIPs still honors explicit blockedHosts', async () => {
    const cfg: ResolvedSsrfOptions = { ...OPEN, allowInternalIPs: true, blockedHosts: ['blocked.internal'] };
    await expect(assertUrlSafe('http://blocked.internal/x', cfg, lookupTo())).rejects.toThrow(SsrfError);
  });

  it('fails CLOSED when the resolver errors (no silent fail-open)', async () => {
    const lookup = jest.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(assertUrlSafe('https://does-not-exist.invalid/x', OPEN, lookup)).rejects.toThrow(SsrfError);
  });

  it('includes the resolver failure detail for a non-Error throw', async () => {
    const lookup = jest.fn(async () => {
      throw 'boom-string';
    });
    await expect(assertUrlSafe('https://weird.example/x', OPEN, lookup)).rejects.toThrow(/boom-string/);
  });

  it('is best-effort (returns []) when no resolver is available on the runtime', async () => {
    const lookup = jest.fn(async () => {
      throw new SsrfResolverUnavailableError('no resolver');
    });
    await expect(assertUrlSafe('https://edge.example/x', OPEN, lookup)).resolves.toEqual([]);
  });

  it('rejects invalid URLs', async () => {
    await expect(assertUrlSafe('not a url', OPEN, lookupTo())).rejects.toThrow(SsrfError);
  });
});

describe('ssrf: safeFetch (fetch-transport path via injected fetchImpl)', () => {
  it('validates the initial URL before fetching', async () => {
    const fetchImpl = jest.fn();
    await expect(safeFetch('http://127.0.0.1/openapi.json', { ssrf: OPEN, fetchImpl, lookup: lookupTo() })).rejects.toThrow(SsrfError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('issues a manual-redirect GET with the provided headers', async () => {
    const fetchImpl = jest.fn(async () => mockResponse({ status: 200, body: '{}' }));
    await safeFetch('https://api.example.com/openapi.json', {
      ssrf: OPEN,
      headers: { 'X-Custom': 'v' },
      fetchImpl,
      lookup: lookupTo('93.184.216.34'),
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/openapi.json',
      expect.objectContaining({ redirect: 'manual', headers: { 'X-Custom': 'v' } }),
    );
  });

  it('follows redirects and re-validates each hop', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: 'https://cdn.example.com/spec.json' }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: '{"ok":true}' }));
    const lookup = lookupTo('93.184.216.34');
    const res = await safeFetch('https://api.example.com/openapi.json', { ssrf: OPEN, fetchImpl, lookup });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // both hops resolved/validated
    expect(lookup).toHaveBeenCalledWith('api.example.com');
    expect(lookup).toHaveBeenCalledWith('cdn.example.com');
  });

  it('refuses a redirect to an internal target', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: 'http://169.254.169.254/latest/meta-data/' }));
    await expect(
      safeFetch('https://api.example.com/openapi.json', { ssrf: OPEN, fetchImpl, lookup: lookupTo('93.184.216.34') }),
    ).rejects.toThrow(SsrfError);
  });

  it('refuses a redirect to a DNS name that resolves internal', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: 'http://127.0.0.1.nip.io/spec.json' }));
    const lookup = jest.fn(async (host: string): Promise<ResolvedAddress[]> =>
      host === 'api.example.com' ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
    );
    await expect(safeFetch('https://api.example.com/openapi.json', { ssrf: OPEN, fetchImpl, lookup })).rejects.toThrow(
      SsrfError,
    );
  });

  it('does not follow redirects when followRedirects=false (returns the 3xx)', async () => {
    const fetchImpl = jest.fn(async () => mockResponse({ status: 302, location: 'https://cdn.example.com/spec.json' }));
    const res = await safeFetch('https://api.example.com/openapi.json', {
      ssrf: OPEN,
      followRedirects: false,
      fetchImpl,
      lookup: lookupTo('93.184.216.34'),
    });
    expect(res.status).toBe(302);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns the response when a redirect has no Location header', async () => {
    const fetchImpl = jest.fn(async () => mockResponse({ status: 302 }));
    const res = await safeFetch('https://api.example.com/openapi.json', {
      ssrf: OPEN,
      fetchImpl,
      lookup: lookupTo('93.184.216.34'),
    });
    expect(res.status).toBe(302);
  });

  it('treats a response with a non-numeric status as non-redirect', async () => {
    const fetchImpl = jest.fn(async () => mockResponse({ body: 'ok' })); // status undefined
    const res = await safeFetch('https://api.example.com/openapi.json', {
      ssrf: OPEN,
      fetchImpl,
      lookup: lookupTo('93.184.216.34'),
    });
    expect(await res.text()).toBe('ok');
  });

  it('throws on redirect loops exceeding maxRedirects', async () => {
    const fetchImpl = jest.fn(async () => mockResponse({ status: 302, location: 'https://api.example.com/again' }));
    await expect(
      safeFetch('https://api.example.com/openapi.json', {
        ssrf: OPEN,
        maxRedirects: 2,
        fetchImpl,
        lookup: lookupTo('93.184.216.34'),
      }),
    ).rejects.toThrow(SsrfError);
  });
});

describe('ssrf: pickHttpModule', () => {
  const modules: NodeHttpModules = { http: httpMod, https: httpsMod };
  it('selects the https module for https: and http otherwise', () => {
    expect(pickHttpModule('https:', modules)).toBe(httpsMod);
    expect(pickHttpModule('http:', modules)).toBe(httpMod);
  });
});

describe('ssrf: makePinnedLookup (connection pin)', () => {
  const pinned: ResolvedAddress[] = [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700::1', family: 6 },
  ];

  it('returns all pinned addresses when options.all is set', () => {
    const cb = jest.fn();
    makePinnedLookup(pinned)('ignored.example', { all: true }, cb);
    expect(cb).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700::1', family: 6 },
    ]);
  });

  it('returns the first pinned address when all is not set', () => {
    const cb = jest.fn();
    makePinnedLookup(pinned)('ignored.example', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('supports the (hostname, callback) two-arg form', () => {
    const cb = jest.fn();
    makePinnedLookup(pinned)('ignored.example', cb);
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });
});

describe('ssrf: defaultLookup', () => {
  it('resolves a hostname via node:dns', async () => {
    const addresses = await defaultLookup('localhost');
    expect(addresses.some((a) => a.address === '127.0.0.1' || a.address === '::1')).toBe(true);
  });
});

describe('ssrf: nodePinnedTransport (real server, connection pinning)', () => {
  const transport = nodePinnedTransport({ http: httpMod, https: httpsMod });
  const freshSignal = () => new AbortController().signal;

  it('pins the socket to the validated IP while preserving the Host header', async () => {
    serverHandler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ host: req.headers.host }));
    };
    // The hostname does NOT resolve to our server; the pin forces the socket to
    // 127.0.0.1. This is the exact primitive the fix guarantees.
    const res = await transport(`http://internal.pinned.invalid:${serverPort}/spec`, {
      headers: { 'x-test': 'yes' },
      signal: freshSignal(),
      pinned: [{ address: '127.0.0.1', family: 4 }],
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.host).toBe(`internal.pinned.invalid:${serverPort}`);
    expect(loopback.requests[0].url).toBe('/spec');
    expect(loopback.requests[0].headers['x-test']).toBe('yes');
  });

  it('connects directly (no pin) to a literal-IP URL', async () => {
    serverHandler = (_req, res) => {
      res.writeHead(200);
      res.end('ok');
    };
    const res = await transport(`http://127.0.0.1:${serverPort}/x`, { signal: freshSignal(), pinned: [] });
    expect(await res.text()).toBe('ok');
  });

  it('returns a null-body Response for a 204', async () => {
    serverHandler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    const res = await transport(`http://127.0.0.1:${serverPort}/x`, { signal: freshSignal(), pinned: [] });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('surfaces multi-value (set-cookie) response headers', async () => {
    serverHandler = (_req, res) => {
      res.setHeader('set-cookie', ['a=1', 'b=2']);
      res.writeHead(200);
      res.end('x');
    };
    const res = await transport(`http://127.0.0.1:${serverPort}/x`, { signal: freshSignal(), pinned: [] });
    expect(res.headers.get('set-cookie')).toContain('a=1');
  });

  it('returns the raw 3xx without following it', async () => {
    serverHandler = (_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/next' });
      res.end();
    };
    const res = await transport(`http://127.0.0.1:${serverPort}/x`, { signal: freshSignal(), pinned: [] });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://127.0.0.1:1/next');
  });

  it('rejects on a connection error', async () => {
    await expect(transport('http://127.0.0.1:1/x', { signal: freshSignal(), pinned: [] })).rejects.toBeDefined();
  });

  it('aborts and rejects when the response body exceeds maxBytes', async () => {
    serverHandler = (_req, res) => {
      res.writeHead(200);
      res.end('x'.repeat(1000));
    };
    await expect(
      transport(`http://127.0.0.1:${serverPort}/big`, { signal: freshSignal(), pinned: [], maxBytes: 100 }),
    ).rejects.toThrow(SsrfError);
  });
});

describe('ssrf: safeFetch over the Node transport (real server)', () => {
  it('loads over node:http even when globalThis.fetch is unavailable', async () => {
    serverHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    };
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = undefined;
    try {
      const res = await safeFetch(`http://127.0.0.1:${serverPort}/spec`, {
        ssrf: { allowedHosts: [], blockedHosts: [], allowInternalIPs: true },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ok":true}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
