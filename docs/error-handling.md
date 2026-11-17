# Error Handling

[Home](../README.md) | [Getting Started](./getting-started.md) | [API Reference](./api-reference.md)

---

## Error Hierarchy

All errors extend `OpenAPIToolError`, which extends `Error`:

```
OpenAPIToolError (base)
  ├── LoadError
  │     └── SsrfError
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

A `LoadOptions.documentUri` that is not an absolute `http`, `https` or `file` URI of at most 2,048 characters, without user information, fragment or (for `file:`) host, also throws a `LoadError`. It is checked first, before `fromURL` fetches or `fromFile` reads anything. `context.documentUri` holds the value as the message quotes it, cut, with any user information shown as `***@`. See [SSRF Prevention](./ssrf-prevention.md#documenturi).

**Context fields:** `url`, `filePath`, `status`, `originalError`, `documentUri`

### SsrfError

A `LoadError` thrown when the SSRF guard refuses the spec URL of `fromURL` (or a redirect hop of it). Catch it apart from other load failures, or let `instanceof LoadError` handle both. `context.reason` says why: `invalid-url`, `protocol`, `host-not-allowed`, `host-blocked`, `internal-address` (the host is an internal name or address), `resolved-address` (the name resolves to one), `dns-failed`, `too-large` (the body exceeds 10 MiB), `too-many-redirects` and `no-transport`.

```typescript
try {
  await OpenAPIToolGenerator.fromURL("http://169.254.169.254/latest/meta-data/");
} catch (error) {
  if (error instanceof SsrfError) {
    error.context?.reason; // 'internal-address'
  }
}
```

**Context fields:** `url`, `reason`

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

A document that declares an unsupported version (Swagger 2.0, another major, a malformed value) fails this way with `INVALID_OPENAPI_VERSION`, or `MISSING_OPENAPI_VERSION` when no version is declared; see [OpenAPI Versions](./openapi-versions.md). The same findings are available without throwing from `generator.validate()` (it throws only for a `$ref` that cannot be read, as below), and what validation only warns about from `generator.getDiagnostics()`.

A failed dereference (`generateTools()`, `generateTool()`, `lint()`, or `validate()`, which returns it instead; see below) is a `ParseError` whose message is `Failed to dereference OpenAPI document: <why>` and whose `context.rule` says why. A `$ref` that cannot be read names the reference, what it was resolved against, the URL or path it became, the rule that refused it and the option that would allow it:

```typescript
try {
  await generator.generateTools();
} catch (error) {
  if (error instanceof ParseError && error.context?.rule) {
    error.message;
    // 'Failed to dereference OpenAPI document: Cannot read $ref "./schemas/pet.json"
    //  resolved against "/tmp/petstore/openapi.json" to "/tmp/petstore/schemas/pet.json":
    //  it is read as a local file, and refResolution.allowedProtocols ("http", "https") does not include "file";
    //  add "file" to refResolution.allowedProtocols to read it'
    error.context.rule; // 'protocol'
    error.context.reference; // './schemas/pet.json'
    error.context.base; // '/tmp/petstore/openapi.json'
    error.context.resolved; // '/tmp/petstore/schemas/pet.json'
    // error.context.path, the JSON Pointer of the $ref, is there when the location is known:
    // not for this document, which declares 3.1; a 3.0 or 3.2 one has it
  }
}
```

`rule` is one of `protocol`, `host-not-allowed`, `host-blocked`, `internal-address`, `resolved-address`, `dns-failed`, `too-large`, `timeout`, `response`, `fetch-failed`, `file-error`, `missing-target`, `invalid-document`, `base-too-long` and `unreadable`; each is described in [SSRF Prevention](./ssrf-prevention.md#when-a-reference-cannot-be-read). The message and every string of `context` are cut and escaped (a document controls them), the query of `base` and `resolved` is shown as `?...`, and the raw error is not kept. When several references cannot be read, the one reported is the first in document order, whatever order the network answers in. The exception is a document that cannot be copied at all (a YAML alias that makes it contain itself): that `ParseError` has only `originalError`.

`generator.validate()` reads references like generation but does not throw for one that cannot be read. It returns `{ valid: false, errors: [{ code: 'UNREADABLE_REFERENCE', message, path }] }`, with `message` the text above without the `Failed to dereference OpenAPI document:` prefix and `path` the JSON Pointer of the `$ref` when it is in the document itself.

**Context fields:** `rule`, `reference`, `base`, `resolved`, `path` (a dereference failure; the last four only when it names a `$ref`), `errors` (when validation fails), `originalError` (a document that cannot be copied)

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

`generateTool()` also throws it for an operation that `generateTools()` skips with a diagnostic, with context `path`, `method` and `pointer` (a JSON Pointer to the cause): a parameter in a location the library does not map (a Swagger `in: body`, a missing `in`; `UNSUPPORTED_PARAMETER_LOCATION`), parameters that break an OpenAPI 3.2 rule on `in: querystring` (`MULTIPLE_QUERYSTRING_PARAMETERS`, `QUERYSTRING_WITH_QUERY_PARAMETERS`, `QUERYSTRING_PARAMETER_WITHOUT_CONTENT`; a document with `validate: true` is rejected by the validator before this), or no Security Requirement that can be satisfied (`UNSATISFIABLE_SECURITY`, see [Security](./security.md)). `ParameterResolver.resolve()` used on its own throws a `GenerationError` with context `code` for the querystring rules. `generateTools()` leaves such an operation out and records the diagnostic instead; see [OpenAPI Versions](./openapi-versions.md#diagnostics).

### RequestBuildError

Thrown by `buildHttpRequest()` for input it cannot turn into a request: a missing required parameter, a value that cannot be serialized (including one its media type cannot carry, a JSON value that is cyclic or too deep, a lone surrogate, a header value or a cookie value that cannot be sent), a name chosen by the input that the tool reserves for a credential or a sibling parameter, an unresolved path placeholder or server variable, a method that is not an RFC 9110 token or is `CONNECT`, a mapper entry with an unknown `type`, and a whole-query (`wholeQuery`) entry that breaks the OpenAPI 3.2 rules. Its `context` names the parameter or method concerned. See [Request Builder](./request-builder.md#errors).

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
