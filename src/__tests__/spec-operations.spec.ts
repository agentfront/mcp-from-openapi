/**
 * Tests for the spec layer's operation walker: where operations live in a
 * Path Item, how methods are named and sent, and what is ignored and why.
 */

import {
  FULL_OPERATION_LAYOUT,
  LEGACY_OPERATION_LAYOUT,
  REFUSED_METHODS,
  SPEC_DIAGNOSTIC_CODES,
  STANDARD_METHODS,
  getOperation,
  getSpecProfile,
  isHttpToken,
  isRefusedMethod,
  isSpecObject,
  isStandardMethod,
  jsonPointer,
  listOperations,
  ownProperty,
  toStandardMethod,
  wireMethod,
  type OperationLayout,
} from '../spec';

/* eslint-disable @typescript-eslint/no-explicit-any */

const op = (operationId: string): any => ({ operationId, responses: {} });
const methodsOf = (pathItem: unknown, layout?: OperationLayout): string[] =>
  listOperations(pathItem, { layout }).operations.map((entry) => entry.method);
const NOT_OBJECTS: unknown[] = [null, 'text', 0, 1, true, false, [], [{}]];

describe('STANDARD_METHODS', () => {
  it('keeps the historical eight in their order, then query', () => {
    expect(STANDARD_METHODS).toEqual(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'query']);
  });

  it('is frozen, like REFUSED_METHODS and the layouts', () => {
    expect(Object.isFrozen(STANDARD_METHODS)).toBe(true);
    expect(Object.isFrozen(REFUSED_METHODS)).toBe(true);
    expect(Object.isFrozen(FULL_OPERATION_LAYOUT)).toBe(true);
    expect(Object.isFrozen(LEGACY_OPERATION_LAYOUT)).toBe(true);
    expect(Object.isFrozen(LEGACY_OPERATION_LAYOUT.fixedMethods)).toBe(true);
    expect(REFUSED_METHODS).toEqual(['CONNECT']);
  });

  it('keeps the legacy layout to what the library read before OpenAPI 3.2: the eight historical methods', () => {
    expect(LEGACY_OPERATION_LAYOUT).toEqual({
      fixedMethods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'],
      additionalOperations: false,
    });
    for (const family of ['3.0', '3.1'] as const) {
      const profile = getSpecProfile(family);
      expect({ fixedMethods: profile.fixedMethods, additionalOperations: profile.additionalOperations }).toEqual(
        LEGACY_OPERATION_LAYOUT,
      );
    }
  });

  it('is the full layout, which is the OpenAPI 3.2 profile layout', () => {
    expect(FULL_OPERATION_LAYOUT).toEqual({ fixedMethods: STANDARD_METHODS, additionalOperations: true });
    const latest = getSpecProfile('3.2');
    expect({ fixedMethods: latest.fixedMethods, additionalOperations: latest.additionalOperations }).toEqual(
      FULL_OPERATION_LAYOUT,
    );
  });
});

describe('isSpecObject and ownProperty', () => {
  it.each([
    [{}, true],
    [Object.create(null), true],
    [[], false],
    [null, false],
    [undefined, false],
    ['x', false],
    [1, false],
  ])('isSpecObject(%p) is %p', (value, expected) => {
    expect(isSpecObject(value)).toBe(expected);
  });

  it('reads own properties only', () => {
    const inherited = Object.create({ get: op('inherited') });
    expect(ownProperty(inherited, 'get')).toBeUndefined();
    expect(ownProperty({ get: 1 }, 'get')).toBe(1);
    expect(ownProperty(['a'], '0')).toBe('a');
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'never resolves %s through the prototype',
    (key) => {
      expect(ownProperty({}, key)).toBeUndefined();
    },
  );

  it('reads an own __proto__ key created by JSON.parse', () => {
    expect(ownProperty(JSON.parse('{"__proto__": 7}'), '__proto__')).toBe(7);
  });

  it.each([null, undefined, 'get', 1, true])('reads nothing from the non-object %p', (value) => {
    expect(ownProperty(value, 'get')).toBeUndefined();
    expect(ownProperty(value, 'length')).toBeUndefined();
  });
});

describe('isHttpToken', () => {
  it.each(['GET', 'get', 'LINK', 'M-SEARCH', 'BREW', "!#$%&'*+-.^_`|~", '0', 'a1', 'constructor', '__proto__'])(
    'accepts %p',
    (value) => {
      expect(isHttpToken(value)).toBe(true);
    },
  );

  it.each([
    '',
    'LI NK',
    'GET\n',
    'GET\r\nX-Injected: 1',
    '\tGET',
    'a/b',
    'a"b',
    '{x}',
    'a:b',
    'a,b',
    'a;b',
    'a@b',
    'a(b)',
    'M\u00c9THODE',
    'GE\u0422', // Cyrillic Te
    'a\u0000b',
  ])('rejects %p', (value) => {
    expect(isHttpToken(value)).toBe(false);
  });

  it.each([1, null, undefined, {}, ['GET'], true])('rejects the non-string %p', (value) => {
    expect(isHttpToken(value)).toBe(false);
  });
});

describe('toStandardMethod and isStandardMethod', () => {
  it.each([
    ['get', 'get'],
    ['GET', 'get'],
    ['Get', 'get'],
    ['QUERY', 'query'],
    ['query', 'query'],
    ['Trace', 'trace'],
  ])('reads %p as %p', (method, expected) => {
    expect(toStandardMethod(method)).toBe(expected);
    expect(isStandardMethod(method)).toBe(true);
  });

  it.each(['LINK', 'connect', ' get', 'get ', 'gett', 'GE\u0422', '\uff27\uff25\uff34', '', 'constructor'])(
    'reads %p as no standard method',
    (method) => {
      expect(toStandardMethod(method)).toBeUndefined();
      expect(isStandardMethod(method)).toBe(false);
    },
  );

  it.each([1, null, undefined, {}, ['get']])('reads the non-string %p as no standard method', (method) => {
    expect(toStandardMethod(method)).toBeUndefined();
    expect(isStandardMethod(method)).toBe(false);
  });
});

describe('isRefusedMethod', () => {
  it.each(['CONNECT', 'connect', 'Connect', 'cOnNeCt'])('refuses %p', (method) => {
    expect(isRefusedMethod(method)).toBe(true);
  });

  it.each(['GET', 'CONNECTX', 'CONNEC', 'LINK', '', 1, null, undefined])('accepts %p', (method) => {
    expect(isRefusedMethod(method)).toBe(false);
  });
});

describe('wireMethod', () => {
  it.each([
    ['get', 'GET'],
    ['Get', 'GET'],
    ['POST', 'POST'],
    ['query', 'QUERY'],
    ['QUERY', 'QUERY'],
    ['LINK', 'LINK'],
    ['link', 'link'],
    ['Purge', 'Purge'],
    ['M-SEARCH', 'M-SEARCH'],
  ])('sends %p as %p', (method, expected) => {
    expect(wireMethod(method)).toBe(expected);
  });
});

describe('listOperations', () => {
  it('lists the fixed methods in STANDARD_METHODS order, whatever the key order', () => {
    const pathItem = {
      query: op('query'),
      trace: op('trace'),
      options: op('options'),
      head: op('head'),
      delete: op('delete'),
      patch: op('patch'),
      put: op('put'),
      post: op('post'),
      get: op('get'),
    };

    const result = listOperations(pathItem);

    expect(result.diagnostics).toEqual([]);
    expect(result.operations).toEqual(
      STANDARD_METHODS.map((method) => ({ method, operation: pathItem[method], source: 'fixed' })),
    );
  });

  it('returns the document objects, not copies', () => {
    const get = op('get');
    const link = op('link');

    const [fixed, additional] = listOperations({ get, additionalOperations: { LINK: link } }).operations;

    expect(fixed.operation).toBe(get);
    expect(additional.operation).toBe(link);
  });

  it('lists additionalOperations after the fixed methods, sorted by key in code-unit order', () => {
    const pathItem = {
      additionalOperations: {
        lock: op('lock'),
        UNLINK: op('unlink'),
        COPY: op('copy'),
        PURGE: op('purge'),
        LINK: op('link'),
        Lock: op('Lock'),
      },
      post: op('post'),
      get: op('get'),
    };

    const result = listOperations(pathItem);

    expect(result.diagnostics).toEqual([]);
    expect(result.operations.map(({ method, source }) => [method, source])).toEqual([
      ['get', 'fixed'],
      ['post', 'fixed'],
      ['COPY', 'additional'],
      ['LINK', 'additional'],
      ['Lock', 'additional'],
      ['PURGE', 'additional'],
      ['UNLINK', 'additional'],
      ['lock', 'additional'],
    ]);
    expect(result.operations[3].operation).toBe(pathItem.additionalOperations.LINK);
  });

  it('keeps an additional key exactly as written', () => {
    expect(methodsOf({ additionalOperations: { 'M-SEARCH': op('m'), purge: op('p') } })).toEqual(['M-SEARCH', 'purge']);
  });

  it('lists nothing, silently, for an empty or absent path item', () => {
    expect(listOperations({})).toEqual({ operations: [], diagnostics: [] });
    expect(listOperations(undefined)).toEqual({ operations: [], diagnostics: [] });
    expect(listOperations({ summary: 'x', parameters: [], servers: [], $ref: '#/x' })).toEqual({
      operations: [],
      diagnostics: [],
    });
  });

  it.each(NOT_OBJECTS)('reports the non-object path item %p', (pathItem) => {
    expect(listOperations(pathItem, { pointer: jsonPointer('paths', '/pets') })).toEqual({
      operations: [],
      diagnostics: [
        {
          severity: 'warning',
          code: SPEC_DIAGNOSTIC_CODES.PATH_ITEM_NOT_OBJECT,
          message: expect.stringMatching(/^A Path Item must be an object, found .+; it holds no operations$/),
          path: '/paths/~1pets',
        },
      ],
    });
  });

  it('skips an undefined fixed field silently', () => {
    expect(listOperations({ get: undefined, post: op('post') })).toEqual({
      operations: [{ method: 'post', operation: op('post'), source: 'fixed' }],
      diagnostics: [],
    });
  });

  it.each(NOT_OBJECTS)('ignores and reports the fixed field holding %p', (value) => {
    const result = listOperations({ get: value, post: op('post') }, { pointer: jsonPointer('paths', '/pets') });

    expect(result.operations.map((entry) => entry.method)).toEqual(['post']);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: SPEC_DIAGNOSTIC_CODES.OPERATION_NOT_OBJECT,
        message: expect.stringMatching(/^The `get` field must hold an Operation Object, found .+; it is ignored$/),
        path: '/paths/~1pets/get',
      },
    ]);
  });

  it('names the found value in the message without printing it', () => {
    const [first, second] = listOperations({ get: [{ secret: 1 }], put: 'x'.repeat(500) }).diagnostics;

    expect(first.message).toBe('The `get` field must hold an Operation Object, found an array; it is ignored');
    expect(second.message).toBe(
      `The \`put\` field must hold an Operation Object, found "${'x'.repeat(64)}..."; it is ignored`,
    );
  });

  it('reads own fields only: an inherited operation is not listed', () => {
    const pathItem = Object.create({ get: op('inherited'), additionalOperations: { LINK: op('inherited') } });
    pathItem.post = op('own');

    expect(methodsOf(pathItem)).toEqual(['post']);
  });

  it('reads JSON __proto__ and constructor keys as data, without touching any prototype', () => {
    const pathItem = JSON.parse(
      '{"__proto__": {"get": {"operationId": "polluted"}}, "additionalOperations": {"__proto__": {"operationId": "proto"}, "constructor": {"operationId": "ctor"}}}',
    );

    const result = listOperations(pathItem);

    expect(result.diagnostics).toEqual([]);
    expect(result.operations.map(({ method, operation }) => [method, operation.operationId])).toEqual([
      ['__proto__', 'proto'],
      ['constructor', 'ctor'],
    ]);
    expect(({} as any).get).toBeUndefined();
    expect(Object.getPrototypeOf(pathItem)).toBe(Object.prototype);
  });

  it('skips an absent additionalOperations silently', () => {
    expect(listOperations({ get: op('get'), additionalOperations: undefined }).diagnostics).toEqual([]);
  });

  it.each(NOT_OBJECTS)('ignores and reports additionalOperations holding %p', (value) => {
    const result = listOperations({ get: op('get'), additionalOperations: value }, { pointer: '/paths/~1pets' });

    expect(result.operations.map((entry) => entry.method)).toEqual(['get']);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: SPEC_DIAGNOSTIC_CODES.ADDITIONAL_OPERATIONS_NOT_OBJECT,
        message: expect.stringMatching(
          /^additionalOperations must be an object mapping methods to operations, found .+; it is ignored$/,
        ),
        path: '/paths/~1pets/additionalOperations',
      },
    ]);
  });

  it('skips an undefined additionalOperations entry silently', () => {
    expect(listOperations({ additionalOperations: { LINK: undefined, COPY: op('copy') } })).toEqual({
      operations: [{ method: 'COPY', operation: op('copy'), source: 'additional' }],
      diagnostics: [],
    });
  });

  it.each(NOT_OBJECTS)('ignores and reports the additional operation holding %p', (value) => {
    const result = listOperations({ additionalOperations: { LINK: value, COPY: op('copy') } }, { pointer: '/p' });

    expect(result.operations.map((entry) => entry.method)).toEqual(['COPY']);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: SPEC_DIAGNOSTIC_CODES.OPERATION_NOT_OBJECT,
        message: expect.stringMatching(
          /^additionalOperations key "LINK" must hold an Operation Object, found .+; it is ignored$/,
        ),
        path: '/p/additionalOperations/LINK',
      },
    ]);
  });

  it.each([
    ['', '/additionalOperations/'],
    ['LI NK', '/additionalOperations/LI NK'],
    ['LINK\r\nX-Injected: 1', '/additionalOperations/LINK\\u000d\\u000aX-Injected: 1'],
    ['\u001b[2J', '/additionalOperations/\\u001b[2J'],
    ['a/b', '/additionalOperations/a~1b'],
    ['a~b/c', '/additionalOperations/a~0b~1c'],
    ['M\u00c9THODE', '/additionalOperations/M\u00c9THODE'],
    ['GE\u0422', '/additionalOperations/GE\u0422'], // Cyrillic Te: not a token, so not a duplicate of GET either
  ])('ignores and reports the additional key %p, which is not an HTTP token', (key, path) => {
    const result = listOperations({ additionalOperations: { [key]: op('x'), COPY: op('copy') } });

    expect(result.operations.map((entry) => entry.method)).toEqual(['COPY']);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: SPEC_DIAGNOSTIC_CODES.INVALID_METHOD_TOKEN,
        message: `additionalOperations key ${JSON.stringify(key)} is not an HTTP method (RFC 9110 token); the operation is ignored`,
        path,
      },
    ]);
  });

  it('never puts raw control characters from a key into a message or a path', () => {
    const [diagnostic] = listOperations(
      { additionalOperations: { 'A\nB\u009b\u202e': op('x') } },
      { pointer: '/paths/~1x\u0007' },
    ).diagnostics;

    expect(diagnostic.message).toContain('"A\\nB\\u009b\\u202e"');
    expect(diagnostic.path).toBe('/paths/~1x\\u0007/additionalOperations/A\\u000aB\\u009b\\u202e');
    expect(`${diagnostic.message}${diagnostic.path}`).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
  });

  it('caps the path segment of a huge key', () => {
    const key = 'A'.repeat(100_000);
    const [diagnostic] = listOperations(
      { additionalOperations: { [key]: null } },
      { pointer: jsonPointer('paths', '/x') },
    ).diagnostics;

    expect(diagnostic.code).toBe(SPEC_DIAGNOSTIC_CODES.OPERATION_NOT_OBJECT);
    expect(diagnostic.path).toBe(`/paths/~1x/additionalOperations/${'A'.repeat(256)}...(truncated)`);
    expect(diagnostic.message.length).toBeLessThan(200);
  });

  it.each(['CONNECT', 'connect', 'Connect'])('refuses and reports the additional key %p', (key) => {
    const result = listOperations({ additionalOperations: { [key]: op('tunnel'), COPY: op('copy') } });

    expect(result.operations.map((entry) => entry.method)).toEqual(['COPY']);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: SPEC_DIAGNOSTIC_CODES.REFUSED_METHOD,
        message: `additionalOperations key "${key}" names CONNECT, which opens a tunnel rather than sending a request; the operation is ignored`,
        path: `/additionalOperations/${key}`,
      },
    ]);
  });

  it.each([
    ['GET', 'get'],
    ['POST', 'post'],
    ['PUT', 'put'],
    ['PATCH', 'patch'],
    ['DELETE', 'delete'],
    ['HEAD', 'head'],
    ['OPTIONS', 'options'],
    ['TRACE', 'trace'],
    ['QUERY', 'query'],
  ])('ignores and reports the additional key %p, forbidden next to the %p field', (key, field) => {
    const fixed = op('fixed');
    const result = listOperations({ [field]: fixed, additionalOperations: { [key]: op('duplicate') } });

    expect(result.operations).toEqual([{ method: field, operation: fixed, source: 'fixed' }]);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: SPEC_DIAGNOSTIC_CODES.DUPLICATE_FIXED_METHOD,
        message: `additionalOperations key "${key}" is the method of the fixed \`${field}\` field, which the specification forbids; the operation is ignored`,
        path: `/additionalOperations/${key}`,
      },
    ]);
  });

  it.each([
    ['get', 'get', 'GET'],
    ['Get', 'get', 'GET'],
    ['post', 'post', 'POST'],
    ['Post', 'post', 'POST'],
    ['query', 'query', 'QUERY'],
    ['Query', 'query', 'QUERY'],
    ['tRACE', 'trace', 'TRACE'],
  ])('ignores and reports the additional key %p, a case variant of the %p method', (key, field, wire) => {
    const fixed = op('fixed');
    const result = listOperations({ [field]: fixed, additionalOperations: { [key]: op('variant') } });

    expect(result.operations).toEqual([{ method: field, operation: fixed, source: 'fixed' }]);
    expect(result.diagnostics).toEqual([
      {
        severity: 'warning',
        code: SPEC_DIAGNOSTIC_CODES.METHOD_CASE_VARIANT,
        message: `additionalOperations key "${key}" differs from ${wire} only in letter case; this library sends every case of a standard method as ${wire} (the \`${field}\` field), so the operation is ignored`,
        path: `/additionalOperations/${key}`,
      },
    ]);
  });

  it('ignores a standard method in additionalOperations even when the fixed field is absent', () => {
    const result = listOperations({ additionalOperations: { GET: op('only-here'), post: op('only-here') } });

    expect(result.operations).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      SPEC_DIAGNOSTIC_CODES.DUPLICATE_FIXED_METHOD,
      SPEC_DIAGNOSTIC_CODES.METHOD_CASE_VARIANT,
    ]);
  });

  it('reports one diagnostic per ignored entry, the first problem found', () => {
    // Invalid token before refused before duplicate or case variant before non-object
    const result = listOperations({
      additionalOperations: { 'G ET': null, CONNECT: null, GET: null, post: null, LINK: null },
    });

    expect(result.diagnostics.map((diagnostic) => [diagnostic.path, diagnostic.code])).toEqual([
      ['/additionalOperations/G ET', SPEC_DIAGNOSTIC_CODES.INVALID_METHOD_TOKEN],
      ['/additionalOperations/CONNECT', SPEC_DIAGNOSTIC_CODES.REFUSED_METHOD],
      ['/additionalOperations/GET', SPEC_DIAGNOSTIC_CODES.DUPLICATE_FIXED_METHOD],
      ['/additionalOperations/post', SPEC_DIAGNOSTIC_CODES.METHOD_CASE_VARIANT],
      ['/additionalOperations/LINK', SPEC_DIAGNOSTIC_CODES.OPERATION_NOT_OBJECT],
    ]);
  });

  it('prefixes diagnostic paths with the given pointer, or none by default', () => {
    const pathItem = { get: null, additionalOperations: { 'a/b': op('x') } };

    expect(listOperations(pathItem).diagnostics.map((d) => d.path)).toEqual(['/get', '/additionalOperations/a~1b']);
    expect(
      listOperations(pathItem, { pointer: jsonPointer('paths', '/pets/{id}') }).diagnostics.map((d) => d.path),
    ).toEqual(['/paths/~1pets~1{id}/get', '/paths/~1pets~1{id}/additionalOperations/a~1b']);
  });

  it('reads neither query nor additionalOperations under the legacy layout', () => {
    const pathItem = {
      get: op('get'),
      query: op('query'),
      additionalOperations: { LINK: op('link'), 'BAD KEY': null },
    };

    expect(listOperations(pathItem, { layout: LEGACY_OPERATION_LAYOUT })).toEqual({
      operations: [{ method: 'get', operation: op('get'), source: 'fixed' }],
      diagnostics: [],
    });
  });

  it('reads only the fields of the given layout, so a 3.0 profile sees neither query nor additionalOperations', () => {
    const pathItem = {
      get: op('get'),
      query: op('query'),
      additionalOperations: { LINK: op('link'), 'BAD KEY': op('bad') },
    };

    expect(listOperations(pathItem, { layout: getSpecProfile('3.0') })).toEqual({
      operations: [{ method: 'get', operation: op('get'), source: 'fixed' }],
      diagnostics: [],
    });
    expect(methodsOf(pathItem, getSpecProfile('3.2'))).toEqual(['get', 'query', 'LINK']);
  });

  it('serves a Swagger 2.0 style layout: fixed fields without trace, query or additionalOperations', () => {
    const layout: OperationLayout = {
      fixedMethods: ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'],
      additionalOperations: false,
    };
    const pathItem = { trace: op('trace'), patch: op('patch'), get: op('get'), query: op('query') };

    expect(methodsOf(pathItem, layout)).toEqual(['get', 'patch']);
  });

  it('keeps STANDARD_METHODS order whatever the order of the layout list', () => {
    const layout: OperationLayout = { fixedMethods: ['trace', 'get', 'post'], additionalOperations: false };

    expect(methodsOf({ get: op('g'), post: op('p'), trace: op('t') }, layout)).toEqual(['get', 'post', 'trace']);
  });

  it('lists a large additionalOperations map in sorted order', () => {
    const additionalOperations: Record<string, unknown> = {};
    for (let index = 9999; index >= 0; index--) additionalOperations[`M${index}`] = op(`m${index}`);

    const methods = methodsOf({ additionalOperations });

    expect(methods).toHaveLength(10000);
    expect(methods).toEqual([...methods].sort());
  });
});

describe('getOperation', () => {
  const get = op('get');
  const query = op('query');
  const link = op('LINK');
  const lowerLink = op('link');
  const copy = op('COPY');
  const pathItem = {
    get,
    query,
    post: null,
    additionalOperations: {
      LINK: link,
      link: lowerLink,
      COPY: copy,
      'BAD KEY': op('bad'),
      CONNECT: op('tunnel'),
      GET: op('duplicate'),
      Post: op('variant'),
      NULL: null,
    },
  };

  it.each(['get', 'GET', 'Get'])('finds the fixed get field for %p', (method) => {
    expect(getOperation(pathItem, method)).toEqual({ method: 'get', operation: get, source: 'fixed' });
    expect(getOperation(pathItem, method)?.operation).toBe(get);
  });

  it.each(['query', 'QUERY'])('finds the fixed query field for %p', (method) => {
    expect(getOperation(pathItem, method)).toEqual({ method: 'query', operation: query, source: 'fixed' });
  });

  it.each(['put', 'post'])('finds nothing for the absent or non-object fixed field %p', (method) => {
    expect(getOperation(pathItem, method)).toBeUndefined();
  });

  it('never looks up a standard method in additionalOperations', () => {
    expect(getOperation(pathItem, 'Post')).toBeUndefined();
    expect(getOperation({ additionalOperations: { GET: op('dup'), Post: op('dup') } }, 'GET')).toBeUndefined();
    expect(getOperation({ additionalOperations: { GET: op('dup'), Post: op('dup') } }, 'Post')).toBeUndefined();
  });

  it('finds an additional operation by its exact key only', () => {
    expect(getOperation(pathItem, 'LINK')).toEqual({ method: 'LINK', operation: link, source: 'additional' });
    expect(getOperation(pathItem, 'link')).toEqual({ method: 'link', operation: lowerLink, source: 'additional' });
    expect(getOperation(pathItem, 'COPY')).toEqual({ method: 'COPY', operation: copy, source: 'additional' });
    expect(getOperation(pathItem, 'copy')).toBeUndefined();
    expect(getOperation(pathItem, 'Link')).toBeUndefined();
  });

  it.each(['BAD KEY', 'CONNECT', 'connect', 'NULL', 'PURGE'])(
    'finds nothing for the unusable or absent key %p',
    (method) => {
      expect(getOperation(pathItem, method)).toBeUndefined();
    },
  );

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__'])(
    'never resolves %s through a prototype',
    (method) => {
      expect(getOperation({}, method)).toBeUndefined();
      expect(getOperation({ additionalOperations: {} }, method)).toBeUndefined();
      expect(getOperation(pathItem, method)).toBeUndefined();
    },
  );

  it('does not read a differently cased own key, nor a prototype member, for constructor', () => {
    const item = { additionalOperations: { CONSTRUCTOR: op('upper') } };

    expect(getOperation(item, 'constructor')).toBeUndefined();
    expect(getOperation(item, '__proto__')).toBeUndefined();
    expect(getOperation(item, 'CONSTRUCTOR')).toEqual({
      method: 'CONSTRUCTOR',
      operation: op('upper'),
      source: 'additional',
    });
  });

  it('finds an own JSON constructor or __proto__ key as an additional operation', () => {
    const item = JSON.parse(
      '{"additionalOperations": {"constructor": {"operationId": "ctor"}, "__proto__": {"operationId": "proto"}}}',
    );

    expect(getOperation(item, 'constructor')).toEqual({
      method: 'constructor',
      operation: { operationId: 'ctor' },
      source: 'additional',
    });
    expect(getOperation(item, '__proto__')?.operation).toEqual({ operationId: 'proto' });
  });

  it.each([...NOT_OBJECTS, undefined])('finds nothing when additionalOperations holds %p', (value) => {
    expect(getOperation({ additionalOperations: value }, 'LINK')).toBeUndefined();
    expect(getOperation({ additionalOperations: value }, '0')).toBeUndefined();
  });

  it.each([...NOT_OBJECTS, undefined])('finds nothing in the non-object path item %p', (value) => {
    expect(getOperation(value, 'get')).toBeUndefined();
    expect(getOperation(value, 'LINK')).toBeUndefined();
  });

  it.each([1, null, undefined, {}])('finds nothing for the non-string method %p', (method) => {
    expect(getOperation(pathItem, method as any)).toBeUndefined();
  });

  it('reads only the fields of the given layout', () => {
    for (const layout of [getSpecProfile('3.1'), LEGACY_OPERATION_LAYOUT]) {
      expect(getOperation(pathItem, 'get', { layout })?.operation).toBe(get);
      expect(getOperation(pathItem, 'query', { layout })).toBeUndefined();
      expect(getOperation(pathItem, 'LINK', { layout })).toBeUndefined();
    }
  });

  it('finds exactly what listOperations lists', () => {
    const { operations } = listOperations(pathItem);

    expect(operations.map((entry) => entry.method)).toEqual(['get', 'query', 'COPY', 'LINK', 'link']);
    for (const entry of operations) {
      expect(getOperation(pathItem, entry.method)).toEqual(entry);
    }
  });

  it('looks up each of 20,000 additional operations in constant time', () => {
    const additionalOperations: Record<string, unknown> = {};
    for (let index = 0; index < 20_000; index++) additionalOperations[`M${index}`] = op(`m${index}`);
    const item = { get: op('get'), additionalOperations };
    const started = Date.now();

    const { operations, diagnostics } = listOperations(item);
    let found = 0;
    for (const entry of operations) {
      if (getOperation(item, entry.method)?.operation === entry.operation) found++;
    }

    expect(diagnostics).toEqual([]);
    expect(operations).toHaveLength(20_001);
    expect(found).toBe(20_001);
    // Backstop only: the quadratic lookup this replaces took minutes here
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});
