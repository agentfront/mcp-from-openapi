# Response Schemas

[Home](../README.md) | [Getting Started](./getting-started.md) | [Configuration](./configuration.md)

---

## Overview

The `ResponseBuilder` extracts response schemas from OpenAPI operations and produces an `outputSchema` for each tool. This schema describes what the API returns.

---

## Single Response

When an operation has one response, the output schema is that response's schema directly:

```yaml
responses:
  '200':
    description: User found
    content:
      application/json:
        schema:
          type: object
          properties:
            id:
              type: string
            name:
              type: string
```

```typescript
tool.outputSchema;
// {
//   type: "object",
//   properties: { id: { type: "string" }, name: { type: "string" } },
//   description: "User found",
//   "x-status-code": 200,
//   "x-content-type": "application/json"
// }
```

---

## Multiple Responses (oneOf Union)

When `includeAllResponses: true` (the default), multiple status codes produce a `oneOf` union:

```yaml
responses:
  '200':
    description: Success
    content:
      application/json:
        schema:
          type: object
          properties:
            data:
              type: string
  '404':
    description: Not found
    content:
      application/json:
        schema:
          type: object
          properties:
            error:
              type: string
```

```typescript
tool.outputSchema;
// {
//   oneOf: [
//     { type: "object", properties: { data: ... }, "x-status-code": 200 },
//     { type: "object", properties: { error: ... }, "x-status-code": 404 }
//   ],
//   description: "Response can be one of multiple status codes"
// }
```

Each variant is annotated with `x-status-code` so consumers can differentiate.

---

## Single Preferred Response

Set `includeAllResponses: false` to get only the preferred response:

```typescript
const tools = await generator.generateTools({
  includeAllResponses: false,
});
```

The preferred status code is selected based on `preferredStatusCodes` order.

### Selection Priority

1. **Exact match** in `preferredStatusCodes` (default: `[200, 201, 204, 202, 203, 206]`)
2. **Any 2xx** response
3. **Any 3xx** response
4. **First available** response

Override the preference order:

```typescript
const tools = await generator.generateTools({
  includeAllResponses: false,
  preferredStatusCodes: [201, 200], // Prefer 201 over 200
});
```

---

## Content Type Selection

When a response has multiple content types, the builder selects based on preference:

1. `application/json`
2. `application/hal+json`
3. `application/problem+json`
4. `application/xml`
5. `text/plain`
6. `text/html`

Falls back to the first available content type. The selected type is annotated as `x-content-type` on the schema.

---

## No Content Responses (204)

Responses without a `content` field (e.g., 204 No Content) produce a null schema:

```yaml
responses:
  '204':
    description: Deleted successfully
```

```typescript
// { type: "null", description: "Deleted successfully", "x-status-code": 204 }
```

---

## Default Response

The `default` response is used as a fallback only when no other status codes are defined:

```yaml
responses:
  default:
    description: Default response
    content:
      application/json:
        schema:
          type: object
```

If any numbered status code exists, `default` is ignored.

---

## Status Code Metadata

Response status codes from the output schema are available in metadata:

```typescript
tool.metadata.responseStatusCodes;
// [200, 404] (from oneOf variants)
// [200]      (single response)
```

---

**Related:** [Configuration](./configuration.md) | [Getting Started](./getting-started.md) | [API Reference](./api-reference.md)
