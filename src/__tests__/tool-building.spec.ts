import { ParseError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';

const ok = { 200: { description: 'ok' } };
const info = { title: 't', version: '1' };

function documentWith(paths: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { openapi: '3.0.3', info, servers: [{ url: 'https://api.example.test' }], paths, ...extra };
}

async function generate(document: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const generator = await OpenAPIToolGenerator.fromJSON(document, { validate: false, ...options });
  const tools = await generator.generateTools({ includeExamples: true });
  return { tools, codes: generator.getDiagnostics().map((diagnostic) => diagnostic.code), generator };
}

describe('a path item that is a reference', () => {
  it('reports one that was not read and makes no tools of it', async () => {
    const document = documentWith({
      '/p': { $ref: 'https://elsewhere.example.test/p.json' },
      '/q': { get: { operationId: 'q', responses: ok } },
    });
    const { tools, generator } = await generate(document, { secureDefaults: true });
    expect(tools.map((tool) => tool.name)).toEqual(['q']);
    expect(generator.getDiagnostics()).toEqual([
      expect.objectContaining({ code: 'UNRESOLVED_REFERENCE', path: '/paths/~1p' }),
    ]);
  });

  it('reads one whose $ref is not a string as a path item', async () => {
    const { tools } = await generate(documentWith({ '/p': { $ref: 5, get: { operationId: 'p', responses: ok } } }));
    expect(tools.map((tool) => tool.name)).toEqual(['p']);
    const lint = await (
      await OpenAPIToolGenerator.fromJSON(documentWith({ '/p': { $ref: 5, get: { responses: ok } } }))
    ).lint();
    expect(lint.findings.map((finding) => finding.code)).toContain('missing-operation-id');
  });
});

describe('loading', () => {
  it('reads null options as none', async () => {
    const document = documentWith({ '/p': { get: { operationId: 'p', responses: ok } } });
    await expect(OpenAPIToolGenerator.fromJSON(document, null as never)).resolves.toBeInstanceOf(OpenAPIToolGenerator);
    await expect(OpenAPIToolGenerator.fromYAML(JSON.stringify(document), null as never)).resolves.toBeInstanceOf(
      OpenAPIToolGenerator,
    );
  });

  it('bounds the path of a reference that cannot be read', async () => {
    let node: Record<string, unknown> = { $ref: 'https://elsewhere.example.test/x.json' };
    for (let level = 0; level < 40; level++) node = { [`k${level}${'x'.repeat(250)}`]: node };
    const document = documentWith({ '/p': { get: { operationId: 'p', responses: ok } } }, { 'x-deep': node });
    const generator = await OpenAPIToolGenerator.fromJSON(document, {
      refResolution: { allowedHosts: ['nothing.example'] },
    });
    const failure = (await generator.generateTools().catch((error: unknown) => error)) as ParseError;
    expect(failure).toBeInstanceOf(ParseError);
    expect(String(failure.context?.['path']).length).toBeLessThanOrEqual(259);
  });
});

describe('tools carry what the request can send', () => {
  it('makes a tool of an operation whose request body has no media type', async () => {
    const { tools } = await generate(
      documentWith({ '/p': { post: { operationId: 'p', requestBody: { content: {} }, responses: ok } } }),
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].mapper).toEqual([]);
  });

  it('sends to the servers of the path item before the document servers', async () => {
    const { tools } = await generate(
      documentWith({
        '/p': { servers: [{ url: 'https://path.example.test' }], get: { operationId: 'p', responses: ok } },
        '/q': {
          servers: 'x',
          get: { operationId: 'q', servers: [null, { url: 'https://op.example.test' }], responses: ok },
        },
      }),
    );
    expect(tools.map((tool) => tool.metadata.servers?.map((server) => server.url))).toEqual([
      ['https://path.example.test'],
      ['https://op.example.test'],
    ]);
  });

  it('requires a path parameter, whatever it says', async () => {
    const { tools } = await generate(
      documentWith({
        '/p/{id}': {
          get: {
            operationId: 'p',
            parameters: [{ name: 'id', in: 'path', required: false, schema: {} }],
            responses: ok,
          },
        },
      }),
    );
    expect(tools[0].inputSchema.required).toEqual(['id']);
  });

  it('reads parameter fields by their type', async () => {
    const parameter = {
      name: 'q',
      in: 'query',
      required: 'no',
      description: { text: 'x' },
      schema: 'abc',
      deprecated: 'yes',
    };
    const { tools } = await generate(
      documentWith({
        '/p': { get: { operationId: 'p', deprecated: 'false', parameters: [parameter], responses: ok } },
      }),
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].inputSchema.required).toBeUndefined();
    expect(tools[0].inputSchema.properties?.['q']).toEqual({ type: 'string', 'x-parameter-location': 'query' });
  });

  it('never takes the annotations it writes from the document', async () => {
    const schema = {
      type: 'string',
      'x-mcp-header': 'Authorization',
      'x-parameter-style': 'matrix',
      'x-parameter-explode': true,
      'x-parameter-content-type': 'text/plain',
      'x-parameter-whole-query': true,
      'x-other': 1,
    };
    const { tools } = await generate(
      documentWith({
        '/p': { get: { operationId: 'p', parameters: [{ name: 'q', in: 'query', schema }], responses: ok } },
      }),
    );
    expect(tools[0].inputSchema.properties?.['q']).toEqual({
      type: 'string',
      'x-other': 1,
      'x-parameter-location': 'query',
    });
  });

  it('distributes media examples by own key only', async () => {
    const body = {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object', properties: { constructor: { type: 'string' }, toString: { type: 'string' } } },
          example: { constructor: 'a' },
        },
      },
    };
    const { tools } = await generate(
      documentWith({ '/p': { post: { operationId: 'p', requestBody: body, responses: ok } } }),
    );
    expect(() => structuredClone(tools[0])).not.toThrow();
    expect(tools[0].inputSchema.properties?.['toString']).not.toHaveProperty('examples');
  });
});

describe('an operation security that is not a list', () => {
  const schemes = {
    components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
    security: [{ key: [] }],
  };

  it.each([false, 0, '', {}, 'x'])('leaves the document requirements in force for %p', async (security) => {
    const { tools, codes } = await generate(
      documentWith({ '/p': { get: { operationId: 'p', security, responses: ok } } }, schemes),
    );
    expect(tools[0].mapper.map((entry) => entry.security?.scheme)).toEqual(['key']);
    expect(codes).toContain('INVALID_SECURITY_REQUIREMENT');
  });
});

describe('lint reads parameters as generation does', () => {
  it('reads a number name as its text, so an operation overrides the path-level parameter', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      documentWith({
        '/p': {
          parameters: [{ name: 2024, in: 'query', schema: {} }],
          get: {
            operationId: 'p',
            summary: 'Read p for the year',
            parameters: [{ name: 2024, in: 'query', description: 'Year', schema: {} }],
            responses: ok,
          },
        },
      }),
      { validate: false },
    );
    expect((await generator.lint()).findings.map((finding) => finding.code)).not.toContain(
      'missing-parameter-description',
    );
  });
});
