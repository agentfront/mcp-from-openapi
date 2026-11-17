/**
 * Swagger 2.0 to OpenAPI 3.0: `upgradeSwagger2`.
 *
 * The converter takes a DEREFERENCED Swagger 2.0 document (every `$ref`
 * already replaced by its target, as the generator's dereferencing leaves
 * it) and returns an OpenAPI 3.0 document plus diagnostics. Converting after
 * dereferencing is what makes split documents work: a parameter or response
 * defined in another file is inline by then, and is converted in the context
 * of each operation's own `consumes` and `produces`.
 *
 * Guarantees, for any input (the document is untrusted):
 *
 * - **Total.** It never throws. A value of the wrong kind is reported
 *   (`SWAGGER_INVALID_VALUE`) and skipped; every lossy or impossible
 *   conversion is a diagnostic whose code is in `SPEC_DIAGNOSTIC_CODES`.
 * - **Pure.** The input is never mutated. Root, path items, operations,
 *   parameters, request bodies, responses, headers and security schemes are
 *   new objects. Schema Objects, examples, defaults, enums, `info`, `tags`,
 *   `externalDocs` and security requirements are attached by reference, so
 *   sharing and cycles survive; only a schema that must change shape (below)
 *   is replaced by a new object, and so is each schema that leads to one.
 * - **Linear.** Every source object is converted once per context it is used
 *   in: a non-body parameter, a header, an Items Object and a schema once; a
 *   body parameter once per `consumes` list; a response once per `produces`
 *   list. A parameter shared by N operations yields one converted object that
 *   all N reference, when the input shares it (objects are told apart by
 *   identity: a dereferencer that copies each `$ref` target gives N objects,
 *   converted N times and reported as one grouped finding). Nothing recurses: the only unbounded chains (`items` of
 *   Items Objects, nested schemas) are walked with explicit stacks and a seen
 *   set; the pointer of a diagnostic deep in one keeps where the walk
 *   started and its last 32 segments.
 *   A diagnostic about a shared object is reported once, at the first place
 *   it was found.
 * - **Order independent.** The output does not depend on the order of an
 *   object's fields; maps (paths, responses, definitions, ...) keep their
 *   order.
 *
 * What it converts (OpenAPI 3.0.3 is declared):
 *
 * | Swagger 2.0 | OpenAPI 3.0 |
 * | --- | --- |
 * | `host`, `basePath`, `schemes` | `servers`, one per scheme; see `serverUrls` |
 * | operation `schemes` | operation `servers`, when they differ from the root's |
 * | `consumes`, `produces` (operation overrides root; empty means none) | request body and response media types; `application/json` when none applies |
 * | `in: body` | `requestBody`, one media type entry per `consumes` value |
 * | `in: formData` | `requestBody` of an object schema, `multipart/form-data` or `application/x-www-form-urlencoded` |
 * | `type: file` | `type: string, format: binary` |
 * | non-body `type`, `format`, `items`, validation keywords | `schema` |
 * | `collectionFormat` | `style` and `explode` (form bodies: `encoding`) |
 * | response `schema`, `examples`, `headers` | `content` per `produces` value with `example`; Header Objects with `schema` |
 * | `definitions`, `parameters`, `responses`, `securityDefinitions` | `components.schemas`, `parameters` / `requestBodies`, `responses`, `securitySchemes` |
 * | `basic`; `apiKey`; `oauth2` flows `implicit`, `password`, `application`, `accessCode` | `http`/`basic`; `apiKey`; flows `implicit`, `password`, `clientCredentials`, `authorizationCode` |
 * | Schema: string `discriminator`, `x-nullable`, `type` lists, `$ref: #/definitions/...` | `discriminator: {propertyName}`, `nullable`, single `type` (`anyOf` for several), `#/components/schemas/...` |
 *
 * `info`, `tags`, `externalDocs`, `security` and every `x-` extension are
 * carried over. Fields Swagger 2.0 does not define are not
 * (`SWAGGER_UNKNOWN_FIELD`).
 *
 * @module
 */

import {
  POINTER_TRUNCATION_MARKER,
  SPEC_DIAGNOSTIC_CODES,
  appendPointer,
  describeValue,
  type SpecDiagnostic,
  type SpecDiagnosticSeverity,
} from './diagnostics';
import { isSpecObject, listOperations, ownProperty, type OperationEntry } from './operations';
import { parameterNameNotStringDiagnostic, readParameterName } from './parameters';
import type { OAS30 } from './types';
import { SPEC_FEATURES, SPEC_PROFILES, isSwagger2, listSkippedNewerOperations } from './versions';

/** The `openapi` value of every converted document. */
export const UPGRADED_OPENAPI_VERSION = '3.0.3';

/**
 * The most distinct media types kept from one `consumes` or `produces` list;
 * the first ones, in order, after duplicates are removed. A 2.0 list applies
 * to every operation (or response) that does not override it, and its 3.0
 * form spells each media type out in every request body and response, so an
 * unbounded list multiplies with the number of operations.
 */
export const MAX_MEDIA_TYPES_PER_LIST = 32;

/**
 * The most entries one conversion creates in the maps it builds: media types
 * of request bodies and responses (`content`), form `encoding` entries,
 * response headers and form body properties. A 2.0 document states once what
 * its 3.0 form repeats per operation, so a small document can need a large
 * conversion; past this the conversion is abandoned (`tooLarge`).
 */
export const MAX_CONVERSION_ENTRIES = 1_000_000;

/** Options of `upgradeSwagger2`. */
export interface UpgradeSwagger2Options {
  /**
   * Where the document was retrieved from (an absolute URI). The 2.0
   * specification says a document without `host` describes an API on the host
   * serving the document, and one without `schemes` uses the scheme it was
   * retrieved with: an `http` or `https` URI here supplies both, a `ws` or
   * `wss` one only the host (its user information is never used). Any other
   * value is ignored.
   */
  documentUri?: string;
  /**
   * The most entries the conversion may create (see
   * `MAX_CONVERSION_ENTRIES`, the default and the most allowed); a value that
   * is not a positive number is read as the default.
   */
  maxEntries?: number;
}

/** The result of `upgradeSwagger2`. */
export interface UpgradeSwagger2Result {
  /** The OpenAPI 3.0 document (`openapi: "3.0.3"`). */
  document: OAS30.OpenAPIObject;
  /** What could not be converted exactly, in the order found. Never an error. */
  diagnostics: SpecDiagnostic[];
  /**
   * For each `parameters` list of the converted document (a Path Item's or an
   * Operation's), the index each of its entries has in the source list. The
   * indexes differ where `in: body` and `in: formData` parameters became the
   * request body, so a finding about a converted parameter can name where
   * the parameter is in the 2.0 document.
   */
  parameterIndexes: WeakMap<object, readonly number[]>;
  /**
   * Set when converting would create more entries than allowed (`maxEntries`,
   * at most `MAX_CONVERSION_ENTRIES`): the conversion is abandoned, `document` has no paths, and the
   * last diagnostic is `SWAGGER_CONVERSION_TOO_LARGE`.
   */
  tooLarge?: true;
}

/**
 * Converts a dereferenced Swagger 2.0 document to OpenAPI 3.0. Never throws
 * and never mutates `document`; see the module documentation for every rule.
 *
 * A document that does not declare Swagger 2.0 is converted as if it did,
 * with a `SWAGGER_VERSION_NOT_2_0` warning (check `isSwagger2` first); one
 * that is not an object gives an empty document and a `SWAGGER_INVALID_VALUE`
 * warning. `options` that are not an object, or hold a value of the wrong
 * kind, are read as absent.
 */
export function upgradeSwagger2(document: unknown, options?: UpgradeSwagger2Options | null): UpgradeSwagger2Result {
  const maxEntries = ownProperty(options, 'maxEntries');
  const budget =
    typeof maxEntries === 'number' && maxEntries > 0 ? Math.min(Math.floor(maxEntries), MAX_CONVERSION_ENTRIES) : MAX_CONVERSION_ENTRIES;
  return new Swagger2Upgrader(ownProperty(options, 'documentUri'), budget).upgrade(document);
}

/** What `readSwagger2BasePath` found in a `basePath`. */
export type Swagger2BasePath =
  /** Usable as written: a path starting with `/`, without its trailing slashes. */
  | { kind: 'usable'; path: string }
  /** Usable once `/` is prepended (the 2.0 schema requires the leading slash): `path` has it. */
  | { kind: 'missing-slash'; path: string }
  /** Not usable as a URL path; `problem` says why, for a message. */
  | { kind: 'unusable'; problem: string };

/**
 * Reads a Swagger 2.0 `basePath` (2.0 schema #/properties/basePath/pattern
 * `^/`). A path a server URL cannot carry unchanged is unusable: not a
 * string, or holding `{` or `}` (OpenAPI 3 reads them as a server variable),
 * whitespace or a control character, `?` or `#` (a query or fragment), a
 * backslash, or a `.` or `..` segment (written as is or percent-encoded),
 * which URL parsers remove. Shared by the converter and the validator's 2.0
 * rules, so they read it alike. Never throws.
 */
export function readSwagger2BasePath(value: unknown): Swagger2BasePath {
  if (typeof value !== 'string') return { kind: 'unusable', problem: `it must be a string, found ${describeValue(value)}` };
  const character = BASE_PATH_UNUSABLE.exec(value);
  if (character !== null) {
    return {
      kind: 'unusable',
      problem: `it holds ${describeValue(character[0])}, which a server URL path cannot carry (a template, whitespace, a query, a fragment or a backslash)`,
    };
  }
  if (value.split('/').some(isDotSegment)) {
    return { kind: 'unusable', problem: 'it has a "." or ".." segment, which a URL parser removes' };
  }
  const path = trimTrailingSlashes(value.startsWith('/') ? value : `/${value}`);
  return value.startsWith('/') ? { kind: 'usable', path } : { kind: 'missing-slash', path };
}

/** Whether a path segment is `.` or `..`, percent-encoded or not: URL parsers resolve it away */
export function isDotSegment(segment: string): boolean {
  return /^(?:\.|%2e){1,2}$/i.test(segment);
}

/**
 * One `FEATURE_NEWER_THAN_DECLARED_VERSION` warning for each operation field
 * of a Swagger 2.0 Path Item that Swagger 2.0 does not define (`trace`,
 * `query`, `additionalOperations`): it is not converted, so it makes no
 * tool. `pointer` is the Path Item's JSON Pointer. Shared by the converter
 * and the validator's 2.0 rules, so the two report one diagnostic.
 */
export function swagger2SkippedOperations(pathItem: unknown, pointer: string): SpecDiagnostic[] {
  return listSkippedNewerOperations(pathItem, SPEC_PROFILES['2.0'], { pointer: typeof pointer === 'string' ? pointer : '' }).map((skipped) => {
    const feature = skipped.feature === undefined ? undefined : SPEC_FEATURES[skipped.feature];
    return {
      severity: 'warning',
      code: SPEC_DIAGNOSTIC_CODES.FEATURE_NEWER_THAN_DECLARED_VERSION,
      message: `${feature?.label ?? 'The `trace` operation'} needs OpenAPI ${feature?.since ?? '3.0'} or later and is not part of Swagger 2.0; it is not converted`,
      path: skipped.path,
    };
  });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type SpecRecord = Record<string, unknown>;

const JSON_MEDIA_TYPE = 'application/json';
const URLENCODED_MEDIA_TYPE = 'application/x-www-form-urlencoded';
const MULTIPART_MEDIA_TYPE = 'multipart/form-data';

const DEFINITIONS_PREFIX = '#/definitions/';
const SCHEMAS_PREFIX = '#/components/schemas/';

/** 2.0 schema #/definitions/schemesList/items/enum */
const WEB_SCHEMES: readonly string[] = ['http', 'https', 'ws', 'wss'];

/** The schemes of the servers an HTTP operation is sent to. */
const HTTP_SCHEMES: readonly string[] = ['http', 'https'];

/**
 * The 2.0 schema's `host` pattern (#/properties/host/pattern,
 * `^[^{}/ :\\]+(?::\d+)?$`), also refusing user information, a query or a
 * fragment (`@`, `?`, `#`), whitespace and control characters, which would
 * change what the server URL means.
 */
const HOST = /^[^{}/:\\?#@\s\u0000-\u001f\u007f]+(?::[0-9]+)?$/;

/**
 * A character a `basePath` cannot hold (see `readSwagger2BasePath`): what
 * would change the URL (`?`, `#`, a `{` or `}` an OpenAPI 3 server URL reads
 * as a variable, backslashes) and whitespace or control characters.
 */
const BASE_PATH_UNUSABLE = /[{}?#\\\s\u0000-\u001f\u007f]/;

/** Scheme and authority of an absolute URI. */
const URI_ORIGIN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/;

/** A host name, IPv4 or bracketed IPv6 literal, with an optional port. */
const AUTHORITY_HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[^{}/:\\?#@[\]\s\u0000-\u001f\u007f]+)(?::[0-9]+)?$/;

/** Fields shared by the Items Object, the Header Object and non-body parameters that become schema keywords. */
const SIMPLE_SCHEMA_KEYWORDS: readonly string[] = [
  'default',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'maxItems',
  'minItems',
  'uniqueItems',
  'enum',
  'multipleOf',
];

// The fields of each object, from the 2.0 schema's `properties` (each has
// additionalProperties: false and allows ^x- extensions)

/** 2.0 schema #/properties */
const ROOT_FIELDS: ReadonlySet<string> = new Set([
  'swagger',
  'info',
  'host',
  'basePath',
  'schemes',
  'consumes',
  'produces',
  'paths',
  'definitions',
  'parameters',
  'responses',
  'security',
  'securityDefinitions',
  'tags',
  'externalDocs',
]);

/**
 * 2.0 schema #/definitions/pathItem/properties, plus the operation fields of
 * later versions, which are reported as operations rather than as unknown
 * fields.
 */
const PATH_ITEM_FIELDS: ReadonlySet<string> = new Set([
  '$ref',
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'parameters',
  'trace',
  'query',
  'additionalOperations',
]);

/** 2.0 schema #/definitions/operation/properties */
const OPERATION_FIELDS: ReadonlySet<string> = new Set([
  'tags',
  'summary',
  'description',
  'externalDocs',
  'operationId',
  'produces',
  'consumes',
  'parameters',
  'responses',
  'schemes',
  'deprecated',
  'security',
]);

/** 2.0 schema #/definitions/bodyParameter/properties */
const BODY_PARAMETER_FIELDS: ReadonlySet<string> = new Set(['name', 'in', 'description', 'required', 'schema']);

/** 2.0 schema #/definitions/primitivesItems/properties */
const ITEMS_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'format',
  'items',
  'collectionFormat',
  ...SIMPLE_SCHEMA_KEYWORDS,
]);

/** 2.0 schema #/definitions/header/properties */
const HEADER_FIELDS: ReadonlySet<string> = new Set([...ITEMS_FIELDS, 'description']);

/**
 * The union of the properties of 2.0 schema #/definitions/headerParameterSubSchema,
 * formDataParameterSubSchema, queryParameterSubSchema and pathParameterSubSchema.
 */
const NON_BODY_PARAMETER_FIELDS: ReadonlySet<string> = new Set([
  ...ITEMS_FIELDS,
  'name',
  'in',
  'description',
  'required',
  'allowEmptyValue',
  // Not a 2.0 field, but written by many 2.0 documents (OpenAPI 3.0 has it): converted, see `exampleOf`
  'example',
]);

/** 2.0 schema #/definitions/response/properties */
const RESPONSE_FIELDS: ReadonlySet<string> = new Set(['description', 'schema', 'headers', 'examples']);

/** The union of the properties of the 2.0 schema's six security scheme definitions. */
const SECURITY_SCHEME_FIELDS: ReadonlySet<string> = new Set([
  'type',
  'description',
  'name',
  'in',
  'flow',
  'authorizationUrl',
  'tokenUrl',
  'scopes',
]);

/** The URLs each 2.0 OAuth2 flow requires (2.0 schema #/definitions/oauth2*Security/required), and its 3.0 name. */
const OAUTH2_FLOWS: ReadonlyMap<string, { name: string; urls: readonly string[] }> = new Map([
  ['implicit', { name: 'implicit', urls: ['authorizationUrl'] }],
  ['password', { name: 'password', urls: ['tokenUrl'] }],
  ['application', { name: 'clientCredentials', urls: ['tokenUrl'] }],
  ['accessCode', { name: 'authorizationCode', urls: ['authorizationUrl', 'tokenUrl'] }],
]);

/** Most fields named in one `SWAGGER_UNKNOWN_FIELD` or list diagnostic. */
const LISTED_NAMES = 3;

/** Most places listed in the message of a finding reported for several places. */
const LISTED_PLACES = 3;

/** Longest place quoted in such a message (a pointer cut there is for display only). */
const LISTED_PLACE_MAX_LENGTH = 256;

/** Thrown inside the converter when the conversion passes `MAX_CONVERSION_ENTRIES`; never escapes it. */
const TOO_LARGE: unique symbol = Symbol('too large');

/**
 * The kind of a finding, from its message: every quoted value (as
 * `describeValue` writes it) and every number replaced, so findings that
 * differ only in the value they quote are one kind.
 */
function findingKind(message: string): string {
  return message.replace(/"(?:[^"\\]|\\.)*"/g, '"…"').replace(/[0-9]+/g, '#');
}

/** Most trailing segments a diagnostic pointer keeps; deeper ones start with `POINTER_TRUNCATION_MARKER`. */
const MAX_TRAIL_SEGMENTS = 32;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Where a value sits: a chain of pointer segments built in constant time per
 * step, turned into a JSON Pointer only when a diagnostic needs one.
 */
interface Trail {
  /** Pointer (already escaped) the chain starts from. */
  readonly root: string;
  readonly parent: Trail | undefined;
  readonly segment: string | number;
}

const rootTrail = (pointer: string): Trail => ({ root: pointer, parent: undefined, segment: '' });

const childTrail = (parent: Trail, segment: string | number): Trail => ({ root: parent.root, parent, segment });

/** `trail` as the root of a new chain: its pointer is computed once (it is shallow), deeper segments hang below. */
const anchorTrail = (trail: Trail): Trail => rootTrail(trailPointer(trail));

/**
 * The pointer of `trail`, keeping at most its last `MAX_TRAIL_SEGMENTS`
 * segments below its root. Walks that can go arbitrarily deep (a schema
 * graph, an Items chain) start from `anchorTrail`, so a cut pointer still
 * names where the walk started.
 */
function trailPointer(trail: Trail): string {
  const segments: Array<string | number> = [];
  let node = trail;
  while (node.parent !== undefined && segments.length < MAX_TRAIL_SEGMENTS) {
    segments.push(node.segment);
    node = node.parent;
  }
  segments.reverse();
  return node.parent === undefined
    ? appendPointer(trail.root, ...segments)
    : appendPointer(trail.root, POINTER_TRUNCATION_MARKER, ...segments);
}

/**
 * Sets an own enumerable property, `__proto__` included (a plain assignment
 * would set the prototype instead).
 */
function setEntry(target: SpecRecord, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/** Copies `key` from `source` to `target` when `source` owns it with a value. */
function copyField(source: SpecRecord, target: SpecRecord, key: string): void {
  const value = ownProperty(source, key);
  if (value !== undefined) setEntry(target, key, value);
}

/** Copies every `x-` extension of `source` to `target`, by reference. */
function copyExtensions(source: SpecRecord, target: SpecRecord): void {
  for (const key of Object.keys(source)) {
    if (key.startsWith('x-')) setEntry(target, key, source[key]);
  }
}

/** `"a", "b", "c" and 4 more`: the first names of a list, described and bounded. */
function listNames(names: readonly string[], total: number): string {
  const listed = names.map((name) => describeValue(name)).join(', ');
  return total > names.length ? `${listed} and ${total - names.length} more` : listed;
}

/**
 * The `SWAGGER_UNKNOWN_FIELD` message for the fields `names` of an `owner`
 * (`A parameter`) found in `count` objects.
 */
function unknownFieldsMessage(owner: string, names: ReadonlySet<string>, count: number): string {
  const total = names.size;
  const listed = listNames([...names].slice(0, LISTED_NAMES), total);
  if (count === 1) {
    return `${owner} has ${total === 1 ? 'a field' : `${total} fields`} Swagger 2.0 does not define there (${listed}); ${total === 1 ? 'it is' : 'they are'} not converted`;
  }
  const where = `${owner[0].toLowerCase()}${owner.slice(1)}`;
  return `${total === 1 ? 'A field' : `${total} fields`} Swagger 2.0 does not define in ${where} (${listed}) ${total === 1 ? 'is' : 'are'} not converted`;
}

/**
 * The example of a non-body parameter: its `example` (an OpenAPI 3.0 field
 * many 2.0 documents write), else its `x-example` (the 2.0 convention);
 * `undefined` with neither. It becomes the 3.0 parameter's `example` (a form
 * field's schema `example`); `x-example` is also kept as an extension.
 */
function exampleOf(source: SpecRecord): unknown {
  const example = ownProperty(source, 'example');
  return example !== undefined ? example : ownProperty(source, 'x-example');
}

/** The `collectionFormat` values of the 2.0 schema (#/definitions/collectionFormat/enum). */
const COLLECTION_FORMATS: readonly string[] = ['csv', 'ssv', 'tsv', 'pipes', 'multi'];

/** The parameter locations the converter knows (2.0, and 3.0's `cookie`). */
const KNOWN_LOCATIONS: readonly string[] = ['query', 'header', 'path', 'formData', 'body', 'cookie'];

/**
 * A `collectionFormat` in a message: a 2.0 value as itself, so findings
 * about different formats are different kinds (`findingKind`); any other
 * value quoted and escaped (`describeValue`).
 */
function formatText(format: unknown): string {
  return typeof format === 'string' && COLLECTION_FORMATS.includes(format) ? format : describeValue(format);
}

/** A parameter location in a message, the way `formatText` writes a format. */
function locationText(location: string): string {
  return KNOWN_LOCATIONS.includes(location) ? location : describeValue(location);
}

/** `type/subtype` of a media type, lower-cased, without parameters. */
function mediaTypeEssence(mediaType: string): string {
  const semicolon = mediaType.indexOf(';');
  return (semicolon === -1 ? mediaType : mediaType.slice(0, semicolon)).trim().toLowerCase();
}

/** The value without its trailing slashes (a loop: a regular expression would be quadratic). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end--;
  return value.slice(0, end);
}

/** Scheme and host of a web URI (user information dropped); `undefined` for anything else. */
function parseOrigin(uri: unknown): { scheme: string; authority: string } | undefined {
  if (typeof uri !== 'string') return undefined;
  const match = URI_ORIGIN.exec(uri);
  if (match === null) return undefined;
  const scheme = match[1].toLowerCase();
  const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
  return WEB_SCHEMES.includes(scheme) && AUTHORITY_HOST.test(authority) ? { scheme, authority } : undefined;
}

/** The media types an operation reads or writes, and where they came from. */
interface MediaTypes {
  /** The source list (memoisation key), or a per-direction sentinel for the default. */
  readonly key: object;
  readonly field: 'consumes' | 'produces';
  /** Media types as written, without duplicates; never empty. */
  readonly types: readonly string[];
  /** `mediaTypeEssence` of each of `types`. */
  readonly essences: readonly string[];
  /** Whether the document declared them (`false`: `application/json` was assumed). */
  readonly declared: boolean;
}

/** A parameter with a string `in`, and where it was first found. */
interface ParsedParameter {
  readonly source: SpecRecord;
  /** The name as a string: as written, or a number or boolean's text; `''` when it cannot be a name. */
  readonly name: string;
  /** The `name` of the converted parameter: `name`, or the value as written when it cannot be a name. */
  readonly convertedName: unknown;
  /** Whether `name` cannot be a name (an object, an array, `null`, `''`, absent). */
  readonly invalidName: boolean;
  readonly in: string;
  readonly trail: Trail;
}

/** A parameter at its index in the list it was read from. */
interface ListedParameter {
  readonly parameter: ParsedParameter;
  readonly index: number;
}

/** Findings of one kind (see `findingKind`), reported as one diagnostic. */
interface FindingGroup {
  readonly diagnostic: SpecDiagnostic;
  count: number;
  readonly places: string[];
  /** For `SWAGGER_UNKNOWN_FIELD`: the owner, and the distinct field names in the order found. */
  readonly fields?: { readonly owner: string; readonly names: Set<string> };
}

/** One `in: formData` parameter as a property of the form body. */
interface FormField {
  readonly schema: SpecRecord;
  readonly required: boolean;
  readonly file: boolean;
  /**
   * Encoding of an array in a form body (multipart or urlencoded), from its
   * `collectionFormat`; `undefined` for a value that is not an array.
   */
  readonly encoding: { style: string; explode: boolean } | undefined;
}

/** A form media type of a `consumes` list. */
interface FormMediaType {
  readonly type: string;
  readonly urlencoded: boolean;
}

/** The parts of a response that do not depend on `produces`, converted once per response. */
interface ResponseParts {
  readonly description: unknown;
  readonly headers: SpecRecord | undefined;
  /** The converted schema; `undefined` when the response has no body. */
  readonly schema: unknown;
  readonly examples: SpecRecord | undefined;
  /** Example keys by media type essence, the first key of each. */
  readonly exampleKeys: ReadonlyMap<string, string>;
  readonly extensions: SpecRecord;
}

/** What `serverUrls` builds from: the validated root fields. */
interface ServerBase {
  readonly host: string | undefined;
  /** `''` or a path starting with `/`, without a trailing slash. */
  readonly basePath: string;
  readonly origin: { scheme: string; authority: string } | undefined;
}

// ---------------------------------------------------------------------------
// The converter
// ---------------------------------------------------------------------------

class Swagger2Upgrader {
  private readonly diagnostics: SpecDiagnostic[] = [];
  /** Findings by code, severity and kind: each kind is one diagnostic, however often it is found. */
  private readonly groups = new Map<string, FindingGroup>();
  private readonly schemas = new SchemaRewriter((severity, code, message, trail) =>
    this.report(severity, code, message, trail),
  );
  private readonly origin: { scheme: string; authority: string } | undefined;
  /** Entries created so far in content, encoding, header and form-property maps. */
  private entries = 0;
  /** Converted `parameters` lists, with the source index of each entry. */
  private readonly parameterIndexes = new WeakMap<object, readonly number[]>();
  /** Media type lists cut at `MAX_MEDIA_TYPES_PER_LIST`: how many, the media types dropped, the first one's place. */
  private readonly cutLists = { count: 0, dropped: 0, first: undefined as Trail | undefined };

  /** Normalized media type lists, by source array. */
  private readonly mediaTypeLists = new Map<unknown[], MediaTypes>();
  private readonly defaultMediaTypes: Record<'consumes' | 'produces', MediaTypes> = {
    consumes: { key: {}, field: 'consumes', types: [JSON_MEDIA_TYPE], essences: [JSON_MEDIA_TYPE], declared: false },
    produces: { key: {}, field: 'produces', types: [JSON_MEDIA_TYPE], essences: [JSON_MEDIA_TYPE], declared: false },
  };
  private readonly assumedReported = new Set<'consumes' | 'produces'>();
  /** Whether an operation's `schemes` was reported as inapplicable (once per document). */
  private relativeSchemesReported = false;

  /** Parsed parameters by source; `null` for one that is not usable. */
  private readonly parsedParameters = new Map<object, ParsedParameter | null>();
  private readonly convertedParameters = new Map<object, SpecRecord>();
  private readonly bodySchemas = new Map<object, unknown>();
  private readonly bodies = new Map<object, Map<object, SpecRecord>>();
  private readonly formFields = new Map<object, FormField>();
  private readonly formMediaTypes = new Map<object, Map<boolean, readonly FormMediaType[]>>();
  private readonly itemsSchemas = new Map<object, SpecRecord>();
  private readonly headers = new Map<object, SpecRecord | null>();
  private readonly responseParts = new Map<object, ResponseParts | null>();
  private readonly responses = new Map<object, Map<object, SpecRecord>>();

  constructor(
    documentUri: unknown,
    private readonly maxEntries: number,
  ) {
    this.origin = parseOrigin(documentUri);
  }

  upgrade(document: unknown): UpgradeSwagger2Result {
    try {
      return this.convert(document);
    } catch (error: unknown) {
      /* c8 ignore next -- the converter throws nothing else */
      if (error !== TOO_LARGE) throw error;
      this.diagnostics.push({
        severity: 'warning',
        code: SPEC_DIAGNOSTIC_CODES.SWAGGER_CONVERSION_TOO_LARGE,
        message:
          `Converting the document needs more than ${this.maxEntries} media type, encoding, header and form ` +
          'property entries (a 2.0 `consumes`, `produces` or path-level parameter applies to every operation, and the ' +
          'OpenAPI 3.0 form repeats it in each); the conversion is abandoned and the document is returned without paths',
        path: '',
      });
      const root: SpecRecord = { openapi: UPGRADED_OPENAPI_VERSION, paths: {} };
      if (isSpecObject(document)) copyField(document, root, 'info');
      return { ...this.result(root), tooLarge: true };
    }
  }

  private convert(document: unknown): UpgradeSwagger2Result {
    const root: SpecRecord = { openapi: UPGRADED_OPENAPI_VERSION };
    if (!isSpecObject(document)) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_INVALID_VALUE,
        `A Swagger 2.0 document must be an object, found ${describeValue(document)}; an empty OpenAPI 3.0 document is returned`,
        rootTrail(''),
      );
      root['paths'] = {};
      return this.result(root);
    }
    if (!isSwagger2(document)) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_VERSION_NOT_2_0,
        `The document does not declare \`swagger: "2.0"\` (found ${describeValue(ownProperty(document, 'swagger'))}${ownProperty(document, 'openapi') === undefined ? '' : ' and an `openapi` field'}); it is converted as Swagger 2.0`,
        rootTrail('/swagger'),
      );
    }
    this.reportUnknownFields(document, ROOT_FIELDS, rootTrail(''), 'The Swagger Object');

    const consumes = this.rootMediaTypes(document, 'consumes');
    const produces = this.rootMediaTypes(document, 'produces');
    const base: ServerBase = {
      host: this.hostOf(ownProperty(document, 'host')),
      basePath: this.basePathOf(ownProperty(document, 'basePath')),
      origin: this.origin,
    };
    const rootSchemes = this.schemeList(ownProperty(document, 'schemes'), rootTrail('/schemes'));
    const servers = this.serverUrls(base, rootSchemes, true);

    // Components first, so a diagnostic about a shared object points at its definition
    const components = this.components(document, consumes, produces);
    const paths = this.paths(ownProperty(document, 'paths'), { base, servers, consumes, produces });

    copyField(document, root, 'info');
    root['servers'] = servers.map((url) => ({ url }));
    root['paths'] = paths;
    if (Object.keys(components).length > 0) root['components'] = components;
    copyField(document, root, 'security');
    copyField(document, root, 'tags');
    copyField(document, root, 'externalDocs');
    copyExtensions(document, root);
    return this.result(root);
  }

  /**
   * The result, with each finding group's message completed: the field names
   * of a `SWAGGER_UNKNOWN_FIELD` group, and for a kind found more than once
   * how often and where (the first `LISTED_PLACES` places).
   */
  private result(root: SpecRecord): UpgradeSwagger2Result {
    if (this.cutLists.first !== undefined) {
      const { count, dropped } = this.cutLists;
      this.diagnostics.push({
        severity: 'warning',
        code: SPEC_DIAGNOSTIC_CODES.SWAGGER_MEDIA_TYPE_LIMIT,
        message:
          `${count === 1 ? 'A `consumes` or `produces` list holds' : `${count} \`consumes\` or \`produces\` lists hold`} ` +
          `more than ${MAX_MEDIA_TYPES_PER_LIST} distinct media types: the first ${MAX_MEDIA_TYPES_PER_LIST} of each are ` +
          `kept and ${dropped} ${dropped === 1 ? 'is' : 'are'} ignored`,
        path: trailPointer(this.cutLists.first),
      });
    }
    for (const group of this.groups.values()) {
      if (group.fields !== undefined) {
        group.diagnostic.message = unknownFieldsMessage(group.fields.owner, group.fields.names, group.count);
      }
      if (group.count > 1) {
        const places = group.places
          .map((place) => (place.length > LISTED_PLACE_MAX_LENGTH ? `${place.slice(0, LISTED_PLACE_MAX_LENGTH)}...` : place))
          .join(', ');
        const more = group.count - group.places.length;
        group.diagnostic.message += ` (in ${group.count} places: ${places}${more > 0 ? ` and ${more} more` : ''})`;
      }
    }
    return {
      document: root as unknown as OAS30.OpenAPIObject,
      diagnostics: this.diagnostics,
      parameterIndexes: this.parameterIndexes,
    };
  }

  /**
   * Records a finding. The first finding of a kind (`findingKind`: its code,
   * severity and message with the quoted values left out) is a diagnostic at
   * its place; a later one of the same kind only adds to that diagnostic's
   * count and places, so a document repeating one problem a thousand times
   * yields one diagnostic.
   */
  private report(severity: SpecDiagnosticSeverity, code: string, message: string, trail: Trail): void {
    this.record(severity, code, `${code}\u0000${severity}\u0000${findingKind(message)}`, message, trail);
  }

  private record(
    severity: SpecDiagnosticSeverity,
    code: string,
    kind: string,
    message: string,
    trail: Trail,
    fields?: FindingGroup['fields'],
  ): FindingGroup {
    const path = trailPointer(trail);
    let group = this.groups.get(kind);
    if (group === undefined) {
      group = { diagnostic: { severity, code, message, path }, count: 0, places: [], ...(fields && { fields }) };
      this.groups.set(kind, group);
      this.diagnostics.push(group.diagnostic);
    }
    group.count++;
    if (group.places.length < LISTED_PLACES) group.places.push(path);
    return group;
  }

  private invalid(message: string, trail: Trail): void {
    this.report('warning', SPEC_DIAGNOSTIC_CODES.SWAGGER_INVALID_VALUE, message, trail);
  }

  /**
   * Counts `count` new entries against the budget (`maxEntries`), abandoning
   * the conversion past it.
   */
  private charge(count: number): void {
    this.entries += count;
    if (this.entries > this.maxEntries) throw TOO_LARGE;
  }

  /**
   * The fields of `value` that are neither in `known` nor extensions, as one
   * `SWAGGER_UNKNOWN_FIELD` per owner (`A parameter`, ...) for the whole
   * document, naming the distinct fields found.
   */
  private reportUnknownFields(value: SpecRecord, known: ReadonlySet<string>, trail: Trail, owner: string): void {
    const unknown = Object.keys(value).filter((key) => !known.has(key) && !key.startsWith('x-'));
    if (unknown.length === 0) return;
    const code = SPEC_DIAGNOSTIC_CODES.SWAGGER_UNKNOWN_FIELD;
    const group = this.record('info', code, `${code}\u0000${owner}`, '', trail, { owner, names: new Set() });
    for (const name of unknown) (group.fields as NonNullable<FindingGroup['fields']>).names.add(name);
  }

  // -- Servers --------------------------------------------------------------

  private hostOf(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string' && HOST.test(value)) return value;
    this.invalid(
      `\`host\` must be a host name or IP address with an optional port (no scheme, path or user information), found ${describeValue(value)}; it is ignored`,
      rootTrail('/host'),
    );
    return undefined;
  }

  /** The base path (see `readSwagger2BasePath`): `''` when absent or unusable, `/` prepended when missing. */
  private basePathOf(value: unknown): string {
    if (value === undefined) return '';
    const basePath = readSwagger2BasePath(value);
    if (basePath.kind === 'usable') return basePath.path;
    if (basePath.kind === 'missing-slash') {
      this.invalid(
        `\`basePath\` must start with "/", found ${describeValue(value)}; ${describeValue(basePath.path || '/')} is used`,
        rootTrail('/basePath'),
      );
      return basePath.path;
    }
    this.invalid(`\`basePath\` cannot be used: ${basePath.problem}; it is ignored`, rootTrail('/basePath'));
    return '';
  }

  /**
   * The schemes of a `schemes` list that servers are made for: `http` and
   * `https`, in the order written, without duplicates, in any letter case
   * (`HTTP`). `ws` and `wss` are valid 2.0 schemes, but an HTTP operation is
   * never sent over them, so they make no server (one diagnostic); anything
   * else is invalid. `undefined` when absent or not a list.
   */
  private schemeList(value: unknown, trail: Trail): readonly string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      this.invalid(`\`schemes\` must be a list, found ${describeValue(value)}; it is ignored`, trail);
      return undefined;
    }
    const schemes: string[] = [];
    const sockets: string[] = [];
    const rejected: string[] = [];
    let rejectedCount = 0;
    for (let index = 0; index < value.length; index++) {
      const entry: unknown = value[index];
      const scheme = typeof entry === 'string' ? entry.toLowerCase() : undefined;
      if (scheme !== undefined && WEB_SCHEMES.includes(scheme)) {
        const into = HTTP_SCHEMES.includes(scheme) ? schemes : sockets;
        if (!into.includes(scheme)) into.push(scheme);
        continue;
      }
      rejectedCount++;
      if (rejected.length < LISTED_NAMES) rejected.push(describeValue(entry));
    }
    if (rejectedCount > 0) {
      this.invalid(
        `\`schemes\` may only hold "http", "https", "ws" and "wss"; ${rejected.join(', ')}${rejectedCount > rejected.length ? ` and ${rejectedCount - rejected.length} more` : ''} ${rejectedCount === 1 ? 'is' : 'are'} ignored`,
        trail,
      );
    }
    if (sockets.length > 0) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
        `\`schemes\` lists ${listNames(sockets, sockets.length)} (WebSocket), which an HTTP operation is never sent over; no server is made for ${sockets.length === 1 ? 'it' : 'them'}`,
        trail,
      );
    }
    return schemes;
  }

  /**
   * Server URLs from the root `host` and `basePath` and a scheme list:
   *
   * - with `host`: `<scheme>://<host><basePath>` per http or https scheme
   *   (`schemeList`); without one, the scheme of an http or https
   *   `documentUri`, else `https` (`SWAGGER_ASSUMED_SCHEME`);
   * - without `host` but with a web `documentUri`: its host, the same way
   *   (the 2.0 text: "the host serving the documentation is to be used");
   * - with neither: the relative URL `<basePath>` (or `/`), which OpenAPI 3
   *   resolves against the document's location (`SWAGGER_RELATIVE_SERVER_URL`).
   *
   * `report` is false for an operation's `schemes`: the root already reported
   * what concerns the root fields.
   */
  private serverUrls(base: ServerBase, schemes: readonly string[] | undefined, report: boolean): string[] {
    const listed = schemes !== undefined && schemes.length > 0 ? schemes : undefined;
    const authority = base.host ?? base.origin?.authority;
    if (authority === undefined) {
      if (report) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_RELATIVE_SERVER_URL,
          `The document has no usable \`host\` and no web document URI was given, so the server URL is ${describeValue(base.basePath || '/')}, relative to wherever the document is served from${listed === undefined ? '' : '; `schemes` cannot apply without a host and is ignored'}`,
          rootTrail('/host'),
        );
      }
      return [base.basePath || '/'];
    }
    const originScheme =
      base.origin !== undefined && HTTP_SCHEMES.includes(base.origin.scheme) ? [base.origin.scheme] : undefined;
    let chosen = listed ?? originScheme;
    if (chosen === undefined) {
      if (report) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_ASSUMED_SCHEME,
          'The document lists no http or https scheme in `schemes`, and no http or https document URI was given to take the scheme from; https is assumed',
          rootTrail('/schemes'),
        );
      }
      chosen = ['https'];
    }
    return chosen.map((scheme) => `${scheme}://${authority}${base.basePath}`);
  }

  // -- Media types ----------------------------------------------------------

  private rootMediaTypes(document: SpecRecord, field: 'consumes' | 'produces'): MediaTypes {
    const value = ownProperty(document, field);
    return value === undefined
      ? this.defaultMediaTypes[field]
      : (this.mediaTypeList(value, rootTrail(`/${field}`), field) ?? this.defaultMediaTypes[field]);
  }

  /** An operation's `consumes` or `produces`: its own list when it has a valid one, else `inherited`. */
  private operationMediaTypes(value: unknown, trail: Trail, inherited: MediaTypes): MediaTypes {
    return value === undefined ? inherited : (this.mediaTypeList(value, trail, inherited.field) ?? inherited);
  }

  /**
   * A `consumes` or `produces` list, memoised by array: non-strings and empty
   * strings are dropped (one diagnostic), duplicates removed. An empty list
   * (the 2.0 text: "an empty value MAY be used to clear the global
   * definition") gives the default. `undefined` (with a diagnostic) for a
   * value that is not a list.
   */
  private mediaTypeList(value: unknown, trail: Trail, field: 'consumes' | 'produces'): MediaTypes | undefined {
    if (!Array.isArray(value)) {
      this.invalid(`\`${field}\` must be a list of media types, found ${describeValue(value)}; it is ignored`, trail);
      return undefined;
    }
    const known = this.mediaTypeLists.get(value);
    if (known !== undefined) return known;
    const types: string[] = [];
    const seen = new Set<string>();
    let rejected = 0;
    let firstRejected = -1;
    let dropped = 0;
    for (let index = 0; index < value.length; index++) {
      const entry: unknown = value[index];
      if (typeof entry !== 'string' || entry.trim() === '') {
        rejected++;
        if (firstRejected === -1) firstRejected = index;
        continue;
      }
      if (seen.has(entry)) continue;
      seen.add(entry);
      // Past the cap, a distinct media type is counted, not kept (one diagnostic per document, in `result`)
      if (types.length < MAX_MEDIA_TYPES_PER_LIST) types.push(entry);
      else dropped++;
    }
    if (dropped > 0) {
      this.cutLists.count++;
      this.cutLists.dropped += dropped;
      this.cutLists.first ??= trail;
    }
    if (rejected > 0) {
      this.invalid(
        `${rejected === 1 ? 'An entry' : `${rejected} entries`} of \`${field}\` ${rejected === 1 ? 'is not a media type' : 'are not media types'} (the first, at index ${firstRejected}, is ${describeValue(value[firstRejected])}); ignored`,
        trail,
      );
    }
    const list: MediaTypes =
      types.length === 0
        ? this.defaultMediaTypes[field]
        : { key: value, field, types, essences: types.map(mediaTypeEssence), declared: true };
    this.mediaTypeLists.set(value, list);
    return list;
  }

  /** Reports, once per direction, that `application/json` was assumed for a body. */
  private noteAssumed(mediaTypes: MediaTypes, trail: Trail): void {
    if (mediaTypes.declared || this.assumedReported.has(mediaTypes.field)) return;
    this.assumedReported.add(mediaTypes.field);
    this.report(
      'info',
      SPEC_DIAGNOSTIC_CODES.SWAGGER_ASSUMED_MEDIA_TYPE,
      `No \`${mediaTypes.field}\` media type applies to this ${mediaTypes.field === 'consumes' ? 'request body' : 'response body'}; ${JSON_MEDIA_TYPE} is assumed for it and for every other such body (reported once)`,
      trail,
    );
  }

  // -- Components -----------------------------------------------------------

  private components(document: SpecRecord, consumes: MediaTypes, produces: MediaTypes): SpecRecord {
    const components: SpecRecord = {};
    const schemas: SpecRecord = {};
    this.forEachEntry(document, 'definitions', (key, value, trail) => {
      if (isSpecObject(value)) {
        setEntry(schemas, key, this.schemas.rewrite(value, trail));
      } else {
        this.invalid(`A definition must be a Schema Object, found ${describeValue(value)}; it is ignored`, trail);
      }
    });

    const parameters: SpecRecord = {};
    const requestBodies: SpecRecord = {};
    this.forEachEntry(document, 'parameters', (key, value, trail) => {
      const parameter = this.parseParameter(value, trail);
      if (parameter === undefined) return;
      if (parameter.in === 'body') {
        setEntry(requestBodies, key, this.body(parameter, consumes, trail));
      } else if (parameter.in === 'formData') {
        this.report(
          'info',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
          'An `in: formData` parameter is one field of a request body, which OpenAPI 3.0 cannot define as a reusable parameter; it is not added to `components`, and operations using it carry it in their request body',
          trail,
        );
      } else {
        setEntry(parameters, key, this.parameter(parameter));
      }
    });

    const responses: SpecRecord = {};
    this.forEachEntry(document, 'responses', (key, value, trail) => {
      const response = this.response(value, produces, trail);
      if (response !== undefined) setEntry(responses, key, response);
    });

    const securitySchemes: SpecRecord = {};
    this.forEachEntry(document, 'securityDefinitions', (key, value, trail) => {
      const scheme = this.securityScheme(value, trail);
      if (scheme !== undefined) setEntry(securitySchemes, key, scheme);
    });

    const sections: Array<[string, SpecRecord]> = [
      ['schemas', schemas],
      ['responses', responses],
      ['parameters', parameters],
      ['requestBodies', requestBodies],
      ['securitySchemes', securitySchemes],
    ];
    for (const [name, section] of sections) {
      if (Object.keys(section).length > 0) components[name] = section;
    }
    // Kept even when empty: a requirement naming a scheme that could not be converted must stay
    // unsatisfiable, as a scheme `securityDefinitions` does not define is, not read as no security
    if (isSpecObject(ownProperty(document, 'securityDefinitions'))) components['securitySchemes'] = securitySchemes;
    return components;
  }

  /** Calls `visit` for each own entry of the map in `document[field]` whose value is not `undefined`. */
  private forEachEntry(
    document: SpecRecord,
    field: string,
    visit: (key: string, value: unknown, trail: Trail) => void,
  ): void {
    const map = ownProperty(document, field);
    if (map === undefined) return;
    const trail = rootTrail(`/${field}`);
    if (!isSpecObject(map)) {
      this.invalid(`\`${field}\` must be an object, found ${describeValue(map)}; it is ignored`, trail);
      return;
    }
    for (const key of Object.keys(map)) {
      const value = map[key];
      if (value !== undefined) visit(key, value, childTrail(trail, key));
    }
  }

  // -- Paths ----------------------------------------------------------------

  private paths(
    value: unknown,
    context: { base: ServerBase; servers: readonly string[]; consumes: MediaTypes; produces: MediaTypes },
  ): SpecRecord {
    const paths: SpecRecord = {};
    if (value === undefined) return paths;
    const trail = rootTrail('/paths');
    if (!isSpecObject(value)) {
      this.invalid(`\`paths\` must be an object, found ${describeValue(value)}; no path is converted`, trail);
      return paths;
    }
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item === undefined) continue;
      if (key.startsWith('x-')) {
        setEntry(paths, key, item);
        continue;
      }
      const converted = this.pathItem(item, childTrail(trail, key), context);
      if (converted !== undefined) setEntry(paths, key, converted);
    }
    return paths;
  }

  private pathItem(
    value: unknown,
    trail: Trail,
    context: { base: ServerBase; servers: readonly string[]; consumes: MediaTypes; produces: MediaTypes },
  ): SpecRecord | undefined {
    const pointer = trailPointer(trail);
    const layout = SPEC_PROFILES['2.0'];
    const listed = listOperations(value, { layout, pointer });
    for (const diagnostic of listed.diagnostics) this.diagnostics.push(diagnostic);
    if (!isSpecObject(value)) return undefined;
    if (ownProperty(value, '$ref') !== undefined) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_UNRESOLVED_REFERENCE,
        'A Path Item `$ref` is left unresolved (the converter expects a dereferenced document); it is ignored and only the fields beside it are converted',
        childTrail(trail, '$ref'),
      );
    }
    this.reportUnknownFields(value, PATH_ITEM_FIELDS, trail, 'A Path Item');
    for (const diagnostic of swagger2SkippedOperations(value, pointer)) this.diagnostics.push(diagnostic);

    const shared = this.splitParameters(
      this.parameterList(ownProperty(value, 'parameters'), childTrail(trail, 'parameters')),
    );
    const pathForms = this.mergeForms(new Map(), shared.forms);
    const item: SpecRecord = {};
    for (const entry of listed.operations) {
      setEntry(item, entry.method, this.operation(entry, childTrail(trail, entry.method), shared, pathForms, context));
    }
    if (shared.others.length > 0) item['parameters'] = this.parameterArray(shared.others);
    copyExtensions(value, item);
    return item;
  }

  private operation(
    entry: OperationEntry,
    trail: Trail,
    shared: { bodies: ParsedParameter[] },
    pathForms: ReadonlyMap<string, ParsedParameter>,
    context: { base: ServerBase; servers: readonly string[]; consumes: MediaTypes; produces: MediaTypes },
  ): SpecRecord {
    const operation = entry.operation as unknown as SpecRecord;
    this.reportUnknownFields(operation, OPERATION_FIELDS, trail, 'An Operation Object');
    const consumes = this.operationMediaTypes(
      ownProperty(operation, 'consumes'),
      childTrail(trail, 'consumes'),
      context.consumes,
    );
    const produces = this.operationMediaTypes(
      ownProperty(operation, 'produces'),
      childTrail(trail, 'produces'),
      context.produces,
    );
    const own = this.splitParameters(
      this.parameterList(ownProperty(operation, 'parameters'), childTrail(trail, 'parameters')),
    );

    const out: SpecRecord = {};
    for (const field of ['tags', 'summary', 'description', 'externalDocs', 'operationId']) {
      copyField(operation, out, field);
    }
    if (own.others.length > 0) out['parameters'] = this.parameterArray(own.others);
    const forms = this.mergeForms(pathForms, own.forms);
    const requestBody = this.requestBody(shared.bodies, own.bodies, forms, consumes, trail);
    if (requestBody !== undefined) out['requestBody'] = requestBody;
    out['responses'] = this.responsesObject(
      ownProperty(operation, 'responses'),
      produces,
      childTrail(trail, 'responses'),
    );
    copyField(operation, out, 'deprecated');
    copyField(operation, out, 'security');
    const servers = this.operationServers(ownProperty(operation, 'schemes'), childTrail(trail, 'schemes'), context);
    if (servers !== undefined) out['servers'] = servers;
    copyExtensions(operation, out);
    return out;
  }

  /** Servers for an operation's own `schemes`, when they give URLs other than the root's. */
  private operationServers(
    value: unknown,
    trail: Trail,
    context: { base: ServerBase; servers: readonly string[] },
  ): Array<{ url: string }> | undefined {
    const schemes = this.schemeList(value, trail);
    if (schemes === undefined || schemes.length === 0) return undefined;
    if (context.base.host === undefined && context.base.origin === undefined) {
      // A fact about the document, not the operation: some documents give every operation `schemes`
      if (!this.relativeSchemesReported) {
        this.relativeSchemesReported = true;
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
          'The operation `schemes` cannot apply: the document has no usable `host` and no web document URI was given, so its server URL is relative; it is ignored, here and in every other operation (reported once)',
          trail,
        );
      }
      return undefined;
    }
    const urls = this.serverUrls(context.base, schemes, false);
    const same = urls.length === context.servers.length && urls.every((url, index) => url === context.servers[index]);
    return same ? undefined : urls.map((url) => ({ url }));
  }

  // -- Parameters -----------------------------------------------------------

  private parameterList(value: unknown, trail: Trail): ListedParameter[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.invalid(`\`parameters\` must be a list, found ${describeValue(value)}; it is ignored`, trail);
      return [];
    }
    const parameters: ListedParameter[] = [];
    for (let index = 0; index < value.length; index++) {
      const parameter = this.parseParameter(value[index], childTrail(trail, index));
      if (parameter !== undefined) parameters.push({ parameter, index });
    }
    return parameters;
  }

  /** Non-body parameters as a converted `parameters` list, remembering the source index of each entry. */
  private parameterArray(parameters: readonly ListedParameter[]): SpecRecord[] {
    const converted = parameters.map((listed) => this.parameter(listed.parameter));
    this.parameterIndexes.set(
      converted,
      parameters.map((listed) => listed.index),
    );
    return converted;
  }

  /**
   * A parameter's `name` and `in`, memoised by object (so its diagnostics are
   * reported once); `undefined` for one that cannot be converted.
   */
  private parseParameter(value: unknown, trail: Trail): ParsedParameter | undefined {
    if (!isSpecObject(value)) {
      this.invalid(`A parameter must be an object, found ${describeValue(value)}; it is ignored`, trail);
      return undefined;
    }
    const known = this.parsedParameters.get(value);
    if (known !== undefined) return known ?? undefined;
    let parsed: ParsedParameter | null = null;
    const name = ownProperty(value, 'name');
    const location = ownProperty(value, 'in');
    const read = readParameterName(name);
    if (ownProperty(value, '$ref') !== undefined) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_UNRESOLVED_REFERENCE,
        'A parameter `$ref` is left unresolved (the converter expects a dereferenced document); the parameter is ignored',
        trail,
      );
    } else if (typeof location !== 'string') {
      this.invalid(`A parameter needs a string \`in\`, found ${describeValue(location)}; it is ignored`, trail);
    } else if (read.kind === 'invalid' && location === 'formData') {
      // The name of a form field is a property name: there is none to give it
      this.invalid(`An \`in: formData\` parameter needs a name, found ${describeValue(name)}; it is ignored`, trail);
    } else {
      // A number or boolean name is its text; another parameter without a name is converted with its
      // `name` as written, so generation skips its operation as for any document (INVALID_PARAMETER_NAME)
      if (read.kind === 'coerced') {
        this.diagnostics.push(parameterNameNotStringDiagnostic(name as number | boolean, trailPointer(trail)));
      }
      parsed = {
        source: value,
        name: read.kind === 'invalid' ? '' : read.name,
        convertedName: read.kind === 'invalid' ? name : read.name,
        invalidName: read.kind === 'invalid',
        in: location,
        trail,
      };
      const body = location === 'body';
      this.reportUnknownFields(
        value,
        body ? BODY_PARAMETER_FIELDS : NON_BODY_PARAMETER_FIELDS,
        trail,
        body ? 'An `in: body` parameter' : 'A parameter',
      );
    }
    this.parsedParameters.set(value, parsed);
    return parsed ?? undefined;
  }

  private splitParameters(parameters: readonly ListedParameter[]): {
    bodies: ParsedParameter[];
    forms: ParsedParameter[];
    others: ListedParameter[];
  } {
    const split = { bodies: [] as ParsedParameter[], forms: [] as ParsedParameter[], others: [] as ListedParameter[] };
    for (const listed of parameters) {
      if (listed.parameter.in === 'body') split.bodies.push(listed.parameter);
      else if (listed.parameter.in === 'formData') split.forms.push(listed.parameter);
      else split.others.push(listed);
    }
    return split;
  }

  /**
   * `inherited` with `forms` merged in by name: a form parameter replaces an
   * inherited one of the same name (an override), and the last of two in
   * `forms` sharing a name wins (`SWAGGER_DUPLICATE_FORM_DATA_PARAMETER`).
   */
  private mergeForms(
    inherited: ReadonlyMap<string, ParsedParameter>,
    forms: readonly ParsedParameter[],
  ): Map<string, ParsedParameter> {
    const merged = new Map(inherited);
    const seen = new Set<string>();
    for (const form of forms) {
      if (seen.has(form.name)) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_DUPLICATE_FORM_DATA_PARAMETER,
          `Two \`in: formData\` parameters are named ${describeValue(form.name)}; the last one is used`,
          form.trail,
        );
      }
      seen.add(form.name);
      merged.set(form.name, form);
    }
    return merged;
  }

  /** A non-body parameter as an OpenAPI 3.0 Parameter Object, memoised by source. */
  private parameter(parameter: ParsedParameter): SpecRecord {
    const known = this.convertedParameters.get(parameter.source);
    if (known !== undefined) return known;
    const source = parameter.source;
    const out: SpecRecord = {};
    if (parameter.convertedName !== undefined) out['name'] = parameter.convertedName;
    out['in'] = parameter.in;
    copyField(source, out, 'description');
    copyField(source, out, 'required');
    if (parameter.in === 'path' && ownProperty(source, 'required') !== true) {
      // OpenAPI 3.0 (and 2.0) require `required: true` of a path parameter: its value is part of the path
      this.invalid(
        `A path parameter must be required (\`required: true\`), found ${describeValue(ownProperty(source, 'required'))}; it is converted as required`,
        childTrail(parameter.trail, 'required'),
      );
      out['required'] = true;
    }
    copyField(source, out, 'allowEmptyValue');
    const example = exampleOf(source);
    if (example !== undefined) out['example'] = example;
    if (ownProperty(source, 'type') === 'array') {
      const style = this.parameterStyle(parameter);
      if (style !== undefined) {
        out['style'] = style.style;
        out['explode'] = style.explode;
      }
    }
    if (ownProperty(source, 'type') === 'file') this.reportFile(parameter.trail);
    out['schema'] = this.simpleSchema(source, parameter.trail);
    copyExtensions(source, out);
    this.convertedParameters.set(source, out);
    return out;
  }

  /**
   * `style` and `explode` for an array parameter's `collectionFormat`
   * (default `csv`), always stated, even where they are the OpenAPI 3.0
   * default for the location:
   *
   * | location | csv | ssv | pipes | multi | tsv, other |
   * | --- | --- | --- | --- | --- | --- |
   * | query | form, false | spaceDelimited, false | pipeDelimited, false | form, true | form, false + diagnostic |
   * | path, header | simple, false | simple, false + diagnostic | same | same | same |
   * | cookie (not 2.0) | form, false | form, false + diagnostic | same | same | same |
   * | another location | none | none + diagnostic | same | same | same |
   */
  private parameterStyle(parameter: ParsedParameter): { style: string; explode: boolean } | undefined {
    const declared = ownProperty(parameter.source, 'collectionFormat');
    const format = declared ?? 'csv';
    const trail = childTrail(parameter.trail, 'collectionFormat');
    const unsupported = (fallback: string): void =>
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT,
        `\`collectionFormat: ${formatText(format)}\` has no OpenAPI 3.0 equivalent for an \`in: ${locationText(parameter.in)}\` parameter; ${fallback}`,
        trail,
      );
    switch (parameter.in) {
      case 'query':
        if (format === 'multi') return { style: 'form', explode: true };
        if (format === 'ssv') return { style: 'spaceDelimited', explode: false };
        if (format === 'pipes') return { style: 'pipeDelimited', explode: false };
        if (format !== 'csv')
          unsupported('the array is sent as comma-separated values (`style: form`, `explode: false`)');
        return { style: 'form', explode: false };
      case 'path':
      case 'header':
        if (format !== 'csv') unsupported('the array is sent as comma-separated values (`style: simple`)');
        return { style: 'simple', explode: false };
      case 'cookie':
        if (format !== 'csv')
          unsupported('the array is sent as comma-separated values (`style: form`, `explode: false`)');
        return { style: 'form', explode: false };
      default:
        if (declared !== undefined) unsupported('no serialization style is set');
        return undefined;
    }
  }

  /**
   * The schema of a non-body parameter or a Header Object: `type` (`file` as
   * a binary string), `format`, `items` and the validation keywords. Their
   * `x-` extensions stay on the parameter or header (an Items Object's go to
   * its schema, in `itemsSchema`).
   */
  private simpleSchema(source: SpecRecord, trail: Trail): SpecRecord {
    const schema: SpecRecord = {};
    this.simpleSchemaFields(schema, source, trail);
    const items = ownProperty(source, 'items');
    if (items !== undefined) {
      if (isSpecObject(items)) {
        schema['items'] = this.itemsSchema(items, childTrail(trail, 'items'));
      } else {
        this.invalid(
          `\`items\` must be an Items Object, found ${describeValue(items)}; it is ignored`,
          childTrail(trail, 'items'),
        );
      }
    }
    this.simpleSchemaKeywords(schema, source);
    return schema;
  }

  /** `type` and `format`, a file as a binary string. */
  private simpleSchemaFields(schema: SpecRecord, source: SpecRecord, trail: Trail): void {
    const type = ownProperty(source, 'type');
    if (type !== 'file') {
      copyField(source, schema, 'type');
      copyField(source, schema, 'format');
      return;
    }
    schema['type'] = 'string';
    schema['format'] = 'binary';
    const format = ownProperty(source, 'format');
    if (format !== undefined && format !== 'binary') {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
        `\`type: file\` becomes a binary string, so \`format: ${describeValue(format)}\` is replaced by \`binary\``,
        childTrail(trail, 'format'),
      );
    }
  }

  private simpleSchemaKeywords(schema: SpecRecord, source: SpecRecord): void {
    for (const keyword of SIMPLE_SCHEMA_KEYWORDS) copyField(source, schema, keyword);
  }

  /**
   * An Items Object chain (`items.items...`) as schemas, memoised by object.
   * A loop, not recursion, with a seen set: a chain that comes back to itself
   * (possible after dereferencing) becomes a cyclic schema, as dereferenced
   * cyclic schemas are.
   */
  private itemsSchema(start: SpecRecord, trail: Trail): SpecRecord {
    const known = this.itemsSchemas.get(start);
    if (known !== undefined) return known;
    const chain: Array<{ node: SpecRecord; trail: Trail; next: SpecRecord | undefined }> = [];
    const onChain = new Set<object>();
    let node: SpecRecord | undefined = start;
    let nodeTrail = anchorTrail(trail);
    while (node !== undefined && !this.itemsSchemas.has(node) && !onChain.has(node)) {
      onChain.add(node);
      const next = ownProperty(node, 'items');
      const nextTrail = childTrail(nodeTrail, 'items');
      if (next !== undefined && !isSpecObject(next)) {
        this.invalid(`\`items\` must be an Items Object, found ${describeValue(next)}; it is ignored`, nextTrail);
      }
      const nextNode = isSpecObject(next) ? next : undefined;
      chain.push({ node, trail: nodeTrail, next: nextNode });
      node = nextNode;
      nodeTrail = nextTrail;
    }
    for (const link of chain) this.itemsSchemas.set(link.node, {});
    for (const link of chain) {
      const schema = this.itemsSchemas.get(link.node) as SpecRecord;
      this.reportUnknownFields(link.node, ITEMS_FIELDS, link.trail, 'An Items Object');
      this.simpleSchemaFields(schema, link.node, link.trail);
      if (ownProperty(link.node, 'type') === 'file') this.reportFile(link.trail);
      if (link.next !== undefined) schema['items'] = this.itemsSchemas.get(link.next);
      this.simpleSchemaKeywords(schema, link.node);
      copyExtensions(link.node, schema);
      // `csv` is the default: stated on a nested array it says nothing a style could lose
      const format = ownProperty(link.node, 'collectionFormat');
      if (format !== undefined && format !== 'csv' && ownProperty(link.node, 'type') === 'array') {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT,
          `\`collectionFormat: ${formatText(format)}\` of a nested array has no OpenAPI 3.0 equivalent (a style applies to the outer array only); it is ignored`,
          childTrail(link.trail, 'collectionFormat'),
        );
      }
    }
    return this.itemsSchemas.get(start) as SpecRecord;
  }

  private reportFile(trail: Trail): void {
    this.report(
      'warning',
      SPEC_DIAGNOSTIC_CODES.SWAGGER_FILE_OUTSIDE_FORM_DATA,
      '`type: file` is only allowed for an `in: formData` parameter (and a response schema); it is converted to a binary string anyway',
      childTrail(trail, 'type'),
    );
  }

  // -- Request bodies -------------------------------------------------------

  /**
   * The request body of an operation from the path-level and operation-level
   * body and form parameters:
   *
   * - one body parameter: it is the body (an operation-level one replaces a
   *   path-level one, which is an override when they share a name);
   * - several: the last one (operation level first) is the body
   *   (`SWAGGER_MULTIPLE_BODY_PARAMETERS`);
   * - body and form parameters: the body parameter is the body
   *   (`SWAGGER_BODY_AND_FORM_DATA`);
   * - form parameters only: an object schema of them.
   */
  private requestBody(
    pathBodies: readonly ParsedParameter[],
    operationBodies: readonly ParsedParameter[],
    forms: ReadonlyMap<string, ParsedParameter>,
    consumes: MediaTypes,
    trail: Trail,
  ): SpecRecord | undefined {
    const candidates = operationBodies.length > 0 ? operationBodies : pathBodies;
    const body = candidates[candidates.length - 1];
    if (body !== undefined) {
      const replaced = operationBodies.length > 0 ? pathBodies.filter((other) => other.name !== body.name) : [];
      // Where the validator reports the same finding: the operation's parameters
      const at = childTrail(trail, 'parameters');
      if (candidates.length > 1 || replaced.length > 0) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_MULTIPLE_BODY_PARAMETERS,
          `The operation has ${candidates.length + replaced.length} \`in: body\` parameters, but a request has one body; ${describeValue(body.name)} is used`,
          at,
        );
      }
      if (forms.size > 0) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_BODY_AND_FORM_DATA,
          `The operation has both an \`in: body\` parameter and ${forms.size} \`in: formData\` parameter${forms.size === 1 ? '' : 's'}, which cannot be sent together; the body parameter ${describeValue(body.name)} is used and the form parameters are ignored`,
          at,
        );
      }
      return this.body(body, consumes, trail);
    }
    return forms.size > 0 ? this.formBody([...forms.values()], consumes, trail) : undefined;
  }

  /** A body parameter as a Request Body Object for `consumes`, memoised by (parameter, list). */
  private body(parameter: ParsedParameter, consumes: MediaTypes, trail: Trail): SpecRecord {
    let byList = this.bodies.get(parameter.source);
    const known = byList?.get(consumes.key);
    if (known !== undefined) return known;
    this.noteAssumed(consumes, trail);
    const schema = this.bodySchema(parameter);
    this.charge(consumes.types.length);
    const content: SpecRecord = {};
    for (const mediaType of consumes.types) setEntry(content, mediaType, { schema });
    const out: SpecRecord = {};
    copyField(parameter.source, out, 'description');
    out['content'] = content;
    copyField(parameter.source, out, 'required');
    copyExtensions(parameter.source, out);
    if (byList === undefined) {
      byList = new Map();
      this.bodies.set(parameter.source, byList);
    }
    byList.set(consumes.key, out);
    return out;
  }

  private bodySchema(parameter: ParsedParameter): unknown {
    if (this.bodySchemas.has(parameter.source)) return this.bodySchemas.get(parameter.source);
    const value = ownProperty(parameter.source, 'schema');
    let schema: unknown;
    if (isSpecObject(value)) {
      schema = this.schemas.rewrite(value, childTrail(parameter.trail, 'schema'));
    } else {
      this.invalid(
        `An \`in: body\` parameter needs a Schema Object in \`schema\`, found ${describeValue(value)}; any body is accepted (\`{}\`)`,
        childTrail(parameter.trail, 'schema'),
      );
      schema = {};
    }
    this.bodySchemas.set(parameter.source, schema);
    return schema;
  }

  /**
   * Form parameters as a Request Body Object: one object schema (a property
   * per parameter, `required` from theirs) under each form media type, and
   * one `encoding` map shared by them, with an entry (`style`, `explode`) for
   * each array, from its `collectionFormat` (`multi`: `form` exploded, one
   * value or part per item; `csv`, the default: `form`; `ssv`:
   * `spaceDelimited`; `pipes`: `pipeDelimited`; `tsv` has no style:
   * `form`, with a diagnostic). OpenAPI 3.0 applies `style` and `explode` to
   * an application/x-www-form-urlencoded body only, 3.2 to multipart as well;
   * the 3.0 schema allows them in any Encoding Object, and `buildHttpRequest`
   * honours them in both.
   */
  private formBody(fields: readonly ParsedParameter[], consumes: MediaTypes, trail: Trail): SpecRecord {
    const converted = fields.map((field) => this.formField(field));
    const mediaTypes = this.formMediaTypeList(
      consumes,
      converted.some((field) => field.file),
      trail,
    );
    this.charge(fields.length);
    const properties: SpecRecord = {};
    const required: string[] = [];
    fields.forEach((field, index) => {
      setEntry(properties, field.name, converted[index].schema);
      if (converted[index].required) required.push(field.name);
    });
    const schema: SpecRecord = { type: 'object', properties };
    if (required.length > 0) schema['required'] = required;

    // One `encoding` map (an Encoding Object per array field, from its `collectionFormat`), shared by
    // every media type of the form: multipart as well as urlencoded
    const encodings = fields.flatMap((field, index) => {
      const fieldEncoding = converted[index].encoding;
      return fieldEncoding === undefined ? [] : [[field.name, fieldEncoding] as const];
    });
    this.charge(encodings.length);
    let encoding: SpecRecord | undefined;
    if (encodings.length > 0) {
      encoding = {};
      for (const [name, fieldEncoding] of encodings) setEntry(encoding, name, { ...fieldEncoding });
    }
    this.charge(mediaTypes.length);
    const content: SpecRecord = {};
    for (const mediaType of mediaTypes) {
      const media: SpecRecord = { schema };
      if (encoding !== undefined) media['encoding'] = encoding;
      setEntry(content, mediaType.type, media);
    }
    const out: SpecRecord = { content };
    if (required.length > 0) out['required'] = true;
    return out;
  }

  /** A form parameter as a property schema, memoised by source. */
  private formField(field: ParsedParameter): FormField {
    const known = this.formFields.get(field.source);
    if (known !== undefined) return known;
    const source = field.source;
    const schema = this.simpleSchema(source, field.trail);
    copyField(source, schema, 'description');
    const example = exampleOf(source);
    if (example !== undefined) schema['example'] = example;
    copyExtensions(source, schema);
    if (ownProperty(source, 'allowEmptyValue') === true) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
        'OpenAPI 3.0 has no `allowEmptyValue` for a request body property; it is dropped',
        childTrail(field.trail, 'allowEmptyValue'),
      );
    }
    let encoding: FormField['encoding'];
    if (ownProperty(source, 'type') === 'array') {
      const format = ownProperty(source, 'collectionFormat') ?? 'csv';
      if (format === 'csv') encoding = { style: 'form', explode: false };
      else if (format === 'ssv') encoding = { style: 'spaceDelimited', explode: false };
      else if (format === 'pipes') encoding = { style: 'pipeDelimited', explode: false };
      else if (format === 'multi') encoding = { style: 'form', explode: true };
      else {
        encoding = { style: 'form', explode: false };
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT,
          `\`collectionFormat: ${formatText(format)}\` has no OpenAPI 3.0 equivalent; the array is sent as comma-separated values (\`style: form\`, \`explode: false\`)`,
          childTrail(field.trail, 'collectionFormat'),
        );
      }
    }
    const converted: FormField = {
      schema,
      required: ownProperty(source, 'required') === true,
      file: ownProperty(source, 'type') === 'file',
      encoding,
    };
    this.formFields.set(source, converted);
    return converted;
  }

  /**
   * The media types of a form body: the form media types of a declared
   * `consumes` (`application/x-www-form-urlencoded`, `multipart/form-data`,
   * with any parameters), only its multipart ones when a parameter is a file
   * (an application/x-www-form-urlencoded body cannot carry a file's bytes);
   * without a declared list, `multipart/form-data` when a parameter is a file
   * and `application/x-www-form-urlencoded` otherwise; the same, with
   * `SWAGGER_FORM_MEDIA_TYPE_ADDED`, when the declared list names no form
   * media type, or no multipart one for a file. Memoised by (list, file).
   */
  private formMediaTypeList(consumes: MediaTypes, file: boolean, trail: Trail): readonly FormMediaType[] {
    let byFile = this.formMediaTypes.get(consumes.key);
    const known = byFile?.get(file);
    if (known !== undefined) return known;
    const fallback: FormMediaType = file
      ? { type: MULTIPART_MEDIA_TYPE, urlencoded: false }
      : { type: URLENCODED_MEDIA_TYPE, urlencoded: true };
    let list: FormMediaType[] = [];
    if (consumes.declared) {
      consumes.types.forEach((type, index) => {
        const essence = consumes.essences[index];
        if (essence === URLENCODED_MEDIA_TYPE || essence === MULTIPART_MEDIA_TYPE) {
          list.push({ type, urlencoded: essence === URLENCODED_MEDIA_TYPE });
        }
      });
      if (list.length === 0) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_FORM_MEDIA_TYPE_ADDED,
          `The operation has \`in: formData\` parameters, but its \`consumes\` names neither ${URLENCODED_MEDIA_TYPE} nor ${MULTIPART_MEDIA_TYPE}; the form body is ${fallback.type}`,
          trail,
        );
      } else if (file) {
        // A file's bytes travel only in a multipart part: the multipart media types alone
        const multipart = list.filter((mediaType) => !mediaType.urlencoded);
        if (multipart.length === 0) {
          this.report(
            'warning',
            SPEC_DIAGNOSTIC_CODES.SWAGGER_FORM_MEDIA_TYPE_ADDED,
            `The operation has a \`type: file\` parameter, which ${URLENCODED_MEDIA_TYPE} cannot carry, and its \`consumes\` names no ${MULTIPART_MEDIA_TYPE}; the form body is ${MULTIPART_MEDIA_TYPE}`,
            trail,
          );
        }
        list = multipart;
      }
    }
    if (list.length === 0) list = [fallback];
    if (byFile === undefined) {
      byFile = new Map();
      this.formMediaTypes.set(consumes.key, byFile);
    }
    byFile.set(file, list);
    return list;
  }

  // -- Responses ------------------------------------------------------------

  private responsesObject(value: unknown, produces: MediaTypes, trail: Trail): SpecRecord {
    const out: SpecRecord = {};
    if (value === undefined) return out;
    if (!isSpecObject(value)) {
      this.invalid(`\`responses\` must be an object, found ${describeValue(value)}; no response is converted`, trail);
      return out;
    }
    for (const key of Object.keys(value)) {
      const response = value[key];
      if (response === undefined) continue;
      if (key.startsWith('x-')) {
        setEntry(out, key, response);
        continue;
      }
      const converted = this.response(response, produces, childTrail(trail, key));
      if (converted !== undefined) setEntry(out, key, converted);
    }
    return out;
  }

  /** A Response Object for `produces`, memoised by (response, list); `undefined` when it cannot be converted. */
  private response(value: unknown, produces: MediaTypes, trail: Trail): SpecRecord | undefined {
    if (!isSpecObject(value)) {
      this.invalid(`A response must be an object, found ${describeValue(value)}; it is ignored`, trail);
      return undefined;
    }
    const parts = this.responsePartsOf(value, trail);
    if (parts === undefined) return undefined;
    let byList = this.responses.get(value);
    const known = byList?.get(produces.key);
    if (known !== undefined) return known;

    // A media type entry for each `produces` value, when the response has a body or examples
    if (parts.schema !== undefined || parts.examples !== undefined) this.charge(produces.types.length);
    const content: SpecRecord = {};
    const used = new Set<string>();
    produces.types.forEach((mediaType, index) => {
      const exampleKey =
        parts.examples !== undefined && Object.hasOwn(parts.examples, mediaType)
          ? mediaType
          : parts.exampleKeys.get(produces.essences[index]);
      const media: SpecRecord = {};
      if (parts.schema !== undefined) media['schema'] = parts.schema;
      if (exampleKey !== undefined) {
        used.add(exampleKey);
        media['example'] = (parts.examples as SpecRecord)[exampleKey];
      }
      if (Object.keys(media).length > 0) setEntry(content, mediaType, media);
    });
    if (Object.keys(content).length > 0) this.noteAssumed(produces, trail);
    if (parts.examples !== undefined) this.reportUnusedExamples(parts.examples, used, produces, trail);

    const out: SpecRecord = {};
    if (parts.description !== undefined) out['description'] = parts.description;
    if (parts.headers !== undefined) out['headers'] = parts.headers;
    if (Object.keys(content).length > 0) out['content'] = content;
    Object.assign(out, parts.extensions);
    if (byList === undefined) {
      byList = new Map();
      this.responses.set(value, byList);
    }
    byList.set(produces.key, out);
    return out;
  }

  private reportUnusedExamples(
    examples: SpecRecord,
    used: ReadonlySet<string>,
    produces: MediaTypes,
    trail: Trail,
  ): void {
    const names: string[] = [];
    let total = 0;
    for (const key of Object.keys(examples)) {
      if (used.has(key) || examples[key] === undefined) continue;
      total++;
      if (names.length < LISTED_NAMES) names.push(key);
    }
    if (total === 0) return;
    this.report(
      'warning',
      SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
      `${total === 1 ? 'The example' : `${total} examples`} for ${listNames(names, total)} ${total === 1 ? 'names' : 'name'} no media type the operation ${produces.declared ? 'produces' : 'produces (none is declared, so application/json is assumed)'}; ${total === 1 ? 'it is' : 'they are'} not converted`,
      childTrail(trail, 'examples'),
    );
  }

  /** What a response is regardless of `produces`, memoised by response; `undefined` when it cannot be converted. */
  private responsePartsOf(value: SpecRecord, trail: Trail): ResponseParts | undefined {
    const known = this.responseParts.get(value);
    if (known !== undefined) return known ?? undefined;
    if (ownProperty(value, '$ref') !== undefined) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_UNRESOLVED_REFERENCE,
        'A response `$ref` is left unresolved (the converter expects a dereferenced document); the response is ignored',
        trail,
      );
      this.responseParts.set(value, null);
      return undefined;
    }
    this.reportUnknownFields(value, RESPONSE_FIELDS, trail, 'A Response Object');

    const schemaValue = ownProperty(value, 'schema');
    let schema: unknown;
    if (isSpecObject(schemaValue)) {
      schema = this.schemas.rewrite(schemaValue, childTrail(trail, 'schema'));
    } else if (schemaValue !== undefined) {
      this.invalid(
        `A response \`schema\` must be a Schema Object, found ${describeValue(schemaValue)}; the response is converted without a body`,
        childTrail(trail, 'schema'),
      );
    }

    const examplesValue = ownProperty(value, 'examples');
    let examples: SpecRecord | undefined;
    const exampleKeys = new Map<string, string>();
    if (isSpecObject(examplesValue)) {
      examples = examplesValue;
      for (const key of Object.keys(examplesValue)) {
        const essence = mediaTypeEssence(key);
        if (!exampleKeys.has(essence)) exampleKeys.set(essence, key);
      }
    } else if (examplesValue !== undefined) {
      this.invalid(
        `\`examples\` must map media types to examples, found ${describeValue(examplesValue)}; it is ignored`,
        childTrail(trail, 'examples'),
      );
    }

    const headersValue = ownProperty(value, 'headers');
    let headers: SpecRecord | undefined;
    if (isSpecObject(headersValue)) {
      headers = {};
      const headersTrail = childTrail(trail, 'headers');
      this.charge(Object.keys(headersValue).length);
      for (const name of Object.keys(headersValue)) {
        const header = headersValue[name];
        if (header === undefined) continue;
        const converted = this.header(header, childTrail(headersTrail, name));
        if (converted !== undefined) setEntry(headers, name, converted);
      }
    } else if (headersValue !== undefined) {
      this.invalid(
        `\`headers\` must be an object, found ${describeValue(headersValue)}; it is ignored`,
        childTrail(trail, 'headers'),
      );
    }

    const extensions: SpecRecord = {};
    copyExtensions(value, extensions);
    const parts: ResponseParts = {
      description: ownProperty(value, 'description'),
      headers,
      schema,
      examples,
      exampleKeys,
      extensions,
    };
    this.responseParts.set(value, parts);
    return parts;
  }

  /** A response Header Object as an OpenAPI 3.0 Header Object, memoised by source. */
  private header(value: unknown, trail: Trail): SpecRecord | undefined {
    if (!isSpecObject(value)) {
      this.invalid(`A header must be an object, found ${describeValue(value)}; it is ignored`, trail);
      return undefined;
    }
    const known = this.headers.get(value);
    if (known !== undefined) return known ?? undefined;
    if (ownProperty(value, '$ref') !== undefined) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_UNRESOLVED_REFERENCE,
        'A header `$ref` is left unresolved (the converter expects a dereferenced document); the header is ignored',
        trail,
      );
      this.headers.set(value, null);
      return undefined;
    }
    this.reportUnknownFields(value, HEADER_FIELDS, trail, 'A Header Object');
    const out: SpecRecord = {};
    copyField(value, out, 'description');
    const format = ownProperty(value, 'collectionFormat');
    if (ownProperty(value, 'type') === 'array' && format !== undefined && format !== 'csv') {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT,
        `\`collectionFormat: ${formatText(format)}\` has no OpenAPI 3.0 equivalent for a header; the array is read as comma-separated values (\`style: simple\`)`,
        childTrail(trail, 'collectionFormat'),
      );
    }
    if (ownProperty(value, 'type') === 'file') this.reportFile(trail);
    out['schema'] = this.simpleSchema(value, trail);
    copyExtensions(value, out);
    this.headers.set(value, out);
    return out;
  }

  // -- Security -------------------------------------------------------------

  /**
   * A Security Scheme Object: `basic` becomes `http` with `scheme: basic`,
   * `apiKey` keeps `name` and `in`, and `oauth2` gets `flows` with one flow
   * (`application` is `clientCredentials`, `accessCode` is
   * `authorizationCode`) holding the URLs that flow uses and `scopes`.
   * `undefined` for an unknown `type` or `flow`.
   */
  private securityScheme(value: unknown, trail: Trail): SpecRecord | undefined {
    if (!isSpecObject(value)) {
      this.invalid(`A security scheme must be an object, found ${describeValue(value)}; it is ignored`, trail);
      return undefined;
    }
    if (ownProperty(value, '$ref') !== undefined) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_UNRESOLVED_REFERENCE,
        'A security scheme `$ref` is left unresolved (the converter expects a dereferenced document); the scheme is ignored',
        trail,
      );
      return undefined;
    }
    this.reportUnknownFields(value, SECURITY_SCHEME_FIELDS, trail, 'A Security Scheme Object');
    const type = ownProperty(value, 'type');
    const out: SpecRecord = {};
    let applicable: readonly string[];
    if (type === 'basic') {
      Object.assign(out, { type: 'http', scheme: 'basic' });
      applicable = ['type', 'description'];
    } else if (type === 'apiKey') {
      out['type'] = 'apiKey';
      copyField(value, out, 'name');
      copyField(value, out, 'in');
      applicable = ['type', 'description', 'name', 'in'];
    } else if (type === 'oauth2') {
      const flowName = ownProperty(value, 'flow');
      const flow = typeof flowName === 'string' ? OAUTH2_FLOWS.get(flowName) : undefined;
      if (flow === undefined) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_UNSUPPORTED_SECURITY_SCHEME,
          `An oauth2 security scheme needs \`flow\` "implicit", "password", "application" or "accessCode", found ${describeValue(flowName)}; the scheme is not converted`,
          childTrail(trail, 'flow'),
        );
        return undefined;
      }
      const flowObject: SpecRecord = {};
      for (const url of flow.urls) copyField(value, flowObject, url);
      const scopes = ownProperty(value, 'scopes');
      if (isSpecObject(scopes)) {
        flowObject['scopes'] = scopes;
      } else {
        if (scopes !== undefined) {
          this.invalid(
            `\`scopes\` must map scope names to descriptions, found ${describeValue(scopes)}; no scope is converted`,
            childTrail(trail, 'scopes'),
          );
        }
        flowObject['scopes'] = {};
      }
      out['type'] = 'oauth2';
      out['flows'] = { [flow.name]: flowObject };
      applicable = ['type', 'description', 'flow', 'scopes', ...flow.urls];
    } else {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_UNSUPPORTED_SECURITY_SCHEME,
        `A security scheme needs \`type\` "basic", "apiKey" or "oauth2", found ${describeValue(type)}; the scheme is not converted`,
        childTrail(trail, 'type'),
      );
      return undefined;
    }
    copyField(value, out, 'description');
    const inapplicable = [...SECURITY_SCHEME_FIELDS].filter(
      (field) => !applicable.includes(field) && ownProperty(value, field) !== undefined,
    );
    if (inapplicable.length > 0) {
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
        `${listNames(inapplicable, inapplicable.length)} ${inapplicable.length === 1 ? 'does' : 'do'} not apply to this security scheme (type ${describeValue(type)}${type === 'oauth2' ? `, flow ${describeValue(ownProperty(value, 'flow'))}` : ''}); not converted`,
        trail,
      );
    }
    copyExtensions(value, out);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

type Reporter = (severity: SpecDiagnosticSeverity, code: string, message: string, trail: Trail) => void;

/** A schema found in the current batch. */
interface SchemaNode {
  readonly trail: Trail;
  /** The schemas of the batch holding this one. */
  readonly parents: SpecRecord[];
  /** Whether this schema, or one it leads to, changes (so it is replaced by a new object). */
  dirty: boolean;
}

/**
 * Rewrites the Schema Object constructs of Swagger 2.0 that OpenAPI 3.0
 * expresses differently, copying only what must change.
 *
 * Changed in a schema (the schema is replaced by a new object):
 *
 * - `discriminator: "petType"` becomes `discriminator: { propertyName: "petType" }`;
 * - `type: file` becomes `type: string, format: binary`;
 * - `x-nullable: <boolean>` becomes `nullable`, unless the schema has `nullable`;
 * - a `type` list becomes one `type` (`"null"` as `nullable: true`) or, for
 *   several types, `anyOf` one schema per type (in `allOf` when the schema
 *   already has `anyOf`); `type: "null"` alone, or a list of nothing else,
 *   has no OpenAPI 3.0 form and is dropped (`SWAGGER_NOT_CONVERTED`);
 * - a tuple `items` (a list) becomes `items: {}` (`SWAGGER_NOT_CONVERTED`);
 * - `additionalItems` is dropped (`SWAGGER_NOT_CONVERTED`), with a tuple or
 *   alone: OpenAPI 3.0 does not define the keyword. Draft-04 reads it only
 *   beside a tuple `items`, which the line above replaces by `items: {}`:
 *   the limit it set on extra items is lost with the tuple (both reported),
 *   and without a tuple it constrained nothing (the official 2.0 schema does not list it either;
 *   the other draft-04 keywords neither version lists, `patternProperties`,
 *   `const`, ..., stay, as generated tools use them);
 * - `$ref: "#/definitions/X"` becomes `$ref: "#/components/schemas/X"`.
 *
 * A schema that leads to a changed one (through `properties`,
 * `additionalProperties`, `items`, `allOf`, `anyOf`, `oneOf` or `not`) is
 * replaced too, so the new graph has the same shape, sharing and cycles as
 * the old one. Every other schema is returned as is.
 *
 * Each schema is processed once, whichever root it is reached from: a batch
 * walks the schemas a root leads to that no earlier batch saw (explicit
 * stack), marks the changed ones and, through parent links, those leading to
 * them, then creates every replacement before filling any, so cycles close.
 */
class SchemaRewriter {
  /** Each processed schema to its result: itself, or its replacement. */
  private readonly results = new Map<object, SpecRecord>();

  constructor(private readonly report: Reporter) {}

  rewrite(root: SpecRecord, trail: Trail): SpecRecord {
    const known = this.results.get(root);
    if (known !== undefined) return known;
    const batch = new Map<object, SchemaNode>([[root, { trail: anchorTrail(trail), parents: [], dirty: false }]]);
    const order: SpecRecord[] = [];
    const stack: SpecRecord[] = [root];
    while (stack.length > 0) {
      const schema = stack.pop() as SpecRecord;
      const node = batch.get(schema) as SchemaNode;
      order.push(schema);
      if (this.changes(schema, node.trail)) node.dirty = true;
      this.forEachSubschema(schema, node.trail, (child, childTrail) => {
        const result = this.results.get(child);
        if (result !== undefined) {
          if (result !== child) node.dirty = true;
          return;
        }
        let childNode = batch.get(child);
        if (childNode === undefined) {
          childNode = { trail: childTrail(), parents: [], dirty: false };
          batch.set(child, childNode);
          stack.push(child);
        }
        childNode.parents.push(schema);
      });
    }
    const queue = order.filter((schema) => (batch.get(schema) as SchemaNode).dirty);
    while (queue.length > 0) {
      for (const parent of (batch.get(queue.pop() as SpecRecord) as SchemaNode).parents) {
        const parentNode = batch.get(parent) as SchemaNode;
        if (parentNode.dirty) continue;
        parentNode.dirty = true;
        queue.push(parent);
      }
    }
    for (const schema of order) this.results.set(schema, (batch.get(schema) as SchemaNode).dirty ? {} : schema);
    for (const schema of order) {
      const result = this.results.get(schema) as SpecRecord;
      if (result !== schema) this.fill(result, schema);
    }
    return this.results.get(root) as SpecRecord;
  }

  /** Calls `visit` for each object subschema, with a lazily built trail. */
  private forEachSubschema(
    schema: SpecRecord,
    trail: Trail,
    visit: (child: SpecRecord, childTrail: () => Trail) => void,
  ): void {
    for (const keyword of ['items', 'not', 'additionalProperties']) {
      const child = ownProperty(schema, keyword);
      if (isSpecObject(child)) visit(child, () => childTrail(trail, keyword));
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      const list = ownProperty(schema, keyword);
      if (!Array.isArray(list)) continue;
      for (let index = 0; index < list.length; index++) {
        const child: unknown = list[index];
        if (isSpecObject(child)) visit(child, () => childTrail(childTrail(trail, keyword), index));
      }
    }
    const properties = ownProperty(schema, 'properties');
    if (isSpecObject(properties)) {
      for (const name of Object.keys(properties)) {
        const child = properties[name];
        if (isSpecObject(child)) visit(child, () => childTrail(childTrail(trail, 'properties'), name));
      }
    }
  }

  /** Whether `schema` itself changes; reports what it cannot convert exactly. */
  private changes(schema: SpecRecord, trail: Trail): boolean {
    let changes = false;
    const type = ownProperty(schema, 'type');
    if (typeof ownProperty(schema, 'discriminator') === 'string') changes = true;
    if (typeof ownProperty(schema, 'x-nullable') === 'boolean' && ownProperty(schema, 'nullable') === undefined) {
      changes = true;
    }
    if (type === 'file') {
      changes = true;
      const format = ownProperty(schema, 'format');
      if (format !== undefined && format !== 'binary') {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
          `\`type: file\` becomes a binary string, so \`format: ${describeValue(format)}\` is replaced by \`binary\``,
          childTrail(trail, 'format'),
        );
      }
    }
    const types = Array.isArray(type) ? type : type === 'null' ? [type] : undefined;
    if (types !== undefined) {
      changes = true;
      const names = types.filter((entry): entry is string => typeof entry === 'string');
      if (names.length !== types.length) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_INVALID_VALUE,
          '`type` lists values that are not type names; they are ignored',
          childTrail(trail, 'type'),
        );
      }
      if (!names.some((name) => name !== 'null')) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
          '`type` names no type but `null`, which OpenAPI 3.0 cannot express on its own; the type is dropped',
          childTrail(trail, 'type'),
        );
      }
    }
    if (Array.isArray(ownProperty(schema, 'items'))) {
      changes = true;
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
        '`items` lists one schema per position (a tuple), which OpenAPI 3.0 cannot express; any item is accepted (`items: {}`)',
        childTrail(trail, 'items'),
      );
    }
    // OpenAPI 3.0 has no `additionalItems`. Draft-04 reads it only beside a tuple `items` (replaced above by `items: {}`,
    // so its limit on extra items goes with the tuple); without a tuple it constrained nothing
    if (ownProperty(schema, 'additionalItems') !== undefined) {
      changes = true;
      this.report(
        'warning',
        SPEC_DIAGNOSTIC_CODES.SWAGGER_NOT_CONVERTED,
        '`additionalItems` is not an OpenAPI 3.0 keyword, and it constrains nothing once `items` is not a tuple; it is dropped',
        childTrail(trail, 'additionalItems'),
      );
    }
    const ref = ownProperty(schema, '$ref');
    if (typeof ref === 'string') {
      if (ref.startsWith(DEFINITIONS_PREFIX)) {
        changes = true;
      } else if (ref.startsWith('#')) {
        this.report(
          'warning',
          SPEC_DIAGNOSTIC_CODES.SWAGGER_UNRESOLVED_REFERENCE,
          `A schema \`$ref\` to ${describeValue(ref)} is left unresolved and points outside \`definitions\`, which has no OpenAPI 3.0 location; it is kept as is`,
          childTrail(trail, '$ref'),
        );
      }
    }
    return changes;
  }

  /**
   * Fills `target` with `schema`'s fields, changed as described on the class.
   * Every object in a subschema slot was walked, so it has a result.
   */
  private fill(target: SpecRecord, schema: SpecRecord): void {
    const result = (value: unknown): unknown => (isSpecObject(value) ? this.results.get(value) : value);
    const type = ownProperty(schema, 'type');
    const xNullable = ownProperty(schema, 'x-nullable');
    const convertsNullable = typeof xNullable === 'boolean' && ownProperty(schema, 'nullable') === undefined;
    for (const key of Object.keys(schema)) {
      const value = schema[key];
      switch (key) {
        case 'items':
          setEntry(target, key, Array.isArray(value) ? {} : result(value));
          break;
        case 'allOf':
        case 'anyOf':
        case 'oneOf':
          setEntry(target, key, Array.isArray(value) ? value.map(result) : value);
          break;
        case 'not':
        case 'additionalProperties':
          setEntry(target, key, result(value));
          break;
        case 'properties':
          if (isSpecObject(value)) {
            const properties: SpecRecord = {};
            for (const name of Object.keys(value)) setEntry(properties, name, result(value[name]));
            setEntry(target, key, properties);
          } else {
            setEntry(target, key, value);
          }
          break;
        case 'discriminator':
          setEntry(target, key, typeof value === 'string' ? { propertyName: value } : value);
          break;
        case '$ref':
          setEntry(
            target,
            key,
            typeof value === 'string' && value.startsWith(DEFINITIONS_PREFIX)
              ? SCHEMAS_PREFIX + value.slice(DEFINITIONS_PREFIX.length)
              : value,
          );
          break;
        case 'x-nullable':
          if (!convertsNullable) setEntry(target, key, value);
          break;
        case 'additionalItems':
          break;
        default:
          setEntry(target, key, value);
      }
    }
    if (convertsNullable) target['nullable'] = xNullable;
    if (type === 'file') {
      target['type'] = 'string';
      target['format'] = 'binary';
    }
    if (Array.isArray(type)) this.fillTypeList(target, type);
    else if (type === 'null') this.fillTypeList(target, [type]);
  }

  /** Replaces a `type` list as described on the class. */
  private fillTypeList(target: SpecRecord, type: readonly unknown[]): void {
    // A set for membership, so a list of any length is de-duplicated in linear time; it keeps the order written
    const names = new Set<string>();
    for (const entry of type) {
      if (typeof entry === 'string') names.add(entry);
    }
    const nullable = names.has('null');
    const types = [...names].filter((name) => name !== 'null');
    delete target['type'];
    if (types.length === 1) {
      target['type'] = types[0];
      if (nullable && ownProperty(target, 'nullable') === undefined) target['nullable'] = true;
      return;
    }
    if (types.length === 0) return;
    const alternatives: SpecRecord[] = types.map((name) => ({ type: name }));
    if (nullable) alternatives[0]['nullable'] = true;
    if (ownProperty(target, 'anyOf') === undefined) {
      target['anyOf'] = alternatives;
    } else {
      const allOf = ownProperty(target, 'allOf');
      target['allOf'] = [...(Array.isArray(allOf) ? allOf : []), { anyOf: alternatives }];
    }
  }
}
