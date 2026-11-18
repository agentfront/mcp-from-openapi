/**
 * Official-documents story: the OpenAPI Initiative's own schema test
 * documents (OpenAPI 3.0 archive, 3.1 and 3.2 `tests/schema`, and the Swagger 2.0
 * examples, vendored under e2e/fixtures/oas/documents and pinned by sha256 in
 * e2e/fixtures/oas/sources.json) go through the whole pipeline.
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
 *    annotations.readOnlyHint, facts?]` (e2e/expected/official-documents.json;
 *    `facts` is the optional fifth element, see `ToolFacts`). It
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
 *    item it ignores, a querystring rule that skips an operation, a parameter it
 *    drops or a `content` it cannot read, a streamed request body, a version it
 *    cannot read, diagnostics it had to drop. A diagnostic code that is neither
 *    in `UNPROCESSED_CODES` nor in `INFORMATIONAL_CODES` is reported too, so a
 *    new code has to be classified here.
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
 * No network: every document loads with external `$ref` resolution disabled,
 * except the one multi-file Swagger 2.0 example (`petstore-separate`), which is
 * read from disk with `fromFile` (`file` is the only protocol allowed).
 *
 * Swagger 2.0 (`2.0/pass`): the library converts a 2.0 document to OpenAPI 3.0 and
 * generates from that, so the same five layers run over the document AS WRITTEN
 * (the schema is the official 2.0 schema, the type is `OAS20.SwaggerObject`, our
 * validator applies the 2.0 rules) and layer 4 pins, besides name, method,
 * path and read-only hint, what only a 2.0 reader has to translate: the
 * request body (the media types its converted request body offers, the one the tool
 * sends, its file parts), each array parameter's `style`/`explode` (from
 * `collectionFormat`), the security schemes a tool uses, and per document the
 * server URLs (from `host`, `basePath` and `schemes`). There are no official 2.0
 * FAIL documents. The converted document's own conformance and its equivalence
 * with the 3.x forms are checked in e2e/swagger2.e2e.ts.
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
 *
 * The official documents leave out constructs the library reads where a tool is
 * built (`in: querystring`, a parameter defined with `content`, `itemSchema`
 * in a response, named servers, overrides by name and location, the `query`
 * operation, ...), so the same checks also run over our own documents under
 * e2e/fixtures/supplementary (a README there lists them). Each must validate
 * against the official schema of its version, has no known gap allowed, and has
 * its tools and facts pinned by hand in e2e/expected/supplementary-documents.json.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import * as yaml from 'yaml';
import { DIAGNOSTIC_CODES, OpenAPIToolError, OpenAPIToolGenerator } from '../src';
import type { LoadOptions, McpOpenAPITool } from '../src';
import { fixturePath, loadFixture } from './helpers/fixtures';
import { validateOasDocument, type SchemaVersion } from './helpers/oas-validate';
import { compileVirtual } from './helpers/tsc';

const repoRoot = join(__dirname, '..');

type Check = 'schema' | 'types' | 'validator' | 'generation' | 'diagnostics' | 'crash';

/**
 * `official`: the OAI test documents vendored under e2e/fixtures/oas.
 * `supplementary`: our own, under e2e/fixtures/supplementary.
 */
type Corpus = 'official' | 'supplementary';

/** One failure a gap covers: a reported line in full, or a pattern with the exact number of lines it matches. */
type Failure = string | { pattern: RegExp; count: number };

interface KnownGap {
  /** The documents' corpus; the official OAI documents unless stated. */
  corpus?: Corpus;
  version: SchemaVersion;
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
    category: 'security-scheme-in-another-document',
    reason:
      'The key `otherapi#/components/securitySchemes/generic_auth` is a URI that names ANOTHER document (a relative reference, so the document `otherapi` next to this one), and by design the schemes of another document are never read, so nothing is fetched for it: the requirement is ignored with an UNRESOLVED_SECURITY_SCHEME diagnostic. A key that names a scheme of THIS document by URI does resolve (the supplementary document `security-scheme-uri`). The story parses documents from text, with no base URI, so the diagnostic says there is none to resolve the reference against; with one it would say the scheme is in another document.',
    failures: [{ pattern: /^UNRESOLVED_SECURITY_SCHEME at \/paths\/~1pets~1\{id\}\/put\/security\/1[/:]/, count: 1 }],
    documents: ['operation-object-example'],
  },
];

type Namespace = 'OAS20' | 'OAS30' | 'OAS31' | 'OAS32';

/** The type of the document root in each namespace: Swagger 2.0 calls it the Swagger Object. */
const ROOT_TYPES: Record<Namespace, string> = {
  OAS20: 'SwaggerObject',
  OAS30: 'OpenAPIObject',
  OAS31: 'OpenAPIObject',
  OAS32: 'OpenAPIObject',
};

const VERSIONS: Array<{ version: SchemaVersion; namespace: Namespace; pass: number; fail: number }> = [
  // Seven files and one multi-file tree (`petstore-separate`, see TREES); the OAI repository has no 2.0 FAIL document
  { version: '2.0', namespace: 'OAS20', pass: 8, fail: 0 },
  { version: '3.0', namespace: 'OAS30', pass: 6, fail: 0 },
  { version: '3.1', namespace: 'OAS31', pass: 35, fail: 12 },
  { version: '3.2', namespace: 'OAS32', pass: 37, fail: 31 },
];

/**
 * What a tool shows of the OpenAPI 3.2 reads: a parameter that is the whole
 * query string, parameters serialized in a media type, a streamed response, the
 * names of the servers. Each key is present only when the tool has the fact, so
 * a tool with none has no `facts`, and that absence is pinned like any other
 * value.
 *
 * At the pinned set no official PASS document has a tool with a fact, in any
 * version, and the pins say so. The constructs do occur, where no tool reads
 * them: `in: querystring` and a query parameter with `content` only in the
 * path-level `parameters` of paths that have no operation
 * (`parameter-object-examples`: `/user`, and `/user/{username}` in 3.1 and
 * 3.2), which make no tool; parameters with `content` otherwise only in
 * `components.parameters` (`style-defaults`), which no operation references;
 * `itemSchema` only in `components.mediaTypes` (`media-type-examples`,
 * 3.2), reached from a request body whose chosen media type is
 * `application/json`, never from a response. The facts are therefore pinned
 * with positive values on our own documents (e2e/fixtures/supplementary,
 * checked below the official ones), and an absence pinned on an official one
 * means the tool does not have the fact.
 */
interface ToolFacts {
  /** The mapper entry that IS the whole query string (`wholeQuery`): the parameter's name and its media type. */
  wholeQuery?: { key: string; contentType: string };
  /**
   * Every other path, query, header or cookie entry serialized in a media type
   * (`serialization.contentType`, set when the parameter is defined with
   * `content`), by parameter name. Body entries carry one too, and are not facts.
   */
  parameterContentTypes?: Record<string, string>;
  /** The media type of the streamed response (`metadata.responseStream.contentType`). */
  responseStream?: string;
  /** The `name` of each server of the tool that has one (`metadata.servers`), in order. */
  serverNames?: string[];
  // The facts below are read for Swagger 2.0 documents only (version `2.0`); every other version leaves them out
  /**
   * The request body (the tool's `body` mapper entries): the media types its converted request body offers
   * (`requestBody.content` of the OpenAPI 3.0 document the library generated from), the one the tool sends, and the
   * input keys that are file parts (`serialization.binary`).
   */
  body?: { offered: string[]; sent: string; binary?: string[] };
  /**
   * Each array parameter outside the body, `<location>:<name>` to `<style>/<explode>` of its mapper entry
   * (`none` for a member the entry does not have): what `collectionFormat` became.
   */
  arrays?: Record<string, string>;
  /** `<scheme>:<type>` of each security mapper entry, in order. */
  security?: string[];
}

/**
 * The pinned tools of the PASS documents, `[name, method, path, readOnlyHint,
 * facts?]` in generation order. A document not listed declares no operation
 * under `paths` (it holds components, webhooks or nothing) and makes no tool.
 */
type ExpectedTool = [name: string, method: string, path: string, readOnlyHint: boolean, facts?: ToolFacts];
const OFFICIAL = (
  JSON.parse(readFileSync(join(__dirname, 'expected', 'official-documents.json'), 'utf8')) as {
    tools: Partial<Record<SchemaVersion, Record<string, ExpectedTool[]>>>;
    /** The server URLs of each Swagger 2.0 document (from `host`, `basePath` and `schemes`): every tool carries them. */
    servers: Partial<Record<SchemaVersion, Record<string, string[]>>>;
    /** The diagnostics an official document is meant to produce (a 2.0 document with no `host`), as `CODE at /pointer`. */
    diagnostics: Partial<Record<SchemaVersion, Record<string, string[]>>>;
  }
);
const EXPECTED_TOOLS = OFFICIAL.tools as Record<SchemaVersion, Record<string, ExpectedTool[]>>;

/** What is pinned for a supplementary `invalid` document: the validator's verdict, the tools, the diagnostics. */
interface InvalidExpectation {
  /** `valid`, and every error and warning written `error|warning CODE at /pointer`, errors first. */
  validator: { valid: boolean; findings: string[] };
  tools: ExpectedTool[];
  /** Each diagnostic generation reports, written `CODE at /pointer`. */
  diagnostics: string[];
  /** Input types of a tool's properties, see `SUPPLEMENTARY.inputTypes`. */
  inputTypes?: Record<string, Record<string, InputType>>;
  /**
   * Whether the official schema of the document's version accepts it, when it does (`accepts`): the default for an
   * `invalid` document is that it REJECTS it. A Swagger 2.0 document can break the 2.0 text with something the
   * official schema cannot see (a body parameter next to form parameters).
   */
  officialSchema?: 'accepts';
}

/** The `type` a pin names for an input property: `null` for no such property, a list for a nullable type. */
type InputType = string | string[] | null;

/**
 * The pinned tools, diagnostics and verdicts of our own documents
 * (e2e/fixtures/supplementary). `tools` is read like `EXPECTED_TOOLS`;
 * `diagnostics` lists, for a `pass` document that is meant to produce some,
 * each as `CODE at /pointer` (a document not listed produces none).
 */
const SUPPLEMENTARY = JSON.parse(readFileSync(join(__dirname, 'expected', 'supplementary-documents.json'), 'utf8')) as {
  tools: Partial<Record<SchemaVersion, Record<string, ExpectedTool[]>>>;
  diagnostics: Partial<Record<SchemaVersion, Record<string, string[]>>>;
  /**
   * The `type` of input properties, for a document where it is what tells a rule from its opposite: by document,
   * then tool name, then property (the parameter name); `null` says the tool has no such property.
   */
  inputTypes: Partial<Record<SchemaVersion, Record<string, Record<string, Record<string, InputType>>>>>;
  /**
   * The security schemes a tool resolves, for a document where it is which scheme a Security Requirement named
   * that matters (a key that is a URI): by document, then tool name, each scheme as `name:type` of the tool's
   * security entries (the order is not pinned).
   */
  securitySchemes: Partial<Record<SchemaVersion, Record<string, Record<string, string[]>>>>;
  invalid: Partial<Record<SchemaVersion, Record<string, InvalidExpectation>>>;
  /** The server URLs of each Swagger 2.0 document, `pass` and `invalid`: every tool carries them. */
  servers: Partial<Record<SchemaVersion, Record<string, string[]>>>;
};

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

const VALIDATOR_VERDICTS: Record<SchemaVersion, ValidatorVerdict[]> = {
  // The OAI repository has no Swagger 2.0 FAIL document: the invalid 2.0 documents are our own (supplementary)
  '2.0': [],
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
      rejectedByOurValidator: true,
      code: 'INVALID_FIELD_TYPE',
      reason: '`servers` is an object, not an array.',
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
      rejectedByOurValidator: true,
      code: 'INVALID_FIELD_TYPE',
      reason: '`servers` is an object, not an array.',
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
  'UNSUPPORTED_SECURITY_SCHEME',
  'INVALID_RESPONSE_KEY',
  'INVALID_SECURITY_REQUIREMENT',
  'UNSATISFIABLE_SECURITY',
  // an operation that fails to build, and a parameter, request body or response left as a reference not read
  'TOOL_GENERATION_FAILED',
  'UNRESOLVED_REFERENCE',
  // a parameter left out of the tool: a header the client or a credential sets, or where a credential is sent
  'PARAMETER_IGNORED',
  // `$self` (src/base-uri.ts): ignored, so the references of the document resolve as if it were absent
  // (against the retrieval URI, or the working directory when there is none): not a string or a URI reference
  // without a fragment, a form the library refuses to use as a base, a relative one with nothing to resolve it against
  'INVALID_SELF',
  'REFUSED_SELF',
  'UNRESOLVABLE_SELF',
  // the URI the document was retrieved from is past 2,048 characters, so it is not used: its relative references
  // fail the load. Recorded when the generator is created, from `fromURL` (a long final URL) or `fromFile`; a
  // document the story parses from text has no retrieval URI to be too long
  'BASE_URI_TOO_LONG',
  // a validation error, never a `getDiagnostics()` entry: `validate()` returns it, instead of throwing, for a
  // reference that cannot be read. Listed so that one that ever appears there is reported, not unclassified;
  // the story below pins that it is returned and not recorded
  'UNREADABLE_REFERENCE',
  // OpenAPI 3.2 querystring rules: the operation makes no tool (a validation error, seen with `validate: false`)
  'MULTIPLE_QUERYSTRING_PARAMETERS',
  'QUERYSTRING_WITH_QUERY_PARAMETERS',
  'QUERYSTRING_PARAMETER_WITHOUT_CONTENT',
  // a parameter dropped as a repeat of another; a `content` that is not one media type
  // (empty: ignored, several: one is picked)
  'DUPLICATE_PARAMETER',
  'INVALID_PARAMETER_CONTENT',
  // a request body that declares only `itemSchema`: the tool takes no body input
  'UNSUPPORTED_STREAMING_REQUEST_BODY',
  // a parameter `name` that is not a string: a number or boolean is read as its text (a note that the document is
  // off, since the official schemas say `string`), anything else cannot be sent and the operation makes no tool
  'PARAMETER_NAME_NOT_STRING',
  'INVALID_PARAMETER_NAME',
  // the tool is made, but no call of it can succeed: a required input whose schema is `false` or `{ not: {} }`
  'REQUIRED_INPUT_ACCEPTS_NOTHING',
  // the tool is made, with a schema cut shallower than maxSchemaDepth: at that depth it exceeds maxSchemaNodes
  'SCHEMA_DEPTH_REDUCED',
  // the tool is made, but a call with some values cannot be built: a JSON cookie value that holds `"` or `,`, an API key
  // in the query string next to a whole query string that is not form-encoded
  'COOKIE_CONTENT_NOT_SENDABLE',
  'QUERYSTRING_WITH_QUERY_CREDENTIAL',
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
  // (a Swagger 2.0 document: `trace`, `query` and `additionalOperations` are not part of it either)
  'FEATURE_NEWER_THAN_DECLARED_VERSION',
  // a Swagger 2.0 document is converted to OpenAPI 3.0 first (src/spec/upgrade-v2.ts); each of these says the conversion
  // could not carry something over exactly, or had to assume something. A `SWAGGER_*` diagnostic of severity `info` is a
  // note that changes nothing a tool does (see `isInformational`)
  'SWAGGER_VERSION_NOT_2_0',
  'SWAGGER_INVALID_VALUE',
  'SWAGGER_NOT_CONVERTED',
  'SWAGGER_UNRESOLVED_REFERENCE',
  'SWAGGER_RELATIVE_SERVER_URL',
  'SWAGGER_ASSUMED_SCHEME',
  'SWAGGER_FORM_MEDIA_TYPE_ADDED',
  'SWAGGER_MULTIPLE_BODY_PARAMETERS',
  'SWAGGER_BODY_AND_FORM_DATA',
  'SWAGGER_DUPLICATE_FORM_DATA_PARAMETER',
  'SWAGGER_UNSUPPORTED_COLLECTION_FORMAT',
  'SWAGGER_FILE_OUTSIDE_FORM_DATA',
  'SWAGGER_UNSUPPORTED_SECURITY_SCHEME',
  // a bound on a conversion was reached: a `consumes` or `produces` list was cut, or the whole conversion abandoned
  'SWAGGER_MEDIA_TYPE_LIMIT',
  'SWAGGER_CONVERSION_TOO_LARGE',
  // a Swagger 2.0 document loaded with `dereference: false`: a validation error, never a `getDiagnostics()` entry
  'DEREFERENCE_REQUIRED',
  // the cap on diagnostics: findings were dropped, so none of the above can be ruled out
  'DIAGNOSTICS_TRUNCATED',
]);

/**
 * Warnings only the validator raises, which `generator.getDiagnostics()` forwards once validation runs. This story
 * generates with `validate: false` (validation is its layer 3, `validatorProblems`), so none of them can occur here; they
 * are listed so that every code of the library is classified somewhere (see the test of that name).
 */
const VALIDATOR_WARNING_CODES: ReadonlySet<string> = new Set([
  'NO_PATHS',
  'NO_OPERATIONS',
  'NO_OPERATION_ID',
  'DUPLICATE_OPERATION_ID',
  'NO_SERVERS',
  'NO_SECURITY_SCHEMES',
]);

/**
 * Diagnostic codes that note something processed anyway. The two `SWAGGER_*` codes here are only ever `info`: a field
 * Swagger 2.0 does not define was left out, a media type was assumed where none applies.
 */
const INFORMATIONAL_CODES: ReadonlySet<string> = new Set([
  'NEWER_OPENAPI_VERSION',
  'SWAGGER_UNKNOWN_FIELD',
  'SWAGGER_ASSUMED_MEDIA_TYPE',
]);

/**
 * Whether a diagnostic only notes something. A Swagger 2.0 conversion diagnostic of severity `info` is one (the
 * generator documents them as notes "that change nothing a tool does"): `SWAGGER_NOT_CONVERTED` is `info` for an
 * `in: formData` parameter defined in the global `parameters`, which cannot be a 3.0 component but still reaches
 * every operation that uses it.
 */
const isInformational = ({ code, severity }: { code: string; severity?: string }): boolean =>
  INFORMATIONAL_CODES.has(code) || (code.startsWith('SWAGGER_') && severity === 'info');

// ---------------------------------------------------------------------------
// Known gaps
// ---------------------------------------------------------------------------

const gapKey = (corpus: Corpus, version: SchemaVersion, check: Check, document: string): string =>
  `${corpus}/${version}/${check}/${document}`;

const gapsFor = (corpus: Corpus, version: SchemaVersion, check: Check, document: string): KnownGap[] =>
  KNOWN_GAPS.filter(
    (gap) =>
      (gap.corpus ?? 'official') === corpus &&
      gap.version === version &&
      gap.check === check &&
      (gap.documents === 'all' || gap.documents.includes(document)),
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
function expectCheck(ref: DocRef, check: Check, problems: string[]): void {
  const { corpus, version, name: document } = ref;
  const entries = gapsFor(corpus, version, check, document);
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
      `${gapKey(corpus, version, check, document)} no longer fails exactly as KNOWN_GAPS records: ${stale.join('; ')}. ` +
        `Delete "${document}" or the failure from the entry (or correct it).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * `pass`: valid against the official schema. `fail`: an official document the
 * schema rejects. `invalid`: a supplementary document that is deliberately invalid.
 */
type Kind = 'pass' | 'fail' | 'invalid';
type Doc = Record<string, unknown>;

/** A document of the story: its corpus, its version, whether it must validate, and its name without `.yaml`. */
interface DocRef {
  corpus: Corpus;
  version: SchemaVersion;
  kind: Kind;
  name: string;
}

const CORPUS_FOLDERS: Record<Corpus, string> = { official: 'oas/documents', supplementary: 'supplementary' };

/**
 * A document that is a tree of files, not one file: its name is the folder under `<version>/pass` and its entry the
 * root file inside it. It is read with `fromFile` (`file` the only protocol allowed, so the story still touches no
 * network), its references to the other files are resolved by the library, and the checks that read the document as
 * written (the schema, the types) read the root file with its references unresolved.
 */
const TREES: Partial<Record<`${Corpus}/${SchemaVersion}/${Kind}/${string}`, string>> = {
  'official/2.0/pass/petstore-separate': 'spec/swagger.yaml',
};

const treeEntry = ({ corpus, version, kind, name }: DocRef): string | undefined =>
  TREES[`${corpus}/${version}/${kind}/${name}`];

const documentNames = (corpus: Corpus, version: SchemaVersion, kind: Kind): string[] => {
  try {
    const trees = Object.keys(TREES)
      .filter((key) => key.startsWith(`${corpus}/${version}/${kind}/`))
      .map((key) => key.slice(`${corpus}/${version}/${kind}/`.length));
    return [
      ...readdirSync(fixturePath(`${CORPUS_FOLDERS[corpus]}/${version}/${kind}`))
        .filter((file) => file.endsWith('.yaml'))
        .map((file) => file.slice(0, -'.yaml'.length)),
      ...trees,
    ].sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

const documentFile = (ref: DocRef): string => {
  const { corpus, version, kind, name } = ref;
  const entry = treeEntry(ref);
  return `${CORPUS_FOLDERS[corpus]}/${version}/${kind}/${entry === undefined ? `${name}.yaml` : `${name}/${entry}`}`;
};

/** A fresh parse each time: the generator and the validator never see a shared object. */
const loadDocument = (ref: DocRef): Doc => yaml.parse(loadFixture(documentFile(ref))) as Doc;

/** Reads the files of a tree, and nothing else: no network, no other protocol. */
const FILES_ONLY: LoadOptions = { refResolution: { allowedProtocols: ['file'] } };

/**
 * A generator over the document: parsed from text with every external reference refused (`options`, by default the
 * story's `OFFLINE`), or, for a tree, read from its root file with `file` allowed.
 */
const openGenerator = (ref: DocRef, options: LoadOptions = OFFLINE): Promise<OpenAPIToolGenerator> =>
  treeEntry(ref) === undefined
    ? OpenAPIToolGenerator.fromJSON(loadDocument(ref), options)
    : OpenAPIToolGenerator.fromFile(fixturePath(documentFile(ref)), { ...options, ...FILES_ONLY });

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

/** Compiles every PASS document of a version as `const d: <namespace>.OpenAPIObject = <literal>;` in one virtual file (Swagger 2.0: `OAS20.SwaggerObject`). */
function typeCheckDocuments(corpus: Corpus, version: SchemaVersion, namespace: Namespace, names: string[]): TypeCheck {
  let source = `import type { ${namespace} } from '../src/spec';\n`;
  const spans: Array<{ name: string; start: number; end: number }> = [];
  names.forEach((name, index) => {
    const literal = JSON.stringify(stripExtensions(loadDocument({ corpus, version, kind: 'pass', name })), null, 2);
    const start = source.length;
    source += `const doc${index}: ${namespace}.${ROOT_TYPES[namespace]} = ${literal};\n`;
    spans.push({ name, start, end: source.length });
  });

  const diagnostics = compileVirtual(`${corpus}-${version}.ts`, source, {
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

async function validatorProblems(ref: DocRef): Promise<string[]> {
  const generator = await openGenerator(ref);
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

/** Generates a document's tools with validation off, keeping the generator's diagnostics. */
async function generate(ref: DocRef) {
  let generator: OpenAPIToolGenerator | undefined;
  const { value, error, warnings } = await withWarnings(async () => {
    generator = await openGenerator(ref, { ...OFFLINE, validate: false });
    return generator.generateTools();
  });
  return { tools: value, error, warnings, diagnostics: generator?.getDiagnostics() ?? [], generator };
}

/** `JSON.stringify` with the keys of every object sorted, so two spellings of one value compare equal. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

/** The facts of a generated tool (see `ToolFacts`); `undefined` when it has none. */
function toolFacts(tool: McpOpenAPITool): ToolFacts | undefined {
  const facts: ToolFacts = {};
  const parameterContentTypes: Record<string, string> = {};
  for (const entry of tool.mapper) {
    const contentType = entry.serialization?.contentType;
    if (entry.wholeQuery) facts.wholeQuery = { key: entry.key, contentType: contentType ?? '' };
    else if (entry.type !== 'body' && contentType !== undefined) {
      parameterContentTypes[`${entry.type}:${entry.key}`] = contentType;
    }
  }
  if (Object.keys(parameterContentTypes).length > 0) facts.parameterContentTypes = parameterContentTypes;
  if (tool.metadata.responseStream) facts.responseStream = tool.metadata.responseStream.contentType;
  const serverNames = (tool.metadata.servers ?? []).flatMap((server) => (server.name === undefined ? [] : server.name));
  if (serverNames.length > 0) facts.serverNames = serverNames;
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/**
 * The facts only a Swagger 2.0 reader has to translate (see `ToolFacts`), of one tool, read from the tool and from
 * the OpenAPI 3.0 document it was generated from (`document`: the generator's `getDocument()` once it has generated).
 */
function swagger2Facts(tool: McpOpenAPITool, document: Doc): ToolFacts {
  const facts: ToolFacts = {};
  const bodies = tool.mapper.filter((entry) => entry.type === 'body');
  if (bodies.length > 0) {
    const operation = (document['paths'] as Doc)[tool.metadata.path] as Doc;
    const requestBody = (operation[tool.metadata.method] as Doc)['requestBody'] as Doc | undefined;
    const sent = [...new Set(bodies.map((entry) => entry.serialization?.contentType ?? '(none)'))];
    const binary = bodies.filter((entry) => entry.serialization?.binary).map((entry) => entry.inputKey);
    facts.body = {
      offered: Object.keys((requestBody?.['content'] ?? {}) as Doc),
      sent: sent.join(' + '),
      ...(binary.length > 0 ? { binary } : {}),
    };
  }
  const properties = (tool.inputSchema as { properties?: Record<string, { type?: unknown }> }).properties ?? {};
  const arrays: Record<string, string> = {};
  for (const entry of tool.mapper) {
    if (entry.type === 'body' || entry.security) continue;
    const type = properties[entry.inputKey]?.type;
    if (type === 'array' || (Array.isArray(type) && type.includes('array'))) {
      arrays[`${entry.type}:${entry.key}`] = `${entry.style ?? 'none'}/${entry.explode ?? 'none'}`;
    }
  }
  if (Object.keys(arrays).length > 0) facts.arrays = arrays;
  const security = tool.mapper.flatMap(({ security: scheme }) => (scheme ? [`${scheme.scheme}:${scheme.type}`] : []));
  if (security.length > 0) facts.security = security;
  return facts;
}

/**
 * A generated tool as it is pinned: `facts` is left out, not `undefined`, when it has none. `converted` is the
 * OpenAPI 3.0 document a Swagger 2.0 tool was generated from, which adds the Swagger 2.0 facts.
 */
function pinnedTool(tool: McpOpenAPITool, converted?: Doc): ExpectedTool {
  const facts = { ...toolFacts(tool), ...(converted ? swagger2Facts(tool, converted) : {}) };
  const pinned: ExpectedTool = [
    tool.name,
    tool.metadata.method,
    tool.metadata.path,
    tool.annotations?.readOnlyHint as boolean,
  ];
  if (Object.keys(facts).length > 0) pinned.push(facts);
  return pinned;
}

const describeTool = ([name, method, path, readOnlyHint, facts]: ExpectedTool): string =>
  `${name} (${method} ${path}, readOnlyHint ${readOnlyHint}${facts ? `, facts ${canonical(facts)}` : ''})`;

/** Generation failures: an error, an operation reported failing, and every difference from the pinned tools. */
async function generationProblems(ref: DocRef, expected: ExpectedTool[]): Promise<string[]> {
  const { tools, error, warnings, generator } = await generate(ref);
  if (error) return [`${error instanceof Error ? error.name : 'thrown'}: ${(error as Error).message}`];
  const problems = warnings.map((warning) => `warning: ${warning}`);

  const converted = ref.version === '2.0' ? (generator!.getDocument() as unknown as Doc) : undefined;
  const actual = tools!.map((tool) => pinnedTool(tool, converted));
  const unmatched = actual.map(canonical);
  for (const tool of expected) {
    const index = unmatched.indexOf(canonical(tool));
    if (index < 0) problems.push(`missing tool ${describeTool(tool)}`);
    else unmatched.splice(index, 1);
  }
  for (const unexpected of unmatched) problems.push(`unexpected tool ${describeTool(JSON.parse(unexpected))}`);
  if (problems.length === warnings.length && canonical(actual) !== canonical(expected)) {
    problems.push(
      `tool order: expected ${expected.map(describeTool).join(', ')}; got ${actual.map(describeTool).join(', ')}`,
    );
  }
  return problems;
}

/**
 * The diagnostics of generating a document that say something was not
 * processed, or are not classified. `expected` lists, as `CODE at /pointer`, the
 * ones the document is meant to produce (a supplementary document that
 * exercises a diagnostic): each is then a problem only when it does not occur,
 * and every other one is a problem as before. An unclassified code is a problem
 * even when expected.
 */
async function diagnosticProblems(ref: DocRef, expected: string[] = []): Promise<string[]> {
  const { diagnostics } = await generate(ref);
  const remaining = [...expected];
  const problems: string[] = [];
  for (const { code, path, message } of diagnostics.filter((found) => !isInformational(found))) {
    const key = `${code} at ${path ?? '/'}`;
    const index = remaining.indexOf(key);
    if (index >= 0) remaining.splice(index, 1);
    if (!UNPROCESSED_CODES.has(code)) {
      problems.push(
        `${key}: unclassified diagnostic code, add it to UNPROCESSED_CODES or INFORMATIONAL_CODES: ${message}`,
      );
    } else if (index < 0) {
      problems.push(`${key}: ${message}`);
    }
  }
  for (const missing of remaining) problems.push(`missing diagnostic ${missing}`);
  return problems;
}

/** What our validator reports for a document, as `valid` and each finding written `error|warning CODE at /pointer`. */
async function validatorVerdict(ref: DocRef): Promise<{ valid: boolean; findings: string[] }> {
  const generator = await openGenerator(ref);
  const result = await generator.validate();
  const finding = (level: string) => (entry: { code?: string; path?: string }) =>
    `${level} ${entry.code} at ${entry.path ?? '/'}`;
  return {
    valid: result.valid,
    findings: [...(result.errors ?? []).map(finding('error')), ...(result.warnings ?? []).map(finding('warning'))],
  };
}

const describeType = (type: unknown): string => (type === null ? 'no such property' : `type ${JSON.stringify(type)}`);

/** The `type` of each pinned input property that the tools generate differently: `tool.property -> type`. */
async function inputTypeProblems(ref: DocRef, expected: Record<string, Record<string, InputType>>): Promise<string[]> {
  const { tools } = await generate(ref);
  const problems: string[] = [];
  for (const [toolName, properties] of Object.entries(expected)) {
    const tool = tools?.find(({ name }) => name === toolName);
    if (!tool) {
      problems.push(`no tool ${toolName} to read the input types of`);
      continue;
    }
    for (const [property, type] of Object.entries(properties)) {
      const schema = (tool.inputSchema as { properties?: Record<string, { type?: unknown }> }).properties?.[property];
      const found = schema === undefined ? null : (schema.type ?? 'untyped');
      if (canonical(found) !== canonical(type)) {
        problems.push(`${toolName}.${property}: ${describeType(found)}, expected ${describeType(type)}`);
      }
    }
  }
  return problems;
}

/**
 * The security schemes each pinned tool resolves, `name:type` of its mapper's security entries. A Security
 * Requirement key that is a URI is read as a scheme of this document or of another one, so the pin says which
 * scheme it became (a tool with a wrong scheme, or none, is a difference).
 */
async function securityProblems(ref: DocRef, expected: Record<string, string[]>): Promise<string[]> {
  const { tools } = await generate(ref);
  const problems: string[] = [];
  for (const [toolName, schemes] of Object.entries(expected)) {
    const tool = tools?.find(({ name }) => name === toolName);
    if (!tool) {
      problems.push(`no tool ${toolName} to read the security schemes of`);
      continue;
    }
    const found = tool.mapper.flatMap(({ security }) => (security ? [`${security.scheme}:${security.type}`] : []));
    if (canonical([...found].sort()) !== canonical([...schemes].sort())) {
      problems.push(`${toolName}: security schemes ${found.join(', ') || 'none'}, expected ${schemes.join(', ') || 'none'}`);
    }
  }
  return problems;
}

/**
 * The server URLs of a Swagger 2.0 document, from its `host`, `basePath` and `schemes`: the converted document's own
 * `servers` and the `servers` every tool carries must each be exactly the pinned list, in order.
 */
async function serverProblems(ref: DocRef, expected: string[]): Promise<string[]> {
  const { tools, generator } = await generate(ref);
  const urls = (servers: unknown): string[] => ((servers ?? []) as Array<{ url: string }>).map(({ url }) => url);
  const problems: string[] = [];
  const document = urls(generator!.getDocument().servers);
  if (canonical(document) !== canonical(expected)) {
    problems.push(`servers of the converted document: ${document.join(', ')}, expected ${expected.join(', ')}`);
  }
  for (const tool of tools ?? []) {
    const found = urls(tool.metadata.servers);
    if (canonical(found) !== canonical(expected)) {
      problems.push(`${tool.name}: servers ${found.join(', ') || 'none'}, expected ${expected.join(', ')}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Supplementary documents: what the schema cannot say about a server-sent event
// ---------------------------------------------------------------------------

/** The fields of a parsed server-sent event: the HTML `text/event-stream` format has no others. */
const EVENT_FIELDS = ['data', 'event', 'id', 'retry'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Follows a chain of `$ref`s inside the document; anything else is returned as it is. */
function resolveLocalRef(document: Doc, node: unknown): unknown {
  for (let hops = 0; isRecord(node) && typeof node['$ref'] === 'string' && hops < 10; hops++) {
    const ref: string = node['$ref'];
    if (!ref.startsWith('#/')) return node;
    node = ref
      .slice(2)
      .split('/')
      .map((segment) => decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), document);
  }
  return node;
}

/**
 * OpenAPI 3.2 ("Special Considerations for Server-Sent Events"): an
 * `itemSchema` of `text/event-stream` applies to an event AFTER it is parsed,
 * an object with the fields of the format (`data`, `event`, `id`, `retry`),
 * every one a string or integer. A schema that names any other property, say
 * the fields of the JSON a `data` line carries, can never match an event: that
 * JSON is described under `data` with `contentMediaType` and `contentSchema`.
 * Reports each such property of an event-stream `itemSchema` anywhere in the document.
 */
function eventStreamItemProblems(document: Doc): string[] {
  const problems: string[] = [];
  const visit = (node: unknown, pointer: string): void => {
    if (!isRecord(node) && !Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const at = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
      if (/^text\/event-stream\s*(;|$)/i.test(key) && isRecord(value) && 'itemSchema' in value) {
        const item = resolveLocalRef(document, value['itemSchema']);
        const named = isRecord(item)
          ? [...Object.keys(isRecord(item['properties']) ? item['properties'] : {}), ...[item['required']].flat()]
          : [];
        for (const name of new Set(named.filter((entry): entry is string => typeof entry === 'string'))) {
          if (!EVENT_FIELDS.includes(name)) {
            problems.push(`${at}/itemSchema: '${name}' is not a field of an event (${EVENT_FIELDS.join(', ')})`);
          }
        }
      }
      visit(value, at);
    }
  };
  visit(document, '');
  return problems;
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
async function crashes(ref: DocRef): Promise<string[]> {
  const found: string[] = [];
  const attempt = async (stage: string, run: () => Promise<unknown>): Promise<void> => {
    const { error } = await withWarnings(run);
    if (error !== undefined && !(error instanceof OpenAPIToolError)) found.push(describeCrash(stage, error));
  };
  const load = (options: LoadOptions) => openGenerator(ref, options);

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
  const corpus: Corpus = 'official';
  const passNames = documentNames(corpus, version, 'pass');
  const failNames = documentNames(corpus, version, 'fail');
  const ref = (kind: Kind, name: string): DocRef => ({ corpus, version, kind, name });
  let typeCheck: TypeCheck;

  beforeAll(() => {
    typeCheck = typeCheckDocuments(corpus, version, namespace, passNames);
  });

  it('vendors the pinned set of documents', () => {
    expect({ pass: passNames.length, fail: failNames.length }).toEqual({ pass, fail });
  });

  it('pins tools for existing documents only, and lists known gaps for existing documents only', () => {
    expect(Object.keys(EXPECTED_TOOLS[version] ?? {}).filter((name) => !passNames.includes(name))).toEqual([]);
    expect(Object.keys(OFFICIAL.servers[version] ?? {}).filter((name) => !passNames.includes(name))).toEqual([]);
    expect(Object.keys(OFFICIAL.diagnostics[version] ?? {}).filter((name) => !passNames.includes(name))).toEqual([]);
    const unknown = KNOWN_GAPS.filter((gap) => (gap.corpus ?? 'official') === corpus && gap.version === version).flatMap(
      (gap) =>
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
    const document = ref('pass', name);

    it('validates against the official schema', () => {
      expectCheck(document, 'schema', validateOasDocument(version, loadDocument(document)).errors);
    });

    it('type-checks against our types', () => {
      expectCheck(document, 'types', typeCheck.byDocument.get(name)!);
    });

    it('is accepted by our validator', async () => {
      expectCheck(document, 'validator', await validatorProblems(document));
    });

    it('generates the pinned tools', async () => {
      expectCheck(document, 'generation', await generationProblems(document, EXPECTED_TOOLS[version]?.[name] ?? []));
    });

    if (version === '2.0') {
      it('serves the pinned servers, from host, basePath and schemes', async () => {
        expectCheck(document, 'generation', await serverProblems(document, OFFICIAL.servers[version]![name]));
      });
    }

    it('generates exactly the pinned diagnostics: none for something it could not process', async () => {
      const expected = OFFICIAL.diagnostics[version]?.[name] ?? [];
      expectCheck(document, 'diagnostics', await diagnosticProblems(document, expected));
    });
  });

  if (failNames.length > 0) {
    describe.each(failNames)('fail/%s', (name) => {
      const document = ref('fail', name);

      it('is rejected by the official schema', () => {
        expect(validateOasDocument(version, loadDocument(document)).valid).toBe(false);
      });

      it('is rejected by our validator exactly as recorded', async () => {
        const verdict = VALIDATOR_VERDICTS[version].find(({ document: failing }) => failing === name)!;
        const generator = await openGenerator(document);
        const result = await generator.validate();
        expect({ document: name, rejectedByOurValidator: !result.valid }).toEqual({
          document: name,
          rejectedByOurValidator: verdict.rejectedByOurValidator,
        });
        if (verdict.code) expect((result.errors ?? []).map((error) => error.code)).toContain(verdict.code);
      });

      it('never crashes the pipeline', async () => {
        expectCheck(document, 'crash', await crashes(document));
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Supplementary documents: ours, through the same checks
// ---------------------------------------------------------------------------

/**
 * Our own documents, e2e/fixtures/supplementary (see its README): one for each
 * construct the official ones leave out where a tool is built. Each `pass`
 * document is held to exactly the five checks of an official PASS document, with
 * no known gap allowed, and its tools and facts are pinned in
 * e2e/expected/supplementary-documents.json, written from the document and the
 * specification before the library's output was compared; a `text/event-stream`
 * `itemSchema` must also describe the parsed event (`eventStreamItemProblems`). An `invalid` document
 * is deliberately not valid against the official schema of its version (the
 * schema must reject it, which is asserted; a document that merely failed the
 * schema by accident would belong in `pass`), so the schema and type checks do
 * not apply: the library's own verdict, tools and diagnostics are pinned instead.
 */
const SUPPLEMENTARY_VERSIONS: Array<{
  version: SchemaVersion;
  namespace: Namespace;
  pass: number;
  invalid: number;
}> = [
  { version: '2.0', namespace: 'OAS20', pass: 10, invalid: 2 },
  { version: '3.0', namespace: 'OAS30', pass: 2, invalid: 0 },
  { version: '3.1', namespace: 'OAS31', pass: 2, invalid: 3 },
  { version: '3.2', namespace: 'OAS32', pass: 19, invalid: 2 },
];

describe.each(SUPPLEMENTARY_VERSIONS)(
  'story: supplementary OpenAPI $version documents',
  ({ version, namespace, pass, invalid }) => {
    const corpus: Corpus = 'supplementary';
    const passNames = documentNames(corpus, version, 'pass');
    const invalidNames = documentNames(corpus, version, 'invalid');
    const ref = (kind: Kind, name: string): DocRef => ({ corpus, version, kind, name });
    const pinnedTools = SUPPLEMENTARY.tools[version] ?? {};
    const pinnedDiagnostics = SUPPLEMENTARY.diagnostics[version] ?? {};
    const pinnedInputTypes = SUPPLEMENTARY.inputTypes[version] ?? {};
    const pinnedSecurity = SUPPLEMENTARY.securitySchemes[version] ?? {};
    const pinnedInvalid = SUPPLEMENTARY.invalid[version] ?? {};
    const pinnedServers = SUPPLEMENTARY.servers[version] ?? {};
    let typeCheck: TypeCheck;

    beforeAll(() => {
      typeCheck = typeCheckDocuments(corpus, version, namespace, passNames);
    });

    it('holds the pinned set of documents', () => {
      expect({ pass: passNames.length, invalid: invalidNames.length }).toEqual({ pass, invalid });
    });

    it('pins tools and diagnostics for existing documents only, and invalid ones for invalid documents only', () => {
      expect(Object.keys(pinnedTools).filter((name) => !passNames.includes(name))).toEqual([]);
      expect(Object.keys(pinnedDiagnostics).filter((name) => !passNames.includes(name))).toEqual([]);
      expect(Object.keys(pinnedInputTypes).filter((name) => !passNames.includes(name))).toEqual([]);
      expect(Object.keys(pinnedSecurity).filter((name) => !passNames.includes(name))).toEqual([]);
      expect(Object.keys(pinnedInvalid).sort()).toEqual(invalidNames);
      // Swagger 2.0 only: the servers of every document, `pass` and `invalid`
      expect(Object.keys(pinnedServers).sort()).toEqual(version === '2.0' ? [...passNames, ...invalidNames].sort() : []);
      expect(KNOWN_GAPS.filter((gap) => gap.corpus === corpus && gap.version === version)).toEqual([]);
    });

    it('resolves the spec types the documents are checked against', () => {
      expect(typeCheck.unattributed).toEqual([]);
    });

    describe.each(passNames)('pass/%s', (name) => {
      const document = ref('pass', name);

      it('validates against the official schema', () => {
        expectCheck(document, 'schema', validateOasDocument(version, loadDocument(document)).errors);
      });

      it('type-checks against our types', () => {
        expectCheck(document, 'types', typeCheck.byDocument.get(name)!);
      });

      it('is accepted by our validator', async () => {
        expectCheck(document, 'validator', await validatorProblems(document));
      });

      it('generates the pinned tools', async () => {
        expectCheck(document, 'generation', await generationProblems(document, pinnedTools[name] ?? []));
      });

      it('generates exactly the pinned diagnostics', async () => {
        expectCheck(document, 'diagnostics', await diagnosticProblems(document, pinnedDiagnostics[name] ?? []));
      });

      it('reads the pinned parameters as the pinned input types', async () => {
        expectCheck(document, 'generation', await inputTypeProblems(document, pinnedInputTypes[name] ?? {}));
      });

      it('resolves the pinned security requirements to the pinned schemes', async () => {
        expectCheck(document, 'generation', await securityProblems(document, pinnedSecurity[name] ?? {}));
      });

      if (version === '2.0') {
        it('serves the pinned servers, from host, basePath and schemes', async () => {
          expectCheck(document, 'generation', await serverProblems(document, pinnedServers[name]));
        });
      }

      it('describes a server-sent event as an event, not as the value its data field carries', () => {
        expect(eventStreamItemProblems(loadDocument(document))).toEqual([]);
      });
    });

    if (invalidNames.length > 0) {
      describe.each(invalidNames)('invalid/%s', (name) => {
        const document = ref('invalid', name);
        const expected = (): InvalidExpectation => pinnedInvalid[name];

        // The official schema rejects an `invalid` document, unless the pin says it cannot see what is wrong with it
        const accepted = (): boolean => expected().officialSchema === 'accepts';

        it(`is ${pinnedInvalid[name]?.officialSchema === 'accepts' ? 'ACCEPTED' : 'rejected'} by the official schema`, () => {
          expect(validateOasDocument(version, loadDocument(document)).valid).toBe(accepted());
        });

        it('gets the pinned verdict from our validator', async () => {
          expect(await validatorVerdict(document)).toEqual(expected().validator);
        });

        if (version === '2.0') {
          it('serves the pinned servers, from host, basePath and schemes', async () => {
            expectCheck(document, 'generation', await serverProblems(document, pinnedServers[name]));
          });
        }

        it('generates the pinned tools', async () => {
          expectCheck(document, 'generation', await generationProblems(document, expected().tools));
        });

        it('generates exactly the pinned diagnostics', async () => {
          expectCheck(document, 'diagnostics', await diagnosticProblems(document, expected().diagnostics));
        });

        it('reads the pinned parameters as the pinned input types', async () => {
          expectCheck(document, 'generation', await inputTypeProblems(document, expected().inputTypes ?? {}));
        });

        it('never crashes the pipeline', async () => {
          expectCheck(document, 'crash', await crashes(document));
        });
      });
    }
  },
);

describe('story: official OpenAPI documents, diagnostic codes', () => {
  it('classifies only diagnostic codes the library defines', () => {
    // A misspelled code would never match a diagnostic, and the document that produces it would fail as unclassified
    const defined = new Set<string>(Object.values(DIAGNOSTIC_CODES));
    expect([...UNPROCESSED_CODES, ...INFORMATIONAL_CODES, ...VALIDATOR_WARNING_CODES].filter((code) => !defined.has(code))).toEqual([]);
    expect([...UNPROCESSED_CODES].filter((code) => INFORMATIONAL_CODES.has(code))).toEqual([]);
    expect([...VALIDATOR_WARNING_CODES].filter((code) => UNPROCESSED_CODES.has(code) || INFORMATIONAL_CODES.has(code))).toEqual([]);
  });

  it('classifies every diagnostic code the library defines, so a new one has to be classified here', () => {
    const classified = new Set([...UNPROCESSED_CODES, ...INFORMATIONAL_CODES, ...VALIDATOR_WARNING_CODES]);
    expect(Object.values(DIAGNOSTIC_CODES).filter((code) => !classified.has(code))).toEqual([]);
  });

  it('classifies every Swagger 2.0 conversion code, so a new one has to be classified here', () => {
    const swagger = Object.values(DIAGNOSTIC_CODES).filter((code) => code.startsWith('SWAGGER_'));
    expect(swagger.length).toBeGreaterThan(0);
    expect(swagger.filter((code) => !UNPROCESSED_CODES.has(code) && !INFORMATIONAL_CODES.has(code))).toEqual([]);
  });
});

describe('story: official OpenAPI documents, an unreadable reference', () => {
  // The supplementary `self-uri` document names itself by `$self`: pointing one reference at a schema it does not
  // have is a reference the library cannot read, whatever `refResolution` allows
  it('is a validation error that validate() returns, and never a diagnostic', async () => {
    const document = loadDocument({ corpus: 'supplementary', version: '3.2', kind: 'pass', name: 'self-uri' });
    const text = JSON.stringify(document).replace('#/components/schemas/PetId', '#/components/schemas/Missing');
    const generator = await OpenAPIToolGenerator.fromJSON(JSON.parse(text) as object, OFFLINE);

    const result = await generator.validate();
    expect(result.valid).toBe(false);
    expect(result.errors?.map(({ code, path }) => [code, path])).toEqual([
      ['UNREADABLE_REFERENCE', '/paths/~1pets~1{petId}/get/parameters/0/schema'],
    ]);
    expect(generator.getDiagnostics().map(({ code }) => code)).not.toContain('UNREADABLE_REFERENCE');
    // generation throws the same finding, as a ParseError
    await expect(generator.generateTools()).rejects.toMatchObject({ context: { rule: 'missing-target' } });
  });
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
