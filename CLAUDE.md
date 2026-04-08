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
| `src/generator.ts` | Main entry point. Factory methods (`fromJSON`, `fromYAML`, `fromURL`, `fromFile`), tool generation, SSRF protection, `$ref` dereferencing |
| `src/types.ts` | All type definitions, `toJsonSchema()` conversion, `isReferenceObject()` guard |
| `src/parameter-resolver.ts` | Resolves OpenAPI parameters + requestBody into flat inputSchema with conflict resolution |
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
- **Mock fetch**: URL loading tests mock `global.fetch` with `jest.fn()`
- **Temp files**: File loading tests create temp files in `os.tmpdir()`, clean up in `finally`
- **Spy on dereference**: SSRF tests spy on `$RefParser.dereference` to inspect options without making network calls
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

- `toJsonSchema()` converts OpenAPI SchemaObject to JSON Schema (handles exclusiveMin/Max boolean-to-numeric conversion)
- Schemas pass through `toJsonSchema()` in both ParameterResolver and ResponseBuilder
- Metadata is attached via `x-` prefixed properties (`x-parameter-location`, `x-status-code`, `x-content-type`)
- The `mapper` array maps inputSchema keys to their HTTP locations (path/query/header/body/cookie)
- Security info lives on mapper entries (not on inputSchema unless `includeSecurityInInput: true`)
- Format resolution is a post-processing step applied to final inputSchema/outputSchema

## Documentation

- All docs live in `docs/` folder
- `docs/FORMAT_RESOLUTION.md` — Format resolution feature docs (built-in resolvers, custom resolvers, standalone usage)

### README Links for npm

All links in `README.md` must use **absolute GitHub URLs** (not relative paths) because npm renders README on its own domain and relative links break. Use the format:

```
https://github.com/agentfront/mcp-from-openapi/blob/main/docs/<file>.md
```

When adding new docs or links to README, always use absolute URLs pointing to the `main` branch.
