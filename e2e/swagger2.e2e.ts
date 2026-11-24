/**
 * Swagger 2.0 story: the library reads a Swagger 2.0 document by converting it to OpenAPI 3.0
 * (`upgradeSwagger2` from openapi-spec) once it is dereferenced, and generates from that. This story holds the
 * conversion to the specifications, not to its own output:
 *
 * 1. CONFORMANCE. Every Swagger 2.0 document we have (the official examples including the multi-file tree, our
 *    supplementary ones, the vendored Netlify description, the Lending Library API in one file and in twelve) is
 *    converted twice, by the generator (`getDocument()` after generation) and by `upgradeSwagger2` on the document
 *    dereferenced by `@apidevtools/json-schema-ref-parser` itself. The two must be the same document, and each must
 *    validate against the OFFICIAL OpenAPI 3.0 JSON Schema (e2e/helpers/oas-validate.ts, offline), keep none of the
 *    2.0-only members, and not change its input. A recursive schema makes the converted document a cyclic graph, which a
 *    JSON Schema validator cannot walk: each back-edge is replaced by a `$ref` to the schema it returns to (a
 *    well-formed Reference Object) before validating, and nothing else is changed. `CONSTRUCTS` is the table of what each
 *    document holds that only Swagger 2.0 has (a string `discriminator`, `type: file`, `collectionFormat`, `x-nullable`,
 *    `in: body` and `in: formData`, ...), checked against a scan of the document. NO document is blocked: every
 *    document converts to a document the official schema accepts in full, a string `discriminator`, `type: file` and a
 *    missing `scopes` included, and so does each of the `invalid/` ones, which the conversion repairs where a repair is
 *    possible (a path parameter with no `required: true` becomes required, with a diagnostic). The negative controls
 *    prove each construct would be named if it were left in.
 * 2. EQUIVALENCE. e2e/fixtures/supplementary/equivalence holds ONE API written five times (Swagger 2.0 in one file and
 *    over twelve, OpenAPI 3.0, 3.1 and 3.2; see its README). Under every option set the five give the same tool
 *    contract (name, order, title, description, input and output schema, mapper, annotations, security, servers,
 *    metadata), the same requests for the same input, and the same lint findings; the converted 2.0 document is the
 *    hand-written 3.0 one; the twelve-file one differs in exactly the three `components` sections the README names (its
 *    non-equivalence 11). Nothing is excluded from the comparison.
 * 3. BEHAVIOURS the conversion has to get right where Swagger 2.0 and OpenAPI 3 disagree, each written from the two
 *    specifications: `dereference: false`, a document with no `host`, `basePath` and `schemes`, `collectionFormat` in
 *    every location and in form bodies of both kinds, `consumes` and `produces` (and their cap), `x-nullable`,
 *    `type: file` and the media types a file form may have, a global body parameter, every OAuth2 flow and the ones that
 *    do not exist, parameter examples, a parameter name that is no string, the grouping of findings, the bounds of a
 *    conversion, where a diagnostic points (`document: 'source'`), the states of `getDocument()`, `lint()`, an Arazzo
 *    workflow over a 2.0 source.
 *
 * Expected values are written from the documents and the specifications (the 2.0 text, the OpenAPI 3.0.4 text and the
 * official JSON Schemas), then compared with the library; none is copied from its output.
 */
import { readdirSync } from 'fs';
import { join } from 'path';
import * as yaml from 'yaml';
import {
  MAX_CONVERSION_ENTRIES,
  MAX_MEDIA_TYPES_PER_LIST,
  OpenAPIToolGenerator,
  ParseError,
  RequestBuildError,
  buildHttpRequest,
  fromArazzo,
  lintDocument,
  upgradeSwagger2,
} from '../src';
import type { ArazzoDocument, BuiltHttpRequest, GenerateOptions, LoadOptions, McpOpenAPITool } from '../src';
import { createLoopbackServer } from '../src/__tests__/helpers/loopback';
import { executeWorkflow } from './helpers/arazzo-executor';
import { fixturePath, loadFixture } from './helpers/fixtures';
import { validateOasDocument } from './helpers/oas-validate';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A parsed document or a part of one: read freely (`noPropertyAccessFromIndexSignature` forbids `.member` on a record). */
type Doc = any;

/** Documents parse from text with every external reference refused: the story touches no network. */
const OFFLINE: LoadOptions = { refResolution: { allowedProtocols: [] } };
/** A tree of files is read from disk, and nothing else. */
const FILES: LoadOptions = { refResolution: { allowedProtocols: ['file'] } };

const parseDocument = (file: string): Doc =>
  (file.endsWith('.json') ? JSON.parse(loadFixture(file)) : yaml.parse(loadFixture(file))) as Doc;

const isObject = (value: unknown): value is Doc => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

/**
 * What a document holds that only Swagger 2.0 has, or that the conversion has to take apart. The vocabulary of the
 * scan in `constructsOf`; read from the dereferenced document, so a construct in a file a tree refers to counts.
 */
type Construct =
  | 'in-body'
  | 'in-formData'
  | 'type-file'
  | 'collectionFormat'
  | 'discriminator-string'
  | 'x-nullable'
  | 'operation-consumes'
  | 'operation-produces'
  | 'global-parameters'
  | 'global-responses'
  | 'securityDefinitions'
  | 'oauth2-implicit'
  | 'oauth2-application'
  | 'oauth2-accessCode'
  | 'oauth2-no-scopes'
  | 'no-host'
  | 'multi-scheme'
  | 'external-refs';

interface Swagger2Document {
  label: string;
  /** Under e2e/fixtures. */
  file: string;
  /** The document is a tree of files: it is read with `fromFile` and dereferenced from its root file. */
  tree?: boolean;
  /** Whether the schemas of the document are recursive (the converted document is then a cyclic graph). */
  recursive?: boolean;
  /** Written by hand from reading the document; compared with the scan. */
  constructs: Construct[];
}

const OFFICIAL = 'oas/documents/2.0/pass';
const SUPPLEMENTARY = 'supplementary/2.0';
const EQUIVALENCE = 'supplementary/equivalence';

const DOCUMENTS: Swagger2Document[] = [
  // The official OpenAPI Initiative examples
  { label: 'official/api-with-examples', file: `${OFFICIAL}/api-with-examples.yaml`, constructs: ['no-host', 'operation-produces'] },
  { label: 'official/petstore', file: `${OFFICIAL}/petstore.yaml`, constructs: [] },
  { label: 'official/petstore-expanded', file: `${OFFICIAL}/petstore-expanded.yaml`, constructs: ['collectionFormat', 'in-body'] },
  { label: 'official/petstore-minimal', file: `${OFFICIAL}/petstore-minimal.yaml`, constructs: ['operation-produces'] },
  {
    label: 'official/petstore-simple',
    file: `${OFFICIAL}/petstore-simple.yaml`,
    constructs: ['collectionFormat', 'in-body', 'operation-produces'],
  },
  {
    label: 'official/petstore-with-external-docs',
    file: `${OFFICIAL}/petstore-with-external-docs.yaml`,
    constructs: ['collectionFormat', 'in-body', 'operation-produces'],
  },
  { label: 'official/uber', file: `${OFFICIAL}/uber.yaml`, constructs: ['securityDefinitions'] },
  {
    label: 'official/petstore-separate',
    file: `${OFFICIAL}/petstore-separate/spec/swagger.yaml`,
    tree: true,
    constructs: ['collectionFormat', 'external-refs', 'in-body'],
  },
  // Ours, one construct each
  { label: 'supplementary/collection-format-locations', file: `${SUPPLEMENTARY}/pass/collection-format-locations.yaml`, constructs: ['collectionFormat'] },
  { label: 'supplementary/collection-format-tsv', file: `${SUPPLEMENTARY}/pass/collection-format-tsv.yaml`, constructs: ['collectionFormat'] },
  { label: 'supplementary/file-response', file: `${SUPPLEMENTARY}/pass/file-response.yaml`, constructs: ['operation-produces', 'type-file'] },
  {
    label: 'supplementary/global-body-two-consumes',
    file: `${SUPPLEMENTARY}/pass/global-body-two-consumes.yaml`,
    constructs: ['global-parameters', 'in-body', 'operation-consumes'],
  },
  {
    label: 'supplementary/global-response-produces-override',
    file: `${SUPPLEMENTARY}/pass/global-response-produces-override.yaml`,
    constructs: ['global-responses', 'operation-produces'],
  },
  { label: 'supplementary/no-host', file: `${SUPPLEMENTARY}/pass/no-host.yaml`, constructs: ['in-body', 'no-host'] },
  {
    label: 'supplementary/file-upload-consumes',
    file: `${SUPPLEMENTARY}/pass/file-upload-consumes.yaml`,
    constructs: ['in-formData', 'operation-consumes', 'type-file'],
  },
  { label: 'supplementary/two-schemes', file: `${SUPPLEMENTARY}/pass/two-schemes.yaml`, constructs: ['multi-scheme'] },
  { label: 'supplementary/websocket-schemes', file: `${SUPPLEMENTARY}/pass/websocket-schemes.yaml`, constructs: ['multi-scheme'] },
  { label: 'supplementary/x-nullable', file: `${SUPPLEMENTARY}/pass/x-nullable.yaml`, constructs: ['in-body', 'x-nullable'] },
  // Invalid by the 2.0 text: still converted, with a diagnostic
  { label: 'supplementary/invalid/body-and-form-data', file: `${SUPPLEMENTARY}/invalid/body-and-form-data.yaml`, constructs: ['in-body', 'in-formData'] },
  { label: 'supplementary/invalid/path-parameter-not-required', file: `${SUPPLEMENTARY}/invalid/path-parameter-not-required.yaml`, constructs: [] },
  // The Lending Library, in one file and over twelve (it has a recursive schema, `Category`)
  {
    label: 'equivalence/swagger-2.0',
    file: `${EQUIVALENCE}/swagger-2.0.yaml`,
    recursive: true,
    constructs: [
      'collectionFormat',
      'discriminator-string',
      'global-parameters',
      'global-responses',
      'in-body',
      'in-formData',
      'multi-scheme',
      'oauth2-accessCode',
      'oauth2-application',
      'operation-consumes',
      'operation-produces',
      'securityDefinitions',
      'type-file',
    ],
  },
  {
    // No `parameters`, `responses` or `definitions` section of its own: they are files (README, non-equivalence 11)
    label: 'equivalence/swagger-2.0-split',
    file: `${EQUIVALENCE}/swagger-2.0-split/swagger.yaml`,
    tree: true,
    recursive: true,
    constructs: [
      'collectionFormat',
      'discriminator-string',
      'external-refs',
      'in-body',
      'in-formData',
      'multi-scheme',
      'oauth2-accessCode',
      'oauth2-application',
      'operation-consumes',
      'operation-produces',
      'securityDefinitions',
      'type-file',
    ],
  },
  // A real description (Netlify, trimmed): one implicit OAuth2 definition with no `scopes`
  {
    label: 'real/netlify-trimmed',
    file: 'netlify-trimmed-2.0.json',
    constructs: [
      'global-parameters',
      'global-responses',
      'in-body',
      'in-formData',
      'oauth2-implicit',
      'oauth2-no-scopes',
      'operation-consumes',
      'operation-produces',
      'securityDefinitions',
      'type-file',
      'x-nullable',
    ],
  },
];

// ---------------------------------------------------------------------------
// Loading and converting
// ---------------------------------------------------------------------------

const methodOf = (key: string): boolean =>
  ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'].includes(key);

function open(document: Swagger2Document, options: LoadOptions = {}): Promise<OpenAPIToolGenerator> {
  return document.tree
    ? OpenAPIToolGenerator.fromFile(fixturePath(document.file), { ...FILES, ...options })
    : OpenAPIToolGenerator.fromJSON(parseDocument(document.file), { ...OFFLINE, ...options });
}

/** The document `@apidevtools/json-schema-ref-parser` dereferences, with no network and the files of a tree only. */
async function dereference(document: Swagger2Document): Promise<Doc> {
  const { default: refParser } = await import('@apidevtools/json-schema-ref-parser');
  return (document.tree
    ? await refParser.dereference(fixturePath(document.file), { resolve: { http: false } })
    : await refParser.dereference(parseDocument(document.file) as object, {
        resolve: { external: false, http: false, file: false },
      })) as Doc;
}

/** The codes of the conversion's own diagnostics, with where each was found. */
const conversionDiagnostics = (diagnostics: Array<{ code: string; path?: string }>): string[] =>
  diagnostics.filter(({ code }) => code.startsWith('SWAGGER_')).map(({ code, path }) => `${code} at ${path}`);

/** Scans a dereferenced Swagger 2.0 document for `Construct`s. Cycle-safe: a recursive schema is walked once. */
function constructsOf(document: Doc, tree: boolean | undefined): Construct[] {
  const found = new Set<Construct>();
  if (tree) found.add('external-refs');
  if (document['host'] === undefined) found.add('no-host');
  if (Array.isArray(document['schemes']) && document['schemes'].length > 1) found.add('multi-scheme');
  if (isObject(document['parameters']) && Object.keys(document['parameters']).length > 0) found.add('global-parameters');
  if (isObject(document['responses']) && Object.keys(document['responses']).length > 0) found.add('global-responses');
  const definitions = isObject(document['securityDefinitions']) ? document['securityDefinitions'] : {};
  if (Object.keys(definitions).length > 0) found.add('securityDefinitions');
  for (const definition of Object.values<Doc>(definitions)) {
    if (definition['type'] !== 'oauth2') continue;
    found.add(`oauth2-${String(definition['flow'])}` as Construct);
    if (definition['scopes'] === undefined) found.add('oauth2-no-scopes');
  }
  for (const item of Object.values<Doc>(isObject(document['paths']) ? document['paths'] : {})) {
    for (const [key, operation] of Object.entries<Doc>(item)) {
      if (!methodOf(key) || !isObject(operation)) continue;
      if (operation['consumes'] !== undefined) found.add('operation-consumes');
      if (operation['produces'] !== undefined) found.add('operation-produces');
    }
  }
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach(walk);
    const record = node as Doc;
    if (typeof record['name'] === 'string' && record['in'] === 'body') found.add('in-body');
    if (typeof record['name'] === 'string' && record['in'] === 'formData') found.add('in-formData');
    if (record['type'] === 'file') found.add('type-file');
    if ('collectionFormat' in record) found.add('collectionFormat');
    if (typeof record['discriminator'] === 'string') found.add('discriminator-string');
    if ('x-nullable' in record) found.add('x-nullable');
    Object.values(record).forEach(walk);
  };
  walk(document);
  return [...found].sort();
}

/** Whether two values are the same document: the same shape and primitives, cycles and sharing aside. Lists the first differences. */
function differences(a: unknown, b: unknown, limit = 12): string[] {
  const found: string[] = [];
  const compared = new Map<object, Set<object>>();
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (found.length >= limit || left === right) return;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
      const show = (value: unknown): string =>
        value !== null && typeof value === 'object' ? (Array.isArray(value) ? '[...]' : '{...}') : JSON.stringify(value) ?? 'undefined';
      found.push(`${path || '/'}: ${show(left)} vs ${show(right)}`);
      return;
    }
    // A pair already being compared is assumed equal: that is what makes a cycle terminate
    const done = compared.get(left) ?? new Set<object>();
    if (done.has(right)) return;
    done.add(right);
    compared.set(left, done);
    if (Array.isArray(left) !== Array.isArray(right)) {
      found.push(`${path || '/'}: a list vs an object`);
      return;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      visit((left as Doc)[key], (right as Doc)[key], `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    }
  };
  visit(a, b, '');
  return found;
}

const escapePointer = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Turns a document that may be a cyclic graph into a tree a JSON Schema validator can walk: an object met again while
 * still being walked (a recursive schema) becomes `{ $ref: '#<pointer of where it started>' }`, a Reference Object. Every
 * other value is copied as it is. `folded` lists each replacement, `ref` first.
 */
function foldCycles(document: unknown): { tree: Doc; folded: string[] } {
  const folded: string[] = [];
  const ancestors = new Map<object, string>();
  const walk = (node: unknown, pointer: string): unknown => {
    if (node === null || typeof node !== 'object') return node;
    const start = ancestors.get(node);
    if (start !== undefined) {
      folded.push(`${pointer} -> ${start}`);
      return { $ref: `#${start}` };
    }
    ancestors.set(node, pointer);
    const copy: unknown = Array.isArray(node)
      ? node.map((member, index) => walk(member, `${pointer}/${index}`))
      : Object.fromEntries(
          Object.entries(node).map(([key, value]) => [key, walk(value, `${pointer}/${escapePointer(key)}`)]),
        );
    ancestors.delete(node);
    return copy;
  };
  return { tree: walk(document, '') as Doc, folded };
}

/** The value a JSON Pointer names in `tree`, `undefined` when it leads nowhere. */
function pointerTarget(tree: Doc, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((node, key) => (node !== null && typeof node === 'object' ? (node as Doc)[key] : undefined), tree);
}

/**
 * What a converted document still has of Swagger 2.0 where OpenAPI 3.0 does not: its root members, an `in: body` or
 * `in: formData` parameter, `collectionFormat`, a string `discriminator`, `type: file`, an operation's `consumes`,
 * `produces` or `schemes`. (A schema PROPERTY called `collectionFormat` would be reported too; no document has one.)
 */
function leftovers(document: Doc): string[] {
  const found: string[] = [];
  for (const member of ['swagger', 'host', 'basePath', 'schemes', 'consumes', 'produces', 'definitions', 'securityDefinitions', 'parameters', 'responses']) {
    if (member in document) found.push(`root member ${member}`);
  }
  const seen = new Set<unknown>();
  const walk = (node: unknown, pointer: string): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach((member, index) => walk(member, `${pointer}/${index}`));
    const record = node as Doc;
    if (typeof record['name'] === 'string' && (record['in'] === 'body' || record['in'] === 'formData')) {
      found.push(`${pointer}: a parameter in ${String(record['in'])}`);
    }
    if ('collectionFormat' in record) found.push(`${pointer}: collectionFormat`);
    if (typeof record['discriminator'] === 'string') found.push(`${pointer}: a string discriminator`);
    if (record['type'] === 'file') found.push(`${pointer}: type file`);
    if (/\/(get|put|post|delete|options|head|patch)$/.test(pointer)) {
      for (const member of ['consumes', 'produces', 'schemes']) {
        if (member in record) found.push(`${pointer}: operation ${member}`);
      }
    }
    for (const [key, value] of Object.entries(record)) walk(value, `${pointer}/${escapePointer(key)}`);
  };
  walk(document, '');
  return found;
}

// ---------------------------------------------------------------------------
// 1. Conformance
// ---------------------------------------------------------------------------

describe('story: Swagger 2.0 conversion conforms to OpenAPI 3.0', () => {
  it('covers every Swagger 2.0 document of the repository, and each document exists once', () => {
    const listed = (folder: string): string[] =>
      readdirSync(fixturePath(folder))
        .filter((name) => name.endsWith('.yaml'))
        .sort();
    const named = (prefix: string, kind: string): string[] =>
      DOCUMENTS.filter(({ file }) => file.startsWith(`${prefix}/${kind}/`) && file.split('/').length === prefix.split('/').length + 2)
        .map(({ file }) => file.slice(`${prefix}/${kind}/`.length))
        .sort();
    // The folder of the official examples also holds a tree, `petstore-separate`, listed by its root file
    expect(named(OFFICIAL.replace(/\/pass$/, ''), 'pass')).toEqual(listed(OFFICIAL));
    expect(named(SUPPLEMENTARY, 'pass')).toEqual(listed(`${SUPPLEMENTARY}/pass`));
    expect(named(SUPPLEMENTARY, 'invalid')).toEqual(listed(`${SUPPLEMENTARY}/invalid`));
    expect(DOCUMENTS.map(({ label }) => label)).toHaveLength(new Set(DOCUMENTS.map(({ label }) => label)).size);
    expect(DOCUMENTS).toHaveLength(23);
    // Nothing else sits in these folders: the one tree of files the official examples hold, the twelve-file form
    // of the Lending Library, and no other file or folder that could be a Swagger 2.0 document left out of the table
    expect(readdirSync(fixturePath(OFFICIAL)).filter((name) => !name.endsWith('.yaml'))).toEqual(['petstore-separate']);
    expect(readdirSync(fixturePath(`${SUPPLEMENTARY}/pass`)).filter((name) => !name.endsWith('.yaml'))).toEqual([]);
    expect(readdirSync(fixturePath(`${SUPPLEMENTARY}/invalid`)).filter((name) => !name.endsWith('.yaml'))).toEqual([]);
    expect(readdirSync(fixturePath(EQUIVALENCE)).sort()).toEqual([
      'openapi-3.0.yaml',
      'openapi-3.1.yaml',
      'openapi-3.2.yaml',
      'swagger-2.0-split',
      'swagger-2.0.yaml',
    ]);
  });

  describe.each(DOCUMENTS)('$label', (document) => {
    let viaGenerator: { document: Doc; diagnostics: Array<{ code: string; path?: string; severity: string }> };
    let viaConverter: { document: Doc; diagnostics: Array<{ code: string; path?: string }> };
    let input: Doc;

    beforeAll(async () => {
      // `validate: false`: the story's `invalid/` documents are converted too, and validation is the other story's
      const generator = await open(document, { validate: false });
      await generator.generateTools();
      viaGenerator = { document: generator.getDocument() as Doc, diagnostics: generator.getDiagnostics() };
      input = await dereference(document);
      const snapshot = structuredClone(input);
      viaConverter = upgradeSwagger2(input) as unknown as typeof viaConverter;
      // The input was not touched (the converter is pure): it still is the document it was given
      expect(differences(input, snapshot)).toEqual([]);
    });

    it('holds the constructs the table says it holds (the scan and a reading of the document agree)', () => {
      expect(constructsOf(input, document.tree)).toEqual([...document.constructs].sort());
    });

    it('is the same converted document whether the generator or upgradeSwagger2 converts it', () => {
      expect(differences(viaGenerator.document, viaConverter.document)).toEqual([]);
      // the diagnostics of the conversion: the generator records exactly the converter's, in order
      expect(conversionDiagnostics(viaGenerator.diagnostics)).toEqual(conversionDiagnostics(viaConverter.diagnostics));
    });

    it('declares OpenAPI 3.0.3 and keeps nothing of Swagger 2.0 that OpenAPI 3.0 does not have', () => {
      expect(viaGenerator.document['openapi']).toBe('3.0.3');
      expect(leftovers(viaGenerator.document)).toEqual([]);
    });

    it('validates against the official OpenAPI 3.0 schema, in full', () => {
      const { tree, folded } = foldCycles(viaGenerator.document);
      // Every back-edge became a reference to a schema of the same document: the folded tree is well-formed
      for (const edge of folded) {
        const target = pointerTarget(tree, edge.split(' -> ')[1]);
        expect(isObject(target) && target['$ref'] === undefined).toBe(true);
      }
      expect(folded.length > 0).toBe(document.recursive === true);

      expect(validateOasDocument('3.0', tree)).toEqual({ valid: true, errors: [] });
    });
  });

  it('holds the 2.0 documents to the official 2.0 schema too: the `pass/` ones validate, and each `invalid/` one is rejected unless its table says the schema cannot see its fault', () => {
    for (const document of DOCUMENTS.filter(({ tree }) => !tree)) {
      const { valid } = validateOasDocument('2.0', parseDocument(document.file));
      // `body-and-form-data` breaks a rule across two parameters, which the 2.0 schema (each parameter alone) cannot see
      const accepted = !document.label.includes('/invalid/') || document.label.endsWith('/body-and-form-data');
      expect({ label: document.label, valid }).toEqual({ label: document.label, valid: accepted });
    }
  });

  // The check above could pass for a validator that sees nothing: each construct below is what the converter has to take
  // out of a 2.0 document, put back into a converted one, and the official schema must name it
  describe('negative controls: the official schema names each 2.0-only construct that is left in a converted document', () => {
    const converted = (): Doc => ({
      openapi: '3.0.3',
      info: { title: 'Control', version: '1.0.0' },
      paths: {
        '/things': {
          get: {
            responses: {
              '200': { description: 'ok', content: { 'application/json': { schema: { type: 'string' } } } },
            },
          },
        },
      },
    });
    const schemaOf = (document: Doc): Doc => document['paths']['/things'].get.responses['200'].content['application/json'].schema;

    it('is satisfied by the control document itself', () => {
      expect(validateOasDocument('3.0', converted())).toEqual({ valid: true, errors: [] });
    });

    it('a string discriminator', () => {
      const document = converted();
      Object.assign(schemaOf(document), { type: 'object', discriminator: 'kind' });
      const { errors } = validateOasDocument('3.0', document);
      expect(errors.some((line) => line.startsWith('/paths/~1things/get/responses/200/content/application~1json/schema/discriminator: must be object'))).toBe(true);
      expect(leftovers(document)).toContain('/paths/~1things/get/responses/200/content/application~1json/schema: a string discriminator');
    });

    it('type: file inside a schema', () => {
      const document = converted();
      schemaOf(document)['type'] = 'file';
      const { errors } = validateOasDocument('3.0', document);
      expect(errors.some((line) => line.startsWith('/paths/~1things/get/responses/200/content/application~1json/schema/type: must be equal to one of the allowed values'))).toBe(true);
      expect(leftovers(document)).toContain('/paths/~1things/get/responses/200/content/application~1json/schema: type file');
    });

    it('an `in: body` parameter', () => {
      const document = converted();
      document['paths']['/things'].get.parameters = [{ name: 'thing', in: 'body', schema: { type: 'string' } }];
      expect(validateOasDocument('3.0', document).valid).toBe(false);
      expect(leftovers(document)).toEqual(['/paths/~1things/get/parameters/0: a parameter in body']);
    });

    it('a `collectionFormat` beside a schema', () => {
      const document = converted();
      document['paths']['/things'].get.parameters = [
        { name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'string' } }, collectionFormat: 'csv' },
      ];
      expect(validateOasDocument('3.0', document).valid).toBe(false);
      expect(leftovers(document)).toEqual(['/paths/~1things/get/parameters/0: collectionFormat']);
    });

    it('an OAuth2 flow with no `scopes`, which the 2.0 schema allows and the 3.0 schema requires', () => {
      const document = converted();
      document['components'] = {
        securitySchemes: { oauth: { type: 'oauth2', flows: { implicit: { authorizationUrl: 'https://auth.example.com/' } } } },
      };
      const { errors } = validateOasDocument('3.0', document);
      expect(errors.some((line) => line.startsWith('/components/securitySchemes/oauth/flows/implicit: must have required property'))).toBe(true);
    });

    it('a root member of Swagger 2.0', () => {
      const document = converted();
      document['host'] = 'api.example.com';
      expect(validateOasDocument('3.0', document).valid).toBe(false);
      expect(leftovers(document)).toEqual(['root member host']);
    });

    it('a recursive schema, which only folding makes a tree', () => {
      const document = converted();
      const node: Doc = { type: 'object', properties: {} };
      node['properties'].child = node;
      document['paths']['/things'].get.responses['200'].content['application/json'].schema = node;
      const { tree, folded } = foldCycles(document);
      expect(folded).toEqual([
        '/paths/~1things/get/responses/200/content/application~1json/schema/properties/child -> /paths/~1things/get/responses/200/content/application~1json/schema',
      ]);
      expect(validateOasDocument('3.0', tree)).toEqual({ valid: true, errors: [] });
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Equivalence: one API, five spellings
// ---------------------------------------------------------------------------

const EQUIVALENT_FORMS = [
  { label: 'swagger-2.0 (one file)', file: `${EQUIVALENCE}/swagger-2.0.yaml`, tree: false },
  { label: 'swagger-2.0-split (twelve files)', file: `${EQUIVALENCE}/swagger-2.0-split/swagger.yaml`, tree: true },
  { label: 'openapi-3.0', file: `${EQUIVALENCE}/openapi-3.0.yaml`, tree: false },
  { label: 'openapi-3.1', file: `${EQUIVALENCE}/openapi-3.1.yaml`, tree: false },
  { label: 'openapi-3.2', file: `${EQUIVALENCE}/openapi-3.2.yaml`, tree: false },
] as const;

/** The tools of the Lending Library, in the order generation gives (path ascending, then method): README. */
const LIBRARY_TOOLS = [
  'listBooks',
  'createBook',
  'getBook',
  'patchBook',
  'deleteBook',
  'uploadBookCover',
  'listCategories',
  'exportBooks',
  'createLoan',
  'listMemberLoans',
];

const openForm = (form: (typeof EQUIVALENT_FORMS)[number]): Promise<OpenAPIToolGenerator> =>
  form.tree
    ? OpenAPIToolGenerator.fromFile(fixturePath(form.file), FILES)
    : OpenAPIToolGenerator.fromJSON(parseDocument(form.file), OFFLINE);

/**
 * The option sets the five forms are generated under. Each changes what a tool says: the default; every credential an
 * input of its own; a TypeScript signature and declaration per tool; each client dialect (which rewrites schemas and
 * inlines references); every response, not only the successful ones.
 */
const OPTION_SETS: Array<{ label: string; options: GenerateOptions }> = [
  { label: 'default options', options: {} },
  { label: 'includeSecurityInInput', options: { includeSecurityInInput: true } },
  { label: 'emitTypeSignatures', options: { emitTypeSignatures: true } },
  { label: 'target claude', options: { target: 'claude' } },
  { label: 'target openai', options: { target: 'openai' } },
  { label: 'target gemini', options: { target: 'gemini' } },
  { label: 'target strict', options: { target: 'strict' } },
  { label: 'includeAllResponses', options: { includeAllResponses: true } },
  { label: 'every output trimmed: stripExamples, maxDescriptionLength 40, maxSchemaDepth 3', options: { stripExamples: true, maxDescriptionLength: 40, maxSchemaDepth: 3 } },
];

/** A tool as JSON: what a client receives. */
const asJson = (tool: McpOpenAPITool): Doc => JSON.parse(JSON.stringify(tool)) as Doc;

describe('story: one API in five spellings gives one tool contract', () => {
  const generators = new Map<string, OpenAPIToolGenerator>();
  const toolsOf = new Map<string, Doc[]>();

  const generate = async (form: (typeof EQUIVALENT_FORMS)[number], set: (typeof OPTION_SETS)[number]): Promise<Doc[]> => {
    const key = `${form.label}/${set.label}`;
    if (!toolsOf.has(key)) {
      if (!generators.has(form.label)) generators.set(form.label, await openForm(form));
      toolsOf.set(key, (await generators.get(form.label)!.generateTools(set.options)).map(asJson));
    }
    return toolsOf.get(key)!;
  };

  // The README, section "What cannot be made equal", lists twelve differences between the FIVE DOCUMENTS (a body
  // parameter's name has no 3.x place, media types exist only where something uses them, a global response takes the
  // root `produces`, ...). None reaches a tool: each tool below is compared whole, with NO field left out. The one
  // difference that does reach the converted DOCUMENT is non-equivalence 11 (the twelve-file form has no `parameters`,
  // `responses` or `definitions` section), compared further down.
  describe.each(OPTION_SETS)('$label', (set) => {
    it('generates the ten tools of the API, in the same order, from every form', async () => {
      for (const form of EQUIVALENT_FORMS) {
        expect((await generate(form, set)).map(({ name }) => name)).toEqual(LIBRARY_TOOLS);
      }
    });

    it.each(EQUIVALENT_FORMS.slice(0, 2).concat(EQUIVALENT_FORMS.slice(3)))(
      'gives, from $label, exactly the tools of the hand-written OpenAPI 3.0 form',
      async (form) => {
        const expected = await generate(EQUIVALENT_FORMS[2], set);
        const actual = await generate(form, set);
        expect(actual).toHaveLength(expected.length);
        for (const [index, tool] of expected.entries()) {
          // Each member of the contract, tool by tool, so a difference names where it is
          const members = new Set([...Object.keys(tool), ...Object.keys(actual[index])]);
          for (const member of members) {
            expect({ tool: tool['name'], member, value: actual[index][member] }).toEqual({
              tool: tool['name'],
              member,
              value: tool[member],
            });
          }
          // The order of the properties is part of what a model reads, and `toEqual` ignores it
          expect(Object.keys(actual[index]['inputSchema'].properties ?? {})).toEqual(Object.keys(tool['inputSchema'].properties ?? {}));
          expect(Object.keys(actual[index])).toEqual(Object.keys(tool));
        }
      },
    );
  });

  it('is not vacuous: the contract has ten tools, their inputs, outputs, credentials, servers and annotations', async () => {
    const tools = await generate(EQUIVALENT_FORMS[0], OPTION_SETS[0]);
    expect(tools).toHaveLength(10);
    expect(tools.map((tool) => Object.keys(tool['inputSchema'].properties).length)).toEqual([6, 3, 2, 4, 1, 3, 0, 0, 3, 4]);
    // every operation has a response with a schema or says what an error looks like: all ten have an output schema
    expect(tools.filter((tool) => tool['outputSchema'] !== undefined)).toHaveLength(10);
    expect(tools.map((tool) => tool['mapper'].filter((entry: Doc) => entry.security !== undefined).length)).toEqual([2, 1, 0, 1, 1, 1, 1, 1, 1, 1]);
    expect(tools.every((tool) => tool['metadata'].servers.length === 2)).toBe(true);
    expect(tools.map((tool) => tool['annotations'].readOnlyHint)).toEqual([true, false, true, false, false, false, true, true, false, true]);
  });

  it('records no diagnostic for any of the five forms: nothing in the two Swagger 2.0 ones is lossy', async () => {
    for (const form of EQUIVALENT_FORMS) {
      // generate here, so the test does not depend on the generators another test left behind
      await generate(form, OPTION_SETS[0]);
      const generator = generators.get(form.label)!;
      expect({ form: form.label, diagnostics: generator.getDiagnostics() }).toEqual({ form: form.label, diagnostics: [] });
    }
  });

  describe('the converted document', () => {
    /** The document a form generates from, dereferenced. */
    const documentOf = async (form: (typeof EQUIVALENT_FORMS)[number]): Promise<Doc> => {
      await generate(form, OPTION_SETS[0]);
      return generators.get(form.label)!.getDocument() as Doc;
    };

    it('is, for the one-file Swagger 2.0 form, the hand-written OpenAPI 3.0 form: the servers, the version and all', async () => {
      expect(differences(await documentOf(EQUIVALENT_FORMS[0]), await documentOf(EQUIVALENT_FORMS[2]))).toEqual([]);
    });

    it('is, for the twelve-file form, the same document without the three components sections it does not have (README, non-equivalence 11)', async () => {
      const split = await documentOf(EQUIVALENT_FORMS[1]);
      const hand = await documentOf(EQUIVALENT_FORMS[2]);
      expect(differences(split, hand).sort()).toEqual(['/components/parameters: undefined vs {...}', '/components/responses: undefined vs {...}', '/components/schemas: undefined vs {...}']);
      expect(Object.keys(split['components'])).toEqual(['securitySchemes']);
      // nothing else: take the three sections out of the hand-written form and the two are the same
      const { schemas: _schemas, parameters: _parameters, responses: _responses, ...rest } = hand['components'];
      expect(differences(split, { ...hand, components: rest })).toEqual([]);
    });

    it('differs between the hand-written 3.0, 3.1 and 3.2 forms in the `openapi` member only (README: the 3.1 and 3.2 files are the 3.0 file with the version changed)', async () => {
      const hand = await documentOf(EQUIVALENT_FORMS[2]);
      for (const [form, version] of [[EQUIVALENT_FORMS[3], '3.1.0'], [EQUIVALENT_FORMS[4], '3.2.0']] as const) {
        const other = await documentOf(form);
        expect(other['openapi']).toBe(version);
        expect(differences({ ...other, openapi: hand['openapi'] }, hand)).toEqual([]);
      }
    });
  });

  describe('the requests the tools build', () => {
    const BASE = 'https://library.example.com/api/v1';
    const UUID = '6f1c2a3e-8b4d-4e5f-9a6b-0c1d2e3f4a5b';
    const COVER = new Blob(['PNG cover bytes'], { type: 'image/png' });

    /**
     * One input per tool, the same for every form. Credentials are given under the input key of their mapper entry
     * (the scheme's name); the OAuth2 and HTTP schemes take the token or the base64 credentials, as the library says.
     */
    const INPUTS: Record<string, Doc> = {
      listBooks: {
        limit: 5,
        offset: 10,
        'X-Request-Id': UUID,
        genres: ['sci-fi', 'fantasy'],
        statuses: ['available', 'lost'],
        tags: ['new', 'staff pick'],
        apiKeyHeader: 'key-1',
      },
      createBook: { title: 'Dune', isbn: '978-0441172719', authors: ['Frank Herbert'], oauthMember: 'member-token' },
      getBook: { bookId: 42, 'X-Request-Id': UUID },
      patchBook: { bookId: 42, title: 'Dune Messiah', status: 'borrowed', apiKeyHeader: 'key-1' },
      deleteBook: { bookId: 42, oauthService: 'service-token' },
      uploadBookCover: { bookId: 42, cover: COVER, caption: 'First edition', oauthMember: 'member-token' },
      listCategories: { apiKeyHeader: 'key-1' },
      exportBooks: { oauthService: 'service-token' },
      createLoan: { bookId: 42, memberId: 7, dueDate: '2026-12-01', basicAuth: 'bGlicmFyaWFuOnNlY3JldA==' },
      listMemberLoans: { memberId: 7, status: 'overdue', limit: 10, oauthMember: 'member-token' },
    };

    /** A request as the wire sees it; a multipart body is its parts. */
    const describeRequest = (request: BuiltHttpRequest): Doc => ({
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(Object.entries(request.headers).sort(([a], [b]) => (a < b ? -1 : 1))),
      contentType: request.contentType,
      body:
        request.body instanceof FormData
          ? [...request.body.entries()].map(([name, value]) =>
              typeof value === 'string' ? [name, value] : [name, { size: value.size, type: value.type }],
            )
          : request.body,
    });

    const buildAll = async (form: (typeof EQUIVALENT_FORMS)[number]): Promise<Record<string, Doc>> => {
      await generate(form, OPTION_SETS[0]);
      const tools = await generators.get(form.label)!.generateTools();
      return Object.fromEntries(
        tools.map((tool) => [tool.name, describeRequest(buildHttpRequest(tool, INPUTS[tool.name]))]),
      );
    };

    it('is, for the same input, the same request from every form: method, URL, headers and body', async () => {
      const reference = await buildAll(EQUIVALENT_FORMS[2]);
      expect(Object.keys(reference)).toEqual(LIBRARY_TOOLS);
      for (const form of EQUIVALENT_FORMS) {
        expect({ form: form.label, requests: await buildAll(form) }).toEqual({ form: form.label, requests: reference });
      }
    });

    it('is the request the specifications describe, written out for the tools that use the 2.0 constructs', async () => {
      const requests = await buildAll(EQUIVALENT_FORMS[0]);
      // collectionFormat csv, pipes and multi on a query; a header parameter; an API key in a header
      // (delimiters are percent-encoded, as for any style: see e2e/wire-serialization.e2e.ts)
      expect(requests['listBooks']).toEqual({
        method: 'GET',
        url: `${BASE}/books?limit=5&offset=10&genres=sci-fi%2Cfantasy&statuses=available%7Clost&tags=new&tags=staff%20pick`,
        headers: { 'X-API-Key': 'key-1', 'X-Request-Id': UUID },
        contentType: undefined,
        body: undefined,
      });
      // a JSON body (the body parameter's name is not sent) and an OAuth2 `accessCode` bearer token
      expect(requests['createBook']).toEqual({
        method: 'POST',
        url: `${BASE}/books`,
        headers: { Authorization: 'Bearer member-token', 'content-type': 'application/json' },
        contentType: 'application/json',
        body: JSON.stringify({ title: 'Dune', isbn: '978-0441172719', authors: ['Frank Herbert'] }),
      });
      // an operation's own `consumes`
      expect(requests['patchBook']).toMatchObject({
        method: 'PATCH',
        url: `${BASE}/books/42`,
        contentType: 'application/merge-patch+json',
        body: JSON.stringify({ title: 'Dune Messiah', status: 'borrowed' }),
      });
      // `formData` with `type: file`: a multipart body of two parts, the boundary left to the client
      expect(requests['uploadBookCover']).toEqual({
        method: 'POST',
        url: `${BASE}/books/42/cover`,
        headers: { Authorization: 'Bearer member-token' },
        contentType: 'multipart/form-data',
        body: [
          ['cover', { size: 15, type: 'image/png' }],
          ['caption', 'First edition'],
        ],
      });
      // `formData` urlencoded, and HTTP basic
      expect(requests['createLoan']).toEqual({
        method: 'POST',
        url: `${BASE}/loans`,
        headers: { Authorization: 'Basic bGlicmFyaWFuOnNlY3JldA==', 'content-type': 'application/x-www-form-urlencoded' },
        contentType: 'application/x-www-form-urlencoded',
        body: 'bookId=42&memberId=7&dueDate=2026-12-01',
      });
      // a path parameter defined at path-item level, a query enum, a global parameter
      expect(requests['listMemberLoans']).toMatchObject({
        url: `${BASE}/members/7/loans?status=overdue&limit=10`,
        headers: { Authorization: 'Bearer member-token' },
      });
      // the `application` flow of an OAuth2 definition is a bearer token too
      expect(requests['deleteBook']).toMatchObject({
        method: 'DELETE',
        url: `${BASE}/books/42`,
        headers: { Authorization: 'Bearer service-token' },
      });
    });
  });

  it('has the same lint findings from every form', async () => {
    const reference = await (await openForm(EQUIVALENT_FORMS[2])).lint();
    for (const form of EQUIVALENT_FORMS) {
      expect({ form: form.label, lint: await (await openForm(form)).lint() }).toEqual({ form: form.label, lint: reference });
    }
    expect(reference.findings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Behaviours
// ---------------------------------------------------------------------------

/** One of the repository's documents, parsed afresh. */
const fixture = (name: string): Doc => parseDocument(DOCUMENTS.find(({ label }) => label === name)!.file);

/** The OpenAPI 3.0 document a Swagger 2.0 document is generated from, with the tools and diagnostics of generating it. */
async function convert(document: Doc, options: LoadOptions = {}) {
  const generator = await OpenAPIToolGenerator.fromJSON(document, { ...OFFLINE, ...options });
  const tools = await generator.generateTools();
  return { generator, tools, converted: generator.getDocument() as Doc, diagnostics: generator.getDiagnostics() };
}

const operationOf = (document: Doc, path: string, method: string): Doc => document['paths'][path][method];
const mediaTypesOf = (content: Doc | undefined): string[] => Object.keys(content ?? {});

/** The one response most probes need. */
const OK = { '200': { description: 'ok' } };

/**
 * A small Swagger 2.0 document to probe one rule with: a `host`, `https` and, unless `paths` says otherwise, one `GET`
 * operation. `extra` is merged over the root, so it can replace any root member.
 */
const swagger = (extra: Doc = {}, paths?: Doc): Doc => ({
  swagger: '2.0',
  info: { title: 'Probe', version: '1' },
  host: 'probe.example.com',
  schemes: ['https'],
  paths: paths ?? { '/things': { get: { operationId: 'getThings', responses: OK } } },
  ...extra,
});

/** The URLs of the servers of a converted document. */
const serverUrlsOf = (converted: Doc): string[] => (converted['servers'] as Doc[]).map(({ url }) => url);

describe('story: Swagger 2.0 loaded with dereference: false', () => {
  const swagger = (): Doc => fixture('official/petstore');
  const REFUSED = {
    code: 'DEREFERENCE_REQUIRED',
    path: '/swagger',
  };

  it('is refused by validate() with one error and nothing else, never thrown', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(swagger(), { ...OFFLINE, dereference: false });
    const result = await generator.validate();
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toMatchObject(REFUSED);
    expect(result.errors![0].message).toContain('dereference: true');
    expect(result.warnings ?? []).toEqual([]);
    // an error of validation, not a diagnostic of generation
    expect(generator.getDiagnostics().map(({ code }) => code)).not.toContain('DEREFERENCE_REQUIRED');
  });

  it.each([
    ['generateTools()', (generator: OpenAPIToolGenerator) => generator.generateTools()],
    ['generateTool()', (generator: OpenAPIToolGenerator) => generator.generateTool('/pets', 'get')],
    ['lint()', (generator: OpenAPIToolGenerator) => generator.lint()],
  ])('is refused by %s with a ParseError carrying the same error', async (_name, run) => {
    const generator = await OpenAPIToolGenerator.fromJSON(swagger(), { ...OFFLINE, dereference: false });
    const error = await run(generator).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(ParseError);
    expect((error as ParseError).context?.['errors']).toEqual([expect.objectContaining(REFUSED)]);
    expect((error as ParseError).message).toContain('dereference: true');
  });

  it('is refused whatever the document holds and whether or not validation is on', async () => {
    const empty: Doc = { swagger: '2.0', info: { title: 'Empty', version: '1' }, paths: {} };
    for (const validate of [true, false]) {
      const generator = await OpenAPIToolGenerator.fromJSON(empty, { ...OFFLINE, dereference: false, validate });
      await expect(generator.generateTools()).rejects.toMatchObject({ context: { errors: [REFUSED] } });
    }
  });

  it('is specific to Swagger 2.0: an OpenAPI 3.0 document with dereference: false generates, and the way out the message names works', async () => {
    const threeZero: Doc = {
      openapi: '3.0.3',
      info: { title: 'Ping', version: '1' },
      paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } } },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(threeZero, { ...OFFLINE, dereference: false });
    expect((await generator.generateTools()).map(({ name }) => name)).toEqual(['ping']);
    // the way out the message names: dereference on, nothing but the document itself read
    for (const options of [{ secureDefaults: true }, { refResolution: { allowedProtocols: [] } }] as LoadOptions[]) {
      const tools = await (await OpenAPIToolGenerator.fromJSON(swagger(), options)).generateTools();
      expect(tools.map(({ name }) => name)).toEqual(['listPets', 'createPets', 'showPetById']);
    }
  });
});

describe('story: Swagger 2.0 with no host', () => {
  const notes = (): Doc => fixture('supplementary/no-host');
  const serverUrls = (tools: McpOpenAPITool[]): string[][] =>
    tools.map((tool) => (tool.metadata.servers ?? []).map(({ url }) => url));
  const codes = (diagnostics: Array<{ code: string }>): string[] => diagnostics.map(({ code }) => code).filter((code) => code.startsWith('SWAGGER_'));

  it('has a relative server, `/v2`, and a warning at `/host`, when nothing says where the document came from', async () => {
    const { tools, diagnostics, converted } = await convert(notes());
    expect(converted['servers']).toEqual([{ url: '/v2' }]);
    expect(serverUrls(tools)).toEqual([['/v2'], ['/v2']]);
    expect(diagnostics.filter(({ code }) => code.startsWith('SWAGGER_'))).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'SWAGGER_RELATIVE_SERVER_URL', path: '/host' }),
    ]);
    // a request cannot be built until the caller says where the API is
    const list = tools.find(({ name }) => name === 'listNotes')!;
    expect(() => buildHttpRequest(list, { q: 'milk' })).toThrow(RequestBuildError);
    expect(buildHttpRequest(list, { q: 'milk' }, { baseUrl: 'https://notes.example.com/v2' }).url).toBe(
      'https://notes.example.com/v2/notes?q=milk',
    );
  });

  it.each([
    // the 2.0 text: "If the host is not included, the host serving the documentation is to be used (including the
    // port)", and `schemes`: "If the schemes is not included, the default scheme to be used is the one used to access
    // the Swagger definition itself"
    ['https://docs.example.org/specs/notes.yaml', 'https://docs.example.org/v2'],
    ['http://docs.example.org:8080/notes.yaml', 'http://docs.example.org:8080/v2'],
  ])('takes host, port and scheme from documentUri %s: %s', async (documentUri, expected) => {
    const { tools, diagnostics, converted } = await convert(notes(), { documentUri });
    expect(converted['servers']).toEqual([{ url: expected }]);
    expect(serverUrls(tools)).toEqual([[expected], [expected]]);
    expect(codes(diagnostics)).toEqual([]);
    const list = tools.find(({ name }) => name === 'listNotes')!;
    expect(buildHttpRequest(list, { q: 'milk' }).url).toBe(`${expected}/notes?q=milk`);
  });

  it('leaves the server relative for a document URI that is not on the web, with the same warning', async () => {
    const { converted, diagnostics } = await convert(notes(), { documentUri: 'file:///srv/specs/notes.yaml' });
    expect(converted['servers']).toEqual([{ url: '/v2' }]);
    expect(codes(diagnostics)).toEqual(['SWAGGER_RELATIVE_SERVER_URL']);
  });

  it('does the same for a file read with fromFile: its URI is a file: URL', async () => {
    const generator = await OpenAPIToolGenerator.fromFile(fixturePath(`${SUPPLEMENTARY}/pass/no-host.yaml`), FILES);
    await generator.generateTools();
    expect((generator.getDocument() as Doc)['servers']).toEqual([{ url: '/v2' }]);
    expect(codes(generator.getDiagnostics())).toEqual(['SWAGGER_RELATIVE_SERVER_URL']);
  });

  describe('fromURL: the final URL of the retrieval, redirects included, is where the host comes from', () => {
    const loopback = createLoopbackServer(() => (req, res) => {
      const text = loadFixture(`${SUPPLEMENTARY}/pass/no-host.yaml`);
      if (req.url === '/old/notes.yaml') {
        res.writeHead(302, { location: '/moved/notes.yaml' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/yaml' });
        res.end(text);
      }
    });
    afterAll(() => loopback.close());
    const load = { refResolution: { allowInternalIPs: true } } satisfies LoadOptions;

    it('serves the API from the host that served the description', async () => {
      const base = await loopback.listen();
      const generator = await OpenAPIToolGenerator.fromURL(`${base}/notes.yaml`, load);
      await generator.generateTools();
      expect((generator.getDocument() as Doc)['servers']).toEqual([{ url: `${base}/v2` }]);
      expect(codes(generator.getDiagnostics())).toEqual([]);

      // and, after a redirect, from the host it ended on (here the same one: the path of the final URL is not used)
      const redirected = await OpenAPIToolGenerator.fromURL(`${base}/old/notes.yaml`, load);
      await redirected.generateTools();
      expect((redirected.getDocument() as Doc)['servers']).toEqual([{ url: `${base}/v2` }]);
      expect(loopback.requests.map(({ url }) => url)).toEqual(['/notes.yaml', '/old/notes.yaml', '/moved/notes.yaml']);
    });
  });

  describe('a host with no schemes', () => {
    const withHost = (): Doc => ({ ...notes(), host: 'notes.example.com' });

    it('assumes https and says so, when nothing says how the document was reached', async () => {
      const { converted, diagnostics } = await convert(withHost());
      expect(converted['servers']).toEqual([{ url: 'https://notes.example.com/v2' }]);
      expect(diagnostics.filter(({ code }) => code === 'SWAGGER_ASSUMED_SCHEME')).toEqual([
        expect.objectContaining({ severity: 'warning', path: '/schemes' }),
      ]);
    });

    it('takes the scheme of the document URI, and keeps its own host', async () => {
      const { converted, diagnostics } = await convert(withHost(), { documentUri: 'http://mirror.example.org/notes.yaml' });
      expect(converted['servers']).toEqual([{ url: 'http://notes.example.com/v2' }]);
      expect(codes(diagnostics)).toEqual([]);
    });

    it('uses `schemes` over the document URI, and the host of the document URI only when it has none', async () => {
      const document = { ...notes(), schemes: ['https'] };
      const { converted } = await convert(document, { documentUri: 'http://mirror.example.org/notes.yaml' });
      expect(converted['servers']).toEqual([{ url: 'https://mirror.example.org/v2' }]);
    });
  });
});

describe('story: collectionFormat in every location', () => {
  /**
   * One operation per location, each parameter named `<format>`. Written from the Swagger 2.0 text ("Possible values are:
   * csv, ssv, tsv, pipes, multi (only valid for query or formData); default csv") and the OpenAPI 3.0.4 Parameter
   * Object (the `style` table; "form" and "simple" the defaults of query and path/header) and Encoding Object ("The
   * behavior follows the same values as query parameters ... SHALL be ignored if the request body media type is not
   * application/x-www-form-urlencoded"). OpenAPI 3.0 has a style for csv, ssv and pipes in a query, for csv in a path or
   * a header, and for nothing else.
   */
  const FORMATS = ['csv', 'ssv', 'tsv', 'pipes', 'multi', 'omitted'] as const;
  type Format = (typeof FORMATS)[number];
  const arrayParameter = (name: Format, location: string, extra: Doc = {}): Doc => ({
    name,
    in: location,
    ...(location === 'path' ? { required: true } : {}),
    type: 'array',
    items: { type: 'string' },
    ...(name === 'omitted' ? {} : { collectionFormat: name }),
    ...extra,
  });
  const document = (): Doc => ({
    swagger: '2.0',
    info: { title: 'Formats', version: '1.0.0' },
    host: 'formats.example.com',
    schemes: ['https'],
    paths: {
      '/query': {
        get: { operationId: 'inQuery', parameters: FORMATS.map((name) => arrayParameter(name, 'query')), responses: { '200': { description: 'ok' } } },
      },
      '/header': {
        get: { operationId: 'inHeader', parameters: FORMATS.map((name) => arrayParameter(name, 'header')), responses: { '200': { description: 'ok' } } },
      },
      '/path/{csv}/{ssv}/{tsv}/{pipes}/{multi}/{omitted}': {
        get: { operationId: 'inPath', parameters: FORMATS.map((name) => arrayParameter(name, 'path')), responses: { '200': { description: 'ok' } } },
      },
      '/urlencoded': {
        post: {
          operationId: 'inUrlencoded',
          consumes: ['application/x-www-form-urlencoded'],
          parameters: FORMATS.map((name) => arrayParameter(name, 'formData')),
          responses: { '200': { description: 'ok' } },
        },
      },
      '/multipart': {
        post: {
          operationId: 'inMultipart',
          consumes: ['multipart/form-data'],
          parameters: FORMATS.map((name) => arrayParameter(name, 'formData')),
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  });

  /** The style and explode of each format where OpenAPI 3.0 has one, `fallback` where it has none (and says so). */
  type Style = { style: string; explode: boolean; warns?: true };
  const QUERY: Record<Format, Style> = {
    csv: { style: 'form', explode: false },
    ssv: { style: 'spaceDelimited', explode: false },
    tsv: { style: 'form', explode: false, warns: true },
    pipes: { style: 'pipeDelimited', explode: false },
    multi: { style: 'form', explode: true },
    omitted: { style: 'form', explode: false },
  };
  const SIMPLE: Record<Format, Style> = {
    csv: { style: 'simple', explode: false },
    ssv: { style: 'simple', explode: false, warns: true },
    tsv: { style: 'simple', explode: false, warns: true },
    pipes: { style: 'simple', explode: false, warns: true },
    multi: { style: 'simple', explode: false, warns: true },
    omitted: { style: 'simple', explode: false },
  };

  it('puts the style and explode of each format on the mapper entry of a query, a header and a path parameter', async () => {
    const { tools } = await convert(document());
    const mapperOf = (tool: string) =>
      Object.fromEntries(
        tools.find(({ name }) => name === tool)!.mapper.map(({ key, style, explode }) => [key, { style, explode }]),
      );
    const expected = (styles: Record<Format, Style>) =>
      Object.fromEntries(FORMATS.map((name) => [name, { style: styles[name].style, explode: styles[name].explode }]));
    expect(mapperOf('inQuery')).toEqual(expected(QUERY));
    expect(mapperOf('inHeader')).toEqual(expected(SIMPLE));
    expect(mapperOf('inPath')).toEqual(expected(SIMPLE));
  });

  it('puts them in the converted document as `style` and `explode` of the parameter, with no `collectionFormat`', async () => {
    const { converted } = await convert(document());
    const parametersOf = (path: string, method = 'get') =>
      Object.fromEntries(
        (operationOf(converted, path, method).parameters as Doc[]).map(({ name, style, explode, collectionFormat }) => [
          name,
          { style, explode, collectionFormat },
        ]),
      );
    const expected = (styles: Record<Format, Style>) =>
      Object.fromEntries(
        FORMATS.map((name) => [name, { style: styles[name].style, explode: styles[name].explode, collectionFormat: undefined }]),
      );
    expect(parametersOf('/query')).toEqual(expected(QUERY));
    expect(parametersOf('/header')).toEqual(expected(SIMPLE));
    expect(parametersOf('/path/{csv}/{ssv}/{tsv}/{pipes}/{multi}/{omitted}')).toEqual(expected(SIMPLE));
  });

  it('puts them in the `encoding` of a form body, whether it is sent urlencoded or multipart (2.0 says `formData`, in either)', async () => {
    const { converted } = await convert(document());
    // The Encoding Object has `style` and `explode` "the same values as query parameters, including default values"
    const expected = Object.fromEntries(FORMATS.map((name) => [name, { style: QUERY[name].style, explode: QUERY[name].explode }]));
    for (const [path, mediaType] of [
      ['/urlencoded', 'application/x-www-form-urlencoded'],
      ['/multipart', 'multipart/form-data'],
    ] as const) {
      const media = operationOf(converted, path, 'post').requestBody.content[mediaType];
      expect(Object.keys(media.schema.properties)).toEqual([...FORMATS]);
      expect(media.encoding).toEqual(expected);
    }
  });

  it('gives a form with both media types one encoding in each, and leaves a field that is no array without one', async () => {
    const { converted } = await convert({
      swagger: '2.0',
      info: { title: 'Both', version: '1' },
      host: 'both.example.com',
      schemes: ['https'],
      paths: {
        '/both': {
          post: {
            operationId: 'both',
            consumes: ['application/x-www-form-urlencoded', 'multipart/form-data'],
            parameters: [
              { name: 'title', in: 'formData', type: 'string' },
              { name: 'tags', in: 'formData', type: 'array', items: { type: 'string' }, collectionFormat: 'pipes' },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const content = operationOf(converted, '/both', 'post').requestBody.content;
    expect(Object.keys(content)).toEqual(['application/x-www-form-urlencoded', 'multipart/form-data']);
    for (const media of Object.values<Doc>(content)) {
      expect(media.encoding).toEqual({ tags: { style: 'pipeDelimited', explode: false } });
    }
  });

  it('warns for exactly the formats OpenAPI 3.0 has no style for where they are used, once per format and location, at the first place', async () => {
    const { diagnostics } = await convert(document());
    const found = diagnostics.filter(({ code }) => code === 'SWAGGER_UNSUPPORTED_COLLECTION_FORMAT');
    const at = (path: string, method: string, index: number): string =>
      `/paths/${path.replace(/\//g, '~1')}/${method}/parameters/${index}/collectionFormat`;
    const PATH = '/path/{csv}/{ssv}/{tsv}/{pipes}/{multi}/{omitted}';
    // Where the 2.0 text and OpenAPI 3.0 leave a format with no style: `tsv` in a query or a form; `ssv`, `tsv`, `pipes`
    // and `multi` in a header or a path (3.0 has `simple` there, nothing else; `multi` is valid only in a query or a form).
    // A form is the same in both media types (the encoding), so its `tsv` is one finding found in two places. The
    // parameter indexes are those of the document written above
    const expected = [
      { format: 'tsv', where: 'query', places: [at('/query', 'get', 2)] },
      ...(['ssv', 'tsv', 'pipes', 'multi'] as const).map((format, index) => ({ format, where: 'header', places: [at('/header', 'get', index + 1)] })),
      ...(['ssv', 'tsv', 'pipes', 'multi'] as const).map((format, index) => ({ format, where: 'path', places: [at(PATH, 'get', index + 1)] })),
      { format: 'tsv', where: undefined, places: [at('/urlencoded', 'post', 2), at('/multipart', 'post', 2)] },
    ];
    expect(found.map(({ path }) => path)).toEqual(expected.map(({ places }) => places[0]));
    expected.forEach(({ format, where, places }, index) => {
      const { severity, message, document } = found[index];
      expect({ severity, document }).toEqual({ severity: 'warning', document: 'source' });
      expect(message.startsWith(`\`collectionFormat: ${format}\` has no OpenAPI 3.0 equivalent`)).toBe(true);
      // a parameter names its location, a form field has none to name
      expect(message.includes(' for an `in: ')).toBe(where !== undefined);
      if (where !== undefined) expect(message).toContain(` for an \`in: ${where}\` parameter;`);
      // "(in N places: ...)" only where there are several, each place written out up to three
      expect(message.endsWith(places.length === 1 ? ')' : `(in ${places.length} places: ${places.join(', ')})`)).toBe(true);
      expect(message.includes('(in ')).toBe(places.length > 1);
    });
    expect(found).toHaveLength(expected.length);
  });

  it('sends a form array the way its format says, in a urlencoded body and in a multipart one alike (the delimiters are the 2.0 text\'s)', async () => {
    const { tools } = await convert(document());
    const input = Object.fromEntries(FORMATS.map((name) => [name, ['a', 'b']]));
    // csv and the default: a comma; ssv: a space; pipes: a bar; multi: one value per item. `tsv` (a tab) has no
    // OpenAPI 3.0 style, so a comma, which the diagnostic says
    const expected = [
      ['csv', 'a,b'],
      ['ssv', 'a b'],
      ['tsv', 'a,b'],
      ['pipes', 'a|b'],
      ['multi', 'a'],
      ['multi', 'b'],
      ['omitted', 'a,b'],
    ];
    const urlencoded = buildHttpRequest(tools.find(({ name }) => name === 'inUrlencoded')!, input);
    expect(urlencoded.contentType).toBe('application/x-www-form-urlencoded');
    // decoded: whether a space is `+` or `%20` in a form body is not what is read here
    expect([...new URLSearchParams(urlencoded.body as string)]).toEqual(expected);
    const multipart = buildHttpRequest(tools.find(({ name }) => name === 'inMultipart')!, input);
    expect(multipart.contentType).toBe('multipart/form-data');
    expect([...(multipart.body as FormData)].map(([name, value]) => [name, String(value)])).toEqual(expected);
  });

  it('sends the formats that have a style the way their style says (the delimiters percent-encoded, as for any style)', async () => {
    const { tools } = await convert(document());
    const query = tools.find(({ name }) => name === 'inQuery')!;
    const input = Object.fromEntries(FORMATS.map((name) => [name, ['a', 'b']]));
    expect(buildHttpRequest(query, input).url).toBe(
      'https://formats.example.com/query?csv=a%2Cb&ssv=a%20b&tsv=a%2Cb&pipes=a%7Cb&multi=a&multi=b&omitted=a%2Cb',
    );
  });
});

describe('story: consumes and produces', () => {
  const media = (consumes?: string[], produces?: string[]): Doc => ({
    ...(consumes ? { consumes } : {}),
    ...(produces ? { produces } : {}),
  });
  const body = { name: 'payload', in: 'body', required: true, schema: { type: 'object', properties: { a: { type: 'string' } } } };
  const ok = { description: 'ok', schema: { type: 'string' } };
  const operations = (): Doc => ({
    '/inherit': {
      post: { operationId: 'inherit', parameters: [body], responses: { '200': ok, '204': { description: 'no content' } } },
    },
    '/override': {
      post: {
        operationId: 'override',
        ...media(['application/xml', 'application/json'], ['text/plain', 'application/json']),
        parameters: [body],
        responses: { '200': ok },
      },
    },
    '/cleared': {
      post: { operationId: 'cleared', ...media([], []), parameters: [body], responses: { '200': ok } },
    },
  });
  const document = (root: Doc): Doc => ({
    swagger: '2.0',
    info: { title: 'Media', version: '1' },
    host: 'media.example.com',
    schemes: ['https'],
    ...root,
    paths: operations(),
  });

  it('takes an operation\'s own lists over the root ones, in the order written, and a root list where it has none', async () => {
    const { converted } = await convert(document(media(['application/json'], ['application/json'])));
    expect(mediaTypesOf(operationOf(converted, '/inherit', 'post').requestBody.content)).toEqual(['application/json']);
    expect(mediaTypesOf(operationOf(converted, '/inherit', 'post').responses['200'].content)).toEqual(['application/json']);
    // a response with no schema has no body to give a media type to
    expect(operationOf(converted, '/inherit', 'post').responses['204']).toEqual({ description: 'no content' });
    expect(mediaTypesOf(operationOf(converted, '/override', 'post').requestBody.content)).toEqual(['application/xml', 'application/json']);
    expect(mediaTypesOf(operationOf(converted, '/override', 'post').responses['200'].content)).toEqual(['text/plain', 'application/json']);
    // each media type carries the same schema
    expect(operationOf(converted, '/override', 'post').responses['200'].content['text/plain'].schema).toEqual({ type: 'string' });
  });

  it('reads an empty list as clearing the root one: nothing applies, so application/json is assumed, and said once per direction', async () => {
    const { converted, diagnostics } = await convert(document(media(['application/xml'], ['text/html'])));
    expect(mediaTypesOf(operationOf(converted, '/inherit', 'post').requestBody.content)).toEqual(['application/xml']);
    expect(mediaTypesOf(operationOf(converted, '/inherit', 'post').responses['200'].content)).toEqual(['text/html']);
    expect(mediaTypesOf(operationOf(converted, '/cleared', 'post').requestBody.content)).toEqual(['application/json']);
    expect(mediaTypesOf(operationOf(converted, '/cleared', 'post').responses['200'].content)).toEqual(['application/json']);
    expect(diagnostics.filter(({ code }) => code === 'SWAGGER_ASSUMED_MEDIA_TYPE').map(({ severity }) => severity)).toEqual(['info', 'info']);
  });

  it('assumes application/json for a body when neither the operation nor the root says, and for a response alike', async () => {
    const { converted, diagnostics } = await convert(document({}));
    for (const path of ['/inherit', '/cleared']) {
      expect(mediaTypesOf(operationOf(converted, path, 'post').requestBody.content)).toEqual(['application/json']);
      expect(mediaTypesOf(operationOf(converted, path, 'post').responses['200'].content)).toEqual(['application/json']);
    }
    expect(diagnostics.filter(({ code }) => code === 'SWAGGER_ASSUMED_MEDIA_TYPE')).toHaveLength(2);
  });

  it('adds a form media type to a form body whose consumes names none: urlencoded, and multipart where there is a file', async () => {
    const form = (name: string, type: string): Doc => ({ name, in: 'formData', required: true, type });
    const { converted, diagnostics } = await convert({
      swagger: '2.0',
      info: { title: 'Forms', version: '1' },
      host: 'forms.example.com',
      schemes: ['https'],
      consumes: ['application/json'],
      paths: {
        '/fields': { post: { operationId: 'fields', parameters: [form('a', 'string')], responses: { '200': { description: 'ok' } } } },
        '/upload': { post: { operationId: 'upload', parameters: [form('f', 'file')], responses: { '200': { description: 'ok' } } } },
      },
    });
    expect(mediaTypesOf(operationOf(converted, '/fields', 'post').requestBody.content)).toEqual(['application/x-www-form-urlencoded']);
    expect(mediaTypesOf(operationOf(converted, '/upload', 'post').requestBody.content)).toEqual(['multipart/form-data']);
    expect(diagnostics.filter(({ code }) => code === 'SWAGGER_FORM_MEDIA_TYPE_ADDED')).toHaveLength(2);
  });

  it('reads the official petstore: an operation lists four media types, the root one, and a POST says json again', async () => {
    const { converted } = await convert(fixture('official/petstore-simple'));
    expect(mediaTypesOf(operationOf(converted, '/pets', 'get').responses['200'].content)).toEqual([
      'application/json',
      'application/xml',
      'text/xml',
      'text/html',
    ]);
    expect(mediaTypesOf(operationOf(converted, '/pets', 'post').requestBody.content)).toEqual(['application/json']);
    // an operation with no `produces` of its own takes the root's
    expect(mediaTypesOf(operationOf(converted, '/pets/{id}', 'delete').responses['default'].content)).toEqual(['application/json']);
  });

  it('converts a global response in the context of each operation that uses it (the `produces` it is served in)', async () => {
    const { converted } = await convert(fixture('supplementary/global-response-produces-override'));
    const problem = (path: string): Doc => operationOf(converted, path, 'get').responses['default'];
    expect(mediaTypesOf(problem('/records/{recordId}').content)).toEqual(['application/json']);
    // the operation that overrides `produces` serves the same global response as CSV...
    expect(mediaTypesOf(problem('/records/{recordId}/export').content)).toEqual(['text/csv']);
    expect(problem('/records/{recordId}/export').content['text/csv'].schema).toEqual(problem('/records/{recordId}').content['application/json'].schema);
    // ...while the component, which has no operation, takes the root's (README, non-equivalence 3)
    expect(mediaTypesOf(converted['components'].responses['Problem'].content)).toEqual(['application/json']);
  });
});

describe('story: a global body parameter used by two operations with different consumes', () => {
  it('becomes a request body per operation, each in that operation\'s own media types, without the parameter\'s name', async () => {
    const { converted, tools } = await convert(fixture('supplementary/global-body-two-consumes'));
    const register = operationOf(converted, '/pets', 'post').requestBody;
    const importing = operationOf(converted, '/pets/import', 'post').requestBody;
    expect(mediaTypesOf(register.content)).toEqual(['application/json']);
    expect(mediaTypesOf(importing.content)).toEqual(['application/xml']);
    // The 3.0 Request Body Object has `description`, `content` and `required`: the parameter's `name` (`pet`) has no place
    expect(Object.keys(register).sort()).toEqual(['content', 'description', 'required']);
    expect(Object.keys(importing).sort()).toEqual(['content', 'description', 'required']);
    for (const requestBody of [register, importing]) {
      expect(requestBody.required).toBe(true);
      expect(requestBody.description).toBe('The pet to register');
    }
    expect(register).not.toBe(importing);
    expect(importing.content['application/xml'].schema).toEqual(register.content['application/json'].schema);
    expect(register.content['application/json'].schema).toMatchObject({ type: 'object', required: ['name'], xml: { name: 'pet' } });
    // the global one, with no operation to take consumes from, takes the root's
    expect(mediaTypesOf(converted['components'].requestBodies['Pet'].content)).toEqual(['application/json']);
    // the tools send each in its own media type, with the same fields
    const sent = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name)!;
      return { fields: Object.keys((tool.inputSchema as Doc)['properties']), types: [...new Set(tool.mapper.map((entry) => entry.serialization?.contentType))] };
    };
    expect(sent('registerPet')).toEqual({ fields: ['name', 'species'], types: ['application/json'] });
    expect(sent('importPet')).toEqual({ fields: ['name', 'species'], types: ['application/xml'] });
  });
});

describe('story: x-nullable', () => {
  it('turns `x-nullable: true` into `nullable: true` wherever a schema is, and leaves `x-nullable: false` not nullable', async () => {
    const { converted, tools } = await convert(fixture('supplementary/x-nullable'));
    const profile = converted['components'].schemas['Profile'].properties;
    expect(profile['name'].nullable === true).toBe(false);
    expect(profile['nickname']).toMatchObject({ type: 'string', nullable: true });
    expect(profile['birthYear']).toMatchObject({ type: 'integer', format: 'int32', nullable: true });
    expect(profile['address']).toMatchObject({ type: 'object', nullable: true });
    expect(profile['aliases']).toMatchObject({ type: 'array', nullable: true });
    expect(profile['aliases'].items).toMatchObject({ type: 'string', nullable: true });
    // and the tool says what JSON Schema says for a value that may be null: a type list with `null`
    const output = (tools.find(({ name }) => name === 'getProfile')!.outputSchema as Doc)['properties'];
    expect(output['name'].type).toBe('string');
    expect(output['nickname'].type).toEqual(['string', 'null']);
    expect(output['birthYear'].type).toEqual(['integer', 'null']);
    expect(output['address'].type).toEqual(['object', 'null']);
    expect(output['aliases'].type).toEqual(['array', 'null']);
    expect(output['aliases'].items.type).toEqual(['string', 'null']);
  });
});

describe('story: schema constructs of Swagger 2.0 inside a recursive schema', () => {
  // `Node` refers to itself, so the converted schema is a cycle; every Swagger 2.0 construct in it (a string
  // `discriminator`, `type: file`, `x-nullable`) has to be converted at every turn of it, not only at the first
  const document = (): Doc => ({
    swagger: '2.0',
    info: { title: 'Graph', version: '1' },
    host: 'graph.example.com',
    schemes: ['https'],
    paths: {
      '/nodes': {
        get: {
          operationId: 'getNode',
          produces: ['application/json'],
          responses: { '200': { description: 'The node', schema: { $ref: '#/definitions/Node' } } },
        },
      },
    },
    definitions: {
      Node: {
        type: 'object',
        discriminator: 'kind',
        required: ['kind'],
        properties: {
          kind: { type: 'string' },
          payload: { type: 'file' },
          tags: { type: 'array', 'x-nullable': true, items: { type: 'string' } },
          next: { $ref: '#/definitions/Node' },
        },
      },
    },
  });

  it('converts them at every level of the cycle, and the conversion still validates', async () => {
    const { converted } = await convert(document());
    let node: Doc = converted['components'].schemas['Node'];
    for (let depth = 0; depth < 4; depth++) {
      expect(node['discriminator']).toEqual({ propertyName: 'kind' });
      expect(node['properties']['payload']).toEqual({ type: 'string', format: 'binary' });
      expect(node['properties']['tags']).toMatchObject({ type: 'array', nullable: true });
      node = node['properties']['next'];
    }
    // the response schema is the same schema, converted the same way
    const response = operationOf(converted, '/nodes', 'get').responses['200'].content['application/json'].schema;
    expect(response['discriminator']).toEqual({ propertyName: 'kind' });
    expect(response['properties']['next']['properties']['payload']).toEqual({ type: 'string', format: 'binary' });
    const { tree, folded } = foldCycles(converted);
    expect(folded.length).toBeGreaterThan(0);
    expect(validateOasDocument('3.0', tree)).toEqual({ valid: true, errors: [] });
    expect(leftovers(converted)).toEqual([]);
  });
});

describe('story: type: file', () => {
  it('is a binary string in each media type the response is produced in, and its headers become Header Objects with a schema', async () => {
    const { converted, tools } = await convert(fixture('supplementary/file-response'));
    const responses = operationOf(converted, '/reports/{reportId}/download', 'get').responses;
    expect(Object.keys(responses['200'].content)).toEqual(['application/pdf', 'application/vnd.ms-excel']);
    for (const media of Object.values<Doc>(responses['200'].content)) {
      expect(media).toEqual({ schema: { type: 'string', format: 'binary' } });
    }
    expect(responses['200'].headers['Content-Disposition']).toEqual({
      description: 'The suggested file name',
      schema: { type: 'string' },
    });
    // a response with no schema has no content
    expect(responses['404']).toEqual({ description: 'There is no such report' });
    // the tool: the file (a binary string) for 200, and nothing for the 404 that has no body
    const output = tools.find(({ name }) => name === 'downloadReport')!.outputSchema as Doc;
    expect(output['anyOf']).toEqual([
      expect.objectContaining({ type: 'string', format: 'binary', 'x-status-code': 200 }),
      expect.objectContaining({ type: 'null', 'x-status-code': 404 }),
    ]);
  });

  it('is a binary file part of a multipart request body, required when the parameter is', async () => {
    const { converted, tools } = await convert(parseDocument(`${EQUIVALENCE}/swagger-2.0.yaml`));
    const body = operationOf(converted, '/books/{bookId}/cover', 'post').requestBody;
    expect(body.required).toBe(true);
    expect(body.content['multipart/form-data'].schema).toMatchObject({
      type: 'object',
      required: ['cover'],
      properties: { cover: { type: 'string', format: 'binary' }, caption: { type: 'string', maxLength: 120 } },
    });
    const upload = tools.find(({ name }) => name === 'uploadBookCover')!;
    expect(upload.mapper.filter(({ serialization }) => serialization?.binary).map(({ inputKey }) => inputKey)).toEqual(['cover']);
  });

  it('is still a binary string outside a form, with a warning, where 2.0 does not allow it', async () => {
    const { converted, diagnostics } = await convert({
      swagger: '2.0',
      info: { title: 'Files', version: '1' },
      host: 'files.example.com',
      schemes: ['https'],
      paths: {
        '/files': {
          get: {
            operationId: 'getFile',
            parameters: [{ name: 'f', in: 'query', type: 'file' }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    expect(operationOf(converted, '/files', 'get').parameters[0].schema).toEqual({ type: 'string', format: 'binary' });
    expect(diagnostics.filter(({ code }) => code === 'SWAGGER_FILE_OUTSIDE_FORM_DATA')).toEqual([
      expect.objectContaining({ severity: 'warning', path: expect.stringContaining('/paths/~1files/get/parameters/0') }),
    ]);
  });
});

describe('story: security definitions', () => {
  const document = (): Doc => ({
    swagger: '2.0',
    info: { title: 'Auth', version: '1' },
    host: 'auth.example.com',
    schemes: ['https'],
    securityDefinitions: {
      basicAuth: { type: 'basic' },
      headerKey: { type: 'apiKey', in: 'header', name: 'X-Key' },
      queryKey: { type: 'apiKey', in: 'query', name: 'key' },
      implicitFlow: { type: 'oauth2', flow: 'implicit', authorizationUrl: 'https://auth.example.com/authorize' },
      passwordFlow: { type: 'oauth2', flow: 'password', tokenUrl: 'https://auth.example.com/token', scopes: { read: 'Read' } },
      applicationFlow: { type: 'oauth2', flow: 'application', tokenUrl: 'https://auth.example.com/token', scopes: {} },
      accessCodeFlow: {
        type: 'oauth2',
        flow: 'accessCode',
        authorizationUrl: 'https://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
        scopes: { read: 'Read', write: 'Write' },
      },
    },
    paths: {
      '/secured': {
        get: {
          operationId: 'secured',
          security: [
            { basicAuth: [] },
            { headerKey: [] },
            { queryKey: [] },
            { implicitFlow: [] },
            { passwordFlow: ['read'] },
            { applicationFlow: [] },
            { accessCodeFlow: ['read', 'write'] },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  });

  it('is each definition as OpenAPI 3.0 writes it: the flows renamed, `scopes` always there', async () => {
    const { converted } = await convert(document());
    expect(converted['components'].securitySchemes).toEqual({
      basicAuth: { type: 'http', scheme: 'basic' },
      headerKey: { type: 'apiKey', in: 'header', name: 'X-Key' },
      queryKey: { type: 'apiKey', in: 'query', name: 'key' },
      // no `scopes` in 2.0 (its text requires one, its schema does not): OpenAPI 3.0 requires one, so it is empty
      implicitFlow: { type: 'oauth2', flows: { implicit: { authorizationUrl: 'https://auth.example.com/authorize', scopes: {} } } },
      passwordFlow: { type: 'oauth2', flows: { password: { tokenUrl: 'https://auth.example.com/token', scopes: { read: 'Read' } } } },
      // `application` is `clientCredentials`, `accessCode` is `authorizationCode`
      applicationFlow: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: {} } } },
      accessCodeFlow: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://auth.example.com/token',
            scopes: { read: 'Read', write: 'Write' },
          },
        },
      },
    });
    expect(validateOasDocument('3.0', converted)).toEqual({ valid: true, errors: [] });
  });

  it('gives a tool one credential entry per alternative, with the scopes the requirement names', async () => {
    const { tools } = await convert(document());
    const entries = tools[0].mapper.flatMap(({ security }) => (security ? [security] : []));
    expect(entries.map(({ scheme, type, scopes }) => [scheme, type, scopes])).toEqual([
      ['basicAuth', 'http', []],
      ['headerKey', 'apiKey', []],
      ['queryKey', 'apiKey', []],
      ['implicitFlow', 'oauth2', []],
      ['passwordFlow', 'oauth2', ['read']],
      ['applicationFlow', 'oauth2', []],
      ['accessCodeFlow', 'oauth2', ['read', 'write']],
    ]);
  });

  it('reads the Netlify description as it is written: one implicit definition with no scopes, required of every operation but one', async () => {
    const { converted, tools } = await convert(parseDocument('netlify-trimmed-2.0.json'));
    expect(converted['components'].securitySchemes).toEqual({
      netlifyAuth: {
        type: 'oauth2',
        flows: { implicit: { authorizationUrl: 'https://app.netlify.com/authorize', scopes: {} } },
      },
    });
    expect(converted['security']).toEqual([{ netlifyAuth: [] }]);
    // the operation that says `security: []` is the one the story pins as public
    const publicTools = tools.filter((tool) => !tool.mapper.some(({ security }) => security));
    expect(publicTools.map(({ name }) => name)).toEqual(['getAIGatewayProviders']);
  });
});

describe('story: basePath', () => {
  // The 2.0 text: "The base path on which the API is served, which is relative to the host ... The value MUST start with a
  // leading slash (/)", and the 2.0 schema has `pattern: ^/` for it. An OpenAPI 3.0 server URL is
  // `<scheme>://<host><basePath>`; a `{...}` in it is a server variable, and a query or a fragment is not part of a URL
  // path, so a base path with one of those cannot be put into a server URL as it is.
  it('has an error for a basePath without its leading slash when the document is validated, and the official schema agrees', async () => {
    const document = swagger({ basePath: 'v1' });
    expect(validateOasDocument('2.0', document).valid).toBe(false);
    const generator = await OpenAPIToolGenerator.fromJSON(document, OFFLINE);
    const result = await generator.validate();
    expect(result.valid).toBe(false);
    expect(result.errors?.map(({ code, path }) => [code, path])).toEqual([['INVALID_BASE_PATH', '/basePath']]);
    // generation validates first: it is refused with the same error
    await expect(generator.generateTools()).rejects.toMatchObject({
      context: { errors: [expect.objectContaining({ code: 'INVALID_BASE_PATH', path: '/basePath' })] },
    });
  });

  it('prepends the slash when validation is off, and says so at /basePath', async () => {
    const { converted, tools, diagnostics } = await convert(swagger({ basePath: 'v1' }), { validate: false });
    expect(serverUrlsOf(converted)).toEqual(['https://probe.example.com/v1']);
    expect(tools.map((tool) => (tool.metadata.servers ?? []).map(({ url }) => url))).toEqual([['https://probe.example.com/v1']]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'SWAGGER_INVALID_VALUE', path: '/basePath', document: 'source' }),
    ]);
    expect(diagnostics[0].message).toContain('"/v1" is used');
    expect(validateOasDocument('3.0', converted)).toEqual({ valid: true, errors: [] });
  });

  it('keeps a valid basePath as it is, without its trailing slashes', async () => {
    for (const [basePath, url] of [
      ['/v1', 'https://probe.example.com/v1'],
      ['/v1/', 'https://probe.example.com/v1'],
      ['/api/v2', 'https://probe.example.com/api/v2'],
    ]) {
      const { converted, diagnostics } = await convert(swagger({ basePath }));
      expect({ basePath, urls: serverUrlsOf(converted), findings: conversionDiagnostics(diagnostics) }).toEqual({ basePath, urls: [url], findings: [] });
    }
  });

  it.each([
    ['a server variable', '/v{version}'],
    ['a space', '/my api'],
    ['a query', '/v1?x=1'],
    ['a fragment', '/v1#top'],
    ['a backslash', '/v1\\x'],
    ['a dot segment', '/a/../b'],
    ['a percent-encoded dot segment', '/a/%2e%2e/b'],
  ])('refuses a basePath with %s: an error when validated, and left out of the server URL when it is not', async (_why, basePath) => {
    const document = swagger({ basePath });
    // the official 2.0 schema only has the leading slash to say about it
    expect(validateOasDocument('2.0', document).valid).toBe(true);
    const validated = await (await OpenAPIToolGenerator.fromJSON(document, OFFLINE)).validate();
    expect(validated.errors?.map(({ code, path }) => [code, path])).toEqual([['INVALID_BASE_PATH', '/basePath']]);

    const { converted, diagnostics } = await convert(document, { validate: false });
    expect(serverUrlsOf(converted)).toEqual(['https://probe.example.com']);
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'SWAGGER_INVALID_VALUE', path: '/basePath', document: 'source' }),
    ]);
    expect(diagnostics[0].message).toContain('it is ignored');
  });

  it('refuses a basePath that is not a string in the same way', async () => {
    const document = swagger({ basePath: 5 });
    expect(validateOasDocument('2.0', document).valid).toBe(false);
    const validated = await (await OpenAPIToolGenerator.fromJSON(document, OFFLINE)).validate();
    expect(validated.errors?.map(({ code, path }) => [code, path])).toEqual([['INVALID_BASE_PATH', '/basePath']]);
    const { converted, diagnostics } = await convert(document, { validate: false });
    expect(serverUrlsOf(converted)).toEqual(['https://probe.example.com']);
    expect(conversionDiagnostics(diagnostics)).toEqual(['SWAGGER_INVALID_VALUE at /basePath']);
  });
});

describe('story: schemes', () => {
  // The 2.0 text: "schemes: The transfer protocol of the API. Values MUST be from the list: "http", "https", "ws", "wss"".
  // The operations of this library are HTTP calls, which go over http and https, and an OpenAPI 3.0 server is one URL per
  // scheme. A URI scheme is case-insensitive (RFC 3986 section 3.1), and the library writes it lower-case.
  const SOCKETS = 'SWAGGER_NOT_CONVERTED at /schemes';
  const ASSUMED = 'SWAGGER_ASSUMED_SCHEME at /schemes';
  const host = 'probe.example.com';

  it.each([
    // the schema's enum is lower-case: `HTTP` is not a 2.0 value, and the library reads it anyway
    ['wss before https', ['wss', 'https'], [`https://${host}`], [SOCKETS], true],
    ['every scheme, ws and wss among them', ['ws', 'http', 'wss', 'https'], [`http://${host}`, `https://${host}`], [SOCKETS], true],
    ['http written in capitals', ['HTTP'], [`http://${host}`], [], false],
    ['one scheme in two letter cases', ['Https', 'http', 'HTTPS'], [`https://${host}`, `http://${host}`], [], false],
    ['ws only', ['ws'], [`https://${host}`], [SOCKETS, ASSUMED], true],
    ['ws and wss only', ['ws', 'wss'], [`https://${host}`], [SOCKETS, ASSUMED], true],
  ])('makes the servers of %s', async (_label, schemes, urls, findings, schemaAccepts) => {
    const document = swagger({ schemes });
    expect(validateOasDocument('2.0', document).valid).toBe(schemaAccepts);
    const { converted, tools, diagnostics } = await convert(document);
    expect(serverUrlsOf(converted)).toEqual(urls);
    expect(tools.map((tool) => (tool.metadata.servers ?? []).map(({ url }) => url))).toEqual([urls]);
    expect(conversionDiagnostics(diagnostics)).toEqual(findings);
    for (const diagnostic of diagnostics.filter(({ code }) => code.startsWith('SWAGGER_'))) {
      expect(diagnostic).toMatchObject({ severity: 'warning', document: 'source' });
    }
    expect(validateOasDocument('3.0', converted)).toEqual({ valid: true, errors: [] });
  });

  it('names the sockets it left out, and the assumed scheme when nothing else is left', async () => {
    const { diagnostics } = await convert(swagger({ schemes: ['ws', 'wss'] }));
    const [sockets, assumed] = diagnostics;
    expect(sockets.message).toBe(
      '`schemes` lists "ws", "wss" (WebSocket), which an HTTP operation is never sent over; no server is made for them',
    );
    expect(assumed.message).toContain('https is assumed');
  });

  it('takes the scheme from the document URI for a list with no http or https in it, as for no list at all', async () => {
    const { converted, diagnostics } = await convert(swagger({ schemes: ['ws'] }), { documentUri: 'http://mirror.example.org/probe.yaml' });
    expect(serverUrlsOf(converted)).toEqual([`http://${host}`]);
    // the sockets are still reported, and nothing is assumed
    expect(conversionDiagnostics(diagnostics)).toEqual([SOCKETS]);
  });

  describe('of an operation', () => {
    // 2.0: an operation's `schemes` "overrides the Swagger Object schemes definition"; 3.0: an operation's own `servers`
    const document = (): Doc =>
      swagger({}, {
        '/plain': { get: { operationId: 'plain', responses: OK } },
        '/insecure': { get: { operationId: 'insecure', schemes: ['http', 'https'], responses: OK } },
        '/same': { get: { operationId: 'same', schemes: ['https'], responses: OK } },
        '/socket': { get: { operationId: 'socket', schemes: ['wss'], responses: OK } },
      });

    it('gives an operation servers of its own only where its list differs from the root\'s', async () => {
      const { converted, tools, diagnostics } = await convert(document());
      expect(serverUrlsOf(converted)).toEqual([`https://${host}`]);
      expect(operationOf(converted, '/plain', 'get').servers).toBeUndefined();
      expect(operationOf(converted, '/insecure', 'get').servers).toEqual([{ url: `http://${host}` }, { url: `https://${host}` }]);
      // the same servers as the root's say nothing more
      expect(operationOf(converted, '/same', 'get').servers).toBeUndefined();
      // a list of sockets only leaves the operation with the root's servers, and says why
      expect(operationOf(converted, '/socket', 'get').servers).toBeUndefined();
      expect(conversionDiagnostics(diagnostics)).toEqual(['SWAGGER_NOT_CONVERTED at /paths/~1socket/get/schemes']);
      const urls = (name: string): string[] | undefined => tools.find((tool) => tool.name === name)!.metadata.servers?.map(({ url }) => url);
      expect(urls('plain')).toEqual([`https://${host}`]);
      expect(urls('insecure')).toEqual([`http://${host}`, `https://${host}`]);
      expect(urls('socket')).toEqual([`https://${host}`]);
      expect(validateOasDocument('3.0', converted)).toEqual({ valid: true, errors: [] });
    });
  });
});

describe('story: a form body with a file', () => {
  // The 2.0 text, `formData`: "If type is "file", the `consumes` MUST be either "multipart/form-data",
  // "application/x-www-form-urlencoded" or both". A file is bytes, which only a multipart part can carry, so a form with a
  // file is multipart whatever the list says; a form with none keeps the form media types the list names, in its order.
  const URLENCODED = 'application/x-www-form-urlencoded';
  const MULTIPART = 'multipart/form-data';
  const upload = (consumes: string[] | undefined, ...parameters: Doc[]): Doc =>
    swagger({}, {
      '/upload': { post: { operationId: 'upload', ...(consumes ? { consumes } : {}), parameters, responses: OK } },
    });
  const file: Doc = { name: 'attachment', in: 'formData', type: 'file', required: true };
  const note: Doc = { name: 'note', in: 'formData', type: 'string' };
  const ADDED = 'SWAGGER_FORM_MEDIA_TYPE_ADDED at /paths/~1upload/post';

  it.each([
    ['urlencoded listed first, multipart second', [URLENCODED, MULTIPART], [MULTIPART], []],
    ['multipart first', [MULTIPART, URLENCODED], [MULTIPART], []],
    ['multipart only', [MULTIPART], [MULTIPART], []],
    ['multipart with a parameter, and JSON', ['application/json', `${MULTIPART}; boundary=part`], [`${MULTIPART}; boundary=part`], []],
    ['urlencoded only', [URLENCODED], [MULTIPART], [ADDED]],
    ['only a media type that is no form', ['application/json'], [MULTIPART], [ADDED]],
    ['nothing written', undefined, [MULTIPART], []],
  ])('offers only multipart for a form with a file and a text field, whose consumes is %s', async (_label, consumes, offered, findings) => {
    const { converted, tools, diagnostics } = await convert(upload(consumes, file, note));
    const content = operationOf(converted, '/upload', 'post').requestBody.content;
    expect(Object.keys(content)).toEqual(offered);
    // the same schema in each: the file is a binary string, required
    for (const media of Object.values<Doc>(content)) {
      expect(media.schema).toEqual({
        type: 'object',
        properties: { attachment: { type: 'string', format: 'binary' }, note: { type: 'string' } },
        required: ['attachment'],
      });
    }
    expect(conversionDiagnostics(diagnostics)).toEqual(findings);
    // what the tool sends: multipart, the file as a binary part
    const [tool] = tools;
    expect([...new Set(tool.mapper.filter(({ type }) => type === 'body').map(({ serialization }) => serialization?.contentType))]).toEqual([offered[0]]);
    expect(tool.mapper.filter(({ serialization }) => serialization?.binary).map(({ inputKey }) => inputKey)).toEqual(['attachment']);
    expect(validateOasDocument('3.0', converted)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['urlencoded then multipart', [URLENCODED, MULTIPART], [URLENCODED, MULTIPART]],
    ['multipart then urlencoded', [MULTIPART, URLENCODED], [MULTIPART, URLENCODED]],
    ['multipart', [MULTIPART], [MULTIPART]],
    ['urlencoded', [URLENCODED], [URLENCODED]],
    ['JSON, then urlencoded', ['application/json', URLENCODED], [URLENCODED]],
    ['nothing written: urlencoded', undefined, [URLENCODED]],
  ])('keeps the form media types of consumes that is %s for a form with no file, in the order written', async (_label, consumes, offered) => {
    const { converted, diagnostics } = await convert(upload(consumes, note));
    expect(Object.keys(operationOf(converted, '/upload', 'post').requestBody.content)).toEqual(offered);
    expect(conversionDiagnostics(diagnostics)).toEqual([]);
  });
});

describe('story: security definitions the conversion cannot carry over', () => {
  // A 2.0 oauth2 definition has one of four `flow`s (the 2.0 schema's enum); an unknown one has no OpenAPI 3.0 flow to
  // become, so no scheme is made. A Security Requirement that names it must not be read as "no security": the
  // operation cannot be called without a credential nobody can describe, so it makes no tool.
  const device: Doc = { type: 'oauth2', flow: 'device', tokenUrl: 'https://auth.example.com/token', scopes: {} };
  const apiKey: Doc = { type: 'apiKey', in: 'header', name: 'X-Key' };
  const operation = (id: string, security?: Doc[]): Doc => ({
    get: { operationId: id, ...(security ? { security } : {}), responses: OK },
  });
  const UNSUPPORTED = 'SWAGGER_UNSUPPORTED_SECURITY_SCHEME at /securityDefinitions/device/flow';

  it('is a rejection of the 2.0 schema (its `flow` enum) and still converts to a valid document', async () => {
    const document = swagger({ securityDefinitions: { device } });
    expect(validateOasDocument('2.0', document).valid).toBe(false);
    const { converted, diagnostics } = await convert(document);
    // an empty `securitySchemes` section, present: the definitions the document had are all there is
    expect(converted['components']).toEqual({ securitySchemes: {} });
    expect(diagnostics.filter(({ code }) => code === 'SWAGGER_UNSUPPORTED_SECURITY_SCHEME')).toEqual([
      expect.objectContaining({ severity: 'warning', path: '/securityDefinitions/device/flow', document: 'source' }),
    ]);
    expect(validateOasDocument('3.0', converted)).toEqual({ valid: true, errors: [] });
  });

  it('makes no tool of an operation that requires only a scheme that could not be converted, whether it is the only scheme or not', async () => {
    for (const definitions of [{ device }, { device, apiKey }]) {
      const { tools, diagnostics } = await convert(
        swagger({ securityDefinitions: definitions }, { '/closed': operation('closed', [{ device: [] }]), '/open': operation('open') }),
      );
      expect(tools.map(({ name }) => name)).toEqual(['open']);
      expect(conversionDiagnostics(diagnostics)).toEqual([UNSUPPORTED]);
      expect(diagnostics.map(({ code, path }) => `${code} at ${path}`).filter((line) => !line.startsWith('SWAGGER_'))).toEqual([
        'UNRESOLVED_SECURITY_SCHEME at /paths/~1closed/get/security/0/device',
        'UNSATISFIABLE_SECURITY at /paths/~1closed/get',
      ]);
    }
  });

  it('makes the tool when another requirement can be satisfied, with that scheme only', async () => {
    const { tools, converted } = await convert(
      swagger({ securityDefinitions: { device, apiKey } }, { '/either': operation('either', [{ device: [] }, { apiKey: [] }]) }),
    );
    expect(Object.keys(converted['components'].securitySchemes)).toEqual(['apiKey']);
    expect(tools.map(({ name }) => name)).toEqual(['either']);
    expect(tools[0].mapper.flatMap(({ security }) => (security ? [`${security.scheme}:${security.type}`] : []))).toEqual(['apiKey:apiKey']);
  });

  it('leaves no tool for operations that inherit a root requirement naming the scheme', async () => {
    const { tools, diagnostics } = await convert(
      swagger({ securityDefinitions: { device }, security: [{ device: [] }] }, { '/a': operation('a'), '/b': operation('b') }),
    );
    expect(tools).toEqual([]);
    expect(diagnostics.filter(({ code }) => code === 'UNSATISFIABLE_SECURITY').map(({ path }) => path)).toEqual(['/paths/~1a/get', '/paths/~1b/get']);
  });

  it('keeps an empty securitySchemes whenever the document has securityDefinitions, so a requirement is never read as no security', async () => {
    const { converted, tools } = await convert(swagger({ securityDefinitions: {} }, { '/a': operation('a', [{ ghost: [] }]) }));
    expect(converted['components']).toEqual({ securitySchemes: {} });
    expect(tools).toEqual([]);
  });

  it('is the opposite for a document with no securityDefinitions at all: nothing is invented, and a requirement names nothing (pre-existing convention)', async () => {
    const { converted, tools, diagnostics } = await convert(swagger({}, { '/a': operation('a', [{ ghost: [] }]) }));
    expect(converted['components']).toBeUndefined();
    expect(tools.map(({ name }) => name)).toEqual(['a']);
    expect(tools[0].mapper.some(({ security }) => security)).toBe(false);
    expect(diagnostics.map(({ code }) => code)).toEqual(['UNRESOLVED_SECURITY_SCHEME']);
  });
});

describe('story: a parameter example', () => {
  // The 2.0 schema has no `example` for a parameter that is not a body one (its tooling writes `x-example`);
  // OpenAPI 3.0 has `example` on the Parameter Object ("Example of the parameter's potential value"), and on a Schema
  // Object, which is where a form field's goes. Both spellings occur in real documents.
  const document = (): Doc =>
    swagger({}, {
      '/q': {
        post: {
          operationId: 'q',
          consumes: ['application/x-www-form-urlencoded'],
          parameters: [
            { name: 'count', in: 'query', type: 'integer', 'x-example': 5 },
            { name: 'label', in: 'query', type: 'string', example: 'new' },
            { name: 'both', in: 'query', type: 'string', example: 'from-example', 'x-example': 'from-x-example' },
            { name: 'plain', in: 'query', type: 'string' },
            { name: 'field', in: 'formData', type: 'string', 'x-example': 'in-a-form' },
            { name: 'other', in: 'formData', type: 'string', example: 'also-a-form' },
          ],
          responses: OK,
        },
      },
    });

  it('is accepted by the 2.0 schema as x-example only', () => {
    const withExample = document();
    expect(validateOasDocument('2.0', withExample).valid).toBe(false);
    for (const parameter of withExample['paths']['/q'].post.parameters as Doc[]) delete parameter['example'];
    expect(validateOasDocument('2.0', withExample)).toEqual({ valid: true, errors: [] });
  });

  it('becomes the `example` of the Parameter Object (a form field\'s, of its property schema); `example` wins over `x-example`, which stays an extension', async () => {
    const { converted, diagnostics } = await convert(document());
    const post = operationOf(converted, '/q', 'post');
    const byName = Object.fromEntries((post.parameters as Doc[]).map((parameter) => [parameter.name, parameter]));
    expect(byName['count'].example).toBe(5);
    expect(byName['count']['x-example']).toBe(5);
    expect(byName['label'].example).toBe('new');
    expect(byName['both'].example).toBe('from-example');
    expect(byName['both']['x-example']).toBe('from-x-example');
    expect('example' in byName['plain']).toBe(false);
    const properties = post.requestBody.content['application/x-www-form-urlencoded'].schema.properties;
    expect(properties['field'].example).toBe('in-a-form');
    expect(properties['other'].example).toBe('also-a-form');
    expect(conversionDiagnostics(diagnostics)).toEqual([]);
    expect(validateOasDocument('3.0', converted)).toEqual({ valid: true, errors: [] });
  });

  it('shows in the input schema of the tool as an example, when examples are asked for', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document(), OFFLINE);
    const [tool] = await generator.generateTools({ includeExamples: true });
    const properties = (tool.inputSchema as Doc)['properties'];
    expect(properties['count'].examples).toEqual([5]);
    expect(properties['label'].examples).toEqual(['new']);
    expect(properties['both'].examples).toEqual(['from-example']);
    expect(properties['plain'].examples).toBeUndefined();
    expect(properties['field'].examples).toEqual(['in-a-form']);
    expect(properties['other'].examples).toEqual(['also-a-form']);
    // and not otherwise
    const [bare] = await generator.generateTools();
    expect((bare.inputSchema as Doc)['properties']['count'].examples).toBeUndefined();
  });
});

describe('story: a parameter name that is not a string', () => {
  // The 2.0 schema says `name` is a string, and YAML reads an unquoted `2024` or `true` as a number or a boolean. A number
  // or a boolean has a text that says what the author meant; anything else (an object, an array, nothing) names nothing.
  const BODY: Doc = { name: 'body', in: 'body', schema: { type: 'string' } };

  it('reads a number or a boolean as its text, and warns once, at its place in the 2.0 document (a body parameter before it is not counted in the converted list)', async () => {
    const parameters: Doc[] = [BODY, { name: 2024, in: 'query', type: 'string' }, { name: true, in: 'header', type: 'string' }];
    const document = swagger({}, { '/n': { post: { operationId: 'n', parameters, responses: OK } } });
    expect(validateOasDocument('2.0', document).valid).toBe(false);
    const { converted, tools, diagnostics } = await convert(document);
    const post = operationOf(converted, '/n', 'post');
    expect((post.parameters as Doc[]).map(({ name, in: location }) => [name, location])).toEqual([
      ['2024', 'query'],
      ['true', 'header'],
    ]);
    // once each (the validator warns too, and generation finds it again in the converted list), at index 1 and 2 of the
    // document as written: the converted list has them at 0 and 1
    expect(diagnostics.filter(({ code }) => code === 'PARAMETER_NAME_NOT_STRING')).toEqual([
      expect.objectContaining({ severity: 'warning', path: '/paths/~1n/post/parameters/1/name', document: 'source' }),
      expect.objectContaining({ severity: 'warning', path: '/paths/~1n/post/parameters/2/name', document: 'source' }),
    ]);
    expect(Object.keys((tools[0].inputSchema as Doc)['properties'])).toEqual(['2024', 'true', 'body']);
    // and the request carries them under their text
    const request = buildHttpRequest(tools[0], { '2024': 'x', true: 'yes', body: 'p' });
    expect(request.url).toBe('https://probe.example.com/n?2024=x');
    expect(request.headers['true']).toBe('yes');
  });

  it('refuses a name that is an object: the validator rejects the document, and with validation off the operation makes no tool', async () => {
    const document = swagger({}, {
      '/bad': { get: { operationId: 'bad', parameters: [{ name: { first: 'a' }, in: 'query', type: 'string' }], responses: OK } },
      '/good': { get: { operationId: 'good', responses: OK } },
    });
    const validated = await (await OpenAPIToolGenerator.fromJSON(document, OFFLINE)).validate();
    expect(validated.errors?.map(({ code, path }) => [code, path])).toEqual([['INVALID_PARAMETER_NAME', '/paths/~1bad/get/parameters/0/name']]);
    const { tools, diagnostics } = await convert(document, { validate: false });
    expect(tools.map(({ name }) => name)).toEqual(['good']);
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'INVALID_PARAMETER_NAME', path: '/paths/~1bad/get/parameters/0/name', document: 'source' }),
    ]);
  });

  it('leaves out a form field with no usable name, as a property cannot be made without one', async () => {
    const document = swagger({}, {
      '/form': {
        post: {
          operationId: 'form',
          consumes: ['application/x-www-form-urlencoded'],
          parameters: [{ name: ['a'], in: 'formData', type: 'string' }, { name: 'kept', in: 'formData', type: 'string' }],
          responses: OK,
        },
      },
    });
    const { converted, tools, diagnostics } = await convert(document, { validate: false });
    expect(Object.keys(operationOf(converted, '/form', 'post').requestBody.content['application/x-www-form-urlencoded'].schema.properties)).toEqual(['kept']);
    expect(Object.keys((tools[0].inputSchema as Doc)['properties'])).toEqual(['kept']);
    expect(conversionDiagnostics(diagnostics)).toEqual(['SWAGGER_INVALID_VALUE at /paths/~1form/post/parameters/0']);
  });
});

describe('story: invalid Swagger 2.0 documents are converted, and say what they repaired', () => {
  const RESPONSES = { responses: OK };

  it('makes a path parameter with no `required: true` required, and says so where the member should be', async () => {
    const document = fixture('supplementary/invalid/path-parameter-not-required');
    // the 2.0 text and schema require it; the document does not, as many real ones do not
    expect(validateOasDocument('2.0', document).valid).toBe(false);
    const validated = await (await OpenAPIToolGenerator.fromJSON(document, OFFLINE)).validate();
    expect(validated.errors?.map(({ code }) => code)).toEqual(['PATH_PARAMETER_NOT_REQUIRED']);

    const { converted, tools, diagnostics } = await convert(document, { validate: false });
    const [parameter] = operationOf(converted, '/things/{thingId}', 'get').parameters as Doc[];
    expect(parameter.required).toBe(true);
    expect((tools[0].inputSchema as Doc)['required']).toEqual(['thingId']);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'SWAGGER_INVALID_VALUE',
        path: '/paths/~1things~1{thingId}/get/parameters/0/required',
        document: 'source',
      }),
    ]);
    // converted into a document that is valid OpenAPI 3.0, as the conformance table above checks for every document
    expect(validateOasDocument('3.0', converted)).toEqual({ valid: true, errors: [] });
  });

  it('does the same for `required: false`, in a path-level and a global parameter, as one finding', async () => {
    const document = swagger(
      { parameters: { Id: { name: 'id', in: 'path', required: false, type: 'string' } } },
      {
        '/a/{id}': {
          parameters: [{ $ref: '#/parameters/Id' }],
          get: { operationId: 'a', ...RESPONSES },
        },
        '/b/{id}': {
          parameters: [{ name: 'id', in: 'path', required: false, type: 'string' }],
          get: { operationId: 'b', ...RESPONSES },
        },
      },
    );
    const { converted, diagnostics } = await convert(document, { validate: false });
    expect((converted['paths']['/b/{id}'].parameters as Doc[]).map(({ required }) => required)).toEqual([true]);
    expect((converted['components'].parameters['Id'] as Doc).required).toBe(true);
    // one finding of one kind (a path parameter that is `required: false`), found in three places (the global parameter,
    // the path-level `$ref` to it and the inline one): one diagnostic, at the first, which is the global parameter (the
    // components are read first)
    const found = diagnostics.filter(({ code }) => code === 'SWAGGER_INVALID_VALUE');
    expect(found.map(({ path }) => path)).toEqual(['/parameters/Id/required']);
    expect(found[0].message).toBe(
      'A path parameter must be required (`required: true`), found false; it is converted as required ' +
        '(in 3 places: /parameters/Id/required, /paths/~1a~1{id}/parameters/0/required, /paths/~1b~1{id}/parameters/0/required)',
    );
  });

  it.each([
    ['SWAGGER_BODY_AND_FORM_DATA', 'supplementary/invalid/body-and-form-data', '/paths/~1submissions/post/parameters'],
    ['SWAGGER_MULTIPLE_BODY_PARAMETERS', undefined, '/paths/~1x/post/parameters'],
  ])('reports %s at the `parameters` of the operation, where the validator reports it', async (code, label, pointer) => {
    const document =
      label !== undefined
        ? fixture(label)
        : swagger({}, {
            '/x': {
              post: {
                operationId: 'x',
                parameters: [
                  { name: 'one', in: 'body', schema: { type: 'string' } },
                  { name: 'two', in: 'body', schema: { type: 'string' } },
                ],
                responses: OK,
              },
            },
          });
    const validated = await (await OpenAPIToolGenerator.fromJSON(document, OFFLINE)).validate();
    const error = validated.errors?.find((candidate) => candidate.code === code);
    expect(error?.path).toBe(pointer);
    const { diagnostics } = await convert(document, { validate: false });
    expect(diagnostics.filter((diagnostic) => diagnostic.code === code)).toEqual([
      expect.objectContaining({ severity: 'warning', path: pointer, document: 'source' }),
    ]);
  });
});

describe('story: findings of one kind are one diagnostic', () => {
  // `type: file` outside a form is one finding, however many parameters it is found on
  const fileQueries = (count: number): Doc =>
    swagger(
      {},
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `/p${index}`,
          { get: { operationId: `get${index}`, parameters: [{ name: 'f', in: 'query', type: 'file' }], responses: OK } },
        ]),
      ),
    );
  const place = (index: number): string => `/paths/~1p${index}/get/parameters/0/type`;

  it.each([
    [1, ''],
    [2, ` (in 2 places: ${place(0)}, ${place(1)})`],
    [3, ` (in 3 places: ${place(0)}, ${place(1)}, ${place(2)})`],
    [5, ` (in 5 places: ${place(0)}, ${place(1)}, ${place(2)} and 2 more)`],
    [40, ` (in 40 places: ${place(0)}, ${place(1)}, ${place(2)} and 37 more)`],
  ])('is one diagnostic for %s place(s), at the first, with "%s" after the message', async (count, suffix) => {
    const { diagnostics } = await convert(fileQueries(count));
    const found = diagnostics.filter(({ code }) => code === 'SWAGGER_FILE_OUTSIDE_FORM_DATA');
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(place(0));
    const base = '`type: file` is only allowed for an `in: formData` parameter (and a response schema); it is converted to a binary string anyway';
    expect(found[0].message).toBe(`${base}${suffix}`);
    expect(found[0]).toMatchObject({ severity: 'warning', document: 'source' });
  });
});

describe('story: the bounds of a conversion', () => {
  const mediaTypes = (count: number, prefix = 'application/vnd.example.v'): string[] =>
    Array.from({ length: count }, (_, index) => `${prefix}${index + 1}+json`);
  const withLists = (consumes?: string[], produces?: string[]): Doc =>
    swagger(
      { ...(consumes ? { consumes } : {}), ...(produces ? { produces } : {}) },
      {
        '/x': {
          post: {
            operationId: 'x',
            parameters: [{ name: 'body', in: 'body', schema: { type: 'string' } }],
            responses: { '200': { description: 'ok', schema: { type: 'string' } } },
          },
        },
      },
    );
  const LIMIT = 'SWAGGER_MEDIA_TYPE_LIMIT';

  it('states its two bounds: 32 media types of a list and a million entries in all', () => {
    expect(MAX_MEDIA_TYPES_PER_LIST).toBe(32);
    expect(MAX_CONVERSION_ENTRIES).toBe(1_000_000);
  });

  describe('a consumes or produces list is cut at 32 distinct media types', () => {
    it.each([
      [32, undefined],
      [undefined, 32],
      [20, 25],
    ])('keeps lists of %s and %s media types whole, without a finding', async (consumes, produces) => {
      const { converted, diagnostics } = await convert(
        withLists(consumes ? mediaTypes(consumes) : undefined, produces ? mediaTypes(produces, 'text/x-v') : undefined),
      );
      const post = operationOf(converted, '/x', 'post');
      expect(Object.keys(post.requestBody.content)).toHaveLength(consumes ?? 1);
      expect(Object.keys(post.responses['200'].content)).toHaveLength(produces ?? 1);
      expect(diagnostics.filter(({ code }) => code === LIMIT)).toEqual([]);
    });

    it('keeps the first 32 of 33, in order, and says so once, at the list', async () => {
      const list = mediaTypes(33);
      const { converted, diagnostics } = await convert(withLists(list));
      expect(Object.keys(operationOf(converted, '/x', 'post').requestBody.content)).toEqual(list.slice(0, 32));
      expect(diagnostics.filter(({ code }) => code === LIMIT)).toEqual([
        {
          severity: 'warning',
          code: LIMIT,
          message: 'A `consumes` or `produces` list holds more than 32 distinct media types: the first 32 of each are kept and 1 is ignored',
          path: '/consumes',
          document: 'source',
        },
      ]);
      expect(validateOasDocument('3.0', converted)).toEqual({ valid: true, errors: [] });
    });

    it('counts distinct media types: 33 entries with a repeat are 32', async () => {
      const { converted, diagnostics } = await convert(withLists([...mediaTypes(32), 'application/vnd.example.v1+json']));
      expect(Object.keys(operationOf(converted, '/x', 'post').requestBody.content)).toEqual(mediaTypes(32));
      expect(diagnostics.filter(({ code }) => code === LIMIT)).toEqual([]);
    });

    it('is one diagnostic for the whole document, naming how many lists and media types: consumes 33 and produces 40', async () => {
      const { converted, diagnostics } = await convert(withLists(mediaTypes(33), mediaTypes(40, 'text/x-v')));
      const post = operationOf(converted, '/x', 'post');
      expect(Object.keys(post.requestBody.content)).toEqual(mediaTypes(33).slice(0, 32));
      expect(Object.keys(post.responses['200'].content)).toEqual(mediaTypes(40, 'text/x-v').slice(0, 32));
      const found = diagnostics.filter(({ code }) => code === LIMIT);
      expect(found).toHaveLength(1);
      // 1 + 8 media types left out of 2 lists, the first of them `/consumes`
      expect(found[0].message).toBe(
        '2 `consumes` or `produces` lists hold more than 32 distinct media types: the first 32 of each are kept and 9 are ignored',
      );
      expect(found[0].path).toBe('/consumes');
    });

    it('cuts an operation\'s own list as well, and points at it', async () => {
      const document = withLists();
      document['paths']['/x'].post.consumes = mediaTypes(40);
      const { converted, diagnostics } = await convert(document);
      expect(Object.keys(operationOf(converted, '/x', 'post').requestBody.content)).toEqual(mediaTypes(40).slice(0, 32));
      expect(diagnostics.filter(({ code }) => code === LIMIT).map(({ path, message }) => [path, message.endsWith('and 8 are ignored')])).toEqual([
        ['/paths/~1x/post/consumes', true],
      ]);
    });
  });

  describe('a conversion is abandoned when it would create more entries than allowed (the `maxEntries` option)', () => {
    // What counts, from the limit's own description: a media type of a request body or of a response with a body
    // (`content`), a form `encoding` entry, a response header and a property of a form body.
    const entriesDocument = (extra: Doc, operation: Doc): Doc =>
      swagger(extra, { '/x': { post: { operationId: 'x', ...operation } } });
    const CASES: Array<[label: string, document: Doc, entries: number]> = [
      [
        'a body in 3 media types, and a response with a body in 2',
        entriesDocument(
          { consumes: ['application/json', 'application/xml', 'text/plain'], produces: ['application/json', 'application/xml'] },
          {
            parameters: [{ name: 'body', in: 'body', schema: { type: 'string' } }],
            responses: { '200': { description: 'ok', schema: { type: 'string' } } },
          },
        ),
        3 + 2,
      ],
      [
        'a form of 2 fields (one an array, so 1 encoding) in 2 media types',
        entriesDocument(
          { consumes: ['application/x-www-form-urlencoded', 'multipart/form-data'] },
          {
            parameters: [
              { name: 'title', in: 'formData', type: 'string' },
              { name: 'tags', in: 'formData', type: 'array', items: { type: 'string' } },
            ],
            responses: OK,
          },
        ),
        2 + 1 + 2,
      ],
      [
        'a response with a body, in 1 media type, and 2 headers',
        entriesDocument(
          {},
          {
            responses: {
              '200': {
                description: 'ok',
                schema: { type: 'string' },
                headers: { 'X-One': { type: 'string' }, 'X-Two': { type: 'integer' } },
              },
            },
          },
        ),
        1 + 2,
      ],
    ];

    it.each(CASES)('allows exactly the entries it needs: %s (%i)', (_label, document, entries) => {
      const enough = upgradeSwagger2(document, { maxEntries: entries });
      expect(enough.tooLarge).toBeUndefined();
      expect(Object.keys(enough.document.paths)).toEqual(['/x']);
      expect(enough.diagnostics.map(({ code }) => code)).not.toContain('SWAGGER_CONVERSION_TOO_LARGE');

      const short = upgradeSwagger2(document, { maxEntries: entries - 1 });
      expect(short.tooLarge).toBe(true);
      // no path, the document's info, and the finding last, at the document
      expect(short.document).toEqual({ openapi: '3.0.3', info: document['info'], paths: {} });
      const last = short.diagnostics[short.diagnostics.length - 1];
      expect(last).toMatchObject({ severity: 'warning', code: 'SWAGGER_CONVERSION_TOO_LARGE', path: '' });
      expect(last.message).toContain(`more than ${entries - 1} media type, encoding, header and form property entries`);
      // the converter itself says nothing of which document a pointer is in: the generator does
      expect(last).not.toHaveProperty('document');
    });

    it.each([0, -3, Number.NaN, 'many', null, undefined, {}])('reads a maxEntries of %p as the default, which is far above this document', (maxEntries) => {
      const [, document] = CASES[0];
      const result = upgradeSwagger2(document, { maxEntries: maxEntries as number });
      expect(result.tooLarge).toBeUndefined();
      expect(Object.keys(result.document.paths)).toEqual(['/x']);
    });

    it('rounds a fractional maxEntries down: 4.9 allows 4', () => {
      const [, document, entries] = CASES[0];
      expect(upgradeSwagger2(document, { maxEntries: entries - 0.1 }).tooLarge).toBe(true);
      expect(upgradeSwagger2(document, { maxEntries: entries + 0.9 }).tooLarge).toBeUndefined();
    });

    it('fails generation for a document that really needs more than MAX_CONVERSION_ENTRIES, with a ParseError that stays', async () => {
      // 32 media types in `consumes`, and a body parameter for each of 31,251 operations: 32 x 31,251 = 1,000,032 entries
      const consumes = mediaTypes(MAX_MEDIA_TYPES_PER_LIST);
      const operations = Math.floor(MAX_CONVERSION_ENTRIES / MAX_MEDIA_TYPES_PER_LIST) + 1;
      const body = { name: 'body', in: 'body', schema: { type: 'string' } };
      const paths = Object.fromEntries(
        Array.from({ length: operations }, (_, index) => [
          `/p${index}`,
          { post: { operationId: `op${index}`, parameters: [body], responses: OK } },
        ]),
      );
      const generator = await OpenAPIToolGenerator.fromJSON(swagger({ consumes }, paths), OFFLINE);
      const failure = await generator.generateTools().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ParseError);
      expect((failure as ParseError).message).toContain(`more than ${MAX_CONVERSION_ENTRIES} media type, encoding, header and form property entries`);
      expect((failure as ParseError).context).toEqual({ code: 'SWAGGER_CONVERSION_TOO_LARGE', maxEntries: MAX_CONVERSION_ENTRIES });
      // the same failure from every way in, never a half-converted document
      await expect(generator.lint()).rejects.toBe(failure);
      await expect(generator.generateTool('/p0', 'post')).rejects.toBe(failure);
      expect((generator.getDocument() as Doc)['swagger']).toBe('2.0');
      expect(generator.getDiagnostics().filter(({ code }) => code === 'SWAGGER_CONVERSION_TOO_LARGE')).toEqual([
        expect.objectContaining({ severity: 'warning', path: '', document: 'source' }),
      ]);
    });
  });
});

describe('story: where a diagnostic of a Swagger 2.0 document points', () => {
  // `document: 'source'` says the `path` of a diagnostic is a JSON Pointer into the 2.0 document as written, whatever
  // the diagnostic is about: the converter's findings and the ones generation makes about the converted parameters
  // alike, the index of a parameter being its index in the 2.0 list (an `in: body` parameter is not in the converted one)
  const document = (): Doc =>
    swagger({}, {
      '/items': {
        post: {
          operationId: 'addItem',
          parameters: [
            { name: 'item', in: 'body', schema: { type: 'string' } },
            { name: 'cols', in: 'query', type: 'array', items: { type: 'string' }, collectionFormat: 'tsv' },
            { name: 2024, in: 'query', type: 'string' },
            { name: 'q', in: 'query', type: 'string' },
            { name: 'q', in: 'query', type: 'integer' },
          ],
          responses: OK,
        },
      },
    });

  it('marks every diagnostic with a path as `source`, and none as `converted`', async () => {
    const { diagnostics } = await convert(document());
    expect(diagnostics.length).toBeGreaterThan(3);
    for (const { code, path, document: marker } of diagnostics) {
      expect({ code, marker }).toEqual({ code, marker: path === undefined ? undefined : 'source' });
    }
  });

  it('points at the parameters where the 2.0 document has them, once each, and the same pointer leads nowhere in the converted one', async () => {
    const swagger2 = document();
    const { converted, diagnostics } = await convert(swagger2);
    const place = (code: string): Array<string | undefined> => diagnostics.filter((diagnostic) => diagnostic.code === code).map(({ path }) => path);
    expect(place('SWAGGER_UNSUPPORTED_COLLECTION_FORMAT')).toEqual(['/paths/~1items/post/parameters/1/collectionFormat']);
    expect(place('PARAMETER_NAME_NOT_STRING')).toEqual(['/paths/~1items/post/parameters/2/name']);
    expect(place('DUPLICATE_PARAMETER')).toEqual(['/paths/~1items/post/parameters/3']);
    // what the first of each points at, in the document as written
    expect(pointerTarget(swagger2, '/paths/~1items/post/parameters/1/collectionFormat')).toBe('tsv');
    expect(pointerTarget(swagger2, '/paths/~1items/post/parameters/2/name')).toBe(2024);
    expect(pointerTarget(swagger2, '/paths/~1items/post/parameters/3')).toEqual({ name: 'q', in: 'query', type: 'string' });
    // in the converted document the same pointers are somewhere else, or nowhere: that is why the marker matters
    expect(pointerTarget(converted, '/paths/~1items/post/parameters/1/collectionFormat')).toBeUndefined();
    expect(pointerTarget(converted, '/paths/~1items/post/parameters/2/name')).toBe('q');
  });

  it('is set by the generator, not by the converter, and never for a document of another version', async () => {
    expect(upgradeSwagger2(document()).diagnostics.every((diagnostic) => !('document' in diagnostic))).toBe(true);
    const { diagnostics } = await convert({
      openapi: '3.0.3',
      info: { title: 'Plain', version: '1' },
      paths: { '/a': { get: { operationId: 'a', security: [{ ghost: [] }], responses: OK } } },
    });
    expect(diagnostics.map(({ code }) => code)).toContain('UNRESOLVED_SECURITY_SCHEME');
    expect(diagnostics.every((diagnostic) => !('document' in diagnostic))).toBe(true);
  });
});

describe('story: more findings than the list of diagnostics keeps', () => {
  // The list keeps `MAX_DIAGNOSTICS` (1,000) entries, warnings in preference to infos: a new warning takes the place of
  // the latest info, and `DIAGNOSTICS_TRUNCATED` says how many warnings and how many infos were not recorded.
  // The document: a body (so one info, `SWAGGER_ASSUMED_MEDIA_TYPE`) and then 1,100 query parameters whose name is a
  // number, each its own warning (`PARAMETER_NAME_NOT_STRING`, at its own place)
  const document = (): Doc =>
    swagger({}, {
      '/a': { post: { operationId: 'a', parameters: [{ name: 'body', in: 'body', schema: { type: 'string' } }], responses: OK } },
      '/b': {
        get: {
          operationId: 'b',
          parameters: Array.from({ length: 1100 }, (_, index) => ({ name: index + 1, in: 'query', type: 'string' })),
          responses: OK,
        },
      },
    });

  it('keeps 1,000 warnings, lets the info make room for the 1,000th, and counts what it left out: 100 warnings and 1 info', async () => {
    const { tools, diagnostics } = await convert(document(), { validate: false });
    expect(tools.map(({ name }) => name)).toEqual(['a', 'b']);
    expect(diagnostics).toHaveLength(1001);
    const kept = diagnostics.slice(0, 1000);
    // the 1,000 warnings are the first 1,000 parameters; the info (found first) gave way to the 1,000th
    expect(kept.every(({ severity, code }) => severity === 'warning' && code === 'PARAMETER_NAME_NOT_STRING')).toBe(true);
    expect(kept.map(({ path }) => path)).toEqual(Array.from({ length: 1000 }, (_, index) => `/paths/~1b/get/parameters/${index}/name`));
    expect(diagnostics[1000]).toEqual({
      severity: 'warning',
      code: 'DIAGNOSTICS_TRUNCATED',
      message: 'Only 1000 diagnostics are kept, warnings in preference to infos; 100 warnings and 1 info were not recorded',
    });
  });

  it('counts the validator\'s own cut as one more warning when the document is validated first', async () => {
    // the validator keeps 1,000 warnings of its own and ends them with its `DIAGNOSTICS_TRUNCATED`: that entry finds the
    // generator's list full (1 warning), the converter's 1,100 warnings are the validator's 1,000 again and 100 new ones, and the
    // info finds the list full (1 info)
    const { diagnostics } = await convert(document());
    expect(diagnostics).toHaveLength(1001);
    expect(diagnostics[1000].message).toBe(
      'Only 1000 diagnostics are kept, warnings in preference to infos; 101 warnings and 1 info were not recorded',
    );
  });
});

describe('story: the states of getDocument() and getSpecVersion()', () => {
  const DECLARED = {
    status: 'supported',
    field: 'swagger',
    declared: '2.0',
    major: 2,
    minor: 0,
    family: '2.0',
    diagnostics: [],
  };
  const hasReference = (node: unknown, seen = new Set<unknown>()): boolean => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    return '$ref' in (node as Doc) || Object.values(node).some((member) => hasReference(member, seen));
  };

  it('is the document as loaded until generation, the OpenAPI 3.0 conversion after, and the declared version throughout', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(fixture('official/petstore'), OFFLINE);
    const loaded = generator.getDocument() as Doc;
    expect(loaded['swagger']).toBe('2.0');
    expect(loaded['openapi']).toBeUndefined();
    expect(hasReference(loaded)).toBe(true);
    expect(generator.getSpecVersion()).toEqual(DECLARED);

    // validation never converts: it reads the document as written
    expect((await generator.validate()).valid).toBe(true);
    expect(generator.getDocument()).toBe(loaded);

    await generator.generateTools();
    const converted = generator.getDocument() as Doc;
    expect(converted).not.toBe(loaded);
    expect(converted['openapi']).toBe('3.0.3');
    expect(converted['swagger']).toBeUndefined();
    expect(hasReference(converted)).toBe(false);
    expect(generator.getSpecVersion()).toEqual(DECLARED);

    // converted once: every later call reads the same document
    await generator.generateTools({ target: 'claude' });
    await generator.generateTool('/pets', 'get');
    await generator.lint();
    expect(generator.getDocument()).toBe(converted);
  });

  it('is converted by lint() alone, and by generateTool() alone', async () => {
    const linted = await OpenAPIToolGenerator.fromJSON(fixture('official/petstore'), OFFLINE);
    await linted.lint();
    expect((linted.getDocument() as Doc)['openapi']).toBe('3.0.3');
    const single = await OpenAPIToolGenerator.fromJSON(fixture('official/petstore'), OFFLINE);
    await single.generateTool('/pets/{petId}', 'get');
    expect((single.getDocument() as Doc)['openapi']).toBe('3.0.3');
  });

  it('is dereferenced, still Swagger 2.0, once validate() has read the files a document refers to', async () => {
    const generator = await OpenAPIToolGenerator.fromFile(fixturePath(`${EQUIVALENCE}/swagger-2.0-split/swagger.yaml`), FILES);
    const loaded = generator.getDocument() as Doc;
    expect(hasReference(loaded)).toBe(true);
    expect((await generator.validate()).valid).toBe(true);
    const dereferenced = generator.getDocument() as Doc;
    expect(dereferenced['swagger']).toBe('2.0');
    expect(hasReference(dereferenced)).toBe(false);
    await generator.generateTools();
    expect((generator.getDocument() as Doc)['openapi']).toBe('3.0.3');
  });

  it('reads the version `swagger: 2.0` as the YAML number 2 too, and refuses any other', async () => {
    const asNumber = await OpenAPIToolGenerator.fromJSON({ ...fixture('official/petstore'), swagger: 2 }, OFFLINE);
    expect(asNumber.getSpecVersion()).toMatchObject({ status: 'supported', field: 'swagger', family: '2.0' });
    expect(await asNumber.generateTools()).toHaveLength(3);
    const older = await OpenAPIToolGenerator.fromJSON({ ...fixture('official/petstore'), swagger: '1.2' }, OFFLINE);
    expect(older.getSpecVersion()).toMatchObject({ status: 'unsupported', field: 'swagger' });
    expect(older.getDiagnostics().map(({ code }) => code)).toContain('INVALID_OPENAPI_VERSION');
    await expect(older.generateTools()).rejects.toBeInstanceOf(ParseError);
  });

  it('is linted as the tools it makes: the same findings from the generator, from the converted document and from the dereferenced one', async () => {
    for (const label of ['official/petstore', 'equivalence/swagger-2.0']) {
      const document = DOCUMENTS.find((candidate) => candidate.label === label)!;
      const generator = await open(document);
      const result = await generator.lint();
      expect(result.findings.length).toBeGreaterThan(0);
      // `GET /pets`: the operations and their labels are those of the tools
      expect(result.findings.every(({ path }) => /^(GET|POST|PUT|PATCH|DELETE) \//.test(path))).toBe(true);
      expect(lintDocument(generator.getDocument() as object)).toEqual(result);
      expect(lintDocument(await dereference(document))).toEqual(result);
    }
  });
});

describe('story: an Arazzo workflow over a Swagger 2.0 source', () => {
  const arazzo: ArazzoDocument = {
    arazzo: '1.0.0',
    info: { title: 'Cataloguing', version: '1.0.0' },
    sourceDescriptions: [{ name: 'library', url: 'https://library.example.com/swagger.yaml' }],
    workflows: [
      {
        workflowId: 'catalogueBook',
        summary: 'Add a book, then read it back',
        inputs: {
          type: 'object',
          properties: { title: { type: 'string' }, isbn: { type: 'string' } },
          required: ['title', 'isbn'],
        },
        steps: [
          {
            stepId: 'create',
            operationId: 'createBook',
            requestBody: { contentType: 'application/json', payload: { title: '$inputs.title', isbn: '$inputs.isbn' } },
            outputs: { id: '$response.body#/id' },
          },
          {
            stepId: 'fetch',
            operationId: 'getBook',
            parameters: [{ name: 'bookId', in: 'path', value: '$steps.create.outputs.id' }],
            outputs: { title: '$response.body#/title' },
          },
        ],
        outputs: { id: '$steps.create.outputs.id', title: '$steps.fetch.outputs.title' },
      },
    ],
  };

  const loopback = createLoopbackServer(() => (req, res, body) => {
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        req.method === 'POST'
          ? { kind: 'Book', id: 11, ...JSON.parse(body.toString()), status: 'available' }
          : { kind: 'Book', id: 11, title: 'Dune', isbn: '978-0441172719', status: 'available' },
      ),
    );
  });
  afterAll(() => loopback.close());

  it('finds each step by operationId in the 2.0 document, and drives them over HTTP, the basePath in the paths', async () => {
    const [workflow] = await fromArazzo(arazzo, { sources: { library: parseDocument(`${EQUIVALENCE}/swagger-2.0.yaml`) } });
    expect(workflow.name).toBe('catalogueBook');
    expect(workflow.metadata.workflow!.steps.map(({ stepId }) => stepId)).toEqual(['create', 'fetch']);

    const base = await loopback.listen();
    const run = await executeWorkflow(workflow, { title: 'Dune', isbn: '978-0441172719' }, `${base}/api/v1`);

    const [created, fetched] = loopback.requests;
    expect([created.method, created.url, created.headers['content-type']]).toEqual(['POST', '/api/v1/books', 'application/json']);
    expect(JSON.parse(created.body.toString())).toEqual({ title: 'Dune', isbn: '978-0441172719' });
    expect([fetched.method, fetched.url]).toEqual(['GET', '/api/v1/books/11']);
    expect(run.outputs).toEqual({ id: 11, title: 'Dune' });
  });
});
