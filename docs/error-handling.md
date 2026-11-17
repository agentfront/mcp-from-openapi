# Error Handling

[Home](../README.md) | [Getting Started](./getting-started.md) | [API Reference](./api-reference.md)

---

## Error Hierarchy

All errors extend `OpenAPIToolError`, which extends `Error`:

```
OpenAPIToolError (base)
  ├── LoadError
  ├── ParseError
  ├── ValidationError
  ├── GenerationError
  ├── RequestBuildError
  └── SchemaError
```

Every error carries a `context` property with structured details about the failure.

---

## Error Classes

### LoadError

Thrown when fetching from a URL or reading a file fails.

```typescript
try {
  const generator = await OpenAPIToolGenerator.fromURL('https://example.com/bad-url');
} catch (error) {
  if (error instanceof LoadError) {
    console.error(error.message);     // "Failed to load OpenAPI spec from URL: ..."
    console.error(error.context?.url); // "https://example.com/bad-url"
    console.error(error.context?.status); // 404
  }
}
```

**Context fields:** `url`, `filePath`, `status`, `originalError`

### ParseError

Thrown when YAML/JSON parsing fails or when `$ref` dereferencing fails.

```typescript
try {
  const generator = await OpenAPIToolGenerator.fromYAML('invalid: yaml: : :');
} catch (error) {
  if (error instanceof ParseError) {
    console.error(error.message); // "Failed to parse YAML: ..."
  }
}
```

Also thrown when an OpenAPI document fails validation (when `validate: true`). Validation runs at the first `generateTools()` or `generateTool()`, not in the factories. The message is `Invalid OpenAPI document: <first error>`, followed by `(and N more; see the error's context.errors)` when there is more than one. The first error can quote the document, so the message cuts it at 512 characters and writes control and bidirectional characters as `\uXXXX`; `context.errors` holds every `ValidationErrorDetail` as the validator produced it (at most 1,000 of each kind, then one `DIAGNOSTICS_TRUNCATED` entry):

```typescript
try {
  await generator.generateTools();
} catch (error) {
  if (error instanceof ParseError && error.context?.errors) {
    for (const { code, path, message } of error.context.errors) {
      console.error(code, path, message);
      // e.g. 'INVALID_OPENAPI_VERSION', '/swagger', 'Swagger 2.0 documents are not supported. ...'
    }
  }
}
```

A document that declares an unsupported version (Swagger 2.0, another major, a malformed value) fails this way with `INVALID_OPENAPI_VERSION`, or `MISSING_OPENAPI_VERSION` when no version is declared; see [OpenAPI Versions](./openapi-versions.md). The same findings are available without throwing from `generator.validate()`, and what validation only warns about from `generator.getDiagnostics()`.

**Context fields:** `originalError`, `errors` (when validation fails during dereference)

### ValidationError

Thrown when explicit validation finds spec issues.

```typescript
try {
  const result = await generator.validate();
  if (!result.valid) {
    // result.errors: ValidationErrorDetail[]
    // result.warnings: ValidationWarning[]
  }
} catch (error) {
  if (error instanceof ValidationError) {
    console.error(error.errors); // Array of validation error details
  }
}
```

**Context fields:** `errors` (array of validation details)

### GenerationError

Thrown when tool generation fails for a specific operation.

**Context fields:** `path`, `method`, `operationId`, `originalError`

`generateTool()` also throws it for an operation that `generateTools()` skips with a diagnostic, with context `path`, `method` and `pointer` (a JSON Pointer to the cause): a parameter in a location the library does not map (today `in: querystring`, or a Swagger `in: body`; `UNSUPPORTED_PARAMETER_LOCATION`), or no Security Requirement that can be satisfied (`UNSATISFIABLE_SECURITY`, see [Security](./security.md)). `generateTools()` leaves such an operation out and records the diagnostic instead; see [OpenAPI Versions](./openapi-versions.md#diagnostics).

### RequestBuildError

Thrown by `buildHttpRequest()` for input it cannot turn into a request: a missing required parameter, a value that cannot be serialized, an unresolved path placeholder or server variable, a method that is not an RFC 9110 token or is `CONNECT`, and a mapper entry with an unknown `type`. Its `context` names the parameter or method concerned. See [Request Builder](./request-builder.md#errors).

### SchemaError

Thrown when schema manipulation fails (e.g., in `SchemaBuilder` operations).

**Context fields:** `originalError`

---

## Base Class: OpenAPIToolError

```typescript
class OpenAPIToolError extends Error {
  readonly context?: Record<string, any>;
  
  constructor(message: string, context?: Record<string, any>);
}
```

All errors include proper stack traces via `Error.captureStackTrace` (Node.js).

---

## Practical Patterns

### Catch-all with type narrowing

```typescript
import {
  OpenAPIToolGenerator,
  LoadError,
  ParseError,
  ValidationError,
  GenerationError,
  SchemaError,
} from 'mcp-from-openapi';

try {
  const generator = await OpenAPIToolGenerator.fromURL(url);
  const tools = await generator.generateTools();
} catch (error) {
  if (error instanceof LoadError) {
    // Network/file issues -- retry or use fallback
    console.error('Load failed:', error.message);
  } else if (error instanceof ParseError) {
    // Malformed spec -- report to user
    console.error('Parse failed:', error.message);
  } else if (error instanceof ValidationError) {
    // Invalid spec structure -- show details
    console.error('Validation failed:', error.errors);
  } else if (error instanceof GenerationError) {
    // Specific operation failed -- skip or warn
    console.error('Generation failed:', error.message);
  } else if (error instanceof SchemaError) {
    // Schema issue -- unlikely in normal usage
    console.error('Schema error:', error.message);
  } else {
    throw error; // Unknown error
  }
}
```

### Non-fatal generation errors

`generateTools()` catches individual operation failures and logs a warning. It will still return tools for operations that succeeded. Use `generateTool()` for strict per-operation error handling:

```typescript
try {
  const tool = await generator.generateTool('/users/{id}', 'get');
} catch (error) {
  // This operation specifically failed
}
```

---

**Related:** [Getting Started](./getting-started.md) | [API Reference](./api-reference.md) | [Configuration](./configuration.md)
