/** Executes the client-targets example and asserts each dialect's rules. */
import { generateForClients } from './example';

/* eslint-disable @typescript-eslint/no-explicit-any */

// A spec that trips every dialect rule: a root oneOf response, a $ref, a
// uuid format, and an optional property.
const spec: any = {
  openapi: '3.0.0',
  info: { title: 'Dialects API', version: '1.0.0' },
  components: {
    schemas: { Item: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, note: { type: 'string' } } } },
  },
  paths: {
    '/items/{id}': {
      get: {
        operationId: 'getItem',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          '200': {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
          },
          '404': {
            description: 'Missing',
            content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } } },
          },
        },
      },
    },
  },
};

describe('example: client-targets', () => {
  it('emits each provider dialect from the same spec', async () => {
    const byTarget = await generateForClients(spec, ['claude', 'openai', 'gemini', 'strict']);

    // Claude: no top-level output unions — status variants collapse
    const claude = byTarget['claude'][0];
    expect((claude.outputSchema as any).oneOf).toBeUndefined();

    // Gemini: no $ref/$defs anywhere, formats demoted
    const gemini = byTarget['gemini'][0];
    const geminiJson = JSON.stringify([gemini.inputSchema, gemini.outputSchema]);
    expect(geminiJson).not.toContain('"$ref"');
    expect((gemini.inputSchema as any).properties.id.format).toBeUndefined();

    // OpenAI strict contract: closed objects, every property required
    for (const target of ['openai', 'strict'] as const) {
      const root = byTarget[target][0].inputSchema as any;
      expect(root.additionalProperties).toBe(false);
      expect(root.required).toEqual(Object.keys(root.properties));
    }

    // Same operations, same names, regardless of dialect
    for (const tools of Object.values(byTarget)) {
      expect(tools.map((tool) => tool.name)).toEqual(['getItem']);
    }
  });
});
