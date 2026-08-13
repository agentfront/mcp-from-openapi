# x-frontmcp Extension

[Home](../README.md) | [API Reference](./api-reference.md) | [Configuration](./configuration.md)

---

## Overview

The `x-frontmcp` extension allows you to add MCP-specific configuration directly in your OpenAPI spec. This data flows through to `tool.metadata.frontmcp` on generated tools.

`x-frontmcp` is the **canonical** extension of the `x-mcp` family: its `annotations` block (including `annotations.title`) also feeds the tool-level `title` and `annotations` fields, taking precedence over `x-mcp` and `x-speakeasy-mcp` and over HTTP-method annotation inference. See [Annotations & Extensions](./annotations.md).

---

## Usage in OpenAPI

Add `x-frontmcp` at the operation level:

```yaml
paths:
  /users:
    get:
      operationId: listUsers
      summary: List all users
      x-frontmcp:
        annotations:
          title: User List
          readOnlyHint: true
          idempotentHint: true
        cache:
          ttl: 300
          slideWindow: true
        tags:
          - users
          - public
      responses:
        '200':
          description: Success
```

---

## Fields

### annotations

Behavior hints for AI/MCP clients:

| Field | Type | Description |
|-------|------|-------------|
| `title` | `string` | Display title for the tool |
| `readOnlyHint` | `boolean` | Tool only reads data, never modifies |
| `destructiveHint` | `boolean` | Tool performs destructive actions (delete, overwrite) |
| `idempotentHint` | `boolean` | Calling multiple times has the same effect as once |
| `openWorldHint` | `boolean` | Tool interacts with external systems beyond the API |

### cache

Response caching configuration:

| Field | Type | Description |
|-------|------|-------------|
| `ttl` | `number` | Time-to-live in seconds |
| `slideWindow` | `boolean` | Reset TTL on each access |

### codecall

CodeCall integration settings:

| Field | Type | Description |
|-------|------|-------------|
| `enabledInCodeCall` | `boolean` | Whether the tool is available in CodeCall |
| `visibleInListTools` | `boolean` | Whether the tool appears in tool listings |

### tags

Additional tags for categorization (separate from OpenAPI tags):

```yaml
x-frontmcp:
  tags:
    - admin
    - internal
```

### hideFromDiscovery

When `true`, the tool is not exposed in discovery/listing endpoints:

```yaml
x-frontmcp:
  hideFromDiscovery: true
```

### examples

Usage examples for the tool:

```yaml
x-frontmcp:
  examples:
    - description: Get active users
      input:
        status: active
        limit: 10
      output:
        users: [{ id: "1", name: "Alice" }]
    - description: Get all users
      input: {}
```

### meta

MCP `_meta` entries emitted on the tool (merged over `x-mcp.meta` and any generated `emitMeta` entry — see [Modern MCP Fields](./modern-mcp-fields.md)):

```yaml
x-frontmcp:
  meta:
    com.example/billing-tier: pro
```

### icons

Tool icons (MCP 2025-11-25 shape; replaces any `x-mcp.icons` wholesale):

```yaml
x-frontmcp:
  icons:
    - src: https://example.com/invoice.png
      mimeType: image/png
      sizes: ["48x48"]
```

---

## Accessing in Code

```typescript
const tools = await generator.generateTools();

for (const tool of tools) {
  if (tool.metadata.frontmcp) {
    const { annotations, cache, codecall, tags, hideFromDiscovery, examples, meta, icons } = tool.metadata.frontmcp;

    if (annotations?.readOnlyHint) {
      // Safe to cache or retry
    }

    if (cache?.ttl) {
      // Configure response caching
    }

    if (hideFromDiscovery) {
      // Skip in tool listings
    }

    // meta and icons also surface on the tool itself (tool._meta / tool.icons)
    // after sanitization — see Modern MCP Fields.
  }
}
```

---

## Type Definition

```typescript
interface FrontMcpExtensionData {
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  cache?: {
    ttl?: number;
    slideWindow?: boolean;
  };
  codecall?: {
    enabledInCodeCall?: boolean;
    visibleInListTools?: boolean;
  };
  tags?: string[];
  hideFromDiscovery?: boolean;
  examples?: Array<{
    description: string;
    input: Record<string, unknown>;
    output?: unknown;
  }>;
  meta?: Record<string, unknown>;
  icons?: ToolIcon[];
}
```

---

**Related:** [API Reference](./api-reference.md) | [Configuration](./configuration.md) | [Getting Started](./getting-started.md)
