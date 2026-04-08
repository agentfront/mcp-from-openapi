# Format Resolution

Format resolution enriches JSON Schema output with concrete constraints derived from OpenAPI `format` fields. When an OpenAPI schema declares `{ type: "string", format: "uuid" }`, the generated MCP tool schema can include a validation `pattern`, descriptive `description`, or numeric `minimum`/`maximum` range --- making the schema actionable for consumers.

## Quick Start

```typescript
import { OpenAPIToolGenerator } from 'mcp-from-openapi';

const generator = await OpenAPIToolGenerator.fromJSON(openApiSpec);

// Enable built-in format resolvers
const tools = await generator.generateTools({
  resolveFormats: true,
});
```

**Before** (default, `resolveFormats: false`):

```json
{
  "type": "string",
  "format": "uuid"
}
```

**After** (`resolveFormats: true`):

```json
{
  "type": "string",
  "format": "uuid",
  "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  "description": "UUID string (RFC 4122)"
}
```

## Options

Format resolution is configured through `GenerateOptions`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `resolveFormats` | `boolean` | `false` | Enable built-in format resolvers |
| `formatResolvers` | `Record<string, FormatResolver>` | `undefined` | Custom format resolvers (see below) |

### Behavior Matrix

| `resolveFormats` | `formatResolvers` | Result |
|------------------|-------------------|--------|
| `false` | not set | No resolution (format fields pass through as-is) |
| `true` | not set | Built-in resolvers applied |
| `false` | set | Only custom resolvers applied |
| `true` | set | Built-in + custom resolvers (custom overrides built-in for same format) |

## Built-in Format Resolvers

### String Formats

| Format | Adds | Value |
|--------|------|-------|
| `uuid` | `pattern` | `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$` |
| | `description` | `UUID string (RFC 4122)` |
| `date-time` | `description` | `ISO 8601 date-time (e.g., 2024-01-15T09:30:00Z)` |
| `date` | `pattern` | `^\d{4}-\d{2}-\d{2}$` |
| | `description` | `ISO 8601 date (e.g., 2024-01-15)` |
| `time` | `pattern` | `^\d{2}:\d{2}:\d{2}` |
| | `description` | `ISO 8601 time (e.g., 09:30:00)` |
| `email` | `description` | `Email address (RFC 5322)` |
| `uri` | `description` | `URI (RFC 3986)` |
| `uri-reference` | `description` | `URI reference (RFC 3986)` |
| `hostname` | `description` | `Internet hostname (RFC 1123)` |
| `ipv4` | `pattern` | `^((25[0-5]\|2[0-4]\d\|[01]?\d\d?)\.){3}(25[0-5]\|2[0-4]\d\|[01]?\d\d?)$` |
| | `description` | `IPv4 address` |
| `ipv6` | `description` | `IPv6 address (RFC 4291)` |

### Integer Formats

| Format | Adds | Value |
|--------|------|-------|
| `int32` | `minimum` | `-2147483648` |
| | `maximum` | `2147483647` |
| `int64` | `minimum` | `Number.MIN_SAFE_INTEGER` (-9007199254740991) |
| | `maximum` | `Number.MAX_SAFE_INTEGER` (9007199254740991) |

### Binary / Encoding Formats

| Format | Adds | Value |
|--------|------|-------|
| `byte` | `pattern` | `^[A-Za-z0-9+/]*={0,2}$` |
| | `description` | `Base64-encoded string (RFC 4648)` |
| `binary` | `description` | `Binary data` |

### Sensitive Data Formats

| Format | Adds | Value |
|--------|------|-------|
| `password` | `description` | `Password (sensitive, UI should mask input)` |

### Non-Destructive Behavior

Built-in resolvers **never overwrite** existing constraints. If a schema already has a `pattern`, `description`, `minimum`, or `maximum`, the resolver preserves the original value:

```typescript
// Input: already has a description
{ type: "string", format: "uuid", description: "The user's unique identifier" }

// Output: description is preserved, only pattern is added
{
  type: "string",
  format: "uuid",
  description: "The user's unique identifier",  // kept
  pattern: "^[0-9a-fA-F]{8}-..."                // added
}
```

## Custom Format Resolvers

Define your own resolvers for any format string --- including custom ones not in the OpenAPI specification.

### FormatResolver Type

```typescript
type FormatResolver = (schema: JsonSchema) => JsonSchema;
```

A resolver receives the full JSON Schema object and returns a new (or spread-copied) schema with additional constraints. The `format` field is still present on the input schema.

### Example: Custom Formats

```typescript
const tools = await generator.generateTools({
  formatResolvers: {
    // Custom phone number format
    'phone': (schema) => ({
      ...schema,
      pattern: '^\\+?[1-9]\\d{1,14}$',
      description: schema.description || 'E.164 phone number',
    }),

    // Custom currency format
    'currency': (schema) => ({
      ...schema,
      pattern: '^[A-Z]{3}$',
      description: schema.description || 'ISO 4217 currency code (e.g., USD, EUR)',
      minLength: 3,
      maxLength: 3,
    }),

    // Custom slug format
    'slug': (schema) => ({
      ...schema,
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
      description: schema.description || 'URL-safe slug',
    }),
  },
});
```

### Overriding Built-in Resolvers

Use `resolveFormats: true` with `formatResolvers` to override specific built-in resolvers while keeping the rest:

```typescript
const tools = await generator.generateTools({
  resolveFormats: true,
  formatResolvers: {
    // Override the built-in uuid resolver with a stricter v4-only pattern
    uuid: (schema) => ({
      ...schema,
      pattern: schema.pattern ?? '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      description: schema.description || 'UUID v4 string',
    }),

    // Override password with strength requirements
    password: (schema) => ({
      ...schema,
      minLength: schema.minLength ?? 8,
      description: schema.description || 'Password (min 8 characters, must include upper/lower/digit)',
    }),
  },
});
```

## Standalone Usage

The `resolveSchemaFormats` function and `BUILTIN_FORMAT_RESOLVERS` map are exported for use outside the generator pipeline:

```typescript
import { resolveSchemaFormats, BUILTIN_FORMAT_RESOLVERS } from 'mcp-from-openapi';

// Use built-in resolvers on any JSON Schema
const enrichedSchema = resolveSchemaFormats(mySchema, BUILTIN_FORMAT_RESOLVERS);

// Use a subset of built-in resolvers
const { uuid, email, 'date-time': dateTime } = BUILTIN_FORMAT_RESOLVERS;
const enrichedSchema = resolveSchemaFormats(mySchema, { uuid, email, 'date-time': dateTime });

// Mix built-in and custom
const enrichedSchema = resolveSchemaFormats(mySchema, {
  ...BUILTIN_FORMAT_RESOLVERS,
  phone: (schema) => ({ ...schema, pattern: '^\\+?[1-9]\\d{1,14}$' }),
});
```

## Scope

Format resolution is applied to both `inputSchema` (request parameters and body) and `outputSchema` (response body) of every generated tool. Resolution is recursive --- formats are resolved in nested `properties`, `items`, `additionalProperties`, and composition keywords (`allOf`, `anyOf`, `oneOf`, `not`).

### What It Does Not Do

- **Does not remove the `format` field** --- the original format annotation is always preserved alongside the added constraints.
- **Does not validate values** --- it adds constraints to the schema so that downstream consumers can perform validation.
- **Does not affect the `mapper`** --- parameter mapping (path/query/header/body routing) is unaffected.
