# Tool Annotations & the x-mcp Extension Family

[Home](../README.md) | [Configuration](./configuration.md) | [x-frontmcp Extension](./x-frontmcp.md)

---

## Overview

Every generated tool carries MCP-native metadata for agent clients:

- **`tool.title`** — a human-readable display name (MCP `Tool.title`, spec 2025-06-18)
- **`tool.annotations`** — MCP tool annotations (spec 2025-03-26): `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, plus the legacy `annotations.title` slot

Both are plain data — spread them directly into an MCP SDK `registerTool` call.

```typescript
const tools = await generator.generateTools();

tools[0].title; // "List all items" (from operation.summary or an extension override)
tools[0].annotations; // { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
```

---

## Annotation Inference from HTTP Semantics

By default (`inferAnnotations: true`), annotations are derived from the HTTP method per RFC 9110 safety/idempotency:

| Method | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|--------|---------------|-------------------|------------------|-----------------|
| GET, HEAD, OPTIONS, TRACE, QUERY | `true` | `false` | `true` | `false` |
| PUT, DELETE | `false` | `true` | `true` | `false` |
| POST, PATCH | `false` | `true` | `false` | `false` |
| Any other method | `false` | `true` | `false` | `false` |

`QUERY` is the OpenAPI 3.2 `query` operation: a safe, idempotent request that carries a body. "Any other method" is an `additionalOperations` method (`LINK`, `PURGE`, ...), whose semantics the library cannot know, so it gets the conservative `POST` profile. A standard method is matched in any case (`inferAnnotationsFromMethod('GET')` and `('get')` agree). `readOnlyOnly: true` follows the method: it keeps `GET`, `HEAD`, `OPTIONS`, `TRACE` and `query` tools, and an extension can only take one out (`readOnlyHint: false`), never put another method in, since the document is not trusted to say a `POST` is safe. It drops `additionalOperations` tools (`query` and `additionalOperations` exist only in a document declaring OpenAPI 3.2 or newer; see [OpenAPI Versions](./openapi-versions.md)). That makes `readOnlyOnly` a safer filter than an `excludeMethods` denylist for a 3.2 document that can add arbitrary methods.

`openWorldHint` is always `false`: tools generated from a spec target one known API backend — a closed world.

Disable inference with `{ inferAnnotations: false }`; extension overrides (below) still apply.

> Annotations are **hints, not enforcement**. Clients must not treat them as security guarantees — gate destructive operations server-side.

---

## Extension Overrides

Spec authors can override the tool name, title, description, annotations, `_meta` entries, and icons — and exclude operations entirely — through the `x-mcp` extension family at the **operation level**. Three dialects are read, in ascending precedence (later wins field-by-field; `meta` merges key-by-key, `icons` replaces wholesale, and `x-speakeasy-mcp` supports neither):

### 1. `x-speakeasy-mcp` (interop)

```yaml
paths:
  /items:
    get:
      operationId: listItems
      x-speakeasy-mcp:
        disabled: false
        name: items_list
        title: List Items
        description: Use this to enumerate items. Supports paging via `cursor`.
        readOnlyHint: true       # annotation hints live at the top level
        idempotentHint: true
```

### 2. `x-mcp` (generic)

Boolean shorthand or object form:

```yaml
x-mcp: false                     # exclude this operation from generation

x-mcp:
  enabled: true                  # explicit include (overrides a speakeasy disable)
  name: items_list
  title: List Items
  description: Agent-facing description
  annotations:                   # annotation hints nested under `annotations`
    readOnlyHint: true
```

### 3. `x-frontmcp` (canonical, highest precedence)

Its `annotations` block (including `annotations.title`, which also becomes the tool title), `meta`, and `icons` map onto tool overrides; the rest of the extension (cache, codecall, tags, examples, ...) flows through `tool.metadata.frontmcp` untouched — see [x-frontmcp Extension](./x-frontmcp.md).

```yaml
x-frontmcp:
  annotations:
    title: List Items
    readOnlyHint: true
    idempotentHint: true
```

### Merge order

```text
HTTP-method inference  <  x-speakeasy-mcp  <  x-mcp  <  x-frontmcp
```

Fields merge individually — an extension that only sets `destructiveHint: false` keeps the inferred values for every other hint.

### Exclusion

`x-mcp: false`, `x-mcp: { enabled: false }`, and `x-speakeasy-mcp: { disabled: true }` all remove the operation from `generateTools()` output. A higher-precedence extension can re-enable (`x-mcp: { enabled: true }` beats a speakeasy disable). Direct `generateTool(path, method)` calls ignore exclusion — an explicit ask wins.

### Name overrides

An extension `name` takes the operationId's place in [name generation](./naming-strategies.md) — including as the `operationId` argument passed to a custom `toolNameGenerator` — and is still normalized to MCP name rules.

---

## Programmatic Access

The building blocks are exported for frameworks that need them:

```typescript
import { inferAnnotationsFromMethod, extractExtensionOverrides } from 'mcp-from-openapi';

inferAnnotationsFromMethod('delete');
// { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }

extractExtensionOverrides(operation);
// { disabled?, name?, title?, description?, annotations?, meta?, icons? }

// `meta` is copied with a node budget (default 25000; the generator passes maxSchemaNodes)
extractExtensionOverrides(operation, { maxMetaNodes: 10_000 });
```

---

**Related:** [Configuration](./configuration.md) | [x-frontmcp Extension](./x-frontmcp.md) | [API Reference](./api-reference.md)
