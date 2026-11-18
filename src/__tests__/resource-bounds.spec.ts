import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ParseError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import { emitToolTypeScript } from '../type-signature';

const ok = { 200: { description: 'ok' } };
const info = { title: 't', version: '1' };

function documentReferencing(ref: string): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info,
    paths: {
      '/p': {
        get: {
          operationId: 'p',
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } } },
        },
      },
    },
  };
}

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

posixOnly('a file reference reads only a regular file of bounded size', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'file-refs-'));
  const files = { refResolution: { allowedProtocols: ['file'] }, timeout: 2000 };

  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function failureOf(ref: string): Promise<ParseError> {
    const generator = await OpenAPIToolGenerator.fromJSON(documentReferencing(ref), files);
    const started = Date.now();
    const failure = (await generator.generateTools().catch((error: unknown) => error)) as ParseError;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(failure).toBeInstanceOf(ParseError);
    return failure;
  }

  it.each(['file:///dev/zero', '/dev/zero'])('refuses a device (%s)', async (ref) => {
    expect((await failureOf(ref)).context).toMatchObject({ rule: 'file-error' });
    expect((await failureOf(ref)).message).toContain('not a regular file');
  });

  it('refuses a named pipe without waiting for a writer', async () => {
    const pipe = path.join(directory, 'pipe.json');
    execFileSync('mkfifo', [pipe]);
    expect((await failureOf(pipe)).context).toMatchObject({ rule: 'file-error' });
  });

  it('refuses a file larger than 10 MiB before reading it', async () => {
    const large = path.join(directory, 'large.json');
    fs.writeFileSync(large, '');
    fs.truncateSync(large, 20 * 1024 * 1024);
    expect((await failureOf(large)).context).toMatchObject({ rule: 'too-large' });
  });

  it('stops reading a file that holds more than its size said', async () => {
    const large = path.join(directory, 'grown.json');
    fs.writeFileSync(large, '');
    fs.truncateSync(large, 11 * 1024 * 1024);
    const open = fs.promises.open;
    const opened = jest.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      return Object.assign(handle, { stat: async () => Object.assign(await stat(), { size: 0 }) });
    });
    try {
      expect((await failureOf(large)).context).toMatchObject({ rule: 'too-large' });
    } finally {
      opened.mockRestore();
    }
  });

  it('refuses a file URL that names a host', async () => {
    expect((await failureOf('file://server.example/share/a.json')).context).toMatchObject({ rule: 'file-error' });
  });

  it('reports a file that does not exist by its error code', async () => {
    expect((await failureOf(path.join(directory, 'missing.json'))).message).toContain(
      'the file cannot be read (ENOENT)',
    );
  });

  it('describes a path that cannot be decoded by its error', async () => {
    const failure = await failureOf(path.join(directory, 'bad%E0%A4.json'));
    expect(failure.context).toMatchObject({ rule: 'file-error' });
    expect(failure.message).toContain('URI malformed');
  });

  it('still reads a regular file, its name percent-encoded or not', async () => {
    const named = path.join(directory, 'pet 1.json');
    fs.writeFileSync(named, JSON.stringify({ type: 'object', properties: { name: { type: 'string' } } }));
    for (const ref of [named, `file://${encodeURI(named)}`]) {
      const generator = await OpenAPIToolGenerator.fromJSON(documentReferencing(ref), files);
      const [tool] = await generator.generateTools();
      expect(tool.outputSchema).toMatchObject({ properties: { name: { type: 'string' } } });
    }
  });
});

describe('a type list renders each kind of type once', () => {
  function nested(type: string[], depth: number): Record<string, unknown> {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let level = 0; level < depth; level++) schema = { type, properties: { a: schema } };
    return schema;
  }

  it.each([
    ['one name repeated', Array.from({ length: 40 }, () => 'object')],
    ['names it does not know', ['object', ...Array.from({ length: 39 }, (_, index) => `x${index}`)]],
  ])('%s, nine levels deep', (_label, type) => {
    const started = Date.now();
    const rendered = emitToolTypeScript('deep', undefined, nested(type, 9) as never, undefined, { maxDepth: 20 });
    expect(Date.now() - started).toBeLessThan(200);
    expect(rendered.signature).toContain('a?: string');
  });

  it('keeps a union of different kinds', () => {
    const rendered = emitToolTypeScript(
      'nullable',
      undefined,
      { type: 'object', properties: { a: { type: ['string', 'null', 'string'] } } } as never,
      undefined,
    );
    expect(rendered.signature).toContain('a?: string | null');
  });
});

describe('validate() and lint() work once per parameter of a path item', () => {
  function pathLevelTimesOperations(count: number, operationParameter?: Record<string, unknown>) {
    const pathItem: Record<string, unknown> = {
      parameters: Array.from({ length: count }, (_, index) => ({
        name: `p${index}`,
        in: 'query',
        schema: { type: 'string' },
      })),
      additionalOperations: Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `M${index}`,
          { operationId: `o${index}`, responses: ok, ...(operationParameter && { parameters: [operationParameter] }) },
        ]),
      ),
    };
    return { openapi: '3.2.0', info, servers: [{ url: 'https://api.example.test' }], paths: { '/x': pathItem } };
  }

  it.each([
    ['no parameters of their own', undefined],
    ['one query parameter each', { name: 'own', in: 'query', schema: { type: 'string' } }],
    ['one overriding parameter each', { name: 'p0', in: 'query', schema: { type: 'integer' } }],
  ])('validates 4,000 operations of a path item with 4,000 parameters, %s', async (_label, parameter) => {
    const generator = await OpenAPIToolGenerator.fromJSON(pathLevelTimesOperations(4000, parameter));
    const started = Date.now();
    const result = await generator.validate();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.valid).toBe(true);
  });

  const querystring = { name: 'q', in: 'querystring', content: { 'application/json': { schema: { type: 'object' } } } };
  const pathWithQuerystring = (operationParameters: unknown[]) => ({
    openapi: '3.2.0',
    info,
    paths: {
      '/x': { parameters: [querystring], get: { operationId: 'g', parameters: operationParameters, responses: ok } },
    },
  });

  it.each([
    [
      'a query parameter next to a path-level querystring',
      [{ name: 'a', in: 'query', schema: {} }],
      'QUERYSTRING_WITH_QUERY_PARAMETERS',
    ],
    ['a second querystring', [{ ...querystring, name: 'r' }], 'MULTIPLE_QUERYSTRING_PARAMETERS'],
  ])('still refuses %s', async (_label, parameters, code) => {
    const result = await (await OpenAPIToolGenerator.fromJSON(pathWithQuerystring(parameters))).validate();
    expect(result.errors?.map((error) => error.code)).toEqual([code]);
  });

  it('counts a querystring the operation overrides once', async () => {
    const result = await (await OpenAPIToolGenerator.fromJSON(pathWithQuerystring([querystring]))).validate();
    expect(result.valid).toBe(true);
  });

  it('still finds a path parameter defined at either level, or missing', async () => {
    const document = {
      openapi: '3.0.3',
      info,
      paths: {
        '/a/{x}/{y}': {
          parameters: [{ name: 'x', in: 'path', required: true, schema: {} }],
          get: { operationId: 'g', parameters: [{ name: 'y', in: 'path', required: true, schema: {} }], responses: ok },
          put: { operationId: 'u', responses: ok },
        },
      },
    };
    const result = await (await OpenAPIToolGenerator.fromJSON(document)).validate();
    expect(result.errors?.map((error) => [error.code, error.path])).toEqual([
      ['MISSING_PATH_PARAMETER', '/paths//a/{x}/{y}/put/parameters'],
    ]);
  });

  it('lints operations shared by many paths once, with bounded messages', async () => {
    const pathItem: Record<string, unknown> = {
      parameters: Array.from({ length: 2000 }, (_, index) => ({ name: `q${index}`, in: 'query', schema: {} })),
    };
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      pathItem[method] = { responses: ok };
    }
    const paths = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [`/p${index}`, { $ref: '#/components/pathItems/P' }]),
    );
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.1.0',
      info,
      paths,
      components: { pathItems: { P: pathItem } },
    });
    const started = Date.now();
    const { findings } = await generator.lint();
    expect(Date.now() - started).toBeLessThan(1000);
    const undescribed = findings.find((finding) => finding.code === 'missing-parameter-description')!;
    expect(undescribed.message).toMatch(/^Parameter\(s\) without description: q0, q1, .*, q9 and 1990 more\.$/);
  });
});

describe('validation findings stay small for a long additional method', () => {
  const method = 'M'.repeat(100_000);
  const document = {
    openapi: '3.2.0',
    info,
    paths: { '/x': { additionalOperations: { [method]: { parameters: Array.from({ length: 1000 }, () => ({})) } } } },
  };

  it('cuts the method in every path, in validate() and in the ParseError of generation', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document);
    const result = await generator.validate();
    const failure = (await generator.generateTools().catch((error: unknown) => error)) as ParseError;
    const findings = [...(result.errors ?? []), ...(result.warnings ?? []), ...(failure.context?.errors as [])];
    expect(findings.length).toBeGreaterThan(1000);
    for (const finding of findings as Array<{ path?: string; message: string }>) {
      expect((finding.path ?? '').length).toBeLessThanOrEqual(2200);
      expect(finding.message.length).toBeLessThanOrEqual(2200);
    }
    expect(JSON.stringify(result).length).toBeLessThan(5_000_000);
  });
});
