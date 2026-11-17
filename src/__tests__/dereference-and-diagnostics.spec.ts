import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GenerationError, LoadError, ParseError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';

const ok = { 200: { description: 'ok' } };

function objectSchema(propertyCount: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(Array.from({ length: propertyCount }, (_, index) => [`p${index}`, { type: 'string' }])),
  };
}

describe('the internal dereferencer resolves one target once, however its pointer is spelled', () => {
  it('shares one object for every spelling of a pointer', async () => {
    const spellings = ['#/components/schemas/Big', '#//components/schemas/Big', '#/components//schemas/Big/', '#components/schemas/Big'];
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      components: {
        schemas: { Big: objectSchema(10) },
        'x-unused': Object.fromEntries(spellings.map((ref, index) => [`s${index}`, { $ref: ref }])),
      },
      paths: {},
    });
    await generator.generateTools();
    const unused = (generator.getDocument().components as Record<string, Record<string, unknown>>)['x-unused'];
    expect(new Set(Object.values(unused)).size).toBe(1);
  });

  it('stays small for thousands of spellings', async () => {
    const spellings = Array.from({ length: 2000 }, (_, index) => `#${'/'.repeat(1 + (index % 40))}components${'/'.repeat(1 + Math.floor(index / 40))}schemas/Big`);
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      components: {
        schemas: { Big: objectSchema(5000) },
        'x-unused': Object.fromEntries(spellings.map((ref, index) => [`s${index}`, { $ref: ref }])),
      },
      paths: {},
    });
    const started = Date.now();
    await generator.generateTools();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('a retrieval URI longer than the limit', () => {
  function deepDocument(depth: number, width: number): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    let current = root;
    for (let level = 0; level < depth; level++) {
      const next: Record<string, unknown> = {};
      current['a'] = next;
      current = next;
    }
    for (let index = 0; index < width; index++) current[`k${index}`] = 1;
    return { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {}, 'x-data': root };
  }

  const longDirectory = path.join(os.tmpdir(), `long-uri-${process.pid}`, ...Array.from({ length: 4 }, (_, index) => `${index}${' '.repeat(190)}`));

  async function loadFromLongPath(document: Record<string, unknown>): Promise<OpenAPIToolGenerator> {
    fs.mkdirSync(longDirectory, { recursive: true });
    const file = path.join(longDirectory, 'openapi.json');
    fs.writeFileSync(file, JSON.stringify(document));
    return OpenAPIToolGenerator.fromFile(file);
  }

  afterAll(() => {
    fs.rmSync(path.join(os.tmpdir(), `long-uri-${process.pid}`), { recursive: true, force: true });
  });

  it('is searched for relative references in linear time', async () => {
    const generator = await loadFromLongPath(deepDocument(2000, 50000));
    expect(generator.getDiagnostics().map((diagnostic) => diagnostic.code)).toContain('BASE_URI_TOO_LONG');
    const started = Date.now();
    await generator.generateTools();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('still reports where a relative reference is', async () => {
    const document = deepDocument(3, 1);
    ((document['x-data'] as Record<string, Record<string, unknown>>)['a'] as Record<string, unknown>)['ref'] = {
      $ref: 'other.json',
    };
    const generator = await loadFromLongPath(document);
    const failure = await generator.generateTools().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ParseError);
    expect((failure as ParseError).context).toMatchObject({ rule: 'base-too-long', path: '/x-data/a/ref' });
  });

  it('a documentUri that becomes longer than the limit once parsed is refused', async () => {
    const document = { openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} };
    const documentUri = `https://example.com/openapi.yaml?${"'".repeat(2000)}`;
    await expect(OpenAPIToolGenerator.fromJSON(document, { documentUri })).rejects.toThrow(/at most 2048 characters/);
  });
});

describe('an operation that cannot become a tool leaves a diagnostic', () => {
  const document = (operation: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: { '/p': { get: { operationId: 'p', responses: ok, ...operation } } },
    ...extra,
  });

  it('records TOOL_GENERATION_FAILED for a tool that fails to build', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document({ operationId: {} }), { validate: false });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(generator.generateTools()).resolves.toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(generator.getDiagnostics()).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'TOOL_GENERATION_FAILED', path: '/paths/~1p/get' })]),
    );
  });

  it('a tags value that is not a list never aborts the whole run', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: { '/a': { get: { operationId: 'a', tags: 'x', responses: ok } }, '/b': { get: { operationId: 'b', tags: ['x'], responses: ok } } },
    });
    const tools = await generator.generateTools({ includeTags: ['x'] });
    expect(tools.map((tool) => tool.name)).toEqual(['b']);
  });

  it('generateTool throws library errors for a missing operation or document paths', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document({}));
    await expect(generator.generateTool('/nope', 'get')).rejects.toThrow(GenerationError);
    const empty = await OpenAPIToolGenerator.fromJSON({ openapi: '3.0.3', info: { title: 't', version: '1' } }, { validate: false });
    await expect(empty.generateTool('/p', 'get')).rejects.toThrow(GenerationError);
  });

  it.each([
    ['fromJSON(null)', () => OpenAPIToolGenerator.fromJSON(null as never)],
    ['fromYAML("")', () => OpenAPIToolGenerator.fromYAML('')],
    ['fromYAML("~")', () => OpenAPIToolGenerator.fromYAML('~')],
  ])('%s is refused when loaded', async (_label, load) => {
    await expect(load()).rejects.toThrow(ParseError);
  });

  it('an empty file is refused when loaded', async () => {
    const file = path.join(os.tmpdir(), `empty-${process.pid}-${Date.now()}.yaml`);
    fs.writeFileSync(file, '');
    try {
      await expect(OpenAPIToolGenerator.fromFile(file)).rejects.toThrow(LoadError);
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('a reference left unresolved makes no broken tool', () => {
  const external = 'https://elsewhere.example.test/c.yaml';
  const load = (operation: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        servers: [{ url: 'https://api.example.test' }],
        paths: { '/p/{id}': { get: { operationId: 'p', responses: ok, ...operation } } },
        ...extra,
      },
      { secureDefaults: true, validate: false },
    );
  const codes = (generator: OpenAPIToolGenerator) => generator.getDiagnostics().map((diagnostic) => diagnostic.code);

  it.each([
    ['an operation parameter', { parameters: [{ $ref: `${external}#/P` }] }],
    ['a request body', { requestBody: { $ref: `${external}#/B` } }],
  ])('skips the operation when %s is a reference', async (_label, operation) => {
    const generator = await load(operation);
    await expect(generator.generateTools()).resolves.toEqual([]);
    expect(codes(generator)).toContain('UNRESOLVED_REFERENCE');
  });

  it('skips the operation when a path-level parameter is a reference', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: { '/p/{id}': { parameters: [{ $ref: `${external}#/P` }], get: { operationId: 'p', responses: ok } } },
      },
      { secureDefaults: true, validate: false },
    );
    await expect(generator.generateTools()).resolves.toEqual([]);
    expect(codes(generator)).toContain('UNRESOLVED_REFERENCE');
  });

  it('reports a response that is a reference and keeps the tool', async () => {
    const generator = await load({ responses: { 200: { $ref: `${external}#/R` } } });
    const tools = await generator.generateTools();
    expect(tools).toHaveLength(1);
    expect(codes(generator)).toContain('UNRESOLVED_REFERENCE');
  });

  it('a security scheme that is a reference cannot satisfy a requirement', async () => {
    const generator = await load(
      { security: [{ refd: [] }] },
      { components: { securitySchemes: { refd: { $ref: `${external}#/S` } } } },
    );
    await expect(generator.generateTools()).resolves.toEqual([]);
    expect(codes(generator)).toEqual(expect.arrayContaining(['UNRESOLVED_SECURITY_SCHEME', 'UNSATISFIABLE_SECURITY']));
  });
});
