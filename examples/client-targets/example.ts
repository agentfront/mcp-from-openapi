/**
 * Client compatibility targets: one spec, four schema dialects.
 *
 * Every model provider accepts a different JSON Schema subset — Claude
 * rejects top-level unions, Gemini rejects $ref/$defs and most formats,
 * OpenAI strict mode wants closed objects with every property required.
 * The `target` option emits the right dialect per connection.
 */
import { OpenAPIToolGenerator } from 'mcp-from-openapi';
import type { ClientTarget, McpOpenAPITool, OpenAPIDocument } from 'mcp-from-openapi';

/**
 * Generate the same tool set once per client dialect — e.g. serve `claude`
 * tools to a Claude connection and `openai` tools to an OpenAI connection.
 */
export async function generateForClients(
  spec: OpenAPIDocument,
  targets: ClientTarget[],
): Promise<Record<string, McpOpenAPITool[]>> {
  const result: Record<string, McpOpenAPITool[]> = {};
  for (const target of targets) {
    // A fresh generator per dialect keeps the transforms independent
    const generator = await OpenAPIToolGenerator.fromJSON(spec);
    result[target] = await generator.generateTools({ target });
  }
  return result;
}
