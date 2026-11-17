# OpenAPI 3.2: QUERY, custom methods, querystring and streams

One small OpenAPI 3.2 document, four shapes that 3.0 and 3.1 cannot describe: turned into tools, sent over real HTTP with `buildHttpRequest`, and (for the stream) consumed item by item with every item validated against its schema.

## What it demonstrates

- **A `query` operation** (`QUERY /files/search`) becomes a tool with `metadata.method` `'query'` and a read-only annotation, like a `GET` that carries a JSON body. The test asserts `QUERY`, the path, the `content-type` and the body bytes on the wire
- **`additionalOperations`** (`LINK /files/{id}`) — a method with no field of its own becomes a tool whose `metadata.method` is the key as written, and it is sent exactly as written (`LINK`). It has no known semantics, so it is not annotated read-only
- **`in: querystring`** — a `GET` whose whole query string is one parameter. The tool has one input (`filter`, an object), its mapper entry is `wholeQuery: true`, and the properties go out as the form-encoded query: `/files?name=annual+report&tag=a&tag=b`
- **`itemSchema` on a stream** (`text/event-stream`) — the tool has no `outputSchema`; `metadata.responseStream` holds `{ statusCode, contentType, itemSchema }` and `metadata.responseHints.streaming` is `true`. `streamItems` reads the response as it arrives and validates each event against `itemSchema` with Ajv. An item is a parsed event (`event`, `data`, `id`, `retry`), as OpenAPI 3.2 says, so a comment (`:keepalive`) or a block with no `data` line (`retry: 3000`) dispatches nothing and is never validated. The test holds the server's response open after the first event, so it only passes if that event is yielded before the stream ends
- **What an older declaration ignores.** The same document declared as `3.1.0` makes tools for the `GET` operations only; `generator.getDiagnostics()` says what was left out:

```typescript
generator.getDiagnostics().map((d) => `${d.severity} ${d.code} ${d.path}`);
// warning FEATURE_NEWER_THAN_DECLARED_VERSION /paths/~1files/get/parameters/0/in
// warning FEATURE_NEWER_THAN_DECLARED_VERSION /paths/~1files~1search/query
// warning NO_OPERATIONS /paths//files/search
// warning FEATURE_NEWER_THAN_DECLARED_VERSION /paths/~1files~1{id}/additionalOperations
// warning NO_OPERATIONS /paths//files/{id}
```

The `query` and `additionalOperations` operations are read only when the document declares 3.2 or later. The `in: querystring` parameter is still read in a 3.1 document, with the first warning above. For the 3.2 document `getDiagnostics()` is empty.

A `querystring` parameter serialized as JSON (or any media type other than `application/x-www-form-urlencoded`) is one percent-encoded value rather than name=value pairs: `buildHttpRequest` returns it as `built.queryString`, and refuses to add a query credential to it. See the [http-requests](https://github.com/agentfront/mcp-from-openapi/tree/main/examples/http-requests) example, which sends credentials through `buildHttpRequest` for that reason.

## Run it

```bash
yarn build && yarn test:e2e
```

[example.e2e.ts](./example.e2e.ts) starts a loopback server that records each request's method, target, headers and body, and serves a small event stream.

Related docs: [OpenAPI Versions](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/openapi-versions.md) · [Request Builder](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/request-builder.md) · [Annotations & Extensions](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/annotations.md)
