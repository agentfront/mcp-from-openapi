import type { JsonSchema, FormatResolver } from './types';

/**
 * Built-in format resolvers that enrich JSON Schema with concrete constraints.
 * Each resolver only adds constraints if not already present on the schema.
 */
export const BUILTIN_FORMAT_RESOLVERS: Record<string, FormatResolver> = {
  // String formats
  uuid: (schema) => ({
    ...schema,
    pattern: schema.pattern ?? '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    description: schema.description || 'UUID string (RFC 4122)',
  }),

  'date-time': (schema) => ({
    ...schema,
    description: schema.description || 'ISO 8601 date-time (e.g., 2024-01-15T09:30:00Z)',
  }),

  date: (schema) => ({
    ...schema,
    pattern: schema.pattern ?? '^\\d{4}-\\d{2}-\\d{2}$',
    description: schema.description || 'ISO 8601 date (e.g., 2024-01-15)',
  }),

  time: (schema) => ({
    ...schema,
    pattern: schema.pattern ?? '^\\d{2}:\\d{2}:\\d{2}',
    description: schema.description || 'ISO 8601 time (e.g., 09:30:00)',
  }),

  email: (schema) => ({
    ...schema,
    description: schema.description || 'Email address (RFC 5322)',
  }),

  uri: (schema) => ({
    ...schema,
    description: schema.description || 'URI (RFC 3986)',
  }),

  'uri-reference': (schema) => ({
    ...schema,
    description: schema.description || 'URI reference (RFC 3986)',
  }),

  hostname: (schema) => ({
    ...schema,
    description: schema.description || 'Internet hostname (RFC 1123)',
  }),

  ipv4: (schema) => ({
    ...schema,
    pattern: schema.pattern ?? '^((25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(25[0-5]|2[0-4]\\d|[01]?\\d\\d?)$',
    description: schema.description || 'IPv4 address',
  }),

  ipv6: (schema) => ({
    ...schema,
    description: schema.description || 'IPv6 address (RFC 4291)',
  }),

  // Integer formats
  int32: (schema) => ({
    ...schema,
    minimum: schema.minimum ?? -2147483648,
    maximum: schema.maximum ?? 2147483647,
  }),

  int64: (schema) => ({
    ...schema,
    minimum: schema.minimum ?? Number.MIN_SAFE_INTEGER,
    maximum: schema.maximum ?? Number.MAX_SAFE_INTEGER,
  }),

  // Binary/encoding formats
  byte: (schema) => ({
    ...schema,
    pattern: schema.pattern ?? '^[A-Za-z0-9+/]*={0,2}$',
    description: schema.description || 'Base64-encoded string (RFC 4648)',
  }),

  binary: (schema) => ({
    ...schema,
    description: schema.description || 'Binary data',
  }),

  // Sensitive data formats
  password: (schema) => ({
    ...schema,
    description: schema.description || 'Password (sensitive, UI should mask input)',
  }),
};

/**
 * Recursively resolve format fields in a JSON Schema tree.
 * For each schema node with a `format` field, the matching resolver
 * is applied to enrich the schema with concrete constraints.
 */
export function resolveSchemaFormats(
  schema: JsonSchema,
  resolvers: Record<string, FormatResolver>,
): JsonSchema {
  if (!schema || typeof schema !== 'object') return schema;

  let result: Record<string, unknown> = { ...schema };

  // Apply resolver to current node if it has a matching format
  const format = result['format'] as string | undefined;
  if (format && resolvers[format]) {
    result = { ...resolvers[format](result as JsonSchema) };
  }

  // Recursively process properties
  if (result['properties'] && typeof result['properties'] === 'object') {
    const props: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(result['properties'] as Record<string, JsonSchema>)) {
      props[key] = resolveSchemaFormats(value, resolvers);
    }
    result['properties'] = props;
  }

  // Recursively process items
  if (result['items']) {
    if (Array.isArray(result['items'])) {
      result['items'] = (result['items'] as JsonSchema[]).map((item) => resolveSchemaFormats(item, resolvers));
    } else {
      result['items'] = resolveSchemaFormats(result['items'] as JsonSchema, resolvers);
    }
  }

  // Recursively process additionalProperties
  if (result['additionalProperties'] && typeof result['additionalProperties'] === 'object') {
    result['additionalProperties'] = resolveSchemaFormats(result['additionalProperties'] as JsonSchema, resolvers);
  }

  // Recursively process composition keywords
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (result[key] && Array.isArray(result[key])) {
      result[key] = (result[key] as JsonSchema[]).map((s) => resolveSchemaFormats(s, resolvers));
    }
  }

  // Recursively process not
  if (result['not'] && typeof result['not'] === 'object') {
    result['not'] = resolveSchemaFormats(result['not'] as JsonSchema, resolvers);
  }

  return result as JsonSchema;
}
