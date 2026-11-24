import { OpenAPIToolGenerator } from '../generator';

const ok = { 200: { description: 'ok' } };
const info = { title: 't', version: '1' };
const code = { $ref: '#/components/schemas/Code', maxLength: 5 };

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
