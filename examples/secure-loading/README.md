# Secure loading of untrusted specs

Loading a spec by URL is an SSRF vector — a hostile spec URL (or a hostile external `$ref` inside a spec) can point at your cloud metadata endpoint or internal services. This library treats that as a first-class threat: CVE-2026-39885 was reported against this package and fixed with DNS pinning and redirect re-validation, and the hardening has been maintained since.

## What it demonstrates

- `fromURL` with `secureDefaults: true` — the one-flag hardened posture (redirects off, external `$ref` resolution off; explicitly-set options still win)
- Built-in SSRF blocking: the test proves `http://169.254.169.254/...` (cloud metadata) is rejected **before any connection**, surfacing as `SsrfError`
- Distinguishing hostile URLs (`SsrfError`) from broken specs (parse/validation errors) in error handling
- Opt-in overrides (`refResolution.allowInternalIPs`) — used by the test to permit loopback, and by production code to allowlist known hosts

## Run it

```bash
yarn build && yarn test:e2e
```

Related docs: [SSRF Prevention](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/ssrf-prevention.md) · [Configuration](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/configuration.md) · [Error Handling](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/error-handling.md)
