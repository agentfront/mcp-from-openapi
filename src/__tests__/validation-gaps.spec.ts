import { OpenAPIToolGenerator } from '../generator';
import { describeValue } from 'openapi-spec';
import { isReferenceObject } from '../types';
import { messageText } from '../validator';

const ok = { 200: { description: 'ok' } };

type Fields = {
  root?: Record<string, unknown>;
  pathItem?: Record<string, unknown>;
  operation?: Record<string, unknown>;
};

function documentWith({ root = {}, pathItem = {}, operation = {} }: Fields): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://api.example.test' }],
    paths: { '/p': { ...pathItem, get: { operationId: 'p', responses: ok, ...operation } } },
    ...root,
  };
}

async function errorsOf(document: Record<string, unknown>) {
  const result = await (await OpenAPIToolGenerator.fromJSON(document)).validate();
  return (result.errors ?? []).map((error) => [error.code, error.path]);
}

describe('only a string $ref makes a Reference Object', () => {
  it('reads an object whose $ref is not a string as what it is', () => {
    expect(isReferenceObject({ $ref: '#/a' })).toBe(true);
    for (const ref of [5, true, null, {}]) expect(isReferenceObject({ $ref: ref })).toBe(false);
  });

  it.each([5, null, { toString: 1 }])('validates a parameter whose $ref is %p, and never throws', async (ref) => {
    const document = documentWith({
      operation: { parameters: [{ $ref: ref, name: 'X-A', in: 'nowhere', schema: { type: 'string' } }] },
    });
    expect(await errorsOf(document)).toEqual([
      ['INVALID_PARAMETER', '/paths/~1p/get/parameters/0/$ref'],
      ['INVALID_PARAMETER_IN', '/paths//p/get/parameters/0/in'],
    ]);
  });

  it('still finds a missing path parameter next to a parameter with a non-string $ref', async () => {
    const document = {
      ...documentWith({}),
      paths: {
        '/a/{id}': {
          get: { operationId: 'a', parameters: [{ $ref: 5, name: 'q', in: 'query', schema: {} }], responses: ok },
        },
      },
    };
    expect((await errorsOf(document)).map(([code]) => code)).toContain('MISSING_PATH_PARAMETER');
  });
});

describe('the validator checks the types generation reads', () => {
  it.each<[string, Fields, string]>([
    ['operation parameters', { operation: { parameters: {} } }, '/paths/~1p/get/parameters'],
    ['path item parameters', { pathItem: { parameters: {} } }, '/paths/~1p/parameters'],
    ['an object operationId', { operation: { operationId: {} } }, '/paths/~1p/get/operationId'],
    ['a number operationId', { operation: { operationId: 5 } }, '/paths/~1p/get/operationId'],
    ['root servers', { root: { servers: 'https://x' } }, '/servers'],
    ['a server', { root: { servers: [null] } }, '/servers/0'],
    ['a server url', { root: { servers: [{ url: 5 }] } }, '/servers/0/url'],
    ['operation servers', { operation: { servers: [null] } }, '/paths/~1p/get/servers/0'],
    ['path item servers', { pathItem: { servers: 'x' } }, '/paths/~1p/servers'],
    ['operation security', { operation: { security: 'x' } }, '/paths/~1p/get/security'],
    ['a security requirement', { root: { security: [5] } }, '/security/0'],
    ['responses', { operation: { responses: 'x' } }, '/paths/~1p/get/responses'],
    ['a response', { operation: { responses: { 200: null } } }, '/paths/~1p/get/responses/200'],
    ['deprecated', { operation: { deprecated: 'false' } }, '/paths/~1p/get/deprecated'],
    ['info.title', { root: { info: { title: {}, version: '1' } } }, '/info/title'],
    ['info.version', { root: { info: { title: 't', version: [] } } }, '/info/version'],
  ])('%s', async (_label, fields, path) => {
    expect(await errorsOf(documentWith(fields))).toEqual([['INVALID_FIELD_TYPE', path]]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['required', { required: 'no' }, 'required'],
    ['description', { description: {} }, 'description'],
    ['schema', { schema: 'abc' }, 'schema'],
  ])('a parameter %s', async (_label, fields, field) => {
    const parameter = { name: 'q', in: 'query', schema: { type: 'string' }, ...fields };
    expect(await errorsOf(documentWith({ operation: { parameters: [parameter] } }))).toEqual([
      ['INVALID_FIELD_TYPE', `/paths/~1p/get/parameters/0/${field}`],
    ]);
  });

  it('accepts a response extension of any value', async () => {
    expect(await errorsOf(documentWith({ operation: { responses: { ...ok, 'x-note': null } } }))).toEqual([]);
  });

  it.each(['header', 'cookie'])('refuses a %s parameter name that is not an HTTP token', async (location) => {
    const parameter = { name: 'X-A\r\nX-Injected: 1', in: location, schema: { type: 'string' } };
    expect(await errorsOf(documentWith({ operation: { parameters: [parameter] } }))).toEqual([
      ['INVALID_PARAMETER_NAME', '/paths/~1p/get/parameters/0/name'],
    ]);
  });
});

describe('invisible and bidirectional characters are escaped in messages', () => {
  it.each(['؜', '​', '‍', '⁠', '﻿'])('escapes U+%s', (character) => {
    const code = `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    expect(messageText(`a${character}b`)).toBe(`a${code}b`);
    expect(describeValue(`a${character}b`)).toBe(`"a${code}b"`);
  });
});
