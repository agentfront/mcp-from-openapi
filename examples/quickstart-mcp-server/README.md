# Quickstart: OpenAPI spec → running MCP server

The flagship journey in ~70 lines: turn an OpenAPI document into MCP tools, register them on the official `@modelcontextprotocol/sdk` server, and proxy every tool call to the real API with credentials resolved from the spec's security schemes.

## What it demonstrates

- `OpenAPIToolGenerator.fromJSON` → `generateTools` with `preferredStatusCodes` (single-object output schemas are what MCP structured content wants)
- `toSdkTool` — the generated tool dropped straight into the SDK's `tools/list` shape
- `SecurityResolver` + `createSecurityContext` — spec security schemes turned into concrete headers/query values
- `buildHttpRequest` — the mapper applied with full OpenAPI parameter serialization
- The structured-content contract: `structuredContent` only on success; error payloads stay in `content` with `isError: true`

## Run it

```bash
yarn build && yarn test:e2e   # runs example.e2e.ts among the rest
```

The test ([example.e2e.ts](./example.e2e.ts)) spins up a local API, connects a real MCP `Client` over `InMemoryTransport`, calls the generated tool, and asserts the request that arrived on the wire — path templating and the `X-API-Key` header included.

## Use it in your project

```typescript
import { createMcpServer } from './example';

const { server } = await createMcpServer({
  spec: await fetch('https://api.example.com/openapi.json').then((r) => r.json()),
  apiBaseUrl: 'https://api.example.com',
  auth: { apiKey: process.env.API_KEY },
});
// connect `server` to your transport of choice (stdio, HTTP, ...)
```

Related docs: [Getting Started](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/getting-started.md) · [Security](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/security.md) · [Request Builder](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/request-builder.md)
