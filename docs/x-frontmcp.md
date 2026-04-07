# x-frontmcp Extension

[Home](../README.md) | [API Reference](./api-reference.md) | [Configuration](./configuration.md)

---

## Overview

The `x-frontmcp` extension allows you to add MCP-specific configuration directly in your OpenAPI spec. This data flows through to `tool.metadata.frontmcp` on generated tools.

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

---

## Accessing in Code

```typescript
const tools = await generator.generateTools();

for (const tool of tools) {
  if (tool.metadata.frontmcp) {
    const { annotations, cache, codecall, tags, hideFromDiscovery, examples } = tool.metadata.frontmcp;

    if (annotations?.readOnlyHint) {
      // Safe to cache or retry
    }

    if (cache?.ttl) {
      // Configure response caching
    }

    if (hideFromDiscovery) {
      // Skip in tool listings
    }
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
}
```

---

**Related:** [API Reference](./api-reference.md) | [Configuration](./configuration.md) | [Getting Started](./getting-started.md)
