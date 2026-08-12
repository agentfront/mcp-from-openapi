import type { JSONSchema } from 'zod/v4/core';

/** JSON Schema type from Zod v4 */
export type JsonSchema = JSONSchema.JSONSchema;
import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';

/**
 * OpenAPI specification version 3.0.x or 3.1.x
 */
export type OpenAPIVersion = '3.0.0' | '3.0.1' | '3.0.2' | '3.0.3' | '3.1.0';

/**
 * Unified OpenAPI Document type (supports both 3.0 and 3.1)
 */
export type OpenAPIDocument = OpenAPIV3.Document | OpenAPIV3_1.Document;

/**
 * HTTP methods supported by OpenAPI
 */
export type HTTPMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'trace';

/**
 * Parameter location types
 */
export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie' | 'body';

/**
 * Authentication types supported
 */
export type AuthType = 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS';

// Re-export OpenAPI types for convenience
export type OperationObject = OpenAPIV3.OperationObject | OpenAPIV3_1.OperationObject;
export type ParameterObject = OpenAPIV3.ParameterObject | OpenAPIV3_1.ParameterObject;
export type RequestBodyObject = OpenAPIV3.RequestBodyObject | OpenAPIV3_1.RequestBodyObject;
export type ResponseObject = OpenAPIV3.ResponseObject | OpenAPIV3_1.ResponseObject;
export type ResponsesObject = OpenAPIV3.ResponsesObject | OpenAPIV3_1.ResponsesObject;
export type MediaTypeObject = OpenAPIV3.MediaTypeObject | OpenAPIV3_1.MediaTypeObject;
export type HeaderObject = OpenAPIV3.HeaderObject | OpenAPIV3_1.HeaderObject;
export type ExampleObject = OpenAPIV3.ExampleObject | OpenAPIV3_1.ExampleObject;
export type PathItemObject = OpenAPIV3.PathItemObject | OpenAPIV3_1.PathItemObject;
export type PathsObject = OpenAPIV3.PathsObject | OpenAPIV3_1.PathsObject;
export type ServerObject = OpenAPIV3.ServerObject | OpenAPIV3_1.ServerObject;
export type SecuritySchemeObject = OpenAPIV3.SecuritySchemeObject | OpenAPIV3_1.SecuritySchemeObject;
export type ReferenceObject = OpenAPIV3.ReferenceObject | OpenAPIV3_1.ReferenceObject;
export type TagObject = OpenAPIV3.TagObject | OpenAPIV3_1.TagObject;
export type ExternalDocumentationObject =
  | OpenAPIV3.ExternalDocumentationObject
  | OpenAPIV3_1.ExternalDocumentationObject;
export type ServerVariableObject = OpenAPIV3.ServerVariableObject | OpenAPIV3_1.ServerVariableObject;
export type EncodingObject = OpenAPIV3.EncodingObject | OpenAPIV3_1.EncodingObject;
export type SecurityRequirementObject = OpenAPIV3.SecurityRequirementObject | OpenAPIV3_1.SecurityRequirementObject;
export type SchemaObject = OpenAPIV3.SchemaObject | OpenAPIV3_1.SchemaObject;

/**
 * Helper to check if an object is a ReferenceObject
 */
export function isReferenceObject(obj: any): obj is ReferenceObject {
  return obj && typeof obj === 'object' && '$ref' in obj;
}

/**
 * Convert OpenAPI schema to JsonSchema
 * Note: OpenAPI 3.0 uses a subset of JSON Schema Draft 4
 * OpenAPI 3.1 uses JSON Schema Draft 2020-12
 *
 * Normalizations applied for clean JSON Schema 2020-12 output (MCP's default
 * dialect since spec revision 2025-11-25):
 * - OpenAPI 3.0 `nullable: true` -> `type: [..., 'null']` union
 * - OpenAPI 3.0 boolean `exclusiveMinimum`/`exclusiveMaximum` -> numeric form
 * - OpenAPI `example` (singular) -> `examples` array (2020-12 keyword)
 * - OpenAPI-only `xml` metadata is dropped
 */
export function toJsonSchema(schema: SchemaObject | ReferenceObject): JsonSchema {
  if (isReferenceObject(schema)) {
    return { $ref: schema.$ref } as JsonSchema;
  }

  // Handle OpenAPI 3.0 boolean exclusiveMaximum/exclusiveMinimum
  // by converting them to JSON Schema Draft 7 numeric format
  const { exclusiveMaximum, exclusiveMinimum, maximum, minimum, ...rest } = schema;
  // OpenAPI-only keywords pulled out of the JSON Schema output. `nullable` and
  // `example` carry validation/annotation meaning and are converted below; `xml`
  // is serialization metadata with no JSON Schema equivalent.
  const { nullable, example, ...cleanRest } = rest as Record<string, unknown> & {
    nullable?: boolean;
    example?: unknown;
  };

  const result: Record<string, unknown> = { ...cleanRest };
  delete result['xml'];

  // OpenAPI 3.0 `nullable: true` -> JSON Schema type union with 'null'.
  // Type-less nullable schemas (compositions, enum-only) can't take a type
  // union — they are wrapped in `anyOf: [<schema>, { type: 'null' }]` at the
  // end of processing instead, so nullability is never silently lost.
  let wrapNullable = false;
  if (nullable === true) {
    const type = result['type'];
    if (type === undefined) {
      wrapNullable = true;
    } else if (Array.isArray(type)) {
      if (!type.includes('null')) {
        result['type'] = [...type, 'null'];
      }
    } else if (type !== 'null') {
      result['type'] = [type, 'null'];
    }
  }

  // OpenAPI `example` (singular) -> JSON Schema 2020-12 `examples` array.
  // When the schema already declares an `examples` array (OpenAPI 3.1), it wins.
  if (example !== undefined && !Array.isArray(result['examples'])) {
    result['examples'] = [example];
  }

  // Handle exclusiveMaximum conversion
  if (typeof exclusiveMaximum === 'boolean') {
    if (exclusiveMaximum && maximum !== undefined) {
      // true + maximum present -> convert to numeric exclusiveMaximum
      result['exclusiveMaximum'] = maximum;
    } else if (maximum !== undefined) {
      // false or true without maximum -> keep maximum only
      result['maximum'] = maximum;
    }
    // Boolean exclusiveMaximum is never added (invalid in JSON Schema 7)
  } else if (exclusiveMaximum !== undefined) {
    // Already numeric (OpenAPI 3.1) - keep as is
    result['exclusiveMaximum'] = exclusiveMaximum;
    if (maximum !== undefined) {
      result['maximum'] = maximum;
    }
  } else if (maximum !== undefined) {
    // No exclusiveMaximum, just maximum
    result['maximum'] = maximum;
  }

  // Handle exclusiveMinimum conversion
  if (typeof exclusiveMinimum === 'boolean') {
    if (exclusiveMinimum && minimum !== undefined) {
      // true + minimum present -> convert to numeric exclusiveMinimum
      result['exclusiveMinimum'] = minimum;
    } else if (minimum !== undefined) {
      // false or true without minimum -> keep minimum only
      result['minimum'] = minimum;
    }
    // Boolean exclusiveMinimum is never added (invalid in JSON Schema 7)
  } else if (exclusiveMinimum !== undefined) {
    // Already numeric (OpenAPI 3.1) - keep as is
    result['exclusiveMinimum'] = exclusiveMinimum;
    if (minimum !== undefined) {
      result['minimum'] = minimum;
    }
  } else if (minimum !== undefined) {
    // No exclusiveMinimum, just minimum
    result['minimum'] = minimum;
  }

  // Recursively convert nested schemas to ensure all nested schemas are valid JsonSchema
  if (result['properties'] && typeof result['properties'] === 'object') {
    const props: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(result['properties'] as Record<string, SchemaObject | ReferenceObject>)) {
      props[key] = toJsonSchema(value);
    }
    result['properties'] = props;
  }

  if (result['items']) {
    if (Array.isArray(result['items'])) {
      result['items'] = (result['items'] as (SchemaObject | ReferenceObject)[]).map(toJsonSchema);
    } else {
      result['items'] = toJsonSchema(result['items'] as SchemaObject | ReferenceObject);
    }
  }

  if (result['additionalProperties'] && typeof result['additionalProperties'] === 'object') {
    result['additionalProperties'] = toJsonSchema(result['additionalProperties'] as SchemaObject | ReferenceObject);
  }

  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (result[key] && Array.isArray(result[key])) {
      result[key] = (result[key] as (SchemaObject | ReferenceObject)[]).map(toJsonSchema);
    }
  }

  if (result['not']) {
    result['not'] = toJsonSchema(result['not'] as SchemaObject | ReferenceObject);
  }

  // Remaining JSON Schema 2020-12 structural keywords, so nested `nullable`/
  // `example`/`xml` under them receive the same normalization as the root.
  // Map-of-schemas keywords:
  for (const key of ['patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const) {
    const value = result[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const mapped: Record<string, JsonSchema> = {};
      for (const [name, sub] of Object.entries(value as Record<string, SchemaObject | ReferenceObject>)) {
        mapped[name] = toJsonSchema(sub);
      }
      result[key] = mapped;
    }
  }
  // Single-schema keywords (`unevaluated*` may be boolean — object guard skips those):
  for (const key of [
    'contains',
    'propertyNames',
    'if',
    'then',
    'else',
    'contentSchema',
    'unevaluatedItems',
    'unevaluatedProperties',
  ] as const) {
    const value = result[key];
    if (value && typeof value === 'object') {
      result[key] = toJsonSchema(value as SchemaObject | ReferenceObject);
    }
  }
  // Array-of-schemas keyword:
  if (Array.isArray(result['prefixItems'])) {
    result['prefixItems'] = (result['prefixItems'] as (SchemaObject | ReferenceObject)[]).map(toJsonSchema);
  }

  if (wrapNullable) {
    // Hoist pure annotation keywords onto the wrapper so descriptions and
    // examples stay visible at the top level instead of buried in anyOf[0].
    const wrapper: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'deprecated', 'examples'] as const) {
      if (result[key] !== undefined) {
        wrapper[key] = result[key];
        delete result[key];
      }
    }
    wrapper['anyOf'] = [result, { type: 'null' }];
    return wrapper as JsonSchema;
  }

  return result as JsonSchema;
}

/**
 * MCP tool annotations — behavior hints for clients (MCP spec 2025-03-26).
 * Hints are advisory: clients must not treat them as security guarantees.
 */
export interface ToolAnnotations {
  /**
   * Legacy display-name slot inside annotations. Prefer the tool-level `title`.
   */
  title?: string;

  /**
   * Tool only reads data, never modifies state.
   */
  readOnlyHint?: boolean;

  /**
   * Tool may perform destructive updates (delete, overwrite).
   */
  destructiveHint?: boolean;

  /**
   * Calling repeatedly with the same arguments has no additional effect.
   */
  idempotentHint?: boolean;

  /**
   * Tool interacts with an open world of external entities.
   */
  openWorldHint?: boolean;
}

/**
 * Main MCP Tool definition generated from OpenAPI.
 *
 * `TMeta` lets embedding frameworks extend the metadata contract without
 * casting — e.g. `McpOpenAPITool<ToolMetadata & { adapter: AdapterState }>`.
 */
export interface McpOpenAPITool<TMeta extends ToolMetadata = ToolMetadata> {
  /**
   * Unique tool name (from operationId or generated)
   */
  name: string;

  /**
   * Human-readable display name (MCP `Tool.title`, spec 2025-06-18).
   * From extension overrides or the operation summary.
   */
  title?: string;

  /**
   * Tool description (from operation summary/description)
   */
  description: string;

  /**
   * MCP tool annotations. Inferred from HTTP method semantics by default
   * (see `GenerateOptions.inferAnnotations`) and overridable via the
   * `x-speakeasy-mcp` / `x-mcp` / `x-frontmcp` extensions (in ascending
   * precedence).
   */
  annotations?: ToolAnnotations;

  /**
   * Combined input schema including all parameters
   * (path, query, header, cookie, body)
   */
  inputSchema: JsonSchema;

  /**
   * Output schema based on response definitions
   * Can be a union of multiple status codes
   */
  outputSchema?: JsonSchema;

  /**
   * Mapping from input schema properties to actual request parameters
   */
  mapper: ParameterMapper[];

  /**
   * Additional metadata about the tool
   */
  metadata: TMeta;
}

/**
 * Maps input schema properties to their actual request locations
 */
export interface ParameterMapper {
  /**
   * Property name in the input schema
   */
  inputKey: string;

  /**
   * Where this parameter should be placed in the request
   */
  type: ParameterLocation;

  /**
   * Original parameter name (before conflict resolution)
   */
  key: string;

  /**
   * Whether this parameter is required
   */
  required?: boolean;

  /**
   * Parameter style (for path/query parameters)
   */
  style?: string;

  /**
   * Whether to explode arrays/objects
   */
  explode?: boolean;

  /**
   * Whether RFC 3986 reserved characters may appear unencoded in the value
   * (query parameters only, OpenAPI `allowReserved`)
   */
  allowReserved?: boolean;

  /**
   * Custom serialization info
   */
  serialization?: SerializationInfo;

  /**
   * When true, this input value IS the entire request body — set for
   * non-object bodies (arrays, primitives, binary) and for `oneOf`/`anyOf`
   * union bodies that cannot be flattened into named properties. Consumers
   * building requests must send the value directly as the body instead of
   * wrapping it in an object keyed by `key`.
   */
  wholeBody?: boolean;

  /**
   * Security scheme information (if this is an auth parameter)
   * This allows frameworks to resolve auth from context, env vars, etc.
   */
  security?: SecurityParameterInfo;
}

/**
 * Serialization information for complex parameters
 */
export interface SerializationInfo {
  /**
   * Content type for body parameters
   */
  contentType?: string;

  /**
   * Encoding rules from the request body's media type (OpenAPI `encoding`).
   * For a flattened body-property parameter this contains only that
   * property's entry; for a whole-body parameter it is the full map.
   */
  encoding?: Record<string, EncodingObject>;

  /**
   * File-upload marker: the parameter schema declares binary content
   * (`format: binary`), e.g. a multipart file part or a raw binary body.
   */
  binary?: boolean;
}

/**
 * Security parameter information for framework-agnostic auth resolution
 */
export interface SecurityParameterInfo {
  /**
   * Security scheme name from OpenAPI (e.g., "BearerAuth")
   */
  scheme: string;

  /**
   * Security type (apiKey, http, oauth2, openIdConnect)
   */
  type: AuthType;

  /**
   * HTTP authentication scheme (for type: "http")
   * e.g., "bearer", "basic"
   */
  httpScheme?: string;

  /**
   * Bearer token format (e.g., "JWT")
   */
  bearerFormat?: string;

  /**
   * Required OAuth2 scopes
   */
  scopes?: string[];

  /**
   * API key parameter name (for type: "apiKey")
   */
  apiKeyName?: string;

  /**
   * API key location (for type: "apiKey")
   */
  apiKeyIn?: 'query' | 'header' | 'cookie';

  /**
   * Description of the security scheme
   */
  description?: string;
}

/**
 * Additional metadata about the generated tool
 */
export interface ToolMetadata {
  /**
   * Original OpenAPI path
   */
  path: string;

  /**
   * HTTP method
   */
  method: HTTPMethod;

  /**
   * Operation ID from OpenAPI
   */
  operationId?: string;

  /**
   * Operation summary from OpenAPI (short description)
   */
  operationSummary?: string;

  /**
   * Operation description from OpenAPI (detailed description)
   */
  operationDescription?: string;

  /**
   * Tags from OpenAPI
   */
  tags?: string[];

  /**
   * Whether operation is deprecated
   */
  deprecated?: boolean;

  /**
   * Security requirements
   */
  security?: SecurityRequirement[];

  /**
   * Server information
   */
  servers?: ServerInfo[];

  /**
   * Response status codes included in output schema
   */
  responseStatusCodes?: number[];

  /**
   * External documentation
   */
  externalDocs?: ExternalDocumentationObject;

  /**
   * FrontMCP extension data from x-frontmcp in the OpenAPI operation.
   * Contains annotations, cache config, codecall config, tags, etc.
   */
  frontmcp?: FrontMcpExtensionData;

  /**
   * Response-shaping signals for consumers that paginate, truncate, or cache:
   * present only when there is something to know.
   */
  responseHints?: ResponseHints;
}

/**
 * Detected response-shaping signals. Clients cap tool results hard (Claude
 * Code: 25K tokens) — these hints tell a consumer WHICH tools need paging or
 * truncation before the first oversized response happens.
 */
export interface ResponseHints {
  /** The success response contains an array without `maxItems` */
  unboundedArray?: boolean;

  /** Query parameters that look like pagination controls (limit, cursor, ...) */
  paginationParams?: string[];

  /** Unbounded array AND no pagination controls: truncate or shape server-side */
  largeResponseRisk?: boolean;
}

/**
 * FrontMCP extension data extracted from x-frontmcp in OpenAPI operations.
 * This provides declarative configuration for tools directly in the OpenAPI spec.
 */
export interface FrontMcpExtensionData {
  /**
   * Tool annotations for AI behavior hints (same contract as the tool-level
   * `annotations` field).
   */
  annotations?: ToolAnnotations;

  /**
   * Cache configuration for response caching.
   */
  cache?: {
    ttl?: number;
    slideWindow?: boolean;
  };

  /**
   * CodeCall-specific configuration.
   */
  codecall?: {
    enabledInCodeCall?: boolean;
    visibleInListTools?: boolean;
  };

  /**
   * Tags/labels for categorization.
   */
  tags?: string[];

  /**
   * If true, hide tool from discovery.
   */
  hideFromDiscovery?: boolean;

  /**
   * Usage examples.
   */
  examples?: Array<{
    description: string;
    input: Record<string, unknown>;
    output?: unknown;
  }>;
}

/**
 * Security requirement definition
 */
export interface SecurityRequirement {
  /**
   * Security scheme name
   */
  scheme: string;

  /**
   * Security type
   */
  type: AuthType;

  /**
   * Scopes required (for OAuth2/OpenID Connect)
   */
  scopes?: string[];

  /**
   * Parameter name (for API key)
   */
  name?: string;

  /**
   * Parameter location (for API key)
   */
  in?: 'query' | 'header' | 'cookie';

  /**
   * HTTP authentication scheme (for type: "http")
   * e.g., "bearer", "basic"
   */
  httpScheme?: string;

  /**
   * Bearer token format (e.g., "JWT")
   */
  bearerFormat?: string;

  /**
   * Description of the security scheme
   */
  description?: string;
}

/**
 * Server information
 */
export interface ServerInfo {
  /**
   * Server URL
   */
  url: string;

  /**
   * Server description
   */
  description?: string;

  /**
   * Server variables
   */
  variables?: Record<string, ServerVariableObject>;
}

/**
 * Controls how external `$ref` pointers are resolved during dereferencing, and
 * the host policy applied to the initial spec-URL fetch in `fromURL`.
 *
 * By default only http/https protocols are allowed and internal/private targets
 * are blocked to prevent SSRF. As of 2.5.0 the guard validates the **resolved
 * IP** (it resolves DNS and rejects hostnames that map to internal addresses —
 * e.g. `127.0.0.1.nip.io`), normalizes IPv4-mapped IPv6, and re-validates every
 * HTTP redirect hop. `allowedHosts` / `blockedHosts` / `allowInternalIPs` apply
 * to both the spec URL and external `$ref`s.
 */
export interface RefResolutionOptions {
  /**
   * Protocols allowed for external $ref resolution.
   * Any protocol string is accepted (http, https, ftp, ws, wss, etc.).
   * @default ['http', 'https']
   */
  allowedProtocols?: string[];

  /**
   * Hostnames allowed for external $ref resolution (network protocols only).
   * When set, only refs pointing to these hosts are resolved.
   * When not set, all hosts are allowed except blocked internal ranges.
   */
  allowedHosts?: string[];

  /**
   * Additional hostnames/IPs to block. Applied on top of the built-in
   * internal IP block list (localhost, 169.254.x.x, 10.x.x.x, etc.).
   */
  blockedHosts?: string[];

  /**
   * Disable the built-in internal/private IP block list.
   * WARNING: Enabling this may expose your application to SSRF attacks
   * against cloud metadata endpoints and internal services.
   * @default false
   */
  allowInternalIPs?: boolean;
}

/**
 * Options for loading OpenAPI specifications
 */
export interface LoadOptions {
  /**
   * Whether to dereference $refs in schemas
   * @default true
   */
  dereference?: boolean;

  /**
   * Base URL for API requests
   * Overrides servers in OpenAPI spec
   */
  baseUrl?: string;

  /**
   * Custom HTTP headers for loading from URL
   */
  headers?: Record<string, string>;

  /**
   * Request timeout in milliseconds
   * @default 30000
   */
  timeout?: number;

  /**
   * Whether to validate the OpenAPI document
   * @default true
   */
  validate?: boolean;

  /**
   * Whether to follow HTTP redirects when fetching the spec URL. Each redirect
   * hop is re-validated against the SSRF guard before being followed (a 3xx to
   * an internal target is refused), so following is safe by default.
   * @default true (false when `secureDefaults` is set)
   */
  followRedirects?: boolean;

  /**
   * OpenAPI Overlay 1.0 document(s) applied to the spec at load time, BEFORE
   * dereferencing and validation, in order. Overlays keep curation
   * (agent-tuned descriptions, `x-mcp` flags) in a separate file that
   * survives spec regeneration. See `applyOverlay` for the supported
   * JSONPath subset.
   */
  overlays?: import('./overlay').OverlayDocument | import('./overlay').OverlayDocument[];

  /**
   * Opt into the strictest loading posture in one flag: redirects are not
   * followed and external `$ref` resolution is disabled entirely
   * (`refResolution.allowedProtocols: []`) — the right default when loading
   * untrusted specs. Explicitly-set `followRedirects`/`refResolution` values
   * still win over the preset.
   * @default false
   */
  secureDefaults?: boolean;

  /**
   * Controls spec-loading security: external `$ref` resolution AND the host
   * policy for the initial spec-URL fetch. By default `file://` is blocked,
   * internal/private targets are blocked, and hostnames are DNS-resolved and
   * re-checked against the internal-address ranges.
   * @see RefResolutionOptions
   */
  refResolution?: RefResolutionOptions;
}

/**
 * Operation object with additional context for filtering
 */
export type OperationWithContext = OperationObject & {
  path: string;
  method: string;
};

/**
 * Options for generating tools
 */
export interface GenerateOptions {
  /**
   * Include only these operation IDs
   */
  includeOperations?: string[];

  /**
   * Exclude these operation IDs
   */
  excludeOperations?: string[];

  /**
   * Custom filter function
   */
  filterFn?: (operation: OperationWithContext) => boolean;

  /**
   * Include only operations carrying at least one of these OpenAPI tags
   */
  includeTags?: string[];

  /**
   * Exclude operations carrying any of these OpenAPI tags
   */
  excludeTags?: string[];

  /**
   * Include only these HTTP methods
   */
  includeMethods?: HTTPMethod[];

  /**
   * Exclude these HTTP methods
   */
  excludeMethods?: HTTPMethod[];

  /**
   * Include only paths matching at least one of these globs.
   * `*` matches within a path segment, `**` across segments, `?` one character
   * (e.g. `/users/*`, `/admin/**`).
   */
  includePaths?: string[];

  /**
   * Exclude paths matching any of these globs
   */
  excludePaths?: string[];

  /**
   * Safety switch: include only operations whose effective annotations say
   * `readOnlyHint: true` (HTTP-method inference merged with extension
   * overrides, regardless of `inferAnnotations`).
   */
  readOnlyOnly?: boolean;

  /**
   * Naming strategy for resolving conflicts
   */
  namingStrategy?: NamingStrategy;

  /**
   * Preferred response status codes (in order of preference)
   * @default [200, 201, 204, 202, 203, 206]
   */
  preferredStatusCodes?: number[];

  /**
   * Whether to include deprecated operations
   * @default false
   */
  includeDeprecated?: boolean;

  /**
   * Whether to include all response codes in output schema
   * If false, only preferred status code is used
   * @default true
   */
  includeAllResponses?: boolean;

  /**
   * Maximum schema nesting depth retained in generated input/output schemas.
   * Structures nested deeper than this are truncated: child schemas are
   * stripped and a truncation note is appended to the node's description.
   * Clamped to a minimum of 1 so the root schema always keeps its properties.
   * @default 10
   */
  maxSchemaDepth?: number;

  /**
   * How the tool description is assembled from the operation:
   * - `summaryOnly` (default): summary, else description, else `METHOD path`
   * - `descriptionOnly`: description, else summary, else `METHOD path`
   * - `combined`: summary + blank line + description (whichever exist)
   * - `full`: summary, description, `Operation: <id>`, and `METHOD path`
   * An `x-mcp`-family description override always wins over the strategy.
   * @default 'summaryOnly'
   */
  descriptionStrategy?: 'summaryOnly' | 'descriptionOnly' | 'combined' | 'full';

  /**
   * Append a compact `Returns: ...` line to each tool description,
   * summarizing the output schema (top-level shape and field names) — cheap
   * context that measurably improves result-handling without shipping the
   * whole response schema in prose.
   * @default false
   */
  appendResponseSummary?: boolean;

  /**
   * Limit object nodes in generated schemas to their first N properties
   * (declaration order). Dropped properties are pruned from `required` and
   * counted in a description note. The ROOT of `inputSchema` is exempt: its
   * properties are mapper-backed parameters, so the cap applies inside each
   * parameter subtree (and throughout output schemas). Unset = no limit.
   */
  maxProperties?: number;

  /**
   * Cap every description in generated schemas to N characters (ellipsis
   * truncation). Unset = no cap.
   */
  maxDescriptionLength?: number;

  /**
   * Remove all `examples` arrays from generated schemas — a token-budget
   * trimming step that leaves validation keywords untouched.
   * @default false
   */
  stripExamples?: boolean;

  /**
   * Include OpenAPI parameter-level and media-type-level `example`/`examples`
   * values in generated schemas (as JSON Schema `examples` arrays). These
   * override schema-level examples where present. Schema-level `example`
   * keywords are always normalized to `examples` regardless of this option.
   * @default false
   */
  includeExamples?: boolean;

  /**
   * Whether to include security requirements as input parameters.
   * - `false` (default): security lives only in the mapper (frameworks
   *   resolve credentials from context/env/vaults)
   * - `true`: every security scheme is added to inputSchema as a required
   *   string property
   * - `string[]`: only the named schemes appear in inputSchema; the rest stay
   *   mapper-only (all schemes are always present in the mapper)
   * @default false
   */
  includeSecurityInInput?: boolean | string[];

  /**
   * Target client schema dialect. Every MCP client accepts a different JSON
   * Schema subset; setting a target applies the transforms that make the
   * generated input/output schemas valid for it: `strict` (safe baseline —
   * local $refs inlined, arrays get `items`, root compositions collapsed),
   * `claude` (= strict), `openai` (strict + closed objects), `gemini`
   * (strict + all unions collapsed + unsupported formats demoted).
   * See `applyClientTarget` for standalone use.
   */
  target?: import('./client-targets').ClientTarget;

  /**
   * Infer MCP tool annotations from HTTP method semantics:
   * GET/HEAD/OPTIONS/TRACE -> read-only + idempotent; PUT/DELETE ->
   * destructive + idempotent; POST/PATCH -> destructive, not idempotent.
   * `openWorldHint` defaults to false (a known API backend is a closed world).
   * Extension overrides (`x-speakeasy-mcp`, `x-mcp`, `x-frontmcp`) are applied
   * on top of the inferred values regardless of this flag.
   * @default true
   */
  inferAnnotations?: boolean;

  /**
   * Maximum length for generated tool names. Names longer than this are
   * truncated and given a short hash suffix derived from the full name, so
   * truncated names stay unique and stable across regenerations.
   *
   * MCP tool names may be 1-128 characters of `[A-Za-z0-9_.-]` (values above
   * 128 are clamped to 128). The default of 64 matches the strictest common
   * client limits (Claude / Bedrock cap tool names at 64 characters).
   * @default 64
   */
  maxToolNameLength?: number;

  /**
   * Enable built-in format-to-schema resolution.
   * Enriches schemas with concrete constraints (patterns, descriptions, min/max)
   * based on OpenAPI format values (uuid, date-time, email, int32, etc.).
   * @default false
   */
  resolveFormats?: boolean;

  /**
   * Custom format resolvers. Keys are format names, values are functions
   * that receive the original schema and return an enriched schema.
   *
   * When used with `resolveFormats: true`, custom resolvers are merged with
   * built-in resolvers (custom takes precedence for the same format).
   * When used without `resolveFormats`, only custom resolvers are applied.
   */
  formatResolvers?: Record<string, FormatResolver>;
}

/**
 * A function that enriches a JSON Schema based on its format field.
 * Receives the schema and returns a new schema with additional constraints.
 */
export type FormatResolver = (schema: JsonSchema) => JsonSchema;

/**
 * Naming strategy for resolving parameter conflicts
 */
export interface NamingStrategy {
  /**
   * Resolver function for parameter name conflicts
   * @param paramName - Original parameter name
   * @param location - Parameter location
   * @param index - Index of conflicting parameter (0-based)
   * @returns New parameter name
   */
  conflictResolver: (paramName: string, location: ParameterLocation, index: number) => string;

  /**
   * Function to generate tool names
   * @param path - OpenAPI path
   * @param method - HTTP method
   * @param operationId - Operation ID if available
   * @returns Tool name
   */
  toolNameGenerator?: (path: string, method: HTTPMethod, operationId?: string) => string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  /**
   * Whether the document is valid
   */
  valid: boolean;

  /**
   * Validation errors
   */
  errors?: ValidationErrorDetail[];

  /**
   * Validation warnings
   */
  warnings?: ValidationWarning[];
}

/**
 * Validation error detail
 */
export interface ValidationErrorDetail {
  /**
   * Error message
   */
  message: string;

  /**
   * Error path (JSON pointer)
   */
  path?: string;

  /**
   * Error code
   */
  code?: string;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  /**
   * Warning message
   */
  message: string;

  /**
   * Warning path (JSON pointer)
   */
  path?: string;

  /**
   * Warning code
   */
  code?: string;
}
