import type { JSONSchema } from 'zod/v4/core';

/** JSON Schema type from Zod v4 */
type JsonSchema = JSONSchema.JSONSchema;
import type {
  ResponseObject,
  GenerateOptions,
  MediaTypeObject,
  ResponsesObject,
  ResponseStatusRange,
  ResponseStreamInfo,
  SchemaConversionOptions,
} from './types';
import { isPresentSchema, isReferenceObject, toJsonSchema } from './types';
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

/** A response's status as the output gives it: a code, a range (`'2XX'`), or 0 for `default`. */
export type ResponseStatus = number | ResponseStatusRange;

/** A range key: one digit from 1 to 5, then `XX` in any case (`2XX`, `4xx`). */
const RANGE_KEY = /^[1-5][Xx]{2}$/;

/**
 * The status a Responses Object key names: a code from 100 to 599 written as
 * three digits, or a range upper-cased (`'2XX'`); `undefined` for any other
 * key (`default`, an extension, `200 `, `0200`). Shared by generation and
 * lint. Internal.
 */
export function readStatusKey(key: string): ResponseStatus | undefined {
  if (RANGE_KEY.test(key)) return `${key[0]}XX` as ResponseStatusRange;
  return /^[1-5]\d{2}$/.test(key) ? Number(key) : undefined;
}

/** Whether `status` is the range of `code`'s class (`'2XX'` covers 200 to 299). */
function rangeCovers(status: ResponseStatus, code: number): boolean {
  return typeof status === 'string' && Number.isInteger(code) && Math.floor(code / 100) === Number(status[0]);
}

/** The first candidate with an explicit status code of class `digit` (2 for 200 to 299). */
function explicitInClass<T extends { statusCode: ResponseStatus }>(candidates: T[], digit: number): T | undefined {
  return candidates.find(
    (c) => typeof c.statusCode === 'number' && c.statusCode >= digit * 100 && c.statusCode < digit * 100 + 100,
  );
}

/** The candidate whose key is the range of class `digit` (`'2XX'` for 2). */
function rangeOfClass<T extends { statusCode: ResponseStatus }>(candidates: T[], digit: number): T | undefined {
  return candidates.find((c) => c.statusCode === `${digit}XX`);
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
      // The union of all response schemas: `anyOf`, as a value can match more than one (two bodiless responses)
      return {
        anyOf: candidates.map((candidate) => this.extractResponseSchema(candidate)),
        description: 'Response can be one of multiple status codes',
      };
    } else {
      // Return only the preferred status code
      return this.extractResponseSchema(this.selectPreferredResponse(candidates));
    }
  }

  /**
   * The status of each response `build` reads, in its order: a code, a range
   * (`'2XX'`) or 0 for `default`. Read from the responses, never from a
   * schema, which the document writes.
   */
  statuses(responses?: ResponsesObject): Array<number | ResponseStatusRange> {
    const candidates = responses ? this.collectResponses(responses) : [];
    const read =
      candidates.length > 1 && !this.includeAllResponses ? [this.selectPreferredResponse(candidates)] : candidates;
    return read.map((candidate) => candidate.statusCode);
  }

  /**
   * The streamed response of an operation (OpenAPI 3.2):
   *
   * - the response: of those with a media type declaring `itemSchema`, the
   *   one preferred like `includeAllResponses: false` prefers an output
   *   schema (see `selectPreferredResponse`: a preferred explicit code, any
   *   explicit 2xx, a range covering a preferred code or `2XX`, a 3xx, the
   *   first); `default` only when no status code has one;
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
      const code = readStatusKey(statusCode);
      if (code === undefined) continue;
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

      // An explicit code, or a range (`2XX`) kept as written, upper-cased
      const code = readStatusKey(statusCode);
      if (code === undefined) continue;

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
   * (a boolean `false` counts: it yields `{ not: {} }`, no value)
   */
  private yieldsSchema(response: ResponseObject): boolean {
    // 3.2 also allows a Reference Object here; like the rest of generation, read it as resolved
    return (
      !response.content ||
      isPresentSchema((response.content as Record<string, MediaTypeObject>)[this.selectContentType(response.content)]?.schema)
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

    const schema: JsonSchema & { 'x-status-code'?: ResponseStatus } = {
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
   * Select the preferred response (see `GenerateOptions.preferredStatusCodes`).
   * The first rule that finds a candidate decides:
   *
   * 1. an explicit status code in `preferredStatusCodes`, in its order;
   * 2. any explicit 2xx status code (the success class), the first in key
   *    order (JavaScript orders integer keys ascending);
   * 3. a range key covering a code in `preferredStatusCodes`, in its order,
   *    else the success range `2XX`;
   * 4. any explicit 3xx status code, else the range `3XX`;
   * 5. the first candidate.
   *
   * So an explicit status code wins over the range of its class when the code
   * is in `preferredStatusCodes` (rule 1) and whenever it is a 2xx (rule 2:
   * `{ 299, '2XX' }` gives 299, even though `2XX` covers the preferred 200).
   * A 3xx code wins over `3XX` only while no range covers a preferred code
   * (rule 3 comes first: `{ 399, '3XX' }` gives `3XX` with `[301]`, 399 with
   * the defaults). In the other classes the range wins when it covers a
   * preferred code (`{ 499, '4XX' }` gives `4XX` with `[404]`); otherwise
   * neither is chosen by a rule, and rule 5 takes the first in key order
   * (integer keys first, so 499 with the defaults).
   */
  private selectPreferredResponse<T extends { statusCode: ResponseStatus }>(candidates: T[]): T {
    for (const preferredCode of this.preferredStatusCodes) {
      const found = candidates.find((c) => c.statusCode === preferredCode);
      if (found) return found;
    }

    const explicitSuccess = explicitInClass(candidates, 2);
    if (explicitSuccess) return explicitSuccess;

    for (const preferredCode of this.preferredStatusCodes) {
      const found = candidates.find((c) => rangeCovers(c.statusCode, preferredCode));
      if (found) return found;
    }
    const successRange = rangeOfClass(candidates, 2);
    if (successRange) return successRange;

    const redirect = explicitInClass(candidates, 3) ?? rangeOfClass(candidates, 3);
    if (redirect) return redirect;

    return candidates[0];
  }
}

/**
 * A response that yields an output schema, with its status code, its range
 * (`'2XX'`), or 0 for `default`
 */
interface ResponseCandidate {
  statusCode: ResponseStatus;
  response: ResponseObject;
}

/** A response whose chosen media type declares `itemSchema` (0 for `default`). */
interface StreamCandidate {
  statusCode: ResponseStatus;
  contentType: string;
  itemSchema: object | boolean;
}
