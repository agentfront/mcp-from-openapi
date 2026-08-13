/**
 * Tests for the MCP SDK registerTool adapter helper
 */

import { toSdkTool } from '../sdk';
import { OpenAPIToolGenerator } from '../generator';
import type { McpOpenAPITool } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fullTool: McpOpenAPITool = {
  name: 'listItems',
  title: 'List Items',
  description: 'Lists items.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } },
  mapper: [],
  metadata: { path: '/items', method: 'get' },
};

describe('toSdkTool', () => {
  it('returns a registerTool-shaped [name, config] pair with raw schemas by default', () => {
    const [name, config] = toSdkTool(fullTool);

    expect(name).toBe('listItems');
    expect(config).toEqual({
      title: 'List Items',
      description: 'Lists items.',
      annotations: { readOnlyHint: true },
      inputSchema: fullTool.inputSchema,
      outputSchema: fullTool.outputSchema,
    });
  });

  it('omits absent optional fields instead of emitting undefined keys', () => {
    const minimal: McpOpenAPITool = {
      name: 'bare',
      description: 'Bare tool.',
      inputSchema: { type: 'object', properties: {} },
      mapper: [],
      metadata: { path: '/bare', method: 'post' },
    };
    const [, config] = toSdkTool(minimal);

    expect('title' in config).toBe(false);
    expect('outputSchema' in config).toBe(false);
    expect('annotations' in config).toBe(false);
  });

  it('wraps both schemas through a provided fromJsonSchema', () => {
    const wrapped: unknown[] = [];
    const fromJsonSchema = (schema: unknown) => {
      wrapped.push(schema);
      return { kind: 'wrapped', schema };
    };
    const [, config] = toSdkTool(fullTool, { fromJsonSchema });

    expect(wrapped).toEqual([fullTool.inputSchema, fullTool.outputSchema]);
    expect((config.inputSchema as any).kind).toBe('wrapped');
    expect((config.outputSchema as any).kind).toBe('wrapped');
  });

  it('omits output schemas whose root is not type object (MCP requirement)', () => {
    const arrayRoot: McpOpenAPITool = {
      ...fullTool,
      outputSchema: { type: 'array', items: { type: 'string' } },
    };
    expect('outputSchema' in toSdkTool(arrayRoot)[1]).toBe(false);

    const unionRoot: McpOpenAPITool = {
      ...fullTool,
      outputSchema: { oneOf: [{ type: 'object' }, { type: 'string' }] } as any,
    };
    expect('outputSchema' in toSdkTool(unionRoot)[1]).toBe(false);

    // the wrapper is never invoked for an omitted output schema
    const wrapped: unknown[] = [];
    toSdkTool(arrayRoot, { fromJsonSchema: (s) => (wrapped.push(s), s) });
    expect(wrapped).toEqual([arrayRoot.inputSchema]);
  });

  it('spreads into a registerTool-style call for generator output', async () => {
    const spec: any = {
      openapi: '3.0.0',
      info: { title: 'SDK API', version: '1.0.0' },
      paths: {
        '/items': {
          get: {
            operationId: 'listItems',
            summary: 'List all items',
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    const [tool] = await generator.generateTools();

    const registered: Record<string, unknown> = {};
    const registerTool = (name: string, config: unknown) => {
      registered[name] = config;
    };
    registerTool(...toSdkTool(tool));

    expect(Object.keys(registered)).toEqual(['listItems']);
    expect((registered['listItems'] as any).title).toBe('List all items');
    expect((registered['listItems'] as any).annotations.readOnlyHint).toBe(true);
  });
});
