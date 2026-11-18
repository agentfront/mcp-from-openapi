import { OpenAPIToolGenerator } from '../generator';
import { wrapReferenceSiblings } from '../spec/schema-references';

const ok = { 200: { description: 'ok' } };
const info = { title: 't', version: '1' };
const code = { $ref: '#/components/schemas/Code', maxLength: 5 };

describe('wrapReferenceSiblings', () => {
  it('puts the $ref of a schema with other constraints under allOf, wherever a schema sits', () => {
    const document = {
      components: { schemas: { A: { ...code }, B: { $ref: '#/x', allOf: [{ minLength: 2 }] } } },
      paths: {
        '/p': {
          parameters: [{ name: 'q', in: 'query', schema: { ...code } }],
          get: {
            responses: {
              200: {
                description: 'ok',
                content: {
                  'application/json': {
                    schema: {
                      properties: { schema: { ...code }, list: { items: [{ ...code }] } },
                      oneOf: [{ ...code }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    wrapReferenceSiblings(document);
    const wrapped = { allOf: [{ $ref: '#/components/schemas/Code' }], maxLength: 5 };
    // After the members already there, so a pointer to one of them still names it
    expect(document.components.schemas).toEqual({ A: wrapped, B: { allOf: [{ minLength: 2 }, { $ref: '#/x' }] } });
    expect(document.paths['/p'].parameters[0].schema).toEqual(wrapped);
    const schema = document.paths['/p'].get.responses[200].content['application/json'].schema;
    expect(schema).toEqual({ properties: { schema: wrapped, list: { items: [wrapped] } }, oneOf: [wrapped] });
  });

  it('walks the entries of a map of objects whatever their names, a response named default included', () => {
    const document = {
      paths: { '/p': { get: { responses: { default: { content: { 'application/json': { schema: { ...code } } } } } } } },
      components: { responses: { example: { content: { 'text/plain': { schema: { ...code } } } } } },
    };
    wrapReferenceSiblings(document);
    const wrapped = { allOf: [{ $ref: '#/components/schemas/Code' }], maxLength: 5 };
    expect(document.paths['/p'].get.responses.default.content['application/json'].schema).toEqual(wrapped);
    expect(document.components.responses.example.content['text/plain'].schema).toEqual(wrapped);
  });

  it('leaves a $ref with only annotations beside it, a reference that is no schema, and data alone', () => {
    const document = {
      components: {
        schemas: {
          Described: { $ref: '#/x', description: 'd', summary: 's', title: 't', $comment: 'c', 'x-note': 1 },
          WithData: { type: 'object', default: { ...code }, examples: [{ ...code }], enum: [{ ...code }], 'x-a': { ...code } },
          NotARef: { $ref: 5, maxLength: 5 },
        },
        parameters: { p: { $ref: '#/components/parameters/q', required: true } },
      },
      paths: { '/p': { get: { responses: { 200: { $ref: '#/r', description: 'd' } } } } },
      'x-root': { schema: { ...code } },
    };
    const before = JSON.stringify(document);
    wrapReferenceSiblings(document);
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe('a $ref beside other keywords in a schema', () => {
  async function codeInput(openapi: string, property: unknown) {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi,
        info,
        servers: [{ url: 'https://api.example.test' }],
        components: { schemas: { Code: { type: 'string', pattern: '^[A-Z]+$' } } },
        paths: {
          '/p': {
            post: {
              operationId: 'p',
              requestBody: {
                required: true,
                content: { 'application/json': { schema: { type: 'object', properties: { code: property } } } },
              },
              responses: ok,
            },
          },
        },
      },
      { validate: false },
    );
    const [tool] = await generator.generateTools();
    return tool.inputSchema.properties?.['code'];
  }

  it.each(['3.1.0', '3.2.0'])('applies with its target in a %s document', async (openapi) => {
    expect(await codeInput(openapi, code)).toEqual({
      allOf: [{ type: 'string', pattern: '^[A-Z]+$' }],
      maxLength: 5,
      'x-parameter-location': 'body',
    });
  });

  it('is replaced by its target in a 3.0 document, as OpenAPI 3.0 says', async () => {
    expect(await codeInput('3.0.3', code)).toEqual({
      type: 'string',
      pattern: '^[A-Z]+$',
      'x-parameter-location': 'body',
    });
  });

  it('reads as before when only annotations are beside it', async () => {
    expect(await codeInput('3.1.0', { $ref: '#/components/schemas/Code', description: 'A code' })).toEqual({
      type: 'string',
      pattern: '^[A-Z]+$',
      'x-parameter-location': 'body',
    });
  });

  it('keeps a pointer to an existing allOf member naming that member', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.1.0',
        info,
        components: {
          schemas: {
            Code: { type: 'integer' },
            A: { $ref: '#/components/schemas/Code', allOf: [{ type: 'string' }], maxLength: 5 },
          },
        },
        paths: {
          '/p': {
            get: {
              operationId: 'p',
              parameters: [{ name: 'q', in: 'query', schema: { $ref: '#/components/schemas/A/allOf/0' } }],
              responses: ok,
            },
          },
        },
      },
      { validate: false },
    );
    const [tool] = await generator.generateTools();
    expect(tool.inputSchema.properties?.['q']).toMatchObject({ type: 'string' });
  });

  it('marks a property readOnly through the keyword beside it', async () => {
    expect(await codeInput('3.1.0', { $ref: '#/components/schemas/Code', readOnly: true })).toBeUndefined();
  });

  it('adds the required fields beside a body $ref', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.1.0',
        info,
        components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' }, tag: {} } } } },
        paths: {
          '/p': {
            post: {
              operationId: 'p',
              requestBody: {
                required: true,
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Pet', required: ['name'] } },
                },
              },
              responses: ok,
            },
          },
        },
      },
      { validate: false },
    );
    const [tool] = await generator.generateTools();
    expect(tool.mapper.map((entry) => entry.key)).toEqual(['name', 'tag']);
    expect(tool.inputSchema.required).toEqual(['name']);
  });
});
