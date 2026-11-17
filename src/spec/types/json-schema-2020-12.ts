/**
 * The keywords of JSON Schema draft 2020-12, the base of the OpenAPI 3.1 and
 * 3.2 Schema Object dialects.
 *
 * Written from the draft 2020-12 meta-schema
 * (https://json-schema.org/draft/2020-12/schema) and its vocabulary
 * meta-schemas: core, applicator, unevaluated, validation, meta-data,
 * format-annotation and content. The meta-schema also still declares four
 * keywords of earlier drafts (`definitions`, `dependencies`,
 * `$recursiveAnchor`, `$recursiveRef`), so they are included, marked
 * deprecated.
 *
 * Each OpenAPI version adds its own vocabulary (`discriminator`, `xml`, ...)
 * through the `Vocabulary` parameter, which applies to every subschema.
 *
 * @module
 */

import type { FreeFormValue, SpecMap } from './common';

/** A JSON Schema primitive type name. */
export type JsonSchemaTypeName =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string'
  | (string & {});

/**
 * A draft 2020-12 schema in object form, extended with a dialect's
 * `Vocabulary`. Wherever a subschema is allowed, the boolean forms `true`
 * (anything is valid) and `false` (nothing is valid) are allowed too.
 */
export type JsonSchema2020<Vocabulary extends object> = {
  // Core vocabulary
  $id?: string;
  $schema?: string;
  $ref?: string;
  $anchor?: string;
  $dynamicRef?: string;
  $dynamicAnchor?: string;
  $vocabulary?: SpecMap<boolean>;
  $comment?: string;
  $defs?: SpecMap<JsonSchema2020<Vocabulary> | boolean>;

  // Applicator vocabulary
  prefixItems?: (JsonSchema2020<Vocabulary> | boolean)[];
  items?: JsonSchema2020<Vocabulary> | boolean;
  contains?: JsonSchema2020<Vocabulary> | boolean;
  additionalProperties?: JsonSchema2020<Vocabulary> | boolean;
  properties?: SpecMap<JsonSchema2020<Vocabulary> | boolean>;
  patternProperties?: SpecMap<JsonSchema2020<Vocabulary> | boolean>;
  dependentSchemas?: SpecMap<JsonSchema2020<Vocabulary> | boolean>;
  propertyNames?: JsonSchema2020<Vocabulary> | boolean;
  if?: JsonSchema2020<Vocabulary> | boolean;
  then?: JsonSchema2020<Vocabulary> | boolean;
  else?: JsonSchema2020<Vocabulary> | boolean;
  allOf?: (JsonSchema2020<Vocabulary> | boolean)[];
  anyOf?: (JsonSchema2020<Vocabulary> | boolean)[];
  oneOf?: (JsonSchema2020<Vocabulary> | boolean)[];
  not?: JsonSchema2020<Vocabulary> | boolean;

  // Unevaluated vocabulary
  unevaluatedItems?: JsonSchema2020<Vocabulary> | boolean;
  unevaluatedProperties?: JsonSchema2020<Vocabulary> | boolean;

  // Validation vocabulary
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  const?: FreeFormValue;
  enum?: FreeFormValue[];
  multipleOf?: number;
  maximum?: number;
  /**
   * Numeric from draft 06 on: the exclusive upper bound itself. The boolean
   * form (whether `maximum` is exclusive) is draft 04's, as in OpenAPI 3.0;
   * it is accepted because documents migrated from 3.0 still carry it.
   */
  exclusiveMaximum?: number | boolean;
  minimum?: number;
  /**
   * Numeric from draft 06 on: the exclusive lower bound itself. The boolean
   * form (whether `minimum` is exclusive) is draft 04's, as in OpenAPI 3.0;
   * it is accepted because documents migrated from 3.0 still carry it.
   */
  exclusiveMinimum?: number | boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  maxContains?: number;
  minContains?: number;
  maxProperties?: number;
  minProperties?: number;
  required?: string[];
  dependentRequired?: SpecMap<string[]>;

  // Meta-data vocabulary
  title?: string;
  description?: string;
  default?: FreeFormValue;
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  examples?: FreeFormValue[];

  // Format-annotation vocabulary
  format?: string;

  // Content vocabulary
  contentEncoding?: string;
  contentMediaType?: string;
  contentSchema?: JsonSchema2020<Vocabulary> | boolean;

  // Keywords of earlier drafts the 2020-12 meta-schema still declares
  /** @deprecated Replaced by `$defs`. */
  definitions?: SpecMap<JsonSchema2020<Vocabulary> | boolean>;
  /** @deprecated Split into `dependentSchemas` and `dependentRequired`. */
  dependencies?: SpecMap<JsonSchema2020<Vocabulary> | boolean | string[]>;
  /** @deprecated Replaced by `$dynamicAnchor`. */
  $recursiveAnchor?: string;
  /** @deprecated Replaced by `$dynamicRef`. */
  $recursiveRef?: string;
} & Vocabulary;
