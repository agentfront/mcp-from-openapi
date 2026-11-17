/**
 * OpenAPI 3.1 object types.
 *
 * Written from the OpenAPI Specification 3.1.2 text
 * (https://spec.openapis.org/oas/v3.1.2), the OAI JSON Schema for 3.1
 * (https://spec.openapis.org/oas/3.1/schema/2026-11-05) and the OAS base
 * vocabulary for Schema Objects
 * (https://spec.openapis.org/oas/3.1/meta/2024-11-10). Object and field names
 * are the specification's own.
 *
 * These are reader types: they describe documents this library reads, so they
 * stay permissive where the specification lists values (enumerations are open
 * strings) and the validator, not the compiler, rejects invalid documents.
 * Specification extensions (`x-` fields) are not declared on any object; read
 * them through `WithExtensions`. Every deliberate deviation from the official
 * schema's value types is listed in `./index.ts`.
 *
 * @module
 */

import type { FreeFormValue, SpecMap } from './common';
import type { JsonSchema2020 } from './json-schema-2020-12';

/**
 * The root object of an OpenAPI 3.1 description. At least one of `paths`,
 * `components` and `webhooks` is present.
 * @see https://spec.openapis.org/oas/v3.1.2#openapi-object
 */
export type OpenAPIObject = {
  /** The version of the OpenAPI Specification the document uses, e.g. `3.1.2`. */
  openapi: string;
  info: InfoObject;
  /** Default `$schema` for the document's Schema Objects. */
  jsonSchemaDialect?: string;
  servers?: ServerObject[];
  paths?: PathsObject;
  /** Incoming requests the API consumer may receive, by name. */
  webhooks?: SpecMap<PathItemObject>;
  components?: ComponentsObject;
  security?: SecurityRequirementObject[];
  tags?: TagObject[];
  externalDocs?: ExternalDocumentationObject;
};

/**
 * Metadata about the API.
 * @see https://spec.openapis.org/oas/v3.1.2#info-object
 */
export type InfoObject = {
  title: string;
  summary?: string;
  description?: string;
  termsOfService?: string;
  contact?: ContactObject;
  license?: LicenseObject;
  /** The version of the API description (not of the specification). */
  version: string;
};

/** @see https://spec.openapis.org/oas/v3.1.2#contact-object */
export type ContactObject = {
  name?: string;
  url?: string;
  email?: string;
};

/**
 * `identifier` (an SPDX expression) and `url` are mutually exclusive.
 * @see https://spec.openapis.org/oas/v3.1.2#license-object
 */
export type LicenseObject = {
  name: string;
  identifier?: string;
  url?: string;
};

/**
 * A server the API is reachable at; `url` may contain `{variable}` templates.
 * @see https://spec.openapis.org/oas/v3.1.2#server-object
 */
export type ServerObject = {
  url: string;
  description?: string;
  variables?: SpecMap<ServerVariableObject>;
};

/** @see https://spec.openapis.org/oas/v3.1.2#server-variable-object */
export type ServerVariableObject = {
  enum?: string[];
  default: string;
  description?: string;
};

/**
 * Reusable objects, referenced from elsewhere in the document.
 * @see https://spec.openapis.org/oas/v3.1.2#components-object
 */
export type ComponentsObject = {
  schemas?: SpecMap<SchemaOrBoolean>;
  responses?: SpecMap<ResponseObject | ReferenceObject>;
  parameters?: SpecMap<ParameterObject | ReferenceObject>;
  examples?: SpecMap<ExampleObject | ReferenceObject>;
  requestBodies?: SpecMap<RequestBodyObject | ReferenceObject>;
  headers?: SpecMap<HeaderObject | ReferenceObject>;
  securitySchemes?: SpecMap<SecuritySchemeObject | ReferenceObject>;
  links?: SpecMap<LinkObject | ReferenceObject>;
  callbacks?: SpecMap<CallbackObject | ReferenceObject>;
  pathItems?: SpecMap<PathItemObject>;
};

/**
 * Relative paths (starting with `/`) to the operations they hold. A lookup
 * may find nothing, or an `x-` extension, so a value is checked before use.
 * @see https://spec.openapis.org/oas/v3.1.2#paths-object
 */
export type PathsObject = SpecMap<PathItemObject>;

/**
 * The operations available on a single path.
 * @see https://spec.openapis.org/oas/v3.1.2#path-item-object
 */
export type PathItemObject = {
  $ref?: string;
  summary?: string;
  description?: string;
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  delete?: OperationObject;
  options?: OperationObject;
  head?: OperationObject;
  patch?: OperationObject;
  trace?: OperationObject;
  servers?: ServerObject[];
  /** Parameters shared by every operation on this path. */
  parameters?: (ParameterObject | ReferenceObject)[];
};

/**
 * A single API operation on a path.
 * @see https://spec.openapis.org/oas/v3.1.2#operation-object
 */
export type OperationObject = {
  tags?: string[];
  summary?: string;
  description?: string;
  externalDocs?: ExternalDocumentationObject;
  operationId?: string;
  parameters?: (ParameterObject | ReferenceObject)[];
  requestBody?: RequestBodyObject | ReferenceObject;
  /** Optional from 3.1 on. */
  responses?: ResponsesObject;
  callbacks?: SpecMap<CallbackObject | ReferenceObject>;
  deprecated?: boolean;
  security?: SecurityRequirementObject[];
  servers?: ServerObject[];
};

/** @see https://spec.openapis.org/oas/v3.1.2#external-documentation-object */
export type ExternalDocumentationObject = {
  description?: string;
  url: string;
};

/**
 * A single operation parameter, identified by `name` and `in`. It is described
 * either by `schema` (with `style`/`explode`/`allowReserved`) or by `content`.
 * @see https://spec.openapis.org/oas/v3.1.2#parameter-object
 */
export type ParameterObject = {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie' | (string & {});
  description?: string;
  /** Must be `true` when `in` is `path`. */
  required?: boolean;
  deprecated?: boolean;
  /** Only for `in: query`. */
  allowEmptyValue?: boolean;
  style?:
    | 'matrix'
    | 'label'
    | 'form'
    | 'simple'
    | 'spaceDelimited'
    | 'pipeDelimited'
    | 'deepObject'
    | (string & {});
  explode?: boolean;
  /** Only for `in: query`. */
  allowReserved?: boolean;
  schema?: SchemaOrBoolean;
  /** A map with a single media type entry, used instead of `schema`. */
  content?: SpecMap<MediaTypeObject>;
  example?: FreeFormValue;
  examples?: SpecMap<ExampleObject | ReferenceObject>;
};

/** @see https://spec.openapis.org/oas/v3.1.2#request-body-object */
export type RequestBodyObject = {
  description?: string;
  /** Media type (or media type range) to its description. */
  content: SpecMap<MediaTypeObject>;
  required?: boolean;
};

/** @see https://spec.openapis.org/oas/v3.1.2#media-type-object */
export type MediaTypeObject = {
  schema?: SchemaOrBoolean;
  example?: FreeFormValue;
  examples?: SpecMap<ExampleObject | ReferenceObject>;
  /** Property name to its encoding (multipart and form bodies only). */
  encoding?: SpecMap<EncodingObject>;
};

/** @see https://spec.openapis.org/oas/v3.1.2#encoding-object */
export type EncodingObject = {
  contentType?: string;
  headers?: SpecMap<HeaderObject | ReferenceObject>;
  style?: 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject' | (string & {});
  explode?: boolean;
  allowReserved?: boolean;
};

/**
 * Status codes (`200`, `4XX`) and `default` to the response they describe.
 * @see https://spec.openapis.org/oas/v3.1.2#responses-object
 */
export type ResponsesObject = SpecMap<ResponseObject | ReferenceObject>;

/** @see https://spec.openapis.org/oas/v3.1.2#response-object */
export type ResponseObject = {
  description: string;
  headers?: SpecMap<HeaderObject | ReferenceObject>;
  content?: SpecMap<MediaTypeObject>;
  links?: SpecMap<LinkObject | ReferenceObject>;
};

/**
 * Runtime expressions to the path item describing the callback request.
 * @see https://spec.openapis.org/oas/v3.1.2#callback-object
 */
export type CallbackObject = SpecMap<PathItemObject>;

/**
 * `value` and `externalValue` are mutually exclusive.
 * @see https://spec.openapis.org/oas/v3.1.2#example-object
 */
export type ExampleObject = {
  summary?: string;
  description?: string;
  value?: FreeFormValue;
  externalValue?: string;
};

/** @see https://spec.openapis.org/oas/v3.1.2#link-object */
export type LinkObject = {
  operationRef?: string;
  operationId?: string;
  parameters?: SpecMap<FreeFormValue>;
  requestBody?: FreeFormValue;
  description?: string;
  server?: ServerObject;
};

/**
 * A response or multipart header; it follows the Parameter Object without
 * `name` and `in`.
 * @see https://spec.openapis.org/oas/v3.1.2#header-object
 */
export type HeaderObject = {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  style?: 'simple' | (string & {});
  explode?: boolean;
  schema?: SchemaOrBoolean;
  content?: SpecMap<MediaTypeObject>;
  example?: FreeFormValue;
  examples?: SpecMap<ExampleObject | ReferenceObject>;
};

/** @see https://spec.openapis.org/oas/v3.1.2#tag-object */
export type TagObject = {
  name: string;
  description?: string;
  externalDocs?: ExternalDocumentationObject;
};

/**
 * A reference to another component. `summary` and `description` override the
 * referenced component's; other fields next to `$ref` are ignored. In a
 * Schema Object, `$ref` is a JSON Schema keyword instead.
 * @see https://spec.openapis.org/oas/v3.1.2#reference-object
 */
export type ReferenceObject = {
  $ref: string;
  summary?: string;
  description?: string;
};

/**
 * Keywords the OAS base vocabulary adds to JSON Schema 2020-12.
 * @see https://spec.openapis.org/oas/3.1/meta/2024-11-10
 */
type SchemaVocabulary = {
  discriminator?: DiscriminatorObject;
  /** @deprecated Use the JSON Schema `examples` keyword. */
  example?: FreeFormValue;
  externalDocs?: ExternalDocumentationObject;
  xml?: XMLObject;
};

/**
 * The 3.1 Schema Object in object form: JSON Schema draft 2020-12 plus the OAS
 * base vocabulary. A subschema may also be `true` or `false`; see
 * `SchemaOrBoolean`.
 * @see https://spec.openapis.org/oas/v3.1.2#schema-object
 */
export type SchemaObject = JsonSchema2020<SchemaVocabulary>;

/** A Schema Object or its boolean form (`true` accepts anything, `false` nothing). */
export type SchemaOrBoolean = SchemaObject | boolean;

/** @see https://spec.openapis.org/oas/v3.1.2#discriminator-object */
export type DiscriminatorObject = {
  propertyName: string;
  /** Payload value to a schema name or reference. */
  mapping?: SpecMap<string>;
};

/** @see https://spec.openapis.org/oas/v3.1.2#xml-object */
export type XMLObject = {
  name?: string;
  namespace?: string;
  prefix?: string;
  attribute?: boolean;
  wrapped?: boolean;
};

/**
 * A security scheme. Which of the optional fields apply depends on `type`:
 * `name` and `in` for `apiKey`, `scheme` and `bearerFormat` for `http`,
 * `flows` for `oauth2`, `openIdConnectUrl` for `openIdConnect`.
 * @see https://spec.openapis.org/oas/v3.1.2#security-scheme-object
 */
export type SecuritySchemeObject = {
  type: 'apiKey' | 'http' | 'mutualTLS' | 'oauth2' | 'openIdConnect' | (string & {});
  description?: string;
  name?: string;
  in?: 'query' | 'header' | 'cookie' | (string & {});
  scheme?: string;
  bearerFormat?: string;
  flows?: OAuthFlowsObject;
  openIdConnectUrl?: string;
};

/**
 * The OAuth flows a scheme supports. Each flow requires the URLs it uses.
 * @see https://spec.openapis.org/oas/v3.1.2#oauth-flows-object
 */
export type OAuthFlowsObject = {
  implicit?: OAuthFlowObject & { authorizationUrl: string };
  password?: OAuthFlowObject & { tokenUrl: string };
  clientCredentials?: OAuthFlowObject & { tokenUrl: string };
  authorizationCode?: OAuthFlowObject & { authorizationUrl: string; tokenUrl: string };
};

/**
 * One OAuth flow. Which URLs are required depends on the flow, so they are
 * optional here and required in `OAuthFlowsObject`: `authorizationUrl` for
 * `implicit` and `authorizationCode`, `tokenUrl` for `password`,
 * `clientCredentials` and `authorizationCode`.
 * @see https://spec.openapis.org/oas/v3.1.2#oauth-flow-object
 */
export type OAuthFlowObject = {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  /** Scope name to a short description; may be empty. */
  scopes: SpecMap<string>;
};

/**
 * Security scheme names (from `components.securitySchemes`) to the scopes or
 * roles required; all listed schemes apply together.
 * @see https://spec.openapis.org/oas/v3.1.2#security-requirement-object
 */
export type SecurityRequirementObject = SpecMap<string[]>;
