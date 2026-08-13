import type { JsonSchema, McpOpenAPITool, ToolAnnotations } from './types';

/**
 * A `registerTool`-shaped config for the official MCP TypeScript SDK.
 * `TSchema` is whatever the schema wrapper returns — the raw `JsonSchema`
 * when no wrapper is used, or the SDK's wrapped schema type.
 */
export interface SdkToolConfig<TSchema = JsonSchema> {
  title?: string;
  description: string;
  inputSchema: TSchema;
  outputSchema?: TSchema;
  annotations?: ToolAnnotations;
}

/**
 * Schema wrapper — pass the SDK v2 `fromJsonSchema` here so schemas are
 * advertised verbatim and validated by the SDK's JSON Schema validator.
 */
export interface SdkSchemaWrapper<TSchema> {
  fromJsonSchema: (schema: JsonSchema) => TSchema;
}

export function toSdkTool(tool: McpOpenAPITool): [name: string, config: SdkToolConfig];
export function toSdkTool<TSchema>(
  tool: McpOpenAPITool,
  wrapper: SdkSchemaWrapper<TSchema>,
): [name: string, config: SdkToolConfig<TSchema>];

/**
 * Shape a generated tool for the official MCP TypeScript SDK's
 * `registerTool(name, config, handler)`:
 *
 * ```ts
 * import { fromJsonSchema } from '@modelcontextprotocol/server'; // SDK v2
 *
 * for (const tool of await generator.generateTools()) {
 *   server.registerTool(...toSdkTool(tool, { fromJsonSchema }), makeHandler(tool));
 * }
 * ```
 *
 * Without a wrapper the config carries raw JSON Schemas — suitable for the
 * low-level v1 `Server` (`tools/list` handlers) or any framework that accepts
 * JSON Schema directly. This library never imports the SDK itself.
 *
 * MCP requires `outputSchema` to be a root `type: 'object'` schema
 * (structured content is an object) — real SDK clients reject listings that
 * violate this. Output schemas with any other root (arrays, scalars, and the
 * `includeAllResponses` status-union roots) are therefore OMITTED from the
 * SDK config; the full schema remains available on `tool.outputSchema`.
 */
export function toSdkTool(
  tool: McpOpenAPITool,
  wrapper?: SdkSchemaWrapper<unknown>,
): [name: string, config: SdkToolConfig<unknown>] {
  const wrapSchema = wrapper?.fromJsonSchema ?? ((schema: JsonSchema) => schema);
  const outputSchema =
    tool.outputSchema !== undefined && (tool.outputSchema as Record<string, unknown>)['type'] === 'object'
      ? tool.outputSchema
      : undefined;

  return [
    tool.name,
    {
      ...(tool.title !== undefined && { title: tool.title }),
      description: tool.description,
      inputSchema: wrapSchema(tool.inputSchema),
      ...(outputSchema !== undefined && { outputSchema: wrapSchema(outputSchema) }),
      ...(tool.annotations !== undefined && { annotations: tool.annotations }),
    },
  ];
}
