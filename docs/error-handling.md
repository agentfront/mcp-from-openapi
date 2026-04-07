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

Also thrown when an OpenAPI document fails validation during load (when `validate: true`):

```typescript
// ParseError with context.errors containing validation details
```

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
