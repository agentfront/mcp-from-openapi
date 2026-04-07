# Examples

[Home](../README.md) | [Getting Started](./getting-started.md) | [API Reference](./api-reference.md)

---

## Building an MCP Server

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { OpenAPIToolGenerator } from 'mcp-from-openapi';

const generator = await OpenAPIToolGenerator.fromURL('https://api.example.com/openapi.json');
const tools = await generator.generateTools();

const server = new Server(/* config */);

// Register tools
tools.forEach((tool) => {
  server.setRequestHandler(tool.name, async (request) => {
    const httpRequest = buildRequest(tool, request.params);
    const response = await fetch(httpRequest.url, {
      method: httpRequest.method,
      headers: { 'Content-Type': 'application/json', ...httpRequest.headers },
      body: httpRequest.body,
    });
    return response.json();
  });
});

function buildRequest(tool, input) {
  let path = tool.metadata.path;
  const query = new URLSearchParams();
  const headers = {};
  let body;

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
  const qs = query.toString();

  return {
    url: `${baseUrl}${path}${qs ? '?' + qs : ''}`,
    method: tool.metadata.method.toUpperCase(),
    headers,
    body: body ? JSON.stringify(body) : undefined,
  };
}
```

---

## Filtering Operations

### By HTTP Method

```typescript
const getTools = await generator.generateTools({
  filterFn: (op) => op.method === 'get',
});
```

### By Tag

```typescript
const userTools = await generator.generateTools({
  filterFn: (op) => op.tags?.includes('users') ?? false,
});
```

### By Operation ID

```typescript
const tools = await generator.generateTools({
  includeOperations: ['getUser', 'createUser', 'listUsers'],
});
```

### Exclude Specific Operations

```typescript
const tools = await generator.generateTools({
  excludeOperations: ['deleteUser', 'adminReset'],
});
```

### Skip Deprecated

```typescript
const tools = await generator.generateTools({
  includeDeprecated: false, // This is the default
});
```

---

## Multiple Response Handling

### All Responses as Union

```typescript
const tools = await generator.generateTools({
  includeAllResponses: true, // Default
});

// tool.outputSchema = { oneOf: [
//   { ..., "x-status-code": 200 },
//   { ..., "x-status-code": 404 }
// ]}
```

### Single Preferred Response

```typescript
const tools = await generator.generateTools({
  includeAllResponses: false,
  preferredStatusCodes: [200, 201],
});

// tool.outputSchema = { ..., "x-status-code": 200 }
```

---

## Custom Naming Strategy

```typescript
const tools = await generator.generateTools({
  namingStrategy: {
    // Custom conflict resolution
    conflictResolver: (paramName, location, index) => {
      return `${location.toUpperCase()}_${paramName}`;
    },
    // Custom tool naming
    toolNameGenerator: (path, method, operationId) => {
      if (operationId) return operationId;
      return `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
    },
  },
});
```

---

## Security Integration

### Bearer Token

```typescript
import { SecurityResolver, createSecurityContext } from 'mcp-from-openapi';

const resolver = new SecurityResolver();
const context = createSecurityContext({
  jwt: process.env.API_TOKEN,
});

const resolved = await resolver.resolve(tool.mapper, context);
// resolved.headers = { Authorization: "Bearer ..." }

const response = await fetch(url, {
  headers: { ...resolved.headers },
});
```

### Multiple Auth Types

```typescript
const context = createSecurityContext({
  jwt: process.env.JWT_TOKEN,
  apiKey: process.env.API_KEY,
  oauth2Token: process.env.OAUTH_TOKEN,
});

const resolved = await resolver.resolve(tool.mapper, context);
// All relevant auth headers/query/cookies are populated
```

### Custom Resolver (Framework Integration)

```typescript
const context = createSecurityContext({
  customResolver: async (security) => {
    // Pull from your framework's auth system
    if (security.type === 'http') {
      return await authService.getBearerToken();
    }
    if (security.type === 'apiKey') {
      return await vault.getSecret(security.apiKeyName);
    }
    return undefined;
  },
});
```

### Check Missing Auth

```typescript
const missing = await resolver.checkMissingSecurity(tool.mapper, context);
if (missing.length > 0) {
  throw new Error(`Missing auth: ${missing.join(', ')}`);
}
```

---

## Zod Integration

Use [`json-schema-to-zod`](https://github.com/StefanTerdell/json-schema-to-zod) to convert schemas for runtime validation:

```typescript
import { jsonSchemaToZod } from 'json-schema-to-zod';

const tools = await generator.generateTools();

for (const tool of tools) {
  const zodSchemaCode = jsonSchemaToZod(tool.inputSchema);
  console.log(`Tool: ${tool.name}`);
  console.log(`Zod schema: ${zodSchemaCode}`);
}
```

---

## Validation-First Workflow

```typescript
const generator = await OpenAPIToolGenerator.fromFile('./openapi.yaml');

const result = await generator.validate();
if (!result.valid) {
  console.error('Validation errors:');
  result.errors?.forEach((e) => {
    console.error(`  ${e.path}: ${e.message} (${e.code})`);
  });
  process.exit(1);
}

if (result.warnings) {
  console.warn('Warnings:');
  result.warnings.forEach((w) => {
    console.warn(`  ${w.path}: ${w.message}`);
  });
}

const tools = await generator.generateTools();
```

---

## SSRF-Safe Loading

```typescript
// Strict: only HTTPS from trusted hosts
const generator = await OpenAPIToolGenerator.fromURL(untrustedUrl, {
  refResolution: {
    allowedProtocols: ['https'],
    allowedHosts: ['schemas.example.com'],
    blockedHosts: ['competitor.com'],
  },
});

// No external resolution at all
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    allowedProtocols: [],
  },
});
```

---

## Custom Base URL

Override server URLs from the spec:

```typescript
const generator = await OpenAPIToolGenerator.fromURL(url, {
  baseUrl: 'https://staging.api.example.com',
});

const tools = await generator.generateTools();
// All tool.metadata.servers[].url will use the staging URL
```

---

## Caching Generated Tools

```typescript
class ToolCache {
  private cache = new Map<string, McpOpenAPITool[]>();

  async getTools(apiUrl: string): Promise<McpOpenAPITool[]> {
    if (this.cache.has(apiUrl)) {
      return this.cache.get(apiUrl)!;
    }

    const generator = await OpenAPIToolGenerator.fromURL(apiUrl);
    const tools = await generator.generateTools();
    this.cache.set(apiUrl, tools);

    return tools;
  }
}
```

---

**Related:** [Getting Started](./getting-started.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)
