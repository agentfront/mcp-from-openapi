/**
 * OpenAPI 3.2 object types, stated as changes to the 3.1 types.
 *
 * Written from the OpenAPI Specification 3.2.1 text
 * (https://spec.openapis.org/oas/v3.2.1), the OAI JSON Schema for 3.2
 * (https://spec.openapis.org/oas/3.2/schema/2026-11-12) and the OAS base
 * vocabulary for Schema Objects
 * (https://spec.openapis.org/oas/3.2/meta/2026-02-26).
 *
 * Every object is either the 3.1 object unchanged or `Override<OAS31 object,
 * changes>`. An object also changes when an object it holds changes (the
 * Operation Object holds Parameter Objects, for example), so those fields are
 * re-pointed at the 3.2 objects too. A later minor version builds on this
 * module the same way. Every deliberate deviation from the official schema's
 * value types is listed in `./index.ts`.
 *
 * @module
 */

import type { FreeFormValue, Override, SpecMap } from './common';
import type { JsonSchema2020 } from './json-schema-2020-12';
import type * as OAS31 from './v3_1';

// Unchanged since 3.1

export type InfoObject = OAS31.InfoObject;
export type ContactObject = OAS31.ContactObject;
export type LicenseObject = OAS31.LicenseObject;
export type ServerVariableObject = OAS31.ServerVariableObject;
export type ExternalDocumentationObject = OAS31.ExternalDocumentationObject;
export type ReferenceObject = OAS31.ReferenceObject;
export type SecurityRequirementObject = OAS31.SecurityRequirementObject;

// Changed in 3.2

/**
 * The root object of an OpenAPI 3.2 description. At least one of `paths`,
 * `components` and `webhooks` is present.
 * @see https://spec.openapis.org/oas/v3.2.1#openapi-object
 */
export type OpenAPIObject = Override<
  OAS31.OpenAPIObject,
  {
    /** The document's own URI (no fragment); also its base URI. New in 3.2. */
    $self?: string;
    servers?: ServerObject[];
    paths?: PathsObject;
    webhooks?: SpecMap<PathItemObject>;
    components?: ComponentsObject;
    tags?: TagObject[];
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#server-object */
export type ServerObject = Override<
  OAS31.ServerObject,
  {
    /** A unique name for the host the URL designates. New in 3.2. */
    name?: string;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#components-object */
export type ComponentsObject = Override<
  OAS31.ComponentsObject,
  {
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
    /** Reusable Media Type Objects. New in 3.2. */
    mediaTypes?: SpecMap<MediaTypeObject | ReferenceObject>;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#paths-object */
export type PathsObject = SpecMap<PathItemObject>;

/** @see https://spec.openapis.org/oas/v3.2.1#path-item-object */
export type PathItemObject = Override<
  OAS31.PathItemObject,
  {
    get?: OperationObject;
    put?: OperationObject;
    post?: OperationObject;
    delete?: OperationObject;
    options?: OperationObject;
    head?: OperationObject;
    patch?: OperationObject;
    trace?: OperationObject;
    /** The HTTP QUERY method. New in 3.2. */
    query?: OperationObject;
    /**
     * Operations for other HTTP methods, keyed by the method name as sent
     * (case-sensitive); never one of the fixed methods above. New in 3.2.
     */
    additionalOperations?: SpecMap<OperationObject>;
    servers?: ServerObject[];
    parameters?: (ParameterObject | ReferenceObject)[];
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#operation-object */
export type OperationObject = Override<
  OAS31.OperationObject,
  {
    parameters?: (ParameterObject | ReferenceObject)[];
    requestBody?: RequestBodyObject | ReferenceObject;
    responses?: ResponsesObject;
    callbacks?: SpecMap<CallbackObject | ReferenceObject>;
    servers?: ServerObject[];
  }
>;

/**
 * A single operation parameter. `in: querystring` (new in 3.2) describes the
 * whole query string and must use `content`.
 * @see https://spec.openapis.org/oas/v3.2.1#parameter-object
 */
export type ParameterObject = Override<
  OAS31.ParameterObject,
  {
    in: 'query' | 'querystring' | 'header' | 'path' | 'cookie' | (string & {});
    /** `cookie` (for `in: cookie`) is new in 3.2. */
    style?:
      | 'matrix'
      | 'label'
      | 'simple'
      | 'form'
      | 'spaceDelimited'
      | 'pipeDelimited'
      | 'deepObject'
      | 'cookie'
      | (string & {});
    schema?: SchemaOrBoolean;
    content?: SpecMap<MediaTypeObject | ReferenceObject>;
    examples?: SpecMap<ExampleObject | ReferenceObject>;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#request-body-object */
export type RequestBodyObject = Override<
  OAS31.RequestBodyObject,
  {
    content: SpecMap<MediaTypeObject | ReferenceObject>;
  }
>;

/**
 * `schema` describes the whole content; `itemSchema` (new in 3.2) each item
 * of a sequential media type such as `text/event-stream` or JSON Lines.
 * `encoding` is mutually exclusive with `prefixEncoding` and `itemEncoding`.
 * @see https://spec.openapis.org/oas/v3.2.1#media-type-object
 */
export type MediaTypeObject = Override<
  OAS31.MediaTypeObject,
  {
    schema?: SchemaOrBoolean;
    /** New in 3.2. */
    itemSchema?: SchemaOrBoolean;
    examples?: SpecMap<ExampleObject | ReferenceObject>;
    encoding?: SpecMap<EncodingObject>;
    /** Encodings for the leading parts of a positional multipart body, in order. New in 3.2. */
    prefixEncoding?: EncodingObject[];
    /** Encoding for every remaining part of a positional multipart body. New in 3.2. */
    itemEncoding?: EncodingObject;
  }
>;

/**
 * Nested `encoding`, `prefixEncoding` and `itemEncoding` (new in 3.2) apply to
 * a nested multipart part the same way they do in the Media Type Object.
 * @see https://spec.openapis.org/oas/v3.2.1#encoding-object
 */
export type EncodingObject = Override<
  OAS31.EncodingObject,
  {
    headers?: SpecMap<HeaderObject | ReferenceObject>;
    /** New in 3.2. */
    encoding?: SpecMap<EncodingObject>;
    /** New in 3.2. */
    prefixEncoding?: EncodingObject[];
    /** New in 3.2. */
    itemEncoding?: EncodingObject;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#responses-object */
export type ResponsesObject = SpecMap<ResponseObject | ReferenceObject>;

/**
 * `description` is optional from 3.2 on, and `summary` is new.
 * @see https://spec.openapis.org/oas/v3.2.1#response-object
 */
export type ResponseObject = Override<
  OAS31.ResponseObject,
  {
    /** New in 3.2. */
    summary?: string;
    /** Optional from 3.2 on. */
    description?: string;
    headers?: SpecMap<HeaderObject | ReferenceObject>;
    content?: SpecMap<MediaTypeObject | ReferenceObject>;
    links?: SpecMap<LinkObject | ReferenceObject>;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#callback-object */
export type CallbackObject = SpecMap<PathItemObject>;

/**
 * `dataValue` and `serializedValue` (new in 3.2) are preferred over `value`,
 * which is deprecated for non-JSON serialization targets.
 * @see https://spec.openapis.org/oas/v3.2.1#example-object
 */
export type ExampleObject = Override<
  OAS31.ExampleObject,
  {
    /** The example as data, valid against the schema. New in 3.2. */
    dataValue?: FreeFormValue;
    /** The example in its serialized form. New in 3.2. */
    serializedValue?: string;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#link-object */
export type LinkObject = Override<
  OAS31.LinkObject,
  {
    server?: ServerObject;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#header-object */
export type HeaderObject = Override<
  OAS31.HeaderObject,
  {
    schema?: SchemaOrBoolean;
    content?: SpecMap<MediaTypeObject | ReferenceObject>;
    examples?: SpecMap<ExampleObject | ReferenceObject>;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#tag-object */
export type TagObject = Override<
  OAS31.TagObject,
  {
    /** A short summary of the tag. New in 3.2. */
    summary?: string;
    /** The `name` of the tag this tag is nested under. New in 3.2. */
    parent?: string;
    /** A machine-readable category such as `nav`, `badge` or `audience`. New in 3.2. */
    kind?: string;
  }
>;

/**
 * Keywords the OAS base vocabulary adds to JSON Schema 2020-12.
 * @see https://spec.openapis.org/oas/3.2/meta/2026-02-26
 */
type SchemaVocabulary = {
  discriminator?: DiscriminatorObject;
  /** @deprecated Use the JSON Schema `examples` keyword. */
  example?: FreeFormValue;
  externalDocs?: ExternalDocumentationObject;
  xml?: XMLObject;
};

/**
 * The 3.2 Schema Object in object form: JSON Schema draft 2020-12 plus the OAS
 * base vocabulary. A subschema may also be `true` or `false`; see
 * `SchemaOrBoolean`.
 * @see https://spec.openapis.org/oas/v3.2.1#schema-object
 */
export type SchemaObject = JsonSchema2020<SchemaVocabulary>;

/** A Schema Object or its boolean form (`true` accepts anything, `false` nothing). */
export type SchemaOrBoolean = SchemaObject | boolean;

/**
 * `propertyName` stays required; when the payload may omit that property,
 * `defaultMapping` (new in 3.2) names the schema to use.
 * @see https://spec.openapis.org/oas/v3.2.1#discriminator-object
 */
export type DiscriminatorObject = Override<
  OAS31.DiscriminatorObject,
  {
    /** New in 3.2. */
    defaultMapping?: string;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#xml-object */
export type XMLObject = Override<
  OAS31.XMLObject,
  {
    /** New in 3.2; when present, `attribute` and `wrapped` must be absent. */
    nodeType?: 'element' | 'attribute' | 'text' | 'cdata' | 'none' | (string & {});
    /** @deprecated Use `nodeType: attribute`. */
    attribute?: boolean;
    /** @deprecated Use `nodeType: element` on the array schema. */
    wrapped?: boolean;
  }
>;

/** @see https://spec.openapis.org/oas/v3.2.1#security-scheme-object */
export type SecuritySchemeObject = Override<
  OAS31.SecuritySchemeObject,
  {
    flows?: OAuthFlowsObject;
    /** RFC 8414 authorization server metadata URL, for `oauth2`. New in 3.2. */
    oauth2MetadataUrl?: string;
    /** New in 3.2. */
    deprecated?: boolean;
  }
>;

/**
 * The OAuth flows a scheme supports. Each flow requires the URLs it uses.
 * @see https://spec.openapis.org/oas/v3.2.1#oauth-flows-object
 */
export type OAuthFlowsObject = Override<
  OAS31.OAuthFlowsObject,
  {
    implicit?: OAuthFlowObject & { authorizationUrl: string };
    password?: OAuthFlowObject & { tokenUrl: string };
    clientCredentials?: OAuthFlowObject & { tokenUrl: string };
    authorizationCode?: OAuthFlowObject & { authorizationUrl: string; tokenUrl: string };
    /** The OAuth 2.0 Device Authorization flow (RFC 8628). New in 3.2. */
    deviceAuthorization?: OAuthFlowObject & { deviceAuthorizationUrl: string; tokenUrl: string };
  }
>;

/**
 * One OAuth flow; `deviceAuthorizationUrl` (new in 3.2) is used by the
 * `deviceAuthorization` flow, which `OAuthFlowsObject` requires to have it and
 * a `tokenUrl`.
 * @see https://spec.openapis.org/oas/v3.2.1#oauth-flow-object
 */
export type OAuthFlowObject = Override<
  OAS31.OAuthFlowObject,
  {
    /** New in 3.2. */
    deviceAuthorizationUrl?: string;
  }
>;
