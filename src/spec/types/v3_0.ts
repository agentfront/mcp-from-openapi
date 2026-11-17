/**
 * OpenAPI 3.0 object types.
 *
 * Written from the OpenAPI Specification 3.0.4 text
 * (https://spec.openapis.org/oas/v3.0.4) and the OAI JSON Schema for 3.0
 * (https://spec.openapis.org/oas/3.0/schema/2024-10-18). Object and field
 * names are the specification's own.
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

/**
 * The root object of an OpenAPI 3.0 description.
 * @see https://spec.openapis.org/oas/v3.0.4#openapi-object
 */
export type OpenAPIObject = {
  /** The version of the OpenAPI Specification the document uses, e.g. `3.0.4`. */
  openapi: string;
  info: InfoObject;
  servers?: ServerObject[];
  paths: PathsObject;
  components?: ComponentsObject;
  security?: SecurityRequirementObject[];
  tags?: TagObject[];
  externalDocs?: ExternalDocumentationObject;
};

/**
 * Metadata about the API.
 * @see https://spec.openapis.org/oas/v3.0.4#info-object
 */
export type InfoObject = {
  title: string;
  description?: string;
  termsOfService?: string;
  contact?: ContactObject;
  license?: LicenseObject;
  /** The version of the API description (not of the specification). */
  version: string;
};

/** @see https://spec.openapis.org/oas/v3.0.4#contact-object */
export type ContactObject = {
  name?: string;
  url?: string;
  email?: string;
};

/** @see https://spec.openapis.org/oas/v3.0.4#license-object */
export type LicenseObject = {
  name: string;
  url?: string;
};

/**
 * A server the API is reachable at; `url` may contain `{variable}` templates.
 * @see https://spec.openapis.org/oas/v3.0.4#server-object
 */
export type ServerObject = {
  url: string;
  description?: string;
  variables?: SpecMap<ServerVariableObject>;
};

/** @see https://spec.openapis.org/oas/v3.0.4#server-variable-object */
export type ServerVariableObject = {
  enum?: string[];
  default: string;
  description?: string;
};

/**
 * Reusable objects, referenced from elsewhere in the document.
 * @see https://spec.openapis.org/oas/v3.0.4#components-object
 */
export type ComponentsObject = {
  schemas?: SpecMap<SchemaObject | ReferenceObject>;
  responses?: SpecMap<ResponseObject | ReferenceObject>;
  parameters?: SpecMap<ParameterObject | ReferenceObject>;
  examples?: SpecMap<ExampleObject | ReferenceObject>;
  requestBodies?: SpecMap<RequestBodyObject | ReferenceObject>;
  headers?: SpecMap<HeaderObject | ReferenceObject>;
  securitySchemes?: SpecMap<SecuritySchemeObject | ReferenceObject>;
  links?: SpecMap<LinkObject | ReferenceObject>;
  callbacks?: SpecMap<CallbackObject | ReferenceObject>;
};

/**
 * Relative paths (starting with `/`) to the operations they hold. A lookup
 * may find nothing, or an `x-` extension, so a value is checked before use.
 * @see https://spec.openapis.org/oas/v3.0.4#paths-object
 */
export type PathsObject = SpecMap<PathItemObject>;

/**
 * The operations available on a single path.
 * @see https://spec.openapis.org/oas/v3.0.4#path-item-object
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
 * @see https://spec.openapis.org/oas/v3.0.4#operation-object
 */
export type OperationObject = {
  tags?: string[];
  summary?: string;
  description?: string;
  externalDocs?: ExternalDocumentationObject;
  operationId?: string;
  parameters?: (ParameterObject | ReferenceObject)[];
  requestBody?: RequestBodyObject | ReferenceObject;
  /** Required in 3.0. */
  responses: ResponsesObject;
  callbacks?: SpecMap<CallbackObject | ReferenceObject>;
  deprecated?: boolean;
  security?: SecurityRequirementObject[];
  servers?: ServerObject[];
};

/** @see https://spec.openapis.org/oas/v3.0.4#external-documentation-object */
export type ExternalDocumentationObject = {
  description?: string;
  url: string;
};

/**
 * A single operation parameter, identified by `name` and `in`. It is described
 * either by `schema` (with `style`/`explode`/`allowReserved`) or by `content`.
 * @see https://spec.openapis.org/oas/v3.0.4#parameter-object
 */
export type ParameterObject = {
  name: string;
  in: 'query' | 'header' | 'path' | 'cookie' | (string & {});
  description?: string;
  /** Must be `true` when `in` is `path`. */
  required?: boolean;
  deprecated?: boolean;
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
  allowReserved?: boolean;
  schema?: SchemaObject | ReferenceObject;
  /** A map with a single media type entry, used instead of `schema`. */
  content?: SpecMap<MediaTypeObject>;
  example?: FreeFormValue;
  examples?: SpecMap<ExampleObject | ReferenceObject>;
};

/** @see https://spec.openapis.org/oas/v3.0.4#request-body-object */
export type RequestBodyObject = {
  description?: string;
  /** Media type (or media type range) to its description. */
  content: SpecMap<MediaTypeObject>;
  required?: boolean;
};

/** @see https://spec.openapis.org/oas/v3.0.4#media-type-object */
export type MediaTypeObject = {
  schema?: SchemaObject | ReferenceObject;
  example?: FreeFormValue;
  examples?: SpecMap<ExampleObject | ReferenceObject>;
  /** Property name to its encoding (multipart and form bodies only). */
  encoding?: SpecMap<EncodingObject>;
};

/** @see https://spec.openapis.org/oas/v3.0.4#encoding-object */
export type EncodingObject = {
  contentType?: string;
  headers?: SpecMap<HeaderObject | ReferenceObject>;
  style?: 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject' | (string & {});
  explode?: boolean;
  allowReserved?: boolean;
};

/**
 * Status codes (`200`, `4XX`) and `default` to the response they describe.
 * @see https://spec.openapis.org/oas/v3.0.4#responses-object
 */
export type ResponsesObject = SpecMap<ResponseObject | ReferenceObject>;

/** @see https://spec.openapis.org/oas/v3.0.4#response-object */
export type ResponseObject = {
  description: string;
  headers?: SpecMap<HeaderObject | ReferenceObject>;
  content?: SpecMap<MediaTypeObject>;
  links?: SpecMap<LinkObject | ReferenceObject>;
};

/**
 * Runtime expressions to the path item describing the callback request.
 * @see https://spec.openapis.org/oas/v3.0.4#callback-object
 */
export type CallbackObject = SpecMap<PathItemObject>;

/** @see https://spec.openapis.org/oas/v3.0.4#example-object */
export type ExampleObject = {
  summary?: string;
  description?: string;
  value?: FreeFormValue;
  externalValue?: string;
};

/** @see https://spec.openapis.org/oas/v3.0.4#link-object */
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
 * @see https://spec.openapis.org/oas/v3.0.4#header-object
 */
export type HeaderObject = {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  style?: 'simple' | (string & {});
  explode?: boolean;
  allowReserved?: boolean;
  schema?: SchemaObject | ReferenceObject;
  content?: SpecMap<MediaTypeObject>;
  example?: FreeFormValue;
  examples?: SpecMap<ExampleObject | ReferenceObject>;
};

/** @see https://spec.openapis.org/oas/v3.0.4#tag-object */
export type TagObject = {
  name: string;
  description?: string;
  externalDocs?: ExternalDocumentationObject;
};

/**
 * A reference to another component. In 3.0 any other field next to `$ref` is
 * ignored.
 * @see https://spec.openapis.org/oas/v3.0.4#reference-object
 */
export type ReferenceObject = {
  $ref: string;
};

/**
 * The 3.0 Schema Object: an extended subset of JSON Schema Specification
 * Draft Wright-00. A subschema may be a Reference Object instead.
 * @see https://spec.openapis.org/oas/v3.0.4#schema-object
 */
export type SchemaObject = {
  title?: string;
  multipleOf?: number;
  maximum?: number;
  /** Boolean in 3.0: whether `maximum` is exclusive. */
  exclusiveMaximum?: boolean;
  minimum?: number;
  /** Boolean in 3.0: whether `minimum` is exclusive. */
  exclusiveMinimum?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  maxProperties?: number;
  minProperties?: number;
  required?: string[];
  enum?: FreeFormValue[];
  /** A single type in 3.0; use `nullable` to also allow `null`. */
  type?: 'array' | 'boolean' | 'integer' | 'number' | 'object' | 'string' | (string & {});
  not?: SchemaObject | ReferenceObject;
  allOf?: (SchemaObject | ReferenceObject)[];
  oneOf?: (SchemaObject | ReferenceObject)[];
  anyOf?: (SchemaObject | ReferenceObject)[];
  items?: SchemaObject | ReferenceObject;
  properties?: SpecMap<SchemaObject | ReferenceObject>;
  additionalProperties?: SchemaObject | ReferenceObject | boolean;
  description?: string;
  format?: string;
  default?: FreeFormValue;
  nullable?: boolean;
  discriminator?: DiscriminatorObject;
  readOnly?: boolean;
  writeOnly?: boolean;
  example?: FreeFormValue;
  externalDocs?: ExternalDocumentationObject;
  deprecated?: boolean;
  xml?: XMLObject;
};

/** @see https://spec.openapis.org/oas/v3.0.4#discriminator-object */
export type DiscriminatorObject = {
  propertyName: string;
  /** Payload value to a schema name or reference. */
  mapping?: SpecMap<string>;
};

/** @see https://spec.openapis.org/oas/v3.0.4#xml-object */
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
 * @see https://spec.openapis.org/oas/v3.0.4#security-scheme-object
 */
export type SecuritySchemeObject = {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | (string & {});
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
 * @see https://spec.openapis.org/oas/v3.0.4#oauth-flows-object
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
 * @see https://spec.openapis.org/oas/v3.0.4#oauth-flow-object
 */
export type OAuthFlowObject = {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  /** Scope name to a short description; may be empty. */
  scopes: SpecMap<string>;
};

/**
 * Security scheme names (from `components.securitySchemes`) to the scopes
 * required; all listed schemes apply together.
 * @see https://spec.openapis.org/oas/v3.0.4#security-requirement-object
 */
export type SecurityRequirementObject = SpecMap<string[]>;
