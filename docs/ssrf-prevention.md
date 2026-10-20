# SSRF Prevention

[Home](../README.md) | [Configuration](./configuration.md) | [Security](./security.md)

---

## Overview

When dereferencing `$ref` pointers, the library resolves external URLs. A malicious OpenAPI spec could point `$ref` to internal services, cloud metadata endpoints, or the local filesystem -- enabling SSRF (Server-Side Request Forgery) and local file read attacks. The library blocks these by default.

### Attack Scenarios

Without protection, a crafted OpenAPI spec could:

- **Cloud credential theft** -- `$ref` pointing to `http://169.254.169.254/latest/meta-data/` steals AWS/GCP/Azure instance metadata
- **Internal network scanning** -- `$ref` values probe internal services and ports
- **Local file read** -- `file:///etc/passwd` reads arbitrary files from the server filesystem

All it takes is processing an untrusted OpenAPI spec.

> **Acknowledgment:** Thanks to [@TharVid](https://github.com/TharVid) for responsibly reporting the SSRF via `$ref` dereferencing attack vector, which led to the implementation of these protections.

---

## Default Protections

Out of the box, the following are blocked:

### Blocked Protocols

- `file://` -- Local filesystem access is blocked
- Only `http://` and `https://` are allowed

### Blocked Hostnames and IP Ranges

| Pattern | Description |
|---------|-------------|
| `localhost` | Loopback hostname |
| `127.0.0.0/8` | IPv4 loopback range |
| `10.0.0.0/8` | RFC 1918 private range |
| `172.16.0.0/12` | RFC 1918 private range |
| `192.168.0.0/16` | RFC 1918 private range |
| `169.254.0.0/16` | Link-local / cloud metadata (AWS, GCP) |
| `0.0.0.0` | Unspecified address |
| `metadata.google.internal` | GCP metadata endpoint |
| `::1` | IPv6 loopback |
| `fd00::/8` | IPv6 Unique Local Address |
| `fe80::/10` | IPv6 link-local |
| `64:ff9b:1::/48` | Local-use NAT64 prefix (never globally routable) |

Bracketed IPv6 forms (`[::1]`, `[fd00:...]`, `[fe80:...]`) are also blocked.

IPv6 addresses that embed an IPv4 address are checked against the IPv4 ranges above, because a NAT64 gateway, 6to4 relay, or dual-stack host may carry them to that IPv4 target:

| Form | Example | Embedded IPv4 |
|------|---------|---------------|
| IPv4-mapped (`::ffff:0:0/96`) | `::ffff:7f00:1` | `127.0.0.1` |
| IPv4-translated (`::ffff:0:0:0/96`) | `::ffff:0:a00:1` | `10.0.0.1` |
| IPv4-compatible (`::/96`, deprecated) | `::7f00:1` | `127.0.0.1` |
| NAT64 well-known prefix (`64:ff9b::/96`) | `64:ff9b::a9fe:a9fe` | `169.254.169.254` |
| 6to4 (`2002::/16`) | `2002:c0a8:101::1` | `192.168.1.1` |

### Hostname Matching

Hostnames are compared in a normalized form: lowercase, with trailing root dots and IPv6 brackets removed. This applies to the built-in names above and to every `allowedHosts` / `blockedHosts` entry, on both sides of the comparison. `localhost.`, `LOCALHOST`, and `localhost` are the same host, so a `blockedHosts: ['internal.corp']` entry also blocks `http://internal.corp./`.

---

## Configuration

Use `RefResolutionOptions` in `LoadOptions` to customize behavior:

### Restrict to Specific Hosts

Only allow refs from trusted hosts:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    allowedHosts: ['schemas.example.com', 'api.example.com'],
  },
});
```

When `allowedHosts` is set, **only** these hosts are permitted (in addition to passing the block list check).

### Add Custom Blocked Hosts

Block additional hostnames on top of the default list:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    blockedHosts: ['untrusted-cdn.com', 'internal.corp.net'],
  },
});
```

### Restrict Protocols

Allow only HTTPS:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    allowedProtocols: ['https'],
  },
});
```

### Disable All External Resolution

Pass an empty protocols list to block all external `$ref` resolution:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    allowedProtocols: [],
  },
});
```

### Allow Internal IPs (Not Recommended)

Disables the built-in IP block list. Only user-provided `blockedHosts` are checked:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    allowInternalIPs: true, // WARNING: SSRF risk
  },
});
```

> **Warning:** Enabling this may expose your application to SSRF attacks against cloud metadata endpoints and internal services.

---

## How It Works

The library configures `@apidevtools/json-schema-ref-parser` with a custom `canRead` function that:

1. Parses the `$ref` URL
2. Checks the protocol against `allowedProtocols`
3. Checks the hostname against `allowedHosts` (if configured)
4. Checks the hostname against the blocked list (built-in + `blockedHosts`)
5. Returns `false` (block) if any check fails

This happens transparently during the dereference step when loading a spec.

Every network fetch -- the spec URL in `fromURL` and each external `$ref` -- then goes through `safeFetch`, which:

1. Resolves the hostname and rejects it if **any** resolved address is internal (this closes the `127.0.0.1.nip.io` class of bypass)
2. Pins the connection to the exact address it just validated, so the socket never looks the name up again (this closes DNS rebinding), while keeping the original hostname for the `Host` header and TLS SNI
3. Opens a fresh socket for every request, so a pooled keep-alive socket that was connected elsewhere is never reused
4. Re-validates every redirect hop before following it (`$ref` fetches refuse redirects entirely)

### Headers and Redirects

`LoadOptions.headers` (typically the spec host's `Authorization` or API key) is sent only while the request stays on the origin of the URL passed to `fromURL`. If a redirect leaves that origin (another host, another port, or an `https` → `http` downgrade), **all** caller headers are dropped for that hop and for every later hop, even if the chain later returns to the original origin. An open redirect on the spec host therefore cannot pass your credentials to a third party. External `$ref` fetches never send `headers`.

If your spec host redirects to a different origin that also needs credentials, load the final URL directly, or pass `followRedirects: false` to stop at the redirect.

Connection pinning needs Node's `node:http`/`node:https`. On runtimes without them (Web/edge), and whenever you pass a custom `fetchImpl` to `safeFetch`, only the pre-fetch checks apply. For untrusted input there, combine `allowedHosts` with network egress controls.

---

**Related:** [Security](./security.md) | [Configuration](./configuration.md) | [Getting Started](./getting-started.md)
