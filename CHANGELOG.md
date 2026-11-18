## [2.10.0] - 2026-11-18

### Added
- OpenAPI 3.2: `query` and `additionalOperations`, `in: querystring`, `style: cookie`, parameters defined with `content`, streamed responses (`itemSchema`, `metadata.responseStream`), server `name`, `$self`, security schemes named by URI.
- Swagger 2.0: converted to OpenAPI 3.0 (`upgradeSwagger2`) and generated through the same pipeline; validated as written.
- Version-aware validation and operation discovery (`detectSpecVersion`, `resolveOperationLayout`, `listOperations`, `getOperation`).
- Own OpenAPI types per version: `OAS20`, `OAS30`, `OAS31`, `OAS32`, `WithExtensions`.
- Multi-file documents: relative `$ref`s resolve against the retrieval URI (`fromURL`, `fromFile`, `LoadOptions.documentUri`); references to the document's own URI resolve locally.
- Encoding Objects applied per field in form and multipart bodies; boolean schemas; response status ranges (`metadata.responseStatusRanges`).
- `getDiagnostics()` with `DIAGNOSTIC_CODES` for every construct the generator skips or ignores.
- Security requirement alternatives kept as a choice (`metadata.securityAlternatives`, `security.alternatives`).
- Release flow: Prepare Release opens a reviewed release pull request; Publish Release publishes through npm trusted publishing.

### Changed
- `validate()` checks the field types generation reads and the names of header and cookie parameters.
- An operation whose security requirements cannot be satisfied makes no tool (`UNSATISFIABLE_SECURITY`).
- `readOnly` properties are left out of inputs and `writeOnly` ones out of outputs.
- Header parameters the HTTP client, a credential or a proxy sets are not inputs (`PARAMETER_IGNORED`).
- Several responses join with `anyOf`; a response key that is not a status code or range is ignored (`INVALID_RESPONSE_KEY`).
- In OpenAPI 3.1 and later a schema `$ref` applies together with the keywords beside it.
- An object body whose `additionalProperties` or `unevaluatedProperties` is not `false` is one `body` input.
- Path-level `servers` are honoured.
- `allowedHosts` matches hosts exactly.
- Default `maxSchemaNodes` is 25,000 (was 100,000); a schema over it is cut shallower (`SCHEMA_DEPTH_REDUCED`).
- `$ref`s inside a schema's `x-` extensions are kept as written.

### Fixed
- A depth cut or a cycle never makes a schema refuse a value the document accepts.
- Flattened `allOf` bodies keep every member's constraints.
- A required body with no required property is sent as an empty body.
- A path parameter the path template does not name is left out with a diagnostic.
- An unreadable reference is located in OpenAPI 3.1 documents.
- Document keys are never read or written through the prototype; `buildHttpRequest` fails only with `RequestBuildError`.

### Security
- `blockedHosts` matches an address in any spelling (IPv4-mapped, NAT64, 6to4, decimal, Unicode names).
- External `$ref` fetching is bounded in documents, bytes, concurrency and time; local file references read only regular files up to 10 MiB.
- The pinned HTTP transport settles on every response a server can send.
- YAML alias graphs and shared objects that would expand without bound are refused; schema conversion has per-tool and per-run node budgets.
- Built request paths keep the resource their template names and start with exactly one slash.
- Parameters and input-chosen names can no longer add or replace a credential.
- Reference errors no longer reveal internal addresses, the working directory or URL credentials; document text is escaped in messages.
- Path globs, validation, lint, Arazzo and overlay processing run in linear time.

## [2.5.0] - 2026-06-21

### Security (SSRF hardening — GHSA-65h7-9wrw-629c)

Closes the remaining SSRF bypasses left after 2.4.0, where the guard checked the
hostname **string** rather than the **resolved IP**:

- **DNS resolution** — spec URLs and external `$ref` targets are now resolved
  (Node `node:dns`) and rejected if **any** resolved address is internal. This
  closes the `http://127.0.0.1.nip.io/` (and any DNS-name-to-internal) bypass.
- **`fromURL` is now guarded** — the initial spec fetch was previously
  unprotected (no host check, blind redirect-following). It now runs through the
  same SSRF guard.
- **Redirect re-validation** — every HTTP redirect hop is re-validated against
  the guard before being followed (manual redirect handling) instead of trusting
  the client to stop at a blocked `Location`.
- **External `$ref` fetch hardening** — refs are fetched via the SSRF-safe
  client (DNS-validated, redirects refused) and the spec-load credentials
  (`headers`) are **no longer forwarded** to third-party `$ref` hosts.
- IPv4 range checks now also cover CGNAT (`100.64.0.0/10`), benchmarking
  (`198.18.0.0/15`), and `192.0.0.0/24`; IPv6 covers loopback, ULA, link-local,
  and multicast.

`RefResolutionOptions` (`allowedHosts` / `blockedHosts` / `allowInternalIPs`)
now governs the spec-URL fetch too. New `SsrfError` and the `ssrf` helpers
(`assertUrlSafe`, `safeFetch`, `isBlockedAddress`, …) are exported.

Residual: resolve-then-fetch is not connection-pinned, so a sub-second
DNS-rebinding race is not fully eliminated — combine with `allowedHosts` and
network egress controls for fully-untrusted input.

## [2.4.0] - 2026-06-18
