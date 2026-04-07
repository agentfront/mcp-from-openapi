# Parameter Conflicts

[Home](../README.md) | [Getting Started](./getting-started.md) | [Naming Strategies](./naming-strategies.md)

---

## The Problem

OpenAPI operations can have parameters with the same name in different locations. For example, `id` might appear in the path, query, and request body simultaneously:

```yaml
paths:
  /users/{id}:
    post:
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
        - name: id
          in: query
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                id:
                  type: string
```

A flat input schema can't have three properties all named `id`. This library detects these conflicts and resolves them automatically.

---

## How It Works

1. **Collect** all parameters from path, query, header, cookie, and request body
2. **Group** parameters by name
3. **Detect** names that appear in more than one location
4. **Rename** conflicted parameters using a naming strategy
5. **Build** the input schema with unique property names
6. **Create** mapper entries that map renamed keys back to original names and locations

---

## Default Naming Strategy

The default conflict resolver prefixes the parameter name with its location:

```
{location}{CapitalizedName}
```

For the example above, the three `id` parameters become:

| Original | Location | Resolved Name |
|----------|----------|---------------|
| `id` | path | `pathId` |
| `id` | query | `queryId` |
| `id` | body | `bodyId` |

The generated output:

```typescript
const tool = await generator.generateTool('/users/{id}', 'post');

// inputSchema.properties:
{
  pathId:  { type: "string" },
  queryId: { type: "string" },
  bodyId:  { type: "string" }
}

// mapper:
[
  { inputKey: "pathId",  type: "path",  key: "id" },
  { inputKey: "queryId", type: "query", key: "id" },
  { inputKey: "bodyId",  type: "body",  key: "id" }
]
```

---

## No Conflict = No Rename

When a parameter name is unique across all locations, it keeps its original name:

```yaml
parameters:
  - name: userId
    in: path
  - name: limit
    in: query
```

```typescript
// No conflicts, names unchanged:
// inputSchema.properties: { userId: ..., limit: ... }
// mapper: [
//   { inputKey: "userId", type: "path", key: "userId" },
//   { inputKey: "limit",  type: "query", key: "limit" }
// ]
```

---

## Request Body Parameters

Request body properties are extracted as individual parameters with `type: 'body'`:

```yaml
requestBody:
  content:
    application/json:
      schema:
        type: object
        properties:
          name:
            type: string
          email:
            type: string
```

Becomes:

```typescript
// mapper:
[
  { inputKey: "name",  type: "body", key: "name", serialization: { contentType: "application/json" } },
  { inputKey: "email", type: "body", key: "email", serialization: { contentType: "application/json" } }
]
```

If a body property name conflicts with a path/query parameter, the conflict resolver kicks in (e.g., `bodyName`, `pathName`).

---

## Content Type Selection

When the request body has multiple content types, the library selects one based on preference:

1. `application/json`
2. `application/x-www-form-urlencoded`
3. `multipart/form-data`
4. `application/xml`
5. `text/plain`

Falls back to the first available content type.

---

## Custom Conflict Resolution

Override the default naming with a custom `conflictResolver`:

```typescript
const tools = await generator.generateTools({
  namingStrategy: {
    conflictResolver: (paramName, location, index) => {
      // Uppercase prefix: PATH_id, QUERY_id, BODY_id
      return `${location.toUpperCase()}_${paramName}`;
    },
  },
});
```

The resolver receives:
- `paramName` -- the original parameter name
- `location` -- `'path'`, `'query'`, `'header'`, `'cookie'`, or `'body'`
- `index` -- 0-based index among conflicting parameters

See [Naming Strategies](./naming-strategies.md) for more examples.

---

**Related:** [Naming Strategies](./naming-strategies.md) | [Getting Started](./getting-started.md) | [Configuration](./configuration.md)
