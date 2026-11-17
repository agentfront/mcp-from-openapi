/**
 * Schema-to-types parity story: for every supported version, our OpenAPI
 * types (`src/spec/types`, namespaces `OAS30`/`OAS31`/`OAS32`) say what the
 * official OpenAPI Initiative JSON Schemas say, field by field.
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
 *   OAuth flow), the value's own required fields must match that definition.
 *   How many fields this covers, and which are skipped, is pinned per version.
 * - Map-like objects (Paths, Responses, Callback, Security Requirement) are
 *   string-index types whose values have the kind the schema states.
 * - The mapping is complete in both directions: every definition in every
 *   vendored OpenAPI schema document is mapped to a type or listed as
 *   unmapped with a reason, and every type a version namespace exports is
 *   compared.
 * - The vendored schemas match the checksums pinned in
 *   e2e/fixtures/oas/sources.json, and `src/spec` refers to no module outside
 *   itself.
 *
 * Schemas are read by e2e/helpers/oas-schema.ts, which follows only the
 * applicators that act on the object itself. The 3.1/3.2 Schema Object is
 * `$dynamicRef: #meta` in schema.json; its keywords come from schema-base.json,
 * which binds it to the OAS dialect: the JSON Schema 2020-12 vocabulary
 * meta-schemas (vendored under e2e/fixtures/oas/schemas/json-schema-2020-12)
 * plus the OAS base vocabulary (meta.json). Types are read with the real
 * TypeScript compiler.
 *
 * When OAI publishes a new schema iteration: re-vendor it
 * (`node scripts/sync-oas-sources.mjs --update`) and run this story. Each
 * failure names the version, the schema definition, the type and the exact
 * fields; fix the types, or record a deliberate deviation in the allowlist
 * with its reason.
 */
import { spawnSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
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
import { loadJsonFixture } from './helpers/fixtures';

const repoRoot = join(__dirname, '..');

/** A schema location: a vendored document's file name and a JSON Pointer. */
type Definition = string;

/** A type compared field by field with the definitions it stands for. */
interface ObjectMapping {
  type: string;
  /**
   * The definitions this type describes. With several, the type stands for
   * an instance of any of them: it must declare every field any of them
   * defines, and may require only what all of them require.
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

/** A field whose value kind deliberately differs from the schema's. */
interface KindDeviation extends Deviation {
  /** The kind the type declares (as the story prints it); any other kind still fails. */
  typeKind: string;
}

interface VersionCase {
  version: '3.0' | '3.1' | '3.2';
  namespace: 'OAS30' | 'OAS31' | 'OAS32';
  /** The manifest `kind`s that make up the version's OpenAPI schema. */
  kinds: string[];
  /** Whether the Schema Object dialect is built on the JSON Schema 2020-12 meta-schemas. */
  jsonSchema2020: boolean;
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

const OAS30: VersionCase = {
  version: '3.0',
  namespace: 'OAS30',
  kinds: ['schema'],
  jsonSchema2020: false,
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

const OAS31_FLOWS = ['implicit', 'password', 'client-credentials', 'authorization-code'];

const OAS31: VersionCase = {
  version: '3.1',
  namespace: 'OAS31',
  kinds: ['schema', 'schema-base', 'dialect', 'meta'],
  jsonSchema2020: true,
  ...oas3xMappings(OAS31_FLOWS),
  unmapped: OAS3X_SHARED_UNMAPPED,
  unmappedTypes: OAS3X_SHARED_UNMAPPED_TYPES,
  extraFields: [],
  stricterRequired: OAS3X_STRICTER_REQUIRED,
  looserRequired: [],
  kindDeviations: OAS3X_KIND_DEVIATIONS,
  kindCoverage: { compared: 212, skipped: [] },
};

const OAS32: VersionCase = {
  version: '3.2',
  namespace: 'OAS32',
  kinds: ['schema', 'schema-base', 'dialect', 'meta'],
  jsonSchema2020: true,
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
  kindCoverage: { compared: 235, skipped: [] },
};

const VERSIONS: VersionCase[] = [OAS30, OAS31, OAS32];

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

const manifest = (): ManifestEntry[] => loadJsonFixture<{ sources: ManifestEntry[] }>('oas/sources.json').sources;

/** The pinned JSON Schema 2020-12 meta-schemas, labelled by their path under `schemas/`; throws when any is missing. */
function jsonSchema2020Sources(): SchemaSource[] {
  const pinned = manifest().filter((entry) => entry.id.startsWith('json-schema-2020-12'));
  const byLabel = new Map(pinned.map((entry) => [entry.path.replace(/^schemas\//, ''), entry]));
  const missing = JSON_SCHEMA_2020_FILES.filter((file) => !byLabel.has(file));
  if (missing.length > 0) {
    throw new Error(
      `e2e/fixtures/oas/sources.json pins no copy of ${missing.join(', ')}: the JSON Schema 2020-12 meta-schemas must be vendored`,
    );
  }
  return [...byLabel].map(([label, entry]) => ({ label, schema: loadJsonFixture(`oas/${entry.path}`) }));
}

const sorted = (names: Iterable<string>): string[] => [...names].sort();

const isDeviation = (list: readonly Deviation[], type: string, field: string): boolean =>
  list.some((deviation) => deviation.type === type && deviation.field === field);

let types: SpecTypeReader;

beforeAll(() => {
  types = new SpecTypeReader(join(repoRoot, 'src/spec/types/index.ts'), join(repoRoot, 'src/spec/tsconfig.json'));
});

describe('story: the parity sources', () => {
  it('verifies the vendored schemas against their pinned checksums', () => {
    const result = spawnSync(process.execPath, ['scripts/sync-oas-sources.mjs'], { cwd: repoRoot, encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toMatch(/^\d+ sources verified$/m);
  });

  it('reads the JSON Schema 2020-12 meta-schemas from their pinned copies', () => {
    expect(sorted(jsonSchema2020Sources().map((source) => source.label))).toEqual(sorted(JSON_SCHEMA_2020_FILES));
  });

  it('compiles the spec types with zero diagnostics', () => {
    expect(types.diagnostics()).toEqual([]);
  });
});

describe('story: the spec layer boundary', () => {
  it('refers to no module outside src/spec', () => {
    const specDir = join(repoRoot, 'src', 'spec');
    const files = readdirSync(specDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .sort();
    const problems: string[] = [];
    let references = 0;
    for (const file of files) {
      const path = join(specDir, file);
      for (const reference of moduleSpecifiers(path, readFileSync(path, 'utf8'))) {
        references++;
        const where = `src/spec/${file}:${reference.line} ${reference.form} '${reference.specifier}'`;
        if (['reference types', 'reference lib', 'declare module'].includes(reference.form)) {
          problems.push(`${where}: brings in declarations from outside src/spec`);
          continue;
        }
        const isRelative = /^\.\.?\//.test(reference.specifier);
        if (!isRelative && reference.form !== 'reference path') {
          problems.push(`${where}: not a relative path, so it names a package or a Node built-in`);
          continue;
        }
        if (relative(specDir, resolve(dirname(path), reference.specifier)).startsWith('..')) {
          problems.push(`${where}: resolves outside src/spec`);
        }
      }
    }
    expect(problems).toEqual([]);
    // The spec layer's own modules import each other; finding none means the collector is broken.
    expect(references).toBeGreaterThan(0);
  });
});

describe.each(VERSIONS)('story: OpenAPI $version schema-to-types parity', (version) => {
  const where = (mapping: ObjectMapping): string =>
    `${version.version} ${mapping.definitions.join(' + ')} -> ${version.namespace}.${mapping.type}`;
  const mappings: ObjectMapping[] = [...version.objects, ...version.maps];

  let entries: ManifestEntry[];
  let labels: string[];
  let registry: SchemaRegistry;
  let view: NamespaceTypes;
  let kinds: KindResolver;

  beforeAll(() => {
    entries = manifest().filter(
      (entry) => entry.id.startsWith('oas-') && entry.version === version.version && SCHEMA_KINDS.includes(entry.kind),
    );
    const sources: SchemaSource[] = entries.map((entry) => ({
      label: basename(entry.path),
      schema: loadJsonFixture(`oas/${entry.path}`),
    }));
    labels = sources.map((source) => source.label);
    registry = new SchemaRegistry([...sources, ...(version.jsonSchema2020 ? jsonSchema2020Sources() : [])]);
    // Value kinds name the mapped object types; a map type is compared by its
    // structure (`map<PathItemObject>`) wherever it appears.
    view = types.namespace(
      version.namespace,
      version.objects.map((mapping) => mapping.type),
    );
    const mapped = version.objects.flatMap((mapping) =>
      mapping.definitions.map((definition) => ({ definition, type: view.canonical(mapping.type) })),
    );
    const typeByDefinition = new Map(mapped.map(({ definition, type }) => [definition, type]));
    kinds = new KindResolver(
      registry,
      (definition) => typeByDefinition.get(definition),
      dynamicAnchorBindings(registry, mapped),
    );
  });

  const fieldsOf = (mapping: ObjectMapping): ObjectFields =>
    anyOfFields(mapping.definitions.map((definition) => extractObjectFields(registry, definition)));

  /** Types standing for several definitions: a field naming one of them must match that one's required fields. */
  const multiDefinitionTypes = (): Set<string> =>
    new Set(version.objects.filter((m) => m.definitions.length > 1).map((m) => view.canonical(m.type)));

  /** Problems with extra fields and required-ness, for objects and maps alike. */
  const fieldProblems = (mapping: ObjectMapping, fields: ObjectFields, shape: TypeShape): string[] => {
    const problems: string[] = [];
    const declared = sorted(shape.properties.keys());
    const required = (name: string): boolean => shape.properties.get(name)?.required === true;
    const extra = declared.filter(
      (name) => !fields.properties.has(name) && !isDeviation(version.extraFields, mapping.type, name),
    );
    if (extra.length > 0) {
      problems.push(
        `${where(mapping)}: declares field(s) the official schema does not define: ${extra.join(', ')} (remove them, or allowlist each in extraFields with a reason)`,
      );
    }
    const tooStrict = declared.filter(
      (name) =>
        required(name) && !fields.required.has(name) && !isDeviation(version.stricterRequired, mapping.type, name),
    );
    if (tooStrict.length > 0) {
      problems.push(
        `${where(mapping)}: requires field(s) the official schema leaves optional: ${tooStrict.join(', ')} (make them optional, or allowlist each in stricterRequired with a reason)`,
      );
    }
    const tooLoose = declared.filter(
      (name) =>
        !required(name) && fields.required.has(name) && !isDeviation(version.looserRequired, mapping.type, name),
    );
    if (tooLoose.length > 0) {
      problems.push(
        `${where(mapping)}: leaves optional field(s) the official schema requires: ${tooLoose.join(', ')} (make them required, or allowlist each in looserRequired with a reason)`,
      );
    }
    return problems;
  };

  /** Compare one value's kind; `field` is `[key]` for a map's values. */
  const kindProblems = (
    mapping: ObjectMapping,
    field: string,
    expected: SchemaKind | SkippedKind,
    actual: Pick<PropertyShape, 'kind' | 'refs'>,
  ): string[] => {
    if ('skip' in expected) return [];
    const problems: string[] = [];
    const allowed = version.kindDeviations.some(
      (d) => d.type === mapping.type && d.field === field && d.typeKind === actual.kind,
    );
    if (expected.kind !== actual.kind && !allowed) {
      problems.push(
        `${where(mapping)}: ${field} holds ${actual.kind} in the type, but the official schema says ${expected.kind} (fix the type, or allowlist it in kindDeviations with a reason)`,
      );
    }
    // A reference to one of several definitions behind one type (one OAuth
    // flow), or a narrowed reference: the value's own fields must match the
    // definition it names.
    for (const { definition, type } of expected.refs) {
      const ref = actual.refs.find((candidate) => candidate.type === type);
      if (!ref || (ref.exact && !multiDefinitionTypes().has(type))) continue;
      const target = extractObjectFields(registry, definition);
      const shape = ref.shape();
      const label = `${where(mapping)}: ${field} (${definition})`;
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
    }
    return problems;
  };

  /** The value-kind check's verdict for every field of every mapped object, and every map's values. */
  const kindVerdicts = (): Array<{ name: string; expected: SchemaKind | SkippedKind }> =>
    [
      ...version.objects.flatMap((mapping) => {
        const fields = fieldsOf(mapping);
        return sorted(fields.properties).map((field) => ({
          name: `${mapping.type}.${field}`,
          expected: kinds.kindOf(fields.propertySchemas.get(field) ?? []),
        }));
      }),
      ...version.maps.map((mapping) => ({ name: `${mapping.type}.[key]`, expected: mapValueKind(fieldsOf(mapping)) })),
    ];

  const mapValueKind = (fields: ObjectFields): SchemaKind | SkippedKind =>
    kinds.kindOf([...fields.valueSchemas, ...[...fields.propertySchemas.values()].flat()]);

  it(`reads every OpenAPI JSON Schema document the manifest pins for ${version.version}`, () => {
    expect(sorted(entries.map((entry) => entry.kind))).toEqual(sorted(version.kinds));
  });

  it('maps every schema definition to a type or lists it as unmapped with a reason', () => {
    const declared = registry.definitions(labels);
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
    const fields = fieldsOf(mapping);
    const shape = view.shape(mapping.type);
    const problems: string[] = [];

    const missing = sorted(fields.properties).filter((name) => !shape.properties.has(name));
    if (missing.length > 0) {
      problems.push(`${where(mapping)}: missing field(s) the official schema defines: ${missing.join(', ')}`);
    }
    problems.push(...fieldProblems(mapping, fields, shape));
    for (const field of sorted(fields.properties)) {
      const property = shape.properties.get(field);
      if (property) {
        problems.push(...kindProblems(mapping, field, kinds.kindOf(fields.propertySchemas.get(field) ?? []), property));
      }
    }
    if (fields.dynamicKeys.size > 0) {
      problems.push(
        `${where(mapping)}: the schema also accepts keys by pattern (${sorted(fields.dynamicKeys).join('; ')}); compare it as a map instead`,
      );
    }
    if (shape.stringIndex) {
      problems.push(
        `${where(mapping)}: the type has a string index signature, but the schema allows fixed fields only`,
      );
    }
    expect(problems).toEqual([]);
  });

  it.each(version.maps)('$type is a string-index map, as its schema definitions are', (mapping) => {
    const fields = fieldsOf(mapping);
    const shape = view.shape(mapping.type);
    const problems: string[] = [];

    if (fields.dynamicKeys.size === 0) {
      problems.push(`${where(mapping)}: the schema allows fixed fields only; compare it as an object instead`);
    }
    if (!shape.stringIndex) {
      problems.push(
        `${where(mapping)}: the schema keys it by pattern (${sorted(fields.dynamicKeys).join('; ')}), but the type has no string index signature`,
      );
    }
    const fixed = sorted(fields.properties);
    if (fixed.join() !== sorted(mapping.fixedKeys).join()) {
      problems.push(
        `${where(mapping)}: the schema's fixed fields are [${fixed.join(', ')}], expected [${sorted(mapping.fixedKeys).join(', ')}]; check whether a new fixed field needs its own property, then update fixedKeys`,
      );
    }
    problems.push(...fieldProblems(mapping, fields, shape));
    problems.push(
      ...kindProblems(mapping, '[key]', mapValueKind(fields), { kind: formatKind(shape.indexAtoms), refs: [] }),
    );
    expect(problems).toEqual([]);
  });

  const { compared, skipped: skips } = version.kindCoverage;
  it(`compares the value kind of ${compared} fields and skips ${skips.length}`, () => {
    const verdicts = kindVerdicts();
    const skipped = verdicts.flatMap(({ name, expected }) => ('skip' in expected ? [`${name}: ${expected.skip}`] : []));
    const skippedNames = skipped.map((entry) => entry.slice(0, entry.indexOf(': ')));
    // On a mismatch, `skipped` shows why each field is skipped.
    expect({ compared: verdicts.length - skipped.length, skippedNames, skipped }).toEqual({
      compared: version.kindCoverage.compared,
      skippedNames: version.kindCoverage.skipped,
      skipped: expect.any(Array),
    });
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
          problems.push(`${where(mapping)}: ${listName} entry for ${deviation.field} gives no reason`);
        }
        if (!stillDeviates(mapping, fieldsOf(mapping), view.shape(deviation.type), deviation)) {
          problems.push(`${where(mapping)}: ${listName} entry for ${deviation.field} no longer applies; remove it`);
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
    check(version.kindDeviations, 'kindDeviations', (_, fields, shape, deviation) => {
      const property = shape.properties.get(deviation.field);
      const expected = kinds.kindOf(fields.propertySchemas.get(deviation.field) ?? []);
      const { typeKind } = deviation as KindDeviation;
      return property?.kind === typeKind && !('skip' in expected) && expected.kind !== typeKind;
    });
    expect(problems).toEqual([]);
  });
});
