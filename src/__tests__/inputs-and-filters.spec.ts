import { GenerationError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import { ParameterResolver } from '../parameter-resolver';
import { buildHttpRequest } from '../request-builder';

const ok = { 200: { description: 'ok' } };
const stringSchema = { type: 'string' };

async function onlyTool(document: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const generator = await OpenAPIToolGenerator.fromJSON(
    {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      servers: [{ url: 'https://api.example.test' }],
      ...document,
    },
    { validate: false },
  );
  const [tool] = await generator.generateTools(options);
  return { tool, codes: generator.getDiagnostics().map((diagnostic) => diagnostic.code) };
}

describe('every input key names one value in one place', () => {
  it('a renamed parameter never takes the name of another input', async () => {
    const { tool } = await onlyTool({
      paths: {
        '/orders': {
          post: {
            operationId: 'order',
            parameters: [
              { name: 'X-Role', in: 'header', schema: { type: 'string', enum: ['user'] } },
              { name: 'X-Role', in: 'query', schema: stringSchema },
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { 'headerX-Role': stringSchema, item: stringSchema } },
                },
              },
            },
            responses: ok,
          },
        },
      },
    });
    const keys = tool.mapper.map((entry) => entry.inputKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of tool.mapper) {
      expect(tool.inputSchema.properties?.[entry.inputKey]).toMatchObject({ 'x-parameter-location': entry.type });
    }
    const built = buildHttpRequest(tool, { 'headerX-Role': 'admin', item: 'book' });
    expect(built.headers['X-Role']).toBeUndefined();
  });

  it('a security scheme never shares an input key with a parameter', async () => {
    const { tool } = await onlyTool({
      components: { securitySchemes: { api_key: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
      paths: {
        '/reports/{id}': {
          get: {
            operationId: 'report',
            security: [{ api_key: [] }],
            parameters: [
              { name: 'id', in: 'path', required: true, schema: stringSchema },
              { name: 'api_key', in: 'query', schema: stringSchema },
            ],
            responses: ok,
          },
        },
      },
    });
    const keys = tool.mapper.map((entry) => entry.inputKey);
    expect(new Set(keys).size).toBe(keys.length);
    const credential = tool.mapper.find((entry) => entry.security)!;
    const built = buildHttpRequest(tool, { id: '7', [credential.inputKey]: 'SYNTH-KEY' });
    expect(built.url).toBe('https://api.example.test/reports/7');
    expect(built.headers['X-API-Key']).toBe('SYNTH-KEY');
  });

  it('a scheme named in two alternative requirements is one input', async () => {
    const { tool } = await onlyTool(
      {
        components: {
          securitySchemes: {
            key: { type: 'apiKey', in: 'header', name: 'X-Key' },
            tok: { type: 'http', scheme: 'bearer' },
          },
        },
        paths: { '/p': { get: { operationId: 'p', security: [{ key: [] }, { key: [], tok: [] }], responses: ok } } },
      },
      { includeSecurityInInput: true },
    );
    expect(tool.inputSchema.required).toBeUndefined();
    expect(tool.mapper.filter((entry) => entry.security).map((entry) => entry.security?.alternatives)).toEqual([
      [0, 1],
      [1],
    ]);
  });
});

describe('a parameter cannot stand in for a credential or for a header the client owns', () => {
  const credentialDocument = (parameters: unknown[]) => ({
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        queryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
        session: { type: 'apiKey', in: 'cookie', name: 'sid' },
      },
    },
    paths: {
      '/notes': {
        post: {
          operationId: 'notes',
          security: [{ bearer: [], queryKey: [], session: [] }],
          parameters,
          responses: ok,
        },
      },
    },
  });

  it.each([
    [
      'a header named like the credential header, in another case',
      { name: 'authorization', in: 'header', schema: stringSchema },
    ],
    ['a query parameter named like a query credential', { name: 'api_key', in: 'query', schema: stringSchema }],
    ['a cookie named like a cookie credential', { name: 'sid', in: 'cookie', schema: stringSchema }],
  ])('drops %s, with a diagnostic', async (_label, parameter) => {
    const { tool, codes } = await onlyTool(
      credentialDocument([parameter, { name: 'note', in: 'query', schema: stringSchema }]),
    );
    const nonCredential = tool.mapper.filter((entry) => !entry.security).map((entry) => entry.key);
    expect(nonCredential).toEqual(['note']);
    expect(codes).toContain('PARAMETER_IGNORED');
  });

  it.each([
    'Host',
    'Content-Length',
    'Transfer-Encoding',
    'Connection',
    'Cookie',
    'Accept',
    'Content-Type',
    'Authorization',
    'X-HTTP-Method-Override',
    'X-Forwarded-For',
    'Forwarded',
  ])('ignores a header parameter named %s, with a diagnostic', async (name) => {
    const { tool, codes } = await onlyTool({
      paths: {
        '/p': {
          post: {
            operationId: 'p',
            parameters: [
              { name, in: 'header', schema: stringSchema },
              { name: 'X-Trace', in: 'header', schema: stringSchema },
            ],
            responses: ok,
          },
        },
      },
    });
    expect(tool.mapper.map((entry) => entry.key)).toEqual(['X-Trace']);
    expect(codes).toContain('PARAMETER_IGNORED');
  });
});

describe('ParameterResolver reads parameter names as generation does', () => {
  const resolver = new ParameterResolver();

  it('reads a number or boolean name as its text', () => {
    const { mapper } = resolver.resolve(
      { parameters: [{ name: 2024, in: 'header', schema: {} }, { name: true, in: 'query', schema: {} }] },
      [{ name: 2024, in: 'header', schema: { type: 'string' } }],
    );
    expect(mapper.map((entry) => [entry.key, entry.inputKey])).toEqual([
      ['2024', '2024'],
      ['true', 'true'],
    ]);
  });

  it.each([{}, [], '', null])('refuses a parameter named %p', (name) => {
    const failure = (() => {
      try {
        return resolver.resolve({ parameters: [{ name, in: 'header', schema: {} }] });
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(GenerationError);
    expect((failure as GenerationError).context).toEqual({ code: 'INVALID_PARAMETER_NAME' });
  });
});

describe('path filters compare the path a client sends', () => {
  const document = {
    paths: {
      '/%61dmin/users': { get: { operationId: 'encodedAdmin', responses: ok } },
      '/public/status': { get: { operationId: 'status', responses: ok } },
    },
  };

  it('excludePaths matches a path key with percent-encoded unreserved characters', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      { openapi: '3.0.3', info: { title: 't', version: '1' }, ...document },
      { validate: false },
    );
    const tools = await generator.generateTools({ excludePaths: ['/admin/**'] });
    expect(tools.map((tool) => tool.name)).toEqual(['status']);
  });

  it.each([['/%61dmin/**'], ['/files/a%2fb'], ['/files/a%2Fb']])('a glob written %s is read the same way', async (glob) => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: { ...document.paths, '/files/a%2fb': { get: { operationId: 'file', responses: ok } } },
      },
      { validate: false },
    );
    const kept = await generator.generateTools({ includePaths: [glob] });
    const left = await generator.generateTools({ excludePaths: [glob] });
    expect(kept).toHaveLength(1);
    expect(left).toHaveLength(2);
  });
});

describe('readOnlyOnly decides from the method, which an extension can only narrow', () => {
  const document = {
    paths: {
      '/items': {
        get: { operationId: 'listItems', responses: ok },
        post: { operationId: 'searchItems', 'x-mcp': { annotations: { readOnlyHint: true } }, responses: ok },
      },
      '/items/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: stringSchema }],
        delete: { operationId: 'deleteItem', 'x-mcp': { annotations: { readOnlyHint: true } }, responses: ok },
        get: { operationId: 'getItem', 'x-mcp': { annotations: { readOnlyHint: false } }, responses: ok },
      },
    },
  };

  it('keeps only safe methods that no extension marks as writing', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      { openapi: '3.0.3', info: { title: 't', version: '1' }, ...document },
      { validate: false },
    );
    const tools = await generator.generateTools({ readOnlyOnly: true });
    expect(tools.map((tool) => tool.name)).toEqual(['listItems']);
  });
});
