import type { JSONSchema } from 'zod/v4/core';

/** JSON Schema type from Zod v4 */
type JsonSchema = JSONSchema.JSONSchema;
import type {
  ResponseObject,
  GenerateOptions,
  MediaTypeObject,
  ResponsesObject,
  ResponseStreamInfo,
  SchemaConversionOptions,
} from './types';
import { isReferenceObject, toJsonSchema } from './types';
import { collectExampleValues } from './parameter-resolver';
import { isSpecObject, ownProperty } from './spec';

/**
 * The text describing a response: its `description`, else (OpenAPI 3.2,
 * where `description` is optional) its `summary`. `description` is returned
 * as the document holds it whenever it is present, as before.
 */
function responseDescription(response: ResponseObject): unknown {
  if (response.description !== undefined) return response.description;
  const summary = ownProperty(response, 'summary');
  return typeof summary === 'string' ? summary : undefined;
}

/**
 * Builds output schemas from OpenAPI response definitions.
 *
 * The output schema (`build`) comes from a response's media type chosen by
 * preference (`application/json`, `application/hal+json`,
 * `application/problem+json`, `application/xml`, `text/plain`, `text/html`,
 * else the first): its `schema` describes the complete content. An OpenAPI
 * 3.2 `itemSchema` describes each item of a sequential media type
 * (`text/event-stream`, `application/jsonl`, ...) and is reported apart
 * (`buildStream`), from the media type chosen for streaming, which need not
 * be the same one. A media type with only `itemSchema` contributes nothing to
 * the output schema, since a tool declaring one must return the complete
 * result as structured content, which an unbounded stream is not.
 */
export class ResponseBuilder {
  private preferredStatusCodes: number[];
  private includeAllResponses: boolean;
  private includeExamples: boolean;
  private schemaConversion: SchemaConversionOptions;

  /**
   * @param schemaConversion - limits for converting response schemas (see
   *   `SchemaConversionOptions`). `OpenAPIToolGenerator` sets them from
   *   `maxSchemaDepth` / `maxSchemaNodes`; unbounded when omitted.
   */
  constructor(options: GenerateOptions = {}, schemaConversion: SchemaConversionOptions = {}) {
    this.preferredStatusCodes = options.preferredStatusCodes ?? [200, 201, 204, 202, 203, 206];
    this.includeAllResponses = options.includeAllResponses ?? true;
    this.includeExamples = options.includeExamples ?? false;
    this.schemaConversion = schemaConversion;
  }

  /**
   * Build output schema from responses
   */
  build(responses?: ResponsesObject): JsonSchema | undefined {
    if (!responses || Object.keys(responses).length === 0) {
      return undefined;
    }

    // Decide which responses are emitted before converting any schema, so a
    // response that is left out costs no conversion work — and cannot exceed
    // the conversion budget on behalf of the ones that are kept
    const candidates = this.collectResponses(responses);

    if (candidates.length === 0) {
      return undefined;
    }

    if (candidates.length === 1) {
      return this.extractResponseSchema(candidates[0]);
    }

    if (this.includeAllResponses) {
      // Return union of all response schemas
      return {
        oneOf: candidates.map((candidate) => this.extractResponseSchema(candidate)),
        description: 'Response can be one of multiple status codes',
      };
    } else {
      // Return only the preferred status code
      return this.extractResponseSchema(this.selectPreferredResponse(candidates));
    }
  }

  /**
   * The streamed response of an operation (OpenAPI 3.2):
   *
   * - the response: of those with a media type declaring `itemSchema`, the
   *   one preferred like `includeAllResponses: false` prefers an output
   *   schema (status codes in `preferredStatusCodes` order, then any 2xx, any
   *   3xx, the first); `default` only when no status code has one;
   * - its media type: the first in the response's `content`, in the document's
   *   key order, that declares `itemSchema`. This is independent of the media
   *   type `build` reads, so `application/json` next to `text/event-stream`
   *   gives both an output schema and a stream.
   *
   * The item schema is converted with the same limits as output schemas.
   * `undefined` when no response streams.
   */
  buildStream(responses?: ResponsesObject): ResponseStreamInfo | undefined {
    if (!isSpecObject(responses)) return undefined;

    const candidates: StreamCandidate[] = [];
    for (const [statusCode, response] of Object.entries(responses)) {
      if (statusCode === 'default') continue;
      const code = parseInt(statusCode, 10);
      if (isNaN(code)) continue;
      const stream = this.streamOf(response);
      if (stream) candidates.push({ statusCode: code, ...stream });
    }
    if (candidates.length === 0) {
      const stream = this.streamOf(ownProperty(responses, 'default'));
      if (stream) candidates.push({ statusCode: 0, ...stream });
    }
    if (candidates.length === 0) return undefined;

    const { statusCode, contentType, itemSchema } = this.selectPreferredResponse(candidates);
    return { statusCode, contentType, itemSchema: toJsonSchema(itemSchema, this.schemaConversion) };
  }

  /**
   * The streamed media type of a response and its `itemSchema`, chosen apart
   * from the media type its output schema comes from: the first in the
   * response's `content`, in the document's key order, that declares
   * `itemSchema`. So a response offering `application/json` and
   * `text/event-stream` gives its output schema from the first and its stream
   * from the second.
   */
  private streamOf(response: unknown): Omit<StreamCandidate, 'statusCode'> | undefined {
    if (!isSpecObject(response) || isReferenceObject(response)) return undefined;
    const content = response['content'];
    if (!isSpecObject(content)) return undefined;
    for (const contentType of Object.keys(content)) {
      const itemSchema = ownProperty(content[contentType], 'itemSchema');
      // A schema is an object or, from 3.1 on, a boolean
      if (typeof itemSchema === 'boolean' || isSpecObject(itemSchema)) return { contentType, itemSchema };
    }
    return undefined;
  }

  /**
   * Collect the responses that yield an output schema (without converting it)
   */
  private collectResponses(responses: ResponsesObject): ResponseCandidate[] {
    const candidates: ResponseCandidate[] = [];

    for (const [statusCode, response] of Object.entries(responses)) {
      // Skip if it's a reference object
      if (isReferenceObject(response)) continue;

      // Skip 'default' for now, we'll handle it separately
      if (statusCode === 'default') continue;

      const code = parseInt(statusCode, 10);
      if (isNaN(code)) continue;

      if (this.yieldsSchema(response)) {
        candidates.push({ statusCode: code, response });
      }
    }

    // Handle default response if no other schemas found
    if (candidates.length === 0 && responses['default']) {
      const defaultResponse = responses['default'];
      if (!isReferenceObject(defaultResponse) && this.yieldsSchema(defaultResponse)) {
        candidates.push({ statusCode: 0, response: defaultResponse });
      }
    }

    return candidates;
  }

  /**
   * Whether a response yields an output schema: one without content yields a
   * `null` schema; one with content needs a schema for its selected media type
   */
  private yieldsSchema(response: ResponseObject): boolean {
    // 3.2 also allows a Reference Object here; like the rest of generation, read it as resolved
    return (
      !response.content ||
      Boolean((response.content as Record<string, MediaTypeObject>)[this.selectContentType(response.content)]?.schema)
    );
  }

  /**
   * Build the output schema of a single response
   */
  private extractResponseSchema({ statusCode, response }: ResponseCandidate): JsonSchema {
    // `description`, else (OpenAPI 3.2) `summary`
    const description = responseDescription(response);
    if (!response.content) {
      // Response with no content (e.g., 204 No Content)
      return {
        type: 'null',
        description,
        'x-status-code': statusCode,
      } as JsonSchema;
    }

    const contentType = this.selectContentType(response.content);
    // 3.2 also allows a Reference Object here; like the rest of generation, read it as resolved
    const mediaType = response.content[contentType] as MediaTypeObject;

    const schema: JsonSchema & { 'x-status-code'?: number } = {
      // collectResponses only keeps responses whose media type has a schema
      ...toJsonSchema(mediaType.schema!, this.schemaConversion),
      'x-status-code': statusCode,
    };

    // Add description if not already present
    if (!schema.description && description) {
      schema.description = description as string;
    }

    // Media-type-level example(s) are more specific than schema-level ones,
    // so they replace any schema-derived `examples` when enabled.
    if (this.includeExamples) {
      const mediaExamples = collectExampleValues(mediaType.example, mediaType.examples);
      if (mediaExamples) {
        schema.examples = mediaExamples as JsonSchema['examples'];
      }
    }

    // Add content type metadata
    (schema as any)['x-content-type'] = contentType;

    return schema;
  }

  /**
   * Select the most appropriate content type
   */
  private selectContentType(content: Record<string, any>): string {
    // Preference order for responses
    const preferences = [
      'application/json',
      'application/hal+json',
      'application/problem+json',
      'application/xml',
      'text/plain',
      'text/html',
    ];

    for (const pref of preferences) {
      if (content[pref]) return pref;
    }

    // Fallback to first available
    return Object.keys(content)[0];
  }

  /**
   * Select the preferred response based on status code preferences
   */
  private selectPreferredResponse<T extends { statusCode: number }>(candidates: T[]): T {
    // First, try to find exact match in preferred list
    for (const preferredCode of this.preferredStatusCodes) {
      const found = candidates.find((c) => c.statusCode === preferredCode);
      if (found) return found;
    }

    // Next, try to find any 2xx response
    const success = candidates.find((c) => c.statusCode >= 200 && c.statusCode < 300);
    if (success) return success;

    // Next, try to find any 3xx response
    const redirect = candidates.find((c) => c.statusCode >= 300 && c.statusCode < 400);
    if (redirect) return redirect;

    // Fallback to first available
    return candidates[0];
  }
}

/**
 * A response that yields an output schema, with its numeric status code
 * (0 for `default`)
 */
interface ResponseCandidate {
  statusCode: number;
  response: ResponseObject;
}

/** A response whose chosen media type declares `itemSchema` (0 for `default`). */
interface StreamCandidate {
  statusCode: number;
  contentType: string;
  itemSchema: object | boolean;
}
