// Main exports
export { OpenAPIToolGenerator } from './generator';
export { SchemaBuilder } from './schema-builder';
export { ParameterResolver } from './parameter-resolver';
export { ResponseBuilder } from './response-builder';
export { Validator } from './validator';
export { SecurityResolver, createSecurityContext } from './security-resolver';
export { BUILTIN_FORMAT_RESOLVERS, resolveSchemaFormats } from './format-resolver';
export { inferAnnotationsFromMethod, extractExtensionOverrides, resolveExtensionEnabled } from './annotations';
export type { ExtensionToolOverrides } from './annotations';

// TypeScript call-signature emission
export { emitToolTypeScript, toPascalIdentifier } from './type-signature';
export type { ToolTypeScriptInfo, TypeSignatureOptions } from './type-signature';

// Naming presets
export { dottedNaming, CODECALL_RESERVED_NAMESPACES } from './naming-presets';
export type { DottedNamingOptions } from './naming-presets';

// Security elicitation descriptors
export { deriveSecurityElicitations } from './elicitation';
export type { SecurityElicitation, ElicitationField } from './elicitation';

// Arazzo 1.0 workflows
export { fromArazzo } from './arazzo';
export type { FromArazzoOptions, ArazzoGenerateOptions } from './arazzo';
export { parseRuntimeExpression } from './arazzo-expressions';
export type {
  ArazzoDocument,
  ArazzoInfo,
  ArazzoSourceDescription,
  ArazzoWorkflow,
  ArazzoStep,
  ArazzoParameter,
  ArazzoRequestBody,
  ArazzoPayloadReplacement,
  ArazzoCriterion,
  ArazzoCriterionType,
  ArazzoSuccessAction,
  ArazzoFailureAction,
  ArazzoReusableObject,
  ArazzoComponents,
  WorkflowIR,
  WorkflowStepIR,
  OperationStepIR,
  NestedWorkflowStepIR,
  StepOperationIR,
  StepParameterIR,
  StepRequestBodyIR,
  PayloadExpressionIR,
  PayloadReplacementIR,
  CriterionIR,
  ActionIR,
  RuntimeExpressionAST,
  RuntimeExpressionType,
  ExpressionValueIR,
} from './arazzo-types';
export {
  applyClientTarget,
  inlineLocalRefs,
  ensureArrayItems,
  collapseRootCompositions,
  collapseNestedUnions,
  demoteFormats,
  enforceClosedObjects,
  requireAllProperties,
} from './client-targets';
export type { ClientTarget } from './client-targets';

// Request building
export { buildHttpRequest } from './request-builder';
export type { BuildHttpRequestOptions, BuiltHttpRequest } from './request-builder';

// MCP SDK integration
export { toSdkTool } from './sdk';
export type { SdkToolConfig, SdkSchemaWrapper } from './sdk';

// Context-budget analysis
export { estimateToolTokens, analyzeToolSet } from './token-report';
export type { ToolTokenEstimate, ToolSetReport, AnalyzeToolSetOptions } from './token-report';

// OpenAPI Overlay support
export { applyOverlay } from './overlay';
export type { OverlayDocument, OverlayAction } from './overlay';

// Agent-readiness lint
export { lintDocument } from './lint';
export type { LintResult, LintFinding, LintSeverity } from './lint';

// Error exports
export { OpenAPIToolError, LoadError, SsrfError, ParseError, ValidationError, GenerationError, SchemaError, RequestBuildError, OverlayError, ArazzoError } from './errors';

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
  ToolAnnotations,
  ToolIcon,
  ParameterMapper,
  ToolMetadata,
  ResponseHints,
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
