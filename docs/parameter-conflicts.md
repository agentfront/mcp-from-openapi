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

1. **Merge** the path item's parameters with the operation's: an operation-level parameter overrides a path-level one with the same name and location (see [Same Name and Location](#same-name-and-location-the-operation-wins))
2. **Collect** all parameters from path, query, header, cookie, and request body, leaving out a header parameter the HTTP client, a credential or a proxy sets (`Accept`, `Content-Type`, `Authorization`, `Host`, `X-Forwarded-*`, ...) and one sent where a credential of the operation is sent (each is a `PARAMETER_IGNORED` diagnostic)
3. **Group** parameters by name
4. **Detect** names that appear in more than one location
5. **Rename** conflicted parameters using a naming strategy; a renamed key another input already uses gets a number (`headerId2`)
6. **Build** the input schema with unique property names, security inputs last (a scheme whose name is taken gets a number too)
7. **Create** mapper entries that map renamed keys back to original names and locations

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

## Same Name and Location: the Operation Wins

Two rules look alike and are kept apart:

- **Same name in different locations** is a conflict, and the rest of this page is about it: each parameter stays and is renamed by the naming strategy (`pathId`, `queryId`).
- **Same name in the same location** is not a conflict, it is an override. A parameter on the Path Item applies to every operation of the path; an operation-level parameter with the same `name` and `in` replaces it, as the OpenAPI Operation Object says. Only one parameter reaches the input schema, and it is the operation's.

```yaml
paths:
  /orders:
    parameters:
      - name: limit
        in: query
        description: Path-level default
        schema: { type: integer, default: 20 }
      - name: X-Trace
        in: header
        schema: { type: string }
    get:
      operationId: listOrders
      parameters:
        - name: limit
          in: query
          required: true
          description: Operation-level
          schema: { type: integer, minimum: 1, maximum: 100 }
```

Now (`inputSchema.properties` keys `X-Trace`, `limit`; `required: ['limit']`):

```typescript
// mapper:
[
  { inputKey: "X-Trace", type: "header", key: "X-Trace", required: false },
  { inputKey: "limit", type: "query", key: "limit", required: true },
]
// input { limit: 5 } -> https://api.example.com/orders?limit=5
```

Before this release both `limit` parameters were kept as a conflict: the input key was renamed to `queryLimit` for both, the mapper held two entries with that key (one required, one not), the input schema kept only the last, and the value was sent twice:

```typescript
// inputSchema.properties keys: queryLimit, X-Trace
// mapper: [
//   { inputKey: "queryLimit", type: "query", key: "limit", required: false },
//   { inputKey: "queryLimit", type: "query", key: "limit", required: true },
//   { inputKey: "X-Trace", type: "header", key: "X-Trace", required: false },
// ]
// input { queryLimit: 5 } -> https://api.example.com/orders?limit=5&limit=5
```

Details:

- **The override is whole.** The operation's `schema`, `required`, `description`, `style` and the rest replace the path-level ones; nothing is merged field by field. A path-level `required: true` is gone if the operation says nothing.
- **Only the same location overrides.** Path-level `id` parameters in the path and in the query, with an operation-level `id` in a header, are three parameters, and the conflict rule renames them (`pathId`, `queryId`, `headerId`). An override and a conflict can happen together: with path-level `id` in the path and in the query and an operation-level `id` in the query, the operation's query `id` replaces the path-level query `id`, and the path `id` and the query `id` are then renamed (`pathId`, `queryId`; `queryId` is the operation's).
- **Names are compared exactly, except for headers.** A query name or a cookie name is case-sensitive, so `limit` and `Limit` are two parameters. A header name is compared without regard to case, as HTTP does: a path-level `X-Trace` is overridden by an operation-level `x-trace`, and the operation's spelling is the one on the wire and in the input schema (before, both were kept and both were sent). Two spellings in one list are duplicates.
- **Order.** The path-level parameters that were not overridden come first, then the operation's. An overriding parameter takes its place among the operation's, so the position of an input key can differ from before (in the example, `limit` now follows `X-Trace`).
- **An override is silent.** It is what the specification says, so it records no diagnostic.
- **Duplicates in one list.** A single list (a path item's or an operation's) that repeats a `name` and `in` (a header in any case) breaks an OpenAPI rule. The last one is used and each earlier one records a `DUPLICATE_PARAMETER` warning (also a validator warning). Before, both were kept with one input key, and the value was sent twice. An exact repeat of an `in: querystring` parameter is a duplicate too, not a second querystring parameter.
- **Lint reads the same parameters.** `lintDocument` (and `generator.lint()`) checks the parameters that apply, merged as above, so a path-level parameter without a description that an operation overrides with a described one is not reported.

---

## Parameters Defined with `content`

A parameter defined with `content` instead of `schema` takes its input schema from the media type's `schema` (a media type with none gives an unconstrained input for a JSON media type, an object for `application/x-www-form-urlencoded` and a string for any other), and its mapper entry says which media type serializes the value. OpenAPI says `style`, `explode` and `allowReserved` do not apply, so the entry has none of them:

```yaml
parameters:
  - name: coordinates
    in: query
    content:
      application/json:
        schema:
          type: object
          properties:
            lat: { type: number }
            long: { type: number }
```

```typescript
// inputSchema.properties.coordinates:
{ type: "object", properties: { lat: ..., long: ... },
  "x-parameter-location": "query", "x-parameter-content-type": "application/json" }

// mapper:
[{ inputKey: "coordinates", type: "query", key: "coordinates", required: false,
   serialization: { contentType: "application/json" } }]
```

When the media type has an `encoding`, it is carried as `serialization.encoding`, as for a request body. See [Request Builder](./request-builder.md#parameters-defined-with-content) for how each media type is serialized and the diagnostics for a `content` that does not hold exactly one media type.

### Whole-query parameters

An OpenAPI 3.2 parameter `in: querystring` becomes one input whose value is the entire query string. Its mapper entry has `type: 'query'` and `wholeQuery: true` (like `wholeBody` for a body), and `key` is the parameter's name, which is never sent. It is defined with `content`, so its entry carries `serialization.contentType` too:

```typescript
[{ inputKey: "query", type: "query", key: "query", required: false,
   serialization: { contentType: "application/json" }, wholeQuery: true }]
```

An operation has at most one, and no `in: query` parameter next to it (path-level ones included); see [Request Builder](./request-builder.md#whole-query-parameters) and [OpenAPI Versions](./openapi-versions.md).

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

### allOf bodies

`allOf` compositions are flattened: object members merge into one property set (later members win on collisions, `required` sets union), so each combined property becomes its own input parameter. Members that carry only a `required` list (the base-`$ref` + required-tightening pattern) still contribute their required fields.

### Whole-body parameters

Bodies that cannot be flattened into named properties become a single `body` input parameter whose mapper entry carries `wholeBody: true` — the input value **is** the entire request body (do not wrap it in `{ body: value }`):

- Non-object bodies: arrays, primitives, raw binary (`format: binary`)
- `oneOf` / `anyOf` union bodies — at the root **or inside any `allOf` member** (the composed schema is preserved intact rather than flattening the union away)
- Free-form objects without declared properties

```typescript
// POST with `schema: { type: 'array', items: { type: 'string' } }`:
[{ inputKey: "body", type: "body", key: "body", wholeBody: true, serialization: { contentType: "application/json" } }]
```

### Multipart and file uploads

For `multipart/form-data` (and other) bodies, binary parts (`format: binary`, or OpenAPI 3.1 `contentMediaType` with no declared `type` and no `contentEncoding`) are marked with `serialization.binary: true`, and per-property `encoding` rules from the media type are attached to the matching mapper entries:

```typescript
[
  { inputKey: "file", type: "body", key: "file", required: true,
    serialization: { contentType: "multipart/form-data", binary: true,
                     encoding: { file: { contentType: "application/octet-stream" } } } },
  { inputKey: "caption", type: "body", key: "caption",
    serialization: { contentType: "multipart/form-data" } }
]
```

`buildHttpRequest` applies these rules when it builds the request (a part's `Content-Type`, `style`, `explode`, `allowReserved` and part `headers`; see [Encoding Objects](./request-builder.md#encoding-objects)).

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
