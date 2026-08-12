/** Tests for security elicitation descriptors */
import { deriveSecurityElicitations } from '../elicitation';
import { OpenAPIToolGenerator } from '../generator';
import type { McpOpenAPITool } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const toolWith = (extras: Partial<McpOpenAPITool>): McpOpenAPITool => ({
  name: 't',
  description: 'd',
  inputSchema: { type: 'object', properties: {} },
  mapper: [],
  metadata: { path: '/t', method: 'get' },
  ...extras,
});

const mapperEntry = (security: any): any => ({
  inputKey: security.scheme,
  type: 'header',
  key: 'Authorization',
  required: true,
  security,
});

describe('deriveSecurityElicitations', () => {
  it('returns an empty array for tools without security', () => {
    expect(deriveSecurityElicitations(toolWith({}))).toEqual([]);
  });

  it('describes bearer tokens with format hints', () => {
    const [e] = deriveSecurityElicitations(
      toolWith({ mapper: [mapperEntry({ scheme: 'auth', type: 'http', httpScheme: 'bearer', bearerFormat: 'JWT' })] }),
    );
    expect(e.scheme).toBe('auth');
    expect(e.message).toBe('Provide the bearer token for "auth".');
    expect(e.requestedSchema.properties['token'].description).toBe('HTTP bearer authentication token (JWT).');
    expect(e.requestedSchema.required).toEqual(['token']);
  });

  it('defaults http schemes to bearer and skips the format suffix when absent', () => {
    const [e] = deriveSecurityElicitations(toolWith({ mapper: [mapperEntry({ scheme: 'auth', type: 'http' })] }));
    expect(e.requestedSchema.properties['token'].description).toBe('HTTP bearer authentication token.');
  });

  it('requests username and password for basic and digest', () => {
    for (const httpScheme of ['basic', 'digest', 'Basic']) {
      const [e] = deriveSecurityElicitations(
        toolWith({ mapper: [mapperEntry({ scheme: 's', type: 'http', httpScheme })] }),
      );
      expect(e.message).toBe(`Provide HTTP ${httpScheme.toLowerCase()} credentials for "s".`);
      expect(e.requestedSchema.required).toEqual(['username', 'password']);
    }
  });

  it('describes api keys with their wire name and location', () => {
    const [e] = deriveSecurityElicitations(
      toolWith({ mapper: [mapperEntry({ scheme: 'key', type: 'apiKey', apiKeyName: 'X-API-Key', apiKeyIn: 'query' })] }),
    );
    expect(e.requestedSchema.properties['apiKey'].description).toBe('API key "X-API-Key" sent via query.');
    const [d] = deriveSecurityElicitations(toolWith({ mapper: [mapperEntry({ scheme: 'key', type: 'apiKey' })] }));
    expect(d.requestedSchema.properties['apiKey'].description).toBe('API key "key" sent via header.');
  });

  it('describes oauth2 and openIdConnect with scopes', () => {
    const [e] = deriveSecurityElicitations(
      toolWith({ mapper: [mapperEntry({ scheme: 'oauth', type: 'oauth2', scopes: ['read', 'write'] })] }),
    );
    expect(e.message).toBe('Provide an OAuth2 access token for "oauth". Scopes: read, write.');
    expect(e.requestedSchema.required).toEqual(['accessToken']);
    const [o] = deriveSecurityElicitations(toolWith({ mapper: [mapperEntry({ scheme: 'oidc', type: 'openIdConnect' })] }));
    expect(o.message).toBe('Provide an OAuth2 access token for "oidc".');
  });

  it('skips schemes without elicitable credentials and dedupes repeats', () => {
    const tool = toolWith({
      mapper: [
        mapperEntry({ scheme: 'mtls', type: 'mutualTLS' }),
        mapperEntry({ scheme: 'auth', type: 'http' }),
        mapperEntry({ scheme: 'auth', type: 'http' }),
      ],
    });
    const result = deriveSecurityElicitations(tool);
    expect(result).toHaveLength(1);
    expect(result[0].scheme).toBe('auth');
  });

  it('falls back to metadata.security when the mapper carries none', () => {
    const tool = toolWith({
      metadata: {
        path: '/t',
        method: 'get',
        security: [
          { scheme: 'key', type: 'apiKey', name: 'X-Key', in: 'cookie' },
          { scheme: 'key', type: 'apiKey', name: 'X-Key', in: 'cookie' },
          { scheme: 'oauth', type: 'oauth2', scopes: ['a'] },
        ],
      },
    });
    const result = deriveSecurityElicitations(tool);
    expect(result).toHaveLength(2);
    expect(result[0].requestedSchema.properties['apiKey'].description).toBe('API key "X-Key" sent via cookie.');
    expect(result[1].scheme).toBe('oauth');
  });

  it('derives from a generated tool end-to-end', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Sec API', version: '1.0.0' },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
      paths: {
        '/me': {
          get: { operationId: 'me', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec, { validate: false });
    const tool = await generator.generateTool('/me', 'get');
    const [e] = deriveSecurityElicitations(tool);
    expect(e.scheme).toBe('bearerAuth');
    expect(e.requestedSchema.properties['token'].description).toBe('HTTP bearer authentication token (JWT).');
  });
});
