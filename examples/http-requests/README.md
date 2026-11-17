# HTTP requests from tool input

The request pipeline with no framework at all: `tool input → buildHttpRequest → fetch`, in under 80 lines. This is the bridge every MCP runtime needs between a tool call and the API behind it — and the reason you never hand-write parameter serialization.

## What it demonstrates

- `buildHttpRequest` applying the mapper with the full OpenAPI serialization table — the test asserts `deepObject` (`filter[status]=active`) and `pipeDelimited` (`ids=1|2|3`) exactly as they hit the wire
- `SecurityResolver` + `createSecurityContext` resolving a bearer scheme into an `Authorization` header
- Credentials handed to `buildHttpRequest` as input, under each security mapper entry's `inputKey`, so it places them in the right header, query pair or cookie. The example never appends to `url.searchParams`: that rewrites the whole query and corrupts one that is not name=value pairs (an OpenAPI 3.2 `in: querystring` JSON value becomes `?%7B%22a%22%3A1%7D=&api_key=k`). With the builder, a query credential joins form-encoded pairs, and a query string it cannot join is refused with a `RequestBuildError` (nothing is sent) — send that credential in a header or a cookie
- Cookies in the security context that no mapper entry names (`auth: { cookies: { session: '...' } }`) are not placed by `buildHttpRequest`: the example joins them to the `Cookie` header it built, never to the URL, and refuses a name or value that is not valid RFC 6265 (a `;` would forge a second cookie)
- The clean split: request *assembly* is pure (`buildHttpRequest` sends nothing); execution is one `fetch`

## Run it

```bash
yarn build && yarn test:e2e
```

[example.e2e.ts](./example.e2e.ts) captures the raw request on a loopback server and asserts the serialized query string and headers byte-for-byte, including the query-credential and context-cookie cases above.

Related docs: [Request Builder](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/request-builder.md) · [Security](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/security.md) · [Parameter Conflicts](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/parameter-conflicts.md)
