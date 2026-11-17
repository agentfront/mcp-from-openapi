import { RequestBuildError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import { buildHttpRequest } from '../request-builder';
import type { McpOpenAPITool, ParameterMapper } from '../types';
import { Validator } from '../validator';

function toolFor(path: string, mapper: ParameterMapper[], baseUrl = 'https://api.example.com'): McpOpenAPITool {
  return {
    name: 'tool',
    description: 'tool',
    inputSchema: { type: 'object', properties: {} },
    mapper,
    metadata: { path, method: 'delete', servers: [{ url: baseUrl }] } as McpOpenAPITool['metadata'],
  };
}

const pathParameter = (key: string, style?: string, explode?: boolean): ParameterMapper => ({
  inputKey: key,
  type: 'path',
  key,
  required: true,
  ...(style && { style }),
  ...(explode !== undefined && { explode }),
});

describe('a path value cannot change which resource a request names', () => {
  const memberTool = toolFor('/v1/projects/{projectId}/members/{memberId}', [
    pathParameter('projectId'),
    pathParameter('memberId'),
  ]);

  it.each(['..', '.'])('refuses the dot segment %p', (memberId) => {
    expect(() => buildHttpRequest(memberTool, { projectId: '42', memberId })).toThrow(RequestBuildError);
  });

  it.each(['', []])('refuses a value that removes the segment (%p)', (memberId) => {
    expect(() => buildHttpRequest(memberTool, { projectId: '42', memberId })).toThrow(RequestBuildError);
  });

  it('refuses a label value that composes a dot segment', () => {
    const tool = toolFor('/v1/files/{name}', [pathParameter('name', 'label', true)]);
    expect(() => buildHttpRequest(tool, { name: ['', ''] })).toThrow(RequestBuildError);
  });

  it('keeps values that only look like traversal as one encoded segment', () => {
    const built = buildHttpRequest(memberTool, { projectId: '%2e%2e', memberId: 'a/../b' });
    expect(built.url).toBe('https://api.example.com/v1/projects/%252e%252e/members/a%2F..%2Fb');
  });

  it('keeps ordinary values, dots inside a value, and a template with a trailing slash', () => {
    expect(buildHttpRequest(memberTool, { projectId: '42', memberId: 'v1.2' }).url).toBe(
      'https://api.example.com/v1/projects/42/members/v1.2',
    );
    const trailing = toolFor('/v1/items/{id}/', [pathParameter('id')]);
    expect(buildHttpRequest(trailing, { id: '7' }).url).toBe('https://api.example.com/v1/items/7/');
    const label = toolFor('/v1/files/{name}', [pathParameter('name', 'label')]);
    expect(buildHttpRequest(label, { name: 'report' }).url).toBe('https://api.example.com/v1/files/.report');
  });

  it('keeps two parameters in one segment when one of them is empty but the segment is not', () => {
    const tool = toolFor('/v1/files/{stem}{extension}', [pathParameter('stem'), pathParameter('extension')]);
    expect(buildHttpRequest(tool, { stem: 'report', extension: '' }).url).toBe('https://api.example.com/v1/files/report');
  });
});

describe('the request path always starts with exactly one slash', () => {
  it('refuses a relative-mode request that would become a network-path reference', () => {
    const tool = toolFor('/{db}/{doc}', [pathParameter('db'), pathParameter('doc')], '');
    expect(() => buildHttpRequest(tool, { db: '', doc: 'evil.example' })).toThrow(RequestBuildError);
  });

  it.each(['//evil.example/collect', '/\\evil.example/collect', '.evil.example/x', '@evil.example/x', 'x'])(
    'refuses the tool path %p with an absolute and with an empty base',
    (path) => {
      for (const baseUrl of ['https://api.example.com', '']) {
        expect(() => buildHttpRequest(toolFor(path, [], baseUrl), {}, { baseUrl })).toThrow(RequestBuildError);
      }
    },
  );

  it('keeps the root path', () => {
    expect(buildHttpRequest(toolFor('/', []), {}).url).toBe('https://api.example.com/');
  });
});

describe('the validator refuses path keys that are not path templates', () => {
  const document = (path: string) => ({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: { [path]: { get: { responses: { 200: { description: 'ok' } } } } },
  });

  it.each([
    '//evil.example/collect',
    '/a//b',
    '/\\evil.example',
    '/public/../admin',
    '/public/./admin',
    '/public/%2e%2e/admin',
    '/public/%2E/admin',
    '/a/{id',
    '/a/id}',
    '/a/{}',
  ])('%p', async (path) => {
    const result = await new Validator().validate(document(path));
    expect(result.valid).toBe(false);
    expect(result.errors?.map((error) => error.code)).toContain('INVALID_PATH_FORMAT');
  });

  it.each(['/', '/users/', '/a/{id}', '/a/{id}.{format}', '/v1.2/items', '/a/..b', '/a/b..'])('accepts %p', async (path) => {
    const result = await new Validator().validate(document(path));
    expect(result.errors?.map((error) => error.code) ?? []).not.toContain('INVALID_PATH_FORMAT');
  });

  it('a generated tool for such a path cannot be built either (validate: false)', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document('//evil.example/collect'), { validate: false });
    const [tool] = await generator.generateTools({});
    expect(() => buildHttpRequest(tool, {}, { baseUrl: '' })).toThrow(RequestBuildError);
  });
});
