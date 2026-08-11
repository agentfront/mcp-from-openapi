# CLAUDE.md - Project Guide for mcp-from-openapi

## Project Overview

**mcp-from-openapi** converts OpenAPI 3.0/3.1 specifications into MCP (Model Context Protocol) tool definitions. It handles parameter resolution, schema conversion, security configuration, SSRF-safe `$ref` dereferencing, and format-to-schema enrichment.

## Architecture

```text
OpenAPI Spec (JSON/YAML/URL/File)
    |
    v
OpenAPIToolGenerator (src/generator.ts)
    |-- initialize(): dereference $refs, then validate
    |-- generateTools(): iterate paths/operations
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

| File | Purpose |
|------|---------|
| `src/generator.ts` | Main entry point. Factory methods (`fromJSON`, `fromYAML`, `fromURL`, `fromFile`), tool generation, tool-name normalization/dedup, SSRF protection, `$ref` dereferencing |
| `src/types.ts` | All type definitions, `toJsonSchema()` conversion (incl. `nullable`/`example`/`xml` normalization), `isReferenceObject()` guard |
| `src/annotations.ts` | HTTP-method annotation inference + `x-mcp` extension family overrides (`x-speakeasy-mcp` < `x-mcp` < `x-frontmcp`); `resolveExtensionEnabled` (root < path < operation) |
| `src/request-builder.ts` | `buildHttpRequest` — pure request assembly with full OpenAPI style/explode serialization, multipart/binary bodies, injection guards |
| `src/client-targets.ts` | Per-client schema dialect transforms (`claude`/`openai`/`gemini`/`strict`), composable and exported standalone |
| `src/sdk.ts` | `toSdkTool` — registerTool-shaped output for the official MCP SDK (no SDK dependency) |
| `src/parameter-resolver.ts` | Resolves OpenAPI parameters + requestBody into flat inputSchema with conflict resolution; flattens `allOf` bodies, flags `wholeBody`/`binary` |
| `src/response-builder.ts` | Builds outputSchema from OpenAPI responses with content-type and status code preferences |
| `src/format-resolver.ts` | Format-to-schema resolution. Built-in resolvers for uuid, date-time, email, int32, etc. |
| `src/schema-builder.ts` | Static utilities: merge, union, clone, flatten, simplify, withFormat, etc. |
| `src/security-resolver.ts` | Resolves security schemes (Bearer, Basic, Digest, API Key, OAuth2, OpenID Connect) |
| `src/validator.ts` | Validates OpenAPI document structure |
| `src/errors.ts` | Error class hierarchy: LoadError, ParseError, ValidationError, GenerationError, SchemaError |
| `src/index.ts` | Barrel file for public exports |

## Development Commands

```bash
yarn test              # Run all tests (unit + integration)
yarn test:unit         # Run unit tests only
yarn test:integration  # Run integration tests only
yarn test:coverage     # Run tests with coverage report
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

- **Framework**: Jest 29 with SWC transformer (`@swc/jest`)
- **Coverage provider**: V8 (`coverageProvider: 'v8'` in jest.config.js)
- **Coverage target**: 100% statements, branches, functions, lines
- **Unit tests**: `src/__tests__/*.spec.ts` (one per module)
- **Integration tests**: `src/__tests__/integration.spec.ts` (full pipeline, imports from entrypoint only)
- **Coverage exclusion**: `src/index.ts` (barrel file)

### Testing Patterns

- **Inline specs**: Tests create OpenAPI spec objects directly (no fixture files)
- **Real loopback servers**: URL-loading and SSRF/connection-pinning tests drive a real
  `127.0.0.1` HTTP server (via the shared `createLoopbackServer` helper) with
  `refResolution.allowInternalIPs`, exercising the actual Node pinned transport + SSRF guard.
  This replaces `global.fetch` mocks and `$RefParser.dereference` spies for those paths, because
  the pinned transport bypasses `global.fetch`. Use `jest.spyOn(Response.prototype, …)` for
  transport-error injection (SWC compiles named exports as non-configurable getters, so the
  module's own exports can't be `jest.spyOn`-ed).
- **Temp files**: File loading tests create temp files in `os.tmpdir()`, clean up in `finally`
- **Spy on dereference**: tests still spy on `$RefParser.dereference` to inspect the resolver
  *config* (canRead/read/redirects) without network; the `read` path's actual fetch is validated
  against a real loopback server instead.
- **`c8 ignore next`**: Used for defensive branches unreachable through normal code paths (V8 coverage ignores)
- **`transformIgnorePatterns`**: `@apidevtools/json-schema-ref-parser` is ESM-only and must be transformed by SWC

### ESM Dependency Handling

`@apidevtools/json-schema-ref-parser` v15 is ESM-only. The project uses dynamic `import()` in `generator.ts` so it works from both CJS and ESM contexts. Jest transforms the package via `transformIgnorePatterns` in `jest.config.js`.

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
- Tool `title`/`annotations` come from HTTP-method inference (`inferAnnotations`, default on) + `x-mcp` family overrides in `src/annotations.ts`
- `generateTools()` output is deterministically ordered (path asc, canonical method order)
- Filtering: tags/methods/path globs/`readOnlyOnly` in `shouldIncludeOperation`; `x-mcp` enable/disable resolves root < path < operation
- `buildHttpRequest` is the canonical request assembly (pure, no fetch); `RequestBuildError` for all failures
- `target` client-dialect transforms run LAST in generateTool (after formats and depth truncation)
- `secureDefaults: true` = redirects off + external refs off (explicit options still win)
- Format resolution is a post-processing step applied to final inputSchema/outputSchema; `maxSchemaDepth` truncation (default 10) runs last

## Documentation

- All docs live in `docs/` folder
- `docs/FORMAT_RESOLUTION.md` — Format resolution feature docs (built-in resolvers, custom resolvers, standalone usage)

### README Links for npm

All links in `README.md` must use **absolute GitHub URLs** (not relative paths) because npm renders README on its own domain and relative links break. Use the format:

```
https://github.com/agentfront/mcp-from-openapi/blob/main/docs/<file>.md
```

When adding new docs or links to README, always use absolute URLs pointing to the `main` branch.
