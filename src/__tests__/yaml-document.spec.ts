import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fromArazzo } from '../arazzo';
import { ArazzoError, LoadError, ParseError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import { MAX_REPEATED_VALUES, assertBoundedExpansion } from '../json-copy';
import { MAX_YAML_ALIASES, parseYamlText } from '../yaml-document';
import { createLoopbackServer, type LoopbackHandler } from './helpers/loopback';

const header = "openapi: 3.0.3\ninfo: {title: t, version: '1'}\npaths: {}\n";

function aliasGraphYaml(depth: number): string {
  let text = `${header}x-a0: &a0 []\n`;
  for (let level = 1; level <= depth; level++) text += `x-a${level}: &a${level} [*a${level - 1}, *a${level - 1}]\n`;
  return text;
}

function scalarAliasesYaml(count: number): string {
  let text = `${header}x-list:\n`;
  for (let index = 0; index < count; index++) text += `  - &v${index} value\n  - *v${index}\n`;
  return text;
}

function sharedGraph(depth: number): Record<string, unknown> {
  let shared: unknown = [];
  for (let level = 0; level < depth; level++) shared = [shared, shared];
  return { openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {}, 'x-shared': shared };
}

describe('parseYamlText', () => {
  it('parses a document with a few aliases like yaml.parse', () => {
    const text = `${header}x-error: &error {type: object}\nx-uses: [*error, *error]\n`;
    const parsed = parseYamlText(text) as Record<string, unknown[]>;
    expect(parsed['x-uses']).toEqual([{ type: 'object' }, { type: 'object' }]);
  });

  it('throws the first YAML error', () => {
    expect(() => parseYamlText('a: 1\na: 2\n')).toThrow(/unique/);
  });

  it(`refuses more than ${MAX_YAML_ALIASES} aliases before resolving them`, () => {
    const started = Date.now();
    expect(() => parseYamlText(scalarAliasesYaml(MAX_YAML_ALIASES + 1))).toThrow(
      `The YAML document uses more than ${MAX_YAML_ALIASES} aliases`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it(`accepts exactly ${MAX_YAML_ALIASES} aliases`, () => {
    expect(() => parseYamlText(scalarAliasesYaml(MAX_YAML_ALIASES))).not.toThrow();
  });

  it('refuses an alias graph that expands past the limit', () => {
    const started = Date.now();
    expect(() => parseYamlText(aliasGraphYaml(30))).toThrow(/expand to more than/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('assertBoundedExpansion', () => {
  it('accepts values without sharing, and primitives', () => {
    expect(() => assertBoundedExpansion({ a: [1, 2, { b: 'c' }] })).not.toThrow();
    expect(() => assertBoundedExpansion('text')).not.toThrow();
    expect(() => assertBoundedExpansion(null)).not.toThrow();
  });

  it('accepts an object shared a few times', () => {
    const schema = { type: 'object', properties: { id: { type: 'string' } } };
    expect(() => assertBoundedExpansion({ a: schema, b: schema, c: [schema, schema] })).not.toThrow();
  });

  it(`refuses sharing that repeats more than ${MAX_REPEATED_VALUES} values`, () => {
    expect(() => assertBoundedExpansion(sharedGraph(40))).toThrow(ParseError);
  });

  it('leaves a cycle to the copy that follows', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(() => assertBoundedExpansion(cyclic)).not.toThrow();
  });

  it('counts the holes of a sparse array, which a copy writes as null', () => {
    let shared: unknown = new Array(10_000);
    for (let level = 0; level < 17; level++) shared = [shared, shared];
    expect(() => assertBoundedExpansion(shared)).toThrow(ParseError);
  });
});

describe('YAML 1.1 merge keys', () => {
  it('refuses a merge-key graph that doubles at each level, quickly', () => {
    let text = `%YAML 1.1\n---\n${header}x-l0: &a0 {k: v}\n`;
    for (let level = 1; level <= 30; level++) {
      text += `x-l${level}: &a${level} {x: {<<: *a${level - 1}}, y: {<<: *a${level - 1}}}\n`;
    }
    const started = Date.now();
    expect(() => parseYamlText(text)).toThrow(/Excessive alias count/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('loaders refuse values that expand without bound', () => {
  it('fromYAML rejects an alias graph with a ParseError', async () => {
    const started = Date.now();
    await expect(OpenAPIToolGenerator.fromYAML(aliasGraphYaml(30))).rejects.toThrow(ParseError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('fromYAML rejects too many aliases', async () => {
    await expect(OpenAPIToolGenerator.fromYAML(scalarAliasesYaml(MAX_YAML_ALIASES + 1))).rejects.toThrow(
      /more than \d+ aliases/,
    );
  });

  it('fromJSON rejects a shared object graph instead of expanding it', async () => {
    const started = Date.now();
    await expect(OpenAPIToolGenerator.fromJSON(sharedGraph(40))).rejects.toThrow(/expand to more than/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('fromJSON still loads a document that reuses one object', async () => {
    const response = { description: 'ok' };
    const document = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: { '/a': { get: { responses: { 200: response } } }, '/b': { get: { responses: { 200: response } } } },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(document);
    expect(await generator.generateTools()).toHaveLength(2);
  });

  it('fromFile rejects an alias graph with a LoadError', async () => {
    const file = path.join(os.tmpdir(), `alias-graph-${process.pid}-${Date.now()}.yaml`);
    fs.writeFileSync(file, aliasGraphYaml(30));
    try {
      await expect(OpenAPIToolGenerator.fromFile(file)).rejects.toThrow(LoadError);
    } finally {
      fs.unlinkSync(file);
    }
  });

  describe('fromURL', () => {
    let handler: LoopbackHandler;
    const loopback = createLoopbackServer(() => handler);
    let baseUrl: string;

    beforeAll(async () => {
      baseUrl = await loopback.listen();
    });

    afterAll(async () => {
      await loopback.close();
    });

    it('rejects an alias graph served as YAML with a LoadError', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/yaml' });
        res.end(aliasGraphYaml(30));
      };
      await expect(
        OpenAPIToolGenerator.fromURL(`${baseUrl}/spec.yaml`, { refResolution: { allowInternalIPs: true } }),
      ).rejects.toThrow(LoadError);
    });
  });

  it('fromArazzo rejects an alias graph with an ArazzoError', async () => {
    const text = `arazzo: 1.0.0\ninfo: {title: t, version: '1'}\nx-a0: &a0 []\n${Array.from(
      { length: 30 },
      (_, index) => `x-a${index + 1}: &a${index + 1} [*a${index}, *a${index}]`,
    ).join('\n')}\n`;
    await expect(fromArazzo(text, { sources: {} })).rejects.toThrow(ArazzoError);
  });

  it('fromArazzo rejects a shared object graph', async () => {
    const document = { ...sharedGraph(40), arazzo: '1.0.0' };
    await expect(fromArazzo(document as never, { sources: {} })).rejects.toThrow(/expand to more than/);
  });
});

describe('the repetition limit', () => {
  function repeatedLeaves(copies: number): Record<string, unknown> {
    const leaf = { name: 'body', in: 'body', required: true };
    return { list: Array.from({ length: copies }, () => leaf) };
  }

  it('accepts a document whose shared values repeat exactly the limit', () => {
    expect(() => assertBoundedExpansion(repeatedLeaves(MAX_REPEATED_VALUES / 4 + 1))).not.toThrow();
  });

  it('refuses one repetition more', () => {
    expect(() => assertBoundedExpansion(repeatedLeaves(MAX_REPEATED_VALUES / 4 + 2))).toThrow(ParseError);
  });
});
