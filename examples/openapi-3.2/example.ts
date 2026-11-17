/**
 * OpenAPI 3.2 in practice: the `QUERY` method, custom methods (`LINK`), an
 * `in: querystring` parameter, and a server-sent-events response described by
 * `itemSchema` — generated as tools, sent with buildHttpRequest, and (for the
 * stream) consumed item by item, each item validated against its schema.
 */
import Ajv2020 from 'ajv/dist/2020';
import { OpenAPIToolGenerator, buildHttpRequest } from 'mcp-from-openapi';
import type { McpOpenAPITool, OpenAPIDocument } from 'mcp-from-openapi';

/**
 * One small document with the four 3.2 shapes. The `openapi` field decides
 * which operations are read: declare `3.1.0` and `query` and
 * `additionalOperations` are ignored (see `diagnosticsOf`).
 */
export function filesApi(openapi: string): OpenAPIDocument {
  const total = { 'application/json': { schema: { type: 'object', properties: { total: { type: 'integer' } } } } };
  return {
    openapi,
    info: { title: 'Files API', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      // A GET whose whole query string is one parameter, form-urlencoded
      '/files': {
        get: {
          operationId: 'listFiles',
          parameters: [
            {
              name: 'filter',
              in: 'querystring',
              content: {
                'application/x-www-form-urlencoded': {
                  schema: {
                    type: 'object',
                    properties: { name: { type: 'string' }, tag: { type: 'array', items: { type: 'string' } } },
                  },
                },
              },
            },
          ],
          responses: { 200: { description: 'Files', content: total } },
        },
      },
      // A response that is a stream: each item of the sequence has this schema
      '/files/events': {
        get: {
          operationId: 'watchFiles',
          responses: {
            200: {
              description: 'Change events',
              content: {
                'text/event-stream': {
                  itemSchema: {
                    type: 'object',
                    properties: {
                      event: { type: 'string', enum: ['created', 'deleted'] },
                      data: { type: 'string' },
                      id: { type: 'string' },
                    },
                    required: ['event', 'data'],
                  },
                },
              },
            },
          },
        },
      },
      // The `query` operation: a safe, idempotent read that carries a body
      '/files/search': {
        query: {
          operationId: 'searchFiles',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { text: { type: 'string' }, limit: { type: 'integer' } },
                  required: ['text'],
                },
              },
            },
          },
          responses: { 200: { description: 'Matches', content: total } },
        },
      },
      // `additionalOperations`: HTTP methods that have no field of their own
      '/files/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        additionalOperations: {
          LINK: {
            operationId: 'linkFile',
            parameters: [{ name: 'Link', in: 'header', required: true, schema: { type: 'string' } }],
            responses: { 204: { description: 'Linked' } },
          },
        },
      },
    },
  };
}

/** Generate the tools; the generator is returned too, for its diagnostics. */
export async function loadTools(spec: OpenAPIDocument) {
  const generator = await OpenAPIToolGenerator.fromJSON(spec);
  const tools = await generator.generateTools();
  return { generator, tools: new Map(tools.map((tool) => [tool.name, tool])) };
}

/**
 * Everything the generator ignored or noticed, one line per finding. This is
 * the one line to run on a document that does not give the tools you expect.
 */
export async function diagnosticsOf(spec: OpenAPIDocument): Promise<string[]> {
  const { generator } = await loadTools(spec);
  return generator.getDiagnostics().map((d) => `${d.severity} ${d.code} ${d.path}`);
}

/**
 * Mapper → request → fetch. `built.method` is `QUERY` or `LINK` as it must be
 * sent, and `built.url` already carries the encoded query string: send it as it is.
 */
export async function callTool(tool: McpOpenAPITool, input: Record<string, unknown>, baseUrl: string) {
  const built = buildHttpRequest(tool, input, { baseUrl });
  const response = await fetch(built.url, {
    method: built.method,
    headers: built.headers,
    body: built.body as string | undefined,
  });
  return { status: response.status, body: await response.text() };
}

/** One server-sent event: the fields the stream carries, as strings. */
export type EventItem = Record<string, string>;

const EVENT_FIELDS = new Set(['event', 'data', 'id', 'retry']);

/** Parse one `field: value` block. Comment lines (`:keepalive`) and unknown fields are ignored, as the SSE rules say. */
function parseEvent(block: string): EventItem {
  const item: EventItem = {};
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    const field = colon > 0 ? line.slice(0, colon) : '';
    if (!EVENT_FIELDS.has(field)) continue;
    const value = line.slice(colon + 1).replace(/^ /, '');
    item[field] = Object.hasOwn(item, field) && field === 'data' ? `${item[field]}\n${value}` : value;
  }
  return item;
}

/**
 * Consume a streamed response as it arrives. The tool says what the stream is
 * (`metadata.responseStream`: status, media type, `itemSchema`) and has no
 * `outputSchema`; each item is validated against `itemSchema` before it is
 * yielded. A minimal parser (LF line endings): use an SSE client in production.
 */
export async function* streamItems(tool: McpOpenAPITool, baseUrl: string): AsyncGenerator<EventItem> {
  const stream = tool.metadata.responseStream;
  if (!stream) throw new Error(`Tool '${tool.name}' does not describe a streamed response`);

  // OpenAPI schemas carry formats Ajv does not know (int64, binary): don't fail on them
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = ajv.compile(stream.itemSchema);

  const built = buildHttpRequest(tool, {}, { baseUrl });
  const response = await fetch(built.url, {
    method: built.method,
    headers: { ...built.headers, accept: stream.contentType },
  });
  if (!response.ok || !response.body) throw new Error(`Stream request failed with HTTP ${response.status}`);

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    // A blank line ends an event; whatever follows the last one stays buffered
    for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
      const item = parseEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (Object.keys(item).length === 0) continue; // a comment-only block
      if (!validate(item)) throw new Error(`Event does not match itemSchema: ${ajv.errorsText(validate.errors)}`);
      yield item;
    }
  }
}
