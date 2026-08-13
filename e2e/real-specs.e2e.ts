/**
 * Real-spec story: three vendored real-world specs survive the whole
 * pipeline — generation, MCP name rules, JSON Schema 2020-12 validity (ajv),
 * every client-target dialect, lint, and token accounting. The literal counts
 * pin fixture↔spec drift (see e2e/fixtures/README.md).
 */
import { OpenAPIToolGenerator, analyzeToolSet, estimateToolTokens, lintDocument } from '../src';
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

  it('lints to the expected finding counts', () => {
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
