# Architecture

[Home](../README.md) | [API Reference](./api-reference.md)

---

## System Overview

```
OpenAPIToolGenerator (Main Entry Point)
  ├── Validator           → OpenAPI document validation
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
     Validate (optional)
         ↓
   Dereference $refs (optional, with SSRF protection)
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
- Handles SSRF protection for `$ref` resolution
- Generates tool names (from operationId or path+method)

**Key files:** `src/generator.ts`

### ParameterResolver

**Responsibility:** Extract parameters, detect conflicts, generate input schema and mapper.

**Algorithm:**
1. Collect parameters from path item + operation (path, query, header, cookie)
2. Extract request body properties as body parameters
3. Group all parameters by name
4. Detect conflicts (same name in multiple locations)
5. Apply naming strategy to resolve conflicts
6. Build combined `inputSchema` with unique property names
7. Create `ParameterMapper[]` entries mapping inputs to request locations
8. Process security requirements (add to mapper, optionally to schema)

**Key files:** `src/parameter-resolver.ts`

### ResponseBuilder

**Responsibility:** Extract response schemas, handle multiple status codes.

- Selects content type by preference (JSON > HAL+JSON > problem+JSON > XML > text)
- Handles no-content responses (204) as `type: 'null'`
- Builds `oneOf` unions for multiple responses or selects preferred
- Annotates schemas with `x-status-code` and `x-content-type`
- Falls back through 2xx, 3xx, then first available when preferred codes aren't found

**Key files:** `src/response-builder.ts`

### Validator

**Responsibility:** Validate OpenAPI 3.0.x and 3.1.x document structure.

**Checks (errors):**
- OpenAPI version field present and valid
- `info`, `info.title`, `info.version` present
- Paths start with `/`
- Path parameters are defined and required
- Operations have responses
- Parameters have name, `in`, and schema/content

**Checks (warnings):**
- No paths defined
- No servers defined
- No operation IDs
- Security requirements without schemes

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
  ├── types.ts               # Type definitions + utility functions
  └── errors.ts              # Error class hierarchy
```

---

**Related:** [API Reference](./api-reference.md) | [Getting Started](./getting-started.md)
