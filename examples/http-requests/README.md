# HTTP requests from tool input

The request pipeline with no framework at all: `tool input → buildHttpRequest → fetch`, in ~40 lines. This is the bridge every MCP runtime needs between a tool call and the API behind it — and the reason you never hand-write parameter serialization.

## What it demonstrates

- `buildHttpRequest` applying the mapper with the full OpenAPI serialization table — the test asserts `deepObject` (`filter[status]=active`) and `pipeDelimited` (`ids=1|2|3`) exactly as they hit the wire
- `SecurityResolver` + `createSecurityContext` resolving a bearer scheme into an `Authorization` header
- The clean split: request *assembly* is pure (`buildHttpRequest` sends nothing); execution is one `fetch`

## Run it

```bash
yarn build && yarn test:e2e
```

[example.e2e.ts](./example.e2e.ts) captures the raw request on a loopback server and asserts the serialized query string and headers byte-for-byte.

Related docs: [Request Builder](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/request-builder.md) · [Security](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/security.md) · [Parameter Conflicts](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/parameter-conflicts.md)
