/**
 * Tests for buildHttpRequest — pure OpenAPI parameter serialization
 */

import { buildHttpRequest } from '../request-builder';
import type { BuiltHttpRequest } from '../request-builder';
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
      const encResult = buildHttpRequest(withUploadPath(urlencoded), { body: { keep: 1, drop: undefined } });
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
      const formResult = buildHttpRequest(withUploadPath(multipart), { body: { keep: 'x', drop: undefined } });
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

      expect(() => buildHttpRequest(withUploadPath(tool), { body: 'raw' })).toThrow(/must be objects/);
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

      expect(() => buildHttpRequest(withUploadPath(tool), { body: [1] })).toThrow(/must be objects/);
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
      const result = buildHttpRequest(withUploadPath(tool), { body: payload });

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
        return buildHttpRequest(withUploadPath(tool), { body: value });
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

/** Replace the templated path with a static /upload so whole-body tools resolve cleanly */
function withUploadPath(tool: McpOpenAPITool): McpOpenAPITool {
  return { ...tool, metadata: { ...tool.metadata, path: '/upload' } };
}

describe('header names and content-type casing', () => {
  it('rejects spec-supplied header names that are not RFC 7230 tokens', () => {
    const tool = makeTool([
      { inputKey: 'id', type: 'path', key: 'id', required: true },
      { inputKey: 'h', type: 'header', key: 'bad name' },
    ]);

    expect(() => buildHttpRequest(tool, { id: '1', h: 'v' })).toThrow(/Invalid header name/);

    const injected = makeTool([
      { inputKey: 'id', type: 'path', key: 'id', required: true },
      { inputKey: 'h', type: 'header', key: 'X-Evil\r\nX-Injected' },
    ]);
    expect(() => buildHttpRequest(injected, { id: '1', h: 'v' })).toThrow(/Invalid header name/);
  });

  it('reuses a spec-declared Content-Type header key instead of duplicating it', () => {
    const tool = makeTool([
      { inputKey: 'id', type: 'path', key: 'id', required: true },
      { inputKey: 'ct', type: 'header', key: 'Content-Type' },
      { inputKey: 'x', type: 'body', key: 'x', serialization: { contentType: 'application/json' } },
    ]);
    const result = buildHttpRequest(tool, { id: '1', ct: 'application/custom', x: 1 });

    const contentTypeKeys = Object.keys(result.headers).filter((h) => h.toLowerCase() === 'content-type');
    expect(contentTypeKeys).toEqual(['Content-Type']); // single key, original casing
    expect(result.headers['Content-Type']).toBe('application/json'); // body serialization wins
  });

  it('removes a mapped Content-Type header for multipart bodies (client sets the boundary)', () => {
    const tool = makeTool([
      { inputKey: 'ct', type: 'header', key: 'Content-Type' },
      {
        inputKey: 'file',
        type: 'body',
        key: 'file',
        serialization: { contentType: 'multipart/form-data' },
      },
    ]);
    const result = buildHttpRequest(withUploadPath(tool), { ct: 'multipart/form-data', file: 'x' });

    expect(result.body).toBeInstanceOf(FormData);
    expect(Object.keys(result.headers).filter((h) => h.toLowerCase() === 'content-type')).toEqual([]);
    expect(result.contentType).toBe('multipart/form-data'); // still reported for routing
  });

  it('keeps an explicit Content-Type header for binary bodies', () => {
    const tool = makeTool([
      { inputKey: 'ct', type: 'header', key: 'Content-Type' },
      {
        inputKey: 'body',
        type: 'body',
        key: 'body',
        wholeBody: true,
        serialization: { contentType: 'application/octet-stream', binary: true },
      },
    ]);
    const result = buildHttpRequest(withUploadPath(tool), { ct: 'image/png', body: new Uint8Array([1]) });

    const contentTypeKeys = Object.keys(result.headers).filter((h) => h.toLowerCase() === 'content-type');
    expect(contentTypeKeys).toEqual(['Content-Type']);
    expect(result.headers['Content-Type']).toBe('image/png'); // explicit header preserved
  });
});

describe('serialization defaults and hardening', () => {
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

describe('flattened multipart bodies with binary parts', () => {
  it('builds FormData (not a raw binary body) when a body PART is binary', () => {
    const tool: any = {
      name: 'uploadFile',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      mapper: [
        { inputKey: 'label', type: 'body', key: 'label', serialization: { contentType: 'multipart/form-data' } },
        { inputKey: 'file', type: 'body', key: 'file', serialization: { contentType: 'multipart/form-data', binary: true } },
      ],
      metadata: { path: '/files', method: 'post' },
    };
    const built = buildHttpRequest(tool, { label: 'x', file: new Uint8Array([1, 2]) }, { baseUrl: 'http://h' });

    expect(built.body).toBeInstanceOf(FormData);
    expect(built.contentType).toBe('multipart/form-data');
    // no bare content-type header: the HTTP client must set the boundary
    expect(Object.keys(built.headers).map((h) => h.toLowerCase())).not.toContain('content-type');
  });

  it('keeps whole-body binary payloads raw', () => {
    const tool: any = {
      name: 'uploadRaw',
      description: 'd',
      inputSchema: { type: 'object', properties: {} },
      mapper: [
        { inputKey: 'body', type: 'body', key: 'body', wholeBody: true, serialization: { contentType: 'application/octet-stream', binary: true } },
      ],
      metadata: { path: '/raw', method: 'post' },
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const built = buildHttpRequest(tool, { body: bytes }, { baseUrl: 'http://h' });
    expect(built.body).toBe(bytes);
    expect(built.headers['content-type']).toBe('application/octet-stream');
  });
});

describe('HTTP method on the wire', () => {
  const noPath = { path: '/things' };
  const call = (method: unknown) =>
    buildHttpRequest(makeTool([], { ...noPath, method: method as any }), {}, { baseUrl: 'http://h' });
  const failure = (method: unknown): RequestBuildError => {
    try {
      call(method);
    } catch (error) {
      return error as RequestBuildError;
    }
    throw new Error('expected buildHttpRequest to throw');
  };

  it.each([
    ['get', 'GET'],
    ['post', 'POST'],
    ['put', 'PUT'],
    ['patch', 'PATCH'],
    ['delete', 'DELETE'],
    ['head', 'HEAD'],
    ['options', 'OPTIONS'],
    ['trace', 'TRACE'],
    ['query', 'QUERY'],
    ['GET', 'GET'],
    ['Query', 'QUERY'],
  ])('sends the standard method %s upper-cased as %s', (method, wire) => {
    expect(call(method).method).toBe(wire);
  });

  it.each(['LINK', 'link', 'Link', 'M-SEARCH', 'PURGE', "a!#$%&'*+.^_`|~-b", 'constructor', '__proto__', 'toString'])(
    'sends the additional method %s exactly as written',
    (method) => {
      expect(call(method).method).toBe(method);
    },
  );

  it.each([
    ['an empty string', ''],
    ['a space', 'GET /x'],
    ['a leading space', ' GET'],
    ['CRLF', 'LINK\r\nX-Injected: 1'],
    ['a newline', 'LINK\n'],
    ['a tab', 'LI\tNK'],
    ['a non-ASCII letter', 'LÍNK'],
    ['a slash', 'LI/NK'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', {}],
    ['an array', ['GET']],
  ])('rejects a method that is %s', (_label, method) => {
    const error = failure(method);

    expect(error).toBeInstanceOf(RequestBuildError);
    expect(error.message).toMatch(/is not a valid method/);
    expect(error.context).toEqual({ method });
  });

  it('keeps control characters of a rejected method out of the message', () => {
    const { message } = failure('LINK\r\nX-Injected: 1');

    expect(message).not.toMatch(/[\r\n]/);
    expect(message).toContain('"LINK\\r\\nX-Injected: 1"');
  });

  it.each(['CONNECT', 'connect', 'Connect'])('refuses %s', (method) => {
    const error = failure(method);

    expect(error).toBeInstanceOf(RequestBuildError);
    expect(error.message).toMatch(/CONNECT opens a tunnel/);
    expect(error.context).toEqual({ method });
  });

  it('checks the method before the base URL', () => {
    const tool = makeTool([], { method: 'CONNECT' as any });

    expect(() => buildHttpRequest(tool, {}, { baseUrl: 'file:///etc/passwd' })).toThrow(/CONNECT opens a tunnel/);
  });

  it('sends a query operation with its JSON body', () => {
    const tool = makeTool([{ inputKey: 'filter', type: 'body', key: 'filter' }], {
      path: '/search',
      method: 'query',
    });
    const built = buildHttpRequest(tool, { filter: { name: 'ada' } });

    expect(built.method).toBe('QUERY');
    expect(built.url).toBe('https://api.example.com/search');
    expect(built.body).toBe('{"filter":{"name":"ada"}}');
    expect(built.headers['content-type']).toBe('application/json');
  });

  it('sends an additional operation with its path and query parameters', () => {
    const tool = makeTool(
      [
        { inputKey: 'id', type: 'path', key: 'id', required: true },
        { inputKey: 'target', type: 'query', key: 'target' },
      ],
      { path: '/items/{id}', method: 'LINK' },
    );
    const built = buildHttpRequest(tool, { id: '7', target: '/items/8' });

    expect(built.method).toBe('LINK');
    expect(built.url).toBe('https://api.example.com/items/7?target=%2Fitems%2F8');
  });
});

describe('mapper locations', () => {
  const entry = (type: unknown, overrides: Partial<ParameterMapper> = {}): ParameterMapper =>
    ({ inputKey: 'x', type: type as any, key: 'x', ...overrides }) as ParameterMapper;
  const security = { scheme: 's', type: 'apiKey', apiKeyName: 'x' } as const;

  it.each(['querystring', 'PATH', 'constructor', '__proto__', 'toString', '', undefined, null, 42, {}])(
    'rejects the unknown location %p whether or not a value is given',
    (type) => {
      const tool = makeTool([entry(type)], { path: '/things' });

      for (const input of [{ x: 'value' }, {}]) {
        let caught: unknown;
        try {
          buildHttpRequest(tool, input);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(RequestBuildError);
        expect((caught as RequestBuildError).message).toMatch(/Unknown parameter location/);
        expect((caught as RequestBuildError).context).toEqual({ param: 'x', inputKey: 'x', location: type });
      }
    },
  );

  it('rejects an unknown location even when the entry is optional and there is a value', () => {
    const tool = makeTool([entry('matrix', { required: false })], { path: '/things' });

    expect(() => buildHttpRequest(tool, { x: 1 })).toThrow(RequestBuildError);
  });

  it.each(['querystring', 'constructor', undefined, 42])(
    'rejects a security entry at the unknown location %p instead of sending it as a cookie',
    (type) => {
      const tool = makeTool([entry(type, { security })], { path: '/things' });

      expect(() => buildHttpRequest(tool, { x: 'secret' })).toThrow(/Unknown parameter location/);
      expect(() => buildHttpRequest(tool, {})).toThrow(/Unknown parameter location/);
    },
  );

  it.each(['path', 'body'])('rejects a security entry at the %s location, with or without a value', (type) => {
    const tool = makeTool([entry(type, { security })], { path: '/things' });

    for (const input of [{ x: 'secret' }, {}]) {
      expect(() => buildHttpRequest(tool, input)).toThrow(/cannot be sent in the .*credentials go in a header/);
    }
  });

  it.each([
    ['header', (built: ReturnType<typeof buildHttpRequest>) => built.headers['x']],
    ['query', (built: ReturnType<typeof buildHttpRequest>) => built.query['x']?.[0]],
    ['cookie', (built: ReturnType<typeof buildHttpRequest>) => built.cookies['x']],
  ])('still sends a security entry at the %s location', (type, read) => {
    const tool = makeTool([entry(type, { security })], { path: '/things' });

    expect(read(buildHttpRequest(tool, { x: 'secret' }))).toBe('secret');
  });
});

/**
 * Catch a RequestBuildError (and only one) from a call, so its message and
 * context can be checked.
 */
function buildFailure(call: () => unknown): RequestBuildError {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(RequestBuildError);
    return error as RequestBuildError;
  }
  throw new Error('expected a RequestBuildError');
}

/** A tool at /foo on https://example.com, as in the OpenAPI 3.2.1 querystring examples */
function fooTool(mapper: ParameterMapper[]): McpOpenAPITool {
  return makeTool(mapper, { path: '/foo', method: 'get', servers: [{ url: 'https://example.com' }] });
}

describe('style: cookie (OpenAPI 3.2 "Style Values", "Style Examples")', () => {
  // The Style Examples value set: a parameter named `color` with
  //   string -> "blue", array -> ["blue", "black", "brown"], object -> { "R": 100, "G": 200, "B": 150 }
  const VALUES = {
    string: 'blue',
    array: ['blue', 'black', 'brown'],
    object: { R: 100, G: 200, B: 150 },
  } as const;
  const cookieTool = (explode?: boolean) =>
    fooTool([{ inputKey: 'color', type: 'cookie', key: 'color', style: 'cookie', ...(explode !== undefined && { explode }) }]);

  // | cookie | true | color= | color=blue | color=blue; color=black; color=brown | R=100; G=200; B=150 |
  // explode defaults to true for `cookie` ("Fixed Fields for use with schema": explode)
  it.each([
    [true, 'string', 'color=blue'],
    [true, 'array', 'color=blue; color=black; color=brown'],
    [true, 'object', 'R=100; G=200; B=150'],
    [undefined, 'string', 'color=blue'],
    [undefined, 'array', 'color=blue; color=black; color=brown'],
    [undefined, 'object', 'R=100; G=200; B=150'],
    // | cookie | false | color= | color=blue | n/a | n/a |
    [false, 'string', 'color=blue'],
  ] as const)('explode %p, %s value: Cookie header %j', (explode, kind, expected) => {
    const built = buildHttpRequest(cookieTool(explode), { color: VALUES[kind] });

    expect(built.headers['Cookie']).toBe(expected);
    expect(built.url).toBe('https://example.com/foo');
  });

  // | cookie | false | ... | n/a | n/a |: the Cookie header forbids the
  // unencoded commas these would need (3.2.1, "Fixed Fields for use with schema")
  it.each(['array', 'object'] as const)('explode false with an %s value is n/a and throws', (kind) => {
    const error = buildFailure(() => buildHttpRequest(cookieTool(false), { color: VALUES[kind] }));

    expect(error.message).toMatch(/style 'cookie' with explode false, which cannot serialize/);
    expect(error.message).toContain(kind === 'array' ? 'an array' : 'an object');
    expect(error.context).toEqual({ param: 'color', location: 'cookie', style: 'cookie' });
  });

  // The `undefined` column (`color=`): an absent or null value is not sent,
  // as for every other parameter of this builder
  it.each([{}, { color: undefined }, { color: null }])('does not send an absent value (%p)', (input) => {
    const built = buildHttpRequest(cookieTool(), input);

    expect(built.headers['Cookie']).toBeUndefined();
    expect(built.cookies).toEqual({});
  });

  it('serializes the specification example of an exploded cookie object verbatim', () => {
    // Parameter Object Examples: "A cookie parameter with an exploded object (the default for style: cookie)"
    //   dataValue: { greeting: 'Hello%2C%20world!', code: 42 }  serializedValue: "greeting=Hello%2C%20world!; code=42"
    const tool = fooTool([{ inputKey: 'cookie', type: 'cookie', key: 'cookie', style: 'cookie' }]);
    const built = buildHttpRequest(tool, { cookie: { greeting: 'Hello%2C%20world!', code: 42 } });

    expect(built.headers['Cookie']).toBe('greeting=Hello%2C%20world!; code=42');
    expect(built.cookies).toEqual({ greeting: 'Hello%2C%20world!', code: '42' });
  });

  it('keeps every pair of an exploded array in the Cookie header and the first value in `cookies`', () => {
    const built = buildHttpRequest(cookieTool(), { color: VALUES.array });

    expect(built.cookies).toEqual({ color: 'blue' });
    expect(built.headers['Cookie']).toBe('color=blue; color=black; color=brown');
  });

  it.each([
    ['a comma', 'a,b'],
    ['a space', 'a b'],
    ['a semicolon', 'a;b'],
    ['a double quote', 'a"b'],
    ['a backslash', 'a\\b'],
    ['CR LF', 'a\r\nb'],
    ['NUL', 'a\u0000b'],
  ])('applies no escaping, so a value with %s is rejected (RFC 6265 cookie-octet)', (_label, bad) => {
    for (const value of [bad, [bad], { k: bad }]) {
      const error = buildFailure(() => buildHttpRequest(cookieTool(), { color: value }));

      expect(error.message).toMatch(/cookie-octet violation/);
    }
  });

  it('checks every cookie name it sends: the property names of an exploded object, not the unused parameter name', () => {
    const tool = fooTool([{ inputKey: 'c', type: 'cookie', key: 'not a token', style: 'cookie' }]);

    expect(buildHttpRequest(tool, { c: { ok: 1 } }).headers['Cookie']).toBe('ok=1');
    expect(() => buildHttpRequest(tool, { c: 'v' })).toThrow(/Invalid cookie name 'not a token'/);
    expect(() => buildHttpRequest(tool, { c: ['v'] })).toThrow(/Invalid cookie name 'not a token'/);
    expect(() => buildHttpRequest(cookieTool(), { color: { 'bad name': 1 } })).toThrow(/Invalid cookie name 'bad name'/);
    expect(() => buildHttpRequest(cookieTool(), { color: { 'a\r\nb': 1 } })).toThrow(/Invalid cookie name/);
  });

  it('skips undefined object properties and rejects null or nested ones', () => {
    expect(buildHttpRequest(cookieTool(), { color: { R: 1, G: undefined } }).headers['Cookie']).toBe('R=1');
    expect(() => buildHttpRequest(cookieTool(), { color: { R: null } })).toThrow(/received null/);
    expect(() => buildHttpRequest(cookieTool(), { color: { R: [1] } })).toThrow(/received an array/);
    expect(() => buildHttpRequest(cookieTool(), { color: [{ R: 1 }] })).toThrow(/received object/);
  });

  it('sends no cookie for an empty array or object', () => {
    expect(buildHttpRequest(cookieTool(), { color: [] }).headers['Cookie']).toBeUndefined();
    expect(buildHttpRequest(cookieTool(), { color: {} }).headers['Cookie']).toBeUndefined();
  });

  it('folds style: cookie pairs together with other cookie parameters and credentials, in mapper order', () => {
    const tool = fooTool([
      { inputKey: 'session', type: 'cookie', key: 'session', security: { scheme: 's', type: 'apiKey', apiKeyIn: 'cookie' } },
      { inputKey: 'color', type: 'cookie', key: 'color', style: 'cookie' },
      { inputKey: 'theme', type: 'cookie', key: 'theme' },
    ]);
    const built = buildHttpRequest(tool, { session: 'tok', color: ['blue', 'black'], theme: 'dark' });

    expect(built.headers['Cookie']).toBe('session=tok; color=blue; color=black; theme=dark');
    expect(built.cookies).toEqual({ session: 'tok', color: 'blue', theme: 'dark' });
  });

  it('serializes a large exploded array without spreading it into a call', () => {
    const many = Array.from({ length: 100_000 }, (_, i) => `v${i}`);
    const built = buildHttpRequest(cookieTool(), { color: many });

    expect(built.headers['Cookie'].split('; ')).toHaveLength(100_000);
    expect(built.headers['Cookie'].endsWith('color=v99999')).toBe(true);
  });
});

describe('cookie parameters without style: cookie keep their output', () => {
  // The default style for `in: cookie` is `form`. OpenAPI 3.2.1 calls
  // `explode: false` invalid with cookies, and a comma-joined array is what
  // form + explode false produces; this builder has always comma-joined
  // arrays, whatever style/explode say, and keeps doing so.
  it.each([
    [undefined, undefined],
    ['form', undefined],
    ['form', true],
    ['form', false],
    [undefined, false],
  ])('style %p, explode %p: an array is comma-joined, a primitive sent as is', (style, explode) => {
    const tool = fooTool([
      { inputKey: 'c', type: 'cookie', key: 'c', ...(style && { style }), ...(explode !== undefined && { explode }) },
    ]);

    expect(buildHttpRequest(tool, { c: ['a', 'b'] }).headers['Cookie']).toBe('c=a,b');
    expect(buildHttpRequest(tool, { c: 7 }).headers['Cookie']).toBe('c=7');
    expect(() => buildHttpRequest(tool, { c: { R: 1 } })).toThrow(/must serialize to a primitive; received object/);
  });
});

describe('parameters defined with content (OpenAPI "Fixed Fields for use with content")', () => {
  const contentTool = (type: 'path' | 'query' | 'header' | 'cookie', contentType: unknown, key = 'p') =>
    makeTool([{ inputKey: 'p', type, key, required: true, serialization: { contentType } as any }], {
      path: type === 'path' ? `/t/{${key}}` : '/t',
      method: 'get',
      servers: [{ url: 'https://example.com' }],
    });

  describe('in the query', () => {
    it('sends the percent-encoded JSON text (the specification `coordinates` example)', () => {
      // in: query, name: coordinates, content: application/json
      //   dataValue: { lat: 40.6, long: -73.9 }
      //   serializedValue: coordinates=%7B%22lat%22%3A40.6%2C%22long%22%3A-73.9%7D
      const built = buildHttpRequest(contentTool('query', 'application/json', 'coordinates'), {
        p: { lat: 40.6, long: -73.9 },
      });

      expect(built.url).toBe('https://example.com/t?coordinates=%7B%22lat%22%3A40.6%2C%22long%22%3A-73.9%7D');
      expect(built.query).toEqual({ coordinates: ['{"lat":40.6,"long":-73.9}'] });
      expect(built.queryString).toBeUndefined();
    });

    it.each(['application/json', 'application/vnd.api+json', 'Application/JSON; charset=utf-8', ' application/json '])(
      'treats %j as JSON',
      (contentType) => {
        expect(buildHttpRequest(contentTool('query', contentType), { p: 'x' }).url).toBe('https://example.com/t?p=%22x%22');
      },
    );

    it('sends JSON for every JSON value: arrays, numbers, booleans, strings', () => {
      const call = (p: unknown) => buildHttpRequest(contentTool('query', 'application/json'), { p }).query['p'];

      expect(call([1, 'a', null])).toEqual(['[1,"a",null]']);
      expect(call(0)).toEqual(['0']);
      expect(call(false)).toEqual(['false']);
      expect(call('')).toEqual(['""']);
    });

    it('sends another media type as the value itself, percent-encoded', () => {
      const call = (p: unknown) => buildHttpRequest(contentTool('query', 'text/plain'), { p }).url;

      expect(call('a b&c=d/é')).toBe('https://example.com/t?p=a%20b%26c%3Dd%2F%C3%A9');
      expect(call(42)).toBe('https://example.com/t?p=42');
      expect(call(true)).toBe('https://example.com/t?p=true');
      expect(call(10n)).toBe('https://example.com/t?p=10');
    });

    it.each([
      ['an object', { a: 1 }],
      ['an array', ['a']],
      ['a function', () => 1],
      ['a symbol', Symbol('s')],
    ])('refuses %s for a media type that is not JSON or a form', (label, p) => {
      const error = buildFailure(() => buildHttpRequest(contentTool('query', 'text/plain'), { p }));

      expect(error.message).toBe(
        `query parameter 'p' is sent as text/plain, which needs a string or another primitive; received ${label}`,
      );
      expect(error.context).toEqual({ param: 'p', location: 'query', contentType: 'text/plain' });
    });

    it('encodes a form-urlencoded value once as a form and again as one query value', () => {
      // The form string's own `&` and `=` must not split the outer query
      const built = buildHttpRequest(contentTool('query', 'application/x-www-form-urlencoded'), {
        p: { a: '1', b: 'x y+z', tags: ['t1', 't2'] },
      });

      expect(built.query['p']).toEqual(['a=1&b=x+y%2Bz&tags=t1&tags=t2']);
      expect(built.url).toBe('https://example.com/t?p=a%3D1%26b%3Dx%2By%252Bz%26tags%3Dt1%26tags%3Dt2');
      expect(new URL(built.url).searchParams.get('p')).toBe('a=1&b=x+y%2Bz&tags=t1&tags=t2');
    });

    it('refuses a form-urlencoded value that is not an object', () => {
      const error = buildFailure(() =>
        buildHttpRequest(contentTool('query', 'application/x-www-form-urlencoded'), { p: 'a=1' }),
      );

      expect(error.message).toBe(
        `query parameter 'p' is sent as application/x-www-form-urlencoded, which needs an object; received "a=1"`,
      );
    });

    it('ignores style, explode and allowReserved, which do not apply to content', () => {
      const tool = makeTool(
        [
          {
            inputKey: 'p',
            type: 'query',
            key: 'p',
            style: 'deepObject',
            explode: true,
            allowReserved: true,
            serialization: { contentType: 'application/json' },
          },
        ],
        { path: '/t' },
      );

      expect(buildHttpRequest(tool, { p: { a: '/' } }).url).toBe('https://api.example.com/t?p=%7B%22a%22%3A%22%2F%22%7D');
    });

    it('treats null like an absent value, as for every non-body parameter', () => {
      const tool = contentTool('query', 'application/json');

      expect(() => buildHttpRequest(tool, { p: null })).toThrow(/Required query parameter 'p'/);
    });
  });

  describe('in the path', () => {
    it('percent-encodes the serialized value', () => {
      expect(buildHttpRequest(contentTool('path', 'application/json'), { p: { a: '1/2' } }).url).toBe(
        'https://example.com/t/%7B%22a%22%3A%221%2F2%22%7D',
      );
      expect(buildHttpRequest(contentTool('path', 'text/plain'), { p: '../x y' }).url).toBe(
        'https://example.com/t/..%2Fx%20y',
      );
      expect(buildHttpRequest(contentTool('path', 'application/x-www-form-urlencoded'), { p: { a: 'b c' } }).url).toBe(
        'https://example.com/t/a%3Db%2Bc',
      );
    });

    it('takes a replacement pattern in a path key or value literally', () => {
      const tool = makeTool([{ inputKey: 'p', type: 'path', key: 'a$&b', style: 'matrix', required: true }], {
        path: '/t/{a$&b}',
      });

      expect(buildHttpRequest(tool, { p: 'v' }).url).toBe('https://api.example.com/t/;a$&b=v');
    });
  });

  describe('in a header', () => {
    it('sends the JSON text unchanged, without percent-encoding', () => {
      const built = buildHttpRequest(contentTool('header', 'application/json', 'X-Filter'), {
        p: { name: 'Ada Lovelace', tags: ['a', 'b'] },
      });

      expect(built.headers['X-Filter']).toBe('{"name":"Ada Lovelace","tags":["a","b"]}');
    });

    it('cannot be used for header injection: JSON escapes CR, LF and NUL inside strings', () => {
      const built = buildHttpRequest(contentTool('header', 'application/json', 'X-Filter'), {
        p: { s: 'a\r\nX-Injected: 1\u0000' },
      });

      expect(built.headers['X-Filter']).toBe('{"s":"a\\r\\nX-Injected: 1\\u0000"}');
      expect(built.headers['X-Filter']).not.toMatch(/[\r\n\u0000]/);
    });

    it('rejects CR, LF or NUL in a value sent as is (any other media type)', () => {
      for (const bad of ['a\r\nX-Injected: 1', 'a\nb', 'a\u0000b']) {
        expect(() => buildHttpRequest(contentTool('header', 'text/plain', 'X-T'), { p: bad })).toThrow(/header injection/);
      }
      expect(buildHttpRequest(contentTool('header', 'text/plain', 'X-T'), { p: 'W/"etag"' }).headers['X-T']).toBe(
        'W/"etag"',
      );
    });
  });

  describe('in a cookie', () => {
    it('sends the serialized text unchanged when it is a valid cookie value', () => {
      expect(buildHttpRequest(contentTool('cookie', 'application/json'), { p: 42 }).headers['Cookie']).toBe('p=42');
      expect(buildHttpRequest(contentTool('cookie', 'text/plain'), { p: 'abc%2C' }).headers['Cookie']).toBe('p=abc%2C');
      expect(buildHttpRequest(contentTool('cookie', 'text/plain'), { p: 'v' }).cookies).toEqual({ p: 'v' });
    });

    it('rejects text the Cookie header cannot carry: JSON strings and objects (quotes), commas', () => {
      for (const p of [{ a: 1 }, 'abc', [1, 2]]) {
        expect(() => buildHttpRequest(contentTool('cookie', 'application/json'), { p })).toThrow(/cookie-octet violation/);
      }
      expect(() => buildHttpRequest(contentTool('cookie', 'text/plain'), { p: 'a,b' })).toThrow(/cookie-octet violation/);
      expect(() => buildHttpRequest(contentTool('cookie', 'text/plain', 'bad name'), { p: 'v' })).toThrow(
        /Invalid cookie name/,
      );
    });
  });

  it.each([
    ['a number', 42, '42'],
    ['an empty string', '', '""'],
    ['parameters only', '; charset=utf-8', '"; charset=utf-8"'],
    ['null', null, 'null'],
  ])('rejects a serialization.contentType that is %s', (_label, contentType, shown) => {
    const error = buildFailure(() => buildHttpRequest(contentTool('query', contentType), { p: 'x' }));

    expect(error.message).toBe(`query parameter 'p' (input key 'p') has an invalid media type ${shown} in serialization.contentType`);
    expect(error.context).toEqual({ param: 'p', inputKey: 'p', location: 'query' });
  });
});

describe('whole-query parameters (OpenAPI 3.2 in: querystring)', () => {
  const wholeQueryTool = (contentType: string | undefined, extra: ParameterMapper[] = [], required = false) =>
    fooTool([
      {
        inputKey: 'q',
        type: 'query',
        key: 'q',
        wholeQuery: true,
        required,
        ...(contentType !== undefined && { serialization: { contentType } }),
      },
      ...extra,
    ]);
  const apiKey = (type: 'query' | 'header' | 'cookie' = 'query'): ParameterMapper => ({
    inputKey: 'key',
    type,
    key: 'api_key',
    security: { scheme: 'k', type: 'apiKey', apiKeyName: 'api_key', apiKeyIn: type },
  });

  describe('application/x-www-form-urlencoded', () => {
    it('makes the object properties the query pairs (the specification example)', () => {
      // in: querystring, name: metadata, content: application/x-www-form-urlencoded
      //   dataValue: { foo: 'a + b', bar: true }   serializedValue: foo=a+%2B+b&bar=true
      const built = buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded'), {
        q: { foo: 'a + b', bar: true },
      });

      expect(built.url).toBe('https://example.com/foo?foo=a+%2B+b&bar=true');
      expect(built.query).toEqual({ foo: ['a + b'], bar: ['true'] });
      expect(built.queryString).toBeUndefined();
    });

    it('serializes object properties as JSON text (the specification "URL Encoded Form with JSON Values" example)', () => {
      const built = buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded'), {
        q: {
          id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
          address: { streetAddress: '123 Example Dr.', city: 'Somewhere', state: 'CA', zip: '99999+1234' },
        },
      });

      expect(built.url).toBe(
        'https://example.com/foo?id=f81d4fae-7dec-11d0-a765-00a0c91e6bf6&address=%7B%22streetAddress%22%3A%22123+Example+Dr.%22%2C%22city%22%3A%22Somewhere%22%2C%22state%22%3A%22CA%22%2C%22zip%22%3A%2299999%2B1234%22%7D',
      );
    });

    // The same serializer as a form body, so both behave identically
    it.each([
      ['scalars', { a: 'x y', n: 1, b: false, z: null }],
      ['arrays (one pair per item)', { tags: ['a', 'b c'], empty: [] }],
      ['objects (JSON text)', { o: { k: [1, { d: 'e' }] } }],
      ['undefined properties (left out)', { keep: 1, drop: undefined }],
      ['reserved characters', { 'k&=': 'v&=+%#/?' }],
    ])('serializes %s exactly as a form body does', (_label, value) => {
      const query = buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded'), { q: value });
      const body = buildHttpRequest(
        withUploadPath(
          makeTool([
            { inputKey: 'b', type: 'body', key: 'b', wholeBody: true, serialization: { contentType: 'application/x-www-form-urlencoded' } },
          ]),
        ),
        { b: value },
      );

      expect(query.url).toBe(`https://example.com/foo${body.body ? `?${body.body}` : ''}`);
    });

    it('fails like a form body on an array item that is not a primitive', () => {
      expect(() =>
        buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded'), { q: { tags: [{ a: 1 }] } }),
      ).toThrow("query parameter 'tags' must serialize to a primitive; received object");
    });

    it.each([
      ['a string', 'a=1&b=2', '"a=1&b=2"'],
      ['an array', [['a', '1']], 'an array'],
      ['a number', 3, '3'],
    ])('refuses %s: a form needs an object', (_label, q, shown) => {
      const error = buildFailure(() => buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded'), { q }));

      expect(error.message).toBe(
        `Whole-query parameter 'q' is sent as application/x-www-form-urlencoded, which needs an object; received ${shown}`,
      );
      expect(error.context).toEqual({
        param: 'q',
        inputKey: 'q',
        location: 'query',
        contentType: 'application/x-www-form-urlencoded',
      });
    });

    it('sends nothing for an empty object', () => {
      const built = buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded'), { q: {} });

      expect(built.url).toBe('https://example.com/foo');
      expect(built.query).toEqual({});
    });

    it('appends a query credential as one more form pair, in mapper order', () => {
      const after = buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded', [apiKey()]), {
        q: { foo: 'a b' },
        key: 'tok en',
      });
      expect(after.url).toBe('https://example.com/foo?foo=a+b&api_key=tok+en');
      expect(after.query).toEqual({ foo: ['a b'], api_key: ['tok en'] });

      const before = buildHttpRequest(
        fooTool([apiKey(), { inputKey: 'q', type: 'query', key: 'q', wholeQuery: true, serialization: { contentType: 'application/x-www-form-urlencoded' } }]),
        { q: { foo: 'a' }, key: 'k' },
      );
      expect(before.url).toBe('https://example.com/foo?api_key=k&foo=a');
    });

    it('applies the Encoding Objects, as a form body does (they used to be ignored: id=x&list=a&list=b)', () => {
      const tool = fooTool([
        {
          inputKey: 'q',
          type: 'query',
          key: 'q',
          wholeQuery: true,
          serialization: {
            contentType: 'application/x-www-form-urlencoded',
            encoding: { id: { contentType: 'application/json' }, list: { style: 'form', explode: false } },
          },
        },
      ]);

      const built = buildHttpRequest(tool, { q: { id: 'x', list: ['a', 'b'], other: ['c', 'd'] } });
      expect(built.url).toBe('https://example.com/foo?id=%22x%22&list=a%2Cb&other=c&other=d');
      expect(built.query).toEqual({ id: ['"x"'], list: ['a,b'], other: ['c', 'd'] });
    });

    it('serializes a large object without recursion or argument spreading', () => {
      const many = Array.from({ length: 200_000 }, (_, i) => i);
      const built = buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded'), { q: { n: many } });

      expect(built.query['n']).toHaveLength(200_000);
      expect(built.url.endsWith('&n=199999')).toBe(true);
    });
  });

  describe('JSON', () => {
    it('makes the percent-encoded JSON text the query string (the specification example)', () => {
      // in: querystring, name: json, content: application/json
      //   dataValue: { numbers: [1, 2], flag: null }
      //   full URL: https://example.com/foo?%7B%22numbers%22%3A%5B1%2C2%5D%2C%22flag%22%3Anull%7D
      const built = buildHttpRequest(wholeQueryTool('application/json'), { q: { numbers: [1, 2], flag: null } });

      expect(built.url).toBe('https://example.com/foo?%7B%22numbers%22%3A%5B1%2C2%5D%2C%22flag%22%3Anull%7D');
      expect(built.queryString).toBe('%7B%22numbers%22%3A%5B1%2C2%5D%2C%22flag%22%3Anull%7D');
      expect(built.query).toEqual({});
    });

    it('serializes any JSON value, +json media types included', () => {
      expect(buildHttpRequest(wholeQueryTool('application/json'), { q: 'abc' }).url).toBe('https://example.com/foo?%22abc%22');
      expect(buildHttpRequest(wholeQueryTool('application/problem+json'), { q: [1] }).url).toBe('https://example.com/foo?%5B1%5D');
    });

    it('cannot add a query credential to a query string that has no pairs', () => {
      const error = buildFailure(() =>
        buildHttpRequest(wholeQueryTool('application/json', [apiKey()]), { q: { a: 1 }, key: 'secret' }),
      );

      expect(error.message).toBe(
        "Security parameter 'api_key' cannot be added to the query string: whole-query parameter 'q' is serialized as application/json, which has no name=value pairs to add a credential to; send the credential in a header or a cookie instead",
      );
      expect(error.context).toEqual({ param: 'api_key', location: 'query', wholeQuery: 'q' });
    });

    it('sends the credential when the whole-query value is absent, and other credentials always', () => {
      expect(buildHttpRequest(wholeQueryTool('application/json', [apiKey()]), { key: 'secret' }).url).toBe(
        'https://example.com/foo?api_key=secret',
      );
      expect(buildHttpRequest(wholeQueryTool('application/json', [apiKey()]), { q: 1 }).url).toBe('https://example.com/foo?1');

      const header = buildHttpRequest(wholeQueryTool('application/json', [apiKey('header')]), { q: 1, key: 'k' });
      expect(header.url).toBe('https://example.com/foo?1');
      expect(header.headers['api_key']).toBe('k');
    });

    it('serializes 1000 levels of nesting and refuses 1001', () => {
      let ok: unknown = 0;
      for (let i = 0; i < 1000; i++) ok = [ok];
      expect(buildHttpRequest(wholeQueryTool('application/json'), { q: ok }).queryString).toBe(
        `${'%5B'.repeat(1000)}0${'%5D'.repeat(1000)}`,
      );

      const error = buildFailure(() => buildHttpRequest(wholeQueryTool('application/json'), { q: [ok] }));
      expect(error.message).toBe("query parameter 'q' cannot be serialized as JSON: it nests deeper than 1000 levels");
      expect(error.context).toEqual({ param: 'q', location: 'query' });
    });

    it('refuses a value nested far deeper than the stack allows without overflowing', () => {
      let deep: Record<string, unknown> = {};
      for (let i = 0; i < 200_000; i++) deep = { d: deep };

      expect(() => buildHttpRequest(wholeQueryTool('application/json'), { q: deep })).toThrow(
        /cannot be serialized as JSON: it nests deeper than 1000 levels/,
      );
    });

    it('refuses a cyclic value', () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic['self'] = { back: [cyclic] };

      expect(() => buildHttpRequest(wholeQueryTool('application/json'), { q: cyclic })).toThrow(
        "query parameter 'q' cannot be serialized as JSON: it contains itself (a cycle)",
      );
      const loop: unknown[] = [];
      loop.push(loop);
      expect(() => buildHttpRequest(wholeQueryTool('application/json'), { q: loop })).toThrow(/a cycle/);
      // inside a form value too
      expect(() =>
        buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded'), { q: { inner: cyclic } }),
      ).toThrow("query parameter 'inner' cannot be serialized as JSON: it contains itself (a cycle)");
    });

    it('serializes an object shared (not cyclic) at several places, each time', () => {
      const shared = { s: 1 };
      const built = buildHttpRequest(wholeQueryTool('application/json'), { q: { a: shared, b: [shared, shared] } });

      expect(decodeURIComponent(built.queryString!)).toBe('{"a":{"s":1},"b":[{"s":1},{"s":1}]}');
    });

    it('counts the depth of a shared object at its deepest position', () => {
      // `chain` is 600 levels deep: reached first at depth 2, then under 500 wrappers
      let chain: unknown = 0;
      for (let i = 0; i < 600; i++) chain = [chain];
      let wrapped: unknown = chain;
      for (let i = 0; i < 500; i++) wrapped = [wrapped];

      expect(() => buildHttpRequest(wholeQueryTool('application/json'), { q: [chain, wrapped] })).toThrow(
        /nests deeper than 1000 levels/,
      );
      expect(buildHttpRequest(wholeQueryTool('application/json'), { q: [chain, chain] }).queryString).toBeDefined();
    });

    it('refuses a value with exponentially many paths at once, instead of letting JSON.stringify walk them all', () => {
      // 2^40 paths through 40 shared objects. Every property read is counted,
      // and a read past the budget throws: whatever walks the value one path
      // at a time (JSON.stringify without the guard) fails fast with "walked
      // too far" instead of running for hours. The guard walks each object
      // once, so it needs two reads per object.
      let reads = 0;
      const counted = (child: unknown) => ({
        get a() {
          if (++reads > 10_000) throw new Error('walked too far');
          return child;
        },
        get b() {
          if (++reads > 10_000) throw new Error('walked too far');
          return child;
        },
      });
      let node: unknown = {};
      for (let i = 0; i < 40; i++) node = counted(node);

      expect(() => buildHttpRequest(wholeQueryTool('application/json'), { q: node })).toThrow(
        "query parameter 'q' cannot be serialized as JSON: its JSON text would be longer than 536870888 characters",
      );
      expect(reads).toBeLessThanOrEqual(80);
    });

    it('bounds the JSON text length wherever it grows: a value, a shared object, a finished one', () => {
      // one 600,000-character string, referenced many times
      const s = 'x'.repeat(600_000);
      const half = () => Array(500).fill(s); // about 3e8 characters: fits on its own
      const call = (q: unknown) => () => buildHttpRequest(wholeQueryTool('application/json'), { q });

      expect(call(Array(1000).fill(s))).toThrow(/its JSON text would be longer than 536870888 characters/);
      const shared = half();
      expect(call([shared, shared])).toThrow(/its JSON text would be longer than 536870888 characters/);
      expect(call([half(), half()])).toThrow(/its JSON text would be longer than 536870888 characters/);
      expect(buildHttpRequest(wholeQueryTool('application/json'), { q: Array(10).fill(s) }).queryString).toHaveLength(
        10 * 600_000 + 10 * 6 + 9 * 3 + 6,
      );
    });

    it('leaves out the object members JSON leaves out, and writes null for them in arrays', () => {
      const built = buildHttpRequest(wholeQueryTool('application/json'), {
        q: { u: undefined, f: () => 1, s: Symbol('s'), keep: 1, list: [undefined, () => 1] },
      });

      expect(decodeURIComponent(built.queryString!)).toBe('{"keep":1,"list":[null,null]}');
    });

    it('turns what JSON.stringify refuses into a RequestBuildError', () => {
      expect(() => buildHttpRequest(wholeQueryTool('application/json'), { q: { n: 1n } })).toThrow(
        "query parameter 'q' cannot be serialized as JSON: Do not know how to serialize a BigInt",
      );
      const multiLine = { toJSON: () => { throw new Error('first line\nsecond line'); } };
      expect(() => buildHttpRequest(wholeQueryTool('application/json'), { q: multiLine })).toThrow(
        /^query parameter 'q' cannot be serialized as JSON: first line$/,
      );
      const thrower = { toJSON: () => { throw 'plain'; } };
      expect(() => buildHttpRequest(wholeQueryTool('application/json'), { q: thrower })).toThrow(
        `query parameter 'q' cannot be serialized as JSON: "plain"`,
      );
      expect(() => buildHttpRequest(wholeQueryTool('application/json'), { q: () => 1 })).toThrow(
        "query parameter 'q' has no JSON representation; received a function",
      );
    });

    it('turns a failure while the value is checked into a RequestBuildError', () => {
      const call = (q: unknown) => () => buildHttpRequest(wholeQueryTool('application/json'), { q });
      const expectBuildError = (q: unknown, message: string | RegExp) => {
        expect(call(q)).toThrow(RequestBuildError);
        expect(call(q)).toThrow(message);
      };
      // The check reads every member: a getter that throws, an Error or anything else
      const getter = Object.defineProperty({}, 'bad', {
        enumerable: true,
        get: () => {
          throw new Error('getter failed\nsecond line');
        },
      });
      expectBuildError(getter, /^query parameter 'q' cannot be serialized as JSON: getter failed$/);
      const plain = Object.defineProperty({}, 'bad', {
        enumerable: true,
        get: () => {
          throw 'plain';
        },
      });
      expectBuildError(plain, `query parameter 'q' cannot be serialized as JSON: "plain"`);
      // A nested array element, and a proxy whose keys cannot be listed
      expectBuildError([getter], /cannot be serialized as JSON: getter failed$/);
      const proxy = new Proxy(
        {},
        {
          ownKeys: () => {
            throw new TypeError('no keys');
          },
        },
      );
      expectBuildError({ inner: proxy }, /cannot be serialized as JSON: no keys$/);
      // A RequestBuildError thrown from the value is passed on as it is
      const own = new RequestBuildError('from the value', {});
      const rethrow = Object.defineProperty({}, 'bad', {
        enumerable: true,
        get: () => {
          throw own;
        },
      });
      let thrown: unknown;
      try {
        call(rethrow)();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(own);
      // A form whole query and a JSON property of a form object are checked the same way
      expect(() => buildHttpRequest(wholeQueryTool('application/x-www-form-urlencoded'), { q: { a: getter } })).toThrow(
        /query parameter 'a' cannot be serialized as JSON: getter failed$/,
      );
    });

    it('serializes a large array', () => {
      const many = Array.from({ length: 1_000_000 }, () => 7);
      const built = buildHttpRequest(wholeQueryTool('application/json'), { q: many });

      expect(built.queryString).toBe(`%5B${Array(1_000_000).fill('7').join('%2C')}%5D`);
    });
  });

  describe('other media types', () => {
    it('percent-encodes the value as the query string (the specification JSONPath example)', () => {
      // in: querystring, name: selector, content: application/jsonpath, example: $.a.b[1:1]
      //   full URL: https://example.com/foo?%24.a.b%5B1%3A1%5D
      const built = buildHttpRequest(wholeQueryTool('application/jsonpath'), { q: '$.a.b[1:1]' });

      expect(built.url).toBe('https://example.com/foo?%24.a.b%5B1%3A1%5D');
      expect(built.queryString).toBe('%24.a.b%5B1%3A1%5D');
      expect(built.query).toEqual({});
    });

    it('percent-encodes everything in a text/plain value, delimiters included', () => {
      // "Extending Support for Querystring Formats": a format defined outside OpenAPI
      expect(buildHttpRequest(wholeQueryTool('text/plain'), { q: 'a[0]=1&b=x y' }).url).toBe(
        'https://example.com/foo?a%5B0%5D%3D1%26b%3Dx%20y',
      );
      expect(buildHttpRequest(wholeQueryTool('text/plain'), { q: 'a\r\n\u0000' }).queryString).toBe('a%0D%0A%00');
    });

    it('gives an empty string as an empty queryString and a URL without ?', () => {
      const built = buildHttpRequest(wholeQueryTool('text/plain'), { q: '' });

      expect(built.url).toBe('https://example.com/foo');
      expect(built.queryString).toBe('');
    });

    it('needs a primitive', () => {
      expect(() => buildHttpRequest(wholeQueryTool('text/plain'), { q: { a: 1 } })).toThrow(
        "query parameter 'q' is sent as text/plain, which needs a string or another primitive; received an object",
      );
    });

    it('refuses a query credential', () => {
      expect(() => buildHttpRequest(wholeQueryTool('text/plain', [apiKey()]), { q: 'x', key: 'k' })).toThrow(
        /cannot be added to the query string: whole-query parameter 'q' is serialized as text\/plain/,
      );
    });
  });

  describe('mapper rules', () => {
    it.each([{ q: 'x' }, {}])('needs a media type, whatever the input holds (%p)', (input) => {
      const error = buildFailure(() => buildHttpRequest(wholeQueryTool(undefined), input));

      expect(error.message).toBe(
        "Whole-query parameter 'q' (input key 'q') needs serialization.contentType: the media type its value is serialized in",
      );
      expect(error.context).toEqual({ param: 'q', inputKey: 'q', location: 'query' });
      expect(() => buildHttpRequest(wholeQueryTool(42 as any), input)).toThrow(
        "query parameter 'q' (input key 'q') has an invalid media type 42 in serialization.contentType",
      );
    });

    it('is optional unless required', () => {
      expect(buildHttpRequest(wholeQueryTool('application/json'), {}).url).toBe('https://example.com/foo');
      expect(() => buildHttpRequest(wholeQueryTool('application/json', [], true), {})).toThrow(
        "Required query parameter 'q' (input key 'q') is missing",
      );
    });

    it('cannot be combined with another query parameter, whatever the input holds', () => {
      const other: ParameterMapper = { inputKey: 'limit', type: 'query', key: 'limit' };
      for (const mapper of [
        [{ inputKey: 'q', type: 'query', key: 'q', wholeQuery: true, serialization: { contentType: 'text/plain' } }, other],
        [other, { inputKey: 'q', type: 'query', key: 'q', wholeQuery: true, serialization: { contentType: 'text/plain' } }],
      ] as ParameterMapper[][]) {
        for (const input of [{}, { q: 'x', limit: 1 }]) {
          const error = buildFailure(() => buildHttpRequest(fooTool(mapper), input));

          expect(error.message).toBe(
            "Whole-query parameter 'q' (input key 'q') is the entire query string, so it cannot be combined with the query parameter 'limit' (input key 'limit')",
          );
          expect(error.context).toEqual({ param: 'q', inputKey: 'q', location: 'query', conflictsWith: 'limit' });
        }
      }
      // a content query parameter counts too, and only the first one is named
      const content: ParameterMapper = { inputKey: 'c', type: 'query', key: 'c', serialization: { contentType: 'application/json' } };
      expect(() => buildHttpRequest(wholeQueryTool('text/plain', [content, other]), {})).toThrow(
        /cannot be combined with the query parameter 'c'/,
      );
    });

    it('allows only one whole-query parameter', () => {
      const tool = fooTool([
        { inputKey: 'a', type: 'query', key: 'a', wholeQuery: true, serialization: { contentType: 'text/plain' } },
        { inputKey: 'b', type: 'query', key: 'b', wholeQuery: true, serialization: { contentType: 'text/plain' } },
      ]);
      const error = buildFailure(() => buildHttpRequest(tool, {}));

      expect(error.message).toBe("A tool has at most one whole-query parameter; found 'a' and 'b'");
      expect(error.context).toEqual({ param: 'b', inputKey: 'b', location: 'query' });
    });

    it.each([
      ['header', undefined],
      ['body', undefined],
      ['cookie', undefined],
      ['query', { scheme: 'k', type: 'apiKey' }],
    ])('is only valid on a non-security query entry (%s, security %p)', (type, security) => {
      const tool = fooTool([
        { inputKey: 'w', type: type as any, key: 'w', wholeQuery: true, security: security as any, serialization: { contentType: 'text/plain' } },
      ]);
      const error = buildFailure(() => buildHttpRequest(tool, { w: 'x' }));

      expect(error.message).toBe(
        "Mapper entry 'w' (input key 'w') is marked wholeQuery, which only a non-security query parameter can be",
      );
      expect(error.context).toEqual({ param: 'w', inputKey: 'w', location: type });
    });

    it('may sit next to path, header, cookie and body parameters', () => {
      const tool = makeTool(
        [
          { inputKey: 'id', type: 'path', key: 'id', required: true },
          { inputKey: 'q', type: 'query', key: 'q', wholeQuery: true, serialization: { contentType: 'application/json' } },
          { inputKey: 'h', type: 'header', key: 'X-H' },
          { inputKey: 'c', type: 'cookie', key: 'c' },
          { inputKey: 'b', type: 'body', key: 'b' },
        ],
        { method: 'query' },
      );
      const built = buildHttpRequest(tool, { id: '1', q: { a: 1 }, h: 'h', c: 'c', b: 2 });

      expect(built.method).toBe('QUERY');
      expect(built.url).toBe('https://api.example.com/things/1?%7B%22a%22%3A1%7D');
      expect(built.headers).toEqual({ 'X-H': 'h', Cookie: 'c=c', 'content-type': 'application/json' });
      expect(built.body).toBe('{"b":2}');
    });
  });
});

describe('own-property reads and hostile names', () => {
  const NAMES = ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf'];

  it.each(NAMES)('does not read an inherited %s as an input value', (name) => {
    const tool = makeTool(
      [
        { inputKey: name, type: 'header', key: 'X-H' },
        { inputKey: `${name}_q`, type: 'query', key: name },
        { inputKey: name, type: 'cookie', key: 'c' },
        { inputKey: name, type: 'body', key: 'b' },
      ],
      { path: '/t' },
    );
    const built = buildHttpRequest(tool, {});

    expect(built.url).toBe('https://api.example.com/t');
    expect(built.headers).toEqual({});
    expect(built.cookies).toEqual({});
    expect(built.body).toBeUndefined();
    expect(() => buildHttpRequest(makeTool([{ inputKey: name, type: 'path', key: 'id', required: true }]), {})).toThrow(
      /Required path parameter 'id'/,
    );
  });

  it.each(NAMES)('sends a parameter named %s in every location', (name) => {
    const tool = makeTool(
      [
        { inputKey: 'h', type: 'header', key: name },
        { inputKey: 'q', type: 'query', key: name },
        { inputKey: 'c', type: 'cookie', key: name },
        { inputKey: 'b', type: 'body', key: name },
      ],
      { path: '/t' },
    );
    const input = JSON.parse('{"h":"hv","q":"qv","c":"cv","b":"bv"}');
    const built = buildHttpRequest(tool, input);

    expect(built.url).toBe(`https://api.example.com/t?${name}=qv`);
    expect(Object.getOwnPropertyDescriptor(built.query, name)?.value).toEqual(['qv']);
    expect(Object.getOwnPropertyDescriptor(built.headers, name)?.value).toBe('hv');
    expect(Object.getOwnPropertyDescriptor(built.cookies, name)?.value).toBe('cv');
    expect(built.headers['Cookie']).toBe(`${name}=cv`);
    expect(built.body).toBe(`{"${name}":"bv"}`);
    expect(Object.keys(built.rawBody as object)).toEqual([name]);
  });

  it.each(NAMES)('reads an own input key %s, as JSON.parse creates it', (name) => {
    const tool = makeTool([{ inputKey: name, type: 'query', key: 'q', required: true }], { path: '/t' });

    expect(buildHttpRequest(tool, JSON.parse(`{"${name}":"v"}`)).url).toBe('https://api.example.com/t?q=v');
  });

  it('returns ordinary objects and pollutes no prototype', () => {
    const tool = makeTool(
      [
        { inputKey: 'h', type: 'header', key: '__proto__' },
        { inputKey: 'q', type: 'query', key: '__proto__' },
        { inputKey: 'c', type: 'cookie', key: '__proto__' },
        { inputKey: 'b', type: 'body', key: '__proto__' },
        { inputKey: 'o', type: 'query', key: 'o' },
      ],
      { path: '/t' },
    );
    const built = buildHttpRequest(tool, JSON.parse('{"h":"1","q":"2","c":"3","b":{"polluted":true},"o":{"constructor":"4"}}'));

    for (const record of [built.headers, built.query, built.cookies, built.rawBody]) {
      expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
      expect(Object.keys(record as object)).toContain('__proto__');
    }
    expect(built.query).toEqual(JSON.parse('{"__proto__":["2"],"constructor":["4"]}'));
    // an exploded object cannot add to (or stand in for) the `__proto__` query parameter
    expect(() => buildHttpRequest(tool, JSON.parse('{"o":{"__proto__":"4"}}'))).toThrow(
      "names the query parameter '__proto__', which this tool reserves for the query parameter '__proto__' (input key 'q')",
    );
    expect(built.body).toBe('{"__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((built.rawBody as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('serializes own __proto__ keys inside values', () => {
    const value = JSON.parse('{"__proto__":"x","constructor":"y"}');
    const deep = makeTool([{ inputKey: 'f', type: 'query', key: 'f', style: 'deepObject' }], { path: '/t' });
    const whole = fooTool([
      { inputKey: 'q', type: 'query', key: 'q', wholeQuery: true, serialization: { contentType: 'application/x-www-form-urlencoded' } },
    ]);
    const cookie = fooTool([{ inputKey: 'c', type: 'cookie', key: 'c', style: 'cookie' }]);

    expect(buildHttpRequest(deep, { f: value }).url).toBe('https://api.example.com/t?f[__proto__]=x&f[constructor]=y');
    expect(buildHttpRequest(whole, { q: value }).url).toBe('https://example.com/foo?__proto__=x&constructor=y');
    expect(buildHttpRequest(cookie, { c: value }).headers['Cookie']).toBe('__proto__=x; constructor=y');
  });

  it('percent-encodes CR, LF and NUL in the query and the path', () => {
    const tool = makeTool([
      { inputKey: 'id', type: 'path', key: 'id', required: true },
      { inputKey: 'q', type: 'query', key: 'q\r\n' },
    ]);

    expect(buildHttpRequest(tool, { id: 'a\r\n\u0000', q: 'b\r\n\u0000' }).url).toBe(
      'https://api.example.com/things/a%0D%0A%00?q%0D%0A=b%0D%0A%00',
    );
  });

  it('treats null or undefined input as no values and refuses another non-object', () => {
    const optional = makeTool([{ inputKey: 'q', type: 'query', key: 'q' }], { path: '/t' });

    expect(buildHttpRequest(optional, null as any).url).toBe('https://api.example.com/t');
    expect(buildHttpRequest(optional, undefined as any).url).toBe('https://api.example.com/t');
    expect(() => buildHttpRequest(makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }]), null as any)).toThrow(
      /Required path parameter 'id'/,
    );
    for (const input of ['q', 1, true]) {
      const error = buildFailure(() => buildHttpRequest(optional, input as any));
      expect(error.message).toMatch(/^Tool input must be an object; received /);
    }
  });

  it('serializes a large array in a form query parameter', () => {
    const many = Array.from({ length: 200_000 }, (_, i) => i);
    const built = buildHttpRequest(makeTool([{ inputKey: 'q', type: 'query', key: 'q' }], { path: '/t' }), { q: many });

    expect(built.query['q']).toHaveLength(200_000);
  });
});

describe('tool shape (hand-made or tampered tools)', () => {
  it.each([
    ['null', null],
    ['a string', 'tool'],
    ['a tool without metadata', { mapper: [] }],
    ['a tool whose metadata is a string', { mapper: [], metadata: 'get /x' }],
  ])('refuses %s', (_label, tool) => {
    expect(() => buildHttpRequest(tool as any, {})).toThrow('Tool must be an object with a metadata object');
  });

  it('refuses a path that is not a string', () => {
    expect(() => buildHttpRequest(makeTool([], { path: 42 as any }), {})).toThrow('Tool path must be a string; received 42');
  });

  it.each([
    ['not an array', { 0: { inputKey: 'a', type: 'query', key: 'a' } }, 'Tool mapper must be an array; received an object'],
    ['an entry that is null', [null], 'Mapper entry 0 must be an object; received null'],
    ['an entry that is a string', ['query'], 'Mapper entry 0 must be an object; received "query"'],
    [
      'a key that is not a string',
      [{ inputKey: 'a', type: 'query', key: 7 }],
      'Mapper entry 0 must have a string key and inputKey; received key 7 and inputKey "a"',
    ],
    [
      'an inputKey that is not a string',
      [{ inputKey: { toString: () => 'a' }, type: 'query', key: 'a' }],
      'Mapper entry 0 must have a string key and inputKey; received key "a" and inputKey an object',
    ],
  ])('refuses a mapper with %s', (_label, mapper, message) => {
    const tool = { ...makeTool([], { path: '/t' }), mapper: mapper as any };

    expect(() => buildHttpRequest(tool, { a: 'x' })).toThrow(message);
  });

  it('refuses a server URL or a baseUrl that is not a string', () => {
    expect(() => buildHttpRequest(makeTool([], { path: '/t', servers: [{ url: 1 } as any] }), {})).toThrow(
      'Server URL must be a string; received 1',
    );
    expect(() => buildHttpRequest(makeTool([], { path: '/t', servers: [{} as any] }), {})).toThrow(
      'Server URL must be a string; received undefined',
    );
    expect(() => buildHttpRequest(makeTool([], { path: '/t' }), {}, { baseUrl: 5 as any })).toThrow(
      'Base URL must be a string; received 5',
    );
  });

  it('refuses a body media type that is not a string, and reads null as the JSON default', () => {
    const tool = (contentType: unknown) =>
      makeTool([{ inputKey: 'b', type: 'body', key: 'b', serialization: { contentType } as any }], { path: '/t' });

    expect(() => buildHttpRequest(tool(['application/json']), { b: 1 })).toThrow(
      "body parameter 'b' (input key 'b') has an invalid media type an array in serialization.contentType",
    );
    expect(buildHttpRequest(tool(null), { b: 1 }).body).toBe('{"b":1}');
  });
});

describe('names the input chooses cannot take a name the tool reserves', () => {
  const credential = (type: 'query' | 'cookie' | 'header', key: string): ParameterMapper => ({
    inputKey: 'cred',
    type,
    key,
    security: { scheme: 'keyScheme', type: 'apiKey', apiKeyName: key, apiKeyIn: type },
  });
  const formWhole: ParameterMapper = {
    inputKey: 'q',
    type: 'query',
    key: 'q',
    wholeQuery: true,
    serialization: { contentType: 'application/x-www-form-urlencoded' },
  };
  const cookieObject: ParameterMapper = { inputKey: 'c', type: 'cookie', key: 'c', style: 'cookie' };
  // style form, explode true: the defaults
  const explodedQuery: ParameterMapper = { inputKey: 'o', type: 'query', key: 'o' };

  describe('(a) the property names of a form whole query', () => {
    const message =
      "The input of query parameter 'q' (input key 'q') names the query parameter 'api_key', which this tool reserves for the credential of security scheme 'keyScheme'";

    it.each([
      ['comes after it', [formWhole, credential('query', 'api_key')]],
      ['comes before it', [credential('query', 'api_key'), formWhole]],
    ])('refuses a property named like a query credential whose entry %s, supplied or not', (_label, mapper) => {
      for (const input of [
        { q: { api_key: 'attacker' }, cred: 'real' },
        { q: { api_key: 'attacker' } },
        { q: { foo: 'x', api_key: ['a', 'b'] } },
      ]) {
        const error = buildFailure(() => buildHttpRequest(fooTool(mapper), input));

        expect(error.message).toBe(message);
        expect(error.context).toEqual({ param: 'q', inputKey: 'q', location: 'query', name: 'api_key', reservedBy: 'cred' });
      }
    });

    it('compares names exactly: another case or another location is not the credential', () => {
      const exact = buildHttpRequest(fooTool([formWhole, credential('query', 'api_key')]), {
        q: { API_KEY: 'x', api_key2: 'y' },
        cred: 'real',
      });
      expect(exact.url).toBe('https://example.com/foo?API_KEY=x&api_key2=y&api_key=real');

      for (const type of ['header', 'cookie'] as const) {
        const built = buildHttpRequest(fooTool([formWhole, credential(type, 'api_key')]), { q: { api_key: 'x' }, cred: 'real' });
        expect(built.url).toBe('https://example.com/foo?api_key=x');
      }
    });

    it('still appends the real credential after the input pairs', () => {
      const built = buildHttpRequest(fooTool([formWhole, credential('query', 'api_key')]), { q: { foo: 'a' }, cred: 'real' });

      expect(built.url).toBe('https://example.com/foo?foo=a&api_key=real');
      expect(built.query).toEqual({ foo: ['a'], api_key: ['real'] });
    });
  });

  describe('(b) the property names of an exploded style: cookie object', () => {
    it.each([
      ['comes after it', [cookieObject, credential('cookie', 'session')]],
      ['comes before it', [credential('cookie', 'session'), cookieObject]],
    ])('refuses a property named like a cookie credential whose entry %s, supplied or not', (_label, mapper) => {
      for (const input of [{ c: { session: 'attacker' }, cred: 'real' }, { c: { theme: 'dark', session: 'attacker' } }]) {
        const error = buildFailure(() => buildHttpRequest(fooTool(mapper), input));

        expect(error.message).toBe(
          "The input of cookie parameter 'c' (input key 'c') names the cookie 'session', which this tool reserves for the credential of security scheme 'keyScheme'",
        );
        expect(error.context).toEqual({ param: 'c', inputKey: 'c', location: 'cookie', name: 'session', reservedBy: 'cred' });
      }
    });

    it.each([
      ['given', { theme: 'dark', c: { theme: 'evil' } }],
      ['absent', { c: { theme: 'evil' } }],
    ])('refuses a property named like a sibling cookie parameter (sibling value %s)', (_label, input) => {
      for (const mapper of [
        [{ inputKey: 'theme', type: 'cookie', key: 'theme' }, cookieObject],
        [cookieObject, { inputKey: 'theme', type: 'cookie', key: 'theme' }],
      ] as ParameterMapper[][]) {
        const error = buildFailure(() => buildHttpRequest(fooTool(mapper), input));

        expect(error.message).toBe(
          "The input of cookie parameter 'c' (input key 'c') names the cookie 'theme', which this tool reserves for the cookie parameter 'theme' (input key 'theme')",
        );
        expect(error.context).toEqual({ param: 'c', inputKey: 'c', location: 'cookie', name: 'theme', reservedBy: 'theme' });
      }
    });

    it('refuses two inputs naming the same cookie instead of keeping only one', () => {
      const tool = fooTool([cookieObject, { inputKey: 'd', type: 'cookie', key: 'd', style: 'cookie' }]);
      const error = buildFailure(() => buildHttpRequest(tool, { c: { theme: 'a' }, d: { theme: 'b' } }));

      expect(error.message).toBe(
        "The input of cookie parameter 'd' (input key 'd') names the cookie 'theme', which the input of cookie parameter 'c' (input key 'c') names too",
      );
      expect(error.context).toEqual({ param: 'd', inputKey: 'd', location: 'cookie', name: 'theme', reservedBy: 'c' });
      expect(buildHttpRequest(tool, { c: { theme: 'a' }, d: { size: 'b' } }).headers['Cookie']).toBe('theme=a; size=b');
    });

    it('allows the parameter own name, and names used by other locations', () => {
      const tool = fooTool([
        cookieObject,
        { inputKey: 'theme', type: 'query', key: 'theme' },
        { inputKey: 'h', type: 'header', key: 'session' },
        credential('header', 'X-Key'),
      ]);
      const built = buildHttpRequest(tool, { c: { c: 'own', theme: 'evil', session: 's', 'X-Key': 'k' }, theme: 'q' });

      expect(built.headers['Cookie']).toBe('c=own; theme=evil; session=s; X-Key=k');
      expect(built.url).toBe('https://example.com/foo?theme=q');
    });
  });

  describe('(c) the property names of an exploded form object in the query', () => {
    it.each([
      ['comes after it', [explodedQuery, credential('query', 'api_key')]],
      ['comes before it', [credential('query', 'api_key'), explodedQuery]],
    ])('refuses a property named like a query credential whose entry %s, supplied or not', (_label, mapper) => {
      for (const input of [{ o: { api_key: 'attacker' }, cred: 'real' }, { o: { page: 1, api_key: 'attacker' } }]) {
        const error = buildFailure(() => buildHttpRequest(fooTool(mapper), input));

        expect(error.message).toBe(
          "The input of query parameter 'o' (input key 'o') names the query parameter 'api_key', which this tool reserves for the credential of security scheme 'keyScheme'",
        );
        expect(error.context).toEqual({ param: 'o', inputKey: 'o', location: 'query', name: 'api_key', reservedBy: 'cred' });
      }
    });

    it.each([
      ['given', { page: 1, o: { page: 99 } }],
      ['absent', { o: { page: 99 } }],
    ])('refuses a property named like a sibling query parameter (sibling value %s)', (_label, input) => {
      const tool = fooTool([explodedQuery, { inputKey: 'pageNumber', type: 'query', key: 'page' }]);
      const error = buildFailure(() => buildHttpRequest(tool, input));

      expect(error.message).toBe(
        "The input of query parameter 'o' (input key 'o') names the query parameter 'page', which this tool reserves for the query parameter 'page' (input key 'pageNumber')",
      );
    });

    it('names the first other entry when several share the name, the exploded entry itself excluded', () => {
      const sharing = fooTool([
        { ...explodedQuery, key: 'page' },
        { inputKey: 'pageNumber', type: 'query', key: 'page' },
        credential('query', 'page'),
      ]);

      expect(() => buildHttpRequest(sharing, { o: { page: 2 } })).toThrow(
        "names the query parameter 'page', which this tool reserves for the query parameter 'page' (input key 'pageNumber')",
      );
    });

    it('applies to every exploded object, whatever the style', () => {
      const tool = fooTool([{ ...explodedQuery, style: 'spaceDelimited', explode: true }, credential('query', 'api_key')]);

      expect(() => buildHttpRequest(tool, { o: { api_key: 'x' } })).toThrow(/names the query parameter 'api_key'/);
    });

    it('lets through names no other entry uses: explode false, a deepObject name, arrays, the own name', () => {
      const call = (mapper: Partial<ParameterMapper>, o: unknown) =>
        buildHttpRequest(fooTool([{ ...explodedQuery, ...mapper }, credential('query', 'api_key')]), { o }).url;

      expect(call({ explode: false }, { api_key: 'x' })).toBe('https://example.com/foo?o=api_key%2Cx');
      expect(call({ style: 'deepObject' }, { api_key: 'x' })).toBe('https://example.com/foo?o[api_key]=x');
      expect(call({}, ['api_key'])).toBe('https://example.com/foo?o=api_key');
      expect(call({}, { o: 1, other: 2 })).toBe('https://example.com/foo?o=1&other=2');
    });
  });
});

describe('names a deepObject query parameter generates cannot take a name the tool reserves', () => {
  const filter: ParameterMapper = { inputKey: 'filter', type: 'query', key: 'filter', style: 'deepObject', explode: true };
  const credential = (key: string): ParameterMapper => ({ inputKey: 'cred', type: 'query', key, security: { scheme: 'keyScheme', type: 'apiKey' } });

  it('refuses filter[a] when a sibling query parameter is literally named filter[a] (it used to send both pairs)', () => {
    const tool = fooTool([filter, { inputKey: 'fa', type: 'query', key: 'filter[a]' }]);

    for (const input of [{ filter: { a: 'x' }, fa: 'real' }, { filter: { a: 'x' } }]) {
      const error = buildFailure(() => buildHttpRequest(tool, input));
      expect(error.message).toBe(
        "The input of query parameter 'filter' (input key 'filter') names the query parameter 'filter[a]', which this tool reserves for the query parameter 'filter[a]' (input key 'fa')",
      );
      expect(error.context).toEqual({ param: 'filter', inputKey: 'filter', location: 'query', name: 'filter[a]', reservedBy: 'fa' });
    }
  });

  it.each([
    ['supplied', { filter: { a: 'attacker' }, cred: 'real' }],
    ['not supplied', { filter: { a: 'attacker' } }],
  ])('refuses filter[a] when a query credential is named filter[a], the credential %s', (_label, input) => {
    const error = buildFailure(() => buildHttpRequest(fooTool([filter, credential('filter[a]')]), input));

    expect(error.message).toBe(
      "The input of query parameter 'filter' (input key 'filter') names the query parameter 'filter[a]', which this tool reserves for the credential of security scheme 'keyScheme'",
    );
    expect(error.context).toEqual({ param: 'filter', inputKey: 'filter', location: 'query', name: 'filter[a]', reservedBy: 'cred' });
  });

  it('checks a nested name and the name of an array property too', () => {
    expect(() => buildHttpRequest(fooTool([filter, credential('filter[a][b]')]), { filter: { a: { b: 'x' } } })).toThrow(
      "names the query parameter 'filter[a][b]', which this tool reserves for the credential of security scheme 'keyScheme'",
    );
    expect(() => buildHttpRequest(fooTool([filter, credential('filter[tags]')]), { filter: { tags: ['x', 'y'] } })).toThrow(
      "names the query parameter 'filter[tags]'",
    );
  });

  it('leaves a request unchanged when no other entry uses the name: a different name, an empty array, another case', () => {
    const tool = fooTool([filter, credential('filter[a]'), { inputKey: 'fb', type: 'query', key: 'filter[B]' }]);

    const built = buildHttpRequest(tool, { filter: { b: 'x', a2: { a: 1 }, tags: [] }, cred: 'k', fb: 'y' });
    expect(built.url).toBe('https://example.com/foo?filter[b]=x&filter[a2][a]=1&filter[a]=k&filter[B]=y');
    // names compare unencoded, which is the decoded wire form: an entry named `filter%5Ba%5D` is another name
    const encoded = fooTool([filter, credential('filter%5Ba%5D')]);
    expect(buildHttpRequest(encoded, { filter: { a: 'x' }, cred: 'k' }).url).toBe('https://example.com/foo?filter[a]=x&filter%255Ba%255D=k');
  });
});

describe('null properties of a form are left out, like undefined ones', () => {
  it('in a form whole query', () => {
    const tool = fooTool([
      { inputKey: 'q', type: 'query', key: 'q', wholeQuery: true, serialization: { contentType: 'application/x-www-form-urlencoded' } },
    ]);
    const built = buildHttpRequest(tool, { q: { q: 'cats', page: null } });

    expect(built.url).toBe('https://example.com/foo?q=cats');
    expect(built.query).toEqual({ q: ['cats'] });
  });

  it('in a form content parameter', () => {
    const tool = fooTool([{ inputKey: 'p', type: 'query', key: 'p', serialization: { contentType: 'application/x-www-form-urlencoded' } }]);

    expect(buildHttpRequest(tool, { p: { q: 'cats', page: null } }).url).toBe('https://example.com/foo?p=q%3Dcats');
  });

  it('in a form body: `a=1&z=null` before, `a=1` now; a JSON body keeps null', () => {
    const flattened = makeTool(
      [
        { inputKey: 'a', type: 'body', key: 'a', serialization: { contentType: 'application/x-www-form-urlencoded' } },
        { inputKey: 'z', type: 'body', key: 'z', serialization: { contentType: 'application/x-www-form-urlencoded' } },
      ],
      { path: '/t' },
    );
    expect(buildHttpRequest(flattened, { a: 1, z: null }).body).toBe('a=1');

    const whole = makeTool(
      [{ inputKey: 'b', type: 'body', key: 'b', wholeBody: true, serialization: { contentType: 'application/x-www-form-urlencoded' } }],
      { path: '/t' },
    );
    expect(buildHttpRequest(whole, { b: { a: 1, z: null } }).body).toBe('a=1');

    const json = makeTool([{ inputKey: 'z', type: 'body', key: 'z' }], { path: '/t' });
    expect(buildHttpRequest(json, { z: null }).body).toBe('{"z":null}');
  });

  it('still refuses null as an array item', () => {
    const whole = makeTool(
      [{ inputKey: 'b', type: 'body', key: 'b', wholeBody: true, serialization: { contentType: 'application/x-www-form-urlencoded' } }],
      { path: '/t' },
    );

    expect(() => buildHttpRequest(whole, { b: { tags: [null] } })).toThrow("body parameter 'tags' must serialize to a primitive; received null");
  });
});

describe('header values hold only what HTTP allows (RFC 9110 field-value)', () => {
  const headerTool = (mapper: Partial<ParameterMapper> = {}) =>
    makeTool([{ inputKey: 'h', type: 'header', key: 'X-H', ...mapper } as ParameterMapper], { path: '/t' });

  it.each([
    ['VT', '\u000b', '000B'],
    ['DEL', '\u007f', '007F'],
    ['another C0 control', '\u0001', '0001'],
    ['č', 'č', '010D'],
    ['a CJK character', '中', '4E2D'],
    ['U+2028', ' ', '2028'],
    ['an emoji', '😀', 'D83D'],
    ['a lone surrogate', '\udc00', 'DC00'],
  ])('refuses %s', (_label, character, code) => {
    const error = buildFailure(() => buildHttpRequest(headerTool(), { h: `ab${character}` }));

    expect(error.message).toBe(
      `Header 'X-H' value contains U+${code} at index 2, which a header value cannot hold (only tab, space, visible ASCII and U+0080 to U+00FF)`,
    );
    expect(error.context).toEqual({ header: 'X-H' });
  });

  it('accepts tab, space, visible ASCII and U+0080 to U+00FF', () => {
    const value = 'a\tb c~!"\u0080éÿ';

    expect(buildHttpRequest(headerTool(), { h: value }).headers['X-H']).toBe(value);
  });

  it('keeps the injection message for CR, LF and NUL', () => {
    expect(() => buildHttpRequest(headerTool(), { h: 'a\r\n中' })).toThrow(/possible header injection/);
  });

  it('applies to credentials and to header parameters sent as text', () => {
    const secured = headerTool({ security: { scheme: 'k', type: 'apiKey', apiKeyIn: 'header' } });
    expect(() => buildHttpRequest(secured, { h: 'tök中' })).toThrow(/U\+4E2D at index 3/);

    expect(() => buildHttpRequest(headerTool({ serialization: { contentType: 'text/plain' } }), { h: '中' })).toThrow(
      /U\+4E2D at index 0/,
    );
  });

  it('writes a JSON content header in ASCII, which parses back to the same value', () => {
    const value = { name: 'Zoë 中 😀', del: '\u007f', ключ: 1 };
    const built = buildHttpRequest(headerTool({ serialization: { contentType: 'application/json' } }), { h: value });

    expect(built.headers['X-H']).toBe(
      '{"name":"Zo\\u00eb \\u4e2d \\ud83d\\ude00","del":"\\u007f","\\u043a\\u043b\\u044e\\u0447":1}',
    );
    expect(JSON.parse(built.headers['X-H'])).toEqual(value);
  });

  it('keeps UTF-8 JSON elsewhere: in the query it is percent-encoded', () => {
    const tool = fooTool([{ inputKey: 'p', type: 'query', key: 'p', serialization: { contentType: 'application/json' } }]);

    expect(buildHttpRequest(tool, { p: 'é' }).url).toBe('https://example.com/foo?p=%22%C3%A9%22');
  });

  describe('cookie values', () => {
    const cookie = (mapper: Partial<ParameterMapper>) =>
      fooTool([{ inputKey: 'c', type: 'cookie', key: 'c', ...mapper } as ParameterMapper]);

    it('without style: cookie: U+0080 to U+00FF still pass, a character above U+00FF is refused', () => {
      expect(buildHttpRequest(cookie({}), { c: 'é' }).headers['Cookie']).toBe('c=é');
      expect(() => buildHttpRequest(cookie({}), { c: '中' })).toThrow(/cookie-octet violation/);
    });

    it('with style: cookie or content: RFC 6265 cookie-octets only', () => {
      for (const mapper of [{ style: 'cookie' }, { serialization: { contentType: 'text/plain' } }]) {
        expect(() => buildHttpRequest(cookie(mapper), { c: 'é' })).toThrow(/cookie-octet violation/);
        expect(buildHttpRequest(cookie(mapper), { c: "!#$%&'()*+-./:<=>?@[]^_`{|}~" }).headers['Cookie']).toBe(
          "c=!#$%&'()*+-./:<=>?@[]^_`{|}~",
        );
      }
    });
  });
});

describe('lone surrogates are refused by every encoder', () => {
  const message = (location: string, param: string) =>
    `${location} parameter '${param}' contains a lone surrogate (an unpaired UTF-16 code unit), which has no UTF-8 encoding`;

  it.each(['a\ud800b', 'a\udc00', '\udc00\ud800', '\ud800'])('in a query value or name (%j), which used to throw a URIError', (lone) => {
    const tool = fooTool([{ inputKey: 'p', type: 'query', key: 'p' }]);

    const value = buildFailure(() => buildHttpRequest(tool, { p: lone }));
    expect(value.message).toBe(message('query', 'p'));
    expect(value.context).toEqual({ param: 'p', location: 'query' });

    expect(buildFailure(() => buildHttpRequest(tool, { p: { [lone]: 1 } })).message).toBe(message('query', lone));
  });

  it('in a path value or object key', () => {
    const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true }]);

    expect(() => buildHttpRequest(tool, { id: '\ud800' })).toThrow(message('path', 'id'));
    expect(() => buildHttpRequest(tool, { id: { ['\ud800']: 1 } })).toThrow(message('path', 'id'));
  });

  it('in a whole query, form or not, and in a query credential', () => {
    const whole = (contentType: string, extra: ParameterMapper[] = []) =>
      fooTool([{ inputKey: 'q', type: 'query', key: 'q', wholeQuery: true, serialization: { contentType } }, ...extra]);

    expect(() => buildHttpRequest(whole('text/plain'), { q: 'a\ud800' })).toThrow(message('query', 'q'));
    expect(() => buildHttpRequest(whole('application/x-www-form-urlencoded'), { q: { k: 'a\ud800' } })).toThrow(
      message('query', 'k'),
    );
    expect(() => buildHttpRequest(whole('application/x-www-form-urlencoded'), { q: { ['k\ud800']: 'v' } })).toThrow(
      message('query', 'k\ud800'),
    );
    const credential: ParameterMapper = { inputKey: 'cred', type: 'query', key: 'api_key', security: { scheme: 'k', type: 'apiKey' } };
    expect(() => buildHttpRequest(whole('application/x-www-form-urlencoded', [credential]), { q: {}, cred: '\ud800' })).toThrow(
      message('query', 'api_key'),
    );
  });

  it('in a form body, which used to send U+FFFD in its place, and in a form content parameter', () => {
    const body = makeTool(
      [{ inputKey: 'b', type: 'body', key: 'b', wholeBody: true, serialization: { contentType: 'application/x-www-form-urlencoded' } }],
      { path: '/t' },
    );
    expect(() => buildHttpRequest(body, { b: { k: 'a\ud800' } })).toThrow(message('body', 'k'));

    const content = fooTool([{ inputKey: 'p', type: 'header', key: 'X-P', serialization: { contentType: 'application/x-www-form-urlencoded' } }]);
    expect(() => buildHttpRequest(content, { p: { k: '\udc00' } })).toThrow(message('header', 'k'));
  });

  it('accepts a surrogate pair, and JSON keeps a lone surrogate as an escape', () => {
    const tool = fooTool([{ inputKey: 'p', type: 'query', key: 'p' }]);
    expect(buildHttpRequest(tool, { p: '😀' }).url).toBe('https://example.com/foo?p=%F0%9F%98%80');

    const json = fooTool([{ inputKey: 'q', type: 'query', key: 'q', wholeQuery: true, serialization: { contentType: 'application/json' } }]);
    const built = buildHttpRequest(json, { q: '\ud800' });
    expect(built.queryString).toBe('%22%5Cud800%22');
    expect(JSON.parse(decodeURIComponent(built.queryString!))).toBe('\ud800');
  });
});

/**
 * One classification of a media type (`classifyMediaType`) serves the input
 * schema of a `content` parameter without a schema (parameter-resolver spec,
 * 'one media-type classification ...') and what buildHttpRequest accepts for it
 * here: JSON text, a form string, or the value itself.
 */
describe('one media-type classification for content parameters and whole queries', () => {
  const JSON_VALUE = { a: 1, b: 'x y' };
  const FORM_VALUE = { a: '1', b: 'x y' };

  /** The media types of each class, as the tests of both sides name them */
  const JSON_TYPES = ['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/problem+json'];
  const FORM_TYPES = ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded; charset=utf-8'];
  const OTHER_TYPES = ['text/json', 'text/plain', 'application/xml'];

  type Where = 'query' | 'header' | 'path' | 'whole query';
  const WHERE: Where[] = ['query', 'header', 'path', 'whole query'];

  const toolFor = (where: Where, contentType: unknown) =>
    where === 'whole query'
      ? fooTool([{ inputKey: 'p', type: 'query', key: 'p', wholeQuery: true, serialization: { contentType } as any }])
      : makeTool([{ inputKey: 'p', type: where, key: 'p', required: true, serialization: { contentType } as any }], {
          path: where === 'path' ? '/t/{p}' : '/t',
          method: 'get',
          servers: [{ url: 'https://example.com' }],
        });

  /** The text the value is sent as, decoded from its location */
  const sentText = (where: Where, contentType: unknown, value: unknown): string => {
    const built = buildHttpRequest(toolFor(where, contentType), { p: value });
    const url = new URL(built.url);
    switch (where) {
      case 'query':
        return built.query['p'][0];
      case 'header':
        return built.headers['p'];
      case 'path':
        return decodeURIComponent(url.pathname.split('/').pop()!);
      default:
        return decodeURIComponent(url.search.slice(1));
    }
  };

  const refusal = (where: Where, contentType: unknown, value: unknown): string =>
    buildFailure(() => buildHttpRequest(toolFor(where, contentType), { p: value })).message;

  describe.each(WHERE)('in %s', (where) => {
    it.each(JSON_TYPES)('writes any value as JSON text for %j', (contentType) => {
      expect(sentText(where, contentType, JSON_VALUE)).toBe('{"a":1,"b":"x y"}');
      expect(sentText(where, contentType, 'x')).toBe('"x"');
      expect(sentText(where, contentType, [1, null])).toBe('[1,null]');
      expect(sentText(where, contentType, 7)).toBe('7');
    });

    it.each(FORM_TYPES)('form-encodes an object for %j and refuses a string', (contentType) => {
      expect(sentText(where, contentType, FORM_VALUE)).toBe('a=1&b=x+y');
      expect(refusal(where, contentType, 'a=1')).toContain(
        'is sent as application/x-www-form-urlencoded, which needs an object; received "a=1"',
      );
    });

    it.each(OTHER_TYPES)('sends the value itself for %j and refuses an object', (contentType) => {
      expect(sentText(where, contentType, 'x y')).toBe('x y');
      expect(sentText(where, contentType, 7)).toBe('7');
      expect(refusal(where, contentType, JSON_VALUE)).toContain(
        `is sent as ${contentType}, which needs a string or another primitive; received an object`,
      );
    });

    it.each([
      ['an empty string', ''],
      ['a media type that is only parameters', '; charset=utf-8'],
      ['a number', 42],
      ['null', null],
      ['an array', ['application/json']],
      ['an object', { 'application/json': {} }],
    ])('refuses %s as the media type', (_label, contentType) => {
      expect(refusal(where, contentType, 'x')).toContain('has an invalid media type');
    });
  });

  describe('generated by the generator from an OpenAPI 3.2 document, a content parameter without a schema', () => {
    const documentFor = (mediaType: string) => ({
      openapi: '3.2.0',
      info: { title: 'Media types', version: '1.0.0' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/items': {
          get: {
            operationId: 'listItems',
            parameters: [{ name: 'p', in: 'query', content: { [mediaType]: {} } }],
            responses: { '200': { description: 'OK' } },
          },
        },
        '/search': {
          get: {
            operationId: 'search',
            parameters: [{ name: 'q', in: 'querystring', content: { [mediaType]: {} } }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    });

    /** The input property of a generated tool, and the tool */
    const generate = async (mediaType: string, path: '/items' | '/search', key: 'p' | 'q') => {
      const generator = await OpenAPIToolGenerator.fromJSON(documentFor(mediaType) as any);
      const tool = await generator.generateTool(path, 'get');
      return { tool, property: (tool!.inputSchema.properties as any)[key] };
    };

    it('JSON: the input is unconstrained and the builder writes any value as JSON text', async () => {
      for (const mediaType of JSON_TYPES) {
        const items = await generate(mediaType, '/items', 'p');
        const search = await generate(mediaType, '/search', 'q');

        expect(items.property.type).toBeUndefined();
        expect(search.property.type).toBeUndefined();
        for (const value of [{ a: 1 }, ['x'], 'x', 3, true]) {
          const text = JSON.stringify(value);
          expect(buildHttpRequest(items.tool!, { p: value }).query['p']).toEqual([text]);
          expect(buildHttpRequest(search.tool!, { q: value }).queryString).toBe(encodeURIComponent(text));
        }
      }
    });

    it('form: the input is an object and the builder form-encodes it', async () => {
      for (const mediaType of FORM_TYPES) {
        const items = await generate(mediaType, '/items', 'p');
        const search = await generate(mediaType, '/search', 'q');

        expect(items.property.type).toBe('object');
        expect(search.property.type).toBe('object');
        expect(buildHttpRequest(items.tool!, { p: { a: '1', b: 'x y' } }).query['p']).toEqual(['a=1&b=x+y']);
        const built = buildHttpRequest(search.tool!, { q: { a: '1', b: 'x y' } });
        expect(built.url).toBe('https://api.example.com/search?a=1&b=x+y');
        expect(built.query).toEqual({ a: ['1'], b: ['x y'] });
      }
    });

    it('other: the input is a string and the builder sends it as written', async () => {
      for (const mediaType of OTHER_TYPES) {
        const items = await generate(mediaType, '/items', 'p');
        const search = await generate(mediaType, '/search', 'q');

        expect(items.property.type).toBe('string');
        expect(search.property.type).toBe('string');
        expect(buildHttpRequest(items.tool!, { p: 'x y' }).url).toBe('https://api.example.com/items?p=x%20y');
        expect(buildHttpRequest(search.tool!, { q: 'x y' }).url).toBe('https://api.example.com/search?x%20y');
      }
    });
  });
});

/**
 * Form fields follow their Encoding Object: OpenAPI 3.0.4 and 3.2.1 "Encoding
 * Object", "Encoding the x-www-form-urlencoded Media Type", "Encoding
 * multipart Media Types", "Encoding By Name" (3.2.1) and Appendix C.
 */
describe('form fields follow their Encoding Object', () => {
  const URLENCODED = 'application/x-www-form-urlencoded';
  const MULTIPART = 'multipart/form-data';

  /** A body field as the generator flattens it: it carries its own Encoding Object only */
  const field = (
    key: string,
    contentType: string,
    encoding?: unknown,
    extra: Partial<ParameterMapper> = {},
  ): ParameterMapper => ({
    inputKey: key,
    type: 'body',
    key,
    serialization: { contentType, ...(encoding !== undefined && { encoding: { [key]: encoding } as any }) },
    ...extra,
  });
  const formTool = (mapper: ParameterMapper[]) => makeTool(mapper, { path: '/t' });
  const build = (mapper: ParameterMapper[], input: Record<string, unknown>) => buildHttpRequest(formTool(mapper), input);
  const formBody = (mapper: ParameterMapper[], input: Record<string, unknown>) => build(mapper, input).body as string;
  const pairsOf = (text: string) => [...new URLSearchParams(text)];
  /** A FormData body as [name, text] entries; a file as `<type>` */
  const entriesOf = (body: unknown) => {
    expect(body).toBeInstanceOf(FormData);
    return [...(body as FormData).entries()].map(([name, value]) => [
      name,
      typeof value === 'string' ? value : `<${(value as File).type}>`,
    ]);
  };
  /** The text of a multipart body the builder wrote itself, its boundary written BOUNDARY */
  const writtenText = async (built: BuiltHttpRequest): Promise<string> => {
    expect(built.body).toBeInstanceOf(Blob);
    expect(built.body).not.toBeInstanceOf(FormData);
    const boundary = /^multipart\/form-data; boundary=(mcp-from-openapi-[0-9a-f]{32})$/.exec(built.headers['content-type'])![1];
    expect((built.body as Blob).type).toBe(`multipart/form-data; boundary=${boundary}`);
    return (await (built.body as Blob).text()).split(boundary).join('BOUNDARY');
  };
  /** A multipart body read back the way a server reads it */
  const parsed = async (built: BuiltHttpRequest) =>
    [...(await new Response(built.body as Blob, { headers: { 'content-type': built.headers['content-type'] } }).formData()).entries()].map(
      ([name, value]) => [name, typeof value === 'string' ? value : `<${(value as File).type}>`],
    );

  // OpenAPI 3.2.1 "Style Examples" for `color` = "blue" / ["blue", "black", "brown"] / { "R": 100, "G": 200, "B": 150 }
  // (the 3.0.4 table agrees on every cell used here). Each row: the cell as the specification writes it, then the
  // bytes the builder sends in a form body (WHATWG form encoding: `+` for a space, `,` written `%2C`), which decode
  // to the same pairs. A form field with an Encoding Object is serialized like a query parameter with that
  // style/explode (one serializer), so the query parameter gets the same pairs.
  const VALUES = { string: 'blue', array: ['blue', 'black', 'brown'], object: { R: 100, G: 200, B: 150 } };
  type Kind = keyof typeof VALUES;
  const STYLE_EXAMPLES: Array<[style: string, explode: boolean | undefined, kind: Kind, spec: string, sent: string]> = [
    ['form', false, 'string', 'color=blue', 'color=blue'],
    ['form', false, 'array', 'color=blue,black,brown', 'color=blue%2Cblack%2Cbrown'],
    ['form', false, 'object', 'color=R,100,G,200,B,150', 'color=R%2C100%2CG%2C200%2CB%2C150'],
    ['form', true, 'string', 'color=blue', 'color=blue'],
    ['form', true, 'array', 'color=blue&color=black&color=brown', 'color=blue&color=black&color=brown'],
    ['form', true, 'object', 'R=100&G=200&B=150', 'R=100&G=200&B=150'],
    ['form', undefined, 'array', 'color=blue&color=black&color=brown', 'color=blue&color=black&color=brown'],
    ['spaceDelimited', false, 'array', 'color=blue%20black%20brown', 'color=blue+black+brown'],
    ['spaceDelimited', undefined, 'array', 'color=blue%20black%20brown', 'color=blue+black+brown'],
    ['pipeDelimited', false, 'array', 'color=blue%7Cblack%7Cbrown', 'color=blue%7Cblack%7Cbrown'],
    ['deepObject', true, 'object', 'color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150', 'color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150'],
    // 3.2.1: "when style is deepObject, this field has no effect"
    ['deepObject', undefined, 'object', 'color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150', 'color%5BR%5D=100&color%5BG%5D=200&color%5BB%5D=150'],
  ];

  describe('application/x-www-form-urlencoded: the Style Examples table', () => {
    it.each(STYLE_EXAMPLES)('style %s, explode %s, %s value', (style, explode, kind, spec, sent) => {
      const encoding = { style, ...(explode !== undefined && { explode }) };
      const body = formBody([field('color', URLENCODED, encoding)], { color: VALUES[kind] });

      expect(body).toBe(sent);
      expect(pairsOf(body)).toEqual(pairsOf(spec));

      // the same pairs as a query parameter with that style/explode
      const query = fooTool([{ inputKey: 'color', type: 'query', key: 'color', style, ...(explode !== undefined && { explode }) }]);
      const built = buildHttpRequest(query, { color: VALUES[kind] });
      expect(pairsOf(built.url.split('?')[1])).toEqual(pairsOf(spec));
    });

    // KNOWN GAP, shared with query parameters (one serializer, whose output for them predates this change and is
    // kept byte for byte): a spaceDelimited or pipeDelimited OBJECT is written comma-separated, not with the
    // style's delimiter as the table gives it. Each row is expected to fail until the serializer is changed.
    it.failing.each([
      ['spaceDelimited', 'color=R%20100%20G%20200%20B%20150'],
      ['pipeDelimited', 'color=R%7C100%7CG%7C200%7CB%7C150'],
    ])('style %s, explode false, object value (known gap)', (style, spec) => {
      const body = formBody([field('color', URLENCODED, { style, explode: false })], { color: VALUES.object });

      expect(pairsOf(body)).toEqual(pairsOf(spec));
    });

    it('writes what a spaceDelimited or pipeDelimited object gets in the query today: comma-separated', () => {
      expect(formBody([field('color', URLENCODED, { style: 'spaceDelimited' })], { color: VALUES.object })).toBe(
        'color=R%2C100%2CG%2C200%2CB%2C150',
      );
    });

    it('serializes every field with its own Encoding Object, and a field without one as it always was', () => {
      const body = formBody(
        [
          field('ids', URLENCODED, { style: 'pipeDelimited', explode: false }),
          field('tags', URLENCODED),
          field('meta', URLENCODED, { style: 'deepObject', explode: true }),
          field('raw', URLENCODED),
          field('note', URLENCODED, {}),
        ],
        { ids: [1, 2], tags: ['a', 'b'], meta: { a: 'x y', b: true }, raw: { a: 1 }, note: 'n' },
      );

      expect(body).toBe('ids=1%7C2&tags=a&tags=b&meta%5Ba%5D=x+y&meta%5Bb%5D=true&raw=%7B%22a%22%3A1%7D&note=n');
    });

    it('leaves out a null or undefined field, with an Encoding Object as without one', () => {
      const mapper = [field('a', URLENCODED, { style: 'deepObject' }), field('b', URLENCODED, { contentType: 'application/json' }), field('c', URLENCODED)];

      expect(formBody(mapper, { a: null, b: null, c: 'x' })).toBe('c=x');
    });

    it('sends an empty array as nothing, exploded or not', () => {
      expect(formBody([field('t', URLENCODED, { explode: false }), field('u', URLENCODED, { explode: true })], { t: [], u: [], v: 1 })).toBe('');
    });

    it('serializes a large array without recursion or argument spreading', () => {
      const many = Array.from({ length: 200_000 }, (_, i) => i);

      const joined = formBody([field('n', URLENCODED, { style: 'form', explode: false })], { n: many });
      expect(joined.startsWith('n=0%2C1%2C2')).toBe(true);
      expect(joined.endsWith('%2C199999')).toBe(true);

      const exploded = formBody([field('n', URLENCODED, { explode: true, allowReserved: true })], { n: many });
      expect(exploded.split('&')).toHaveLength(200_000);
    });
  });

  describe('application/x-www-form-urlencoded: what the table leaves undefined', () => {
    it('nests deepObject brackets for an object property and repeats the name for an array property, as in the query', () => {
      const value = { customer: { address: { city: 'Paris', zip: '75001' } }, tags: ['a', 'b'], skip: undefined, n: 1 };
      const body = formBody([field('filter', URLENCODED, { style: 'deepObject', explode: true })], { filter: value });

      expect(pairsOf(body)).toEqual([
        ['filter[customer][address][city]', 'Paris'],
        ['filter[customer][address][zip]', '75001'],
        ['filter[tags]', 'a'],
        ['filter[tags]', 'b'],
        ['filter[n]', '1'],
      ]);
      const query = buildHttpRequest(fooTool([{ inputKey: 'filter', type: 'query', key: 'filter', style: 'deepObject' }]), { filter: value });
      expect(pairsOf(query.url.split('?')[1])).toEqual(pairsOf(body));
    });

    it('writes a deepObject array as form (exploded unless explode is false) and a primitive as one pair', () => {
      expect(formBody([field('expand', URLENCODED, { style: 'deepObject', explode: true })], { expand: ['a', 'b'] })).toBe('expand=a&expand=b');
      expect(formBody([field('expand', URLENCODED, { style: 'deepObject', explode: false })], { expand: ['a', 'b'] })).toBe('expand=a%2Cb');
      expect(formBody([field('metadata', URLENCODED, { style: 'deepObject', explode: true })], { metadata: '' })).toBe('metadata=');
    });

    it('refuses an array of objects with deepObject (servers disagree on its form), at the top or nested', () => {
      const mapper = [field('line_items', URLENCODED, { style: 'deepObject', explode: true }, { inputKey: 'lineItems' })];
      const message =
        "body parameter 'line_items' has style deepObject, which has no form for an array of objects: OpenAPI defines deepObject for an object with primitive properties, and servers write the items of an array differently (line_items[0][key]=value, line_items[][key]=value)";

      const top = buildFailure(() => build(mapper, { lineItems: [{ price: 'p', quantity: 1 }] }));
      expect(top.message).toBe(message);
      expect(top.context).toEqual({ param: 'line_items', inputKey: 'lineItems', location: 'body', style: 'deepObject' });

      expect(() => build(mapper, { lineItems: { list: [{ price: 'p' }] } })).toThrow(message);
    });

    it('gives the same refusal to a deepObject query parameter, which used to say only "must serialize to a primitive"', () => {
      const tool = fooTool([{ inputKey: 'f', type: 'query', key: 'f', style: 'deepObject' }]);

      const error = buildFailure(() => buildHttpRequest(tool, { f: [{ a: 1 }] }));
      expect(error.message).toMatch(/^query parameter 'f' has style deepObject, which has no form for an array of objects/);
      expect(error.context).toEqual({ param: 'f', location: 'query', style: 'deepObject' });
    });

    it('refuses a null or nested-array property inside a deepObject, as the query does', () => {
      const mapper = [field('m', URLENCODED, { style: 'deepObject' })];

      expect(() => build(mapper, { m: { a: null } })).toThrow("body parameter 'm' must serialize to a primitive; received null");
      expect(() => build(mapper, { m: { a: [[1]] } })).toThrow("body parameter 'm' must serialize to a primitive; received an array");
    });

    it('keeps a nested object JSON text without an Encoding Object, and refuses it with a style other than deepObject, as the query does', () => {
      expect(formBody([field('m', URLENCODED)], { m: { a: { b: 1 } } })).toBe('m=%7B%22a%22%3A%7B%22b%22%3A1%7D%7D');
      expect(formBody([field('m', URLENCODED, { contentType: 'application/json' })], { m: { a: { b: 1 } } })).toBe(
        'm=%7B%22a%22%3A%7B%22b%22%3A1%7D%7D',
      );
      expect(() => build([field('m', URLENCODED, { style: 'form', explode: false })], { m: { a: { b: 1 } } })).toThrow(
        "body parameter 'm' must serialize to a primitive; received object",
      );
    });
  });

  describe('application/x-www-form-urlencoded: allowReserved', () => {
    it('keeps the reserved characters a form allows, percent-encoded triples too, and encodes & = + # [ ] always', () => {
      const value = "a/b:c?d@e!$'()*,;&=+#[] x%41%zz%";
      const body = formBody([field('next', URLENCODED, { allowReserved: true }), field('plain', URLENCODED)], { next: value, plain: value });

      expect(body).toBe(
        "next=a/b:c?d@e!$'()*,;%26%3D%2B%23%5B%5D+x%41%25zz%25" +
          '&plain=a%2Fb%3Ac%3Fd%40e%21%24%27%28%29*%2C%3B%26%3D%2B%23%5B%5D+x%2541%25zz%25',
      );
      // the value cannot add a field: two pairs, whatever it holds
      expect(pairsOf(body).map(([name]) => name)).toEqual(['next', 'plain']);
      expect(pairsOf(body)[0][1]).toBe("a/b:c?d@e!$'()*,;&=+#[] xA%zz%");
    });

    it('applies to every pair of the field, never to a name', () => {
      const body = formBody([field('m', URLENCODED, { style: 'deepObject', allowReserved: true })], { m: { 'a/b': 'c/d' } });

      expect(body).toBe('m%5Ba%2Fb%5D=c/d');
    });

    it('allowReserved false (explicit) is the plain form encoding with style form defaults', () => {
      expect(formBody([field('p', URLENCODED, { allowReserved: false })], { p: ['a/b', 'c'] })).toBe('p=a%2Fb&p=c');
    });

    it('refuses a lone surrogate in a value it keeps', () => {
      expect(() => build([field('p', URLENCODED, { allowReserved: true })], { p: 'a\ud800' })).toThrow(
        "body parameter 'p' contains a lone surrogate (an unpaired UTF-16 code unit), which has no UTF-8 encoding",
      );
    });
  });

  describe('application/x-www-form-urlencoded: contentType (no style, explode or allowReserved)', () => {
    it('writes JSON text for a JSON media type, a string quoted (the specification example)', () => {
      // id = f81d4fae-7dec-11d0-a765-00a0c91e6bf6 serialized as application/json: id=%22f81d4fae-7dec-11d0-a765-00a0c91e6bf6%22
      const body = formBody(
        [field('id', URLENCODED, { contentType: 'application/json' }), field('address', URLENCODED, { contentType: 'application/json' })],
        { id: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', address: { zip: '99999+1234' } },
      );

      expect(body).toBe('id=%22f81d4fae-7dec-11d0-a765-00a0c91e6bf6%22&address=%7B%22zip%22%3A%2299999%2B1234%22%7D');
    });

    it('applies it to each item of an array ("Encoding By Name"), an object item included', () => {
      expect(formBody([field('a', URLENCODED, { contentType: 'application/json' })], { a: ['x', { y: 1 }, null] })).toBe(
        'a=%22x%22&a=%7B%22y%22%3A1%7D&a=null',
      );
    });

    it('reads the first media type of a list, and a non-JSON one needs a primitive', () => {
      expect(formBody([field('a', URLENCODED, { contentType: 'application/json, text/plain' })], { a: 'x' })).toBe('a=%22x%22');
      expect(formBody([field('a', URLENCODED, { contentType: 'text/plain' })], { a: ['x', 2, true] })).toBe('a=x&a=2&a=true');
      expect(formBody([field('icon', URLENCODED, { contentType: 'image/png, image/jpeg' })], { icon: 'iVBOR/w==' })).toBe('icon=iVBOR%2Fw%3D%3D');

      const error = buildFailure(() => build([field('a', URLENCODED, { contentType: 'text/plain' }, { inputKey: 'A' })], { a: 1, A: { b: 1 } }));
      expect(error.message).toBe("body parameter 'a' is sent as text/plain, which needs a string or another primitive; received an object");
      expect(error.context).toEqual({ param: 'a', inputKey: 'A', location: 'body', contentType: 'text/plain' });
    });

    it('writes a nested form string for a form media type', () => {
      expect(formBody([field('f', URLENCODED, { contentType: URLENCODED })], { f: { a: '1', b: 'x y' } })).toBe('f=a%3D1%26b%3Dx%2By');
    });

    it('defaults by the value without a contentType: JSON for an object or array item, the string form of a primitive', () => {
      const body = formBody([field('a', URLENCODED, { headers: { 'X-Ignored': {} } })], { a: [{ b: 1 }, [2], 'c', 3] });

      expect(body).toBe('a=%7B%22b%22%3A1%7D&a=%5B2%5D&a=c&a=3');
      expect(() => build([field('a', URLENCODED, {})], { a: [null] })).toThrow("body parameter 'a' must serialize to a primitive; received null");
    });

    it('refuses what JSON cannot write, with the input key', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;

      const error = buildFailure(() => build([field('a', URLENCODED, { contentType: 'application/json' }, { inputKey: 'A' })], { A: cyclic }));
      expect(error.message).toBe("body parameter 'a' cannot be serialized as JSON: it contains itself (a cycle)");
      expect(error.context).toEqual({ param: 'a', inputKey: 'A', location: 'body' });
      expect(() => build([field('a', URLENCODED, {})], { a: { n: 1n } })).toThrow(/body parameter 'a' cannot be serialized as JSON: /);
      expect(() => build([field('a', URLENCODED, { contentType: 'application/json' })], { a: () => 1 })).toThrow(
        /body parameter 'a' has no JSON representation/,
      );
    });

    it('refuses a form string for a field that is not an object', () => {
      const error = buildFailure(() => build([field('f', URLENCODED, { contentType: URLENCODED })], { f: 'a=1' }));

      expect(error.message).toBe(`body parameter 'f' is sent as ${URLENCODED}, which needs an object; received "a=1"`);
      expect(error.context).toEqual({ param: 'f', inputKey: 'f', location: 'body', contentType: URLENCODED });
    });
  });

  describe('whole bodies, whole queries and content parameters', () => {
    it('reads a whole form body\'s Encoding Objects by property name', () => {
      const tool = formTool([
        {
          inputKey: 'body',
          type: 'body',
          key: 'body',
          wholeBody: true,
          serialization: { contentType: URLENCODED, encoding: { meta: { style: 'deepObject' }, list: { explode: false } } },
        },
      ]);

      expect(buildHttpRequest(tool, { body: { meta: { a: 1 }, list: [1, 2], other: { x: 1 } } }).body).toBe(
        'meta%5Ba%5D=1&list=1%2C2&other=%7B%22x%22%3A1%7D',
      );
    });

    it('applies them to a form whole query, checking every name a field puts in the query', () => {
      const credential: ParameterMapper = { inputKey: 'cred', type: 'query', key: 'api_key', security: { scheme: 'keyScheme', type: 'apiKey' } };
      const tool = fooTool([
        {
          inputKey: 'q',
          type: 'query',
          key: 'q',
          wholeQuery: true,
          serialization: { contentType: URLENCODED, encoding: { f: { style: 'deepObject' }, o: { explode: true }, r: { allowReserved: true } } },
        },
        credential,
      ]);

      const built = buildHttpRequest(tool, { q: { f: { a: 'x' }, o: { b: 'y' }, r: 'a/b' }, cred: 'k' });
      expect(built.url).toBe('https://example.com/foo?f%5Ba%5D=x&b=y&r=a/b&api_key=k');
      expect(built.query).toEqual({ 'f[a]': ['x'], b: ['y'], r: ['a/b'], api_key: ['k'] });

      const error = buildFailure(() => buildHttpRequest(tool, { q: { o: { api_key: 'attacker' } } }));
      expect(error.message).toBe(
        "The input of query parameter 'q' (input key 'q') names the query parameter 'api_key', which this tool reserves for the credential of security scheme 'keyScheme'",
      );
      expect(error.context).toEqual({ param: 'q', inputKey: 'q', location: 'query', name: 'api_key', reservedBy: 'cred' });
    });

    it('applies them to a form content parameter, whose names stay inside its one value', () => {
      const tool = fooTool([
        { inputKey: 'p', type: 'query', key: 'p', serialization: { contentType: URLENCODED, encoding: { ids: { explode: false } } } },
      ]);

      expect(buildHttpRequest(tool, { p: { ids: [1, 2], q: 'x' } }).url).toBe('https://example.com/foo?p=ids%3D1%252C2%26q%3Dx');
    });

    it('ignores the Encoding Objects of a JSON or other content parameter, however they are written', () => {
      const tool = fooTool([{ inputKey: 'p', type: 'query', key: 'p', serialization: { contentType: 'application/json', encoding: 'junk' as any } }]);

      expect(buildHttpRequest(tool, { p: { ids: [1, 2] } }).url).toBe('https://example.com/foo?p=%7B%22ids%22%3A%5B1%2C2%5D%7D');
    });
  });

  describe('names the input chooses in a form body', () => {
    it('refuses an exploded object property named like another body field, given or not', () => {
      const mapper = [field('opts', URLENCODED, { style: 'form', explode: true }), field('name', URLENCODED, undefined, { inputKey: 'theName' })];

      for (const input of [{ opts: { name: 'evil' } }, { opts: { name: 'evil' }, theName: 'real' }]) {
        const error = buildFailure(() => build(mapper, input));
        expect(error.message).toBe(
          "The input of body parameter 'opts' (input key 'opts') names the form field 'name', which this tool reserves for the body parameter 'name' (input key 'theName')",
        );
        expect(error.context).toEqual({ param: 'opts', inputKey: 'opts', location: 'body', name: 'name', reservedBy: 'theName' });
      }
    });

    it('refuses a deepObject name that is another body field', () => {
      const mapper = [field('meta', URLENCODED, { style: 'deepObject' }), field('meta[plan]', URLENCODED)];

      expect(() => build(mapper, { meta: { plan: 'pro' } })).toThrow(
        "names the form field 'meta[plan]', which this tool reserves for the body parameter 'meta[plan]' (input key 'meta[plan]')",
      );
      expect(formBody(mapper, { meta: { tier: 'pro' }, 'meta[plan]': 'x' })).toBe('meta%5Btier%5D=pro&meta%5Bplan%5D=x');
    });

    it('refuses the same in a multipart body', () => {
      const mapper = [field('opts', MULTIPART, { explode: true }), field('file', MULTIPART)];

      expect(() => build(mapper, { opts: { file: 'evil' } })).toThrow("names the form field 'file', which this tool reserves for the body parameter 'file'");
    });

    it('allows the field\'s own name, names no other field has, and __proto__ as an ordinary name', () => {
      const mapper = [field('opts', URLENCODED, { explode: true }), field('other', URLENCODED)];

      expect(formBody(mapper, { opts: JSON.parse('{"opts":1,"x":2,"__proto__":3,"constructor":4}') })).toBe('opts=1&x=2&__proto__=3&constructor=4');
    });

    it('refuses a __proto__ property when a body field has that name', () => {
      const mapper = [field('opts', URLENCODED, { explode: true }), field('__proto__', URLENCODED)];

      expect(() => build(mapper, { opts: JSON.parse('{"__proto__":"x"}') })).toThrow("names the form field '__proto__'");
    });

    it('checks nothing in a whole body, where every field name is the input\'s', () => {
      const tool = formTool([
        { inputKey: 'b', type: 'body', key: 'b', wholeBody: true, serialization: { contentType: URLENCODED, encoding: { o: { explode: true } } } },
      ]);

      expect(buildHttpRequest(tool, { b: { o: { a: 1, b: 2 }, a: 3 } }).body).toBe('a=1&b=2&a=3');
    });

    it('reads an Encoding Object as an own property only', () => {
      const encoding = Object.create({ toString: { style: 'deepObject' } });
      const tool = formTool([{ inputKey: 'toString', type: 'body', key: 'toString', serialization: { contentType: URLENCODED, encoding } }]);

      expect(buildHttpRequest(tool, { toString: { a: 1 } }).body).toBe('toString=%7B%22a%22%3A1%7D');
    });
  });

  describe('hostile and huge values', () => {
    it('refuses a cyclic deepObject value instead of recursing forever, in a body and in the query', () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic['self'] = { back: cyclic };

      const error = buildFailure(() => build([field('m', URLENCODED, { style: 'deepObject' }, { inputKey: 'M' })], { M: cyclic }));
      expect(error.message).toBe("body parameter 'm' cannot be serialized with style deepObject: it contains itself (a cycle)");
      expect(error.context).toEqual({ param: 'm', inputKey: 'M', location: 'body' });

      const query = fooTool([{ inputKey: 'm', type: 'query', key: 'm', style: 'deepObject' }]);
      expect(() => buildHttpRequest(query, { m: cyclic })).toThrow("query parameter 'm' cannot be serialized with style deepObject: it contains itself (a cycle)");
    });

    it('refuses a deepObject value nested far deeper than the stack allows', () => {
      let deep: Record<string, unknown> = { leaf: 1 };
      for (let i = 0; i < 200_000; i++) deep = { d: deep };

      expect(() => build([field('m', URLENCODED, { style: 'deepObject' })], { m: deep })).toThrow(
        "body parameter 'm' cannot be serialized with style deepObject: it nests deeper than 1000 levels",
      );
    });

    it('refuses a lone surrogate in a deepObject key', () => {
      expect(() => build([field('m', URLENCODED, { style: 'deepObject' })], { m: { ['k\ud800']: 1 } })).toThrow(
        "body parameter 'm[k\ud800]' contains a lone surrogate",
      );
    });
  });

  describe('Encoding Objects of the wrong shape', () => {
    const failure = (encoding: unknown, value: unknown = 'x') => buildFailure(() => build([field('f', URLENCODED, encoding, { inputKey: 'F' })], { F: value }));
    const prefix = "body parameter 'f' (input key 'F') has an invalid Encoding Object for 'f' in serialization.encoding: ";

    it.each([
      [null, 'it must be an object; received null'],
      [['style'], 'it must be an object; received an array'],
      [{ style: 1 }, 'style must be a string; received 1'],
      [{ style: null }, 'style must be a string; received null'],
      [{ explode: 'yes' }, 'explode must be a boolean; received "yes"'],
      [{ allowReserved: 1 }, 'allowReserved must be a boolean; received 1'],
      [{ contentType: 1 }, 'contentType must name a media type; received 1'],
      [{ contentType: ' , ' }, 'contentType must name a media type; received " , "'],
      [{ contentType: '; charset=utf-8' }, 'contentType must name a media type; received "; charset=utf-8"'],
    ])('refuses %p', (encoding, problem) => {
      const error = failure(encoding);

      expect(error.message).toBe(prefix + problem);
      expect(error.context).toEqual({ param: 'f', inputKey: 'F', location: 'body', field: 'f' });
    });

    it('refuses an encoding map that is not an object', () => {
      const tool = formTool([{ inputKey: 'f', type: 'body', key: 'f', serialization: { contentType: URLENCODED, encoding: [] as any } }]);

      expect(() => buildHttpRequest(tool, { f: 'x' })).toThrow(prefix.replace("(input key 'F')", "(input key 'f')") + 'the encoding map must be an object; received an array');
    });

    it('refuses multipart headers that are not an object, and ignores them in a urlencoded form', () => {
      expect(formBody([field('f', URLENCODED, { headers: 'X' })], { f: 'x' })).toBe('f=x');

      const error = buildFailure(() => build([field('f', MULTIPART, { headers: 'X' }, { inputKey: 'F' })], { F: 'x' }));
      expect(error.message).toBe(`${prefix}headers must be an object; received "X"`);
      expect(error.context).toEqual({ param: 'f', inputKey: 'F', location: 'body', field: 'f' });
    });
  });

  describe('multipart/form-data', () => {
    it('keeps every field without an Encoding Object as it was: an array is ONE part of JSON text, null the text null', () => {
      const built = build([field('tags', MULTIPART), field('meta', MULTIPART), field('n', MULTIPART), field('file', MULTIPART)], {
        tags: ['a', 'b'],
        meta: { a: 1 },
        n: null,
        file: new Uint8Array([1]),
      });

      expect(entriesOf(built.body)).toEqual([
        ['tags', '["a","b"]'],
        ['meta', '{"a":1}'],
        ['n', 'null'],
        ['file', '<>'],
      ]);
      expect(built.headers['content-type']).toBeUndefined();
    });

    it.each(STYLE_EXAMPLES)(
      'sends style %s, explode %s, %s value as the pairs of the table, one part each, never percent-encoded',
      (style, explode, kind, spec) => {
        const built = build([field('color', MULTIPART, { style, ...(explode !== undefined && { explode }) })], { color: VALUES[kind] });

        // Appendix C: names in Content-Disposition, values in the part, no `?`, `=`, `&` and no percent-encoding
        expect(entriesOf(built.body)).toEqual(pairsOf(spec));
        expect(built.headers['content-type']).toBeUndefined();
      },
    );

    it('sends multi (explode) one part per item and csv (explode false) one delimited part', () => {
      expect(entriesOf(build([field('tags', MULTIPART, { style: 'form', explode: true })], { tags: ['x', 'y'] }).body)).toEqual([
        ['tags', 'x'],
        ['tags', 'y'],
      ]);
      expect(entriesOf(build([field('tags', MULTIPART, { style: 'form', explode: false })], { tags: ['x', 'y z'] }).body)).toEqual([
        ['tags', 'x,y z'],
      ]);
    });

    it('sends a deepObject object one part per bracketed name (Stripe file_link_data)', () => {
      const built = build([field('file_link_data', MULTIPART, { style: 'deepObject', explode: true })], {
        file_link_data: { create: true, metadata: { k: 'v' } },
      });

      expect(entriesOf(built.body)).toEqual([
        ['file_link_data[create]', 'true'],
        ['file_link_data[metadata][k]', 'v'],
      ]);
    });

    it('applies no percent-encoding with allowReserved, which has no effect in multipart', () => {
      expect(entriesOf(build([field('p', MULTIPART, { allowReserved: true })], { p: 'a&b=c/d' }).body)).toEqual([['p', 'a&b=c/d']]);
    });

    it('leaves out null with an Encoding Object', () => {
      expect(entriesOf(build([field('p', MULTIPART, {}), field('q', MULTIPART)], { p: null, q: 'x' }).body)).toEqual([['q', 'x']]);
    });

    it('writes the body itself when a part needs a header FormData cannot write: a text part\'s Content-Type or a part header', async () => {
      const built = build(
        [
          field('id', MULTIPART),
          field('meta', MULTIPART, {
            contentType: 'application/json',
            headers: {
              'X-Trace': { schema: { type: 'string', const: 't-1' } },
              'X-Free': { schema: { type: 'string' } },
              'content-type': { schema: { const: 'x/y' } },
            },
          }),
          field('tags', MULTIPART, { style: 'form', explode: true }),
          field('file', MULTIPART, { contentType: 'image/png' }),
        ],
        { id: '7', meta: { a: 1 }, tags: ['x', 'y'], file: new Uint8Array([1, 2]) },
      );

      expect(await writtenText(built)).toBe(
        '--BOUNDARY\r\nContent-Disposition: form-data; name="id"\r\n\r\n7\r\n' +
          '--BOUNDARY\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\nX-Trace: t-1\r\n\r\n{"a":1}\r\n' +
          '--BOUNDARY\r\nContent-Disposition: form-data; name="tags"\r\n\r\nx\r\n' +
          '--BOUNDARY\r\nContent-Disposition: form-data; name="tags"\r\n\r\ny\r\n' +
          '--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: image/png\r\n\r\n\u0001\u0002\r\n' +
          '--BOUNDARY--\r\n',
      );
      expect(await parsed(built)).toEqual([
        ['id', '7'],
        ['meta', '{"a":1}'],
        ['tags', 'x'],
        ['tags', 'y'],
        ['file', '<image/png>'],
      ]);
      expect(built.contentType).toBe('multipart/form-data');
    });

    it('writes every other part exactly as FormData does (undici), so only the extra headers differ', async () => {
      const input: Record<string, unknown> = {
        text: 'a\nb\r\nc\rd',
        'we"ird\nname': 'v',
        file: new File([new Uint8Array([9])], 'x"y\r\n.png', { type: 'image/png' }),
        bytes: new Uint8Array([7]),
        unnamed: new File([new Uint8Array([8])], ''),
        blob: new Blob(['b']),
      };
      const plain = Object.keys(input).map((key) => field(key, MULTIPART));
      const response = new Response(build(plain, input).body as FormData);
      const boundary = /boundary=(.+)$/.exec(response.headers.get('content-type')!)![1];
      const viaFormData = (await response.text()).split(boundary).join('BOUNDARY');

      const own = await writtenText(build([...plain, field('extra', MULTIPART, { contentType: 'text/plain' })], { ...input, extra: 'e' }));
      expect(own).toBe(
        viaFormData.replace(
          '--BOUNDARY--\r\n',
          '--BOUNDARY\r\nContent-Disposition: form-data; name="extra"\r\nContent-Type: text/plain\r\n\r\ne\r\n--BOUNDARY--\r\n',
        ),
      );
    });

    it('sends each item of an array as its own part by content type ("Encoding By Name")', async () => {
      const built = build([field('addresses', MULTIPART, { contentType: 'application/json' })], { addresses: [{ city: 'A' }, { city: 'B' }] });

      expect(await parsed(built)).toEqual([
        ['addresses', '{"city":"A"}'],
        ['addresses', '{"city":"B"}'],
      ]);
      expect(await writtenText(built)).toContain('name="addresses"\r\nContent-Type: application/json\r\n\r\n{"city":"B"}\r\n');
    });

    it('names the first media type of a list, parameters kept, and none for a range (FormData then suffices)', async () => {
      const typed = build([field('x', MULTIPART, { contentType: 'application/xml; charset=utf-8, text/plain' })], { x: '<a/>' });
      expect(await writtenText(typed)).toContain('name="x"\r\nContent-Type: application/xml; charset=utf-8\r\n\r\n<a/>\r\n');

      expect(entriesOf(build([field('words', MULTIPART, { contentType: 'text/*' })], { words: ['a', 'b'] }).body)).toEqual([
        ['words', 'a'],
        ['words', 'b'],
      ]);
    });

    it('writes application/json for an object without a contentType, nothing for a primitive (text/plain is the default)', async () => {
      const built = build([field('meta', MULTIPART, {}), field('n', MULTIPART, {})], { meta: { a: 1 }, n: 2 });

      expect(await writtenText(built)).toBe(
        '--BOUNDARY\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n{"a":1}\r\n' +
          '--BOUNDARY\r\nContent-Disposition: form-data; name="n"\r\n\r\n2\r\n--BOUNDARY--\r\n',
      );
      expect(entriesOf(build([field('n', MULTIPART, {})], { n: 2 }).body)).toEqual([['n', '2']]);
    });

    it('refuses an object for a media type it cannot write', () => {
      expect(() => build([field('a', MULTIPART, { contentType: 'application/xml' })], { a: { b: 1 } })).toThrow(
        "body parameter 'a' is sent as application/xml, which needs a string or another primitive; received an object",
      );
    });

    it('types a file that has no type by one named media type, keeping its name; a file with a type keeps it', () => {
      const built = build(
        [
          field('a', MULTIPART, { contentType: 'image/png' }),
          field('b', MULTIPART, { contentType: 'image/png' }),
          field('c', MULTIPART, { contentType: 'image/png, image/jpeg' }),
          field('d', MULTIPART, { contentType: 'image/*' }),
          field('e', MULTIPART, { style: 'form', contentType: 'image/png' }),
          field('f', MULTIPART, { contentType: 'image/gif' }),
          field('g', MULTIPART, { contentType: 'text/csv' }),
        ],
        {
          a: new File([new Uint8Array([1])], 'a.bin', { lastModified: 5 }),
          b: new Blob(['x'], { type: 'image/jpeg' }),
          c: new Uint8Array([1]),
          d: new Uint8Array([2]),
          e: new Blob(['y']),
          f: [new Uint8Array([3]), new Blob(['z'])],
          g: new Blob(['q']),
        },
      );
      const form = built.body as FormData;

      expect(entriesOf(form)).toEqual([
        ['a', '<image/png>'],
        ['b', '<image/jpeg>'],
        ['c', '<image/png>'],
        ['d', '<>'],
        ['e', '<>'],
        ['f', '<image/gif>'],
        ['f', '<image/gif>'],
        ['g', '<text/csv>'],
      ]);
      expect((form.get('a') as File).name).toBe('a.bin');
      expect((form.get('a') as File).lastModified).toBe(5);
    });

    it('sends the headers whose value the document pins, and no other', async () => {
      const headers = {
        'X-Const': { schema: { const: 'c' } },
        'X-Enum': { schema: { enum: [3] } },
        'X-Bool': { schema: { const: true } },
        'X-Two': { schema: { enum: ['a', 'b'] } },
        'X-Free': { schema: { type: 'string' } },
        'X-NoSchema': { description: 'no schema' },
        'X-BooleanSchema': { schema: true },
        'X-Ref': { $ref: '#/components/headers/X' },
        'X-NotObject': 'header',
        'X-Object': { schema: { const: { a: 1 } } },
        'X-Null': { schema: { enum: [null] } },
        'Content-Type': { schema: { const: 'text/html' } },
        'CONTENT-DISPOSITION': { schema: { const: 'inline' } },
        'Content-Transfer-Encoding': { schema: { const: 'base64' } },
      };

      expect(await writtenText(build([field('p', MULTIPART, { headers })], { p: 'aGk=' }))).toBe(
        '--BOUNDARY\r\nContent-Disposition: form-data; name="p"\r\nX-Const: c\r\nX-Enum: 3\r\nX-Bool: true\r\nContent-Transfer-Encoding: base64\r\n\r\naGk=\r\n--BOUNDARY--\r\n',
      );
      // a header nobody pins changes nothing: FormData, as without an Encoding Object
      expect(entriesOf(build([field('p', MULTIPART, { headers: { 'X-Free': { schema: { type: 'string' } } } })], { p: 'x' }).body)).toEqual([['p', 'x']]);
    });

    it.each([
      ['CR and LF in the value', { 'X-A': { schema: { const: 'v\r\nX-Injected: 1' } } }, "Header 'X-A' value contains control characters (possible header injection)", 'X-A'],
      ['a name that is not a token', { 'X A': { schema: { const: 'v' } } }, "Invalid header name 'X A' (RFC 7230 token required)", 'X A'],
      [
        'a character no header can hold',
        { 'X-A': { schema: { const: 'v€' } } },
        "Header 'X-A' value contains U+20AC at index 1, which a header value cannot hold (only tab, space, visible ASCII and U+0080 to U+00FF)",
        'X-A',
      ],
    ])('refuses a pinned part header with %s', (_label, headers, message, header) => {
      const error = buildFailure(() => build([field('p', MULTIPART, { headers }, { inputKey: 'P' })], { P: 'x' }));

      expect(error.message).toBe(message);
      expect(error.context).toEqual({ header, param: 'p', inputKey: 'P', location: 'body', field: 'p' });
    });

    it('refuses a part Content-Type with CR or LF (a document cannot add part headers through it)', () => {
      const encoding = { contentType: 'text/plain\r\nX-Injected: 1' };
      const error = buildFailure(() => build([field('p', MULTIPART, encoding)], { p: 'x' }));

      expect(error.message).toBe("Header 'Content-Type' value contains control characters (possible header injection)");
      expect(error.context).toEqual({ header: 'Content-Type', param: 'p', inputKey: 'p', location: 'body', field: 'p' });
      // not a header in a urlencoded form: only how the value is written
      expect(formBody([field('p', URLENCODED, encoding)], { p: 'x' })).toBe('p=x');
    });

    it('replaces a spec-mapped Content-Type header with its own, boundary included', () => {
      const built = build([{ inputKey: 'ct', type: 'header', key: 'Content-Type' }, field('m', MULTIPART, { contentType: 'application/json' })], {
        ct: 'multipart/form-data',
        m: { a: 1 },
      });

      expect(Object.keys(built.headers)).toEqual(['Content-Type']);
      expect(built.headers['Content-Type']).toBe((built.body as Blob).type);
      expect(built.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=mcp-from-openapi-[0-9a-f]{32}$/);
    });

    it('reads a whole multipart body\'s Encoding Objects by property name', async () => {
      const tool = formTool([
        {
          inputKey: 'body',
          type: 'body',
          key: 'body',
          wholeBody: true,
          serialization: { contentType: MULTIPART, encoding: { meta: { contentType: 'application/json' }, tags: { explode: true } } },
        },
      ]);
      const built = buildHttpRequest(tool, { body: { meta: { a: 1 }, tags: ['x', 'y'], other: ['z'] } });

      expect(await parsed(built)).toEqual([
        ['meta', '{"a":1}'],
        ['tags', 'x'],
        ['tags', 'y'],
        ['other', '["z"]'],
      ]);
    });

    it('refuses a cyclic object part with a RequestBuildError, with or without an Encoding Object (a TypeError before)', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;

      expect(() => build([field('m', MULTIPART)], { m: cyclic })).toThrow("body parameter 'm' cannot be serialized as JSON: it contains itself (a cycle)");
      expect(() => build([field('m', URLENCODED)], { m: cyclic })).toThrow("body parameter 'm' cannot be serialized as JSON: it contains itself (a cycle)");
      expect(() => build([field('m', MULTIPART, {})], { m: cyclic })).toThrow(RequestBuildError);
    });
  });
});

/**
 * allowReserved never lets a value change the structure of the query string or
 * the URL (OpenAPI 3.2.1 Parameter Object `allowReserved`, "URL
 * Percent-Encoding", Appendices C and E). One definition of what it keeps raw
 * serves a query value and a form value.
 */
describe('allowReserved keeps only what cannot change the query string or the URL', () => {
  const credential: ParameterMapper = { inputKey: 'cred', type: 'query', key: 'api_key', security: { scheme: 'keyScheme', type: 'apiKey' } };
  const queryUrl = (allowReserved: boolean | undefined, p: unknown) =>
    buildHttpRequest(fooTool([{ inputKey: 'p', type: 'query', key: 'p', ...(allowReserved !== undefined && { allowReserved }) }]), { p }).url;
  const formBodyOf = (allowReserved: boolean, p: unknown) =>
    buildHttpRequest(
      makeTool(
        [
          {
            inputKey: 'p',
            type: 'body',
            key: 'p',
            serialization: { contentType: 'application/x-www-form-urlencoded', encoding: { p: { allowReserved } } },
          },
        ],
        { path: '/t' },
      ),
      { p },
    ).body as string;
  const wholeQueryUrl = (p: unknown) =>
    buildHttpRequest(
      fooTool([
        {
          inputKey: 'q',
          type: 'query',
          key: 'q',
          wholeQuery: true,
          serialization: { contentType: 'application/x-www-form-urlencoded', encoding: { p: { allowReserved: true } } },
        },
      ]),
      { q: { p } },
    ).url;
  /** What a call gives: the request's url, headers and cookies, or the error message */
  const outcome = (call: () => BuiltHttpRequest) => {
    try {
      const built = call();
      return { url: built.url, headers: built.headers, cookies: built.cookies };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };

  // Each character inside a value `a<char>b`: how a query value and a form value with allowReserved write it.
  // Kept raw: the reserved characters the destination gives no meaning (`:/?@!$'()*,;`) and a percent-encoded
  // triple. Always encoded: `&` `=` (pair delimiters), `+` (a space), `#` (a fragment), `[` `]` (not allowed in a
  // query), a `%` that starts no triple, and everything that is not reserved. A space is `%20` in the query and `+`
  // in a form (each encoder's own writing; both decode to a space), `~` is unreserved for RFC 3986 and encoded by the
  // WHATWG form encoder.
  const CHARACTERS: Array<[label: string, char: string, query: string, form: string]> = [
    ['ampersand', '&', '%26', '%26'],
    ['equals sign', '=', '%3D', '%3D'],
    ['plus sign', '+', '%2B', '%2B'],
    ['hash', '#', '%23', '%23'],
    ['left bracket', '[', '%5B', '%5B'],
    ['right bracket', ']', '%5D', '%5D'],
    ['lone percent sign', '%', '%25', '%25'],
    ['percent sign before non-hex', '%zz', '%25zz', '%25zz'],
    ['percent-encoded triple', '%41', '%41', '%41'],
    ['percent-encoded ampersand', '%26', '%26', '%26'],
    ['question mark', '?', '?', '?'],
    ['slash', '/', '/', '/'],
    ['colon', ':', ':', ':'],
    ['at sign', '@', '@', '@'],
    ['exclamation mark', '!', '!', '!'],
    ['dollar sign', '$', '$', '$'],
    ['apostrophe', "'", "'", "'"],
    ['left parenthesis', '(', '(', '('],
    ['right parenthesis', ')', ')', ')'],
    ['asterisk', '*', '*', '*'],
    ['comma', ',', ',', ','],
    ['semicolon', ';', ';', ';'],
    ['space', ' ', '%20', '+'],
    ['tilde', '~', '~', '%7E'],
    ['double quote', '"', '%22', '%22'],
    ['pipe', '|', '%7C', '%7C'],
    ['backslash', '\\', '%5C', '%5C'],
    ['non-ASCII', 'é', '%C3%A9', '%C3%A9'],
  ];

  describe.each(CHARACTERS)('%s (%s)', (_label, char, query, form) => {
    const value = `a${char}b`;

    it('in a query value with allowReserved', () => {
      expect(queryUrl(true, value)).toBe(`https://example.com/foo?p=a${query}b`);
      expect(new URL(queryUrl(true, value)).searchParams.getAll('p')).toEqual([char === '+' ? 'a+b' : decodeURIComponent(`a${query}b`)]);
    });

    it('in a form body field and a form whole query with allowReserved', () => {
      expect(formBodyOf(true, value)).toBe(`p=a${form}b`);
      expect(wholeQueryUrl(value)).toBe(`https://example.com/foo?p=a${form}b`);
    });

    it('in a path, a header, a cookie and a content parameter, where allowReserved changes nothing', () => {
      for (const type of ['path', 'header', 'cookie'] as const) {
        const sent = (allowReserved: boolean) =>
          outcome(() =>
            buildHttpRequest(
              makeTool([{ inputKey: 'p', type, key: type === 'header' ? 'X-P' : 'p', required: true, allowReserved }], {
                path: type === 'path' ? '/t/{p}' : '/t',
              }),
              { p: value },
            ),
          );
        expect(sent(true)).toEqual(sent(false));
      }
      const content = (allowReserved: boolean) =>
        outcome(() =>
          buildHttpRequest(fooTool([{ inputKey: 'p', type: 'query', key: 'p', allowReserved, serialization: { contentType: 'text/plain' } }]), { p: value }),
        );
      expect(content(true)).toEqual(content(false));
    });
  });

  it('keeps a path value percent-encoded whatever allowReserved says: / ? # and % never reach the path raw', () => {
    const tool = makeTool([{ inputKey: 'id', type: 'path', key: 'id', required: true, allowReserved: true }], { path: '/files/{id}' });

    expect(buildHttpRequest(tool, { id: 'a/b?c#d%e%41' }).url).toBe('https://api.example.com/files/a%2Fb%3Fc%23d%25e%2541');
  });

  it('cannot add a pair named like a query credential: x&api_key=attacker (it used to send two api_key pairs)', () => {
    const tool = fooTool([{ inputKey: 'next', type: 'query', key: 'next', allowReserved: true }, credential]);

    const built = buildHttpRequest(tool, { next: 'x&api_key=attacker', cred: 'real' });
    expect(built.url).toBe('https://example.com/foo?next=x%26api_key%3Dattacker&api_key=real');
    expect(new URL(built.url).searchParams.getAll('api_key')).toEqual(['real']);
    expect(new URL(built.url).searchParams.get('next')).toBe('x&api_key=attacker');
    expect(built.query).toEqual({ next: ['x&api_key=attacker'], api_key: ['real'] });

    const absent = buildHttpRequest(tool, { next: 'x&api_key=attacker' });
    expect(new URL(absent.url).searchParams.has('api_key')).toBe(false);
  });

  it('cannot cut the query with a fragment: a#b (it used to send ?p=a#b, which drops #b and every later pair)', () => {
    const tool = fooTool([{ inputKey: 'p', type: 'query', key: 'p', allowReserved: true }, { inputKey: 'q', type: 'query', key: 'q' }]);

    const built = buildHttpRequest(tool, { p: 'a#b', q: 'after' });
    expect(built.url).toBe('https://example.com/foo?p=a%23b&q=after');
    expect(new URL(built.url).hash).toBe('');
    expect([...new URL(built.url).searchParams]).toEqual([
      ['p', 'a#b'],
      ['q', 'after'],
    ]);
  });

  it('applies the same rule to every value of an array, an exploded object and a deepObject in the query', () => {
    const tool = (mapper: Partial<ParameterMapper>) => fooTool([{ inputKey: 'p', type: 'query', key: 'p', allowReserved: true, ...mapper }]);

    expect(buildHttpRequest(tool({ explode: false }), { p: ['a&b', 'c/d'] }).url).toBe('https://example.com/foo?p=a%26b,c/d');
    expect(buildHttpRequest(tool({}), { p: ['a=b', 'c#d'] }).url).toBe('https://example.com/foo?p=a%3Db&p=c%23d');
    expect(buildHttpRequest(tool({ style: 'deepObject' }), { p: { k: 'v&w=x' } }).url).toBe('https://example.com/foo?p[k]=v%26w%3Dx');
  });

  it('is one definition: a query value and a form value keep the same reserved characters', () => {
    const printable = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join('');
    /** The characters an encoded value holds raw, letters and digits aside */
    const raw = (encoded: string) => [...new Set(encoded.replace(/%[0-9A-F]{2}/g, '').replace(/[A-Za-z0-9]/g, ''))].sort().join('');
    const sorted = (chars: string) => [...chars].sort().join('');

    // the reserved characters both keep, plus what each encoder never encodes: `-._~` (RFC 3986 unreserved) in the
    // query, `-._` and `+` for a space in a form
    expect(raw(queryUrl(true, printable).split('?p=')[1])).toBe(sorted(":/?@!$'()*,;" + '-._~'));
    expect(raw(formBodyOf(true, printable).slice('p='.length))).toBe(sorted(":/?@!$'()*,;" + '-._+'));
  });
});
