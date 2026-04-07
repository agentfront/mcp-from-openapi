# mcp-from-openapi

> Convert OpenAPI specifications into MCP tool definitions with automatic parameter conflict resolution

[![npm version](https://badge.fury.io/js/mcp-from-openapi.svg)](https://www.npmjs.com/package/mcp-from-openapi)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-yellow.svg)](https://opensource.org/license/apache-2-0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

## What This Solves

When converting OpenAPI specs to MCP tools, you hit **parameter conflicts** -- the same name appears in different locations (path, query, body). This library resolves them automatically and gives you an **explicit mapper** for building HTTP requests.

**The Problem:**

```yaml
paths:
  /users/{id}:
    post:
      parameters:
        - name: id        # path
          in: path
      requestBody:
        content:
          application/json:
            schema:
              properties:
                id:        # body -- CONFLICT!
                  type: string
```

**The Solution:**

```typescript
{
  inputSchema: {
    properties: {
      pathId: { type: "string" },    // Automatically renamed
      bodyId: { type: "string" }     // Automatically renamed
    }
  },
  mapper: [
    { inputKey: "pathId", type: "path", key: "id" },
    { inputKey: "bodyId", type: "body", key: "id" }
  ]
}
```

Now you know exactly how to build the HTTP request.

## Features

- **Smart Parameter Handling** -- Automatic conflict detection and resolution across path, query, header, cookie, and body
- **Complete Schemas** -- Input schema combines all parameters; output schema from responses (with oneOf unions)
- **Security Resolution** -- Framework-agnostic auth for Bearer, Basic, Digest, API Key, OAuth2, OpenID, mTLS, HMAC, AWS Sig V4
- **SSRF Prevention** -- Blocks internal IPs, localhost, and cloud metadata endpoints by default during `$ref` resolution
- **Multiple Input Sources** -- Load from URL, file, YAML string, or JSON object
- **Rich Metadata** -- Authentication, servers, tags, deprecation, external docs, `x-frontmcp` extension
- **Production Ready** -- Full TypeScript support, validation, structured errors, 80%+ test coverage
- **MCP Native** -- Designed specifically for Model Context Protocol integration

## Installation

```bash
npm install mcp-from-openapi
# or
yarn add mcp-from-openapi
# or
pnpm add mcp-from-openapi
```

## Quick Start

```typescript
import { OpenAPIToolGenerator } from 'mcp-from-openapi';

// Load an OpenAPI spec
const generator = await OpenAPIToolGenerator.fromURL('https://api.example.com/openapi.json');

// Generate MCP tools
const tools = await generator.generateTools();

// Each tool has everything you need
tools.forEach((tool) => {
  console.log(tool.name);          // "createUser"
  console.log(tool.inputSchema);   // Combined schema for all params
  console.log(tool.outputSchema);  // Response schema
  console.log(tool.mapper);        // How to build the HTTP request
  console.log(tool.metadata);      // Auth, servers, tags, etc.
});
```

## Using the Mapper

The mapper tells you how to convert tool inputs into an HTTP request:

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
  const qs = query.toString();

  return {
    url: `${baseUrl}${path}${qs ? '?' + qs : ''}`,
    method: tool.metadata.method.toUpperCase(),
    headers,
    body: body ? JSON.stringify(body) : undefined,
  };
}
```

## Documentation

| Document | Description |
|----------|-------------|
| [Getting Started](docs/getting-started.md) | Loading specs, generating tools, building requests |
| [Configuration](docs/configuration.md) | LoadOptions, GenerateOptions, RefResolutionOptions |
| [Parameter Conflicts](docs/parameter-conflicts.md) | How conflict detection and resolution works |
| [Response Schemas](docs/response-schemas.md) | Output schemas, status codes, oneOf unions |
| [Security](docs/security.md) | SecurityResolver, all auth types, custom resolvers |
| [SSRF Prevention](docs/ssrf-prevention.md) | Ref resolution security, blocked IPs and hosts |
| [Naming Strategies](docs/naming-strategies.md) | Custom tool naming and conflict resolvers |
| [SchemaBuilder](docs/schema-builder.md) | JSON Schema utility methods |
| [Error Handling](docs/error-handling.md) | Error classes, context, and patterns |
| [x-frontmcp Extension](docs/x-frontmcp.md) | Custom OpenAPI extension for MCP annotations |
| [API Reference](docs/api-reference.md) | Complete types, interfaces, and exports |
| [Examples](docs/examples.md) | MCP server, Zod, filtering, security, and more |
| [Architecture](docs/architecture.md) | System overview, data flow, design patterns |

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 5.0 (for TypeScript users)
- Peer dependency: `zod@^4.0.0`

## Contributing

Contributions are welcome! Please see our [issues page](https://github.com/agentfront/mcp-from-openapi/issues).

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [OpenAPI Specification](https://www.openapis.org/)

## License

[Apache 2.0](LICENSE)
