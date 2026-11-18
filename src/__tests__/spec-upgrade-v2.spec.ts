/**
 * Tests for the Swagger 2.0 to OpenAPI 3.0 converter (`upgradeSwagger2`):
 * every conversion rule, its diagnostics, memoisation, purity, and hostile or
 * malformed input. Specs are inline.
 */

import {
  MAX_CONVERSION_ENTRIES,
  MAX_MEDIA_TYPES_PER_LIST,
  POINTER_TRUNCATION_MARKER,
  SPEC_DIAGNOSTIC_CODES,
  UPGRADED_OPENAPI_VERSION,
  parameterNameNotStringDiagnostic,
  readSwagger2BasePath,
  upgradeSwagger2,
  type SpecDiagnostic,
  type UpgradeSwagger2Result,
} from '../spec';

/* eslint-disable @typescript-eslint/no-explicit-any */

const C = SPEC_DIAGNOSTIC_CODES;

/** A minimal valid Swagger 2.0 document with a host and a scheme, so no server diagnostic. */
const swagger = (extra: Record<string, unknown> = {}): any => ({
  swagger: '2.0',
  info: { title: 'T', version: '1' },
  host: 'api.example.com',
  schemes: ['https'],
  paths: {},
  ...extra,
});

/** A Response Object for `responses`. */
const ok = { description: 'ok' };

/** An operation with a 200 response, plus `extra`. */
const operation = (extra: Record<string, unknown> = {}): any => ({ responses: { 200: ok }, ...extra });

/** A document whose one operation is POST /x. */
const withOperation = (op: Record<string, unknown>, root: Record<string, unknown> = {}): any =>
  swagger({ paths: { '/x': { post: op } }, ...root });

const run = (document: unknown, options?: { documentUri?: string }): UpgradeSwagger2Result & { doc: any } => {
  const result = upgradeSwagger2(document, options);
  return { ...result, doc: result.document as any };
};

const codes = (diagnostics: readonly SpecDiagnostic[]): string[] => diagnostics.map((d) => d.code);
const withoutInfo = (diagnostics: readonly SpecDiagnostic[]): SpecDiagnostic[] =>
  diagnostics.filter((d) => d.severity !== 'info');
const postOf = (result: { doc: any }): any => result.doc.paths['/x'].post;

/** Freezes `value` and everything it holds, so a mutation throws (test files are strict mode). */
function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) stack.push((node as Record<string, unknown>)[key]);
  }
  return value;
}

describe('upgradeSwagger2: a whole document', () => {
  const pet = {
    type: 'object',
    required: ['name'],
    properties: { id: { type: 'integer', format: 'int64' }, name: { type: 'string' } },
  };
  const error = { type: 'object', properties: { message: { type: 'string' } } };
  const limit = {
    name: 'limit',
    in: 'query',
    description: 'How many',
    required: false,
    type: 'integer',
    format: 'int32',
    maximum: 100,
  };
  const notFound = { description: 'Not found', schema: error };
  const petstore = (): any => ({
    swagger: '2.0',
    info: { title: 'Petstore', version: '1.0.0' },
    host: 'petstore.example.com',
    basePath: '/v1',
    schemes: ['https', 'http'],
    consumes: ['application/json'],
    produces: ['application/json'],
    paths: {
      '/pets': {
        get: {
          operationId: 'listPets',
          tags: ['pets'],
          parameters: [limit],
          responses: {
            200: {
              description: 'A list',
              schema: { type: 'array', items: pet },
              headers: { 'x-next': { type: 'string', description: 'Next page' } },
            },
            default: notFound,
          },
        },
        post: {
          operationId: 'createPet',
          parameters: [{ name: 'pet', in: 'body', required: true, schema: pet }],
          responses: { 201: { description: 'Created' } },
        },
      },
      '/pets/{petId}': {
        parameters: [{ name: 'petId', in: 'path', required: true, type: 'string' }],
        get: { operationId: 'showPet', responses: { 200: { description: 'A pet', schema: pet }, 404: notFound } },
      },
    },
    definitions: { Pet: pet, Error: error },
    parameters: { limit },
    responses: { NotFound: notFound },
    securityDefinitions: { key: { type: 'apiKey', name: 'X-Key', in: 'header' } },
    security: [{ key: [] }],
    tags: [{ name: 'pets' }],
    externalDocs: { url: 'https://docs.example.com' },
    'x-logo': { url: 'logo.png' },
  });

  it('converts every part to OpenAPI 3.0.3, with no diagnostic', () => {
    const source = petstore();
    const { doc, diagnostics } = run(source);
    const json = (schema: unknown) => ({ 'application/json': { schema } });
    const notFoundResponse = { description: 'Not found', content: json(error) };
    const limitParameter = {
      name: 'limit',
      in: 'query',
      description: 'How many',
      required: false,
      schema: { type: 'integer', format: 'int32', maximum: 100 },
    };

    expect(diagnostics).toEqual([]);
    expect(UPGRADED_OPENAPI_VERSION).toBe('3.0.3');
    expect(doc).toEqual({
      openapi: '3.0.3',
      info: { title: 'Petstore', version: '1.0.0' },
      servers: [{ url: 'https://petstore.example.com/v1' }, { url: 'http://petstore.example.com/v1' }],
      paths: {
        '/pets': {
          get: {
            tags: ['pets'],
            operationId: 'listPets',
            parameters: [limitParameter],
            responses: {
              200: {
                description: 'A list',
                headers: { 'x-next': { description: 'Next page', schema: { type: 'string' } } },
                content: json({ type: 'array', items: pet }),
              },
              default: notFoundResponse,
            },
          },
          post: {
            operationId: 'createPet',
            requestBody: { content: json(pet), required: true },
            responses: { 201: { description: 'Created' } },
          },
        },
        '/pets/{petId}': {
          get: {
            operationId: 'showPet',
            responses: { 200: { description: 'A pet', content: json(pet) }, 404: notFoundResponse },
          },
          parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
      components: {
        schemas: { Pet: pet, Error: error },
        responses: { NotFound: notFoundResponse },
        parameters: { limit: limitParameter },
        securitySchemes: { key: { type: 'apiKey', name: 'X-Key', in: 'header' } },
      },
      security: [{ key: [] }],
      tags: [{ name: 'pets' }],
      externalDocs: { url: 'https://docs.example.com' },
      'x-logo': { url: 'logo.png' },
    });
  });

  it('attaches schemas, info, tags, security and extensions by reference, and shares converted objects', () => {
    const source = petstore();
    const { doc } = run(source);
    const listPets = doc.paths['/pets'].get;

    expect(doc.info).toBe(source.info);
    expect(doc.tags).toBe(source.tags);
    expect(doc.security).toBe(source.security);
    expect(doc.externalDocs).toBe(source.externalDocs);
    expect(doc['x-logo']).toBe(source['x-logo']);
    expect(doc.components.schemas.Pet).toBe(pet);
    expect(doc.paths['/pets'].post.requestBody.content['application/json'].schema).toBe(pet);
    expect(listPets.responses[200].content['application/json'].schema).toBe(
      source.paths['/pets'].get.responses[200].schema,
    );
    // One conversion per shared source object
    expect(listPets.parameters[0]).toBe(doc.components.parameters.limit);
    expect(listPets.responses.default).toBe(doc.components.responses.NotFound);
    expect(doc.paths['/pets/{petId}'].get.responses[404]).toBe(doc.components.responses.NotFound);
  });

  it('never mutates its input, deep-frozen or not', () => {
    const source = petstore();
    const before = JSON.stringify(source);

    expect(() => run(deepFreeze(source))).not.toThrow();
    expect(JSON.stringify(source)).toBe(before);
  });

  it('builds new objects for every converted container', () => {
    const source = petstore();
    const { doc } = run(source);

    expect(doc.paths).not.toBe(source.paths);
    expect(doc.paths['/pets']).not.toBe(source.paths['/pets']);
    expect(doc.paths['/pets'].get).not.toBe(source.paths['/pets'].get);
    expect(doc.paths['/pets'].get.parameters[0]).not.toBe(limit);
    expect(doc.paths['/pets'].get.responses).not.toBe(source.paths['/pets'].get.responses);
    expect(doc.components.securitySchemes.key).not.toBe(source.securityDefinitions.key);
  });

  it('does not depend on the order of an object’s fields', () => {
    const reverse = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverse);
      if (typeof value !== 'object' || value === null) return value;
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, inner]) => [key, reverse(inner)]),
      );
    };
    const fixedFieldsOnly = (value: any): any => {
      // Map keys (paths, responses, properties) keep their order; fixed fields are reversed
      const copy = reverse(value) as any;
      copy.paths = Object.fromEntries(Object.entries(copy.paths).reverse());
      return copy;
    };

    expect(run(fixedFieldsOnly(petstore())).doc).toEqual(run(petstore()).doc);
  });
});

describe('upgradeSwagger2: the document itself', () => {
  it.each([null, undefined, 'swagger', 42, true, [], [swagger()]])('returns an empty document for %p', (value) => {
    const { doc, diagnostics } = run(value);

    expect(doc).toEqual({ openapi: '3.0.3', paths: {} });
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_INVALID_VALUE,
        message: expect.stringContaining('must be an object'),
        path: '',
      },
    ]);
  });

  it.each([
    [{ swagger: '1.2' }, 'found "1.2")'],
    [{ swagger: undefined }, 'found undefined)'],
    [{ swagger: '2.0', openapi: '3.0.0' }, 'found "2.0" and an `openapi` field)'],
  ])('converts a document that does not declare Swagger 2.0 anyway, with a warning: %p', (fields, found) => {
    const { doc, diagnostics } = run(swagger(fields));

    expect(doc.openapi).toBe('3.0.3');
    expect(diagnostics[0]).toEqual({
      severity: 'warning',
      code: C.SWAGGER_VERSION_NOT_2_0,
      message: expect.stringContaining(found),
      path: '/swagger',
    });
  });

  it('accepts the number 2 that YAML reads an unquoted 2.0 as', () => {
    expect(run(swagger({ swagger: 2 })).diagnostics).toEqual([]);
  });

  it('reports root fields Swagger 2.0 does not define, naming at most three', () => {
    const one = run(swagger({ servers: [] })).diagnostics;
    const many = run(
      swagger({ servers: [], components: {}, webhooks: {}, jsonSchemaDialect: 'x', 'x-ok': 1 }),
    ).diagnostics;

    expect(one).toEqual([
      {
        severity: 'info',
        code: C.SWAGGER_UNKNOWN_FIELD,
        message: 'The Swagger Object has a field Swagger 2.0 does not define there ("servers"); it is not converted',
        path: '',
      },
    ]);
    expect(many[0].message).toBe(
      'The Swagger Object has 4 fields Swagger 2.0 does not define there ("servers", "components", "webhooks" and 1 more); they are not converted',
    );
  });

  it('omits info when absent and components when nothing goes there', () => {
    const { info: _info, ...rest } = swagger();
    const { doc } = run(rest);

    expect('info' in doc).toBe(false);
    expect('components' in doc).toBe(false);
    expect(doc.paths).toEqual({});
  });

  it('cuts and escapes hostile text in messages', () => {
    const { diagnostics } = run(swagger({ host: `\u001b[2J${'h'.repeat(100_000)}/` }));

    expect(diagnostics[0].message.length).toBeLessThan(400);
    expect(diagnostics[0].message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe('upgradeSwagger2: servers', () => {
  const urls = (result: { doc: any }): string[] => result.doc.servers.map((server: any) => server.url);

  it.each<[string, Record<string, unknown>, string | undefined, string[], string[]]>([
    [
      'host, basePath and schemes',
      { host: 'h.io', basePath: '/v1', schemes: ['http', 'https'] },
      undefined,
      ['http://h.io/v1', 'https://h.io/v1'],
      [],
    ],
    [
      'ws schemes: no server, https assumed',
      { host: 'h.io:8443', schemes: ['wss', 'ws'] },
      undefined,
      ['https://h.io:8443'],
      [C.SWAGGER_NOT_CONVERTED, C.SWAGGER_ASSUMED_SCHEME],
    ],
    [
      'http schemes only, in the order written, before or after ws',
      { host: 'h.io', schemes: ['wss', 'http', 'ws', 'https'] },
      undefined,
      ['http://h.io', 'https://h.io'],
      [C.SWAGGER_NOT_CONVERTED],
    ],
    ['schemes in any case', { host: 'h.io', schemes: ['HTTP', 'Https', 'http'] }, undefined, ['http://h.io', 'https://h.io'], []],
    ['duplicate schemes once', { host: 'h.io', schemes: ['https', 'https'] }, undefined, ['https://h.io'], []],
    ['basePath "/" as no path', { host: 'h.io', basePath: '/', schemes: ['https'] }, undefined, ['https://h.io'], []],
    [
      'trailing slashes trimmed',
      { host: 'h.io', basePath: '/v1//', schemes: ['https'] },
      undefined,
      ['https://h.io/v1'],
      [],
    ],
    [
      'no schemes: the document URI scheme',
      { host: 'h.io', schemes: undefined },
      'http://docs.io/spec.json',
      ['http://h.io'],
      [],
    ],
    [
      'no schemes, no document URI: https',
      { host: 'h.io', schemes: undefined },
      undefined,
      ['https://h.io'],
      [C.SWAGGER_ASSUMED_SCHEME],
    ],
    [
      'no schemes, a file document URI: https',
      { host: 'h.io', schemes: undefined },
      'file:///tmp/spec.json',
      ['https://h.io'],
      [C.SWAGGER_ASSUMED_SCHEME],
    ],
    ['empty schemes: as absent', { host: 'h.io', schemes: [] }, 'http://docs.io', ['http://h.io'], []],
    [
      'no schemes, a ws document URI: its host, https assumed',
      { host: undefined, schemes: undefined },
      'wss://docs.io',
      ['https://docs.io'],
      [C.SWAGGER_ASSUMED_SCHEME],
    ],
    [
      'no host: the document host, with its port, without user information',
      { host: undefined, basePath: '/api', schemes: undefined },
      'https://user:secret@docs.io:8080/a/b.json?q#f',
      ['https://docs.io:8080/api'],
      [],
    ],
    [
      'no host: the document host with the declared schemes',
      { host: undefined, schemes: ['http'] },
      'HTTPS://docs.io',
      ['http://docs.io'],
      [],
    ],
    [
      'no host: an IPv6 document host',
      { host: undefined, schemes: undefined },
      'http://[::1]:3000/spec',
      ['http://[::1]:3000'],
      [],
    ],
    [
      'no host, no document URI: relative',
      { host: undefined, basePath: '/api', schemes: undefined },
      undefined,
      ['/api'],
      [C.SWAGGER_RELATIVE_SERVER_URL],
    ],
    [
      'no host, no basePath: "/"',
      { host: undefined, schemes: undefined },
      undefined,
      ['/'],
      [C.SWAGGER_RELATIVE_SERVER_URL],
    ],
    [
      'no host, a document URI without a host',
      { host: undefined, schemes: undefined },
      'http://exa mple.com/',
      ['/'],
      [C.SWAGGER_RELATIVE_SERVER_URL],
    ],
    [
      'no host, a relative document URI',
      { host: undefined, schemes: undefined },
      './spec.json',
      ['/'],
      [C.SWAGGER_RELATIVE_SERVER_URL],
    ],
  ])('%s', (_label, fields, documentUri, expected, expectedCodes) => {
    const result = run(swagger(fields), { documentUri });

    expect(urls(result)).toEqual(expected);
    expect(codes(result.diagnostics)).toEqual(expectedCodes);
  });

  it('says that schemes cannot apply to a relative server URL', () => {
    const { diagnostics } = run(swagger({ host: undefined, schemes: ['http'] }));

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_RELATIVE_SERVER_URL,
        message:
          'The document has no usable `host` and no web document URI was given, so the server URL is "/", relative to wherever the document is served from; `schemes` cannot apply without a host and is ignored',
        path: '/host',
      },
    ]);
  });

  it.each([
    ['https://h.io', '/host'],
    ['h.io/v1', '/host'],
    ['user@h.io', '/host'],
    ['h.io?x', '/host'],
    ['h io', '/host'],
    ['h.io:port', '/host'],
    ['{tenant}.h.io', '/host'],
    [42, '/host'],
  ])('ignores the host %p', (host, path) => {
    const result = run(swagger({ host }));

    expect(urls(result)).toEqual(['/']);
    expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_INVALID_VALUE, path],
      [C.SWAGGER_RELATIVE_SERVER_URL, '/host'],
    ]);
  });

  it.each(['/v1?x=1', '/v1#f', '/{version}', '/a}', '/a b', '/a\\b', '/a\tb', 7, null, '/a/../b', '/./a', '/a/%2E%2e', '..'])(
    'ignores the basePath %p',
    (basePath) => {
      const result = run(swagger({ basePath }));

      expect(urls(result)).toEqual(['https://api.example.com']);
      expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([[C.SWAGGER_INVALID_VALUE, '/basePath']]);
      expect(result.diagnostics[0].message).toMatch(/^`basePath` cannot be used: it .*; it is ignored$/);
    },
  );

  it.each([
    ['v1', 'https://api.example.com/v1', '"/v1"'],
    ['api/v1/', 'https://api.example.com/api/v1', '"/api/v1"'],
    ['', 'https://api.example.com', '"/"'],
  ])('prepends "/" to the basePath %p', (basePath, url, used) => {
    const result = run(swagger({ basePath }));

    expect(urls(result)).toEqual([url]);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_INVALID_VALUE,
        message: `\`basePath\` must start with "/", found ${JSON.stringify(basePath)}; ${used} is used`,
        path: '/basePath',
      },
    ]);
  });

  it('reads a basePath with readSwagger2BasePath, which the validator shares', () => {
    expect(readSwagger2BasePath('/api/v1/')).toEqual({ kind: 'usable', path: '/api/v1' });
    expect(readSwagger2BasePath('/')).toEqual({ kind: 'usable', path: '' });
    expect(readSwagger2BasePath('api')).toEqual({ kind: 'missing-slash', path: '/api' });
    expect(readSwagger2BasePath('/a..b/.c/%2Ed')).toEqual({ kind: 'usable', path: '/a..b/.c/%2Ed' });
    expect(readSwagger2BasePath('/{v}')).toEqual({
      kind: 'unusable',
      problem: 'it holds "{", which a server URL path cannot carry (a template, whitespace, a query, a fragment or a backslash)',
    });
    expect(readSwagger2BasePath(['/a'])).toEqual({ kind: 'unusable', problem: 'it must be a string, found an array' });
    expect(readSwagger2BasePath('/a/%2e')).toEqual({
      kind: 'unusable',
      problem: 'it has a "." or ".." segment, which a URL parser removes',
    });
  });

  it('trims a long run of trailing slashes in linear time', () => {
    const started = Date.now();
    const result = run(swagger({ basePath: `/${'/'.repeat(200_000)}x${'/'.repeat(200_000)}` }));

    expect(urls(result)[0].endsWith('/x')).toBe(true);
    // A hang backstop only (tens of ms, instrumented for coverage): a trim that rescans the run from each slash, as a
    // backtracking `/\/+$/` does, takes minutes here
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('keeps the valid schemes in any case, and reports the others in one diagnostic and ws in another', () => {
    const result = run(swagger({ schemes: ['https', 'ftp', 3, 'HTTP', null, 'ws', 'mailto', 'WSS'] }));

    expect(urls(result)).toEqual(['https://api.example.com', 'http://api.example.com']);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_INVALID_VALUE,
        message: '`schemes` may only hold "http", "https", "ws" and "wss"; "ftp", 3, null and 1 more are ignored',
        path: '/schemes',
      },
      {
        severity: 'warning',
        code: C.SWAGGER_NOT_CONVERTED,
        message:
          '`schemes` lists "ws", "wss" (WebSocket), which an HTTP operation is never sent over; no server is made for them',
        path: '/schemes',
      },
    ]);
    expect(run(swagger({ schemes: ['ftp'] })).diagnostics[0].message).toContain('"ftp" is ignored');
  });

  it('reports ws schemes once for the document, with the places', () => {
    const result = run(
      swagger({
        schemes: ['https', 'wss'],
        paths: { '/a': { get: operation({ schemes: ['ws'] }) }, '/b': { get: operation({ schemes: ['wss', 'http'] }) } },
      }),
    );

    expect(result.doc.paths['/a'].get.servers).toBeUndefined();
    expect(result.doc.paths['/b'].get.servers).toEqual([{ url: 'http://api.example.com' }]);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_NOT_CONVERTED,
        message:
          '`schemes` lists "wss" (WebSocket), which an HTTP operation is never sent over; no server is made for it ' +
          '(in 3 places: /schemes, /paths/~1a/get/schemes, /paths/~1b/get/schemes)',
        path: '/schemes',
      },
    ]);
  });

  it('ignores schemes that are not a list', () => {
    const result = run(swagger({ schemes: 'https' }));

    expect(urls(result)).toEqual(['https://api.example.com']);
    expect(codes(result.diagnostics)).toEqual([C.SWAGGER_INVALID_VALUE, C.SWAGGER_ASSUMED_SCHEME]);
  });

  describe('operation schemes', () => {
    it('become operation servers when they differ from the root', () => {
      const result = run(withOperation(operation({ schemes: ['http'] }), { basePath: '/v1' }));

      expect(postOf(result).servers).toEqual([{ url: 'http://api.example.com/v1' }]);
      expect(result.diagnostics).toEqual([]);
    });

    it('add nothing when they give the root servers', () => {
      expect(postOf(run(withOperation(operation({ schemes: ['https'] })))).servers).toBeUndefined();
      expect(postOf(run(withOperation(operation({ schemes: [] })))).servers).toBeUndefined();
    });

    it('use the document host when the document has none', () => {
      const result = run(withOperation(operation({ schemes: ['http'] }), { host: undefined, schemes: undefined }), {
        documentUri: 'https://docs.io/s.json',
      });

      expect(postOf(result).servers).toEqual([{ url: 'http://docs.io' }]);
    });

    it('cannot apply to a relative server URL', () => {
      const result = run(withOperation(operation({ schemes: ['http'] }), { host: undefined }));

      expect(postOf(result).servers).toBeUndefined();
      expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
        [C.SWAGGER_RELATIVE_SERVER_URL, '/host'],
        [C.SWAGGER_NOT_CONVERTED, '/paths/~1x/post/schemes'],
      ]);
    });

    it('that cannot apply are reported once per document, not once per operation', () => {
      const paths: Record<string, unknown> = {};
      for (let index = 0; index < 50; index++) {
        paths[`/p${index}`] = { get: { schemes: ['https'], responses: { 200: { description: 'ok' } } } };
      }
      const result = run(swagger({ host: undefined, schemes: undefined, paths }));

      expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
        [C.SWAGGER_RELATIVE_SERVER_URL, '/host'],
        [C.SWAGGER_NOT_CONVERTED, '/paths/~1p0/get/schemes'],
      ]);
      expect(result.diagnostics[1].message).toMatch(/here and in every other operation \(reported once\)$/);
      expect(Object.values(result.doc.paths).every((item: any) => item.get.servers === undefined)).toBe(true);
    });

    it('are ignored when not a list', () => {
      const result = run(withOperation(operation({ schemes: 'http' })));

      expect(postOf(result).servers).toBeUndefined();
      expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
        [C.SWAGGER_INVALID_VALUE, '/paths/~1x/post/schemes'],
      ]);
    });
  });
});

describe('upgradeSwagger2: consumes and produces', () => {
  const body = { name: 'b', in: 'body', schema: { type: 'object' } };
  const withSchema = { 200: { description: 'ok', schema: { type: 'string' } } };
  const mediaTypes = (result: { doc: any }) => ({
    request: Object.keys(postOf(result).requestBody.content),
    response: Object.keys(postOf(result).responses[200].content),
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string[], string[]]>([
    [
      'root lists',
      { consumes: ['application/xml'], produces: ['text/plain', 'application/json'] },
      {},
      ['application/xml'],
      ['text/plain', 'application/json'],
    ],
    [
      'operation lists override the root',
      { consumes: ['application/xml'], produces: ['text/plain'] },
      { consumes: ['text/csv'], produces: ['image/png'] },
      ['text/csv'],
      ['image/png'],
    ],
    [
      'operation lists without root lists',
      {},
      { consumes: ['text/csv'], produces: ['image/png'] },
      ['text/csv'],
      ['image/png'],
    ],
    [
      'an empty operation list clears the root one',
      { consumes: ['application/xml'], produces: ['text/plain'] },
      { consumes: [], produces: [] },
      ['application/json'],
      ['application/json'],
    ],
    ['duplicates once', { consumes: ['a/b', 'a/b'], produces: ['c/d', 'c/d', 'e/f'] }, {}, ['a/b'], ['c/d', 'e/f']],
  ])('%s', (_label, root, op, request, response) => {
    const result = run(withOperation(operation({ ...op, parameters: [body], responses: withSchema }), root));

    expect(mediaTypes(result)).toEqual({ request, response });
  });

  it('assumes application/json once per direction, with an info diagnostic', () => {
    const document = swagger({
      paths: {
        '/x': { post: operation({ parameters: [body], responses: withSchema }) },
        '/y': { put: operation({ parameters: [body], responses: withSchema }) },
      },
    });
    const { diagnostics } = run(document);

    expect(diagnostics).toEqual([
      {
        severity: 'info',
        code: C.SWAGGER_ASSUMED_MEDIA_TYPE,
        message:
          'No `consumes` media type applies to this request body; application/json is assumed for it and for every other such body (reported once)',
        path: '/paths/~1x/post',
      },
      {
        severity: 'info',
        code: C.SWAGGER_ASSUMED_MEDIA_TYPE,
        message:
          'No `produces` media type applies to this response body; application/json is assumed for it and for every other such body (reported once)',
        path: '/paths/~1x/post/responses/200',
      },
    ]);
  });

  it('assumes nothing for an operation without a body', () => {
    expect(run(withOperation(operation())).diagnostics).toEqual([]);
  });

  it('drops entries that are not media types, reporting them once per list', () => {
    const consumes = ['application/json', 3, '', '  ', null];
    const document = swagger({
      consumes,
      paths: {
        '/x': { post: operation({ parameters: [body] }) },
        '/y': { post: operation({ parameters: [body] }) },
      },
    });
    const result = run(document);

    expect(Object.keys(result.doc.paths['/y'].post.requestBody.content)).toEqual(['application/json']);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_INVALID_VALUE,
        message: '4 entries of `consumes` are not media types (the first, at index 1, is 3); ignored',
        path: '/consumes',
      },
    ]);
    expect(run(swagger({ produces: [1] })).diagnostics[0].message).toBe(
      'An entry of `produces` is not a media type (the first, at index 0, is 1); ignored',
    );
  });

  it('treats a list of nothing but invalid entries as absent', () => {
    const result = run(withOperation(operation({ parameters: [body] }), { consumes: [7] }));

    expect(Object.keys(postOf(result).requestBody.content)).toEqual(['application/json']);
    expect(codes(result.diagnostics)).toEqual([C.SWAGGER_INVALID_VALUE, C.SWAGGER_ASSUMED_MEDIA_TYPE]);
  });

  it('ignores a list that is not a list: the root one for the default, an operation one for the root one', () => {
    const root = run(withOperation(operation({ parameters: [body] }), { consumes: 'application/xml' }));
    const op = run(withOperation(operation({ parameters: [body], consumes: { a: 1 } }), { consumes: ['text/csv'] }));

    expect(Object.keys(postOf(root).requestBody.content)).toEqual(['application/json']);
    expect(root.diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_INVALID_VALUE, '/consumes'],
      [C.SWAGGER_ASSUMED_MEDIA_TYPE, '/paths/~1x/post'],
    ]);
    expect(Object.keys(postOf(op).requestBody.content)).toEqual(['text/csv']);
    expect(op.diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_INVALID_VALUE, '/paths/~1x/post/consumes'],
    ]);
  });
});

describe('upgradeSwagger2: body parameters', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };

  it('become the request body, one media type entry per consumes value', () => {
    const parameter = { name: 'b', in: 'body', description: 'The thing', required: true, schema, 'x-body': 1 };
    const result = run(
      withOperation(operation({ parameters: [parameter], consumes: ['application/json', 'application/xml'] })),
    );

    expect(postOf(result).requestBody).toEqual({
      description: 'The thing',
      content: { 'application/json': { schema }, 'application/xml': { schema } },
      required: true,
      'x-body': 1,
    });
    expect(postOf(result).requestBody.content['application/xml'].schema).toBe(schema);
    expect(postOf(result).parameters).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  it('converts a shared body once per consumes list', () => {
    const parameter = { name: 'b', in: 'body', schema };
    const xml = ['application/xml'];
    const document = swagger({
      consumes: ['application/json'],
      paths: {
        '/a': { post: operation({ parameters: [parameter] }) },
        '/b': { post: operation({ parameters: [parameter] }) },
        '/c': { post: operation({ parameters: [parameter], consumes: xml }) },
        '/d': { post: operation({ parameters: [parameter], consumes: xml }) },
        '/e': { post: operation({ parameters: [parameter], consumes: ['application/xml'] }) },
      },
    });
    const { doc } = run(document);
    const bodyOf = (path: string) => doc.paths[path].post.requestBody;

    expect(bodyOf('/a')).toBe(bodyOf('/b'));
    expect(bodyOf('/c')).toBe(bodyOf('/d'));
    expect(bodyOf('/c')).not.toBe(bodyOf('/a'));
    // A different array with the same content converts again, to an equal body
    expect(bodyOf('/e')).not.toBe(bodyOf('/c'));
    expect(bodyOf('/e')).toEqual(bodyOf('/c'));
  });

  it.each([undefined, 'object', ['a'], null])('accepts any body when the schema is %p, with a diagnostic', (value) => {
    const result = run(
      withOperation(operation({ parameters: [{ name: 'b', in: 'body', schema: value }] }), { consumes: ['a/b'] }),
    );

    expect(postOf(result).requestBody).toEqual({ content: { 'a/b': { schema: {} } } });
    expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_INVALID_VALUE, '/paths/~1x/post/parameters/0/schema'],
    ]);
  });

  it('reports the missing schema of a shared body parameter once', () => {
    const parameter = { name: 'b', in: 'body' };
    const document = swagger({
      paths: {
        '/x': { post: operation({ parameters: [parameter], consumes: ['a/b'] }) },
        '/y': { post: operation({ parameters: [parameter], consumes: ['c/d'] }) },
      },
    });

    expect(codes(run(document).diagnostics)).toEqual([C.SWAGGER_INVALID_VALUE]);
  });

  it('inherits a path-level body, which an operation-level one of the same name overrides silently', () => {
    const pathBody = { name: 'b', in: 'body', schema: { type: 'string' } };
    const opBody = { name: 'b', in: 'body', schema: { type: 'integer' } };
    const document = swagger({
      consumes: ['a/b'],
      paths: { '/x': { parameters: [pathBody], get: operation(), post: operation({ parameters: [opBody] }) } },
    });
    const { doc, diagnostics } = run(document);

    expect(doc.paths['/x'].get.requestBody.content['a/b'].schema).toBe(pathBody.schema);
    expect(doc.paths['/x'].post.requestBody.content['a/b'].schema).toBe(opBody.schema);
    expect(doc.paths['/x'].parameters).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  it.each<[string, unknown[], unknown[], string]>([
    [
      'two operation-level bodies',
      [],
      [
        { name: 'a', in: 'body', schema: {} },
        { name: 'z', in: 'body', schema: { title: 'z' } },
      ],
      '2',
    ],
    [
      'a path-level body of another name',
      [{ name: 'a', in: 'body', schema: {} }],
      [{ name: 'z', in: 'body', schema: { title: 'z' } }],
      '2',
    ],
    [
      'two path-level bodies',
      [
        { name: 'a', in: 'body', schema: {} },
        { name: 'z', in: 'body', schema: { title: 'z' } },
      ],
      [],
      '2',
    ],
  ])('uses the last body when there are %s', (_label, pathParameters, opParameters, count) => {
    const document = swagger({
      consumes: ['a/b'],
      paths: { '/x': { parameters: pathParameters, post: operation({ parameters: opParameters }) } },
    });
    const result = run(document);

    expect(postOf(result).requestBody.content['a/b'].schema).toEqual({ title: 'z' });
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_MULTIPLE_BODY_PARAMETERS,
        message: `The operation has ${count} \`in: body\` parameters, but a request has one body; "z" is used`,
        // Where the validator reports it
        path: '/paths/~1x/post/parameters',
      },
    ]);
  });

  it('prefers a body to form parameters', () => {
    const result = run(
      withOperation(
        operation({
          parameters: [
            { name: 'f', in: 'formData', type: 'string' },
            { name: 'b', in: 'body', schema: { type: 'string' } },
          ],
        }),
        { consumes: ['a/b'] },
      ),
    );

    expect(postOf(result).requestBody).toEqual({ content: { 'a/b': { schema: { type: 'string' } } } });
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_BODY_AND_FORM_DATA,
        message:
          'The operation has both an `in: body` parameter and 1 `in: formData` parameter, which cannot be sent together; the body parameter "b" is used and the form parameters are ignored',
        path: '/paths/~1x/post/parameters',
      },
    ]);
    const two = run(
      withOperation(
        operation({
          parameters: [
            { name: 'f', in: 'formData', type: 'string' },
            { name: 'g', in: 'formData', type: 'string' },
            { name: 'b', in: 'body', schema: {} },
          ],
        }),
        { consumes: ['a/b'] },
      ),
    );
    expect(two.diagnostics[0].message).toContain('and 2 `in: formData` parameters,');
  });

  it('reports fields a body parameter does not have', () => {
    const result = run(
      withOperation(operation({ parameters: [{ name: 'b', in: 'body', schema: {}, type: 'object' }] }), {
        consumes: ['a/b'],
      }),
    );

    expect(result.diagnostics).toEqual([
      {
        severity: 'info',
        code: C.SWAGGER_UNKNOWN_FIELD,
        message: 'An `in: body` parameter has a field Swagger 2.0 does not define there ("type"); it is not converted',
        path: '/paths/~1x/post/parameters/0',
      },
    ]);
  });
});

describe('upgradeSwagger2: form parameters', () => {
  const form = (extra: Record<string, unknown>): any => ({ in: 'formData', type: 'string', ...extra });
  const bodyOf = (parameters: unknown[], root: Record<string, unknown> = {}, op: Record<string, unknown> = {}) => {
    const result = run(withOperation(operation({ parameters, ...op }), root));
    return { body: postOf(result).requestBody, diagnostics: result.diagnostics };
  };

  it('become an urlencoded object body without consumes', () => {
    const { body, diagnostics } = bodyOf([
      form({ name: 'name', required: true, description: 'Name', 'x-f': 1, maxLength: 5 }),
      form({ name: 'tag' }),
    ]);

    expect(body).toEqual({
      content: {
        'application/x-www-form-urlencoded': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: 5, description: 'Name', 'x-f': 1 },
              tag: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
      required: true,
    });
    expect(diagnostics).toEqual([]);
  });

  it('become a multipart body when a parameter is a file', () => {
    const { body } = bodyOf([form({ name: 'upload', type: 'file', format: 'binary' }), form({ name: 'note' })]);

    expect(body).toEqual({
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: { upload: { type: 'string', format: 'binary' }, note: { type: 'string' } },
          },
        },
      },
    });
  });

  it('use the form media types consumes declares, parameters kept, in its order', () => {
    const { body, diagnostics } = bodyOf([form({ name: 'a' })], {
      consumes: [
        'application/json',
        'multipart/form-data; boundary=x',
        'Application/X-WWW-Form-Urlencoded; charset=utf-8',
      ],
    });

    expect(Object.keys(body.content)).toEqual([
      'multipart/form-data; boundary=x',
      'Application/X-WWW-Form-Urlencoded; charset=utf-8',
    ]);
    expect(body.content['multipart/form-data; boundary=x'].schema).toBe(
      body.content['Application/X-WWW-Form-Urlencoded; charset=utf-8'].schema,
    );
    expect(diagnostics).toEqual([]);
  });

  it('send a file in multipart/form-data only, which the urlencoded form cannot carry', () => {
    const urlencoded = bodyOf([form({ name: 'f', type: 'file' })], { consumes: ['application/x-www-form-urlencoded'] });

    expect(Object.keys(urlencoded.body.content)).toEqual(['multipart/form-data']);
    expect(urlencoded.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_FORM_MEDIA_TYPE_ADDED,
        message:
          'The operation has a `type: file` parameter, which application/x-www-form-urlencoded cannot carry, and its ' +
          '`consumes` names no multipart/form-data; the form body is multipart/form-data',
        path: '/paths/~1x/post',
      },
    ]);
    // Both declared: the multipart ones alone, whatever the order
    const both = bodyOf([form({ name: 'f', type: 'file' })], {
      consumes: ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'multipart/form-data'],
    });
    expect(Object.keys(both.body.content)).toEqual(['multipart/form-data; boundary=x', 'multipart/form-data']);
    expect(both.diagnostics).toEqual([]);
  });

  it('choose the form media types per operation, whether it has a file or not', () => {
    const document = swagger({
      consumes: ['application/x-www-form-urlencoded', 'multipart/form-data'],
      paths: {
        '/a': { post: operation({ parameters: [form({ name: 'cover', type: 'file' }), form({ name: 'caption' })] }) },
        '/b': { post: operation({ parameters: [form({ name: 'caption' })] }) },
        '/c': { post: operation({ parameters: [form({ name: 'photo', type: 'file' })] }) },
      },
    });
    const { doc } = run(document);
    const mediaTypes = (path: string) => Object.keys(doc.paths[path].post.requestBody.content);

    expect(mediaTypes('/a')).toEqual(['multipart/form-data']);
    expect(mediaTypes('/b')).toEqual(['application/x-www-form-urlencoded', 'multipart/form-data']);
    expect(mediaTypes('/c')).toEqual(['multipart/form-data']);
  });

  it.each<[boolean, string]>([
    [false, 'application/x-www-form-urlencoded'],
    [true, 'multipart/form-data'],
  ])('add a form media type when consumes names none (file: %p)', (file, mediaType) => {
    const { body, diagnostics } = bodyOf([form({ name: 'a', type: file ? 'file' : 'string' })], {
      consumes: ['application/json'],
    });

    expect(Object.keys(body.content)).toEqual([mediaType]);
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_FORM_MEDIA_TYPE_ADDED,
        message: `The operation has \`in: formData\` parameters, but its \`consumes\` names neither application/x-www-form-urlencoded nor multipart/form-data; the form body is ${mediaType}`,
        path: '/paths/~1x/post',
      },
    ]);
  });

  it('report a consumes list without form media types once', () => {
    const consumes = ['application/json'];
    const document = swagger({
      consumes,
      paths: {
        '/x': { post: operation({ parameters: [form({ name: 'a' })] }) },
        '/y': { post: operation({ parameters: [form({ name: 'b' })] }) },
      },
    });

    expect(codes(run(document).diagnostics)).toEqual([C.SWAGGER_FORM_MEDIA_TYPE_ADDED]);
  });

  it.each<[unknown, Record<string, unknown>, string[]]>([
    [undefined, { style: 'form', explode: false }, []],
    ['csv', { style: 'form', explode: false }, []],
    ['ssv', { style: 'spaceDelimited', explode: false }, []],
    ['pipes', { style: 'pipeDelimited', explode: false }, []],
    ['multi', { style: 'form', explode: true }, []],
    ['tsv', { style: 'form', explode: false }, [C.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT]],
    ['bogus', { style: 'form', explode: false }, [C.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT]],
  ])('encode a form array with collectionFormat %p, urlencoded and multipart alike', (collectionFormat, encoding, expected) => {
    const parameter = form({ name: 'tags', type: 'array', items: { type: 'string' }, collectionFormat });
    const { body, diagnostics } = bodyOf([parameter, form({ name: 'plain' })]);
    const media = body.content['application/x-www-form-urlencoded'];

    expect(media.encoding).toEqual({ tags: encoding });
    expect(media.schema.properties.tags).toEqual({ type: 'array', items: { type: 'string' } });
    expect(codes(diagnostics)).toEqual(expected);
    const multipart = bodyOf([parameter, form({ name: 'f', type: 'file' })], { consumes: ['multipart/form-data'] });
    expect(multipart.body.content['multipart/form-data'].encoding).toEqual({ tags: encoding });
    expect(codes(multipart.diagnostics)).toEqual(expected);
  });

  it('say what a tsv form array is sent as', () => {
    const parameter = form({ name: 'tags', type: 'array', items: { type: 'string' }, collectionFormat: 'tsv' });
    expect(bodyOf([parameter]).diagnostics[0].message).toBe(
      '`collectionFormat: tsv` has no OpenAPI 3.0 equivalent; the array is sent as comma-separated values (`style: form`, `explode: false`)',
    );
  });

  it('share one encoding between the multipart and urlencoded media types of a form, saying nothing', () => {
    const tags = form({ name: 'tags', type: 'array', items: { type: 'string' }, collectionFormat: 'pipes' });
    const parts = form({ name: 'parts', type: 'array', items: { type: 'string' }, collectionFormat: 'multi' });
    const document = swagger({
      consumes: ['multipart/form-data', 'application/x-www-form-urlencoded'],
      paths: { '/x': { post: operation({ parameters: [tags, parts, form({ name: 'plain' })] }) } },
    });
    const { doc, diagnostics } = run(document);
    const content = doc.paths['/x'].post.requestBody.content;

    expect(content['multipart/form-data'].encoding).toEqual({
      tags: { style: 'pipeDelimited', explode: false },
      parts: { style: 'form', explode: true },
    });
    expect(content['multipart/form-data'].encoding).toBe(content['application/x-www-form-urlencoded'].encoding);
    expect(diagnostics).toEqual([]);
  });

  it('drop allowEmptyValue: true, which a body property cannot have', () => {
    const { body, diagnostics } = bodyOf([
      form({ name: 'a', allowEmptyValue: true }),
      form({ name: 'b', allowEmptyValue: false }),
    ]);

    expect(body.content['application/x-www-form-urlencoded'].schema.properties).toEqual({
      a: { type: 'string' },
      b: { type: 'string' },
    });
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_NOT_CONVERTED, '/paths/~1x/post/parameters/0/allowEmptyValue'],
    ]);
  });

  it('merge path-level form parameters, which operation-level ones override by name', () => {
    const document = swagger({
      paths: {
        '/x': {
          parameters: [form({ name: 'a', description: 'path' }), form({ name: 'b' })],
          post: operation({ parameters: [form({ name: 'a', description: 'operation' }), form({ name: 'c' })] }),
          put: operation(),
        },
      },
    });
    const { doc, diagnostics } = run(document);
    const properties = (method: string) =>
      doc.paths['/x'][method].requestBody.content['application/x-www-form-urlencoded'].schema.properties;

    expect(properties('post')).toEqual({
      a: { type: 'string', description: 'operation' },
      b: { type: 'string' },
      c: { type: 'string' },
    });
    expect(properties('put')).toEqual({ a: { type: 'string', description: 'path' }, b: { type: 'string' } });
    expect(diagnostics).toEqual([]);
  });

  it('use the last of two form parameters of one list sharing a name', () => {
    const document = swagger({
      paths: {
        '/x': {
          parameters: [form({ name: 'p', title: 'first' }), form({ name: 'p', format: 'second' })],
          post: operation({ parameters: [form({ name: 'o' }), form({ name: 'o', format: 'last' })] }),
        },
      },
    });
    const { doc, diagnostics } = run(document);

    expect(doc.paths['/x'].post.requestBody.content['application/x-www-form-urlencoded'].schema.properties).toEqual({
      p: { type: 'string', format: 'second' },
      o: { type: 'string', format: 'last' },
    });
    // One finding of one kind: one diagnostic, with its places
    expect(diagnostics.filter((d) => d.severity === 'warning').map((d) => [d.code, d.path, d.message])).toEqual([
      [
        C.SWAGGER_DUPLICATE_FORM_DATA_PARAMETER,
        '/paths/~1x/parameters/1',
        'Two `in: formData` parameters are named "p"; the last one is used ' +
          '(in 2 places: /paths/~1x/parameters/1, /paths/~1x/post/parameters/1)',
      ],
    ]);
  });

  it('convert a shared form parameter once', () => {
    const shared = form({
      name: 'a',
      type: 'array',
      items: { type: 'string' },
      collectionFormat: 'tsv',
      allowEmptyValue: true,
    });
    const document = swagger({
      paths: {
        '/x': { post: operation({ parameters: [shared] }) },
        '/y': { post: operation({ parameters: [shared] }) },
      },
    });
    const { doc, diagnostics } = run(document);
    const schemaOf = (path: string) =>
      doc.paths[path].post.requestBody.content['application/x-www-form-urlencoded'].schema.properties.a;

    expect(schemaOf('/x')).toBe(schemaOf('/y'));
    expect(codes(diagnostics)).toEqual([C.SWAGGER_NOT_CONVERTED, C.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT]);
  });

  it('are not added to components, with an info diagnostic', () => {
    const { doc, diagnostics } = run(swagger({ parameters: { upload: form({ name: 'f', type: 'file' }) } }));

    expect(doc.components).toBeUndefined();
    expect(diagnostics.map((d) => [d.severity, d.code, d.path])).toEqual([
      ['info', C.SWAGGER_NOT_CONVERTED, '/parameters/upload'],
    ]);
  });

  it('keep __proto__ and constructor names as properties', () => {
    const parameters = JSON.parse(
      '[{"name":"__proto__","in":"formData","type":"string","required":true},{"name":"constructor","in":"formData","type":"integer"}]',
    );
    const { body } = bodyOf(parameters);
    const schema = body.content['application/x-www-form-urlencoded'].schema;

    expect(Object.keys(schema.properties)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(schema.properties)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(schema.properties, '__proto__')?.value).toEqual({ type: 'string' });
    expect(schema.required).toEqual(['__proto__']);
  });
});

describe('upgradeSwagger2: other parameters', () => {
  const parameterOf = (parameter: Record<string, unknown>) => {
    const result = run(withOperation(operation({ parameters: [parameter] })));
    return { parameter: postOf(result).parameters?.[0], diagnostics: result.diagnostics };
  };

  it('move type, format, items, enum, default and the validation keywords to schema', () => {
    const items = { type: 'integer', minimum: 1, 'x-item': true };
    const enumeration = ['a', 'b'];
    const { parameter, diagnostics } = parameterOf({
      name: 'q',
      in: 'query',
      description: 'Q',
      required: true,
      allowEmptyValue: true,
      type: 'array',
      format: 'list',
      items,
      collectionFormat: 'multi',
      default: [1],
      maxItems: 3,
      minItems: 1,
      uniqueItems: true,
      enum: enumeration,
      maximum: 9,
      exclusiveMaximum: true,
      minimum: 0,
      exclusiveMinimum: false,
      maxLength: 4,
      minLength: 2,
      pattern: '^a',
      multipleOf: 2,
      'x-param': 'kept',
    });

    expect(parameter).toEqual({
      name: 'q',
      in: 'query',
      description: 'Q',
      required: true,
      allowEmptyValue: true,
      style: 'form',
      explode: true,
      schema: {
        type: 'array',
        format: 'list',
        items: { type: 'integer', minimum: 1, 'x-item': true },
        default: [1],
        maximum: 9,
        exclusiveMaximum: true,
        minimum: 0,
        exclusiveMinimum: false,
        maxLength: 4,
        minLength: 2,
        pattern: '^a',
        maxItems: 3,
        minItems: 1,
        uniqueItems: true,
        enum: enumeration,
        multipleOf: 2,
      },
      'x-param': 'kept',
    });
    expect(parameter.schema.enum).toBe(enumeration);
    expect(diagnostics).toEqual([]);
  });

  it.each<[string, unknown, Record<string, unknown> | undefined, boolean]>([
    ['query', undefined, { style: 'form', explode: false }, false],
    ['query', 'csv', { style: 'form', explode: false }, false],
    ['query', 'ssv', { style: 'spaceDelimited', explode: false }, false],
    ['query', 'pipes', { style: 'pipeDelimited', explode: false }, false],
    ['query', 'multi', { style: 'form', explode: true }, false],
    ['query', 'tsv', { style: 'form', explode: false }, true],
    ['query', 7, { style: 'form', explode: false }, true],
    ['path', undefined, { style: 'simple', explode: false }, false],
    ['path', 'csv', { style: 'simple', explode: false }, false],
    ['path', 'ssv', { style: 'simple', explode: false }, true],
    ['path', 'multi', { style: 'simple', explode: false }, true],
    ['header', 'csv', { style: 'simple', explode: false }, false],
    ['header', 'pipes', { style: 'simple', explode: false }, true],
    ['cookie', undefined, { style: 'form', explode: false }, false],
    ['cookie', 'tsv', { style: 'form', explode: false }, true],
    ['matrix', undefined, undefined, false],
    ['matrix', 'csv', undefined, true],
  ])('map an array in %s with collectionFormat %p', (location, collectionFormat, style, reported) => {
    const { parameter, diagnostics } = parameterOf({
      name: 'a',
      in: location,
      required: true,
      type: 'array',
      items: { type: 'string' },
      collectionFormat,
    });

    expect({ style: parameter.style, explode: parameter.explode }).toEqual(
      style ?? { style: undefined, explode: undefined },
    );
    expect(codes(diagnostics)).toEqual(reported ? [C.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT] : []);
    if (reported) expect(diagnostics[0].path).toBe('/paths/~1x/post/parameters/0/collectionFormat');
  });

  it('say what a collectionFormat falls back to', () => {
    expect(parameterOf({ name: 'a', in: 'query', type: 'array', collectionFormat: 'tsv' }).diagnostics[0].message).toBe(
      '`collectionFormat: tsv` has no OpenAPI 3.0 equivalent for an `in: query` parameter; the array is sent as comma-separated values (`style: form`, `explode: false`)',
    );
    expect(
      parameterOf({ name: 'a', in: 'path', required: true, type: 'array', collectionFormat: 'ssv' }).diagnostics[0].message,
    ).toContain('`collectionFormat: ssv` has no OpenAPI 3.0 equivalent for an `in: path` parameter; the array is sent as comma-separated values (`style: simple`)');
    expect(
      parameterOf({ name: 'a', in: 'matrix', type: 'array', collectionFormat: 'csv' }).diagnostics[0].message,
    ).toBe('`collectionFormat: csv` has no OpenAPI 3.0 equivalent for an `in: "matrix"` parameter; no serialization style is set');
    expect(
      parameterOf({ name: 'a', in: 'query', type: 'array', collectionFormat: 'weird' }).diagnostics[0].message,
    ).toContain('`collectionFormat: "weird"`');
  });

  it('group collectionFormat findings by format and location, so each grouped message is true of all', () => {
    const array = (name: string, location: string, format: string) => ({ name, in: location, required: true, type: 'array', items: { type: 'string' }, collectionFormat: format });
    const document = swagger({
      paths: {
        '/a/{p}/{q}': {
          get: operation({
            parameters: [array('p', 'path', 'ssv'), array('q', 'path', 'ssv'), array('h', 'header', 'ssv'), array('t', 'header', 'tsv')],
          }),
        },
      },
    });
    const simple = 'the array is sent as comma-separated values (`style: simple`)';
    expect(run(document).diagnostics.map((d) => d.message)).toEqual([
      `\`collectionFormat: ssv\` has no OpenAPI 3.0 equivalent for an \`in: path\` parameter; ${simple} (in 2 places: ` +
        '/paths/~1a~1{p}~1{q}/get/parameters/0/collectionFormat, /paths/~1a~1{p}~1{q}/get/parameters/1/collectionFormat)',
      `\`collectionFormat: ssv\` has no OpenAPI 3.0 equivalent for an \`in: header\` parameter; ${simple}`,
      `\`collectionFormat: tsv\` has no OpenAPI 3.0 equivalent for an \`in: header\` parameter; ${simple}`,
    ]);
  });

  it('ignore collectionFormat on a value that is not an array', () => {
    const { parameter, diagnostics } = parameterOf({ name: 'a', in: 'query', type: 'string', collectionFormat: 'tsv' });

    expect(parameter.style).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  it('convert a file outside formData to a binary string, with a diagnostic', () => {
    const { parameter, diagnostics } = parameterOf({ name: 'a', in: 'query', type: 'file' });

    expect(parameter.schema).toEqual({ type: 'string', format: 'binary' });
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_FILE_OUTSIDE_FORM_DATA, '/paths/~1x/post/parameters/0/type'],
    ]);
  });

  it('report a format a file loses', () => {
    const { parameter, diagnostics } = parameterOf({ name: 'a', in: 'formData', type: 'file', format: 'byte' });

    expect(parameter).toBeUndefined();
    expect(diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      [
        C.SWAGGER_NOT_CONVERTED,
        '/paths/~1x/post/parameters/0/format',
        '`type: file` becomes a binary string, so `format: "byte"` is replaced by `binary`',
      ],
    ]);
  });

  it('keep path-level parameters on the path item, converted once', () => {
    const id = { name: 'id', in: 'path', required: true, type: 'string' };
    const document = swagger({
      paths: { '/a/{id}': { parameters: [id] }, '/b/{id}': { parameters: [id], get: operation() } },
    });
    const { doc } = run(document);

    expect(doc.paths['/a/{id}']).toEqual({
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    });
    expect(doc.paths['/a/{id}'].parameters[0]).toBe(doc.paths['/b/{id}'].parameters[0]);
  });

  it('report fields a parameter does not have', () => {
    const { diagnostics } = parameterOf({ name: 'a', in: 'query', type: 'string', content: 1, schema: {} });

    expect(diagnostics).toEqual([
      {
        severity: 'info',
        code: C.SWAGGER_UNKNOWN_FIELD,
        message:
          'A parameter has 2 fields Swagger 2.0 does not define there ("content", "schema"); they are not converted',
        path: '/paths/~1x/post/parameters/0',
      },
    ]);
  });

  it('convert example, or else x-example, to the 3.0 example', () => {
    expect(parameterOf({ name: 'a', in: 'query', type: 'integer', example: 3 })).toEqual({
      parameter: { name: 'a', in: 'query', example: 3, schema: { type: 'integer' } },
      diagnostics: [],
    });
    expect(parameterOf({ name: 'a', in: 'query', type: 'integer', 'x-example': 4 }).parameter).toEqual({
      name: 'a',
      in: 'query',
      example: 4,
      schema: { type: 'integer' },
      'x-example': 4,
    });
    expect(parameterOf({ name: 'a', in: 'header', type: 'string', example: null, 'x-example': 'x' }).parameter.example).toBeNull();
    // A form field's example goes to its property schema
    const result = run(withOperation(operation({ parameters: [{ name: 'f', in: 'formData', type: 'string', example: 'v' }] })));
    expect(postOf(result).requestBody.content['application/x-www-form-urlencoded'].schema.properties.f).toEqual({
      type: 'string',
      example: 'v',
    });
  });

  it('report many unknown fields of one kind as one diagnostic naming them all', () => {
    const parameters = Array.from({ length: 1000 }, (_, i) => ({ name: `p${i}`, in: 'query', type: 'string', [`f${i % 5}`]: 1 }));
    const result = run(withOperation(operation({ parameters })));

    expect(result.diagnostics).toEqual([
      {
        severity: 'info',
        code: C.SWAGGER_UNKNOWN_FIELD,
        message:
          '5 fields Swagger 2.0 does not define in a parameter ("f0", "f1", "f2" and 2 more) are not converted ' +
          '(in 1000 places: /paths/~1x/post/parameters/0, /paths/~1x/post/parameters/1, /paths/~1x/post/parameters/2 ' +
          'and 997 more)',
        path: '/paths/~1x/post/parameters/0',
      },
    ]);
    // Once per owner: another kind of object is another diagnostic
    const twoOwners = run(withOperation(operation({ parameters: parameters.slice(0, 2), foo: 1 })));
    expect(twoOwners.diagnostics.map((d) => d.message)).toEqual([
      'An Operation Object has a field Swagger 2.0 does not define there ("foo"); it is not converted',
      '2 fields Swagger 2.0 does not define in a parameter ("f0", "f1") are not converted (in 2 places: ' +
        '/paths/~1x/post/parameters/0, /paths/~1x/post/parameters/1)',
    ]);
    // One field in many places
    const same = run(withOperation(operation({ parameters: parameters.map((p, i) => ({ name: p.name, in: 'query', type: 'string', foo: i })) })));
    expect(same.diagnostics.map((d) => d.message)).toEqual([
      'A field Swagger 2.0 does not define in a parameter ("foo") is not converted (in 1000 places: ' +
        '/paths/~1x/post/parameters/0, /paths/~1x/post/parameters/1, /paths/~1x/post/parameters/2 and 997 more)',
    ]);
  });

  describe('lists', () => {
    it('ignore a parameters value that is not a list', () => {
      const result = run(withOperation(operation({ parameters: { a: 1 } })));

      expect(postOf(result).parameters).toBeUndefined();
      expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
        [C.SWAGGER_INVALID_VALUE, '/paths/~1x/post/parameters'],
      ]);
    });

    it.each([null, 'q', 3, [], undefined])('ignore the entry %p', (entry) => {
      const valid = { name: 'ok', in: 'query', type: 'string' };
      const result = run(withOperation(operation({ parameters: [entry, valid] })));

      expect(postOf(result).parameters.map((p: any) => p.name)).toEqual(['ok']);
      expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
        [C.SWAGGER_INVALID_VALUE, '/paths/~1x/post/parameters/0'],
      ]);
    });

    it.each([[{ name: 'a', type: 'string' }], [{ name: 'a', in: ['query'] }]])(
      'ignore %p, which has no string in, reporting it once',
      (parameter) => {
        const document = swagger({
          paths: { '/x': { get: operation({ parameters: [parameter] }), put: operation({ parameters: [parameter] }) } },
        });
        const { doc, diagnostics } = run(document);

        expect(doc.paths['/x'].get.parameters).toBeUndefined();
        expect(diagnostics).toEqual([
          {
            severity: 'warning',
            code: C.SWAGGER_INVALID_VALUE,
            message: `A parameter needs a string \`in\`, found ${parameter.in === undefined ? 'undefined' : 'an array'}; it is ignored`,
            path: '/paths/~1x/get/parameters/0',
          },
        ]);
      },
    );

    it('read a number or boolean name as its text, with the warning the validator gives', () => {
      const document = swagger({
        paths: { '/x': { get: operation({ parameters: [{ name: 2024, in: 'query', type: 'string' }, { name: true, in: 'header', type: 'string' }] }) } },
      });
      const { doc, diagnostics } = run(document);

      expect(doc.paths['/x'].get.parameters.map((p: any) => p.name)).toEqual(['2024', 'true']);
      expect(diagnostics).toEqual([
        parameterNameNotStringDiagnostic(2024, '/paths/~1x/get/parameters/0'),
        parameterNameNotStringDiagnostic(true, '/paths/~1x/get/parameters/1'),
      ]);
      expect(diagnostics[0]).toEqual({
        severity: 'warning',
        code: C.PARAMETER_NAME_NOT_STRING,
        message: 'Parameter name 2024 is a number, not a string (YAML reads an unquoted number so); it is read as "2024"',
        path: '/paths/~1x/get/parameters/0/name',
      });
    });

    it('keep a parameter without a usable name as written, for generation to refuse, except a form field', () => {
      const document = swagger({
        paths: {
          '/x': {
            get: operation({ parameters: [{ in: 'query', type: 'string' }, { name: { a: 1 }, in: 'header', type: 'string' }] }),
            post: operation({ parameters: [{ name: '', in: 'formData', type: 'string' }, { name: null, in: 'body', schema: {} }] }),
          },
        },
      });
      const { doc, diagnostics } = run(document);

      expect(doc.paths['/x'].get.parameters).toEqual([
        { in: 'query', schema: { type: 'string' } },
        { name: { a: 1 }, in: 'header', schema: { type: 'string' } },
      ]);
      // A body has no name in 3.0; a form field without one cannot be a property
      expect(doc.paths['/x'].post.requestBody).toEqual({ content: { 'application/json': { schema: {} } } });
      expect(diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
        [
          C.SWAGGER_INVALID_VALUE,
          '/paths/~1x/post/parameters/0',
          'An `in: formData` parameter needs a name, found ""; it is ignored',
        ],
        [C.SWAGGER_ASSUMED_MEDIA_TYPE, '/paths/~1x/post', expect.any(String)],
      ]);
    });

    it('ignore an unresolved parameter reference, reporting it once', () => {
      const ref = { $ref: '#/parameters/limit' };
      const document = swagger({
        paths: { '/x': { get: operation({ parameters: [ref] }), put: operation({ parameters: [ref] }) } },
      });
      const { doc, diagnostics } = run(document);

      expect(doc.paths['/x'].get.parameters).toBeUndefined();
      expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
        [C.SWAGGER_UNRESOLVED_REFERENCE, '/paths/~1x/get/parameters/0'],
      ]);
    });
  });

  describe('items', () => {
    it('chain nested Items Objects, reporting a nested collectionFormat', () => {
      const { parameter, diagnostics } = parameterOf({
        name: 'grid',
        in: 'query',
        type: 'array',
        items: { type: 'array', collectionFormat: 'pipes', items: { type: 'integer', maximum: 63 } },
      });

      expect(parameter.schema).toEqual({
        type: 'array',
        items: { type: 'array', items: { type: 'integer', maximum: 63 } },
      });
      expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
        [C.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT, '/paths/~1x/post/parameters/0/items/collectionFormat'],
      ]);
    });

    it('ignore a collectionFormat of items that are not arrays', () => {
      expect(
        parameterOf({ name: 'a', in: 'query', type: 'array', items: { type: 'string', collectionFormat: 'ssv' } })
          .diagnostics,
      ).toEqual([]);
    });

    it.each([
      [{ type: 'array', items: 'string' }, '/paths/~1x/post/parameters/0/items'],
      [{ type: 'array', items: { type: 'array', items: 5 } }, '/paths/~1x/post/parameters/0/items/items'],
    ])('drop an items value that is not an object: %p', (fields, path) => {
      const { parameter, diagnostics } = parameterOf({ name: 'a', in: 'query', ...fields });

      expect(JSON.stringify(parameter.schema)).not.toContain('5');
      expect(diagnostics.map((d) => [d.code, d.path])).toEqual([[C.SWAGGER_INVALID_VALUE, path]]);
    });

    it('report a file and unknown fields in an Items Object', () => {
      const { parameter, diagnostics } = parameterOf({
        name: 'a',
        in: 'query',
        type: 'array',
        items: { type: 'file', description: 'no' },
      });

      expect(parameter.schema.items).toEqual({ type: 'string', format: 'binary' });
      expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
        [C.SWAGGER_UNKNOWN_FIELD, '/paths/~1x/post/parameters/0/items'],
        [C.SWAGGER_FILE_OUTSIDE_FORM_DATA, '/paths/~1x/post/parameters/0/items/type'],
      ]);
    });

    it('convert a shared Items Object once', () => {
      const items = { type: 'string' };
      const document = swagger({
        paths: {
          '/x': {
            get: operation({
              parameters: [
                { name: 'a', in: 'query', type: 'array', items },
                { name: 'b', in: 'header', type: 'array', items },
              ],
            }),
          },
        },
      });
      const [a, b] = run(document).doc.paths['/x'].get.parameters;

      expect(a.schema.items).toBe(b.schema.items);
    });

    it('turn a cyclic chain into a cyclic schema', () => {
      const outer: any = { type: 'array' };
      const inner: any = { type: 'array', items: outer };
      outer.items = inner;
      const { parameter, diagnostics } = parameterOf({ name: 'a', in: 'query', type: 'array', items: outer });
      const first = parameter.schema.items;

      expect(first.items.items).toBe(first);
      expect(first).not.toBe(outer);
      expect(diagnostics).toEqual([]);
    });

    it('walk a 100,000-deep chain with a loop', () => {
      const root: any = { type: 'array' };
      let node = root;
      for (let depth = 0; depth < 100_000; depth++) {
        node.items = { type: 'array' };
        node = node.items;
      }
      node.type = 'string';
      node.collectionFormat = 'ssv';
      node.type = 'array';
      node['x-bottom'] = true;

      // A recursive walk overflows the call stack long before 100,000 levels: reaching the bottom is the check
      const { parameter, diagnostics } = parameterOf({ name: 'deep', in: 'query', type: 'array', items: root });
      let schema = parameter.schema;
      let depth = 0;
      while (schema.items !== undefined) {
        schema = schema.items;
        depth++;
      }

      expect(depth).toBe(100_001);
      expect(schema['x-bottom']).toBe(true);
      // The pointer of the deepest item keeps its last 32 segments
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].path).toBe(
        `/paths/~1x/post/parameters/0/items/${POINTER_TRUNCATION_MARKER}${'/items'.repeat(31)}/collectionFormat`,
      );
    });
  });
});

describe('upgradeSwagger2: responses', () => {
  const responseOf = (response: unknown, op: Record<string, unknown> = {}, root: Record<string, unknown> = {}) => {
    const result = run(withOperation(operation({ responses: { 200: response }, ...op }), root));
    return { response: postOf(result).responses[200], diagnostics: result.diagnostics };
  };

  it('put the schema under each produces media type, with matching examples', () => {
    const schema = { type: 'object' };
    const { response, diagnostics } = responseOf(
      {
        description: 'ok',
        schema,
        examples: { 'application/json': { a: 1 }, 'TEXT/PLAIN; charset=utf-8': 'a' },
        'x-r': 1,
      },
      {},
      { produces: ['application/json', 'text/plain', 'application/xml'] },
    );

    expect(response).toEqual({
      description: 'ok',
      content: {
        'application/json': { schema, example: { a: 1 } },
        'text/plain': { schema, example: 'a' },
        'application/xml': { schema },
      },
      'x-r': 1,
    });
    expect(diagnostics).toEqual([]);
  });

  it('turn a file response into a binary string', () => {
    const { response } = responseOf(
      { description: 'f', schema: { type: 'file' } },
      {},
      { produces: ['application/pdf'] },
    );

    expect(response.content).toEqual({ 'application/pdf': { schema: { type: 'string', format: 'binary' } } });
  });

  it('keep examples without a schema, and no content without either', () => {
    expect(responseOf({ description: 'e', examples: { 'a/b': 1 } }, {}, { produces: ['a/b', 'c/d'] }).response).toEqual(
      {
        description: 'e',
        content: { 'a/b': { example: 1 } },
      },
    );
    expect(responseOf({ description: 'none' }).response).toEqual({ description: 'none' });
  });

  it('report examples for media types the operation does not produce', () => {
    const { response, diagnostics } = responseOf(
      {
        description: 'e',
        schema: {},
        examples: { 'a/b': 1, 'c/d': 2, 'e/f': 3, 'g/h': 4, 'i/j': 5, 'k/l': undefined },
      },
      {},
      { produces: ['a/b'] },
    );

    expect(Object.keys(response.content)).toEqual(['a/b']);
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_NOT_CONVERTED,
        message:
          '4 examples for "c/d", "e/f", "g/h" and 1 more name no media type the operation produces; they are not converted',
        path: '/paths/~1x/post/responses/200/examples',
      },
    ]);
    expect(responseOf({ description: 'e', examples: { 'x/y': 1 } }).diagnostics[0].message).toBe(
      'The example for "x/y" names no media type the operation produces (none is declared, so application/json is assumed); it is not converted',
    );
  });

  it('convert headers to Header Objects with a schema', () => {
    const { response, diagnostics } = responseOf({
      description: 'h',
      headers: {
        'X-Rate': { type: 'integer', description: 'Rate', 'x-h': 1 },
        'X-List': { type: 'array', items: { type: 'string' }, collectionFormat: 'csv' },
        'X-Pipes': { type: 'array', items: { type: 'string' }, collectionFormat: 'pipes' },
        'X-File': { type: 'file' },
        'X-Unknown': { type: 'string', style: 'simple' },
        'X-Bad': 'nope',
        'X-Ref': { $ref: '#/x' },
        'X-Undefined': undefined,
      },
    });

    expect(response.headers).toEqual({
      'X-Rate': { description: 'Rate', schema: { type: 'integer' }, 'x-h': 1 },
      'X-List': { schema: { type: 'array', items: { type: 'string' } } },
      'X-Pipes': { schema: { type: 'array', items: { type: 'string' } } },
      'X-File': { schema: { type: 'string', format: 'binary' } },
      'X-Unknown': { schema: { type: 'string' } },
    });
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT, '/paths/~1x/post/responses/200/headers/X-Pipes/collectionFormat'],
      [C.SWAGGER_FILE_OUTSIDE_FORM_DATA, '/paths/~1x/post/responses/200/headers/X-File/type'],
      [C.SWAGGER_UNKNOWN_FIELD, '/paths/~1x/post/responses/200/headers/X-Unknown'],
      [C.SWAGGER_INVALID_VALUE, '/paths/~1x/post/responses/200/headers/X-Bad'],
      [C.SWAGGER_UNRESOLVED_REFERENCE, '/paths/~1x/post/responses/200/headers/X-Ref'],
    ]);
  });

  it('convert a shared header once, and a shared unresolved one is reported once', () => {
    const header = { type: 'string' };
    const ref = { $ref: '#/x' };
    const document = swagger({
      paths: {
        '/x': { get: operation({ responses: { 200: { description: 'a', headers: { A: header, R: ref } } } }) },
        '/y': { get: operation({ responses: { 200: { description: 'b', headers: { B: header, R: ref } } } }) },
      },
    });
    const { doc, diagnostics } = run(document);

    expect(doc.paths['/x'].get.responses[200].headers.A).toBe(doc.paths['/y'].get.responses[200].headers.B);
    expect(codes(diagnostics)).toEqual([C.SWAGGER_UNRESOLVED_REFERENCE]);
  });

  it.each<[string, unknown, string]>([
    ['schema', 'string', '/paths/~1x/post/responses/200/schema'],
    ['examples', ['a'], '/paths/~1x/post/responses/200/examples'],
    ['headers', 3, '/paths/~1x/post/responses/200/headers'],
  ])('ignore a %s that is not an object', (field, value, path) => {
    const { response, diagnostics } = responseOf({ description: 'd', [field]: value });

    expect(response).toEqual({ description: 'd' });
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([[C.SWAGGER_INVALID_VALUE, path]]);
  });

  it('copy extensions of the Responses Object and skip undefined entries', () => {
    const result = run(withOperation({ responses: { 200: ok, 'x-codes': [1], 404: undefined } }));

    expect(postOf(result).responses).toEqual({ 200: { description: 'ok' }, 'x-codes': [1] });
  });

  it.each([null, 'ok', 5, []])('ignore the response %p', (response) => {
    const { diagnostics } = responseOf(response);

    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_INVALID_VALUE, '/paths/~1x/post/responses/200'],
    ]);
  });

  it('ignore an unresolved response reference, reporting it once', () => {
    const ref = { $ref: '#/responses/NotFound' };
    const document = swagger({
      paths: { '/x': { get: operation({ responses: { 404: ref } }), put: operation({ responses: { 404: ref } }) } },
    });
    const { doc, diagnostics } = run(document);

    expect(doc.paths['/x'].get.responses).toEqual({});
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_UNRESOLVED_REFERENCE, '/paths/~1x/get/responses/404'],
    ]);
  });

  it.each([undefined, 'none', [ok]])('give an empty Responses Object for responses %p', (responses) => {
    const result = run(withOperation({ responses }));

    expect(postOf(result).responses).toEqual({});
    expect(codes(result.diagnostics)).toEqual(responses === undefined ? [] : [C.SWAGGER_INVALID_VALUE]);
  });

  it('convert a shared response once per produces list', () => {
    const response = { description: 'r', schema: { type: 'string' } };
    const json = ['application/json'];
    const document = swagger({
      produces: json,
      paths: {
        '/a': { get: operation({ responses: { 200: response } }) },
        '/b': { get: operation({ responses: { 200: response } }) },
        '/c': { get: operation({ responses: { 200: response }, produces: ['text/plain'] }) },
      },
    });
    const { doc } = run(document);
    const responseAt = (path: string) => doc.paths[path].get.responses[200];

    expect(responseAt('/a')).toBe(responseAt('/b'));
    expect(responseAt('/c')).not.toBe(responseAt('/a'));
    expect(responseAt('/c').content['text/plain'].schema).toBe(responseAt('/a').content['application/json'].schema);
  });

  it('report fields a response does not have, once', () => {
    const response = { description: 'r', content: {} };
    const document = swagger({
      paths: {
        '/a': { get: operation({ responses: { 200: response } }), put: operation({ responses: { 200: response } }) },
      },
    });

    expect(run(document).diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_UNKNOWN_FIELD, '/paths/~1a/get/responses/200'],
    ]);
  });
});

describe('upgradeSwagger2: components', () => {
  it('convert definitions, parameters, responses and security definitions', () => {
    const document = swagger({
      consumes: ['a/b'],
      definitions: { A: { type: 'string' }, Bad: 'x', Skipped: undefined },
      parameters: {
        q: { name: 'q', in: 'query', type: 'string' },
        body: { name: 'b', in: 'body', schema: { type: 'object' } },
        bad: 4,
      },
      responses: { R: { description: 'r' }, Bad: [] },
      securityDefinitions: { basic: { type: 'basic' }, bad: { type: 'digest' } },
    });
    const { doc, diagnostics } = run(document);

    expect(doc.components).toEqual({
      schemas: { A: { type: 'string' } },
      responses: { R: { description: 'r' } },
      parameters: { q: { name: 'q', in: 'query', schema: { type: 'string' } } },
      requestBodies: { body: { content: { 'a/b': { schema: { type: 'object' } } } } },
      securitySchemes: { basic: { type: 'http', scheme: 'basic' } },
    });
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_INVALID_VALUE, '/definitions/Bad'],
      [C.SWAGGER_INVALID_VALUE, '/parameters/bad'],
      [C.SWAGGER_INVALID_VALUE, '/responses/Bad'],
      [C.SWAGGER_UNSUPPORTED_SECURITY_SCHEME, '/securityDefinitions/bad/type'],
    ]);
  });

  it.each(['definitions', 'parameters', 'responses', 'securityDefinitions'])(
    'ignore %s that is not an object',
    (field) => {
      const { doc, diagnostics } = run(swagger({ [field]: ['x'] }));

      // A securityDefinitions of the wrong kind still defines a scheme map, an empty one
      expect(doc.components).toEqual(field === 'securityDefinitions' ? { securitySchemes: {} } : undefined);
      expect(diagnostics.map((d) => [d.code, d.path])).toEqual([[C.SWAGGER_INVALID_VALUE, `/${field}`]]);
    },
  );

  it('keep __proto__ and constructor component names as own keys', () => {
    const document = JSON.parse(
      '{"swagger":"2.0","info":{"title":"T","version":"1"},"host":"h","schemes":["https"],"paths":{},' +
        '"definitions":{"__proto__":{"type":"string"},"constructor":{"type":"integer"}},' +
        '"securityDefinitions":{"__proto__":{"type":"basic"}}}',
    );
    const { doc } = run(document);

    expect(Object.keys(doc.components.schemas)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(doc.components.schemas)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(doc.components.securitySchemes, '__proto__')?.value).toEqual({
      type: 'http',
      scheme: 'basic',
    });
  });
});

describe('upgradeSwagger2: security schemes', () => {
  const schemeOf = (scheme: unknown) => {
    const result = run(swagger({ securityDefinitions: { s: scheme } }));
    return { scheme: result.doc.components?.securitySchemes?.s, diagnostics: result.diagnostics };
  };

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'basic',
      { type: 'basic', description: 'B', 'x-s': 1 },
      { type: 'http', scheme: 'basic', description: 'B', 'x-s': 1 },
    ],
    ['apiKey', { type: 'apiKey', name: 'X-Key', in: 'query' }, { type: 'apiKey', name: 'X-Key', in: 'query' }],
    [
      'oauth2 implicit',
      { type: 'oauth2', flow: 'implicit', authorizationUrl: 'https://a', scopes: { read: 'Read' } },
      { type: 'oauth2', flows: { implicit: { authorizationUrl: 'https://a', scopes: { read: 'Read' } } } },
    ],
    [
      'oauth2 password',
      { type: 'oauth2', flow: 'password', tokenUrl: 'https://t', scopes: {} },
      { type: 'oauth2', flows: { password: { tokenUrl: 'https://t', scopes: {} } } },
    ],
    [
      'oauth2 application',
      { type: 'oauth2', flow: 'application', tokenUrl: 'https://t', scopes: { a: 'A' }, description: 'D' },
      { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://t', scopes: { a: 'A' } } }, description: 'D' },
    ],
    [
      'oauth2 accessCode',
      { type: 'oauth2', flow: 'accessCode', authorizationUrl: 'https://a', tokenUrl: 'https://t', scopes: {} },
      {
        type: 'oauth2',
        flows: { authorizationCode: { authorizationUrl: 'https://a', tokenUrl: 'https://t', scopes: {} } },
      },
    ],
  ])('convert %s', (_label, scheme, expected) => {
    const { scheme: converted, diagnostics } = schemeOf(scheme);

    expect(converted).toEqual(expected);
    expect(diagnostics).toEqual([]);
  });

  it('attach scopes by reference, and give empty scopes when there are none', () => {
    const scopes = { read: 'Read' };

    expect(schemeOf({ type: 'oauth2', flow: 'password', tokenUrl: 't', scopes }).scheme.flows.password.scopes).toBe(
      scopes,
    );
    expect(schemeOf({ type: 'oauth2', flow: 'password', tokenUrl: 't' })).toEqual({
      scheme: { type: 'oauth2', flows: { password: { tokenUrl: 't', scopes: {} } } },
      diagnostics: [],
    });
  });

  it('replace scopes that are not a map, with a diagnostic', () => {
    const { scheme, diagnostics } = schemeOf({ type: 'oauth2', flow: 'password', tokenUrl: 't', scopes: ['read'] });

    expect(scheme.flows.password.scopes).toEqual({});
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_INVALID_VALUE, '/securityDefinitions/s/scopes'],
    ]);
  });

  it('report fields that do not apply to the scheme', () => {
    const basic = schemeOf({ type: 'basic', name: 'n', in: 'header' });
    const implicit = schemeOf({ type: 'oauth2', flow: 'implicit', authorizationUrl: 'a', tokenUrl: 't', scopes: {} });

    expect(basic.scheme).toEqual({ type: 'http', scheme: 'basic' });
    expect(basic.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_NOT_CONVERTED,
        message: '"name", "in" do not apply to this security scheme (type "basic"); not converted',
        path: '/securityDefinitions/s',
      },
    ]);
    expect(implicit.scheme.flows.implicit).toEqual({ authorizationUrl: 'a', scopes: {} });
    expect(implicit.diagnostics[0].message).toBe(
      '"tokenUrl" does not apply to this security scheme (type "oauth2", flow "implicit"); not converted',
    );
  });

  it.each<[unknown, string, string]>([
    [{ type: 'oauth2', flow: 'deviceCode' }, '/securityDefinitions/s/flow', 'found "deviceCode"'],
    [{ type: 'oauth2' }, '/securityDefinitions/s/flow', 'found undefined'],
    [{ type: 'oauth2', flow: '__proto__' }, '/securityDefinitions/s/flow', 'found "__proto__"'],
    [{ type: 'http', scheme: 'bearer' }, '/securityDefinitions/s/type', 'found "http"'],
    [{}, '/securityDefinitions/s/type', 'found undefined'],
  ])('drop the unsupported scheme %p', (scheme, path, found) => {
    const { scheme: converted, diagnostics } = schemeOf(scheme);

    expect(converted).toBeUndefined();
    expect(diagnostics.filter((d) => d.code === C.SWAGGER_UNSUPPORTED_SECURITY_SCHEME)).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_UNSUPPORTED_SECURITY_SCHEME,
        message: expect.stringContaining(found),
        path,
      },
    ]);
  });

  it.each<[unknown, string]>([
    ['basic', C.SWAGGER_INVALID_VALUE],
    [{ $ref: '#/x' }, C.SWAGGER_UNRESOLVED_REFERENCE],
  ])('drop the scheme %p', (scheme, code) => {
    expect(schemeOf(scheme)).toEqual({
      scheme: undefined,
      diagnostics: [expect.objectContaining({ code, path: '/securityDefinitions/s' })],
    });
  });

  it('report fields a security scheme does not have', () => {
    expect(codes(schemeOf({ type: 'apiKey', name: 'k', in: 'header', scheme: 'x' }).diagnostics)).toEqual([
      C.SWAGGER_UNKNOWN_FIELD,
    ]);
  });
});

describe('upgradeSwagger2: schemas', () => {
  const definitionsOf = (definitions: Record<string, unknown>) => {
    const result = run(swagger({ definitions }));
    return { schemas: result.doc.components?.schemas ?? {}, diagnostics: result.diagnostics };
  };

  it('return a schema without 2.0-only constructs as is, however deep', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'array', items: { allOf: [{ type: 'string' }], not: { enum: [1] } } } },
      additionalProperties: { oneOf: [{ type: 'integer' }], anyOf: [{ type: 'number' }] },
      discriminator: { propertyName: 'kind' },
      $ref: 'other.json#/X',
    };

    expect(definitionsOf({ S: schema })).toEqual({ schemas: { S: schema }, diagnostics: [] });
    expect(definitionsOf({ S: schema }).schemas.S).toBe(schema);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    [
      'a string discriminator',
      { type: 'object', discriminator: 'petType' },
      { type: 'object', discriminator: { propertyName: 'petType' } },
    ],
    [
      'x-nullable: true',
      { type: 'string', 'x-nullable': true, 'x-other': 1 },
      { type: 'string', nullable: true, 'x-other': 1 },
    ],
    ['x-nullable: false', { type: 'string', 'x-nullable': false }, { type: 'string', nullable: false }],
    ['type: file', { type: 'file', description: 'f' }, { type: 'string', format: 'binary', description: 'f' }],
    ['type: file with format binary', { type: 'file', format: 'binary' }, { type: 'string', format: 'binary' }],
    ['a definitions reference', { $ref: '#/definitions/Pet' }, { $ref: '#/components/schemas/Pet' }],
    [
      'a deep definitions reference',
      { $ref: '#/definitions/Pet/properties/a~1b' },
      { $ref: '#/components/schemas/Pet/properties/a~1b' },
    ],
    ['a type list of one', { type: ['string'] }, { type: 'string' }],
    [
      'a type list with null',
      { type: ['string', 'null'], maxLength: 3 },
      { maxLength: 3, type: 'string', nullable: true },
    ],
    [
      'a type list with null and nullable',
      { type: ['string', 'null'], nullable: false },
      { nullable: false, type: 'string' },
    ],
    [
      'a type list of several',
      { type: ['string', 'integer'], minimum: 1 },
      { minimum: 1, anyOf: [{ type: 'string' }, { type: 'integer' }] },
    ],
    [
      'a type list of several with null',
      { type: ['integer', 'null', 'string', 'integer'] },
      { anyOf: [{ type: 'integer', nullable: true }, { type: 'string' }] },
    ],
    [
      'a type list beside anyOf',
      { type: ['string', 'integer'], anyOf: [{ minLength: 1 }], allOf: [{ title: 't' }] },
      { anyOf: [{ minLength: 1 }], allOf: [{ title: 't' }, { anyOf: [{ type: 'string' }, { type: 'integer' }] }] },
    ],
    [
      'a type list beside anyOf without allOf',
      { type: ['string', 'integer'], anyOf: [{ minLength: 1 }], allOf: 'bad' },
      { anyOf: [{ minLength: 1 }], allOf: [{ anyOf: [{ type: 'string' }, { type: 'integer' }] }] },
    ],
  ])('convert %s', (_label, schema, expected) => {
    const { schemas } = definitionsOf({ S: schema });

    expect(schemas.S).toEqual(expected);
    expect(schemas.S).not.toBe(schema);
  });

  it('copy the other fields of a changed schema as they are', () => {
    const discriminator = { propertyName: 'k' };
    const { schemas } = definitionsOf({
      A: { discriminator, 'x-nullable': true },
      B: { $ref: 'other.json#/definitions/B', 'x-nullable': false },
      C: { discriminator: 'k', 'x-nullable': 'yes' },
    });

    expect(schemas.A).toEqual({ discriminator, nullable: true });
    expect(schemas.A.discriminator).toBe(discriminator);
    expect(schemas.B).toEqual({ $ref: 'other.json#/definitions/B', nullable: false });
    expect(schemas.C).toEqual({ discriminator: { propertyName: 'k' }, 'x-nullable': 'yes' });
  });

  it('leave x-nullable as is when the schema has nullable or the value is not a boolean', () => {
    const withNullable = { type: 'string', 'x-nullable': true, nullable: false };
    const notBoolean = { type: 'string', 'x-nullable': 'yes' };

    expect(definitionsOf({ A: withNullable, B: notBoolean }).schemas).toEqual({ A: withNullable, B: notBoolean });
    expect(definitionsOf({ A: withNullable }).schemas.A).toBe(withNullable);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string, string]>([
    [
      'a tuple',
      { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] },
      { type: 'array', items: {} },
      C.SWAGGER_NOT_CONVERTED,
      '/definitions/S/items',
    ],
    [
      'a type list of null only',
      { type: ['null'], title: 't' },
      { title: 't' },
      C.SWAGGER_NOT_CONVERTED,
      '/definitions/S/type',
    ],
    [
      'type null',
      { type: 'null', description: 'd' },
      { description: 'd' },
      C.SWAGGER_NOT_CONVERTED,
      '/definitions/S/type',
    ],
    ['an empty type list', { type: [] }, {}, C.SWAGGER_NOT_CONVERTED, '/definitions/S/type'],
    [
      'a file losing its format',
      { type: 'file', format: 'byte' },
      { type: 'string', format: 'binary' },
      C.SWAGGER_NOT_CONVERTED,
      '/definitions/S/format',
    ],
  ])('approximate %s, with a diagnostic', (_label, schema, expected, code, path) => {
    const { schemas, diagnostics } = definitionsOf({ S: schema });

    expect(schemas.S).toEqual(expected);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([[code, path]]);
  });

  it('drop additionalItems beside a tuple, with one diagnostic each', () => {
    const { schemas, diagnostics } = definitionsOf({
      S: { type: 'array', items: [{ type: 'string' }], additionalItems: false },
    });

    expect(schemas.S).toEqual({ type: 'array', items: {} });
    expect(diagnostics.map((d) => [d.code, d.path, d.message])).toEqual([
      [
        C.SWAGGER_NOT_CONVERTED,
        '/definitions/S/items',
        '`items` lists one schema per position (a tuple), which OpenAPI 3.0 cannot express; any item is accepted (`items: {}`)',
      ],
      [
        C.SWAGGER_NOT_CONVERTED,
        '/definitions/S/additionalItems',
        '`additionalItems` is not an OpenAPI 3.0 keyword, and it constrains nothing once `items` is not a tuple; it is dropped',
      ],
    ]);
  });

  it.each<[string, unknown]>([
    ['false', false],
    ['true', true],
    ['a schema', { type: 'integer', 'x-nullable': true }],
  ])('drop additionalItems %s on its own, which makes the schema change', (_label, additionalItems) => {
    const schema = { type: 'array', items: { type: 'string' }, additionalItems };
    const { schemas, diagnostics } = definitionsOf({ S: schema });

    expect(schemas.S).toEqual({ type: 'array', items: { type: 'string' } });
    expect(schemas.S).not.toBe(schema);
    // The unchanged `items` is shared, not copied
    expect(schemas.S.items).toBe(schema.items);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([[C.SWAGGER_NOT_CONVERTED, '/definitions/S/additionalItems']]);
  });

  it('drop additionalItems deep in properties and allOf, replacing each schema that leads to it, without changing the input', () => {
    const untouched = { type: 'string' };
    const source = deepFreeze({
      swagger: '2.0',
      info: { title: 'T', version: '1' },
      host: 'api.example.com',
      schemes: ['https'],
      paths: {},
      definitions: {
        Outer: {
          type: 'object',
          properties: {
            list: { type: 'array', items: { type: 'string' }, additionalItems: false },
            other: untouched,
          },
          allOf: [{ type: 'object' }, { properties: { tail: { type: 'array', additionalItems: { type: 'string' } } } }],
        },
      },
    });
    const before = JSON.stringify(source);
    const { doc, diagnostics } = run(source);
    const outer = doc.components.schemas.Outer;

    expect(JSON.stringify(source)).toBe(before);
    expect(outer).not.toBe(source.definitions.Outer);
    expect(outer).toEqual({
      type: 'object',
      properties: { list: { type: 'array', items: { type: 'string' } }, other: { type: 'string' } },
      allOf: [{ type: 'object' }, { properties: { tail: { type: 'array' } } }],
    });
    // Only schemas leading to a change are replaced
    expect(outer.properties.other).toBe(untouched);
    expect(outer.allOf[0]).toBe(source.definitions.Outer.allOf[0]);
    expect(outer.allOf[1]).not.toBe(source.definitions.Outer.allOf[1]);
    expect(JSON.stringify(doc)).not.toContain('additionalItems');
    // One finding of a kind, grouped: the first place found, and every place
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_NOT_CONVERTED, '/definitions/Outer/properties/list/additionalItems'],
    ]);
    expect(diagnostics[0].message).toBe(
      '`additionalItems` is not an OpenAPI 3.0 keyword, and it constrains nothing once `items` is not a tuple; it is ' +
        'dropped (in 2 places: /definitions/Outer/properties/list/additionalItems, ' +
        '/definitions/Outer/allOf/1/properties/tail/additionalItems)',
    );
  });

  it('de-duplicate a type list of any length without scanning the list for each entry', () => {
    // 25,000 names, `null`, then the 25,000 names again: 50,001 entries
    const names = Array.from({ length: 25_000 }, (_, i) => `t${i}`);
    const type = [...names, 'null', ...names];
    // Counts the entries every array membership scan goes through while converting
    let scanned = 0;
    const spies = (['includes', 'indexOf', 'lastIndexOf'] as const).map((method) => {
      const original = Array.prototype[method] as (...args: unknown[]) => unknown;
      return jest.spyOn(Array.prototype, method).mockImplementation(function (this: unknown[], ...args: unknown[]) {
        scanned += this.length;
        return original.apply(this, args);
      } as any);
    });
    let schemas: any;
    try {
      ({ schemas } = definitionsOf({ S: { type } }));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    expect(schemas.S.anyOf).toHaveLength(25_000);
    expect(schemas.S.anyOf[0]).toEqual({ type: 't0', nullable: true });
    expect(schemas.S.anyOf[1]).toEqual({ type: 't1' });
    expect(schemas.S.anyOf[24_999]).toEqual({ type: 't24999' });
    // A scan of the names found so far for each entry goes through about 9.4e8 of them
    expect(scanned).toBeLessThan(type.length);
  });

  it('ignore type list entries that are not names', () => {
    const { schemas, diagnostics } = definitionsOf({ S: { type: ['string', 5, null] } });

    expect(schemas.S).toEqual({ type: 'string' });
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([[C.SWAGGER_INVALID_VALUE, '/definitions/S/type']]);
  });

  it('keep a local reference outside definitions as is, with a diagnostic', () => {
    const schema = { $ref: '#/parameters/limit' };
    const { schemas, diagnostics } = definitionsOf({ S: schema });

    expect(schemas.S).toBe(schema);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([[C.SWAGGER_UNRESOLVED_REFERENCE, '/definitions/S/$ref']]);
  });

  it('replace each schema leading to a changed one, and share the rest', () => {
    const unchanged = { type: 'string' };
    const changed = { type: 'object', discriminator: 'kind' };
    const schema = {
      type: 'object',
      properties: { u: unchanged, c: changed },
      items: { allOf: [unchanged, changed] },
      additionalProperties: { not: changed },
      anyOf: [5, unchanged],
      oneOf: [changed],
    };
    const { schemas } = definitionsOf({ S: schema, C: changed, U: unchanged });
    const S = schemas.S;

    expect(S).not.toBe(schema);
    expect(S.properties).not.toBe(schema.properties);
    expect(S.properties.u).toBe(unchanged);
    expect(S.properties.c).toBe(schemas.C);
    expect(S.items.allOf[0]).toBe(unchanged);
    expect(S.items.allOf[1]).toBe(schemas.C);
    expect(S.additionalProperties.not).toBe(schemas.C);
    expect(S.anyOf).toEqual([5, unchanged]);
    expect(S.oneOf[0]).toBe(schemas.C);
    expect(schemas.U).toBe(unchanged);
  });

  it('keep cycles and sharing in the new graph', () => {
    const node: any = { type: 'object', discriminator: 'kind', properties: {} };
    node.properties.self = node;
    node.properties.list = { type: 'array', items: node };
    const holder = { type: 'object', properties: { a: node, b: node } };
    const { schemas, diagnostics } = definitionsOf({ Holder: holder, Node: node });
    const converted = schemas.Node;

    expect(converted.discriminator).toEqual({ propertyName: 'kind' });
    expect(converted.properties.self).toBe(converted);
    expect(converted.properties.list.items).toBe(converted);
    expect(schemas.Holder.properties.a).toBe(converted);
    expect(schemas.Holder.properties.b).toBe(converted);
    expect(diagnostics).toEqual([]);
  });

  it('process a schema once, whichever root reaches it, and point at the first', () => {
    const tuple = { type: 'array', items: [{}] };
    const { schemas, diagnostics } = definitionsOf({ A: { properties: { t: tuple } }, B: { items: tuple } });

    expect(schemas.A.properties.t).toBe(schemas.B.items);
    expect(diagnostics.map((d) => d.path)).toEqual(['/definitions/A/properties/t/items']);
  });

  it('leave subschema slots that hold no schema as they are', () => {
    const schema = {
      discriminator: 'k',
      properties: { a: 'text', b: null, c: [1] },
      allOf: { not: 'a list' },
      not: 3,
      additionalProperties: true,
    };
    const { schemas } = definitionsOf({ S: schema, P: { discriminator: 'k', properties: 'not a map' } });

    expect(schemas.S).toEqual({ ...schema, discriminator: { propertyName: 'k' } });
    expect(schemas.P).toEqual({ discriminator: { propertyName: 'k' }, properties: 'not a map' });
  });

  it('keep __proto__ properties as own keys of the new properties map', () => {
    const schema = JSON.parse(
      '{"discriminator":"k","properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer"}}}',
    );
    const { schemas } = definitionsOf({ S: schema });

    expect(Object.keys(schemas.S.properties)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(schemas.S.properties)).toBe(Object.prototype);
  });

  it('rewrite body, response and nested schemas with the same rules', () => {
    const result = run(
      withOperation(
        operation({
          parameters: [{ name: 'b', in: 'body', schema: { type: 'object', discriminator: 'k' } }],
          responses: { 200: { description: 'r', schema: { type: 'array', items: { type: 'file' } } } },
        }),
        { consumes: ['a/b'], produces: ['c/d'] },
      ),
    );

    expect(postOf(result).requestBody.content['a/b'].schema).toEqual({
      type: 'object',
      discriminator: { propertyName: 'k' },
    });
    expect(postOf(result).responses[200].content['c/d'].schema).toEqual({
      type: 'array',
      items: { type: 'string', format: 'binary' },
    });
  });

  it('walk a 100,000-deep chain with an explicit stack, replacing every level above a change', () => {
    const root: any = { type: 'object', properties: {} };
    let node = root;
    for (let depth = 0; depth < 100_000; depth++) {
      node.properties.next = { type: 'object', properties: {} };
      node = node.properties.next;
    }
    node.items = [{}];

    // A recursive walk overflows the call stack long before 100,000 levels: reaching the bottom is the check
    const { schemas, diagnostics } = definitionsOf({ Deep: root });
    let converted = schemas.Deep;
    let original = root;
    let depth = 0;
    while (converted.properties?.next !== undefined) {
      expect(converted).not.toBe(original);
      converted = converted.properties.next;
      original = original.properties.next;
      depth++;
    }

    expect(depth).toBe(100_000);
    expect(converted.items).toEqual({});
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].path).toBe(
      `/definitions/Deep/${POINTER_TRUNCATION_MARKER}${'/next/properties'.repeat(15)}/next/items`,
    );
  });
});

describe('upgradeSwagger2: paths and operations', () => {
  it('copy the operation fields, extensions included', () => {
    const op = {
      tags: ['t'],
      summary: 's',
      description: 'd',
      externalDocs: { url: 'u' },
      operationId: 'id',
      deprecated: true,
      security: [{ key: [] }],
      responses: { 200: ok },
      'x-op': { a: 1 },
    };
    const { doc } = run(withOperation(op));
    const { responses: _responses, ...rest } = op;

    expect(postOf({ doc })).toEqual({ ...rest, responses: { 200: { description: 'ok' } } });
    expect(postOf({ doc }).security).toBe(op.security);
  });

  it('list operations in the canonical method order and keep path item extensions', () => {
    const document = swagger({
      paths: {
        '/x': { patch: operation(), get: operation(), delete: operation(), 'x-path': 1 },
      },
    });

    expect(Object.keys(run(document).doc.paths['/x'])).toEqual(['get', 'patch', 'delete', 'x-path']);
  });

  it('do not convert trace, query or additionalOperations, which Swagger 2.0 lacks', () => {
    const document = swagger({
      paths: {
        '/x': { get: operation(), trace: operation(), query: operation(), additionalOperations: { LINK: operation() } },
      },
    });
    const { doc, diagnostics } = run(document);

    expect(Object.keys(doc.paths['/x'])).toEqual(['get']);
    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.FEATURE_NEWER_THAN_DECLARED_VERSION,
        message: 'The `trace` operation needs OpenAPI 3.0 or later and is not part of Swagger 2.0; it is not converted',
        path: '/paths/~1x/trace',
      },
      {
        severity: 'warning',
        code: C.FEATURE_NEWER_THAN_DECLARED_VERSION,
        message: 'The `query` operation needs OpenAPI 3.2 or later and is not part of Swagger 2.0; it is not converted',
        path: '/paths/~1x/query',
      },
      {
        severity: 'warning',
        code: C.FEATURE_NEWER_THAN_DECLARED_VERSION,
        message:
          'Path Item `additionalOperations` needs OpenAPI 3.2 or later and is not part of Swagger 2.0; it is not converted',
        path: '/paths/~1x/additionalOperations',
      },
    ]);
  });

  it('report operation and path item values that are not objects', () => {
    const document = swagger({ paths: { '/a': null, '/b': { get: 'nope', put: operation() }, '/c': undefined } });
    const { doc, diagnostics } = run(document);

    expect(Object.keys(doc.paths)).toEqual(['/b']);
    expect(Object.keys(doc.paths['/b'])).toEqual(['put']);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.PATH_ITEM_NOT_OBJECT, '/paths/~1a'],
      [C.OPERATION_NOT_OBJECT, '/paths/~1b/get'],
    ]);
  });

  it('copy paths extensions and convert other keys as paths', () => {
    const document = swagger({ paths: { 'x-paths': [1], 'no-slash': { get: operation() } } });

    expect(run(document).doc.paths).toEqual({ 'x-paths': [1], 'no-slash': { get: { responses: { 200: ok } } } });
  });

  it.each([[[]], ['paths'], [5]])('give no paths for paths %p', (paths) => {
    const result = run(swagger({ paths }));

    expect(result.doc.paths).toEqual({});
    expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([[C.SWAGGER_INVALID_VALUE, '/paths']]);
  });

  it('give no paths, silently, without paths', () => {
    const { paths: _paths, ...rest } = swagger();

    expect(run(rest)).toMatchObject({ document: { paths: {} }, diagnostics: [] });
  });

  it('report an unresolved path item reference and convert the fields beside it', () => {
    const document = swagger({ paths: { '/x': { $ref: 'other.yaml#/x', get: operation() } } });
    const { doc, diagnostics } = run(document);

    expect(doc.paths['/x']).toEqual({ get: { responses: { 200: ok } } });
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([[C.SWAGGER_UNRESOLVED_REFERENCE, '/paths/~1x/$ref']]);
  });

  it('report fields path items and operations do not have', () => {
    const document = swagger({ paths: { '/x': { summary: 's', servers: [], get: operation({ requestBody: {} }) } } });

    expect(run(document).diagnostics).toEqual([
      {
        severity: 'info',
        code: C.SWAGGER_UNKNOWN_FIELD,
        message:
          'A Path Item has 2 fields Swagger 2.0 does not define there ("summary", "servers"); they are not converted',
        path: '/paths/~1x',
      },
      {
        severity: 'info',
        code: C.SWAGGER_UNKNOWN_FIELD,
        message:
          'An Operation Object has a field Swagger 2.0 does not define there ("requestBody"); it is not converted',
        path: '/paths/~1x/get',
      },
    ]);
  });

  it('read __proto__ and constructor paths and methods as data', () => {
    const document = JSON.parse(
      '{"swagger":"2.0","info":{"title":"T","version":"1"},"host":"h","schemes":["https"],' +
        '"paths":{"__proto__":{"get":{"responses":{"200":{"description":"p"}}}},"/constructor":{"constructor":{}}}}',
    );
    const { doc, diagnostics } = run(document);

    expect(Object.keys(doc.paths)).toEqual(['__proto__', '/constructor']);
    expect(Object.getPrototypeOf(doc.paths)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(doc.paths, '__proto__')?.value.get.responses[200].description).toBe('p');
    expect(doc.paths['/constructor']).toEqual({});
    expect(codes(diagnostics)).toEqual([C.SWAGGER_UNKNOWN_FIELD]);
  });

  it('cap a pointer segment from a huge path key', () => {
    const key = `/${'p'.repeat(1_000_000)}`;
    const { diagnostics } = run(swagger({ paths: { [key]: { get: 'x' } } }));

    expect(diagnostics[0].path!.length).toBeLessThan(400);
    expect(diagnostics[0].path).toContain(POINTER_TRUNCATION_MARKER);
  });
});

describe('upgradeSwagger2: scale', () => {
  it('converts 100,000 operations sharing one parameter with one conversion', () => {
    const shared = { name: 'limit', in: 'query', type: 'integer', collectionFormat: 'tsv', 'x-unknown': 1, unknown: 2 };
    const response = { description: 'ok', schema: { type: 'string' } };
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 100_000; index++) {
      paths[`/p${index}`] = { get: { operationId: `op${index}`, parameters: [shared], responses: { 200: response } } };
    }

    const { doc, diagnostics } = run(swagger({ produces: ['application/json'], paths }));
    const converted = new Set(Object.values(doc.paths).map((item: any) => item.get.parameters[0]));
    const responses = new Set(Object.values(doc.paths).map((item: any) => item.get.responses[200]));

    expect(Object.keys(doc.paths)).toHaveLength(100_000);
    // One converted object each: the shared parameter and response were converted once, not once per operation
    expect(converted.size).toBe(1);
    expect(responses.size).toBe(1);
    expect([...converted][0]).toEqual({ name: 'limit', in: 'query', schema: { type: 'integer' }, 'x-unknown': 1 });
    // Diagnostics about the shared parameter are reported once
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      [C.SWAGGER_UNKNOWN_FIELD, '/paths/~1p0/get/parameters/0'],
    ]);
  });

  it('handles huge strings in media types and names without slowing down', () => {
    const huge = `application/${'x'.repeat(1_000_000)}`;
    const shared = { name: 'b', in: 'body', schema: { type: 'string' } };
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 1000; index++) {
      paths[`/p${index}`] = {
        post: { parameters: [shared], responses: { 200: { description: 'ok', schema: {}, examples: { [huge]: 1 } } } },
      };
    }

    const started = Date.now();
    const { doc } = run(swagger({ consumes: [huge], produces: [huge], paths }));

    expect(Object.keys(doc.paths['/p999'].post.requestBody.content)).toEqual([huge]);
    expect(doc.paths['/p999'].post.responses[200].content[huge].example).toBe(1);
    // A hang backstop only (a few hundred ms, instrumented for coverage): work quadratic in the 1 MB media type
    // would not finish
    expect(Date.now() - started).toBeLessThan(20_000);
  });
});

describe('upgradeSwagger2: bounded output (review round 2)', () => {
  /** Media type, encoding and header entries and form properties of the converted document, each map counted once. */
  const countEntries = (document: unknown): { content: number; encoding: number; headers: number; properties: number } => {
    const counts = { content: 0, encoding: 0, headers: 0, properties: 0 };
    const seen = new Set<object>();
    const stack: Array<[unknown, string]> = [[document, '']];
    while (stack.length > 0) {
      const [node, key] = stack.pop()!;
      if (node === null || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      const size = Object.keys(node).length;
      if (key === 'content' || key === 'encoding' || key === 'headers') counts[key] += size;
      if (key === 'properties') counts.properties += size;
      for (const [child, value] of Object.entries(node)) stack.push([value, child]);
    }
    return counts;
  };
  const types = (count: number, prefix = 'application/vnd.t') => Array.from({ length: count }, (_, i) => `${prefix}${i}+json`);

  it('keeps the first MAX_MEDIA_TYPES_PER_LIST media types of a list: N operations x M types stays N x 32', () => {
    const n = 3000;
    const m = 3000;
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      paths[`/p${i}`] = {
        post: {
          parameters: [{ name: 'b', in: 'body', schema: { type: 'object' } }],
          responses: { 200: { description: 'ok', schema: { type: 'string' } } },
        },
      };
    }
    const result = run(swagger({ consumes: types(m), produces: [...types(m), ...types(10)], paths }));

    expect(MAX_MEDIA_TYPES_PER_LIST).toBe(32);
    expect(countEntries(result.doc)).toEqual({ content: 2 * n * 32, encoding: 0, headers: 0, properties: 0 });
    expect(Object.keys(result.doc.paths['/p0'].post.requestBody.content)).toEqual(types(32));
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_MEDIA_TYPE_LIMIT,
        message:
          '2 `consumes` or `produces` lists hold more than 32 distinct media types: the first 32 of each are kept ' +
          'and 5936 are ignored',
        path: '/consumes',
      },
    ]);
    const one = run(swagger({ consumes: [...types(33), ...types(33)] }));
    expect(one.diagnostics[0].message).toBe(
      'A `consumes` or `produces` list holds more than 32 distinct media types: the first 32 of each are kept and 1 is ignored',
    );
  });

  it('shares one encoding map between the urlencoded media types of a form: 7 x 1000 path-level fields stay linear', () => {
    const fields = Array.from({ length: 1000 }, (_, i) => ({
      name: `f${i}`,
      in: 'formData',
      type: 'array',
      items: { type: 'string' },
    }));
    const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];
    const item: Record<string, unknown> = { parameters: fields };
    for (const method of methods) item[method] = operation();
    const result = run(swagger({ consumes: types(1000, 'application/x-www-form-urlencoded;v='), paths: { '/x': item } }));

    expect(countEntries(result.doc)).toEqual({ content: 7 * 32, encoding: 7 * 1000, headers: 0, properties: 7 * 1000 });
    const content = result.doc.paths['/x'].post.requestBody.content;
    const encodings = new Set(Object.values(content).map((media: any) => media.encoding));
    expect(encodings.size).toBe(1);
  });

  it('bounds global request bodies and responses the same way', () => {
    const parameters: Record<string, unknown> = {};
    const responses: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      parameters[`B${i}`] = { name: 'b', in: 'body', schema: { type: 'object' } };
      responses[`R${i}`] = { description: 'r', schema: { type: 'string' }, headers: { 'X-A': { type: 'string' } } };
    }
    const result = run(swagger({ consumes: types(500), produces: types(500), parameters, responses }));

    expect(countEntries(result.doc)).toEqual({ content: 2 * 500 * 32, encoding: 0, headers: 500, properties: 0 });
  });

  it('abandons a conversion past maxEntries, without paths, and says so', () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      // Each operation its own produces list: the shared responses convert once per list
      paths[`/p${i}`] = { get: { produces: types(32), responses: { 200: { description: 'ok', schema: { type: 'string' } } } } };
    }
    const result = upgradeSwagger2(swagger({ paths }), { maxEntries: 1000 });

    expect(result.tooLarge).toBe(true);
    expect(result.document).toEqual({ openapi: UPGRADED_OPENAPI_VERSION, info: { title: 'T', version: '1' }, paths: {} });
    expect(result.diagnostics.at(-1)).toEqual({
      severity: 'warning',
      code: C.SWAGGER_CONVERSION_TOO_LARGE,
      message:
        'Converting the document needs more than 1000 media type, encoding, header and form property entries (a 2.0 ' +
        '`consumes`, `produces` or path-level parameter applies to every operation, and the OpenAPI 3.0 form repeats ' +
        'it in each); the conversion is abandoned and the document is returned without paths',
      path: '',
    });
    // Within the budget: converted
    expect(upgradeSwagger2(swagger({ paths }), { maxEntries: 3200 }).tooLarge).toBeUndefined();
    // maxEntries is capped at MAX_CONVERSION_ENTRIES and read as the default when it is not a positive number
    for (const maxEntries of [0, -1, Number.NaN, '5', MAX_CONVERSION_ENTRIES * 10]) {
      expect(upgradeSwagger2(swagger({ paths }), { maxEntries } as any).tooLarge).toBeUndefined();
    }
    expect(MAX_CONVERSION_ENTRIES).toBe(1_000_000);
    // A document that is not an object has no info to keep
    expect(upgradeSwagger2('x', { maxEntries: 1 }).tooLarge).toBeUndefined();
  });

  it('reads null or malformed options as absent', () => {
    for (const options of [null, 'x', 3, [], { documentUri: 7, maxEntries: null }]) {
      const result = upgradeSwagger2(swagger({ host: undefined }), options as any);
      expect(result.doc ?? result.document).toMatchObject({ servers: [{ url: '/' }] });
    }
  });

  it('gives the source index of each converted parameter', () => {
    const body = { name: 'b', in: 'body', schema: {} };
    const form = { name: 'f', in: 'formData', type: 'string' };
    const query = (name: string) => ({ name, in: 'query', type: 'string' });
    const result = run(
      swagger({
        paths: {
          '/x': {
            parameters: [form, query('p'), 'bad', query('q')],
            put: operation({ parameters: [body, query('a'), query('b')] }),
          },
        },
      }),
    );

    expect(result.parameterIndexes.get(result.doc.paths['/x'].parameters)).toEqual([1, 3]);
    expect(result.parameterIndexes.get(result.doc.paths['/x'].put.parameters)).toEqual([1, 2]);
    expect(result.parameterIndexes.get(result.doc.paths['/x'])).toBeUndefined();
  });

  it('keeps securitySchemes, empty, when no definition could be converted', () => {
    const result = run(swagger({ securityDefinitions: { k: { type: 'mutualTLS' } }, security: [{ k: [] }] }));

    expect(result.doc.components).toEqual({ securitySchemes: {} });
    expect(codes(result.diagnostics)).toEqual([C.SWAGGER_UNSUPPORTED_SECURITY_SCHEME]);
    expect(run(swagger({ securityDefinitions: {} })).doc.components).toEqual({ securitySchemes: {} });
    expect(run(swagger({ securityDefinitions: 'x' })).doc.components).toEqual({ securitySchemes: {} });
  });

  it('reports a finding of one kind once, however deep or often', () => {
    // A 1000-deep Items chain with a collectionFormat at every level
    const chain = (format: string) => {
      let items: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 1000; i++) items = { type: 'array', items, collectionFormat: format };
      return run(withOperation(operation({ parameters: [{ name: 'a', in: 'query', type: 'array', items }] })));
    };
    const result = chain('pipes');

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].code).toBe(C.SWAGGER_UNSUPPORTED_COLLECTION_FORMAT);
    expect(result.diagnostics[0].message).toMatch(
      /it is ignored \(in 1000 places: \/paths\/~1x\/post\/parameters\/0\/items\/collectionFormat, .* and 997 more\)$/,
    );
    // A nested `csv` is the default: nothing to report
    expect(chain('csv').diagnostics).toEqual([]);
    // A place longer than 256 characters is cut in the message
    const key = `/${'k'.repeat(400)}`;
    const long = run(swagger({ paths: { [key]: { get: operation({ parameters: [{ name: 'a', in: 'query', type: 'file' }] }) }, [`${key}2`]: { get: operation({ parameters: [{ name: 'a', in: 'query', type: 'file' }] }) } } }));
    expect(long.diagnostics).toHaveLength(1);
    expect(long.diagnostics[0].message).toContain(`${'k'.repeat(240)}`);
    expect(long.diagnostics[0].message).toMatch(/k\.\.\., \/paths\//);
  });
});

describe('upgradeSwagger2: path parameters (review round 2)', () => {
  it.each([[undefined], [false], ['yes']])('converts a path parameter with required %p as required, saying so', (required) => {
    const parameter: Record<string, unknown> = { name: 'id', in: 'path', type: 'string' };
    if (required !== undefined) parameter['required'] = required;
    const result = run(swagger({ paths: { '/x/{id}': { get: operation({ parameters: [parameter] }) } } }));

    expect(result.doc.paths['/x/{id}'].get.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: C.SWAGGER_INVALID_VALUE,
        message: `A path parameter must be required (\`required: true\`), found ${required === undefined ? 'undefined' : JSON.stringify(required)}; it is converted as required`,
        path: '/paths/~1x~1{id}/get/parameters/0/required',
      },
    ]);
  });

  it('says nothing for a path parameter that is required', () => {
    const result = run(swagger({ paths: { '/x/{id}': { get: operation({ parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }] }) } } }));

    expect(result.diagnostics).toEqual([]);
  });
});
