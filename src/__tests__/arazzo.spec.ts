/** Tests for fromArazzo() and Arazzo runtime-expression parsing */
import { fromArazzo } from '../arazzo';
import { collectPayloadExpressions, parseExpressionValue, parseRuntimeExpression } from '../arazzo-expressions';
import { ArazzoError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import * as yaml from 'yaml';
import type { OperationStepIR, NestedWorkflowStepIR } from '../arazzo-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const petstoreDoc = (): any => ({
  openapi: '3.0.0',
  info: { title: 'Pets', version: '1.0.0' },
  servers: [{ url: 'https://pets.example.com' }],
  components: { securitySchemes: { petAuth: { type: 'http', scheme: 'bearer' } } },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createPet',
        security: [{ petAuth: [] }],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPet',
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    owner: { type: 'object', properties: { email: { type: 'string' } } },
                    photos: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

const ordersDoc = (): any => ({
  openapi: '3.0.0',
  info: { title: 'Orders', version: '1.0.0' },
  paths: {
    '/orders/{id}': {
      get: {
        operationId: 'getOrder',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/shared': { get: { operationId: 'sharedOp', responses: { '200': { description: 'OK' } } } },
  },
});

// sharedOp exists in both sources for ambiguity tests
const petstoreWithShared = (): any => {
  const doc = petstoreDoc();
  doc.paths['/shared'] = { get: { operationId: 'sharedOp', responses: { '200': { description: 'OK' } } } };
  return doc;
};

const arazzoWith = (workflows: any[], extra: any = {}): any => ({
  arazzo: '1.0.0',
  info: { title: 'Flows', version: '1.0.0' },
  sourceDescriptions: [
    { name: 'pets', url: 'https://x/pets.json' },
    { name: 'orders', url: 'https://x/orders.json' },
  ],
  workflows,
  ...extra,
});

const simpleWorkflow = (overrides: any = {}): any => ({
  workflowId: 'getPetFlow',
  summary: 'Get a pet',
  description: 'Fetch one pet by id.',
  inputs: { type: 'object', properties: { petId: { type: 'string' } }, required: ['petId'] },
  steps: [
    {
      stepId: 'fetch',
      operationId: 'getPet',
      parameters: [{ name: 'petId', in: 'path', value: '$inputs.petId' }],
      outputs: { pet: '$response.body' },
    },
  ],
  outputs: { pet: '$steps.fetch.outputs.pet' },
  ...overrides,
});

const sources = () => ({ pets: petstoreDoc(), orders: ordersDoc() });

const expectArazzoError = async (promise: Promise<unknown>, match: RegExp, path?: string): Promise<void> => {
  await expect(promise).rejects.toThrow(ArazzoError);
  await promise.catch((error: ArazzoError) => {
    expect(error.message).toMatch(match);
    if (path !== undefined) {
      expect(error.path).toBe(path);
    }
  });
};

describe('parseRuntimeExpression', () => {
  it('parses every expression root structurally', () => {
    expect(parseRuntimeExpression('$url')).toEqual({ type: 'url', raw: '$url', path: [] });
    expect(parseRuntimeExpression('$method')).toEqual({ type: 'method', raw: '$method', path: [] });
    expect(parseRuntimeExpression('$statusCode')).toEqual({ type: 'statusCode', raw: '$statusCode', path: [] });
    expect(parseRuntimeExpression('$request.header.Accept')).toEqual({
      type: 'request',
      raw: '$request.header.Accept',
      path: [],
      source: 'header',
      name: 'Accept',
    });
    expect(parseRuntimeExpression('$request.query.limit')).toEqual({
      type: 'request',
      raw: '$request.query.limit',
      path: [],
      source: 'query',
      name: 'limit',
    });
    expect(parseRuntimeExpression('$request.path.petId')).toEqual({
      type: 'request',
      raw: '$request.path.petId',
      path: [],
      source: 'path',
      name: 'petId',
    });
    expect(parseRuntimeExpression('$response.body')).toEqual({ type: 'response', raw: '$response.body', path: [], source: 'body' });
    expect(parseRuntimeExpression('$response.body#/a~1b/0')).toEqual({
      type: 'response',
      raw: '$response.body#/a~1b/0',
      path: [],
      source: 'body',
      pointer: '/a~1b/0',
    });
    expect(parseRuntimeExpression('$response.body#')).toEqual({
      type: 'response',
      raw: '$response.body#',
      path: [],
      source: 'body',
      pointer: '',
    });
    expect(parseRuntimeExpression('$inputs.petId')).toEqual({ type: 'inputs', raw: '$inputs.petId', path: ['petId'] });
    expect(parseRuntimeExpression('$outputs.result')).toEqual({ type: 'outputs', raw: '$outputs.result', path: ['result'] });
    expect(parseRuntimeExpression('$steps.s1.outputs.id')).toEqual({
      type: 'steps',
      raw: '$steps.s1.outputs.id',
      path: ['s1', 'outputs', 'id'],
    });
    expect(parseRuntimeExpression('$workflows.w1.outputs.x')).toEqual({
      type: 'workflows',
      raw: '$workflows.w1.outputs.x',
      path: ['w1', 'outputs', 'x'],
    });
    expect(parseRuntimeExpression('$sourceDescriptions.pets.url')).toEqual({
      type: 'sourceDescriptions',
      raw: '$sourceDescriptions.pets.url',
      path: ['pets', 'url'],
    });
    expect(parseRuntimeExpression('$components.parameters.page')).toEqual({
      type: 'components',
      raw: '$components.parameters.page',
      path: ['parameters', 'page'],
    });
  });

  it('rejects malformed expressions with the document path attached', () => {
    for (const bad of ['$urlx', '$url.extra', '$respons.body', '$request.body#x', '$request.cookie.x', '$steps.', '$steps..x', '$steps.a b', '$request.header.', '$request.header.bad name', '$request.query.', '', 'plain', '$']) {
      expect(() => parseRuntimeExpression(bad, '/at')).toThrow(ArazzoError);
    }
    try {
      parseRuntimeExpression('$steps.', '/workflows/0/outputs/x');
    } catch (error) {
      expect((error as ArazzoError).path).toBe('/workflows/0/outputs/x');
    }
  });
});

describe('parseExpressionValue', () => {
  it('classifies literals, expressions, and templates', () => {
    expect(parseExpressionValue(42)).toEqual({ kind: 'literal', value: 42 });
    expect(parseExpressionValue(null)).toEqual({ kind: 'literal', value: null });
    expect(parseExpressionValue('plain')).toEqual({ kind: 'literal', value: 'plain' });
    expect(parseExpressionValue('$50')).toEqual({ kind: 'literal', value: '$50' });
    expect(parseExpressionValue('has { braces } but no dollar')).toEqual({
      kind: 'literal',
      value: 'has { braces } but no dollar',
    });
    expect(parseExpressionValue('$inputs.a')).toEqual({
      kind: 'expression',
      expression: { type: 'inputs', raw: '$inputs.a', path: ['a'] },
    });
    const template = parseExpressionValue('Bearer {$inputs.token} end');
    expect(template).toEqual({
      kind: 'template',
      raw: 'Bearer {$inputs.token} end',
      parts: ['Bearer ', { type: 'inputs', raw: '$inputs.token', path: ['token'] }, ' end'],
    });
    const backToBack = parseExpressionValue('{$inputs.a}{$inputs.b}');
    expect((backToBack as any).parts).toHaveLength(2);
  });

  it('rejects known-root strings that fail to parse and unterminated templates', () => {
    expect(() => parseExpressionValue('$inputs.')).toThrow(ArazzoError);
    expect(() => parseExpressionValue('x {$inputs.a')).toThrow(ArazzoError);
  });
});

describe('collectPayloadExpressions', () => {
  it('locates expressions by RFC 6901 pointer with escaped keys', () => {
    const payload = {
      'a/b': '$inputs.slash',
      'c~d': { deep: 'Bearer {$inputs.token}' },
      list: ['plain', '$statusCode'],
      literal: '$50',
      count: 3,
    };
    const found = collectPayloadExpressions(payload);
    expect(found.map((f) => f.pointer)).toEqual(['/a~1b', '/c~0d/deep', '/list/1']);
  });

  it('treats a whole-string payload as pointer ""', () => {
    const found = collectPayloadExpressions('$inputs.body');
    expect(found).toEqual([
      { pointer: '', value: { kind: 'expression', expression: { type: 'inputs', raw: '$inputs.body', path: ['body'] } } },
    ]);
    expect(collectPayloadExpressions(undefined)).toEqual([]);
    expect(collectPayloadExpressions(7)).toEqual([]);
  });
});

describe('fromArazzo happy path', () => {
  it('builds one consolidated tool per workflow with an executor-ready IR', async () => {
    const tools = await fromArazzo(arazzoWith([simpleWorkflow()]), { sources: sources() });
    expect(tools).toHaveLength(1);
    const tool = tools[0];

    expect(tool.name).toBe('getPetFlow');
    expect(tool.title).toBe('Get a pet');
    expect(tool.description).toBe('Get a pet\n\nFetch one pet by id.');
    expect(tool.mapper).toEqual([]);
    expect(tool.metadata.path).toBe('arazzo:getPetFlow');
    expect(tool.metadata.method).toBe('post');
    expect(tool.metadata.operationId).toBe('getPetFlow');
    expect((tool.inputSchema as any).properties.petId).toEqual({ type: 'string' });

    const ir = tool.metadata.workflow!;
    expect(ir.arazzoVersion).toBe('1.0.0');
    expect(ir.workflowId).toBe('getPetFlow');
    expect(ir.steps).toHaveLength(1);
    const step = ir.steps[0] as OperationStepIR;
    expect(step.kind).toBe('operation');
    expect(step.source).toBe('pets');
    expect(step.path).toBe('/pets/{petId}');
    expect(step.method).toBe('get');
    expect(step.operationId).toBe('getPet');
    expect(step.parameters).toEqual([
      { name: 'petId', in: 'path', value: { kind: 'expression', expression: { type: 'inputs', raw: '$inputs.petId', path: ['petId'] } } },
    ]);
    expect(step.outputs?.pet).toEqual({ type: 'response', raw: '$response.body', path: [], source: 'body' });

    // Embedded operation essentials match a direct generateTool call
    const generator = await OpenAPIToolGenerator.fromJSON(petstoreDoc());
    const direct = await generator.generateTool('/pets/{petId}', 'get');
    expect(step.operation.inputSchema).toEqual(direct.inputSchema);
    expect(step.operation.mapper).toEqual(direct.mapper);
    expect(step.operation.outputSchema).toEqual(direct.outputSchema);
    expect(step.operation.servers).toEqual(direct.metadata.servers);

    // Output schema derived from the chased step output ($response.body)
    const outProps = (tool.outputSchema as any).properties;
    expect(outProps.pet.description).toBe('Arazzo output: $steps.fetch.outputs.pet');
    expect(outProps.pet.properties.id).toEqual({ type: 'string' });

    // Read-only workflow (single GET) gets safe annotations
    expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it('accepts YAML input and produces output identical to the object form', async () => {
    const doc = arazzoWith([simpleWorkflow()]);
    const fromObject = await fromArazzo(doc, { sources: sources() });
    const fromYaml = await fromArazzo(yaml.stringify(doc), { sources: sources() });
    expect(fromYaml).toEqual(fromObject);
  });

  it('is deterministic, document-ordered, and JSON-serializable', async () => {
    const second = simpleWorkflow({ workflowId: 'zeta', outputs: undefined, steps: [{ stepId: 's', operationId: 'listPets' }] });
    const doc = arazzoWith([simpleWorkflow({ workflowId: 'omega' }), second]);
    const first = await fromArazzo(doc, { sources: sources() });
    const again = await fromArazzo(doc, { sources: sources() });
    expect(first.map((t) => t.name)).toEqual(['omega', 'zeta']);
    expect(again).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('accepts pre-built generators and normalizes workflow inputs (nullable)', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(petstoreDoc());
    const workflow = simpleWorkflow({
      inputs: { type: 'object', properties: { petId: { type: 'string', nullable: true } }, required: ['petId'] },
      outputs: undefined,
    });
    const [tool] = await fromArazzo(arazzoWith([workflow]), { sources: { pets: generator } });
    expect((tool.inputSchema as any).properties.petId).toEqual({ type: ['string', 'null'] });
    expect(tool.outputSchema).toBeUndefined();
  });

  it('defaults the input schema when the workflow declares no inputs', async () => {
    const workflow = simpleWorkflow({ inputs: undefined, outputs: undefined });
    workflow.steps[0].parameters = [{ name: 'petId', in: 'path', value: 'fixed' }];
    const [tool] = await fromArazzo(arazzoWith([workflow]), { sources: sources() });
    expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
    expect(tool.metadata.workflow!.inputSchema).toBeUndefined();
  });

  it('omits annotations for mixed-method and nested-workflow flows and unions security', async () => {
    const mixed = arazzoWith([
      simpleWorkflow({
        workflowId: 'mixed',
        outputs: undefined,
        steps: [
          { stepId: 'a', operationId: 'getPet', parameters: [{ name: 'petId', in: 'path', value: 'x' }] },
          { stepId: 'b', operationId: 'createPet' },
          { stepId: 'b2', operationId: 'createPet' },
        ],
      }),
      simpleWorkflow({ workflowId: 'nested', outputs: undefined, steps: [{ stepId: 'n', workflowId: 'mixed' }] }),
    ]);
    const tools = await fromArazzo(mixed, { sources: sources() });
    expect(tools[0].annotations).toBeUndefined();
    expect(tools[0].metadata.security).toHaveLength(1);
    expect(tools[0].metadata.security![0]).toMatchObject({ scheme: 'petAuth', type: 'http', httpScheme: 'bearer' });
    expect(tools[1].annotations).toBeUndefined();
    expect(tools[1].metadata.security).toBeUndefined();
    const nestedStep = tools[1].metadata.workflow!.steps[0] as NestedWorkflowStepIR;
    expect(nestedStep).toEqual({ kind: 'workflow', workflowId: 'mixed', stepId: 'n' });
  });

  it('dedupes tool names that normalize identically', async () => {
    const doc = arazzoWith([
      simpleWorkflow({ workflowId: 'flow', outputs: undefined }),
      simpleWorkflow({ workflowId: '_flow', outputs: undefined }),
    ]);
    const tools = await fromArazzo(doc, { sources: sources() });
    expect(tools[0].name).toBe('flow');
    expect(tools[1].name).toMatch(/^flow_[0-9a-f]{8}$/);
  });

  it('applies generateOptions to consolidated and embedded schemas including type signatures', async () => {
    const workflow = simpleWorkflow();
    const [tool] = await fromArazzo(arazzoWith([workflow]), {
      sources: sources(),
      generateOptions: { target: 'gemini', stripExamples: true, emitTypeSignatures: true, maxSchemaDepth: 4 },
    });
    expect(tool.metadata.typescript?.signature).toContain('petId: string');
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    // gemini target inlines/normalizes — embedded schema equals a direct call with the same options
    const generator = await OpenAPIToolGenerator.fromJSON(petstoreDoc());
    const direct = await generator.generateTool('/pets/{petId}', 'get', {
      target: 'gemini',
      stripExamples: true,
      emitTypeSignatures: true,
      maxSchemaDepth: 4,
    });
    expect(step.operation.inputSchema).toEqual(direct.inputSchema);
  });
});

describe('fromArazzo input parsing errors', () => {
  it('rejects invalid YAML, non-object documents, and null input', async () => {
    await expectArazzoError(fromArazzo('{{{{:::', { sources: {} }), /Failed to parse Arazzo document/);
    await expectArazzoError(fromArazzo('42', { sources: {} }), /must be an object/);
    await expectArazzoError(fromArazzo(null as any, { sources: {} }), /must be an object/);
  });
});

describe('fromArazzo structural validation', () => {
  const base = () => arazzoWith([simpleWorkflow()]);

  const cases: Array<{ label: string; mutate: (doc: any) => void; match: RegExp; path?: string }> = [
    { label: 'bad version', mutate: (d) => (d.arazzo = '2.0.0'), match: /Unsupported arazzo version/, path: '/arazzo' },
    { label: 'missing info title', mutate: (d) => delete d.info.title, match: /"info" requires/, path: '/info' },
    { label: 'empty sourceDescriptions', mutate: (d) => (d.sourceDescriptions = []), match: /non-empty array/, path: '/sourceDescriptions' },
    { label: 'bad source name', mutate: (d) => (d.sourceDescriptions[0].name = 'has space'), match: /matching \[A-Za-z0-9_-\]\+/ },
    { label: 'missing source url', mutate: (d) => delete d.sourceDescriptions[0].url, match: /requires a string "url"/ },
    { label: 'bad source type', mutate: (d) => (d.sourceDescriptions[0].type = 'graphql'), match: /invalid type/ },
    { label: 'duplicate source names', mutate: (d) => (d.sourceDescriptions[1].name = 'pets'), match: /Duplicate source description name/ },
    { label: 'empty workflows', mutate: (d) => (d.workflows = []), match: /"workflows" must be a non-empty array/ },
    { label: 'bad workflowId', mutate: (d) => (d.workflows[0].workflowId = 'no good'), match: /workflowId/ },
    { label: 'empty steps', mutate: (d) => (d.workflows[0].steps = []), match: /non-empty "steps"/ },
    { label: 'bad stepId', mutate: (d) => (d.workflows[0].steps[0].stepId = ''), match: /stepId/ },
    { label: 'two step kinds', mutate: (d) => (d.workflows[0].steps[0].workflowId = 'x'), match: /exactly one of/ },
    { label: 'zero step kinds', mutate: (d) => delete d.workflows[0].steps[0].operationId, match: /exactly one of/ },
    { label: 'parameters not array', mutate: (d) => (d.workflows[0].steps[0].parameters = 'nope'), match: /must be an array/ },
    { label: 'parameter not object', mutate: (d) => (d.workflows[0].steps[0].parameters = [7]), match: /Parameter must be an object/ },
    { label: 'parameter missing name', mutate: (d) => (d.workflows[0].steps[0].parameters = [{ value: 1 }]), match: /non-empty string "name"/ },
    { label: 'parameter missing value', mutate: (d) => (d.workflows[0].steps[0].parameters = [{ name: 'a', in: 'query' }]), match: /requires a "value"/ },
    { label: 'bad parameter location', mutate: (d) => (d.workflows[0].steps[0].parameters = [{ name: 'a', in: 'body', value: 1 }]), match: /Invalid parameter location/ },
    { label: 'operation param missing in', mutate: (d) => (d.workflows[0].steps[0].parameters = [{ name: 'a', value: 1 }]), match: /requires "in"/ },
    { label: 'duplicate parameters', mutate: (d) => (d.workflows[0].steps[0].parameters = [{ name: 'a', in: 'query', value: 1 }, { name: 'a', in: 'query', value: 2 }]), match: /Duplicate parameter/ },
    { label: 'criteria not array', mutate: (d) => (d.workflows[0].steps[0].successCriteria = 'x'), match: /must be an array/ },
    { label: 'criterion not object', mutate: (d) => (d.workflows[0].steps[0].successCriteria = [1]), match: /Criterion must be an object/ },
    { label: 'criterion missing condition', mutate: (d) => (d.workflows[0].steps[0].successCriteria = [{}]), match: /non-empty string "condition"/ },
    { label: 'unknown criterion type', mutate: (d) => (d.workflows[0].steps[0].successCriteria = [{ condition: 'x', type: 'fancy' }]), match: /Unknown criterion type/ },
    { label: 'bad criterion type object', mutate: (d) => (d.workflows[0].steps[0].successCriteria = [{ condition: 'x', type: { type: 'jsonpath' } }]), match: /requires "type" \(jsonpath\|xpath\) and "version"/ },
    { label: 'criterion type wrong shape', mutate: (d) => (d.workflows[0].steps[0].successCriteria = [{ condition: 'x', type: 42 }]), match: /must be a string or a Criterion Expression Type Object/ },
    { label: 'typed criterion missing context', mutate: (d) => (d.workflows[0].steps[0].successCriteria = [{ condition: 'x', type: 'regex' }]), match: /requires a "context" expression/ },
    { label: 'actions not array', mutate: (d) => (d.workflows[0].steps[0].onSuccess = 'x'), match: /Actions must be an array/ },
    { label: 'action not object', mutate: (d) => (d.workflows[0].steps[0].onSuccess = [null]), match: /Action must be an object/ },
    { label: 'action missing name', mutate: (d) => (d.workflows[0].steps[0].onSuccess = [{ type: 'end' }]), match: /non-empty string "name"/ },
    { label: 'success action retry', mutate: (d) => (d.workflows[0].steps[0].onSuccess = [{ name: 'r', type: 'retry' }]), match: /Invalid success-action type/ },
    { label: 'goto both targets', mutate: (d) => (d.workflows[0].steps[0].onFailure = [{ name: 'g', type: 'goto', workflowId: 'a', stepId: 'b' }]), match: /exactly one of "workflowId" or "stepId"/ },
    { label: 'goto no target', mutate: (d) => (d.workflows[0].steps[0].onFailure = [{ name: 'g', type: 'goto' }]), match: /exactly one of/ },
    { label: 'end with target', mutate: (d) => (d.workflows[0].steps[0].onSuccess = [{ name: 'e', type: 'end', stepId: 's' }]), match: /must not specify/ },
    { label: 'negative retryAfter', mutate: (d) => (d.workflows[0].steps[0].onFailure = [{ name: 'r', type: 'retry', retryAfter: -1 }]), match: /non-negative number/ },
    { label: 'fractional retryLimit', mutate: (d) => (d.workflows[0].steps[0].onFailure = [{ name: 'r', type: 'retry', retryLimit: 1.5 }]), match: /non-negative integer/ },
    { label: 'bad action criteria', mutate: (d) => (d.workflows[0].steps[0].onFailure = [{ name: 'r', type: 'end', criteria: [{ type: 'simple' }] }]), match: /non-empty string "condition"/ },
    { label: 'outputs not object', mutate: (d) => (d.workflows[0].outputs = ['x']), match: /must be an object/ },
    { label: 'bad output name', mutate: (d) => (d.workflows[0].outputs = { 'no space': '$url' }), match: /Invalid output name/ },
    { label: 'non-string output', mutate: (d) => (d.workflows[0].outputs = { x: 42 }), match: /must be a runtime expression string/ },
    { label: 'workflow param with in on workflow step', mutate: (d) => {
      d.workflows[0].steps[0] = { stepId: 'n', workflowId: 'getPetFlow', parameters: [{ name: 'a', in: 'query', value: 1 }] };
    }, match: /must not specify "in"/ },
  ];

  it.each(cases)('rejects $label', async ({ mutate, match, path }) => {
    const doc = base();
    mutate(doc);
    await expectArazzoError(fromArazzo(doc, { sources: sources() }), match, path);
  });

  it('rejects duplicate workflowIds and stepIds', async () => {
    const dupWf = arazzoWith([simpleWorkflow(), simpleWorkflow()]);
    await expectArazzoError(fromArazzo(dupWf, { sources: sources() }), /Duplicate workflowId/, '/workflows/1');

    const dupStep = base();
    dupStep.workflows[0].steps.push({ ...dupStep.workflows[0].steps[0] });
    await expectArazzoError(fromArazzo(dupStep, { sources: sources() }), /Duplicate stepId/);
  });
});

describe('fromArazzo components resolution', () => {
  it('inlines reusable parameters with value overrides and reusable actions', async () => {
    const doc = arazzoWith(
      [
        simpleWorkflow({
          outputs: undefined,
          steps: [
            {
              stepId: 'fetch',
              operationId: 'getPet',
              parameters: [{ reference: '$components.parameters.petParam', value: '$inputs.petId' }],
              onFailure: [{ reference: '$components.failureActions.giveUp' }],
            },
          ],
          failureActions: [{ reference: '$components.failureActions.giveUp' }],
        }),
      ],
      {
        components: {
          parameters: { petParam: { name: 'petId', in: 'path', value: 'default' } },
          failureActions: { giveUp: { name: 'giveUp', type: 'retry', retryAfter: 5, retryLimit: 2, criteria: [{ condition: '$statusCode == 503', context: '$statusCode', type: 'regex' }] } },
        },
      },
    );
    const [tool] = await fromArazzo(doc, { sources: sources() });
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    expect(step.parameters).toEqual([
      { name: 'petId', in: 'path', value: { kind: 'expression', expression: { type: 'inputs', raw: '$inputs.petId', path: ['petId'] } } },
    ]);
    expect(step.onFailure).toEqual([
      {
        name: 'giveUp',
        kind: 'failure',
        type: 'retry',
        retryAfter: 5,
        retryLimit: 2,
        criteria: [
          { condition: '$statusCode == 503', context: { type: 'statusCode', raw: '$statusCode', path: [] }, type: 'regex' },
        ],
      },
    ]);
    expect(tool.metadata.workflow!.failureActions).toHaveLength(1);
  });

  it('resolves components.inputs $refs so the IR is self-contained', async () => {
    const doc = arazzoWith(
      [
        simpleWorkflow({
          inputs: {
            type: 'object',
            properties: { petId: { $ref: '#/components/inputs/petIdInput' } },
            required: ['petId'],
          },
          outputs: undefined,
        }),
      ],
      { components: { inputs: { petIdInput: { type: 'string', description: 'A pet id' } } } },
    );
    const [tool] = await fromArazzo(doc, { sources: sources() });
    expect((tool.inputSchema as any).properties.petId).toEqual({ type: 'string', description: 'A pet id' });
    expect(JSON.stringify(tool)).not.toContain('$ref');
  });

  it('rejects unknown, cyclic, wrong-group, and malformed references', async () => {
    const withInputs = (inputs: any, components: any = {}) =>
      arazzoWith([simpleWorkflow({ inputs, outputs: undefined })], { components });

    await expectArazzoError(
      fromArazzo(withInputs({ $ref: '#/components/inputs/missing' }), { sources: sources() }),
      /Unknown workflow inputs reference/,
    );
    await expectArazzoError(
      fromArazzo(withInputs({ $ref: '#/definitions/x' }), { sources: sources() }),
      /Unsupported \$ref/,
    );
    await expectArazzoError(
      fromArazzo(
        withInputs({ $ref: '#/components/inputs/a' }, { inputs: { a: { $ref: '#/components/inputs/a' } } }),
        { sources: sources() },
      ),
      /Cyclic workflow inputs reference/,
    );

    const badGroup = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 'f', operationId: 'getPet', parameters: [{ reference: '$components.successActions.x' }] }],
      }),
    ]);
    await expectArazzoError(fromArazzo(badGroup, { sources: sources() }), /must point at \$components\.parameters/);

    const unknownRef = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 'f', operationId: 'getPet', parameters: [{ reference: '$components.parameters.nope' }] }],
      }),
    ]);
    await expectArazzoError(fromArazzo(unknownRef, { sources: sources() }), /Unknown reference/);

    const nonString = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 'f', operationId: 'getPet', parameters: [{ reference: 42 }] }],
      }),
    ]);
    await expectArazzoError(fromArazzo(nonString, { sources: sources() }), /"reference" must be a string/);
  });

  it('never resolves inherited or non-object component members', async () => {
    // Without the own-key guard, `$components.parameters.toString` resolves
    // Object.prototype.toString and crashes in the JSON round-trip
    const inherited = arazzoWith(
      [
        simpleWorkflow({
          outputs: undefined,
          steps: [{ stepId: 'f', operationId: 'getPet', parameters: [{ reference: '$components.parameters.toString' }] }],
        }),
      ],
      { components: { parameters: {} } },
    );
    await expectArazzoError(fromArazzo(inherited, { sources: sources() }), /Unknown reference/);

    const nullish = arazzoWith(
      [
        simpleWorkflow({
          outputs: undefined,
          steps: [{ stepId: 'f', operationId: 'getPet', parameters: [{ reference: '$components.parameters.gone' }] }],
        }),
      ],
      { components: { parameters: { gone: null } } },
    );
    await expectArazzoError(fromArazzo(nullish, { sources: sources() }), /Unknown reference/);

    // `#/components/inputs/constructor` would resolve the inherited Function
    const inputsRef = (name: string, components: any) =>
      arazzoWith([simpleWorkflow({ inputs: { $ref: `#/components/inputs/${name}` }, outputs: undefined })], {
        components,
      });
    await expectArazzoError(
      fromArazzo(inputsRef('constructor', { inputs: {} }), { sources: sources() }),
      /Unknown workflow inputs reference/,
    );
    await expectArazzoError(
      fromArazzo(inputsRef('prim', { inputs: { prim: 'not-a-schema' } }), { sources: sources() }),
      /Unknown workflow inputs reference/,
    );
  });

  it('re-validates action types resolved from components', async () => {
    const doc = arazzoWith(
      [
        simpleWorkflow({
          outputs: undefined,
          steps: [
            { stepId: 'f', operationId: 'getPet', onSuccess: [{ reference: '$components.successActions.retryish' }] },
          ],
        }),
      ],
      { components: { successActions: { retryish: { name: 'r', type: 'retry' } } } },
    );
    await expectArazzoError(fromArazzo(doc, { sources: sources() }), /Invalid success-action type "retry"/);
  });
});

describe('fromArazzo source and operation resolution', () => {
  it('rejects unknown options.sources keys and missing used sources', async () => {
    await expectArazzoError(
      fromArazzo(arazzoWith([simpleWorkflow()]), { sources: { ...sources(), extra: petstoreDoc() } }),
      /not a declared source description/,
    );
    await expectArazzoError(
      fromArazzo(arazzoWith([simpleWorkflow()]), { sources: {} }),
      /not found in any supplied source/,
    );
  });

  it('rejects steps resolving into arazzo-typed sources', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 'f', operationPath: '{$sourceDescriptions.flows.url}#/paths/~1x/get' }],
      }),
    ]);
    doc.sourceDescriptions.push({ name: 'flows', url: 'https://x/flows.yaml', type: 'arazzo' });
    await expectArazzoError(fromArazzo(doc, { sources: sources() }), /nested Arazzo sources are not supported/);
  });

  it('resolves ambiguous operationIds only with a $sourceDescriptions pin', async () => {
    const both = { pets: petstoreWithShared(), orders: ordersDoc() };
    const ambiguous = arazzoWith([
      simpleWorkflow({ outputs: undefined, steps: [{ stepId: 's', operationId: 'sharedOp' }] }),
    ]);
    await expectArazzoError(fromArazzo(ambiguous, { sources: both }), /ambiguous across sources/);

    const pinned = arazzoWith([
      simpleWorkflow({ outputs: undefined, steps: [{ stepId: 's', operationId: '$sourceDescriptions.orders.sharedOp' }] }),
    ]);
    const [tool] = await fromArazzo(pinned, { sources: both });
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    expect(step.source).toBe('orders');
    expect(step.operationId).toBe('sharedOp');
  });

  it('rejects bad operationId pins', async () => {
    const shortPin = arazzoWith([
      simpleWorkflow({ outputs: undefined, steps: [{ stepId: 's', operationId: '$sourceDescriptions.pets' }] }),
    ]);
    await expectArazzoError(fromArazzo(shortPin, { sources: sources() }), /must be \$sourceDescriptions\.<name>\.<operationId>/);

    const missingPin = arazzoWith([
      simpleWorkflow({ outputs: undefined, steps: [{ stepId: 's', operationId: '$sourceDescriptions.pets.getOrder' }] }),
    ]);
    await expectArazzoError(fromArazzo(missingPin, { sources: sources() }), /not found in source "pets"/);

    const missingSourcePin = arazzoWith([
      simpleWorkflow({ outputs: undefined, steps: [{ stepId: 's', operationId: '$sourceDescriptions.orders.getOrder' }] }),
    ]);
    await expectArazzoError(fromArazzo(missingSourcePin, { sources: { pets: petstoreDoc() } }), /No document supplied for source "orders"/);
  });

  it('rejects duplicated operationIds inside one source when pinned', async () => {
    const dupDoc = petstoreDoc();
    dupDoc.paths['/pets2'] = { get: { operationId: 'getPet', responses: { '200': { description: 'OK' } } } };
    const pinned = arazzoWith([
      simpleWorkflow({ outputs: undefined, steps: [{ stepId: 's', operationId: '$sourceDescriptions.pets.getPet' }] }),
    ]);
    await expectArazzoError(fromArazzo(pinned, { sources: { pets: dupDoc, orders: ordersDoc() } }), /duplicated inside source/);
  });

  it('resolves operationPath with pointer escapes', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [
          {
            stepId: 's',
            operationPath: '{$sourceDescriptions.pets.url}#/paths/~1pets~1{petId}/get',
            parameters: [{ name: 'petId', in: 'path', value: 'x' }],
          },
        ],
      }),
    ]);
    const [tool] = await fromArazzo(doc, { sources: sources() });
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    expect(step.path).toBe('/pets/{petId}');
    expect(step.method).toBe('get');
    expect(step.operationId).toBeUndefined();
  });

  it('rejects malformed operationPath variants', async () => {
    const mk = (operationPath: string) =>
      arazzoWith([simpleWorkflow({ outputs: undefined, steps: [{ stepId: 's', operationPath }] })]);
    await expectArazzoError(fromArazzo(mk('nobrace#/paths/~1x/get'), { sources: sources() }), /must start with/);
    await expectArazzoError(fromArazzo(mk('{$sourceDescriptions.pets.url#/paths/~1x/get'), { sources: sources() }), /missing "}"/);
    await expectArazzoError(fromArazzo(mk('{$inputs.x}#/paths/~1x/get'), { sources: sources() }), /must reference \$sourceDescriptions/);
    await expectArazzoError(fromArazzo(mk('{$sourceDescriptions.pets.name}#/paths/~1x/get'), { sources: sources() }), /must reference \$sourceDescriptions\.<name>\.url/);
    await expectArazzoError(fromArazzo(mk('{$sourceDescriptions.pets.url}/paths/~1x/get'), { sources: sources() }), /requires a "#\/paths/);
    await expectArazzoError(fromArazzo(mk('{$sourceDescriptions.pets.url}#/definitions/~1x/get'), { sources: sources() }), /shape #\/paths/);
    await expectArazzoError(fromArazzo(mk('{$sourceDescriptions.pets.url}#/paths/~1x'), { sources: sources() }), /shape #\/paths/);
    await expectArazzoError(fromArazzo(mk('{$sourceDescriptions.pets.url}#/paths/~1x/fetch'), { sources: sources() }), /unknown HTTP method/);
  });

  it('wraps generateTool failures with the step path', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 's', operationPath: '{$sourceDescriptions.pets.url}#/paths/~1missing/get' }],
      }),
    ]);
    await expectArazzoError(
      fromArazzo(doc, { sources: sources() }),
      /Failed to resolve GET \/missing from source "pets"/,
      '/workflows/0/steps/0',
    );
  });
});

describe('fromArazzo workflow graph checks', () => {
  it('rejects unknown and cyclic dependsOn chains', async () => {
    const unknown = arazzoWith([simpleWorkflow({ dependsOn: ['ghost'], outputs: undefined })]);
    await expectArazzoError(fromArazzo(unknown, { sources: sources() }), /dependsOn unknown workflow/);

    const cyclic = arazzoWith([
      simpleWorkflow({ workflowId: 'a', dependsOn: ['b'], outputs: undefined }),
      simpleWorkflow({ workflowId: 'b', dependsOn: ['a'], outputs: undefined }),
    ]);
    await expectArazzoError(fromArazzo(cyclic, { sources: sources() }), /Cyclic dependsOn chain: (a -> b -> a|b -> a -> b)/);
  });

  it('rejects recursive workflow invocation and unknown nested targets', async () => {
    const selfCall = arazzoWith([
      simpleWorkflow({ workflowId: 'a', outputs: undefined, steps: [{ stepId: 's', workflowId: 'a' }] }),
    ]);
    await expectArazzoError(fromArazzo(selfCall, { sources: sources() }), /Cyclic workflow invocation: a -> a/);

    const unknownTarget = arazzoWith([
      simpleWorkflow({ workflowId: 'a', outputs: undefined, steps: [{ stepId: 's', workflowId: 'ghost' }] }),
    ]);
    // Unknown nested targets surface at the step level after graph construction
    await expectArazzoError(fromArazzo(unknownTarget, { sources: sources() }), /references unknown workflow "ghost"/);
  });

  it('accepts valid dependsOn chains', async () => {
    const chain = arazzoWith([
      simpleWorkflow({ workflowId: 'a', outputs: undefined }),
      simpleWorkflow({ workflowId: 'b', dependsOn: ['a'], outputs: undefined }),
    ]);
    const tools = await fromArazzo(chain, { sources: sources() });
    expect(tools[1].metadata.workflow!.dependsOn).toEqual(['a']);
  });
});

describe('fromArazzo request bodies', () => {
  it('captures payload expressions, replacements, and contentType', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [
          {
            stepId: 'create',
            operationId: 'createPet',
            requestBody: {
              contentType: 'application/json',
              payload: { name: '{$inputs.petId} the pet', 'meta/kind': '$inputs.petId', fixed: 1 },
              replacements: [
                { target: '/fixed', value: '$statusCode' },
                { target: '/name', value: 'literal' },
              ],
            },
          },
        ],
      }),
    ]);
    const [tool] = await fromArazzo(doc, { sources: sources() });
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    expect(step.requestBody?.contentType).toBe('application/json');
    expect(step.requestBody?.payload).toEqual({ name: '{$inputs.petId} the pet', 'meta/kind': '$inputs.petId', fixed: 1 });
    expect(step.requestBody?.payloadExpressions?.map((e) => e.pointer)).toEqual(['/name', '/meta~1kind']);
    expect(step.requestBody?.replacements).toEqual([
      { target: '/fixed', value: { kind: 'expression', expression: { type: 'statusCode', raw: '$statusCode', path: [] } } },
      { target: '/name', value: { kind: 'literal', value: 'literal' } },
    ]);
  });

  it('rejects malformed request bodies and replacements', async () => {
    const badBody = arazzoWith([
      simpleWorkflow({ outputs: undefined, steps: [{ stepId: 's', operationId: 'createPet', requestBody: 'x' }] }),
    ]);
    await expectArazzoError(fromArazzo(badBody, { sources: sources() }), /requestBody must be an object/);

    const badReplacements = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 's', operationId: 'createPet', requestBody: { payload: {}, replacements: 'x' } }],
      }),
    ]);
    await expectArazzoError(fromArazzo(badReplacements, { sources: sources() }), /replacements must be an array/);

    const badReplacement = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 's', operationId: 'createPet', requestBody: { payload: {}, replacements: [{ value: 1 }] } }],
      }),
    ]);
    await expectArazzoError(fromArazzo(badReplacement, { sources: sources() }), /Replacement requires a string "target"/);
  });
});

describe('fromArazzo output schema derivation', () => {
  const flowWith = (outputs: Record<string, string>, stepOutputs: Record<string, string> = { pet: '$response.body' }) =>
    arazzoWith([
      simpleWorkflow({
        steps: [
          {
            stepId: 'fetch',
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', value: '$inputs.petId' }],
            outputs: stepOutputs,
          },
        ],
        outputs,
      }),
    ]);

  const outputProp = async (outputs: Record<string, string>, stepOutputs?: Record<string, string>) => {
    const [tool] = await fromArazzo(flowWith(outputs, stepOutputs), { sources: sources() });
    return (tool.outputSchema as any).properties;
  };

  it('derives scalar shapes for statusCode, url, method, and headers', async () => {
    const props = await outputProp({ code: '$statusCode', where: '$url', how: '$method' });
    expect(props.code.type).toBe('number');
    expect(props.where.type).toBe('string');
    expect(props.how.type).toBe('string');
  });

  it('chases step outputs into response body schemas with pointers', async () => {
    const props = await outputProp(
      { owner: '$steps.fetch.outputs.ownerEmail', photo: '$steps.fetch.outputs.firstPhoto' },
      { ownerEmail: '$response.body#/owner/email', firstPhoto: '$response.body#/photos/0/url' },
    );
    expect(props.owner.type).toBe('string');
    expect(props.photo.type).toBe('string');
  });

  it('degrades unresolvable outputs to unknown with the raw expression preserved', async () => {
    const props = await outputProp(
      {
        missing: '$steps.fetch.outputs.nope',
        badStep: '$steps.ghost.outputs.x',
        shallow: '$steps.fetch.foo',
        input: '$inputs.petId',
        inputMissing: '$inputs.ghost',
        wf: '$workflows.other.outputs.x',
        header: '$steps.fetch.outputs.hdr',
        deadEnd: '$steps.fetch.outputs.badPtr',
      },
      { hdr: '$response.header.X-Trace', badPtr: '$response.body#/owner/missing/deep' },
    );
    expect(props.missing).toEqual({ description: 'Arazzo output: $steps.fetch.outputs.nope' });
    expect(props.badStep.description).toContain('$steps.ghost');
    expect(props.shallow.type).toBeUndefined();
    expect(props.input.type).toBe('string');
    expect(props.inputMissing.type).toBeUndefined();
    expect(props.wf.type).toBeUndefined();
    expect(props.header.type).toBe('string');
    expect(props.deadEnd.type).toBeUndefined();
  });

  it('caps self-referential step output chases', async () => {
    const props = await outputProp({ loop: '$steps.fetch.outputs.self' }, { self: '$steps.fetch.outputs.self' });
    expect(props.loop).toEqual({ description: 'Arazzo output: $steps.fetch.outputs.self' });
  });

  it('uses the first status variant for multi-response operations', async () => {
    const multi = petstoreDoc();
    multi.paths['/pets/{petId}'].get.responses['404'] = {
      description: 'Not found',
      content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } },
    };
    const [tool] = await fromArazzo(flowWith({ pet: '$steps.fetch.outputs.pet' }), {
      sources: { pets: multi, orders: ordersDoc() },
    });
    const props = (tool.outputSchema as any).properties;
    expect(props.pet.properties.id).toEqual({ type: 'string' });
  });

  it('ignores outputs referencing nested workflow steps', async () => {
    const doc = arazzoWith([
      simpleWorkflow({ workflowId: 'inner', outputs: undefined }),
      simpleWorkflow({
        workflowId: 'outer',
        steps: [{ stepId: 'call', workflowId: 'inner' }],
        outputs: { x: '$steps.call.outputs.pet' },
      }),
    ]);
    const tools = await fromArazzo(doc, { sources: sources() });
    const props = (tools[1].outputSchema as any).properties;
    expect(props.x).toEqual({ description: 'Arazzo output: $steps.call.outputs.pet' });
  });
});

describe('fromArazzo remaining coverage', () => {
  it('rejects bare dotted roots like $inputs', () => {
    expect(() => parseRuntimeExpression('$inputs')).toThrow(/missing a name/);
  });

  it('captures workflow-level parameters, success actions, and typed criteria', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        parameters: [{ name: 'tenant', in: 'header', value: '$inputs.petId' }],
        successActions: [{ name: 'done', type: 'end' }],
        steps: [
          {
            stepId: 'fetch',
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', value: 'x' }],
            successCriteria: [
              { context: '$response.body', condition: '$[0].id', type: { type: 'jsonpath', version: 'draft-goessner-dispatch-jsonpath-00' } },
            ],
          },
        ],
      }),
    ]);
    const [tool] = await fromArazzo(doc, { sources: sources() });
    const ir = tool.metadata.workflow!;
    expect(ir.parameters).toEqual([
      { name: 'tenant', in: 'header', value: { kind: 'expression', expression: { type: 'inputs', raw: '$inputs.petId', path: ['petId'] } } },
    ]);
    expect(ir.successActions).toEqual([{ name: 'done', kind: 'success', type: 'end' }]);
    const step = ir.steps[0] as OperationStepIR;
    expect(step.successCriteria).toEqual([
      {
        context: { type: 'response', raw: '$response.body', path: [], source: 'body' },
        condition: '$[0].id',
        type: 'jsonpath',
        version: 'draft-goessner-dispatch-jsonpath-00',
      },
    ]);
  });

  it('rejects malformed reusable parameter components', async () => {
    const doc = arazzoWith(
      [
        simpleWorkflow({
          outputs: undefined,
          steps: [{ stepId: 'f', operationId: 'getPet', parameters: [{ reference: '$components.parameters.broken' }] }],
        }),
      ],
      { components: { parameters: { broken: { in: 'query', value: 1 } as any } } },
    );
    await expectArazzoError(fromArazzo(doc, { sources: sources() }), /Parameter requires a non-empty string "name"/);
  });

  it('degrades direct workflow-level $response.body outputs to unknown', async () => {
    const doc = arazzoWith([simpleWorkflow({ outputs: { direct: '$response.body' } })]);
    const [tool] = await fromArazzo(doc, { sources: sources() });
    expect((tool.outputSchema as any).properties.direct).toEqual({ description: 'Arazzo output: $response.body' });
  });

  it('applies description and property trims to consolidated schemas', async () => {
    const workflow = simpleWorkflow({
      inputs: {
        type: 'object',
        properties: {
          petId: {
            type: 'object',
            description: 'A very long description that should be truncated at some point for budget reasons',
            properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
          },
        },
      },
    });
    const [tool] = await fromArazzo(arazzoWith([workflow]), {
      sources: sources(),
      generateOptions: { maxDescriptionLength: 20, maxProperties: 2 },
    });
    const petId = (tool.inputSchema as any).properties.petId;
    // description capped first, then the property-omission note appends
    expect(petId.description).toMatch(/^A very long descrip… \[1 additional property omitted/);
    expect(Object.keys(petId.properties)).toHaveLength(2);
    const out = (tool.outputSchema as any).properties.pet;
    expect(Object.keys(out.properties).length).toBeLessThanOrEqual(2);
  });
});

describe('fromArazzo branch completeness', () => {
  it('rejects wrong criterion-object types and non-numeric retryLimit', async () => {
    const bad1 = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 's', operationId: 'getPet', parameters: [{ name: 'petId', in: 'path', value: 'x' }], successCriteria: [{ condition: 'x', context: '$statusCode', type: { type: 'simple', version: 'v' } }] }],
      }),
    ]);
    await expectArazzoError(fromArazzo(bad1, { sources: sources() }), /requires "type" \(jsonpath\|xpath\)/);

    const bad2 = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 's', operationId: 'getPet', parameters: [{ name: 'petId', in: 'path', value: 'x' }], onFailure: [{ name: 'r', type: 'retry', retryLimit: 'lots' }] }],
      }),
    ]);
    await expectArazzoError(fromArazzo(bad2, { sources: sources() }), /non-negative integer/);

    const bad3 = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [{ stepId: 's', operationId: 'getPet', parameters: [{ name: 'petId', in: 'path', value: 'x' }], onFailure: [{ name: 'r', type: 'retry', retryLimit: -2 }] }],
      }),
    ]);
    await expectArazzoError(fromArazzo(bad3, { sources: sources() }), /non-negative integer/);
  });

  it('rejects duplicate location-less workflow-level parameters', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        parameters: [{ name: 'a', value: 1 }, { name: 'a', value: 2 }],
      }),
    ]);
    await expectArazzoError(fromArazzo(doc, { sources: sources() }), /Duplicate parameter "a"/);
  });

  it('tolerates missing options.sources and skips pathless or malformed source paths', async () => {
    const noSources = arazzoWith([simpleWorkflow({ outputs: undefined })]);
    await expectArazzoError(fromArazzo(noSources, { } as any), /not found in any supplied source/);

    const oddDoc: any = {
      openapi: '3.0.0',
      info: { title: 'Odd', version: '1.0.0' },
      paths: { '/null': null, '/noid': { get: { responses: { '200': { description: 'OK' } } } } },
    };
    const doc = arazzoWith([simpleWorkflow({ outputs: undefined })]);
    await expectArazzoError(
      fromArazzo(doc, { sources: { pets: oddDoc, orders: ordersDoc() } }),
      /not found in any supplied source/,
    );

    const pathless: any = { openapi: '3.0.0', info: { title: 'Empty', version: '1.0.0' } };
    await expectArazzoError(
      fromArazzo(doc, { sources: { pets: pathless } }),
      /not found in any supplied source/,
    );
  });

  it('marks later workflows done before revisiting them in the cycle check', async () => {
    const doc = arazzoWith([
      simpleWorkflow({ workflowId: 'first', dependsOn: ['second'], outputs: undefined }),
      simpleWorkflow({ workflowId: 'second', outputs: undefined }),
    ]);
    const tools = await fromArazzo(doc, { sources: sources() });
    expect(tools).toHaveLength(2);
  });

  it('carries goto targets, step descriptions, and criteria-less actions into the IR', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [
          {
            stepId: 'fetch',
            description: 'First step',
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', value: 'x' }],
            onSuccess: [{ name: 'jump', type: 'goto', stepId: 'fetch' }],
            onFailure: [{ name: 'redo', type: 'goto', workflowId: 'getPetFlow' }],
          },
        ],
      }),
    ]);
    const [tool] = await fromArazzo(doc, { sources: sources() });
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    expect(step.description).toBe('First step');
    expect(step.onSuccess).toEqual([{ name: 'jump', kind: 'success', type: 'goto', stepId: 'fetch' }]);
    expect(step.onFailure).toEqual([{ name: 'redo', kind: 'failure', type: 'goto', workflowId: 'getPetFlow' }]);
  });

  it('walks pointers through boolean sub-schemas without crashing', async () => {
    const boolDoc = petstoreDoc();
    boolDoc.paths['/pets/{petId}'].get.responses['200'].content['application/json'].schema = {
      type: 'object',
      properties: { anything: true },
    };
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: { deep: '$steps.fetch.outputs.deep' },
        steps: [
          {
            stepId: 'fetch',
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', value: 'x' }],
            outputs: { deep: '$response.body#/anything/nested' },
          },
        ],
      }),
    ]);
    const [tool] = await fromArazzo(doc, { sources: { pets: boolDoc, orders: ordersDoc() } });
    expect((tool.outputSchema as any).properties.deep).toEqual({ description: 'Arazzo output: $steps.fetch.outputs.deep' });
  });

  it('handles $inputs outputs when the workflow has no or shapeless inputs', async () => {
    const noInputs = arazzoWith([
      simpleWorkflow({ inputs: undefined, outputs: { echo: '$inputs.petId' }, steps: [{ stepId: 's', operationId: 'listPets' }] }),
    ]);
    const [t1] = await fromArazzo(noInputs, { sources: sources() });
    expect((t1.outputSchema as any).properties.echo.type).toBeUndefined();

    const shapeless = arazzoWith([
      simpleWorkflow({ inputs: { type: 'object' }, outputs: { echo: '$inputs.petId' }, steps: [{ stepId: 's', operationId: 'listPets' }] }),
    ]);
    const [t2] = await fromArazzo(shapeless, { sources: sources() });
    expect((t2.outputSchema as any).properties.echo.type).toBeUndefined();
  });

  it('resolves formats and defaults the printer depth for type signatures', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        inputs: { type: 'object', properties: { petId: { type: 'string', format: 'uuid' } } },
        outputs: undefined,
      }),
    ]);
    const [tool] = await fromArazzo(doc, { sources: sources(), generateOptions: { resolveFormats: true, emitTypeSignatures: true } });
    expect((tool.inputSchema as any).properties.petId.pattern).toBeDefined();
    expect(tool.metadata.typescript?.signature).toContain('petId');
  });

  it('falls back through the description forms', async () => {
    const doc = arazzoWith([
      simpleWorkflow({ workflowId: 'bare', summary: undefined, description: undefined, outputs: undefined }),
      simpleWorkflow({ workflowId: 'descOnly', summary: undefined, description: 'Only description.', outputs: undefined }),
    ]);
    const tools = await fromArazzo(doc, { sources: sources() });
    expect(tools[0].description).toBe('Arazzo workflow: bare');
    expect(tools[0].title).toBeUndefined();
    expect(tools[1].description).toBe('Only description.');
  });
});

describe('fromArazzo review-fix regressions', () => {
  it('expands YAML anchors so payload expressions cover every occurrence', async () => {
    const yamlDoc = [
      'arazzo: 1.0.0',
      'info: { title: F, version: "1" }',
      'sourceDescriptions: [{ name: pets, url: "https://x" }]',
      'workflows:',
      '  - workflowId: w',
      '    steps:',
      '      - stepId: s',
      '        operationId: createPet',
      '        requestBody:',
      '          payload:',
      '            a: &shared { v: $inputs.foo }',
      '            b: *shared',
    ].join('\n');
    const [tool] = await fromArazzo(yamlDoc, { sources: { pets: petstoreDoc() } });
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    expect(step.requestBody?.payloadExpressions?.map((e) => e.pointer).sort()).toEqual(['/a/v', '/b/v']);
    expect(JSON.stringify(tool)).toBeDefined();
  });

  it('rejects cyclic YAML documents with an ArazzoError', async () => {
    const cyclic = ['arazzo: 1.0.0', 'x: &c', '  self: *c'].join('\n');
    await expectArazzoError(fromArazzo(cyclic, { sources: {} }), /JSON-serializable/);
    const loop: any = { arazzo: '1.0.0' };
    loop.self = loop;
    await expectArazzoError(fromArazzo(loop, { sources: {} }), /JSON-serializable/);
  });

  it('supports the $message expression root', async () => {
    expect(parseRuntimeExpression('$message.body#/x')).toEqual({
      type: 'message',
      raw: '$message.body#/x',
      path: [],
      source: 'body',
      pointer: '/x',
    });
    expect(parseRuntimeExpression('$message.header.X-Id').name).toBe('X-Id');
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [
          {
            stepId: 's',
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', value: 'x' }],
            successCriteria: [{ condition: 'ok', context: '$message.body', type: 'regex' }],
          },
        ],
      }),
    ]);
    const [tool] = await fromArazzo(doc, { sources: sources() });
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    expect(step.successCriteria![0].context?.type).toBe('message');
  });

  it('keeps unknown-root dollar strings literal at exact boundaries', () => {
    expect(parseExpressionValue('$request-id')).toEqual({ kind: 'literal', value: '$request-id' });
    expect(parseExpressionValue('$urlx')).toEqual({ kind: 'literal', value: '$urlx' });
    expect(parseExpressionValue('$inputsfoo')).toEqual({ kind: 'literal', value: '$inputsfoo' });
  });

  it('resolves dotted component names', async () => {
    const doc = arazzoWith(
      [
        simpleWorkflow({
          outputs: undefined,
          steps: [
            { stepId: 's', operationId: 'getPet', parameters: [{ reference: '$components.parameters.my.org.petId' }] },
          ],
        }),
      ],
      { components: { parameters: { 'my.org.petId': { name: 'petId', in: 'path', value: 'x' } } } },
    );
    const [tool] = await fromArazzo(doc, { sources: sources() });
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    expect(step.parameters![0].name).toBe('petId');
  });

  it('accepts cross-document dependsOn expressions and rejects malformed ones', async () => {
    const doc = arazzoWith([
      simpleWorkflow({ dependsOn: ['$sourceDescriptions.flows.otherWf'], outputs: undefined }),
    ]);
    doc.sourceDescriptions.push({ name: 'flows', url: 'https://x/flows.yaml', type: 'arazzo' });
    const [tool] = await fromArazzo(doc, { sources: sources() });
    expect(tool.metadata.workflow!.dependsOn).toEqual(['$sourceDescriptions.flows.otherWf']);

    const badSource = arazzoWith([
      simpleWorkflow({ dependsOn: ['$sourceDescriptions.ghost.wf'], outputs: undefined }),
    ]);
    await expectArazzoError(fromArazzo(badSource, { sources: sources() }), /must reference a declared source/);

    const notArray = arazzoWith([simpleWorkflow({ dependsOn: 'other', outputs: undefined })]);
    await expectArazzoError(fromArazzo(notArray, { sources: sources() }), /must be an array/);

    const badEntry = arazzoWith([simpleWorkflow({ dependsOn: [42], outputs: undefined })]);
    await expectArazzoError(fromArazzo(badEntry, { sources: sources() }), /entries must be strings/);
  });

  it('rejects non-string criterion contexts as ArazzoError, not a crash', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [
          {
            stepId: 's',
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', value: 'x' }],
            successCriteria: [{ condition: 'x', context: 123, type: 'regex' }],
          },
        ],
      }),
    ]);
    await expectArazzoError(fromArazzo(doc, { sources: sources() }), /"context" must be a runtime expression string/);
  });

  it('gives cross-document workflow steps the nested-unsupported error and rejects their request bodies', async () => {
    const crossDoc = arazzoWith([
      simpleWorkflow({ outputs: undefined, steps: [{ stepId: 's', workflowId: '$sourceDescriptions.flows.wf' }] }),
    ]);
    crossDoc.sourceDescriptions.push({ name: 'flows', url: 'https://x/f.yaml', type: 'arazzo' });
    await expectArazzoError(fromArazzo(crossDoc, { sources: sources() }), /nested Arazzo sources are not supported/);

    const bodyOnWorkflow = arazzoWith([
      simpleWorkflow({ workflowId: 'a', outputs: undefined }),
      simpleWorkflow({
        workflowId: 'b',
        outputs: undefined,
        steps: [{ stepId: 's', workflowId: 'a', requestBody: { payload: {} } }],
      }),
    ]);
    await expectArazzoError(fromArazzo(bodyOnWorkflow, { sources: sources() }), /must not declare a requestBody/);
  });

  it('re-validates reusable-sourced actions and parameters fully', async () => {
    const smuggledGoto = arazzoWith(
      [
        simpleWorkflow({
          outputs: undefined,
          steps: [{ stepId: 's', operationId: 'getPet', parameters: [{ name: 'petId', in: 'path', value: 'x' }], onSuccess: [{ reference: '$components.successActions.bad' }] }],
        }),
      ],
      { components: { successActions: { bad: { name: 'g', type: 'goto' } } } },
    );
    await expectArazzoError(fromArazzo(smuggledGoto, { sources: sources() }), /exactly one of "workflowId" or "stepId"/);

    const dupViaRefs = arazzoWith(
      [
        simpleWorkflow({
          outputs: undefined,
          steps: [
            {
              stepId: 's',
              operationId: 'getPet',
              parameters: [
                { reference: '$components.parameters.petParam' },
                { reference: '$components.parameters.petParam' },
              ],
            },
          ],
        }),
      ],
      { components: { parameters: { petParam: { name: 'petId', in: 'path', value: 'x' } } } },
    );
    await expectArazzoError(fromArazzo(dupViaRefs, { sources: sources() }), /Duplicate parameter "petId"/);

    const noIn = arazzoWith(
      [
        simpleWorkflow({
          outputs: undefined,
          steps: [{ stepId: 's', operationId: 'getPet', parameters: [{ reference: '$components.parameters.inless' }] }],
        }),
      ],
      { components: { parameters: { inless: { name: 'petId', value: 'x' } as any } } },
    );
    await expectArazzoError(fromArazzo(noIn, { sources: sources() }), /requires "in"/);
  });

  it('never aliases the tool output schema with the embedded step schemas', async () => {
    const [tool] = await fromArazzo(arazzoWith([simpleWorkflow()]), { sources: sources() });
    const outputPet = (tool.outputSchema as any).properties.pet;
    const step = tool.metadata.workflow!.steps[0] as OperationStepIR;
    const embedded: any = step.operation.outputSchema;
    expect(outputPet.properties).not.toBe(embedded.properties);
    outputPet.properties.id.type = 'MUTATED';
    expect(embedded.properties.id.type).toBe('string');
  });

  it('reports per-index paths for action criteria failures', async () => {
    const doc = arazzoWith([
      simpleWorkflow({
        outputs: undefined,
        steps: [
          {
            stepId: 's',
            operationId: 'getPet',
            parameters: [{ name: 'petId', in: 'path', value: 'x' }],
            onFailure: [{ name: 'r', type: 'end', criteria: [{ condition: 'ok' }, { condition: '' }] }],
          },
        ],
      }),
    ]);
    await expectArazzoError(
      fromArazzo(doc, { sources: sources() }),
      /non-empty string "condition"/,
      '/workflows/0/steps/0/onFailure/0/criteria/1',
    );
  });
});

describe('fromArazzo location-less parameters through resolution', () => {
  it('resolves in-less workflow and nested-step parameters and dedupes them', async () => {
    const doc = arazzoWith(
      [
        simpleWorkflow({ workflowId: 'inner', outputs: undefined }),
        simpleWorkflow({
          workflowId: 'outer',
          outputs: undefined,
          parameters: [{ name: 'shared', value: 1 }],
          steps: [{ stepId: 'call', workflowId: 'inner', parameters: [{ name: 'input', value: '$inputs.petId' }] }],
        }),
      ],
    );
    const tools = await fromArazzo(doc, { sources: sources() });
    expect(tools[1].metadata.workflow!.parameters).toEqual([{ name: 'shared', value: { kind: 'literal', value: 1 } }]);
    const step = tools[1].metadata.workflow!.steps[0] as NestedWorkflowStepIR;
    expect(step.parameters![0].in).toBeUndefined();

    const dupInless = arazzoWith(
      [
        simpleWorkflow({ workflowId: 'inner', outputs: undefined }),
        simpleWorkflow({
          workflowId: 'outer',
          outputs: undefined,
          steps: [
            {
              stepId: 'call',
              workflowId: 'inner',
              parameters: [{ reference: '$components.parameters.p' }, { reference: '$components.parameters.p' }],
            },
          ],
        }),
      ],
      { components: { parameters: { p: { name: 'dup', value: 1 } as any } } },
    );
    await expectArazzoError(fromArazzo(dupInless, { sources: sources() }), /Duplicate parameter "dup"/);
  });
});
