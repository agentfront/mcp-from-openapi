/**
 * Tests for buildHttpRequest — pure OpenAPI parameter serialization
 */

import { buildHttpRequest } from '../request-builder';
import { RequestBuildError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import type { McpOpenAPITool, ParameterMapper } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal tool factory for direct mapper-level tests */
function makeTool(mapper: ParameterMapper[], overrides: Partial<McpOpenAPITool['metadata']> = {}): McpOpenAPITool {
  return {
    name: 'test_tool',
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    mapper,
    metadata: {
      path: '/things/{id}',
      method: 'post',
      servers: [{ url: 'https://api.example.com/' }],
      ...overrides,
    } as McpOpenAPITool['metadata'],
  };
}

describe('buildHttpRequest', () => {
  describe('URL, method, and base handling', () => {
    it('composes url from server, expanded path, and query', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'q', type: 'query', key: 'q' },
      ]);
      const result = buildHttpRequest(tool, { id: '42', q: 'hello world' });

      expect(result.url).toBe('https://api.example.com/things/42?q=hello%20world');
      expect(result.method).toBe('POST');
    });

    it('prefers options.baseUrl over the tool servers and trims trailing slashes', () => {
      const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }]);
      const result = buildHttpRequest(tool, { id: '1' }, { baseUrl: 'https://staging.example.com//' });

      expect(result.url).toBe('https://staging.example.com/things/1');
    });

    it('allows an empty base for relative requests', () => {
      const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }], { servers: undefined });
      const result = buildHttpRequest(tool, { id: '1' });

      expect(result.url).toBe('/things/1');
    });

    it('rejects non-http base URLs', () => {
      const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }]);

      expect(() => buildHttpRequest(tool, { id: '1' }, { baseUrl: 'file:///etc/passwd' })).toThrow(RequestBuildError);
      expect(() => buildHttpRequest(tool, { id: '1' }, { baseUrl: 'javascript:alert(1)' })).toThrow(RequestBuildError);
    });

    it('throws when path parameters remain unresolved', () => {
      const tool = makeTool([{ inputKey: 'other', type: 'query', key: 'other' }]);

      expect(() => buildHttpRequest(tool, { other: 'x' })).toThrow(/Unresolved path parameters/);
    });

    it('replaces duplicate path placeholders', () => {
      const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }], {
        path: '/pair/{id}/{id}',
      });
      const result = buildHttpRequest(tool, { id: '7' });

      expect(result.url).toBe('https://api.example.com/pair/7/7');
    });
  });

  describe('required and missing parameters', () => {
    it('throws for missing required parameters', () => {
      const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }]);

      expect(() => buildHttpRequest(tool, {})).toThrow(/Required path parameter 'id'/);
    });

    it('treats null as missing for non-body parameters', () => {
      const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }]);

      expect(() => buildHttpRequest(tool, { id: null })).toThrow(RequestBuildError);
    });

    it('skips optional missing parameters silently', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'q', type: 'query', key: 'q' },
      ]);
      const result = buildHttpRequest(tool, { id: '1' });

      expect(result.url).toBe('https://api.example.com/things/1');
    });

    it('allows null in JSON bodies', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'note', type: 'body', key: 'note', serialization: { contentType: 'application/json' } },
      ]);
      const result = buildHttpRequest(tool, { id: '1', note: null });

      expect(result.body).toBe('{"note":null}');
    });
  });

  describe('query serialization styles', () => {
    const queryTool = (mapper: Partial<ParameterMapper>) =>
      makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'p', type: 'query', key: 'p', ...mapper } as ParameterMapper,
      ]);

    it('form + explode (default): repeats the key per array item', () => {
      const result = buildHttpRequest(queryTool({}), { id: '1', p: ['a', 'b'] });

      expect(result.url).toContain('?p=a&p=b');
      expect(result.query['p']).toEqual(['a', 'b']);
    });

    it('form + explode=false: comma-joins array items', () => {
      const result = buildHttpRequest(queryTool({ explode: false }), { id: '1', p: ['a', 'b'] });

      expect(result.url).toContain('?p=a%2Cb');
      expect(result.query['p']).toEqual(['a,b']);
    });

    it('spaceDelimited: joins with encoded spaces', () => {
      const result = buildHttpRequest(queryTool({ style: 'spaceDelimited', explode: false }), {
        id: '1',
        p: ['a', 'b'],
      });

      expect(result.url).toContain('?p=a%20b');
    });

    it('pipeDelimited: joins with pipes', () => {
      const result = buildHttpRequest(queryTool({ style: 'pipeDelimited', explode: false }), {
        id: '1',
        p: ['a', 'b'],
      });

      expect(result.url).toContain('?p=a%7Cb');
    });

    it('deepObject: bracket notation, recursive', () => {
      const result = buildHttpRequest(queryTool({ style: 'deepObject', explode: true }), {
        id: '1',
        p: { author: { name: 'ada' }, years: [1815, 1852], active: true },
      });

      expect(result.url).toContain('p[author][name]=ada');
      expect(result.url).toContain('p[years]=1815&p[years]=1852');
      expect(result.url).toContain('p[active]=true');
    });

    it('form object + explode: fields become top-level pairs', () => {
      const result = buildHttpRequest(queryTool({}), { id: '1', p: { x: 1, y: 2 } });

      expect(result.url).toContain('?x=1&y=2');
    });

    it('form object + explode=false: single comma-joined pair', () => {
      const result = buildHttpRequest(queryTool({ explode: false }), { id: '1', p: { x: 1, y: 2 } });

      expect(result.url).toContain('?p=x%2C1%2Cy%2C2');
    });

    it('skips undefined object fields', () => {
      const result = buildHttpRequest(queryTool({}), { id: '1', p: { x: 1, y: undefined } });

      expect(result.url).toContain('?x=1');
      expect(result.url).not.toContain('y=');
    });

    it('allowReserved keeps RFC 3986 reserved characters unencoded', () => {
      const result = buildHttpRequest(queryTool({ allowReserved: true }), { id: '1', p: 'a/b:c,d' });

      expect(result.url).toContain('?p=a/b:c,d');
    });

    it('encodes reserved characters without allowReserved', () => {
      const result = buildHttpRequest(queryTool({}), { id: '1', p: 'a/b:c' });

      expect(result.url).toContain('?p=a%2Fb%3Ac');
    });

    it('rejects nested non-primitives in plain array items', () => {
      expect(() => buildHttpRequest(queryTool({}), { id: '1', p: [{ nested: true }] })).toThrow(RequestBuildError);
    });

    it('reports null and array values in serialization errors', () => {
      expect(() => buildHttpRequest(queryTool({}), { id: '1', p: { x: null } })).toThrow(/received null/);
      expect(() => buildHttpRequest(queryTool({}), { id: '1', p: { x: [1] } })).toThrow(/received an array/);
    });

    it('deepObject skips undefined fields', () => {
      const result = buildHttpRequest(queryTool({ style: 'deepObject', explode: true }), {
        id: '1',
        p: { keep: 1, drop: undefined },
      });

      expect(result.url).toContain('p[keep]=1');
      expect(result.url).not.toContain('drop');
    });
  });

  describe('path serialization styles', () => {
    const pathTool = (mapper: Partial<ParameterMapper>, path = '/t/{p}') =>
      makeTool([{ inputKey: 'p', type: 'path', key: 'p', required: true, ...mapper } as ParameterMapper], { path });

    it('simple array: comma-joined', () => {
      expect(buildHttpRequest(pathTool({}), { p: ['a', 'b'] }).url).toContain('/t/a,b');
    });

    it('simple object explode=false: k,v pairs', () => {
      expect(buildHttpRequest(pathTool({}), { p: { R: 100, G: 200 } }).url).toContain('/t/R,100,G,200');
    });

    it('simple object explode=true: k=v pairs', () => {
      expect(buildHttpRequest(pathTool({ explode: true }), { p: { R: 100, G: 200 } }).url).toContain('/t/R=100,G=200');
    });

    it('label primitive and arrays', () => {
      expect(buildHttpRequest(pathTool({ style: 'label' }), { p: 'v' }).url).toContain('/t/.v');
      expect(buildHttpRequest(pathTool({ style: 'label' }), { p: ['a', 'b'] }).url).toContain('/t/.a,b');
      expect(buildHttpRequest(pathTool({ style: 'label', explode: true }), { p: ['a', 'b'] }).url).toContain('/t/.a.b');
    });

    it('label objects', () => {
      expect(buildHttpRequest(pathTool({ style: 'label' }), { p: { R: 100 } }).url).toContain('/t/.R,100');
      expect(buildHttpRequest(pathTool({ style: 'label', explode: true }), { p: { R: 100 } }).url).toContain('/t/.R=100');
    });

    it('matrix primitives, arrays, and objects', () => {
      expect(buildHttpRequest(pathTool({ style: 'matrix' }), { p: 'v' }).url).toContain('/t/;p=v');
      expect(buildHttpRequest(pathTool({ style: 'matrix' }), { p: ['a', 'b'] }).url).toContain('/t/;p=a,b');
      expect(buildHttpRequest(pathTool({ style: 'matrix', explode: true }), { p: ['a', 'b'] }).url).toContain(
        '/t/;p=a;p=b',
      );
      expect(buildHttpRequest(pathTool({ style: 'matrix' }), { p: { R: 100 } }).url).toContain('/t/;p=R,100');
      expect(buildHttpRequest(pathTool({ style: 'matrix', explode: true }), { p: { R: 100 } }).url).toContain(
        '/t/;R=100',
      );
    });

    it('percent-encodes path values', () => {
      expect(buildHttpRequest(pathTool({}), { p: 'a/b c' }).url).toContain('/t/a%2Fb%20c');
    });
  });

  describe('headers and cookies', () => {
    it('serializes header arrays and objects (simple style)', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'list', type: 'header', key: 'X-List' },
        { inputKey: 'objA', type: 'header', key: 'X-Obj' },
        { inputKey: 'objB', type: 'header', key: 'X-Obj-Exploded', explode: true },
      ]);
      const result = buildHttpRequest(tool, {
        id: '1',
        list: ['a', 'b'],
        objA: { k: 'v' },
        objB: { k: 'v' },
      });

      expect(result.headers['X-List']).toBe('a,b');
      expect(result.headers['X-Obj']).toBe('k,v');
      expect(result.headers['X-Obj-Exploded']).toBe('k=v');
    });

    it('rejects header injection attempts', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'h', type: 'header', key: 'X-H' },
      ]);

      expect(() => buildHttpRequest(tool, { id: '1', h: 'evil\r\nX-Injected: 1' })).toThrow(/header injection/);
    });

    it('folds cookies into a single Cookie header with verbatim values', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'session', type: 'cookie', key: 'session' },
        { inputKey: 'pref', type: 'cookie', key: 'pref' },
      ]);
      const result = buildHttpRequest(tool, { id: '1', session: 'abc', pref: 'dark-mode' });

      expect(result.cookies).toEqual({ session: 'abc', pref: 'dark-mode' });
      expect(result.headers['Cookie']).toBe('session=abc; pref=dark-mode');
    });

    it('joins cookie arrays with commas and rejects invalid cookie names', () => {
      const good = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'multi', type: 'cookie', key: 'multi' },
      ]);
      expect(buildHttpRequest(good, { id: '1', multi: ['a', 'b'] }).cookies['multi']).toBe('a,b');

      const bad = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'c', type: 'cookie', key: 'bad name' },
      ]);
      expect(() => buildHttpRequest(bad, { id: '1', c: 'v' })).toThrow(/Invalid cookie name/);
    });
  });

  describe('body serialization', () => {
    it('JSON bodies: composed object, stringified, content-type set', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'name', type: 'body', key: 'name', serialization: { contentType: 'application/json' } },
        { inputKey: 'age', type: 'body', key: 'age', serialization: { contentType: 'application/json' } },
      ]);
      const result = buildHttpRequest(tool, { id: '1', name: 'Ada', age: 36 });

      expect(result.rawBody).toEqual({ name: 'Ada', age: 36 });
      expect(result.body).toBe('{"name":"Ada","age":36}');
      expect(result.headers['content-type']).toBe('application/json');
      expect(result.contentType).toBe('application/json');
    });

    it('supports +json content types', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'data', type: 'body', key: 'data', serialization: { contentType: 'application/vnd.api+json' } },
      ]);
      const result = buildHttpRequest(tool, { id: '1', data: 'x' });

      expect(result.body).toBe('{"data":"x"}');
      expect(result.headers['content-type']).toBe('application/vnd.api+json');
    });

    it('wholeBody: the value IS the body (arrays serialize whole)', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        {
          inputKey: 'body',
          type: 'body',
          key: 'body',
          wholeBody: true,
          serialization: { contentType: 'application/json' },
        },
      ]);
      const result = buildHttpRequest(tool, { id: '1', body: ['a', 'b'] });

      expect(result.body).toBe('["a","b"]');
    });

    it('wholeBody with falsy values still serializes', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        {
          inputKey: 'body',
          type: 'body',
          key: 'body',
          wholeBody: true,
          serialization: { contentType: 'application/json' },
        },
      ]);

      expect(buildHttpRequest(tool, { id: '1', body: false }).body).toBe('false');
      expect(buildHttpRequest(tool, { id: '1', body: 0 }).body).toBe('0');
      expect(buildHttpRequest(tool, { id: '1', body: null }).body).toBe('null');
    });

    it('form-urlencoded bodies', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        {
          inputKey: 'user',
          type: 'body',
          key: 'user',
          serialization: { contentType: 'application/x-www-form-urlencoded' },
        },
        {
          inputKey: 'tags',
          type: 'body',
          key: 'tags',
          serialization: { contentType: 'application/x-www-form-urlencoded' },
        },
        {
          inputKey: 'meta',
          type: 'body',
          key: 'meta',
          serialization: { contentType: 'application/x-www-form-urlencoded' },
        },
      ]);
      const result = buildHttpRequest(tool, { id: '1', user: 'ada b', tags: ['x', 'y'], meta: { a: 1 } });

      expect(result.body).toBe('user=ada+b&tags=x&tags=y&meta=%7B%22a%22%3A1%7D');
      expect(result.headers['content-type']).toBe('application/x-www-form-urlencoded');
    });

    it('form-urlencoded and multipart whole bodies skip undefined fields', () => {
      const urlencoded = makeTool([
        {
          inputKey: 'body',
          type: 'body',
          key: 'body',
          wholeBody: true,
          serialization: { contentType: 'application/x-www-form-urlencoded' },
        },
      ]);
      const encResult = buildHttpRequest(makeToolWithPathless(urlencoded), { body: { keep: 1, drop: undefined } });
      expect(encResult.body).toBe('keep=1');

      const multipart = makeTool([
        {
          inputKey: 'body',
          type: 'body',
          key: 'body',
          wholeBody: true,
          serialization: { contentType: 'multipart/form-data' },
        },
      ]);
      const formResult = buildHttpRequest(makeToolWithPathless(multipart), { body: { keep: 'x', drop: undefined } });
      expect((formResult.body as FormData).get('keep')).toBe('x');
      expect((formResult.body as FormData).has('drop')).toBe(false);
    });

    it('form-urlencoded whole bodies must be objects', () => {
      const tool = makeTool([
        {
          inputKey: 'body',
          type: 'body',
          key: 'body',
          wholeBody: true,
          serialization: { contentType: 'application/x-www-form-urlencoded' },
        },
      ]);

      expect(() => buildHttpRequest(makeToolWithPathless(tool), { body: 'raw' })).toThrow(/must be objects/);
    });

    it('multipart bodies build FormData without a content-type header', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        {
          inputKey: 'file',
          type: 'body',
          key: 'file',
          serialization: { contentType: 'multipart/form-data' },
        },
        {
          inputKey: 'caption',
          type: 'body',
          key: 'caption',
          serialization: { contentType: 'multipart/form-data' },
        },
        {
          inputKey: 'tags',
          type: 'body',
          key: 'tags',
          serialization: { contentType: 'multipart/form-data' },
        },
        {
          inputKey: 'blob',
          type: 'body',
          key: 'blob',
          serialization: { contentType: 'multipart/form-data' },
        },
      ]);
      const result = buildHttpRequest(tool, {
        id: '1',
        file: new Uint8Array([1, 2, 3]),
        caption: 'hello',
        tags: ['a', 'b'],
        blob: new Blob(['x'], { type: 'text/plain' }),
      });

      expect(result.body).toBeInstanceOf(FormData);
      const form = result.body as FormData;
      expect(form.get('caption')).toBe('hello');
      expect(form.get('tags')).toBe('["a","b"]');
      expect(form.get('file')).toBeInstanceOf(Blob);
      expect(form.get('blob')).toBeInstanceOf(Blob);
      expect(result.headers['content-type']).toBeUndefined();
      expect(result.contentType).toBe('multipart/form-data');
    });

    it('multipart whole bodies must be objects', () => {
      const tool = makeTool([
        {
          inputKey: 'body',
          type: 'body',
          key: 'body',
          wholeBody: true,
          serialization: { contentType: 'multipart/form-data' },
        },
      ]);

      expect(() => buildHttpRequest(makeToolWithPathless(tool), { body: [1] })).toThrow(/must be objects/);
    });

    it('binary whole bodies pass through untouched', () => {
      const payload = new Uint8Array([1, 2, 3]);
      const tool = makeTool([
        {
          inputKey: 'body',
          type: 'body',
          key: 'body',
          wholeBody: true,
          serialization: { contentType: 'application/octet-stream', binary: true },
        },
      ]);
      const result = buildHttpRequest(makeToolWithPathless(tool), { body: payload });

      expect(result.body).toBe(payload);
      expect(result.headers['content-type']).toBe('application/octet-stream');
    });

    it('text bodies stringify primitives and JSON-stringify structures', () => {
      const textTool = (value: unknown) => {
        const tool = makeTool([
          {
            inputKey: 'body',
            type: 'body',
            key: 'body',
            wholeBody: true,
            serialization: { contentType: 'text/plain' },
          },
        ]);
        return buildHttpRequest(makeToolWithPathless(tool), { body: value });
      };

      expect(textTool('hello').body).toBe('hello');
      expect(textTool(42).body).toBe('42');
      expect(textTool({ a: 1 }).body).toBe('{"a":1}');
      expect(textTool(['a']).body).toBe('["a"]');
    });

    it('no body mappers -> no body, no content-type', () => {
      const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }]);
      const result = buildHttpRequest(tool, { id: '1' });

      expect(result.body).toBeUndefined();
      expect(result.contentType).toBeUndefined();
      expect(result.headers['content-type']).toBeUndefined();
    });

    it('defaults body content type to application/json when unspecified', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'x', type: 'body', key: 'x' },
      ]);
      const result = buildHttpRequest(tool, { id: '1', x: 1 });

      expect(result.body).toBe('{"x":1}');
      expect(result.headers['content-type']).toBe('application/json');
    });
  });

  describe('security parameters', () => {
    const securityTool = () =>
      makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        {
          inputKey: 'bearerAuth',
          type: 'header',
          key: 'Authorization',
          required: true,
          security: { scheme: 'bearerAuth', type: 'http', httpScheme: 'bearer' },
        },
        {
          inputKey: 'apiKey',
          type: 'query',
          key: 'api_key',
          required: true,
          security: { scheme: 'apiKey', type: 'apiKey', apiKeyName: 'api_key', apiKeyIn: 'query' },
        },
        {
          inputKey: 'sessionAuth',
          type: 'cookie',
          key: 'session',
          required: true,
          security: { scheme: 'sessionAuth', type: 'apiKey', apiKeyName: 'session', apiKeyIn: 'cookie' },
        },
      ]);

    it('never throws for missing security values', () => {
      const result = buildHttpRequest(securityTool(), { id: '1' });

      expect(result.headers['Authorization']).toBeUndefined();
      expect(result.url).not.toContain('api_key');
    });

    it('applies provided security values with scheme-aware formatting', () => {
      const result = buildHttpRequest(securityTool(), {
        id: '1',
        bearerAuth: 'tok123',
        apiKey: 'key456',
        sessionAuth: 'sess789',
      });

      expect(result.headers['Authorization']).toBe('Bearer tok123');
      expect(result.url).toContain('api_key=key456');
      expect(result.headers['Cookie']).toBe('session=sess789');
    });

    it('does not double-prefix bearer tokens', () => {
      const result = buildHttpRequest(securityTool(), { id: '1', bearerAuth: 'Bearer tok123' });

      expect(result.headers['Authorization']).toBe('Bearer tok123');
    });

    it('prefixes oauth2 tokens with Bearer and keeps existing prefixes', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        {
          inputKey: 'oauth',
          type: 'header',
          key: 'Authorization',
          security: { scheme: 'oauth', type: 'oauth2' },
        },
      ]);

      expect(buildHttpRequest(tool, { id: '1', oauth: 'tok' }).headers['Authorization']).toBe('Bearer tok');
      expect(buildHttpRequest(tool, { id: '1', oauth: 'Bearer tok' }).headers['Authorization']).toBe('Bearer tok');
    });

    it('defaults http security to the bearer scheme when httpScheme is absent', () => {
      const tool = makeTool([
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        {
          inputKey: 'auth',
          type: 'header',
          key: 'Authorization',
          security: { scheme: 'auth', type: 'http' },
        },
      ]);

      expect(buildHttpRequest(tool, { id: '1', auth: 'tok' }).headers['Authorization']).toBe('Bearer tok');
    });
  });

  describe('integration with the generator', () => {
    it('builds a request from a generator-produced tool end to end', async () => {
      const spec: any = {
        openapi: '3.0.0',
        info: { title: 'E2E API', version: '1.0.0' },
        servers: [{ url: 'https://api.example.com' }],
        paths: {
          '/users/{id}/posts': {
            post: {
              operationId: 'createPost',
              parameters: [
                { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                {
                  name: 'filter',
                  in: 'query',
                  style: 'deepObject',
                  explode: true,
                  schema: { type: 'object', properties: { tag: { type: 'string' } } },
                },
              ],
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { title: { type: 'string' } },
                      required: ['title'],
                    },
                  },
                },
              },
              responses: { '201': { description: 'Created' } },
            },
          },
        },
      };
      const generator = await OpenAPIToolGenerator.fromJSON(spec);
      const tool = await generator.generateTool('/users/{id}/posts', 'post');
      const result = buildHttpRequest(tool, { id: 'u1', filter: { tag: 'news' }, title: 'Hello' });

      expect(result.url).toBe('https://api.example.com/users/u1/posts?filter[tag]=news');
      expect(result.method).toBe('POST');
      expect(result.body).toBe('{"title":"Hello"}');
      expect(result.headers['content-type']).toBe('application/json');
    });
  });
});

/** Strip the path template so pathless whole-body tools resolve cleanly */
function makeToolWithPathless(tool: McpOpenAPITool): McpOpenAPITool {
  return { ...tool, metadata: { ...tool.metadata, path: '/upload' } };
}

describe('review fixes', () => {
  const queryTool = (mapper: Partial<ParameterMapper>) =>
    makeTool([
      { inputKey: 'id', type: 'path', key: 'id', required: true },
      { inputKey: 'p', type: 'query', key: 'p', ...mapper } as ParameterMapper,
    ]);

  it('spaceDelimited/pipeDelimited default to explode=false per the OpenAPI table', () => {
    expect(buildHttpRequest(queryTool({ style: 'spaceDelimited' }), { id: '1', p: ['a', 'b'] }).url).toContain(
      '?p=a%20b',
    );
    expect(buildHttpRequest(queryTool({ style: 'pipeDelimited' }), { id: '1', p: ['a', 'b'] }).url).toContain(
      '?p=a%7Cb',
    );
    // form still defaults to explode=true
    expect(buildHttpRequest(queryTool({}), { id: '1', p: ['a', 'b'] }).url).toContain('?p=a&p=b');
  });

  it('deepObject top-level arrays default to exploded pairs when explode is omitted', () => {
    const result = buildHttpRequest(queryTool({ style: 'deepObject' }), { id: '1', p: ['a', 'b'] });

    expect(result.url).toContain('?p=a&p=b');
  });

  it('deepObject top-level arrays honor an explicit explode=false', () => {
    const result = buildHttpRequest(queryTool({ style: 'deepObject', explode: false }), { id: '1', p: ['a', 'b'] });

    expect(result.url).toContain('?p=a%2Cb');
  });

  it('empty arrays with explode=false emit no pairs', () => {
    const result = buildHttpRequest(queryTool({ explode: false }), { id: '1', p: [] });

    expect(result.url).not.toContain('p=');
  });

  it('deepObject arrays default to exploded pairs', () => {
    const result = buildHttpRequest(queryTool({ style: 'deepObject' }), { id: '1', p: { tags: ['x', 'y'] } });

    expect(result.url).toContain('p[tags]=x&p[tags]=y');
  });

  it('sends cookie values verbatim and rejects illegal cookie octets', () => {
    const tool = makeTool([
      { inputKey: 'id', type: 'path', key: 'id', required: true },
      { inputKey: 'session', type: 'cookie', key: 'session' },
    ]);
    const ok = buildHttpRequest(tool, { id: '1', session: 'abc123==' });
    expect(ok.headers['Cookie']).toBe('session=abc123==');
    expect(ok.cookies['session']).toBe('abc123==');

    expect(() => buildHttpRequest(tool, { id: '1', session: 'a;b' })).toThrow(/cookie-octet/);
    expect(() => buildHttpRequest(tool, { id: '1', session: 'a b' })).toThrow(/cookie-octet/);
  });

  it('substitutes server template variables from spec defaults', () => {
    const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }], {
      servers: [
        {
          url: 'https://{region}.api.example.com/{version}',
          variables: { region: { default: 'eu' }, version: { default: 'v2' } },
        } as any,
      ],
    });
    const result = buildHttpRequest(tool, { id: '9' });

    expect(result.url).toBe('https://eu.api.example.com/v2/things/9');
  });

  it('throws loudly on unresolved server template variables', () => {
    const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }], {
      servers: [{ url: 'https://{region}.api.example.com' } as any],
    });

    expect(() => buildHttpRequest(tool, { id: '9' })).toThrow(/unresolved server template variables/);
    // explicit baseUrl is the documented workaround
    expect(buildHttpRequest(tool, { id: '9' }, { baseUrl: 'https://eu.api.example.com' }).url).toBe(
      'https://eu.api.example.com/things/9',
    );
  });

  it('passes digest and unknown http scheme values through verbatim', () => {
    const digestTool = makeTool([
      { inputKey: 'id', type: 'path', key: 'id', required: true },
      {
        inputKey: 'digestAuth',
        type: 'header',
        key: 'Authorization',
        security: { scheme: 'digestAuth', type: 'http', httpScheme: 'digest' },
      },
    ]);
    const fullDigest = 'Digest username="u", realm="r", nonce="n", response="x"';
    const result = buildHttpRequest(digestTool, { id: '1', digestAuth: fullDigest });

    expect(result.headers['Authorization']).toBe(fullDigest);
    // raw non-header value is NOT blindly prefixed either
    expect(buildHttpRequest(digestTool, { id: '1', digestAuth: 'rawcred' }).headers['Authorization']).toBe('rawcred');
  });
});
