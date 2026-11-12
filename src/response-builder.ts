import type { JSONSchema } from 'zod/v4/core';

/** JSON Schema type from Zod v4 */
type JsonSchema = JSONSchema.JSONSchema;
import type { ResponseObject, GenerateOptions, ResponsesObject, SchemaConversionOptions } from './types';
import { isReferenceObject, toJsonSchema } from './types';
import { collectExampleValues } from './parameter-resolver';

/**
 * Builds output schemas from OpenAPI response definitions
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
    return !response.content || Boolean(response.content[this.selectContentType(response.content)]?.schema);
  }

  /**
   * Build the output schema of a single response
   */
  private extractResponseSchema({ statusCode, response }: ResponseCandidate): JsonSchema {
    if (!response.content) {
      // Response with no content (e.g., 204 No Content)
      return {
        type: 'null',
        description: response.description,
        'x-status-code': statusCode,
      } as JsonSchema;
    }

    const contentType = this.selectContentType(response.content);
    const mediaType = response.content[contentType];

    const schema: JsonSchema & { 'x-status-code'?: number } = {
      // collectResponses only keeps responses whose media type has a schema
      ...toJsonSchema(mediaType.schema!, this.schemaConversion),
      'x-status-code': statusCode,
    };

    // Add description if not already present
    if (!schema.description && response.description) {
      schema.description = response.description;
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
  private selectPreferredResponse(candidates: ResponseCandidate[]): ResponseCandidate {
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
