# OpenAPI Versions

[Home](../README.md) | [Getting Started](./getting-started.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)

---

The library reads OpenAPI 3.0, 3.1 and 3.2 documents. This page is the support matrix: what happens for each declared version, which OpenAPI 3.2 features work today, how the library reports what it could not process, and the gaps that remain.

Two rules explain most of the behaviour:

- **Validation follows the declared version.** The validator applies the rules of the declared `major.minor`. The patch number (and any `-suffix`, as in `3.2.0-rc1`) never changes behaviour: the specification tells tooling to ignore it.
- **Which operations are read follows the declared version too; everything else follows features.** The `query` operation and `additionalOperations` are read only when the document declares OpenAPI 3.2 or newer. Every other construct the library understands (parameter locations, bodies, security, schemas) is processed whatever version the document declares, because real specs are often mislabelled. The one function that decides which operations a document has is `resolveOperationLayout(detectSpecVersion(document))`; the generator, the validator, lint and Arazzo all use it.

## Declared versions

The version is read from the `openapi` field (or `swagger`, for Swagger 2.0). `generator.getSpecVersion()` and the standalone `detectSpecVersion(document)` report it; `status` is one of the values in the first column.

| Declared version | `status` | Validation (`validate: true`, the default) | Operations read | With `validate: false` |
| --- | --- | --- | --- | --- |
| `3.0.x` | `supported` | The 3.0 rules | The eight classic methods | Generates |
| `3.1.x` | `supported` | The 3.1 rules | The eight classic methods | Generates |
| `3.2.x` | `supported` | The 3.2 rules | The eight, `query` and `additionalOperations` | Generates |
| `3.N.x` newer than 3.2 (`3.3.0`, `3.10.1`) | `newer-minor` | Valid, checked with the 3.2 rules, plus a `NEWER_OPENAPI_VERSION` warning | As 3.2 | Generates; the warning is in `getDiagnostics()` |
| `swagger: "2.0"` | `swagger-2.0` | **Rejected** with `INVALID_OPENAPI_VERSION` | The eight classic methods | Not supported: the document is read as OpenAPI 3, which gives wrong tools (see below) |
| Another major (`1.0.0`, `2.0.0`, `4.0.0`, `swagger: "1.2"`) | `unsupported` | Rejected with `INVALID_OPENAPI_VERSION` | The eight classic methods | Generates as if it were OpenAPI 3; the error is in `getDiagnostics()` as a warning |
| Not a version string (`3.1`, `banana`, a number, `null`) | `malformed` | Rejected with `INVALID_OPENAPI_VERSION` | The eight classic methods | As above |
| No `openapi` or `swagger` field | `missing` | Rejected with `MISSING_OPENAPI_VERSION` | The eight classic methods | As above |

The eight classic methods are `get`, `post`, `put`, `patch`, `delete`, `head`, `options` and `trace`. A document whose version cannot be processed is only reachable with `validate: false` (validation rejects it otherwise), and it is read exactly as the library read every document before OpenAPI 3.2 support.

A rejection throws a `ParseError` whose message names the first error and whose `context.errors` lists them all:

```typescript
import { OpenAPIToolGenerator, ParseError } from "mcp-from-openapi";

const generator = await OpenAPIToolGenerator.fromJSON({
  swagger: "2.0",
  info: { title: "Pets", version: "1" },
  paths: {},
});

generator.getSpecVersion().status; // 'swagger-2.0'

try {
  await generator.generateTools();
} catch (error) {
  if (error instanceof ParseError) {
    error.message;
    // 'Invalid OpenAPI document: Swagger 2.0 documents are not supported.
    //  Expected OpenAPI 3.0.x, 3.1.x or 3.2.x (a later 3.x is read with the 3.2 rules)'
    error.context?.errors[0].code; // 'INVALID_OPENAPI_VERSION'
    error.context?.errors[0].path; // '/swagger'
  }
}
```

The factories never validate; the first `generateTools()` or `generateTool()` call does, so loading a Swagger 2.0 document succeeds and generating from it throws.

### A newer 3.x minor version

A document declaring `3.3.0` is accepted and processed with the 3.2 rules. The version is not an error, because a later minor version is meant to stay compatible, but the library cannot know what it adds:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.3.0",
  info: { title: "Pets", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: { "/pets": { get: { operationId: "listPets", responses: { 200: { description: "ok" } } } } },
});

generator.getSpecVersion().status; // 'newer-minor'
generator.getSpecVersion().family; // '3.2' (the rules the document is processed with)
(await generator.generateTools()).length; // 1
generator.getDiagnostics().map((d) => `${d.code} ${d.path}`);
// ['NEWER_OPENAPI_VERSION /openapi']
```

A new major version (`4.0.0`) is not treated the same way: a new major may change the structure, so it is rejected.

### Why the declared version decides which operations are read

A `query` operation or an `additionalOperations` map in a document that declares 3.0 or 3.1 is ignored, with one `FEATURE_NEWER_THAN_DECLARED_VERSION` diagnostic for each (per path item). The message says so and what to do: declare OpenAPI 3.2 or later to read it. Two reasons:

- **Existing documents keep their tools.** A 3.0 or 3.1 document that happens to carry a `query` key or an `additionalOperations` key (neither exists in those versions) does not suddenly gain tools.
- **A method filter written for the old methods cannot be bypassed.** An `excludeMethods` list written when only the eight classic methods existed (`['delete']`) keeps meaning what it meant: a 3.0 or 3.1 document cannot add a method the list never named.

On a document that does declare 3.2 or newer, the second point does not hold: `additionalOperations` accepts any HTTP method token, so a new method can be added to the document at any time. **`excludeMethods` is a denylist and cannot cover methods you have not seen.** For a 3.2 document you do not control, prefer `includeMethods` (an allowlist) or `readOnlyOnly: true` (which keeps only operations whose effective annotations are read-only; an additional method is not read-only unless an `x-mcp` extension says so), and review `getDiagnostics()` and the tool list when the document changes. See [Configuration](./configuration.md#filtering-operations).

An `in: querystring` parameter is different: it is read in every version, like the other parameter locations. It becomes a whole-query input (see [Whole-query parameters](#whole-query-parameters-in-querystring)), and the operation makes a tool whatever version the document declares. For a document declaring 3.0 or 3.1 the validator adds a `FEATURE_NEWER_THAN_DECLARED_VERSION` warning.

### Swagger 2.0

Swagger 2.0 is not supported and the validator rejects it. Converting it to OpenAPI 3 is planned.

`validate: false` does not make it work. The document is read as OpenAPI 3: a query parameter that declares `type: integer` instead of `schema` becomes a string input, response schemas are not found, there is no `servers` entry (`host`, `basePath` and `schemes` are ignored), and an operation with an `in: body` or `in: formData` parameter is skipped with an `UNSUPPORTED_PARAMETER_LOCATION` diagnostic. Convert the document to OpenAPI 3 first.

### YAML and quoting

YAML reads an unquoted `openapi: 3.1` as the number `3.1`, which is `malformed`: a version has three parts, so write `openapi: 3.1.0`. An unquoted `swagger: 2.0` is the number `2`, and is recognised as Swagger 2.0.

A document with both `openapi` and `swagger` is read by its `openapi` field; `swagger` is ignored and a `CONFLICTING_VERSION_FIELDS` warning is recorded.

## What validation checks per version

The validator ([API Reference](./api-reference.md#validator)) differs by version in two rules:

| Rule | 3.0 | 3.1 | 3.2 |
| --- | --- | --- | --- |
| An operation must have `responses` (`NO_RESPONSES`) | Required | Optional | Optional |
| Parameter locations (`INVALID_PARAMETER_IN`) | `path`, `query`, `header`, `cookie` | Same as 3.0 | Adds `querystring` |

Where `responses` is present it must not be empty, in any version.

Constructs from a newer version are not errors in an older document; they are warnings:

- a `query` operation, or `additionalOperations`, in a document declaring 3.0 or 3.1: not read, so not validated either (the document is valid even if the ignored `additionalOperations` is malformed), and one `FEATURE_NEWER_THAN_DECLARED_VERSION` warning each;
- an `in: querystring` parameter in a document declaring 3.0 or 3.1: a `FEATURE_NEWER_THAN_DECLARED_VERSION` warning instead of `INVALID_PARAMETER_IN`. The operation still makes a tool: the generator reads the location in every version;
- `$self` in a document declaring 3.0 or 3.1: a `FEATURE_NEWER_THAN_DECLARED_VERSION` warning. The field is not read, so references resolve as if it were absent.

Other constructs a version added (`webhooks`, ...) are not checked against the declared version.

The validator reads exactly the operations the generator turns into tools (`resolveOperationLayout`), so it also applies these rules:

- at most one `in: querystring` parameter per operation (`MULTIPLE_QUERYSTRING_PARAMETERS`), never together with `in: query` parameters (`QUERYSTRING_WITH_QUERY_PARAMETERS`), and it must declare `content` with a media type, not `schema` (`QUERYSTRING_PARAMETER_WITHOUT_CONTENT`). The path item's parameters count with the operation's, after an operation-level parameter has overridden a path-level one with the same name and location. These are errors in every version, because the generator reads the location in every version. With `validate: false` the generator enforces the same three rules itself: the operation makes no tool, and the code is recorded in `getDiagnostics()`;
- a parameter's `content` should hold exactly one usable media type, and not sit next to a `schema` (`INVALID_PARAMETER_CONTENT`, a warning that says what generation does instead: it uses one media type, ignores a `content` that is empty or not a map, uses `schema` when there is one, reads a media type that is not an object as one with no schema, and does not read an `itemSchema` in it), and a parameter list (a path item's, or an operation's) should not repeat a `name` and `in`, a header name in any case (`DUPLICATE_PARAMETER`, a warning: the last one is used);
- in a document declaring 3.2 or newer, `additionalOperations` must be an object (`ADDITIONAL_OPERATIONS_NOT_OBJECT`), each key must be an HTTP method token (`INVALID_METHOD_TOKEN`), and no key may be the upper-case name of a method that has its own field, such as `GET` or `QUERY` (`DUPLICATE_FIXED_METHOD`);
- in a document declaring 3.2 or newer, `$self` must be a string in the form of a URI reference (RFC 3986) without a fragment (`INVALID_SELF`, an error). The rules the generator adds before it uses `$self` as a base (no user information, an `http`, `https` or `file` scheme, ...) depend on where the document was read from, which the validator does not know, so they are generator diagnostics (`REFUSED_SELF`, `UNRESOLVABLE_SELF`) and never validation errors.

Findings of the operation walk that are errors or warnings when validating:

| Code | When validating |
| --- | --- |
| `OPERATION_NOT_OBJECT` | **Error**: a method field or an `additionalOperations` value is not an object (`get: "x"`, `LINK: null`). A fixed field holding `null` is skipped without a finding, as it always was |
| `ADDITIONAL_OPERATIONS_NOT_OBJECT`, `INVALID_METHOD_TOKEN`, `DUPLICATE_FIXED_METHOD` | **Error**: the specification forbids each |
| `PATH_ITEM_NOT_OBJECT` | Warning: `"/pets": null` holds no operations |
| `METHOD_CASE_VARIANT` | Warning: an `additionalOperations` key such as `post` or `Get` is allowed by the specification, but this library sends every case of a standard method upper-cased, so only the fixed field serves it; the key is ignored |
| `REFUSED_METHOD` | Warning: `CONNECT` is a valid method the library never sends; the key is ignored |

An error message from the walk is the finding without its "the operation is ignored" clause, since a rejected document is not generated.

The validator does not enforce every difference between the versions. For example, a document without `paths` is valid in every version (it gets a `NO_PATHS` warning).

## OpenAPI 3.2 features

| Status | Meaning |
| --- | --- |
| Supported | Works as described |
| Not yet (planned) | The feature is read from the document without error, but the library does not act on it as the specification says; the row states what happens instead |
| Typed only | The feature is part of the TypeScript types (`OAS32`) and passes through generation without any behaviour of its own |

| Feature | Status | What happens today |
| --- | --- | --- |
| `query` operation | Supported | In a document declaring 3.2 or newer it becomes a tool. `metadata.method` is `'query'`, it is annotated read-only and idempotent, and `buildHttpRequest` sends `QUERY`. In a 3.0 or 3.1 document it is ignored with a `FEATURE_NEWER_THAN_DECLARED_VERSION` diagnostic |
| `additionalOperations` | Supported | In a document declaring 3.2 or newer, each usable key becomes a tool. `metadata.method` is the key as written (`'LINK'`), and `buildHttpRequest` sends it as written. Annotated like `POST`. Keys that are not HTTP method tokens, `CONNECT`, and keys that are a case variant of a method with its own field are ignored with a diagnostic. In a 3.0 or 3.1 document the whole map is ignored with one `FEATURE_NEWER_THAN_DECLARED_VERSION` diagnostic per path item |
| Parameter `in: querystring` | Supported | One input whose value is the whole query string, serialized in the media type of its `content`. The mapper entry has `type: 'query'` and `wholeQuery: true`. Whatever version the document declares the operation makes a tool; in 3.0 or 3.1 the validator also warns (`FEATURE_NEWER_THAN_DECLARED_VERSION`). At most one per operation, never with `in: query` parameters, and it must use `content`: the validator rejects a document that breaks a rule, and with `validate: false` the operation makes no tool and the diagnostic is recorded (`generateTool()` throws a `GenerationError`). See [Whole-query parameters](#whole-query-parameters-in-querystring) |
| Media Type `itemSchema` in a response (streams such as `text/event-stream`) | Supported | Reported in `metadata.responseStream` with `responseHints.streaming`, never as `outputSchema`: a media type with only `itemSchema` contributes nothing to it. The stream's media type is the first one with `itemSchema` in document order, chosen apart from the output schema's, so JSON and `text/event-stream` in one response give both. Read whatever version the document declares. See [Streaming responses](#streaming-responses) |
| Media Type `itemSchema` in a request body (a streamed upload) | Not yet (planned) | The body is left out: the tool takes no body input, and `UNSUPPORTED_STREAMING_REQUEST_BODY` is recorded |
| `$self` | Supported | In a document declaring 3.2 or newer it is the document's identity: a `$ref` to it is resolved from the document, with no fetch, and a Security Requirement key can name the document's schemes by it. It does not move where relative `$ref`s are read from: that is the retrieval URI (the URL or file the document was loaded from, or `documentUri`), and `$self` is the base of reads only for a document with no retrieval URI. A `$self` that breaks a rule is ignored with `INVALID_SELF` (also a validation error), `REFUSED_SELF` or `UNRESOLVABLE_SELF`; in a 3.0 or 3.1 document it is ignored with `FEATURE_NEWER_THAN_DECLARED_VERSION`. It never changes `servers`, and every URL built from it passes the same checks as an absolute `$ref`. The `$self` of a referenced document is not read. See [The `$self` Field](./ssrf-prevention.md#the-self-field) |
| Security scheme named by URI in a Security Requirement | Supported | In a document declaring 3.2 or newer, a key that is not a component name and resolves to this document with the fragment `/components/securitySchemes/<name>` is that scheme. A scheme of another document is not fetched: its Security Requirement object cannot be satisfied, so it is dropped (with every scheme it names) and `UNRESOLVED_SECURITY_SCHEME` is recorded. If every requirement of an operation is dropped, the operation makes no tool (`UNSATISFIABLE_SECURITY`). See [Security](./security.md#schemes-named-by-uri-openapi-32) |
| `style: cookie` on a cookie parameter | Supported | `buildHttpRequest` writes `name=value` pairs separated by `; ` with the values as given (RFC 6265 cookie-octets only). An exploded array repeats the name (`color=blue; color=black`), an exploded object is one cookie per property (`R=100; G=200`; a property may not name another cookie the tool sends), and an array or object with `explode: false` throws a `RequestBuildError`. Read whatever version the document declares; a cookie parameter without `style: cookie` is serialized as before. See [Request Builder](./request-builder.md#cookies-and-style-cookie) |
| Response `summary` (and the now-optional `description`) | Supported | `summary` is the description of the output schema when the response has no `description` (and the schema has none). A response with neither gets an output schema with no description |
| Example `dataValue` | Supported | With `includeExamples`, `dataValue` is used in preference to `value` |
| Example `serializedValue`, `externalValue` | Typed only | Read without error. Neither is used as an example value: they hold a serialization or a link, not the data |
| Server `name` | Supported | Copied to `metadata.servers[].name` when it is a string, and kept when `baseUrl` replaces the URL. `metadata.servers[]` carries `url`, `name`, `description` and `variables` |
| Security scheme `deprecated`, `oauth2MetadataUrl`, OAuth `deviceAuthorization` flow | Typed only | Read without error. They do not appear in `metadata.security` |
| Tag `parent`, `kind`, `summary` | Typed only | Read without error. `includeTags` and `excludeTags` match the tag names an operation lists, not its ancestors |
| Discriminator `defaultMapping`, XML `nodeType`, `components.mediaTypes`, `prefixEncoding` / `itemEncoding` | Typed only | Read without error. A `$ref` to a component media type dereferences like any other `$ref`; `xml` is dropped from converted schemas as before |

Webhooks and `components.pathItems` (3.1 and later) describe requests that the API sends to the client, so they make no tools.

### `query` and `additionalOperations`

A Path Item can hold operations in the fixed fields `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `trace` and, from 3.2, `query`, and in the 3.2 `additionalOperations` map, whose keys are HTTP methods that have no field (`LINK`, `PURGE`, `M-SEARCH`). The document must declare 3.2 or newer for the last two to be read.

```typescript
import { OpenAPIToolGenerator, buildHttpRequest } from "mcp-from-openapi";

const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.2.0",
  info: { title: "Files", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/files/search": {
      query: {
        operationId: "searchFiles",
        requestBody: {
          content: { "application/json": { schema: { type: "object", properties: { q: { type: "string" } } } } },
        },
        responses: { 200: { description: "Matches" } },
      },
    },
    "/files/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      additionalOperations: { LINK: { responses: { 204: { description: "Linked" } } } },
    },
  },
});

const tools = await generator.generateTools();
tools.map((t) => [t.name, t.metadata.method, t.annotations?.readOnlyHint]);
// [['searchFiles', 'query', true], ['LINK_files_By_id', 'LINK', false]]

const search = tools.find((t) => t.metadata.method === "query")!;
const request = buildHttpRequest(search, { q: "report" });
request.method; // 'QUERY'
request.url; // 'https://api.example.com/files/search'
request.body; // '{"q":"report"}'

const link = tools.find((t) => t.metadata.method === "LINK")!;
buildHttpRequest(link, { id: "7" }).method; // 'LINK'
```

- **Order.** Paths are sorted. Within a path: the eight classic methods in their usual order, then `query`, then the `additionalOperations` keys sorted by code unit (`LINK` before `lock`).
- **`metadata.method`.** The lowercase field name for a fixed method (`'get'`, `'query'`), the `additionalOperations` key exactly as written otherwise. HTTP methods are case-sensitive, so `LINK` and `Link` are two operations and two tools. `isStandardMethod(method)` tells the two kinds apart.
- **Keys that are ignored.** An `additionalOperations` key that is the upper-case name of a standard method (`GET`, `QUERY`) is forbidden by the specification (`DUPLICATE_FIXED_METHOD`). Another case of one (`post`, `Get`) is allowed by the specification, but the library sends every case of a standard method upper-cased, so it could not send that operation as written: it is ignored with `METHOD_CASE_VARIANT`, and the fixed field serves the method. `CONNECT` in any case (`REFUSED_METHOD`) and a key that is not an HTTP method token (`INVALID_METHOD_TOKEN`) are ignored too.
- **Names.** Without an `operationId`, the name is `<method>_<path>` as for any operation: `query_search`, `LINK_files_By_id`. The method keeps its case; `-` is a valid character in a tool name, so `M-SEARCH` stays as is. See [Naming Strategies](./naming-strategies.md).
- **Annotations.** `query` is safe and idempotent, like `GET`. An `additionalOperations` method has no known semantics, so it gets the conservative `POST` profile (not read-only, destructive, not idempotent). `readOnlyOnly: true` therefore keeps `query` tools and drops the additional ones. See [Annotations & Extensions](./annotations.md).
- **Exact matching.** An additional method is found only exactly as written, everywhere: `generateTool('/files/{id}', 'LINK')` finds `LINK` but `'link'` does not, an `includeMethods`/`excludeMethods` entry must be `'LINK'`, an Arazzo `operationPath` must end in `additionalOperations/LINK`, and `getOperation` follows the same rule. A standard method matches in any case (`'GET'`, `'Query'`).
- **Filters.** `excludeMethods` is a denylist; see the note above on why `includeMethods` or `readOnlyOnly` are the safer filters for a 3.2 document that can add arbitrary methods. See [Configuration](./configuration.md#filtering-operations).
- **On the wire.** `buildHttpRequest` sends a standard method upper-cased and an additional one as written, and refuses `CONNECT`. See [Request Builder](./request-builder.md).
- **Arazzo.** `operationPath` accepts `#/paths/<path>/additionalOperations/<METHOD>`. See [Arazzo Workflows](./arazzo.md).

To walk operations the same way yourself, use `listOperations(pathItem, { layout })` and `getOperation(pathItem, method, { layout })` with `layout: resolveOperationLayout(detectSpecVersion(document))` ([API Reference](./api-reference.md#operations-and-versions)) rather than indexing a path item with a method name: they read own properties only, so a method or path named `constructor` never resolves to something inherited. Without a `layout` they read every place an operation can be, whatever the document declares.

### Whole-query parameters (`in: querystring`)

A parameter `in: querystring` holds the entire query string, serialized by the media type of its `content`. The generator makes it one input whose mapper entry has `type: 'query'` and `wholeQuery: true` (the counterpart of `wholeBody`); `key` is the parameter's name, which is not sent.

```typescript
import { OpenAPIToolGenerator, buildHttpRequest } from "mcp-from-openapi";

const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.2.0",
  info: { title: "Search", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/search": {
      get: {
        operationId: "search",
        parameters: [
          {
            name: "filters",
            in: "querystring",
            required: true,
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  properties: { color: { type: "string" }, size: { type: "array", items: { type: "string" } } },
                },
              },
            },
          },
        ],
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
const [tool] = await generator.generateTools();

tool.inputSchema.properties.filters;
// { type: 'object', properties: { color: ..., size: ... },
//   'x-parameter-location': 'query',
//   'x-parameter-content-type': 'application/x-www-form-urlencoded',
//   'x-parameter-whole-query': true }

tool.mapper[0];
// { inputKey: 'filters', type: 'query', key: 'filters', required: true,
//   serialization: { contentType: 'application/x-www-form-urlencoded' }, wholeQuery: true }

buildHttpRequest(tool, { filters: { color: "blue", size: ["S", "M"] } }).url;
// 'https://api.example.com/search?color=blue&size=S&size=M'
```

- **Rules.** An operation has at most one such parameter (counting the path item's), never together with `in: query` parameters, and it must define `content` with a media type, not `schema`. The validator rejects a document that breaks a rule (`MULTIPLE_QUERYSTRING_PARAMETERS`, `QUERYSTRING_WITH_QUERY_PARAMETERS`, `QUERYSTRING_PARAMETER_WITHOUT_CONTENT`). With `validate: false` the generator skips the operation instead and records the same code; `generateTool()` for it throws a `GenerationError` whose context has `path`, `method` and `pointer`. A `content` with several media types is read as for any parameter (`INVALID_PARAMETER_CONTENT`).
- **Any version.** The location is read whatever version the document declares; a 3.0 or 3.1 document gets a `FEATURE_NEWER_THAN_DECLARED_VERSION` warning from the validator.
- **Serialization.** Form, JSON and other media types, query credentials and the pitfalls of post-processing the URL are in [Request Builder](./request-builder.md#whole-query-parameters).

### Streaming responses

A Media Type Object of a response can declare `itemSchema`, the schema of each item of a sequential media type such as `text/event-stream` or `application/jsonl`. The generator reports it in `metadata.responseStream` and never as the output schema: an MCP tool that declares an output schema must return its result as structured content, which an unbounded stream is not.

```typescript
const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.2.0",
  info: { title: "Events", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/events": {
      get: {
        operationId: "events",
        responses: {
          200: {
            description: "Event stream",
            content: {
              "text/event-stream": {
                itemSchema: {
                  type: "object",
                  required: ["data"],
                  properties: { event: { type: "string" }, data: { type: "string" }, id: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
});
const [tool] = await generator.generateTools();

tool.outputSchema; // undefined
tool.metadata.responseStream;
// { statusCode: 200, contentType: 'text/event-stream',
//   itemSchema: { type: 'object', required: ['data'], properties: { event: ..., data: ..., id: ... } } }
tool.metadata.responseHints; // { streaming: true }
```

Which response and media type are used (the first media type with `itemSchema` in document order, independent of the output schema's), the item schema's processing, and the output schema of an operation that streams on one status code and returns JSON on another are in [Response Schemas](./response-schemas.md#streaming-responses). A request body that declares only `itemSchema` is not supported (`UNSUPPORTED_STREAMING_REQUEST_BODY`).

## Diagnostics

`generator.getDiagnostics()` returns what the generator noticed without failing, in the order it was first noticed, each finding once:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.1.0",
  info: { title: "Search", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/search": {
      get: { operationId: "listSearches", responses: { 200: { description: "ok" } } },
      query: { operationId: "search", responses: { 200: { description: "Matches" } } },
    },
  },
});
const tools = await generator.generateTools();
tools.map((t) => t.name); // ['listSearches']: the 3.1 document has no `query` operation

for (const diagnostic of generator.getDiagnostics()) {
  console.log(diagnostic.severity, diagnostic.code, diagnostic.path);
  console.log(`  ${diagnostic.message}`);
}
// warning FEATURE_NEWER_THAN_DECLARED_VERSION /paths/~1search/query
//   The `query` operation needs OpenAPI 3.2 or later, but the document declares OpenAPI "3.1.0",
//   so it is ignored (no tool); declare OpenAPI 3.2 or later to read it
```

Each entry is `{ severity, code, message, path? }`. `path` is a JSON Pointer (RFC 6901) into the document. Every severity today is `warning`. Validation *errors* are not diagnostics: they throw a `ParseError` (see [Error Handling](./error-handling.md)).

The list grows as the generator works:

1. **On load**: the declared version, why `$self` is ignored when the document has one that is, and a retrieval URI that is too long to be used.
2. **At the first generation with `validate: true`**: the validator's warnings.
3. **While generating**: everything the generator skips or ignores. `generateTools()` walks every path; `generateTool()` records the findings of the path item and operation it builds.

With `validate: false` the second stage never happens. `generator.validate()` returns its own `ValidationResult` and does not add to the list.

`DIAGNOSTIC_CODES` (exported, with the type `DiagnosticCode`) is the one registry of every code `getDiagnostics()` can carry. The values never change once released.

| Code | Emitted when | Stage |
| --- | --- | --- |
| `NEWER_OPENAPI_VERSION` | `openapi` declares a 3.x minor version newer than 3.2 | Load |
| `CONFLICTING_VERSION_FIELDS` | The document has both `openapi` and `swagger`; `swagger` is ignored | Load |
| `INVALID_OPENAPI_VERSION` | The version cannot be processed: Swagger 2.0, another major, a malformed value. Recorded as a warning even when validation then rejects the document | Load |
| `MISSING_OPENAPI_VERSION` | The document declares no version | Load |
| `NO_PATHS` | The document defines no paths | Validation |
| `NO_OPERATIONS` | A path item holds no operation the declared version reads (it may hold only ignored ones) | Validation |
| `NO_OPERATION_ID` | An operation has no `operationId`; its tool name comes from the method and path | Validation |
| `NO_SERVERS` | The document defines no servers | Validation |
| `NO_SECURITY_SCHEMES` | The document has `security` but no `components.securitySchemes` | Validation |
| `FEATURE_NEWER_THAN_DECLARED_VERSION` | A `query` operation or `additionalOperations` in a document declaring 3.0 or 3.1: it is not read, so it makes no tool. Also `$self` in such a document (not read: references resolve as if it were absent), and, when validating, an `in: querystring` parameter (it is read all the same: the operation makes a tool) | Load (`$self`), validation, generation |
| `PATH_ITEM_NOT_OBJECT` | A path item is not an object (`"/pets": null`); it holds no operations | Validation, generation |
| `OPERATION_NOT_OBJECT` | A method field, or an `additionalOperations` value, is not an object; it is ignored | Generation (validation: error) |
| `ADDITIONAL_OPERATIONS_NOT_OBJECT` | `additionalOperations` is not an object; it is ignored | Generation (validation: error) |
| `INVALID_METHOD_TOKEN` | An `additionalOperations` key is not an HTTP method token (it has a space, is empty, ...); the operation is ignored | Generation (validation: error) |
| `DUPLICATE_FIXED_METHOD` | An `additionalOperations` key is the upper-case name of a method that has its own field (`GET`, `QUERY`); the operation is ignored and only the field is read | Generation (validation: error) |
| `METHOD_CASE_VARIANT` | An `additionalOperations` key is another case of a method that has its own field (`post`, `Get`); allowed by the specification, but the library sends such a method upper-cased, so the key is ignored | Validation, generation |
| `REFUSED_METHOD` | An `additionalOperations` key is `CONNECT` (any case), which opens a tunnel instead of sending a request; the operation is ignored | Validation, generation |
| `INVALID_SELF` | `$self`, in a document declaring 3.2 or newer, is not a string, is not a URI reference (a space or a non-ASCII character), or has a fragment. It is ignored; the validator rejects the document | Load (validation: error) |
| `REFUSED_SELF` | `$self` has user information, a scheme other than `http`, `https` or `file`, is a `file:` URI naming a host or in a document retrieved over the network, or is longer than 2,048 characters (or resolves to a longer URI). It is ignored; the message gives the reason without quoting the value | Load |
| `UNRESOLVABLE_SELF` | `$self` is a relative reference and the document has no usable retrieval URI to resolve it against (`fromJSON` or `fromYAML` without `documentUri`, or a retrieval URI too long to be used). It is ignored | Load |
| `BASE_URI_TOO_LONG` | The URI the document was retrieved from (the final URL of `fromURL` after redirects, or the `file:` URL of `fromFile`) is longer than 2,048 characters, so it is not used: a reference to the document by that URI is not recognised as local, and a relative reference to another document fails the load (rule `base-too-long`). No `path` | Load |
| `UNRESOLVED_SECURITY_SCHEME` | A Security Requirement object names a scheme that `components.securitySchemes` does not define, and that (in a 3.2 or newer document) is not a URI naming a scheme of this document: a scheme in another document is not read. One diagnostic per missing scheme; the whole object is dropped | Generation |
| `INVALID_SECURITY_REQUIREMENT` | A Security Requirement is not an object; it is dropped | Generation |
| `UNSATISFIABLE_SECURITY` | Every Security Requirement of an operation was dropped, so no way to authenticate is known; the operation makes no tool | Generation |
| `UNSUPPORTED_PARAMETER_LOCATION` | A parameter has an `in` the generator does not map to a request (a Swagger `body`, a missing `in`); the operation makes no tool | Generation |
| `MULTIPLE_QUERYSTRING_PARAMETERS` | An operation has more than one `in: querystring` parameter (the path item's included); the operation makes no tool | Generation (validation: error) |
| `QUERYSTRING_WITH_QUERY_PARAMETERS` | An operation has an `in: querystring` parameter and `in: query` parameters (the path item's included); the operation makes no tool | Generation (validation: error) |
| `QUERYSTRING_PARAMETER_WITHOUT_CONTENT` | An `in: querystring` parameter has no `content` holding a media type (it must not use `schema`); the operation makes no tool | Generation (validation: error) |
| `INVALID_PARAMETER_CONTENT` | A parameter's `content` cannot be read as OpenAPI defines it: several media types (one is used), none or not a map (ignored), alongside a `schema` (`schema` is used; for `in: querystring`, `content`), a media type that is not an object, or one with `itemSchema` (not read for a parameter). Generation alone also reports a media type left as an unresolved `$ref` | Validation, generation |
| `COOKIE_CONTENT_NOT_SENDABLE` | A cookie parameter sent as JSON (`content` with a JSON media type) whose schema allows a string, an object or an array (or has none): their JSON text holds `"` or `,`, which a cookie value cannot carry, so only a number, boolean or `null` can be sent. The tool is still made | Generation |
| `QUERYSTRING_WITH_QUERY_CREDENTIAL` | A whole-query parameter serialized as anything but `application/x-www-form-urlencoded` (no name=value pairs) in an operation whose security scheme sends an API key in the query. One per scheme; `buildHttpRequest` refuses a call using it. The tool is still made | Generation |
| `DUPLICATE_PARAMETER` | A parameter list (a path item's or an operation's) repeats a `name` and `in` (a header name in any case, an `in: querystring` parameter exactly); the last one is used and each earlier one is ignored | Validation, generation |
| `UNSUPPORTED_STREAMING_REQUEST_BODY` | A request body's media type declares only `itemSchema` (a streamed upload); the tool takes no body input | Generation |
| `UNREADABLE_REFERENCE` | **A validation error only, never a `getDiagnostics()` entry.** `generator.validate()` returns it, instead of throwing, for a `$ref` it cannot read (refused by a `refResolution` rule, missing, not JSON or YAML, a pointer that leads nowhere, ...). `message` is the `ParseError` message of generation without its prefix; `path` is the JSON Pointer of the `$ref` when it is in the document itself | `validate()` result |
| `DIAGNOSTICS_TRUNCATED` | The list reached `MAX_DIAGNOSTICS`; later findings were not recorded | Last entry |

The table lists every code of `DIAGNOSTIC_CODES`. Two kinds are validation errors: `INVALID_SELF` is both an error of `validate()` and a warning-severity diagnostic recorded at load, and `UNREADABLE_REFERENCE` is only ever an error returned by `generator.validate()`. "Validation: error" means the validator rejects the document for that finding (see [What validation checks per version](#what-validation-checks-per-version)); the diagnostic exists when generation runs with `validate: false`. When validating, the codes marked "Validation, generation" are warnings and reach `getDiagnostics()`; with `validate: false`, generation records them itself.

### Limits and escaping

A document is untrusted input, and a diagnostic quotes it, so each list and each quotation is bounded:

- **`MAX_DIAGNOSTICS` (1,000).** `getDiagnostics()` keeps the first 1,000 distinct findings, then ends with one `DIAGNOSTICS_TRUNCATED` entry (no `path`); findings after the limit are not recorded. A `ValidationResult` caps `errors` and `warnings` the same way, each ending with its own `DIAGNOSTICS_TRUNCATED` entry; `valid` still reflects every error. A repeated finding (the validator and the generator both reporting one) counts once.
- **Quoted document text.** A string from the document is cut (64 characters in most messages; a path key or method in a validation message, 1,024 and 64) and shown as JSON, with control characters, line and paragraph separators and bidirectional formatting characters written as `\uXXXX`, so no newline or terminal escape sequence reaches a log. The `ParseError` message for a failed validation quotes the first error at most 512 characters, escaped; `context.errors` keeps each error as the validator produced it.
- **JSON Pointers.** `path` is built with each segment escaped as RFC 6901 says (`~` is `~0`, `/` is `~1`). A segment is also made safe to display: unsafe characters become `\uXXXX` and a segment over 256 characters is cut and ends with `...(truncated)`. A pointer holding a cut or `\u`-escaped segment is for display: it does not resolve to the value. An ordinary key gives a pointer that resolves.
- **Legacy paths.** The validator codes that predate OpenAPI 3.2 support (`INVALID_PATH_FORMAT`, `NO_OPERATIONS`, `NO_OPERATION_ID`, `NO_RESPONSES`, `MISSING_PATH_PARAMETER`, `MISSING_PARAMETER_NAME`, `MISSING_PARAMETER_IN`, `INVALID_PARAMETER_IN`, `PATH_PARAMETER_NOT_REQUIRED`, `MISSING_PARAMETER_SCHEMA`) keep their historical `path`: the path key unescaped, cut past 1,024 characters (`LEGACY_PATH_KEY_MAX_LENGTH`) with `...` (`/paths//pets/get/operationId`), so code that matches on them keeps working. Every newer code, and every diagnostic the generator adds, uses a JSON Pointer (`/paths/~1pets/get`).

## Changes to existing output in this release

Most of what this release adds is output for constructs that earlier versions skipped, ignored or did not read. The changes below alter the tools, requests or reports generated from documents the library already accepted, so check them when you upgrade. Each example is the same document before and after.

### A parameter defined with `content`

A parameter with `content` instead of `schema` was a string input, serialized like a `schema` parameter. It is now the media type's schema, serialized in the media type, and its mapper entry says so. The same change applies in a path, a query, a header and a cookie, in every OpenAPI version.

```typescript
const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.1.0",
  info: { title: "Search", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/search": {
      get: {
        operationId: "search",
        parameters: [
          {
            name: "filter",
            in: "query",
            content: {
              "application/json": {
                schema: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
              },
            },
          },
        ],
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
const [tool] = await generator.generateTools();
```

Before:

```typescript
tool.inputSchema.properties.filter;
// { type: 'string', 'x-parameter-location': 'query' }
tool.mapper[0];
// { inputKey: 'filter', type: 'query', key: 'filter', required: false }
buildHttpRequest(tool, { filter: '{"tag":"news"}' }).url; // the caller passed the JSON text
// 'https://api.example.com/search?filter=%7B%22tag%22%3A%22news%22%7D'
```

After:

```typescript
tool.inputSchema.properties.filter;
// { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'],
//   'x-parameter-location': 'query', 'x-parameter-content-type': 'application/json' }
tool.mapper[0];
// { inputKey: 'filter', type: 'query', key: 'filter', required: false,
//   serialization: { contentType: 'application/json' } }
buildHttpRequest(tool, { filter: { tag: "news" } }).url; // the caller passes the value
// 'https://api.example.com/search?filter=%7B%22tag%22%3A%22news%22%7D'
```

What to check:

- **Callers must pass the value, not its text.** A string given to an `application/json` parameter is a JSON string, so the old input is now quoted a second time: `buildHttpRequest(tool, { filter: '{"tag":"news"}' }).url` is `'https://api.example.com/search?filter=%22%7B%5C%22tag%5C%22%3A%5C%22news%5C%22%7D%22'`.
- **`style`, `explode` and `allowReserved` are gone from the mapper entry** (and `x-parameter-style` and `x-parameter-explode` from the input property), because OpenAPI says they do not apply to `content`. A document that gave them used to see them there.
- **A parameter with both `schema` and `content`** is still read as `schema`.
- **A media type with no schema** is an unconstrained input (`{}`) for a JSON media type, `{ type: 'object' }` for `application/x-www-form-urlencoded` and `{ type: 'string' }` for any other (before, always a string).
- **A `content` that cannot be read as OpenAPI defines it** now records an `INVALID_PARAMETER_CONTENT` warning (the document stays valid): several media types (one is used: `application/json`, then `application/x-www-form-urlencoded`, `multipart/form-data`, `application/xml`, `text/plain`, else the first), an empty or non-map `content` (ignored, the parameter stays a string), both `schema` and `content` (`schema` is used), a media type that is not an object, an unresolved `$ref` media type, and `itemSchema` inside the parameter's `content`.

See [Request Builder](./request-builder.md#parameters-defined-with-content) for the serialization of each media type in each location.

### An operation-level parameter overrides a path-level one

A parameter on the Path Item and one on the operation with the same `name` and `in` were both kept, as a conflict. Now the operation's replaces the path item's, as OpenAPI says, and a list that repeats a `name` and `in` uses the last one.

```typescript
const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.0.3",
  info: { title: "Orders", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/orders": {
      parameters: [
        { name: "limit", in: "query", description: "Path-level default", schema: { type: "integer", default: 20 } },
        { name: "X-Trace", in: "header", schema: { type: "string" } },
      ],
      get: {
        operationId: "listOrders",
        parameters: [
          {
            name: "limit",
            in: "query",
            required: true,
            description: "Operation-level",
            schema: { type: "integer", minimum: 1, maximum: 100 },
          },
        ],
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
const [tool] = await generator.generateTools();
```

Before:

```typescript
Object.keys(tool.inputSchema.properties); // ['queryLimit', 'X-Trace']
tool.inputSchema.required; // ['queryLimit']
tool.mapper.map((m) => `${m.inputKey}:${m.type}:${m.key}:${m.required}`);
// ['queryLimit:query:limit:false', 'queryLimit:query:limit:true', 'X-Trace:header:X-Trace:false']
buildHttpRequest(tool, { queryLimit: 5 }).url; // 'https://api.example.com/orders?limit=5&limit=5'
```

After:

```typescript
Object.keys(tool.inputSchema.properties); // ['X-Trace', 'limit']
tool.inputSchema.required; // ['limit']
tool.mapper.map((m) => `${m.inputKey}:${m.type}:${m.key}:${m.required}`);
// ['X-Trace:header:X-Trace:false', 'limit:query:limit:true']
buildHttpRequest(tool, { limit: 5 }).url; // 'https://api.example.com/orders?limit=5'
```

What to check:

- **The input key changes** from `queryLimit` to `limit`, so callers that pass `queryLimit` must pass `limit`. A name in different locations is still renamed as before ([Parameter Conflicts](./parameter-conflicts.md)).
- **The order of input keys can change**: the path-level parameters that were not overridden come first, then the operation's.
- **Two parameters with one `name` and `in` in a single list** (an operation's or a path item's) were both kept and sent twice (`?q=3&q=3`); now the last is used, and each earlier one records a `DUPLICATE_PARAMETER` warning (the document stays valid). An override is silent.
- **Header names match in any case.** A path-level header `X-Trace` and an operation-level `x-trace` were two inputs, both sent (`{ 'X-Trace': 'a', 'x-trace': 'b' }`); now they are one parameter, and the operation's spelling is the input key and the header on the wire (`{ 'x-trace': '7' }`). Query and cookie names still compare exactly.
- **Lint reads the same parameters.** A path-level parameter without a description that an operation overrides with a described one was reported by `missing-parameter-description` (`limit, X-Trace`); it no longer is.

### A `null` property in a form body

A `null` property of an `application/x-www-form-urlencoded` request body was sent as the text `null`. It is left out now, as a form has no way to write null (an `undefined` property always was). The same serializer writes a form whole query and a form `content` parameter.

```typescript
// a form body with properties a and z
buildHttpRequest(tool, { a: "1", z: null }).body;
// before: 'a=1&z=null'
// after:  'a=1'
```

A JSON body keeps `null`, and a multipart part with a `null` value is still sent as the text `null`.

### Header and cookie values that cannot be sent

A header value with a character outside tab, space, visible ASCII and U+0080 to U+00FF was built and then failed inside the HTTP client. A cookie value above U+00FF was built too. Both are a `RequestBuildError` now, where the parameter is known:

```typescript
// a header parameter X-Note
buildHttpRequest(tool, { "X-Note": "€5" }).headers;
// before: { 'X-Note': '€5' }  (new Headers(...) then throws "...greater than 255")
// after:  RequestBuildError: Header 'X-Note' value contains U+20AC at index 0, which a header value
//         cannot hold (only tab, space, visible ASCII and U+0080 to U+00FF)
```

`style: cookie` and `content` cookies are new and held to RFC 6265 cookie-octets; a plain cookie keeps its old rules apart from the U+00FF limit. A lone surrogate is refused by every percent-encoder and form-encoder (before, `encodeURIComponent` threw a bare `URIError` and form bodies silently wrote U+FFFD). See [Header and cookie values](./request-builder.md#header-and-cookie-values).

### A name the input chooses may not be a credential or a sibling parameter

An exploded `form` object in the query used to let its properties name any query pair, including the one a credential uses:

```typescript
// an `apiKey` scheme `key` in the query (api_key) and an exploded `filter` object
buildHttpRequest(tool, { filter: { color: "blue", api_key: "ATTACKER" } }).url;
// before: 'https://api.example.com/items?color=blue&api_key=ATTACKER'
// after:  RequestBuildError: The input of query parameter 'filter' (input key 'filter') names the query
//         parameter 'api_key', which this tool reserves for the credential of security scheme 'key'
```

The caller of a tool chooses its input, so a name taken from it must not add or replace a credential (or override a sibling parameter). See [Names the input chooses](./request-builder.md#names-the-input-chooses).

### Input values are read as own properties

`buildHttpRequest` used to read `input[inputKey]` through the prototype chain, so `new Input()` with the value in a prototype getter, or `Object.create({ id: 'x' })`, worked. Such a value is now missing (`Required path parameter 'id' (input key 'id') is missing`). Pass an object that holds the values as own properties (any object parsed from JSON does). A parameter named like an `Object.prototype` member (`constructor`, `toString`) used to throw a `TypeError` while the query was composed; it works now.

### 3.2 fields honoured in a document that declares 3.1

Generation follows features, not the declared version, apart from which operations exist. A document declaring 3.0 or 3.1 that uses a 3.2 field now gets it read:

```typescript
// a 3.1.0 document: a cookie parameter `color` with style: cookie (an array), a server with
// name: 'production', a 200 response with itemSchema on text/event-stream, a 204 with only a summary
buildHttpRequest(tool, { color: ["blue", "black"] }).headers.Cookie;
// before: 'color=blue,black'   after: 'color=blue; color=black'
tool.metadata.servers;
// before: [{ url: 'https://api.example.com' }]
// after:  [{ url: 'https://api.example.com', name: 'production' }]
tool.metadata.responseStream; // before: undefined
// after: { statusCode: 200, contentType: 'text/event-stream', itemSchema: { type: 'object', properties: { data: ... } } }
tool.outputSchema; // the 204 variant
// before: { type: 'null', 'x-status-code': 204 }
// after:  { type: 'null', description: 'Nothing to return', 'x-status-code': 204 }
```

The same holds for an `in: querystring` parameter, which used to skip its operation (`UNSUPPORTED_PARAMETER_LOCATION`) and now makes a whole-query tool, and for `dataValue` in an Example Object (preferred over `value` when `includeExamples` is on; an example with both used `value`).

### A relative `$ref` resolves against the document's location

A relative external `$ref` resolved against the process working directory, whatever the document was loaded from. It now resolves against the document's retrieval URI: the URL a `fromURL` document was finally read from, the file of a `fromFile` document, or `LoadOptions.documentUri`. A document with none of these (`fromJSON`, `fromYAML`) resolves against an absolute `$self` when it has one (3.2), and otherwise against the working directory as before.

```typescript
// /tmp/petstore/openapi.json holds { "$ref": "./schemas/pet.json" }: the file /tmp/petstore/schemas/pet.json.
// The process runs with / as its working directory.
const generator = await OpenAPIToolGenerator.fromFile("/tmp/petstore/openapi.json", {
  refResolution: { allowedProtocols: ["file"] },
});
const [tool] = await generator.generateTools();
```

Before:

```
ParseError: Failed to dereference OpenAPI document: Error opening file /schemas/pet.json: ENOENT: no such file or directory, open '/schemas/pet.json'
```

After:

```typescript
Object.keys(tool.outputSchema.properties); // ['id', 'name']
```

What to check:

- **A `fromFile` document used to read its references from the working directory.** That worked only when the process was started in the spec's own directory. If you relied on it for a spec whose references sit elsewhere, say where with `documentUri`: `documentUri: pathToFileURL(process.cwd() + "/").href` restores the old base.
- **A `fromURL` document whose relative references used to fail now fetches them from its own location**, through the same host, address and redirect checks (and without your `headers`). Before, `./schemas/pet.json` was looked up as a local file and refused (`Unable to resolve $ref pointer`). This is a widening: a load that used to fail now makes a request to the host the spec came from. An absolute `$ref` to that host was always fetched, so it reaches nothing new, but if you load specs you do not trust, restrict `allowedHosts` or use `secureDefaults: true`.
- **A 3.2 document with no retrieval URI and an absolute `http` or `https` `$self` fetches its relative references from the `$self`** under the default options (a `fromJSON` document, say). They used to resolve against the working directory and be refused as local files; with `file` allowed they were read from disk, and are now fetched instead. Every check still applies, and `$self` never moves the reads of a document that has a retrieval URI (see below).
- **Reading local files still needs `file` in `allowedProtocols`**, for `fromFile` as before.

### A `$ref` to the document's own URI is resolved locally, and held to a pointer that exists

A `$ref` that names the document's own URI (`https://specs.example.com/petstore/openapi.json#/components/schemas/Pet` in a document served from that URL, or its `$self`) was an external reference: with the default options the document was fetched a second time (without your `headers`) and the reference resolver followed the pointer in the copy, and under `secureDefaults` it stayed unresolved. It is now resolved from the document, like `#/components/schemas/Pet`.

```typescript
// a response schema is { "$ref": "https://specs.example.com/petstore/openapi.json#/components/schemas/Pet" }
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  documentUri: "https://specs.example.com/petstore/openapi.json",
  secureDefaults: true,
});
const [tool] = await generator.generateTools();
tool.outputSchema;
```

Before (`documentUri` did not exist, so the document had no location, and `secureDefaults` leaves an external reference as written):

```typescript
{ $ref: 'https://specs.example.com/petstore/openapi.json#/components/schemas/Pet', 'x-status-code': 200, description: 'ok', 'x-content-type': 'application/json' }
```

After:

```typescript
{ type: 'object', properties: { id: { type: 'integer' } }, 'x-status-code': 200, description: 'ok', 'x-content-type': 'application/json' }
```

A reference of this kind is also held to the rules below. Each row was run with `fromURL` against a local server, before this release and after, once with the default options and once with `secureDefaults: true`; `U` stands for the document's own URL.

| `$ref` | Before, default options | Before, `secureDefaults` | After (both) |
| --- | --- | --- | --- |
| `U#/components/schemas/Pet` | The document is fetched again; the schema resolves | Left as written | Resolves, no fetch |
| `U#/components/schemas/My%20Pet` (key `My Pet`) | Resolves (the fetched copy decodes the fragment) | Left as written | Resolves: the fragment is percent-decoded as a JSON Pointer |
| `U#/components/schemas/A~1B` (key `A/B`) | Resolves | Left as written | Resolves |
| `U`, `U#`, and `""` with a base | `U`, `U#`: the whole document, fetched again. `""`: left as written | Left as written | The whole document. `""` without a base is still left as written |
| `U#/components/schemas/Nope` (nothing there) | `ParseError`: `Missing $ref pointer "#/components/schemas/Nope". Token "Nope" does not exist.`, with no `rule` | Left as written, no error | `ParseError`, rule `missing-target`: `it names this document, but "#/components/schemas/Nope" points to nothing in it` |
| `U#/components/schemas/Alias/properties`, where `Alias` is `{ "$ref": "#/components/schemas/Pet" }` | Followed through `Alias` | Left as written | `ParseError`, rule `missing-target`: `its pointer goes through another $ref (at "#/components/schemas/Alias"), which is not followed` |
| `U#/components/schemas/Pet` with a `description` beside it | The sibling `description` is kept | Left as written | The sibling is dropped, as for `#/...` |
| `U#Pet` (a plain-name fragment) | `ParseError`: `Invalid $ref pointer "Pet"...` | Left as written | Same `ParseError` (rule `missing-target`); under `secureDefaults`, left as written |

A plain local reference (`#/components/schemas/Nope`) did not change: it still becomes `{}` without an error, and `#/components/schemas/My%20Pet` still finds nothing (see Known gaps). Only references that name the document by URI are checked. A missing target never turned into `{}` for these before: it was an error with the default options and left as written under `secureDefaults`; it is an error in both now.

What to check:

- **No second request.** With `fromURL` and the default options, a document that referred to its own URL used to cause a second `GET` of it; it causes none now.
- **A pointer through another `$ref` is refused.** It used to resolve when the document was fetched again. Point at the target of the alias instead.
- Which URIs count, and the limits, are in [SSRF Prevention](./ssrf-prevention.md#references-to-the-document-itself).

### `validate()` reads the references of the document, and reports what it cannot read

`generator.validate()` validated the loaded document as it was, without reading any reference. When the document holds a `$ref` that does not start with `#` (and `dereference` is on), it now dereferences first and validates the result, so it can read files and make network requests, with the same `refResolution` rules as generation. A reference it cannot read does not throw: it is the result.

```typescript
// a response schema is { "$ref": "https://schemas.example.com/pet.json" }
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: { allowedHosts: ["trusted.example.org"] },
});
await generator.validate();
```

Before:

```typescript
{ valid: true } // the reference was never read
```

After:

```typescript
{
  valid: false,
  errors: [
    {
      message: 'Cannot read $ref "https://schemas.example.com/pet.json" resolved against "/" to "https://schemas.example.com/pet.json": its host "schemas.example.com" is not in refResolution.allowedHosts; add the host to refResolution.allowedHosts to read it',
      code: 'UNREADABLE_REFERENCE',
    },
  ],
}
```

(The process runs with `/` as its working directory, which is what a document with no location resolves against. `generateTools()` throws the `ParseError` with this text after `Failed to dereference OpenAPI document: `.) When the `$ref` is in the document itself and its place is known, the error has a `path`: the JSON Pointer of the `$ref`.

What to check:

- **Code that called `validate()` to check a document without side effects** (before accepting it, say) now reads whatever the document references. Call it only where generation would be acceptable, or load with `dereference: false`, which validates without reading.
- **It does not throw for an unreadable reference**, so a caller that used `try/catch` around `validate()` to catch a failure should read `result.errors` for `UNREADABLE_REFERENCE`. The one thing that still throws is a document that cannot be copied at all (a YAML alias that makes it contain itself, with a reference to read): the same `ParseError` generation throws.
- **The work is shared.** The dereference happens once per generator: `generateTools()` after `validate()` reuses it, the other way round too, and concurrent calls share one set of fetches. After a failure the next call tries again. `getDocument()` returns the dereferenced document after `validate()`, also for a document whose only external-looking references name its own URI (they are made local and read nothing). `validate()` still adds nothing to `getDiagnostics()`.

### `$self` and schemes named by URI are read

`$self` was ignored, and a Security Requirement key that was a URI dropped its whole requirement object. In a document declaring 3.2 or newer both are read now: `$self` as the document's identity, a URI key as the scheme of this document it names.

**`$self` never moves where references are read from.** The retrieval URI does, whenever there is one. OpenAPI 3.2 makes `$self` the base of relative references; the specification leaves open where an implementation retrieves a document from, so the identity follows the specification and the retrieval location is an implementation choice.

```typescript
// a 3.2 document; $self is "https://specs.example.com/v1/openapi.json"; a response schema is { "$ref": "./schemas/pet.json" }
// 1. a document with no retrieval URI
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: { allowedHosts: ["trusted.example.org"] },
});
await generator.generateTools(); // the process runs with / as its working directory
```

Before (`$self` ignored: the reference was a local file, which is blocked):

```
ParseError: Failed to dereference OpenAPI document: Unable to resolve $ref pointer "/schemas/pet.json"
```

After (no retrieval URI, so the absolute `$self` is where the reads go: `https://specs.example.com/v1/schemas/pet.json`):

```
ParseError: Failed to dereference OpenAPI document: Cannot read $ref "./schemas/pet.json" at "#/paths/~1pets/get/responses/200/content/application~1json/schema"
  resolved against "https://specs.example.com/v1/openapi.json" to "https://specs.example.com/v1/schemas/pet.json":
  its host "specs.example.com" is not in refResolution.allowedHosts; add the host to refResolution.allowedHosts to read it
```

`allowedHosts` stops the example before any request; without it, the reference is fetched from that host (with a local server standing in for it, it is). This is a change in what a load fetches, noted above. With a retrieval URI the same document reads from where it was loaded:

```typescript
// 2. the same document with a documentUri of a mirror
await OpenAPIToolGenerator.fromJSON(spec, {
  documentUri: "https://mirror.example.net/petstore/openapi.json",
  refResolution: { allowedHosts: ["trusted.example.org"] },
}).then((generator) => generator.generateTools());
// ParseError: ... resolved against "https://mirror.example.net/petstore/openapi.json"
//   to "https://mirror.example.net/petstore/schemas/pet.json": its host "mirror.example.net" is not in ...

// 3. the same document read from /tmp/petstore32/openapi.json with fromFile, default options
// ParseError: ... resolved against "/tmp/petstore32/openapi.json" to "/tmp/petstore32/schemas/pet.json":
//   it is read as a local file, and refResolution.allowedProtocols ("http", "https") does not include "file"; ...
```

A mirror serves its own copies, and a file-loaded spec reads its sibling files whatever `$self` says: `specs.example.com` is not contacted in either case. (Before this release the second and third cases failed the same way as the first, `Unable to resolve $ref pointer`, because relative references resolved against the working directory.) See [The `$self` Field](./ssrf-prevention.md#the-self-field).

A security scheme named by URI:

```typescript
// a 3.2 document with components.securitySchemes.ApiKey and, on an operation,
//   security: [{ "#/components/securitySchemes/ApiKey": [] }]
const generator = await OpenAPIToolGenerator.fromJSON(spec);
const tools = await generator.generateTools();
```

Before:

```typescript
tools.length; // 0
generator.getDiagnostics().map((d) => d.code); // ['UNRESOLVED_SECURITY_SCHEME', 'UNSATISFIABLE_SECURITY']
```

After:

```typescript
tools.length; // 1
tools[0].metadata.security; // [{ scheme: 'ApiKey', type: 'apiKey', scopes: [], name: 'X-Key', in: 'header' }]
generator.getDiagnostics(); // []
```

A 3.0 or 3.1 document that has a `$self` field now records `FEATURE_NEWER_THAN_DECLARED_VERSION` for it (a warning; the field is ignored, as before).

### The error for a `$ref` that cannot be read

A reference that the allow-list or the host checks refused failed with the reference resolver's generic message, and the `ParseError` kept the raw error in `context.originalError`. It now names the reference, the base, the rule and what would allow it, and `ParseError.context` carries `rule`, `reference`, `base`, `resolved` and, when known, `path`, each bounded and escaped; the raw error is not kept. A fetch that failed changed too:

```
// fromJSON documents, the process runs with / as its working directory
// a response schema is { "$ref": "https://schemas.example.com/pet.json" }, allowedHosts: ["trusted.example.org"]
// before: ParseError: Failed to dereference OpenAPI document: Unable to resolve $ref pointer "https://schemas.example.com/pet.json"
//         context: { originalError }
// after:  ParseError: Failed to dereference OpenAPI document: Cannot read $ref "https://schemas.example.com/pet.json"
//           resolved against "/" to "https://schemas.example.com/pet.json":
//           its host "schemas.example.com" is not in refResolution.allowedHosts; add the host to refResolution.allowedHosts to read it
//         context: { rule: 'host-not-allowed', reference, base: '/', resolved }

// a reference to a server that answers 404
// before: ParseError: Failed to dereference OpenAPI document: Failed to resolve external $ref "http://127.0.0.1:<port>/missing.json": 404 Not Found
// after:  ParseError: Failed to dereference OpenAPI document: Cannot read $ref "http://127.0.0.1:<port>/missing.json"
//           resolved against "/" to "http://127.0.0.1:<port>/missing.json": the server answered 404 "Not Found"
```

Every other failure of a dereference has a `rule` now (`invalid-document` for a file that is not JSON or YAML, `missing-target` for a pointer that leads nowhere, `unreadable` for the rest), except a document that cannot be copied at all (a YAML alias that makes it contain itself), which keeps only `originalError`. When several references cannot be read the first in document order is the one reported. Code that matched on the old message text should read `error.context.rule` instead. See [When a Reference Cannot Be Read](./ssrf-prevention.md#when-a-reference-cannot-be-read).

### Fields that only add

`x-parameter-content-type` and `x-parameter-whole-query` on input properties, `wholeQuery` on a mapper entry, `queryString` on a built request, `metadata.servers[].name`, `metadata.responseStream` and `responseHints.streaming`, `LoadOptions.documentUri`, `rule`, `reference`, `base`, `resolved` and `path` on the `context` of a `ParseError`, `context.reason` on an `SsrfError`, and the new warnings (`INVALID_PARAMETER_CONTENT`, `DUPLICATE_PARAMETER`, `UNSUPPORTED_STREAMING_REQUEST_BODY`, `COOKIE_CONTENT_NOT_SENDABLE`, `QUERYSTRING_WITH_QUERY_CREDENTIAL`, `INVALID_SELF`, `REFUSED_SELF`, `UNRESOLVABLE_SELF`, `BASE_URI_TOO_LONG`; a valid document stays valid, apart from a 3.2 document whose `$self` is not a URI reference, which `validate()` now rejects with `INVALID_SELF`). `fromArazzo` rejects a `loadOptions.documentUri` with an `ArazzoError` (see [Arazzo Workflows](./arazzo.md#sources)).

### If you wrote your own request builder

An older request builder (such as the manual walkthrough in [Getting Started](./getting-started.md)) does not know `wholeQuery`, nor a `serialization.contentType` on a path, query, header or cookie entry, so it serializes those parameters wrongly. Check every mapper entry of the tools you serve:

```typescript
function needsMediaType(entry: ParameterMapper): boolean {
  return entry.wholeQuery === true || (entry.type !== "body" && entry.serialization?.contentType !== undefined);
}

tool.mapper.filter(needsMediaType).map((entry) => entry.inputKey);
// ['coordinates', 'X-Filter'] for a query and a header parameter defined with content
```

For a flagged entry a builder that only does `String(value)` sends `coordinates=%5Bobject+Object%5D` and a header `X-Filter: [object Object]`, where `buildHttpRequest` sends `coordinates=%7B%22lat%22%3A1%7D` and `X-Filter: {"a":1}`; for a `wholeQuery` entry it sends `query=%5Bobject+Object%5D`, where the query string should be the serialized value alone. Either handle them (see [Request Builder](./request-builder.md)) or call `buildHttpRequest`. Also check for `style: 'cookie'` entries, for input keys that changed with the override rule, and for the rules on names, header values and `null` above.

## Known gaps

What the library does not do yet. These exist today and apply as stated; each is planned unless noted.

**OpenAPI 3.2 and Swagger 2.0**

- Swagger 2.0 is rejected (see above).
- The 3.2 features marked "Not yet (planned)" in the table above.
- The new security scheme fields (`oauth2MetadataUrl`, `deprecated`, the `deviceAuthorization` flow) are typed but not surfaced in `metadata.security`.
- Tag `parent` is not used by `includeTags` / `excludeTags`: filtering by a parent tag does not include operations tagged with its children.
- An operation that streams on `200` (an `itemSchema` and no `schema`) and returns a JSON error on `404` has an `outputSchema` that describes the error alone: the stream is in `metadata.responseStream`.

**Every version**

- A boolean `false` subschema becomes `{}`, which accepts everything. (`true` also becomes `{}`, which is correct.)
- Response keys such as `2XX` and `4XX` are read as the status codes `2` and `4`, so `metadata.responseStatusCodes` holds `[2, 4]` for them.
- A preferred media type that has no schema hides a sibling media type that does: `application/json: {}` next to a `text/plain` schema produces no output schema.
- Path-level `servers` are ignored. Operation-level and document-level `servers` are used.
- A `$ref` with sibling keywords (`$ref` plus `description`) keeps only the target when the library dereferences internal references itself; external references keep the siblings.
- The Encoding Object is carried on the mapper (`serialization.encoding`, for a `content` parameter and a form-urlencoded whole query too), but `buildHttpRequest` does not apply it: a multipart part declared `contentType: application/json` is sent as a plain string field, and a form property's `style` and `explode` are ignored.
- Alternative security requirements (`security: [{ a: [] }, { b: [] }]`) are flattened: every scheme of every requirement object that can be satisfied becomes a requirement of the tool, rather than a choice between them.
- A document with no retrieval URI (`fromJSON` or `fromYAML` without `documentUri`) resolves a relative external `$ref` against an absolute `$self` when it has one, and otherwise against the process working directory. With a retrieval URI (`fromURL`, `fromFile`, `documentUri`) it resolves against that, whatever `$self` says.
- A local reference (`#/...`) keeps the reading it always had: its percent-escapes are not decoded (`#/components/schemas/My%20Pet` finds nothing), and a pointer that leads nowhere becomes `{}` without an error. Only a reference that names the document by its URI is decoded and checked (rule `missing-target`).
- The `$self` of a document reached through a `$ref` is not read: a relative reference inside it resolves against the URL or path it was fetched from.
- A relative reference under a Schema Object with its own `$id` resolves against that `$id` in a document declaring 3.1, because the reference resolver applies nested `$id` scopes there. In a document declaring 3.0 or 3.2 it resolves against the document's base URI instead. The rewrite of a `$ref` to the document's own URI skips a schema with its own `$id` in every version.
- A `$ref` to the document's own URI is resolved locally only when its fragment is empty or a JSON Pointer; a plain-name fragment (`#Pet`, an `$anchor`) is left to the reference resolver.
- A Security Requirement that names a scheme by the URI of another document is dropped (`UNRESOLVED_SECURITY_SCHEME`); schemes of other documents are never read.
- A request body media type that carries parameters is matched whole. `application/x-www-form-urlencoded; charset=utf-8` is not recognized as a form, so an object body is sent as JSON text under that `content-type` header (`{"a":"x y","n":1}`); `multipart/form-data; boundary=x` is sent the same way, as JSON text, with that header. `application/json; charset=utf-8` happens to work, because an object is written as JSON anyway. Media types of `content` parameters and whole queries are compared without their parameters and are not affected.
- A cookie parameter with the default `form` style is sent without percent-encoding, where OpenAPI 3.2.1 describes percent-encoded form cookies: a value with a space or `;` throws a `RequestBuildError` instead of being encoded, and `%` and non-ASCII characters up to U+00FF are sent as they are.
- A path value of `.` or `..` is sent as a dot segment (`/files/../meta`), which a client that normalizes URLs (`new URL`, `fetch`) resolves to another path (`/meta`). Values such as `%2e%2e` or `a/../b` are encoded and stay one segment.
- A header parameter named `Accept`, `Content-Type` or `Authorization` is not ignored, as OpenAPI says its definition SHALL be: it becomes an input and the builder sends it, so the caller of the tool chooses those headers.
- A parameter named `__proto__` gets a mapper entry (and a `required` entry, when it is required) but no property in `inputSchema.properties`.
- A security scheme and a parameter can share an input key (a scheme `api_key` and a parameter `api_key`). With `includeSecurityInInput` the security property replaces the parameter's in the input schema (its description is lost); either way the mapper holds both entries under one key, and the one value is sent as the credential and as the parameter.

---

**Related:** [API Reference](./api-reference.md) | [Configuration](./configuration.md) | [Error Handling](./error-handling.md) | [Architecture](./architecture.md)
