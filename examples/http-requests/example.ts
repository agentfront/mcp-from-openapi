/**
 * The request pipeline without any framework: generate tools, then turn tool
 * input into a real HTTP call — buildHttpRequest applies the mapper with the
 * full OpenAPI serialization table (styles, explode, bodies, cookies), and
 * SecurityResolver supplies credentials.
 */
import { OpenAPIToolGenerator, SecurityResolver, buildHttpRequest, createSecurityContext } from 'mcp-from-openapi';
import type { McpOpenAPITool, OpenAPIDocument, SecurityContext } from 'mcp-from-openapi';

export interface CallToolOptions {
  apiBaseUrl: string;
  auth?: Partial<SecurityContext>;
}

/** Generate tools once; keep them keyed by name for dispatch. */
export async function loadTools(spec: OpenAPIDocument): Promise<Map<string, McpOpenAPITool>> {
  const generator = await OpenAPIToolGenerator.fromJSON(spec);
  const tools = await generator.generateTools();
  return new Map(tools.map((tool) => [tool.name, tool]));
}

/**
 * Execute one tool call: mapper → request → fetch. This is everything an MCP
 * (or any other) runtime needs to bridge tool input to the API.
 */
export async function callTool(
  tool: McpOpenAPITool,
  input: Record<string, unknown>,
  options: CallToolOptions,
): Promise<{ status: number; body: unknown }> {
  // Resolve credentials for the tool's security schemes (no-op without any)
  const security = await new SecurityResolver().resolve(tool.mapper, createSecurityContext(options.auth ?? {}));

  // Pure request assembly: url, method, headers (incl. Cookie), body —
  // deepObject/pipeDelimited/multipart/... all handled from the mapper
  const built = buildHttpRequest(tool, input, { baseUrl: options.apiBaseUrl });

  const url = new URL(built.url);
  for (const [key, value] of Object.entries(security.query)) url.searchParams.append(key, value);

  // Fold cookie-based credentials into the Cookie header, preserving any
  // cookie parameters buildHttpRequest already composed
  const headers: Record<string, string> = { ...built.headers, ...security.headers };
  const securityCookies = Object.entries(security.cookies);
  if (securityCookies.length > 0) {
    const extra = securityCookies.map(([name, value]) => `${name}=${value}`).join('; ');
    headers['Cookie'] = headers['Cookie'] ? `${headers['Cookie']}; ${extra}` : extra;
  }

  const response = await fetch(url, {
    method: built.method,
    headers,
    body: built.body as never,
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
