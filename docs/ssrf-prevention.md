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

Bracketed IPv6 forms (`[::1]`, `[fd00:...]`, `[fe80:...]`) are also blocked.

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

---

**Related:** [Security](./security.md) | [Configuration](./configuration.md) | [Getting Started](./getting-started.md)
