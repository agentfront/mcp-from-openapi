# OpenAPI Versions

[Home](../README.md) | [Getting Started](./getting-started.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)

---

The library reads Swagger 2.0 and OpenAPI 3.0, 3.1 and 3.2 documents. This page is the support matrix: what happens for each declared version, how a Swagger 2.0 document becomes tools, which OpenAPI 3.2 features work today, how the library reports what it could not process, and the gaps that remain.

Three rules explain most of the behaviour:

- **Validation follows the declared version.** The validator applies the rules of the declared `major.minor`. The patch number (and any `-suffix`, as in `3.2.0-rc1`) never changes behaviour: the specification tells tooling to ignore it.
- **Which operations are read follows the declared version too; everything else follows features.** The `query` operation and `additionalOperations` are read only when the document declares OpenAPI 3.2 or newer. Every other construct the library understands (parameter locations, bodies, security, schemas) is processed whatever version the document declares, because real specs are often mislabelled. The one function that decides which operations a document has is `resolveOperationLayout(detectSpecVersion(document))`; the generator, the validator, lint and Arazzo all use it.
- **Swagger 2.0 is converted, not read separately.** A 2.0 document is validated as written with the 2.0 rules, then converted to OpenAPI 3.0 (`upgradeSwagger2`), and the tools are generated from the conversion. There is one generator, so schemas, parameters, security and request building behave for a 2.0 document exactly as for one written in 3.0. See [Swagger 2.0](#swagger-20).

## Declared versions

The version is read from the `openapi` field (or `swagger`, for Swagger 2.0). `generator.getSpecVersion()` and the standalone `detectSpecVersion(document)` report it. `status` is the value in the second column; `family` (`'2.0'`, `'3.0'`, `'3.1'` or `'3.2'`) is the set of rules the document is processed with, and is absent when the document cannot be processed.

| Declared version | `status` | Validation (`validate: true`, the default) | Operations read | With `validate: false` |
| --- | --- | --- | --- | --- |
| `swagger: "2.0"` (the unquoted YAML `2.0`, the number `2`, is read the same) | `supported`, `field: 'swagger'`, `family: '2.0'` | The 2.0 rules (see [Swagger 2.0](#swagger-20)) | The seven 2.0 methods: `get`, `post`, `put`, `patch`, `delete`, `head`, `options` | Converted to OpenAPI 3.0 and generated; needs `dereference: true` |
| `3.0.x` | `supported` | The 3.0 rules | The eight classic methods | Generates |
| `3.1.x` | `supported` | The 3.1 rules | The eight classic methods | Generates |
| `3.2.x` | `supported` | The 3.2 rules | The eight, `query` and `additionalOperations` | Generates |
| `3.N.x` newer than 3.2 (`3.3.0`, `3.10.1`) | `newer-minor` | Valid, checked with the 3.2 rules, plus a `NEWER_OPENAPI_VERSION` warning | As 3.2 | Generates; the warning is in `getDiagnostics()` |
| Another major or minor of Swagger (`swagger: "1.2"`, `"2.1"`) or OpenAPI (`1.0.0`, `2.0.0`, `4.0.0`) | `unsupported` | Rejected with `INVALID_OPENAPI_VERSION` | The eight classic methods | Generates as if it were OpenAPI 3; the error is in `getDiagnostics()` as a warning |
| Not a version string (`3.1`, `banana`, a number, `null`) | `malformed` | Rejected with `INVALID_OPENAPI_VERSION` | The eight classic methods | As above |
| No `openapi` or `swagger` field | `missing` | Rejected with `MISSING_OPENAPI_VERSION` | The eight classic methods | As above |

The eight classic methods are `get`, `post`, `put`, `patch`, `delete`, `head`, `options` and `trace`. A document whose version cannot be processed is only reachable with `validate: false` (validation rejects it otherwise), and it is read exactly as the library read every document before OpenAPI 3.2 support.

A rejection throws a `ParseError` whose message names the first error and whose `context.errors` lists them all:

```typescript
import { OpenAPIToolGenerator, ParseError } from "mcp-from-openapi";

const generator = await OpenAPIToolGenerator.fromJSON({
  swagger: "1.2",
  info: { title: "Pets", version: "1" },
  paths: {},
});

generator.getSpecVersion().status; // 'unsupported'

try {
  await generator.generateTools();
} catch (error) {
  if (error instanceof ParseError) {
    error.message;
    // 'Invalid OpenAPI document: Unsupported version: Swagger "1.2".
    //  Expected Swagger 2.0 or OpenAPI 3.0.x, 3.1.x or 3.2.x (a later 3.x is read with the 3.2 rules)'
    error.context?.errors[0].code; // 'INVALID_OPENAPI_VERSION'
    error.context?.errors[0].path; // '/swagger'
  }
}
```

The factories never validate; the first `generateTools()` or `generateTool()` call does, so loading such a document succeeds and generating from it throws.

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

On a document that does declare 3.2 or newer, the second point does not hold: `additionalOperations` accepts any HTTP method token, so a new method can be added to the document at any time. **`excludeMethods` is a denylist and cannot cover methods you have not seen.** For a 3.2 document you do not control, prefer `includeMethods` (an allowlist) or `readOnlyOnly: true` (which keeps only operations whose method is safe; an additional method never is), and review `getDiagnostics()` and the tool list when the document changes. See [Configuration](./configuration.md#filtering-operations).

An `in: querystring` parameter is different: it is read in every version, like the other parameter locations. It becomes a whole-query input (see [Whole-query parameters](#whole-query-parameters-in-querystring)), and the operation makes a tool whatever version the document declares. For a document declaring 3.0 or 3.1 the validator adds a `FEATURE_NEWER_THAN_DECLARED_VERSION` warning.

### YAML and quoting

YAML reads an unquoted `openapi: 3.1` as the number `3.1`, which is `malformed`: a version has three parts, so write `openapi: 3.1.0`. An unquoted `swagger: 2.0` is the number `2`, and is recognised as Swagger 2.0.

A document with both `openapi` and `swagger` is read by its `openapi` field; `swagger` is ignored and a `CONFLICTING_VERSION_FIELDS` warning is recorded.

## Swagger 2.0

Swagger 2.0 (the OpenAPI Specification 2.0, declared with `swagger: "2.0"`) is read by converting the document to OpenAPI 3.0 and generating the tools from the result. The pipeline, in order:

1. Overlays apply to the 2.0 document as written.
2. `$ref`s are resolved: local ones, and references to other files or URLs under the same `refResolution` rules as for any version. This is why a 2.0 document needs `dereference: true` (the default).
3. The dereferenced document is validated with the 2.0 rules (skipped with `validate: false`).
4. `upgradeSwagger2` converts it to OpenAPI 3.0.3, once, at the first `generateTools()`, `generateTool()` or `lint()`.
5. Tools are generated from the conversion.

What the conversion could not carry over exactly is recorded in `getDiagnostics()` with the `SWAGGER_*` codes (see [Diagnostics](#diagnostics)). Split documents work: a parameter, response or definition in another file is inline by the time it is converted, and is converted in the context of each operation that uses it.

```typescript
import { OpenAPIToolGenerator } from "mcp-from-openapi";

const generator = await OpenAPIToolGenerator.fromJSON({
  swagger: "2.0",
  info: { title: "Pets", version: "1" },
  host: "api.example.com",
  basePath: "/v2",
  schemes: ["https"],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        parameters: [{ $ref: "#/parameters/Limit" }],
        responses: { 200: { description: "Pets", schema: { type: "array", items: { $ref: "#/definitions/Pet" } } } },
      },
    },
  },
  parameters: { Limit: { name: "limit", in: "query", type: "integer" } },
  definitions: { Pet: { type: "object", properties: { name: { type: "string", "x-nullable": true } } } },
});

generator.getSpecVersion();
// { status: 'supported', field: 'swagger', declared: '2.0', major: 2, minor: 0, family: '2.0', diagnostics: [] }
generator.getDocument().swagger; // '2.0': the document as loaded, its $refs still in place

const [tool] = await generator.generateTools();
generator.getDocument().openapi; // '3.0.3': the conversion the tool was generated from
generator.getDocument().servers; // [{ url: 'https://api.example.com/v2' }]
generator.getDocument().paths["/pets"].get.parameters; // [{ name: 'limit', in: 'query', schema: { type: 'integer' } }]
generator.getSpecVersion().family; // '2.0': the declared version never changes
tool.outputSchema.items.properties.name; // { type: ['string', 'null'] }
```

### The three states of `getDocument()`

`getDocument()` returns the generator's own document, and a Swagger 2.0 document has three states:

1. **As loaded** (after overlays): `swagger: "2.0"`, `$ref`s in place.
2. **Dereferenced, still 2.0**: after `validate()` on a document that references other documents (a `$ref` that does not start with `#`). A document with only `#` references is not dereferenced by `validate()`, so it stays in state 1.
3. **Converted**: after the first `generateTools()`, `generateTool()` or `lint()`, the OpenAPI 3.0.3 document the tools are generated from.

`getSpecVersion()` reports the declared Swagger 2.0 in every state. `validate()` always validates the 2.0 document, never the conversion, so its paths point into the document you wrote.

### `dereference: false` is refused

The converter reads a dereferenced document, so a 2.0 document loaded with `dereference: false` cannot be read. Every method says so with the same finding, `DEREFERENCE_REQUIRED` at `/swagger`, before it looks at anything else (also with `validate: false`):

| Method | What it does |
| --- | --- |
| `generateTools()`, `generateTool()`, `lint()` | Throw a `ParseError` whose message is the finding's and whose `context.errors` is `[{ message, path: '/swagger', code: 'DEREFERENCE_REQUIRED' }]` |
| `validate()` | Does not throw: `{ valid: false, errors: [that one error] }` |
| `getSpecVersion()`, `getDiagnostics()` | Unchanged: the declared version is read as always, and `DEREFERENCE_REQUIRED` is never a `getDiagnostics()` entry |

The message is `A Swagger 2.0 document needs LoadOptions.dereference: true (the default): it is converted to OpenAPI 3.0 once its $refs are resolved. To read no other document, keep dereferencing on and set secureDefaults: true (or refResolution.allowedProtocols: [])`. Reading no other document is what `dereference: false` was usually for: with `secureDefaults: true` or `allowedProtocols: []` a reference to another document is left unresolved, the converter ignores the parameter, response or header that holds it and records `SWAGGER_UNRESOLVED_REFERENCE`, and the tool is still generated. An OpenAPI 3 document with `dereference: false` is unaffected.

### How a document is converted

| Swagger 2.0 | OpenAPI 3.0 result | Diagnostic when it is lossy |
| --- | --- | --- |
| `host`, `basePath`, `schemes` | `servers`: one `<scheme>://<host><basePath>` per `http` or `https` scheme, in any letter case (trailing slashes of `basePath` removed); `ws` and `wss` make none. An operation's own `schemes` become that operation's `servers` when they differ from the root's. See [Servers](#servers-host-basepath-and-schemes) | `SWAGGER_ASSUMED_SCHEME`, `SWAGGER_RELATIVE_SERVER_URL`, `SWAGGER_NOT_CONVERTED` (a `ws` or `wss` scheme); a value that is not a host, a usable path or a scheme list is ignored with `SWAGGER_INVALID_VALUE` |
| `consumes`, `produces` | The media type keys of `requestBody.content` and of each response's `content`. An operation's list replaces the root's; an empty list, or none at all, gives `application/json`. At most 32 distinct media types are kept from one list (see [Limits](#limits)) | `SWAGGER_ASSUMED_MEDIA_TYPE` (`info`, once for requests and once for responses), `SWAGGER_MEDIA_TYPE_LIMIT` |
| `in: body` | `requestBody`: `content[<media type>].schema` for every `consumes` media type, with the parameter's `description`, `required` and `x-` fields. The parameter's `name` is dropped | `SWAGGER_MULTIPLE_BODY_PARAMETERS`: of several, the last of the operation's is the body (the path item's, when the operation has none) |
| `in: formData` | `requestBody` with an object schema (a property per parameter, `required` listing the required ones, `requestBody.required: true` when any is). `multipart/form-data` when a parameter is `type: file`, else `application/x-www-form-urlencoded`; the form media types of a declared `consumes` are used instead when it names any. **A form with a file field is sent only as multipart**: the urlencoded type is left out, whatever `consumes` says, because a file cannot be a urlencoded value. An array field gets an `encoding` entry from its `collectionFormat` (`style` and `explode`), in a urlencoded body and in a multipart one | `SWAGGER_FORM_MEDIA_TYPE_ADDED` (a `consumes` list names no form type, or a form with a file names only urlencoded: the form type is added, multipart for a file), `SWAGGER_BODY_AND_FORM_DATA` (next to a body parameter the body wins and the form parameters are ignored), `SWAGGER_DUPLICATE_FORM_DATA_PARAMETER` (the last wins), `SWAGGER_NOT_CONVERTED` (`allowEmptyValue` has no place in a body property and is dropped), `SWAGGER_INVALID_VALUE` (a form parameter without a usable `name` is dropped) |
| `type: file` | `type: string`, `format: binary`; the mapper entry of a multipart part has `serialization.binary: true` | `SWAGGER_NOT_CONVERTED` when another `format` is replaced; `SWAGGER_FILE_OUTSIDE_FORM_DATA` for a file anywhere but a form parameter or a response schema (converted all the same) |
| `collectionFormat` of an array | In a query: `csv` is `style: form`, `explode: false`; `ssv` is `spaceDelimited`; `pipes` is `pipeDelimited`; `multi` is `form` with `explode: true`. In a path or header: `csv` is `style: simple`. Always written out, `csv` being the 2.0 default | `SWAGGER_UNSUPPORTED_COLLECTION_FORMAT`: `tsv`, and `ssv`, `pipes` or `multi` where 3.0 has no such style, become comma-separated values (`form`/`explode: false` in a query or a form field, `simple` in a path or header); the format of a nested array is ignored. A form field (`in: formData`) has its own row above: `multi` is exploded `form`, `csv` and an omitted format `form` with `explode: false`, `ssv` and `pipes` their delimited styles, in a urlencoded and a multipart body alike |
| Non-body `type`, `format`, `items`, `default`, `enum`, bounds, `pattern`, ... | The parameter's `schema` (an Items Object becomes a schema); `description`, `required`, `allowEmptyValue` and `x-` fields stay on the parameter | |
| `in: path` | Always `required: true`: OpenAPI 3.0 requires it, and the 2.0 schema does too, so a document that omits it or says `false` is a validation error (`PATH_PARAMETER_NOT_REQUIRED`); with `validate: false` the conversion reads the parameter as required | `SWAGGER_INVALID_VALUE` (`A path parameter must be required`) |
| Parameter `example` or `x-example` | The parameter's `example` (`example` wins when a parameter has both); `includeExamples` then puts it in the input schema's `examples` as for any parameter | |
| Response `schema`, `examples`, `headers` | `content[<media type>].schema` for every `produces` media type; `examples` by media type as `example`; each header as a Header Object with a `schema` | `SWAGGER_NOT_CONVERTED` for an example that names a media type the operation does not produce |
| `definitions`, `parameters`, `responses`, `securityDefinitions` | `components.schemas`, `components.parameters` (a body parameter goes to `components.requestBodies`), `components.responses` (`produces` of the root), `components.securitySchemes` (present whenever the document has `securityDefinitions`, `{}` when none converted); `#/definitions/X` becomes `#/components/schemas/X` | An `in: formData` global parameter has no component (`info` `SWAGGER_NOT_CONVERTED`); operations that use it carry it in their request body |
| `basic`, `apiKey`, `oauth2` | `http` with `scheme: basic`; `apiKey` with its `name` and `in`; `oauth2` with one flow holding the URLs it uses and its `scopes`. Flow names: `implicit`, `password`, `application` becomes `clientCredentials`, `accessCode` becomes `authorizationCode`. A missing `scopes` (the official 2.0 schema allows it, 3.0 requires the map) becomes `{}` | `SWAGGER_UNSUPPORTED_SECURITY_SCHEME` for an unknown `type` or `flow` (the scheme is not converted, and an operation that requires it is skipped, see [Security](./security.md#requirements-that-name-an-undefined-scheme)); `SWAGGER_NOT_CONVERTED` for fields that do not apply to the type |
| Schema Object: string `discriminator`, `x-nullable`, a `type` list, a tuple `items`, `additionalItems`, `type: file` | `discriminator: { propertyName }`, `nullable`, one `type` (several types become `anyOf`, `"null"` becomes `nullable: true`), `items: {}`, no `additionalItems`, a binary string | `SWAGGER_NOT_CONVERTED` for a tuple `items`, for `additionalItems` (dropped: OpenAPI 3.0 has no such keyword. Draft-04 reads it only beside a tuple `items`, and the tuple is replaced by `items: {}`, so the converted schema accepts any items: with `items: [{ type: 'string' }]` and `additionalItems: false`, `['a', 1]` was invalid and is valid after the conversion. Without a tuple the keyword constrained nothing) and for a `type` that names nothing but `null` (dropped) |
| `trace`, `query`, `additionalOperations` in a Path Item | Not converted: Swagger 2.0 has none of them, so they make no tool | `FEATURE_NEWER_THAN_DECLARED_VERSION` (a warning, also from the validator) |
| `info`, `tags`, `externalDocs`, `security`, every `x-` extension | Carried over unchanged | A field Swagger 2.0 does not define in that object is not converted: `SWAGGER_UNKNOWN_FIELD` (`info`) |

The conversion also accepts a few things the official schema forbids, rather than refusing them: a value of the wrong kind is reported (`SWAGGER_INVALID_VALUE`) and skipped or replaced as the message says, and a `$ref` left in the document (only possible when references were not read) is `SWAGGER_UNRESOLVED_REFERENCE` and the object holding it is ignored. A diagnostic about an object that several operations share (a global parameter, response or definition) is reported once, where it was first found.

The Schema Object row also holds without the conversion: `x-nullable`, `type: file` and a string `discriminator` are read by `toJsonSchema` in every version (see [Swagger constructs in any document](#swagger-constructs-in-any-document)), so a 3.x document that carries them is read the same way.

### Limits

A 2.0 document states `consumes`, `produces` and path-level parameters once, and they apply to every operation that does not override them; the OpenAPI 3.0 form spells each one out in every request body and response. A few hundred KB of 2.0 text, with a root `consumes` list of thousands of media types and thousands of operations, could therefore be converted into gigabytes. Two limits keep the conversion bounded:

| Limit | Value | What happens past it |
| --- | --- | --- |
| Distinct media types kept from one `consumes` or `produces` list (`MAX_MEDIA_TYPES_PER_LIST`) | 32 | The first 32, in order and without duplicates, are kept and the rest ignored: one `SWAGGER_MEDIA_TYPE_LIMIT` warning for the document says how many lists were cut and how many media types were dropped |
| Entries the conversion creates in the maps it builds (`MAX_CONVERSION_ENTRIES`): media types of request bodies and responses, form `encoding` entries, response headers and form body properties | 1,000,000 | The conversion is abandoned. `generateTools()`, `generateTool()` and `lint()` throw a `ParseError` whose `context` is `{ code: 'SWAGGER_CONVERSION_TOO_LARGE', maxEntries: 1000000 }` (the same error on every later call), and `getDiagnostics()` has the `SWAGGER_CONVERSION_TOO_LARGE` warning. The standalone `lintDocument` does not throw: it returns one `swagger-conversion-too-large` error finding with `path` `''`. `upgradeSwagger2` returns `tooLarge: true` and a document with no paths |

```typescript
const media = Array.from({ length: 40 }, (_, index) => `application/vnd.example.v${index}+json`);
const generator = await OpenAPIToolGenerator.fromJSON({
  swagger: "2.0",
  info: { title: "Media", version: "1" },
  host: "api.example.com",
  schemes: ["https"],
  consumes: media,
  paths: {
    "/x": {
      post: {
        operationId: "x",
        parameters: [{ name: "body", in: "body", schema: { type: "object" } }],
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
await generator.generateTools();
Object.keys(generator.getDocument().paths["/x"].post.requestBody.content).length; // 32
generator.getDiagnostics().map((d) => `${d.code} ${d.path}`); // ['SWAGGER_MEDIA_TYPE_LIMIT /consumes']
```

`upgradeSwagger2(document, { maxEntries })` takes a smaller budget (never a larger one than `MAX_CONVERSION_ENTRIES`), for a caller that wants its own bound.

### Servers: `host`, `basePath` and `schemes`

A 2.0 document with no `host` describes an API on the host that serves the document, and one with no `schemes` uses the scheme it was retrieved with. The library knows neither unless it knows where the document was retrieved from: the final URL of `fromURL` (after redirects), or `LoadOptions.documentUri`. An `http` or `https` URI supplies the host (with its port) and the scheme; its user information is never used. Any other URI (a `file:` URL, which is what `fromFile` records) supplies nothing.

| Document | `metadata.servers` | Diagnostic |
| --- | --- | --- |
| `host` and `schemes` | One URL per `http` or `https` scheme, in the order written (`HTTPS` is `https`; a scheme listed twice is one server) | |
| `host`, no `schemes`, or `schemes` that holds only `ws` and `wss` | The scheme of the retrieval URI when it is a web one | `SWAGGER_ASSUMED_SCHEME` and `https`, when there is none; `SWAGGER_NOT_CONVERTED` for each `ws` or `wss` in `schemes` |
| No `host`, retrieved from a web URI (`fromURL`, or `documentUri`) | That URI's host and port, with `schemes` or else its scheme | None from the converter. The validator's `NO_SERVERS` warning, which does not know the retrieval URI, is still recorded |
| No `host`, no web retrieval URI (`fromJSON` or `fromYAML` without `documentUri`, `fromFile`) | The relative URL `<basePath>`, or `/`; `schemes` cannot apply and is ignored (`SWAGGER_NOT_CONVERTED` says so for an operation's own `schemes`, once) | `SWAGGER_RELATIVE_SERVER_URL` |

`ws` and `wss` are valid `schemes` in Swagger 2.0 (for WebSocket endpoints), but an HTTP operation is never sent over them, so they make no server (`SWAGGER_NOT_CONVERTED`: `schemes` lists "wss" (WebSocket), which an HTTP operation is never sent over; no server is made for it). A `schemes` entry that is none of `http`, `https`, `ws` and `wss` is ignored with `SWAGGER_INVALID_VALUE`.

**`basePath`** must start with `/` (the 2.0 schema says so) and be a path a server URL can carry unchanged, so that every tool URL means what the document says. It is unusable when it is not a string, holds `{` or `}` (OpenAPI 3 reads them as a server variable), whitespace or a control character, `?` or `#` (a query or a fragment), a backslash, or a `.` or `..` segment (written as is or percent-encoded), which URL parsers remove:

| `basePath` | Validation (`validate: true`, the default) | With `validate: false` |
| --- | --- | --- |
| `/v2` or `/v2/` | Valid; the trailing slashes are removed (`https://api.example.com/v2`) | Same |
| `v2` (no leading `/`) | `ParseError`: `INVALID_BASE_PATH` at `/basePath`: `basePath must start with "/", found "v2"` | `/` is prepended (`https://api.example.com/v2`), with a `SWAGGER_INVALID_VALUE` warning |
| `/a b`, `/a?x`, `/{v}`, `/a/../b`, or not a string (`5`) | `ParseError`: `INVALID_BASE_PATH` at `/basePath` with the reason | The `basePath` is dropped (the server is `https://api.example.com`), with a `SWAGGER_INVALID_VALUE` warning |

A relative server URL is not usable on its own: `buildHttpRequest` refuses it (`Base URL must be http(s) or empty; received '/v2'`) until you give it a `baseUrl` (which replaces the whole server URL, `basePath` included) or load the document with `documentUri`. `LoadOptions.baseUrl` replaces the server URLs as for any document, but the diagnostics stay.

```typescript
import { OpenAPIToolGenerator, buildHttpRequest } from "mcp-from-openapi";

const spec = {
  swagger: "2.0",
  info: { title: "Pets", version: "1" },
  basePath: "/v2",
  paths: { "/pets": { get: { operationId: "listPets", responses: { 200: { description: "Pets" } } } } },
};

const relative = await OpenAPIToolGenerator.fromJSON(spec);
const [tool] = await relative.generateTools();
tool.metadata.servers; // [{ url: '/v2' }]
relative.getDiagnostics().map((d) => d.code); // ['NO_SERVERS', 'SWAGGER_RELATIVE_SERVER_URL']
buildHttpRequest(tool, {}, { baseUrl: "https://api.example.com/v2" }).url; // 'https://api.example.com/v2/pets'

const located = await OpenAPIToolGenerator.fromJSON(spec, { documentUri: "https://api.example.com/swagger.json" });
(await located.generateTools())[0].metadata.servers; // [{ url: 'https://api.example.com/v2' }]
located.getDiagnostics().map((d) => d.code); // ['NO_SERVERS']
```

### What validation checks

`validate()` and the first generation check a 2.0 document with the rules of the 2.0 text and its official JSON Schema. The checks that differ from OpenAPI 3:

- **Version.** `swagger` must be `"2.0"` (the number `2` of an unquoted YAML `2.0` is accepted). Another value is `INVALID_OPENAPI_VERSION` at `/swagger`.
- **Operations.** The seven 2.0 methods. `trace`, `query` and `additionalOperations` in a Path Item are not read and each gets one `FEATURE_NEWER_THAN_DECLARED_VERSION` warning.
- **`responses`** is required and may not be empty (`NO_RESPONSES`). A response without a `description` is not rejected.
- **Parameter locations** are `path`, `query`, `header`, `formData` and `body` (`INVALID_PARAMETER_IN` for any other: `cookie` and `querystring` do not exist in 2.0).
- **A body parameter needs `schema`, every other parameter needs `type`** (`MISSING_PARAMETER_SCHEMA`). A `schema` on a non-body parameter is the same error.
- **Body rules the official schema cannot express**, checked per operation across its own and its path item's parameters: at most one `in: body` parameter (`SWAGGER_MULTIPLE_BODY_PARAMETERS`) and none next to an `in: formData` one (`SWAGGER_BODY_AND_FORM_DATA`). They are errors here; with `validate: false` the converter reports the same codes as warnings and uses the body parameter.
- **`basePath`** must start with `/` and be usable in a URL (`INVALID_BASE_PATH` at `/basePath`; see [Servers](#servers-host-basepath-and-schemes)).
- **Path parameters** must be `required: true` (`PATH_PARAMETER_NOT_REQUIRED`), as in the official schema. The conversion makes every `in: path` parameter required whatever it says (`validate: false` gets a `SWAGGER_INVALID_VALUE` warning for one that did not).
- **Local parameter references** are `#/parameters/<name>`.
- **Warnings.** `NO_SERVERS` at `/host` when there is no `host`, and `NO_SECURITY_SCHEMES` when `security` is declared without `securityDefinitions`.

A parameter `name` that is a number or a boolean is read as its text with a `PARAMETER_NAME_NOT_STRING` warning, and one that is an array or an object is `INVALID_PARAMETER_NAME`, in every version. The rules shared with OpenAPI 3 (path parameters must be defined, `info.title` and `info.version`, paths start with `/`) are unchanged. See [What validation checks per version](#what-validation-checks-per-version).

### Which diagnostic points where

A Swagger 2.0 document is read twice, so a diagnostic's `path` would be ambiguous. Every entry of `getDiagnostics()` that has a `path` therefore carries `document` (`SpecDiagnostic.document`; absent for every other document, and on an entry without a `path`):

- **`'source'`**: `path` points into the 2.0 document as you wrote it (`generator.getDocument()` before generation, or the file). This is every validator warning, every converter finding (`SWAGGER_*`) and every finding generation records about a construct that exists in the 2.0 document, parameters included: the generator names a parameter by its index in the 2.0 `parameters` list (`/paths/~1pets/post/parameters/1`), not by the index it has in the conversion, where `in: body` and `in: formData` parameters no longer sit in `parameters`. A message may still say `components.securitySchemes` where the 2.0 document says `securityDefinitions`.
- **`'converted'`**: `path` points into the OpenAPI 3.0 conversion (`getDocument()` once generation has run), for a construct only the conversion has, such as a request body. No finding of the library points there today; the value exists so that one can without a reader having to guess.

A finding is therefore reported once. A repeated parameter that sits next to a body parameter is one `DUPLICATE_PARAMETER`, at its 2.0 index, from whichever stage found it first. A finding about a body conflict (`SWAGGER_MULTIPLE_BODY_PARAMETERS`, `SWAGGER_BODY_AND_FORM_DATA`) points at the operation's `parameters` (`/paths/~1pets/post/parameters`), where the competing parameters are.

The converter groups what it finds: a kind of finding that occurs in several places is one diagnostic at the first place, and its message ends with `(in N places: <first three> and N more)`:

```typescript
// three operations with a `collectionFormat: tsv` array in a query
generator.getDiagnostics().map((d) => [d.code, d.path, d.document]);
// [['SWAGGER_UNSUPPORTED_COLLECTION_FORMAT', '/paths/~1a/get/parameters/0/collectionFormat', 'source']]
generator.getDiagnostics()[0].message;
// '`collectionFormat: tsv` has no OpenAPI 3.0 equivalent for an `in: query` parameter; the array is sent as
//  comma-separated values (`style: form`, `explode: false`) (in 3 places: /paths/~1a/get/parameters/0/collectionFormat,
//  /paths/~1a/get/parameters/1/collectionFormat, /paths/~1b/get/parameters/0/collectionFormat)'
```

### Lint

`generator.lint()` converts the document first and lints the OpenAPI 3.0 form, so its findings are those of the tools the document generates, labelled with the same method and path. It throws the `ParseError` of [`dereference: false`](#dereference-false-is-refused) for a document loaded that way. The standalone `lintDocument(document)` converts a 2.0 document the same way (its conversion diagnostics are not reported); pass it a dereferenced document, as `generator.lint()` does, because a `$ref` left in it is not followed. When the conversion is abandoned at `MAX_CONVERSION_ENTRIES` (see [Limits](#limits)) there is no operation to lint, and `lintDocument` never throws and never reports a clean document: it returns ONE finding, severity `error`, code `swagger-conversion-too-large`, `path` `''` (it names the whole document, not an operation), with `counts` `{ error: 1, warning: 0, info: 0 }`. `generator.lint()` throws the `ParseError` that generation throws (`context.code` `SWAGGER_CONVERSION_TOO_LARGE`) instead.

### The converter on its own

`upgradeSwagger2(document, options?)` is the conversion the generator applies, exported for callers who want the OpenAPI 3.0 document itself. It takes a **dereferenced** document and returns `{ document, diagnostics, parameterIndexes }` (and `tooLarge: true` when it gave up, see [Limits](#limits)).

```typescript
import { upgradeSwagger2 } from "mcp-from-openapi";

const { document, diagnostics } = upgradeSwagger2(
  {
    swagger: "2.0",
    info: { title: "Uploads", version: "1" },
    basePath: "/v1",
    paths: {
      "/files": {
        post: {
          operationId: "upload",
          consumes: ["multipart/form-data"],
          parameters: [
            { name: "file", in: "formData", type: "file", required: true },
            { name: "tags", in: "formData", type: "array", items: { type: "string" }, collectionFormat: "tsv" },
          ],
          responses: { 201: { description: "Stored" } },
        },
      },
    },
  },
  { documentUri: "https://api.example.com/swagger.json" },
);

document.openapi; // '3.0.3'
document.servers; // [{ url: 'https://api.example.com/v1' }]
document.paths["/files"].post.requestBody;
// { content: { 'multipart/form-data': {
//     schema: { type: 'object',
//       properties: { file: { type: 'string', format: 'binary' }, tags: { type: 'array', items: { type: 'string' } } },
//       required: ['file'] },
//     encoding: { tags: { style: 'form', explode: false } } } },
//   required: true }
diagnostics.map((d) => `${d.severity} ${d.code} ${d.path}`);
// ['warning SWAGGER_UNSUPPORTED_COLLECTION_FORMAT /paths/~1files/post/parameters/1/collectionFormat']
```

- **Options.** `documentUri` (an absolute URI) supplies the host and the scheme the 2.0 text says come from where the document was retrieved (an `http` or `https` URI both; a `ws` or `wss` one only the host; user information never). Without it, the server of the document above is the relative `/v1` (`SWAGGER_RELATIVE_SERVER_URL`). `maxEntries` lowers the budget of [Limits](#limits) (it can not raise it). `options` that is `null`, not an object, or holds a value of the wrong kind is read as absent; so do the `options` of `listOperations` and `getOperation`.
- **`parameterIndexes`.** A `WeakMap` from each `parameters` list of the converted document (a Path Item's or an Operation's) to the index each of its entries has in the source list. The indexes differ where `in: body` and `in: formData` parameters became the request body; the generator uses it so that a finding about a parameter names its place in the 2.0 document.
- **Total and pure.** It never throws for any document: a value of the wrong kind is reported and skipped. The input is never mutated; schemas, examples and `info` are shared with the result by reference, so cycles and sharing survive. A value that is not an object gives an empty OpenAPI 3.0 document and a `SWAGGER_INVALID_VALUE` warning, and one that does not declare Swagger 2.0 is converted as if it did, with `SWAGGER_VERSION_NOT_2_0` (check `detectSpecVersion(document).family === '2.0'` first). The generator never produces that code.
- **Linear.** Each source object is converted once per context it is used in, and nothing recurses, so a deep or cyclic schema converts.
- **Types.** `OAS20` holds the Swagger 2.0 object types (`OAS20.SwaggerObject`, ...); `OAS30.OpenAPIObject` is the result's type. `OAS20` is not part of the cross-version unions (`OpenAPIDocument`, ...) because a 2.0 document is never read as such. `UpgradeSwagger2Options`, `UpgradeSwagger2Result`, `MAX_MEDIA_TYPES_PER_LIST` and `MAX_CONVERSION_ENTRIES` are exported too.

### Swagger constructs in any document

Three Swagger 2.0 spellings are normalised by `toJsonSchema` whatever version the document declares, because real 3.x documents carry them and converters leave them behind:

| In a schema | Becomes |
| --- | --- |
| `x-nullable: true` or `false`, without a `nullable` keyword | Read as `nullable` (so `true` makes the type a union with `null`); the extension is dropped. A schema with `nullable` of its own is left alone |
| `type: file` (or `file` in a `type` list) | `type: string`, `format: binary`, so the property is a file part |
| `discriminator: "kind"` (a string) | `discriminator: { propertyName: "kind" }` |

The before and after for a 3.x document that carries them is in [Swagger constructs honoured in OpenAPI 3 documents](#swagger-constructs-honoured-in-openapi-3-documents).

### What is not the same as writing the API in OpenAPI 3

The same API written in Swagger 2.0 and in OpenAPI 3.0, 3.1 and 3.2 gives identical tools (the repository's lending-library test API, `e2e/fixtures/supplementary/equivalence`, is written five times, once as one file and once over twelve files, and all five generate the same ten tools). The two languages cannot say everything in the same words, and these are the differences a tool can show:

- **A body parameter's name is dropped.** OpenAPI 3 request bodies have no name. A body whose schema is an object is flattened into one input per property, as in OpenAPI 3; any other body (an array, a string) is one input called `body` (`wholeBody`), whatever the 2.0 parameter was called.
- **Media types appear only where something uses them.** An operation with no body has no `consumes`, and a response with no schema has no `produces`, in the conversion. A document that declares no list, or an empty one, gets `application/json` (`SWAGGER_ASSUMED_MEDIA_TYPE`, as an `info` note). `components.responses` and `components.requestBodies` use the root `consumes` and `produces`; operations are converted with their own lists, because references are resolved first, so a global response used by an operation that overrides `produces` is served in that operation's media types.
- **`type: file` and `format: binary` are not the same statement**: 2.0 `file` is a type only a form parameter or a response may have; the binary string can be anywhere.
- **`collectionFormat` defaults to `csv`** and the conversion writes it out; `tsv` has no 3.0 style and is sent comma-separated (`SWAGGER_UNSUPPORTED_COLLECTION_FORMAT`).
- **Form parameters are properties of a body.** Their `in` is gone, `requestBody.required` is derived (true when a form parameter is required; 2.0 cannot say a form as a whole is optional), and the only Encoding Object a conversion writes is the `style` and `explode` of an array field, from its `collectionFormat`: the `contentType` and `headers` of a multipart part have no 2.0 spelling. A global `formData` parameter has no component. A form with a file field is multipart only.
- **One 2.0 `oauth2` definition is one flow.** The scheme becomes one entry of `flows` (`application` is `clientCredentials`, `accessCode` is `authorizationCode`), and a definition with no `scopes` gets `scopes: {}`. A 3.x scheme could hold several flows; a converted one never does.
- **`servers` follow `host`, `basePath` and `schemes`**: one `basePath` for every scheme, and a relative server without a `host` and a retrieval URI (above).
- **`discriminator`** is a name in 2.0 and an object in 3.0; no `mapping` is written, because the 2.0 value (the definition's own name) is the 3.0 default.

The remaining differences are in the version members themselves (`swagger: "2.0"` against `openapi: "3.x"`) and in documents split over files, which are equal to their single-file form only once their references are resolved, as the library always does first.

## What validation checks per version

The validator ([API Reference](./api-reference.md#validator)) differs by version in these rules; the 2.0 column is explained in [What validation checks](#what-validation-checks):

| Rule | 2.0 | 3.0 | 3.1 | 3.2 |
| --- | --- | --- | --- | --- |
| An operation must have `responses` (`NO_RESPONSES`) | Required | Required | Optional | Optional |
| Parameter locations (`INVALID_PARAMETER_IN`) | `path`, `query`, `header`, `formData`, `body` | `path`, `query`, `header`, `cookie` | Same as 3.0 | Adds `querystring` |
| What describes a parameter (`MISSING_PARAMETER_SCHEMA`) | `schema` for `in: body`, `type` for the others | `schema` or `content` | Same as 3.0 | Same as 3.0; an `in: querystring` parameter needs `content` |
| One body per operation (`SWAGGER_MULTIPLE_BODY_PARAMETERS`, `SWAGGER_BODY_AND_FORM_DATA`) | At most one `in: body` parameter, none next to `in: formData` | Does not apply: `in: body` is an `INVALID_PARAMETER_IN` error | Same as 3.0 | Same as 3.0 |
| `basePath` (`INVALID_BASE_PATH`) | Starts with `/` and usable in a URL | Does not apply (`servers`) | Same as 3.0 | Same as 3.0 |

Where `responses` is present it must not be empty, in any version. A parameter `name` that is an array or an object is an `INVALID_PARAMETER_NAME` error in every version; one that is a number or a boolean is read as its text, with a `PARAMETER_NAME_NOT_STRING` warning.

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
- **Annotations.** `query` is safe and idempotent, like `GET`. An `additionalOperations` method has no known semantics, so it gets the conservative `POST` profile (not read-only, destructive, not idempotent). `readOnlyOnly: true` therefore keeps `query` tools and drops the additional ones, whatever an extension says. See [Annotations & Extensions](./annotations.md).
- **Exact matching.** An additional method is found only exactly as written, everywhere: `generateTool('/files/{id}', 'LINK')` finds `LINK` but `'link'` does not, an `includeMethods` entry must be `'LINK'` (an `excludeMethods` entry matches in any case, so the document cannot pass it by spelling `Link`), an Arazzo `operationPath` must end in `additionalOperations/LINK`, and `getOperation` follows the same rule. A standard method matches in any case (`'GET'`, `'Query'`).
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

Each entry is `{ severity, code, message, path?, document? }`. `path` is a JSON Pointer (RFC 6901) into the document; `document` is set only for a Swagger 2.0 document and says which of its two documents `path` points into (see [Which diagnostic points where](#which-diagnostic-points-where)). `severity` is `'warning'` for everything except three Swagger 2.0 conversion notes that change nothing a tool does, which are `'info'` (`SWAGGER_UNKNOWN_FIELD`, `SWAGGER_ASSUMED_MEDIA_TYPE`, and `SWAGGER_NOT_CONVERTED` for a global `in: formData` parameter). Validation *errors* are not diagnostics: they throw a `ParseError` (see [Error Handling](./error-handling.md)).

The list grows as the generator works:

1. **On load**: a problem with the declared version (a 3.x minor newer than 3.2, both `openapi` and `swagger`, a version that cannot be processed), why `$self` is ignored when the document has one that is, and a retrieval URI that is too long to be used. The declared version itself is not a diagnostic: `getSpecVersion()` reports it.
2. **At the first generation with `validate: true`**: the validator's warnings.
3. **Swagger 2.0 only, at the first generation or `lint()`, after validation**: what the conversion to OpenAPI 3.0 could not carry over exactly (the `SWAGGER_*` codes, and `FEATURE_NEWER_THAN_DECLARED_VERSION` for a `trace`, `query` or `additionalOperations` field). It runs with `validate: false` too. Their `path` points into the 2.0 document.
4. **While generating**: everything the generator skips or ignores. `generateTools()` walks every path; `generateTool()` records the findings of the path item and operation it builds. For a Swagger 2.0 document a finding about a parameter names the parameter's index in the 2.0 document (see [Which diagnostic points where](#which-diagnostic-points-where)).

With `validate: false` the second stage never happens. `generator.validate()` returns its own `ValidationResult` and does not add to the list.

`DIAGNOSTIC_CODES` (exported, with the type `DiagnosticCode`) is the one registry of every code `getDiagnostics()` can carry. The values never change once released.

| Code | Emitted when | Stage |
| --- | --- | --- |
| `NEWER_OPENAPI_VERSION` | `openapi` declares a 3.x minor version newer than 3.2 | Load |
| `CONFLICTING_VERSION_FIELDS` | The document has both `openapi` and `swagger`; `swagger` is ignored | Load |
| `INVALID_OPENAPI_VERSION` | The version cannot be processed: another major or minor of Swagger (`1.2`, `2.1`) or OpenAPI, a malformed value. Recorded as a warning even when validation then rejects the document | Load |
| `MISSING_OPENAPI_VERSION` | The document declares no version | Load |
| `NO_PATHS` | The document defines no paths | Validation |
| `NO_OPERATIONS` | A path item holds no operation the declared version reads (it may hold only ignored ones) | Validation |
| `NO_OPERATION_ID` | An operation has no `operationId`; its tool name comes from the method and path | Validation |
| `DUPLICATE_OPERATION_ID` | Two operations share an `operationId`, which must be unique; `path` is the second one's `operationId` | Validation |
| `NO_SERVERS` | The document defines no servers (Swagger 2.0: no `host`; it warns even when `fromURL` or `documentUri` will supply one, because the validator does not know the retrieval URI) | Validation |
| `NO_SECURITY_SCHEMES` | The document has `security` but no `components.securitySchemes` (Swagger 2.0: no `securityDefinitions`) | Validation |
| `FEATURE_NEWER_THAN_DECLARED_VERSION` | A `query` operation or `additionalOperations` in a document declaring 3.0 or 3.1: it is not read, so it makes no tool. Also `$self` in such a document (not read: references resolve as if it were absent), and, when validating, an `in: querystring` parameter (it is read all the same: the operation makes a tool), and, in a Swagger 2.0 document, a `trace`, `query` or `additionalOperations` field in a Path Item, which Swagger 2.0 does not define (not converted, so it makes no tool) | Load (`$self`), validation, conversion, generation |
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
| `SWAGGER_VERSION_NOT_2_0` | `upgradeSwagger2` was given a document that does not declare Swagger 2.0; it is converted as if it did. A standalone-converter code: the generator never converts such a document | Conversion |
| `SWAGGER_INVALID_VALUE` | A field holds a value of the wrong kind, or an impossible one (a `host` with a scheme or a path, a `basePath` without a leading `/` (it is added) or one a server URL cannot carry (it is dropped), a `schemes` entry other than `http`, `https`, `ws` and `wss`, a `consumes` that is not a list of media types, a parameter without a usable `name` and `in` (an `in: formData` one is dropped), a body parameter without a `schema`, an `in: path` parameter that is not `required: true` (converted as required), ...); it is ignored or replaced as the message says | Conversion |
| `SWAGGER_UNKNOWN_FIELD` | **`info`.** An object holds fields Swagger 2.0 does not define there (other than `x-` extensions); the message names the first three and they are not converted | Conversion |
| `SWAGGER_NOT_CONVERTED` | A construct has no OpenAPI 3.0 equivalent and is dropped or approximated as the message says: a tuple `items`, `additionalItems`, a `type` of nothing but `null`, `allowEmptyValue` on a form property, a `format` replaced because the type is `file`, a response example for a media type the operation does not produce, a security-scheme field that does not apply to its type, an operation's `schemes` when there is no host to apply them to, a `ws` or `wss` entry of `schemes` (no server is made for it). **`info`** for a global `in: formData` parameter, which OpenAPI 3.0 cannot hold as a component | Conversion |
| `SWAGGER_UNRESOLVED_REFERENCE` | A `$ref` is left in a document the converter expects dereferenced (references were not read: `secureDefaults`, `allowedProtocols: []`, or a standalone call), or a schema `$ref` points outside `#/definitions/`. The parameter, response, header or security scheme that holds it is ignored; a schema reference is kept as written | Conversion |
| `SWAGGER_RELATIVE_SERVER_URL` | No usable `host` and no `http` or `https` retrieval URI: the server URL is the relative `basePath` (or `/`), and `schemes` cannot apply | Conversion |
| `SWAGGER_ASSUMED_SCHEME` | A `host` but no `http` or `https` in `schemes` (none, or only `ws` and `wss`), and no web retrieval URI to take the scheme from: `https` is assumed | Conversion |
| `SWAGGER_ASSUMED_MEDIA_TYPE` | **`info`.** No `consumes` (or `produces`) applies to a body: `application/json` is assumed for it and for every other such body. Reported once for request bodies and once for responses | Conversion |
| `SWAGGER_FORM_MEDIA_TYPE_ADDED` | An operation has `in: formData` parameters but its `consumes` names neither `application/x-www-form-urlencoded` nor `multipart/form-data`: one is added (multipart with a file field, else urlencoded). Also an operation with a `type: file` field whose `consumes` names only urlencoded: the body is multipart, since a file cannot be a urlencoded value | Conversion |
| `SWAGGER_MULTIPLE_BODY_PARAMETERS` | An operation has more than one `in: body` parameter (the path item's included); the last one is the body. `path` is the operation's `parameters` | Conversion (validation: error) |
| `SWAGGER_BODY_AND_FORM_DATA` | An operation has both `in: body` and `in: formData` parameters; the body parameter is the body and the form parameters are ignored. `path` is the operation's `parameters` | Conversion (validation: error) |
| `SWAGGER_DUPLICATE_FORM_DATA_PARAMETER` | Two `in: formData` parameters of one list share a name; the last one is used | Conversion |
| `SWAGGER_UNSUPPORTED_COLLECTION_FORMAT` | A `collectionFormat` OpenAPI 3.0 cannot express where it is used (`tsv`; `ssv`, `pipes` or `multi` in a path or header; anything but `csv` in a response header; one on a nested array); the fallback the message states applies. A form field never needs it for `multi`, `csv`, `ssv` or `pipes`: they have a style in both form media types | Conversion |
| `SWAGGER_FILE_OUTSIDE_FORM_DATA` | `type: file` outside an `in: formData` parameter or a response schema (a query parameter, a header, an Items Object); converted to a binary string anyway | Conversion |
| `SWAGGER_UNSUPPORTED_SECURITY_SCHEME` | A security definition of an unknown `type`, or an `oauth2` whose `flow` is not `implicit`, `password`, `application` or `accessCode`; the scheme is not converted, so a requirement that names it is dropped with `UNRESOLVED_SECURITY_SCHEME`, and an operation left with no requirement is skipped (`UNSATISFIABLE_SECURITY`), whether or not other schemes exist (see [Security](./security.md#requirements-that-name-an-undefined-scheme)) | Conversion |
| `SWAGGER_MEDIA_TYPE_LIMIT` | A `consumes` or `produces` list holds more than `MAX_MEDIA_TYPES_PER_LIST` (32) distinct media types; the first 32 of each are kept. One diagnostic for the document, which says how many lists and media types; `path` is the first list cut | Conversion |
| `SWAGGER_CONVERSION_TOO_LARGE` | The conversion would create more than `MAX_CONVERSION_ENTRIES` (1,000,000) entries and is abandoned: `generateTools()`, `generateTool()` and `lint()` throw a `ParseError` (see [Limits](#limits)). `path` is the root (`''`) | Conversion |
| `UNRESOLVED_SECURITY_SCHEME` | A Security Requirement object names a scheme that `components.securitySchemes` does not define, and that (in a 3.2 or newer document) is not a URI naming a scheme of this document: a scheme in another document is not read. One diagnostic per missing scheme; the whole object is dropped | Generation |
| `INVALID_SECURITY_REQUIREMENT` | A Security Requirement is not an object; it is dropped | Generation |
| `UNSATISFIABLE_SECURITY` | Every Security Requirement of an operation was dropped, so no way to authenticate is known; the operation makes no tool | Generation |
| `UNSUPPORTED_SECURITY_SCHEME` | A Security Requirement names a scheme the library cannot send: a `type` that is none of `apiKey`, `http`, `oauth2`, `openIdConnect`, `mutualTLS` (exactly), or an `apiKey` whose `in` is none of `query`, `header`, `cookie` or that has no `name`. The whole object is dropped, like one naming an undefined scheme. As an `info`: a `mutualTLS` scheme, which the HTTP client applies, so the tool has no input for it | Generation |
| `INVALID_RESPONSE_KEY` | A key of an operation's `responses` is no status code (three digits from `100` to `599`), range (`2XX`, any case) or `default` (`200 `, `0200`, `+200`, `20`); the response is ignored | Generation |
| `TOOL_GENERATION_FAILED` | `generateTools()` could not build a tool for an operation, for a reason no other code names; the message holds the error. `generateTool()` throws it instead | Generation |
| `UNRESOLVED_REFERENCE` | With `dereference: true`, a parameter or request body is still a Reference Object after dereferencing (a reference to another document that was not read, as under `secureDefaults`): the operation makes no tool. A response left as a reference is ignored and the tool is still made | Generation |
| `PARAMETER_IGNORED` | A parameter is not an input of the tool: a header parameter the HTTP client, a credential or a proxy sets (`Accept`, `Content-Type` and `Authorization`, which OpenAPI says to ignore; `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Cookie`, `Forwarded`, `X-Forwarded-*`, the method-override headers, ...), or a parameter sent where a credential of the operation is sent (same location and name; a header name in any case). The tool is still made | Generation |
| `UNSUPPORTED_PARAMETER_LOCATION` | A parameter has an `in` the generator does not map to a request (an `in: body` in an OpenAPI 3 document, a missing `in`); the operation makes no tool. The `in: body` and `in: formData` parameters of a Swagger 2.0 document are converted first and never reach it | Generation |
| `MULTIPLE_QUERYSTRING_PARAMETERS` | An operation has more than one `in: querystring` parameter (the path item's included); the operation makes no tool | Generation (validation: error) |
| `QUERYSTRING_WITH_QUERY_PARAMETERS` | An operation has an `in: querystring` parameter and `in: query` parameters (the path item's included); the operation makes no tool | Generation (validation: error) |
| `QUERYSTRING_PARAMETER_WITHOUT_CONTENT` | An `in: querystring` parameter has no `content` holding a media type (it must not use `schema`); the operation makes no tool | Generation (validation: error) |
| `INVALID_PARAMETER_CONTENT` | A parameter's `content` cannot be read as OpenAPI defines it: several media types (one is used), none or not a map (ignored), alongside a `schema` (`schema` is used; for `in: querystring`, `content`), a media type that is not an object, or one with `itemSchema` (not read for a parameter). Generation alone also reports a media type left as an unresolved `$ref` | Validation, generation |
| `COOKIE_CONTENT_NOT_SENDABLE` | A cookie parameter sent as JSON (`content` with a JSON media type) whose schema allows a string, an object or an array (or has none): their JSON text holds `"` or `,`, which a cookie value cannot carry, so only a number, boolean or `null` can be sent. The tool is still made | Generation |
| `QUERYSTRING_WITH_QUERY_CREDENTIAL` | A whole-query parameter serialized as anything but `application/x-www-form-urlencoded` (no name=value pairs) in an operation whose security scheme sends an API key in the query. One per scheme; `buildHttpRequest` refuses a call using it. The tool is still made | Generation |
| `DUPLICATE_PARAMETER` | A parameter list (a path item's or an operation's) repeats a `name` and `in` (a header name in any case, an `in: querystring` parameter exactly); the last one is used and each earlier one is ignored | Validation, generation |
| `PARAMETER_NAME_NOT_STRING` | A parameter's `name` is a number or a boolean (YAML reads an unquoted `2024` or `true` so): it is read as its text (`"2024"`), in every version | Validation, generation |
| `INVALID_PARAMETER_NAME` | A parameter's `name` is absent, `null`, `''`, an array or an object, so it cannot be sent: the operation makes no tool. A validation error too (`MISSING_PARAMETER_NAME` for an absent, `null` or empty name) | Generation (validation: error) |
| `REQUIRED_INPUT_ACCEPTS_NOTHING` | A required input of a tool (a parameter, a body property, a whole body) has a schema that accepts no value (`false`, or `{ not: {} }`), so no call can succeed. The tool is still made | Generation |
| `UNSUPPORTED_STREAMING_REQUEST_BODY` | A request body's media type declares only `itemSchema` (a streamed upload); the tool takes no body input | Generation |
| `SCHEMA_DEPTH_REDUCED` | A tool's input, output or stream item schema exceeds `maxSchemaNodes` at `maxSchemaDepth`, so it is cut at the deepest depth where it fits; the message names the schema and the depth. The tool is still made (see [maxSchemaNodes](./configuration.md#maxschemanodes)) | Generation |
| `UNREADABLE_REFERENCE` | **A validation error only, never a `getDiagnostics()` entry.** `generator.validate()` returns it, instead of throwing, for a `$ref` it cannot read (refused by a `refResolution` rule, missing, not JSON or YAML, a pointer that leads nowhere, ...). `message` is the `ParseError` message of generation without its prefix; `path` is the JSON Pointer of the `$ref` when it is in the document itself | `validate()` result |
| `DEREFERENCE_REQUIRED` | **A validation error only, never a `getDiagnostics()` entry.** A Swagger 2.0 document loaded with `dereference: false`, which the conversion cannot read. `generator.validate()` returns it; generation and `lint()` throw a `ParseError` that carries it in `context.errors`. `path` is `/swagger` | `validate()` result, `ParseError` |
| `DIAGNOSTICS_TRUNCATED` | The list reached `MAX_DIAGNOSTICS`; findings after it were not recorded, and the message counts the warnings and the infos left out (see [Limits and escaping](#limits-and-escaping)) | Last entry |

The table lists every code of `DIAGNOSTIC_CODES`: the spec layer's own (`SPEC_DIAGNOSTIC_CODES`: the declared version, the Path Item walk, the Swagger 2.0 conversion) and the generator's. Three things to know when reading it:

- **Two codes are validation errors only and never a `getDiagnostics()` entry:** `UNREADABLE_REFERENCE` and `DEREFERENCE_REQUIRED`, both returned by `generator.validate()` (the second also thrown by generation). `INVALID_SELF` is both an error of `validate()` and a warning recorded at load.
- **"Validation: error"** means the validator rejects the document for that finding (see [What validation checks per version](#what-validation-checks-per-version)); the diagnostic exists when generation runs with `validate: false`. When validating, the codes marked "Validation, generation" are warnings and reach `getDiagnostics()`; with `validate: false`, generation records them itself.
- **The other validation errors are not in the registry.** `MISSING_INFO`, `MISSING_TITLE`, `MISSING_VERSION`, `INVALID_PATH_FORMAT`, `NO_RESPONSES`, `MISSING_PATH_PARAMETER`, `INVALID_PARAMETER`, `MISSING_PARAMETER_NAME`, `MISSING_PARAMETER_IN`, `INVALID_PARAMETER_IN`, `PATH_PARAMETER_NOT_REQUIRED`, `MISSING_PARAMETER_SCHEMA`, `INVALID_SECURITY_SCHEME` and `INVALID_BASE_PATH` (Swagger 2.0) only ever appear in a `ValidationResult` or in the `context.errors` of the `ParseError` that a failed validation throws; `generator.getDiagnostics()` never carries them (see [API Reference](./api-reference.md#validator)).

### Limits and escaping

A document is untrusted input, and a diagnostic quotes it, so each list and each quotation is bounded:

- **`MAX_DIAGNOSTICS` (1,000).** `getDiagnostics()` keeps at most 1,000 distinct findings, warnings in preference to infos: while there is room every finding is kept in the order found; once the list is full a new warning takes the place of the most recently recorded `info` (while there is one) and a new `info` is not recorded. The list then ends with one `DIAGNOSTICS_TRUNCATED` entry (no `path`), whose message counts the warnings and the infos that were not recorded, separately (`1200 warnings and 2 infos were not recorded`). A finding found again after it was dropped counts once. A `ValidationResult` caps `errors` and `warnings` at the first 1,000 each, ending with its own `DIAGNOSTICS_TRUNCATED` entry; `valid` still reflects every error. A repeated finding (the validator and the generator both reporting one) counts once.
- **Quoted document text.** A string from the document is cut (64 characters in most messages; a path key or method in a validation message, 1,024 and 64) and shown as JSON, with control characters, line and paragraph separators and bidirectional formatting characters written as `\uXXXX`, so no newline or terminal escape sequence reaches a log. The `ParseError` message for a failed validation quotes the first error at most 512 characters, escaped; `context.errors` keeps each error as the validator produced it.
- **JSON Pointers.** `path` is built with each segment escaped as RFC 6901 says (`~` is `~0`, `/` is `~1`). A segment is also made safe to display: unsafe characters become `\uXXXX` and a segment over 256 characters is cut and ends with `...(truncated)`. A pointer holding a cut or `\u`-escaped segment is for display: it does not resolve to the value. An ordinary key gives a pointer that resolves.
- **Legacy paths.** The validator codes that predate OpenAPI 3.2 support (`INVALID_PATH_FORMAT`, `NO_OPERATIONS`, `NO_OPERATION_ID`, `NO_RESPONSES`, `MISSING_PATH_PARAMETER`, `MISSING_PARAMETER_NAME`, `MISSING_PARAMETER_IN`, `INVALID_PARAMETER_IN`, `PATH_PARAMETER_NOT_REQUIRED`, `MISSING_PARAMETER_SCHEMA`) keep their historical `path`: the path key unescaped, cut past 1,024 characters (`LEGACY_PATH_KEY_MAX_LENGTH`) with `...` (`/paths//pets/get/operationId`), so code that matches on them keeps working. Every newer code (`INVALID_PARAMETER_NAME` and the Swagger 2.0 body rules included), and every diagnostic the generator adds, uses a JSON Pointer (`/paths/~1pets/get`).

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

### Encoding Objects are applied

The `encoding` map of a form media type was carried on the mapper (`serialization.encoding`) but ignored: a field was always written by its type, whatever its Encoding Object said. `buildHttpRequest` now applies `style`, `explode` and `allowReserved` in `application/x-www-form-urlencoded` bodies, form whole queries and form `content` parameters, and those, `contentType` and `headers` in `multipart/form-data` bodies. A tool whose media type has no `encoding` is unchanged; one that declares it changes. The same urlencoded body (`ids` an array, `metadata` an object, `next` a string, with `encoding: { ids: { style: "pipeDelimited" }, metadata: { style: "deepObject", explode: true }, next: { allowReserved: true } }`) and input `{ ids: [1, 2, 3], metadata: { plan: "pro" }, next: "/orders?page=2&x=1#top" }`:

```typescript
buildHttpRequest(tool, input).body;
// before: 'ids=1&ids=2&ids=3&metadata=%7B%22plan%22%3A%22pro%22%7D&next=%2Forders%3Fpage%3D2%26x%3D1%23top'
// after:  'ids=1%7C2%7C3&metadata%5Bplan%5D=pro&next=/orders?page%3D2%26x%3D1%23top'
```

A multipart body whose `meta` field has `contentType: "application/json"` and a header `X-Version` that its schema fixes to `2`, and whose `tags` array has `style: "pipeDelimited"` (see [Request Builder](./request-builder.md#multipart-parts)):

```typescript
request.body;
// before: FormData [['meta', '{"title":"Q3"}'], ['file', <Blob text/csv>], ['tags', '["a","b"]']], and no content-type header
// after:  a Blob the builder wrote (parts: meta with Content-Type: application/json and X-Version: 2, file, tags = 'a|b'),
//         and headers['content-type'] = 'multipart/form-data; boundary=mcp-from-openapi-<random>'
```

What to check:

- **Code that sends `request.body` with `fetch` needs no change** for a `Blob` or a `FormData`; code that assumed a multipart body is always a `FormData` (`body instanceof FormData`, `body.get(...)`) must also accept a `Blob`, and **must send `request.headers['content-type']` when it is set**, because it carries the boundary the builder chose. A multipart body without part headers is still a `FormData` with no `content-type`.
- **A document that declares an `encoding` now gets what it asked for.** If you sent `metadata` as JSON text because the library did, and the server expected that although the document says `deepObject`, the server was wrong about its own document: fix the document, or the server.
- **`contentType` is ignored for a field that also has `style`, `explode` or `allowReserved`**, as OpenAPI 3.2 says.
- **A field with an Encoding Object omits `null`** in a multipart body as in a form (without one, `null` is still the text `null` there).
- **New refusals** (`RequestBuildError`): an Encoding Object of the wrong shape, an array of objects under `deepObject`, an object under `text/plain`, a part header with an invalid name or value, and a name the input chooses that the tool reserves (an exploded `meta` object with a property `token` next to a `token` field).

The rules, each row of the table run, are in [Request Builder](./request-builder.md#encoding-objects).

### `allowReserved` and the query string

`allowReserved: true` on a query parameter left every RFC 3986 reserved character raw and read a percent-encoded triple as text, so an input value could add query pairs (`&`, `=`), cut the query short with a fragment (`#`) or send a `+` that a form reads as a space. It now leaves raw only `: / ? @ ! $ ' ( ) * , ;`, passes a valid percent-encoded triple (`%41`) through, and always encodes `& = + # [ ]`; a `%` that does not start a triple becomes `%25`. The table of what each destination does is in [Request Builder](./request-builder.md#allowreserved).

```typescript
// a query parameter `next` with allowReserved: true, and an `apiKey` scheme `key` in the query (api_key); input key: 'real'
buildHttpRequest(tool, { next: "x&api_key=attacker", key: "real" }).url;
// before: 'https://api.example.com/items?next=x&api_key=attacker&api_key=real'
// after:  'https://api.example.com/items?next=x%26api_key%3Dattacker&api_key=real'

// a query parameter `p` with allowReserved: true
buildHttpRequest(tool, { p: "a#b" }).url; // before: '...?p=a#b' (the rest of the query is lost)   after: '...?p=a%23b'
buildHttpRequest(tool, { p: "%41" }).url; // before: '...?p=%2541'                                   after: '...?p=%41'
buildHttpRequest(tool, { p: "a+b" }).url; // before: '...?p=a+b' (a form reads a space)             after: '...?p=a%2Bb'
buildHttpRequest(tool, { p: "[x]" }).url; // before: '...?p=[x]'                                    after: '...?p=%5Bx%5D'
```

What to check:

- **A value that relied on the raw characters** (`allowReserved: true` and an input such as `a&b=c`, meant as two pairs) is now one value. Pass separate parameters, or an array or object with the style that says what you mean.
- **`allowReserved` has no effect on a path parameter** (`/`, `?`, `#` and `%` are always encoded), a header, a cookie, a parameter defined with `content` or a non-form whole query.
- **A form field with `allowReserved` in its Encoding Object** follows the same rules, now that Encoding Objects are applied (above).

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

### Swagger 2.0 is accepted

A Swagger 2.0 document used to be rejected; it is converted and generated now.

```typescript
// { swagger: '2.0', info: ..., host: 'api.example.com', schemes: ['https'],
//   paths: { '/pets': { get: { operationId: 'listPets', responses: { 200: { description: 'ok' } } } } } }
const generator = await OpenAPIToolGenerator.fromJSON(spec);
generator.getSpecVersion();
await generator.generateTools();
await generator.validate();
```

Before:

```typescript
// { status: 'swagger-2.0', field: 'swagger', declared: '2.0', major: 2, minor: 0, diagnostics: [] }
// getDiagnostics(): [INVALID_OPENAPI_VERSION (warning)]
// generateTools() threw ParseError:
//   'Invalid OpenAPI document: Swagger 2.0 documents are not supported. Expected OpenAPI 3.0.x, 3.1.x or 3.2.x
//    (a later 3.x is read with the 3.2 rules)'   (context.errors[0].code 'INVALID_OPENAPI_VERSION', path '/swagger')
// validate(): { valid: false, errors: [INVALID_OPENAPI_VERSION], warnings: [NO_SERVERS] }
// with validate: false: one tool, read as if it were OpenAPI 3, and INVALID_OPENAPI_VERSION in getDiagnostics()
```

After:

```typescript
// { status: 'supported', field: 'swagger', declared: '2.0', major: 2, minor: 0, family: '2.0', diagnostics: [] }
// getDiagnostics(): []
// generateTools(): [listPets]
// validate(): { valid: true }
```

What to check:

- **`SpecVersionStatus` has no `'swagger-2.0'` member any more** (a Swagger 2.0 document is `'supported'`, with `field: 'swagger'` and `family: '2.0'`), and `SpecFamily` gains `'2.0'`. A `switch` on `status` that handled `'swagger-2.0'`, or code that read `family` as one of `'3.0' | '3.1' | '3.2'`, needs updating. Swagger `"1.2"` and `"2.1"` stay `'unsupported'`.
- **`SUPPORTED_SPEC_VERSIONS` is `['2.0', '3.0.x', '3.1.x', '3.2.x']`**, and the version errors say `Expected Swagger 2.0 or OpenAPI 3.0.x, 3.1.x or 3.2.x`.
- **Code that relied on the rejection** (to refuse a 2.0 document before using it) now gets tools. Test `generator.getSpecVersion().family === '2.0'` to treat it apart.
- **`resolveOperationLayout` for a 2.0 document** reads the seven 2.0 methods (no `trace`); a document with a version that cannot be processed still gets the eight classic methods.

### Boolean schemas are read as what they say

OpenAPI 3.1 and 3.2 allow a schema to be `true` (any value) or `false` (no value) wherever a schema goes. `true` always became `{}`; `false` became `{}` too, which accepts everything. It now becomes `{ not: {} }`, in every position, and a media type whose `schema` is `false` counts as having one. What generation does:

| The document has | Before | After |
| --- | --- | --- |
| A request body with `schema: true` | No body input: the body was ignored | An input `body`, `{}`, the whole body (`wholeBody: true`) |
| A request body with `schema: false` (`required: true`) | No body input | A required input `body`, `{ not: {} }`: no call can satisfy it, as the document says |
| A parameter with `schema: false` | With validation on, `ParseError`: `Parameter 'q' missing schema or content` | An input `q` with `{ not: {} }` |
| A response with `schema: false` | No `outputSchema` | An `outputSchema` of `{ not: {}, 'x-status-code': 200, description: 'ok', 'x-content-type': 'application/json' }` |
| An object schema with a property `false` | `{}` | `{ not: {} }` |
| A parameter or response with `schema: true` | `{}` | `{}`, unchanged |

`toJsonSchema(false)` is `{ not: {} }` as well, and so is a `false` that is a member of `properties`, `prefixItems`, `allOf`, `anyOf` or `oneOf`, `patternProperties`, `dependentSchemas`, `$defs` or `definitions` (a `true` there is `{}`). `items: true` and `not: true` are `{}`. Where JSON Schema 2020-12 allows a boolean as the keyword's own value, the boolean is kept as written, because it is valid there: `additionalProperties`, `items: false`, `not: false`, `contains`, `propertyNames`, `if`/`then`/`else`, `contentSchema` and `unevaluated*`. Converting a `false` schema costs two nodes of the `maxSchemaNodes` budget (the schema and its `not` keyword), like any schema with one keyword.

A schema that accepts no value is visible in two more places:

- **Type signatures** (`emitTypeSignatures`) write `{ not: {} }` as `never` (`q: never;` for a required `false` parameter, `n?: never;` for a property), see [Type Signatures](./type-signatures.md).
- **`REQUIRED_INPUT_ACCEPTS_NOTHING`**: a required input of a tool (a parameter, a body property, a whole body) whose schema accepts no value means no call of the tool can succeed. The tool is still made, and the operation gets one warning per such input (`POST /a: the required input "q" accepts no value (its schema is false, or { not: {} }), so no call of the tool can succeed; the tool is still made`).

Client targets treat the "never" schema `{ not: {} }` (which is also how OpenAPI 3.0 writes it) so that no target breaks on it:

| Target | What it does with `{ not: {} }` |
| --- | --- |
| `strict`, `claude` | Nothing: it stays as written |
| `openai` | An **optional** property no value satisfies cannot be made required-and-nullable. In a closed object (`additionalProperties: false`, no `patternProperties`) it is left out, which forbids it just the same; in an open one it stays optional. A required one stays required (the object can never be sent, as written) |
| `gemini` | A `oneOf`/`anyOf` member that accepts nothing is not counted as an omitted alternative: the first member that accepts a value is kept, and the note lists the others. When no member accepts a value, the first is kept |

A nullable schema whose other member accepts nothing (`anyOf: [false, { type: 'null' }]`, which is `anyOf: [{ not: {} }, { type: 'null' }]` in the tool, or a 3.0 schema written `{ not: {}, nullable: true }`) is no longer unwrapped to that member: unwrapping gave `{ not: {}, description: 'May be null.' }`, which rejects `null` too, although `null` is the only value the union accepts. (The 3.0 form is the library's reading: it applies `nullable` to a schema without `type` as well, where OpenAPI 3.0.3 says `nullable` only takes effect next to `type`, so that document strictly allows no value.) `gemini` now gives `{ type: 'null' }` (the first member that accepts a value), and the root collapse of `strict`, `claude` and `openai` gives the `x-variants` node (`{ description: 'Accepts one of 2 variants: variant 1; type null.', 'x-variants': [{ not: {} }, { type: 'null' }] }`); below the root these three leave the union as written. A wrapper around a schema that accepts values still unwraps.

See [Client Targets](./client-targets.md#schemas-that-accept-no-value).

### Response status ranges (`1XX` to `5XX`)

A response key `2XX` (any case: `2xx`) is a range of the OpenAPI Specification, not the status code 2. It used to be read as `parseInt('2XX')`, so `x-status-code` was `2` and `metadata.responseStatusCodes` held `[2]`. A range key now keeps its name: `x-status-code` is the string `'2XX'` (upper-cased), `metadata.responseStatusRanges` lists it, and `metadata.responseStatusCodes` holds only numbers (an explicit code, and `0` for `default`).

The preferred response (`includeAllResponses: false`, and the streamed response) is the first rule that finds a candidate (`GenerateOptions.preferredStatusCodes`):

1. an explicit status code in `preferredStatusCodes`, in its order;
2. any explicit 2xx code;
3. a range key covering a code in `preferredStatusCodes`, in its order, else the `2XX` range;
4. any explicit 3xx code, else the `3XX` range;
5. the first response with a schema (`default` only when nothing else has one).

An explicit code beats a range of its own class where the rules say so: always for 2xx (rule 2 precedes every range rule) and for a code listed in `preferredStatusCodes` (rule 1), for 3xx only while no range covers a code of `preferredStatusCodes` (rule 3 precedes rule 4), and not for the other classes: `{ 299, 2XX }` gives 299 although `2XX` covers the preferred 200, but `{ 499, 4XX }` with `preferredStatusCodes: [404]` gives `4XX` (rule 3 finds the range covering 404; with the default list the answer is 499, by rule 5). A range is the answer for the codes the document does not list. Cases, with `includeAllResponses: false` and the default `preferredStatusCodes` unless stated (`x-status-code` of the chosen response):

| Response keys | Before | After |
| --- | --- | --- |
| `200`, `2XX` | `200` (`responseStatusCodes`: `[200, 2]`) | `200` (`responseStatusCodes`: `[200]`, `responseStatusRanges`: `['2XX']`) |
| `299`, `2XX` | `299` | `299` |
| `4XX`, `404` | `404` | `404` |
| `2XX`, `404` | `404` (`2XX` was code 2, no preferred code matched) | `'2XX'` |
| `2XX` | `2` | `'2XX'` |
| `4XX`, `5XX` | `4` | `'4XX'` |
| `3XX`, `2XX` | `3` | `'2XX'` |
| `2xx`, `5xx` | `2` | `'2XX'` |
| `2XX`, `4XX`, with `preferredStatusCodes: [404, 200]` | `2` | `'4XX'` |
| `2XX`, `3XX`, `299`, with `preferredStatusCodes: [201]` | `299` | `299` |

With the default `includeAllResponses: true` every response is a `oneOf` variant, each with its own `x-status-code`: `[200, '2XX']` for the first row (JavaScript lists integer keys first, so explicit codes come before ranges). A streamed response (OpenAPI 3.2 `itemSchema`) is chosen the same way: for `{ '2XX': <stream> }` `metadata.responseStream.statusCode` was `2` and is `'2XX'`, and for `{ 404, '2XX' }`, both streaming, it was `404` and is `'2XX'`.

What to check:

- **`x-status-code` can be a string**, `ResponseStreamInfo.statusCode` is `number | ResponseStatusRange` (the exported type `ResponseStatusRange` is `'1XX' | '2XX' | '3XX' | '4XX' | '5XX'`), and a `typeof` or arithmetic on it needs a branch. The type signature of a tool prints it as written (`/** status 4XX (application/json) */`).
- **`metadata.responseStatusCodes` no longer holds `2`, `4` and so on** for range keys; read `metadata.responseStatusRanges`.
- **The tool a range key selects can change** for `includeAllResponses: false` and for streams, as the table shows.

### Swagger constructs honoured in OpenAPI 3 documents

`x-nullable`, `type: file` and a string `discriminator` are read by `toJsonSchema` in every version (see [Swagger constructs in any document](#swagger-constructs-in-any-document)). A 3.0 or 3.1 document that carries them (a converter's output often does) used to keep them verbatim, which is not valid JSON Schema:

```typescript
// a 3.0.3 or 3.1.0 document; a request body schema with
//   name: { type: 'string', 'x-nullable': true }, avatar: { type: 'file' }
// and a response schema with discriminator: 'kind'
```

Before:

```typescript
tool.inputSchema.properties.name; // { type: 'string', 'x-nullable': true, 'x-parameter-location': 'body' }
tool.inputSchema.properties.avatar; // { type: 'file', 'x-parameter-location': 'body' }
tool.mapper.find((m) => m.inputKey === 'avatar').serialization; // { contentType: 'application/json' }
tool.outputSchema.discriminator; // 'kind'
```

After:

```typescript
tool.inputSchema.properties.name; // { type: ['string', 'null'], 'x-parameter-location': 'body' }
tool.inputSchema.properties.avatar; // { type: 'string', format: 'binary', 'x-parameter-location': 'body' }
tool.mapper.find((m) => m.inputKey === 'avatar').serialization; // { contentType: 'application/json', binary: true }
tool.outputSchema.discriminator; // { propertyName: 'kind' }
```

An `x-nullable` next to a `nullable` of its own is not read (the `nullable` decides), and `x-nullable` with a value that is not a boolean is left as written.

### `fromJSON` throws a `ParseError` for input it cannot copy

`fromJSON(json)` copies the object as JSON. Input that cannot be copied used to throw whatever `JSON.stringify` threw (a `TypeError`, a `RangeError`); it is a `ParseError` now, so the error handling of every other load failure covers it:

```typescript
const cyclic: Record<string, unknown> = { openapi: "3.0.3", info: { title: "t", version: "1" }, paths: {} };
cyclic.self = cyclic;
await OpenAPIToolGenerator.fromJSON(cyclic);
```

Before: `TypeError: Converting circular structure to JSON ...`. After: `ParseError: Failed to read the JSON document: Converting circular structure to JSON\u000a    --> starting at object with constructor 'Object' ...` (the message is cut and escaped; `context.originalError` holds the original). The same for a `BigInt` (`Do not know how to serialize a BigInt`) and for nesting too deep for `JSON.stringify`: `RangeError: Maximum call stack size exceeded` before, `ParseError: Failed to read the JSON document: it is nested too deeply to copy (maximum call stack size exceeded)` after.

### A parameter `name` that is not a string

A parameter whose `name` was a number, a boolean, an array or an object passed validation (only a missing or empty name was an error) and became an input key of that value: the tool was generated with `mapper[0].inputKey === 5`, and `buildHttpRequest` then refused it (`Mapper entry 0 must have a string key and inputKey`). What happens now depends on the value, in every version:

| `name` | `validate: true` (the default) | `validate: false` |
| --- | --- | --- |
| A number or a boolean (`5`, `true`: YAML reads an unquoted `2024` or `true` so) | Read as its text (`"5"`), with a `PARAMETER_NAME_NOT_STRING` warning; the tool is made and sent as `?5=x` | The same |
| An array or an object | `ParseError`: `Invalid OpenAPI document: Parameter name must be a string, found an array` (`context.errors[0]`: `{ code: 'INVALID_PARAMETER_NAME', path: '/paths/~1p/get/parameters/1/name' }`) | The operation makes no tool, with an `INVALID_PARAMETER_NAME` warning |
| Absent, `null` or `''` | `ParseError`: `Parameter missing name` (`MISSING_PARAMETER_NAME`, as before) | The operation makes no tool, with an `INVALID_PARAMETER_NAME` warning |

```typescript
// parameters: [{ name: 5, in: 'query', schema: { type: 'string' } }]
const [tool] = await generator.generateTools();
tool.mapper[0]; // { inputKey: '5', type: 'query', key: '5', required: false }
buildHttpRequest(tool, { "5": "x" }).url; // 'https://api.example.com/p?5=x'
generator.getDiagnostics().map((d) => d.code); // ['PARAMETER_NAME_NOT_STRING']
```

### Arazzo `operationPath` fragments are percent-decoded

The fragment of an `operationPath` is a JSON Pointer, written percent-encoded in a URI reference (RFC 6901 section 6). It was split and unescaped without decoding, so an encoded character found nothing; it is decoded first now (a `%` that does not start a valid escape stays as written):

| `operationPath` fragment | Before | After |
| --- | --- | --- |
| `#/paths/~1pets~1%7BpetId%7D/get` | `ArazzoError`: `Failed to resolve GET /pets/%7BpetId%7D ...: Operation not found` | `get /pets/{petId}` |
| `#/paths/~1pets~1{petId}/additionalOperations/%4CINK` | `ArazzoError`: `Operation not found: %4CINK /pets/{petId}` | `LINK /pets/{petId}` |
| `#/paths/~1pets~1{petId}/get` | `get /pets/{petId}` | unchanged |

### `buildHttpRequest` wraps every JSON preflight failure

A `content` parameter serialized as JSON checks its value first (a cycle, nesting past 1,000 levels, a BigInt). A value that throws while it is read (a getter, a proxy) escaped that check as the raw error; it is a `RequestBuildError` now, like the others:

```typescript
buildHttpRequest(tool, { filter: { get a() { throw new Error("boom"); } } });
```

Before: `Error: boom`. After: `RequestBuildError: query parameter 'filter' cannot be serialized as JSON: boom`.

### Credentials are redacted in `$self` and `$ref` messages

A message that quotes `$self`, `LoadOptions.documentUri`, or the `reference` and `resolved` URL of a `$ref` that cannot be read (the `ParseError` message and its `context`), showed any user information the text held. It is replaced by `***` now, by the rule a URL parser uses to find user information:

- tabs and line breaks are removed first, and leading control characters and spaces skipped, as a URL parser does (`https:/<TAB>/user:secret@host` is `https://user:secret@host`);
- after a special scheme (`http`, `https`, `ws`, `wss`, `ftp`, `file`, in any letter case) and any slashes or backslashes, **with or without `//`** (`https:user:secret@host/x` is a URL with a user), after another scheme followed by `//`, or after a leading `//`, everything in the authority up to its last `@` is replaced;
- a path segment that starts with a special scheme and holds an `@` before the next `/`, `\`, `?` or `#` is treated the same way, because a reference such as `https:user:secret@host/x` that is read as a local path becomes `/srv/https:user:secret@host/x`, and the `resolved` text that names that path is redacted too.

Text a URL parser does not read as user information is left exactly as written, because it is not a credential and the message should name the file: a relative path such as `pet@v2.yaml` or `@scope/pet.yaml`, a name with a scheme-like prefix that is not special (`a:b@c.yaml`), and an opaque URI (`mailto:a@b`). A user name that is part of an ordinary directory name (`./dir/user:secret@x/pet.json`) is also left alone.

```typescript
// $self: 'https://user:secret@example.com/x.json#frag' (3.2), and a response schema $ref: 'https://user:secret@schemas.example.com/pet.json'
// before: INVALID_SELF ... found "https://user:secret@example.com/x.json#frag"
//         Cannot read $ref "https://user:secret@schemas.example.com/pet.json" ... resolved against ... to "https://user:secret@schemas.example.com/pet.json"
// after:  INVALID_SELF ... found "https://***@example.com/x.json#frag"
//         Cannot read $ref "https://***@schemas.example.com/pet.json" ... to "https://***@schemas.example.com/pet.json"
```

### A `$ref` to the document's own URI under a schema with its own `$id`

A reference that names the document by an absolute URI (`https://specs.example.com/petstore/openapi.json#/components/schemas/Pet`) inside a Schema Object with its own `$id` was never rewritten to a local reference, because the `$id` could change what a relative one means. An absolute reference means the same under any base, so it is rewritten now; a relative reference under an `$id` still is not.

```typescript
// documentUri: 'https://specs.example.com/petstore/openapi.json', secureDefaults: true; a response schema with
// $id: 'https://example.com/schemas/list' and properties.pet = { $ref: '<documentUri>#/components/schemas/Pet' }
tool.outputSchema.properties.pet;
// before: { $ref: 'https://specs.example.com/petstore/openapi.json#/components/schemas/Pet' }
// after:  { type: 'object', properties: { id: { type: 'integer' } } }
```

The one exception is a document that declares 3.1 (or names a JSON Schema dialect or an `$id` of its own) and also references another document: the reference resolver then reads `#` references against the nearest `$id`, so the absolute reference is left as written for it to read.

### A schema over `maxSchemaNodes` is cut shallower instead of failing the tool

A schema that exceeded the node budget at `maxSchemaDepth` failed its tool with a `SchemaError` (`Lower maxSchemaDepth or raise maxSchemaNodes`), and `generateTools()` left the tool out. That schema is now built again at the deepest depth that fits, and the operation gets a `SCHEMA_DEPTH_REDUCED` warning; only the schema over the budget is cut shallower, the tool's other schemas keep `maxSchemaDepth`. A tool fails only when not even depth 1 fits, with a new message (`The output schema of GET /item exceeds the node budget of 20 (maxSchemaNodes) even cut at depth 1 (maxSchemaDepth 10 was tried first): ... Raise maxSchemaNodes.`).

```typescript
// GET /item returns S0, whose five properties all reference S1, and so on: 5^10 nodes at depth 10
const tools = await generator.generateTools();
```

Before: no `getItem` tool, and `console.warn('Failed to generate tool for GET /item:', 'Schema exceeds the node budget of 100000 (maxSchemaNodes) after depth truncation: ...')` (the default budget was 100000).

After:

```typescript
tools.map((t) => t.name); // ['getItem', ...]
generator.getDiagnostics()[0].message;
// 'GET /item: its output schema exceeds the node budget of 25000 (maxSchemaNodes) at maxSchemaDepth 10, so it is cut at depth 5; raise maxSchemaNodes to keep more of it'
```

### The default `maxSchemaNodes` is 25,000 (it was 100,000)

A schema over the budget used to cost its tool, so the default was set high enough to only stop schemas no client could use. It now costs depth, so the default is set to cut only the outliers: the largest tools of the pinned GitHub and Discord descriptions need 22,232 and 19,225 nodes and stay whole, as does every tool of the 35 public descriptions in the maintainers' survey corpus (`scripts/spec-corpus/`) that load, except Microsoft Graph (811 tools), Stripe (171) and Datadog (2), whose largest tools go from 20 MB, 3 MB and 1.5 MB to 5 MB, 0.9 MB and 1.1 MB. The extension meta, the values a tool copies from the spec and a client target's inlining share the budget and still fail the tool past it: none of those descriptions comes near. `maxSchemaNodes: 100000` gives the earlier tools back (with the shallower cut).

### A `$ref` inside a schema's `x-` extension is kept as written

Dereferencing resolves every `$ref`, including one inside a specification extension, where OpenAPI defines no Reference Object. A tool's schema then carried the resolved value: for Stripe's `x-expansionResources`, the whole graph of the schemas an expandable field expands to: 110 of its 606 operations failed whatever `maxSchemaDepth`, and 212 more failed at the default depth. In a tool's input, output and stream item schemas, an extension now holds each `$ref` as the dereferencer read it (relative to the file it was written in, a reference to the document's own URI in its local form, without keywords next to it; see [maxSchemaNodes](./configuration.md#maxschemanodes)). Nothing else changes: the schemas are dereferenced, a `$ref` in a `default` or an example is still resolved, `getDocument()` returns the dereferenced document, and the `x-mcp` / `x-frontmcp` meta of an operation is still resolved.

```typescript
// components.schemas.charge.properties.customer:
//   { anyOf: [...], 'x-expansionResources': { oneOf: [{ $ref: '#/components/schemas/customer' }] } }
const tool = await generator.generateTool('/v1/charges/{charge}', 'get');
```

Before: a `SchemaError` (`Schema exceeds the node budget of 100000 (maxSchemaNodes) after depth truncation`), whatever `maxSchemaDepth`.

After:

```typescript
tool.outputSchema.properties.customer.anyOf[0]['x-expansionResources'];
// { oneOf: [{ $ref: '#/components/schemas/customer' }, { $ref: '#/components/schemas/deleted_customer' }] }
```

### Fields that only add

`x-parameter-content-type` and `x-parameter-whole-query` on input properties, `wholeQuery` on a mapper entry, `queryString` on a built request, `metadata.servers[].name`, `metadata.responseStream` and `responseHints.streaming`, `LoadOptions.documentUri`, `rule`, `reference`, `base`, `resolved` and `path` on the `context` of a `ParseError`, `context.reason` on an `SsrfError`, `metadata.responseStatusRanges` and the type `ResponseStatusRange`, `upgradeSwagger2` with its options (`documentUri`, `maxEntries`) and result types (`document`, `diagnostics`, `parameterIndexes`, `tooLarge`), `MAX_MEDIA_TYPES_PER_LIST` and `MAX_CONVERSION_ENTRIES`, and the `OAS20` types, the `SWAGGER_*` conversion codes (and `DEREFERENCE_REQUIRED` and `INVALID_BASE_PATH`, validation errors for a Swagger 2.0 document), the `info` severity of a diagnostic and `SpecDiagnostic.document`, and the new warnings (`INVALID_PARAMETER_CONTENT`, `DUPLICATE_PARAMETER`, `PARAMETER_NAME_NOT_STRING`, `REQUIRED_INPUT_ACCEPTS_NOTHING`, `SCHEMA_DEPTH_REDUCED`, `UNSUPPORTED_STREAMING_REQUEST_BODY`, `COOKIE_CONTENT_NOT_SENDABLE`, `QUERYSTRING_WITH_QUERY_CREDENTIAL`, `INVALID_SELF`, `REFUSED_SELF`, `UNRESOLVABLE_SELF`, `BASE_URI_TOO_LONG`; a valid document stays valid, apart from a 3.2 document whose `$self` is not a URI reference, which `validate()` now rejects with `INVALID_SELF`). `fromArazzo` rejects a `loadOptions.documentUri` with an `ArazzoError` (see [Arazzo Workflows](./arazzo.md#sources)).

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

**Swagger 2.0**

- A 2.0 document needs `dereference: true`; `dereference: false` is refused (`DEREFERENCE_REQUIRED`). To read no other document, use `secureDefaults` or `allowedProtocols: []`.
- A 2.0 document with no `host` has a relative server URL (`SWAGGER_RELATIVE_SERVER_URL`) unless it is loaded with `fromURL` or a web `documentUri`, and the validator's `NO_SERVERS` warning does not know the retrieval URI, so it appears even then. A `buildHttpRequest` call on a relative server needs `baseUrl`.
- `collectionFormat: tsv` has no OpenAPI 3.0 style: the array is sent comma-separated, in a query, a path, a header or a form field. A `multi` array in a path or header, and a nested array's `collectionFormat`, are comma-separated or ignored too (`SWAGGER_UNSUPPORTED_COLLECTION_FORMAT`).
- A global `in: formData` parameter is not a component: operations that use it carry it in their request body.
- The converter drops `additionalItems` (`SWAGGER_NOT_CONVERTED`), but copies the other JSON Schema keywords the 2.0 Schema Object does not allow (`patternProperties`, `dependencies`, `const`, `id`, `$schema`, `definitions`) as written, because generated tools use them. The converted document is then **not valid OpenAPI 3.0**: the official 3.0 schema rejects each of them (a Schema Object with `patternProperties`, `const`, `dependencies`, `id`, `$schema` or `definitions` does not validate), although the document converts and generates tools.
- An `oauth2` definition with an unknown `flow`, or a definition of an unknown `type`, is not converted. A requirement that names it is dropped (`UNRESOLVED_SECURITY_SCHEME`) and an operation left with no requirement is skipped (`UNSATISFIABLE_SECURITY`), whether or not other schemes exist; an operation with another requirement that names a convertible scheme is generated with that one.
- `ws` and `wss` in `schemes` make no server: an HTTP operation is never sent over them. A document whose `schemes` holds only those takes the scheme of its retrieval URI, else `https` (`SWAGGER_ASSUMED_SCHEME`).
- Limits (see [Limits](#limits)): at most 32 distinct media types are kept from one `consumes` or `produces` list, and a conversion that would create more than 1,000,000 entries (media types of bodies and responses, form encodings, response headers, form properties) is refused with a `ParseError`.
- A form with a file field is sent only as `multipart/form-data`, even when `consumes` lists only urlencoded; a 2.0 form has no way to say a part's `contentType` or headers.
- With `validate: false`, a `formData` parameter without a usable `name` is dropped (`SWAGGER_INVALID_VALUE`); validation rejects the document (`MISSING_PARAMETER_NAME`).
- What the two languages cannot say in the same words is listed under [What is not the same as writing the API in OpenAPI 3](#what-is-not-the-same-as-writing-the-api-in-openapi-3): the body parameter's name, media types appearing only where used, `type: file` against `format: binary`, one OAuth flow per scheme.

**OpenAPI 3.2**

- The 3.2 features marked "Not yet (planned)" in the table above.
- The new security scheme fields (`oauth2MetadataUrl`, `deprecated`, the `deviceAuthorization` flow) are typed but not surfaced in `metadata.security`.
- Tag `parent` is not used by `includeTags` / `excludeTags`: filtering by a parent tag does not include operations tagged with its children.
- An operation that streams on `200` (an `itemSchema` and no `schema`) and returns a JSON error on `404` has an `outputSchema` that describes the error alone: the stream is in `metadata.responseStream`.

**Every version**

- A preferred media type that has no schema hides a sibling media type that does: `application/json: {}` next to a `text/plain` schema produces no output schema.
- A multipart part is marked as a file (`serialization.binary: true` on its mapper entry) for `format: binary` and for a schema with `contentMediaType` and no `type`, but not for the bare OpenAPI 3.1+ spelling of a binary part (`{}`, or a schema with only a `description`), nor for `type: string` with `contentMediaType` (read as an embedded string payload, not a file). With a `Blob` the request is the same under all five: each goes out as a file part with the `Blob`'s content type, because `buildHttpRequest` decides a file part from the value, so only what reads the mapper sees the difference. Write `type: string, format: binary` (the spelling the official 3.1 and 3.2 test document `media-type-examples.yaml` uses for a binary part) to have the part marked.
- A whole request body of `application/octet-stream` whose schema is `{}` or has only a `description` (in OpenAPI 3.0 and 3.1+ alike), or is `type: string` with `contentMediaType` (3.1+), is not marked binary: a `Uint8Array` given as `body` is sent as JSON text (`{"0":1,"1":2,"2":3}`) under `content-type: application/octet-stream`. Write the schema as `type: string, format: binary`, or in 3.1+ as `contentMediaType: application/octet-stream` with no `type`: the builder then sends the bytes untouched (`Uint8Array`, `Blob` or string).
- In a document declaring OpenAPI 3.0, a tuple `items` (a list of schemas, the JSON Schema draft-04 form that 3.0 does not allow) and `additionalItems` are left as written in the tool's schema, with no diagnostic and no `validate()` warning, so the tool's JSON Schema 2020-12 schema is invalid there (Ajv's 2020 dialect refuses it: `items must be object,boolean`); the same happens in a 3.1 document that uses the draft-04 form instead of `prefixItems`. Only a Swagger 2.0 document is converted: its tuple `items` becomes `items: {}` and `additionalItems` is dropped (`SWAGGER_NOT_CONVERTED`).
- With `validate: false`, a path parameter with an explicit `required: false` stays optional in a tool of an OpenAPI 3 document (validation rejects it with `PATH_PARAMETER_NOT_REQUIRED`; the Swagger 2.0 conversion makes every path parameter required): a call that leaves it out fails with `Unresolved path parameters remain`.
- Path-level `servers` are ignored. Operation-level and document-level `servers` are used.
- A `$ref` with sibling keywords (`$ref` plus `description`) keeps only the target when the library dereferences internal references itself; external references keep the siblings.
- The delimiter of a non-exploded array is percent-encoded: `style: form` with `explode: false` is sent as `ids=1%2C2%2C3`, `pipeDelimited` as `ids=1%7C2%7C3` and `spaceDelimited` as `ids=1%202%203` in a query (`+` in a form). OpenAPI 3.2.1 says the delimiters are not percent-encoded; servers generally accept both. `allowReserved: true` keeps the comma raw (`ids=1,2,3`) but not `|`.
- A `spaceDelimited` or `pipeDelimited` **object** is comma-joined (`o=a%2C1%2Cb%2C2`), as is `form` with `explode: false`: the specification gives no delimiter form for them.
- The indexed array conventions that go beyond the specification (`expand[0]`, `line_items[0][price]`, `items[][key]`) are not produced, so an array of objects in a form field, a `deepObject` or a query parameter is a `RequestBuildError`.
- Only the `encoding` map of the media type is read. The OpenAPI 3.2 `prefixEncoding` and `itemEncoding`, and an Encoding Object's own nested `encoding` (for a multipart part that is itself multipart), are not.
- Several files in one multipart field are sent as a single part of JSON text (`[{},{}]`) when the field has no Encoding Object: give it one with a `contentType` (each file is then its own part). With `explode` or another style, an array of files is a `RequestBuildError`.
- An Encoding Object `headers` entry is sent in a multipart part only when its `schema` fixes one value (`const`, or an `enum` of one member): a Header Object has no value of its own and the input has no place for one.
- A document with no retrieval URI (`fromJSON` or `fromYAML` without `documentUri`) resolves a relative external `$ref` against an absolute `$self` when it has one, and otherwise against the process working directory. With a retrieval URI (`fromURL`, `fromFile`, `documentUri`) it resolves against that, whatever `$self` says.
- A local reference (`#/...`) keeps the reading it always had: its percent-escapes are not decoded (`#/components/schemas/My%20Pet` finds nothing), and a pointer that leads nowhere becomes `{}` without an error. Only a reference that names the document by its URI is decoded and checked (rule `missing-target`).
- The `$self` of a document reached through a `$ref` is not read: a relative reference inside it resolves against the URL or path it was fetched from.
- A relative reference under a Schema Object with its own `$id` resolves against that `$id` in a document declaring 3.1, because the reference resolver applies nested `$id` scopes there. In a document declaring 3.0 or 3.2 it resolves against the document's base URI instead. Under a Schema Object with its own `$id`, only an absolute `$ref` that names the document's own URI is rewritten to a local reference (a relative one is not), and not even that one in a document where the reference resolver applies `$id` scopes (declaring 3.1, or naming a JSON Schema dialect or an `$id` of its own) and another document has to be read: it is left as written.
- A `$ref` to the document's own URI is resolved locally only when its fragment is empty or a JSON Pointer; a plain-name fragment (`#Pet`, an `$anchor`) is left to the reference resolver.
- A Security Requirement that names a scheme by the URI of another document is dropped (`UNRESOLVED_SECURITY_SCHEME`); schemes of other documents are never read.
- A request body media type that carries parameters is matched whole. `application/x-www-form-urlencoded; charset=utf-8` is not recognized as a form, so an object body is sent as JSON text under that `content-type` header (`{"a":"x y","n":1}`); `multipart/form-data; boundary=x` is sent the same way, as JSON text, with that header. `application/json; charset=utf-8` happens to work, because an object is written as JSON anyway. Media types of `content` parameters and whole queries are compared without their parameters and are not affected.
- A cookie parameter with the default `form` style is sent without percent-encoding, where OpenAPI 3.2.1 describes percent-encoded form cookies: a value with a space or `;` throws a `RequestBuildError` instead of being encoded, and `%` and non-ASCII characters up to U+00FF are sent as they are.

---

**Related:** [API Reference](./api-reference.md) | [Configuration](./configuration.md) | [Error Handling](./error-handling.md) | [Architecture](./architecture.md)
