# Swagger 2.0: body, form, file and collectionFormat

One small Swagger 2.0 document, typed as `OAS20.SwaggerObject`, loaded through the same factory as any OpenAPI 3.x document, turned into tools, and sent over real HTTP with `buildHttpRequest`. The library reads the 2.0 document, converts it to OpenAPI 3.0 and generates the tools from that.

## What it demonstrates

- **The same factory, the same tools.** `OpenAPIToolGenerator.fromJSON(petStore)` is all it takes. `getSpecVersion()` reports `{ status: 'supported', field: 'swagger', family: '2.0' }`, and once tools are generated `getDocument()` is the OpenAPI 3.0 document (`openapi: '3.0.3'`) they were read from
- **`host`, `basePath` and `schemes` become the server.** The tools carry `metadata.servers` `[{ url: 'https://petstore.example.com/v2' }]`. `buildHttpRequest`'s `baseUrl` replaces that whole URL, `basePath` included, so the test sends to `<loopback server>/v2`
- **`in: body`** — the properties of the body schema are the tool's inputs (`name`, `tag`; `name` required) and go out as `{"name":"Rex","tag":"dog"}` with `content-type: application/json`
- **`in: formData`** — an operation whose `consumes` is `application/x-www-form-urlencoded` sends `name=Rex+Jr&status=sold`
- **`type: file`** — the input is a binary string, the mapper entry has `serialization.binary`, and the operation (`consumes: multipart/form-data`) sends a multipart body: the text field and the file as its own part, with the `Blob`'s content type (`image/png`) and its bytes untouched. The test reads the body back with the platform's own multipart parser
- **`collectionFormat`** — `csv` joins the items with a comma (`tags=a%2Cb`, the comma percent-encoded) and `multi` repeats the parameter (`status=sold&status=pending`)
- **`securityDefinitions`** — the `apiKey` scheme (`X-Api-Key`, `in: header`) is resolved by `SecurityResolver` by the name of the header, and sent as that header
- **The conversion on its own** — `upgradeSwagger2(document)` returns `{ document, diagnostics }`: an OpenAPI 3.0 document (`openapi: '3.0.3'`, `servers`, the `in: body` parameter as a `requestBody`, `collectionFormat: multi` as `style: form` with `explode: true`) and the same findings as the generator. It is plain JSON: save it, load it later as OpenAPI 3.0, and the same tools come out. It needs a document with its `$ref`s resolved (a shared `#/parameters/limit` is left out, with `SWAGGER_UNRESOLVED_REFERENCE`); the generator resolves them first
- **What the conversion could not carry over** is in `getDiagnostics()`, one finding per construct. OpenAPI 3.0 has no tab-separated style, so the `collectionFormat: tsv` parameter is sent comma-separated, and says so:

```typescript
generator.getDiagnostics().map((d) => `${d.severity} ${d.code} ${d.path}`);
// warning SWAGGER_UNSUPPORTED_COLLECTION_FORMAT /paths/~1pets/get/parameters/2/collectionFormat
```

The `path` points into the Swagger 2.0 document as written. Run `diagnosticsOf` on a document before you rely on its tools.

## Run it

```bash
yarn build && yarn test:e2e
```

[example.e2e.ts](./example.e2e.ts) starts a loopback server that records each request's method, target, headers and body.

Related docs: [OpenAPI Versions](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/openapi-versions.md) · [Request Builder](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/request-builder.md) · [Security](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/security.md)
