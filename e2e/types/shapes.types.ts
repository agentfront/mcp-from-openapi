/**
 * The shape of each object, stated with types so that no second error can hide
 * it: which keys are required, which exist in which version, and what a field
 * holds. The required sets are the ones in the official JSON Schemas under
 * `e2e/fixtures/oas/schemas`. Compiled by `yarn typecheck`, never executed
 * (see README.md).
 */
import type {
  ExampleObject,
  MediaTypeObject,
  OAS30,
  OAS31,
  OAS32,
  ParameterObject,
  ReferenceObject,
  ResponseObject,
  SchemaObject,
  SchemaOrBoolean,
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
