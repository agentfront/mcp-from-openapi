/**
 * Swagger 2.0 (OpenAPI Specification 2.0) object types.
 *
 * Written from the Swagger 2.0 specification text
 * (https://spec.openapis.org/oas/v2.0) and the official JSON Schema for 2.0
 * (https://spec.openapis.org/oas/2.0/schema/2017-08-27). Object and field
 * names are the specification's own; the root is the Swagger Object.
 *
 * These are reader types, under the same rules as the 3.x modules (see
 * `./index.ts`): enumerations are open strings, maps are `SpecMap`, free-form
 * values are `FreeFormValue`, nothing declares an index signature, and `x-`
 * extensions are read through `WithExtensions`. No field is required here
 * that the official schema leaves optional.
 *
 * Where the schema splits one object of the text into variants, the type is
 * the one object of the text, holding the fields of every variant; a field is
 * required only when every variant requires it:
 *
 * - `ParameterObject`: `#/definitions/bodyParameter` and
 *   `#/definitions/nonBodyParameter` (itself one of
 *   `headerParameterSubSchema`, `formDataParameterSubSchema`,
 *   `queryParameterSubSchema`, `pathParameterSubSchema`). Only `name` and `in`
 *   are required; `schema` (body) and `type` (every other location) are
 *   optional.
 * - `SecuritySchemeObject`: `#/definitions/basicAuthenticationSecurity`,
 *   `apiKeySecurity` and the four `oauth2*Security` definitions. Only `type`
 *   is required. `scopes` is optional, as in the schema, although the text
 *   calls it required.
 * - `SchemaObject`: `#/definitions/schema` and `#/definitions/fileSchema`
 *   (a response schema whose `type` is `file`).
 *
 * The 2.0 Schema Object has `$ref` as a field of its own
 * (`#/definitions/schema/properties/$ref`), so a subschema is a
 * `SchemaObject`, which a Reference Object also satisfies.
 *
 * The Items Object (`#/definitions/primitivesItems`) requires no field in the
 * schema, so its `type` is optional although the text calls it required.
 *
 * Swagger 2.0 types are not part of the cross-version unions
 * (`OpenAPIDocument`, ...): a 2.0 document is converted to OpenAPI 3.0 before
 * the library reads it (`upgradeSwagger2`).
 *
 * @module
 */

import type { FreeFormValue, SpecMap } from './common';

/** A transfer protocol (`#/definitions/schemesList/items/enum`). */
type Scheme = 'http' | 'https' | 'ws' | 'wss' | (string & {});

/**
 * How an array value is serialized (`#/definitions/collectionFormatWithMulti`);
 * `multi` only for `query` and `formData` parameters. Default `csv`.
 */
type CollectionFormat = 'csv' | 'ssv' | 'tsv' | 'pipes' | 'multi' | (string & {});

/**
 * The root object of a Swagger 2.0 description.
 * @see https://spec.openapis.org/oas/v2.0#swagger-object
 */
export type SwaggerObject = {
  /** The specification version; the schema allows exactly `"2.0"`. */
  swagger: string;
  info: InfoObject;
  /** Host (name or IP, optionally a port) serving the API; without it, the host serving the document. */
  host?: string;
  /** Path the API is served under, relative to `host`; starts with `/`. */
  basePath?: string;
  /** Without it, the scheme the document itself was retrieved with. */
  schemes?: Scheme[];
  /** Media types the operations consume, unless an operation overrides them. */
  consumes?: string[];
  /** Media types the operations produce, unless an operation overrides them. */
  produces?: string[];
  paths: PathsObject;
  definitions?: DefinitionsObject;
  parameters?: ParametersDefinitionsObject;
  responses?: ResponsesDefinitionsObject;
  security?: SecurityRequirementObject[];
  securityDefinitions?: SecurityDefinitionsObject;
  tags?: TagObject[];
  externalDocs?: ExternalDocumentationObject;
};

/**
 * Metadata about the API.
 * @see https://spec.openapis.org/oas/v2.0#info-object
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

/** @see https://spec.openapis.org/oas/v2.0#contact-object */
export type ContactObject = {
  name?: string;
  url?: string;
  email?: string;
};

/** @see https://spec.openapis.org/oas/v2.0#license-object */
export type LicenseObject = {
  name: string;
  url?: string;
};

/**
 * Relative paths (starting with `/`, appended to `basePath`) to the operations
 * they hold. A lookup may find nothing, or an `x-` extension, so a value is
 * checked before use.
 * @see https://spec.openapis.org/oas/v2.0#paths-object
 */
export type PathsObject = SpecMap<PathItemObject>;

/**
 * The operations available on a single path. Unlike OpenAPI 3, there is no
 * `trace` operation and no `summary`, `description` or `servers`.
 * @see https://spec.openapis.org/oas/v2.0#path-item-object
 */
export type PathItemObject = {
  $ref?: string;
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  delete?: OperationObject;
  options?: OperationObject;
  head?: OperationObject;
  patch?: OperationObject;
  /** Parameters shared by every operation on this path; at most one `in: body`. */
  parameters?: (ParameterObject | ReferenceObject)[];
};

/**
 * A single API operation on a path.
 * @see https://spec.openapis.org/oas/v2.0#operation-object
 */
export type OperationObject = {
  tags?: string[];
  summary?: string;
  description?: string;
  externalDocs?: ExternalDocumentationObject;
  operationId?: string;
  /** Overrides the root `produces`; an empty list clears it. */
  produces?: string[];
  /** Overrides the root `consumes`; an empty list clears it. */
  consumes?: string[];
  /** At most one `in: body`, never together with `in: formData`. */
  parameters?: (ParameterObject | ReferenceObject)[];
  responses: ResponsesObject;
  /** Overrides the root `schemes`. */
  schemes?: Scheme[];
  deprecated?: boolean;
  /** Overrides the root `security`; an empty list removes it. */
  security?: SecurityRequirementObject[];
};

/** @see https://spec.openapis.org/oas/v2.0#external-documentation-object */
export type ExternalDocumentationObject = {
  description?: string;
  url: string;
};

/**
 * A single operation parameter, identified by `name` and `in`.
 *
 * An `in: body` parameter is described by `schema` (required for it) and is
 * the whole request body. Every other location is described by `type`
 * (required for it), `format`, `items` and the validation fields; `type:
 * file` only for `in: formData`.
 * @see https://spec.openapis.org/oas/v2.0#parameter-object
 */
export type ParameterObject = {
  name: string;
  in: 'query' | 'header' | 'path' | 'formData' | 'body' | (string & {});
  description?: string;
  /** Must be `true` when `in` is `path`. */
  required?: boolean;
  /** `in: body` only. */
  schema?: SchemaObject;
  /** Every location but `body`. */
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'file' | (string & {});
  format?: string;
  /** `in: query` and `in: formData` only. */
  allowEmptyValue?: boolean;
  /** Required when `type` is `array`. */
  items?: ItemsObject;
  collectionFormat?: CollectionFormat;
  default?: FreeFormValue;
  maximum?: number;
  exclusiveMaximum?: boolean;
  minimum?: number;
  exclusiveMinimum?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  enum?: FreeFormValue[];
  multipleOf?: number;
};

/**
 * The items of an array that is not in a body: a limited subset of JSON
 * Schema.
 * @see https://spec.openapis.org/oas/v2.0#items-object
 */
export type ItemsObject = {
  /** No `file`, no object. Required by the text, optional in the schema. */
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | (string & {});
  format?: string;
  /** Required when `type` is `array`. */
  items?: ItemsObject;
  /** No `multi`. */
  collectionFormat?: CollectionFormat;
  default?: FreeFormValue;
  maximum?: number;
  exclusiveMaximum?: boolean;
  minimum?: number;
  exclusiveMinimum?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  enum?: FreeFormValue[];
  multipleOf?: number;
};

/**
 * Status codes (`200`) and `default` to the response they describe.
 * @see https://spec.openapis.org/oas/v2.0#responses-object
 */
export type ResponsesObject = SpecMap<ResponseObject | ReferenceObject>;

/** @see https://spec.openapis.org/oas/v2.0#response-object */
export type ResponseObject = {
  description: string;
  /** The response body; no body without it. Its root `type` may also be `file`. */
  schema?: SchemaObject;
  headers?: HeadersObject;
  /** Media type to an example body. */
  examples?: ExampleObject;
};

/**
 * Header names to the headers a response sends.
 * @see https://spec.openapis.org/oas/v2.0#headers-object
 */
export type HeadersObject = SpecMap<HeaderObject>;

/**
 * Media types (from the operation's `produces`) to an example response body.
 * @see https://spec.openapis.org/oas/v2.0#example-object
 */
export type ExampleObject = SpecMap<FreeFormValue>;

/** @see https://spec.openapis.org/oas/v2.0#header-object */
export type HeaderObject = {
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | (string & {});
  format?: string;
  /** Required when `type` is `array`. */
  items?: ItemsObject;
  /** No `multi`. */
  collectionFormat?: CollectionFormat;
  default?: FreeFormValue;
  maximum?: number;
  exclusiveMaximum?: boolean;
  minimum?: number;
  exclusiveMinimum?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  enum?: FreeFormValue[];
  multipleOf?: number;
};

/** @see https://spec.openapis.org/oas/v2.0#tag-object */
export type TagObject = {
  name: string;
  description?: string;
  externalDocs?: ExternalDocumentationObject;
};

/**
 * A JSON Reference to a definition, in this document or another
 * (`#/definitions/jsonReference`).
 * @see https://spec.openapis.org/oas/v2.0#reference-object
 */
export type ReferenceObject = {
  $ref: string;
};

/** A JSON Schema draft 04 primitive type, plus `file` for a response schema. */
type SchemaType = 'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string' | 'file' | (string & {});

/**
 * The 2.0 Schema Object: a subset of JSON Schema draft 04 with a few fields
 * of its own (`discriminator`, `readOnly`, `xml`, `externalDocs`, `example`).
 * No `oneOf`, `anyOf`, `not` or `nullable`.
 * @see https://spec.openapis.org/oas/v2.0#schema-object
 */
export type SchemaObject = {
  $ref?: string;
  format?: string;
  title?: string;
  description?: string;
  default?: FreeFormValue;
  multipleOf?: number;
  maximum?: number;
  /** Boolean in 2.0: whether `maximum` is exclusive. */
  exclusiveMaximum?: boolean;
  minimum?: number;
  /** Boolean in 2.0: whether `minimum` is exclusive. */
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
  additionalProperties?: SchemaObject | boolean;
  /** One type or, as draft 04 allows, a list of them. */
  type?: SchemaType | SchemaType[];
  /** One schema for every item or, as draft 04 allows, one per position. */
  items?: SchemaObject | SchemaObject[];
  allOf?: SchemaObject[];
  properties?: SpecMap<SchemaObject>;
  /**
   * A string in 2.0: the name of the property whose value names the schema
   * (under `definitions`) an instance is validated against.
   */
  discriminator?: string;
  readOnly?: boolean;
  xml?: XMLObject;
  externalDocs?: ExternalDocumentationObject;
  example?: FreeFormValue;
};

/** @see https://spec.openapis.org/oas/v2.0#xml-object */
export type XMLObject = {
  name?: string;
  namespace?: string;
  prefix?: string;
  attribute?: boolean;
  wrapped?: boolean;
};

/**
 * Names to the schemas operations consume and produce.
 * @see https://spec.openapis.org/oas/v2.0#definitions-object
 */
export type DefinitionsObject = SpecMap<SchemaObject>;

/**
 * Names to parameters operations refer to. Not global parameters.
 * @see https://spec.openapis.org/oas/v2.0#parameters-definitions-object
 */
export type ParametersDefinitionsObject = SpecMap<ParameterObject>;

/**
 * Names to responses operations refer to. Not global responses.
 * @see https://spec.openapis.org/oas/v2.0#responses-definitions-object
 */
export type ResponsesDefinitionsObject = SpecMap<ResponseObject>;

/**
 * Names to the security schemes requirements refer to.
 * @see https://spec.openapis.org/oas/v2.0#security-definitions-object
 */
export type SecurityDefinitionsObject = SpecMap<SecuritySchemeObject>;

/**
 * A security scheme. Which of the optional fields apply depends on `type`:
 * `name` and `in` for `apiKey`; `flow`, `scopes` and, per flow,
 * `authorizationUrl` (`implicit`, `accessCode`) and `tokenUrl` (`password`,
 * `application`, `accessCode`) for `oauth2`.
 * @see https://spec.openapis.org/oas/v2.0#security-scheme-object
 */
export type SecuritySchemeObject = {
  type: 'basic' | 'apiKey' | 'oauth2' | (string & {});
  description?: string;
  name?: string;
  in?: 'query' | 'header' | (string & {});
  flow?: 'implicit' | 'password' | 'application' | 'accessCode' | (string & {});
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes?: ScopesObject;
};

/**
 * OAuth2 scope names to a short description.
 * @see https://spec.openapis.org/oas/v2.0#scopes-object
 */
export type ScopesObject = SpecMap<string>;

/**
 * Security scheme names (from `securityDefinitions`) to the scopes required;
 * all listed schemes apply together.
 * @see https://spec.openapis.org/oas/v2.0#security-requirement-object
 */
export type SecurityRequirementObject = SpecMap<string[]>;
