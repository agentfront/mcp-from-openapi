# CLAUDE.md - Project Guide for mcp-from-openapi

## Project Overview

**mcp-from-openapi** converts OpenAPI 3.0/3.1 specifications into MCP (Model Context Protocol) tool definitions. It handles parameter resolution, schema conversion, security configuration, SSRF-safe `$ref` dereferencing, and format-to-schema enrichment.

## Architecture

```text
OpenAPI Spec (JSON/YAML/URL/File)
    |
    v
OpenAPIToolGenerator (src/generator.ts)
    |-- initialize(): dereference $refs, then validate (once; rules of the declared version)
    |-- generateTools(): iterate paths, then operations via listOperations (src/spec/operations.ts)
    |-- generateTool(): build a single McpOpenAPITool
           |
           |-- ParameterResolver (src/parameter-resolver.ts)
           |      resolves params + requestBody into inputSchema + mapper
           |
           |-- ResponseBuilder (src/response-builder.ts)
           |      builds outputSchema from responses
           |
           |-- Format Resolution (src/format-resolver.ts)
           |      enriches schemas with format constraints (optional)
           |
           v
    McpOpenAPITool { name, description, inputSchema, outputSchema, mapper, metadata }
```

## Key Files

| File                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/generator.ts`              | Main entry point. Factory methods (`fromJSON`, `fromYAML`, `fromURL`, `fromFile`), tool generation, tool-name normalization/dedup, SSRF protection, `$ref` dereferencing, `getDiagnostics()` (de-duplicated by `diagnosticKey`, capped at `MAX_DIAGNOSTICS`) / `getSpecVersion()`, validation once, operations read through the declared version's layout, security requirements dropped per object (`UNSATISFIABLE_SECURITY`)                                               |
| `src/types.ts`                  | All type definitions, `toJsonSchema()` conversion (incl. `nullable`/`example`/`xml` normalization), `isReferenceObject()` guard; the OpenAPI object aliases re-export the cross-version unions of `src/spec/types`; `DIAGNOSTIC_CODES` (the one registry of every `getDiagnostics()` code, extends the spec layer's `SPEC_DIAGNOSTIC_CODES`), `MAX_DIAGNOSTICS`, `LEGACY_PATH_KEY_MAX_LENGTH`                                                                                |
| `src/spec/types/*`              | Own OpenAPI 3.0/3.1/3.2 reader types, written from the official spec text and OAI JSON Schemas: namespaces `OAS30`/`OAS31`/`OAS32` (`v3_0.ts`/`v3_1.ts`/`v3_2.ts`; 3.2 states only its changes to 3.1 via `Override`), cross-version unions and `SchemaOrBoolean` in `index.ts`, `WithExtensions` for reading `x-` fields, shared `SpecMap`/`FreeFormValue`/`Override` in `common.ts`, JSON Schema 2020-12 keywords in `json-schema-2020-12.ts`. Barrel: `src/spec/index.ts` |
| `src/spec/tsconfig.json`        | Compile-time boundary of the spec layer: `rootDir: "."` and `types: []`, so nothing under `src/spec/` can import from outside it (run by `yarn typecheck`)                                                                                                                                                                                                                                                                                                                   |
| `src/spec/versions.ts`          | `detectSpecVersion` (status, `family`), one `SpecProfile` per known `major.minor` in `SPEC_PROFILES`, `resolveOperationLayout(version)` (THE decision of which operations a document has: the profile for 3.0/3.1/3.2+, `LEGACY_OPERATION_LAYOUT` otherwise), `listSkippedNewerOperations`, the `SPEC_FEATURES` table behind `featureNewerThanDeclared`, `SUPPORTED_SPEC_VERSIONS`. Adding 3.3 = a family, a profile, its features                                           |
| `src/spec/operations.ts`        | `listOperations` / `getOperation` (take an `OperationLayout`): the one walker of a Path Item (fixed methods in `STANDARD_METHODS` order incl. `query`, then `additionalOperations` by key), own-property reads, a diagnostic per ignored value; an additional method matches EXACTLY as written, a case variant of a standard method is `METHOD_CASE_VARIANT`; `isStandardMethod`, `wireMethod`, `isHttpToken`, `isRefusedMethod`                                            |
| `src/spec/diagnostics.ts`       | `SpecDiagnostic`, `SPEC_DIAGNOSTIC_CODES` (the spec layer's codes), `diagnosticKey` (bounded identity for de-duplication), and the helpers that make document text safe: `describeValue` for message fragments; `jsonPointer`/`appendPointer`/`escapePointerSegment` for paths (unsafe characters become `\uXXXX`, a segment is cut at 256, so a cut pointer is display-only)                                                                                                |
| `src/annotations.ts`            | HTTP-method annotation inference (`query` is read-only/idempotent; any method that is not standard is treated like `post`) + `x-mcp` extension family overrides (`x-speakeasy-mcp` < `x-mcp` < `x-frontmcp`); `resolveExtensionEnabled` (root < path < operation)                                                                                                                                                                                                            |
| `src/request-builder.ts`        | `buildHttpRequest` — pure request assembly with full OpenAPI style/explode serialization, multipart/binary bodies, injection guards; validates the method token, refuses `CONNECT`, sends standard methods upper-case and `additionalOperations` methods as written; unknown mapper type or security location -> `RequestBuildError`                                                                                                                                         |
| `src/client-targets.ts`         | Per-client schema dialect transforms (`claude`/`openai`/`gemini`/`strict`), composable and exported standalone                                                                                                                                                                                                                                                                                                                                                               |
| `src/token-report.ts`           | `estimateToolTokens` / `analyzeToolSet` — context-budget estimates and curation warnings                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/overlay.ts`                | OpenAPI Overlay 1.0 application with a JSONPath subset (filters, recursive descent); `OverlayError`                                                                                                                                                                                                                                                                                                                                                                          |
| `src/lint.ts`                   | `lintDocument` agent-readiness findings (severity + fix hints) over the operations the declared version has; skips malformed values instead of throwing; `PAGINATION_PARAM` shared regex                                                                                                                                                                                                                                                                                     |
| `src/sdk.ts`                    | `toSdkTool` — registerTool-shaped output for the official MCP SDK (no SDK dependency)                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/type-signature.ts`         | `emitToolTypeScript` — TypeScript signature/declaration rendering of a tool's call contract (`emitTypeSignatures` option → `metadata.typescript`)                                                                                                                                                                                                                                                                                                                            |
| `src/naming-presets.ts`         | `dottedNaming` — two-segment `ns.method` naming preset for CodeCall namespace binding; `CODECALL_RESERVED_NAMESPACES`                                                                                                                                                                                                                                                                                                                                                        |
| `src/elicitation.ts`            | `deriveSecurityElicitations` — MCP elicitation descriptors (`{message, requestedSchema}`) from a tool's security data                                                                                                                                                                                                                                                                                                                                                        |
| `src/arazzo.ts`                 | `fromArazzo()` — Arazzo 1.0 parsing, source/operation resolution (operations as each source's declared version defines them; `additionalOperations/<METHOD>` pointers match exactly), workflow IR + consolidated tools (companions: `arazzo-types.ts`, `arazzo-expressions.ts`)                                                                                                                                                                                              |
| `src/parameter-resolver.ts`     | Resolves OpenAPI parameters + requestBody into flat inputSchema with conflict resolution; flattens `allOf` bodies, flags `wholeBody`/`binary`                                                                                                                                                                                                                                                                                                                                |
| `src/response-builder.ts`       | Builds outputSchema from OpenAPI responses with content-type and status code preferences                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/format-resolver.ts`        | Format-to-schema resolution. Built-in resolvers for uuid, date-time, email, int32, etc.                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/json-copy.ts`              | `copyJsonValue` — copies a spec value into a fresh tree under a node budget (`CopyBudget`): cycles dropped, >1000 levels → `SchemaError`, iterative                                                                                                                                                                                                                                                                                                                          |
| `src/schema-builder.ts`         | Static utilities: merge, union, clone, flatten, simplify, withFormat, etc.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/security-resolver.ts`      | Resolves security schemes (Bearer, Basic, Digest, API Key, OAuth2, OpenID Connect)                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/validator.ts`              | Validates structure with the rules of the DECLARED version (3.0/3.1/3.2 via `SPEC_PROFILES`; newer 3.x minor = valid + `NEWER_OPENAPI_VERSION`; Swagger 2.0/other majors = `INVALID_OPENAPI_VERSION`); walker findings are errors or warnings (`WALKER_ERROR_CODES`); `errors`/`warnings` capped at `MAX_DIAGNOSTICS`; legacy codes keep their historical unescaped `path`, newer ones use JSON Pointers; `messageText` escapes quoted text                                  |
| `src/errors.ts`                 | Error class hierarchy: LoadError, ParseError, ValidationError, GenerationError, SchemaError, OverlayError, RequestBuildError, ArazzoError                                                                                                                                                                                                                                                                                                                                    |
| `src/index.ts`                  | Barrel file for public exports                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `scripts/sync-oas-sources.mjs`  | Verifies (offline, sha256) or with `--update` re-downloads the pinned official OpenAPI JSON Schemas vendored under `e2e/fixtures/oas/`, as listed in `e2e/fixtures/oas/sources.json`                                                                                                                                                                                                                                                                                         |
| `scripts/diff-public-types.mjs` | Public-type differential: compares every type exported by the built `dist/` with a published release, in both directions; each difference must be on `scripts/public-types-allowlist.json` with a reason. Needs network and `yarn build`; CI job `public-types`                                                                                                                                                                                                              |

## Development Commands

```bash
yarn test              # Run all tests (unit + integration)
yarn test:unit         # Run unit tests only
yarn test:integration  # Run integration tests only
yarn test:e2e          # E2E story suite (requires `yarn build` first — the packaging story consumes dist/)
yarn test:coverage     # Run tests with coverage report
yarn typecheck         # tsc over src, e2e, examples and the type tests (e2e/tsconfig.json), then the src/spec boundary project — Jest's SWC strips types without checking them
yarn build             # Build CJS + ESM + type declarations
yarn build:cjs         # Build CommonJS output only
yarn build:esm         # Build ESM output only
yarn build:types       # Emit TypeScript declarations only
yarn clean             # Remove dist/ and coverage/
```

## Build System

- **Bundler**: esbuild (separate CJS and ESM builds)
- **Type declarations**: tsc with `tsconfig.lib.json`
- **Packages**: external (not bundled into output) via `--packages=external`
- **CJS output**: `dist/index.js`
- **ESM output**: `dist/esm/index.mjs`
- **Types**: `dist/index.d.ts`

## Testing

- **Framework**: Jest 30 with SWC transformer (`@swc/jest`)
- **Coverage provider**: V8 (`coverageProvider: 'v8'` in jest.config.js)
- **Coverage target**: 100% statements, branches, functions, lines — a UNIT-suite contract; the e2e suite never runs under `test:coverage`
- **Unit tests**: `src/__tests__/*.spec.ts` (one per module)
- **Integration tests**: `src/__tests__/integration.spec.ts` (full pipeline, imports from entrypoint only)
- **E2E stories**: `e2e/*.e2e.ts` under `jest.e2e.config.js` (the `.e2e.ts` suffix + separate `roots` keep the suites structurally separate). Real loopback HTTP, the real MCP SDK over `InMemoryTransport`, vendored real-world specs, dist packaging, and tsc-compiled emitted declarations. `@modelcontextprotocol/sdk` and `ajv` are dev-only and must never be imported from `src/`.
- **Official documents**: `e2e/official-documents.e2e.ts` runs the OpenAPI Initiative's own test documents (OpenAPI 3.0 archive, 3.1 and 3.2 `tests/schema`; vendored under `e2e/fixtures/oas/documents/<version>/{pass,fail}/`, pinned in `sources.json`) through the pipeline, offline. Each pass document is checked against the official JSON Schema (`e2e/helpers/oas-validate.ts`, Ajv), our types, our validator, `generateTools()` with a pinned tool count, and its diagnostics; each fail document must never crash. `KNOWN_GAPS` lists what does not hold yet, and each entry is asserted to STILL fail: fixing a gap fails the test until its entry is deleted, so the table only shrinks
- **Tested examples**: `examples/<name>/` pairs consumer-style code (`example.ts`, importing `mcp-from-openapi` — the e2e runner maps the bare specifier onto `src/index.ts`) with a colocated `example.e2e.ts` executed by `yarn test:e2e`. Each folder has a README; the index at `examples/README.md` and `docs/examples.md` point to them. New examples must follow this shape — an untested example is a doc bug.
- **Type tests**: `e2e/types/*.types.ts` check the public OpenAPI types the way a consumer sees them: `documents`/`reads`/`extensions` must compile, `rejections` holds must-fail cases each marked `// @ts-expect-error`. Compiled by `yarn typecheck` (through `e2e/tsconfig.json`), never run by Jest (the names end in neither `.e2e.ts` nor `.spec.ts`). See `e2e/types/README.md`
- **Schema-to-types parity**: `e2e/spec-types-parity.e2e.ts` proves `OAS30`/`OAS31`/`OAS32` declare exactly the fields of the official OAI JSON Schemas (a deviation needs a per-version allowlist entry with a reason). The schemas are pinned under `e2e/fixtures/oas/` (manifest `sources.json` with sha256, checked by `scripts/sync-oas-sources.mjs`) and read with `e2e/helpers/oas-schema.ts`; no network
- **Public-type differential**: `scripts/diff-public-types.mjs` compares the built declarations with a published release (CI job `public-types` in `push.yml`). Every difference must be on `scripts/public-types-allowlist.json` with a reason, and a stale entry fails too; `--update-allowlist` rewrites the entries, keeping existing reasons
- **Declaration check**: the packaging story scans `dist/**/*.d.ts`: only `zod/v4/core`, `node:http` and `node:https` may be imported, no `/// <reference lib>` beyond the ES libs, no ambient `declare module`
- **Coverage exclusion** (`collectCoverageFrom` in `jest.config.js`): `src/index.ts` (barrel file) and the types-only `src/arazzo-types.ts` and `src/spec/types/**`. `src/spec/index.ts` is NOT excluded: it re-exports runtime values, so the unit suite loads and covers it

### Testing Patterns

- **Inline specs (unit tests)**: Unit tests create OpenAPI spec objects directly (no fixture files). E2E story tests MAY load vendored real-world fixtures from `e2e/fixtures/` — provenance, pinned commits, and licenses documented in `e2e/fixtures/README.md`; regenerating a fixture requires updating the literal count assertions that pin it
- **Real loopback servers**: URL-loading, SSRF/connection-pinning, and e2e wire tests drive a real
  `127.0.0.1` HTTP server (via the shared `src/__tests__/helpers/loopback.ts` helper, which also
  captures each request's method/url/headers/raw body for wire assertions) with
  `refResolution.allowInternalIPs`, exercising the actual Node pinned transport + SSRF guard.
  This replaces `global.fetch` mocks and `$RefParser.dereference` spies for those paths, because
  the pinned transport bypasses `global.fetch`. Use `jest.spyOn(Response.prototype, …)` for
  transport-error injection (SWC compiles named exports as non-configurable getters, so the
  module's own exports can't be `jest.spyOn`-ed).
- **Temp files**: File loading tests create temp files in `os.tmpdir()`, clean up in `finally`
- **Spy on dereference**: tests still spy on `$RefParser.dereference` to inspect the resolver
  _config_ (canRead/read/redirects) without network; the `read` path's actual fetch is validated
  against a real loopback server instead.
- **`c8 ignore next`**: Used for defensive branches unreachable through normal code paths (V8 coverage ignores)
- **`transformIgnorePatterns`**: `@apidevtools/json-schema-ref-parser` is ESM-only and must be transformed by SWC

### ESM Dependency Handling

`@apidevtools/json-schema-ref-parser` v16 is ESM-only. The project uses dynamic `import()` in `generator.ts` so it works from both CJS and ESM contexts. Jest transforms the package via `transformIgnorePatterns` in `jest.config.js`.

## Options Flow

```text
LoadOptions (factory methods)
  -> constructor (normalizes defaults)
  -> initialize()
      -> $RefParser.dereference() [if dereference: true]
      -> Validator.validate() [if validate: true]

GenerateOptions (generateTools/generateTool)
  -> ParameterResolver(namingStrategy)
      .resolve(operation, pathParams, security, includeSecurityInInput)
  -> ResponseBuilder(preferredStatusCodes, includeAllResponses)
      .build(responses)
  -> resolveSchemaFormats(schema, resolvers) [if resolveFormats/formatResolvers set]
```

## Key Conventions

- `toJsonSchema()` converts OpenAPI SchemaObject to JSON Schema 2020-12 (exclusiveMin/Max boolean-to-numeric, `nullable` → type union, `example` → `examples`, drops `xml`)
- Schemas pass through `toJsonSchema()` in both ParameterResolver and ResponseBuilder
- Metadata is attached via `x-` prefixed properties (`x-parameter-location`, `x-status-code`, `x-content-type`)
- The `mapper` array maps inputSchema keys to their HTTP locations (path/query/header/body/cookie); `wholeBody: true` means the value IS the entire body; `serialization.binary` marks file parts
- Security info lives on mapper entries (not on inputSchema unless `includeSecurityInInput: true`)
- Tool names are always normalized to MCP rules (`[A-Za-z0-9_.-]`, `maxToolNameLength` cap default 64, hash-suffix truncation, collision dedup in `generateTools`)
- OpenAPI types (`src/spec/types`) are reader types: they describe documents we read, so the validator rejects invalid documents and the compiler does not. They declare no index signatures (an index signature rejects a document typed with the caller's own interfaces); `x-` extensions are read through `WithExtensions`
- Enumerated strings in the OpenAPI types are open (`'query' | 'header' | (string & {})`) wherever the field is a plain string; a spec map (paths, responses, `content`, components) is `SpecMap<T>` = `Record<string, T | undefined>`; free-form values (`example`, `default`, `enum`/`const` members) are `FreeFormValue` = `any` by design
- `SchemaObject` is always the object form; a boolean schema is typed only through `SchemaOrBoolean`. The cross-version aliases keep their names and stay assignable in both directions with the last published release, apart from the allowlisted differences
- Generation follows features, with ONE exception: operation discovery follows the declared version. `query` and `additionalOperations` are read only when the document declares 3.2 or newer (a newer 3.x minor included); in 3.0/3.1 each is ignored with one `FEATURE_NEWER_THAN_DECLARED_VERSION` diagnostic, and a missing/malformed/unsupported version (reachable only with `validate: false`) reads the eight historical methods. This is decided in exactly one place, `resolveOperationLayout(detectSpecVersion(document))` (exported), used by the generator, validator, lint and Arazzo, so an `excludeMethods` list written for the old methods cannot be bypassed by a new method. Everything else (parameter locations, bodies, security, schemas) is processed whatever the document declares; `in: querystring` skips its operation (with a diagnostic) in every version. The validator applies the profile of the declared `major.minor` (the patch never matters)
- Operations are enumerated ONLY through `listOperations` / `getOperation` (`src/spec/operations.ts`) with the document's layout, never by indexing a path item with a method name: one list of methods, own-property reads (no `constructor` from the prototype), a diagnostic for what is ignored. Standard methods match in any case; an additional method matches EXACTLY as written everywhere (`getOperation`, `generateTool`, Arazzo `operationPath`, `includeMethods`/`excludeMethods`)
- `metadata.method` is the lowercase fixed field name (`get`, `query`) or the `additionalOperations` key exactly as written (`LINK`); `HTTPMethod` is `StandardMethod | (string & {})`. Dedup hashes and names are seeded with it, so never upper-case it before storing; only `wireMethod` (used by `buildHttpRequest`) upper-cases a standard method
- Diagnostics instead of silent drops: a construct that is skipped or ignored (an unresolved security scheme, an unmapped parameter location, an ignored operation key) is recorded via `generator.getDiagnostics()` (`{ severity, code, message, path }`, `path` a JSON Pointer) and never dropped without a trace. Every code is in `DIAGNOSTIC_CODES` (`src/types.ts`; the spec layer's subset is `SPEC_DIAGNOSTIC_CODES`). The list is de-duplicated with `diagnosticKey` (bounded, so a huge document cannot make the key huge) and capped at `MAX_DIAGNOSTICS` (1,000, then one `DIAGNOSTICS_TRUNCATED`); the validator caps `errors`/`warnings` the same way. Validation errors still throw `ParseError` (message names the first error, bounded and escaped; `context.errors` lists all); only warnings and skips are diagnostics
- Untrusted document text never goes raw into a message or a path: `describeValue` (`messageText` in the validator) for values quoted in messages, `jsonPointer`/`appendPointer` for `path`. They cut long text and write control, bidirectional and lone-surrogate characters as `\uXXXX`; a pointer with a cut or escaped segment is display-only. The validator's legacy codes keep their historical unescaped `path` (key cut at `LEGACY_PATH_KEY_MAX_LENGTH`)
- A Security Requirement object naming an undefined scheme is dropped as a whole (`UNRESOLVED_SECURITY_SCHEME` per missing scheme); when every requirement of an operation is dropped the tool is not generated (`UNSATISFIABLE_SECURITY`, `generateTool` throws `GenerationError`), unless the document defines no `components.securitySchemes` at all, which keeps generating with empty security
- Tool `title`/`annotations` come from HTTP-method inference (`inferAnnotations`, default on) + `x-mcp` family overrides in `src/annotations.ts`
- `generateTools()` output is deterministically ordered (path asc, canonical method order)
- Filtering: tags/methods/path globs/`readOnlyOnly` in `shouldIncludeOperation`; `x-mcp` enable/disable resolves root < path < operation
- `buildHttpRequest` is the canonical request assembly (pure, no fetch); `RequestBuildError` for all failures
- `target` client-dialect transforms run LAST in generateTool (after formats and depth truncation)
- `secureDefaults: true` = redirects off + external refs off (explicit options still win)
- `LoadOptions.overlays` apply BEFORE dereference/validation, exactly once; `generator.lint()` runs on the patched document
- Trimming order in generateTool: formats → depth truncation → stripExamples/maxProperties/maxDescriptionLength → client target
- `metadata.responseHints` (unboundedArray/paginationParams/largeResponseRisk) computed on the FINAL output schema
- Format resolution is a post-processing step applied to final inputSchema/outputSchema; `maxSchemaDepth` truncation (default 10) runs after it, BEFORE client target transforms
- Shared `$ref` targets stay bounded (issue #48): `toJsonSchema` converts each acyclic node once and stops at `maxDepth`; a revisited result is reused if its conversion was self-contained (no depth cut, no cycle back to it or above), else only if Tarjan SCC — run lazily, at most once per conversion, over the edges walkable within `maxDepth` — shows it off any walkable cycle (cyclic nodes convert per path, preserving the cut-at-revisit output) (`allOf` members don't count — body flattening hoists them) with `{}` placeholders that `truncateDepth` always discards. `resolveSchemaFormats` memoizes by node; `truncateDepth` materializes a fresh unshared tree. `maxSchemaNodes` (default 100k) budgets every conversion visit (converted, reused, or placeholder — each fills a slot) and the truncated output → `SchemaError` (`ArazzoError` from `fromArazzo`); `ResponseBuilder` picks the emitted responses before converting, so unselected ones cost nothing. Generator output is byte-identical to per-occurrence conversion; conversion and truncation must use the same `resolveSchemaLimits` depth
- Walks over unbounded nesting keep explicit stacks (issue #50): `dereferenceInternal`, `toJsonSchema` (frames with child slots, visited in the recursive order so cache/budget behave identically), body flattening (`collectObjectMembers`), `resolveSchemaFormats`, lint's `measureSchema`/`schemaHasExample`, and x-mcp `cleanseMeta` walk with explicit stacks, so `$ref` chains of any length generate. `truncateDepth` and every later step recurse per level, bounded by `maxSchemaDepth`; `generateTool` turns a stack overflow there into a `SchemaError` naming `maxSchemaDepth`
- `maxSchemaNodes` counts every JSON value (issue #50): `truncateDepth` charges each schema object, keyword value, and value inside it; conversion charges 1 per visit plus 1 per keyword of each converted schema (a cyclic schema converts once per path); client-target `inlineLocalRefs` takes `{ maxNodes }` (generator passes `maxSchemaNodes`; standalone unbounded), caps nesting incl. `$ref` hops at 1000, and neither copies nor charges target keywords a `$ref`'s siblings overwrite (`undefined` placeholders keep key order). Every budgeted walk counts an array hole as the `null` it serializes as, rejecting an array longer than the budget left before walking it (`ensureBudget`/`mapSlots`, conversion's `queueMembers`). Smallest budget for every real tool: 22,232 (full GitHub spec), 19,225 (Discord)
- Spec values that land in a tool are copied, never shared (`copyJsonValue`): dereferencing resolves `$ref`s inside values too, so a few can expand exponentially. `truncateDepth` copies every object-valued keyword (`default`, `examples`, `enum`, `required`, `x-*`, ...) and counts its values against `maxNodes`; `buildTool` copies `title`, `mapper`, `metadata`, and `_meta`'s operation entry under a `maxSchemaNodes` budget; extension `meta` is copied with prototype keys omitted, every value of `x-mcp` + `x-frontmcp` meta counting against `maxSchemaNodes` (`extractExtensionOverrides(op, { maxMetaNodes })`, default 100k). Cycles are dropped; nesting past 1000 levels → `SchemaError`. Operation filters (`resolveExtensionEnabled`, `readOnlyOnly`) use `extractExtensionSettings`, which never copies meta/icons, so a bad meta fails only its own tool

## Documentation

- All docs live in `docs/` folder
- `docs/FORMAT_RESOLUTION.md` — Format resolution feature docs (built-in resolvers, custom resolvers, standalone usage)

### README Links for npm

All links in `README.md` must use **absolute GitHub URLs** (not relative paths) because npm renders README on its own domain and relative links break. Use the format:

```
https://github.com/agentfront/mcp-from-openapi/blob/main/docs/<file>.md
```

When adding new docs or links to README, always use absolute URLs pointing to the `main` branch.
