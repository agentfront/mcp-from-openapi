/**
 * The pinned official OpenAPI sources this repository vendors (e2e/fixtures/oas, pinned in
 * e2e/fixtures/oas/sources.json), and the Swagger 2.0 documents of the repository against the
 * official 2.0 schema.
 *
 * - The vendored files match their pinned checksums (scripts/sync-oas-sources.mjs, offline).
 * - Every Swagger 2.0 document the stories read validates against the official 2.0 schema (the
 *   official examples, the supplementary documents, the Netlify trim, the equivalence API), except
 *   the ones that are meant not to, whose verdict is pinned; the fragments of the multi-file example
 *   are not documents. The validation helper (e2e/helpers/oas-validate.ts) is checked too.
 *
 * The types are held to the official schemas in openapi-spec, which owns them
 * (https://github.com/agentfront/openapi-spec, e2e/spec-types-parity.e2e.ts).
 */
import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { basename, join } from 'path';
import * as yaml from 'yaml';
import { fixturePath, loadFixture } from './helpers/fixtures';
import { rejectUntoleratedWarnings, swagger2SchemasAreDraft04, validateOasDocument } from './helpers/oas-validate';

const repoRoot = join(__dirname, '..');

const sorted = (names: Iterable<string>): string[] => [...names].sort();

describe('story: the pinned official sources', () => {
  it('verifies the vendored files against their pinned checksums', () => {
    const result = spawnSync(process.execPath, ['scripts/sync-oas-sources.mjs'], { cwd: repoRoot, encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toMatch(/^\d+ sources verified$/m);
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

