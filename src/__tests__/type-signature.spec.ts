/** Tests for TypeScript call-signature emission */
import { emitToolTypeScript, toPascalIdentifier } from '../type-signature';
import type { JsonSchema } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const sig = (input: any, output?: any, options?: any): string =>
  emitToolTypeScript('t', undefined, input as JsonSchema, output as JsonSchema | undefined, options).signature;

const inputType = (input: any, options?: any): string => {
  const m = sig(input, undefined, options).match(/^\((?:input\??: )?(.*?)\) => /);
  return m ? (m[1] ?? '') : '';
};

const outputType = (output: any, options?: any): string =>
  sig({ type: 'object', properties: { a: { type: 'string' } } }, output, options).replace(/^.* => Promise<(.*)>$/s, '$1');

describe('toPascalIdentifier', () => {
  it('pascal-cases dotted, dashed, and underscored tool names', () => {
    expect(toPascalIdentifier('users.get_by-id')).toBe('UsersGetById');
    expect(toPascalIdentifier('getUser')).toBe('GetUser');
  });

  it('falls back to Tool for names with no alphanumerics', () => {
    expect(toPascalIdentifier('...')).toBe('Tool');
  });

  it('prefixes T when the result starts with a digit', () => {
    expect(toPascalIdentifier('3d.scan')).toBe('T3dScan');
  });
});

describe('emitToolTypeScript type printing', () => {
  it('prints scalar types and maps integer to number', () => {
    expect(outputType({ type: 'string' })).toBe('string');
    expect(outputType({ type: 'integer' })).toBe('number');
    expect(outputType({ type: 'number' })).toBe('number');
    expect(outputType({ type: 'boolean' })).toBe('boolean');
    expect(outputType({ type: 'null' })).toBe('null');
  });

  it('prints boolean schemas as unknown/never', () => {
    expect(outputType(true)).toBe('unknown');
    expect(outputType(false)).toBe('never');
    expect(outputType({ type: 'object', properties: { a: true, b: false } })).toBe('{ a?: unknown; b?: never }');
  });

  it('prints unknown for non-object schemas and unrecognized types', () => {
    expect(outputType('nonsense')).toBe('unknown');
    expect(outputType({ type: 'mystery' })).toBe('unknown');
  });

  it('prints $ref leftovers as unknown and never prints $defs', () => {
    expect(outputType({ $ref: '#/$defs/User' })).toBe('unknown');
    expect(outputType({ type: 'object', properties: { u: { $ref: '#/x' } }, $defs: { x: { type: 'string' } } })).toBe(
      '{ u?: unknown }',
    );
  });

  it('ignores x- annotation keywords for typing', () => {
    expect(
      outputType({ type: 'string', 'x-parameter-location': 'header', 'x-status-code': 200, 'x-content-type': 'a/b' }),
    ).toBe('string');
  });

  it('prints primitive consts as literals and falls through for object consts', () => {
    expect(outputType({ const: 'fixed' })).toBe('"fixed"');
    expect(outputType({ const: 42 })).toBe('42');
    expect(outputType({ const: false })).toBe('false');
    expect(outputType({ const: null })).toBe('null');
    expect(outputType({ const: { a: 1 }, type: 'object', properties: { a: { type: 'number' } } })).toBe(
      '{ a?: number }',
    );
  });

  it('prints enums as literal unions with dedupe and unknown for non-primitive members', () => {
    expect(outputType({ enum: ['a', 'b', 'a', 1, true, null, { bad: 1 }] })).toBe('"a" | "b" | 1 | true | null | unknown');
    expect(outputType({ enum: [] })).toBe('unknown');
    expect(outputType({ type: 'integer', enum: [1, 2] })).toBe('1 | 2');
  });

  it('recognizes the nullable anyOf wrapper in either order', () => {
    expect(outputType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(outputType({ anyOf: [{ type: 'null' }, { type: 'integer' }] })).toBe('number | null');
    expect(outputType({ anyOf: [{ type: 'null' }, { type: 'null' }] })).toBe('null');
  });

  it('parenthesizes union members inside the nullable wrapper', () => {
    expect(outputType({ anyOf: [{ oneOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'null' }] })).toBe(
      '(string | number) | null',
    );
  });

  it('prints allOf as an intersection including local properties', () => {
    expect(outputType({ allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }] })).toBe(
      '{ a: string }',
    );
    expect(
      outputType({
        allOf: [{ type: 'object', properties: { a: { type: 'string' } } }],
        properties: { b: { type: 'number' } },
      }),
    ).toBe('{ a?: string } & { b?: number }');
    expect(outputType({ allOf: [] })).toBe('unknown');
  });

  it('prints oneOf/anyOf as deduplicated unions', () => {
    expect(outputType({ oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'string' }] })).toBe('string | number');
    expect(outputType({ anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] })).toBe(
      'string | number | boolean',
    );
    expect(outputType({ oneOf: [] })).toBe('unknown');
  });

  it('prints type arrays as unions', () => {
    expect(outputType({ type: ['string', 'null'] })).toBe('string | null');
    expect(outputType({ type: [] })).toBe('unknown');
  });

  it('prints arrays with item types, parenthesizing unions', () => {
    expect(outputType({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(outputType({ type: 'array' })).toBe('unknown[]');
    expect(outputType({ type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } })).toBe(
      '(string | number)[]',
    );
  });

  it('prints tuples from prefixItems and legacy array items', () => {
    expect(outputType({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] })).toBe(
      '[string, number]',
    );
    expect(
      outputType({ type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } }),
    ).toBe('[string, ...number[]]');
    expect(outputType({ type: 'array', items: [{ type: 'string' }, { type: 'boolean' }] })).toBe('[string, boolean]');
  });

  it('prints bare objects as Records keyed by additionalProperties', () => {
    expect(outputType({ type: 'object' })).toBe('Record<string, unknown>');
    expect(outputType({ type: 'object', additionalProperties: false })).toBe('Record<string, never>');
    expect(outputType({ type: 'object', additionalProperties: true })).toBe('Record<string, unknown>');
    expect(outputType({ type: 'object', additionalProperties: { type: 'number' } })).toBe('Record<string, number>');
    expect(outputType({ type: 'object', patternProperties: { '^x': { type: 'string' } } })).toBe(
      'Record<string, string>',
    );
  });

  it('treats type-less schemas with object keywords as objects', () => {
    expect(outputType({ properties: { a: { type: 'string' } } })).toBe('{ a?: string }');
    expect(outputType({ additionalProperties: { type: 'string' } })).toBe('Record<string, string>');
    expect(outputType({ patternProperties: { '^x': { type: 'number' } } })).toBe('Record<string, number>');
    expect(outputType({ format: 'opaque' })).toBe('unknown');
  });

  it('appends a Record intersection for typed additionalProperties beside properties', () => {
    expect(
      outputType({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: { type: 'number' },
        patternProperties: { '^x': { type: 'boolean' } },
      }),
    ).toBe('{ a: string } & Record<string, number | boolean>');
  });

  it('quotes property names that are not valid identifiers', () => {
    expect(outputType({ type: 'object', properties: { 'content-type': { type: 'string' }, ok$_1: { type: 'boolean' } } })).toBe(
      '{ "content-type"?: string; ok$_1?: boolean }',
    );
  });

  it('collapses true cycles to unknown while diamond-shared nodes print fully', () => {
    const cyclic: any = { type: 'object', properties: {} };
    cyclic.properties.self = cyclic;
    expect(outputType(cyclic)).toBe('{ self?: unknown }');

    const shared: any = { type: 'string' };
    expect(outputType({ type: 'object', properties: { a: shared, b: shared } })).toBe('{ a?: string; b?: string }');
  });

  it('caps nesting at maxDepth and honors the option', () => {
    const deep = { type: 'object', properties: { l1: { type: 'object', properties: { l2: { type: 'string' } } } } };
    expect(outputType(deep, { maxDepth: 2 })).toBe('{ l1?: { l2?: unknown } }');
    expect(outputType(deep, { maxDepth: 1 })).toBe('{ l1?: unknown }');
    expect(outputType(deep, { maxDepth: Number.NaN })).toBe('{ l1?: { l2?: string } }');
  });
});

describe('emitToolTypeScript assembly', () => {
  it('builds the signature parameter form from the input schema', () => {
    expect(sig({ type: 'object', properties: {} })).toBe('() => Promise<unknown>');
    expect(sig('not-a-schema')).toBe('() => Promise<unknown>');
    expect(sig({ type: 'object', properties: { a: { type: 'string' } } })).toBe(
      '(input?: { a?: string }) => Promise<unknown>',
    );
    expect(sig({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })).toBe(
      '(input: { a: string }) => Promise<unknown>',
    );
  });

  it('emits a complete self-contained declaration with JSDoc', () => {
    const { declaration } = emitToolTypeScript(
      'users.get',
      'Fetch a user.\nSecond line with */ inside.',
      {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The user id', format: 'uuid' },
          verbose: { type: 'boolean', default: false, deprecated: true },
        },
        required: ['id'],
      } as JsonSchema,
      { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } as JsonSchema,
    );
    expect(declaration).toBe(
      [
        '/**',
        ' * Fetch a user.',
        ' * Second line with *\\/ inside.',
        ' */',
        '',
        'interface UsersGetInput {',
        '  /**',
        '   * The user id',
        '   * @format uuid',
        '   */',
        '  id: string;',
        '  /**',
        '   * @default false',
        '   * @deprecated',
        '   */',
        '  verbose?: boolean;',
        '}',
        '',
        'interface UsersGetOutput {',
        '  name: string;',
        '}',
        '',
        'declare function usersGet(input: UsersGetInput): Promise<UsersGetOutput>;',
      ].join('\n'),
    );
  });

  it('renders single-line JSDoc compactly and skips unserializable defaults', () => {
    const { declaration } = emitToolTypeScript(
      't',
      undefined,
      {
        type: 'object',
        properties: { a: { type: 'string', description: 'One line', default: undefined } },
      } as JsonSchema,
      undefined,
    );
    expect(declaration).toContain('  /** One line */\n  a?: string;');
    expect(declaration).not.toContain('@default');
  });

  it('uses type aliases for non-object roots and unknown output when absent', () => {
    const { declaration } = emitToolTypeScript('t', undefined, { type: 'object' } as JsonSchema, {
      type: 'string',
    } as JsonSchema);
    expect(declaration).toContain('type TInput = Record<string, unknown>;');
    expect(declaration).toContain('type TOutput = string;');

    const none = emitToolTypeScript('t', undefined, { type: 'object', properties: {} } as JsonSchema, undefined);
    expect(none.declaration).toContain('type TOutput = unknown;');
    expect(none.declaration).toContain('declare function t(): Promise<TOutput>;');
  });

  it('uses a type alias when an intersection suffix prevents an interface body', () => {
    const { declaration } = emitToolTypeScript(
      't',
      undefined,
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: { type: 'number' },
      } as JsonSchema,
      undefined,
    );
    expect(declaration).toContain('type TInput = {\n  a?: string;\n} & Record<string, number>;');
  });

  it('annotates root output status variants from x-status-code', () => {
    const { declaration } = emitToolTypeScript('t', undefined, { type: 'object', properties: {} } as JsonSchema, {
      oneOf: [
        { type: 'object', properties: { ok: { type: 'boolean' } }, 'x-status-code': 200, 'x-content-type': 'application/json' },
        { type: 'object', properties: { error: { type: 'string' } }, 'x-status-code': '404' },
        { type: 'string' },
        true,
      ],
    } as JsonSchema);
    expect(declaration).toContain('type TOutput =');
    expect(declaration).toContain('  | /** status 200 (application/json) */ {');
    expect(declaration).toContain('  | /** status 404 */ {');
    expect(declaration).toContain('  | string');
    expect(declaration).toContain('  | unknown');
  });

  it('falls back to a plain union for root oneOf without status codes', () => {
    const { declaration } = emitToolTypeScript('t', undefined, { type: 'object', properties: {} } as JsonSchema, {
      oneOf: [{ type: 'string' }, { type: 'number' }],
    } as JsonSchema);
    expect(declaration).toContain('type TOutput = string | number;');
  });

  it('declares union and intersection roots as type aliases, never interfaces', () => {
    const union = emitToolTypeScript('t', undefined, { type: 'object', properties: {} } as JsonSchema, {
      oneOf: [
        { type: 'object', properties: { bark: { type: 'boolean' } } },
        { type: 'object', properties: { meow: { type: 'boolean' } } },
      ],
      'x-status-code': 200,
    } as JsonSchema);
    expect(union.declaration).toContain('type TOutput = {\n  bark?: boolean;\n} | {\n  meow?: boolean;\n};');
    expect(union.declaration).not.toContain('interface TOutput');

    const intersection = emitToolTypeScript('t', undefined, { type: 'object', properties: {} } as JsonSchema, {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'number' } } },
      ],
    } as JsonSchema);
    expect(intersection.declaration).toContain('type TOutput = {\n  a?: string;\n} & {\n  b?: number;\n};');
  });

  it('escapes comment-breaking content types and statuses in variant comments', () => {
    const { declaration } = emitToolTypeScript('t', undefined, { type: 'object', properties: {} } as JsonSchema, {
      oneOf: [
        { type: 'string', 'x-status-code': 200, 'x-content-type': '*/*' },
        { type: 'number', 'x-status-code': 500 },
      ],
    } as JsonSchema);
    expect(declaration).toContain('/** status 200 (*\\/*) */ string');
    expect(declaration).not.toContain('(*/*)');
  });

  it('suffixes reserved words used as function names', () => {
    const { declaration } = emitToolTypeScript(
      'delete',
      undefined,
      { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as JsonSchema,
      undefined,
    );
    expect(declaration).toContain('declare function delete_(input: DeleteInput): Promise<DeleteOutput>;');
  });

  it('degrades non-finite numeric literals to number and skips their defaults', () => {
    expect(outputType({ enum: [Infinity, 1] })).toBe('number | 1');
    expect(outputType({ const: Number.NaN })).toBe('number');
    const { declaration } = emitToolTypeScript('t', undefined, {
      type: 'object',
      properties: { x: { type: 'number', default: Infinity } },
    } as JsonSchema, undefined);
    expect(declaration).not.toContain('@default');
  });

  it('survives crafted self-referential type arrays', () => {
    const type: any[] = ['object'];
    type.push(type);
    expect(outputType({ type, properties: { a: { type: 'string' } } })).toBe('{ a?: string }');
  });

  it('keeps input for property-less roots that still carry data', () => {
    expect(sig({ type: 'object', additionalProperties: { type: 'string' } })).toBe(
      '(input: Record<string, string>) => Promise<unknown>',
    );
    expect(sig({ type: 'string' })).toBe('(input: string) => Promise<unknown>');
    expect(sig(true)).toBe('(input?: unknown) => Promise<unknown>');
    const { declaration } = emitToolTypeScript('t', undefined, {
      type: 'object',
      additionalProperties: { type: 'string' },
    } as JsonSchema, undefined);
    expect(declaration).toContain('declare function t(input: TInput): Promise<TOutput>;');
  });

  it('is deterministic across calls', () => {
    const input = { type: 'object', properties: { a: { type: 'string' } } } as JsonSchema;
    const output = { oneOf: [{ type: 'string' }, { type: 'number' }] } as JsonSchema;
    const first = emitToolTypeScript('users.get', 'd', input, output);
    const second = emitToolTypeScript('users.get', 'd', input, output);
    expect(second).toEqual(first);
  });
});
