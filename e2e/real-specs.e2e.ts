/**
 * Real-spec story: four vendored real-world specs survive the whole
 * pipeline — generation, MCP name rules, JSON Schema 2020-12 validity (ajv),
 * every client-target dialect, lint, and token accounting. The literal counts
 * pin fixture↔spec drift (see e2e/fixtures/README.md).
 *
 * One of the four is Swagger 2.0 (Netlify, `netlify-trimmed-2.0.json`), which the
 * library converts to OpenAPI 3.0 and generates from. Its 177 tools are the 177
 * operations of the document (76 get, 50 post, 23 put, 23 delete, 5 patch, none
 * deprecated, each with its own operationId). It is linted through the generator, which dereferences it
 * first: `lintDocument` converts what it is given and does not follow a `$ref`
 * left in a 2.0 document. Of its 45 warnings and 261 infos, four codes were counted
 * again from the document itself (e2e/swagger2.e2e.ts reads the same document through
 * the converter): 43 `unpaginated-list` (a GET whose response holds an array and that
 * has no pagination parameter), 155 `missing-parameter-description` (operations with a
 * path, query or header parameter that has no description), 48 `missing-request-example`
 * (the operations with a body, 47 `in: body` and the one multipart upload) and 42
 * `vague-description` (summary and description under 20 characters).
 */
import { OpenAPIToolGenerator, analyzeToolSet, detectSpecVersion, estimateToolTokens, lintDocument } from '../src';
import type { ClientTarget, JsonSchema, McpOpenAPITool, OpenAPIDocument } from '../src';
import { loadFixture, loadJsonFixture } from './helpers/fixtures';
import { compileAll } from './helpers/ajv';
import * as yaml from 'yaml';

const FIXTURES: Array<{
  file: string;
  toolCount: number;
  lintCounts: { error: number; warning: number; info: number };
}> = [
  { file: 'petstore-3.0.yaml', toolCount: 19, lintCounts: { error: 0, warning: 2, info: 8 } },
  { file: 'github-trimmed-3.0.json', toolCount: 78, lintCounts: { error: 0, warning: 26, info: 15 } },
  { file: 'discord-trimmed-3.1.json', toolCount: 60, lintCounts: { error: 0, warning: 64, info: 72 } },
  { file: 'netlify-trimmed-2.0.json', toolCount: 177, lintCounts: { error: 0, warning: 45, info: 261 } },
];

const TARGETS = ['claude', 'openai', 'gemini', 'strict'] as const satisfies readonly ClientTarget[];
// Compile-time exhaustiveness: a new ClientTarget member breaks this line
// until it is added to TARGETS above.
type MissingTarget = Exclude<ClientTarget, (typeof TARGETS)[number]>;
const allTargetsCovered: [MissingTarget] extends [never] ? true : never = true;
void allTargetsCovered;
const MCP_NAME = /^[A-Za-z0-9_.-]+$/;

const loadDocument = (file: string): OpenAPIDocument =>
  file.endsWith('.yaml') ? (yaml.parse(loadFixture(file)) as OpenAPIDocument) : loadJsonFixture<OpenAPIDocument>(file);

const allSchemas = (tools: McpOpenAPITool[]): Array<{ label: string; schema: JsonSchema }> =>
  tools.flatMap((tool) => [
    { label: `${tool.name} input`, schema: tool.inputSchema },
    ...(tool.outputSchema ? [{ label: `${tool.name} output`, schema: tool.outputSchema }] : []),
  ]);

describe.each(FIXTURES)('story: real spec $file', ({ file, toolCount, lintCounts }) => {
  let document: OpenAPIDocument;
  let tools: McpOpenAPITool[];

  beforeAll(async () => {
    document = loadDocument(file);
    tools = await (await OpenAPIToolGenerator.fromJSON(document)).generateTools();
  });

  it(`generates exactly ${toolCount} tools, deterministically`, async () => {
    expect(tools).toHaveLength(toolCount);
    const again = await (await OpenAPIToolGenerator.fromJSON(loadDocument(file))).generateTools();
    expect(again).toEqual(tools);
  });

  it('emits MCP-valid, unique tool names', () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(MCP_NAME);
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });

  it('produces valid JSON Schema 2020-12 for every schema', () => {
    expect(compileAll(allSchemas(tools))).toEqual([]);
  });

  it.each(TARGETS)('stays valid and dialect-conformant under target %s', async (target) => {
    const targeted = await (await OpenAPIToolGenerator.fromJSON(loadDocument(file))).generateTools({ target });
    expect(targeted).toHaveLength(toolCount);
    expect(compileAll(allSchemas(targeted))).toEqual([]);

    for (const tool of targeted) {
      const serialized = JSON.stringify([tool.inputSchema, tool.outputSchema ?? {}]);
      expect(serialized).not.toContain('"$ref"'); // inlineLocalRefs ran

      // ensureArrayItems: every array node carries items
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const record = node as Record<string, unknown>;
        const type = record['type'];
        if (type === 'array' || (Array.isArray(type) && type.includes('array'))) {
          expect(record['items'] ?? record['prefixItems']).toBeDefined();
        }
        Object.values(record).forEach(walk);
      };
      walk(tool.inputSchema);

      if (target === 'strict') {
        const root = tool.inputSchema as Record<string, unknown>;
        expect(root['additionalProperties']).toBe(false);
      }
    }
  });

  it('lints to the expected finding counts', async () => {
    if (detectSpecVersion(document).family === '2.0') {
      // Swagger 2.0: the generator dereferences, then converts, then lints the OpenAPI 3.0 document it generates from
      const generator = await OpenAPIToolGenerator.fromJSON(loadDocument(file));
      const result = await generator.lint();
      expect(result.counts).toEqual(lintCounts);
      expect(lintDocument(generator.getDocument())).toEqual(result);
      return;
    }
    expect(lintDocument(document).counts).toEqual(lintCounts);
  });

  it('reports sane token estimates', () => {
    const report = analyzeToolSet(tools);
    expect(report.toolCount).toBe(toolCount);
    expect(report.estimatedTokens).toBeGreaterThan(0);
    for (const tool of tools) {
      const tokens = estimateToolTokens(tool);
      expect(Number.isInteger(tokens)).toBe(true);
      expect(tokens).toBeGreaterThan(0);
    }
  });
});

describe('story: real spec netlify-trimmed-2.0.json, converted without a finding', () => {
  // A real Swagger 2.0 description is the test that the conversion does not cry wolf: every construct of this one
  // (`type: file`, `x-nullable`, `in: body` and `in: formData`, a global parameter and response, an implicit OAuth2
  // definition with no `scopes`, `consumes` and `produces` at the root and on operations) is carried over exactly, so
  // generating from it records no diagnostic of any kind. A finding here is a construct the conversion no longer handles.
  it('records no diagnostic, and every tool of it has a server', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(loadDocument('netlify-trimmed-2.0.json'));
    const tools = await generator.generateTools();
    expect(tools).toHaveLength(177);
    expect(generator.getDiagnostics()).toEqual([]);
    expect(tools.filter((tool) => (tool.metadata.servers ?? []).length === 0)).toEqual([]);
  });
});
