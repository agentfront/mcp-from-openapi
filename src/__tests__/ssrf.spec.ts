import {
  assertUrlSafe,
  safeFetch,
  isBlockedAddress,
  isBlockedHostname,
  decodeIpv4MappedIpv6,
  normalizeSsrfOptions,
  type ResolvedSsrfOptions,
  type ResolvedAddress,
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
    '198.18.0.1', // benchmarking
    '224.0.0.1', // multicast
    '255.255.255.255',
  ])('blocks internal/reserved IPv4 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1'])(
    'allows public IPv4 %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it.each(['::1', '[::1]', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1'])('blocks internal IPv6 %s', (ip) => {
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

  it('rejects DNS names that resolve to internal addresses (nip.io class)', async () => {
    const lookup = lookupTo('127.0.0.1');
    await expect(assertUrlSafe('http://127.0.0.1.nip.io/schema.json', OPEN, lookup)).rejects.toThrow(SsrfError);
    expect(lookup).toHaveBeenCalledWith('127.0.0.1.nip.io');
  });

  it('rejects when ANY resolved address is internal (mixed records)', async () => {
    const lookup = lookupTo('93.184.216.34', '10.0.0.5');
    await expect(assertUrlSafe('http://rebind.example/x', OPEN, lookup)).rejects.toThrow(SsrfError);
  });

  it('allows DNS names that resolve to public addresses', async () => {
    const lookup = lookupTo('93.184.216.34');
    await expect(assertUrlSafe('https://api.example.com/openapi.json', OPEN, lookup)).resolves.toBeUndefined();
  });

  it('enforces allowedHosts allow-list', async () => {
    const cfg: ResolvedSsrfOptions = { ...OPEN, allowedHosts: ['api.example.com'] };
    await expect(assertUrlSafe('https://evil.example/x', cfg, lookupTo('93.184.216.34'))).rejects.toThrow(SsrfError);
    await expect(assertUrlSafe('https://api.example.com/x', cfg, lookupTo('93.184.216.34'))).resolves.toBeUndefined();
  });

  it('honors blockedHosts', async () => {
    const cfg: ResolvedSsrfOptions = { ...OPEN, blockedHosts: ['api.example.com'] };
    await expect(assertUrlSafe('https://api.example.com/x', cfg, lookupTo('93.184.216.34'))).rejects.toThrow(SsrfError);
  });

  it('allowInternalIPs bypasses range + DNS checks', async () => {
    const lookup = lookupTo('127.0.0.1');
    await expect(assertUrlSafe('http://localhost:3000/openapi.json', { ...OPEN, allowInternalIPs: true }, lookup)).resolves.toBeUndefined();
    await expect(assertUrlSafe('http://127.0.0.1/x', { ...OPEN, allowInternalIPs: true }, lookup)).resolves.toBeUndefined();
  });

  it('fails open when DNS resolution errors (host cannot be fetched anyway)', async () => {
    const lookup = jest.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(assertUrlSafe('https://does-not-exist.invalid/x', OPEN, lookup)).resolves.toBeUndefined();
  });

  it('rejects invalid URLs', async () => {
    await expect(assertUrlSafe('not a url', OPEN, lookupTo())).rejects.toThrow(SsrfError);
  });
});

describe('ssrf: safeFetch', () => {
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

  it('throws if no fetch implementation is available', async () => {
    const original = globalThis.fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = undefined;
    try {
      await expect(
        safeFetch('https://api.example.com/openapi.json', { ssrf: OPEN, lookup: lookupTo('93.184.216.34') }),
      ).rejects.toThrow(SsrfError);
    } finally {
      globalThis.fetch = original;
    }
  });
});
