/**
 * OpenAPI object types, one namespace per specification version, plus the
 * cross-version unions the library works with.
 *
 * - `OAS30`, `OAS31`, `OAS32`: each version's objects under the
 *   specification's own names (`OAS32.ParameterObject`, ...).
 * - The unions accept an object of any supported version. Reading a field
 *   that only some versions define needs narrowing, which is deliberate: the
 *   union states what a document of any version may hold.
 *
 * Field names follow the official OAI JSON Schemas exactly. Value types
 * deviate from them on purpose, because these are reader types (the
 * validator, not the compiler, rejects an invalid document):
 *
 * - Enumerated strings (`in`, `style`, a schema's or security scheme's
 *   `type`, ...) are open: the listed values plus any other string.
 * - Every map is a `SpecMap<T>`, whose values may be `undefined`, so a
 *   document imported as a JSON module type-checks.
 * - Free-form values are `FreeFormValue` (`any`), not `unknown`: Parameter,
 *   Media Type and Header `example`, Example `value` and `dataValue`, Link
 *   `parameters` values and `requestBody`, and Schema `default`, `enum`
 *   members, `const`, `example` and `examples` members. Link `parameters`
 *   values are free-form although the 3.1 and 3.2 schemas say strings, as the
 *   specification text allows any value or runtime expression.
 * - In 3.1 and 3.2, `exclusiveMinimum` and `exclusiveMaximum` also accept the
 *   boolean form of draft 04 (OpenAPI 3.0), which migrated documents carry.
 * - `$recursiveAnchor` is a `string`, as the draft 2020-12 meta-schema
 *   declares it, although draft 2019-09 wrote it as `true`.
 * - The Security Scheme Object is one object, not a union per `type`: only
 *   `type` is required, and the fields each type requires are optional.
 * - The OAuth Flow Object is one object for every flow, with its URLs
 *   optional; the OAuth Flows Object requires the URLs each flow uses.
 * - Rules spanning several fields are left to the validator: `schema` versus
 *   `content`, `example` versus `examples`, `operationRef` versus
 *   `operationId`, `required: true` on path parameters, a non-empty server
 *   variable `enum`, and (from 3.1 on) one of `paths`, `components` and
 *   `webhooks` being present.
 *
 * @module
 */

import type * as OAS30 from './v3_0';
import type * as OAS31 from './v3_1';
import type * as OAS32 from './v3_2';

export type * as OAS30 from './v3_0';
export type * as OAS31 from './v3_1';
export type * as OAS32 from './v3_2';
export type { ExtensionName, WithExtensions } from './extensions';

/** An OpenAPI 3.0, 3.1 or 3.2 document. */
export type OpenAPIDocument = OAS30.OpenAPIObject | OAS31.OpenAPIObject | OAS32.OpenAPIObject;

export type OperationObject = OAS30.OperationObject | OAS31.OperationObject | OAS32.OperationObject;
export type ParameterObject = OAS30.ParameterObject | OAS31.ParameterObject | OAS32.ParameterObject;
export type RequestBodyObject = OAS30.RequestBodyObject | OAS31.RequestBodyObject | OAS32.RequestBodyObject;
export type ResponseObject = OAS30.ResponseObject | OAS31.ResponseObject | OAS32.ResponseObject;
export type ResponsesObject = OAS30.ResponsesObject | OAS31.ResponsesObject | OAS32.ResponsesObject;
export type MediaTypeObject = OAS30.MediaTypeObject | OAS31.MediaTypeObject | OAS32.MediaTypeObject;
export type HeaderObject = OAS30.HeaderObject | OAS31.HeaderObject | OAS32.HeaderObject;
export type ExampleObject = OAS30.ExampleObject | OAS31.ExampleObject | OAS32.ExampleObject;
export type PathItemObject = OAS30.PathItemObject | OAS31.PathItemObject | OAS32.PathItemObject;
export type PathsObject = OAS30.PathsObject | OAS31.PathsObject | OAS32.PathsObject;
export type ServerObject = OAS30.ServerObject | OAS31.ServerObject | OAS32.ServerObject;
export type SecuritySchemeObject = OAS30.SecuritySchemeObject | OAS31.SecuritySchemeObject | OAS32.SecuritySchemeObject;
export type ReferenceObject = OAS30.ReferenceObject | OAS31.ReferenceObject | OAS32.ReferenceObject;
export type TagObject = OAS30.TagObject | OAS31.TagObject | OAS32.TagObject;
export type ExternalDocumentationObject =
  | OAS30.ExternalDocumentationObject
  | OAS31.ExternalDocumentationObject
  | OAS32.ExternalDocumentationObject;
export type ServerVariableObject = OAS30.ServerVariableObject | OAS31.ServerVariableObject | OAS32.ServerVariableObject;
export type EncodingObject = OAS30.EncodingObject | OAS31.EncodingObject | OAS32.EncodingObject;
export type SecurityRequirementObject =
  | OAS30.SecurityRequirementObject
  | OAS31.SecurityRequirementObject
  | OAS32.SecurityRequirementObject;

/** A Schema Object of any version, in object form. */
export type SchemaObject = OAS30.SchemaObject | OAS31.SchemaObject | OAS32.SchemaObject;

/**
 * A Schema Object or, from 3.1 on, its boolean form: `true` accepts anything,
 * `false` nothing.
 */
export type SchemaOrBoolean = SchemaObject | boolean;
