/**
 * SSRF protection for spec loading and external `$ref` resolution.
 *
 * The generator fetches two kinds of attacker-influenceable URLs:
 *   1. the OpenAPI spec itself (`fromURL`), and
 *   2. external `$ref` targets during dereferencing.
 *
 * A hostname-string denylist (the pre-2.5 approach) is bypassable, as reported
 * in GHSA-65h7-9wrw-629c:
 *   - DNS names that resolve to internal IPs, e.g. `http://127.0.0.1.nip.io/`
 *     — the literal-string `127.0.0.1` patterns never match, yet the name
 *     resolves to loopback;
 *   - IPv4-mapped IPv6 forms (handled since 2.4 via {@link decodeIpv4MappedIpv6});
 *   - redirects from an allowed host to an internal one.
 *
 * This module validates the **resolved IP**, not just the hostname string:
 *   - parses/normalizes IPv4 (incl. numeric/hex/octal forms canonicalized by
 *     `new URL()`) and IPv4-mapped IPv6 before range checks;
 *   - blocks loopback / private (RFC 1918) / CGNAT (RFC 6598) / link-local /
 *     multicast / unspecified / reserved ranges and cloud-metadata endpoints;
 *   - resolves the hostname (Node, via `node:dns`) and rejects if **any**
 *     resolved address is internal — closing the DNS-name-to-internal bypass;
 *   - re-validates every redirect hop ({@link safeFetch}) instead of letting the
 *     HTTP client follow 3xx blindly.
 *
 * Node-aware: DNS resolution lazily imports `node:dns` and is a no-op on
 * runtimes without it (Web/edge), where the literal-address checks still apply.
 *
 * Residual: this does DNS resolve-then-fetch without connection-level IP
 * pinning, so a sub-second DNS-rebinding race (flip the record between the
 * validating resolve and the client's connect-time resolve) is not fully
 * eliminated. For fully-untrusted inputs, combine with an `allowedHosts`
 * allow-list and network egress controls.
 */

import type { RefResolutionOptions } from './types';
import { SsrfError } from './errors';

/** The subset of {@link RefResolutionOptions} relevant to address blocking. */
export interface ResolvedSsrfOptions {
  allowedHosts: string[];
  blockedHosts: string[];
  allowInternalIPs: boolean;
}

/** Resolved DNS address shape (subset of Node's `dns.LookupAddress`). */
export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Hostname → resolved addresses. Injectable for testing. */
export type SsrfHostLookup = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * Non-IP hostnames that map to internal targets, so the IP-range checks alone
 * would miss them when DNS resolution is unavailable. DNS resolution (when
 * available) also catches these; this set is defense-in-depth.
 */
export const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
]);

/** Normalize a (possibly undefined) {@link RefResolutionOptions} to the SSRF subset. */
export function normalizeSsrfOptions(refResolution?: RefResolutionOptions): ResolvedSsrfOptions {
  return {
    allowedHosts: refResolution?.allowedHosts ?? [],
    blockedHosts: refResolution?.blockedHosts ?? [],
    allowInternalIPs: refResolution?.allowInternalIPs ?? false,
  };
}

/**
 * Decode an IPv4-mapped IPv6 host (`::ffff:169.254.169.254` or its hex form
 * `::ffff:a9fe:a9fe`, optionally bracketed) to its embedded dotted-quad IPv4, or
 * `null` if the host isn't IPv4-mapped. `new URL().hostname` normalizes
 * `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, which the plain
 * dotted-quad range checks would otherwise miss.
 */
export function decodeIpv4MappedIpv6(hostname: string): string | null {
  let h = hostname;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const lower = h.toLowerCase();
  const marker = lower.lastIndexOf('::ffff:');
  if (marker === -1) return null;
  const tail = lower.slice(marker + '::ffff:'.length);
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return tail;
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** Parse a dotted-quad IPv4 string into octets, or `null` if not valid IPv4. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets: [number, number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((n) => n > 255)) return null;
  return octets;
}

/** Is this dotted-quad IPv4 in a blocked (non-public) range? */
function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network" / unspecified
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT (RFC 6598)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

/** Is this IPv6 host (bracketed or not, possibly zoned) in a blocked range? */
function isBlockedIpv6(host: string): boolean {
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);
  const lower = h.toLowerCase();
  if (lower === '::' || lower === '::0') return true; // unspecified
  if (lower === '::1') return true; // loopback
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 ULA (fc/fd)
  if (/^fe[89a-f]/.test(lower)) return true; // fe80::/10 link-local + fec0::/10 site-local
  if (/^ff/.test(lower)) return true; // ff00::/8 multicast
  return false;
}

/**
 * Predicate: is `host` (an IP literal — dotted-quad IPv4, bracketed/zoned IPv6,
 * or IPv4-mapped IPv6) in a blocked, non-public range? Returns `false` for
 * non-IP-literal hostnames (use DNS resolution for those).
 */
export function isBlockedAddress(host: string): boolean {
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);

  // IPv4-mapped IPv6 → re-check as the embedded IPv4.
  const mapped = decodeIpv4MappedIpv6(host);
  if (mapped) {
    const o = parseIpv4(mapped);
    if (o) return isBlockedIpv4(o);
  }

  const v4 = parseIpv4(h);
  if (v4) return isBlockedIpv4(v4);

  if (h.includes(':')) return isBlockedIpv6(h);

  return false;
}

/** Is the hostname a literal IP address (vs a DNS name)? */
function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true; // IPv6 literal
  return parseIpv4(hostname) !== null;
}

/**
 * Synchronous host check used by the `$RefParser` `canRead` filter (which cannot
 * be async). Blocks known internal hostnames, explicit `blockedHosts`, and
 * literal internal IPs (incl. IPv4-mapped IPv6). DNS names that *resolve* to
 * internal addresses are caught later, asynchronously, in {@link safeFetch}.
 */
export function isBlockedHostname(hostname: string, ssrf: ResolvedSsrfOptions): boolean {
  if (ssrf.allowInternalIPs) {
    return ssrf.blockedHosts.includes(hostname);
  }
  if (ssrf.blockedHosts.includes(hostname)) return true;

  const lower = hostname.toLowerCase();
  const stripped = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (BLOCKED_HOSTNAMES.has(lower) || BLOCKED_HOSTNAMES.has(stripped)) return true;

  return isBlockedAddress(hostname);
}

/** Default DNS resolver: lazily loads `node:dns`; rejects on non-Node runtimes. */
export const defaultLookup: SsrfHostLookup = async (hostname) => {
  const dns = await import('node:dns');
  return dns.promises.lookup(hostname, { all: true });
};

/**
 * Validate that `url` is safe to fetch (spec URL or `$ref` target), throwing
 * {@link SsrfError} if not. Enforces http/https, the `allowedHosts` allow-list,
 * the internal-address denylist, and — for DNS names — resolves and rejects if
 * any resolved address is internal.
 */
export async function assertUrlSafe(
  url: string,
  ssrf: ResolvedSsrfOptions,
  lookup: SsrfHostLookup = defaultLookup,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError(`Invalid spec URL: ${url}`, { url });
  }

  const protocol = parsed.protocol.replace(/:$/, '');
  if (protocol !== 'http' && protocol !== 'https') {
    throw new SsrfError(`Protocol "${protocol}" is not allowed for network spec loading (only http/https)`, { url });
  }

  const hostname = parsed.hostname;
  if (ssrf.allowedHosts.length > 0 && !ssrf.allowedHosts.includes(hostname)) {
    throw new SsrfError(`Host "${hostname}" is not in the allowed-hosts list`, { url });
  }

  if (ssrf.allowInternalIPs) {
    if (ssrf.blockedHosts.includes(hostname)) {
      throw new SsrfError(`Host "${hostname}" is blocked`, { url });
    }
    return;
  }

  if (isBlockedHostname(hostname, ssrf)) {
    throw new SsrfError(`Host "${hostname}" maps to a blocked internal address`, { url });
  }

  // For DNS names, resolve and reject if any resolved address is internal. This
  // is what closes the `127.0.0.1.nip.io` class of bypass. (Literal IPs are
  // already fully decided by isBlockedHostname above.)
  if (!isIpLiteral(hostname)) {
    let addresses: ResolvedAddress[];
    try {
      addresses = await lookup(hostname);
    } catch {
      // Unresolvable (NXDOMAIN/timeout) or no DNS module (edge). It cannot be
      // fetched either, so there is no SSRF; let the real fetch surface it.
      return;
    }
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        throw new SsrfError(`Host "${hostname}" resolves to blocked address ${address}`, { url });
      }
    }
  }
}

/** Options for {@link safeFetch}. */
export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Follow 3xx redirects (re-validating each hop). @default true */
  followRedirects?: boolean;
  /** Max redirect hops before failing. @default 5 */
  maxRedirects?: number;
  ssrf: ResolvedSsrfOptions;
  /** Injectable DNS resolver (tests). */
  lookup?: SsrfHostLookup;
  /** Injectable fetch implementation (tests / custom runtimes). */
  fetchImpl?: typeof fetch;
}

/**
 * SSRF-safe `fetch`: validates the initial URL and **every redirect hop** with
 * {@link assertUrlSafe} before issuing the request, using manual redirect
 * handling so a 3xx to an internal target can't be followed without
 * re-validation. Returns the final {@link Response} (the caller checks
 * `response.ok` / reads the body).
 */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<Response> {
  const { headers, timeoutMs = 30000, followRedirects = true, maxRedirects = 5, ssrf, lookup } = opts;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new SsrfError('No fetch implementation available to load OpenAPI spec from URL', { url });
  }

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertUrlSafe(current, ssrf, lookup);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        headers,
        signal: controller.signal,
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timer);
    }

    const status = typeof response.status === 'number' ? response.status : 0;
    const isRedirect = status >= 300 && status < 400 && status !== 304;
    if (!isRedirect || !followRedirects) {
      return response;
    }

    const location = response.headers?.get?.('location') ?? undefined;
    if (!location) {
      return response; // malformed redirect — let the caller treat it as non-ok
    }
    current = new URL(location, current).toString();
    // Loop re-validates `current` via assertUrlSafe before the next fetch.
  }

  throw new SsrfError(`Too many redirects while loading OpenAPI spec (max ${maxRedirects})`, { url });
}
