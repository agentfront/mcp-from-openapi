# Architecture

[Home](../README.md) | [API Reference](./api-reference.md)

---

## System Overview

```
OpenAPIToolGenerator (Main Entry Point)
  ├── Spec layer (src/spec) → declared version, per-version profiles, operation walk, diagnostics,
  │                           Swagger 2.0 → OpenAPI 3.0 conversion (upgradeSwagger2)
  ├── Validator           → Swagger 2.0 / OpenAPI document validation (rules of the declared version)
  ├── ParameterResolver   → Parameter conflict resolution & mapping
  ├── ResponseBuilder     → Output schema generation
  ├── SchemaBuilder       → Schema manipulation utilities
  └── SecurityResolver    → Framework-agnostic auth resolution
```

---

## Data Flow

```
User Input (URL / File / String / Object)
         ↓
     Load & Parse
         ↓
   OpenAPI Document
         ↓
     Read declared version (detectSpecVersion)
         ↓
   Dereference $refs (optional, with SSRF protection; references to the
   document itself are made local first, relative ones resolve against its base URI)
         ↓
     Validate (optional, rules of the declared version, a Swagger 2.0
     document as written; once per generator)
         ↓
     Swagger 2.0 only: convert to OpenAPI 3.0 (upgradeSwagger2, once;
     its findings are SWAGGER_* diagnostics)
         ↓
     List operations (listOperations with the declared version's layout:
     the eight classic methods; plus query and additionalOperations from 3.2)
         ↓
     Filter Operations
         ↓
     For Each Operation:
         ├── ParameterResolver  → inputSchema + mapper
         ├── ResponseBuilder    → outputSchema
         └── Metadata Extractor → metadata (security, servers, tags, etc.)
         ↓
     McpOpenAPITool[]
```

---

## Core Components

### OpenAPIToolGenerator

**Responsibility:** Entry point, orchestration, document management.

- Provides four factory methods for loading specs from different sources
- Manages the dereference lifecycle (lazy initialization)
- Coordinates validation, parameter resolution, response building, and metadata extraction
- Handles SSRF protection for `$ref` resolution, and keeps the document's URIs: the retrieval URI (`documentUri`, or the URL or file it was read from) that relative references are read against, and, from 3.2, the `$self` that names it
- Makes `validate()` dereference first when the document holds a `$ref` that does not start with `#`, returning `UNREADABLE_REFERENCE` for one it cannot read
- Converts a Swagger 2.0 document to OpenAPI 3.0 once it is dereferenced and validated (`upgradeSwagger2`), and generates from the conversion; `getDocument()` returns the converted document from then on, `getSpecVersion()` keeps the declared one, and a 2.0 document loaded with `dereference: false` is refused (`DEREFERENCE_REQUIRED`)
- Generates tool names (from operationId or path+method)
- Enumerates operations through the spec layer, never by indexing a path item with a method name
- Records what it skipped or ignored as diagnostics (`getDiagnostics()`) instead of dropping it silently

**Key files:** `src/generator.ts`

### Spec layer

**Responsibility:** Everything that knows about OpenAPI versions. It imports nothing from the rest of the library (the compiler enforces it through `src/spec/tsconfig.json`), so it can be extracted as is. It returns diagnostics and the generator decides what each becomes.

- `versions.ts`: reads the declared version (`detectSpecVersion`, from `openapi` or, for Swagger 2.0, `swagger`), holds one profile per known `major.minor` (2.0, 3.0, 3.1, 3.2) with the rules the validator applies, and names the version that introduced each feature
- `operations.ts`: the one place that knows where operations live in a Path Item (`listOperations`, `getOperation`), with own-property reads and diagnostics for what it ignores. Additional methods match exactly as written
- `diagnostics.ts`: the `SpecDiagnostic` shape, the spec layer's codes, `diagnosticKey` (bounded de-duplication keys), and the helpers that escape and cap document text before it reaches a message or a JSON Pointer (`describeValue`, `jsonPointer`)
- `upgrade-v2.ts`: `upgradeSwagger2`, the conversion of a dereferenced Swagger 2.0 document to OpenAPI 3.0.3 (`host`/`basePath`/`schemes` to `servers`, `in: body` and `in: formData` to `requestBody`, `collectionFormat` to `style`, `securityDefinitions` to `components.securitySchemes`, ...). Total (never throws), pure and linear, and bounded (32 media types per `consumes`/`produces` list, 1,000,000 created entries; a 2.0 list applies to every operation, so the 3.0 form repeats it); what it cannot carry over exactly is a `SWAGGER_*` diagnostic, grouped one per kind
- `types/`: the Swagger 2.0 (`OAS20`) and OpenAPI 3.0, 3.1 and 3.2 object types

Which operations a document has follows its declared version (`resolveOperationLayout`: `query` and `additionalOperations` only from 3.2), and so does validation; every other construct the library understands is processed whatever version the document declares. The generator, the validator, lint and Arazzo all read operations through the same layout. See [OpenAPI Versions](./openapi-versions.md).

**Key files:** `src/spec/versions.ts`, `src/spec/operations.ts`, `src/spec/diagnostics.ts`, `src/spec/upgrade-v2.ts`

### ParameterResolver

**Responsibility:** Extract parameters, detect conflicts, generate input schema and mapper.

**Algorithm:**
1. Merge the parameters of the path item with the operation's (path, query, querystring, header, cookie): an operation-level parameter overrides a path-level one with the same name and location (a header name in any case), and the last of a repeated name and location wins (`analyzeParameters`, also used by the validator, the generator and lint)
2. Read each parameter from its `schema`, or from its `content` media type when it has no `schema` (an `in: querystring` parameter is always read from `content` and becomes a whole-query entry)
3. Extract request body properties as body parameters
4. Group all parameters by name
5. Detect conflicts (same name in multiple locations)
6. Apply naming strategy to resolve conflicts
7. Build combined `inputSchema` with unique property names
8. Create `ParameterMapper[]` entries mapping inputs to request locations
9. Process security requirements (add to mapper, optionally to schema)

**Key files:** `src/parameter-resolver.ts`

### ResponseBuilder

**Responsibility:** Extract response schemas, handle multiple status codes.

- Selects content type by preference (JSON > HAL+JSON > problem+JSON > XML > text)
- Handles no-content responses (204) as `type: 'null'`
- Builds `oneOf` unions for multiple responses or selects preferred
- Annotates schemas with `x-status-code` and `x-content-type`
- Falls back through an explicit 2xx, the range keys (`2XX`, kept as `'2XX'` in `x-status-code`), 3xx, then first available when preferred codes aren't found (see [Response Schemas](./response-schemas.md#selection-priority))
- Reports a streamed response (OpenAPI 3.2 `itemSchema`) apart from the output schema (`buildStream`), which the generator stores in `metadata.responseStream`
- Uses a response's `summary` as its description when it has no `description`

**Key files:** `src/response-builder.ts`

### Validator

**Responsibility:** Validate Swagger 2.0 and OpenAPI 3.0.x, 3.1.x and 3.2.x document structure with the rules of the version the document declares.

**Checks (errors):**
- Version field present and processable (`swagger: "2.0"` or `openapi` 3.0 to 3.2; other majors and minors, such as Swagger 1.2, are rejected; a newer 3.x minor is accepted with a warning)
- `info`, `info.title`, `info.version` present
- Paths start with `/`
- Path parameters are defined and required
- Operations have non-empty responses (`responses` is required in Swagger 2.0 and 3.0 only)
- Parameters have a name (a number or boolean is read as its text, with a warning; an object or array is an error), a location the declared version defines, and schema/content (Swagger 2.0: `schema` for `in: body`, `type` for the rest)
- Swagger 2.0 rules: at most one body parameter per operation, none next to `formData` parameters, `basePath` starts with `/` and is usable in a URL
- OpenAPI 3.2 rules: at most one `in: querystring` parameter, not combined with `in: query`, using `content` with a media type; in a document declaring 3.2 or newer, `additionalOperations` is an object whose keys are HTTP method tokens other than the upper-case name of a method with its own field; method fields hold objects; in a document declaring 3.2 or newer, `$self` is a string in the form of a URI reference without a fragment

**Checks (warnings):**
- No paths defined
- No servers defined (Swagger 2.0: no `host`)
- No operation IDs
- Security requirements without schemes
- A newer 3.x minor version, both `openapi` and `swagger`, or a construct newer than the declared version (`query`, `additionalOperations` and `$self` in a 3.0 or 3.1 document are not read; `in: querystring` is read all the same; `trace`, `query` and `additionalOperations` in a Swagger 2.0 document are not read)
- A parameter's `content` that does not hold exactly one media type, and a parameter list that repeats a name and location
- Values the operation walk ignores (a path item that is not an object, a case variant of a standard method as an `additionalOperations` key, a `CONNECT` method)
- Each list (`errors`, `warnings`) is capped at 1,000 entries, then one `DIAGNOSTICS_TRUNCATED` entry

**Key files:** `src/validator.ts`

### SchemaBuilder

**Responsibility:** Static utilities for JSON Schema manipulation.

Provides factory methods (object, array, string, number, etc.), composition (merge, union), modification (withDescription, withRange, etc.), and utilities (clone, flatten, simplify, removeRefs).

**Key files:** `src/schema-builder.ts`

### SecurityResolver

**Responsibility:** Map OpenAPI security schemes to actual auth values.

- Resolves HTTP (bearer, basic, digest), API Key, OAuth2, OpenID Connect
- Detects signature-based auth (HMAC, AWS, custom)
- Supports custom resolvers for framework-specific auth
- Provides `checkMissingSecurity()` for validation
- Provides `signRequest()` for signature-based auth

**Key files:** `src/security-resolver.ts`

---

## Design Patterns

| Pattern | Usage |
|---------|-------|
| **Factory** | `OpenAPIToolGenerator.fromURL()`, `.fromFile()`, `.fromYAML()`, `.fromJSON()` |
| **Strategy** | `NamingStrategy` for parameter conflict resolution and tool naming |
| **Builder** | `SchemaBuilder` for constructing schemas fluently |
| **Template Method** | Tool generation pipeline (validate → dereference → resolve → build → extract) |

---

## Extension Points

1. **Custom Naming Strategies** -- Implement `NamingStrategy` to control parameter renaming and tool naming
2. **Custom Filters** -- Use `filterFn` in `GenerateOptions` to select which operations become tools
3. **Custom Security Resolution** -- Use `customResolver` in `SecurityContext` for framework-specific auth
4. **Custom Signature Generation** -- Use `signatureGenerator` in `SecurityContext` for signature-based auth
5. **Schema Transformation** -- Use `SchemaBuilder` utilities post-generation

---

## Module Structure

```
src/
  ├── index.ts               # Public exports
  ├── generator.ts           # OpenAPIToolGenerator class
  ├── parameter-resolver.ts  # ParameterResolver class
  ├── response-builder.ts    # ResponseBuilder class
  ├── security-resolver.ts   # SecurityResolver class + types
  ├── schema-builder.ts      # SchemaBuilder class
  ├── validator.ts           # Validator class
  ├── base-uri.ts            # Document URIs, $self rules, self-reference detection, security scheme URIs
  ├── ssrf.ts                # SSRF guard: host/address checks, pinned transport, safeFetch
  ├── types.ts               # Type definitions + utility functions
  ├── errors.ts              # Error class hierarchy
  └── spec/                  # Version-aware spec layer (imports nothing from outside)
      ├── versions.ts        # Declared version, per-version profiles, feature table
      ├── upgrade-v2.ts      # upgradeSwagger2: Swagger 2.0 -> OpenAPI 3.0
      ├── operations.ts      # listOperations / getOperation
      ├── diagnostics.ts     # SpecDiagnostic, codes, JSON Pointer helpers
      └── types/             # Swagger 2.0 / OpenAPI 3.0 / 3.1 / 3.2 object types
```

---

**Related:** [API Reference](./api-reference.md) | [Getting Started](./getting-started.md)
