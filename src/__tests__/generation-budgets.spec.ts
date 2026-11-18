import { SchemaError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import { ParameterResolver } from '../parameter-resolver';
import {
  DEFAULT_MAX_SCHEMA_NODES,
  SECURE_MAX_TOTAL_SCHEMA_NODES,
  resolveMaxTotalSchemaNodes,
  resolveSchemaLimits,
} from '../schema-builder';
import { toJsonSchema } from '../types';

function objectSchema(propertyCount: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < propertyCount; index++) properties[`p${index}`] = { type: 'string' };
  return { type: 'object', properties };
}

function manyParametersDocument(parameterCount: number, propertyCount: number): Record<string, unknown> {
  const parameters = Array.from({ length: parameterCount }, (_, index) => ({
    name: `q${index}`,
    in: 'query',
    schema: { $ref: '#/components/schemas/Big' },
  }));
  return {
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    components: { schemas: { Big: objectSchema(propertyCount) } },
    paths: { '/p': { get: { operationId: 'p', parameters, responses: { 200: { description: 'ok' } } } } },
  };
}

function manyOperationsDocument(operationCount: number, propertyCount: number): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < operationCount; index++) {
    paths[`/r${index}`] = {
      get: {
        operationId: `op${index}`,
        responses: {
          200: {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Big' } } },
          },
        },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    components: { schemas: { Big: objectSchema(propertyCount) } },
    paths,
  };
}

describe('one node budget for every conversion of a tool schema', () => {
  it('toJsonSchema charges a shared budget across calls', () => {
    const sharedBudget = { nodes: 0, maxNodes: 60 };
    toJsonSchema(objectSchema(20), { maxNodes: 1000, sharedBudget });
    expect(sharedBudget.nodes).toBeGreaterThan(40);
    expect(() => toJsonSchema(objectSchema(20), { maxNodes: 1000, sharedBudget })).toThrow(SchemaError);
    expect(() => toJsonSchema({ type: 'array', prefixItems: [1, 2, 3].map(() => ({})) }, { maxNodes: 1000, sharedBudget: { nodes: 59, maxNodes: 60 } })).toThrow(SchemaError);
  });

  it('ParameterResolver converts all parameters of an operation against one budget', () => {
    const operation = {
      parameters: Array.from({ length: 10 }, (_, index) => ({
        name: `q${index}`,
        in: 'query',
        schema: objectSchema(10),
      })),
      responses: {},
    };
    const resolver = new ParameterResolver(undefined, { schemaConversion: { maxNodes: 1000, sharedBudget: { nodes: 0, maxNodes: 100 } } });
    expect(() => resolver.resolve(operation as never, [])).toThrow(SchemaError);
  });

  it('an operation whose parameters together exceed the budget is cut shallower', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(manyParametersDocument(30, 1000));
    const [tool] = await generator.generateTools();
    expect(Object.keys(tool.inputSchema.properties ?? {})).toHaveLength(30);
    expect(generator.getDiagnostics().map((diagnostic) => diagnostic.code)).toContain('SCHEMA_DEPTH_REDUCED');
  });

  it('an operation whose parameters cannot fit even at depth 1 fails fast instead of exhausting memory', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(manyParametersDocument(2000, 5000));
    const started = Date.now();
    await expect(generator.generateTool('/p', 'get')).rejects.toThrow(/node budget/);
    expect(Date.now() - started).toBeLessThan(4000);
  }, 30000);
});

describe('maxTotalSchemaNodes', () => {
  it('stops generation once the tools hold more schema nodes than allowed', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(manyOperationsDocument(20, 200));
    const failure = await generator.generateTools({ maxTotalSchemaNodes: 2000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SchemaError);
    expect((failure as SchemaError).message).toMatch(/maxTotalSchemaNodes/);
    expect((failure as SchemaError).context).toMatchObject({ maxTotalSchemaNodes: 2000 });
  });

  it('allows a tool set within the limit', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(manyOperationsDocument(3, 20));
    await expect(generator.generateTools({ maxTotalSchemaNodes: 100_000 })).resolves.toHaveLength(3);
  });

  it('is unlimited by default', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(manyOperationsDocument(20, 200));
    await expect(generator.generateTools()).resolves.toHaveLength(20);
  });

  it(`defaults to ${SECURE_MAX_TOTAL_SCHEMA_NODES} under secureDefaults, and an explicit value wins`, () => {
    expect(resolveMaxTotalSchemaNodes(undefined, true)).toBe(SECURE_MAX_TOTAL_SCHEMA_NODES);
    expect(resolveMaxTotalSchemaNodes(7, true)).toBe(7);
    expect(resolveMaxTotalSchemaNodes(undefined, false)).toBe(Infinity);
  });

  it('applies the secureDefaults value to generation', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(manyOperationsDocument(2, 2), { secureDefaults: true });
    await expect(generator.generateTools()).resolves.toHaveLength(2);
  });

  it.each([Number.NaN, 'many', {}, -5, 0])('reads %p as unlimited', (value) => {
    expect(resolveMaxTotalSchemaNodes(value, true)).toBe(Infinity);
  });

  it('counts a streamed response item schema', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.2.0',
      info: { title: 't', version: '1' },
      paths: {
        '/events': {
          get: {
            operationId: 'events',
            responses: {
              200: {
                description: 'ok',
                content: { 'text/event-stream': { itemSchema: objectSchema(50) } },
              },
            },
          },
        },
      },
    });
    await expect(generator.generateTools({ maxTotalSchemaNodes: 20 })).rejects.toThrow(/maxTotalSchemaNodes/);
  });

  it('a too large tool set fails generateTool too', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(manyOperationsDocument(1, 200));
    await expect(generator.generateTool('/r0', 'get', { maxTotalSchemaNodes: 50 })).rejects.toThrow(
      /maxTotalSchemaNodes/,
    );
  });
});

describe('limit options of the wrong type fall back to the default', () => {
  it.each(['abc', {}, [1, 2], null, true])('maxSchemaNodes %p', (value) => {
    expect(resolveSchemaLimits({ maxSchemaNodes: value as number }).maxNodes).toBe(DEFAULT_MAX_SCHEMA_NODES);
  });

  const unusableLengths = [Number.NaN, 'abc', {}, null, 0, 0.5, -3];
  it.each(unusableLengths)('maxToolNameLength %p keeps names within 64 characters', async (value) => {
    const generator = await OpenAPIToolGenerator.fromJSON({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: { '/p': { get: { operationId: 'x'.repeat(300), responses: { 200: { description: 'ok' } } } } },
    });
    const [tool] = await generator.generateTools({ maxToolNameLength: value as number });
    expect(tool.name.length).toBeLessThanOrEqual(64);
  });
});
