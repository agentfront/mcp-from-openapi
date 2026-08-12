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
```

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
```

#### Methods

```typescript
build(responses?: ResponsesObject): JsonSchema | undefined
```

See [Response Schemas](./response-schemas.md) for details.

---

### Validator

Validates OpenAPI 3.0.x and 3.1.x documents.

```typescript
import { Validator } from "mcp-from-openapi";
```

#### Methods

```typescript
async validate(document: OpenAPIDocument): Promise<ValidationResult>
```

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
applyClientTarget(schema: JsonSchema, target: ClientTarget): JsonSchema
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
lintDocument(document: OpenAPIDocument): LintResult
```

### toSdkTool

Shape a tool for the official MCP SDK's `registerTool(name, config, handler)` — pass the SDK v2 `fromJsonSchema` to wrap schemas; without it, raw JSON Schemas are returned.

```typescript
toSdkTool(tool: McpOpenAPITool): [string, SdkToolConfig]
toSdkTool<TSchema>(tool: McpOpenAPITool, wrapper?: SdkSchemaWrapper<TSchema>): [string, SdkToolConfig<TSchema>]

// SdkSchemaWrapper<TSchema> = { fromJsonSchema: (schema: JsonSchema) => TSchema }
```

### inferAnnotationsFromMethod / extractExtensionOverrides / resolveExtensionEnabled

Annotation inference and `x-mcp` extension family parsing. See [Annotations & Extensions](./annotations.md).

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
import { toJsonSchema } from "mcp-from-openapi";

const jsonSchema = toJsonSchema(openApiSchema);
```

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
  method: HTTPMethod; // HTTP verb
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
  includeMethods?: HTTPMethod[]; // filter by HTTP method
  excludeMethods?: HTTPMethod[];
  includePaths?: string[]; // path globs: * per segment, ** across, ? one char
  excludePaths?: string[];
  readOnlyOnly?: boolean; // default: false (safety switch)
  namingStrategy?: NamingStrategy;
  preferredStatusCodes?: number[]; // default: [200, 201, 204, 202, 203, 206]
  includeDeprecated?: boolean; // default: false
  includeAllResponses?: boolean; // default: true
  maxSchemaDepth?: number; // default: 10 (deeper structures truncated)
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
  ) => string;
}
```

### OperationWithContext

Operation object extended with path and method context, used in `filterFn`.

```typescript
type OperationWithContext = OperationObject & {
  path: string;
  method: string;
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
type OpenAPIVersion = "3.0.0" | "3.0.1" | "3.0.2" | "3.0.3" | "3.1.0";
type OpenAPIDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;
type HTTPMethod =
  "get" | "post" | "put" | "patch" | "delete" | "head" | "options" | "trace";
type ParameterLocation = "path" | "query" | "header" | "cookie" | "body";
type AuthType = "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
```

---

## Re-exported OpenAPI Types

These types are re-exported from the `openapi-types` package for convenience:

`OperationObject`, `ParameterObject`, `RequestBodyObject`, `ResponseObject`, `ResponsesObject`, `MediaTypeObject`, `HeaderObject`, `ExampleObject`, `PathItemObject`, `PathsObject`, `ServerObject`, `SecuritySchemeObject`, `ReferenceObject`, `TagObject`, `ExternalDocumentationObject`, `ServerVariableObject`, `EncodingObject`, `SecurityRequirementObject`, `SchemaObject`

---

**Related:** [Getting Started](./getting-started.md) | [Configuration](./configuration.md) | [Examples](./examples.md)
