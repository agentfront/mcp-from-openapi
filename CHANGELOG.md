## [2.11.0] - 2026-11-25

### Changed
- The spec layer (the `OAS20`/`OAS30`/`OAS31`/`OAS32` types, version detection and profiles, the operation walker, the Swagger 2.0 converter) comes from the `openapi-spec` package (`^1.0.0`), a new runtime dependency. The library exports the same names with the same types and reads documents as before.

### Security
- The Swagger 2.0 converter groups its findings in one linear pass (from `openapi-spec` 1.0.0; CodeQL `js/polynomial-redos`).

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

## [2.9.3] - 2026-11-12

### Fixed
- Addressed stack overflow risks when processing `$ref` chains of any length.
- Implemented stricter prototype key checks to prevent pollution.
- Improved schema node budget counting for inlining and mapper value calculations.
- Resolved schema handling to avoid circular references causing application crashes.

## [2.9.2] - 2026-11-12

### Fixed
- Restored v2.9.1's allOf nesting limit.
- Charged every conversion visit against maxSchemaNodes.
- Budgeted only emitted work, using cheaper cycle analysis.
- Bounded generateTools work on schemas that reuse a $ref.

## [2.9.1] - 2026-10-20

### Security
- Resolved security alerts related to `@istanbuljs/load-nyc-config/js-yaml`.

## [2.9.0] - 2026-10-20

### Changed
- Improved hostname normalization for $ref resolution.
- Updated internal IP blocking for IPv6 flows.

### Fixed
- Fixed SSRF vulnerability by adjusting IPv6 prefix blocking.
- Ensured spec credentials retain original origin during redirects.

### Security
- Enhanced SSRF protection in hostname handling.
- Adjusted SSRF prevention mechanisms to handle spec credentials more securely.

## [2.8.0] - 2026-09-26

### Added
- Improved HTTP Request handling for Blobs.

### Changed
- Node version requirement updated to >= 22.19.
- Updated `@apidevtools/json-schema-ref-parser` to v16.0.2.

### Security
- Prevent SSRF by ensuring each HTTP request opens a fresh socket.

### Fixed
- Never reuse pooled keep-alive sockets in the pinned transport.

## [2.7.0] - 2026-08-13

### Added
- New Arazzo 1.0 workflows conversion to MCP tools.
- TypeScript call signatures emission via `emitTypeSignatures`.
- Added `_meta`, tool icons, and security elicitation descriptors.
- Added `dottedNaming` preset for CodeCall-bindable tool names.

### Fixed
- Resolved local parameter refs and stabilized schema validation.
- Skipped reference-object parameters in validation and coverage checks.
- Omitted non-object output schemas from SDK configurations.

### Security
- Mitigated dependency vulnerabilities and addressed CodeQL alerts.

## [2.6.1] - 2026-08-12

### Added
- Overlay application at load time with support for JSONPath.
- Agent-readiness linting for improving spec-quality and tool accuracy.
- Pagination parameter detection and unbounded-array metadata hints.
- Token estimation and tool-set budget reporting.
- Trimming options: `maxProperties`, `maxDescriptionLength`, and `stripExamples`.

### Fixed
- Path template regex adjusted to prevent polynomial backtracking.
- CodeQL alerts on polynomial trims and digest backslash escaping resolved.

### Security
- Security enhancements addressing CodeQL findings.

## [2.6.0] - 2026-08-11

See the [release notes](https://github.com/agentfront/mcp-from-openapi/releases/tag/v2.6.0).

## [2.5.1] - 2026-07-21

### Added

- Introduced IP connection pinning feature using a custom `lookup` in Node.js environments, which ensures the socket connects to the validated IP, closing DNS-rebinding vulnerabilities.
- Implemented manual redirect handling to re-validate each redirect, preventing automatic follow-through to potentially unsafe internal addresses.
- Added a cap on response body size for the Node.js transport, defaulting to 10 MiB.

### Changed

- Modified the DNS resolution process to signal unavailability on non-Node runtimes with a `SsrfResolverUnavailableError`. This allows processing to proceed with literal-address checks while acknowledging platform limitations.

### Fixed

- Addressed potential issues with unresolvable hosts by ensuring URLs reject appropriately if DNS resolution fails outside the edge environment.

### Security

- Strengthened SSRF protections by incorporating mandatory address validation and connection pinning, thereby mitigating risks through layer-by-layer validation and control over DNS resolution and redirection.

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

### Added

- Introduced lazy loading for Node.js built-in modules (path and fs) in `fromFile` method to ensure compatibility with V8-isolate runtimes like Cloudflare Workers and Deno.
- Added functions to decode IPv4-mapped IPv6 addresses and dereference internal JSON pointers without using Node dependencies, improving cross-platform compatibility.

### Changed

- Updated dependency version and package manager to `yarn@4.14.1`.
- Enhanced hostname blocklist checking to prevent bypass using IPv4-mapped IPv6 addresses.
- Prevented automatic HTTP redirect following in `$Ref` resolution to improve security.

### Security

- Secured digest authentication by stripping CR/LF and backslashes in quotes and tokens to prevent header/response-splitting vulnerabilities.

## [2.3.0] - 2026-04-08

### Added

- Implemented built-in format resolvers, enriching JSON Schema with constraints based on OpenAPI format values (e.g., uuid, date-time, int32).
- Added support for custom format resolvers through `formatResolvers` option in `GenerateOptions`.
- Enabled resolution of schema formats globally with `resolveFormats` flag in `GenerateOptions`.

### Changed

- Updated engine requirement to Node.js v20 or higher.
- Upgraded `@apidevtools/json-schema-ref-parser` dependency to v15.3.5.

### Fixed

- Improved handling of OpenAPI document validation when dereferencing.
- Corrected source map misalignments during coverage reporting.

## [2.2.0] - 2026-04-07

### Added

- First release from this repository, extracted from frontmcp.

## [2.1.2] - 2025-12-27

### Changed

- Added `publish-alpha` Nx target to enable alpha publishing flow using common script.

## [2.1.1] - 2025-12-24

### Fixed

- Revised build setup to emit CJS and ESM bundles with corrected export map and sideEffects flag to improve tree shaking.
- Synced package entry points and type outputs with the new build artifacts while preserving the public API surface.

## [2.1.0] - 2025-12-19

### Added

- Introduced logger support within the OpenAPI adapter to improve observability.
- Expanded security handling with automatic auth type routing and enhanced documentation.

### Changed

- Refined security resolver examples and guidance for broader authentication scheme coverage.

## [2.0.0] - 2025-12-11

### Breaking

- Migrated to Zod v4 (now a peer dependency) and aligned JSON schema types with Zod’s v4 JSONSchema
- Renamed utility export `toJSONSchema7` to `toJsonSchema`, affecting consumers of the types/helpers

### Changed

- Updated SWC/Jest config to inline ES2022 settings and modernized tooling versions
- Adjusted exports formatting and minor parameter resolver refactors for consistency

## [1.0.0] - 2025-11-21

### Features

- Production-ready library for converting OpenAPI specifications into MCP tool definitions
- OpenAPI 3.0+ and Swagger 2.0 support
- Comprehensive operation parsing:
  - RESTful endpoint detection (GET, POST, PUT, PATCH, DELETE, etc.)
  - Path parameter extraction and validation
  - Query parameter handling
  - Request body schema conversion
  - Response schema parsing
- Advanced OpenAPI features:
  - Reference resolution ($ref) across the entire specification
  - Security scheme detection and configuration
  - Parameter conflict resolution
  - Operation naming controls and customization
- Request mapper generation:
  - Automatic parameter mapping from MCP tool inputs to HTTP requests
  - Type-safe parameter handling
  - Support for different parameter locations (path, query, header, cookie)
  - Request body transformation
- Tool metadata generation:
  - Descriptive tool names from operation IDs
  - Documentation from OpenAPI descriptions
  - Schema validation rules
- Multiple input formats:
  - JSON OpenAPI specifications
  - YAML OpenAPI specifications
  - Inline specification objects
  - URL references to remote specifications
- Type-safe TypeScript implementation
- Node.js 18+ compatibility

### Documentation

- Complete API reference
- OpenAPI conversion examples
- Integration guides for MCP servers
- Best practices for tool generation

This is the first official release of `mcp-from-openapi`, extracted from the FrontMCP framework to be published as a
standalone, reusable library for the community.
