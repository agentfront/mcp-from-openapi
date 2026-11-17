/**
 * Schema-to-types parity story: for every supported version, our OpenAPI
 * types (`src/spec/types`, namespaces `OAS20` (Swagger 2.0), `OAS30`, `OAS31`
 * and `OAS32`) say what the official OpenAPI Initiative JSON Schemas say,
 * field by field.
 *
 * - Every field the official schema gives an object is a property of the
 *   matching type, and the type declares no property the schema lacks unless
 *   it is on the version's `extraFields` allowlist.
 * - Required-ness matches: a field is required in the type exactly when the
 *   schema requires it of every instance. Deliberate differences are on the
 *   `stricterRequired` / `looserRequired` allowlists.
 * - Each field holds the kind of value the schema states (string, boolean,
 *   number, array of, map of, or a reference to a mapped type), wherever the
 *   schema states one plainly; `any`/`unknown` only where the schema leaves
 *   the value unconstrained. Deliberate differences are on `kindDeviations`.
 *   Where a field refers to one of several definitions behind one type (an
 *   OAuth flow), or narrows a mapped type, the value's own required fields
 *   must match that definition, and each field it declares must hold the kind
 *   the definition states (a field that narrows to `never` fails).
 *   A type that stands for several definitions (the 2.0 Schema Object is a
 *   `schema` or a `fileSchema`; a security scheme is one of six definitions)
 *   holds in each field any kind one of them states.
 *   How many fields this covers, and which are skipped, is pinned per version.
 * - Map-like objects (Paths, Responses, Callback, Security Requirement and, in
 *   Swagger 2.0, the definition maps, Headers, Examples and Scopes) are
 *   string-index types whose values have the kind the schema states.
 * - Which of those maps the official schema lets hold any value under an `x-`
 *   key is pinned per version (from probe documents validated with Ajv). A map
 *   type cannot accept a non-value-type entry under an `x-` key, so each such
 *   map is a visible, deliberate deviation in `extensionKeyDeviations`, shown
 *   with the in-process compiler. A map type that accepts a value the schema
 *   rejects as one of its own (a string, or a number where the values are
 *   strings: a hole in the type, not a deviation) is listed in
 *   `permissiveValues` until it is closed. Every map of Swagger 2.0 is probed
 *   the same way (`MAP_PROBES_20`); an Example Object holds any value, so it has
 *   no foreign value to probe.
 * - Every object type a namespace exports rejects a string, a number, a boolean
 *   and an array (`primitiveAccepts`), as a plain `const check: T = value`
 *   compiled with the real compiler: a type made only of optional fields takes
 *   no weak-type check when it is `Omit<Base, keyof Changes> & Changes` with
 *   nothing left to omit (the 3.2 Response, Components and OAuth Flows Objects
 *   once accepted a string). A type that accepts one on purpose is on
 *   `acceptsPrimitives` with its reason.
 * - The mapping is complete in both directions: every definition in every
 *   vendored OpenAPI schema document is mapped to a type or listed as
 *   unmapped with a reason, and every type a version namespace exports is
 *   compared.
 * - The vendored schemas match the checksums pinned in
 *   e2e/fixtures/oas/sources.json, and `src/spec` refers to no module outside
 *   itself. A module named by anything but a constant string (`import(x)`, a
 *   template literal with substitutions) cannot be proven to stay inside, so
 *   it fails the boundary check as well.
 *
 * Schemas are read by e2e/helpers/oas-schema.ts, which follows only the
 * applicators that act on the object itself. The 3.1/3.2 Schema Object is
 * `$dynamicRef: #meta` in schema.json; its keywords come from schema-base.json,
 * which binds it to the OAS dialect: the JSON Schema 2020-12 vocabulary
 * meta-schemas (vendored under e2e/fixtures/oas/schemas/json-schema-2020-12)
 * plus the OAS base vocabulary (meta.json). The 2.0 schema is one draft-04
 * document whose Parameter Object is a `oneOf` of a body parameter and a
 * `oneOf` of four others, whose security schemes are six definitions, whose
 * Schema Object is `schema` or `fileSchema`, and which reads its keyword
 * schemas (`title`, `maximum`, ...) from the draft-04 meta-schema (vendored
 * under e2e/fixtures/oas/schemas/json-schema-draft-04). Types are read with the
 * real TypeScript compiler.
 *
 * The story also checks the validation helper (e2e/helpers/oas-validate.ts)
 * for 2.0: every Swagger 2.0 document the repository holds validates against
 * the official schema, except the ones that are meant not to.
 *
 * When OAI publishes a new schema iteration: re-vendor it
 * (`node scripts/sync-oas-sources.mjs --update`) and run this story. Each
 * failure names the version, the schema definition, the type and the exact
 * fields; fix the types, or record a deliberate deviation in the allowlist
 * with its reason.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, resolve } from 'path';
import * as ts from 'typescript';
import * as yaml from 'yaml';
import {
  KindResolver,
  SchemaRegistry,
  SpecTypeReader,
  anyOfFields,
  dynamicAnchorBindings,
  extractObjectFields,
  formatKind,
  moduleSpecifiers,
  type NamespaceTypes,
  type ObjectFields,
  type PropertyShape,
  type SchemaKind,
  type SchemaSource,
  type SkippedKind,
  type TypeShape,
} from './helpers/oas-schema';
import { fixturePath, loadFixture, loadJsonFixture } from './helpers/fixtures';
import {
  rejectUntoleratedWarnings,
  swagger2SchemasAreDraft04,
  validateOasDocument,
  type SchemaVersion,
} from './helpers/oas-validate';
import { compileVirtual } from './helpers/tsc';

const repoRoot = join(__dirname, '..');

/** A schema location: a vendored document's file name and a JSON Pointer. */
type Definition = string;

/** A type compared field by field with the definitions it stands for. */
interface ObjectMapping {
  type: string;
  /**
   * The definitions this type describes. With several, the type stands for
   * an instance of any of them: it must declare every field any of them
   * defines, may require only what all of them require, and a field holds any
   * of the kinds they state for it (`KindResolver.kindOfAlternatives`).
   */
  definitions: Definition[];
}

/** A type the schema keys by pattern; compared as a string-index type. */
interface MapMapping extends ObjectMapping {
  /** Fixed fields the schema also lists, covered by the index signature (`default` in Responses). */
  fixedKeys: string[];
}

/** A deliberate difference between a type and the official schema. */
interface Deviation {
  type: string;
  field: string;
  reason: string;
}

/** An exported type that accepts a primitive on purpose. */
interface PrimitiveDeviation extends Omit<Deviation, 'field'> {
  /** The names (from `PRIMITIVES`) of the primitives it accepts. */
  accepts: string[];
}

/** A field whose value kind deliberately differs from the schema's. */
interface KindDeviation extends Deviation {
  /** The kind the type declares (as the story prints it); any other kind still fails. */
  typeKind: string;
}

interface VersionCase {
  version: SchemaVersion;
  /** How the version is named in the story's titles. */
  label: 'Swagger 2.0' | 'OpenAPI 3.0' | 'OpenAPI 3.1' | 'OpenAPI 3.2';
  namespace: 'OAS20' | 'OAS30' | 'OAS31' | 'OAS32';
  /** The manifest `kind`s that make up the version's OpenAPI schema. */
  kinds: string[];
  /**
   * The JSON Schema meta-schemas the version's schema documents `$ref`: the
   * 2020-12 vocabulary meta-schemas of the 3.1/3.2 dialect, or the draft-04
   * meta-schema the 2.0 schema reads its keyword schemas from. 3.0 refers to none.
   */
  metaSchema: 'draft-04' | '2020-12' | null;
  /**
   * The document every map probe is placed in: the version member and the
   * required `info` (a map object's own place is added by its probe).
   */
  probeRoot: object;
  /** How to probe each map object (`maps`), by type. */
  probes: Record<string, MapProbe>;
  objects: ObjectMapping[];
  maps: MapMapping[];
  /** Definitions deliberately not compared with a type of their own, with the reason. */
  unmapped: Record<Definition, string>;
  /** Exported types with no definition of their own, with the reason. */
  unmappedTypes: Record<string, string>;
  /** Properties a type declares although the schema does not define them. */
  extraFields: Deviation[];
  /** Properties a type requires although the schema leaves them optional. */
  stricterRequired: Deviation[];
  /** Properties a type leaves optional although the schema requires them. */
  looserRequired: Deviation[];
  kindDeviations: KindDeviation[];
  /**
   * The map objects (a `maps` type) whose official schema lets an `x-` key hold
   * any value, not only the map's own value type. Pinned from probe documents
   * (`probeExtensionKeys`): the others accept an `x-` key only with the map's
   * value type.
   */
  anyExtensionValue: string[];
  /**
   * Map objects that accept any `x-` value in the schema (`anyExtensionValue`)
   * but whose type cannot (`field` is the pattern `^x-`).
   */
  extensionKeyDeviations: Deviation[];
  /**
   * Map objects whose type accepts a string as the value of one of its own
   * keys, which the schema rejects (`field` is `[key]`). A gap in the type, not
   * a deliberate deviation: when the type accepts a string it also accepts one
   * under an `x-` key, which is no sign the map can hold "anything".
   */
  permissiveValues: Deviation[];
  /**
   * Exported types that accept a string, a number, a boolean or an array on
   * purpose, with the primitives (from `PRIMITIVES`) they accept. Any other
   * exported type rejects all four.
   */
  acceptsPrimitives: PrimitiveDeviation[];
  /**
   * How many fields (and map value kinds) the value-kind check compares, and
   * the `Type.field`s it skips because the schema states no plain kind. A
   * change here is a change in what the check covers: review it.
   */
  kindCoverage: { compared: number; skipped: string[] };
}

// Reasons shared by several unmapped definitions.

const orReference = (name: string, type: string): Record<Definition, string> => ({
  [`schema.json#/$defs/${name}-or-reference`]:
    `Either a Reference Object or a ${name}, chosen by whether \`$ref\` is present; typed inline as ` +
    `\`${type} | ReferenceObject\` where it is used, and both sides are compared on their own.`,
});

const PER_LOCATION_STYLES =
  'The style rules for one `in` value, applied in place under the parameter `dependentSchemas`; their fields are counted under ParameterObject.';
const PER_SCHEME_TYPE =
  'The fields for one security scheme `type`, applied in place by the security-scheme `allOf`; counted under SecuritySchemeObject, the single type for every scheme type.';
const EXTENSIONS_ONLY =
  'Only the `^x-` pattern. The types declare no specification extensions (read them through `WithExtensions`).';

const OAS3X_SHARED_UNMAPPED: Record<Definition, string> = {
  ...orReference('parameter', 'ParameterObject'),
  ...orReference('request-body', 'RequestBodyObject'),
  ...orReference('response', 'ResponseObject'),
  ...orReference('callbacks', 'CallbackObject'),
  ...orReference('example', 'ExampleObject'),
  ...orReference('link', 'LinkObject'),
  ...orReference('header', 'HeaderObject'),
  ...orReference('security-scheme', 'SecuritySchemeObject'),
  'schema.json#/$defs/content':
    'Media type range to Media Type Object; typed inline as a map on each owner (parameter, request body, response, header).',
  'schema.json#/$defs/specification-extensions': EXTENSIONS_ONLY,
  'schema.json#/$defs/examples':
    'The `example`/`examples` pair applied in place by parameter, header and media-type; counted under those types.',
  'schema.json#/$defs/map-of-strings':
    'A string-to-string map, typed inline where it is used (link `parameters`, flow `scopes`).',
  'schema.json#/$defs/explode-for-form':
    'The default of `explode` for each `style`, applied in place by encoding and query parameters; counted under those types.',
  'schema.json#/$defs/parameter/dependentSchemas/schema/$defs/styles-for-path': PER_LOCATION_STYLES,
  'schema.json#/$defs/parameter/dependentSchemas/schema/$defs/styles-for-header': PER_LOCATION_STYLES,
  'schema.json#/$defs/parameter/dependentSchemas/schema/$defs/styles-for-query': PER_LOCATION_STYLES,
  'schema.json#/$defs/parameter/dependentSchemas/schema/$defs/styles-for-cookie': PER_LOCATION_STYLES,
  'schema.json#/$defs/security-scheme/$defs/type-apikey': PER_SCHEME_TYPE,
  'schema.json#/$defs/security-scheme/$defs/type-http': PER_SCHEME_TYPE,
  'schema.json#/$defs/security-scheme/$defs/type-http-bearer': PER_SCHEME_TYPE,
  'schema.json#/$defs/security-scheme/$defs/type-oauth2': PER_SCHEME_TYPE,
  'schema.json#/$defs/security-scheme/$defs/type-oidc': PER_SCHEME_TYPE,
  'schema-base.json#/$defs/dialect': 'A `const` (the dialect URI), not an object.',
  'meta.json#/$defs/extensible': EXTENSIONS_ONLY,
};

const OAS3X_SHARED_UNMAPPED_TYPES: Record<string, string> = {
  SchemaOrBoolean: 'A Schema Object or its boolean form (`true`/`false`); its object form is compared as SchemaObject.',
};

const OAS3X_STRICTER_REQUIRED: Deviation[] = [
  {
    type: 'ReferenceObject',
    field: '$ref',
    reason:
      'The `reference` definition requires nothing on its own because every `*-or-reference` definition selects it only when `$ref` is present (`if: { required: [$ref] }`). Wherever a Reference Object can appear, it therefore has `$ref`.',
  },
];

const EXTENSION_KEY_REASON =
  'The official schema lets an `x-` key in this object hold any value, but the map type `SpecMap<T>` (`Record<string, T | undefined>`) cannot accept a ' +
  'value that is not a T under an `x-` key. TypeScript cannot say "`x-` keys hold anything, other keys hold T" without an index signature on object ' +
  "types, which the design forbids: it would reject documents typed with the caller's own interfaces. An `x-` entry reads as a T; check it before use.";

const OAS3X_ACCEPTS_PRIMITIVES: PrimitiveDeviation[] = [
  {
    type: 'SchemaOrBoolean',
    accepts: ['a boolean'],
    reason: 'A Schema Object or, from 3.1 on, its boolean form: `true` accepts anything, `false` nothing.',
  },
];

const OAS3X_KIND_DEVIATIONS: KindDeviation[] = [
  {
    type: 'SchemaObject',
    field: 'exclusiveMinimum',
    typeKind: 'boolean | number',
    reason:
      'JSON Schema 2020-12 makes it a number, but documents migrated from 3.0 often keep the boolean form; the reader type accepts both and the library normalises it.',
  },
  {
    type: 'SchemaObject',
    field: 'exclusiveMaximum',
    typeKind: 'boolean | number',
    reason:
      'JSON Schema 2020-12 makes it a number, but documents migrated from 3.0 often keep the boolean form; the reader type accepts both and the library normalises it.',
  },
  {
    type: 'LinkObject',
    field: 'parameters',
    typeKind: 'map<free>',
    reason:
      'The schema (`map-of-strings`) allows only strings, but the specification text says a value is "Any | {expression}": a constant of any type or a runtime expression.',
  },
];

// ---------------------------------------------------------------------------
// How to probe each map object for `x-` keys
// ---------------------------------------------------------------------------

/**
 * How to probe one map object: where it sits in a minimal valid document
 * (`place`), the entries it holds, and a value of its own value type (`typed`).
 */
interface MapProbe {
  /** The document (after the version's `probeRoot`) holding `map` where the object belongs. */
  place: (map: object) => object;
  entries: object;
  typed: unknown;
  /**
   * A value the map's own value type cannot hold, given to `x-label` and to the
   * first entry in turn: the string `'Pets'` unless the map's values are strings.
   */
  foreign?: unknown;
  /** Every JSON value is a value of this map (a Swagger 2.0 Example Object): there is nothing foreign to probe. */
  holdsAnything?: true;
}

/** OpenAPI 3.x: Paths, Responses, Callback and Security Requirement. */
const MAP_PROBES_3X: Record<string, MapProbe> = {
  PathsObject: { place: (map) => ({ paths: map }), entries: { '/pets': {} }, typed: {} },
  ResponsesObject: {
    place: (map) => ({ paths: { '/pets': { get: { responses: map } } } }),
    entries: { '200': { description: 'ok' } },
    typed: { description: 'ok' },
  },
  CallbackObject: {
    place: (map) => ({
      paths: { '/pets': { get: { responses: { '200': { description: 'ok' } }, callbacks: { onEvent: map } } } },
    }),
    entries: { '{$request.body#/url}': {} },
    typed: {},
  },
  SecurityRequirementObject: { place: (map) => ({ paths: {}, security: [map] }), entries: { apiKey: [] }, typed: [] },
};

/** A Swagger 2.0 operation with one response, to hold what `fields` adds to the operation or the response. */
const swagger2Operation = (operation: object = {}, response: object = {}): object => ({
  paths: { '/pets': { get: { responses: { '200': { description: 'ok', ...response } }, ...operation } } },
});

/** Swagger 2.0: every map object, whose schema keys it by `additionalProperties` or `patternProperties`. */
const MAP_PROBES_20: Record<string, MapProbe> = {
  PathsObject: MAP_PROBES_3X['PathsObject']!,
  ResponsesObject: {
    place: (map) => ({ paths: { '/pets': { get: { responses: map } } } }),
    entries: { '200': { description: 'ok' } },
    typed: { description: 'ok' },
  },
  DefinitionsObject: { place: (map) => ({ paths: {}, definitions: map }), entries: { Pet: {} }, typed: {} },
  ParametersDefinitionsObject: {
    place: (map) => ({ paths: {}, parameters: map }),
    entries: { limit: { name: 'limit', in: 'query', type: 'integer' } },
    typed: { name: 'limit', in: 'query', type: 'integer' },
  },
  ResponsesDefinitionsObject: {
    place: (map) => ({ paths: {}, responses: map }),
    entries: { NotFound: { description: 'Not found' } },
    typed: { description: 'Not found' },
  },
  HeadersObject: {
    place: (map) => swagger2Operation({}, { headers: map }),
    entries: { 'X-Rate-Limit': { type: 'integer' } },
    typed: { type: 'integer' },
  },
  ExampleObject: {
    place: (map) => swagger2Operation({}, { examples: map }),
    entries: { 'application/json': { id: 1 } },
    typed: { id: 1 },
    holdsAnything: true,
  },
  SecurityDefinitionsObject: {
    place: (map) => ({ paths: {}, securityDefinitions: map }),
    entries: { basic: { type: 'basic' } },
    typed: { type: 'basic' },
  },
  ScopesObject: {
    place: (map) => ({
      paths: {},
      securityDefinitions: {
        oauth: { type: 'oauth2', flow: 'password', tokenUrl: 'https://auth.example.com/token', scopes: map },
      },
    }),
    entries: { read: 'Read pets' },
    typed: 'Write pets',
    // a scope's description is a string: the foreign value is a number
    foreign: 1,
  },
  SecurityRequirementObject: { place: (map) => ({ paths: {}, security: [map] }), entries: { apiKey: [] }, typed: [] },
};

const OAS30: VersionCase = {
  version: '3.0',
  label: 'OpenAPI 3.0',
  namespace: 'OAS30',
  kinds: ['schema'],
  metaSchema: null,
  probeRoot: { openapi: '3.0.0', info: { title: 'Probe', version: '1' } },
  probes: MAP_PROBES_3X,
  objects: [
    { type: 'OpenAPIObject', definitions: ['schema.json#'] },
    { type: 'InfoObject', definitions: ['schema.json#/definitions/Info'] },
    { type: 'ContactObject', definitions: ['schema.json#/definitions/Contact'] },
    { type: 'LicenseObject', definitions: ['schema.json#/definitions/License'] },
    { type: 'ServerObject', definitions: ['schema.json#/definitions/Server'] },
    { type: 'ServerVariableObject', definitions: ['schema.json#/definitions/ServerVariable'] },
    { type: 'ComponentsObject', definitions: ['schema.json#/definitions/Components'] },
    { type: 'PathItemObject', definitions: ['schema.json#/definitions/PathItem'] },
    { type: 'OperationObject', definitions: ['schema.json#/definitions/Operation'] },
    { type: 'ExternalDocumentationObject', definitions: ['schema.json#/definitions/ExternalDocumentation'] },
    { type: 'ParameterObject', definitions: ['schema.json#/definitions/Parameter'] },
    { type: 'RequestBodyObject', definitions: ['schema.json#/definitions/RequestBody'] },
    { type: 'MediaTypeObject', definitions: ['schema.json#/definitions/MediaType'] },
    { type: 'EncodingObject', definitions: ['schema.json#/definitions/Encoding'] },
    { type: 'ResponseObject', definitions: ['schema.json#/definitions/Response'] },
    { type: 'ExampleObject', definitions: ['schema.json#/definitions/Example'] },
    { type: 'LinkObject', definitions: ['schema.json#/definitions/Link'] },
    { type: 'HeaderObject', definitions: ['schema.json#/definitions/Header'] },
    { type: 'TagObject', definitions: ['schema.json#/definitions/Tag'] },
    { type: 'ReferenceObject', definitions: ['schema.json#/definitions/Reference'] },
    { type: 'SchemaObject', definitions: ['schema.json#/definitions/Schema'] },
    { type: 'DiscriminatorObject', definitions: ['schema.json#/definitions/Discriminator'] },
    { type: 'XMLObject', definitions: ['schema.json#/definitions/XML'] },
    { type: 'SecuritySchemeObject', definitions: ['schema.json#/definitions/SecurityScheme'] },
    { type: 'OAuthFlowsObject', definitions: ['schema.json#/definitions/OAuthFlows'] },
    {
      type: 'OAuthFlowObject',
      definitions: [
        'schema.json#/definitions/ImplicitOAuthFlow',
        'schema.json#/definitions/PasswordOAuthFlow',
        'schema.json#/definitions/ClientCredentialsFlow',
        'schema.json#/definitions/AuthorizationCodeOAuthFlow',
      ],
    },
  ],
  maps: [
    { type: 'PathsObject', definitions: ['schema.json#/definitions/Paths'], fixedKeys: [] },
    { type: 'ResponsesObject', definitions: ['schema.json#/definitions/Responses'], fixedKeys: ['default'] },
    { type: 'CallbackObject', definitions: ['schema.json#/definitions/Callback'], fixedKeys: [] },
    { type: 'SecurityRequirementObject', definitions: ['schema.json#/definitions/SecurityRequirement'], fixedKeys: [] },
  ],
  unmapped: {
    'schema.json#/definitions/ExampleXORExamples':
      'A constraint with no fields (`example` and `examples` are mutually exclusive), applied in place by MediaType, Header and Parameter.',
    'schema.json#/definitions/SchemaXORContent':
      'A constraint with no fields of its own (exactly one of `schema` and `content`), applied in place by Header and Parameter.',
    'schema.json#/definitions/PathParameter':
      'One alternative of the Parameter `oneOf` (the rules for `in: path`); its fields are counted under ParameterObject.',
    'schema.json#/definitions/QueryParameter':
      'One alternative of the Parameter `oneOf` (the rules for `in: query`); its fields are counted under ParameterObject.',
    'schema.json#/definitions/HeaderParameter':
      'One alternative of the Parameter `oneOf` (the rules for `in: header`); its fields are counted under ParameterObject.',
    'schema.json#/definitions/CookieParameter':
      'One alternative of the Parameter `oneOf` (the rules for `in: cookie`); its fields are counted under ParameterObject.',
    'schema.json#/definitions/APIKeySecurityScheme':
      'One alternative of the SecurityScheme `oneOf`; counted under SecuritySchemeObject, the single type for every scheme type.',
    'schema.json#/definitions/HTTPSecurityScheme':
      'One alternative of the SecurityScheme `oneOf`; counted under SecuritySchemeObject, the single type for every scheme type.',
    'schema.json#/definitions/OAuth2SecurityScheme':
      'One alternative of the SecurityScheme `oneOf`; counted under SecuritySchemeObject, the single type for every scheme type.',
    'schema.json#/definitions/OpenIdConnectSecurityScheme':
      'One alternative of the SecurityScheme `oneOf`; counted under SecuritySchemeObject, the single type for every scheme type.',
  },
  unmappedTypes: {},
  extraFields: [],
  stricterRequired: [],
  looserRequired: [],
  kindDeviations: [],
  // Paths, Responses and Callback say `^x-: {}`; a Security Requirement has no extensions.
  anyExtensionValue: ['CallbackObject', 'PathsObject', 'ResponsesObject'],
  extensionKeyDeviations: [
    { type: 'PathsObject', field: '^x-', reason: EXTENSION_KEY_REASON },
    { type: 'ResponsesObject', field: '^x-', reason: EXTENSION_KEY_REASON },
    { type: 'CallbackObject', field: '^x-', reason: EXTENSION_KEY_REASON },
  ],
  permissiveValues: [],
  acceptsPrimitives: [],
  kindCoverage: { compared: 177, skipped: [] },
};

/**
 * Objects and maps whose definitions have the same names in 3.1 and 3.2;
 * `flows` names the version's OAuth flow definitions under `oauth-flows`.
 */
const oas3xMappings = (flows: readonly string[]): Pick<VersionCase, 'objects' | 'maps'> => ({
  objects: [
    { type: 'OpenAPIObject', definitions: ['schema.json#', 'schema-base.json#'] },
    { type: 'InfoObject', definitions: ['schema.json#/$defs/info'] },
    { type: 'ContactObject', definitions: ['schema.json#/$defs/contact'] },
    { type: 'LicenseObject', definitions: ['schema.json#/$defs/license'] },
    { type: 'ServerObject', definitions: ['schema.json#/$defs/server'] },
    { type: 'ServerVariableObject', definitions: ['schema.json#/$defs/server-variable'] },
    { type: 'ComponentsObject', definitions: ['schema.json#/$defs/components'] },
    { type: 'PathItemObject', definitions: ['schema.json#/$defs/path-item'] },
    { type: 'OperationObject', definitions: ['schema.json#/$defs/operation'] },
    {
      type: 'ExternalDocumentationObject',
      definitions: ['schema.json#/$defs/external-documentation', 'meta.json#/$defs/external-docs'],
    },
    { type: 'ParameterObject', definitions: ['schema.json#/$defs/parameter'] },
    { type: 'RequestBodyObject', definitions: ['schema.json#/$defs/request-body'] },
    { type: 'MediaTypeObject', definitions: ['schema.json#/$defs/media-type'] },
    { type: 'EncodingObject', definitions: ['schema.json#/$defs/encoding'] },
    { type: 'ResponseObject', definitions: ['schema.json#/$defs/response'] },
    { type: 'ExampleObject', definitions: ['schema.json#/$defs/example'] },
    { type: 'LinkObject', definitions: ['schema.json#/$defs/link'] },
    { type: 'HeaderObject', definitions: ['schema.json#/$defs/header'] },
    { type: 'TagObject', definitions: ['schema.json#/$defs/tag'] },
    { type: 'ReferenceObject', definitions: ['schema.json#/$defs/reference'] },
    // schema.json's `schema` is only `$dynamicAnchor: meta`; schema-base.json
    // binds it to the dialect (dialect.json), which is JSON Schema 2020-12 plus
    // the OAS base vocabulary (meta.json).
    {
      type: 'SchemaObject',
      definitions: ['schema.json#/$defs/schema', 'schema-base.json#/$defs/schema', 'dialect.json#', 'meta.json#'],
    },
    { type: 'DiscriminatorObject', definitions: ['meta.json#/$defs/discriminator'] },
    { type: 'XMLObject', definitions: ['meta.json#/$defs/xml'] },
    { type: 'SecuritySchemeObject', definitions: ['schema.json#/$defs/security-scheme'] },
    { type: 'OAuthFlowsObject', definitions: ['schema.json#/$defs/oauth-flows'] },
    { type: 'OAuthFlowObject', definitions: flows.map((flow) => `schema.json#/$defs/oauth-flows/$defs/${flow}`) },
  ],
  maps: [
    { type: 'PathsObject', definitions: ['schema.json#/$defs/paths'], fixedKeys: [] },
    { type: 'ResponsesObject', definitions: ['schema.json#/$defs/responses'], fixedKeys: ['default'] },
    { type: 'CallbackObject', definitions: ['schema.json#/$defs/callbacks'], fixedKeys: [] },
    { type: 'SecurityRequirementObject', definitions: ['schema.json#/$defs/security-requirement'], fixedKeys: [] },
  ],
});

/**
 * 3.1 and 3.2: Paths and Responses allow any `x-` value (`specification-extensions`),
 * but a Callback's `x-` value must still be a Path Item (its `additionalProperties`,
 * which the sibling `$ref` to the extensions does not exempt it from), and a
 * Security Requirement has no extensions.
 */
const OAS3X_EXTENSION_KEYS: Pick<VersionCase, 'anyExtensionValue' | 'extensionKeyDeviations' | 'permissiveValues'> = {
  anyExtensionValue: ['PathsObject', 'ResponsesObject'],
  extensionKeyDeviations: [
    { type: 'PathsObject', field: '^x-', reason: EXTENSION_KEY_REASON },
    { type: 'ResponsesObject', field: '^x-', reason: EXTENSION_KEY_REASON },
  ],
  permissiveValues: [],
};

const OAS31_FLOWS = ['implicit', 'password', 'client-credentials', 'authorization-code'];

const OAS31: VersionCase = {
  version: '3.1',
  label: 'OpenAPI 3.1',
  namespace: 'OAS31',
  kinds: ['schema', 'schema-base', 'dialect', 'meta'],
  metaSchema: '2020-12',
  probeRoot: { openapi: '3.1.0', info: { title: 'Probe', version: '1' } },
  probes: MAP_PROBES_3X,
  ...oas3xMappings(OAS31_FLOWS),
  unmapped: OAS3X_SHARED_UNMAPPED,
  unmappedTypes: OAS3X_SHARED_UNMAPPED_TYPES,
  extraFields: [],
  stricterRequired: OAS3X_STRICTER_REQUIRED,
  looserRequired: [],
  kindDeviations: OAS3X_KIND_DEVIATIONS,
  ...OAS3X_EXTENSION_KEYS,
  acceptsPrimitives: OAS3X_ACCEPTS_PRIMITIVES,
  kindCoverage: { compared: 212, skipped: [] },
};

const OAS32: VersionCase = {
  version: '3.2',
  label: 'OpenAPI 3.2',
  namespace: 'OAS32',
  kinds: ['schema', 'schema-base', 'dialect', 'meta'],
  metaSchema: '2020-12',
  probeRoot: { openapi: '3.2.0', info: { title: 'Probe', version: '1' } },
  probes: MAP_PROBES_3X,
  ...oas3xMappings([...OAS31_FLOWS, 'device-authorization']),
  unmapped: {
    ...OAS3X_SHARED_UNMAPPED,
    ...orReference('media-type', 'MediaTypeObject'),
    'schema.json#/$defs/parameters':
      'An array of parameter-or-reference with the `querystring` rules; typed inline as `(ParameterObject | ReferenceObject)[]`.',
    'schema.json#/$defs/token': 'A string pattern (an RFC 9110 token), not an object.',
  },
  unmappedTypes: OAS3X_SHARED_UNMAPPED_TYPES,
  extraFields: [],
  stricterRequired: OAS3X_STRICTER_REQUIRED,
  looserRequired: [],
  kindDeviations: OAS3X_KIND_DEVIATIONS,
  ...OAS3X_EXTENSION_KEYS,
  acceptsPrimitives: OAS3X_ACCEPTS_PRIMITIVES,
  kindCoverage: { compared: 235, skipped: [] },
};

// Reasons shared by several unmapped Swagger 2.0 definitions.

const PARAMETER_ALTERNATIVE =
  'One alternative of the Parameter Object (`parameter` is a `oneOf` of a body parameter and `nonBodyParameter`, itself a `oneOf` of four); ' +
  'its fields are counted under ParameterObject, the one object of the text, mapped through `parameter`.';
const DRAFT_04_KEYWORD =
  'An alias of one keyword schema of the draft-04 meta-schema (`$ref: http://json-schema.org/draft-04/schema#/...`), applied in place by the ' +
  'parameter, items, header and Schema Objects; its kind is compared under each field that uses it.';
const INLINE_ARRAY = (name: string, type: string): string =>
  `An array typed inline where it is used: \`${type}\` (the ${name} list); the elements are compared on their own.`;

const OAS20: VersionCase = {
  version: '2.0',
  label: 'Swagger 2.0',
  namespace: 'OAS20',
  kinds: ['schema'],
  metaSchema: 'draft-04',
  probeRoot: { swagger: '2.0', info: { title: 'Probe', version: '1' } },
  probes: MAP_PROBES_20,
  objects: [
    { type: 'SwaggerObject', definitions: ['schema.json#'] },
    { type: 'InfoObject', definitions: ['schema.json#/definitions/info'] },
    { type: 'ContactObject', definitions: ['schema.json#/definitions/contact'] },
    { type: 'LicenseObject', definitions: ['schema.json#/definitions/license'] },
    { type: 'PathItemObject', definitions: ['schema.json#/definitions/pathItem'] },
    { type: 'OperationObject', definitions: ['schema.json#/definitions/operation'] },
    { type: 'ExternalDocumentationObject', definitions: ['schema.json#/definitions/externalDocs'] },
    // `parameter` is `oneOf` [bodyParameter, nonBodyParameter]: a field is required only when every branch requires it
    { type: 'ParameterObject', definitions: ['schema.json#/definitions/parameter'] },
    { type: 'ItemsObject', definitions: ['schema.json#/definitions/primitivesItems'] },
    { type: 'ResponseObject', definitions: ['schema.json#/definitions/response'] },
    { type: 'HeaderObject', definitions: ['schema.json#/definitions/header'] },
    { type: 'TagObject', definitions: ['schema.json#/definitions/tag'] },
    { type: 'ReferenceObject', definitions: ['schema.json#/definitions/jsonReference'] },
    { type: 'SchemaObject', definitions: ['schema.json#/definitions/schema', 'schema.json#/definitions/fileSchema'] },
    { type: 'XMLObject', definitions: ['schema.json#/definitions/xml'] },
    {
      type: 'SecuritySchemeObject',
      definitions: [
        'schema.json#/definitions/basicAuthenticationSecurity',
        'schema.json#/definitions/apiKeySecurity',
        'schema.json#/definitions/oauth2ImplicitSecurity',
        'schema.json#/definitions/oauth2PasswordSecurity',
        'schema.json#/definitions/oauth2ApplicationSecurity',
        'schema.json#/definitions/oauth2AccessCodeSecurity',
      ],
    },
  ],
  maps: [
    { type: 'PathsObject', definitions: ['schema.json#/definitions/paths'], fixedKeys: [] },
    { type: 'ResponsesObject', definitions: ['schema.json#/definitions/responses'], fixedKeys: [] },
    { type: 'DefinitionsObject', definitions: ['schema.json#/definitions/definitions'], fixedKeys: [] },
    {
      type: 'ParametersDefinitionsObject',
      definitions: ['schema.json#/definitions/parameterDefinitions'],
      fixedKeys: [],
    },
    {
      type: 'ResponsesDefinitionsObject',
      definitions: ['schema.json#/definitions/responseDefinitions'],
      fixedKeys: [],
    },
    { type: 'HeadersObject', definitions: ['schema.json#/definitions/headers'], fixedKeys: [] },
    { type: 'ExampleObject', definitions: ['schema.json#/definitions/examples'], fixedKeys: [] },
    { type: 'SecurityDefinitionsObject', definitions: ['schema.json#/definitions/securityDefinitions'], fixedKeys: [] },
    { type: 'ScopesObject', definitions: ['schema.json#/definitions/oauth2Scopes'], fixedKeys: [] },
    { type: 'SecurityRequirementObject', definitions: ['schema.json#/definitions/securityRequirement'], fixedKeys: [] },
  ],
  unmapped: {
    'schema.json#/definitions/vendorExtension': EXTENSIONS_ONLY + ' It holds any value (`additionalProperties: true`).',
    'schema.json#/definitions/mimeType': 'A string (a media type), not an object; the items of `consumes` and `produces`.',
    'schema.json#/definitions/responseValue':
      'Either a Response Object or a Reference Object (`oneOf`); typed inline as `ResponseObject | ReferenceObject` as the value of ResponsesObject, and both sides are compared on their own.',
    'schema.json#/definitions/bodyParameter': PARAMETER_ALTERNATIVE,
    'schema.json#/definitions/nonBodyParameter': PARAMETER_ALTERNATIVE,
    'schema.json#/definitions/headerParameterSubSchema': PARAMETER_ALTERNATIVE,
    'schema.json#/definitions/formDataParameterSubSchema': PARAMETER_ALTERNATIVE,
    'schema.json#/definitions/queryParameterSubSchema': PARAMETER_ALTERNATIVE,
    'schema.json#/definitions/pathParameterSubSchema': PARAMETER_ALTERNATIVE,
    'schema.json#/definitions/security': INLINE_ARRAY('security requirement', 'SecurityRequirementObject[]'),
    'schema.json#/definitions/mediaTypeList': INLINE_ARRAY('media type', 'string[]'),
    'schema.json#/definitions/parametersList': INLINE_ARRAY('parameter', '(ParameterObject | ReferenceObject)[]'),
    'schema.json#/definitions/schemesList': INLINE_ARRAY('scheme', 'Scheme[]'),
    'schema.json#/definitions/collectionFormat':
      'A string enumeration (`csv`, `ssv`, `tsv`, `pipes`), open in the type (`CollectionFormat`, not exported); the type of `collectionFormat` on a header, items and non-query parameters.',
    'schema.json#/definitions/collectionFormatWithMulti':
      'A string enumeration (`collectionFormat` plus `multi`), open in the type (`CollectionFormat`, not exported); the type of `collectionFormat` on a query or formData parameter.',
    'schema.json#/definitions/title': DRAFT_04_KEYWORD,
    'schema.json#/definitions/description': DRAFT_04_KEYWORD,
    'schema.json#/definitions/default': DRAFT_04_KEYWORD,
    'schema.json#/definitions/multipleOf': DRAFT_04_KEYWORD,
    'schema.json#/definitions/maximum': DRAFT_04_KEYWORD,
    'schema.json#/definitions/exclusiveMaximum': DRAFT_04_KEYWORD,
    'schema.json#/definitions/minimum': DRAFT_04_KEYWORD,
    'schema.json#/definitions/exclusiveMinimum': DRAFT_04_KEYWORD,
    'schema.json#/definitions/maxLength': DRAFT_04_KEYWORD,
    'schema.json#/definitions/minLength': DRAFT_04_KEYWORD,
    'schema.json#/definitions/pattern': DRAFT_04_KEYWORD,
    'schema.json#/definitions/maxItems': DRAFT_04_KEYWORD,
    'schema.json#/definitions/minItems': DRAFT_04_KEYWORD,
    'schema.json#/definitions/uniqueItems': DRAFT_04_KEYWORD,
    'schema.json#/definitions/enum': DRAFT_04_KEYWORD,
  },
  unmappedTypes: {},
  extraFields: [],
  stricterRequired: [],
  looserRequired: [],
  kindDeviations: [],
  // Paths and Responses say `^x-: vendorExtension` (any value); an Example Object holds any value under every key
  anyExtensionValue: ['ExampleObject', 'PathsObject', 'ResponsesObject'],
  extensionKeyDeviations: [
    { type: 'PathsObject', field: '^x-', reason: EXTENSION_KEY_REASON },
    { type: 'ResponsesObject', field: '^x-', reason: EXTENSION_KEY_REASON },
  ],
  permissiveValues: [],
  acceptsPrimitives: [
    {
      type: 'ExampleObject',
      accepts: ['an array'],
      reason:
        'The schema says `type: object` with `additionalProperties: true`, which rejects an array. The type is `SpecMap<FreeFormValue>`, that is `Record<string, any>`, and ' +
        'TypeScript relates every object type (an array, a function) to a string index signature whose value type is `any`, where it would not for `unknown` or any ' +
        'other value type. Free-form values are `any` on purpose (see `FreeFormValue` in common.ts), so the index signature has to be one; a value that is not a ' +
        'plain object is for the validator to refuse.',
    },
  ],
  kindCoverage: { compared: 168, skipped: [] },
};

const VERSIONS: VersionCase[] = [OAS20, OAS30, OAS31, OAS32];

interface ManifestEntry {
  id: string;
  version: string;
  kind: string;
  url: string;
  path: string;
  sha256: string;
}

const SCHEMA_KINDS = ['schema', 'schema-base', 'dialect', 'meta'];

/** The JSON Schema 2020-12 meta-schema and its vocabulary meta-schemas, by path under e2e/fixtures/oas/schemas/. */
const JSON_SCHEMA_2020_FILES = [
  'json-schema-2020-12/schema.json',
  ...['core', 'applicator', 'unevaluated', 'validation', 'meta-data', 'format-annotation', 'content'].map(
    (vocabulary) => `json-schema-2020-12/meta/${vocabulary}.json`,
  ),
];

/** The JSON Schema draft-04 meta-schema, by path under e2e/fixtures/oas/schemas/ (2.0 reads keyword schemas from it). */
const JSON_SCHEMA_DRAFT_04_FILES = ['json-schema-draft-04/schema.json'];

const manifest = (): ManifestEntry[] => loadJsonFixture<{ sources: ManifestEntry[] }>('oas/sources.json').sources;

/**
 * The pinned meta-schemas whose manifest ids start with `idPrefix`, labelled by
 * their path under `schemas/`; throws when one of `files` is missing.
 */
function metaSchemaSources(idPrefix: string, files: readonly string[], name: string): SchemaSource[] {
  const pinned = manifest().filter((entry) => entry.id.startsWith(idPrefix));
  const byLabel = new Map(pinned.map((entry) => [entry.path.replace(/^schemas\//, ''), entry]));
  const missing = files.filter((file) => !byLabel.has(file));
  if (missing.length > 0) {
    throw new Error(
      `e2e/fixtures/oas/sources.json pins no copy of ${missing.join(', ')}: the ${name} meta-schemas must be vendored`,
    );
  }
  return [...byLabel].map(([label, entry]) => ({ label, schema: loadJsonFixture(`oas/${entry.path}`) }));
}

const jsonSchema2020Sources = (): SchemaSource[] =>
  metaSchemaSources('json-schema-2020-12', JSON_SCHEMA_2020_FILES, 'JSON Schema 2020-12');
const jsonSchemaDraft04Sources = (): SchemaSource[] =>
  metaSchemaSources('json-schema-draft-04', JSON_SCHEMA_DRAFT_04_FILES, 'JSON Schema draft-04');

/** The meta-schemas the version's schema documents refer to. */
const metaSchemasOf = (version: VersionCase): SchemaSource[] =>
  version.metaSchema === '2020-12'
    ? jsonSchema2020Sources()
    : version.metaSchema === 'draft-04'
      ? jsonSchemaDraft04Sources()
      : [];

const sorted = (names: Iterable<string>): string[] => [...names].sort();

const isDeviation = (list: readonly Deviation[], type: string, field: string): boolean =>
  list.some((deviation) => deviation.type === type && deviation.field === field);

let types: SpecTypeReader;

beforeAll(() => {
  types = new SpecTypeReader(join(repoRoot, 'src/spec/types/index.ts'), join(repoRoot, 'src/spec/tsconfig.json'));
});

// ---------------------------------------------------------------------------
// The comparison of one version, over a given reading of the types
// ---------------------------------------------------------------------------

/** What the comparison of one version needs: its schemas, and the types read through `view`. */
interface ParityContext {
  version: VersionCase;
  /** The manifest entries of the version's OpenAPI schema documents. */
  entries: ManifestEntry[];
  /** The documents' short names, as locations are written. */
  labels: string[];
  registry: SchemaRegistry;
  /** The fields of each definition, read once. */
  definitionFields: Map<Definition, ObjectFields>;
  view: NamespaceTypes;
  kinds: KindResolver;
  /** Canonical names of types standing for several definitions: a field naming one must match that one's required fields. */
  multiDefinition: ReadonlySet<string>;
}

function buildContext(version: VersionCase, reader: SpecTypeReader): ParityContext {
  const entries = manifest().filter(
    (entry) => entry.id.startsWith('oas-') && entry.version === version.version && SCHEMA_KINDS.includes(entry.kind),
  );
  const sources: SchemaSource[] = entries.map((entry) => ({
    label: basename(entry.path),
    schema: loadJsonFixture(`oas/${entry.path}`),
  }));
  const registry = new SchemaRegistry([...sources, ...metaSchemasOf(version)]);
  // Value kinds name the mapped object types; a map type is compared by its
  // structure (`map<PathItemObject>`) wherever it appears.
  const view = reader.namespace(
    version.namespace,
    version.objects.map((mapping) => mapping.type),
  );
  const mapped = version.objects.flatMap((mapping) =>
    mapping.definitions.map((definition) => ({ definition, type: view.canonical(mapping.type) })),
  );
  const typeByDefinition = new Map(mapped.map(({ definition, type }) => [definition, type]));
  return {
    version,
    entries,
    labels: sources.map((source) => source.label),
    registry,
    definitionFields: new Map(),
    view,
    kinds: new KindResolver(
      registry,
      (definition) => typeByDefinition.get(definition),
      dynamicAnchorBindings(registry, mapped),
    ),
    multiDefinition: new Set(
      version.objects.filter((m) => m.definitions.length > 1).map((m) => view.canonical(m.type)),
    ),
  };
}

const mappingsOf = (version: VersionCase): ObjectMapping[] => [...version.objects, ...version.maps];

const where = ({ version }: ParityContext, mapping: ObjectMapping): string =>
  `${version.version} ${mapping.definitions.join(' + ')} -> ${version.namespace}.${mapping.type}`;

/** What the schema at `definition` gives an instance, read once. */
function definitionFields(ctx: ParityContext, definition: Definition): ObjectFields {
  let fields = ctx.definitionFields.get(definition);
  if (!fields) {
    fields = extractObjectFields(ctx.registry, definition);
    ctx.definitionFields.set(definition, fields);
  }
  return fields;
}

const fieldsOfDefinitions = (ctx: ParityContext, definitions: readonly Definition[]): ObjectFields =>
  anyOfFields(definitions.map((definition) => definitionFields(ctx, definition)));

const fieldsOf = (ctx: ParityContext, mapping: ObjectMapping): ObjectFields =>
  fieldsOfDefinitions(ctx, mapping.definitions);

/**
 * The kind of value `field` holds in an instance of any of `definitions`: the
 * union of the kinds each definition that defines it states.
 */
const fieldKind = (ctx: ParityContext, definitions: readonly Definition[], field: string): SchemaKind | SkippedKind =>
  ctx.kinds.kindOfAlternatives(
    definitions.flatMap((definition) => {
      const locations = definitionFields(ctx, definition).propertySchemas.get(field);
      return locations ? [locations] : [];
    }),
  );

const mapValueKind = (ctx: ParityContext, fields: ObjectFields): SchemaKind | SkippedKind =>
  ctx.kinds.kindOf([...fields.valueSchemas, ...[...fields.propertySchemas.values()].flat()]);

/** Problems with extra fields and required-ness, for objects and maps alike. */
function fieldProblems(ctx: ParityContext, mapping: ObjectMapping, fields: ObjectFields, shape: TypeShape): string[] {
  const { version } = ctx;
  const problems: string[] = [];
  const declared = sorted(shape.properties.keys());
  const required = (name: string): boolean => shape.properties.get(name)?.required === true;
  const extra = declared.filter(
    (name) => !fields.properties.has(name) && !isDeviation(version.extraFields, mapping.type, name),
  );
  if (extra.length > 0) {
    problems.push(
      `${where(ctx, mapping)}: declares field(s) the official schema does not define: ${extra.join(', ')} (remove them, or allowlist each in extraFields with a reason)`,
    );
  }
  const tooStrict = declared.filter(
    (name) =>
      required(name) && !fields.required.has(name) && !isDeviation(version.stricterRequired, mapping.type, name),
  );
  if (tooStrict.length > 0) {
    problems.push(
      `${where(ctx, mapping)}: requires field(s) the official schema leaves optional: ${tooStrict.join(', ')} (make them optional, or allowlist each in stricterRequired with a reason)`,
    );
  }
  const tooLoose = declared.filter(
    (name) => !required(name) && fields.required.has(name) && !isDeviation(version.looserRequired, mapping.type, name),
  );
  if (tooLoose.length > 0) {
    problems.push(
      `${where(ctx, mapping)}: leaves optional field(s) the official schema requires: ${tooLoose.join(', ')} (make them required, or allowlist each in looserRequired with a reason)`,
    );
  }
  return problems;
}

/**
 * Problems with a value that refers to one of several definitions behind one
 * type (one OAuth flow), or narrows a mapped type: its own fields must match
 * the definition it names. Presence and required-ness first, then the kind of
 * every field it declares, as ordinary fields are compared (no allowlist
 * applies); no field may be `never` (a narrowing that contradicts the type it
 * narrows).
 */
function referenceProblems(
  ctx: ParityContext,
  label: string,
  definitions: readonly string[],
  shape: TypeShape,
): string[] {
  const problems: string[] = [];
  const target = fieldsOfDefinitions(ctx, definitions);
  const missing = sorted(target.properties).filter((name) => !shape.properties.has(name));
  if (missing.length > 0) problems.push(`${label} lacks field(s) the definition defines: ${missing.join(', ')}`);
  const stricter = sorted(shape.properties.keys()).filter(
    (name) => shape.properties.get(name)!.required && !target.required.has(name),
  );
  if (stricter.length > 0) {
    problems.push(`${label} requires field(s) the definition leaves optional: ${stricter.join(', ')}`);
  }
  const looser = sorted(target.required).filter((name) => shape.properties.get(name)?.required === false);
  if (looser.length > 0) {
    problems.push(`${label} leaves optional field(s) the definition requires: ${looser.join(', ')}`);
  }
  for (const name of sorted(shape.properties.keys())) {
    const actual = shape.properties.get(name)!.kind;
    if (actual === 'never') {
      problems.push(
        `${label} declares ${name} as never, so it can hold no value: the narrowing contradicts the type it narrows`,
      );
      continue;
    }
    // One type stands for every definition behind it, so it may declare fields this one lacks.
    if (!target.properties.has(name)) continue;
    const expected = fieldKind(ctx, definitions, name);
    if (!('skip' in expected) && expected.kind !== actual) {
      problems.push(`${label} declares ${name} as ${actual}, but the definition says ${expected.kind}`);
    }
  }
  return problems;
}

/** Compare one value's kind; `field` is `[key]` for a map's values. */
function kindProblems(
  ctx: ParityContext,
  mapping: ObjectMapping,
  field: string,
  expected: SchemaKind | SkippedKind,
  actual: Pick<PropertyShape, 'kind' | 'refs'>,
): string[] {
  if ('skip' in expected) return [];
  const problems: string[] = [];
  const allowed = ctx.version.kindDeviations.some(
    (d) => d.type === mapping.type && d.field === field && d.typeKind === actual.kind,
  );
  if (expected.kind !== actual.kind && !allowed) {
    problems.push(
      `${where(ctx, mapping)}: ${field} holds ${actual.kind} in the type, but the official schema says ${expected.kind} (fix the type, or allowlist it in kindDeviations with a reason)`,
    );
  }
  // A reference to one of several definitions behind one type (one OAuth
  // flow), or a narrowed reference: the value's own fields must match the
  // definition it names. A value that may be any of several definitions of the
  // same type (a response `schema` is a `schema` or a `fileSchema`) must match
  // any of them.
  const definitionsByType = new Map<string, string[]>();
  for (const { definition, type } of expected.refs) {
    definitionsByType.set(type, [...(definitionsByType.get(type) ?? []), definition]);
  }
  for (const [type, definitions] of definitionsByType) {
    const ref = actual.refs.find((candidate) => candidate.type === type);
    if (!ref || (ref.exact && !ctx.multiDefinition.has(type))) continue;
    const label = `${where(ctx, mapping)}: ${field} (${definitions.join(' | ')})`;
    problems.push(...referenceProblems(ctx, label, definitions, ref.shape()));
  }
  return problems;
}

/** All problems with one object type: missing, extra and required-ness of fields, their value kinds, and its shape. */
function objectProblems(ctx: ParityContext, mapping: ObjectMapping): string[] {
  const fields = fieldsOf(ctx, mapping);
  const shape = ctx.view.shape(mapping.type);
  const problems: string[] = [];

  const missing = sorted(fields.properties).filter((name) => !shape.properties.has(name));
  if (missing.length > 0) {
    problems.push(`${where(ctx, mapping)}: missing field(s) the official schema defines: ${missing.join(', ')}`);
  }
  problems.push(...fieldProblems(ctx, mapping, fields, shape));
  for (const field of sorted(fields.properties)) {
    const property = shape.properties.get(field);
    if (property) {
      problems.push(...kindProblems(ctx, mapping, field, fieldKind(ctx, mapping.definitions, field), property));
    }
  }
  if (fields.dynamicKeys.size > 0) {
    problems.push(
      `${where(ctx, mapping)}: the schema also accepts keys by pattern (${sorted(fields.dynamicKeys).join('; ')}); compare it as a map instead`,
    );
  }
  if (shape.stringIndex) {
    problems.push(
      `${where(ctx, mapping)}: the type has a string index signature, but the schema allows fixed fields only`,
    );
  }
  return problems;
}

/** The value-kind check's verdict for every field of every mapped object, and every map's values. */
const kindVerdicts = (ctx: ParityContext): Array<{ name: string; expected: SchemaKind | SkippedKind }> => [
  ...ctx.version.objects.flatMap((mapping) => {
    const fields = fieldsOf(ctx, mapping);
    return sorted(fields.properties).map((field) => ({
      name: `${mapping.type}.${field}`,
      expected: fieldKind(ctx, mapping.definitions, field),
    }));
  }),
  ...ctx.version.maps.map((mapping) => ({
    name: `${mapping.type}.[key]`,
    expected: mapValueKind(ctx, fieldsOf(ctx, mapping)),
  })),
];

// ---------------------------------------------------------------------------
// `x-` keys in map objects
// ---------------------------------------------------------------------------

/** One value of each JSON type; a map object's `x-` keys are given each in turn. */
const ARBITRARY_VALUES: unknown[] = ['Pets', 1, true, null, [1, 'a'], { label: 'Pets' }];

/** What the official schema and the type checker say about an `x-label` key in one map object. */
interface ExtensionProbe {
  /**
   * The value (as JSON) no value of the map can be, given to `x-label` and to
   * the map's own first key; `undefined` when the map holds any value.
   */
  foreign: string | undefined;
  schema: {
    /** The probe document without an `x-` key validates (so the document itself is sound). */
    control: boolean;
    /** It validates with `x-label` holding the map's own value type. */
    typed: boolean;
    /** The arbitrary values (as JSON) `x-label` may hold. */
    accepted: string[];
    /** It validates with the foreign value as the value of the map's own first key (it must not). */
    ownKeyForeign: boolean;
  };
  type: {
    /** The map type accepts the entries without an `x-` key. */
    control: boolean;
    /** It accepts `x-label` holding its own value type. */
    typed: boolean;
    /** It accepts `x-label` holding the foreign value (`'Pets'` where the map holds anything). */
    arbitrary: boolean;
    /** It accepts the foreign value as the value of its own first key (`'/pets': 'Pets'`), which the schema rejects. */
    ownKeyForeign: boolean;
  };
}

const PROBE_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

/** The value no value of the map can be: `'Pets'` unless the probe says otherwise. */
const foreignOf = (probe: MapProbe): unknown => (probe.foreign === undefined ? 'Pets' : probe.foreign);

/** The entries with `value` as the value of the first key. */
const ownKeyWith = (entries: object, value: unknown): object => ({ ...entries, [Object.keys(entries)[0]!]: value });

/** Whether the official schema of `version` accepts a document holding `entries` in the map object `type`. */
function schemaAccepts(version: VersionCase, type: string, entries: object): { valid: boolean; errors: string[] } {
  const document = { ...version.probeRoot, ...probeOf(version, type).place(entries) };
  return validateOasDocument(version.version, document);
}

const probeOf = (version: VersionCase, type: string): MapProbe => {
  const probe = version.probes[type];
  if (!probe) throw new Error(`${version.version} ${type}: add a probe to its probes table`);
  return probe;
};

/** A probe: the span of the virtual source holding it, and what it is about. */
interface Span<Subject> {
  subject: Subject;
  start: number;
  end: number;
}

/**
 * Compiles the virtual module `source` (with the real compiler, against `src/spec`) and returns the spans that
 * hold a diagnostic: the probes the type checker rejects.
 */
function rejectedSpans<Subject>(fileName: string, source: string, spans: Array<Span<Subject>>): Set<Span<Subject>> {
  const diagnostics = compileVirtual(fileName, source, { baseDir: __dirname, compilerOptions: PROBE_COMPILER_OPTIONS });
  // compileVirtual prints `<file>:<offset> <message>`; other files' diagnostics have a test of their own.
  const prefix = `${resolve(__dirname, fileName)}:`;
  const rejected = new Set<Span<Subject>>();
  const unattributed: string[] = [];
  for (const diagnostic of diagnostics.filter((entry) => entry.startsWith(prefix))) {
    const offset = Number(/^\d+/.exec(diagnostic.slice(prefix.length))?.[0] ?? -1);
    const span = spans.find(({ start, end }) => offset >= start && offset < end);
    if (span) rejected.add(span);
    else unattributed.push(diagnostic);
  }
  // A diagnostic outside the probes means the harness itself is broken (a bad import, a compiler option).
  if (unattributed.length > 0) throw new Error(`${fileName}: ${unattributed.join('; ')}`);
  return rejected;
}

/** Per map type of `version`: whether the type checker accepts each probe (one virtual file, a `const check: T` each). */
function typeAccepts(version: VersionCase): Map<string, ExtensionProbe['type']> {
  let source = `import type { ${version.namespace} } from '../src/spec';\n`;
  const spans: Array<Span<{ type: string; kind: keyof ExtensionProbe['type'] }>> = [];
  for (const { type } of version.maps) {
    const probe = probeOf(version, type);
    const foreign = foreignOf(probe);
    const cases: Array<[keyof ExtensionProbe['type'], object | undefined]> = [
      ['control', {}],
      ['typed', { 'x-label': probe.typed }],
      ['arbitrary', { 'x-label': foreign }],
      // a map that holds anything has no value of its own to get wrong
      ['ownKeyForeign', probe.holdsAnything ? undefined : ownKeyWith(probe.entries, foreign)],
    ];
    for (const [kind, extra] of cases) {
      if (extra === undefined) continue;
      const start = source.length;
      const name = `${type}_${kind}`;
      source += `const value_${name} = ${JSON.stringify({ ...probe.entries, ...extra })};\n`;
      source += `const check_${name}: ${version.namespace}.${type} = value_${name};\n`;
      spans.push({ subject: { type, kind }, start, end: source.length });
    }
  }
  const rejected = rejectedSpans(`extension-keys-${version.version}.ts`, source, spans);
  return new Map(
    version.maps.map(({ type }) => {
      const accepted = (kind: keyof ExtensionProbe['type']): boolean => {
        const span = spans.find(({ subject }) => subject.type === type && subject.kind === kind);
        return span !== undefined && !rejected.has(span);
      };
      return [
        type,
        {
          control: accepted('control'),
          typed: accepted('typed'),
          arbitrary: accepted('arbitrary'),
          ownKeyForeign: accepted('ownKeyForeign'),
        },
      ];
    }),
  );
}

const probedExtensionKeys = new Map<string, Map<string, ExtensionProbe>>();

/** The probes of every map object of `version`, computed once. */
function probeExtensionKeys(version: VersionCase): Map<string, ExtensionProbe> {
  let probes = probedExtensionKeys.get(version.version);
  if (!probes) {
    const typeSide = typeAccepts(version);
    probes = new Map(
      version.maps.map(({ type }) => {
        const probe = probeOf(version, type);
        const control = schemaAccepts(version, type, probe.entries);
        const typed = schemaAccepts(version, type, { ...probe.entries, 'x-label': probe.typed });
        const accepted = ARBITRARY_VALUES.filter(
          (value) => schemaAccepts(version, type, { ...probe.entries, 'x-label': value }).valid,
        ).map((value) => JSON.stringify(value));
        const ownKeyForeign = probe.holdsAnything
          ? false
          : schemaAccepts(version, type, ownKeyWith(probe.entries, foreignOf(probe))).valid;
        return [
          type,
          {
            foreign: probe.holdsAnything ? undefined : JSON.stringify(foreignOf(probe)),
            schema: { control: control.valid, typed: typed.valid, accepted, ownKeyForeign },
            type: typeSide.get(type)!,
          },
        ];
      }),
    );
    probedExtensionKeys.set(version.version, probes);
  }
  return probes;
}

/** Whether the official schema lets an `x-` key in the map object hold every arbitrary value. */
const acceptsAnyExtension = (probe: ExtensionProbe): boolean =>
  probe.schema.accepted.length === ARBITRARY_VALUES.length;

// ---------------------------------------------------------------------------
// Primitives are not objects
// ---------------------------------------------------------------------------

/**
 * One value of each JSON type that is not an object: no OpenAPI object type
 * accepts any of them (`declaration` is its type in the virtual module).
 */
const PRIMITIVES = [
  { name: 'a string', declaration: "'x'" },
  { name: 'a number', declaration: '1' },
  { name: 'a boolean', declaration: 'true' },
  { name: 'an array', declaration: 'never[]' },
] as const;

const primitiveProbes = new Map<string, Map<string, string[]>>();

/**
 * Per type the namespace of `version` exports: the names of the `PRIMITIVES`
 * the type checker accepts as a value of it (one virtual file, one
 * `const check: T = primitive` per type and primitive).
 */
function primitiveAccepts(version: VersionCase): Map<string, string[]> {
  let accepts = primitiveProbes.get(version.version);
  if (!accepts) {
    const names = types.typeNames(version.namespace);
    let source = `import type { ${version.namespace} } from '../src/spec';\n`;
    PRIMITIVES.forEach(({ declaration }, index) => {
      source += `declare const primitive_${index}: ${declaration};\n`;
    });
    const spans: Array<Span<{ type: string; primitive: string }>> = [];
    for (const type of names) {
      PRIMITIVES.forEach(({ name }, index) => {
        const start = source.length;
        source += `const check_${type}_${index}: ${version.namespace}.${type} = primitive_${index};\n`;
        spans.push({ subject: { type, primitive: name }, start, end: source.length });
      });
    }
    const rejected = rejectedSpans(`primitives-${version.version}.ts`, source, spans);
    accepts = new Map(
      names.map((type) => [
        type,
        spans
          .filter((span) => span.subject.type === type && !rejected.has(span))
          .map((span) => span.subject.primitive),
      ]),
    );
    primitiveProbes.set(version.version, accepts);
  }
  return accepts;
}

// ---------------------------------------------------------------------------
// The sources and the boundary
// ---------------------------------------------------------------------------

describe('story: the parity sources', () => {
  it('verifies the vendored schemas against their pinned checksums', () => {
    const result = spawnSync(process.execPath, ['scripts/sync-oas-sources.mjs'], { cwd: repoRoot, encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toMatch(/^\d+ sources verified$/m);
  });

  it('reads the JSON Schema 2020-12 meta-schemas from their pinned copies', () => {
    expect(sorted(jsonSchema2020Sources().map((source) => source.label))).toEqual(sorted(JSON_SCHEMA_2020_FILES));
  });

  it('reads the JSON Schema draft-04 meta-schema from its pinned copy', () => {
    expect(sorted(jsonSchemaDraft04Sources().map((source) => source.label))).toEqual(
      sorted(JSON_SCHEMA_DRAFT_04_FILES),
    );
  });

  it('compiles the spec types with zero diagnostics', () => {
    expect(types.diagnostics()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Swagger 2.0 documents against the official schema (e2e/helpers/oas-validate.ts)
// ---------------------------------------------------------------------------

describe('story: the official Swagger 2.0 schema validates the 2.0 documents of the repository', () => {
  /** The YAML files of a folder under e2e/fixtures, as fixture paths. */
  const yamlIn = (dir: string): string[] =>
    readdirSync(fixturePath(dir))
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map((name) => `${dir}/${name}`);

  const load = (file: string): Record<string, unknown> =>
    (file.endsWith('.json') ? JSON.parse(loadFixture(file)) : yaml.parse(loadFixture(file))) as Record<string, unknown>;

  const OFFICIAL = yamlIn('oas/documents/2.0/pass');
  const SUPPLEMENTARY = yamlIn('supplementary/2.0/pass');
  /** The files of the multi-file `petstore-separate` tree that are not documents (its root is `swagger.yaml`). */
  const FRAGMENTS = [
    'oas/documents/2.0/pass/petstore-separate/common/Error.yaml',
    'oas/documents/2.0/pass/petstore-separate/spec/NewPet.yaml',
    'oas/documents/2.0/pass/petstore-separate/spec/Pet.yaml',
    'oas/documents/2.0/pass/petstore-separate/spec/parameters.yaml',
  ];

  it('holds the whole documents of the official examples, and the fixtures the 2.0 stories read', () => {
    // the seven single-file examples and the root of `petstore-separate` (the README counts eight whole documents)
    expect(OFFICIAL).toHaveLength(7);
    expect(SUPPLEMENTARY.length).toBeGreaterThan(0);
  });

  it.each([
    ...OFFICIAL,
    'oas/documents/2.0/pass/petstore-separate/spec/swagger.yaml',
    'netlify-trimmed-2.0.json',
    'supplementary/equivalence/swagger-2.0.yaml',
    'supplementary/equivalence/swagger-2.0-split/swagger.yaml',
    ...SUPPLEMENTARY,
  ])('validates %s', (file) => {
    expect(validateOasDocument('2.0', load(file))).toEqual({ valid: true, errors: [] });
  });

  it.each(FRAGMENTS)('rejects %s, a fragment of a multi-file description and not a document', (file) => {
    const { valid, errors } = validateOasDocument('2.0', load(file));
    expect(valid).toBe(false);
    expect(errors).toContainEqual(expect.stringContaining("required property 'swagger'"));
  });

  /**
   * The documents under `supplementary/2.0/invalid` break the 2.0 specification; what the official schema says
   * about each is a fact of the schema, pinned here (every file needs a row).
   */
  const INVALID: Record<string, { schemaAccepts: boolean; why: string }> = {
    'path-parameter-not-required': {
      schemaAccepts: false,
      why: 'a path parameter must say `required: true`: the schema allows no other value for `in: path` (`pathParameterSubSchema`)',
    },
    // Invalid by the TEXT only. The schema checks each parameter alone (`parameter` is a `oneOf` over ONE parameter),
    // so it cannot see "form parameters cannot be declared together with a body parameter for the same operation".
    // A document that mixes the two validates, which is why this verdict is pinned and not assumed.
    'body-and-form-data': {
      schemaAccepts: true,
      why: 'the rule is across the parameters of one operation, which the schema cannot express',
    },
  };

  it('lists a verdict for every document under supplementary/2.0/invalid', () => {
    expect(yamlIn('supplementary/2.0/invalid').map((file) => basename(file, '.yaml'))).toEqual(
      sorted(Object.keys(INVALID)),
    );
  });

  it.each(Object.entries(INVALID))('gives its own verdict on the invalid document %s', (name, { schemaAccepts }) => {
    const { valid } = validateOasDocument('2.0', load(`supplementary/2.0/invalid/${name}.yaml`));
    expect(valid).toBe(schemaAccepts);
  });

  describe('rejects a document that breaks the schema (the helper checks something)', () => {
    const minimal = (): Record<string, any> => load('oas/documents/2.0/pass/petstore-minimal.yaml');
    const withOperation = (operation: object): object => ({
      ...minimal(),
      paths: { '/pets': { get: { responses: { '200': { description: 'ok' } }, ...operation } } },
    });

    it.each([
      ['a missing info', () => ({ ...minimal(), info: undefined })],
      ['a version that is not 2.0', () => ({ ...minimal(), swagger: '2.1' })],
      ['a field of the root the schema does not define', () => ({ ...minimal(), servers: [] })],
      ['a host with a path', () => ({ ...minimal(), host: 'example.com/api' })],
      ['a scheme the schema does not list', () => ({ ...minimal(), schemes: ['ftp'] })],
      ['a response without a description', () => withOperation({ responses: { '200': {} } })],
      [
        'a cookie parameter, which 2.0 does not have',
        () => withOperation({ parameters: [{ name: 'session', in: 'cookie', type: 'string' }] }),
      ],
      [
        'a query parameter of type file (only formData may)',
        () => withOperation({ parameters: [{ name: 'upload', in: 'query', type: 'file' }] }),
      ],
      [
        'a body parameter without a schema',
        () => withOperation({ parameters: [{ name: 'pet', in: 'body', required: true }] }),
      ],
    ])('%s', (_, build) => {
      expect(validateOasDocument('2.0', build()).valid).toBe(false);
    });

    it('accepts a specification extension on the root, and checks no format (`validateFormats: false`)', () => {
      expect(validateOasDocument('2.0', { ...minimal(), 'x-internal': { anything: [1, 'a'] } }).valid).toBe(true);
      // `format: email` is an assertion in draft-04, so a validator with ajv-formats would refuse this
      const info = { ...minimal()['info'], contact: { email: 'not an email', url: 'not a url' } };
      expect(validateOasDocument('2.0', { ...minimal(), info }).valid).toBe(true);
    });
  });

  describe('the helper itself', () => {
    it('registers the pinned draft-04 meta-schema, and both it and the 2.0 schema are valid draft-04 schemas', () => {
      expect(swagger2SchemasAreDraft04()).toEqual({ schema: true, metaSchema: true });
    });

    const tolerated = 'strict mode: "additionalItems" is ignored when "items" is not an array of schemas';

    it('tolerates the one strict-mode complaint of the official schema, however often Ajv logs it', () => {
      expect(() => rejectUntoleratedWarnings([tolerated, tolerated, tolerated])).not.toThrow();
      expect(() => rejectUntoleratedWarnings([])).not.toThrow();
    });

    it.each([
      ['an unknown keyword', 'strict mode: unknown keyword: "nullable"'],
      ['an unknown format', 'unknown format "uri" ignored in schema at path "#/properties/url"'],
      ['an error', 'error: schema is invalid'],
    ])('throws on %s among the messages', (_, message) => {
      expect(() => rejectUntoleratedWarnings([tolerated, message])).toThrow(
        /strict-mode complaints beyond the tolerated one/,
      );
    });

    it('keeps validating the 3.x versions with their own schemas', () => {
      const openapi = { info: { title: 'Probe', version: '1' }, paths: {} };
      expect(validateOasDocument('3.0', { openapi: '3.0.0', ...openapi }).valid).toBe(true);
      expect(validateOasDocument('3.1', { openapi: '3.1.0', ...openapi }).valid).toBe(true);
      expect(validateOasDocument('3.2', { openapi: '3.2.0', ...openapi }).valid).toBe(true);
      // a 2.0 document is not an OpenAPI 3 document, and the reverse
      expect(validateOasDocument('3.0', load('oas/documents/2.0/pass/petstore-minimal.yaml')).valid).toBe(false);
      expect(validateOasDocument('2.0', { openapi: '3.0.0', ...openapi }).valid).toBe(false);
    });
  });
});

/**
 * The references of one file under `specDir` that break the spec layer boundary
 * (`file` is its path relative to `specDir`), and how many references it has.
 */
function boundaryProblems(specDir: string, file: string, text: string): { problems: string[]; references: number } {
  const path = join(specDir, file);
  const references = moduleSpecifiers(path, text);
  const problems: string[] = [];
  for (const reference of references) {
    const at = `src/spec/${file}:${reference.line} ${reference.form} '${reference.specifier}'`;
    if (!reference.constant) {
      problems.push(
        `${at}: the module is not named by a constant string, so it cannot be proven to stay inside src/spec`,
      );
      continue;
    }
    if (['reference types', 'reference lib', 'declare module'].includes(reference.form)) {
      problems.push(`${at}: brings in declarations from outside src/spec`);
      continue;
    }
    const isRelative = /^\.\.?\//.test(reference.specifier);
    if (!isRelative && reference.form !== 'reference path') {
      problems.push(`${at}: not a relative path, so it names a package or a Node built-in`);
      continue;
    }
    if (relative(specDir, resolve(dirname(path), reference.specifier)).startsWith('..')) {
      problems.push(`${at}: resolves outside src/spec`);
    }
  }
  return { problems, references: references.length };
}

describe('story: the spec layer boundary', () => {
  it('refers to no module outside src/spec', () => {
    const specDir = join(repoRoot, 'src', 'spec');
    const files = readdirSync(specDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .sort();
    const problems: string[] = [];
    let references = 0;
    for (const file of files) {
      const checked = boundaryProblems(specDir, file, readFileSync(join(specDir, file), 'utf8'));
      problems.push(...checked.problems);
      references += checked.references;
    }
    expect(problems).toEqual([]);
    // The spec layer's own modules import each other; finding none means the collector is broken.
    expect(references).toBeGreaterThan(0);
  });

  describe('the collector', () => {
    /** Every form that names a module, a constant template literal and a computed specifier included. */
    const SNIPPET = [
      '/// <reference path="./reference.d.ts" />',
      '/// <reference types="node" />',
      '/// <reference lib="dom" />',
      "import a from './import';",
      "import type { B } from './import-type';",
      "export * from './export-star';",
      "export { d } from './export-named';",
      'export const local = 1;',
      "import e = require('./import-equals');",
      "type T = import('./type').T;",
      'type U = import(`./type-template`).U;',
      "const f = import('./call');",
      'const g = import(`./call-template`);',
      "const h = require('./require');",
      'const i = require(`./require-template`);',
      "declare module 'ambient' {}",
      'const j = import(name);',
      'const k = import(`./${name}`);',
      'const l = require(name);',
      'const m = require(`./${name}`);',
      "const n = require('./' + name);",
      'type V = import(`./${string}`).V;',
    ].join('\n');

    it('lists every module a file refers to, constant template literals included', () => {
      expect(
        moduleSpecifiers('snippet.ts', SNIPPET).map(({ form, specifier, constant, line }) => ({
          form,
          specifier,
          constant,
          line,
        })),
      ).toEqual([
        { form: 'import', specifier: './import', constant: true, line: 4 },
        { form: 'import', specifier: './import-type', constant: true, line: 5 },
        { form: 'export', specifier: './export-star', constant: true, line: 6 },
        { form: 'export', specifier: './export-named', constant: true, line: 7 },
        { form: 'import = require()', specifier: './import-equals', constant: true, line: 9 },
        { form: 'import() type', specifier: './type', constant: true, line: 10 },
        { form: 'import() type', specifier: './type-template', constant: true, line: 11 },
        { form: 'import()', specifier: './call', constant: true, line: 12 },
        { form: 'import()', specifier: './call-template', constant: true, line: 13 },
        { form: 'require()', specifier: './require', constant: true, line: 14 },
        { form: 'require()', specifier: './require-template', constant: true, line: 15 },
        { form: 'declare module', specifier: 'ambient', constant: true, line: 16 },
        { form: 'import()', specifier: 'name', constant: false, line: 17 },
        { form: 'import()', specifier: '`./${name}`', constant: false, line: 18 },
        { form: 'require()', specifier: 'name', constant: false, line: 19 },
        { form: 'require()', specifier: '`./${name}`', constant: false, line: 20 },
        { form: 'require()', specifier: "'./' + name", constant: false, line: 21 },
        { form: 'import() type', specifier: '`./${string}`', constant: false, line: 22 },
        { form: 'reference path', specifier: './reference.d.ts', constant: true, line: 1 },
        { form: 'reference types', specifier: 'node', constant: true, line: 2 },
        { form: 'reference lib', specifier: 'dom', constant: true, line: 3 },
      ]);
    });

    const specDir = '/virtual/src/spec';
    const problemsOf = (code: string): string[] => boundaryProblems(specDir, 'snippet.ts', code).problems;

    it.each([
      ['import(`ajv`)', 'const a = import(`ajv`);'],
      ['require(`fs`)', 'const a = require(`fs`);'],
      ['import(`ajv`) as a type', 'type A = import(`ajv`).A;'],
      ['import x = require(`fs`)', 'import x = require(`fs`);'],
      ["import('ajv')", "const a = import('ajv');"],
    ])('fails on a package named by %s', (_, code) => {
      expect(problemsOf(code)).toEqual([expect.stringContaining('not a relative path')]);
    });

    it.each([
      ['import(`../outside`)', 'const a = import(`../outside`);'],
      ['require(`../../outside`)', 'const a = require(`../../outside`);'],
    ])('fails on a relative path out of src/spec named by %s', (_, code) => {
      expect(problemsOf(code)).toEqual([expect.stringContaining('resolves outside src/spec')]);
    });

    it.each([
      ['import(x)', 'const a = import(name);'],
      ['import(`./${x}`)', 'const a = import(`./${name}`);'],
      ['require(x)', 'const a = require(name);'],
      ['require(`./${x}`)', 'const a = require(`./${name}`);'],
      ["require('./' + x)", "const a = require('./' + name);"],
      ['import(`./${string}`) as a type', 'type A = import(`./${string}`).A;'],
    ])('fails on a module named by %s, which cannot be proven to stay inside', (_, code) => {
      expect(problemsOf(code)).toEqual([expect.stringContaining('not named by a constant string')]);
    });

    it('accepts relative paths inside src/spec, however they are written', () => {
      const code = [
        "import a from './a';",
        'const b = import(`./nested/b`);',
        'const c = require(`../spec/c`);',
        'type D = import(`./d`).D;',
      ].join('\n');
      expect(boundaryProblems(specDir, 'snippet.ts', code)).toEqual({ problems: [], references: 4 });
    });
  });
});

// ---------------------------------------------------------------------------
// A narrowed reference is compared with its definition
// ---------------------------------------------------------------------------

describe('story: a narrowed reference holds the kinds of the definition it narrows to', () => {
  const flowsMapping = OAS31.objects.find((mapping) => mapping.type === 'OAuthFlowsObject')!;
  const v31 = JSON.stringify(join(repoRoot, 'src/spec/types/v3_1'));
  const common = JSON.stringify(join(repoRoot, 'src/spec/types/common'));

  /**
   * The problems the object comparison finds for 3.1 `OAuthFlowsObject` when
   * the 3.1 types are re-exported from a temp module with `implicit` declared
   * as given and, when `flow` is given, `OAuthFlowObject` replaced.
   */
  function overlaidProblems({ implicit, flow }: { implicit: string; flow?: string }): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'spec-types-overlay-'));
    try {
      writeFileSync(
        join(dir, 'v3_1.ts'),
        [
          `import type { SpecMap } from ${common};`,
          flow === undefined
            ? `import type { OAuthFlowObject } from ${v31};`
            : `export type OAuthFlowObject = ${flow};`,
          // The local exports below take precedence over the same names re-exported here.
          `export type * from ${v31};`,
          'export type OAuthFlowsObject = {',
          `  implicit?: ${implicit};`,
          '  password?: OAuthFlowObject & { tokenUrl: string };',
          '  clientCredentials?: OAuthFlowObject & { tokenUrl: string };',
          '  authorizationCode?: OAuthFlowObject & { authorizationUrl: string; tokenUrl: string };',
          '};',
          'export type Unused = SpecMap<string>;',
        ].join('\n'),
      );
      writeFileSync(join(dir, 'index.ts'), "export type * as OAS31 from './v3_1';\n");
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ extends: join(repoRoot, 'src/spec/tsconfig.json'), compilerOptions: { rootDir: null } }),
      );
      const reader = new SpecTypeReader(join(dir, 'index.ts'), join(dir, 'tsconfig.json'));
      return objectProblems(buildContext(OAS31, reader), flowsMapping);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('finds nothing wrong with a faithful overlay (the harness itself is sound)', () => {
    expect(overlaidProblems({ implicit: 'OAuthFlowObject & { authorizationUrl: string }' })).toEqual([]);
  });

  it('fails a refinement whose field cannot hold what the definition says (`authorizationUrl: number`)', () => {
    expect(overlaidProblems({ implicit: 'OAuthFlowObject & { authorizationUrl: number }' })).toEqual([
      expect.stringMatching(
        /OAuthFlowsObject: implicit \(schema\.json#\/\$defs\/oauth-flows\/\$defs\/implicit\) declares authorizationUrl as never/,
      ),
    ]);
  });

  it('fails a narrowing of a field the definition does not define whose type is never (`tokenUrl?: number`)', () => {
    // The Implicit flow has no `tokenUrl`, so no definition kind exists to compare: only the `never` is a sign of it.
    expect(overlaidProblems({ implicit: 'OAuthFlowObject & { authorizationUrl: string; tokenUrl?: number }' })).toEqual(
      [
        expect.stringMatching(
          /implicit \(schema\.json#\/\$defs\/oauth-flows\/\$defs\/implicit\) declares tokenUrl as never/,
        ),
      ],
    );
  });

  it('fails a field of the narrowed type whose kind differs from the definition (`refreshUrl` as number)', () => {
    const flow = '{ authorizationUrl?: string; tokenUrl?: string; refreshUrl?: number; scopes: SpecMap<string> }';
    const problems = overlaidProblems({ implicit: 'OAuthFlowObject & { authorizationUrl: string }', flow });
    expect(problems).toContainEqual(
      expect.stringMatching(
        /OAuthFlowsObject: implicit \(schema\.json#\/\$defs\/oauth-flows\/\$defs\/implicit\) declares refreshUrl as number, but the definition says string/,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Each version
// ---------------------------------------------------------------------------

describe.each(VERSIONS)('story: $label schema-to-types parity', (version) => {
  const mappings = mappingsOf(version);

  let ctx: ParityContext;

  beforeAll(() => {
    ctx = buildContext(version, types);
  });

  it(`reads every OpenAPI JSON Schema document the manifest pins for ${version.version}`, () => {
    expect(sorted(ctx.entries.map((entry) => entry.kind))).toEqual(sorted(version.kinds));
  });

  it('maps every schema definition to a type or lists it as unmapped with a reason', () => {
    const declared = ctx.registry.definitions(ctx.labels);
    const mapped = mappings.flatMap((mapping) => mapping.definitions);
    const classified = [...mapped, ...Object.keys(version.unmapped)];
    const problems: string[] = [];

    const unclassified = declared.filter((definition) => !classified.includes(definition));
    if (unclassified.length > 0) {
      problems.push(
        `${version.version}: definition(s) neither mapped to a type nor listed as unmapped: ${unclassified.join(', ')}`,
      );
    }
    const unknown = classified.filter((definition) => !declared.includes(definition));
    if (unknown.length > 0) {
      problems.push(
        `${version.version}: mapped or unmapped definition(s) the schemas do not declare: ${unknown.join(', ')}`,
      );
    }
    const twice = classified.filter((definition, index) => classified.indexOf(definition) !== index);
    if (twice.length > 0) {
      problems.push(`${version.version}: definition(s) classified more than once: ${twice.join(', ')}`);
    }
    const unexplained = Object.keys(version.unmapped).filter(
      (definition) => version.unmapped[definition]!.trim() === '',
    );
    if (unexplained.length > 0) {
      problems.push(`${version.version}: unmapped definition(s) without a reason: ${unexplained.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  it(`compares every type ${version.namespace} exports`, () => {
    const exported = types.typeNames(version.namespace);
    const compared = mappings.map((mapping) => mapping.type);
    const accounted = [...compared, ...Object.keys(version.unmappedTypes)];
    const problems: string[] = [];

    const unchecked = exported.filter((name) => !accounted.includes(name));
    if (unchecked.length > 0) {
      problems.push(
        `${version.namespace}: exported type(s) compared with no schema definition: ${unchecked.join(', ')} (map each to its definition, or list it in unmappedTypes with a reason)`,
      );
    }
    const missing = accounted.filter((name) => !exported.includes(name));
    if (missing.length > 0) {
      problems.push(`${version.namespace}: mapped type(s) it does not export: ${missing.join(', ')}`);
    }
    const twice = compared.filter((name, index) => compared.indexOf(name) !== index);
    if (twice.length > 0) {
      problems.push(`${version.namespace}: type(s) mapped more than once: ${twice.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });

  it.each(version.objects)('$type declares exactly the fields of its schema definitions', (mapping) => {
    expect(objectProblems(ctx, mapping)).toEqual([]);
  });

  it.each(version.maps)('$type is a string-index map, as its schema definitions are', (mapping) => {
    const fields = fieldsOf(ctx, mapping);
    const shape = ctx.view.shape(mapping.type);
    const problems: string[] = [];

    if (fields.dynamicKeys.size === 0) {
      problems.push(`${where(ctx, mapping)}: the schema allows fixed fields only; compare it as an object instead`);
    }
    if (!shape.stringIndex) {
      problems.push(
        `${where(ctx, mapping)}: the schema keys it by pattern (${sorted(fields.dynamicKeys).join('; ')}), but the type has no string index signature`,
      );
    }
    const fixed = sorted(fields.properties);
    if (fixed.join() !== sorted(mapping.fixedKeys).join()) {
      problems.push(
        `${where(ctx, mapping)}: the schema's fixed fields are [${fixed.join(', ')}], expected [${sorted(mapping.fixedKeys).join(', ')}]; check whether a new fixed field needs its own property, then update fixedKeys`,
      );
    }
    problems.push(...fieldProblems(ctx, mapping, fields, shape));
    problems.push(
      ...kindProblems(ctx, mapping, '[key]', mapValueKind(ctx, fields), {
        kind: formatKind(shape.indexAtoms),
        refs: [],
      }),
    );
    expect(problems).toEqual([]);
  });

  const { compared, skipped: skips } = version.kindCoverage;
  it(`compares the value kind of ${compared} fields and skips ${skips.length}`, () => {
    const verdicts = kindVerdicts(ctx);
    const skipped = verdicts.flatMap(({ name, expected }) => ('skip' in expected ? [`${name}: ${expected.skip}`] : []));
    const skippedNames = skipped.map((entry) => entry.slice(0, entry.indexOf(': ')));
    // On a mismatch, `skipped` shows why each field is skipped.
    expect({ compared: verdicts.length - skipped.length, skippedNames, skipped }).toEqual({
      compared: version.kindCoverage.compared,
      skippedNames: version.kindCoverage.skipped,
      skipped: expect.any(Array),
    });
  });

  describe('x- keys in map objects', () => {
    it('pins which map objects the official schema lets hold any value under an `x-` key', () => {
      const probes = probeExtensionKeys(version);
      const problems: string[] = [];
      for (const [type, probe] of probes) {
        const { schema } = probe;
        if (!schema.control) problems.push(`${type}: the probe document is invalid even without an x- key`);
        if (!schema.typed) problems.push(`${type}: the schema rejects an x- key holding the map's own value type`);
        if (schema.ownKeyForeign) {
          problems.push(`${type}: the schema accepts ${probe.foreign} as the value of one of its own keys`);
        }
        // Without the exemption an `x-` key is one more key of the map: its value must still be the map's value type.
        if (!acceptsAnyExtension(probe) && probe.foreign !== undefined && schema.accepted.includes(probe.foreign)) {
          problems.push(
            `${type}: the schema accepts ${probe.foreign} under an x- key although it does not accept any value`,
          );
        }
      }
      expect(problems).toEqual([]);
      expect(sorted([...probes].filter(([, probe]) => acceptsAnyExtension(probe)).map(([type]) => type))).toEqual(
        sorted(version.anyExtensionValue),
      );
    });

    it('lists as a deviation each map type that cannot hold what its schema lets an `x-` key hold', () => {
      const probes = probeExtensionKeys(version);
      const problems: string[] = [];
      for (const mapping of version.maps) {
        const { type: typeSide, foreign } = probes.get(mapping.type)!;
        const at = where(ctx, mapping);
        const foreignText = foreign ?? '"Pets"';
        // The probes differ only in the value under `x-label`, so these two make a rejection below the value's.
        if (!typeSide.control) problems.push(`${at}: the type rejects the probe without an x- key`);
        if (!typeSide.typed) problems.push(`${at}: the type rejects an x- key holding its own value type`);
        const schemaAcceptsAny = version.anyExtensionValue.includes(mapping.type);
        const listed = isDeviation(version.extensionKeyDeviations, mapping.type, '^x-');
        if (typeSide.ownKeyForeign && !isDeviation(version.permissiveValues, mapping.type, '[key]')) {
          problems.push(
            `${at}: the type accepts ${foreignText} as the value of one of its own keys, which the schema rejects (close the gap, or list it in permissiveValues with a reason)`,
          );
        }
        if (schemaAcceptsAny && !typeSide.arbitrary && !listed) {
          problems.push(
            `${at}: the schema lets an x- key hold any value, but the type rejects { 'x-label': ${foreignText} } (allowlist it in extensionKeyDeviations with a reason)`,
          );
        }
        if (!schemaAcceptsAny && typeSide.arbitrary) {
          problems.push(`${at}: the type accepts { 'x-label': ${foreignText} }, which the official schema rejects`);
        }
      }
      expect(problems).toEqual([]);
    });
  });

  it(`rejects a string, a number, a boolean and an array as a value of every type ${version.namespace} exports`, () => {
    const problems: string[] = [];
    const accepts = primitiveAccepts(version);
    for (const [type, accepted] of accepts) {
      const allowed = version.acceptsPrimitives.find((deviation) => deviation.type === type)?.accepts ?? [];
      const unexpected = accepted.filter((name) => !allowed.includes(name));
      if (unexpected.length > 0) {
        problems.push(
          `${version.namespace}.${type} accepts ${unexpected.join(', ')}: a type made only of optional fields must still reject a primitive (a weak-type check is lost when the type is an intersection with an empty object type); fix the type, or list it in acceptsPrimitives with a reason`,
        );
      }
      const stale = allowed.filter((name) => !accepted.includes(name));
      if (stale.length > 0) {
        problems.push(
          `${version.namespace}.${type} no longer accepts ${stale.join(', ')}: remove it from acceptsPrimitives`,
        );
      }
    }
    for (const deviation of version.acceptsPrimitives) {
      if (!accepts.has(deviation.type)) problems.push(`acceptsPrimitives: ${deviation.type} is not exported`);
      if (deviation.reason.trim() === '') problems.push(`acceptsPrimitives: ${deviation.type} gives no reason`);
    }
    expect(problems).toEqual([]);
    // The probes cover every exported type, so one added to the namespace is checked without a line here.
    expect(sorted(accepts.keys())).toEqual(types.typeNames(version.namespace));
  });

  it('still needs every allowlisted deviation', () => {
    const problems: string[] = [];
    const check = (
      list: readonly Deviation[],
      listName: string,
      stillDeviates: (mapping: ObjectMapping, fields: ObjectFields, shape: TypeShape, deviation: Deviation) => boolean,
    ): void => {
      for (const deviation of list) {
        const mapping = mappings.find((candidate) => candidate.type === deviation.type);
        if (!mapping) {
          problems.push(`${version.version} ${listName}: ${deviation.type} is not a mapped type`);
          continue;
        }
        if (deviation.reason.trim() === '') {
          problems.push(`${where(ctx, mapping)}: ${listName} entry for ${deviation.field} gives no reason`);
        }
        if (!stillDeviates(mapping, fieldsOf(ctx, mapping), ctx.view.shape(deviation.type), deviation)) {
          problems.push(
            `${where(ctx, mapping)}: ${listName} entry for ${deviation.field} no longer applies; remove it`,
          );
        }
      }
    };
    check(
      version.extraFields,
      'extraFields',
      (_, fields, shape, { field }) => shape.properties.has(field) && !fields.properties.has(field),
    );
    check(
      version.stricterRequired,
      'stricterRequired',
      (_, fields, shape, { field }) => shape.properties.get(field)?.required === true && !fields.required.has(field),
    );
    check(
      version.looserRequired,
      'looserRequired',
      (_, fields, shape, { field }) => shape.properties.get(field)?.required === false && fields.required.has(field),
    );
    check(version.kindDeviations, 'kindDeviations', (mapping, _, shape, deviation) => {
      const property = shape.properties.get(deviation.field);
      const expected = fieldKind(ctx, mapping.definitions, deviation.field);
      const { typeKind } = deviation as KindDeviation;
      return property?.kind === typeKind && !('skip' in expected) && expected.kind !== typeKind;
    });
    check(version.extensionKeyDeviations, 'extensionKeyDeviations', (mapping, _, __, { field }) => {
      const probe = probeExtensionKeys(version).get(mapping.type);
      // A map type of this version, whose schema lets an `x-` key hold any value and whose type cannot.
      return field === '^x-' && probe !== undefined && acceptsAnyExtension(probe) && !probe.type.arbitrary;
    });
    check(version.permissiveValues, 'permissiveValues', (mapping, _, __, { field }) => {
      return field === '[key]' && probeExtensionKeys(version).get(mapping.type)?.type.ownKeyForeign === true;
    });
    expect(problems).toEqual([]);
  });
});
