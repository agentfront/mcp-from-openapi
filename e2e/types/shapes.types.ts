/**
 * The shape of each object, stated with types so that no second error can hide
 * it: which keys are required, which exist in which version, and what a field
 * holds. The required sets are the ones in the official JSON Schemas under
 * `e2e/fixtures/oas/schemas`. Compiled by `yarn typecheck`, never executed
 * (see README.md).
 */
import type {
  BuiltHttpRequest,
  DIAGNOSTIC_CODES,
  DiagnosticCode,
  ExampleObject,
  GenerateOptions,
  HTTPMethod,
  JsonSchema,
  MediaTypeObject,
  OAS30,
  OAS31,
  OAS32,
  OpenAPIToolGenerator,
  OpenAPIVersion,
  OperationLayout,
  ParameterLocation,
  ParameterMapper,
  ParameterObject,
  ReferenceObject,
  ResponseHints,
  ResponseObject,
  ResponseStreamInfo,
  SchemaObject,
  SchemaOrBoolean,
  SerializationInfo,
  ServerInfo,
  SpecDiagnostic,
  SpecFamily,
  SpecVersionInfo,
  SpecVersionStatus,
  StandardMethod,
  ToolMetadata,
  buildHttpRequest,
  resolveOperationLayout,
} from 'mcp-from-openapi';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Extends<A, B> = [A] extends [B] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;
type IsAny<T> = 0 extends 1 & T ? true : false;

/** The keys a value of `T` must have. */
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
/** The keys a value of `T` may leave out. */
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
/** Whether `T` declares the key `K`. */
type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;
/** The value of an optional field, without `undefined`. */
type Field<T, K extends keyof T> = NonNullable<T[K]>;

// ---------------------------------------------------------------------------
// Required keys
// ---------------------------------------------------------------------------

export type RootRequiredKeys = [
  Expect<Equal<RequiredKeys<OAS30.OpenAPIObject>, 'openapi' | 'info' | 'paths'>>,
  Expect<Equal<RequiredKeys<OAS31.OpenAPIObject>, 'openapi' | 'info'>>,
  Expect<Equal<RequiredKeys<OAS32.OpenAPIObject>, 'openapi' | 'info'>>,
];

export type InfoRequiredKeys = [
  Expect<Equal<RequiredKeys<OAS30.InfoObject>, 'title' | 'version'>>,
  Expect<Equal<RequiredKeys<OAS31.InfoObject>, 'title' | 'version'>>,
  Expect<Equal<RequiredKeys<OAS32.InfoObject>, 'title' | 'version'>>,
];

/** `responses` is required in 3.0 and optional from 3.1. */
export type OperationRequiredKeys = [
  Expect<Equal<RequiredKeys<OAS30.OperationObject>, 'responses'>>,
  Expect<Equal<RequiredKeys<OAS31.OperationObject>, never>>,
  Expect<Equal<RequiredKeys<OAS32.OperationObject>, never>>,
  Expect<Extends<'responses', OptionalKeys<OAS31.OperationObject>>>,
  Expect<Extends<'responses', OptionalKeys<OAS32.OperationObject>>>,
];

/** `description` is required in 3.0 and 3.1 and optional from 3.2. */
export type ResponseRequiredKeys = [
  Expect<Equal<RequiredKeys<OAS30.ResponseObject>, 'description'>>,
  Expect<Equal<RequiredKeys<OAS31.ResponseObject>, 'description'>>,
  Expect<Equal<RequiredKeys<OAS32.ResponseObject>, never>>,
  Expect<Extends<'description', OptionalKeys<OAS32.ResponseObject>>>,
  Expect<Extends<'summary', OptionalKeys<OAS32.ResponseObject>>>,
];

export type ParameterRequiredKeys = [
  Expect<Equal<RequiredKeys<OAS30.ParameterObject>, 'name' | 'in'>>,
  Expect<Equal<RequiredKeys<OAS31.ParameterObject>, 'name' | 'in'>>,
  Expect<Equal<RequiredKeys<OAS32.ParameterObject>, 'name' | 'in'>>,
];

export type SmallObjectsRequiredKeys = [
  Expect<Equal<RequiredKeys<OAS30.RequestBodyObject>, 'content'>>,
  Expect<Equal<RequiredKeys<OAS31.RequestBodyObject>, 'content'>>,
  Expect<Equal<RequiredKeys<OAS32.RequestBodyObject>, 'content'>>,
  Expect<Equal<RequiredKeys<OAS30.ServerObject>, 'url'>>,
  Expect<Equal<RequiredKeys<OAS32.ServerObject>, 'url'>>,
  Expect<Equal<RequiredKeys<OAS30.ServerVariableObject>, 'default'>>,
  Expect<Equal<RequiredKeys<OAS31.ServerVariableObject>, 'default'>>,
  Expect<Equal<RequiredKeys<OAS30.ReferenceObject>, '$ref'>>,
  Expect<Equal<RequiredKeys<OAS31.ReferenceObject>, '$ref'>>,
  Expect<Equal<RequiredKeys<OAS32.ReferenceObject>, '$ref'>>,
  Expect<Equal<RequiredKeys<OAS30.TagObject>, 'name'>>,
  Expect<Equal<RequiredKeys<OAS32.TagObject>, 'name'>>,
  Expect<Equal<RequiredKeys<OAS30.LicenseObject>, 'name'>>,
  Expect<Equal<RequiredKeys<OAS31.LicenseObject>, 'name'>>,
  Expect<Equal<RequiredKeys<OAS30.ExternalDocumentationObject>, 'url'>>,
  Expect<Equal<RequiredKeys<OAS32.ExternalDocumentationObject>, 'url'>>,
  Expect<Equal<RequiredKeys<OAS30.DiscriminatorObject>, 'propertyName'>>,
  Expect<Equal<RequiredKeys<OAS32.DiscriminatorObject>, 'propertyName'>>,
  Expect<Equal<RequiredKeys<OAS30.SecuritySchemeObject>, 'type'>>,
  Expect<Equal<RequiredKeys<OAS31.SecuritySchemeObject>, 'type'>>,
  Expect<Equal<RequiredKeys<OAS32.SecuritySchemeObject>, 'type'>>,
];

/** Each OAuth flow requires the URLs it uses, and every flow requires `scopes`. */
export type OAuthFlowRequiredKeys = [
  Expect<Equal<RequiredKeys<Field<OAS30.OAuthFlowsObject, 'implicit'>>, 'authorizationUrl' | 'scopes'>>,
  Expect<Equal<RequiredKeys<Field<OAS30.OAuthFlowsObject, 'password'>>, 'tokenUrl' | 'scopes'>>,
  Expect<Equal<RequiredKeys<Field<OAS30.OAuthFlowsObject, 'clientCredentials'>>, 'tokenUrl' | 'scopes'>>,
  Expect<
    Equal<RequiredKeys<Field<OAS30.OAuthFlowsObject, 'authorizationCode'>>, 'authorizationUrl' | 'tokenUrl' | 'scopes'>
  >,
  Expect<Equal<RequiredKeys<Field<OAS31.OAuthFlowsObject, 'implicit'>>, 'authorizationUrl' | 'scopes'>>,
  Expect<Equal<RequiredKeys<Field<OAS31.OAuthFlowsObject, 'password'>>, 'tokenUrl' | 'scopes'>>,
  Expect<Equal<RequiredKeys<Field<OAS31.OAuthFlowsObject, 'clientCredentials'>>, 'tokenUrl' | 'scopes'>>,
  Expect<
    Equal<RequiredKeys<Field<OAS31.OAuthFlowsObject, 'authorizationCode'>>, 'authorizationUrl' | 'tokenUrl' | 'scopes'>
  >,
  Expect<Equal<RequiredKeys<Field<OAS32.OAuthFlowsObject, 'implicit'>>, 'authorizationUrl' | 'scopes'>>,
  Expect<Equal<RequiredKeys<Field<OAS32.OAuthFlowsObject, 'password'>>, 'tokenUrl' | 'scopes'>>,
  Expect<Equal<RequiredKeys<Field<OAS32.OAuthFlowsObject, 'clientCredentials'>>, 'tokenUrl' | 'scopes'>>,
  Expect<
    Equal<RequiredKeys<Field<OAS32.OAuthFlowsObject, 'authorizationCode'>>, 'authorizationUrl' | 'tokenUrl' | 'scopes'>
  >,
  // New in 3.2: the device flow requires both of its URLs
  Expect<
    Equal<
      RequiredKeys<Field<OAS32.OAuthFlowsObject, 'deviceAuthorization'>>,
      'deviceAuthorizationUrl' | 'tokenUrl' | 'scopes'
    >
  >,
  // Not required by any flow
  Expect<Extends<'refreshUrl', OptionalKeys<OAS32.OAuthFlowObject>>>,
];

// ---------------------------------------------------------------------------
// Keys that exist in one version and not in another
// ---------------------------------------------------------------------------

export type NewIn32 = [
  Expect<Not<Has<OAS30.PathItemObject, 'query'>>>,
  Expect<Not<Has<OAS31.PathItemObject, 'query'>>>,
  Expect<Has<OAS32.PathItemObject, 'query'>>,
  Expect<Not<Has<OAS31.PathItemObject, 'additionalOperations'>>>,
  Expect<Has<OAS32.PathItemObject, 'additionalOperations'>>,
  Expect<Not<Has<OAS31.OpenAPIObject, '$self'>>>,
  Expect<Has<OAS32.OpenAPIObject, '$self'>>,
  Expect<Not<Has<OAS31.ServerObject, 'name'>>>,
  Expect<Has<OAS32.ServerObject, 'name'>>,
  Expect<Not<Has<OAS31.TagObject, 'parent'>>>,
  Expect<Not<Has<OAS31.TagObject, 'kind'>>>,
  Expect<Not<Has<OAS31.TagObject, 'summary'>>>,
  Expect<Has<OAS32.TagObject, 'parent'>>,
  Expect<Has<OAS32.TagObject, 'kind'>>,
  Expect<Has<OAS32.TagObject, 'summary'>>,
  Expect<Not<Has<OAS31.ResponseObject, 'summary'>>>,
  Expect<Has<OAS32.ResponseObject, 'summary'>>,
  Expect<Not<Has<OAS31.MediaTypeObject, 'itemSchema'>>>,
  Expect<Has<OAS32.MediaTypeObject, 'itemSchema'>>,
  Expect<Not<Has<OAS31.MediaTypeObject, 'prefixEncoding'>>>,
  Expect<Has<OAS32.MediaTypeObject, 'prefixEncoding'>>,
  Expect<Has<OAS32.MediaTypeObject, 'itemEncoding'>>,
  Expect<Not<Has<OAS31.ExampleObject, 'dataValue'>>>,
  Expect<Has<OAS32.ExampleObject, 'dataValue'>>,
  Expect<Has<OAS32.ExampleObject, 'serializedValue'>>,
  Expect<Not<Has<OAS31.ComponentsObject, 'mediaTypes'>>>,
  Expect<Has<OAS32.ComponentsObject, 'mediaTypes'>>,
  Expect<Not<Has<OAS31.OAuthFlowsObject, 'deviceAuthorization'>>>,
  Expect<Has<OAS32.OAuthFlowsObject, 'deviceAuthorization'>>,
  Expect<Not<Has<OAS31.SecuritySchemeObject, 'oauth2MetadataUrl'>>>,
  Expect<Has<OAS32.SecuritySchemeObject, 'oauth2MetadataUrl'>>,
  Expect<Not<Has<OAS31.SecuritySchemeObject, 'deprecated'>>>,
  Expect<Has<OAS32.SecuritySchemeObject, 'deprecated'>>,
  Expect<Not<Has<OAS31.DiscriminatorObject, 'defaultMapping'>>>,
  Expect<Has<OAS32.DiscriminatorObject, 'defaultMapping'>>,
  Expect<Not<Has<OAS31.XMLObject, 'nodeType'>>>,
  Expect<Has<OAS32.XMLObject, 'nodeType'>>,
];

export type NewIn31 = [
  Expect<Not<Has<OAS30.OpenAPIObject, 'webhooks'>>>,
  Expect<Has<OAS31.OpenAPIObject, 'webhooks'>>,
  Expect<Not<Has<OAS30.OpenAPIObject, 'jsonSchemaDialect'>>>,
  Expect<Has<OAS31.OpenAPIObject, 'jsonSchemaDialect'>>,
  Expect<Not<Has<OAS30.InfoObject, 'summary'>>>,
  Expect<Has<OAS31.InfoObject, 'summary'>>,
  Expect<Not<Has<OAS30.LicenseObject, 'identifier'>>>,
  Expect<Has<OAS31.LicenseObject, 'identifier'>>,
  Expect<Not<Has<OAS30.ComponentsObject, 'pathItems'>>>,
  Expect<Has<OAS31.ComponentsObject, 'pathItems'>>,
  Expect<Not<Has<OAS30.ReferenceObject, 'summary'>>>,
  Expect<Has<OAS31.ReferenceObject, 'summary'>>,
  Expect<Not<Has<OAS30.SchemaObject, 'const'>>>,
  Expect<Has<OAS31.SchemaObject, 'const'>>,
  Expect<Not<Has<OAS30.SchemaObject, 'prefixItems'>>>,
  Expect<Has<OAS31.SchemaObject, 'prefixItems'>>,
  Expect<Has<OAS30.SchemaObject, 'nullable'>>,
  Expect<Not<Has<OAS31.SchemaObject, 'nullable'>>>,
  Expect<Not<Has<OAS32.SchemaObject, 'nullable'>>>,
];

// ---------------------------------------------------------------------------
// What a field holds
// ---------------------------------------------------------------------------

/** A 3.1 Reference Object may override the summary and description of its target. */
export type ReferenceFields = [
  Expect<Equal<OAS31.ReferenceObject['summary'], string | undefined>>,
  Expect<Equal<OAS31.ReferenceObject['description'], string | undefined>>,
  Expect<Equal<OAS32.ReferenceObject['summary'], string | undefined>>,
  Expect<Equal<OAS31.ReferenceObject['$ref'], string>>,
];

/** From 3.1 a schema may be `true` or `false` wherever a schema is allowed. */
export type BooleanSchemas = [
  Expect<Extends<true, Field<OAS31.MediaTypeObject, 'schema'>>>,
  Expect<Extends<false, Field<OAS31.MediaTypeObject, 'schema'>>>,
  Expect<Extends<SchemaObject, Field<OAS31.MediaTypeObject, 'schema'>>>,
  Expect<Extends<true, Field<OAS32.MediaTypeObject, 'schema'>>>,
  Expect<Extends<false, Field<OAS32.MediaTypeObject, 'schema'>>>,
  Expect<Extends<true, Field<OAS32.MediaTypeObject, 'itemSchema'>>>,
  Expect<Extends<true, Field<OAS31.ParameterObject, 'schema'>>>,
  Expect<Extends<true, Field<OAS32.ParameterObject, 'schema'>>>,
  Expect<Extends<true, Field<OAS31.HeaderObject, 'schema'>>>,
  Expect<Extends<true, Field<OAS31.ComponentsObject, 'schemas'>[string]>>,
  Expect<Extends<false, Field<OAS31.ComponentsObject, 'schemas'>[string]>>,
  Expect<Extends<true, NonNullable<NonNullable<OAS31.SchemaObject['properties']>[string]>>>,
  Expect<Extends<false, NonNullable<NonNullable<OAS31.SchemaObject['items']>>>>,
  Expect<Extends<true, NonNullable<OAS32.SchemaObject['additionalProperties']>>>,
  Expect<Extends<false, NonNullable<NonNullable<OAS32.SchemaObject['allOf']>[number]>>>,
  Expect<Extends<true, SchemaOrBoolean>>,
  Expect<Extends<false, SchemaOrBoolean>>,
];

/** In 3.0 a schema is an object or a reference; a boolean schema is not a 3.0 concept. */
export type NoBooleanSchemas30 = [
  Expect<Not<Extends<true, Field<OAS30.MediaTypeObject, 'schema'>>>>,
  Expect<Not<Extends<false, Field<OAS30.MediaTypeObject, 'schema'>>>>,
  Expect<Not<Extends<true, Field<OAS30.ParameterObject, 'schema'>>>>,
  Expect<Not<Extends<true, Field<OAS30.ComponentsObject, 'schemas'>[string]>>>,
  Expect<Not<Extends<true, NonNullable<NonNullable<OAS30.SchemaObject['properties']>[string]>>>>,
  Expect<Not<Extends<true, NonNullable<OAS30.SchemaObject['items']>>>>,
  // `additionalProperties` is the one place 3.0 takes a boolean
  Expect<Extends<true, NonNullable<OAS30.SchemaObject['additionalProperties']>>>,
];

/** The Schema Object is the object form only. */
export type SchemaObjectIsObjectOnly = [
  Expect<Not<Extends<boolean, SchemaObject>>>,
  Expect<Not<Extends<true, SchemaObject>>>,
  Expect<Not<Extends<false, SchemaObject>>>,
  Expect<Extends<SchemaObject, SchemaOrBoolean>>,
];

/** Maps hold a value or nothing: a lookup can miss. */
export type MapsHoldOptionalValues = [
  Expect<Equal<OAS31.PathsObject[string], OAS31.PathItemObject | undefined>>,
  Expect<Equal<OAS30.ResponsesObject[string], OAS30.ResponseObject | OAS30.ReferenceObject | undefined>>,
  Expect<Equal<OAS30.SecurityRequirementObject[string], string[] | undefined>>,
];

/** Response fields. `description` is a string where required and `string | undefined` where not. */
export type ResponseFields = [
  Expect<Equal<OAS30.ResponseObject['description'], string>>,
  Expect<Equal<OAS31.ResponseObject['description'], string>>,
  Expect<Equal<OAS32.ResponseObject['description'], string | undefined>>,
  Expect<Equal<OAS32.ResponseObject['summary'], string | undefined>>,
  Expect<Equal<ResponseObject['description'], string | undefined>>,
];

/** A parameter's location and style stay open strings. */
export type OpenStrings = [
  Expect<Extends<'query' | 'header' | 'path' | 'cookie', OAS30.ParameterObject['in']>>,
  Expect<Extends<'query' | 'querystring' | 'header' | 'path' | 'cookie', OAS32.ParameterObject['in']>>,
  Expect<Extends<string, OAS30.ParameterObject['in']>>,
  Expect<Extends<string, OAS32.ParameterObject['in']>>,
  Expect<Extends<string, NonNullable<ParameterObject['style']>>>,
  Expect<Extends<string, OAS31.SecuritySchemeObject['type']>>,
  Expect<Extends<string, NonNullable<OAS32.XMLObject['nodeType']>>>,
];

/**
 * Free-form values are `any`, so code written against earlier typings keeps
 * reading them directly (see reads.types.ts).
 */
export type FreeFormValues = [
  Expect<IsAny<NonNullable<SchemaObject['example']>>>,
  Expect<IsAny<NonNullable<SchemaObject['default']>>>,
  Expect<IsAny<NonNullable<SchemaObject['enum']>[number]>>,
  Expect<IsAny<NonNullable<OAS30.SchemaObject['enum']>[number]>>,
  Expect<IsAny<NonNullable<OAS31.SchemaObject['const']>>>,
  Expect<IsAny<NonNullable<OAS32.SchemaObject['examples']>[number]>>,
  Expect<IsAny<NonNullable<ParameterObject['example']>>>,
  Expect<IsAny<NonNullable<MediaTypeObject['example']>>>,
  Expect<IsAny<NonNullable<ExampleObject['value']>>>,
  Expect<IsAny<NonNullable<OAS31.LinkObject['parameters']>[string]>>,
  Expect<IsAny<NonNullable<OAS31.LinkObject['requestBody']>>>,
  Expect<IsAny<NonNullable<OAS32.ExampleObject['dataValue']>>>,
];

// ---------------------------------------------------------------------------
// HTTP methods, declared versions and diagnostics (see methods.types.ts)
// ---------------------------------------------------------------------------

/** The nine standard methods, and the open type that adds any other token. */
export type MethodTypes = [
  Expect<
    Equal<StandardMethod, 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options' | 'trace' | 'query'>
  >,
  Expect<Extends<StandardMethod, HTTPMethod>>,
  Expect<Extends<'LINK', HTTPMethod>>,
  Expect<Extends<string, HTTPMethod>>,
  Expect<Extends<HTTPMethod, string>>,
  Expect<Not<Extends<number, HTTPMethod>>>,
  // open, but not a plain `string`: the standard methods still autocomplete
  Expect<Not<Equal<HTTPMethod, string>>>,
  Expect<Equal<ToolMetadata['method'], HTTPMethod>>,
  Expect<Equal<GenerateOptions['includeMethods'], HTTPMethod[] | undefined>>,
  Expect<Equal<GenerateOptions['excludeMethods'], HTTPMethod[] | undefined>>,
];

/** Any `3.0.x`, `3.1.x` and `3.2.x` string, and no other. */
export type VersionTypes = [
  Expect<Equal<OpenAPIVersion, `3.0.${string}` | `3.1.${string}` | `3.2.${string}`>>,
  Expect<Extends<'3.0.4', OpenAPIVersion>>,
  Expect<Extends<'3.1.2', OpenAPIVersion>>,
  Expect<Extends<'3.2.1', OpenAPIVersion>>,
  Expect<Extends<'3.0.0' | '3.0.1' | '3.0.2' | '3.0.3' | '3.1.0', OpenAPIVersion>>,
  Expect<Not<Extends<'3.3.0', OpenAPIVersion>>>,
  Expect<Not<Extends<string, OpenAPIVersion>>>,
  Expect<Equal<SpecFamily, '3.0' | '3.1' | '3.2'>>,
];

/** A diagnostic always has a severity, a code and a message; the pointer is optional. */
export type DiagnosticShape = [
  Expect<Equal<RequiredKeys<SpecDiagnostic>, 'severity' | 'code' | 'message'>>,
  Expect<Equal<OptionalKeys<SpecDiagnostic>, 'path'>>,
  Expect<Equal<SpecDiagnostic['severity'], 'warning' | 'info'>>,
  Expect<Equal<SpecDiagnostic['code'], string>>,
  Expect<Equal<SpecDiagnostic['message'], string>>,
  Expect<Equal<SpecDiagnostic['path'], string | undefined>>,
  Expect<Equal<ReturnType<OpenAPIToolGenerator['getDiagnostics']>, SpecDiagnostic[]>>,
];

/** The declared version: a status and the diagnostics always, the rest when the document gives it. */
export type SpecVersionShape = [
  Expect<Equal<RequiredKeys<SpecVersionInfo>, 'status' | 'diagnostics'>>,
  Expect<Equal<OptionalKeys<SpecVersionInfo>, 'field' | 'declared' | 'major' | 'minor' | 'family'>>,
  Expect<Equal<SpecVersionInfo['status'], SpecVersionStatus>>,
  Expect<Equal<SpecVersionInfo['family'], SpecFamily | undefined>>,
  Expect<Equal<SpecVersionInfo['major'], number | undefined>>,
  Expect<Equal<SpecVersionInfo['minor'], number | undefined>>,
  Expect<Equal<SpecVersionInfo['diagnostics'], SpecDiagnostic[]>>,
  // the declared value is whatever the document holds, so it must be narrowed before use
  Expect<Equal<SpecVersionInfo['declared'], unknown>>,
  Expect<Equal<ReturnType<OpenAPIToolGenerator['getSpecVersion']>, SpecVersionInfo>>,
  Expect<
    Equal<SpecVersionStatus, 'supported' | 'newer-minor' | 'swagger-2.0' | 'unsupported' | 'malformed' | 'missing'>
  >,
];

/**
 * A diagnostic's `code` is a plain string, and `DIAGNOSTIC_CODES` is the one registry of the codes
 * the generator documents: the spec layer's (the declared version, the Path Item walk) and the
 * generator's own (version rejection, validator warnings, security, parameter locations, the cap).
 */
export type DiagnosticCodes = [
  Expect<Equal<SpecDiagnostic['code'], string>>,
  Expect<Extends<DiagnosticCode, SpecDiagnostic['code']>>,
  // a closed union, not a string: a code can be compared with the registry exhaustively
  Expect<Not<Extends<string, DiagnosticCode>>>,
  // every key is its own value
  Expect<Equal<keyof typeof DIAGNOSTIC_CODES, DiagnosticCode>>,
  Expect<Equal<(typeof DIAGNOSTIC_CODES)['UNRESOLVED_SECURITY_SCHEME'], 'UNRESOLVED_SECURITY_SCHEME'>>,
  // spec layer
  Expect<
    Extends<
      'NEWER_OPENAPI_VERSION' | 'FEATURE_NEWER_THAN_DECLARED_VERSION' | 'INVALID_METHOD_TOKEN' | 'REFUSED_METHOD',
      DiagnosticCode
    >
  >,
  // generator level
  Expect<
    Extends<
      | 'INVALID_OPENAPI_VERSION'
      | 'MISSING_OPENAPI_VERSION'
      | 'NO_OPERATION_ID'
      | 'UNRESOLVED_SECURITY_SCHEME'
      | 'UNSATISFIABLE_SECURITY'
      | 'UNSUPPORTED_PARAMETER_LOCATION'
      | 'DIAGNOSTICS_TRUNCATED',
      DiagnosticCode
    >
  >,
  // parameters (OpenAPI 3.2 `querystring`, `content`) and streamed bodies
  Expect<
    Extends<
      | 'MULTIPLE_QUERYSTRING_PARAMETERS'
      | 'QUERYSTRING_WITH_QUERY_PARAMETERS'
      | 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT'
      | 'INVALID_PARAMETER_CONTENT'
      | 'DUPLICATE_PARAMETER'
      | 'UNSUPPORTED_STREAMING_REQUEST_BODY',
      DiagnosticCode
    >
  >,
  Expect<Equal<(typeof DIAGNOSTIC_CODES)['MULTIPLE_QUERYSTRING_PARAMETERS'], 'MULTIPLE_QUERYSTRING_PARAMETERS'>>,
  Expect<Equal<(typeof DIAGNOSTIC_CODES)['UNSUPPORTED_STREAMING_REQUEST_BODY'], 'UNSUPPORTED_STREAMING_REQUEST_BODY'>>,
];

/** Which operations a version defines: the layout `listOperations` and `getOperation` take. */
export type OperationLayoutShape = [
  Expect<Equal<RequiredKeys<OperationLayout>, 'fixedMethods' | 'additionalOperations'>>,
  Expect<Equal<OperationLayout['fixedMethods'], readonly StandardMethod[]>>,
  Expect<Equal<OperationLayout['additionalOperations'], boolean>>,
  Expect<Equal<ReturnType<typeof resolveOperationLayout>, OperationLayout>>,
  Expect<Equal<Parameters<typeof resolveOperationLayout>, [version: SpecVersionInfo]>>,
];

// ---------------------------------------------------------------------------
// The generated tool: the mapper, the metadata and the built request (see tools.types.ts)
// ---------------------------------------------------------------------------

/**
 * A mapper entry names an input key, a location and the parameter. `wholeQuery` marks the entry whose value IS
 * the whole query string (OpenAPI 3.2 `in: querystring`) and holds the literal `true`, never `false`: an entry
 * either is one or leaves it out. `wholeBody` is the older marker and holds a plain boolean.
 */
export type MapperShape = [
  Expect<Equal<RequiredKeys<ParameterMapper>, 'inputKey' | 'type' | 'key'>>,
  Expect<Extends<'wholeQuery' | 'wholeBody' | 'serialization', OptionalKeys<ParameterMapper>>>,
  Expect<Equal<ParameterMapper['wholeQuery'], true | undefined>>,
  Expect<Equal<ParameterMapper['wholeBody'], boolean | undefined>>,
  Expect<Equal<ParameterMapper['serialization'], SerializationInfo | undefined>>,
  // `querystring` is an OpenAPI location, not a mapper one: the whole query string is a `query` entry
  Expect<Equal<ParameterMapper['type'], ParameterLocation>>,
  Expect<Equal<ParameterLocation, 'path' | 'query' | 'header' | 'cookie' | 'body'>>,
  Expect<Not<Extends<'querystring', ParameterLocation>>>,
];

/**
 * `serialization` holds nothing required. `contentType` is the media type a body, a parameter defined with
 * `content` or a whole query string is serialized in.
 */
export type SerializationShape = [
  Expect<Equal<RequiredKeys<SerializationInfo>, never>>,
  Expect<Equal<OptionalKeys<SerializationInfo>, 'contentType' | 'encoding' | 'binary'>>,
  Expect<Equal<SerializationInfo['contentType'], string | undefined>>,
  Expect<Equal<SerializationInfo['binary'], boolean | undefined>>,
];

/** A streamed response (OpenAPI 3.2 `itemSchema`): the status code, the media type and the schema of each item. */
export type ResponseStreamShape = [
  Expect<Equal<RequiredKeys<ResponseStreamInfo>, 'statusCode' | 'contentType' | 'itemSchema'>>,
  Expect<Equal<OptionalKeys<ResponseStreamInfo>, never>>,
  Expect<Equal<ResponseStreamInfo['statusCode'], number>>,
  Expect<Equal<ResponseStreamInfo['contentType'], string>>,
  Expect<Equal<ResponseStreamInfo['itemSchema'], JsonSchema>>,
  // present only on a tool whose response streams
  Expect<Extends<'responseStream' | 'responseHints', OptionalKeys<ToolMetadata>>>,
  Expect<Equal<ToolMetadata['responseStream'], ResponseStreamInfo | undefined>>,
  Expect<Equal<ToolMetadata['responseHints'], ResponseHints | undefined>>,
  Expect<Equal<RequiredKeys<ResponseHints>, never>>,
  Expect<Equal<ResponseHints['streaming'], boolean | undefined>>,
];

/** A server's `name` (OpenAPI 3.2) is optional, like its description. */
export type ServerInfoShape = [
  Expect<Equal<RequiredKeys<ServerInfo>, 'url'>>,
  Expect<Equal<OptionalKeys<ServerInfo>, 'name' | 'description' | 'variables'>>,
  Expect<Equal<ServerInfo['name'], string | undefined>>,
  Expect<Equal<NonNullable<ToolMetadata['servers']>[number], ServerInfo>>,
];

/**
 * The built request always has the URL and the query pairs; `queryString` is there only when the query is a single
 * serialized value, not name/value pairs, and `url` stays the authoritative form.
 */
export type BuiltRequestShape = [
  Expect<Extends<'url' | 'method' | 'headers' | 'query' | 'cookies', RequiredKeys<BuiltHttpRequest>>>,
  Expect<Extends<'queryString', OptionalKeys<BuiltHttpRequest>>>,
  Expect<Equal<BuiltHttpRequest['queryString'], string | undefined>>,
  Expect<Equal<BuiltHttpRequest['query'], Record<string, string[]>>>,
  Expect<Equal<ReturnType<typeof buildHttpRequest>, BuiltHttpRequest>>,
];
