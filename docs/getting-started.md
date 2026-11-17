# Getting Started

[Home](../README.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)

---

## Installation

```bash
npm install mcp-from-openapi
# or
yarn add mcp-from-openapi
# or
pnpm add mcp-from-openapi
```

**Requirements:**
- Node.js >= 20.0.0
- Peer dependency: `zod@^4.0.0`

---

## Loading an OpenAPI Spec

The library supports four loading methods:

### From a URL

```typescript
import { OpenAPIToolGenerator } from 'mcp-from-openapi';

const generator = await OpenAPIToolGenerator.fromURL('https://api.example.com/openapi.json');
```

Supports custom headers, timeout, and redirect control:

```typescript
const generator = await OpenAPIToolGenerator.fromURL('https://api.example.com/openapi.json', {
  headers: { Authorization: 'Bearer token' },
  timeout: 10000,
  followRedirects: true,
});
```

Auto-detects JSON vs YAML based on `Content-Type` header or URL extension. The URL the document was finally read from (after redirects) is its base URI for relative `$ref`s: see [Multi-file Specifications](#multi-file-specifications).

### From a File

```typescript
const generator = await OpenAPIToolGenerator.fromFile('./openapi.yaml');
```

Accepts `.json`, `.yaml`, and `.yml` files. For other extensions, attempts JSON first, then YAML. Relative `$ref`s resolve next to the file; reading them needs `file` in `refResolution.allowedProtocols`: see [Multi-file Specifications](#multi-file-specifications).

### From a YAML String

```typescript
const generator = await OpenAPIToolGenerator.fromYAML(`
openapi: 3.0.0
info:
  title: My API
  version: 1.0.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: string
                    name:
                      type: string
`);
```

### From a JSON Object

```typescript
const spec = {
  openapi: '3.0.0',
  info: { title: 'My API', version: '1.0.0' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        responses: {
          '200': {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { type: 'object', properties: { id: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    },
  },
};

const generator = await OpenAPIToolGenerator.fromJSON(spec);
```

The JSON object is deep-cloned internally, so your original is never mutated.

A string or an object has no location, so pass `documentUri` if it has relative `$ref`s (see [Multi-file Specifications](#multi-file-specifications)).

---

## Multi-file Specifications

A spec split across files names the other files with relative `$ref`s, such as `{ "$ref": "./schemas/pet.json" }`. A relative reference resolves against the document's base URI: where the document was loaded from. Each way of loading has one, or takes it as an option.

### Files on disk

Load the main file with `fromFile` and allow the `file` protocol, which is blocked by default:

```typescript
const generator = await OpenAPIToolGenerator.fromFile("/tmp/petstore/openapi.json", {
  refResolution: { allowedProtocols: ["file"] },
});
const [tool] = await generator.generateTools();
Object.keys(tool.outputSchema.properties); // ['id', 'name']
```

The references resolve next to the file, whatever the working directory is. If some references are absolute `http` or `https` URLs, keep those protocols in the list: `["http", "https", "file"]`.

Without `file`, the first `generateTools()` (or `validate()`) fails, and the error says what to change:

```
ParseError: Failed to dereference OpenAPI document: Cannot read $ref "./schemas/pet.json"
  resolved against "/tmp/petstore/openapi.json" to "/tmp/petstore/schemas/pet.json":
  it is read as a local file, and refResolution.allowedProtocols ("http", "https") does not include "file";
  add "file" to refResolution.allowedProtocols to read it
```

`error.context` holds `reference`, `base`, `resolved` and `rule` (here `'protocol'`). See [When a Reference Cannot Be Read](./ssrf-prevention.md#when-a-reference-cannot-be-read) for every rule.

> **`file` lets the spec read any file the process can read.** Allow it only for documents you control. Do not allow it for a spec that comes from a URL or from a user: see the [Trust Model](./ssrf-prevention.md#trust-model).

### A URL

```typescript
const generator = await OpenAPIToolGenerator.fromURL("https://specs.example.com/petstore/openapi.json");
```

`./schemas/pet.json` resolves against the URL the document was finally read from (after redirects, without credentials or fragment): `https://specs.example.com/petstore/schemas/pet.json`. `http` and `https` are allowed by default, so no option is needed. The reference passes the same host and internal-address checks as any other, and your `headers` are not sent with it.

### A string or an object: `documentUri`

`fromYAML` and `fromJSON` do not know where the text came from. Say so with `documentUri`:

```typescript
import { readFile } from "node:fs/promises";

const spec = JSON.parse(await readFile("/tmp/petstore/openapi.json", "utf8"));

const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  documentUri: "file:///tmp/petstore/openapi.json",
  refResolution: { allowedProtocols: ["file"] },
});
```

`documentUri` is an absolute `http`, `https` or `file` URI of at most 2,048 characters with no user information, no fragment and, for `file:`, no host; anything else throws a `LoadError` before anything is fetched or read (user information is never quoted back):

```
LoadError: LoadOptions.documentUri must be an absolute URI, such as https://example.com/openapi.yaml, found "./openapi.json"
```

It also replaces the URL or file a document was read from, in `fromURL` and `fromFile`. Without it, a document passed as a string or an object has no location: its relative references resolve against the process working directory, as in earlier releases.

A 3.2 document can name itself with `$self`. That does not move where its references are read from: they are read next to the file, or from the URL, it was actually loaded from (or from `documentUri`). `$self` is the base only for a string or an object with no `documentUri`. See [The `$self` Field](./ssrf-prevention.md#the-self-field).

---

## Generating Tools

### All Tools

```typescript
const tools = await generator.generateTools();
```

### A Single Tool

```typescript
const tool = await generator.generateTool('/users/{id}', 'get');
```

### With Options

```typescript
const tools = await generator.generateTools({
  includeOperations: ['listUsers', 'getUser'],
  includeDeprecated: false,
  includeAllResponses: true,
});
```

See [Configuration](./configuration.md) for all options.

---

## Understanding the Output

Each generated tool is an `McpOpenAPITool`:

```typescript
const tool = tools[0];

tool.name;          // "listUsers" (from operationId)
tool.description;   // "List all users" (from operation summary)
tool.inputSchema;   // Combined JSON Schema for all parameters
tool.outputSchema;  // Response schema (can be a oneOf union)
tool.mapper;        // Array of ParameterMapper entries
tool.metadata;      // { path, method, servers, security, tags, ... }
```

### The Mapper

The `mapper` array is the key feature -- it tells you exactly how to convert tool inputs into an HTTP request:

```typescript
tool.mapper.forEach((m) => {
  console.log(`${m.inputKey} -> ${m.type}:${m.key}`);
  // e.g., "id -> path:id"
  // e.g., "bodyName -> body:name"
});
```

Each mapper entry has:

| Field | Description |
|-------|-------------|
| `inputKey` | Property name in `inputSchema` |
| `type` | Where to put it: `path`, `query`, `header`, `cookie`, or `body` |
| `key` | The original parameter name |
| `required` | Whether the parameter is required |
| `style`, `explode`, `allowReserved` | How a parameter defined with `schema` is serialized; absent for one defined with `content` |
| `serialization` | The media type the value is serialized in (a body's, a `content` parameter's, a whole query's), its `encoding`, and the `binary` marker |
| `wholeBody` / `wholeQuery` | The input value IS the entire request body / query string (`wholeQuery` is an OpenAPI 3.2 `in: querystring` parameter) |
| `security` | Present if this is an auth parameter |

---

## Building HTTP Requests from Tools

Use the mapper to construct the actual HTTP request:

> **Prefer `buildHttpRequest`** — the built-in [request builder](./request-builder.md) applies the full OpenAPI serialization table (style/explode, deepObject, multipart, binary, `wholeBody`). The manual walkthrough below shows the mapper contract for custom integrations; it does not serialize `content` parameters or `wholeQuery` entries, and it upper-cases `metadata.method`, which is right for a standard method. An OpenAPI 3.2 `additionalOperations` method (`metadata.method` is its key as written, such as `LINK`) must be sent as written, and `buildHttpRequest` does that.

```typescript
function buildRequest(tool: McpOpenAPITool, input: Record<string, any>) {
  let path = tool.metadata.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  let body: Record<string, any> | undefined;

  for (const m of tool.mapper) {
    const value = input[m.inputKey];
    if (value === undefined) continue;

    switch (m.type) {
      case 'path':
        path = path.replace(`{${m.key}}`, encodeURIComponent(value));
        break;
      case 'query':
        query.set(m.key, String(value));
        break;
      case 'header':
        headers[m.key] = String(value);
        break;
      case 'body':
        if (m.wholeBody) {
          body = value; // non-object/union bodies: the value IS the entire body
        } else {
          if (!body) body = {};
          body[m.key] = value;
        }
        break;
    }
  }

  const baseUrl = tool.metadata.servers?.[0]?.url ?? '';
  const queryString = query.toString();
  const url = `${baseUrl}${path}${queryString ? '?' + queryString : ''}`;

  return {
    url,
    method: tool.metadata.method.toUpperCase(),
    headers,
    // NOTE: binary bodies (mapper serialization.binary) need raw/multipart
    // serialization per serialization.contentType, not JSON.stringify
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}
```

Usage:

```typescript
const request = buildRequest(tool, {
  id: 'user-123',
  name: 'John Doe',
  email: 'john@example.com',
});

const response = await fetch(request.url, {
  method: request.method,
  headers: { 'Content-Type': 'application/json', ...request.headers },
  body: request.body,
});
```

---

## Validation

Validate an OpenAPI document before generating tools:

```typescript
const result = await generator.validate();

if (!result.valid) {
  console.error('Errors:', result.errors);
  // [{ message: '...', path: '/paths/...', code: 'NO_RESPONSES' }]
}

if (result.warnings) {
  console.warn('Warnings:', result.warnings);
  // [{ message: 'No servers defined...', path: '/servers', code: 'NO_SERVERS' }]
}
```

When the document has a `$ref` that does not start with `#`, `validate()` dereferences it first, under the same `refResolution` rules as generation, and validates the result. So it can read files and make network requests. A reference that cannot be read does not throw: the result is `{ valid: false, errors: [{ code: 'UNREADABLE_REFERENCE', message, path }] }`, where generation throws a `ParseError`. A reference to the document's own URI is made local and reads nothing. See [API Reference](./api-reference.md#instance-methods).

By default, validation runs automatically before the first `generateTools()` / `generateTool()` call, with the rules of the version the document declares (OpenAPI 3.0, 3.1 and 3.2; see [OpenAPI Versions](./openapi-versions.md)). Disable with `validate: false`:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
```

Whatever the setting, `generator.getDiagnostics()` lists what the library noticed or could not process: a newer-than-known version, an operation it skipped, a security scheme it could not resolve. See [OpenAPI Versions](./openapi-versions.md#diagnostics).

---

## Next Steps

- [Configuration](./configuration.md) -- All LoadOptions and GenerateOptions
- [OpenAPI Versions](./openapi-versions.md) -- Supported versions, OpenAPI 3.2 features, diagnostics
- [Parameter Conflicts](./parameter-conflicts.md) -- How automatic conflict resolution works
- [SSRF Prevention](./ssrf-prevention.md) -- Base URIs, `$self`, which references are read, and the trust model
- [Security](./security.md) -- Authentication handling
- [Examples](./examples.md) -- Complete usage examples

---

**Related:** [Configuration](./configuration.md) | [Parameter Conflicts](./parameter-conflicts.md) | [API Reference](./api-reference.md)
