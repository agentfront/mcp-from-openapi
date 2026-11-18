import { RequestBuildError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import { SecurityResolver } from '../security-resolver';
import type { ParameterMapper, SecurityParameterInfo } from '../types';

const ok = { 200: { description: 'ok' } };
const info = { title: 't', version: '1' };

function documentWith(schemes: Record<string, unknown>, security: unknown[], openapi = '3.0.3') {
  return {
    openapi,
    info,
    servers: [{ url: 'https://api.example.test' }],
    components: { securitySchemes: schemes },
    paths: { '/p': { get: { operationId: 'p', security, responses: ok } } },
  };
}

describe('a security scheme the library cannot send drops its requirement, with a diagnostic', () => {
  const good = { type: 'http', scheme: 'bearer' };

  it.each([
    ['a type in another case', { type: 'HTTP', scheme: 'bearer' }],
    ['an unknown type', { type: 'apikey', in: 'header', name: 'k' }],
    ['an apiKey in another case of a location', { type: 'apiKey', in: 'Query', name: 'k' }],
    ['an apiKey in the body', { type: 'apiKey', in: 'body', name: 'k' }],
    ['an apiKey without a name', { type: 'apiKey', in: 'header' }],
  ])('%s', async (_label, bad) => {
    const generator = await OpenAPIToolGenerator.fromJSON(documentWith({ bad }, [{ bad: [] }]), { validate: false });
    await expect(generator.generateTools()).resolves.toEqual([]);
    expect(generator.getDiagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNSUPPORTED_SECURITY_SCHEME', path: '/paths/~1p/get/security/0/bad' }),
        expect.objectContaining({ code: 'UNSATISFIABLE_SECURITY' }),
      ]),
    );
  });

  it('keeps the tool for the alternative that can be sent', async () => {
    const document = documentWith({ bad: { type: 'apiKey', in: 'body', name: 'k' }, good }, [
      { bad: [] },
      { good: [] },
    ]);
    const generator = await OpenAPIToolGenerator.fromJSON(document, { validate: false });
    const [tool] = await generator.generateTools();
    expect(tool.mapper.filter((entry) => entry.security).map((entry) => entry.security?.scheme)).toEqual(['good']);
  });

  it('keeps a mutualTLS tool, which has nothing to send, and says so', async () => {
    const document = documentWith({ mtls: { type: 'mutualTLS' } }, [{ mtls: [] }], '3.1.0');
    const generator = await OpenAPIToolGenerator.fromJSON(document);
    const [tool] = await generator.generateTools();
    expect(tool.mapper.filter((entry) => entry.security)).toEqual([]);
    expect(generator.getDiagnostics()).toEqual([
      expect.objectContaining({ severity: 'info', code: 'UNSUPPORTED_SECURITY_SCHEME' }),
    ]);
  });
});

describe('the validator refuses a security scheme the declared version does not define', () => {
  const codesAndPaths = async (document: Record<string, unknown>) =>
    ((await (await OpenAPIToolGenerator.fromJSON(document)).validate()).errors ?? []).map((error) => [
      error.code,
      error.path,
    ]);

  it.each([
    [{ type: 'HTTP', scheme: 'bearer' }, '/components/securitySchemes/bad/type'],
    [{ type: 'apiKey', in: 'Query', name: 'k' }, '/components/securitySchemes/bad/in'],
    [{ type: 'apiKey', in: 'header' }, '/components/securitySchemes/bad/name'],
    [{ type: 'mutualTLS' }, '/components/securitySchemes/bad/type'],
  ])('in OpenAPI 3.0: %p', async (bad, path) => {
    expect(await codesAndPaths(documentWith({ bad }, [{ bad: [] }]))).toEqual([['INVALID_SECURITY_SCHEME', path]]);
  });

  it('accepts mutualTLS from OpenAPI 3.1', async () => {
    expect(await codesAndPaths(documentWith({ mtls: { type: 'mutualTLS' } }, [{ mtls: [] }], '3.1.0'))).toEqual([]);
  });

  it('reads Swagger 2.0 security definitions with the 2.0 values', async () => {
    const swagger = (definitions: Record<string, unknown>) => ({
      swagger: '2.0',
      info,
      host: 'api.example.test',
      securityDefinitions: definitions,
      paths: { '/p': { get: { operationId: 'p', responses: ok } } },
    });
    expect(
      await codesAndPaths(swagger({ b: { type: 'basic' }, k: { type: 'apiKey', in: 'header', name: 'k' } })),
    ).toEqual([]);
    expect(await codesAndPaths(swagger({ h: { type: 'http', scheme: 'bearer' } }))).toEqual([
      ['INVALID_SECURITY_SCHEME', '/securityDefinitions/h/type'],
    ]);
    expect(await codesAndPaths(swagger({ c: { type: 'apiKey', in: 'cookie', name: 'k' } }))).toEqual([
      ['INVALID_SECURITY_SCHEME', '/securityDefinitions/c/in'],
    ]);
  });
});

describe('SecurityResolver applies each credential where it belongs', () => {
  const resolver = new SecurityResolver();
  const credential = (
    key: string,
    type: ParameterMapper['type'],
    security: SecurityParameterInfo,
  ): ParameterMapper => ({
    inputKey: security.scheme,
    key,
    type,
    required: true,
    security,
  });
  const apiKey = (scheme: string, name: string, location: 'header' | 'query' | 'cookie') =>
    credential(name, location, { scheme, type: 'apiKey', apiKeyName: name, apiKeyIn: location });

  it('uses the single apiKey only for a tool with one apiKey scheme', async () => {
    const two = [apiKey('partner', 'X-Partner-Token', 'header'), apiKey('tracking', 'tracking_key', 'query')];
    const resolved = await resolver.resolve(two, { apiKey: 'SYNTH-KEY' });
    expect(resolved.headers).toEqual({});
    expect(resolved.query).toEqual({});
    expect(await resolver.checkMissingSecurity(two, { apiKey: 'SYNTH-KEY' })).toEqual(['partner', 'tracking']);

    const one = [apiKey('partner', 'X-Partner-Token', 'header')];
    expect((await resolver.resolve(one, { apiKey: 'SYNTH-KEY' })).headers).toEqual({ 'X-Partner-Token': 'SYNTH-KEY' });
    const unnamed = [credential('X-Key', 'header', { scheme: 'key', type: 'apiKey' })];
    expect((await resolver.resolve(unnamed, { apiKey: 'SYNTH-KEY', apiKeys: {} })).headers).toEqual({ 'X-Key': 'SYNTH-KEY' });
  });

  it('reads only own, non-empty keys of apiKeys and customHeaders', async () => {
    const mappers = [apiKey('proto', 'constructor', 'header'), apiKey('empty', 'X-Empty', 'header')];
    const context = { apiKeys: { 'X-Empty': '' }, customHeaders: {} };
    expect((await resolver.resolve(mappers, context)).headers).toEqual({});
    expect(await resolver.checkMissingSecurity(mappers, context)).toEqual(['proto', 'empty']);
  });

  it('fills an apiKey scheme whose name merely looks like a signature', async () => {
    const mappers = [apiKey('TomahawkKey', 'X-Tomahawk', 'header')];
    const resolved = await resolver.resolve(mappers, { apiKeys: { 'X-Tomahawk': 'SYNTH-VALUE' } });
    expect(resolved.headers).toEqual({ 'X-Tomahawk': 'SYNTH-VALUE' });
    expect(resolved.requiresSignature).toBeUndefined();
  });

  it('reports a signature scheme missing exactly when nothing can sign it', async () => {
    const mappers = [
      credential('Authorization', 'header', { scheme: 'hmac-signature', type: 'http', httpScheme: 'bearer' }),
    ];
    expect((await resolver.resolve(mappers, {})).requiresSignature).toBe(true);
    expect(await resolver.checkMissingSecurity(mappers, {})).toEqual(['hmac-signature']);
    expect(await resolver.checkMissingSecurity(mappers, { signatureGenerator: async () => 'signed' })).toEqual([]);
  });

  it('refuses a credential that cannot be sent as a header or cookie value', async () => {
    const bearer = [credential('Authorization', 'header', { scheme: 'bearer', type: 'http', httpScheme: 'bearer' })];
    await expect(resolver.resolve(bearer, { jwt: 'tok\r\nX-Injected: yes' })).rejects.toThrow(RequestBuildError);
    const session = [apiKey('session', 'sid', 'cookie')];
    await expect(resolver.resolve(session, { apiKeys: { sid: 'a; admin=1' } })).rejects.toThrow(RequestBuildError);
  });
});
