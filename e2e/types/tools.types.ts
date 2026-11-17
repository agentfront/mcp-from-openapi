/**
 * How consumers read a generated tool and the request built from it: the
 * mapper (a whole query string, parameters defined with `content`), the
 * metadata (a streamed response, server names) and the built request's query
 * string. All of it must keep compiling; the matching rejections are in
 * `rejections.types.ts` and the type-level facts (which fields are optional,
 * what they hold) in `shapes.types.ts`. Compiled by `yarn typecheck`, never
 * executed (see README.md).
 */
import { DIAGNOSTIC_CODES, buildHttpRequest } from 'mcp-from-openapi';
import type {
  BuiltHttpRequest,
  JsonSchema,
  McpOpenAPITool,
  ParameterLocation,
  ParameterMapper,
  ResponseHints,
  ResponseStatusRange,
  ResponseStreamInfo,
  SerializationInfo,
  ServerInfo,
  SpecDiagnostic,
  ToolMetadata,
} from 'mcp-from-openapi';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const tool: McpOpenAPITool;
declare const input: Record<string, unknown>;

// ---------------------------------------------------------------------------
// ParameterMapper.wholeQuery: the value IS the whole query string
// (OpenAPI 3.2 `in: querystring`), the way `wholeBody` marks a whole body
// ---------------------------------------------------------------------------

/** A whole-query entry: a `query` entry, marked `true`, whose media type is in `serialization`. */
export const wholeQueryEntry: ParameterMapper = {
  inputKey: 'filter',
  type: 'query',
  key: 'filter',
  required: true,
  wholeQuery: true,
  serialization: { contentType: 'application/json' },
};

/** In `application/x-www-form-urlencoded` the media type's Encoding Objects ride along, as for a body. */
export const wholeQueryForm: ParameterMapper = {
  inputKey: 'filter',
  type: 'query',
  key: 'filter',
  wholeQuery: true,
  serialization: {
    contentType: 'application/x-www-form-urlencoded',
    encoding: { tags: { style: 'form', explode: false } },
  },
};

/** The marker is optional, and an absent value is the same as `undefined`: every other entry omits it. */
export const ordinaryQueryEntry: ParameterMapper = { inputKey: 'limit', type: 'query', key: 'limit' };
export const undefinedWholeQuery: ParameterMapper = { inputKey: 'limit', type: 'query', key: 'limit', wholeQuery: undefined };

/** A mapper entry can still say it is a whole body, a different marker with a different type. */
export const wholeBodyEntry: ParameterMapper = { inputKey: 'body', type: 'body', key: 'body', wholeBody: true };
export const notWholeBody: ParameterMapper = { inputKey: 'body', type: 'body', key: 'body', wholeBody: false };

/** A request builder of the consumer's own, branching on `wholeQuery`. */
export function queryTransport(entries: ParameterMapper[]): 'whole' | 'pairs' | 'none' {
  const query = entries.filter((entry) => entry.type === 'query');
  if (query.some((entry) => entry.wholeQuery)) return 'whole';
  return query.length > 0 ? 'pairs' : 'none';
}

export function serializeWholeQuery(mapper: ParameterMapper[], values: Record<string, unknown>): string | undefined {
  for (const entry of mapper) {
    if (!entry.wholeQuery) continue;
    type Marked = [Expect<Equal<typeof entry.wholeQuery, true>>];
    const mediaType: string | undefined = entry.serialization?.contentType;
    const value: unknown = values[entry.inputKey];
    if (mediaType === 'application/json') return encodeURIComponent(JSON.stringify(value));
    if (mediaType === 'application/x-www-form-urlencoded') {
      // the media type's Encoding Objects, by property name, as for a body
      const style: string | undefined = entry.serialization?.encoding?.['tags']?.style;
      return `${style ?? 'form'}:${new URLSearchParams(value as Record<string, string>).toString()}`;
    }
    return encodeURIComponent(String(value));
  }
  return undefined;
}

/** A tool's entries are read the same way. */
export const toolHasWholeQuery: boolean = tool.mapper.some((entry) => entry.wholeQuery === true);

// ---------------------------------------------------------------------------
// SerializationInfo.contentType: a parameter defined with `content`
// ---------------------------------------------------------------------------

/** A path, query, header or cookie parameter defined with `content` names its media type. */
export const contentParameter: ParameterMapper = {
  inputKey: 'coordinates',
  type: 'query',
  key: 'coordinates',
  serialization: { contentType: 'application/json' },
};

export const contentHeader: ParameterMapper = {
  inputKey: 'X-Filter',
  type: 'header',
  key: 'X-Filter',
  serialization: { contentType: 'text/plain' },
};

/** Every field of the serialization info is optional: an entry may carry any of them, or an empty object. */
export const serializationFields: SerializationInfo[] = [
  {},
  { contentType: 'application/json' },
  { contentType: 'multipart/form-data', encoding: { file: { contentType: 'image/png' } }, binary: true },
  { binary: true },
];

/** Parameters read through `content`, by location and name; body entries carry a media type too and are left out. */
export function contentTypesOf(mapper: ParameterMapper[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of mapper) {
    if (entry.type === 'body' || entry.wholeQuery) continue;
    type Location = [Expect<Equal<typeof entry.type, 'path' | 'query' | 'header' | 'cookie'>>];
    const mediaType: string | undefined = entry.serialization?.contentType;
    if (mediaType !== undefined) found[`${entry.type}:${entry.key}`] = mediaType;
  }
  return found;
}

/** `ParameterLocation` is the five request locations a mapper entry has; `querystring` is not one of them. */
export const mapperLocations: ParameterLocation[] = ['path', 'query', 'header', 'cookie', 'body'];

// ---------------------------------------------------------------------------
// ToolMetadata.responseStream and ResponseHints.streaming: a streamed response
// (OpenAPI 3.2 `itemSchema`)
// ---------------------------------------------------------------------------

export const streamInfo: ResponseStreamInfo = {
  statusCode: 200,
  contentType: 'application/jsonl',
  itemSchema: { type: 'object', properties: { id: { type: 'string' } } },
};

/** `default` is 0, and a Server-Sent Events stream is described like any other. */
export const defaultStream: ResponseStreamInfo = { statusCode: 0, contentType: 'text/event-stream', itemSchema: {} };

/** A response range key (`2XX`) is not a number: the stream's status is the range, upper-cased as the output gives it. */
export const rangeStream: ResponseStreamInfo = { statusCode: '2XX', contentType: 'application/jsonl', itemSchema: {} };
export const everyRange: ResponseStatusRange[] = ['1XX', '2XX', '3XX', '4XX', '5XX'];

export const streamingHints: ResponseHints = { streaming: true };
export const noHints: ResponseHints = {};

export function describeStream(candidate: McpOpenAPITool): string {
  const stream: ResponseStreamInfo | undefined = candidate.metadata.responseStream;
  const streaming: boolean | undefined = candidate.metadata.responseHints?.streaming;
  if (stream === undefined) return `buffered ${streaming ?? false}`;
  // a code, or a range: narrow before using either as what it is
  const status: number | ResponseStatusRange = stream.statusCode;
  const label = typeof status === 'number' ? (status === 0 ? 'default' : `code ${status}`) : `range ${status}`;
  const mediaType: string = stream.contentType;
  const items: JsonSchema = stream.itemSchema;
  const events = mediaType === 'text/event-stream';
  return `${label} ${mediaType} ${events} ${JSON.stringify(items)}`;
}

/** A stream is a success when its status is a 2xx code or the `2XX` range. */
export function streamSucceeds(stream: ResponseStreamInfo): boolean {
  if (typeof stream.statusCode === 'number') return stream.statusCode >= 200 && stream.statusCode < 300;
  const range: ResponseStatusRange = stream.statusCode;
  return range === '2XX';
}

// ---------------------------------------------------------------------------
// ToolMetadata.responseStatusCodes and responseStatusRanges: the statuses of the output schema
// ---------------------------------------------------------------------------

/** Explicit codes are numbers (0 for `default`); a range goes in the other list. Each is absent when empty. */
export function describeStatuses(candidate: McpOpenAPITool): string {
  const codes: number[] = candidate.metadata.responseStatusCodes ?? [];
  const ranges: ResponseStatusRange[] = candidate.metadata.responseStatusRanges ?? [];
  const first: ResponseStatusRange | undefined = ranges[0];
  const successful = ranges.includes('2XX') || codes.some((code) => code >= 200 && code < 300);
  return `${codes.join(',')} ${ranges.join(',')} ${first ?? 'none'} ${successful}`;
}

/** A tool typed with metadata of the consumer's own keeps both lists. */
export function rangesOfExtendedTool(extended: McpOpenAPITool<ToolMetadata & { adapter: string }>): number {
  return (extended.metadata.responseStatusRanges ?? []).length + (extended.metadata.responseStatusCodes ?? []).length;
}

/** A tool typed with metadata of the consumer's own keeps the stream. */
export function streamOfExtendedTool(extended: McpOpenAPITool<ToolMetadata & { adapter: string }>): string | undefined {
  return extended.metadata.responseStream?.contentType;
}

// ---------------------------------------------------------------------------
// ServerInfo.name: a 3.2 server's unique name
// ---------------------------------------------------------------------------

export const namedServer: ServerInfo = {
  url: 'https://api.example.com',
  name: 'production',
  description: 'The live API',
};
export const unnamedServer: ServerInfo = { url: 'https://api.example.com' };

export function serverLabels(candidate: McpOpenAPITool): string[] {
  return (candidate.metadata.servers ?? []).map((server) => {
    const name: string | undefined = server.name;
    return name ?? server.url;
  });
}

// ---------------------------------------------------------------------------
// BuiltHttpRequest.queryString: set only when the query is not name/value pairs
// ---------------------------------------------------------------------------

/** A request whose query is pairs has no `queryString`... */
export const pairsRequest: BuiltHttpRequest = {
  url: 'https://example.com/pets?limit=10',
  method: 'GET',
  headers: {},
  query: { limit: ['10'] },
  cookies: {},
};

/** ...and one whose whole query string is a serialized value has it, with `query` empty. */
export const wholeQueryRequest: BuiltHttpRequest = {
  url: 'https://example.com/search?%7B%22a%22%3A1%7D',
  method: 'GET',
  headers: {},
  query: {},
  queryString: '%7B%22a%22%3A1%7D',
  cookies: {},
};

export function describeRequest(): string {
  const request = buildHttpRequest(tool, input);
  // `url` is authoritative; `queryString` says the text after `?` is not made of pairs
  const raw: string | undefined = request.queryString;
  const pairs: Record<string, string[]> = request.query;
  return raw === undefined ? `${request.url} ${Object.keys(pairs).join(',')}` : `${request.url} ${raw}`;
}

// ---------------------------------------------------------------------------
// The diagnostics of parameters, querystring rules and streaming bodies
// ---------------------------------------------------------------------------

/** The codes that skip an operation, and the ones that only warn about a parameter or a body. */
export const skippingCodes: string[] = [
  DIAGNOSTIC_CODES.MULTIPLE_QUERYSTRING_PARAMETERS,
  DIAGNOSTIC_CODES.QUERYSTRING_WITH_QUERY_PARAMETERS,
  DIAGNOSTIC_CODES.QUERYSTRING_PARAMETER_WITHOUT_CONTENT,
  DIAGNOSTIC_CODES.UNSUPPORTED_PARAMETER_LOCATION,
];
export const warningCodes: string[] = [
  DIAGNOSTIC_CODES.DUPLICATE_PARAMETER,
  DIAGNOSTIC_CODES.INVALID_PARAMETER_CONTENT,
  DIAGNOSTIC_CODES.UNSUPPORTED_STREAMING_REQUEST_BODY,
];

export function skippedOperations(diagnostics: SpecDiagnostic[]): string[] {
  return diagnostics.filter((diagnostic) => skippingCodes.includes(diagnostic.code)).map((diagnostic) => diagnostic.path ?? '');
}
