import { fromArazzo } from '../arazzo';
import { ArazzoError, OverlayError, RequestBuildError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import { applyOverlay } from '../overlay';
import { buildHttpRequest } from '../request-builder';
import type { McpOpenAPITool, ParameterMapper } from '../types';

const ok = { 200: { description: 'ok' } };

function petsSource(responseProperties = 1): Record<string, unknown> {
  const properties = Object.fromEntries(
    Array.from({ length: responseProperties }, (_, index) => [`p${index}`, { type: 'string' }]),
  );
  return {
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1' },
    servers: [{ url: 'https://pets.example.test' }],
    paths: {
      '/pets/{id}': {
        get: {
          operationId: 'getPet',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties } } } },
          },
        },
      },
    },
  };
}

const workflow = (workflowId: string, extra: Record<string, unknown> = {}) => ({
  workflowId,
  steps: [
    {
      stepId: 'fetch',
      operationId: 'getPet',
      parameters: [{ name: 'id', in: 'path', value: '1' }],
      outputs: { pet: '$response.body' },
    },
  ],
  ...extra,
});

const arazzo = (workflows: unknown[], extra: Record<string, unknown> = {}) => ({
  arazzo: '1.0.0',
  info: { title: 'Flows', version: '1' },
  sourceDescriptions: [{ name: 'pets', url: 'https://x.example.test/pets.json' }],
  workflows,
  ...extra,
});

/** Whether `root` reaches one object twice, which a JSON copy would write twice */
function sharesAnObject(root: unknown): boolean {
  const seen = new Set<object>();
  const stack = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value !== 'object' || value === null) continue;
    if (seen.has(value)) return true;
    seen.add(value);
    stack.push(...Object.values(value));
  }
  return false;
}

describe('fromArazzo stays bounded', () => {
  it('resolves a chain of inputs that each reference the previous one twice, once per input', async () => {
    const inputs: Record<string, unknown> = { i0: { type: 'string' } };
    for (let index = 1; index <= 30; index++) {
      const previous = { $ref: `#/components/inputs/i${index - 1}` };
      inputs[`i${index}`] = { type: 'object', properties: { a: previous, b: previous } };
    }
    const document = arazzo([workflow('chain', { inputs: { $ref: '#/components/inputs/i30' } })], {
      components: { inputs },
    });
    const started = Date.now();
    const [tool] = await fromArazzo(document, { sources: { pets: petsSource() } });
    expect(Date.now() - started).toBeLessThan(500);
    expect(tool.inputSchema).toMatchObject({ type: 'object', properties: { a: { type: 'object' } } });
    expect(sharesAnObject(tool.metadata.workflow?.inputSchema)).toBe(false);
  });

  it('still refuses a cycle of inputs', async () => {
    const inputs = {
      a: { type: 'object', properties: { b: { $ref: '#/components/inputs/b' } } },
      b: { type: 'object', properties: { a: { $ref: '#/components/inputs/a' } } },
    };
    const document = arazzo([workflow('cycle', { inputs: { $ref: '#/components/inputs/a' } })], {
      components: { inputs },
    });
    await expect(fromArazzo(document, { sources: { pets: petsSource() } })).rejects.toThrow(/Cyclic workflow inputs/);
  });

  it('derives thousands of outputs returning one large schema without copying it for each', async () => {
    const outputs = Object.fromEntries(
      Array.from({ length: 4000 }, (_, index) => [`o${index}`, '$steps.fetch.outputs.pet']),
    );
    const document = arazzo([workflow('many', { outputs })]);
    const heapBefore = process.memoryUsage().heapUsed;
    const started = Date.now();
    const [tool] = await fromArazzo(document, { sources: { pets: petsSource(3000) } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(300 * 1024 * 1024);
    expect(Object.keys(tool.outputSchema?.properties ?? {})).toHaveLength(4000);
  });

  it('gives up deduplicating a tool name once the name space under a tiny cap is exhausted', async () => {
    const document = arazzo(Array.from({ length: 18 }, (_, index) => workflow(`w${index}`)));
    await expect(
      fromArazzo(document, { sources: { pets: petsSource() }, generateOptions: { maxToolNameLength: 1 } }),
    ).rejects.toThrow(ArazzoError);
  });
});

describe('overlay targets with recursive descent', () => {
  function nested(depth: number): Record<string, unknown> {
    let schema: Record<string, unknown> = { type: 'string', description: 'leaf' };
    for (let level = 0; level < depth; level++)
      schema = { type: 'object', properties: { a: schema }, description: 'd' };
    return {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {},
      components: { schemas: { Deep: schema } },
    };
  }

  const overlay = (target: string) => ({
    overlay: '1.0.0',
    info: { title: 'o', version: '1' },
    actions: [{ target, update: { 'x-seen': true } }],
  });

  it('walks every node once for three recursive segments over a deep document', () => {
    const heapBefore = process.memoryUsage().heapUsed;
    const started = Date.now();
    const result = applyOverlay(nested(1000), overlay('$..properties..properties..properties..a'));
    expect(Date.now() - started).toBeLessThan(300);
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(100 * 1024 * 1024);
    expect(JSON.stringify(result)).toContain('"x-seen":true');
  });

  it('applies to a document deeper than the call stack, or refuses it as an OverlayError', () => {
    let outcome: unknown;
    try {
      outcome = applyOverlay(nested(5000), overlay('$..a'));
    } catch (error) {
      outcome = error;
    }
    expect(outcome instanceof RangeError).toBe(false);
    if (outcome instanceof Error) expect(outcome).toBeInstanceOf(OverlayError);
  });

  it('refuses a document that is not plain JSON without quoting it', () => {
    const document: Record<string, unknown> = { openapi: '3.0.3' };
    document['\u202Eloop'] = document;
    expect(() => applyOverlay(document, overlay('$.openapi'))).toThrow(
      new OverlayError('The document cannot be copied to apply the overlay: it holds a cycle, a value JSON cannot hold, or nesting too deep', {}),
    );
  });
});

describe('excludeMethods names an additional method in any case', () => {
  const document = {
    openapi: '3.2.0',
    info: { title: 't', version: '1' },
    paths: {
      '/cache': {
        get: { operationId: 'read', responses: ok },
        additionalOperations: {
          PURGE: { operationId: 'purgeUpper', responses: ok },
          Purge: { operationId: 'purgeMixed', responses: ok },
          purge: { operationId: 'purgeLower', responses: ok },
        },
      },
    },
  };

  it('excludes every spelling of an excluded method', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document);
    const tools = await generator.generateTools({ excludeMethods: ['PURGE'] });
    expect(tools.map((tool) => tool.name)).toEqual(['read']);
  });

  it('includes an additional method only as written', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document);
    const tools = await generator.generateTools({ includeMethods: ['PURGE'] });
    expect(tools.map((tool) => tool.name)).toEqual(['purgeUpper']);
  });
});

describe('an input-chosen query name cannot be read as a reserved one', () => {
  const tool = (mapper: ParameterMapper[]): McpOpenAPITool =>
    ({
      name: 't',
      inputSchema: { type: 'object', properties: {} },
      mapper,
      metadata: { path: '/items', method: 'get', servers: [{ url: 'https://api.example.test' }] },
    }) as never;
  const items = tool([
    { inputKey: 'filter', type: 'query', key: 'filter', style: 'form', explode: true },
    { inputKey: 'role', type: 'query', key: 'role' },
    {
      inputKey: 'apiKey',
      type: 'query',
      key: 'api_key',
      required: true,
      security: { scheme: 'key', type: 'apiKey', apiKeyName: 'api_key', apiKeyIn: 'query' },
    },
  ] as ParameterMapper[]);

  it.each([{ 'api_key[]': 'x' }, { 'api_key[x]': 'y' }, { API_KEY: 'x' }, { 'role[]': 'admin' }])(
    'refuses %p',
    (filter) => {
      expect(() => buildHttpRequest(items, { filter, apiKey: 'SYNTH-KEY' })).toThrow(RequestBuildError);
    },
  );

  it('still builds a name that only starts like a reserved one', () => {
    const built = buildHttpRequest(items, { filter: { api_keys: 'x', Role: 'y' }, apiKey: 'SYNTH-KEY' });
    expect(built.url).toBe('https://api.example.test/items?api_keys=x&Role=y&api_key=SYNTH-KEY');
  });
});
