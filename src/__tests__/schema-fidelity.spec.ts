import { OpenAPIToolGenerator } from '../generator';
import { buildHttpRequest } from '../request-builder';
import { SchemaBuilder } from '../schema-builder';

const ok = { 200: { description: 'ok' } };
const info = { title: 't', version: '1' };

async function toolFor(operation: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const generator = await OpenAPIToolGenerator.fromJSON(
    {
      openapi: '3.1.0',
      info,
      servers: [{ url: 'https://api.example.test' }],
      paths: { '/p': { post: { operationId: 'p', responses: ok, ...operation } } },
    },
    { validate: false },
  );
  const [tool] = await generator.generateTools(options);
  return tool;
}

const jsonBody = (schema: unknown, required = true) => ({
  requestBody: { required, content: { 'application/json': { schema } } },
});

describe('readOnly and writeOnly properties', () => {
  const user = {
    type: 'object',
    required: ['id', 'name', 'password'],
    properties: {
      id: { type: 'string', readOnly: true },
      name: { type: 'string' },
      password: { type: 'string', writeOnly: true },
      profile: {
        type: 'object',
        required: ['createdAt', 'bio'],
        properties: {
          createdAt: { type: 'string', readOnly: true },
          bio: { type: 'string' },
          secret: { type: 'string', writeOnly: true },
        },
      },
      meta: {
        type: 'object',
        required: ['version'],
        properties: { version: { type: 'integer', readOnly: true }, note: {} },
      },
      stamp: { type: 'object', properties: { at: { type: 'string', readOnly: true } } },
    },
  };

  it('leaves readOnly properties out of the input, at every depth, and from required', async () => {
    const tool = await toolFor(jsonBody(user));
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['name', 'password', 'profile', 'meta', 'stamp']);
    expect(tool.inputSchema.required).toEqual(['name', 'password']);
    expect(tool.mapper.map((entry) => entry.key)).toEqual(['name', 'password', 'profile', 'meta', 'stamp']);
    expect(tool.inputSchema.properties?.['meta']).not.toHaveProperty('required');
    expect(tool.inputSchema.properties?.['stamp']).toMatchObject({ properties: {} });
    const profile = tool.inputSchema.properties?.['profile'] as Record<string, unknown>;
    expect(Object.keys(profile['properties'] as object)).toEqual(['bio', 'secret']);
    expect(profile['required']).toEqual(['bio']);
  });

  it('keeps a body whole when every property is readOnly, so a required body is still sent', async () => {
    const schema = { type: 'object', required: ['id'], properties: { id: { type: 'string', readOnly: true } } };
    const tool = await toolFor(jsonBody(schema));
    expect(tool.mapper).toEqual([expect.objectContaining({ key: 'body', wholeBody: true, required: true })]);
    expect(tool.inputSchema.properties?.['body']).toMatchObject({ type: 'object', properties: {} });
    expect(buildHttpRequest(tool, { body: {} }).body).toBe('{}');
  });

  it('leaves writeOnly properties out of the output, at every depth, and from required', async () => {
    const tool = await toolFor({
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: user } } } },
    });
    expect(Object.keys(tool.outputSchema?.properties ?? {})).toEqual(['id', 'name', 'profile', 'meta', 'stamp']);
    expect(tool.outputSchema?.required).toEqual(['id', 'name']);
    const profile = tool.outputSchema?.properties?.['profile'] as Record<string, unknown>;
    expect(Object.keys(profile['properties'] as object)).toEqual(['createdAt', 'bio']);
  });
});

describe('marked properties are left out only where a value must match', () => {
  it('leaves a negated or conditional subschema as it is', () => {
    const marked = { properties: { secret: { type: 'string', writeOnly: true } }, required: ['secret'] };
    const schema = {
      type: 'object',
      properties: { open: { type: 'string' }, secret: { type: 'string', writeOnly: true } },
      not: marked,
      if: marked,
      then: marked,
    };
    const omitted = SchemaBuilder.omitMarkedProperties(schema as never, 'writeOnly') as Record<string, unknown>;
    expect(Object.keys(omitted['properties'] as object)).toEqual(['open']);
    expect(omitted['not']).toEqual(marked);
    expect(omitted['if']).toEqual(marked);
    expect(omitted['then']).toEqual({ properties: {} });
  });
});

describe('a flattened body keeps every constraint of its allOf members', () => {
  it('applies every definition of a property two members define', async () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { role: { type: 'string', enum: ['user', 'admin'], description: 'base' } } },
        { type: 'object', properties: { role: { maxLength: 4, description: 'override' } } },
      ],
    };
    const tool = await toolFor(jsonBody(schema));
    expect(tool.inputSchema.properties?.['role']).toEqual({
      type: 'string',
      enum: ['user', 'admin'],
      maxLength: 4,
      description: 'override',
      'x-parameter-location': 'body',
    });
  });

  it('keeps both definitions when they set one constraint differently', async () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { n: { type: 'string', maxLength: 10 } } },
        { type: 'object', properties: { n: { maxLength: 4 } } },
      ],
    };
    const tool = await toolFor(jsonBody(schema));
    expect(tool.inputSchema.properties?.['n']).toMatchObject({
      allOf: [{ type: 'string', maxLength: 10 }, { maxLength: 4 }],
    });
  });

  it.each([
    ['if and then', { if: { type: 'string' } }, { then: { maxLength: 2 } }],
    ['additionalProperties and properties', { type: 'object', properties: { a: {} } }, { additionalProperties: false }],
    ['items and prefixItems', { prefixItems: [{ type: 'string' }] }, { items: { type: 'number' } }],
  ])('keeps two definitions whose %s would read each other as one schema', async (_label, first, second) => {
    const schema = {
      allOf: [
        { type: 'object', properties: { n: first } },
        { type: 'object', properties: { n: second } },
      ],
    };
    const tool = await toolFor(jsonBody(schema));
    expect(tool.inputSchema.properties?.['n']).toMatchObject({ allOf: [first, second] });
  });

  it('merges a definition that only adds annotations to one read with its siblings', async () => {
    const nested = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const schema = {
      allOf: [
        { type: 'object', properties: { n: nested } },
        { type: 'object', properties: { n: { description: 'override' } } },
      ],
    };
    const tool = await toolFor(jsonBody(schema));
    expect(tool.inputSchema.properties?.['n']).toMatchObject({ ...nested, description: 'override' });
  });

  it.each([
    ['not', { not: { required: ['a', 'b'] } }],
    ['minProperties', { minProperties: 1 }],
    ['maxProperties', { maxProperties: 1 }],
    ['dependentRequired', { dependentRequired: { a: ['b'] } }],
    ['if', { if: { required: ['a'] }, then: { required: ['b'] } }],
    ['patternProperties', { patternProperties: { '^x-': { type: 'string' } } }],
    ['propertyNames', { propertyNames: { maxLength: 3 } }],
    ['enum', { enum: [{ a: 'x' }] }],
    ['const', { const: { a: 'x' } }],
  ])('keeps a body whole when it carries %s, which properties alone cannot say', async (_label, constraint) => {
    const schema = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, ...constraint };
    const tool = await toolFor(jsonBody(schema));
    expect(tool.mapper).toEqual([expect.objectContaining({ key: 'body', wholeBody: true })]);
    expect(tool.inputSchema.properties?.['body']).toMatchObject(constraint);
  });

  it('keeps a body whole when an allOf member carries such a constraint', async () => {
    const schema = { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { minProperties: 1 }] };
    const tool = await toolFor(jsonBody(schema));
    expect(tool.mapper).toEqual([expect.objectContaining({ wholeBody: true })]);
  });

  it('still flattens an ordinary object body', async () => {
    const tool = await toolFor(jsonBody({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }));
    expect(tool.mapper.map((entry) => entry.key)).toEqual(['a']);
    expect(buildHttpRequest(tool, { a: 'x' }).body).toBe('{"a":"x"}');
  });
});

describe('a root input named __proto__ under maxProperties', () => {
  it('keeps its schema', async () => {
    const parameters = [{ name: '__proto__', in: 'query', schema: { type: 'object', properties: { a: {}, b: {} } } }];
    const tool = await toolFor({ parameters }, { maxProperties: 1 });
    expect(Object.getPrototypeOf(tool.inputSchema.properties)).toBe(Object.prototype);
    expect(Object.hasOwn(tool.inputSchema.properties ?? {}, '__proto__')).toBe(true);
  });
});
