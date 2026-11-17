# Client Compatibility Targets

[Home](../README.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)

---

## The problem

Every LLM client accepts a different JSON Schema subset: Claude rejects top-level unions on `input_schema` and caps tool names at 64 characters; OpenAI strict function calling requires closed objects (`additionalProperties: false`); Gemini rejects `$ref`/`$defs`, union-heavy schemas, type arrays, and most string formats. The same generated tool can be valid on one client and rejected by another.

`target` applies the transforms that make generated schemas valid for a specific client:

```typescript
const tools = await generator.generateTools({ target: "gemini" });
```

## Targets

| Target   | Transforms                                                                                                                                                                                                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strict` | The safe baseline for every client: local `$ref`s inlined and `$defs`/`definitions` stripped, arrays always carry `items`, root-level compositions collapsed (`allOf` merged; `oneOf`/`anyOf` documented and preserved under `x-variants`; nullable wrappers unwrapped with a "May be null." note, unless the other member accepts no value: see below)   |
| `claude` | = `strict`. Claude's other constraints (no top-level unions on input, 64-char names) are already the generator's defaults                                                                                                                                                                            |
| `openai` | `strict` + every object closed (`additionalProperties: false`) + every property listed in `required`, with originally-optional fields becoming nullable (`type: [..., 'null']`) — the full OpenAI strict function-calling contract. Typed maps (schema-valued `additionalProperties`) are left alone |
| `gemini` | `strict` + unions collapsed at **every** level (nullable wrappers unwrap, unless the other member accepts no value; `type: ['string','null']` arrays keep the first non-null type; other unions keep their first variant and document the omitted alternatives) + unsupported `format` values demoted into descriptions (`date-time` is kept)  |

## Schemas that accept no value

A schema no value satisfies (`false` in an OpenAPI 3.1 or 3.2 document, which becomes `{ not: {} }`; OpenAPI 3.0 writes it the same way) is a legal property that can never be sent. The transforms handle it so no target breaks on it:

| Target | `{ not: {} }` |
| --- | --- |
| `strict`, `claude` | Left as written |
| `openai` | An **optional** property of this kind cannot become required-and-nullable. In a closed object (`additionalProperties: false`, no `patternProperties`) it is left out, which forbids it just the same; in an open object it stays optional. A required one stays required, and the object can never be sent, as the document says |
| `gemini` | A `oneOf`/`anyOf` member that accepts nothing is not an alternative worth keeping: the first member that accepts a value is kept, and the note lists the other omitted ones (not the never member). When no member accepts a value, the first member is kept |

A **nullable wrapper whose other member accepts nothing** (`anyOf: [{ not: {} }, { type: 'null' }]`: a `false | null` property in OpenAPI 3.1 or 3.2, or a 3.0 schema written `{ not: {}, nullable: true }`, which the library reads as nullable although OpenAPI 3.0.3 applies `nullable` only next to `type`) is not unwrapped to that member, because the unwrapped schema would reject `null` too and the only value the union accepts would be gone. It is a union like any other, so `gemini` keeps its first member that accepts a value, `{ type: 'null' }`, at every level, and the other targets collapse it at the root into the `x-variants` node (a nested one is left as written, as are all nested unions). A wrapper around a schema that accepts values (`anyOf: [{ type: 'string' }, { type: 'null' }]`) unwraps as before:

```typescript
applyClientTarget({ anyOf: [{ not: {} }, { type: "null" }] }, "gemini");
// { type: 'null' }
applyClientTarget({ anyOf: [{ not: {} }, { type: "null" }] }, "claude");
// { description: 'Accepts one of 2 variants: variant 1; type null.', 'x-variants': [{ not: {} }, { type: 'null' }] }
applyClientTarget({ anyOf: [{ type: "string" }, { type: "null" }] }, "claude");
// { type: 'string', description: 'May be null.' }
```

```typescript
import { applyClientTarget, collapseNestedUnions } from "mcp-from-openapi";

const schema = { type: "object", additionalProperties: false, properties: { id: { type: "string" }, legacy: { not: {} } } };
applyClientTarget(schema, "openai");
// { type: 'object', additionalProperties: false, properties: { id: { type: ['string', 'null'] } }, required: ['id'] }
collapseNestedUnions({ oneOf: [{ not: {} }, { type: "integer" }, { type: "string" }] });
// { type: 'integer', description: '1 alternative schema variant(s) omitted for client compatibility: type string.' }
```

Lossy collapses always leave a trace: omitted variants are described in the `description` and root-level variants are preserved under `x-variants`, so no information silently disappears.

## Standalone use

Each transform is exported for use on schemas that did not come from this generator:

```typescript
import {
  applyClientTarget, // full pipeline for a target
  inlineLocalRefs,
  ensureArrayItems,
  collapseRootCompositions,
  collapseNestedUnions,
  demoteFormats,
  enforceClosedObjects,
  requireAllProperties,
} from "mcp-from-openapi";

const geminiSafe = applyClientTarget(anyJsonSchema, "gemini");
```

All transforms are pure and copy-on-write — inputs are never mutated.

`inlineLocalRefs` inlines a definition once per `$ref` to it, so definitions that reference each other twice expand exponentially. Pass `{ maxNodes }` to `applyClientTarget` or `inlineLocalRefs` to cap the inlined schema (every JSON value counts; past the budget a `SchemaError` is thrown). The generator passes `maxSchemaNodes`; standalone calls are unbounded unless you pass it. Inlining nests at most 1,000 levels, counting each `$ref` hop, and throws a `SchemaError` past that.

```typescript
const geminiSafe = applyClientTarget(untrustedSchema, "gemini", { maxNodes: 100_000 });
```

---

**Related:** [Configuration](./configuration.md) | [SchemaBuilder](./schema-builder.md) | [API Reference](./api-reference.md)
