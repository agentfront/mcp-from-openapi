import type { JSONSchema } from 'zod/v4/core';

/** JSON Schema type from Zod v4 */
type JsonSchema = JSONSchema.JSONSchema;
import type {
  ParameterMapper,
  ParameterObject,
  RequestBodyObject,
  MediaTypeObject,
  NamingStrategy,
  ParameterLocation,
  SchemaOrBoolean,
  ReferenceObject,
  SecurityRequirement,
  SecurityParameterInfo,
  SecuritySchemeObject,
  SchemaConversionOptions,
} from './types';
import { toJsonSchema, isReferenceObject, isPresentSchema } from './types';
import { diagnosticKey, isSpecObject, ownProperty, setOwnProperty } from './spec';
import { GenerationError } from './errors';
import { classifyMediaType } from './media-type';

/**
 * Request media types in order of preference: the one a request body is read
 * in, and the one a parameter's `content` is read in when it (wrongly) lists
 * several. Any other media type comes after these, in document order.
 */
const REQUEST_MEDIA_TYPE_PREFERENCES: readonly string[] = Object.freeze([
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'application/xml',
  'text/plain',
]);

/**
 * The media type of a `content` map that is read: the first of
 * `REQUEST_MEDIA_TYPE_PREFERENCES` present (with a value), else the first key;
 * `undefined` for an empty map. Internal (not part of the public barrel).
 */
export function selectRequestMediaType(content: Record<string, unknown>): string | undefined {
  for (const preference of REQUEST_MEDIA_TYPE_PREFERENCES) {
    if (ownProperty(content, preference)) return preference;
  }
  return Object.keys(content)[0];
}

/**
 * A parameter's `content`, as generation reads it:
 *
 * - `absent`: no `content` (missing, or `null`);
 * - `invalid`: `content` is not a map (a string, an array, ...);
 * - `empty`: a map without any media type;
 * - `media`: the media type read — the only one or, of several (`count` > 1,
 *   which OpenAPI forbids), the one `selectRequestMediaType` picks — with its
 *   Media Type Object (`undefined` when that is not an object).
 */
export type ParameterContent =
  | { kind: 'absent' }
  | { kind: 'invalid'; value: unknown }
  | { kind: 'empty' }
  | { kind: 'media'; mediaType: string; media: Record<string, unknown> | undefined; count: number };

/** Reads a parameter's `content` (see `ParameterContent`). Internal. */
export function readParameterContent(parameter: unknown): ParameterContent {
  const content = ownProperty(parameter, 'content');
  if (content === undefined || content === null) return { kind: 'absent' };
  if (!isSpecObject(content)) return { kind: 'invalid', value: content };
  const count = Object.keys(content).length;
  if (count === 0) return { kind: 'empty' };
  const mediaType = selectRequestMediaType(content)!;
  const media = ownProperty(content, mediaType);
  return { kind: 'media', mediaType, media: isSpecObject(media) ? media : undefined, count };
}

/** A parameter of a path item's (`path`) or an operation's (`operation`) `parameters`, at `index`. */
export interface ParameterSlot {
  parameter: unknown;
  level: 'path' | 'operation';
  index: number;
}

/** A querystring rule an operation's parameters break (OpenAPI 3.2 `in: querystring`). */
export interface QuerystringProblem {
  code: 'MULTIPLE_QUERYSTRING_PARAMETERS' | 'QUERYSTRING_WITH_QUERY_PARAMETERS' | 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT';
  /**
   * The parameter concerned: the second querystring parameter, or the only
   * one (with query parameters, or without usable `content`)
   */
  slot: ParameterSlot;
  /** How many querystring parameters apply */
  querystrings: number;
}

/** How an operation's parameters combine with its path item's. Internal. */
export interface ParameterAnalysis {
  /**
   * The parameters that apply, in order: the path item's that the operation
   * does not override, then the operation's. An operation-level parameter
   * overrides a path-level one with the same `name` and `in` (OpenAPI
   * Operation Object `parameters`), and within one list the last of several
   * with the same `name` and `in` is kept. Header names match in any case
   * (`X-Id` and `x-id`), so the operation's spelling is the one sent. A
   * parameter without a string
   * `name` and `in` (a Reference Object left by `dereference: false`, a
   * malformed entry) is never merged: it is kept where it is.
   */
  effective: ParameterSlot[];
  /** Each parameter dropped because a later one in its own list has the same `name` and `in`. */
  duplicates: Array<{ dropped: ParameterSlot; kept: ParameterSlot }>;
  /** The querystring rule the parameters that apply break, if any. */
  querystring?: QuerystringProblem;
}

/**
 * The identity of a parameter (`name` and `in`), bounded in length;
 * `undefined` when it has none. A header name is compared without regard to
 * case, as HTTP header names are case-insensitive (RFC 9110 section 5.1):
 * `X-Id` and `x-id` are one header. Internal.
 */
export function parameterIdentity(parameter: unknown): string | undefined {
  if (!isSpecObject(parameter) || isReferenceObject(parameter)) return undefined;
  const name = parameter['name'];
  const location = parameter['in'];
  if (typeof name !== 'string' || typeof location !== 'string') return undefined;
  const key = location === 'header' ? name.toLowerCase() : name;
  // Bounded: a set of long strings of one length hashes into one bucket
  return diagnosticKey({ severity: 'info', code: '', message: JSON.stringify([location, key]) });
}

/**
 * Whether a media type is JSON: `application/json`, or `application/` + one or
 * more characters + `+json` (`application/problem+json`), parameters and case
 * ignored. `text/json` is not: the same rule `buildHttpRequest` writes JSON
 * text by (`classifyMediaType`). Internal.
 */
export function isJsonMediaType(mediaType: string): boolean {
  return classifyMediaType(mediaType) === 'json';
}

/**
 * The input schema of a parameter defined with `content` whose media type
 * declares no schema, by the media type's class (`classifyMediaType`, which
 * `buildHttpRequest` serializes by): unconstrained (`{}`) for JSON, whose text
 * can encode any value; an object for a form, which is built from one; a
 * string otherwise, as the value is sent as written.
 */
function schemaWithoutMediaSchema(mediaType: string): JsonSchema {
  switch (classifyMediaType(mediaType)) {
    case 'json':
      return {};
    case 'form':
      return { type: 'object' };
    default:
      return { type: 'string' };
  }
}

/**
 * What a `content` parameter's value becomes when its media type declares no
 * schema, for a diagnostic: the reading `schemaWithoutMediaSchema` gives.
 * Internal.
 */
export function describeContentWithoutSchema(mediaType: string): string {
  switch (classifyMediaType(mediaType)) {
    case 'json':
      return 'the value is unconstrained';
    case 'form':
      return 'the value is read as an object';
    default:
      return 'the value is read as a string';
  }
}

/** A parameter's `in`, when it is a Parameter Object. */
function parameterLocation(parameter: unknown): unknown {
  return isSpecObject(parameter) && !isReferenceObject(parameter) ? parameter['in'] : undefined;
}

/**
 * Combines a path item's parameters with an operation's (see
 * `ParameterAnalysis`). Shared by the resolver and the generator, which reads
 * the lists as the document holds them to point its diagnostics at them.
 * Internal.
 */
export function analyzeParameters(pathLevel: Iterable<unknown>, operationLevel: Iterable<unknown>): ParameterAnalysis {
  const slots: ParameterSlot[] = [];
  let index = 0;
  for (const parameter of pathLevel) slots.push({ parameter, level: 'path', index: index++ });
  index = 0;
  for (const parameter of operationLevel) slots.push({ parameter, level: 'operation', index: index++ });

  // The last slot of each identity is the one that applies
  const identities = slots.map((slot) => parameterIdentity(slot.parameter));
  const last = new Map<string, number>();
  identities.forEach((identity, position) => {
    if (identity !== undefined) last.set(identity, position);
  });
  const lastInLevel = new Map<string, number>();
  const effective: ParameterSlot[] = [];
  const duplicates: ParameterAnalysis['duplicates'] = [];
  // Backwards, so a duplicate finds the later slot of its own list that replaces it
  for (let position = slots.length - 1; position >= 0; position--) {
    const slot = slots[position];
    const identity = identities[position];
    if (identity === undefined || last.get(identity) === position) {
      effective.push(slot);
      if (identity !== undefined) lastInLevel.set(`${slot.level}:${identity}`, position);
      continue;
    }
    const sameLevel = lastInLevel.get(`${slot.level}:${identity}`);
    if (sameLevel !== undefined) {
      duplicates.push({ dropped: slot, kept: slots[sameLevel] });
    } else {
      // Overridden by the operation; a path-level duplicate before it is reported against this one
      lastInLevel.set(`${slot.level}:${identity}`, position);
    }
  }
  effective.reverse();
  duplicates.reverse();

  return { effective, duplicates, querystring: querystringProblem(effective) };
}

/**
 * The OpenAPI 3.2 rules on `in: querystring`, over the parameters that
 * apply: at most one, never together with `in: query` parameters, and
 * defined with `content` (a media type). A mapper breaking one could not be
 * serialized.
 */
function querystringProblem(effective: ParameterSlot[]): QuerystringProblem | undefined {
  const querystrings = effective.filter((slot) => parameterLocation(slot.parameter) === 'querystring');
  if (querystrings.length === 0) return undefined;
  const count = querystrings.length;
  if (count > 1) return { code: 'MULTIPLE_QUERYSTRING_PARAMETERS', slot: querystrings[1], querystrings: count };
  if (effective.some((slot) => parameterLocation(slot.parameter) === 'query')) {
    return { code: 'QUERYSTRING_WITH_QUERY_PARAMETERS', slot: querystrings[0], querystrings: count };
  }
  if (readParameterContent(querystrings[0].parameter).kind !== 'media') {
    return { code: 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT', slot: querystrings[0], querystrings: count };
  }
  return undefined;
}

/**
 * Options controlling parameter resolution behavior
 */
export interface ParameterResolverOptions {
  /**
   * Include parameter-level and media-type-level example(s) in the
   * generated input schema (as JSON Schema `examples` arrays).
   */
  includeExamples?: boolean;

  /**
   * Limits for converting parameter and request-body schemas (see
   * `SchemaConversionOptions`). `OpenAPIToolGenerator` sets them from
   * `maxSchemaDepth` / `maxSchemaNodes`; unbounded when omitted.
   */
  schemaConversion?: SchemaConversionOptions;
}

/**
 * Resolves parameters and handles naming conflicts
 */
export class ParameterResolver {
  private namingStrategy: NamingStrategy & { conflictResolver: NonNullable<NamingStrategy['conflictResolver']> };
  private includeExamples: boolean;
  private schemaConversion: SchemaConversionOptions;

  constructor(namingStrategy?: NamingStrategy, options?: ParameterResolverOptions) {
    this.namingStrategy = {
      ...namingStrategy,
      // Bind a supplied resolver to its own strategy object so class-based
      // strategies keep their `this` (we invoke it off a spread clone).
      conflictResolver: namingStrategy?.conflictResolver
        ? namingStrategy.conflictResolver.bind(namingStrategy)
        : this.defaultConflictResolver,
    };
    this.includeExamples = options?.includeExamples ?? false;
    this.schemaConversion = options?.schemaConversion ?? {};
  }

  /**
   * Default conflict resolver: prefix with location
   */
  private defaultConflictResolver(paramName: string, location: ParameterLocation, index: number): string {
    const locationPrefix = {
      path: 'path',
      query: 'query',
      header: 'header',
      cookie: 'cookie',
      body: 'body',
    }[location];

    return `${locationPrefix}${paramName.charAt(0).toUpperCase()}${paramName.slice(1)}`;
  }

  /**
   * Resolve all parameters for an operation.
   *
   * - The operation's parameters are merged with the path item's
   *   (`pathParameters`): an operation-level parameter overrides the
   *   path-level one with the same `name` and `in` (a header name in any
   *   case), and of several with the same `name` and `in` in one list the
   *   last is used (see `analyzeParameters`). Parameters with one name in
   *   different locations all stay, their input keys renamed by the naming
   *   strategy's `conflictResolver`.
   * - A parameter defined with `content` (a media type) instead of `schema`
   *   takes its input schema from the media type's `schema`; when the media
   *   type has none, it is unconstrained for a JSON media type
   *   (`application/json`, `application/*+json`), an object for
   *   `application/x-www-form-urlencoded` and a string otherwise (the
   *   classes `classifyMediaType` gives, which `buildHttpRequest`
   *   serializes by). Its mapper entry carries
   *   `serialization.contentType` (and the media type's `encoding`) and no
   *   `style` / `explode` / `allowReserved`. Its input property is annotated
   *   `x-parameter-content-type: <media type>`. A parameter with both keeps
   *   reading `schema`.
   * - An OpenAPI 3.2 `in: querystring` parameter becomes a `type: 'query'`
   *   mapper entry with `wholeQuery: true` (its value is the whole query
   *   string, serialized in its `content` media type); its input property is
   *   annotated `x-parameter-location: 'query'` and
   *   `x-parameter-whole-query: true`.
   * - `securityAlternatives`, when given, are the Security Requirement
   *   objects `securityRequirements` lists the schemes of. With more than
   *   one, they are a choice: each credential entry names the alternatives
   *   that need it (`security.alternatives`, `security.optional` when one
   *   is empty) and is not required, nor is its input.
   *
   * @throws GenerationError when the parameters break a querystring rule:
   *   more than one `in: querystring`, one together with `in: query`
   *   parameters, or one without `content` (`OpenAPIToolGenerator` skips
   *   such an operation with a diagnostic before calling this)
   */
  resolve(
    operation: any,
    pathParameters?: ParameterObject[],
    securityRequirements?: SecurityRequirement[],
    includeSecurityInInput?: boolean | string[],
    securityAlternatives?: SecurityRequirement[][],
  ): {
    inputSchema: JsonSchema;
    mapper: ParameterMapper[];
    /** Parameters left out of the tool, and why */
    ignored: IgnoredParameter[];
  } {
    const analysis = analyzeParameters(pathParameters ?? [], operation.parameters ?? []);
    if (analysis.querystring) {
      const { code, querystrings } = analysis.querystring;
      throw new GenerationError(
        `The parameters break an OpenAPI rule on in: querystring (${code}; ${querystrings} querystring ` +
          `parameter(s)): at most one, never with in: query parameters, and defined with content`,
        { code },
      );
    }

    const requestBody = operation.requestBody as RequestBodyObject | undefined;

    const credentials = this.securityEntries(
      securityRequirements ?? [],
      includeSecurityInInput ?? false,
      securityAlternatives ?? [],
    );
    const credentialWireNames = new Set(credentials.map(({ entry }) => wireName(entry.type, entry.key)));
    const ignored: IgnoredParameter[] = [];

    // Collect all parameter names and detect conflicts
    const parametersByName = new Map<string, ParameterInfo[]>();

    // Process standard parameters
    for (const { parameter } of analysis.effective) {
      const param = parameter as ParameterObject;
      if (param.in === 'header' && isIgnoredHeaderParameter(param.name)) {
        ignored.push({ name: param.name, in: param.in, reason: 'the HTTP client, a credential or a proxy sets this header' });
        continue;
      }
      if (credentialWireNames.has(wireName(param.in, param.name))) {
        ignored.push({ name: param.name, in: param.in, reason: 'a credential of the operation is sent there' });
        continue;
      }
      const info = this.parameterInfo(param);

      if (!parametersByName.has(param.name)) {
        parametersByName.set(param.name, []);
      }
      parametersByName.get(param.name)!.push(info);
    }

    // Process request body
    if (requestBody?.content) {
      const contentType = this.selectContentType(requestBody.content);
      // 3.2 also allows a Reference Object here; like the rest of generation, read it as resolved
      const mediaType = requestBody.content[contentType] as MediaTypeObject | undefined;

      // A media type with only `itemSchema` (a streamed body) is not read; the
      // generator records UNSUPPORTED_STREAMING_REQUEST_BODY for it. A boolean
      // schema is read: `true` is any body, `false` none
      if (mediaType && isPresentSchema(mediaType.schema)) {
        const mediaExamples = this.includeExamples
          ? collectExampleValues(mediaType.example, mediaType.examples)
          : undefined;
        /* c8 ignore next -- both sides of ?? tested: true by required body tests, false by optional body tests */
        this.extractBodyParameters(mediaType.schema!, parametersByName, requestBody.required ?? false, contentType, mediaExamples, mediaType.encoding);
      }
    }

    // Resolve conflicts and build schema + mapper
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const mapper: ParameterMapper[] = [];

    // A name used once keeps it; one used in several locations is renamed, never onto another input's key
    const taken = new Set([...parametersByName].filter(([, params]) => params.length === 1).map(([name]) => name));
    for (const [originalName, params] of parametersByName.entries()) {
      params.forEach((param, index) => {
        const inputKey =
          params.length === 1
            ? originalName
            : uniqueKey(this.namingStrategy.conflictResolver(originalName, param.location, index), taken);

        setOwnProperty(properties, inputKey, this.buildParameterSchema(param));
        if (param.required) {
          required.push(inputKey);
        }

        mapper.push(mapperEntry(inputKey, originalName, param));
      });
    }

    for (const { entry, schema } of credentials) {
      const inputKey = uniqueKey(entry.inputKey, taken);
      mapper.push({ ...entry, inputKey });
      if (schema) {
        setOwnProperty(properties, inputKey, schema);
        if (entry.required) required.push(inputKey);
      }
    }

    const inputSchema: JsonSchema = {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
      additionalProperties: false,
    };

    return { inputSchema, mapper, ignored };
  }

  /**
   * What one Parameter Object contributes: read from `schema` (with its
   * `style`, `explode`, `allowReserved`), or from `content` when it has no
   * `schema` or is in the query string, as a whole
   */
  private parameterInfo(param: ParameterObject): ParameterInfo {
    const wholeQuery = param.in === 'querystring';
    // `schema` wins when a parameter (wrongly) has both, as it always has; a
    // querystring parameter is defined by its content alone
    const content =
      wholeQuery || param.schema === undefined || param.schema === null
        ? readParameterContent(param)
        : ({ kind: 'absent' } as const);

    if (content.kind !== 'media') {
      return {
        name: param.name,
        location: param.in as ParameterLocation,
        required: param.required ?? param.in === 'path',
        schema: param.schema ?? { type: 'string' },
        description: param.description,
        style: param.style,
        explode: param.explode,
        allowReserved: param.allowReserved,
        deprecated: param.deprecated,
        examples: this.includeExamples ? collectExampleValues(param.example, param.examples) : undefined,
      };
    }

    // Serialized in a media type: style, explode and allowReserved do not apply
    const { mediaType: contentType, media } = content;
    const mediaSchema = ownProperty(media, 'schema');
    const encoding = ownProperty(media, 'encoding');
    return {
      name: param.name,
      // The whole query string is a query entry (ParameterLocation is unchanged)
      location: wholeQuery ? 'query' : (param.in as ParameterLocation),
      required: param.required ?? param.in === 'path',
      // No schema (or no Media Type Object): unconstrained for JSON, an object for a form, else a string
      schema: (mediaSchema ?? schemaWithoutMediaSchema(contentType)) as SchemaOrBoolean,
      description: param.description,
      deprecated: param.deprecated,
      // The parameter's own example(s) first, else the media type's
      examples: this.includeExamples
        ? (collectExampleValues(param.example, param.examples) ??
          collectExampleValues(ownProperty(media, 'example'), ownProperty(media, 'examples') as Record<string, unknown>))
        : undefined,
      contentType,
      ...(wholeQuery && { wholeQuery: true }),
      serialization: {
        contentType,
        ...(isSpecObject(encoding) && Object.keys(encoding).length > 0 && { encoding }),
      },
    };
  }

  /**
   * Extract parameters from request body schema
   */
  private extractBodyParameters(
    schema: SchemaOrBoolean | ReferenceObject,
    parametersByName: Map<string, ParameterInfo[]>,
    required: boolean,
    contentType: string,
    mediaExamples?: unknown[],
    encoding?: Record<string, any>,
    prefix = '',
  ): void {
    // A boolean schema is a whole body: `true` any value (`{}`), `false` none
    // (`{ not: {} }`, so a required one cannot be satisfied, as the document says)
    if (typeof schema !== 'boolean' && (!schema || typeof schema !== 'object')) return;

    // Convert to JsonSchema for processing
    const jsonSchema = toJsonSchema(schema, this.schemaConversion);

    // Flatten object bodies into named parameters — including `allOf`
    // compositions, whose object members merge into one property set.
    const flattened = flattenObjectBody(jsonSchema);

    if (flattened) {
      const requiredFields = flattened.required;

      for (const [propName, propSchema] of Object.entries(flattened.properties)) {
        /* c8 ignore next -- prefix is only used internally and defaults to '' */
        const fullName = prefix ? `${prefix}.${propName}` : propName;
        const isRequired = required && requiredFields.has(propName);

        // Always an object: conversion turns every subschema into one (a
        // boolean `false` property into `{ not: {} }`, which keeps it as an
        // input that accepts no value)
        if (typeof propSchema === 'object') {
          const propEncoding = ownProperty(encoding, propName) as Record<string, unknown> | undefined;
          // Distribute media-type-level whole-body examples onto the
          // flattened properties: { example: { name: 'Ada' } } -> name: ['Ada']
          const propExamples = mediaExamples
            ?.map((ex) =>
              ex !== null && typeof ex === 'object' && !Array.isArray(ex)
                ? (ex as Record<string, unknown>)[propName]
                : undefined,
            )
            .filter((value) => value !== undefined);
          const info: ParameterInfo = {
            name: fullName,
            location: 'body',
            required: isRequired,
            schema: propSchema as JsonSchema,
            description: (propSchema as any).description,
            examples: propExamples && propExamples.length > 0 ? propExamples : undefined,
            serialization: {
              contentType,
              ...(propEncoding && { encoding: { [propName]: propEncoding } }),
              ...(isBinarySchema(propSchema as JsonSchema) && { binary: true }),
            },
          };

          if (!parametersByName.has(fullName)) {
            parametersByName.set(fullName, []);
          }
          parametersByName.get(fullName)!.push(info);
        }
      }
    } else {
      // Whole-body parameter: non-object bodies (arrays, primitives, binary)
      // and root oneOf/anyOf unions that cannot be flattened into properties.
      const bodyParamName = prefix || 'body';
      const info: ParameterInfo = {
        name: bodyParamName,
        location: 'body',
        required,
        schema: jsonSchema,
        examples: mediaExamples,
        wholeBody: true,
        serialization: {
          contentType,
          ...(encoding && Object.keys(encoding).length > 0 && { encoding }),
          ...(isBinarySchema(jsonSchema) && { binary: true }),
        },
      };

      if (!parametersByName.has(bodyParamName)) {
        parametersByName.set(bodyParamName, []);
      }
      parametersByName.get(bodyParamName)!.push(info);
    }
  }

  /**
   * Build JSON Schema for a parameter
   */
  private buildParameterSchema(param: ParameterInfo): JsonSchema {
    const schema: JsonSchema = toJsonSchema(param.schema as any, this.schemaConversion);

    if (param.description) {
      schema.description = param.description;
    }

    // Parameter/media-type-level example(s) are more specific than schema-level
    // ones (OpenAPI: "the example SHOULD override the example provided by the
    // schema"), so they replace any schema-derived `examples`.
    if (param.examples && param.examples.length > 0) {
      schema.examples = param.examples as JsonSchema['examples'];
    }

    if (param.deprecated) {
      schema['deprecated'] = true;
    }

    // Add parameter metadata. `x-parameter-location` is the mapper type
    // (`query` for a whole-query parameter)
    (schema as any)['x-parameter-location'] = param.location;
    if (param.location === 'header') {
      // Original wire header name (conflict renames only change the inputKey)
      (schema as any)['x-mcp-header'] = param.name;
    }
    if (param.style) {
      (schema as any)['x-parameter-style'] = param.style;
    }
    if (param.explode !== undefined) {
      (schema as any)['x-parameter-explode'] = param.explode;
    }
    // A parameter defined with `content`: the media type its value is
    // serialized in (and, for `in: querystring`, that the value is the whole
    // query string)
    if (param.contentType !== undefined) {
      (schema as any)['x-parameter-content-type'] = param.contentType;
    }
    if (param.wholeQuery) {
      (schema as any)['x-parameter-whole-query'] = true;
    }

    return schema;
  }

  /**
   * Select the most appropriate content type
   */
  private selectContentType(content: Record<string, any>): string {
    const contentType = selectRequestMediaType(content);
    if (!contentType) {
      throw new Error('No content type available in request body');
    }
    return contentType;
  }

  /** The mapper entry of each scheme the requirements name, with its input schema when the scheme is an input */
  private securityEntries(
    securityRequirements: SecurityRequirement[],
    includeInInput: boolean | string[],
    alternatives: SecurityRequirement[][],
  ): Array<{ entry: ParameterMapper; schema?: JsonSchema }> {
    const entries: Array<{ entry: ParameterMapper; schema?: JsonSchema }> = [];
    const seen = new Set<string>();
    // A choice of requirement objects: no scheme is required on its own
    const choice = alternatives.length > 1;
    const optional = alternatives.some((alternative) => alternative.length === 0);
    for (const secReq of securityRequirements) {
      const { scheme, type, name: apiKeyName, in: apiKeyIn, scopes } = secReq;
      // A scheme named in several alternative requirements is one credential
      if (seen.has(scheme)) continue;
      seen.add(scheme);

      // Build security parameter info
      const securityInfo: SecurityParameterInfo = {
        scheme,
        type,
        scopes,
        ...(choice && {
          alternatives: alternatives.flatMap((alternative, index) =>
            alternative.some((requirement) => requirement.scheme === scheme) ? [index] : [],
          ),
          ...(optional && { optional }),
        }),
      };

      // Determine parameter details based on security type
      let inputKey: string;
      let headerKey: string;
      let paramLocation: ParameterLocation;
      let description: string;
      let schema: JsonSchema;

      if (type === 'http') {
        // HTTP auth (bearer, basic, etc.)
        inputKey = scheme;
        headerKey = 'Authorization';
        paramLocation = 'header';

        const httpScheme = 'httpScheme' in secReq && secReq.httpScheme ? secReq.httpScheme : 'bearer';
        const bearerFormat = 'bearerFormat' in secReq ? secReq.bearerFormat : undefined;

        securityInfo.httpScheme = httpScheme;
        if (bearerFormat) {
          securityInfo.bearerFormat = bearerFormat;
        }

        description = `${httpScheme.charAt(0).toUpperCase()}${httpScheme.slice(1)} authentication token`;
        if (bearerFormat) {
          description += ` (${bearerFormat})`;
        }

        schema = {
          type: 'string',
          description,
        };
      } else if (type === 'apiKey') {
        // API Key auth
        inputKey = scheme;
        headerKey = apiKeyName || 'X-API-Key';
        paramLocation = (apiKeyIn || 'header') as ParameterLocation;

        securityInfo.apiKeyName = apiKeyName;
        securityInfo.apiKeyIn = apiKeyIn;

        description = `API key for ${scheme}`;
        schema = {
          type: 'string',
          description,
        };
      } else if (type === 'oauth2' || type === 'openIdConnect') {
        // OAuth2 / OpenID Connect
        inputKey = scheme;
        headerKey = 'Authorization';
        paramLocation = 'header';

        description = `OAuth2 access token${scopes && scopes.length > 0 ? ` (scopes: ${scopes.join(', ')})` : ''}`;
        schema = {
          type: 'string',
          description,
        };
      } else {
        // mutualTLS: the HTTP client presents the certificate, there is nothing to map
        continue;
      }

      // In the input schema: every scheme when `true`, the listed ones when an array; always in the mapper
      const schemeInInput = includeInInput === true || (Array.isArray(includeInInput) && includeInInput.includes(scheme));
      if (schemeInInput && paramLocation === 'header') {
        (schema as any)['x-mcp-header'] = headerKey;
      }
      entries.push({
        entry: { inputKey, type: paramLocation, key: headerKey, required: !choice, security: securityInfo },
        ...(schemeInInput && { schema }),
      });
    }
    return entries;
  }
}

/** A parameter `resolve` leaves out of the tool */
export interface IgnoredParameter {
  /** The parameter's `name` */
  name: string;
  /** The parameter's `in` */
  in: string;
  /** Why it is not an input */
  reason: string;
}

/**
 * Header parameters a tool never takes: those OpenAPI says to ignore (`Accept`, `Content-Type`, `Authorization`)
 * and those that frame, route or forward a request, which the HTTP client, a credential or a proxy sets
 */
const IGNORED_HEADER_PARAMETERS: ReadonlySet<string> = new Set([
  'accept',
  'content-type',
  'authorization',
  'cookie',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'forwarded',
  'x-original-url',
  'x-rewrite-url',
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
]);

function isIgnoredHeaderParameter(name: string): boolean {
  const lowerCaseName = name.toLowerCase();
  return IGNORED_HEADER_PARAMETERS.has(lowerCaseName) || lowerCaseName.startsWith('x-forwarded-');
}

/** Where a value goes on the wire; header names compare in any case */
function wireName(location: string, name: string): string {
  return `${location}:${location === 'header' ? name.toLowerCase() : name}`;
}

/** `base`, or `base` with the first number from 2 that makes it a key not in `taken`; the key is then taken */
function uniqueKey(base: string, taken: Set<string>): string {
  let key = base;
  for (let suffix = 2; taken.has(key); suffix++) key = `${base}${suffix}`;
  taken.add(key);
  return key;
}

/**
 * Internal parameter info structure
 */
interface ParameterInfo {
  name: string;
  location: ParameterLocation;
  required: boolean;
  schema: SchemaOrBoolean | ReferenceObject | JsonSchema;
  description?: string;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  deprecated?: boolean;
  examples?: unknown[];
  wholeBody?: boolean;
  /** The value is the whole query string (OpenAPI 3.2 `in: querystring`) */
  wholeQuery?: boolean;
  /** The media type of a parameter defined with `content`, whose value is serialized in it */
  contentType?: string;
  serialization?: {
    contentType?: string;
    encoding?: Record<string, any>;
    binary?: boolean;
  };
}

/**
 * The mapper entry of one input property. A parameter defined with `content`
 * gets no `style`, `explode` or `allowReserved`: OpenAPI says they do not
 * apply to it.
 */
function mapperEntry(inputKey: string, originalName: string, param: ParameterInfo): ParameterMapper {
  const entry: ParameterMapper = { inputKey, type: param.location, key: originalName, required: param.required };
  if (param.contentType === undefined) {
    entry.style = param.style;
    entry.explode = param.explode;
    entry.allowReserved = param.allowReserved;
  }
  entry.serialization = param.serialization;
  if (param.wholeBody) entry.wholeBody = true;
  if (param.wholeQuery) entry.wholeQuery = true;
  return entry;
}

/**
 * A flattened view of an object request body: the combined property map and
 * required set, with `allOf` members merged in (later members win on property
 * collisions, required sets union).
 */
interface FlattenedObjectBody {
  properties: Record<string, JsonSchema>;
  required: Set<string>;
}

/**
 * Collect the property map and required set of an object schema, merging
 * `allOf` members (in order). Returns 'union' when the schema — or ANY allOf
 * member, at any depth — carries a root `oneOf`/`anyOf`: such bodies cannot
 * be flattened into named properties without deleting the union constraint,
 * so the caller must keep the body whole.
 *
 * The merge is the one a recursive `Object.assign` of each member's merged
 * map, in order, followed by the schema's own `properties`, would produce: a
 * key sits where it first appears in that sequence of assignments and holds
 * the value it was last assigned. Building that map for every member would
 * cost quadratic time and memory on a long `allOf` chain (each level copies
 * the whole map below it), so the two are found directly instead, by walks
 * that each visit a member once — every key of a repeated member has already
 * appeared (forward) or been assigned for the last time (backward). Both
 * walks keep their own stacks, so any `allOf` chain can be flattened (issue
 * #50). The schema is a `toJsonSchema` result, which is acyclic.
 */
function collectObjectMembers(schema: JsonSchema): FlattenedObjectBody | 'union' {
  // Forward, in assignment order (a member's members, then its own
  // properties): each key's first appearance, every required field, and
  // whether a union is reachable
  const keys: string[] = [];
  const seenKeys = new Set<string>();
  const required = new Set<string>();
  const entered = new Set<object>();
  const frames: { schema: Record<string, unknown>; members: unknown[]; next: number }[] = [];
  // False when `member` is a union
  const enter = (member: unknown): boolean => {
    /* c8 ignore next -- defensive: toJsonSchema always yields objects, so non-object members cannot reach here */
    if (!member || typeof member !== 'object') return true;
    if (entered.has(member)) return true;
    entered.add(member);
    const record = member as Record<string, unknown>;
    if (Array.isArray(record['oneOf']) || Array.isArray(record['anyOf'])) return false;
    frames.push({ schema: record, members: Array.isArray(record['allOf']) ? record['allOf'] : [], next: 0 });
    return true;
  };
  if (!enter(schema)) return 'union';
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.next < frame.members.length) {
      if (!enter(frame.members[frame.next++])) return 'union';
      continue;
    }
    frames.pop();
    const own = frame.schema;
    if (own['properties'] && typeof own['properties'] === 'object') {
      for (const key of Object.keys(own['properties'])) {
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          keys.push(key);
        }
      }
    }
    if (Array.isArray(own['required'])) {
      own['required'].forEach((field: string) => required.add(field));
    }
  }

  // Backward — own properties, then members from last to first: the first
  // value seen for a key is the one it was last assigned
  const values = new Map<string, unknown>();
  const assigned = new Set<object>();
  const pending: unknown[] = [schema];
  while (pending.length > 0) {
    const member = pending.pop();
    if (!member || typeof member !== 'object' || assigned.has(member)) continue;
    assigned.add(member);
    const record = member as Record<string, unknown>;
    if (record['properties'] && typeof record['properties'] === 'object') {
      const own = record['properties'] as Record<string, unknown>;
      for (const key of Object.keys(own)) {
        if (!values.has(key)) values.set(key, own[key]);
      }
    }
    // Pushed in order, so the last member is assigned first
    if (Array.isArray(record['allOf'])) {
      for (const child of record['allOf'] as unknown[]) pending.push(child);
    }
  }

  const properties: Record<string, JsonSchema> = {};
  for (const key of keys) setOwnProperty(properties, key, values.get(key));
  return { properties, required };
}

/**
 * Flatten an object body schema — including `allOf` compositions — into a
 * single property map. Returns undefined when the body cannot be represented
 * as named properties: `oneOf`/`anyOf` unions at the root OR inside any allOf
 * member (flattening would delete the union constraint), non-object schemas
 * (arrays, primitives, binary), and free-form objects without properties.
 */
function flattenObjectBody(schema: JsonSchema): FlattenedObjectBody | undefined {
  const collected = collectObjectMembers(schema);
  if (collected === 'union') return undefined;
  return Object.keys(collected.properties).length > 0 ? collected : undefined;
}

/**
 * Does the schema declare raw binary content (a file part / binary body)?
 * OpenAPI 3.0 uses `format: binary`; 3.1 omits `type` and uses
 * `contentMediaType` alone for raw binary — a schema with `type: 'string'`
 * and `contentMediaType` is an embedded *string* payload, not a file part.
 */
function isBinarySchema(schema: JsonSchema): boolean {
  /* c8 ignore next -- defensive: callers pass toJsonSchema results, which are always objects */
  if (!schema || typeof schema !== 'object') return false;
  const record = schema as Record<string, unknown>;
  if (record['format'] === 'binary') return true;
  return (
    typeof record['contentMediaType'] === 'string' &&
    record['contentEncoding'] === undefined &&
    record['type'] === undefined
  );
}

/**
 * Collect concrete example values from OpenAPI `example` / `examples` fields
 * (parameter or media-type level). The `examples` map wins over the singular
 * `example` (they are mutually exclusive per OpenAPI); `$ref` entries are
 * skipped because example refs are not dereferenced into values here.
 * Returns undefined when nothing usable is present.
 *
 * Of an Example Object, the data form is used: OpenAPI 3.2 `dataValue` when
 * present, else `value`. `serializedValue` and `externalValue` hold the
 * serialized form (or a link to it), not data, so an example with only those
 * is left out.
 *
 * Internal helper shared with ResponseBuilder (not part of the public barrel).
 */
export function collectExampleValues(
  example: unknown,
  examples?: Record<string, unknown> | unknown[],
): unknown[] | undefined {
  if (examples && !Array.isArray(examples)) {
    const values = Object.values(examples)
      .filter((entry) => entry !== null && typeof entry === 'object' && !isReferenceObject(entry))
      .map((entry) => {
        const dataValue = ownProperty(entry, 'dataValue');
        return dataValue !== undefined ? dataValue : (entry as { value?: unknown }).value;
      })
      .filter((value) => value !== undefined);
    if (values.length > 0) {
      return values;
    }
  }
  if (example !== undefined) {
    return [example];
  }
  return undefined;
}
