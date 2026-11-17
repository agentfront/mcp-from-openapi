/**
 * Official-documents story: the OpenAPI Initiative's own schema test
 * documents (OpenAPI 3.0 archive, 3.1 and 3.2 `tests/schema`, vendored under
 * e2e/fixtures/oas/documents and pinned by sha256 in e2e/fixtures/oas/sources.json)
 * go through the whole pipeline.
 *
 * Each PASS document, which OAI's own suite validates against its schema, is
 * checked at five separate layers, so a failure names the layer:
 *
 * 1. it validates against the official JSON Schema for its version
 *    (e2e/helpers/oas-validate.ts, offline);
 * 2. it type-checks against our types (`OAS30`/`OAS31`/`OAS32`) as an
 *    annotated object literal, with the real TypeScript compiler. `x-`
 *    extension keys are removed first, because the types declare no index
 *    signatures on purpose (read extensions through `WithExtensions`). All
 *    documents of a version are compiled together, as one virtual file;
 * 3. our validator accepts it (`generator.validate()`);
 * 4. `generateTools()` completes and returns exactly the pinned tools, in
 *    order, each as `[name, metadata.method, metadata.path,
 *    annotations.readOnlyHint]` (e2e/expected/official-documents.json). It
 *    runs with `validate: false`: validation is layer 3, and a document our
 *    validator rejects still gets its generation checked. The pinned list is
 *    what the document declares under `paths`, written from the document and
 *    the rules, not from what the library prints: the eight fixed methods in
 *    the library's fixed order (get, post, put, patch, delete, head, options,
 *    trace), then `query` (3.2, read-only), then `additionalOperations`
 *    sorted by key (3.2, not read-only, the method as written); paths sorted;
 *    webhooks and component path items are not callable and make no tools;
 * 5. that generation reports no diagnostic (`generator.getDiagnostics()`) for
 *    something the library could not process: a parameter in a location it
 *    does not map, a security scheme it cannot resolve, an operation or path
 *    item it ignores, a version it cannot read, diagnostics it had to drop. A
 *    diagnostic code that is neither in `UNPROCESSED_CODES` nor in
 *    `INFORMATIONAL_CODES` is reported too, so a new code has to be classified
 *    here.
 *
 * Each FAIL document, which OAI's suite requires the schema to reject, must
 * be rejected by the official schema here too (the helper's sanity check),
 * must never crash the pipeline (loading, `validate()` and `generateTools()`,
 * with and without validation, either succeed or fail with one of the
 * library's own errors, `OpenAPIToolError` and its subclasses, never a
 * `TypeError` or `RangeError`), and has a recorded verdict from OUR validator:
 * `VALIDATOR_VERDICTS` says for each document whether our validator rejects it
 * and why, asserted both ways, so which official rules we enforce is a visible
 * fact. A rule we start (or stop) enforcing changes a row on purpose.
 *
 * No network: every document loads with external `$ref` resolution disabled.
 *
 * KNOWN_GAPS lists what does not hold yet. An entry names a version, a check,
 * the documents (or `'all'`), a category, the reason, and the exact failures it
 * covers: each a line a check reports, written out in full, or a pattern with
 * the exact number of lines it matches. A check reports its failures as lines.
 * Every line must be covered by an entry for that document, and every failure
 * an entry lists must still occur exactly as listed (a line that is gone, or
 * one more or less matching a pattern, is reported). So a listed gap is
 * asserted to STILL FAIL, and a second, different failure in the same document
 * is never hidden by an existing entry: when a change fixes a gap the test
 * fails until the entry (or the document's name in it) is deleted, and a fix
 * that exposes a different failure is reported as an unlisted one. The list can
 * only shrink deliberately, by deleting entries. When OAI publishes a newer
 * pin, re-vendor with `node scripts/sync-oas-sources.mjs --update`, then update
 * the literal document counts below and the pinned tools in
 * e2e/expected/official-documents.json (see e2e/fixtures/README.md).
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import * as yaml from 'yaml';
import { OpenAPIToolError, OpenAPIToolGenerator } from '../src';
import type { LoadOptions } from '../src';
import { fixturePath, loadFixture } from './helpers/fixtures';
import { validateOasDocument, type OasVersion } from './helpers/oas-validate';
import { compileVirtual } from './helpers/tsc';

const repoRoot = join(__dirname, '..');

type Check = 'schema' | 'types' | 'validator' | 'generation' | 'diagnostics' | 'crash';

/** One failure a gap covers: a reported line in full, or a pattern with the exact number of lines it matches. */
type Failure = string | { pattern: RegExp; count: number };

interface KnownGap {
  version: OasVersion;
  /** `crash` entries list FAIL documents; every other check lists PASS documents. */
  check: Check;
  /** Short kebab-case cause shared by the documents of one entry. */
  category: string;
  /** Why the check fails today. */
  reason: string;
  /** Every failure line this entry covers, for each of its documents. */
  failures: Failure[];
  /** Document names, without `.yaml`, or `'all'` for every document the check runs over. */
  documents: string[] | 'all';
}

/**
 * Documents the pipeline does not handle yet. Fixing a gap and deleting its
 * entry is a pure deletion; nothing else in this file refers to the entries.
 */
const KNOWN_GAPS: KnownGap[] = [
  // --- OpenAPI 3.1 -------------------------------------------------------
  {
    version: '3.1',
    check: 'schema',
    category: 'wip-dialect-uri',
    reason:
      "The document names the work-in-progress dialect (`.../dialect/WORK-IN-PROGRESS`), as OAI's source schemas do; the published schema pins the dated dialect with `const`. Proven below: with the pinned URI the document validates.",
    failures: [
      '/components/schemas/WithDollarSchema/$schema: must be equal to constant (https://spec.openapis.org/oas/3.1/dialect/2024-11-10)',
      '/jsonSchemaDialect: must be equal to constant (https://spec.openapis.org/oas/3.1/dialect/2024-11-10)',
    ],
    documents: ['json_schema_dialect'],
  },
  {
    version: '3.1',
    check: 'types',
    category: 'schema-unknown-keyword',
    reason:
      'JSON Schema allows keywords an OpenAPI dialect does not define (`myArbitraryKeyword: true`); OAS31.SchemaObject is a closed object type without an index signature.',
    failures: [
      '`"myArbitraryKeyword": true`: Object literal may only specify known properties, and \'"myArbitraryKeyword"\' does not exist in type \'SchemaObject\'.',
    ],
    documents: ['mega'],
  },
  // --- OpenAPI 3.2 -------------------------------------------------------
  {
    version: '3.2',
    check: 'schema',
    category: 'wip-dialect-uri',
    reason:
      'As for 3.1: the document names `.../oas/3.2/dialect/WORK-IN-PROGRESS`, the published schema pins the dated dialect.',
    failures: [
      '/components/schemas/WithDollarSchema/$schema: must be equal to constant (https://spec.openapis.org/oas/3.2/dialect/2026-02-26)',
      '/jsonSchemaDialect: must be equal to constant (https://spec.openapis.org/oas/3.2/dialect/2026-02-26)',
    ],
    documents: ['json_schema_dialect'],
  },
  {
    version: '3.2',
    check: 'types',
    category: 'schema-unknown-keyword',
    reason: 'As for 3.1: `myArbitraryKeyword: true` in a Schema Object; OAS32.SchemaObject is closed.',
    failures: [
      '`"myArbitraryKeyword": true`: Object literal may only specify known properties, and \'"myArbitraryKeyword"\' does not exist in type \'SchemaObject\'.',
    ],
    documents: ['mega'],
  },
  {
    version: '3.2',
    check: 'diagnostics',
    category: 'security-scheme-uri',
    reason:
      'A Security Requirement key that is a URI (`otherapi#/components/securitySchemes/generic_auth`) is not resolved yet: the requirement is ignored with an UNRESOLVED_SECURITY_SCHEME diagnostic.',
    failures: [{ pattern: /^UNRESOLVED_SECURITY_SCHEME at \/paths\/~1pets~1\{id\}\/put\/security\/1[/:]/, count: 1 }],
    documents: ['operation-object-example'],
  },
];

const VERSIONS: Array<{ version: OasVersion; namespace: 'OAS30' | 'OAS31' | 'OAS32'; pass: number; fail: number }> = [
  { version: '3.0', namespace: 'OAS30', pass: 6, fail: 0 },
  { version: '3.1', namespace: 'OAS31', pass: 35, fail: 12 },
  { version: '3.2', namespace: 'OAS32', pass: 37, fail: 31 },
];

/**
 * The pinned tools of the PASS documents, `[name, method, path, readOnlyHint]`
 * in generation order. A document not listed declares no operation under
 * `paths` (it holds components, webhooks or nothing) and makes no tool.
 */
type ExpectedTool = [name: string, method: string, path: string, readOnlyHint: boolean];
const EXPECTED_TOOLS = (
  JSON.parse(readFileSync(join(__dirname, 'expected', 'official-documents.json'), 'utf8')) as {
    tools: Record<OasVersion, Record<string, ExpectedTool[]>>;
  }
).tools;

/**
 * What OUR validator says about each official FAIL document, asserted both
 * ways: whether it rejects the document (`generator.validate()` is not valid)
 * and, when it does, with which error code. OAI's schema rejects all of them;
 * our validator is not a schema validator, so this is the visible record of
 * which official rules it enforces. A rule we start enforcing flips a row on
 * purpose.
 */
interface ValidatorVerdict {
  /** The FAIL document, without `.yaml`. */
  document: string;
  rejectedByOurValidator: boolean;
  /** The rule that is broken and why our validator does or does not catch it. */
  reason: string;
  /** The error code that rejects it (only when `rejectedByOurValidator`). */
  code?: string;
}

const COMPONENTS_NOT_READ =
  'the validator reads nothing under `components` except `components.parameters`, and that only to resolve a `$ref` from an operation';
const QUERYSTRING_ONLY_UNDER_PATHS =
  'the validator enforces this rule, but only for the parameters of path items and operations under `paths`';
const SCHEMAS_NOT_VALIDATED = 'Schema Objects are not validated';
const NO_CONTAINER =
  'there is none of `paths`, `components` and `webhooks` (one is required), and the validator only warns NO_PATHS';
const UNKNOWN_FIELD_IGNORED = 'a field the specification does not define is not rejected';

const VALIDATOR_VERDICTS: Record<OasVersion, ValidatorVerdict[]> = {
  '3.0': [],
  '3.1': [
    {
      document: 'example-examples',
      rejectedByOurValidator: false,
      reason: `\`example\` together with \`examples\` on \`components.parameters.animal\`: ${COMPONENTS_NOT_READ}.`,
    },
    {
      document: 'header-object-allowReserved',
      rejectedByOurValidator: false,
      reason: `\`allowReserved\` in a Header Object under \`components.headers\`, which is not read.`,
    },
    {
      document: 'invalid_schema_types',
      rejectedByOurValidator: false,
      reason: `Invalid \`type\` values in \`components.schemas\`: ${SCHEMAS_NOT_VALIDATED}.`,
    },
    {
      document: 'link-object-no-body',
      rejectedByOurValidator: false,
      reason: `A Link Object with the undefined field \`body\`, under \`components.links\`, which is not read.`,
    },
    { document: 'no_containers', rejectedByOurValidator: false, reason: `No container: ${NO_CONTAINER}.` },
    {
      document: 'openapi-version',
      rejectedByOurValidator: true,
      code: 'INVALID_OPENAPI_VERSION',
      reason: '`openapi: 3.1.৪` (a Bengali digit) is not a version string: the validator requires ASCII digits.',
    },
    {
      document: 'parameter-object-cookie-form-allowReserved',
      rejectedByOurValidator: false,
      reason: `\`allowReserved\` with \`style: cookie\` on \`components.parameters\`: ${COMPONENTS_NOT_READ}; and it has no rule for it.`,
    },
    {
      document: 'parameter-object-header-allowReserved',
      rejectedByOurValidator: false,
      reason: `\`allowReserved\` on a header parameter in \`components.parameters\`: ${COMPONENTS_NOT_READ}; and it has no rule for it.`,
    },
    {
      document: 'parameter-object-path-allowReserved',
      rejectedByOurValidator: false,
      reason: `\`allowReserved\` and a missing \`required\` on a path parameter in \`components.parameters\`: ${COMPONENTS_NOT_READ}.`,
    },
    {
      document: 'server_enum_empty',
      rejectedByOurValidator: false,
      reason: 'An empty `enum` in a server variable under `servers`: the validator does not look at server variables.',
    },
    {
      document: 'servers',
      rejectedByOurValidator: false,
      reason:
        '`servers` is an object, not an array: the validator only tests that `servers` is present and its `length` is not 0, which an object passes.',
    },
    {
      document: 'unknown_container',
      rejectedByOurValidator: false,
      reason: `The top-level field \`overlays\` (${UNKNOWN_FIELD_IGNORED}) and no container: ${NO_CONTAINER}.`,
    },
  ],
  '3.2': [
    {
      document: 'encoding-enc-item-exclusion',
      rejectedByOurValidator: false,
      reason:
        'An Encoding Object inside `prefixEncoding` that has `prefixEncoding` of its own, under `components.requestBodies`, which is not read.',
    },
    {
      document: 'encoding-enc-prefix-exclusion',
      rejectedByOurValidator: false,
      reason:
        'An Encoding Object inside `prefixEncoding` that has `itemEncoding`, under `components.requestBodies`, which is not read.',
    },
    {
      document: 'example-examples',
      rejectedByOurValidator: false,
      reason: `\`example\` together with \`examples\` on \`components.parameters.animal\`: ${COMPONENTS_NOT_READ}.`,
    },
    {
      document: 'example-object-old-exclusions',
      rejectedByOurValidator: false,
      reason: 'An Example Object with `value` and `externalValue`, under `components.examples`, which is not read.',
    },
    {
      document: 'example-object-old-vs-data',
      rejectedByOurValidator: false,
      reason: 'An Example Object with `value` and `dataValue`, under `components.examples`, which is not read.',
    },
    {
      document: 'example-object-old-vs-ser',
      rejectedByOurValidator: false,
      reason: 'An Example Object with `value` and `serializedValue`, under `components.examples`, which is not read.',
    },
    {
      document: 'example-object-ser-exclusions',
      rejectedByOurValidator: false,
      reason:
        'An Example Object with `serializedValue` and `externalValue`, under `components.examples`, which is not read.',
    },
    {
      document: 'header-object-allowReserved',
      rejectedByOurValidator: false,
      reason: `\`allowReserved\` in a Header Object under \`components.headers\`, which is not read.`,
    },
    {
      document: 'header-object-name',
      rejectedByOurValidator: false,
      reason:
        'The response header name `Bad=Header` is not an HTTP token. The document is under `paths`, but the validator does not check response headers.',
    },
    {
      document: 'invalid_schema_types',
      rejectedByOurValidator: false,
      reason: `Invalid \`type\` values in \`components.schemas\`: ${SCHEMAS_NOT_VALIDATED}.`,
    },
    {
      document: 'media-type-description',
      rejectedByOurValidator: false,
      reason: `\`description\` on a Media Type Object under \`components.mediaTypes\`, which is not read.`,
    },
    {
      document: 'media-type-enc-item-exclusion',
      rejectedByOurValidator: false,
      reason:
        'A Media Type Object with `encoding` and `itemEncoding`, under `components.requestBodies`, which is not read.',
    },
    {
      document: 'media-type-enc-prefix-exclusion',
      rejectedByOurValidator: false,
      reason:
        'A Media Type Object with `encoding` and `prefixEncoding`, under `components.requestBodies`, which is not read.',
    },
    { document: 'no_containers', rejectedByOurValidator: false, reason: `No container: ${NO_CONTAINER}.` },
    {
      document: 'openapi-version',
      rejectedByOurValidator: true,
      code: 'INVALID_OPENAPI_VERSION',
      reason: '`openapi: 3.2.৪` (a Bengali digit) is not a version string: the validator requires ASCII digits.',
    },
    {
      document: 'operation-object-query-with-querystring',
      rejectedByOurValidator: false,
      reason: `A \`query\` and a \`querystring\` parameter on one operation, in \`components.pathItems\`: ${QUERYSTRING_ONLY_UNDER_PATHS}.`,
    },
    {
      document: 'operation-object-two-querystrings',
      rejectedByOurValidator: false,
      reason: `Two \`querystring\` parameters on one operation, in \`components.pathItems\`: ${QUERYSTRING_ONLY_UNDER_PATHS}.`,
    },
    {
      document: 'parameter-object-content-not-with-style',
      rejectedByOurValidator: false,
      reason: `A \`querystring\` parameter with \`content\` and \`style\`, in \`components.parameters\`: ${COMPONENTS_NOT_READ}; and it has no rule for \`style\` next to \`content\`.`,
    },
    {
      document: 'parameter-object-cookie-allowReserved',
      rejectedByOurValidator: false,
      reason: `\`allowReserved\` on a cookie parameter in \`components.parameters\`: ${COMPONENTS_NOT_READ}; and it has no rule for it.`,
    },
    {
      document: 'parameter-object-header-allowReserved',
      rejectedByOurValidator: false,
      reason: `\`allowReserved\` on a header parameter in \`components.parameters\`: ${COMPONENTS_NOT_READ}; and it has no rule for it.`,
    },
    {
      document: 'parameter-object-header-name',
      rejectedByOurValidator: false,
      reason: `A header parameter named \`Bad[Header]\` (not an HTTP token) in \`components.parameters\`: ${COMPONENTS_NOT_READ}; and it has no rule for header names.`,
    },
    {
      document: 'parameter-object-path-name',
      rejectedByOurValidator: false,
      reason: `A path parameter named \`Bad{Path}\` in \`components.parameters\`: ${COMPONENTS_NOT_READ}; and it has no rule for path parameter names.`,
    },
    {
      document: 'parameter-object-querystring-not-with-schema',
      rejectedByOurValidator: false,
      reason: `A \`querystring\` parameter with \`schema\` instead of \`content\`, in \`components.parameters\`: ${QUERYSTRING_ONLY_UNDER_PATHS}.`,
    },
    {
      document: 'path-item-object-conflicting-additional-operation',
      rejectedByOurValidator: true,
      code: 'DUPLICATE_FIXED_METHOD',
      reason:
        '`additionalOperations` has the key `POST`, the method of the fixed `post` field, which the specification forbids.',
    },
    {
      document: 'path-item-object-query-with-querystring',
      rejectedByOurValidator: false,
      reason: `A path-level \`querystring\` parameter next to a path-level \`query\` parameter, in \`components.pathItems\`: ${QUERYSTRING_ONLY_UNDER_PATHS}.`,
    },
    {
      document: 'path-item-object-two-querystrings',
      rejectedByOurValidator: false,
      reason: `Two path-level \`querystring\` parameters, in \`components.pathItems\`: ${QUERYSTRING_ONLY_UNDER_PATHS}.`,
    },
    {
      document: 'server_enum_empty',
      rejectedByOurValidator: false,
      reason: 'An empty `enum` in a server variable under `servers`: the validator does not look at server variables.',
    },
    {
      document: 'servers',
      rejectedByOurValidator: false,
      reason:
        '`servers` is an object, not an array: the validator only tests that `servers` is present and its `length` is not 0, which an object passes.',
    },
    {
      document: 'unknown_container',
      rejectedByOurValidator: false,
      reason: `The top-level field \`overlays\` (${UNKNOWN_FIELD_IGNORED}) and no container: ${NO_CONTAINER}.`,
    },
    {
      document: 'xml-attr-exclusion',
      rejectedByOurValidator: false,
      reason: `\`xml.attribute\` with \`xml.nodeType\` in \`components.schemas\`: ${SCHEMAS_NOT_VALIDATED}.`,
    },
    {
      document: 'xml-wrapped-exclusion',
      rejectedByOurValidator: false,
      reason: `\`xml.wrapped\` with \`xml.nodeType\` in \`components.schemas\`: ${SCHEMAS_NOT_VALIDATED}.`,
    },
  ],
};

/** Documents load with external `$ref` resolution off: the suite never touches the network. */
const OFFLINE: LoadOptions = { refResolution: { allowedProtocols: [] } };

/**
 * Diagnostic codes (`generator.getDiagnostics()`) that say the library could
 * not process something in a valid document: a value it ignored, an operation
 * it skipped, a version it could not read.
 */
const UNPROCESSED_CODES: ReadonlySet<string> = new Set([
  // generator
  'UNSUPPORTED_PARAMETER_LOCATION',
  'UNRESOLVED_SECURITY_SCHEME',
  'INVALID_SECURITY_REQUIREMENT',
  'UNSATISFIABLE_SECURITY',
  // operation walker (src/spec/operations.ts)
  'PATH_ITEM_NOT_OBJECT',
  'OPERATION_NOT_OBJECT',
  'ADDITIONAL_OPERATIONS_NOT_OBJECT',
  'INVALID_METHOD_TOKEN',
  'DUPLICATE_FIXED_METHOD',
  'REFUSED_METHOD',
  'METHOD_CASE_VARIANT',
  // declared version (src/spec/versions.ts)
  'INVALID_OPENAPI_VERSION',
  'MISSING_OPENAPI_VERSION',
  'CONFLICTING_VERSION_FIELDS',
  // `query` / `additionalOperations` in a document declaring 3.0 or 3.1: read only from 3.2 on, so no tool
  'FEATURE_NEWER_THAN_DECLARED_VERSION',
  // the cap on diagnostics: findings were dropped, so none of the above can be ruled out
  'DIAGNOSTICS_TRUNCATED',
]);

/** Diagnostic codes that note something processed anyway. */
const INFORMATIONAL_CODES: ReadonlySet<string> = new Set(['NEWER_OPENAPI_VERSION']);

// ---------------------------------------------------------------------------
// Known gaps
// ---------------------------------------------------------------------------

const gapKey = (version: OasVersion, check: Check, document: string): string => `${version}/${check}/${document}`;

const gapsFor = (version: OasVersion, check: Check, document: string): KnownGap[] =>
  KNOWN_GAPS.filter(
    (gap) =>
      gap.version === version && gap.check === check && (gap.documents === 'all' || gap.documents.includes(document)),
  );

const describeFailure = (failure: Failure): string =>
  typeof failure === 'string' ? JSON.stringify(failure) : `${failure.count} line(s) matching ${failure.pattern}`;

/**
 * Asserts one check's outcome. `problems` is the lines the check reports, empty
 * when it holds. The entries listed for the document must account for every
 * line exactly: a line they list in full is one line; a pattern consumes
 * exactly its `count` of the lines matching it. A line no entry accounts for
 * fails the check; a failure an entry lists that did not occur as listed is
 * reported so the entry can be deleted or corrected.
 */
function expectCheck(version: OasVersion, check: Check, document: string, problems: string[]): void {
  const entries = gapsFor(version, check, document);
  const remaining = [...problems];
  const stale: string[] = [];
  const consume = (gap: KnownGap, failure: Failure): void => {
    if (typeof failure === 'string') {
      const index = remaining.indexOf(failure);
      if (index < 0) stale.push(`the ${gap.category} entry lists ${describeFailure(failure)}, which no longer occurs`);
      else remaining.splice(index, 1);
      return;
    }
    const matching = remaining.filter((line) => failure.pattern.test(line));
    for (const line of matching) remaining.splice(remaining.indexOf(line), 1);
    if (matching.length !== failure.count) {
      stale.push(`the ${gap.category} entry lists ${describeFailure(failure)}, found ${matching.length}`);
    }
  };
  for (const gap of entries) for (const failure of gap.failures) consume(gap, failure);

  // A failure no entry lists: an unlisted failure fails normally
  expect(remaining).toEqual([]);
  if (stale.length > 0) {
    throw new Error(
      `${gapKey(version, check, document)} no longer fails exactly as KNOWN_GAPS records: ${stale.join('; ')}. ` +
        `Delete "${document}" or the failure from the entry (or correct it).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

type Kind = 'pass' | 'fail';
type Doc = Record<string, unknown>;

const documentNames = (version: OasVersion, kind: Kind): string[] => {
  try {
    return readdirSync(fixturePath(`oas/documents/${version}/${kind}`))
      .filter((file) => file.endsWith('.yaml'))
      .map((file) => file.slice(0, -'.yaml'.length))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

/** A fresh parse each time: the generator and the validator never see a shared object. */
const loadDocument = (version: OasVersion, kind: Kind, name: string): Doc =>
  yaml.parse(loadFixture(`oas/documents/${version}/${kind}/${name}.yaml`)) as Doc;

/** Removes every `x-` key at any depth. */
function stripExtensions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripExtensions);
  if (node === null || typeof node !== 'object') return node;
  const out: Doc = {};
  for (const [key, value] of Object.entries(node)) if (!key.startsWith('x-')) out[key] = stripExtensions(value);
  return out;
}

// ---------------------------------------------------------------------------
// Layer 2: type-check
// ---------------------------------------------------------------------------

interface TypeCheck {
  /** Diagnostics per document name. */
  byDocument: Map<string, string[]>;
  /** Diagnostics that belong to no document (the import header). */
  unattributed: string[];
}

/** Compiles every PASS document of a version as `const d: <namespace>.OpenAPIObject = <literal>;` in one virtual file. */
function typeCheckDocuments(version: OasVersion, namespace: string, names: string[]): TypeCheck {
  let source = `import type { ${namespace} } from '../src/spec';\n`;
  const spans: Array<{ name: string; start: number; end: number }> = [];
  names.forEach((name, index) => {
    const literal = JSON.stringify(stripExtensions(loadDocument(version, 'pass', name)), null, 2);
    const start = source.length;
    source += `const doc${index}: ${namespace}.OpenAPIObject = ${literal};\n`;
    spans.push({ name, start, end: source.length });
  });

  const diagnostics = compileVirtual(`official-${version}.ts`, source, {
    baseDir: __dirname,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
  });

  const result: TypeCheck = { byDocument: new Map(names.map((name) => [name, []])), unattributed: [] };
  for (const diagnostic of diagnostics) {
    const parsed = /^.*?:(\d+) ([\s\S]*)$/.exec(diagnostic);
    const offset = parsed ? Number(parsed[1]) : -1;
    const message = (parsed ? parsed[2] : diagnostic).split('\n')[0];
    const span = spans.find(({ start, end }) => offset >= start && offset < end);
    if (!span) {
      result.unattributed.push(diagnostic);
      continue;
    }
    const lineStart = source.lastIndexOf('\n', offset) + 1;
    const line = source.slice(lineStart, source.indexOf('\n', offset)).trim();
    result.byDocument.get(span.name)!.push(`\`${line.slice(0, 80)}\`: ${message}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Layers 3 and 4: our validator and generator
// ---------------------------------------------------------------------------

async function validatorProblems(version: OasVersion, name: string): Promise<string[]> {
  const generator = await OpenAPIToolGenerator.fromJSON(loadDocument(version, 'pass', name), OFFLINE);
  const result = await generator.validate();
  return result.valid ? [] : (result.errors ?? []).map((error) => `${error.path ?? '/'}: ${error.message}`);
}

/** Runs `run` with `console.warn` captured: the generator reports a failing operation by warning, then drops it. */
async function withWarnings<T>(run: () => Promise<T>): Promise<{ value?: T; error?: unknown; warnings: string[] }> {
  const warnings: string[] = [];
  const spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  try {
    return { value: await run(), warnings };
  } catch (error) {
    return { error, warnings };
  } finally {
    spy.mockRestore();
  }
}

/** Generates a PASS document's tools with validation off, keeping the generator's diagnostics. */
async function generate(version: OasVersion, name: string) {
  let generator: OpenAPIToolGenerator | undefined;
  const { value, error, warnings } = await withWarnings(async () => {
    generator = await OpenAPIToolGenerator.fromJSON(loadDocument(version, 'pass', name), {
      ...OFFLINE,
      validate: false,
    });
    return generator.generateTools();
  });
  return { tools: value, error, warnings, diagnostics: generator?.getDiagnostics() ?? [] };
}

const describeTool = ([name, method, path, readOnlyHint]: ExpectedTool): string =>
  `${name} (${method} ${path}, readOnlyHint ${readOnlyHint})`;

/** Generation failures: an error, an operation reported failing, and every difference from the pinned tools. */
async function generationProblems(version: OasVersion, name: string): Promise<string[]> {
  const expected = EXPECTED_TOOLS[version][name] ?? [];
  const { tools, error, warnings } = await generate(version, name);
  if (error) return [`${error instanceof Error ? error.name : 'thrown'}: ${(error as Error).message}`];
  const problems = warnings.map((warning) => `warning: ${warning}`);

  const actual = tools!.map((tool): ExpectedTool => [
    tool.name,
    tool.metadata.method,
    tool.metadata.path,
    tool.annotations?.readOnlyHint as boolean,
  ]);
  const key = (tool: ExpectedTool): string => JSON.stringify(tool);
  const unmatched = actual.map(key);
  for (const tool of expected) {
    const index = unmatched.indexOf(key(tool));
    if (index < 0) problems.push(`missing tool ${describeTool(tool)}`);
    else unmatched.splice(index, 1);
  }
  for (const unexpected of unmatched) problems.push(`unexpected tool ${describeTool(JSON.parse(unexpected))}`);
  if (problems.length === warnings.length && JSON.stringify(actual) !== JSON.stringify(expected)) {
    problems.push(
      `tool order: expected ${expected.map(describeTool).join(', ')}; got ${actual.map(describeTool).join(', ')}`,
    );
  }
  return problems;
}

/** The diagnostics of generating a valid document that say something was not processed, or are not classified. */
async function diagnosticProblems(version: OasVersion, name: string): Promise<string[]> {
  const { diagnostics } = await generate(version, name);
  return diagnostics
    .filter(({ code }) => !INFORMATIONAL_CODES.has(code))
    .map(({ code, path, message }) =>
      UNPROCESSED_CODES.has(code)
        ? `${code} at ${path ?? '/'}: ${message}`
        : `${code} at ${path ?? '/'}: unclassified diagnostic code, add it to UNPROCESSED_CODES or INFORMATIONAL_CODES: ${message}`,
    );
}

// ---------------------------------------------------------------------------
// FAIL documents: the pipeline never crashes
// ---------------------------------------------------------------------------

const describeCrash = (stage: string, error: unknown): string => {
  const failure = error instanceof Error ? error : new Error(String(error));
  const frame = (failure.stack ?? '').split('\n').find((line) => line.trimStart().startsWith('at '));
  return `${stage}: ${failure.name}: ${failure.message} (${
    frame
      ?.trim()
      .split(repoRoot + '/')
      .join('') ?? 'no stack'
  })`;
};

/** Every stage's failure that is not one of the library's own errors. */
async function crashes(version: OasVersion, name: string): Promise<string[]> {
  const found: string[] = [];
  const attempt = async (stage: string, run: () => Promise<unknown>): Promise<void> => {
    const { error } = await withWarnings(run);
    if (error !== undefined && !(error instanceof OpenAPIToolError)) found.push(describeCrash(stage, error));
  };
  const load = (options: LoadOptions) => OpenAPIToolGenerator.fromJSON(loadDocument(version, 'fail', name), options);

  await attempt('validate()', async () => (await load(OFFLINE)).validate());
  await attempt('generateTools()', async () => (await load(OFFLINE)).generateTools());
  await attempt('generateTools() without validation', async () =>
    (await load({ ...OFFLINE, validate: false })).generateTools(),
  );
  return found;
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

describe.each(VERSIONS)('story: official OpenAPI $version test documents', ({ version, namespace, pass, fail }) => {
  const passNames = documentNames(version, 'pass');
  const failNames = documentNames(version, 'fail');
  let typeCheck: TypeCheck;

  beforeAll(() => {
    typeCheck = typeCheckDocuments(version, namespace, passNames);
  });

  it('vendors the pinned set of documents', () => {
    expect({ pass: passNames.length, fail: failNames.length }).toEqual({ pass, fail });
  });

  it('pins tools for existing documents only, and lists known gaps for existing documents only', () => {
    expect(Object.keys(EXPECTED_TOOLS[version]).filter((name) => !passNames.includes(name))).toEqual([]);
    const unknown = KNOWN_GAPS.filter((gap) => gap.version === version).flatMap((gap) =>
      gap.documents === 'all'
        ? []
        : gap.documents.filter((name) => !(gap.check === 'crash' ? failNames : passNames).includes(name)),
    );
    expect(unknown).toEqual([]);
  });

  it('records a validator verdict for every FAIL document, and for those only', () => {
    expect(VALIDATOR_VERDICTS[version].map((verdict) => verdict.document).sort()).toEqual(failNames);
    for (const verdict of VALIDATOR_VERDICTS[version]) {
      expect(verdict.reason).not.toEqual('');
      expect(verdict.code !== undefined).toBe(verdict.rejectedByOurValidator);
    }
  });

  it('resolves the spec types the documents are checked against', () => {
    expect(typeCheck.unattributed).toEqual([]);
  });

  describe.each(passNames)('pass/%s', (name) => {
    it('validates against the official schema', () => {
      expectCheck(version, 'schema', name, validateOasDocument(version, loadDocument(version, 'pass', name)).errors);
    });

    it('type-checks against our types', () => {
      expectCheck(version, 'types', name, typeCheck.byDocument.get(name)!);
    });

    it('is accepted by our validator', async () => {
      expectCheck(version, 'validator', name, await validatorProblems(version, name));
    });

    it('generates the pinned tools', async () => {
      expectCheck(version, 'generation', name, await generationProblems(version, name));
    });

    it('generates without a diagnostic for something it could not process', async () => {
      expectCheck(version, 'diagnostics', name, await diagnosticProblems(version, name));
    });
  });

  if (failNames.length > 0) {
    describe.each(failNames)('fail/%s', (name) => {
      it('is rejected by the official schema', () => {
        expect(validateOasDocument(version, loadDocument(version, 'fail', name)).valid).toBe(false);
      });

      it('is rejected by our validator exactly as recorded', async () => {
        const verdict = VALIDATOR_VERDICTS[version].find(({ document }) => document === name)!;
        const generator = await OpenAPIToolGenerator.fromJSON(loadDocument(version, 'fail', name), OFFLINE);
        const result = await generator.validate();
        expect({ document: name, rejectedByOurValidator: !result.valid }).toEqual({
          document: name,
          rejectedByOurValidator: verdict.rejectedByOurValidator,
        });
        if (verdict.code) expect((result.errors ?? []).map((error) => error.code)).toContain(verdict.code);
      });

      it('never crashes the pipeline', async () => {
        expectCheck(version, 'crash', name, await crashes(version, name));
      });
    });
  }
});

describe('story: official OpenAPI documents, the work-in-progress dialect', () => {
  // OAI's source schemas carry `WORK-IN-PROGRESS` in their ids and a document may name that dialect;
  // the published schemas pin the dated one. Replacing the URI is what publishing does.
  it.each(['3.1', '3.2'] as const)(
    'validates against the pinned %s schema once its dialect URI is the pinned one',
    (version) => {
      const dialect = (
        JSON.parse(loadFixture(`oas/schemas/${version}/schema-base.json`)) as {
          $defs: { dialect: { const: string } };
        }
      ).$defs.dialect.const;
      const text = loadFixture(`oas/documents/${version}/pass/json_schema_dialect.yaml`);
      expect(text).toContain(`${dialect.slice(0, dialect.lastIndexOf('/'))}/WORK-IN-PROGRESS`);
      const document = yaml.parse(
        text.split(`${dialect.slice(0, dialect.lastIndexOf('/'))}/WORK-IN-PROGRESS`).join(dialect),
      ) as Doc;
      expect(validateOasDocument(version, document)).toEqual({ valid: true, errors: [] });
    },
  );
});
