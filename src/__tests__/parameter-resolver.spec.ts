/**
 * ParameterResolver: parameter `content`, OpenAPI 3.2 whole-query
 * parameters, path-level/operation-level merging, and Example Object
 * `dataValue` (issue #55). The older resolver behaviour is covered in
 * generator.spec.ts ('ParameterResolver').
 */
import {
  ParameterResolver,
  analyzeParameters,
  collectExampleValues,
  describeContentWithoutSchema,
  isJsonMediaType,
  readParameterContent,
  selectRequestMediaType,
} from '../parameter-resolver';
import { GenerationError } from '../errors';

const resolve = (operation: Record<string, unknown>, pathParameters?: unknown[], options = {}) =>
  new ParameterResolver(undefined, options).resolve(operation, pathParameters as any);

describe('selectRequestMediaType', () => {
  it('prefers the request media types in order, else takes the first key', () => {
    expect(selectRequestMediaType({ 'text/plain': {}, 'application/xml': {} })).toBe('application/xml');
    expect(selectRequestMediaType({ 'multipart/form-data': {}, 'application/x-www-form-urlencoded': {} })).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(selectRequestMediaType({ 'text/csv': {}, 'application/yaml': {} })).toBe('text/csv');
    // a preferred key without a value is passed over, as for request bodies
    expect(selectRequestMediaType({ 'text/csv': {}, 'application/json': null })).toBe('text/csv');
    expect(selectRequestMediaType({})).toBeUndefined();
  });
});

describe('isJsonMediaType', () => {
  it('recognises application/json and application/*+json, ignoring parameters and case', () => {
    for (const mediaType of ['application/json', 'APPLICATION/JSON; charset=utf-8', 'application/vnd.api+json']) {
      expect(isJsonMediaType(mediaType)).toBe(true);
    }
    for (const mediaType of [
      'text/json',
      'text/foo+json',
      'application/jsonl',
      'application/json-seq',
      'application/x-ndjson',
      'text/plain',
      'json',
      '',
    ]) {
      expect([mediaType, isJsonMediaType(mediaType)]).toEqual([mediaType, false]);
    }
  });
});

/**
 * What a `content` parameter without a schema is, by the media type's class:
 * the same classification `buildHttpRequest` serializes by (request-builder
 * spec, 'one media-type classification ...').
 */
const SCHEMA_WITHOUT_MEDIA_SCHEMA = [
  ['application/json', {}, 'the value is unconstrained'],
  ['application/json; charset=utf-8', {}, 'the value is unconstrained'],
  ['Application/JSON', {}, 'the value is unconstrained'],
  ['application/problem+json', {}, 'the value is unconstrained'],
  ['text/json', { type: 'string' }, 'the value is read as a string'],
  ['application/x-www-form-urlencoded', { type: 'object' }, 'the value is read as an object'],
  ['application/x-www-form-urlencoded; charset=utf-8', { type: 'object' }, 'the value is read as an object'],
  ['text/plain', { type: 'string' }, 'the value is read as a string'],
  ['application/xml', { type: 'string' }, 'the value is read as a string'],
  ['', { type: 'string' }, 'the value is read as a string'],
] as const;

describe('describeContentWithoutSchema', () => {
  it.each(SCHEMA_WITHOUT_MEDIA_SCHEMA)('says what %j becomes without a schema', (mediaType, _schema, reading) => {
    expect(describeContentWithoutSchema(mediaType)).toBe(reading);
  });

  it('reads a value that is not a string as a string', () => {
    expect(describeContentWithoutSchema(42 as any)).toBe('the value is read as a string');
    expect(isJsonMediaType(undefined as any)).toBe(false);
  });
});

describe('readParameterContent', () => {
  it('tells absent, invalid and empty content apart from a media type', () => {
    expect(readParameterContent({ name: 'a' })).toEqual({ kind: 'absent' });
    expect(readParameterContent({ content: null })).toEqual({ kind: 'absent' });
    expect(readParameterContent({ content: 'application/json' })).toEqual({ kind: 'invalid', value: 'application/json' });
    expect(readParameterContent({ content: [] })).toEqual({ kind: 'invalid', value: [] });
    expect(readParameterContent({ content: {} })).toEqual({ kind: 'empty' });
    expect(readParameterContent(null)).toEqual({ kind: 'absent' });
  });

  it('reads the only media type, or picks one of several by preference', () => {
    const media = { schema: { type: 'object' } };
    expect(readParameterContent({ content: { 'application/json': media } })).toEqual({
      kind: 'media',
      mediaType: 'application/json',
      media,
      count: 1,
    });
    expect(readParameterContent({ content: { 'text/csv': {}, 'text/plain': media, 'a/b': {} } })).toEqual({
      kind: 'media',
      mediaType: 'text/plain',
      media,
      count: 3,
    });
    // a media type that is not an object has no Media Type Object
    expect(readParameterContent({ content: { 'text/csv': 'x' } })).toEqual({
      kind: 'media',
      mediaType: 'text/csv',
      media: undefined,
      count: 1,
    });
  });

  it('reads own properties only', () => {
    const inherited = Object.create({ content: { 'application/json': {} } });
    expect(readParameterContent(inherited)).toEqual({ kind: 'absent' });
    const content = Object.create({ 'application/json': { schema: {} } });
    content['text/plain'] = {};
    expect(readParameterContent({ content })).toMatchObject({ mediaType: 'text/plain', count: 1 });
  });
});

describe('analyzeParameters', () => {
  const p = (name: unknown, location: unknown, extra: Record<string, unknown> = {}) => ({ name, in: location, ...extra });
  const shape = (analysis: ReturnType<typeof analyzeParameters>) =>
    analysis.effective.map((slot) => `${slot.level}:${slot.index}`);

  it('lets an operation parameter override the path-level one with the same name and location', () => {
    const analysis = analyzeParameters(
      [p('id', 'path'), p('limit', 'query'), p('limit', 'header')],
      [p('limit', 'query', { schema: { type: 'integer' } }), p('q', 'query')],
    );
    expect(shape(analysis)).toEqual(['path:0', 'path:2', 'operation:0', 'operation:1']);
    expect(analysis.duplicates).toEqual([]);
    expect(analysis.querystring).toBeUndefined();
  });

  it('keeps the last of several in one list, reporting each one dropped against the one kept', () => {
    const analysis = analyzeParameters(
      [p('a', 'query'), p('a', 'query'), p('b', 'query')],
      [p('a', 'query'), p('c', 'query'), p('c', 'query'), p('c', 'query')],
    );
    expect(shape(analysis)).toEqual(['path:2', 'operation:0', 'operation:3']);
    expect(
      analysis.duplicates.map(({ dropped, kept }) => [`${dropped.level}:${dropped.index}`, `${kept.level}:${kept.index}`]),
    ).toEqual([
      ['path:0', 'path:1'],
      ['operation:1', 'operation:3'],
      ['operation:2', 'operation:3'],
    ]);
  });

  it('never merges an entry without a string name and location, keeping it in place', () => {
    const ref = { $ref: '#/components/parameters/P' };
    const analysis = analyzeParameters(
      [ref, null, 'x', p(5, 'query'), p('a', undefined)],
      [ref, null, p(5, 'query'), p('a', undefined)],
    );
    expect(shape(analysis)).toEqual([
      'path:0',
      'path:1',
      'path:2',
      'path:3',
      'path:4',
      'operation:0',
      'operation:1',
      'operation:2',
      'operation:3',
    ]);
    expect(analysis.duplicates).toEqual([]);
  });

  it('matches header names in any case, for overrides and duplicates, and other names exactly', () => {
    const analysis = analyzeParameters(
      [p('X-Id', 'header'), p('id', 'query'), p('Trace', 'cookie')],
      [p('x-id', 'header'), p('ID', 'query'), p('trace', 'cookie'), p('X-A', 'header'), p('x-a', 'header')],
    );
    expect(shape(analysis)).toEqual([
      'path:1',
      'path:2',
      'operation:0',
      'operation:1',
      'operation:2',
      'operation:4',
    ]);
    expect(analysis.duplicates.map(({ dropped, kept }) => [dropped.index, kept.index])).toEqual([[3, 4]]);
  });

  it('keys by name and location with no prototype lookups', () => {
    const analysis = analyzeParameters(
      [p('__proto__', 'query'), p('constructor', 'query'), p('toString', 'header')],
      [p('__proto__', 'query'), p('constructor', 'query', { x: 1 }), p('hasOwnProperty', 'query')],
    );
    expect(shape(analysis)).toEqual(['path:2', 'operation:0', 'operation:1', 'operation:2']);
    expect(Object.prototype).not.toHaveProperty('x');
  });

  it('stays linear on thousands of parameters with long names', () => {
    // Keys of one long length would share a hash bucket; the bounded key spreads them
    const long = 'n'.repeat(1_000);
    const many = Array.from({ length: 3_000 }, (_, i) => p(`${long}${String(i).padStart(5, '0')}`, 'query'));
    const started = Date.now();
    const analysis = analyzeParameters(many, many);
    expect(analysis.effective).toHaveLength(3_000);
    expect(analysis.effective.every((slot) => slot.level === 'operation')).toBe(true);
    // generous: instrumented for coverage it takes about a second
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  describe('querystring rules', () => {
    const qs = (name: string, extra: Record<string, unknown> = { content: { 'application/json': {} } }) =>
      p(name, 'querystring', extra);

    it('accepts one querystring parameter, the operation overriding a path-level one', () => {
      expect(analyzeParameters([qs('q')], [qs('q')]).querystring).toBeUndefined();
      expect(analyzeParameters([qs('q'), p('h', 'header')], []).querystring).toBeUndefined();
    });

    it('reports more than one, across levels', () => {
      expect(analyzeParameters([qs('q')], [qs('r')]).querystring).toEqual({
        code: 'MULTIPLE_QUERYSTRING_PARAMETERS',
        slot: { parameter: qs('r'), level: 'operation', index: 0 },
        querystrings: 2,
      });
    });

    it('reports a querystring parameter with query parameters, path-level ones included', () => {
      expect(analyzeParameters([p('limit', 'query')], [qs('q')]).querystring).toMatchObject({
        code: 'QUERYSTRING_WITH_QUERY_PARAMETERS',
        slot: { level: 'operation', index: 0 },
        querystrings: 1,
      });
    });

    it('reports a querystring parameter without a media type', () => {
      for (const extra of [{}, { content: {} }, { content: 'x' }, { schema: { type: 'string' } }]) {
        expect(analyzeParameters([], [qs('q', extra)]).querystring).toMatchObject({
          code: 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT',
          slot: { index: 0 },
        });
      }
    });
  });
});

describe('ParameterResolver: parameters defined with content', () => {
  const filterSchema = { type: 'object', properties: { status: { type: 'string' } } };

  it('takes the input schema from the media type and maps the value without style', () => {
    const { inputSchema, mapper } = resolve({
      parameters: [
        {
          name: 'filter',
          in: 'query',
          description: 'A filter',
          deprecated: true,
          content: { 'application/json': { schema: filterSchema } },
        },
      ],
    });
    expect(inputSchema).toEqual({
      type: 'object',
      properties: {
        filter: {
          ...filterSchema,
          description: 'A filter',
          deprecated: true,
          'x-parameter-location': 'query',
          'x-parameter-content-type': 'application/json',
        },
      },
      additionalProperties: false,
    });
    expect(mapper).toEqual([
      {
        inputKey: 'filter',
        type: 'query',
        key: 'filter',
        required: false,
        serialization: { contentType: 'application/json' },
      },
    ]);
    // the keys are absent, not undefined
    expect(Object.keys(mapper[0])).toEqual(['inputKey', 'type', 'key', 'required', 'serialization']);
  });

  it('works in every location, header names and path requiredness included', () => {
    const json = { 'application/json': { schema: { type: 'array', items: { type: 'integer' } } } };
    const { inputSchema, mapper } = resolve({
      parameters: [
        { name: 'ids', in: 'path', content: json },
        { name: 'X-Filter', in: 'header', required: true, content: json },
        { name: 'prefs', in: 'cookie', content: json },
      ],
    });
    expect(inputSchema.required).toEqual(['ids', 'X-Filter']);
    expect((inputSchema.properties as any)['X-Filter']).toEqual({
      type: 'array',
      items: { type: 'integer' },
      'x-parameter-location': 'header',
      'x-mcp-header': 'X-Filter',
      'x-parameter-content-type': 'application/json',
    });
    expect(mapper.map((m) => [m.type, m.required, m.serialization?.contentType])).toEqual([
      ['path', true, 'application/json'],
      ['header', true, 'application/json'],
      ['cookie', false, 'application/json'],
    ]);
  });

  it('reads a value without a media schema as unconstrained for JSON, an object for a form, a string otherwise', () => {
    const shapes = [{}, 'junk', null, { itemSchema: { type: 'string' } }, { schema: null }, { $ref: '#/m' }];
    for (const [mediaType, expected] of [
      ['text/plain', { type: 'string' }],
      ['application/x-www-form-urlencoded', { type: 'object' }],
      ['application/json', {}],
      ['application/problem+json; charset=utf-8', {}],
      ['Application/JSON', {}],
    ] as const) {
      const { inputSchema } = resolve({
        parameters: shapes.map((media, i) => ({ name: `p${i}`, in: 'query', content: { [mediaType]: media } })),
      });
      for (let i = 0; i < shapes.length; i++) {
        expect((inputSchema.properties as any)[`p${i}`]).toEqual({
          ...expected,
          'x-parameter-location': 'query',
          'x-parameter-content-type': mediaType,
        });
      }
    }
  });

  describe('one media-type classification for a content parameter without a schema', () => {
    it.each(SCHEMA_WITHOUT_MEDIA_SCHEMA)('gives %j the input schema %j', (mediaType, expected) => {
      const { inputSchema, mapper } = resolve({
        parameters: [
          { name: 'q', in: 'query', content: { [mediaType]: {} } },
          { name: 'x-h', in: 'header', content: { [mediaType]: {} } },
          { name: 'c', in: 'cookie', content: { [mediaType]: {} } },
          { name: 'id', in: 'path', required: true, content: { [mediaType]: {} } },
        ],
      });

      for (const [name, location] of [
        ['q', 'query'],
        ['x-h', 'header'],
        ['c', 'cookie'],
        ['id', 'path'],
      ]) {
        expect((inputSchema.properties as any)[name]).toEqual({
          ...expected,
          'x-parameter-location': location,
          'x-parameter-content-type': mediaType,
          ...(location === 'header' && { 'x-mcp-header': 'x-h' }),
        });
      }
      expect(mapper.map((entry) => entry.serialization?.contentType)).toEqual([mediaType, mediaType, mediaType, mediaType]);
    });

    it.each(SCHEMA_WITHOUT_MEDIA_SCHEMA)('gives a whole query of %j the input schema %j', (mediaType, expected) => {
      const { inputSchema, mapper } = resolve({
        parameters: [{ name: 'search', in: 'querystring', content: { [mediaType]: {} } }],
      });

      expect((inputSchema.properties as any).search).toEqual({
        ...expected,
        'x-parameter-location': 'query',
        'x-parameter-whole-query': true,
        'x-parameter-content-type': mediaType,
      });
      expect(mapper[0]).toMatchObject({ wholeQuery: true, serialization: { contentType: mediaType } });
    });

    it('gives each parameter its own schema object, never one shared between parameters', () => {
      const { inputSchema } = resolve({
        parameters: [
          { name: 'a', in: 'query', content: { 'application/x-www-form-urlencoded': {} } },
          { name: 'b', in: 'query', content: { 'application/x-www-form-urlencoded': {} } },
        ],
      });
      const properties = inputSchema.properties as any;

      expect(properties.a).not.toBe(properties.b);
      properties.a.properties = { changed: true };
      expect(properties.b.properties).toBeUndefined();
    });

    it('keeps the schema of the media type when it has one, whatever its class', () => {
      for (const mediaType of ['application/json', 'application/x-www-form-urlencoded', 'text/json', 'text/plain']) {
        const { inputSchema } = resolve({
          parameters: [{ name: 'q', in: 'query', content: { [mediaType]: { schema: { type: 'integer' } } } }],
        });

        expect((inputSchema.properties as any).q.type).toBe('integer');
      }
    });
  });

  it('accepts a boolean schema in the media type', () => {
    const { inputSchema } = resolve({ parameters: [{ name: 'a', in: 'query', content: { 'application/json': { schema: true } } }] });
    expect((inputSchema.properties as any).a).toEqual({ 'x-parameter-location': 'query', 'x-parameter-content-type': 'application/json' });
    // `false` accepts no value
    const never = resolve({ parameters: [{ name: 'a', in: 'query', content: { 'application/json': { schema: false } } }] });
    expect((never.inputSchema.properties as any).a).toEqual({
      not: {},
      'x-parameter-location': 'query',
      'x-parameter-content-type': 'application/json',
    });
  });

  it('carries the media type encoding when it is a non-empty map', () => {
    const encoding = { tags: { style: 'form', explode: true } };
    const form = (value: unknown) => ({
      'application/x-www-form-urlencoded': { schema: { type: 'object' }, encoding: value },
    });
    const { mapper } = resolve({
      parameters: [
        { name: 'a', in: 'query', content: form(encoding) },
        { name: 'b', in: 'query', content: form({}) },
        { name: 'c', in: 'query', content: form('x') },
        { name: 'd', in: 'query', content: form(['x']) },
      ],
    });
    expect(mapper.map((m) => m.serialization)).toEqual([
      { contentType: 'application/x-www-form-urlencoded', encoding },
      { contentType: 'application/x-www-form-urlencoded' },
      { contentType: 'application/x-www-form-urlencoded' },
      { contentType: 'application/x-www-form-urlencoded' },
    ]);
  });

  it('reads one of several media types by preference', () => {
    const { mapper, inputSchema } = resolve({
      parameters: [
        { name: 'a', in: 'query', content: { 'text/plain': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object' } } } },
      ],
    });
    expect(mapper[0].serialization).toEqual({ contentType: 'application/json' });
    expect((inputSchema.properties as any).a.type).toBe('object');
  });

  it('keeps reading schema, with its style, when a parameter has both', () => {
    const { inputSchema, mapper } = resolve({
      parameters: [
        {
          name: 'a',
          in: 'query',
          style: 'form',
          explode: false,
          schema: { type: 'array', items: { type: 'string' } },
          content: { 'application/json': { schema: { type: 'object' } } },
        },
      ],
    });
    expect((inputSchema.properties as any).a).toEqual({
      type: 'array',
      items: { type: 'string' },
      'x-parameter-location': 'query',
      'x-parameter-style': 'form',
      'x-parameter-explode': false,
    });
    expect(mapper[0]).toEqual({
      inputKey: 'a',
      type: 'query',
      key: 'a',
      required: false,
      style: 'form',
      explode: false,
      allowReserved: undefined,
      serialization: undefined,
    });
  });

  it('reads a parameter whose content is unusable as before: a string, styled', () => {
    for (const content of [{}, 'application/json', ['application/json']]) {
      const { inputSchema, mapper } = resolve({ parameters: [{ name: 'a', in: 'query', style: 'form', content }] });
      expect((inputSchema.properties as any).a).toEqual({
        type: 'string',
        'x-parameter-location': 'query',
        'x-parameter-style': 'form',
      });
      expect(mapper[0]).toMatchObject({ style: 'form', serialization: undefined });
    }
  });

  it('takes examples from the parameter first, else from the media type', () => {
    const content = (media: Record<string, unknown>) => ({ 'application/json': { schema: { type: 'object' }, ...media } });
    const { inputSchema } = resolve(
      {
        parameters: [
          { name: 'own', in: 'query', example: { a: 1 }, content: content({ example: { b: 2 } }) },
          { name: 'media', in: 'query', content: content({ examples: { x: { dataValue: { c: 3 }, value: { d: 4 } } } }) },
          { name: 'single', in: 'query', content: content({ example: { e: 5 } }) },
          { name: 'none', in: 'query', content: content({}) },
        ],
      },
      undefined,
      { includeExamples: true },
    );
    const examples = (key: string) => (inputSchema.properties as any)[key].examples;
    expect([examples('own'), examples('media'), examples('single'), examples('none')]).toEqual([
      [{ a: 1 }],
      [{ c: 3 }],
      [{ e: 5 }],
      undefined,
    ]);
    // off by default
    const plain = resolve({ parameters: [{ name: 'a', in: 'query', example: 1, content: content({ example: 2 }) }] });
    expect((plain.inputSchema.properties as any).a.examples).toBeUndefined();
  });
});

describe('ParameterResolver: in: querystring', () => {
  const form = {
    'application/x-www-form-urlencoded': {
      schema: { type: 'object', properties: { q: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
      encoding: { tags: { explode: true } },
    },
  };

  it('maps the whole query string as one query entry typed by its content', () => {
    const { inputSchema, mapper } = resolve({
      parameters: [
        { name: 'search', in: 'querystring', required: true, description: 'The search', content: form },
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
    });
    expect(mapper).toEqual([
      {
        inputKey: 'search',
        type: 'query',
        key: 'search',
        required: true,
        serialization: { contentType: 'application/x-www-form-urlencoded', encoding: { tags: { explode: true } } },
        wholeQuery: true,
      },
      expect.objectContaining({ inputKey: 'id', type: 'path' }),
    ]);
    expect(inputSchema.required).toEqual(['search', 'id']);
    expect((inputSchema.properties as any).search).toEqual({
      type: 'object',
      properties: { q: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
      description: 'The search',
      'x-parameter-location': 'query',
      'x-parameter-content-type': 'application/x-www-form-urlencoded',
      'x-parameter-whole-query': true,
    });
  });

  it('reads content even when the parameter also has schema and style, which do not apply', () => {
    const { mapper } = resolve({
      parameters: [{ name: 'q', in: 'querystring', schema: { type: 'string' }, style: 'form', content: { 'text/plain': {} } }],
    });
    expect(mapper).toEqual([
      { inputKey: 'q', type: 'query', key: 'q', required: false, serialization: { contentType: 'text/plain' }, wholeQuery: true },
    ]);
  });

  it('renames on a conflict with a body property like any query parameter', () => {
    const { mapper } = resolve({
      parameters: [{ name: 'filter', in: 'querystring', content: { 'application/json': { schema: { type: 'object' } } } }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { filter: { type: 'string' } } } } } },
    });
    expect(mapper.map((m) => [m.inputKey, m.type, m.wholeQuery])).toEqual([
      ['queryFilter', 'query', true],
      ['bodyFilter', 'body', undefined],
    ]);
  });

  it('throws a GenerationError for parameters that break a querystring rule', () => {
    const qs = { name: 'q', in: 'querystring', content: { 'application/json': {} } };
    const cases: Array<[unknown[], unknown[], string]> = [
      [[qs], [{ ...qs, name: 'r' }], 'MULTIPLE_QUERYSTRING_PARAMETERS'],
      [[{ name: 'limit', in: 'query', schema: {} }], [qs], 'QUERYSTRING_WITH_QUERY_PARAMETERS'],
      [[], [{ name: 'q', in: 'querystring', schema: {} }], 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT'],
    ];
    for (const [pathLevel, operationLevel, code] of cases) {
      let error: unknown;
      try {
        resolve({ parameters: operationLevel }, pathLevel);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(GenerationError);
      expect((error as GenerationError).message).toContain(code);
      expect((error as GenerationError).context).toEqual({ code });
    }
  });
});

describe('ParameterResolver: path-level and operation-level parameters', () => {
  it('lets the operation parameter override the path-level one: one input key, sent once', () => {
    const { inputSchema, mapper } = resolve(
      {
        parameters: [
          { name: 'limit', in: 'query', required: true, schema: { type: 'integer', maximum: 50 } },
          { name: 'q', in: 'query', schema: { type: 'string' } },
        ],
      },
      [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } },
      ],
    );
    expect(Object.keys(inputSchema.properties!)).toEqual(['id', 'limit', 'q']);
    expect((inputSchema.properties as any).limit.maximum).toBe(50);
    expect(inputSchema.required).toEqual(['id', 'limit']);
    expect(mapper.map((m) => [m.inputKey, m.type, m.key])).toEqual([
      ['id', 'path', 'id'],
      ['limit', 'query', 'limit'],
      ['q', 'query', 'q'],
    ]);
  });

  it('keeps every parameter of one name in different locations, renamed as before', () => {
    const { mapper } = resolve(
      { parameters: [{ name: 'id', in: 'query', schema: { type: 'string' } }] },
      [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    );
    expect(mapper.map((m) => [m.inputKey, m.type])).toEqual([
      ['pathId', 'path'],
      ['queryId', 'query'],
    ]);
  });

  it('uses the last of several parameters with one name and location in a list', () => {
    const { inputSchema, mapper } = resolve({
      parameters: [
        { name: 'page', in: 'query', schema: { type: 'string' } },
        { name: 'page', in: 'query', schema: { type: 'integer' } },
      ],
    });
    expect(mapper).toHaveLength(1);
    expect((inputSchema.properties as any).page.type).toBe('integer');
  });

  it('passes the conflict index of the merged list to a custom conflict resolver', () => {
    const calls: unknown[] = [];
    new ParameterResolver({
      conflictResolver: (name, location, index) => {
        calls.push([name, location, index]);
        return `${location}_${name}`;
      },
    }).resolve(
      {
        parameters: [
          { name: 'x', in: 'query', schema: {} },
          { name: 'x', in: 'header', schema: {} },
        ],
      },
      [{ name: 'x', in: 'query', schema: {} } as any],
    );
    expect(calls).toEqual([
      ['x', 'query', 0],
      ['x', 'header', 1],
    ]);
  });
});

describe('collectExampleValues: Example Object data', () => {
  it('prefers dataValue, falls back to value, and never reads serialized forms', () => {
    expect(
      collectExampleValues(undefined, {
        both: { dataValue: { a: 1 }, value: 'ignored' },
        data: { dataValue: 0 },
        nullData: { dataValue: null, value: 'x' },
        value: { value: 'v' },
        serialized: { serializedValue: 'a=1' },
        external: { externalValue: 'https://example.com/x.json' },
        ref: { $ref: '#/components/examples/x' },
      }),
    ).toEqual([{ a: 1 }, 0, null, 'v']);
  });

  it('falls back to example when no Example Object holds data', () => {
    expect(collectExampleValues('single', { serialized: { serializedValue: 'x' } })).toEqual(['single']);
    expect(collectExampleValues(undefined, { serialized: { serializedValue: 'x' } })).toBeUndefined();
  });

  it('reads dataValue as an own property only', () => {
    const entry = Object.create({ dataValue: 'inherited' });
    entry.value = 'own';
    expect(collectExampleValues(undefined, { entry })).toEqual(['own']);
  });
});

describe('ParameterResolver: boolean schemas', () => {
  it('reads a parameter schema false as an input that accepts no value', () => {
    const { inputSchema, mapper } = resolve({
      parameters: [
        { name: 'id', in: 'path', required: true, schema: false, description: 'gone' },
        { name: 'q', in: 'query', schema: true },
      ],
    });
    expect(inputSchema.properties).toEqual({
      id: { not: {}, description: 'gone', 'x-parameter-location': 'path' },
      q: { 'x-parameter-location': 'query' },
    });
    expect(inputSchema.required).toEqual(['id']);
    expect(mapper.map((m) => m.inputKey)).toEqual(['id', 'q']);
  });

  it('keeps a false body property as an input no value satisfies, required when the body requires it', () => {
    const body = (required: boolean) =>
      resolve({
        requestBody: {
          required,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { gone: false, any: true, name: { type: 'string' } }, required: ['gone'] },
            },
          },
        },
      });
    const { inputSchema, mapper } = body(true);
    expect(inputSchema.properties).toEqual({
      gone: { not: {}, 'x-parameter-location': 'body' },
      any: { 'x-parameter-location': 'body' },
      name: { type: 'string', 'x-parameter-location': 'body' },
    });
    expect(inputSchema.required).toEqual(['gone']);
    expect(mapper.map((m) => [m.inputKey, m.required, m.wholeBody])).toEqual([
      ['gone', true, undefined],
      ['any', false, undefined],
      ['name', false, undefined],
    ]);
    expect(body(false).inputSchema.required).toBeUndefined();
  });

  it('reads a false form body as a whole body, and false allOf members as adding no property', () => {
    const form = resolve({ requestBody: { content: { 'application/x-www-form-urlencoded': { schema: false } } } });
    expect(form.inputSchema.properties).toEqual({ body: { not: {}, 'x-parameter-location': 'body' } });
    expect(form.mapper[0].serialization).toEqual({ contentType: 'application/x-www-form-urlencoded' });

    const allOf = resolve({
      requestBody: {
        content: { 'application/json': { schema: { allOf: [false, { type: 'object', properties: { a: false } }] } } },
      },
    });
    expect(allOf.inputSchema.properties).toEqual({ a: { not: {}, 'x-parameter-location': 'body' } });
  });

  it('still takes no body input for a media type without a schema, or one that is not a schema', () => {
    for (const schema of [undefined, null, 0, '']) {
      const { inputSchema, mapper } = resolve({ requestBody: { content: { 'application/json': { schema } } } });
      expect(inputSchema.properties).toEqual({});
      expect(mapper).toEqual([]);
    }
    // A truthy value that is not a schema is passed over, as before
    expect(resolve({ requestBody: { content: { 'application/json': { schema: 'x' } } } }).mapper).toEqual([]);
  });
});
