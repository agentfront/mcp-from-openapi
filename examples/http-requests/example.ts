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

  // Hand each resolved credential to buildHttpRequest as input, under its
  // security mapper entry's inputKey: it places the value (header, query pair
  // or cookie). Never append query credentials to the URL yourself:
  // url.searchParams.append rewrites the whole query and corrupts one that is
  // not name=value pairs (an `in: querystring` JSON value). An unresolved
  // credential is `undefined`, which also overrides what the model's own
  // arguments hold under that key.
  const where: Record<string, Record<string, string> | undefined> = {
    header: security.headers,
    query: security.query,
    cookie: security.cookies,
  };
  const credentials = Object.fromEntries(
    tool.mapper.filter((m) => m.security).map((m) => [m.inputKey, where[m.type]?.[m.key]]),
  );

  // Pure request assembly: url, method, headers (incl. Cookie and credentials), body —
  // deepObject/pipeDelimited/multipart/... all handled from the mapper
  const built = buildHttpRequest(tool, { ...input, ...credentials }, { baseUrl: options.apiBaseUrl });

  const response = await fetch(built.url, {
    method: built.method,
    headers: built.headers,
    body: built.body as never,
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}
