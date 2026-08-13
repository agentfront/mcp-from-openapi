/**
 * Real MCP SDK wiring for the server story: a low-level `Server` (JSON Schema
 * tools, no zod conversion) and a `Client` linked over `InMemoryTransport`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { toSdkTool } from '../../src';
import type { McpOpenAPITool } from '../../src';

export interface CallOutcome {
  // Index signature keeps this assignable to the SDK's ServerResult shape
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type CallHandler = (tool: McpOpenAPITool, args: Record<string, unknown>) => Promise<CallOutcome>;

export interface McpPair {
  client: Client;
  shutdown(): Promise<void>;
}

export async function startMcpPair(tools: McpOpenAPITool[], onCall: CallHandler): Promise<McpPair> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server({ name: 'e2e-server', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => {
      const [name, config] = toSdkTool(tool);
      return { name, ...config } as Tool;
    }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      throw new Error(`unknown tool ${request.params.name}`);
    }
    return onCall(tool, (request.params.arguments ?? {}) as Record<string, unknown>);
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'e2e-client', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    shutdown: async () => {
      await client.close();
      await server.close();
    },
  };
}
