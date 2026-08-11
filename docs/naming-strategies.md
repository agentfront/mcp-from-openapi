# Naming Strategies

[Home](../README.md) | [Parameter Conflicts](./parameter-conflicts.md) | [Configuration](./configuration.md)

---

## Overview

The `NamingStrategy` interface controls two things:

1. **conflictResolver** -- How conflicted parameter names are renamed
2. **toolNameGenerator** -- How tool names are generated (optional)

---

## Default Conflict Resolver

When no custom strategy is provided, conflicted parameters are prefixed with their location:

```
{location}{CapitalizedName}
```

| Location | Example Input | Result |
|----------|--------------|--------|
| `path` | `id` | `pathId` |
| `query` | `id` | `queryId` |
| `header` | `id` | `headerId` |
| `cookie` | `id` | `cookieId` |
| `body` | `id` | `bodyId` |

Only conflicted names are renamed. Unique parameter names are kept as-is.

---

## Custom Conflict Resolver

```typescript
interface NamingStrategy {
  conflictResolver: (paramName: string, location: ParameterLocation, index: number) => string;
  toolNameGenerator?: (path: string, method: HTTPMethod, operationId?: string) => string;
}
```

### Uppercase prefix

```typescript
const tools = await generator.generateTools({
  namingStrategy: {
    conflictResolver: (paramName, location, index) => {
      return `${location.toUpperCase()}_${paramName}`;
    },
  },
});
// PATH_id, QUERY_id, BODY_id
```

### Numbered suffix

```typescript
const tools = await generator.generateTools({
  namingStrategy: {
    conflictResolver: (paramName, location, index) => {
      return `${paramName}_${index}`;
    },
  },
});
// id_0, id_1, id_2
```

### Location abbreviation

```typescript
const abbrev: Record<string, string> = {
  path: 'p', query: 'q', header: 'h', cookie: 'c', body: 'b',
};

const tools = await generator.generateTools({
  namingStrategy: {
    conflictResolver: (paramName, location) => {
      return `${abbrev[location]}_${paramName}`;
    },
  },
});
// p_id, q_id, b_id
```

---

## Tool Name Normalization (MCP rules)

Every tool name — whether it comes from an `operationId`, an `x-mcp`-family `name` override, a path/method fallback, or a custom `toolNameGenerator` — is normalized to MCP's tool-name rules:

1. **Character set**: anything outside `[A-Za-z0-9_.-]` becomes `_`; consecutive underscores collapse; leading/trailing underscores are trimmed. `get user (v2)!` → `get_user_v2`.
2. **Length cap**: names longer than `maxToolNameLength` (default `64`; clamped to MCP's hard limit of `128`) are truncated and given an 8-character FNV-1a hash suffix derived from the *full* original name — so truncated names stay unique and stable across regenerations: `veryLongOperation..._a1b2c3d4`.
3. **Empty fallback**: if sanitization leaves nothing (e.g. `operationId: "!!!"`), the name becomes `tool_<hash>` seeded from the method + path.
4. **Collision dedup** (`generateTools()` only): when two operations produce the same name (e.g. duplicate operationIds), the first keeps the clean name and later ones get a stable suffix hashed from their `method + path` — deterministic across runs and spec re-serializations.

Normalization is not bypassable: MCP name rules are hard client constraints (Claude/Bedrock reject or truncate names over 64 chars; the MCP spec caps names at 128 chars of that character set).

---

## Custom Tool Name Generator

By default, tools are named using the operation's `operationId` (or an extension `name` override — see [Annotations & Extensions](./annotations.md)). If neither exists, a name is generated from the path and method:

```text
{method}_{sanitized_path}
```

For example: `GET /users/{id}` becomes `get_users_By_id`.

Override with `toolNameGenerator` (output is still normalized as above):

```typescript
const tools = await generator.generateTools({
  namingStrategy: {
    conflictResolver: (name, loc) => `${loc}${name.charAt(0).toUpperCase()}${name.slice(1)}`,
    toolNameGenerator: (path, method, operationId) => {
      if (operationId) return operationId;
      // camelCase: getUsersById
      const parts = path.split('/').filter(Boolean);
      const camel = parts
        .map((p) => p.replace(/\{(\w+)\}/, 'By$1'))
        .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
        .join('');
      return `${method}${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
    },
  },
});
```

---

**Related:** [Parameter Conflicts](./parameter-conflicts.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)
