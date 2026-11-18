import { OpenAPIToolGenerator } from '../generator';
import { ParameterResolver } from '../parameter-resolver';
import { buildHttpRequest } from '../request-builder';
import { SecurityResolver } from '../security-resolver';
import type { McpOpenAPITool, SecurityRequirement } from '../types';

const ok = { 200: { description: 'ok' } };
const info = { title: 't', version: '1' };
const schemes = {
  partnerKey: { type: 'apiKey', in: 'header', name: 'X-Partner-Key' },
  userToken: { type: 'http', scheme: 'bearer' },
  oauth: {
    type: 'oauth2',
    flows: { clientCredentials: { tokenUrl: 'https://auth.example.test/token', scopes: { read: 'r', admin: 'a' } } },
  },
  certificate: { type: 'mutualTLS' },
  hmacPrimary: { type: 'http', scheme: 'hmac-primary' },
  hmacBackup: { type: 'http', scheme: 'hmac-backup' },
};

async function toolFor(security: unknown[], options: Record<string, unknown> = {}): Promise<McpOpenAPITool> {
  const generator = await OpenAPIToolGenerator.fromJSON({
    openapi: '3.1.0',
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

describe('each alternative asks for what it needs', () => {
  const resolver = new SecurityResolver();
  const clientCertificate = { cert: 'SYNTH-CERT', key: 'SYNTH-KEY' };
  const held = { apiKeys: { 'X-Partner-Key': 'SYNTH-PARTNER' }, jwt: 'SYNTH-USER' };

  it('asks a scheme for the scopes of each alternative naming it', async () => {
    const tool = await toolFor([{ oauth: ['admin'] }, { oauth: ['read'] }]);
    expect(tool.mapper).toHaveLength(1);
    expect(tool.mapper[0].security).toMatchObject({
      scopes: ['admin'],
      alternatives: [0, 1],
      alternativeScopes: [['admin'], ['read']],
    });
    const asked: unknown[] = [];
    const resolved = await resolver.resolve(tool.mapper, {
      customResolver: (security) => {
        asked.push(security.scopes);
        return security.scopes?.includes('read') ? 'Bearer SYNTH-READ' : undefined;
      },
    });
    expect(asked).toEqual([['admin'], ['read']]);
    expect(resolved.headers).toEqual({ Authorization: 'Bearer SYNTH-READ' });
  });

  it('reads a requirement without scopes as asking none', () => {
    const plain: SecurityRequirement = { scheme: 'oauth', type: 'oauth2' };
    const scoped: SecurityRequirement = { ...plain, scopes: ['read'] };
    const { mapper } = new ParameterResolver().resolve({}, [], [plain, scoped], false, [[plain], [scoped]]);
    expect(mapper[0].security?.alternativeScopes).toEqual([[], ['read']]);
  });

  it('keeps one scope list when every alternative asks the same', async () => {
    const tool = await toolFor([{ oauth: ['read'] }, { oauth: ['read'], partnerKey: [] }]);
    expect(tool.mapper[0].security).not.toHaveProperty('alternativeScopes');
  });

  it('applies an alternative that needs a client certificate only with one', async () => {
    const tool = await toolFor([{ certificate: [], partnerKey: [] }, { userToken: [] }]);
    expect(tool.mapper.map((entry) => entry.security?.clientCertificates)).toEqual([
      [{ scheme: 'certificate', alternatives: [0] }],
      [{ scheme: 'certificate', alternatives: [0] }],
    ]);
    expect((await resolver.resolve(tool.mapper, held)).headers).toEqual({ Authorization: 'Bearer SYNTH-USER' });
    expect((await resolver.resolve(tool.mapper, { ...held, clientCertificate })).headers).toEqual({
      'X-Partner-Key': 'SYNTH-PARTNER',
    });
  });

  it('reports the client certificate missing when it is all that keeps every alternative from applying', async () => {
    const tool = await toolFor([
      { certificate: [], partnerKey: [] },
      { certificate: [], userToken: [] },
    ]);
    expect(await resolver.checkMissingSecurity(tool.mapper, held)).toEqual(['certificate']);
    expect(await resolver.checkMissingSecurity(tool.mapper, { ...held, clientCertificate })).toEqual([]);
    expect(await resolver.checkMissingSecurity(tool.mapper, { clientCertificate })).toEqual(['partnerKey', 'userToken']);
  });

  it('signs nothing when no alternative can be applied', async () => {
    const tool = await toolFor([{ hmacPrimary: [], partnerKey: [] }, { userToken: [] }]);
    const signatureGenerator = jest.fn(async () => 'SYNTH-SIG');
    const data = { method: 'GET', url: 'https://api.example.test/p', headers: { accept: 'application/json' } };
    expect(await resolver.signRequest(tool.mapper, data, { signatureGenerator })).toEqual(data.headers);
    expect(signatureGenerator).not.toHaveBeenCalled();
  });

  it('signs only the signature entries of the alternative it applies', async () => {
    const tool = await toolFor([{ hmacPrimary: [] }, { hmacBackup: [] }]);
    const signed: string[] = [];
    const signatureGenerator = async (_data: unknown, security: { scheme: string }) => {
      signed.push(security.scheme);
      return `SYNTH-SIG-${security.scheme}`;
    };
    const headers = await resolver.signRequest(tool.mapper, { method: 'GET', url: 'https://api.example.test/p', headers: {} }, {
      signatureGenerator,
    });
    expect(signed).toEqual(['hmacPrimary']);
    expect(headers).toEqual({ Authorization: 'SYNTH-SIG-hmacPrimary' });
  });

  it('never drops a credential for an alternative that also needs a client certificate', async () => {
    const tool = await toolFor([{ certificate: [], partnerKey: [] }, { userToken: [] }], { includeSecurityInInput: true });
    const both = buildHttpRequest(tool, { partnerKey: 'SYNTH-PARTNER', userToken: 'SYNTH-USER' });
    // Whether there is a certificate is not known here, so neither alternative can be ruled out
    expect(both.headers).toEqual({ 'X-Partner-Key': 'SYNTH-PARTNER', Authorization: 'Bearer SYNTH-USER' });
    expect(buildHttpRequest(tool, { partnerKey: 'SYNTH-PARTNER' }).headers).toEqual({ 'X-Partner-Key': 'SYNTH-PARTNER' });
    const certificateOnly = await toolFor([{ certificate: [] }, { userToken: [] }], { includeSecurityInInput: true });
    expect(buildHttpRequest(certificateOnly, { userToken: 'SYNTH-USER' }).headers).toEqual({
      Authorization: 'Bearer SYNTH-USER',
    });
  });

  it('signs without asking for credentials when the requirements are no choice', async () => {
    const tool = await toolFor([{ hmacPrimary: [], partnerKey: [] }]);
    const customResolver = jest.fn(() => 'SYNTH-PARTNER');
    const signatureGenerator = async () => 'SYNTH-SIG';
    const data = { method: 'GET', url: 'https://api.example.test/p', headers: {} };
    expect(await resolver.signRequest(tool.mapper, data, { customResolver, signatureGenerator })).toEqual({
      Authorization: 'SYNTH-SIG',
    });
    expect(customResolver).not.toHaveBeenCalled();
  });

  it('signs the alternative resolve applied, without asking for credentials again', async () => {
    const tool = await toolFor([{ hmacPrimary: [], partnerKey: [] }, { hmacBackup: [] }]);
    let partnerKeyCalls = 0;
    const customResolver = (security: { scheme: string }) =>
      security.scheme === 'partnerKey' && partnerKeyCalls++ === 0 ? 'SYNTH-PARTNER' : undefined;
    const signatureGenerator = jest.fn(async (_data: unknown, security: { scheme: string }) => `SYNTH-SIG-${security.scheme}`);
    const context = { customResolver, signatureGenerator };
    const resolved = await resolver.resolve(tool.mapper, context);
    expect(resolved.signatureInfo).toEqual({ scheme: 'hmacPrimary', schemes: ['hmacPrimary'] });
    const data = { method: 'GET', url: 'https://api.example.test/p', headers: {} };
    expect(await resolver.signRequest(tool.mapper, data, context, resolved)).toEqual({ Authorization: 'SYNTH-SIG-hmacPrimary' });
    expect(partnerKeyCalls).toBe(1);
  });

  it('sends the credentials of one alternative when the input gives several', async () => {
    const tool = await toolFor([{ partnerKey: [] }, { userToken: [] }], { includeSecurityInInput: true });
    const both = buildHttpRequest(tool, { partnerKey: 'SYNTH-PARTNER', userToken: 'SYNTH-USER' });
    expect(both.headers).toEqual({ 'X-Partner-Key': 'SYNTH-PARTNER' });
    expect(buildHttpRequest(tool, { userToken: 'SYNTH-USER' }).headers).toEqual({ Authorization: 'Bearer SYNTH-USER' });
  });

  it('is satisfied by a client certificate alone when an alternative needs nothing else', async () => {
    const tool = await toolFor([{ certificate: [] }, { userToken: [] }]);
    expect(await resolver.checkMissingSecurity(tool.mapper, { clientCertificate })).toEqual([]);
    expect((await resolver.resolve(tool.mapper, { ...held, clientCertificate })).headers).toEqual({});
    expect(await resolver.checkMissingSecurity(tool.mapper, {})).toEqual(['userToken', 'certificate']);
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
