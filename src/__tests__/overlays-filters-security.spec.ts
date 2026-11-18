import { OpenAPIToolGenerator } from '../generator';
import { applyOverlay } from '../overlay';
import { Validator } from '../validator';

const operation = (operationId: string | undefined) => ({
  ...(operationId === undefined ? {} : { operationId }),
  responses: { 200: { description: 'ok' } },
});

describe('overlay updates are copied into every target', () => {
  const document = () => ({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {
      '/public/status': { get: operation('getStatus') },
      '/users/one': { delete: operation('deleteUser') },
      '/admin/wipe': { post: operation('wipeEverything') },
    },
  });
  const overlay = () => ({
    overlay: '1.0.0',
    info: { title: 'curation', version: '1' },
    actions: [
      { target: '$.paths.*.*', update: { 'x-mcp': { enabled: false } } },
      { target: "$.paths['/public/status'].get", update: { 'x-mcp': { enabled: true } } },
    ],
  });

  it('enables only the operation the second action names', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document(), { overlays: [overlay()] });
    const tools = await generator.generateTools();
    expect(tools.map((tool) => tool.name)).toEqual(['getStatus']);
  });

  it('leaves the caller overlay unchanged, so it can be applied again', () => {
    const curation = overlay();
    const before = JSON.stringify(curation);
    applyOverlay(document(), curation);
    expect(JSON.stringify(curation)).toBe(before);
    const second = applyOverlay(document(), curation) as ReturnType<typeof document>;
    expect(second.paths['/users/one'].delete).toMatchObject({ 'x-mcp': { enabled: false } });
  });

  it('gives each target its own object, also when an update is appended to arrays or replaces a value', () => {
    const result = applyOverlay(
      { a: { list: [] as unknown[] }, b: { list: [] as unknown[] }, c: { value: 1 }, d: { value: 2 } },
      {
        actions: [
          { target: '$.*.list', update: { tag: 'x' } },
          { target: '$.*.value', update: { replaced: true } },
        ],
      },
    );
    expect(result.a.list[0]).not.toBe(result.b.list[0]);
    expect(result.c.value).not.toBe(result.d.value);
    (result.a.list[0] as Record<string, string>).tag = 'changed';
    expect(result.b.list[0]).toEqual({ tag: 'x' });
  });
});

describe('includeOperations is an allow-list', () => {
  const document = {
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {
      '/users': { get: operation('listUsers') },
      '/users/{id}': {
        get: {
          ...operation('getUser'),
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
        delete: {
          ...operation(undefined),
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        },
      },
      '/admin/wipe': { post: operation(undefined) },
    },
  };

  it('leaves out operations without an operationId', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document);
    const tools = await generator.generateTools({ includeOperations: ['listUsers', 'getUser'] });
    expect(tools.map((tool) => tool.name).sort()).toEqual(['getUser', 'listUsers']);
  });

  it('an empty list allows nothing', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document);
    await expect(generator.generateTools({ includeOperations: [] })).resolves.toEqual([]);
  });

  it('the validator warns about a repeated operationId', async () => {
    const result = await new Validator().validate({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: { '/a': { get: operation('same') }, '/b': { delete: operation('same') } },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DUPLICATE_OPERATION_ID', path: '/paths/~1b/delete/operationId' }),
      ]),
    );
  });

  it('a repeated operationId is reported as a generation diagnostic', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: { '/a': { get: operation('same') }, '/b': { delete: operation('same') } },
    });
    await generator.generateTools();
    expect(generator.getDiagnostics().map((diagnostic) => diagnostic.code)).toContain('DUPLICATE_OPERATION_ID');
  });
});

describe('security scopes of one scheme named twice are merged in linear time', () => {
  it('merges 6,000 scopes per key across 400 operations quickly and keeps them all', async () => {
    const scopeCount = 6_000;
    const requirement = {
      s: Array.from({ length: scopeCount }, (_, index) => `a${index}`),
      '#/components/securitySchemes/s': Array.from({ length: scopeCount }, (_, index) => `b${index}`),
    };
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 400; index++) paths[`/p${index}`] = { get: operation(`o${index}`) };
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.2.0',
      info: { title: 't', version: '1' },
      servers: [{ url: 'https://api.example.test' }],
      security: [requirement],
      components: {
        securitySchemes: {
          s: {
            type: 'oauth2',
            flows: { clientCredentials: { tokenUrl: 'https://api.example.test/token', scopes: {} } },
          },
        },
      },
      paths,
    });
    const started = Date.now();
    const tools = await generator.generateTools();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(tools).toHaveLength(400);
    expect(tools[0].metadata.security?.[0]?.scopes).toHaveLength(scopeCount * 2);
  }, 30000);
});
