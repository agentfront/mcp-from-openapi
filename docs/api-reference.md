# API Reference

[Home](../README.md) | [Getting Started](./getting-started.md) | [Configuration](./configuration.md) | [Examples](./examples.md)

Complete reference for all exports from `mcp-from-openapi`.

---

## Classes

### OpenAPIToolGenerator

Main entry point. Loads OpenAPI specs and generates MCP tool definitions.

```typescript
import { OpenAPIToolGenerator } from "mcp-from-openapi";
```

#### Static Factory Methods

```typescript
static async fromURL(url: string, options?: LoadOptions): Promise<OpenAPIToolGenerator>
static async fromFile(filePath: string, options?: LoadOptions): Promise<OpenAPIToolGenerator>
static async fromYAML(yaml: string, options?: LoadOptions): Promise<OpenAPIToolGenerator>
static async fromJSON(json: object, options?: LoadOptions): Promise<OpenAPIToolGenerator>
```

**Base URI.** A relative external `$ref` is read against the document's retrieval URI: the final URL after redirects for `fromURL` (without user information or fragment), the file's `file:` URL for `fromFile`, or `LoadOptions.documentUri`, which replaces both. `fromJSON` and `fromYAML` have none without `documentUri`: relative references then resolve against an absolute `$self` (OpenAPI 3.2) or else the process working directory. With a retrieval URI, `$self` only names the document (a `$ref` to it, or a Security Requirement key, is local) and never moves where references are read from. A bad `documentUri` (not an absolute `http`, `https` or `file` URI of at most 2,048 characters, or with user information, a fragment, or a host in a `file:` URI) throws a `LoadError` (context `documentUri`) before anything is fetched or read. A relative reference still has to pass `refResolution`: reading files next to a `fromFile` document needs `file` in `allowedProtocols`. See [Multi-file Specifications](./getting-started.md#multi-file-specifications) and [SSRF Prevention](./ssrf-prevention.md#base-uris-and-relative-references).

#### Instance Methods

```typescript
async generateTools(options?: GenerateOptions): Promise<McpOpenAPITool[]>
async generateTool(path: string, method: string, options?: GenerateOptions): Promise<McpOpenAPITool>
getDocument(): OpenAPIDocument
async validate(): Promise<ValidationResult>
async lint(): Promise<LintResult>
getDiagnostics(): SpecDiagnostic[]
getSpecVersion(): SpecVersionInfo
```

**`generateTool(path, method)`**: `method` is a standard method in any case (`'get'`, `'GET'`, `'query'`) or an OpenAPI 3.2 `additionalOperations` method exactly as written in the document (`'LINK'` finds `LINK`; `'link'` does not). Only the operations the declared version defines are found: `query` and `additionalOperations` exist from 3.2 on, so `generateTool('/search', 'query')` on a 3.1 document throws `Operation not found`, and so does `'trace'` on a Swagger 2.0 document. The tool's `metadata.method` is the canonical form: the lowercase field name of a standard method, the key as written otherwise. It throws a `GenerationError` (context `path`, `method`, `pointer`) for an operation that `generateTools()` skips with a diagnostic: a parameter in a location the library does not map, such as an `in: body` in an OpenAPI 3 document (`UNSUPPORTED_PARAMETER_LOCATION`; a Swagger 2.0 body parameter is converted before this), parameters that break an OpenAPI 3.2 rule on `in: querystring` (`MULTIPLE_QUERYSTRING_PARAMETERS`, `QUERYSTRING_WITH_QUERY_PARAMETERS`, `QUERYSTRING_PARAMETER_WITHOUT_CONTENT`; with `validate: true` the validator rejects such a document first), or no Security Requirement that can be satisfied (`UNSATISFIABLE_SECURITY`).

**`generateTools()` / `generateTool()` and validation**: with `validate: true` (the default) the first call validates the document (after dereferencing, when that is on) and later calls reuse the result. A document that fails throws a `ParseError` whose message is `Invalid OpenAPI document: <first error>` (with `(and N more; see the error's context.errors)` when there are more) and whose `context.errors` is the full `ValidationErrorDetail[]`. The quoted first error is cut at 512 characters and any control or bidirectional character in it is written as `\uXXXX`, so the message is safe to log; `context.errors` is not altered. `validate()` is separate: see below.

**`validate()`** validates the document with the rules of the version it declares and returns a `ValidationResult` (`valid: false` for a document that breaks a rule, no throw), whatever the `validate` load option says, and records no diagnostics. When `dereference` is on (the default) and the document holds a `$ref` that does not start with `#`, it dereferences first and validates the result, as generation does: it can read files and make network requests, under exactly the `refResolution` gates, SSRF protections and redirect rules of generation, and `getDocument()` returns the dereferenced document afterwards. A reference to the document's own URI is made local and reads nothing. A reference that cannot be read (refused by a rule, missing, not JSON or YAML, a pointer that leads nowhere, ...) does **not** throw: the result is `{ valid: false, errors: [{ code: 'UNREADABLE_REFERENCE', message, path }] }`, where `message` is the text of the `ParseError` generation throws (without its `Failed to dereference OpenAPI document:` prefix), bounded and escaped, and `path` the JSON Pointer of the `$ref` when it is in this document (absent otherwise). Only a document JSON cannot copy (a YAML alias that makes it contain itself) still throws the `ParseError`, as generation does. The dereference happens at most once per generator: `generateTools()` after `validate()` reuses it, and the reverse, concurrent calls share one, and after a failure the next call tries again. A document with only `#` references, or any document when `dereference` is `false`, is validated as loaded without reading anything. A Swagger 2.0 document is validated as written, with the 2.0 rules (`validate()` never converts it); loaded with `dereference: false`, which the conversion cannot read, the result is `{ valid: false, errors: [{ code: 'DEREFERENCE_REQUIRED', message, path: '/swagger' }] }` and nothing else.

**`getDiagnostics()`** returns what the generator noticed without failing, in the order it was first noticed, each finding once (a copy; changing it changes nothing). It grows as the generator works: at load, a problem with the declared version (a 3.x minor newer than 3.2, `openapi` and `swagger` together, a version that cannot be processed) and why `$self` is not used when it is present and ignored (`INVALID_SELF`, `REFUSED_SELF`, `UNRESOLVABLE_SELF`, or `FEATURE_NEWER_THAN_DECLARED_VERSION` in a 3.0 or 3.1 document), and a retrieval URI too long to be used (`BASE_URI_TOO_LONG`); then the validator's warnings at the first generation with `validate: true`; for a Swagger 2.0 document, what its conversion to OpenAPI 3.0 could not carry over exactly (the `SWAGGER_*` codes); and the constructs generation skipped or ignored. The declared version itself is not in it: `getSpecVersion()` reports it. `severity` is `'warning'`, except three Swagger 2.0 conversion notes that change nothing a tool does (`SWAGGER_UNKNOWN_FIELD`, `SWAGGER_ASSUMED_MEDIA_TYPE`, and `SWAGGER_NOT_CONVERTED` for a global `in: formData` parameter), which are `'info'`. It keeps at most `MAX_DIAGNOSTICS` (1,000) distinct findings, warnings in preference to infos: once the list is full a new warning takes the place of the most recently recorded info and a new info is not recorded, and one final `DIAGNOSTICS_TRUNCATED` entry says how many warnings and infos were not recorded. For a Swagger 2.0 document every entry with a `path` has `document`, which says whether `path` points into the 2.0 document as written (`'source'`) or into its conversion (`'converted'`); the converter reports a finding that applies to several places once, naming the first three. See [OpenAPI Versions](./openapi-versions.md#diagnostics) for every code and the limits on quoted text and `path`.

```typescript
interface SpecDiagnostic {
  severity: "warning" | "info";
  code: string; // a DIAGNOSTIC_CODES value, e.g. 'FEATURE_NEWER_THAN_DECLARED_VERSION'
  message: string;
  path?: string; // JSON Pointer (RFC 6901) into the document; display-only when a segment was cut or escaped
  document?: "source" | "converted"; // Swagger 2.0 only: which document `path` points into; absent for every other document
}
```

**`getSpecVersion()`** returns the declared version as `detectSpecVersion` reads it (after overlays), as a copy. `status` says whether the version can be processed and `family` which rules apply. A Swagger 2.0 document reports `{ status: 'supported', field: 'swagger', family: '2.0' }`, before and after its conversion.

**`lint()`** lints the overlay-patched, dereferenced document for agent-readiness (see [Curation](./curation.md#lint)); validation never gates it. A Swagger 2.0 document is converted first and its OpenAPI 3.0 form is linted, so the findings are those of its tools; loaded with `dereference: false` it throws the `ParseError` of `DEREFERENCE_REQUIRED`.

**`getDocument()`** returns the generator's own document (not a copy): as loaded after overlays, dereferenced once generation, `lint()` or `validate()` (for a document that references other documents) has run, and, for a Swagger 2.0 document, the OpenAPI 3.0.3 conversion once generation or `lint()` has run. See [The three states of `getDocument()`](./openapi-versions.md#the-three-states-of-getdocument).

---

### SecurityResolver

Framework-agnostic authentication resolver. Maps OpenAPI security schemes to actual auth values (headers, query params, cookies).

```typescript
import { SecurityResolver } from "mcp-from-openapi";
```

#### Methods

```typescript
async resolve(mappers: ParameterMapper[], context: SecurityContext): Promise<ResolvedSecurity>
async checkMissingSecurity(mappers: ParameterMapper[], context: SecurityContext): Promise<string[]>
async signRequest(mappers: ParameterMapper[], signatureData: SignatureData, context: SecurityContext): Promise<Record<string, string>>
```

See [Security](./security.md) for detailed usage.

---

### SchemaBuilder

Static utility class for building and manipulating JSON schemas.

```typescript
import { SchemaBuilder } from "mcp-from-openapi";
```

See [SchemaBuilder](./schema-builder.md) for all methods.

---

### ParameterResolver

Resolves parameters from OpenAPI operations, detects naming conflicts, and generates input schemas with mapper entries.

```typescript
import { ParameterResolver } from "mcp-from-openapi";

new ParameterResolver(namingStrategy?: NamingStrategy, options?: {
  includeExamples?: boolean;
  schemaConversion?: SchemaConversionOptions; // unbounded when omitted
});
```

#### Methods

```typescript
resolve(
  operation: OperationObject,
  pathParameters?: ParameterObject[],
  securityRequirements?: SecurityRequirement[],
  includeSecurityInInput?: boolean | string[],
  securityAlternatives?: SecurityRequirement[][] // the requirement objects; more than one is a choice
): { inputSchema: JsonSchema; mapper: ParameterMapper[]; ignored: IgnoredParameter[] }
```

- `pathParameters` are the path item's parameters. An operation-level parameter with the same `name` and `in` overrides a path-level one (a header name in any case; the operation's spelling is used), and of several with the same `name` and `in` in one list the last is used. The same name in different locations is a conflict, renamed by the naming strategy. See [Parameter Conflicts](./parameter-conflicts.md#same-name-and-location-the-operation-wins).
- A parameter defined with `content` takes its input schema from the media type's `schema` (a media type with none gives `{}` for a JSON media type (`application/json`, `application/*+json`), `{ type: 'object' }` for `application/x-www-form-urlencoded` and `{ type: 'string' }` otherwise); its mapper entry has `serialization.contentType` (and `encoding`) and no `style`, `explode` or `allowReserved`. A parameter with both `schema` and `content` is read as `schema`.
- An OpenAPI 3.2 `in: querystring` parameter becomes a `type: 'query'` mapper entry with `wholeQuery: true`.
- An `in: path` parameter is always required, whatever its `required` says. A field of another type than the specification gives it is read as absent: `required` counts only when `true`, a `description` only when a string, a `schema` only when an object or a boolean (else `{ type: 'string' }`). A `request body` whose `content` holds no media type is no body.
- Every input key is unique: a conflict rename never takes a key another input uses, and a security input whose scheme name is taken gets a number (`api_key2`). A scheme named in several requirements is one entry.
- `ignored` lists the parameters left out (`{ name, in, reason }`): a header parameter the HTTP client, a credential or a proxy sets (`Accept`, `Content-Type`, `Authorization`, `Host`, `Content-Length`, `Cookie`, `X-Forwarded-*`, ...), and a parameter in the same location and with the same name as a credential of `securityRequirements`. The generator reports each as `PARAMETER_IGNORED`.
- It throws a `GenerationError` (context `code`) when the parameters break a querystring rule: more than one `in: querystring`, one next to `in: query` parameters, or one without `content` holding a media type. `OpenAPIToolGenerator` checks the rules first and skips the operation with a diagnostic.

#### Input schema annotations

Each property of the input schema carries annotations that mirror its mapper entry:

| Annotation | Set when |
| --- | --- |
| `x-parameter-location` | Every parameter and body property: `path`, `query`, `header`, `cookie` or `body` (not a security input). A whole-query parameter is `query` |
| `x-mcp-header` | A header: the wire header name, which a conflict rename does not change |
| `x-parameter-style` | The parameter declares a `style` (never for a parameter defined with `content`) |
| `x-parameter-explode` | The parameter declares `explode` (never for a parameter defined with `content`) |
| `x-parameter-content-type` | The parameter is defined with `content`: the media type its value is serialized in |
| `x-parameter-whole-query` | `true` for an `in: querystring` parameter |

Output schemas are annotated `x-status-code` and `x-content-type`. The `x-` annotations are ignored for typing ([Type Signatures](./type-signatures.md)).

---

### ResponseBuilder

Extracts and combines response schemas from OpenAPI operations.

```typescript
import { ResponseBuilder } from "mcp-from-openapi";

new ResponseBuilder(options?: GenerateOptions, schemaConversion?: SchemaConversionOptions);
```

#### Methods

```typescript
build(responses?: ResponsesObject): JsonSchema | undefined
buildStream(responses?: ResponsesObject): ResponseStreamInfo | undefined
statuses(responses?: ResponsesObject): Array<number | ResponseStatusRange>
```

`build` returns the output schema: one response's schema, or an `anyOf` of several. A media type with only `itemSchema` contributes nothing to it. `statuses` returns the status of each response `build` reads, in its order (a code, a range, `0` for `default`); the generator takes `metadata.responseStatusCodes` and `responseStatusRanges` from it. Only a three-digit code from `100` to `599`, a range or `default` is a response key; any other key is skipped. With `includeAllResponses: false` the response is chosen by `preferredStatusCodes` (see [Response Schemas](./response-schemas.md#selection-priority)); a response key `2XX` (any case) is a range, kept as `'2XX'` in `x-status-code`. `buildStream` returns the streamed response (OpenAPI 3.2 `itemSchema`): of the responses with a media type that declares `itemSchema`, the one `preferredStatusCodes` prefers (same order as for the output schema, ranges included); within it, the first such media type in document order, chosen apart from the one `build` reads (a response offering `application/json` and `text/event-stream` gives both). The item schema is converted with the same limits. `generateTool()` calls both and stores the second in `metadata.responseStream`. A response with no `description` uses its `summary` as the description. See [Response Schemas](./response-schemas.md).

#### SchemaConversionOptions

Limits for converting OpenAPI schemas, used by `ParameterResolver` and `ResponseBuilder`. The generator sets them from `maxSchemaDepth` / `maxSchemaNodes`; standalone, both default to unbounded.

```typescript
interface SchemaConversionOptions {
  // Stop descending below this depth; deeper subschemas become `{}` placeholders.
  // allOf members don't consume depth. SchemaBuilder.truncateDepth(schema, maxDepth)
  // removes every placeholder.
  maxDepth?: number;
  // Throw a SchemaError once one conversion visits more than this many nodes
  // (converted, reused, or placeholder), bounding its time and memory.
  maxNodes?: number;
}
```

A schema reused through `$ref` is converted once and shared, so the returned schemas can share nested objects. Treat them as read-only below the root, or copy them with `SchemaBuilder.truncateDepth`, which always returns an unshared tree.

See [Response Schemas](./response-schemas.md) for details.

---

### Validator

Validates Swagger 2.0 and OpenAPI 3.0.x, 3.1.x and 3.2.x documents with the rules of the version the document declares (a Swagger 2.0 document as written, not its conversion). A newer 3.x minor version is valid with a `NEWER_OPENAPI_VERSION` warning and is checked with the 3.2 rules; other major or minor versions of Swagger or OpenAPI, malformed and missing versions are errors. See [OpenAPI Versions](./openapi-versions.md).

```typescript
import { Validator } from "mcp-from-openapi";
```

#### Methods

```typescript
async validate(document: object): Promise<ValidationResult>
```

Accepts any object, like the generator's factories.

#### Codes

Errors (`valid: false`):

| Code | Reported when |
| --- | --- |
| `MISSING_OPENAPI_VERSION` | The document has neither `openapi` nor `swagger` |
| `INVALID_OPENAPI_VERSION` | The version cannot be processed: another major or minor version of Swagger (`1.2`, `2.1`) or OpenAPI, a malformed value |
| `MISSING_INFO`, `MISSING_TITLE`, `MISSING_VERSION` | `info`, `info.title` or `info.version` is missing |
| `INVALID_PATH_FORMAT` | A path does not start with `/` |
| `NO_RESPONSES` | An operation has no `responses` (required in Swagger 2.0 and 3.0 only) or has an empty `responses` (any version) |
| `MISSING_PATH_PARAMETER` | A path template variable has no matching `in: path` parameter |
| `INVALID_PARAMETER` | An entry of a `parameters` list is not an object, or has a `$ref` that is not a string (only a string `$ref` makes a Reference Object) |
| `MISSING_PARAMETER_NAME`, `MISSING_PARAMETER_IN` | A parameter has no `name` or no `in` |
| `INVALID_PARAMETER_NAME` | A `header` or `cookie` parameter's `name` is not an HTTP token (it is sent as written), or a parameter's `name` is an array or an object (a number or a boolean is read as its text, with a `PARAMETER_NAME_NOT_STRING` warning). Its `path` is a JSON Pointer |
| `INVALID_BASE_PATH` | Swagger 2.0: `basePath` does not start with `/`, or cannot be used in a URL (not a string, or holds `{`, `}`, whitespace, `?`, `#`, a backslash or a `.` or `..` segment). Its `path` is `/basePath` |
| `INVALID_PARAMETER_IN` | `in` is not a location of the declared version (Swagger 2.0: `path`, `query`, `header`, `formData`, `body`; 3.0 and 3.1: `path`, `query`, `header`, `cookie`; 3.2 adds `querystring`) |
| `PATH_PARAMETER_NOT_REQUIRED` | An `in: path` parameter is not `required: true` (also in Swagger 2.0, where the conversion would otherwise read it as required) |
| `MISSING_PARAMETER_SCHEMA` | A parameter has neither `schema` nor `content` (an `in: querystring` parameter needs `content` with a media type). In Swagger 2.0: a body parameter without `schema`, or any other parameter without `type` |
| `SWAGGER_MULTIPLE_BODY_PARAMETERS` | Swagger 2.0: an operation has more than one `in: body` parameter (the path item's count) |
| `SWAGGER_BODY_AND_FORM_DATA` | Swagger 2.0: an operation has an `in: body` parameter and `in: formData` parameters (the path item's count) |
| `MULTIPLE_QUERYSTRING_PARAMETERS` | An operation has more than one `in: querystring` parameter (the path item's count, after an operation-level parameter overrides a path-level one) |
| `QUERYSTRING_WITH_QUERY_PARAMETERS` | An operation combines an `in: querystring` parameter with `in: query` parameters (the path item's included) |
| `QUERYSTRING_PARAMETER_WITHOUT_CONTENT` | An `in: querystring` parameter has no `content`, or one that holds no media type |
| `OPERATION_NOT_OBJECT` | A method field, or an `additionalOperations` value, is not an object (`get: "x"`). A fixed field holding `null` is skipped without a finding |
| `ADDITIONAL_OPERATIONS_NOT_OBJECT` | `additionalOperations` is not an object (read only when the document declares 3.2 or newer) |
| `INVALID_SELF` | `$self` (read when the document declares 3.2 or newer) is not a string in the form of a URI reference, or has a fragment. The generator also records it at load and ignores the field |
| `UNREADABLE_REFERENCE` | Returned by `generator.validate()`, never by `Validator.validate()`: a `$ref` the generator could not read (see above) |
| `DEREFERENCE_REQUIRED` | Returned by `generator.validate()`, never by `Validator.validate()`: a Swagger 2.0 document loaded with `dereference: false` (see above) |
| `INVALID_METHOD_TOKEN` | An `additionalOperations` key is not an HTTP method token (RFC 9110) |
| `DUPLICATE_FIXED_METHOD` | An `additionalOperations` key is the upper-case name of a method that has its own field (`GET`, `QUERY`) |
| `INVALID_SECURITY_SCHEME` | The scheme map (`components.securitySchemes`, Swagger 2.0: `securityDefinitions`) is present but not a map, or a security scheme (Swagger 2.0: definition) has a `type` the declared version does not define, or an `apiKey` scheme has an `in` it does not define or no `name`; values compare exactly (Swagger 2.0: `basic`, `apiKey`, `oauth2`, in `header`/`query`; 3.0: `apiKey`, `http`, `oauth2`, `openIdConnect`, in `header`/`query`/`cookie`; 3.1 and 3.2 add `mutualTLS`) |
| `INVALID_FIELD_TYPE` | A field generation reads has another type than the official schema gives it: `parameters`, `servers` and `security` must be arrays, `responses` an object, `operationId`, `info.title`, `info.version`, a server `url` and a parameter `description` strings, `deprecated` and a parameter `required` booleans, a parameter `schema` a Schema Object or a boolean; each server, Security Requirement and response must be an object (a response map's `x-` extensions hold any value). A falsy value reads as absent, as generation reads it |

Warnings:

| Code | Reported when |
| --- | --- |
| `NO_PATHS`, `NO_SERVERS`, `NO_OPERATIONS`, `NO_OPERATION_ID`, `NO_SECURITY_SCHEMES` | No paths or servers (Swagger 2.0: no `host`), a path without operations, an operation without `operationId`, security requirements without schemes (Swagger 2.0: without `securityDefinitions`) |
| `NEWER_OPENAPI_VERSION` | The document declares a 3.x minor version newer than 3.2 |
| `PARAMETER_NAME_NOT_STRING` | A parameter's `name` is a number or a boolean (YAML reads an unquoted `2024` or `true` so): it is read as its text (`"2024"`), in every version |
| `CONFLICTING_VERSION_FIELDS` | The document declares both `openapi` and `swagger` (`swagger` is ignored) |
| `FEATURE_NEWER_THAN_DECLARED_VERSION` | A `query` operation or `additionalOperations` in a document declaring 3.0 or 3.1 (not read, so no tool and not validated), `$self` in such a document (not read), or an `in: querystring` parameter in such a document (which is read all the same); in a Swagger 2.0 document, a `trace`, `query` or `additionalOperations` field in a Path Item (not read) |
| `INVALID_PARAMETER_CONTENT` | A parameter's `content` cannot be read as OpenAPI defines it, and the message says what is done instead: several media types (one is used), none or not a map (ignored), a `schema` next to it (`schema` is used; `content` for `in: querystring`), a media type that is not an object, or one with `itemSchema` (not read for a parameter). A media type left as an unresolved `$ref` is reported by generation only |
| `DUPLICATE_PARAMETER` | A parameter list (a path item's or an operation's) repeats a `name` and `in` (a header name in any case); the last one is used, an exact repeat of an `in: querystring` parameter included. An operation-level parameter that overrides a path-level one is not a duplicate |
| `PATH_ITEM_NOT_OBJECT` | A path item is not an object; it holds no operations |
| `METHOD_CASE_VARIANT` | An `additionalOperations` key is another case of a method that has its own field (`post`, `Get`); the library sends such a method upper-cased, so the key is ignored |
| `REFUSED_METHOD` | An `additionalOperations` key is `CONNECT` in any case; it is ignored |
| `DIAGNOSTICS_TRUNCATED` | `errors` or `warnings` reached `MAX_DIAGNOSTICS` (1,000); it is the last entry of that list |

The codes of earlier releases and their `path` form (the path key unescaped, cut past `LEGACY_PATH_KEY_MAX_LENGTH` (1,024) characters, as in `/paths//pets/get/operationId`) are unchanged; every newer code carries an RFC 6901 JSON Pointer (`/paths/~1pets/get`), whose segments are escaped for display and capped at 256 characters (a pointer with a cut or escaped segment does not resolve). Text quoted from the document in a message is cut and escaped. `errors` and `warnings` each keep at most `MAX_DIAGNOSTICS` entries. The messages of the version errors name the supported versions (`Expected Swagger 2.0 or OpenAPI 3.0.x, 3.1.x or 3.2.x`).

---

## Utility Functions

### buildHttpRequest

Build a ready-to-send HTTP request from a tool and its input values — the full OpenAPI serialization table applied. See [Request Builder](./request-builder.md).

```typescript
buildHttpRequest(tool: McpOpenAPITool, input: Record<string, unknown>, options?: BuildHttpRequestOptions): BuiltHttpRequest

interface BuiltHttpRequest {
  url: string; // base + expanded path + encoded query; authoritative: send this
  method: string; // standard methods upper-case; additionalOperations methods as written
  headers: Record<string, string>;
  query: Record<string, string[]>; // pairs as sent (unencoded); {} for a non-form whole query
  queryString?: string; // the query exactly as in `url`; set only for a non-form whole query ('' when empty)
  cookies: Record<string, string>; // one value per name; the Cookie header carries every pair
  contentType?: string;
  body?: unknown;
  rawBody?: unknown;
}
```

Input values are read as own properties. It refuses a name the input chooses that the tool reserves for a credential or a sibling parameter, a header value or cookie value that cannot be sent, and a lone surrogate; it leaves a `null` property out of a form. It applies the Encoding Objects of form and multipart bodies and the `allowReserved` rules (`& = + # [ ]` are never left raw in a query value). A multipart body is a `FormData`, or a `Blob` the builder writes (with `content-type` and its boundary in `headers`) when a part needs a `Content-Type` or a header `FormData` cannot write. For `content` parameters, whole-query parameters (`wholeQuery`) and `style: cookie`, see [Request Builder](./request-builder.md). A `queryString` is never to be re-parsed as name/value pairs: [Do not rebuild the query string](./request-builder.md#do-not-rebuild-the-query-string).

### applyClientTarget

Apply a client dialect's schema transforms (`'claude' | 'openai' | 'gemini' | 'strict'`). The individual transforms (`inlineLocalRefs`, `ensureArrayItems`, `collapseRootCompositions`, `collapseNestedUnions`, `demoteFormats`, `enforceClosedObjects`) are exported too. See [Client Targets](./client-targets.md).

```typescript
applyClientTarget(schema: JsonSchema, target: ClientTarget, options?: ClientTargetOptions): JsonSchema
// ClientTargetOptions = { maxNodes?: number } — a node budget for inlining local $refs (unbounded when omitted)
```

### fromArazzo / parseRuntimeExpression

Convert an Arazzo 1.0 workflow document into consolidated MCP tools (one per workflow, IR on `metadata.workflow`); parse Arazzo runtime expressions standalone. Throws `ArazzoError` with a JSON-Pointer `path`. `FromArazzoOptions.onDiagnostic(diagnostic, source?)` receives the findings once every tool is made: a workflow schema cut shallower (`SCHEMA_DEPTH_REDUCED`), then the diagnostics of the generators made for raw sources (`source`: the source name). See [Arazzo Workflows](./arazzo.md).

```typescript
fromArazzo(document: ArazzoDocument | string, options: FromArazzoOptions): Promise<McpOpenAPITool[]>
parseRuntimeExpression(raw: string, docPath?: string): RuntimeExpressionAST
```

### deriveSecurityElicitations

Derive MCP-elicitation-compatible `{ message, requestedSchema }` credential requests from a tool's security data. See [Modern MCP Fields](./modern-mcp-fields.md).

```typescript
deriveSecurityElicitations(tool: McpOpenAPITool): SecurityElicitation[]
```

### dottedNaming

Naming preset producing two-segment `ns.method` tool names bindable by code-execution namespaces (FrontMCP CodeCall). See [Naming Strategies](./naming-strategies.md).

```typescript
dottedNaming(options?: DottedNamingOptions): NamingStrategy
```

### emitToolTypeScript / toPascalIdentifier

Render a tool's call contract as TypeScript text (one-line `signature` + self-contained `declaration`). Also emitted during generation via `GenerateOptions.emitTypeSignatures` as `metadata.typescript`. See [Type Signatures](./type-signatures.md).

```typescript
emitToolTypeScript(toolName: string, description: string | undefined, inputSchema: JsonSchema, outputSchema?: JsonSchema, options?: TypeSignatureOptions): ToolTypeScriptInfo
toPascalIdentifier(toolName: string): string
```

### analyzeToolSet / estimateToolTokens

Context-budget analysis: per-tool token estimates (heaviest first) and curation warnings. See [Curation](./curation.md).

```typescript
estimateToolTokens(tool: McpOpenAPITool): number
analyzeToolSet(tools: McpOpenAPITool[], options?: AnalyzeToolSetOptions): ToolSetReport
```

### applyOverlay

Apply an OpenAPI Overlay 1.0 document (deep-merge/append/replace updates, removals, JSONPath subset with filters and recursive descent). Also available at load time via `LoadOptions.overlays`. Throws `OverlayError` on malformed overlays or unsupported syntax. See [Curation](./curation.md).

```typescript
applyOverlay<T extends object>(document: T, overlay: OverlayDocument): T
```

### lintDocument

Agent-readiness lint with severity-ranked findings and fix hints; `generator.lint()` runs it on the overlay-patched, dereferenced document. A Swagger 2.0 document is converted to OpenAPI 3.0 first, so the findings are those of its tools (pass it dereferenced; a `$ref` left in it is not followed). When that conversion is abandoned at `MAX_CONVERSION_ENTRIES` it returns ONE finding, severity `error`, code `swagger-conversion-too-large`, `path` `''` (a finding about the whole document), instead of throwing or reading as clean; `generator.lint()` throws the generation `ParseError` (`context.code` `SWAGGER_CONVERSION_TOO_LARGE`). See [Curation](./curation.md).

```typescript
lintDocument(document: object): LintResult
```

### toSdkTool

Shape a tool for the official MCP SDK's `registerTool(name, config, handler)` — pass the SDK v2 `fromJsonSchema` to wrap schemas; without it, raw JSON Schemas are returned.

```typescript
toSdkTool(tool: McpOpenAPITool): [string, SdkToolConfig]
toSdkTool<TSchema>(tool: McpOpenAPITool, wrapper?: SdkSchemaWrapper<TSchema>): [string, SdkToolConfig<TSchema>]

// SdkSchemaWrapper<TSchema> = { fromJsonSchema: (schema: JsonSchema) => TSchema }
```

### inferAnnotationsFromMethod / extractExtensionOverrides / resolveExtensionEnabled

Annotation inference and `x-mcp` extension family parsing. `extractExtensionOverrides(operation, { maxMetaNodes })` throws a `SchemaError` when the extensions' `meta`, with its `$ref`s resolved, copies more than `maxMetaNodes` values (default `25000`) or nests more than 1,000 levels. See [Annotations & Extensions](./annotations.md).

### createSecurityContext

Helper to create a `SecurityContext` from partial auth data.

```typescript
import { createSecurityContext } from "mcp-from-openapi";

const context = createSecurityContext({
  jwt: process.env.JWT_TOKEN,
  apiKey: process.env.API_KEY,
});
```

### isReferenceObject

Type guard to check if an object is a JSON `$ref` reference.

```typescript
import { isReferenceObject } from "mcp-from-openapi";

if (isReferenceObject(schema)) {
  console.log(schema.$ref);
}
```

### toJsonSchema

Converts OpenAPI schema objects to JSON Schema format. Handles OpenAPI 3.0's boolean `exclusiveMinimum`/`exclusiveMaximum` conversion to numeric format, `nullable`, `example` and `xml`, and three Swagger 2.0 spellings, whatever version the document declares: `x-nullable` (when there is no `nullable`) is read as `nullable`, `type: file` is `type: string, format: binary`, and a string `discriminator` becomes `{ propertyName }`.

```typescript
toJsonSchema(schema: object | boolean, options?: SchemaConversionOptions): JsonSchema
```

The input is any object (a Schema or Reference Object of any OpenAPI version, or a schema-shaped object you built) or a boolean schema. A boolean schema converts to an object schema with the same meaning: `true` (any value) to `{}`, `false` (no value) to `{ not: {} }`, also as a member of `properties`, `prefixItems`, `allOf`, `anyOf`, `oneOf`, `patternProperties`, `dependentSchemas`, `$defs` and `definitions`. A boolean that JSON Schema allows as a keyword's own value (`additionalProperties`, `items: false`, `not: false`, `contains`, `propertyNames`, `if`/`then`/`else`, `contentSchema`, `unevaluated*`) is kept as written.

```typescript
import { toJsonSchema } from "mcp-from-openapi";

const jsonSchema = toJsonSchema(openApiSchema);
```

### upgradeSwagger2

Converts a **dereferenced** Swagger 2.0 document to OpenAPI 3.0 (`openapi: "3.0.3"`): the conversion the generator applies to a 2.0 document before it generates tools. It never throws, never mutates its input, and returns the new document with what could not be converted exactly. See [OpenAPI Versions](./openapi-versions.md#swagger-20) for every rule.

```typescript
upgradeSwagger2(document: unknown, options?: UpgradeSwagger2Options): UpgradeSwagger2Result

interface UpgradeSwagger2Options {
  documentUri?: string; // where the document was retrieved from: supplies the host and scheme a 2.0 document without `host` or `schemes` leaves out (an http or https URI; a ws or wss one supplies the host only; user information never used)
  maxEntries?: number; // the most entries the conversion may create; default and maximum MAX_CONVERSION_ENTRIES (1,000,000)
}

interface UpgradeSwagger2Result {
  document: OAS30.OpenAPIObject; // openapi: "3.0.3"
  diagnostics: SpecDiagnostic[]; // SWAGGER_* codes (and FEATURE_NEWER_THAN_DECLARED_VERSION), with `path` into the 2.0 document
  parameterIndexes: WeakMap<object, readonly number[]>; // for each converted `parameters` list, the index each entry has in the source list
  tooLarge?: true; // set when the conversion passed `maxEntries` and was abandoned: `document` has no paths
}
```

```typescript
import { upgradeSwagger2 } from "mcp-from-openapi";

const { document, diagnostics } = upgradeSwagger2(
  { swagger: "2.0", info: { title: "Pets", version: "1" }, basePath: "/v2", paths: {} },
  { documentUri: "https://api.example.com/swagger.json" },
);
document.servers; // [{ url: 'https://api.example.com/v2' }]
```

A value that is not an object gives an empty OpenAPI 3.0 document and a `SWAGGER_INVALID_VALUE` warning; a document that does not declare Swagger 2.0 is converted as if it did, with `SWAGGER_VERSION_NOT_2_0`. `options` that is `null`, not an object or holds a value of the wrong kind is read as absent.

Two limits bound what a document can make the conversion create, because a 2.0 `consumes`, `produces` and path-level parameter list is stated once and applies to every operation, so its 3.0 form repeats it per operation: at most `MAX_MEDIA_TYPES_PER_LIST` (32) distinct media types are kept from one `consumes` or `produces` list (`SWAGGER_MEDIA_TYPE_LIMIT`), and at most `MAX_CONVERSION_ENTRIES` (1,000,000) media type, encoding, header and form property entries are created in all. Past the second the result has `tooLarge: true` and the last diagnostic is `SWAGGER_CONVERSION_TOO_LARGE`; the generator's `generateTools()`, `generateTool()` and `lint()` throw a `ParseError` whose `context.code` is `SWAGGER_CONVERSION_TOO_LARGE`. Both constants are exported. See [Limits](./openapi-versions.md#limits).

---

## Operations and Versions

The functions that read a document's declared version and walk the operations of a Path Item. `generateTools()`, the validator, `lintDocument` and `fromArazzo` use them, so code that walks a document the same way sees the same operations. See [OpenAPI Versions](./openapi-versions.md).

### detectSpecVersion

Reads the version a document declares (`openapi`, or `swagger` when there is no `openapi`). Never throws; any value is accepted. `generator.getSpecVersion()` returns the same result for the loaded document.

```typescript
detectSpecVersion(document: unknown): SpecVersionInfo

interface SpecVersionInfo {
  status: "supported" | "newer-minor" | "unsupported" | "malformed" | "missing";
  field?: "openapi" | "swagger"; // where the version was read; undefined when missing
  declared?: unknown; // the value as read; undefined when missing
  major?: number; // unless malformed or missing
  minor?: number;
  family?: "2.0" | "3.0" | "3.1" | "3.2"; // the rules applied; set for 'supported' and 'newer-minor'
  diagnostics: SpecDiagnostic[]; // NEWER_OPENAPI_VERSION, CONFLICTING_VERSION_FIELDS
}
```

```typescript
import { detectSpecVersion } from "mcp-from-openapi";

detectSpecVersion({ openapi: "3.1.0" }).family; // '3.1'
detectSpecVersion({ openapi: "3.9.0" }).status; // 'newer-minor'
detectSpecVersion({ swagger: "2.0" }).family; // '2.0' (status 'supported', field 'swagger')
detectSpecVersion({ swagger: "1.2" }).status; // 'unsupported'
detectSpecVersion({ openapi: "3.1" }).status; // 'malformed'
detectSpecVersion({}).status; // 'missing'
```

### SUPPORTED_SPEC_VERSIONS

The versions the library reads, as `readonly string[]`: `['2.0', '3.0.x', '3.1.x', '3.2.x']`.

### resolveOperationLayout

The one place that decides which operations of a document are read. A `supported` or `newer-minor` version gets its family's layout: `query` and `additionalOperations` only from 3.2 on, and the seven methods of Swagger 2.0 (no `trace`). Any other status (`unsupported`, `malformed`, `missing`) gets the eight classic methods and no `additionalOperations`, exactly what the library read before OpenAPI 3.2 support.

```typescript
resolveOperationLayout(version: SpecVersionInfo): OperationLayout
```

```typescript
import { detectSpecVersion, resolveOperationLayout } from "mcp-from-openapi";

resolveOperationLayout(detectSpecVersion({ openapi: "3.1.0" })).additionalOperations; // false
resolveOperationLayout(detectSpecVersion({ openapi: "3.2.0" })).additionalOperations; // true
resolveOperationLayout(detectSpecVersion({ openapi: "3.2.0" })).fixedMethods.includes("query"); // true
resolveOperationLayout(detectSpecVersion({})).fixedMethods.includes("query"); // false
```

Pass its result as `layout` to `listOperations` and `getOperation` to read a document the way the generator does.

### listOperations / getOperation / isStandardMethod

```typescript
listOperations(pathItem: unknown, options?: ListOperationsOptions): OperationList
getOperation(pathItem: unknown, method: string, options?: GetOperationOptions): OperationEntry | undefined
isStandardMethod(method: unknown): boolean
```

```typescript
type StandardMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options" | "trace" | "query";

type OperationEntry =
  | { method: StandardMethod; operation: OperationObject; source: "fixed" }
  | { method: string; operation: OperationObject; source: "additional" };

interface OperationList {
  operations: OperationEntry[];
  diagnostics: SpecDiagnostic[]; // each value that was ignored, and why
}

interface OperationLayout {
  readonly fixedMethods: readonly StandardMethod[]; // the fixed fields read
  readonly additionalOperations: boolean; // whether `additionalOperations` is read
}

interface ListOperationsOptions {
  layout?: OperationLayout; // default: every fixed field and `additionalOperations`, whatever the document declares
  pointer?: string; // JSON Pointer of the path item, prefixed to diagnostics' `path`
}

interface GetOperationOptions {
  layout?: OperationLayout;
}
```

- `listOperations` lists the fixed fields in the order `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `trace`, `query`, then the `additionalOperations` entries sorted by key (code-unit order). A missing field is skipped silently; any other value that is ignored adds a warning diagnostic (`PATH_ITEM_NOT_OBJECT`, `OPERATION_NOT_OBJECT`, `ADDITIONAL_OPERATIONS_NOT_OBJECT`, `INVALID_METHOD_TOKEN`, `DUPLICATE_FIXED_METHOD`, `METHOD_CASE_VARIANT`, `REFUSED_METHOD`). Only the fields in the layout are read.
- For a fixed operation `method` is the lowercase field name; for an additional one it is the key as written (it may be any HTTP token, so never use it as a key of a plain object without checking `isStandardMethod`).
- `getOperation` finds the operation `listOperations` would list for `method`. A standard method in any case (`'GET'`) is looked up in its fixed field only. Any other method is looked up in `additionalOperations` and matched exactly as written: `'LINK'` does not find `link`, as for `generateTool`, `includeMethods` and Arazzo `operationPath`.
- Reads are own-property reads: a path item never yields `constructor` or `__proto__` from its prototype.
- `isStandardMethod` is true for a method that has a fixed field, in any case: `'GET'`, `'Query'` yes; `'LINK'`, a non-string no.

```typescript
import { listOperations, getOperation, isStandardMethod } from "mcp-from-openapi";

const pathItem = {
  get: { responses: {} },
  query: { responses: {} },
  additionalOperations: { LINK: { responses: {} }, GET: { responses: {} } },
};

const { operations, diagnostics } = listOperations(pathItem, { pointer: "/paths/~1files" });
operations.map((o) => `${o.method} (${o.source})`); // ['get (fixed)', 'query (fixed)', 'LINK (additional)']
diagnostics.map((d) => `${d.code} ${d.path}`); // ['DUPLICATE_FIXED_METHOD /paths/~1files/additionalOperations/GET']

getOperation(pathItem, "QUERY")?.method; // 'query'
getOperation(pathItem, "LINK")?.method; // 'LINK'
getOperation(pathItem, "link"); // undefined: an additional method matches exactly as written
isStandardMethod("Query"); // true
isStandardMethod("LINK"); // false
```

### DIAGNOSTIC_CODES / MAX_DIAGNOSTICS

`DIAGNOSTIC_CODES` is the one frozen registry of every code a diagnostic from `generator.getDiagnostics()` can carry (its keys equal its values); `DiagnosticCode` is the union of those strings. It holds the codes of the version and operation-walk logic (`NEWER_OPENAPI_VERSION`, `FEATURE_NEWER_THAN_DECLARED_VERSION`, `CONFLICTING_VERSION_FIELDS`, `PATH_ITEM_NOT_OBJECT`, `OPERATION_NOT_OBJECT`, `ADDITIONAL_OPERATIONS_NOT_OBJECT`, `INVALID_METHOD_TOKEN`, `DUPLICATE_FIXED_METHOD`, `METHOD_CASE_VARIANT`, `REFUSED_METHOD`), the Swagger 2.0 conversion's (`SWAGGER_VERSION_NOT_2_0`, `SWAGGER_INVALID_VALUE`, `SWAGGER_UNKNOWN_FIELD`, `SWAGGER_NOT_CONVERTED`, `SWAGGER_UNRESOLVED_REFERENCE`, `SWAGGER_RELATIVE_SERVER_URL`, `SWAGGER_ASSUMED_SCHEME`, `SWAGGER_ASSUMED_MEDIA_TYPE`, `SWAGGER_FORM_MEDIA_TYPE_ADDED`, `SWAGGER_MULTIPLE_BODY_PARAMETERS`, `SWAGGER_BODY_AND_FORM_DATA`, `SWAGGER_DUPLICATE_FORM_DATA_PARAMETER`, `SWAGGER_UNSUPPORTED_COLLECTION_FORMAT`, `SWAGGER_FILE_OUTSIDE_FORM_DATA`, `SWAGGER_UNSUPPORTED_SECURITY_SCHEME`, `SWAGGER_MEDIA_TYPE_LIMIT`, `SWAGGER_CONVERSION_TOO_LARGE`), the version errors (`INVALID_OPENAPI_VERSION`, `MISSING_OPENAPI_VERSION`), the validator warnings (`NO_PATHS`, `NO_OPERATIONS`, `NO_OPERATION_ID`, `DUPLICATE_OPERATION_ID`, `NO_SERVERS`, `NO_SECURITY_SCHEMES`), the document URIs' (`INVALID_SELF`, `REFUSED_SELF`, `UNRESOLVABLE_SELF`: why `$self` is ignored; `BASE_URI_TOO_LONG`: a retrieval URI that is not used), the generator's (`UNRESOLVED_SECURITY_SCHEME`, `INVALID_SECURITY_REQUIREMENT`, `UNSATISFIABLE_SECURITY`, `UNSUPPORTED_PARAMETER_LOCATION`, `UNSUPPORTED_STREAMING_REQUEST_BODY`, `REQUEST_BODY_WITHOUT_MEDIA_TYPE`, `TOOL_GENERATION_FAILED`, `UNRESOLVED_REFERENCE`, `PARAMETER_IGNORED`, `UNSUPPORTED_SECURITY_SCHEME`, `INVALID_RESPONSE_KEY`), the parameter rules (`MULTIPLE_QUERYSTRING_PARAMETERS`, `QUERYSTRING_WITH_QUERY_PARAMETERS`, `QUERYSTRING_PARAMETER_WITHOUT_CONTENT`, `INVALID_PARAMETER_CONTENT`, `DUPLICATE_PARAMETER`, `PARAMETER_NAME_NOT_STRING`, `INVALID_PARAMETER_NAME`), the generator's warnings about a tool that is made but cannot take some inputs (`COOKIE_CONTENT_NOT_SENDABLE`, `QUERYSTRING_WITH_QUERY_CREDENTIAL`, `REQUIRED_INPUT_ACCEPTS_NOTHING`), the warning about a schema cut shallower than `maxSchemaDepth` to fit `maxSchemaNodes` (`SCHEMA_DEPTH_REDUCED`) and `DIAGNOSTICS_TRUNCATED`. Each is described in [OpenAPI Versions](./openapi-versions.md#diagnostics).

`UNREADABLE_REFERENCE` and `DEREFERENCE_REQUIRED` are in the registry too but are never `getDiagnostics()` entries: they are the validation errors `generator.validate()` returns for a reference it cannot read and for a Swagger 2.0 document loaded with `dereference: false`. `MAX_DIAGNOSTICS` (`1000`) is the most findings one list keeps: `getDiagnostics()`, and each of a `ValidationResult`'s `errors` and `warnings`. `INVALID_BASE_PATH` and the other validation errors that are not in the registry (see [OpenAPI Versions](./openapi-versions.md#diagnostics)) only appear in a `ValidationResult` or in the `context.errors` of a `ParseError`. `LEGACY_PATH_KEY_MAX_LENGTH` (`1024`) is the longest path key the historical validation paths and messages quote.

```typescript
import { DIAGNOSTIC_CODES } from "mcp-from-openapi";

const unsupported = generator
  .getDiagnostics()
  .filter((d) => d.code === DIAGNOSTIC_CODES.UNSUPPORTED_PARAMETER_LOCATION);
```

### Types

`SpecDiagnostic`, `SpecDiagnosticSeverity` (`'warning' | 'info'`), `DiagnosticCode`, `SpecVersionInfo`, `SpecVersionStatus`, `SpecVersionField` (`'openapi' | 'swagger'`), `SpecFamily` (`'2.0' | '3.0' | '3.1' | '3.2'`), `StandardMethod`, `OperationEntry`, `OperationSource` (`'fixed' | 'additional'`), `OperationList`, `OperationLayout`, `ListOperationsOptions`, `GetOperationOptions`.

---

## Core Types

### McpOpenAPITool

The main output type -- a generated MCP tool definition.

```typescript
interface McpOpenAPITool<TMeta extends ToolMetadata = ToolMetadata> {
  name: string; // Normalized tool name (MCP name rules enforced)
  title?: string; // Display name (MCP Tool.title) from summary/extension
  description: string; // From operation summary/description (or extension override)
  annotations?: ToolAnnotations; // MCP behavior hints (inferred + extension overrides)
  inputSchema: JsonSchema; // Combined input schema (all params)
  outputSchema?: JsonSchema; // Response schema (an anyOf union for several responses)
  mapper: ParameterMapper[]; // Input -> request mapping
  metadata: TMeta; // Auth, servers, tags, etc. — extendable by frameworks
}
```

> **Note:** `JsonSchema` is the `JSONSchema` type from `zod/v4/core`, not `JSONSchema7`.

---

### ToolAnnotations

MCP tool annotations — behavior hints for clients. Inferred from HTTP method semantics by default and overridable via the `x-mcp` extension family. See [Annotations & Extensions](./annotations.md).

```typescript
interface ToolAnnotations {
  title?: string; // Legacy display-name slot; prefer tool-level `title`
  readOnlyHint?: boolean; // Tool only reads data
  destructiveHint?: boolean; // Tool may delete/overwrite state
  idempotentHint?: boolean; // Repeat calls have no additional effect
  openWorldHint?: boolean; // Tool touches an open world of external entities
}
```

---

### ParameterMapper

Maps input schema properties to their actual HTTP request locations.

```typescript
interface ParameterMapper {
  inputKey: string; // Property name in inputSchema
  type: ParameterLocation; // 'path' | 'query' | 'header' | 'cookie' | 'body'
  key: string; // Original parameter name
  required?: boolean;
  style?: string; // 'simple', 'form', 'matrix', 'cookie', etc.; absent for a parameter defined with `content`
  explode?: boolean; // Array/object explosion; absent for a parameter defined with `content`
  allowReserved?: boolean; // Applied in a query only: `: / ? @ ! $ ' ( ) * , ;` stay raw, `& = + # [ ]` are always encoded; absent for `content`
  serialization?: SerializationInfo; // Media type, encoding rules, binary marker
  wholeBody?: boolean; // Input value IS the entire request body
  wholeQuery?: true; // Input value IS the entire query string (OpenAPI 3.2 `in: querystring`)
  security?: SecurityParameterInfo; // Auth parameter metadata
}
```

`wholeBody` is set for non-object bodies (arrays, primitives, binary) and root `oneOf`/`anyOf` union bodies: send `input[inputKey]` directly as the request body instead of wrapping it in `{ [key]: value }`. See [SerializationInfo](#serializationinfo) for the content-type, encoding, and binary markers.

`wholeQuery` is set only on a `type: 'query'` entry, for an OpenAPI 3.2 parameter `in: querystring`: the input value is the entire query string, serialized in `serialization.contentType`, and `key` (the parameter's name) is never sent. An operation has at most one such entry and no other non-security `query` entry. See [Request Builder](./request-builder.md#whole-query-parameters).

A parameter defined with `content` has `serialization.contentType` (and `encoding`) and no `style`, `explode` or `allowReserved`. Only a `path`, `query`, `header` or `cookie` entry that is defined with `content`, or is a whole-query entry, carries `serialization`; one defined with `schema` does not.

---

### ToolMetadata

Additional metadata about the generated tool.

```typescript
interface ToolMetadata {
  path: string; // OpenAPI path (e.g., '/users/{id}')
  method: HTTPMethod; // lowercase field name ('get', 'query') or the additionalOperations key as written ('LINK')
  operationId?: string;
  operationSummary?: string; // Short description
  operationDescription?: string; // Detailed description
  tags?: string[];
  deprecated?: boolean;
  security?: SecurityRequirement[];
  securityAlternatives?: SecurityRequirement[][]; // With several requirement objects: each ([] for {}); any one authenticates
  servers?: ServerInfo[];
  responseStatusCodes?: number[]; // From output schema: each explicit code, and 0 for `default` (not a streamed response's)
  responseStatusRanges?: ResponseStatusRange[]; // From output schema: its range keys (`2XX`), upper-cased; absent when it has none
  externalDocs?: ExternalDocumentationObject;
  frontmcp?: FrontMcpExtensionData; // x-frontmcp extension data
  responseHints?: ResponseHints; // Paging/truncation/streaming signals; present only when there is something to say
  responseStream?: ResponseStreamInfo; // The streamed response (OpenAPI 3.2 `itemSchema`), apart from outputSchema
}
```

#### ResponseHints

```typescript
interface ResponseHints {
  unboundedArray?: boolean; // The output schema holds an array with no maxItems
  paginationParams?: string[]; // Query parameters that look like pagination controls (a whole-query parameter never counts)
  largeResponseRisk?: boolean; // Unbounded array and no pagination controls
  streaming?: boolean; // The operation streams its response: `responseStream` describes the items
}
```

#### ResponseStreamInfo

A streamed response: an OpenAPI 3.2 Media Type Object with `itemSchema`. It is reported here and never as `outputSchema`, because an MCP tool that declares an output schema must return structured content, which an unbounded stream is not. See [Response Schemas](./response-schemas.md#streaming-responses).

```typescript
type ResponseStatusRange = "1XX" | "2XX" | "3XX" | "4XX" | "5XX"; // an OpenAPI response range key, whatever its case in the document

interface ResponseStreamInfo {
  statusCode: number | ResponseStatusRange; // The response's status code (0 for `default`), or its range (`'2XX'`), as `x-status-code` gives it
  contentType: string; // The media type as the document writes it: the first one with `itemSchema` in document order (`text/event-stream`, `application/jsonl`, ...)
  itemSchema: JsonSchema; // The schema of each item, converted like an output schema
}
```

---

### SecurityParameterInfo

Security scheme information attached to mapper entries.

```typescript
interface SecurityParameterInfo {
  scheme: string; // Scheme name from OpenAPI (e.g., "BearerAuth")
  type: AuthType; // 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS'
  httpScheme?: string; // 'bearer', 'basic', 'digest', etc.
  bearerFormat?: string; // e.g., 'JWT'
  scopes?: string[]; // Required OAuth2 scopes
  apiKeyName?: string; // API key parameter name
  apiKeyIn?: "query" | "header" | "cookie";
  description?: string;
  alternatives?: number[]; // With a choice: the indexes of metadata.securityAlternatives that need this scheme
  alternativeScopes?: string[][]; // The scopes each of `alternatives` asks, when they differ
  certificateAlternatives?: number[]; // The alternatives that also need a client certificate (mutualTLS)
  optional?: boolean; // With a choice: one alternative is empty, so a call needs no credential
}
```

---

### SecurityRequirement

Security requirement from OpenAPI spec.

```typescript
interface SecurityRequirement {
  scheme: string;
  type: AuthType;
  scopes?: string[];
  name?: string; // API key parameter name
  in?: "query" | "header" | "cookie";
  httpScheme?: string; // 'bearer', 'basic', etc.
  bearerFormat?: string;
  description?: string;
}
```

---

### SerializationInfo

Serialization details for complex parameters.

```typescript
interface SerializationInfo {
  contentType?: string; // The media type the value is serialized in: a body's, a `content` parameter's, a whole query's
  encoding?: Record<string, EncodingObject>; // OpenAPI media-type encoding rules
  binary?: boolean; // File part / raw binary body (format: binary)
}
```

On a body entry, `contentType` is the request body's media type. On a `path`, `query`, `header` or `cookie` entry it is present only when the parameter is defined with `content` or is a whole-query parameter, and is then the media type of its `content`. `encoding` of a flattened body property holds that property's entry only; of a whole body, a `content` parameter or a whole query it is the media type's full map. `buildHttpRequest` applies it, field by field, in `application/x-www-form-urlencoded` and `multipart/form-data` bodies and in a form whole query or form `content` parameter: `style`, `explode`, `allowReserved`, and for multipart parts `contentType` and `headers` ([Encoding Objects](./request-builder.md#encoding-objects)). A tool without `encoding` is serialized as before.

---

### ServerInfo

Server information from OpenAPI spec.

```typescript
interface ServerInfo {
  url: string;
  name?: string; // OpenAPI 3.2 Server Object `name`, when the document gives a string; kept when `baseUrl` replaces the URL
  description?: string;
  variables?: Record<string, ServerVariableObject>;
}
```

---

### FrontMcpExtensionData

Custom `x-frontmcp` extension data for MCP-specific configuration. See [x-frontmcp Extension](./x-frontmcp.md).

```typescript
interface FrontMcpExtensionData {
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  cache?: {
    ttl?: number;
    slideWindow?: boolean;
  };
  codecall?: {
    enabledInCodeCall?: boolean;
    visibleInListTools?: boolean;
  };
  tags?: string[];
  hideFromDiscovery?: boolean;
  examples?: Array<{
    description: string;
    input: Record<string, unknown>;
    output?: unknown;
  }>;
}
```

---

## Security Types

### SecurityContext

Auth context provided to `SecurityResolver.resolve()`.

```typescript
interface SecurityContext {
  jwt?: string; // Bearer token
  basic?: string; // Base64 "username:password"
  digest?: DigestAuthCredentials; // Digest auth credentials
  apiKey?: string; // Single API key
  apiKeys?: Record<string, string>; // Multiple API keys by name
  oauth2Token?: string; // OAuth2 access token
  clientCertificate?: ClientCertificate;
  privateKey?: string; // For signature-based auth
  publicKey?: string;
  hmacSecret?: string; // For HMAC auth
  awsCredentials?: AWSCredentials; // AWS Signature V4
  customHeaders?: Record<string, string>;
  cookies?: Record<string, string>;
  customResolver?: (
    security: SecurityParameterInfo,
  ) => string | Promise<string | undefined>;
  signatureGenerator?: (
    data: SignatureData,
    security: SecurityParameterInfo,
  ) => string | Promise<string>;
}
```

### ResolvedSecurity

Output from `SecurityResolver.resolve()`.

```typescript
interface ResolvedSecurity {
  headers: Record<string, string>;
  query: Record<string, string>;
  cookies: Record<string, string>;
  clientCertificate?: ClientCertificate;
  requiresSignature?: boolean;
  signatureInfo?: {
    scheme: string;
    algorithm?: string;
  };
}
```

### DigestAuthCredentials

```typescript
interface DigestAuthCredentials {
  username: string;
  password: string;
  realm?: string;
  nonce?: string;
  uri?: string;
  qop?: string;
  nc?: string;
  cnonce?: string;
  response?: string;
  opaque?: string;
}
```

### ClientCertificate

```typescript
interface ClientCertificate {
  cert: string; // PEM format
  key: string; // PEM format
  passphrase?: string;
  ca?: string | string[];
}
```

### AWSCredentials

```typescript
interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
  service?: string;
}
```

### SignatureData

```typescript
interface SignatureData {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timestamp?: number;
}
```

---

## Configuration Types

### LoadOptions

Options for loading OpenAPI specifications. See [Configuration](./configuration.md).

```typescript
interface LoadOptions {
  dereference?: boolean; // default: true; a Swagger 2.0 document needs it (DEREFERENCE_REQUIRED)
  baseUrl?: string; // replaces the API's server URLs; not the document's own URI
  documentUri?: string; // where the document was retrieved from: what its relative $refs are read against (absolute http, https or file URI, at most 2,048 characters)
  headers?: Record<string, string>;
  timeout?: number; // default: 30000 (ms)
  validate?: boolean; // default: true
  followRedirects?: boolean; // default: true (false under secureDefaults)
  refResolution?: RefResolutionOptions;
  secureDefaults?: boolean; // default: false (redirects off + external refs off)
  overlays?: OverlayDocument | OverlayDocument[]; // applied eagerly, before dereference/validation
}
```

### GenerateOptions

Options for tool generation. See [Configuration](./configuration.md).

```typescript
interface GenerateOptions {
  includeOperations?: string[];
  excludeOperations?: string[];
  filterFn?: (operation: OperationWithContext) => boolean;
  includeTags?: string[]; // filter by OpenAPI tags
  excludeTags?: string[];
  includeMethods?: HTTPMethod[]; // filter by HTTP method; standard methods match in any case
  excludeMethods?: HTTPMethod[]; // a denylist; additionalOperations methods match only exactly as written
  includePaths?: string[]; // path globs: * per segment, ** across, ? one char
  excludePaths?: string[];
  readOnlyOnly?: boolean; // default: false (safety switch)
  namingStrategy?: NamingStrategy;
  preferredStatusCodes?: number[]; // default: [200, 201, 204, 202, 203, 206]; order of preference for includeAllResponses: false and streams (ranges too, see Response Schemas)
  includeDeprecated?: boolean; // default: false
  includeAllResponses?: boolean; // default: true
  maxSchemaDepth?: number; // default: 10 (deeper structures truncated)
  maxSchemaNodes?: number; // default: 25000 (per schema; over it a schema is cut shallower; Infinity disables)
  includeExamples?: boolean; // default: false (parameter/media-type examples)
  includeSecurityInInput?: boolean | string[]; // default: false; array = per-scheme selection
  target?: ClientTarget; // per-client schema dialect transforms
  descriptionStrategy?: "summaryOnly" | "descriptionOnly" | "combined" | "full";
  appendResponseSummary?: boolean; // default: false ("Returns: ..." line)
  maxProperties?: number; // cap object width (drop noted)
  maxDescriptionLength?: number; // ellipsis-truncate descriptions
  stripExamples?: boolean; // default: false
  inferAnnotations?: boolean; // default: true (HTTP-method annotation inference)
  maxToolNameLength?: number; // default: 64 (clamped to MCP's 128 max)
  resolveFormats?: boolean; // default: false
  formatResolvers?: Record<string, FormatResolver>;
}
```

### RefResolutionOptions

Security configuration for `$ref` resolution. See [SSRF Prevention](./ssrf-prevention.md).

```typescript
interface RefResolutionOptions {
  allowedProtocols?: string[]; // default: ['http', 'https']; add 'file' to read files (a relative $ref of a fromFile document is a file)
  allowedHosts?: string[];
  blockedHosts?: string[];
  allowInternalIPs?: boolean; // default: false
}
```

### NamingStrategy

Custom naming for parameter conflict resolution and tool names. See [Naming Strategies](./naming-strategies.md).

```typescript
interface NamingStrategy {
  conflictResolver: (
    paramName: string,
    location: ParameterLocation,
    index: number,
  ) => string;
  toolNameGenerator?: (
    path: string,
    method: HTTPMethod,
    operationId?: string,
    operation?: OperationObject,
  ) => string;
}
```

### OperationWithContext

Operation object extended with path and method context, used in `filterFn`.

```typescript
type OperationWithContext = OperationObject & {
  path: string;
  method: string; // canonical: lowercase for a fixed field, the key as written for additionalOperations
};
```

---

## Validation Types

### ValidationResult

```typescript
interface ValidationResult {
  valid: boolean;
  errors?: ValidationErrorDetail[];
  warnings?: ValidationWarning[];
}
```

### ValidationErrorDetail

```typescript
interface ValidationErrorDetail {
  message: string;
  path?: string; // JSON pointer
  code?: string;
}
```

### ValidationWarning

```typescript
interface ValidationWarning {
  message: string;
  path?: string;
  code?: string;
}
```

---

## Error Classes

See [Error Handling](./error-handling.md) for usage patterns.

| Class              | Thrown When                              |
| ------------------ | ---------------------------------------- |
| `OpenAPIToolError` | Base class for all errors                |
| `LoadError`        | URL fetch or file read fails, or `LoadOptions.documentUri` is invalid |
| `SsrfError`        | A `LoadError` for a spec URL the SSRF guard refuses; `context.reason` says why (`invalid-url`, `protocol`, `host-not-allowed`, `host-blocked`, `internal-address`, `resolved-address`, `dns-failed`, `too-large`, `too-many-redirects`, `no-transport`) |
| `ParseError`       | YAML/JSON parsing, `fromJSON` copying (a cyclic, too deep or BigInt-holding object) or dereferencing fails; also a failed validation, and a Swagger 2.0 document loaded with `dereference: false`. A failed dereference has `context.rule` (a document that cannot be copied at all has only `originalError`); one that names a `$ref` adds `reference`, `base`, `resolved` and, when known, `path` (see [SSRF Prevention](./ssrf-prevention.md#when-a-reference-cannot-be-read)) |
| `ValidationError`  | OpenAPI document is invalid              |
| `GenerationError`  | Tool generation fails                    |
| `SchemaError`      | Schema manipulation fails                |

---

## Basic Types

```typescript
type OpenAPIVersion = `3.0.${string}` | `3.1.${string}` | `3.2.${string}`;
type OpenAPIDocument = OAS30.OpenAPIObject | OAS31.OpenAPIObject | OAS32.OpenAPIObject;
type StandardMethod =
  "get" | "post" | "put" | "patch" | "delete" | "head" | "options" | "trace" | "query";
type HTTPMethod = StandardMethod | (string & {});
type ParameterLocation = "path" | "query" | "header" | "cookie" | "body";
type AuthType = "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
```

`OpenAPIVersion` is any `3.0.x`, `3.1.x` or `3.2.x` string (`'3.0.3'`, `'3.2.0-rc1'`); the patch is not checked, because the specification tells tooling to ignore it. `OpenAPIDocument` is the union of the OpenAPI 3 documents: a Swagger 2.0 document is never read as one, it is converted first (`upgradeSwagger2`), so the generator's `getDocument()` holds a 3.0 document once generation has run and its types are in `OAS20`. `HTTPMethod` is open so that `additionalOperations` methods type-check while the standard ones autocomplete: a fixed method is its lowercase field name, an additional method is its key exactly as written (HTTP methods are case-sensitive). Use `isStandardMethod(method)` to tell them apart.

---

## OpenAPI Object Types

The library ships its own types for Swagger 2.0 and OpenAPI 3.0, 3.1 and 3.2 documents, written from the OpenAPI Specification text and the OpenAPI Initiative's JSON Schemas. It installs no third-party OpenAPI types package.

### Per-version namespaces

`OAS20`, `OAS30`, `OAS31` and `OAS32` hold each version's objects under the specification's own names. `OAS20` has the Swagger Object and its parts: `SwaggerObject`, `InfoObject`, `ContactObject`, `LicenseObject`, `PathsObject`, `PathItemObject`, `OperationObject`, `ExternalDocumentationObject`, `ParameterObject` (the body and non-body forms in one type), `ItemsObject`, `ResponsesObject`, `ResponseObject`, `HeadersObject`, `ExampleObject`, `HeaderObject`, `TagObject`, `ReferenceObject`, `SchemaObject`, `XMLObject`, `DefinitionsObject`, `ParametersDefinitionsObject`, `ResponsesDefinitionsObject`, `SecurityDefinitionsObject`, `SecuritySchemeObject`, `ScopesObject` and `SecurityRequirementObject`; it is not part of the cross-version unions below. `OAS30`, `OAS31` and `OAS32` hold: `OpenAPIObject`, `InfoObject`, `ContactObject`, `LicenseObject`, `ServerObject`, `ServerVariableObject`, `ComponentsObject`, `PathsObject`, `PathItemObject`, `OperationObject`, `ExternalDocumentationObject`, `ParameterObject`, `RequestBodyObject`, `MediaTypeObject`, `EncodingObject`, `ResponsesObject`, `ResponseObject`, `CallbackObject`, `ExampleObject`, `LinkObject`, `HeaderObject`, `TagObject`, `ReferenceObject`, `SchemaObject`, `DiscriminatorObject`, `XMLObject`, `SecuritySchemeObject`, `OAuthFlowsObject`, `OAuthFlowObject`, `SecurityRequirementObject`. `OAS31` and `OAS32` also export `SchemaOrBoolean`.

```typescript
import type { OAS20, OAS31, OAS32 } from "mcp-from-openapi";

function streamItemSchema(mediaType: OAS32.MediaTypeObject): OAS32.SchemaOrBoolean | undefined {
  return mediaType.itemSchema; // new in 3.2
}

function basePath(document: OAS20.SwaggerObject): string {
  return document.basePath ?? "/"; // Swagger 2.0: host, basePath and schemes, not servers
}
```

### Cross-version types

Each of these is the union of the 3.0, 3.1 and 3.2 objects of the same name, so it accepts an object of any supported version:

`OpenAPIDocument`, `OperationObject`, `ParameterObject`, `RequestBodyObject`, `ResponseObject`, `ResponsesObject`, `MediaTypeObject`, `HeaderObject`, `ExampleObject`, `PathItemObject`, `PathsObject`, `ServerObject`, `SecuritySchemeObject`, `ReferenceObject`, `TagObject`, `ExternalDocumentationObject`, `ServerVariableObject`, `EncodingObject`, `SecurityRequirementObject`, `SchemaObject`

Reading a field that only some versions define (such as 3.2's `query` operation) needs narrowing to that version's type.

`SchemaObject` is always an object. From 3.1 on a schema may also be `true` (anything is valid) or `false` (nothing is valid): `SchemaOrBoolean` is `SchemaObject | boolean`, and in `OAS31` and `OAS32` every position that allows a boolean schema (a parameter's `schema`, `items`, `properties` values, ...) is typed with that version's `SchemaOrBoolean`.

### How the types are shaped

- **Reader types.** They describe documents the library reads. Fields the specification enumerates (`in`, `style`, a security scheme's `type`, ...) are open strings: the known values autocomplete and any other string is still accepted. Rejecting an invalid document is the validator's job.
- **No `x-` fields.** Specification extensions are not declared on any object, so documents typed with your own interfaces stay assignable. Read an extension through `WithExtensions`, which views an object together with its `x-` fields; each one is `unknown` until checked. `ExtensionName` is the type of such a field name (`` `x-${string}` ``).

```typescript
import type { OperationObject, WithExtensions } from "mcp-from-openapi";

function isInternal(operation: OperationObject): boolean {
  return (operation as WithExtensions<OperationObject>)["x-internal"] === true;
}
```
- **A map lookup may find nothing.** The values of every map (paths, responses, `content`, component maps, security requirements, schema `properties`, ...) may be `undefined`: a key may be missing, and a document imported as a JSON module, where sibling maps have different keys, type-checks as is.
- **Free-form values are `any`.** `example`, `default`, `enum` members, `const` and similar values the specification leaves free-form are typed `any`, so existing code that reads them keeps compiling; the document decides what they hold, so check them before relying on their shape.

---

**Related:** [Getting Started](./getting-started.md) | [Configuration](./configuration.md) | [Examples](./examples.md)
