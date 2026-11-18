import { OpenAPIToolGenerator } from '../generator';
import { SchemaBuilder } from '../schema-builder';
import { toJsonSchema } from '../types';

const info = { title: 't', version: '1' };

async function generate(responses: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const generator = await OpenAPIToolGenerator.fromJSON(
    { openapi: '3.0.3', info, paths: { '/p': { get: { operationId: 'p', responses } } } },
    { validate: false },
  );
  const [tool] = await generator.generateTools(options);
  return { tool, diagnostics: generator.getDiagnostics() };
}

const json = (schema: unknown) => ({ content: { 'application/json': { schema } } });

describe('an output schema of several responses accepts a value that matches more than one', () => {
  it('joins the responses with anyOf', async () => {
    const { tool } = await generate({ 204: { description: 'gone' }, 404: { description: 'missing' } });
    expect(tool.outputSchema).toMatchObject({
      anyOf: [
        { type: 'null', 'x-status-code': 204 },
        { type: 'null', 'x-status-code': 404 },
      ],
    });
    expect(tool.outputSchema).not.toHaveProperty('oneOf');
    expect(tool.metadata.responseStatusCodes).toEqual([204, 404]);
  });

  it('annotates each response of the union in the TypeScript declaration', async () => {
    const { tool } = await generate(
      { 200: { description: 'ok', ...json({ type: 'string' }) }, 404: { description: 'missing' } },
      { emitTypeSignatures: true },
    );
    expect(tool.metadata.typescript?.declaration).toContain('/** status 200 (application/json) */ string');
    expect(tool.metadata.typescript?.declaration).toContain('/** status 404 */ null');
  });
});

describe('response keys are status codes or ranges', () => {
  it.each(['200abc', '200 ', '0200', '+200', '0', '20', '600'])('ignores the key %p with a diagnostic', async (key) => {
    const { tool, diagnostics } = await generate({
      [key]: { description: 'look-alike', ...json({ type: 'string' }) },
      500: { description: 'error', ...json({ type: 'object' }) },
    });
    expect(tool.outputSchema).toMatchObject({ type: 'object', 'x-status-code': 500 });
    expect(tool.metadata.responseStatusCodes).toEqual([500]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: 'INVALID_RESPONSE_KEY', path: `/paths/~1p/get/responses/${key}` }),
    ]);
  });

  it('reads the statuses of the responses the output schema was built from, whatever the naming callback does', async () => {
    const toolNameGenerator = (_path: string, _method: string, _id: string, operation: Record<string, any>) => {
      operation.responses['404'] = { description: 'added later' };
      operation.responses['5XX'] = { description: 'added later' };
      return 'named';
    };
    const { tool } = await generate({ 200: { description: 'ok', ...json({ type: 'string' }) } }, {
      namingStrategy: { conflictResolver: (name: string) => name, toolNameGenerator },
    });
    expect(tool.metadata.responseStatusCodes).toEqual([200]);
    expect(tool.metadata.responseStatusRanges).toBeUndefined();
  });

  it('reads extensions and default without a diagnostic', async () => {
    const { diagnostics } = await generate({ 200: { description: 'ok' }, default: { description: 'e' }, 'x-note': 1 });
    expect(diagnostics).toEqual([]);
  });

  it('takes the status metadata from the responses, never from the schema', async () => {
    const union = {
      oneOf: [
        { type: 'string', 'x-status-code': 200 },
        { type: 'number', 'x-status-code': 201 },
      ],
    };
    expect((await generate({ 500: { description: 'e', ...json(union) } })).tool.metadata.responseStatusCodes).toEqual([
      500,
    ]);
    expect((await generate({ 200: { description: 'ok', ...json(union) } })).tool.metadata.responseStatusCodes).toEqual([
      200,
    ]);
    const ranges = { oneOf: [{ type: 'string', 'x-status-code': '2XX' }] };
    expect(
      (await generate({ 500: { description: 'e', ...json(ranges) } })).tool.metadata.responseStatusRanges,
    ).toBeUndefined();
  });

  it('reports only the preferred response when includeAllResponses is off', async () => {
    const { tool } = await generate(
      {
        200: { description: 'ok', ...json({ type: 'string' }) },
        '4XX': { description: 'e', ...json({ type: 'object' }) },
      },
      { includeAllResponses: false },
    );
    expect(tool.metadata.responseStatusCodes).toEqual([200]);
    expect(tool.metadata.responseStatusRanges).toBeUndefined();
  });

  it('lint reads the success responses the same way', async () => {
    const lint = async (responses: Record<string, unknown>) => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        {
          openapi: '3.0.3',
          info,
          paths: { '/p': { get: { operationId: 'p', summary: 'Read the p resource', responses } } },
        },
        { validate: false },
      );
      return (await generator.lint()).findings.map((finding) => finding.code);
    };
    expect(await lint({ '200 ': { description: 'ok' } })).toContain('missing-success-response');
    expect(await lint({ '2xx': { description: 'ok' } })).not.toContain('missing-success-response');
  });
});

describe('schema trimming never refuses what the document accepts', () => {
  it('opens an object whose properties a depth cut removed', () => {
    const closed = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const cut = SchemaBuilder.truncateDepth({ type: 'object', properties: { nested: closed } } as never, 1);
    const nested = (cut.properties as Record<string, Record<string, unknown>>)['nested'];
    expect(nested).not.toHaveProperty('properties');
    expect(nested).not.toHaveProperty('additionalProperties');

    const tuple = { type: 'array', prefixItems: [{ type: 'string' }], items: false };
    const cutTuple = SchemaBuilder.truncateDepth({ type: 'object', properties: { t: tuple } } as never, 1);
    expect((cutTuple.properties as Record<string, unknown>)['t']).not.toHaveProperty('items');
  });

  it('keeps a closing keyword at a cut node that had nothing to remove', () => {
    const closed = { type: 'object', additionalProperties: false };
    const cut = SchemaBuilder.truncateDepth({ type: 'object', properties: { empty: closed } } as never, 1);
    expect((cut.properties as Record<string, unknown>)['empty']).toMatchObject({ additionalProperties: false });
  });

  it.each([
    ['an empty properties map', { properties: {} }],
    ['definitions', { $defs: { a: { type: 'string' } }, definitions: { b: {} } }],
  ])('keeps a closing keyword when a cut removes only %s', (_label, children) => {
    const closed = { type: 'object', ...children, additionalProperties: false, unevaluatedProperties: false };
    const cut = SchemaBuilder.truncateDepth({ type: 'object', properties: { c: closed } } as never, 1);
    expect((cut.properties as Record<string, unknown>)['c']).toMatchObject({
      additionalProperties: false,
      unevaluatedProperties: false,
    });
  });

  it('opens a node whose cut removed a schema that marks items evaluated', () => {
    const closed = { type: 'array', contains: {}, unevaluatedItems: false };
    const cut = SchemaBuilder.truncateDepth({ type: 'object', properties: { c: closed } } as never, 1);
    expect((cut.properties as Record<string, unknown>)['c']).not.toHaveProperty('unevaluatedItems');
  });

  it('opens an object whose properties maxProperties removed', () => {
    const limited = SchemaBuilder.limitProperties(
      {
        type: 'object',
        properties: { a: {}, b: {}, c: {} },
        additionalProperties: false,
        unevaluatedProperties: false,
      } as never,
      2,
    );
    expect(Object.keys(limited.properties ?? {})).toEqual(['a', 'b']);
    expect(limited).not.toHaveProperty('additionalProperties');
    expect(limited).not.toHaveProperty('unevaluatedProperties');
  });

  it('drops x-nullable whenever it is a boolean, so converting twice gives the same schema', () => {
    const once = toJsonSchema({ type: 'string', nullable: false, 'x-nullable': true } as never);
    expect(once).toEqual({ type: 'string' });
    expect(toJsonSchema(once as never)).toEqual(once);
  });
});
