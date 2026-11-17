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

#### Instance Methods

```typescript
async generateTools(options?: GenerateOptions): Promise<McpOpenAPITool[]>
async generateTool(path: string, method: string, options?: GenerateOptions): Promise<McpOpenAPITool>
getDocument(): OpenAPIDocument
async validate(): Promise<ValidationResult>
getDiagnostics(): SpecDiagnostic[]
getSpecVersion(): SpecVersionInfo
```

**`generateTool(path, method)`**: `method` is a standard method in any case (`'get'`, `'GET'`, `'query'`) or an OpenAPI 3.2 `additionalOperations` method exactly as written in the document (`'LINK'` finds `LINK`; `'link'` does not). Only the operations the declared version defines are found: `query` and `additionalOperations` exist from 3.2 on, so `generateTool('/search', 'query')` on a 3.1 document throws `Operation not found`. The tool's `metadata.method` is the canonical form: the lowercase field name of a standard method, the key as written otherwise. It throws a `GenerationError` (context `path`, `method`, `pointer`) for an operation that `generateTools()` skips with a diagnostic: a parameter in a location the library does not map, such as `in: querystring` (`UNSUPPORTED_PARAMETER_LOCATION`), or no Security Requirement that can be satisfied (`UNSATISFIABLE_SECURITY`).

**`generateTools()` / `generateTool()` and validation**: with `validate: true` (the default) the first call validates the document (after dereferencing, when that is on) and later calls reuse the result. A document that fails throws a `ParseError` whose message is `Invalid OpenAPI document: <first error>` (with `(and N more; see the error's context.errors)` when there are more) and whose `context.errors` is the full `ValidationErrorDetail[]`. The quoted first error is cut at 512 characters and any control or bidirectional character in it is written as `\uXXXX`, so the message is safe to log; `context.errors` is not altered. `validate()` is separate: it validates the loaded document as it is (not dereferenced) each time it is called, returns the result instead of throwing, and records no diagnostics.

**`getDiagnostics()`** returns what the generator noticed without failing, in the order it was first noticed, each finding once (a copy; changing it changes nothing). It grows as the generator works: the declared version at load, the validator's warnings at the first generation with `validate: true`, and the constructs generation skipped or ignored. Every `severity` is `'warning'` today. It keeps at most `MAX_DIAGNOSTICS` (1,000) distinct findings, then ends with one `DIAGNOSTICS_TRUNCATED` entry. See [OpenAPI Versions](./openapi-versions.md#diagnostics) for every code and the limits on quoted text and `path`.

```typescript
interface SpecDiagnostic {
  severity: "warning" | "info";
  code: string; // a DIAGNOSTIC_CODES value, e.g. 'FEATURE_NEWER_THAN_DECLARED_VERSION'
  message: string;
  path?: string; // JSON Pointer (RFC 6901) into the document; display-only when a segment was cut or escaped
}
```

**`getSpecVersion()`** returns the declared version as `detectSpecVersion` reads it (after overlays), as a copy. `status` says whether the version can be processed and `family` which rules apply.

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
  includeSecurityInInput?: boolean | string[]
): { inputSchema: JsonSchema; mapper: ParameterMapper[] }
```

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
```

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

Validates OpenAPI 3.0.x, 3.1.x and 3.2.x documents with the rules of the version the document declares. A newer 3.x minor version is valid with a `NEWER_OPENAPI_VERSION` warning and is checked with the 3.2 rules; Swagger 2.0, other major versions, malformed and missing versions are errors. See [OpenAPI Versions](./openapi-versions.md).

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
| `INVALID_OPENAPI_VERSION` | The version cannot be processed: Swagger 2.0, another major version, a malformed value |
| `MISSING_INFO`, `MISSING_TITLE`, `MISSING_VERSION` | `info`, `info.title` or `info.version` is missing |
| `INVALID_PATH_FORMAT` | A path does not start with `/` |
| `NO_RESPONSES` | An operation has no `responses` (required in 3.0 only) or has an empty `responses` (any version) |
| `MISSING_PATH_PARAMETER` | A path template variable has no matching `in: path` parameter |
| `INVALID_PARAMETER` | An entry of a `parameters` list is not an object |
| `MISSING_PARAMETER_NAME`, `MISSING_PARAMETER_IN` | A parameter has no `name` or no `in` |
| `INVALID_PARAMETER_IN` | `in` is not a location of the declared version (3.0 and 3.1: `path`, `query`, `header`, `cookie`; 3.2 adds `querystring`) |
| `PATH_PARAMETER_NOT_REQUIRED` | An `in: path` parameter is not `required` |
| `MISSING_PARAMETER_SCHEMA` | A parameter has neither `schema` nor `content` (an `in: querystring` parameter needs `content`) |
| `MULTIPLE_QUERYSTRING_PARAMETERS` | An operation has more than one `in: querystring` parameter |
| `QUERYSTRING_WITH_QUERY_PARAMETERS` | An operation combines an `in: querystring` parameter with `in: query` parameters |
| `QUERYSTRING_PARAMETER_WITHOUT_CONTENT` | An `in: querystring` parameter has no `content` |
| `OPERATION_NOT_OBJECT` | A method field, or an `additionalOperations` value, is not an object (`get: "x"`). A fixed field holding `null` is skipped without a finding |
| `ADDITIONAL_OPERATIONS_NOT_OBJECT` | `additionalOperations` is not an object (read only when the document declares 3.2 or newer) |
| `INVALID_METHOD_TOKEN` | An `additionalOperations` key is not an HTTP method token (RFC 9110) |
| `DUPLICATE_FIXED_METHOD` | An `additionalOperations` key is the upper-case name of a method that has its own field (`GET`, `QUERY`) |

Warnings:

| Code | Reported when |
| --- | --- |
| `NO_PATHS`, `NO_SERVERS`, `NO_OPERATIONS`, `NO_OPERATION_ID`, `NO_SECURITY_SCHEMES` | No paths or servers, a path without operations, an operation without `operationId`, security requirements without schemes |
| `NEWER_OPENAPI_VERSION` | The document declares a 3.x minor version newer than 3.2 |
| `CONFLICTING_VERSION_FIELDS` | The document declares both `openapi` and `swagger` (`swagger` is ignored) |
| `FEATURE_NEWER_THAN_DECLARED_VERSION` | A `query` operation or `additionalOperations` in a document declaring 3.0 or 3.1 (not read, so no tool and not validated), or an `in: querystring` parameter in such a document |
| `PATH_ITEM_NOT_OBJECT` | A path item is not an object; it holds no operations |
| `METHOD_CASE_VARIANT` | An `additionalOperations` key is another case of a method that has its own field (`post`, `Get`); the library sends such a method upper-cased, so the key is ignored |
| `REFUSED_METHOD` | An `additionalOperations` key is `CONNECT` in any case; it is ignored |
| `DIAGNOSTICS_TRUNCATED` | `errors` or `warnings` reached `MAX_DIAGNOSTICS` (1,000); it is the last entry of that list |

The codes of earlier releases and their `path` form (the path key unescaped, cut past `LEGACY_PATH_KEY_MAX_LENGTH` (1,024) characters, as in `/paths//pets/get/operationId`) are unchanged; every newer code carries an RFC 6901 JSON Pointer (`/paths/~1pets/get`), whose segments are escaped for display and capped at 256 characters (a pointer with a cut or escaped segment does not resolve). Text quoted from the document in a message is cut and escaped. `errors` and `warnings` each keep at most `MAX_DIAGNOSTICS` entries. The messages of the version errors changed with the supported versions.

---

## Utility Functions

### buildHttpRequest

Build a ready-to-send HTTP request from a tool and its input values — the full OpenAPI serialization table applied. See [Request Builder](./request-builder.md).

```typescript
buildHttpRequest(tool: McpOpenAPITool, input: Record<string, unknown>, options?: BuildHttpRequestOptions): BuiltHttpRequest
```

### applyClientTarget

Apply a client dialect's schema transforms (`'claude' | 'openai' | 'gemini' | 'strict'`). The individual transforms (`inlineLocalRefs`, `ensureArrayItems`, `collapseRootCompositions`, `collapseNestedUnions`, `demoteFormats`, `enforceClosedObjects`) are exported too. See [Client Targets](./client-targets.md).

```typescript
applyClientTarget(schema: JsonSchema, target: ClientTarget, options?: ClientTargetOptions): JsonSchema
// ClientTargetOptions = { maxNodes?: number } — a node budget for inlining local $refs (unbounded when omitted)
```

### fromArazzo / parseRuntimeExpression

Convert an Arazzo 1.0 workflow document into consolidated MCP tools (one per workflow, IR on `metadata.workflow`); parse Arazzo runtime expressions standalone. Throws `ArazzoError` with a JSON-Pointer `path`. See [Arazzo Workflows](./arazzo.md).

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

Agent-readiness lint with severity-ranked findings and fix hints; `generator.lint()` runs it on the overlay-patched, dereferenced document. See [Curation](./curation.md).

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

Annotation inference and `x-mcp` extension family parsing. `extractExtensionOverrides(operation, { maxMetaNodes })` throws a `SchemaError` when the extensions' `meta`, with its `$ref`s resolved, copies more than `maxMetaNodes` values (default `100000`) or nests more than 1,000 levels. See [Annotations & Extensions](./annotations.md).

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

Converts OpenAPI schema objects to JSON Schema format. Handles OpenAPI 3.0's boolean `exclusiveMinimum`/`exclusiveMaximum` conversion to numeric format.

```typescript
toJsonSchema(schema: object | boolean, options?: SchemaConversionOptions): JsonSchema
```

The input is any object (a Schema or Reference Object of any OpenAPI version, or a schema-shaped object you built) or a boolean schema. A boolean schema converts to `{}`; for `false` that is a known gap, as the result accepts everything.

```typescript
import { toJsonSchema } from "mcp-from-openapi";

const jsonSchema = toJsonSchema(openApiSchema);
```

---

## Operations and Versions

The functions that read a document's declared version and walk the operations of a Path Item. `generateTools()`, the validator, `lintDocument` and `fromArazzo` use them, so code that walks a document the same way sees the same operations. See [OpenAPI Versions](./openapi-versions.md).

### detectSpecVersion

Reads the version a document declares (`openapi`, or `swagger` when there is no `openapi`). Never throws; any value is accepted. `generator.getSpecVersion()` returns the same result for the loaded document.

```typescript
detectSpecVersion(document: unknown): SpecVersionInfo

interface SpecVersionInfo {
  status: "supported" | "newer-minor" | "swagger-2.0" | "unsupported" | "malformed" | "missing";
  field?: "openapi" | "swagger"; // where the version was read; undefined when missing
  declared?: unknown; // the value as read; undefined when missing
  major?: number; // unless malformed or missing
  minor?: number;
  family?: "3.0" | "3.1" | "3.2"; // the rules applied; set for 'supported' and 'newer-minor'
  diagnostics: SpecDiagnostic[]; // NEWER_OPENAPI_VERSION, CONFLICTING_VERSION_FIELDS
}
```

```typescript
import { detectSpecVersion } from "mcp-from-openapi";

detectSpecVersion({ openapi: "3.1.0" }).family; // '3.1'
detectSpecVersion({ openapi: "3.9.0" }).status; // 'newer-minor'
detectSpecVersion({ swagger: "2.0" }).status; // 'swagger-2.0'
detectSpecVersion({ openapi: "3.1" }).status; // 'malformed'
detectSpecVersion({}).status; // 'missing'
```

### SUPPORTED_SPEC_VERSIONS

The versions the library reads, as `readonly string[]`: `['3.0.x', '3.1.x', '3.2.x']`.

### resolveOperationLayout

The one place that decides which operations of a document are read. A `supported` or `newer-minor` version gets its family's layout: `query` and `additionalOperations` only from 3.2 on. Any other status (`swagger-2.0`, `unsupported`, `malformed`, `missing`) gets the eight classic methods and no `additionalOperations`, exactly what the library read before OpenAPI 3.2 support.

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

`DIAGNOSTIC_CODES` is the one frozen registry of every code a diagnostic from `generator.getDiagnostics()` can carry (its keys equal its values); `DiagnosticCode` is the union of those strings. It holds the codes of the version and operation-walk logic (`NEWER_OPENAPI_VERSION`, `FEATURE_NEWER_THAN_DECLARED_VERSION`, `CONFLICTING_VERSION_FIELDS`, `PATH_ITEM_NOT_OBJECT`, `OPERATION_NOT_OBJECT`, `ADDITIONAL_OPERATIONS_NOT_OBJECT`, `INVALID_METHOD_TOKEN`, `DUPLICATE_FIXED_METHOD`, `METHOD_CASE_VARIANT`, `REFUSED_METHOD`), the version errors (`INVALID_OPENAPI_VERSION`, `MISSING_OPENAPI_VERSION`), the validator warnings (`NO_PATHS`, `NO_OPERATIONS`, `NO_OPERATION_ID`, `NO_SERVERS`, `NO_SECURITY_SCHEMES`), the generator's (`UNRESOLVED_SECURITY_SCHEME`, `INVALID_SECURITY_REQUIREMENT`, `UNSATISFIABLE_SECURITY`, `UNSUPPORTED_PARAMETER_LOCATION`) and `DIAGNOSTICS_TRUNCATED`. Each is described in [OpenAPI Versions](./openapi-versions.md#diagnostics).

`MAX_DIAGNOSTICS` (`1000`) is the most findings one list keeps: `getDiagnostics()`, and each of a `ValidationResult`'s `errors` and `warnings`. `LEGACY_PATH_KEY_MAX_LENGTH` (`1024`) is the longest path key the historical validation paths and messages quote.

```typescript
import { DIAGNOSTIC_CODES } from "mcp-from-openapi";

const unsupported = generator
  .getDiagnostics()
  .filter((d) => d.code === DIAGNOSTIC_CODES.UNSUPPORTED_PARAMETER_LOCATION);
```

### Types

`SpecDiagnostic`, `SpecDiagnosticSeverity` (`'warning' | 'info'`), `DiagnosticCode`, `SpecVersionInfo`, `SpecVersionStatus`, `SpecVersionField`, `SpecFamily`, `StandardMethod`, `OperationEntry`, `OperationSource` (`'fixed' | 'additional'`), `OperationList`, `OperationLayout`, `ListOperationsOptions`, `GetOperationOptions`.

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
  outputSchema?: JsonSchema; // Response schema (can be oneOf union)
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
  style?: string; // 'simple', 'form', 'matrix', etc.
  explode?: boolean; // Array/object explosion
  allowReserved?: boolean; // Query only: RFC 3986 reserved characters stay unencoded
  serialization?: SerializationInfo; // Content-type, encoding rules, binary marker
  wholeBody?: boolean; // Input value IS the entire request body
  security?: SecurityParameterInfo; // Auth parameter metadata
}
```

`wholeBody` is set for non-object bodies (arrays, primitives, binary) and root `oneOf`/`anyOf` union bodies: send `input[inputKey]` directly as the request body instead of wrapping it in `{ [key]: value }`. See [SerializationInfo](#serializationinfo) for the content-type, encoding, and binary markers.

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
  servers?: ServerInfo[];
  responseStatusCodes?: number[]; // From output schema
  externalDocs?: ExternalDocumentationObject;
  frontmcp?: FrontMcpExtensionData; // x-frontmcp extension data
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
  contentType?: string; // Body content type
  encoding?: Record<string, EncodingObject>; // OpenAPI media-type encoding rules
  binary?: boolean; // File part / raw binary body (format: binary)
}
```

---

### ServerInfo

Server information from OpenAPI spec.

```typescript
interface ServerInfo {
  url: string;
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
  dereference?: boolean; // default: true
  baseUrl?: string;
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
  preferredStatusCodes?: number[]; // default: [200, 201, 204, 202, 203, 206]
  includeDeprecated?: boolean; // default: false
  includeAllResponses?: boolean; // default: true
  maxSchemaDepth?: number; // default: 10 (deeper structures truncated)
  maxSchemaNodes?: number; // default: 100000 (per schema; Infinity disables)
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
  allowedProtocols?: string[]; // default: ['http', 'https']
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
| `LoadError`        | URL fetch or file read fails             |
| `ParseError`       | YAML/JSON parsing or dereferencing fails |
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

`OpenAPIVersion` is any `3.0.x`, `3.1.x` or `3.2.x` string (`'3.0.3'`, `'3.2.0-rc1'`); the patch is not checked, because the specification tells tooling to ignore it. `HTTPMethod` is open so that `additionalOperations` methods type-check while the standard ones autocomplete: a fixed method is its lowercase field name, an additional method is its key exactly as written (HTTP methods are case-sensitive). Use `isStandardMethod(method)` to tell them apart.

---

## OpenAPI Object Types

The library ships its own types for OpenAPI 3.0, 3.1 and 3.2 documents, written from the OpenAPI Specification text and the OpenAPI Initiative's JSON Schemas. It installs no third-party OpenAPI types package.

### Per-version namespaces

`OAS30`, `OAS31` and `OAS32` hold each version's objects under the specification's own names: `OpenAPIObject`, `InfoObject`, `ContactObject`, `LicenseObject`, `ServerObject`, `ServerVariableObject`, `ComponentsObject`, `PathsObject`, `PathItemObject`, `OperationObject`, `ExternalDocumentationObject`, `ParameterObject`, `RequestBodyObject`, `MediaTypeObject`, `EncodingObject`, `ResponsesObject`, `ResponseObject`, `CallbackObject`, `ExampleObject`, `LinkObject`, `HeaderObject`, `TagObject`, `ReferenceObject`, `SchemaObject`, `DiscriminatorObject`, `XMLObject`, `SecuritySchemeObject`, `OAuthFlowsObject`, `OAuthFlowObject`, `SecurityRequirementObject`. `OAS31` and `OAS32` also export `SchemaOrBoolean`.

```typescript
import type { OAS31, OAS32 } from "mcp-from-openapi";

function streamItemSchema(mediaType: OAS32.MediaTypeObject): OAS32.SchemaOrBoolean | undefined {
  return mediaType.itemSchema; // new in 3.2
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
