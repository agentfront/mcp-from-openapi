/**
 * Type-signature story: every emitted TypeScript declaration and signature
 * from real specs compiles under the real TypeScript compiler with zero
 * diagnostics — the invalid-TS bug class as a permanent regression test.
 */
import { OpenAPIToolGenerator } from '../src';
import type { McpOpenAPITool, OpenAPIDocument } from '../src';
import { loadFixture, loadJsonFixture } from './helpers/fixtures';
import { compileVirtual } from './helpers/tsc';
import * as yaml from 'yaml';

const cases: Array<{ file: string }> = [
  { file: 'petstore-3.0.yaml' },
  { file: 'github-trimmed-3.0.json' },
  // Swagger 2.0, converted to OpenAPI 3.0: `type: file`, `x-nullable`, a body parameter and a form file part
  { file: 'netlify-trimmed-2.0.json' },
];

describe.each(cases)('story: emitted TypeScript compiles ($file)', ({ file }) => {
  let tools: McpOpenAPITool[];

  beforeAll(async () => {
    // A Swagger 2.0 document is no OpenAPIDocument (the type holds the OpenAPI 3 versions): `fromJSON` takes any object
    const document: object = file.endsWith('.yaml')
      ? (yaml.parse(loadFixture(file)) as OpenAPIDocument)
      : loadJsonFixture<OpenAPIDocument>(file);
    tools = await (await OpenAPIToolGenerator.fromJSON(document)).generateTools({ emitTypeSignatures: true });
  });

  it('emits a signature and declaration for every tool', () => {
    for (const tool of tools) {
      expect(tool.metadata.typescript?.signature).toMatch(/^\(.*\) => Promise<.+>$/s);
      expect(tool.metadata.typescript?.declaration).toContain('declare function');
    }
  });

  it('compiles all declarations with zero diagnostics', () => {
    const source = tools.map((tool) => tool.metadata.typescript!.declaration).join('\n\n');
    expect(compileVirtual('declarations.ts', source)).toEqual([]);
  });

  it('compiles all signatures as type aliases with zero diagnostics', () => {
    const source = tools
      .map((tool, index) => `type S${index} = ${tool.metadata.typescript!.signature};`)
      .join('\n');
    expect(compileVirtual('signatures.ts', source)).toEqual([]);
  });
});

describe('story: a schema that accepts no value is `never` in the emitted TypeScript', () => {
  // JSON Schema: `false` accepts nothing, and so does `{ not: {} }` (`{}` accepts everything, so its negation nothing);
  // OpenAPI 3.0 has no boolean schema and says it the second way, 3.1 and later may say it the first. TypeScript's
  // type with no value is `never`. A required input of that type can never be given, so no call of the tool can succeed:
  // the tool is still made, and generation says so.
  const document = {
    openapi: '3.1.0',
    info: { title: 'Nothing', version: '1' },
    servers: [{ url: 'https://nothing.example.com' }],
    paths: {
      '/n': {
        post: {
          operationId: 'never',
          parameters: [
            { name: 'must', in: 'query', required: true, schema: false },
            { name: 'mustToo', in: 'query', required: true, schema: { not: {} } },
            { name: 'may', in: 'query', schema: { not: {} } },
            { name: 'fine', in: 'query', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['a', 'b'], properties: { a: false, b: { type: 'string' }, c: { not: {} } } },
              },
            },
          },
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object', properties: { x: false, y: { not: {} }, z: { type: 'string' } } } } },
            },
          },
        },
      },
      // An object with properties that `not: {}` makes accept nothing: its root type is `never`, so it is declared
      // `type X = never;` (an `interface` needs a `{ ... }` body)
      '/out': {
        get: {
          operationId: 'emptyOutput',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } }, not: {} } } },
            },
          },
        },
      },
      '/whole': {
        post: {
          operationId: 'whole',
          requestBody: { required: true, content: { 'application/json': { schema: false } } },
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  let tools: McpOpenAPITool[];
  let diagnostics: Array<{ severity: string; code: string; path?: string; message: string }>;

  beforeAll(async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(document, { refResolution: { allowedProtocols: [] } });
    tools = await generator.generateTools({ emitTypeSignatures: true });
    diagnostics = generator.getDiagnostics();
  });

  it('is `never` for each input and each output property, optional where the document does not require it', () => {
    const signature = (name: string): string => tools.find((tool) => tool.name === name)!.metadata.typescript!.signature;
    expect(signature('never')).toBe(
      '(input: { must: never; mustToo: never; may?: never; fine: string; a: never; b: string; c?: never }) => ' +
        'Promise<{ x?: never; y?: never; z?: string }>',
    );
    // a whole body that accepts nothing
    expect(signature('whole')).toBe('(input: { body: never }) => Promise<null>');
    // an output object that accepts nothing, whatever properties it lists
    expect(signature('emptyOutput')).toBe('() => Promise<never>');
    expect(tools.find((tool) => tool.name === 'emptyOutput')!.metadata.typescript!.declaration).toContain(
      'type EmptyOutputOutput = never;',
    );
  });

  it('compiles, with zero diagnostics', () => {
    const source = tools.map((tool) => tool.metadata.typescript!.declaration).join('\n\n');
    expect(compileVirtual('never-declarations.ts', source)).toEqual([]);
    const aliases = tools.map((tool, index) => `type S${index} = ${tool.metadata.typescript!.signature};`).join('\n');
    expect(compileVirtual('never-signatures.ts', aliases)).toEqual([]);
  });

  it('is a warning for each required input that accepts nothing, at the operation, and for no optional one', () => {
    const found = diagnostics.filter(({ code }) => code === 'REQUIRED_INPUT_ACCEPTS_NOTHING');
    expect(found.map(({ severity, path, message }) => [severity, path, /the required input "([^"]+)"/.exec(message)?.[1]])).toEqual([
      ['warning', '/paths/~1n/post', 'must'],
      ['warning', '/paths/~1n/post', 'mustToo'],
      ['warning', '/paths/~1n/post', 'a'],
      ['warning', '/paths/~1whole/post', 'body'],
    ]);
    // the tools are still made
    expect(tools.map(({ name }) => name)).toEqual(['never', 'emptyOutput', 'whole']);
  });
});

