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
- Node.js >= 18.0.0
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

Auto-detects JSON vs YAML based on `Content-Type` header or URL extension.

### From a File

```typescript
const generator = await OpenAPIToolGenerator.fromFile('./openapi.yaml');
```

Accepts `.json`, `.yaml`, and `.yml` files. For other extensions, attempts JSON first, then YAML.

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
| `security` | Present if this is an auth parameter |

---

## Building HTTP Requests from Tools

Use the mapper to construct the actual HTTP request:

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
        if (!body) body = {};
        body[m.key] = value;
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
    body: body ? JSON.stringify(body) : undefined,
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
  // [{ message: '...', path: '/paths/...', code: 'MISSING_RESPONSES' }]
}

if (result.warnings) {
  console.warn('Warnings:', result.warnings);
  // [{ message: 'No servers defined...', path: '/servers', code: 'NO_SERVERS' }]
}
```

By default, validation runs automatically when loading a spec. Disable with `validate: false`:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
```

---

## Next Steps

- [Configuration](./configuration.md) -- All LoadOptions and GenerateOptions
- [Parameter Conflicts](./parameter-conflicts.md) -- How automatic conflict resolution works
- [Security](./security.md) -- Authentication handling
- [Examples](./examples.md) -- Complete usage examples

---

**Related:** [Configuration](./configuration.md) | [Parameter Conflicts](./parameter-conflicts.md) | [API Reference](./api-reference.md)
