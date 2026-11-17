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

An `in: querystring` parameter is different: it is a feature the generator cannot build a request for yet, so its operation is skipped with an `UNSUPPORTED_PARAMETER_LOCATION` diagnostic whatever version the document declares.

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
- an `in: querystring` parameter in a document declaring 3.0 or 3.1: a `FEATURE_NEWER_THAN_DECLARED_VERSION` warning instead of `INVALID_PARAMETER_IN`. The operation is still skipped when generating.

Other constructs a version added (`webhooks`, `$self`, ...) are not checked against the declared version.

The validator reads exactly the operations the generator turns into tools (`resolveOperationLayout`), so for a 3.2 document it also applies these rules:

- at most one `in: querystring` parameter per operation (`MULTIPLE_QUERYSTRING_PARAMETERS`), never together with `in: query` parameters (`QUERYSTRING_WITH_QUERY_PARAMETERS`), and it must declare `content`, not `schema` (`QUERYSTRING_PARAMETER_WITHOUT_CONTENT`). These are errors in every version, because the generator reads the location in every version;
- `additionalOperations` must be an object (`ADDITIONAL_OPERATIONS_NOT_OBJECT`), each key must be an HTTP method token (`INVALID_METHOD_TOKEN`), and no key may be the upper-case name of a method that has its own field, such as `GET` or `QUERY` (`DUPLICATE_FIXED_METHOD`).

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
| Parameter `in: querystring` | Not yet (planned) | Whatever version the document declares, the operation makes no tool and `UNSUPPORTED_PARAMETER_LOCATION` is recorded. In a 3.2 document it validates (see the rules above); in 3.0 or 3.1 it also gets a `FEATURE_NEWER_THAN_DECLARED_VERSION` warning. `generateTool()` for that operation throws a `GenerationError` |
| Media Type `itemSchema` (streams such as `text/event-stream`) | Not yet (planned) | Ignored, with no diagnostic. A response whose media type declares only `itemSchema` contributes nothing to `outputSchema` |
| `$self` | Not yet (planned) | Ignored, with no diagnostic. It does not change how `$ref`s or servers resolve |
| Security scheme named by URI in a Security Requirement | Not yet (planned) | The scheme is not resolved, so its Security Requirement object cannot be satisfied: that object is dropped (with every scheme it names) and `UNRESOLVED_SECURITY_SCHEME` is recorded. If every requirement of an operation is dropped, the operation makes no tool (`UNSATISFIABLE_SECURITY`); see [Security](./security.md) |
| `style: cookie` on a cookie parameter | Not yet (planned) | The style is carried on the mapper entry, but `buildHttpRequest` does not serialize it as 3.2 describes. A primitive is sent as `name=value`, an array is joined with commas, and an object value throws a `RequestBuildError` |
| Response `summary` (and the now-optional `description`) | Not yet (planned) | `summary` is not read. A response with no `description` produces an output schema with no description |
| Example `dataValue` and `serializedValue` | Not yet (planned) | Not read. With `includeExamples`, an example that has only `dataValue` is left out; `value` is used when present |
| Server `name` | Not yet (planned) | Not copied. `metadata.servers[]` carries `url`, `description` and `variables` |
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

1. **On load**: the declared version.
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
| `FEATURE_NEWER_THAN_DECLARED_VERSION` | A `query` operation or `additionalOperations` in a document declaring 3.0 or 3.1: it is not read, so it makes no tool. Also, when validating, an `in: querystring` parameter in such a document (the operation is skipped either way, see `UNSUPPORTED_PARAMETER_LOCATION`) | Validation, generation |
| `PATH_ITEM_NOT_OBJECT` | A path item is not an object (`"/pets": null`); it holds no operations | Validation, generation |
| `OPERATION_NOT_OBJECT` | A method field, or an `additionalOperations` value, is not an object; it is ignored | Generation (validation: error) |
| `ADDITIONAL_OPERATIONS_NOT_OBJECT` | `additionalOperations` is not an object; it is ignored | Generation (validation: error) |
| `INVALID_METHOD_TOKEN` | An `additionalOperations` key is not an HTTP method token (it has a space, is empty, ...); the operation is ignored | Generation (validation: error) |
| `DUPLICATE_FIXED_METHOD` | An `additionalOperations` key is the upper-case name of a method that has its own field (`GET`, `QUERY`); the operation is ignored and only the field is read | Generation (validation: error) |
| `METHOD_CASE_VARIANT` | An `additionalOperations` key is another case of a method that has its own field (`post`, `Get`); allowed by the specification, but the library sends such a method upper-cased, so the key is ignored | Validation, generation |
| `REFUSED_METHOD` | An `additionalOperations` key is `CONNECT` (any case), which opens a tunnel instead of sending a request; the operation is ignored | Validation, generation |
| `UNRESOLVED_SECURITY_SCHEME` | A Security Requirement object names a scheme that `components.securitySchemes` does not define (a scheme named by URI included). One diagnostic per missing scheme; the whole object is dropped | Generation |
| `INVALID_SECURITY_REQUIREMENT` | A Security Requirement is not an object; it is dropped | Generation |
| `UNSATISFIABLE_SECURITY` | Every Security Requirement of an operation was dropped, so no way to authenticate is known; the operation makes no tool | Generation |
| `UNSUPPORTED_PARAMETER_LOCATION` | A parameter has an `in` the generator does not map to a request (`querystring` today, or a Swagger `body`); the operation makes no tool | Generation |
| `DIAGNOSTICS_TRUNCATED` | The list reached `MAX_DIAGNOSTICS`; later findings were not recorded | Last entry |

"Validation: error" means the validator rejects the document for that finding (see [What validation checks per version](#what-validation-checks-per-version)); the diagnostic exists when generation runs with `validate: false`. When validating, the codes marked "Validation, generation" are warnings and reach `getDiagnostics()`; with `validate: false`, generation records them itself.

### Limits and escaping

A document is untrusted input, and a diagnostic quotes it, so each list and each quotation is bounded:

- **`MAX_DIAGNOSTICS` (1,000).** `getDiagnostics()` keeps the first 1,000 distinct findings, then ends with one `DIAGNOSTICS_TRUNCATED` entry (no `path`); findings after the limit are not recorded. A `ValidationResult` caps `errors` and `warnings` the same way, each ending with its own `DIAGNOSTICS_TRUNCATED` entry; `valid` still reflects every error. A repeated finding (the validator and the generator both reporting one) counts once.
- **Quoted document text.** A string from the document is cut (64 characters in most messages; a path key or method in a validation message, 1,024 and 64) and shown as JSON, with control characters, line and paragraph separators and bidirectional formatting characters written as `\uXXXX`, so no newline or terminal escape sequence reaches a log. The `ParseError` message for a failed validation quotes the first error at most 512 characters, escaped; `context.errors` keeps each error as the validator produced it.
- **JSON Pointers.** `path` is built with each segment escaped as RFC 6901 says (`~` is `~0`, `/` is `~1`). A segment is also made safe to display: unsafe characters become `\uXXXX` and a segment over 256 characters is cut and ends with `...(truncated)`. A pointer holding a cut or `\u`-escaped segment is for display: it does not resolve to the value. An ordinary key gives a pointer that resolves.
- **Legacy paths.** The validator codes that predate OpenAPI 3.2 support (`INVALID_PATH_FORMAT`, `NO_OPERATIONS`, `NO_OPERATION_ID`, `NO_RESPONSES`, `MISSING_PATH_PARAMETER`, `MISSING_PARAMETER_NAME`, `MISSING_PARAMETER_IN`, `INVALID_PARAMETER_IN`, `PATH_PARAMETER_NOT_REQUIRED`, `MISSING_PARAMETER_SCHEMA`) keep their historical `path`: the path key unescaped, cut past 1,024 characters (`LEGACY_PATH_KEY_MAX_LENGTH`) with `...` (`/paths//pets/get/operationId`), so code that matches on them keeps working. Every newer code, and every diagnostic the generator adds, uses a JSON Pointer (`/paths/~1pets/get`).

## Known gaps

What the library does not do yet. These exist today and apply as stated; each is planned unless noted.

**OpenAPI 3.2 and Swagger 2.0**

- Swagger 2.0 is rejected (see above).
- The 3.2 features marked "Not yet (planned)" in the table above.
- The new security scheme fields (`oauth2MetadataUrl`, `deprecated`, the `deviceAuthorization` flow) are typed but not surfaced in `metadata.security`.
- Tag `parent` is not used by `includeTags` / `excludeTags`: filtering by a parent tag does not include operations tagged with its children.

**Every version**

- A boolean `false` subschema becomes `{}`, which accepts everything. (`true` also becomes `{}`, which is correct.)
- Response keys such as `2XX` and `4XX` are read as the status codes `2` and `4`, so `metadata.responseStatusCodes` holds `[2, 4]` for them.
- A preferred media type that has no schema hides a sibling media type that does: `application/json: {}` next to a `text/plain` schema produces no output schema.
- Path-level `servers` are ignored. Operation-level and document-level `servers` are used.
- A `$ref` with sibling keywords (`$ref` plus `description`) keeps only the target when the library dereferences internal references itself; external references keep the siblings.
- The multipart Encoding Object is carried on the mapper (`serialization.encoding`), but `buildHttpRequest` does not apply it: a part declared `contentType: application/json` is sent as a plain string field.
- Alternative security requirements (`security: [{ a: [] }, { b: [] }]`) are flattened: every scheme of every requirement object that can be satisfied becomes a requirement of the tool, rather than a choice between them.
- A parameter defined with `content` instead of `schema` becomes a string input, and its value is not serialized by the media type.
- An operation-level parameter does not override a path-level one with the same name and location: both are kept, the input key is renamed (`queryLimit`), and the value is sent twice.
- A relative external `$ref` resolves against the process working directory, not against the location of the document that contains it.

---

**Related:** [API Reference](./api-reference.md) | [Configuration](./configuration.md) | [Error Handling](./error-handling.md) | [Architecture](./architecture.md)
