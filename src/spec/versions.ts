/**
 * OpenAPI versions: which version a document declares, what each known
 * version allows (its profile), and which version introduced each feature.
 *
 * Every rule here comes from the official OAI JSON Schemas vendored under
 * `e2e/fixtures/oas/schemas/` (cited per value as `<version> schema
 * <pointer>`) and the specification text. The patch number never changes
 * behaviour: the specification says tooling SHOULD NOT consider it.
 *
 * Swagger 2.0 is a family like the others (`'2.0'`, the oldest), declared by
 * the `swagger` field instead of `openapi`. A 2.0 document is converted to
 * OpenAPI 3.0 (`upgradeSwagger2`, `./upgrade-v2.ts`) before the library reads
 * it; its profile describes the document as written, for validation and for
 * the operations the converter reads.
 *
 * Adding a minor version (3.3): add its family to `SPEC_FAMILIES`, its profile
 * to `SPEC_PROFILES`, and its new features to `SPEC_FEATURES`.
 *
 * @module
 */

import { SPEC_DIAGNOSTIC_CODES, appendPointer, describeValue, type SpecDiagnostic } from './diagnostics';
import {
  LEGACY_OPERATION_LAYOUT,
  STANDARD_METHODS,
  isSpecObject,
  ownProperty,
  type OperationLayout,
  type StandardMethod,
} from './operations';

/**
 * A known specification `major.minor`, oldest first in `SPEC_FAMILIES`:
 * Swagger 2.0 (`swagger: "2.0"`) and OpenAPI 3.0, 3.1 and 3.2.
 */
export type SpecFamily = '2.0' | '3.0' | '3.1' | '3.2';

/** The known families, oldest first. Comparisons between families use this order. */
export const SPEC_FAMILIES: readonly SpecFamily[] = Object.freeze(['2.0', '3.0', '3.1', '3.2'] as const);

/** The Swagger 2.0 family: the only one declared by `swagger` rather than `openapi`. */
const SWAGGER_FAMILY = '2.0' satisfies SpecFamily;

/** The newest known family. A newer 3.x minor version is processed with its profile. */
export const LATEST_SPEC_FAMILY: SpecFamily = '3.2';

/**
 * The supported versions, as named in messages, oldest first: `2.0` (the
 * `swagger` value Swagger 2.0 requires), then `3.0.x`, `3.1.x`, `3.2.x`.
 */
export const SUPPORTED_SPEC_VERSIONS: readonly string[] = Object.freeze(
  SPEC_FAMILIES.map((family) => (family === SWAGGER_FAMILY ? family : `${family}.x`)),
);

/** Field of the root object that declares the version. */
export type SpecVersionField = 'openapi' | 'swagger';

/**
 * What the declared version means for the library.
 *
 * - `supported`: a known family. `openapi` 3.0, 3.1 or 3.2, any patch, with
 *   or without a `-suffix`; or `swagger: "2.0"` (also the number `2`, as YAML
 *   reads an unquoted `2.0`), family `2.0`.
 * - `newer-minor`: a 3.x minor version newer than the latest known one
 *   (`3.3.0`, `3.7.1`); processed with the latest profile, with a
 *   `NEWER_OPENAPI_VERSION` warning.
 * - `unsupported`: a well-formed version of another major or minor
 *   (`openapi: "1.0.0"`, `"2.0.0"`, `"4.0.0"`, `swagger: "1.2"`, `"3.0"`).
 * - `malformed`: a version field holding something that is not a version
 *   (`3.1`, `banana`, a number, `null`, ...).
 * - `missing`: neither field is present, or the document is not an object.
 */
export type SpecVersionStatus = 'supported' | 'newer-minor' | 'unsupported' | 'malformed' | 'missing';

/** The result of `detectSpecVersion`. */
export interface SpecVersionInfo {
  status: SpecVersionStatus;
  /** The field the version was read from; `undefined` when `missing`. */
  field?: SpecVersionField;
  /** The declared value exactly as read (any type); `undefined` when `missing`. */
  declared?: unknown;
  /** Declared major version; set unless `malformed` or `missing`. */
  major?: number;
  /** Declared minor version; set unless `malformed` or `missing`. */
  minor?: number;
  /**
   * The profile the document is processed with: the declared family when
   * `supported` (`2.0` for Swagger 2.0), `LATEST_SPEC_FAMILY` when
   * `newer-minor`, otherwise `undefined`. Defined exactly when the document
   * can be processed.
   */
  family?: SpecFamily;
  /** `NEWER_OPENAPI_VERSION`, `CONFLICTING_VERSION_FIELDS`; never an error. */
  diagnostics: SpecDiagnostic[];
}

/**
 * `major.minor.patch` with an optional `-suffix`. Major and minor have no
 * leading zeros, so that the known families match exactly the official
 * schemas' patterns: `^3\.1\.[0-9]+(-.+)?$` (3.1 schema `#/properties/openapi/pattern`),
 * `^3\.2\.[0-9]+(-.+)?$` (3.2), and `^3\.0\.\d(-.+)?$` (3.0, whose single-digit
 * patch is not enforced here: the patch never matters). `.` excludes line
 * terminators, as in the schemas (ECMA-262 regular expressions).
 */
const OPENAPI_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.[0-9]+(?:-.+)?$/;

/** `major.minor`, the form of the Swagger `swagger` field. */
const SWAGGER_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const [LATEST_MAJOR, LATEST_MINOR] = LATEST_SPEC_FAMILY.split('.').map(Number);

/** Longest stretch of a declared version string quoted in a message (by `describeValue`). */
const VERSION_TEXT_MAX_LENGTH = 32;

/** Whether `value` is a family declared by the `openapi` field (every family but Swagger 2.0). */
function isOpenapiFamily(value: string): value is SpecFamily {
  return value !== SWAGGER_FAMILY && (SPEC_FAMILIES as readonly string[]).includes(value);
}

/** Parses `major` and `minor`; `undefined` if either is past the safe-integer range. */
function versionNumbers(match: RegExpExecArray): { major: number; minor: number } | undefined {
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) ? { major, minor } : undefined;
}

function fromOpenapiField(declared: unknown): SpecVersionInfo {
  const malformed: SpecVersionInfo = { status: 'malformed', field: 'openapi', declared, diagnostics: [] };
  if (typeof declared !== 'string') return malformed;
  const match = OPENAPI_VERSION.exec(declared);
  const numbers = match === null ? undefined : versionNumbers(match);
  if (numbers === undefined) return malformed;
  const { major, minor } = numbers;
  const known = `${major}.${minor}`;
  if (isOpenapiFamily(known)) {
    return { status: 'supported', field: 'openapi', declared, major, minor, family: known, diagnostics: [] };
  }
  if (major === LATEST_MAJOR && minor > LATEST_MINOR) {
    return {
      status: 'newer-minor',
      field: 'openapi',
      declared,
      major,
      minor,
      family: LATEST_SPEC_FAMILY,
      diagnostics: [
        {
          severity: 'warning',
          code: SPEC_DIAGNOSTIC_CODES.NEWER_OPENAPI_VERSION,
          message: `The document declares OpenAPI ${versionText(declared)}, newer than the latest version this library knows (${LATEST_SPEC_FAMILY}); it is processed with the OpenAPI ${LATEST_SPEC_FAMILY} rules`,
          path: '/openapi',
        },
      ],
    };
  }
  return { status: 'unsupported', field: 'openapi', declared, major, minor, diagnostics: [] };
}

function fromSwaggerField(declared: unknown): SpecVersionInfo {
  // 2.0 schema #/properties/swagger/enum: ["2.0"]; YAML reads an unquoted `2.0` as the number 2
  if (declared === '2.0' || declared === 2) {
    return {
      status: 'supported',
      field: 'swagger',
      declared,
      major: 2,
      minor: 0,
      family: SWAGGER_FAMILY,
      diagnostics: [],
    };
  }
  const match = typeof declared === 'string' ? SWAGGER_VERSION.exec(declared) : null;
  const numbers = match === null ? undefined : versionNumbers(match);
  return numbers === undefined
    ? { status: 'malformed', field: 'swagger', declared, diagnostics: [] }
    : { status: 'unsupported', field: 'swagger', declared, ...numbers, diagnostics: [] };
}

/**
 * Reads the version a document declares, from `openapi` or, failing that,
 * `swagger`. Never throws; any value is accepted.
 *
 * A field counts as present when the document owns it with a value other
 * than `undefined`. With both present, `openapi` decides and a
 * `CONFLICTING_VERSION_FIELDS` warning is added.
 */
export function detectSpecVersion(document: unknown): SpecVersionInfo {
  const openapi = ownProperty(document, 'openapi');
  const swagger = ownProperty(document, 'swagger');
  if (!isSpecObject(document) || (openapi === undefined && swagger === undefined)) {
    return { status: 'missing', diagnostics: [] };
  }
  if (openapi === undefined) return fromSwaggerField(swagger);
  const info = fromOpenapiField(openapi);
  if (swagger !== undefined) {
    info.diagnostics.push({
      severity: 'warning',
      code: SPEC_DIAGNOSTIC_CODES.CONFLICTING_VERSION_FIELDS,
      message: 'The document declares both `openapi` and `swagger`; `swagger` is ignored',
      path: '/swagger',
    });
  }
  return info;
}

/**
 * Whether `document` declares Swagger 2.0 (`swagger: "2.0"`, or the number
 * `2` from an unquoted YAML `2.0`) and no `openapi` field: the documents
 * `upgradeSwagger2` converts. Never throws.
 */
export function isSwagger2(document: unknown): boolean {
  return detectSpecVersion(document).family === SWAGGER_FAMILY;
}

/** The declared value as quoted in messages: cut, JSON-quoted and escaped by `describeValue`. */
function versionText(declared: unknown): string {
  return describeValue(declared, VERSION_TEXT_MAX_LENGTH);
}

/** `OpenAPI "3.1.0"`, `Swagger "1.2"`: the declared version as named in messages. */
function declaredText(info: SpecVersionInfo): string {
  return `${info.field === 'swagger' ? 'Swagger' : 'OpenAPI'} ${versionText(info.declared)}`;
}

const OPENAPI_VERSIONS = SUPPORTED_SPEC_VERSIONS.filter((version) => version !== SWAGGER_FAMILY);

const EXPECTED_VERSIONS = `Expected Swagger ${SWAGGER_FAMILY} or OpenAPI ${OPENAPI_VERSIONS.slice(0, -1).join(', ')} or ${OPENAPI_VERSIONS[OPENAPI_VERSIONS.length - 1]} (a later 3.x is read with the ${LATEST_SPEC_FAMILY} rules)`;

/**
 * Why a document with this version cannot be processed, as a message naming
 * the supported versions; `undefined` when it can (`supported`,
 * `newer-minor`). `info` that is not an object reads as a missing version.
 */
export function describeSpecVersionProblem(info: SpecVersionInfo): string | undefined {
  if (!isSpecObject(info)) return describeSpecVersionProblem(detectSpecVersion(undefined));
  switch (info.status) {
    case 'supported':
    case 'newer-minor':
      return undefined;
    case 'unsupported':
      return `Unsupported version: ${declaredText(info)}. ${EXPECTED_VERSIONS}`;
    case 'malformed':
      return info.field === 'swagger'
        ? `Malformed version: \`swagger\` must be "2.0", found ${versionText(info.declared)}. ${EXPECTED_VERSIONS}`
        : `Malformed version: \`openapi\` must be a version string such as "3.1.0", found ${versionText(info.declared)}. ${EXPECTED_VERSIONS}`;
    case 'missing':
      return `Missing version: the document has neither an \`openapi\` nor a \`swagger\` field. ${EXPECTED_VERSIONS}`;
  }
}

/** Orders families oldest first: negative when `a` is older than `b`, 0 when equal. */
export function compareSpecFamilies(a: SpecFamily, b: SpecFamily): number {
  return SPEC_FAMILIES.indexOf(a) - SPEC_FAMILIES.indexOf(b);
}

/** A Parameter Object `in` value of some version (`formData` and `body` are Swagger 2.0's). */
export type ParameterLocationName = 'path' | 'query' | 'querystring' | 'header' | 'cookie' | 'formData' | 'body';

/**
 * What one OpenAPI version allows, for the rules the library applies. It is
 * an `OperationLayout`, so it can be passed to `listOperations`.
 */
export interface SpecProfile extends OperationLayout {
  readonly family: SpecFamily;
  /** Path Item fields holding an Operation Object, in `STANDARD_METHODS` order. */
  readonly fixedMethods: readonly StandardMethod[];
  /** Whether the Path Item has `additionalOperations`. */
  readonly additionalOperations: boolean;
  /** The Parameter Object `in` values (a set; the order means nothing). */
  readonly parameterLocations: readonly ParameterLocationName[];
  /** Whether `in: querystring` exists (`parameterLocations` includes it). */
  readonly querystringParameter: boolean;
  /** Whether the Operation Object requires `responses`. */
  readonly operationResponsesRequired: boolean;
  /** Whether the Response Object requires `description`. */
  readonly responseDescriptionRequired: boolean;
  /** Whether the root object requires `paths`. */
  readonly pathsRequired: boolean;
  /** Root fields of which at least one must be present; empty when the version demands none. */
  readonly rootRequiresAnyOf: readonly string[];
  /** Whether the root object has `webhooks`. */
  readonly webhooks: boolean;
  /** Whether the Components Object has `pathItems`. */
  readonly componentsPathItems: boolean;
  /** Whether the Components Object has `mediaTypes`. */
  readonly componentsMediaTypes: boolean;
  /** Whether the root object has `$self`. */
  readonly self: boolean;
  /** The Security Scheme Object `type` values (Swagger 2.0: of a security definition). */
  readonly securitySchemeTypes: readonly string[];
  /** The `in` values of an `apiKey` security scheme, which also requires a `name`. */
  readonly apiKeyLocations: readonly string[];
  /** Whether a Schema Object's `$ref` applies together with its other keywords, rather than replacing them. */
  readonly schemaReferenceSiblings: boolean;
}

const PROFILE_2_0: SpecProfile = Object.freeze({
  family: '2.0',
  // 2.0 schema #/definitions/pathItem/properties: $ref, get, put, post, delete, options, head, patch,
  // parameters (additionalProperties: false): no trace, no query
  fixedMethods: Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const),
  // 2.0 schema #/definitions/pathItem: no additionalOperations property, additionalProperties: false
  additionalOperations: false,
  // 2.0 schema #/definitions/parameter/oneOf: bodyParameter (#/definitions/bodyParameter/properties/in/enum
  // ["body"]) and nonBodyParameter, one of headerParameterSubSchema, formDataParameterSubSchema,
  // queryParameterSubSchema, pathParameterSubSchema (each properties/in/enum one location)
  parameterLocations: Object.freeze(['path', 'query', 'header', 'formData', 'body'] as const),
  querystringParameter: false,
  // 2.0 schema #/definitions/operation/required: ["responses"]
  operationResponsesRequired: true,
  // 2.0 schema #/definitions/response/required: ["description"]
  responseDescriptionRequired: true,
  // 2.0 schema #/required: ["swagger", "info", "paths"]
  pathsRequired: true,
  // 2.0 schema: no root anyOf (paths is required outright)
  rootRequiresAnyOf: Object.freeze([]),
  // 2.0 schema #/properties: no webhooks (additionalProperties: false)
  webhooks: false,
  // 2.0 schema #/properties: no components (reusable objects live in definitions, parameters,
  // responses and securityDefinitions), so no pathItems
  componentsPathItems: false,
  // Same: no components, so no mediaTypes
  componentsMediaTypes: false,
  // 2.0 schema #/properties: no $self
  self: false,
  // 2.0 schema #/definitions/securityDefinitions: basicAuthenticationSecurity, apiKeySecurity and the
  // oauth2 definitions, each fixing properties/type/enum to one value
  securitySchemeTypes: Object.freeze(['basic', 'apiKey', 'oauth2']),
  // 2.0 schema #/definitions/apiKeySecurity/properties/in/enum (required: type, name, in)
  apiKeyLocations: Object.freeze(['header', 'query']),
  // 2.0 spec text, Reference Object: a JSON Reference, whose other members are ignored
  schemaReferenceSiblings: false,
});

const PROFILE_3_0: SpecProfile = Object.freeze({
  family: '3.0',
  // 3.0 schema #/definitions/PathItem/properties: get, put, post, delete, options, head, patch, trace
  // (additionalProperties: false, so no other method field)
  fixedMethods: Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const),
  // 3.0 schema #/definitions/PathItem: no additionalOperations property, additionalProperties: false
  additionalOperations: false,
  // 3.0 schema #/definitions/Parameter/oneOf: PathParameter, QueryParameter, HeaderParameter,
  // CookieParameter, each fixing #/definitions/<name>/properties/in/enum to one location
  parameterLocations: Object.freeze(['path', 'query', 'header', 'cookie'] as const),
  querystringParameter: false,
  // 3.0 schema #/definitions/Operation/required: ["responses"]
  operationResponsesRequired: true,
  // 3.0 schema #/definitions/Response/required: ["description"]
  responseDescriptionRequired: true,
  // 3.0 schema #/required: ["openapi", "info", "paths"]
  pathsRequired: true,
  // 3.0 schema: no root anyOf (paths is required outright)
  rootRequiresAnyOf: Object.freeze([]),
  // 3.0 schema #/properties: no webhooks (additionalProperties: false)
  webhooks: false,
  // 3.0 schema #/definitions/Components/properties: no pathItems
  componentsPathItems: false,
  // 3.0 schema #/definitions/Components/properties: no mediaTypes
  componentsMediaTypes: false,
  // 3.0 schema #/properties: no $self
  self: false,
  // 3.0 schema #/definitions/SecurityScheme/oneOf: APIKey, HTTP, OAuth2 and OpenIdConnect security schemes,
  // each fixing properties/type/enum to one value
  securitySchemeTypes: Object.freeze(['apiKey', 'http', 'oauth2', 'openIdConnect']),
  // 3.0 schema #/definitions/APIKeySecurityScheme/properties/in/enum (required: type, name, in)
  apiKeyLocations: Object.freeze(['header', 'query', 'cookie']),
  // 3.0 spec text, Reference Object: "any properties added SHALL be ignored"
  schemaReferenceSiblings: false,
});

const PROFILE_3_1: SpecProfile = Object.freeze({
  family: '3.1',
  // 3.1 schema #/$defs/path-item/properties: get, put, post, delete, options, head, patch, trace
  // (unevaluatedProperties: false)
  fixedMethods: Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const),
  // 3.1 schema #/$defs/path-item/properties: no additionalOperations
  additionalOperations: false,
  // 3.1 schema #/$defs/parameter/properties/in/enum: ["query", "header", "path", "cookie"]
  parameterLocations: Object.freeze(['path', 'query', 'header', 'cookie'] as const),
  querystringParameter: false,
  // 3.1 schema #/$defs/operation: no required (spec 3.1 dropped REQUIRED from Operation.responses)
  operationResponsesRequired: false,
  // 3.1 schema #/$defs/response/required: ["description"]
  responseDescriptionRequired: true,
  // 3.1 schema #/required: ["openapi", "info"]
  pathsRequired: false,
  // 3.1 schema #/anyOf: [{required: [paths]}, {required: [components]}, {required: [webhooks]}]
  rootRequiresAnyOf: Object.freeze(['paths', 'components', 'webhooks']),
  // 3.1 schema #/properties/webhooks
  webhooks: true,
  // 3.1 schema #/$defs/components/properties/pathItems
  componentsPathItems: true,
  // 3.1 schema #/$defs/components/properties: no mediaTypes
  componentsMediaTypes: false,
  // 3.1 schema #/properties: no $self
  self: false,
  // 3.1 schema #/$defs/security-scheme/properties/type/enum
  securitySchemeTypes: Object.freeze(['apiKey', 'http', 'mutualTLS', 'oauth2', 'openIdConnect']),
  // 3.1 schema #/$defs/security-scheme/$defs/type-apikey: properties/in/enum (required: name, in)
  apiKeyLocations: Object.freeze(['query', 'header', 'cookie']),
  // 3.1 spec text, Schema Object: JSON Schema 2020-12, where `$ref` is an applicator beside other keywords
  schemaReferenceSiblings: true,
});

const PROFILE_3_2: SpecProfile = Object.freeze({
  family: '3.2',
  // 3.2 schema #/$defs/path-item/properties: get, put, post, delete, options, head, patch, trace, query
  fixedMethods: Object.freeze(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'query'] as const),
  // 3.2 schema #/$defs/path-item/properties/additionalOperations. Its propertyNames are
  // #/$defs/token and `not: {enum: [GET, PUT, POST, DELETE, OPTIONS, HEAD, PATCH, TRACE, QUERY]}`:
  // only those exact upper-case names are forbidden (DUPLICATE_FIXED_METHOD). Other case
  // variants (`post`, `Get`) are valid but ignored by listOperations (METHOD_CASE_VARIANT)
  additionalOperations: true,
  // 3.2 schema #/$defs/parameter/properties/in/enum: ["query", "querystring", "header", "path", "cookie"]
  parameterLocations: Object.freeze(['path', 'query', 'querystring', 'header', 'cookie'] as const),
  // 3.2 schema #/$defs/parameter/properties/in/enum includes "querystring"; #/$defs/parameters
  // allows at most one, never together with in: query
  querystringParameter: true,
  // 3.2 schema #/$defs/operation: no required
  operationResponsesRequired: false,
  // 3.2 schema #/$defs/response: no required (description became optional; summary was added)
  responseDescriptionRequired: false,
  // 3.2 schema #/required: ["openapi", "info"]
  pathsRequired: false,
  // 3.2 schema #/anyOf: [{required: [paths]}, {required: [components]}, {required: [webhooks]}]
  rootRequiresAnyOf: Object.freeze(['paths', 'components', 'webhooks']),
  // 3.2 schema #/properties/webhooks
  webhooks: true,
  // 3.2 schema #/$defs/components/properties/pathItems
  componentsPathItems: true,
  // 3.2 schema #/$defs/components/properties/mediaTypes
  componentsMediaTypes: true,
  // 3.2 schema #/properties/$self
  self: true,
  // 3.2 schema #/$defs/security-scheme/properties/type/enum
  securitySchemeTypes: Object.freeze(['apiKey', 'http', 'mutualTLS', 'oauth2', 'openIdConnect']),
  // 3.2 schema #/$defs/security-scheme/$defs/type-apikey: properties/in/enum (required: name, in)
  apiKeyLocations: Object.freeze(['query', 'header', 'cookie']),
  // 3.2 spec text, Schema Object: JSON Schema 2020-12, as in 3.1
  schemaReferenceSiblings: true,
});

/**
 * The first field of a Security Scheme Object that `profile` does not define, and why (a fragment that follows the
 * scheme's name), or `undefined`: a `type` outside `securitySchemeTypes`, or for `apiKey` an `in` outside
 * `apiKeyLocations` or no `name`. Values compare exactly. Shared by the validator (the declared version's
 * profile) and generation (the latest one: generation reads a feature whatever version the document declares).
 */
export function securitySchemeProblem(
  scheme: Record<string, unknown>,
  profile: SpecProfile,
): { field: 'type' | 'in' | 'name'; problem: string } | undefined {
  const { type, in: location, name } = scheme;
  if (typeof type !== 'string' || !profile.securitySchemeTypes.includes(type)) {
    return {
      field: 'type',
      problem: `has the type ${describeValue(type)}, which is none of ${profile.securitySchemeTypes.join(', ')}`,
    };
  }
  if (type !== 'apiKey') return undefined;
  if (typeof location !== 'string' || !profile.apiKeyLocations.includes(location)) {
    return {
      field: 'in',
      problem: `is an apiKey scheme sent in ${describeValue(location)}, which is none of ${profile.apiKeyLocations.join(', ')}`,
    };
  }
  return typeof name === 'string' && name !== '' ? undefined : { field: 'name', problem: 'is an apiKey scheme without a name' };
}

/** The profile of each known family. */
export const SPEC_PROFILES: Readonly<Record<SpecFamily, SpecProfile>> = Object.freeze({
  '2.0': PROFILE_2_0,
  '3.0': PROFILE_3_0,
  '3.1': PROFILE_3_1,
  '3.2': PROFILE_3_2,
});

/**
 * The profile of `family`; `undefined` for anything that is not a known
 * family (including `undefined`, so `getSpecProfile(info.family)` works).
 */
export function getSpecProfile(family: SpecFamily): SpecProfile;
export function getSpecProfile(family: string | undefined): SpecProfile | undefined;
export function getSpecProfile(family: string | undefined): SpecProfile | undefined {
  return typeof family === 'string' && Object.hasOwn(SPEC_PROFILES, family)
    ? SPEC_PROFILES[family as SpecFamily]
    : undefined;
}

/**
 * Which operations of a document are read: the single place that decides it.
 *
 * A `supported` or `newer-minor` version gets its profile's layout, so `query`
 * and `additionalOperations` are read only when the declared version defines
 * them (3.2 and later), and a Swagger 2.0 document has no `trace` (its seven
 * methods). Any other status (`missing`, `malformed`, `unsupported`) gets
 * `LEGACY_OPERATION_LAYOUT`, exactly what the library read before OpenAPI 3.2
 * support.
 */
export function resolveOperationLayout(version: SpecVersionInfo): OperationLayout {
  // `version` that is not an object reads as a version that cannot be processed
  const status = ownProperty(version, 'status');
  const processable = status === 'supported' || status === 'newer-minor';
  return (processable ? getSpecProfile(ownProperty(version, 'family') as string | undefined) : undefined) ??
    LEGACY_OPERATION_LAYOUT;
}

/** A Path Item field holding operations that a layout does not read. */
export interface SkippedOperationField {
  /** The field: a standard method's fixed field or `additionalOperations`. */
  field: StandardMethod | 'additionalOperations';
  /**
   * The feature the field is (`queryMethod`, `additionalOperations`), for
   * `featureNewerThanDeclared`; `undefined` for a field no version after 3.0
   * added (`trace`, absent from Swagger 2.0 only).
   */
  feature?: SpecFeatureId;
  /** JSON Pointer of the field (`options.pointer` + the field name). */
  path: string;
}

/** Options of `listSkippedNewerOperations`. */
export interface ListSkippedNewerOperationsOptions {
  /** JSON Pointer of the Path Item, prefixed to each `path`. Default `''`. */
  pointer?: string;
}

/**
 * The operation fields `pathItem` holds that `layout` does not read, in
 * `STANDARD_METHODS` order with `additionalOperations` last: one call per
 * Path Item, at most ten own-property reads, never walking a map.
 *
 * A field counts when the Path Item owns it with a value other than
 * `undefined`, whatever that value is (an empty or malformed
 * `additionalOperations` still uses the feature). Report each with
 * `featureNewerThanDeclared(skipped.feature, version, skipped.path)`, which
 * gives `FEATURE_NEWER_THAN_DECLARED_VERSION` when the declared version
 * predates it and nothing for a version that cannot be processed.
 */
export function listSkippedNewerOperations(
  pathItem: unknown,
  layout: OperationLayout,
  options?: ListSkippedNewerOperationsOptions | null,
): SkippedOperationField[] {
  const pointer = ownProperty(options, 'pointer');
  const base = typeof pointer === 'string' ? pointer : '';
  const skipped: SkippedOperationField[] = [];
  // A layout that is not one skips nothing: every field counts as read
  if (!isSpecObject(pathItem) || !isSpecObject(layout) || !Array.isArray(layout.fixedMethods)) return skipped;
  for (const method of STANDARD_METHODS) {
    if (layout.fixedMethods.includes(method) || ownProperty(pathItem, method) === undefined) continue;
    skipped.push({
      field: method,
      ...(method === 'query' ? { feature: 'queryMethod' as const } : {}),
      path: appendPointer(base, method),
    });
  }
  if (!layout.additionalOperations && ownProperty(pathItem, 'additionalOperations') !== undefined) {
    skipped.push({
      field: 'additionalOperations',
      feature: 'additionalOperations',
      path: appendPointer(base, 'additionalOperations'),
    });
  }
  return skipped;
}

/** A construct that only some versions define. */
export interface SpecFeature {
  /** The first family that defines it. */
  readonly since: SpecFamily;
  /** How a message names it. */
  readonly label: string;
}

// Each entry cites the schema field that the version adds (absent from the
// previous version's schema).
const FEATURES = {
  // 3.1 schema #/properties/webhooks
  webhooks: { since: '3.1', label: 'The `webhooks` field' },
  // 3.1 schema #/properties/jsonSchemaDialect
  jsonSchemaDialect: { since: '3.1', label: 'The `jsonSchemaDialect` field' },
  // 3.1 schema #/$defs/components/properties/pathItems
  componentsPathItems: { since: '3.1', label: 'Components `pathItems`' },
  // 3.1 schema #/$defs/info/properties/summary
  infoSummary: { since: '3.1', label: 'Info `summary`' },
  // 3.1 schema #/$defs/license/properties/identifier
  licenseIdentifier: { since: '3.1', label: 'License `identifier`' },
  // 3.1 schema #/$defs/reference/properties/summary and description
  referenceSummaryDescription: { since: '3.1', label: 'Reference Object `summary` and `description`' },
  // 3.1 schema #/$defs/security-scheme/properties/type/enum includes "mutualTLS"
  mutualTLS: { since: '3.1', label: 'The `mutualTLS` security scheme type' },
  // 3.2 schema #/properties/$self
  self: { since: '3.2', label: 'The `$self` field' },
  // 3.2 schema #/$defs/path-item/properties/query
  queryMethod: { since: '3.2', label: 'The `query` operation' },
  // 3.2 schema #/$defs/path-item/properties/additionalOperations
  additionalOperations: { since: '3.2', label: 'Path Item `additionalOperations`' },
  // 3.2 schema #/$defs/parameter/properties/in/enum includes "querystring"
  querystringParameter: { since: '3.2', label: 'A parameter `in: querystring`' },
  // 3.2 schema #/$defs/parameter/dependentSchemas/schema/$defs/styles-for-cookie/then/properties/style/enum
  // includes "cookie"
  cookieStyle: { since: '3.2', label: 'A cookie parameter with `style: cookie`' },
  // 3.2 schema #/$defs/media-type/properties/itemSchema
  itemSchema: { since: '3.2', label: 'Media Type `itemSchema`' },
  // 3.2 schema #/$defs/media-type/properties/prefixEncoding and #/$defs/encoding/properties/prefixEncoding
  prefixEncoding: { since: '3.2', label: '`prefixEncoding`' },
  // 3.2 schema #/$defs/media-type/properties/itemEncoding and #/$defs/encoding/properties/itemEncoding
  itemEncoding: { since: '3.2', label: '`itemEncoding`' },
  // 3.2 schema #/$defs/encoding/properties/encoding
  nestedEncoding: { since: '3.2', label: 'Encoding Object `encoding`' },
  // 3.2 schema #/$defs/components/properties/mediaTypes (and #/$defs/media-type-or-reference)
  componentsMediaTypes: { since: '3.2', label: 'Components `mediaTypes`' },
  // 3.2 schema #/$defs/response/properties/summary
  responseSummary: { since: '3.2', label: 'Response `summary`' },
  // 3.2 schema #/$defs/example/properties/dataValue
  exampleDataValue: { since: '3.2', label: 'Example `dataValue`' },
  // 3.2 schema #/$defs/example/properties/serializedValue
  exampleSerializedValue: { since: '3.2', label: 'Example `serializedValue`' },
  // 3.2 schema #/$defs/server/properties/name
  serverName: { since: '3.2', label: 'Server `name`' },
  // 3.2 schema #/$defs/tag/properties/summary
  tagSummary: { since: '3.2', label: 'Tag `summary`' },
  // 3.2 schema #/$defs/tag/properties/parent
  tagParent: { since: '3.2', label: 'Tag `parent`' },
  // 3.2 schema #/$defs/tag/properties/kind
  tagKind: { since: '3.2', label: 'Tag `kind`' },
  // 3.2 schema #/$defs/security-scheme/properties/deprecated
  securitySchemeDeprecated: { since: '3.2', label: 'Security Scheme `deprecated`' },
  // 3.2 spec text, Security Requirement Object: a name "MUST either correspond to a security scheme
  // declared in the Security Schemes under the Components Object, or be the URI of a Security Scheme
  // Object" (the schema is unchanged: the keys were always free strings)
  securitySchemeUri: { since: '3.2', label: 'A security scheme named by URI' },
  // 3.2 schema #/$defs/security-scheme/$defs/type-oauth2/then/properties/oauth2MetadataUrl
  oauth2MetadataUrl: { since: '3.2', label: 'Security Scheme `oauth2MetadataUrl`' },
  // 3.2 schema #/$defs/oauth-flows/properties/deviceAuthorization
  deviceAuthorizationFlow: { since: '3.2', label: 'The `deviceAuthorization` OAuth flow' },
  // 3.2 meta #/$defs/discriminator/properties/defaultMapping
  discriminatorDefaultMapping: { since: '3.2', label: 'Discriminator `defaultMapping`' },
  // 3.2 meta #/$defs/xml/properties/nodeType
  xmlNodeType: { since: '3.2', label: 'XML `nodeType`' },
} as const satisfies Record<string, SpecFeature>;

for (const feature of Object.values(FEATURES)) Object.freeze(feature);

/**
 * Every construct added after OpenAPI 3.0, with the version that added it,
 * so a caller can report "feature X needs OpenAPI N" for a document that
 * declares an older version (`featureNewerThanDeclared`). Generation handles
 * a feature it understands whatever the declared version; validation reports
 * it. Changes to the JSON Schema dialect (3.1) are not listed.
 */
export const SPEC_FEATURES: typeof FEATURES = Object.freeze(FEATURES);

/** The name of a feature in `SPEC_FEATURES`. */
export type SpecFeatureId = keyof typeof SPEC_FEATURES;

function featureOf(feature: string): SpecFeature | undefined {
  return Object.hasOwn(SPEC_FEATURES, feature) ? SPEC_FEATURES[feature as SpecFeatureId] : undefined;
}

/** Whether `family` defines `feature`. An unknown feature name counts as available. */
export function isFeatureAvailable(feature: SpecFeatureId, family: SpecFamily): boolean {
  const known = featureOf(feature);
  return known === undefined || compareSpecFamilies(known.since, family) <= 0;
}

/**
 * A `FEATURE_NEWER_THAN_DECLARED_VERSION` warning when the document's
 * declared version predates `feature`, else `undefined`. Nothing is reported
 * for a version that cannot be processed (no `family`) or a `newer-minor`
 * one (processed as the latest family, which defines every known feature).
 *
 * `path` is the JSON Pointer of the construct, such as
 * `jsonPointer('paths', '/pets', 'query')`.
 */
export function featureNewerThanDeclared(
  feature: SpecFeatureId,
  version: SpecVersionInfo,
  path?: string,
): SpecDiagnostic | undefined {
  const known = featureOf(feature);
  // A `version` that is not an object, or names no known family, cannot be processed
  const family = getSpecProfile(ownProperty(version, 'family') as string | undefined)?.family;
  if (known === undefined || family === undefined || compareSpecFamilies(known.since, family) <= 0) {
    return undefined;
  }
  return {
    severity: 'warning',
    code: SPEC_DIAGNOSTIC_CODES.FEATURE_NEWER_THAN_DECLARED_VERSION,
    message: `${known.label} needs OpenAPI ${known.since} or later, but the document declares ${declaredText(version)}`,
    ...(typeof path === 'string' ? { path } : {}),
  };
}
