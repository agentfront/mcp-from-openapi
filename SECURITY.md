# Security Policy

`mcp-from-openapi` loads and processes OpenAPI documents — including, by
design, documents you may not fully trust. Security reports are taken
seriously and handled with priority.

## Supported versions

| Version | Supported                |
| ------- | ------------------------ |
| 2.6.x   | ✅                       |
| 2.5.x   | ✅ (security fixes only) |
| < 2.5   | ❌                       |

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/agentfront/mcp-from-openapi/security/advisories/new)
(preferred), or by email to **info@agentfront.dev** with the subject
`[SECURITY] mcp-from-openapi`.

Please include:

- A description of the vulnerability and its impact
- A minimal reproduction (spec snippet, code, or PoC)
- The affected version(s)

You can expect an acknowledgment within **3 business days** and a triage
verdict within **7 business days**. Confirmed vulnerabilities are fixed in a
patch release with a GitHub advisory (and CVE where applicable) crediting the
reporter, unless anonymity is requested. Please give us reasonable time to
release a fix before public disclosure.

## Scope and hardening posture

Security-relevant surfaces of this library include:

- **SSRF protection** for spec-URL loading and external `$ref` resolution:
  DNS resolution with connection pinning, internal/private address blocking
  (including cloud metadata endpoints), and per-hop redirect re-validation
  (`src/ssrf.ts`). See
  [docs/ssrf-prevention.md](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/ssrf-prevention.md).
- **`secureDefaults: true`** — the recommended one-flag posture when loading
  untrusted specs (redirects off, external `$ref` resolution disabled).
- **Request building** — header/cookie injection guards and RFC 7230/6265
  validation in `buildHttpRequest`.
- **Overlay application** — prototype-pollution guards on JSONPath matching
  and merging.

Prior advisories for this package are listed under
[GitHub advisories](https://github.com/agentfront/mcp-from-openapi/security/advisories)
and on [Snyk](https://security.snyk.io/package/npm/mcp-from-openapi).
