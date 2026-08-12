# Curation: Budgets, Overlays & Lint

[Home](../README.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)

---

Auto-converting a whole API produces a phone book, not a menu: model accuracy measurably degrades past ~30-40 tools, and definitions routinely cost ~1,000 tokens each. This page covers the curation toolkit: **measure** the context bill, **fix** the spec without forking it, and **lint** what remains.

## Token budgets

```typescript
import { analyzeToolSet, estimateToolTokens } from "mcp-from-openapi";

const tools = await generator.generateTools();
const report = analyzeToolSet(tools);

report.toolCount; // 87
report.estimatedTokens; // 61,240
report.perTool[0]; // { name: 'searchOrders', tokens: 2140 }  (heaviest first)
report.warnings; // actionable strings, empty when comfortably sized
```

Warnings fire when the set crosses the thresholds where agent accuracy is known to degrade (defaults: 40 tools, 10K total tokens, 2K per tool — all overridable via `AnalyzeToolSetOptions`). The estimate is `chars / 4` over the advertised definition — a sizing signal for curation, not a tokenizer (real counts vary ~±20% by model).

## Overlays

Curation lives in a small [OpenAPI Overlay 1.0](https://spec.openapis.org/overlay/v1.0.0) file that survives every regeneration of the source spec — no forking, no lost hand-tuning:

```typescript
const generator = await OpenAPIToolGenerator.fromURL(specUrl, {
  overlays: {
    overlay: "1.0.0",
    actions: [
      // agent-tuned description without touching the source spec
      {
        target: "$.paths['/orders'].get",
        update: {
          description:
            "Search orders. Use `status` to narrow; returns newest first.",
        },
      },
      // hide internal operations from generation
      { target: "$.paths['/internal/*']", remove: true },
      // tag every mutation for filtering
      { target: "$.paths.*[?(@.operationId)]", update: { "x-audited": true } },
    ],
  },
});
```

Overlays apply **eagerly at construction** — before dereferencing and validation — so `validate()`, `getDocument()`, `lint()`, and generation all see the same curated document (an overlay can even fix an invalid spec). Actions run in order, each matched node exactly once. `applyOverlay(document, overlay)` is exported for standalone use.

**Update semantics** (per the Overlay spec): object targets deep-merge, array targets append, primitive targets are replaced. `remove: true` deletes matched nodes. Unmatched targets are skipped silently.

**Supported JSONPath subset**: `$` root · `.name` / `['name']` children · `.*` / `[*]` wildcards · `[3]` / `[-1]` indices · `[?(@.field)]` / `[?(@.field == 'value')]` / `[?(@.field != 42)]` filters · `..` recursive descent before any of these. Unsupported syntax throws `OverlayError` — nothing is silently ignored.

## Lint

```typescript
const result = await generator.lint(); // or lintDocument(document)

result.counts; // { error: 1, warning: 4, info: 7 }
result.findings[0];
// { severity: 'error', code: 'duplicate-operation-id',
//   message: "operationId 'list' is used by 2 operations: GET /a, GET /b.",
//   path: 'GET /a', hint: 'Make operationIds unique — ...' }
```

Finding codes: `duplicate-operation-id` (error) · `missing-operation-id`, `missing-description`, `missing-success-response`, `unpaginated-list`, `deep-schema` (warnings) · `vague-description`, `missing-parameter-description`, `missing-request-example`, `wide-schema`, `long-operation-id` (info). Each carries a fix hint — in the spec or via generate options/overlays. Spec studies show a handful of line fixes routinely takes tool-call success from mediocre to near-perfect.

`generator.lint()` runs after overlays and dereferencing but is **never gated by validation** — diagnostics work on exactly the imperfect specs they exist to diagnose (generation still validates).

## Trimming and descriptions

Alongside `maxSchemaDepth` (Tier 1), three more trimming knobs and two description controls:

```typescript
await generator.generateTools({
  maxProperties: 20, // cap object width (root input params are mapper-backed and never dropped)
  maxDescriptionLength: 300, // ellipsis-truncate every description
  stripExamples: true, // drop examples arrays wholesale
  descriptionStrategy: "combined", // summaryOnly | descriptionOnly | combined | full
  appendResponseSummary: true, // "Returns: array of objects with fields: id, name"
});
```

## Response hints

`tool.metadata.responseHints` flags the tools that need paging or truncation _before_ the first oversized response (Claude Code caps tool results at 25K tokens):

```typescript
tool.metadata.responseHints;
// { unboundedArray: true, paginationParams: ['limit', 'cursor'] }
// or { unboundedArray: true, largeResponseRisk: true }  ← no pagination controls
// undefined when there is nothing to know
```

---

**Related:** [Configuration](./configuration.md) | [Client Targets](./client-targets.md) | [API Reference](./api-reference.md)
