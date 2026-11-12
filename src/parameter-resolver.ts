import type { JSONSchema } from 'zod/v4/core';

/** JSON Schema type from Zod v4 */
type JsonSchema = JSONSchema.JSONSchema;
import type {
  ParameterMapper,
  ParameterObject,
  RequestBodyObject,
  NamingStrategy,
  ParameterLocation,
  SchemaObject,
  ReferenceObject,
  SecurityRequirement,
  SecurityParameterInfo,
  SecuritySchemeObject,
  SchemaConversionOptions,
} from './types';
import { toJsonSchema, isReferenceObject } from './types';

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
   * Resolve all parameters for an operation
   */
  resolve(
    operation: any,
    pathParameters?: ParameterObject[],
    securityRequirements?: SecurityRequirement[],
    includeSecurityInInput?: boolean | string[],
  ): {
    inputSchema: JsonSchema;
    mapper: ParameterMapper[];
  } {
    const allParameters: ParameterObject[] = [...(pathParameters ?? []), ...(operation.parameters ?? [])];

    const requestBody = operation.requestBody as RequestBodyObject | undefined;

    // Collect all parameter names and detect conflicts
    const parametersByName = new Map<string, ParameterInfo[]>();

    // Process standard parameters
    allParameters.forEach((param) => {
      const info: ParameterInfo = {
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

      if (!parametersByName.has(param.name)) {
        parametersByName.set(param.name, []);
      }
      parametersByName.get(param.name)!.push(info);
    });

    // Process request body
    if (requestBody?.content) {
      const contentType = this.selectContentType(requestBody.content);
      const mediaType = requestBody.content[contentType];

      if (mediaType?.schema) {
        const mediaExamples = this.includeExamples
          ? collectExampleValues(mediaType.example, mediaType.examples)
          : undefined;
        /* c8 ignore next -- both sides of ?? tested: true by required body tests, false by optional body tests */
        this.extractBodyParameters(mediaType.schema, parametersByName, requestBody.required ?? false, contentType, mediaExamples, mediaType.encoding);
      }
    }

    // Resolve conflicts and build schema + mapper
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const mapper: ParameterMapper[] = [];

    for (const [originalName, params] of parametersByName.entries()) {
      if (params.length === 1) {
        // No conflict
        const param = params[0];
        const inputKey = originalName;

        properties[inputKey] = this.buildParameterSchema(param);
        if (param.required) {
          required.push(inputKey);
        }

        mapper.push({
          inputKey,
          type: param.location,
          key: originalName,
          required: param.required,
          style: param.style,
          explode: param.explode,
          allowReserved: param.allowReserved,
          serialization: param.serialization,
          ...(param.wholeBody && { wholeBody: true }),
        });
      } else {
        // Conflict - need to resolve
        params.forEach((param, index) => {
          const inputKey = this.namingStrategy.conflictResolver(originalName, param.location, index);

          properties[inputKey] = this.buildParameterSchema(param);
          if (param.required) {
            required.push(inputKey);
          }

          mapper.push({
            inputKey,
            type: param.location,
            key: originalName,
            required: param.required,
            style: param.style,
            explode: param.explode,
            allowReserved: param.allowReserved,
            serialization: param.serialization,
            ...(param.wholeBody && { wholeBody: true }),
          });
        });
      }
    }

    // Process security requirements
    if (securityRequirements && securityRequirements.length > 0) {
      this.processSecurityRequirements(
        securityRequirements,
        properties,
        required,
        mapper,
        includeSecurityInInput ?? false,
      );
    }

    const inputSchema: JsonSchema = {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
      additionalProperties: false,
    };

    return { inputSchema, mapper };
  }

  /**
   * Extract parameters from request body schema
   */
  private extractBodyParameters(
    schema: SchemaObject | ReferenceObject,
    parametersByName: Map<string, ParameterInfo[]>,
    required: boolean,
    contentType: string,
    mediaExamples?: unknown[],
    encoding?: Record<string, any>,
    prefix = '',
  ): void {
    if (!schema || typeof schema !== 'object') return;

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

        if (typeof propSchema === 'object') {
          const propEncoding = encoding?.[propName];
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

    // Add parameter metadata
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

    return schema;
  }

  /**
   * Select the most appropriate content type
   */
  private selectContentType(content: Record<string, any>): string {
    // Preference order
    const preferences = [
      'application/json',
      'application/x-www-form-urlencoded',
      'multipart/form-data',
      'application/xml',
      'text/plain',
    ];

    for (const pref of preferences) {
      if (content[pref]) return pref;
    }

    // Fallback to first available
    const firstKey = Object.keys(content)[0];
    if (!firstKey) {
      throw new Error('No content type available in request body');
    }
    return firstKey;
  }

  /**
   * Process security requirements and add to mapper/inputSchema
   */
  private processSecurityRequirements(
    securityRequirements: SecurityRequirement[],
    properties: Record<string, JsonSchema>,
    required: string[],
    mapper: ParameterMapper[],
    includeInInput: boolean | string[],
  ): void {
    for (const secReq of securityRequirements) {
      const { scheme, type, name: apiKeyName, in: apiKeyIn, scopes } = secReq;

      // Build security parameter info
      const securityInfo: SecurityParameterInfo = {
        scheme,
        type,
        scopes,
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
        // Unknown type, skip
        continue;
      }

      // Add to mapper (always)
      mapper.push({
        inputKey,
        type: paramLocation,
        key: headerKey,
        required: true,
        security: securityInfo,
      });

      // Add to inputSchema: everything when `true`, per-scheme when an array
      // (all schemes stay in the mapper either way)
      const schemeInInput = includeInInput === true || (Array.isArray(includeInInput) && includeInInput.includes(scheme));
      if (schemeInInput) {
        if (paramLocation === 'header') {
          (schema as any)['x-mcp-header'] = headerKey;
        }
        properties[inputKey] = schema;
        required.push(inputKey);
      }
    }
  }
}

/**
 * Internal parameter info structure
 */
interface ParameterInfo {
  name: string;
  location: ParameterLocation;
  required: boolean;
  schema: SchemaObject | ReferenceObject | JsonSchema;
  description?: string;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  deprecated?: boolean;
  examples?: unknown[];
  wholeBody?: boolean;
  serialization?: {
    contentType?: string;
    encoding?: Record<string, any>;
    binary?: boolean;
  };
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
  for (const key of keys) properties[key] = values.get(key) as JsonSchema;
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
  /* c8 ignore next -- defensive: callers guard with `typeof === 'object'` before invoking */
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
 * Internal helper shared with ResponseBuilder (not part of the public barrel).
 */
export function collectExampleValues(
  example: unknown,
  examples?: Record<string, unknown> | unknown[],
): unknown[] | undefined {
  if (examples && !Array.isArray(examples)) {
    const values = Object.values(examples)
      .filter((entry) => entry !== null && typeof entry === 'object' && !isReferenceObject(entry))
      .map((entry) => (entry as { value?: unknown }).value)
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
