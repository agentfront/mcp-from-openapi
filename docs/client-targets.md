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
| `strict` | The safe baseline for every client: local `$ref`s inlined and `$defs`/`definitions` stripped, arrays always carry `items`, root-level compositions collapsed (`allOf` merged; `oneOf`/`anyOf` documented and preserved under `x-variants`; nullable wrappers unwrapped with a "May be null." note)   |
| `claude` | = `strict`. Claude's other constraints (no top-level unions on input, 64-char names) are already the generator's defaults                                                                                                                                                                            |
| `openai` | `strict` + every object closed (`additionalProperties: false`) + every property listed in `required`, with originally-optional fields becoming nullable (`type: [..., 'null']`) — the full OpenAI strict function-calling contract. Typed maps (schema-valued `additionalProperties`) are left alone |
| `gemini` | `strict` + unions collapsed at **every** level (nullable wrappers unwrap; `type: ['string','null']` arrays keep the first non-null type; other unions keep their first variant and document the omitted alternatives) + unsupported `format` values demoted into descriptions (`date-time` is kept)  |

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

---

**Related:** [Configuration](./configuration.md) | [SchemaBuilder](./schema-builder.md) | [API Reference](./api-reference.md)
