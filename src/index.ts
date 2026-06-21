// Main exports
export { OpenAPIToolGenerator } from './generator';
export { SchemaBuilder } from './schema-builder';
export { ParameterResolver } from './parameter-resolver';
export { ResponseBuilder } from './response-builder';
export { Validator } from './validator';
export { SecurityResolver, createSecurityContext } from './security-resolver';
export { BUILTIN_FORMAT_RESOLVERS, resolveSchemaFormats } from './format-resolver';

// Error exports
export { OpenAPIToolError, LoadError, SsrfError, ParseError, ValidationError, GenerationError, SchemaError } from './errors';

// SSRF protection (shared by spec-URL loading and $ref resolution; usable by
// consumers that fetch spec URLs themselves, e.g. pollers)
export {
  assertUrlSafe,
  safeFetch,
  isBlockedAddress,
  isBlockedHostname,
  decodeIpv4MappedIpv6,
  normalizeSsrfOptions,
  defaultLookup,
  BLOCKED_HOSTNAMES,
} from './ssrf';
export type { ResolvedSsrfOptions, ResolvedAddress, SsrfHostLookup, SafeFetchOptions } from './ssrf';

// Type exports
export type {
  // Main MCP types
  McpOpenAPITool,
  ParameterMapper,
  ToolMetadata,
  FrontMcpExtensionData,
  SerializationInfo,
  SecurityRequirement,
  SecurityParameterInfo,
  ServerInfo,

  // Configuration types
  RefResolutionOptions,
  LoadOptions,
  GenerateOptions,
  FormatResolver,
  JsonSchema,
  NamingStrategy,
  OperationWithContext,

  // Basic types
  OpenAPIDocument,
  OpenAPIVersion,
  HTTPMethod,
  ParameterLocation,
  AuthType,

  // Re-exported OpenAPI types (from openapi-types package)
  OperationObject,
  ParameterObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  MediaTypeObject,
  HeaderObject,
  ExampleObject,
  PathItemObject,
  PathsObject,
  ServerObject,
  SecuritySchemeObject,
  ReferenceObject,
  TagObject,
  ExternalDocumentationObject,
  ServerVariableObject,
  EncodingObject,
  SecurityRequirementObject,
  SchemaObject,

  // Validation types
  ValidationResult,
  ValidationErrorDetail,
  ValidationWarning,
} from './types';

// Security resolver types
export type {
  SecurityContext,
  ResolvedSecurity,
  DigestAuthCredentials,
  ClientCertificate,
  AWSCredentials,
  SignatureData,
} from './security-resolver';

// Utility exports
export { isReferenceObject, toJsonSchema } from './types';
