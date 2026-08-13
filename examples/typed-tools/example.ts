/**
 * Typed tools for code-execution surfaces.
 *
 * Code-mode runtimes (like FrontMCP CodeCall) present tools as importable,
 * typed functions instead of tool JSON — Anthropic measured ~98.7% token
 * reduction for this pattern. Two features make it work: `dottedNaming`
 * emits `namespace.method` names that bind as `await billing.listInvoices(...)`,
 * and `emitTypeSignatures` renders each tool's call contract as TypeScript.
 */
import { OpenAPIToolGenerator, dottedNaming } from 'mcp-from-openapi';
import type { McpOpenAPITool, OpenAPIDocument } from 'mcp-from-openapi';

export interface TypedSurface {
  tools: McpOpenAPITool[];
  /** All declarations concatenated — a virtual .d.ts of the whole API */
  declarations: string;
  /** One-line signatures keyed by tool name — compact listings for prompts */
  signatures: Record<string, string>;
}

export async function buildTypedSurface(spec: OpenAPIDocument): Promise<TypedSurface> {
  const generator = await OpenAPIToolGenerator.fromJSON(spec);
  const tools = await generator.generateTools({
    namingStrategy: dottedNaming(), // first tag -> namespace, operationId -> method
    emitTypeSignatures: true, // metadata.typescript = { signature, declaration }
  });

  const signatures: Record<string, string> = {};
  for (const tool of tools) {
    signatures[tool.name] = tool.metadata.typescript!.signature;
  }

  return {
    tools,
    declarations: tools.map((tool) => tool.metadata.typescript!.declaration).join('\n\n'),
    signatures,
  };
}
