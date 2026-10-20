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
 *     `new URL()`), IPv4-mapped IPv6, and the IPv6 transition forms that embed
 *     an IPv4 (NAT64, 6to4, IPv4-compatible/translated) before range checks;
 *   - matches `allowedHosts` / `blockedHosts` (and the built-in internal names)
 *     on a normalized hostname — lowercase, trailing root dot(s) and IPv6
 *     brackets removed — so `host.` can't dodge an entry for `host`;
 *   - blocks loopback / private (RFC 1918) / CGNAT (RFC 6598) / link-local /
 *     multicast / unspecified / reserved ranges and cloud-metadata endpoints;
 *   - resolves the hostname (Node, via `node:dns`) and rejects if **any**
 *     resolved address is internal — closing the DNS-name-to-internal bypass;
 *   - **pins the connection to the validated IP**: on Node, {@link safeFetch}
 *     connects through `node:http`/`node:https` with a custom `lookup` that
 *     returns the exact address {@link assertUrlSafe} just validated, so the
 *     guard and the socket share one DNS resolution. This closes the
 *     DNS-rebinding TOCTOU where the client would otherwise re-resolve the
 *     hostname at connect time and reach a different (internal) address. The
 *     original hostname is preserved for the `Host` header and TLS SNI, and
 *     every request opens a fresh socket (never a pooled keep-alive one);
 *   - re-validates every redirect hop ({@link safeFetch}) instead of letting the
 *     HTTP client follow 3xx blindly, and stops sending the caller's headers
 *     (spec-host credentials) once a redirect leaves the original origin.
 *
 * Node-aware: DNS resolution lazily imports `node:dns` and IP pinning lazily
 * imports `node:http`/`node:https`. On runtimes without them (Web/edge) the
 * literal-address checks still apply and the fetch falls back to the platform
 * `fetch` (best-effort, without connection pinning) — combine with an
 * `allowedHosts` allow-list and network egress controls there.
 *
 * Fails closed: a genuine resolver error rejects the URL rather than proceeding
 * unvalidated; only a runtime that has no resolver at all (edge) skips the DNS
 * step ({@link SsrfResolverUnavailableError}).
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
 * Canonical form of a hostname for allow/deny-list matching: trimmed,
 * lowercase, IPv6 brackets removed, and trailing root dot(s) dropped.
 * `API.example.com.` and `api.example.com` name the same DNS host, as do
 * `[::1]` and `::1`, so an exact string match would let one spelling dodge a
 * list entry written in the other.
 */
export function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // A loop, not /\.+$/: that regex rescans from every dot, quadratic on `a....b`.
  let end = h.length;
  while (end > 0 && h[end - 1] === '.') end--;
  return h.slice(0, end);
}

/** Does `list` contain `hostname`? Both sides are compared in {@link normalizeHostname} form. */
export function hostListIncludes(list: readonly string[], hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return list.some((entry) => normalizeHostname(entry) === host);
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
    /* c8 ignore next -- defensive: the regex above guarantees valid hex, so parseInt never yields NaN */
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

/**
 * Expand an IPv6 address (no brackets or zone) into its eight 16-bit groups,
 * or `null` if it is malformed. Accepts `::` compression and a trailing
 * dotted-quad (`::ffff:1.2.3.4`).
 */
function parseIpv6(host: string): number[] | null {
  let h = host;
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted) {
    const v4 = parseIpv4(dotted[2]);
    if (!v4) return null;
    h = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return null;
  const split = (part: string) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * The IPv4 address embedded in an IPv6 transition form, or `null`. A host or
 * network translator (NAT64 gateway, 6to4 relay, dual-stack kernel) may carry
 * such an address to its IPv4 target, so a public-looking IPv6 address can
 * still reach an internal IPv4 one.
 */
function embeddedIpv4(groups: number[]): [number, number, number, number] | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const octets = (hi: number, lo: number): [number, number, number, number] => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0) {
    if (g4 === 0 && (g5 === 0 || g5 === 0xffff)) return octets(g6, g7); // ::a.b.c.d compatible, ::ffff:a.b.c.d mapped
    if (g4 === 0xffff && g5 === 0) return octets(g6, g7); // ::ffff:0:a.b.c.d translated (SIIT)
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return octets(g6, g7); // 64:ff9b::/96 NAT64
  if (g0 === 0x2002) return octets(g1, g2); // 2002::/16 6to4
  return null;
}

/** Is this IPv6 host (bracketed or not, possibly zoned) in a blocked range? */
function isBlockedIpv6(host: string): boolean {
  let h = host;
  /* c8 ignore next -- defensive: the only caller (isBlockedAddress) already strips brackets */
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);
  const lower = h.toLowerCase();
  if (lower === '::' || lower === '::0') return true; // unspecified
  if (lower === '::1') return true; // loopback
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 ULA (fc/fd)
  if (/^fe[89a-f]/.test(lower)) return true; // fe80::/10 link-local + fec0::/10 site-local
  if (/^ff/.test(lower)) return true; // ff00::/8 multicast

  const groups = parseIpv6(lower);
  if (!groups) return false;
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  const v4 = embeddedIpv4(groups);
  return v4 !== null && isBlockedIpv4(v4);
}

/**
 * Predicate: is `host` (an IP literal — dotted-quad IPv4, bracketed/zoned IPv6,
 * or an IPv6 form embedding an IPv4: mapped, NAT64, 6to4, compatible) in a
 * blocked, non-public range? Returns `false` for non-IP-literal hostnames (use
 * DNS resolution for those).
 */
export function isBlockedAddress(host: string): boolean {
  let h = host;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);

  // IPv4-mapped IPv6 → re-check as the embedded IPv4. Block-only: the decoder
  // finds `::ffff:` anywhere (e.g. `fd00::ffff:808:808`), so a public result
  // must still fall through to the IPv6 prefix and embedded-IPv4 checks.
  const mapped = decodeIpv4MappedIpv6(host);
  if (mapped) {
    const o = parseIpv4(mapped);
    if (o && isBlockedIpv4(o)) return true;
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
  if (hostListIncludes(ssrf.blockedHosts, hostname)) return true;
  if (ssrf.allowInternalIPs) return false;

  const host = normalizeHostname(hostname);
  if (BLOCKED_HOSTNAMES.has(host)) return true;

  return isBlockedAddress(host);
}

/**
 * Signals that no DNS resolver is available on the current runtime (e.g. a
 * Web/edge isolate without `node:dns`). {@link assertUrlSafe} treats this as
 * "cannot resolve, cannot pin" and proceeds on literal-address checks only,
 * whereas a genuine resolver failure fails closed.
 */
export class SsrfResolverUnavailableError extends Error {}

/** Default DNS resolver: lazily loads `node:dns`; signals unavailability off-Node. */
export const defaultLookup: SsrfHostLookup = async (hostname) => {
  let dns: typeof import('node:dns');
  try {
    dns = await import('node:dns');
    /* c8 ignore start -- only reached on runtimes without node:dns (Web/edge) */
  } catch {
    throw new SsrfResolverUnavailableError('DNS resolution is unavailable on this runtime');
  }
  /* c8 ignore stop */
  return dns.promises.lookup(hostname, { all: true });
};

/**
 * Validate that `url` is safe to fetch (spec URL or `$ref` target), throwing
 * {@link SsrfError} if not. Enforces http/https, the `allowedHosts` allow-list,
 * the internal-address denylist, and — for DNS names — resolves and rejects if
 * any resolved address is internal.
 *
 * Returns the validated resolved addresses so the caller can **pin** the
 * connection to them ({@link safeFetch}), guaranteeing the socket connects to
 * the exact IP that was validated rather than re-resolving the hostname. An
 * empty array means "no pinning needed" (a literal IP, `allowInternalIPs`, or a
 * runtime without a resolver).
 *
 * Fails closed: a genuine resolver error (or a name that resolves to no
 * address) rejects the URL. Only {@link SsrfResolverUnavailableError} — no
 * resolver on this runtime — is treated as best-effort and returns `[]`.
 */
export async function assertUrlSafe(
  url: string,
  ssrf: ResolvedSsrfOptions,
  lookup: SsrfHostLookup = defaultLookup,
): Promise<ResolvedAddress[]> {
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
  if (ssrf.allowedHosts.length > 0 && !hostListIncludes(ssrf.allowedHosts, hostname)) {
    throw new SsrfError(`Host "${hostname}" is not in the allowed-hosts list`, { url });
  }

  if (ssrf.allowInternalIPs) {
    if (hostListIncludes(ssrf.blockedHosts, hostname)) {
      throw new SsrfError(`Host "${hostname}" is blocked`, { url });
    }
    return [];
  }

  if (isBlockedHostname(hostname, ssrf)) {
    throw new SsrfError(`Host "${hostname}" maps to a blocked internal address`, { url });
  }

  // Literal IPs are already fully decided by isBlockedHostname above, and the
  // socket connects to them directly (no DNS), so there is nothing to pin.
  if (isIpLiteral(hostname)) {
    return [];
  }

  // For DNS names, resolve and reject if any resolved address is internal. This
  // is what closes the `127.0.0.1.nip.io` class of bypass. The returned
  // addresses are pinned by safeFetch so the connection can't be rebound.
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname);
  } catch (error) {
    if (error instanceof SsrfResolverUnavailableError) {
      return [];
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SsrfError(`Host "${hostname}" could not be resolved for SSRF validation: ${message}`, { url });
  }

  if (addresses.length === 0) {
    throw new SsrfError(`Host "${hostname}" did not resolve to any address`, { url });
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfError(`Host "${hostname}" resolves to blocked address ${address}`, { url });
    }
  }

  return addresses;
}

/** Options for {@link safeFetch}. */
export interface SafeFetchOptions {
  /**
   * Request headers (e.g. the spec host's `Authorization`). Sent only while the
   * request stays on the origin of `url`: once a redirect leaves that origin
   * (scheme, host, or port), they are dropped for every remaining hop.
   */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Follow 3xx redirects (re-validating each hop). @default true */
  followRedirects?: boolean;
  /** Max redirect hops before failing. @default 5 */
  maxRedirects?: number;
  /** Max response body bytes before the request is aborted (Node transport). @default 10 MiB */
  maxResponseBytes?: number;
  ssrf: ResolvedSsrfOptions;
  /** Injectable DNS resolver (tests). */
  lookup?: SsrfHostLookup;
  /**
   * Injectable fetch implementation (tests / custom runtimes). Providing this
   * bypasses the Node connection-pinning transport, so the implementation is
   * responsible for connecting to the validated address itself.
   */
  fetchImpl?: typeof fetch;
}

/** Lazily-loaded `node:http`/`node:https` modules. */
export interface NodeHttpModules {
  http: typeof import('node:http');
  https: typeof import('node:https');
}

/** Default cap on response body size for the Node transport (10 MiB). */
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** A transport that issues one GET and returns the raw (unfollowed) response. */
type SsrfTransport = (
  url: string,
  request: { headers?: Record<string, string>; signal: AbortSignal; pinned: ResolvedAddress[]; maxBytes?: number },
) => Promise<Response>;

/** Load the Node HTTP transport modules, or `null` on runtimes without them. */
async function loadNodeHttpModules(): Promise<NodeHttpModules | null> {
  try {
    const [http, https] = await Promise.all([import('node:http'), import('node:https')]);
    return { http, https };
    /* c8 ignore start -- only reached on runtimes without node:http (Web/edge) */
  } catch {
    return null;
  }
  /* c8 ignore stop */
}

/** Select the Node transport module for a URL protocol. Exported for tests. */
export function pickHttpModule(
  protocol: string,
  modules: NodeHttpModules,
): NodeHttpModules['http'] | NodeHttpModules['https'] {
  return protocol === 'https:' ? modules.https : modules.http;
}

/**
 * A `node:net` lookup that always returns the pre-validated addresses, ignoring
 * the queried hostname — pinning the socket to the exact IP {@link assertUrlSafe}
 * validated so the connection cannot be re-resolved to a different (internal)
 * address. Exported for tests.
 */
export function makePinnedLookup(pinned: ResolvedAddress[]) {
  return (_hostname: string, options: unknown, callback?: unknown): void => {
    const done = (typeof options === 'function' ? options : callback) as (
      err: Error | null,
      address: string | ResolvedAddress[],
      family?: number,
    ) => void;
    const wantsAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
    if (wantsAll) {
      done(
        null,
        pinned.map(({ address, family }) => ({ address, family })),
      );
    } else {
      done(null, pinned[0].address, pinned[0].family);
    }
  };
}

/** HTTP statuses that must not carry a response body (Fetch spec). */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/**
 * Node transport that pins the connection to the validated address(es) via a
 * custom `lookup`, preserving the original hostname for the `Host` header and
 * TLS SNI. Each request uses a one-off agent so a shared keep-alive pool can't
 * hand it a socket connected elsewhere. Manual redirects only (no `lookup`
 * re-resolution between hops). Exported for tests.
 */
export function nodePinnedTransport(modules: NodeHttpModules): SsrfTransport {
  return (url, { headers, signal, pinned, maxBytes }) =>
    new Promise<Response>((resolve, reject) => {
      const limit = maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      const lib = pickHttpModule(new URL(url).protocol, modules);
      const requestOptions: Record<string, unknown> = {
        method: 'GET',
        signal,
        // A pooled keep-alive socket is keyed by host:port only and would skip the pinned lookup.
        agent: false,
        headers: { ...headers, 'accept-encoding': 'identity' },
      };
      if (pinned.length > 0) {
        requestOptions['lookup'] = makePinnedLookup(pinned);
      }
      const request = lib.request(url, requestOptions as import('node:http').RequestOptions, (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > limit) {
            request.destroy();
            reject(new SsrfError(`Response body exceeds ${limit} bytes`, { url }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode as number;
          const responseHeaders = new Headers();
          const entries = Object.entries(response.headers) as [string, string | string[]][];
          for (const [key, value] of entries) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(key, item);
            } else {
              responseHeaders.append(key, value);
            }
          }
          const body = NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, statusText: response.statusMessage, headers: responseHeaders }));
        });
        /* c8 ignore next -- defensive: a mid-stream socket error surfaces as a rejection */
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end();
    });
}

/** Fetch-based transport (injected impl or platform fetch). Cannot pin. */
function fetchTransport(fetchImpl: typeof fetch): SsrfTransport {
  return (url, { headers, signal }) => fetchImpl(url, { headers, signal, redirect: 'manual' });
}

/** Choose the transport: injected fetch, else Node pinned, else platform fetch. */
async function selectTransport(opts: SafeFetchOptions, url: string): Promise<SsrfTransport> {
  if (opts.fetchImpl) {
    return fetchTransport(opts.fetchImpl);
  }
  const modules = await loadNodeHttpModules();
  /* c8 ignore start -- non-Node fallback: unreachable in the Node test runtime */
  if (!modules) {
    const platformFetch = globalThis.fetch as typeof fetch | undefined;
    if (typeof platformFetch === 'function') {
      return fetchTransport(platformFetch);
    }
    throw new SsrfError('No fetch implementation available to load OpenAPI spec from URL', { url });
  }
  /* c8 ignore stop */
  return nodePinnedTransport(modules);
}

/**
 * SSRF-safe `fetch`: validates the initial URL and **every redirect hop** with
 * {@link assertUrlSafe} before issuing the request, then **pins** the connection
 * to the validated IP (on Node) so the socket can't be rebound to an internal
 * address. Uses manual redirect handling so a 3xx to an internal target can't be
 * followed without re-validation, and so the caller's `headers` never follow a
 * redirect off the original origin. Returns the final {@link Response} (the
 * caller checks `response.ok` / reads the body).
 */
export async function safeFetch(url: string, opts: SafeFetchOptions): Promise<Response> {
  const { headers, timeoutMs = 30000, followRedirects = true, maxRedirects = 5, ssrf, lookup } = opts;
  const transport = await selectTransport(opts, url);

  let current = url;
  let hopHeaders = headers;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const pinned = await assertUrlSafe(current, ssrf, lookup);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await transport(current, {
        headers: hopHeaders,
        signal: controller.signal,
        pinned,
        maxBytes: opts.maxResponseBytes,
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
    const next = new URL(location, current);
    // The caller's headers authenticate to the origin it asked for. Like fetch
    // does for Authorization, drop them once a hop leaves that origin (another
    // host, port, or an https→http downgrade), and never restore them later in
    // the chain — an open redirect must not harvest the spec host's token.
    if (next.origin !== new URL(current).origin) {
      hopHeaders = undefined;
    }
    current = next.toString();
    // Loop re-validates + re-pins `current` via assertUrlSafe before the next fetch.
  }

  throw new SsrfError(`Too many redirects while loading OpenAPI spec (max ${maxRedirects})`, { url });
}
