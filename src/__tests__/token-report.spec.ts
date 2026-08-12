/**
 * Tests for token estimation and tool-set budget reports
 */

import { estimateToolTokens, analyzeToolSet } from '../token-report';
import { OpenAPIToolGenerator } from '../generator';
import type { McpOpenAPITool } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const makeTool = (name: string, extras: Partial<McpOpenAPITool> = {}): McpOpenAPITool => ({
  name,
  description: `Description for ${name}`,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  mapper: [],
  metadata: { path: `/${name}`, method: 'get' },
  ...extras,
});

describe('estimateToolTokens', () => {
  it('estimates ceil(chars / 4) of the advertised definition', () => {
    const tool = makeTool('t');
    const advertised = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };

    expect(estimateToolTokens(tool)).toBe(Math.ceil(JSON.stringify(advertised).length / 4));
  });

  it('includes title, annotations, and outputSchema when present', () => {
    const bare = estimateToolTokens(makeTool('t'));
    const full = estimateToolTokens(
      makeTool('t', {
        title: 'Tool Title',
        annotations: { readOnlyHint: true },
        outputSchema: { type: 'array', items: { type: 'string' } },
      }),
    );

    expect(full).toBeGreaterThan(bare);
  });

  it('grows with schema size', () => {
    const small = estimateToolTokens(makeTool('t'));
    const big = estimateToolTokens(
      makeTool('t', {
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 40 }, (_, i) => [`field${i}`, { type: 'string', description: `Field ${i}` }]),
          ),
        } as any,
      }),
    );

    expect(big).toBeGreaterThan(small * 5);
  });
});

describe('analyzeToolSet', () => {
  it('reports counts, totals, and per-tool estimates sorted heaviest first', () => {
    const light = makeTool('light');
    const heavy = makeTool('heavy', {
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 30 }, (_, i) => [`f${i}`, { type: 'string', description: `Field number ${i}` }]),
        ),
      } as any,
    });
    const report = analyzeToolSet([light, heavy]);

    expect(report.toolCount).toBe(2);
    expect(report.perTool.map((t) => t.name)).toEqual(['heavy', 'light']);
    expect(report.estimatedTokens).toBe(report.perTool[0].tokens + report.perTool[1].tokens);
    expect(report.warnings).toEqual([]);
  });

  it('breaks per-tool ties by name for deterministic output', () => {
    const a = makeTool('aaa');
    const b = makeTool('bbb');
    (b as any).description = a.description.replace('bbb', 'aaa'); // equal size

    const report = analyzeToolSet([b, a]);
    expect(report.perTool[0].tokens).toBe(report.perTool[1].tokens);
    expect(report.perTool.map((t) => t.name)).toEqual(['aaa', 'bbb']);
  });

  it('warns when the tool count exceeds the recommended maximum', () => {
    const tools = Array.from({ length: 41 }, (_, i) => makeTool(`tool${i}`));
    const report = analyzeToolSet(tools);

    expect(report.warnings.some((w) => w.includes('41 tools'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('curate'))).toBe(true);
  });

  it('warns when the estimated total exceeds the token budget', () => {
    const tools = [makeTool('a'), makeTool('b')];
    const report = analyzeToolSet(tools, { tokenBudget: 10 });

    expect(report.warnings.some((w) => w.includes('token budget') || w.includes('-token budget'))).toBe(true);
  });

  it('flags disproportionately heavy tools by name, capping the listing at three', () => {
    const heavyTools = Array.from({ length: 4 }, (_, i) =>
      makeTool(`heavy${i}`, {
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 50 }, (_, j) => [`f${j}`, { type: 'string', description: `A rather long field description ${j}` }]),
          ),
        } as any,
      }),
    );
    const report = analyzeToolSet(heavyTools, { perToolWarning: 100, tokenBudget: 1e9 });

    const heavyWarning = report.warnings.find((w) => w.includes('exceed 100 tokens'));
    expect(heavyWarning).toBeDefined();
    expect(heavyWarning).toContain('heavy0');
    expect(heavyWarning).toContain('…'); // 4 heavy tools, listing capped at 3
  });

  it('lists all heavy tools without an ellipsis when three or fewer', () => {
    const heavy = makeTool('lone-heavy', {
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 50 }, (_, j) => [`f${j}`, { type: 'string', description: `Long field description ${j}` }]),
        ),
      } as any,
    });
    const report = analyzeToolSet([heavy], { perToolWarning: 100, tokenBudget: 1e9 });

    const warning = report.warnings.find((w) => w.includes('exceed 100 tokens'));
    expect(warning).toContain('lone-heavy');
    expect(warning).not.toContain('…');
  });

  it('honors custom thresholds', () => {
    const tools = [makeTool('a'), makeTool('b'), makeTool('c')];
    const report = analyzeToolSet(tools, { maxRecommendedTools: 2, tokenBudget: 1e9, perToolWarning: 1e9 });

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain('3 tools');
  });

  it('handles an empty tool set', () => {
    const report = analyzeToolSet([]);

    expect(report).toEqual({ toolCount: 0, estimatedTokens: 0, perTool: [], warnings: [] });
  });

  it('works end to end with generator output', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'Report API', version: '1.0.0' },
      paths: {
        '/a': { get: { operationId: 'getA', responses: { '200': { description: 'OK' } } } },
        '/b': { get: { operationId: 'getB', responses: { '200': { description: 'OK' } } } },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const report = analyzeToolSet(await generator.generateTools());

    expect(report.toolCount).toBe(2);
    expect(report.estimatedTokens).toBeGreaterThan(0);
    expect(report.warnings).toEqual([]);
  });
});
