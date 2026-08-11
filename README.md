# mcp-from-openapi

> Convert OpenAPI specifications into MCP tool definitions with automatic parameter conflict resolution

[![npm version](https://badge.fury.io/js/mcp-from-openapi.svg)](https://www.npmjs.com/package/mcp-from-openapi)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-yellow.svg)](https://opensource.org/license/apache-2-0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org/)

## What This Solves

When converting OpenAPI specs to MCP tools, you hit **parameter conflicts** -- the same name appears in different locations (path, query, body). This library resolves them automatically and gives you an **explicit mapper** for building HTTP requests.

**The Problem:**

```yaml
paths:
  /users/{id}:
    post:
      parameters:
        - name: id # path
          in: path
      requestBody:
        content:
          application/json:
            schema:
              properties:
                id: # body -- CONFLICT!
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

- **Built-in Request Builder** -- `buildHttpRequest()` applies the full OpenAPI serialization table (form/deepObject/pipeDelimited queries, label/matrix paths, multipart, binary, `wholeBody`) so you never hand-write request assembly
- **Client Compatibility Targets** -- `target: 'claude' | 'openai' | 'gemini' | 'strict'` emits schemas each client actually accepts (inlined refs, closed objects, collapsed unions, demoted formats)
- **Curation-Grade Filtering** -- Filter by tag, method, path glob (`/admin/**`), operationId, a `readOnlyOnly` safety switch, and `x-mcp` extension flags with root < path < operation precedence
- **Smart Parameter Handling** -- Automatic conflict detection and resolution across path, query, header, cookie, and body; `allOf` bodies flatten, union and binary bodies map cleanly (`wholeBody`, `binary` markers)
- **Complete Schemas** -- Input schema combines all parameters; output schema from responses (with oneOf unions); clean JSON Schema 2020-12 output (`nullable` unions, normalized `examples`)
- **MCP-Native Tools** -- `title` and tool `annotations` (readOnly/destructive/idempotent hints) inferred from HTTP semantics, overridable via the `x-mcp` extension family; spec-compliant tool names (64-char cap, stable hash truncation, collision dedup); deterministic tool ordering for prompt-cache friendliness; `toSdkTool()` for one-line SDK registration
- **Security Resolution** -- Framework-agnostic auth for Bearer, Basic, Digest, API Key, OAuth2, OpenID, mTLS, HMAC, AWS Sig V4; per-scheme `includeSecurityInInput`
- **SSRF Prevention** -- Blocks internal IPs, localhost, and cloud metadata endpoints by default during `$ref` resolution; one-flag `secureDefaults` posture for untrusted specs
- **Multiple Input Sources** -- Load from URL, file, YAML string, or JSON object
- **Rich Metadata** -- Authentication, servers, tags, deprecation, external docs, `x-frontmcp` extension
- **Production Ready** -- Full TypeScript support, validation, structured errors, 100% test coverage (enforced)
- **Runtime Agnostic** -- Works on Node and V8 isolates (Cloudflare Workers) alike

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
import { OpenAPIToolGenerator } from "mcp-from-openapi";

// Load an OpenAPI spec
const generator = await OpenAPIToolGenerator.fromURL(
  "https://api.example.com/openapi.json",
);

// Generate MCP tools
const tools = await generator.generateTools();

// Each tool has everything you need
tools.forEach((tool) => {
  console.log(tool.name); // "createUser"
  console.log(tool.title); // "Create a user" (from summary/extensions)
  console.log(tool.annotations); // { readOnlyHint: false, destructiveHint: true, ... }
  console.log(tool.inputSchema); // Combined schema for all params
  console.log(tool.outputSchema); // Response schema
  console.log(tool.mapper); // How to build the HTTP request
  console.log(tool.metadata); // Auth, servers, tags, etc.
});
```

## Building Requests

`buildHttpRequest()` turns a tool plus input values into a ready-to-send request — style/explode serialization, deepObject queries, multipart, binary, and `wholeBody` handled correctly:

```typescript
import { buildHttpRequest } from "mcp-from-openapi";

const request = buildHttpRequest(tool, { id: "42", filter: { tag: "news" } });
// { url: 'https://api.example.com/users/42?filter[tag]=news',
//   method: 'GET', headers: {...}, body: undefined, ... }

await fetch(request.url, {
  method: request.method,
  headers: request.headers,
  body: request.body as BodyInit,
});
```

The `mapper` array stays public for anyone who needs custom request assembly — see [Request Builder](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/request-builder.md) and [Parameter Conflicts](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/parameter-conflicts.md) for its contract.

## Serving with the Official MCP SDK

```typescript
import { toSdkTool, buildHttpRequest } from "mcp-from-openapi";
import { fromJsonSchema } from "@modelcontextprotocol/server"; // SDK v2

for (const tool of await generator.generateTools({ target: "claude" })) {
  server.registerTool(...toSdkTool(tool, { fromJsonSchema }), async (input) => {
    const request = buildHttpRequest(tool, input);
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body as BodyInit,
    });
    return { content: [{ type: "text", text: await response.text() }] };
  });
}
```

## Documentation

| Document                                                                                                    | Description                                                       |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Getting Started](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/getting-started.md)         | Loading specs, generating tools, building requests                |
| [Configuration](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/configuration.md)             | LoadOptions, GenerateOptions, RefResolutionOptions                |
| [Parameter Conflicts](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/parameter-conflicts.md) | How conflict detection and resolution works                       |
| [Request Builder](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/request-builder.md)         | `buildHttpRequest` — full OpenAPI parameter serialization         |
| [Client Targets](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/client-targets.md)           | Per-client schema dialects (Claude, OpenAI, Gemini)               |
| [Response Schemas](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/response-schemas.md)       | Output schemas, status codes, oneOf unions                        |
| [Annotations & Extensions](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/annotations.md)    | Tool title, annotation inference, `x-mcp` extension family        |
| [Security](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/security.md)                       | SecurityResolver, all auth types, custom resolvers                |
| [SSRF Prevention](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/ssrf-prevention.md)         | Ref resolution security, blocked IPs and hosts                    |
| [Format Resolution](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/FORMAT_RESOLUTION.md)     | Format-to-schema enrichment (uuid, date-time, email, int32, etc.) |
| [Naming Strategies](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/naming-strategies.md)     | Custom tool naming and conflict resolvers                         |
| [SchemaBuilder](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/schema-builder.md)            | JSON Schema utility methods                                       |
| [Error Handling](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/error-handling.md)           | Error classes, context, and patterns                              |
| [x-frontmcp Extension](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/x-frontmcp.md)         | Custom OpenAPI extension for MCP annotations                      |
| [API Reference](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/api-reference.md)             | Complete types, interfaces, and exports                           |
| [Examples](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/examples.md)                       | MCP server, Zod, filtering, security, and more                    |
| [Architecture](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/architecture.md)               | System overview, data flow, design patterns                       |

## Requirements

- Node.js >= 20.0.0
- TypeScript >= 5.0 (for TypeScript users)
- Peer dependency: `zod@^4.0.0`

## Contributing

Contributions are welcome! Please see our [issues page](https://github.com/agentfront/mcp-from-openapi/issues).

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [OpenAPI Specification](https://www.openapis.org/)

## License

[Apache 2.0](https://github.com/agentfront/mcp-from-openapi/blob/main/LICENSE)
