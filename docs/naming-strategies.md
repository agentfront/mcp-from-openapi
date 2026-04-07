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

## Custom Tool Name Generator

By default, tools are named using the operation's `operationId`. If no `operationId` exists, a name is generated from the path and method:

```
{method}_{sanitized_path}
```

For example: `GET /users/{id}` becomes `get_users_By_id`.

Override with `toolNameGenerator`:

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
