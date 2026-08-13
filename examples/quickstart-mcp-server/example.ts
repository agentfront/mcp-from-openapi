/**
 * Quickstart: OpenAPI spec → running MCP server.
 *
 * Generates MCP tools from a spec, registers them on the official
 * @modelcontextprotocol/sdk low-level Server, and proxies every tool call to
 * the real API — credentials resolved by SecurityResolver, requests built by
 * buildHttpRequest with full OpenAPI parameter serialization.
 */
import {
  OpenAPIToolGenerator,
  SecurityResolver,
  buildHttpRequest,
  createSecurityContext,
  toSdkTool,
} from 'mcp-from-openapi';
import type { McpOpenAPITool, OpenAPIDocument, SecurityContext } from 'mcp-from-openapi';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

export interface QuickstartOptions {
  /** OpenAPI document (or use fromURL/fromFile/fromYAML in your own code) */
  spec: OpenAPIDocument;
  /** Where the real API lives */
  apiBaseUrl: string;
  /** Credentials for the spec's security schemes, e.g. { apiKey: '...' } */
  auth?: Partial<SecurityContext>;
}

export async function createMcpServer(options: QuickstartOptions): Promise<{ server: Server; tools: McpOpenAPITool[] }> {
  // 1. Spec → tools. One preferred response per tool keeps output schemas
  //    MCP-friendly (structured content must be a single object shape).
  const generator = await OpenAPIToolGenerator.fromJSON(options.spec);
  const tools = await generator.generateTools({ preferredStatusCodes: [200, 201], includeAllResponses: false });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // 2. Credentials, resolved once — SecurityResolver turns the spec's
  //    security schemes + your context into concrete headers/query/cookies.
  const resolver = new SecurityResolver();
  const securityContext = createSecurityContext(options.auth ?? {});

  // 3. A standard MCP server: list advertises the generated tools verbatim,
  //    call proxies to the API.
  const server = new Server({ name: 'openapi-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => {
      const [name, config] = toSdkTool(tool);
      return { name, ...config } as Tool;
    }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    }

    const security = await resolver.resolve(tool.mapper, securityContext);
    const built = buildHttpRequest(tool, (request.params.arguments ?? {}) as Record<string, unknown>, {
      baseUrl: options.apiBaseUrl,
    });

    const url = new URL(built.url);
    for (const [key, value] of Object.entries(security.query)) url.searchParams.append(key, value);
    const headers: Record<string, string> = { ...built.headers, ...security.headers };
    const securityCookies = Object.entries(security.cookies);
    if (securityCookies.length > 0) {
      const extra = securityCookies.map(([name, value]) => `${name}=${value}`).join('; ');
      headers['Cookie'] = headers['Cookie'] ? `${headers['Cookie']}; ${extra}` : extra;
    }
    const response = await fetch(url, { method: built.method, headers, body: built.body as never });

    // Read the body ONCE and tolerate empty/text/HTML responses — real APIs
    // return 204s and error pages, and a JSON parse crash here would surface
    // as a protocol error instead of a tool result
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === '' ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }
    const structured =
      response.ok && payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined;
    return {
      content: [{ type: 'text', text: payload !== undefined ? JSON.stringify(payload) : text }],
      // structuredContent describes SUCCESS object shapes — everything else stays in content
      ...(structured && { structuredContent: structured }),
      isError: !response.ok,
    };
  });

  return { server, tools };
}
