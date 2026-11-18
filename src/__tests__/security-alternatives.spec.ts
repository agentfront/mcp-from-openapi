import { OpenAPIToolGenerator } from '../generator';
import { SecurityResolver } from '../security-resolver';
import type { McpOpenAPITool } from '../types';

const ok = { 200: { description: 'ok' } };
const info = { title: 't', version: '1' };
const schemes = {
  partnerKey: { type: 'apiKey', in: 'header', name: 'X-Partner-Key' },
  userToken: { type: 'http', scheme: 'bearer' },
};

async function toolFor(security: unknown[], options: Record<string, unknown> = {}): Promise<McpOpenAPITool> {
  const generator = await OpenAPIToolGenerator.fromJSON({
    openapi: '3.0.3',
    info,
    servers: [{ url: 'https://api.example.test' }],
    components: { securitySchemes: schemes },
    paths: { '/p': { get: { operationId: 'p', security, responses: ok } } },
  });
  const [tool] = await generator.generateTools(options);
  return tool;
}

const credentials = (tool: McpOpenAPITool) =>
  tool.mapper
    .filter((entry) => entry.security)
    .map((entry) => ({
      scheme: entry.security?.scheme,
      required: entry.required,
      alternatives: entry.security?.alternatives,
      optional: entry.security?.optional,
    }));

describe('alternative security requirements stay a choice', () => {
  it('keeps schemes required together as before', async () => {
    const tool = await toolFor([{ partnerKey: [], userToken: [] }]);
    expect(tool.metadata.securityAlternatives).toBeUndefined();
    expect(credentials(tool)).toEqual([
      { scheme: 'partnerKey', required: true, alternatives: undefined, optional: undefined },
      { scheme: 'userToken', required: true, alternatives: undefined, optional: undefined },
    ]);
  });

  it('describes a choice between requirements', async () => {
    const tool = await toolFor([{ partnerKey: [] }, { userToken: [] }]);
    expect(tool.metadata.securityAlternatives?.map((alternative) => alternative.map((s) => s.scheme))).toEqual([
      ['partnerKey'],
      ['userToken'],
    ]);
    expect(credentials(tool)).toEqual([
      { scheme: 'partnerKey', required: false, alternatives: [0], optional: undefined },
      { scheme: 'userToken', required: false, alternatives: [1], optional: undefined },
    ]);
  });

  it('marks a choice that includes no authentication as optional', async () => {
    const tool = await toolFor([{}, { userToken: [] }]);
    expect(tool.metadata.securityAlternatives?.map((alternative) => alternative.map((s) => s.scheme))).toEqual([
      [],
      ['userToken'],
    ]);
    expect(credentials(tool)).toEqual([{ scheme: 'userToken', required: false, alternatives: [1], optional: true }]);
  });

  it('lists every alternative a scheme belongs to', async () => {
    const tool = await toolFor([{ partnerKey: [] }, { partnerKey: [], userToken: [] }]);
    expect(credentials(tool)[0]).toMatchObject({ scheme: 'partnerKey', alternatives: [0, 1] });
  });

  it('does not require a credential input that is one of a choice', async () => {
    const tool = await toolFor([{ partnerKey: [] }, { userToken: [] }], { includeSecurityInInput: true });
    expect(tool.inputSchema.required).toBeUndefined();
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['partnerKey', 'userToken']);
  });
});

describe('SecurityResolver applies one alternative', () => {
  const resolver = new SecurityResolver();
  const both = { apiKeys: { 'X-Partner-Key': 'SYNTH-PARTNER' }, jwt: 'SYNTH-USER' };

  it('sends only the first alternative whose credentials are all available', async () => {
    const tool = await toolFor([{ partnerKey: [] }, { userToken: [] }]);
    expect((await resolver.resolve(tool.mapper, both)).headers).toEqual({ 'X-Partner-Key': 'SYNTH-PARTNER' });
    expect((await resolver.resolve(tool.mapper, { jwt: 'SYNTH-USER' })).headers).toEqual({
      Authorization: 'Bearer SYNTH-USER',
    });
  });

  it('reports nothing missing while one alternative can be satisfied', async () => {
    const tool = await toolFor([{ partnerKey: [] }, { userToken: [] }]);
    expect(await resolver.checkMissingSecurity(tool.mapper, { jwt: 'SYNTH-USER' })).toEqual([]);
    expect(await resolver.checkMissingSecurity(tool.mapper, {})).toEqual(['partnerKey', 'userToken']);
  });

  it('reports nothing missing for an operation that also accepts no authentication', async () => {
    const tool = await toolFor([{}, { userToken: [] }]);
    expect(await resolver.checkMissingSecurity(tool.mapper, {})).toEqual([]);
    expect((await resolver.resolve(tool.mapper, { jwt: 'SYNTH-USER' })).headers).toEqual({
      Authorization: 'Bearer SYNTH-USER',
    });
  });

  it('sends nothing of an alternative it can only partly fill', async () => {
    const tool = await toolFor([
      { partnerKey: [], userToken: [] },
      { userToken: [], partnerKey: [] },
    ]);
    expect((await resolver.resolve(tool.mapper, { jwt: 'SYNTH-USER' })).headers).toEqual({});
  });
});

describe('a security scheme map that is present but not a map defines no scheme', () => {
  const required = { get: { operationId: 'p', security: [{ key: [] }], responses: ok } };

  it.each([null, 0, [], 'x'])('OpenAPI 3: %p', async (map) => {
    const document = { openapi: '3.0.3', info, components: { securitySchemes: map }, paths: { '/p': required } };
    const validated = await (await OpenAPIToolGenerator.fromJSON(document)).validate();
    expect(validated.errors?.map((error) => [error.code, error.path])).toEqual([
      ['INVALID_SECURITY_SCHEME', '/components/securitySchemes'],
    ]);
    const generator = await OpenAPIToolGenerator.fromJSON(document, { validate: false });
    await expect(generator.generateTools()).resolves.toEqual([]);
    expect(generator.getDiagnostics().map((diagnostic) => diagnostic.code)).toContain('UNSATISFIABLE_SECURITY');
  });

  it.each([null, 0, [], 'x'])('Swagger 2.0: %p', async (map) => {
    const document = {
      swagger: '2.0',
      info,
      host: 'api.example.test',
      securityDefinitions: map,
      paths: { '/p': required },
    };
    const validated = await (await OpenAPIToolGenerator.fromJSON(document)).validate();
    expect(validated.errors?.map((error) => [error.code, error.path])).toEqual([
      ['INVALID_SECURITY_SCHEME', '/securityDefinitions'],
    ]);
    const generator = await OpenAPIToolGenerator.fromJSON(document, { validate: false });
    await expect(generator.generateTools()).resolves.toEqual([]);
    expect(generator.getDiagnostics().map((diagnostic) => diagnostic.code)).toContain('UNSATISFIABLE_SECURITY');
  });

  it('still generates an unsecured tool when the document defines no scheme map at all', async () => {
    const document = { openapi: '3.0.3', info, paths: { '/p': required } };
    const generator = await OpenAPIToolGenerator.fromJSON(document, { validate: false });
    await expect(generator.generateTools()).resolves.toHaveLength(1);
  });
});
