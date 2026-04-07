# SchemaBuilder

[Home](../README.md) | [API Reference](./api-reference.md)

---

## Overview

`SchemaBuilder` is a static utility class for building and manipulating JSON schemas. All methods are pure -- they return new schemas without modifying inputs.

```typescript
import { SchemaBuilder } from 'mcp-from-openapi';
```

---

## Type Constructors

### object

```typescript
SchemaBuilder.object(
  { name: { type: 'string' }, age: { type: 'integer' } },
  ['name'] // required fields
);
// { type: "object", properties: { name: ..., age: ... }, required: ["name"], additionalProperties: false }
```

### array

```typescript
SchemaBuilder.array({ type: 'string' }, { minItems: 1, maxItems: 100, uniqueItems: true });
// { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, uniqueItems: true }
```

### string

```typescript
SchemaBuilder.string({ minLength: 1, maxLength: 255, pattern: '^[a-z]+$', format: 'email', enum: ['a', 'b'] });
// { type: "string", minLength: 1, maxLength: 255, pattern: "^[a-z]+$", format: "email", enum: ["a", "b"] }
```

### number

```typescript
SchemaBuilder.number({ minimum: 0, maximum: 100, multipleOf: 0.5 });
// { type: "number", minimum: 0, maximum: 100, multipleOf: 0.5 }
```

### integer

```typescript
SchemaBuilder.integer({ minimum: 1, exclusiveMaximum: 1000 });
// { type: "integer", minimum: 1, exclusiveMaximum: 1000 }
```

### boolean

```typescript
SchemaBuilder.boolean();
// { type: "boolean" }
```

### null

```typescript
SchemaBuilder.null();
// { type: "null" }
```

---

## Composition

### merge

Merges multiple object schemas into one, combining their properties and required fields:

```typescript
const a = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };
const b = { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] };

SchemaBuilder.merge([a, b]);
// { type: "object", properties: { x: ..., y: ... }, required: ["x", "y"] }
```

Empty input returns `{ type: "object" }`. Single schema returns it as-is.

### union

Creates a `oneOf` union of schemas:

```typescript
SchemaBuilder.union([
  { type: 'string' },
  { type: 'number' },
]);
// { oneOf: [{ type: "string" }, { type: "number" }] }
```

Single schema returns it as-is (no unnecessary wrapping).

---

## Modification

These methods add metadata to existing schemas. All return new schemas.

### withDescription

```typescript
SchemaBuilder.withDescription(schema, 'A user object');
```

### withExample

Appends to the schema's `examples` array:

```typescript
SchemaBuilder.withExample(schema, { name: 'John', age: 30 });
```

### withDefault

```typescript
SchemaBuilder.withDefault(schema, 'unknown');
```

### withFormat

```typescript
SchemaBuilder.withFormat(schema, 'date-time');
```

### withPattern

```typescript
SchemaBuilder.withPattern(schema, '^[A-Z]{2}\\d{4}$');
```

### withEnum

```typescript
SchemaBuilder.withEnum(schema, ['active', 'inactive', 'pending']);
```

### withRange

```typescript
// Inclusive range
SchemaBuilder.withRange(schema, 0, 100);

// Exclusive range
SchemaBuilder.withRange(schema, 0, 100, { exclusive: true });

// Partial (min only)
SchemaBuilder.withRange(schema, 0);
```

### withLength

```typescript
SchemaBuilder.withLength(schema, 1, 255);  // min and max
SchemaBuilder.withLength(schema, 1);       // min only
SchemaBuilder.withLength(schema, undefined, 100); // max only
```

---

## Utilities

### clone

Deep clones a schema (JSON serialize/deserialize):

```typescript
const copy = SchemaBuilder.clone(schema);
```

### removeRefs

Recursively removes all `$ref` properties (use after dereferencing):

```typescript
const cleaned = SchemaBuilder.removeRefs(schema);
```

### flatten

Flattens nested `oneOf`, `anyOf`, and `allOf` schemas:

```typescript
// Input: { oneOf: [{ oneOf: [a, b] }, c] }
// Output: { oneOf: [a, b, c] }
SchemaBuilder.flatten(schema);
SchemaBuilder.flatten(schema, 5); // Custom max depth (default: 10)
```

### simplify

Removes empty arrays/objects and deduplicates matching title/description:

```typescript
SchemaBuilder.simplify(schema);
// Removes: empty required[], empty properties{}, empty examples[]
// Removes: title when it matches description
```

---

**Related:** [API Reference](./api-reference.md) | [Getting Started](./getting-started.md)
