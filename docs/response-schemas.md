# Response Schemas

[Home](../README.md) | [Getting Started](./getting-started.md) | [Configuration](./configuration.md)

---

## Overview

The `ResponseBuilder` extracts response schemas from OpenAPI operations and produces an `outputSchema` for each tool. This schema describes what the API returns. A streamed response (OpenAPI 3.2 `itemSchema`) is not part of it: it is reported in `metadata.responseStream` ([Streaming Responses](#streaming-responses)).

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

## Response Descriptions

The description of an output schema comes from, in order: the schema's own `description`, the response's `description`, and (OpenAPI 3.2, where a response's `description` is optional) the response's `summary`. The library reads `summary` whatever version the document declares.

```yaml
responses:
  '200':
    summary: The widget
    content:
      application/json:
        schema:
          type: object
          properties:
            id:
              type: string
  '204':
    summary: Nothing to return
  '404':
    summary: Missing
    description: The widget does not exist
    content:
      application/json:
        schema:
          type: object
          description: Own description
```

```typescript
tool.outputSchema.oneOf.map((variant) => [variant["x-status-code"], variant.description]);
// [[200, "The widget"], [204, "Nothing to return"], [404, "Own description"]]
```

A `description` that is present wins over `summary` even when it is empty: `description: ''` with a `summary` gives an empty description. Before this release `summary` was not read, so the 200 and 204 variants above had no description.

---

## Streaming Responses

OpenAPI 3.2 describes a streamed response with `itemSchema` on a Media Type Object: the schema of **each item** of a sequential media type such as `text/event-stream` (Server-Sent Events), `application/jsonl`, `application/x-ndjson`, `application/json-seq` or `multipart/mixed`.

```yaml
responses:
  '200':
    description: Event stream
    content:
      text/event-stream:
        itemSchema:
          type: object
          required: [data]
          properties:
            event: { type: string }
            data: { type: string }
            id: { type: string }
```

```typescript
tool.outputSchema; // undefined: a media type with only itemSchema has no output schema

tool.metadata.responseStream;
// {
//   statusCode: 200,
//   contentType: "text/event-stream",
//   itemSchema: { type: "object", required: ["data"], properties: { event: ..., data: ..., id: ... } }
// }

tool.metadata.responseHints; // { streaming: true }
```

**Stream and output schema together.** A response that offers both gets both:

```yaml
responses:
  '200':
    description: Either
    content:
      application/json:
        schema:
          type: array
          items: { type: string }
      text/event-stream:
        itemSchema:
          type: object
          properties:
            data: { type: string }
```

```typescript
tool.outputSchema;
// { type: "array", items: { type: "string" }, "x-status-code": 200, description: "Either", "x-content-type": "application/json" }
tool.metadata.responseStream;
// { statusCode: 200, contentType: "text/event-stream", itemSchema: { type: "object", properties: { data: ... } } }
tool.metadata.responseHints; // { unboundedArray: true, largeResponseRisk: true, streaming: true }
```

**Why it is not the output schema.** An MCP tool that declares an output schema must return its result as structured content that matches the schema. An unbounded stream is not a result of that kind: it never completes as one value. The item schema therefore sits in `metadata.responseStream`, and `outputSchema` describes only what the tool can return as a whole. For `text/event-stream` an item is one parsed event (`data`, `event`, `id`, `retry`).

How the stream is found:

- **Which response.** One with a media type that declares `itemSchema` (a schema object, or a boolean, which becomes `{}`). Of several, the preferred one is chosen as `includeAllResponses: false` chooses an output schema: the `preferredStatusCodes` order, then any 2xx, any 3xx, then the first. A `default` response is used only when no numbered response streams.
- **Which media type.** Within that response, the **first one in the document's `content` order that declares `itemSchema`**. There is no preference list for streams. The choice is independent of the media type the output schema comes from, so a response that offers `application/json` (with a `schema`) and `text/event-stream` (with an `itemSchema`) gives both: an `outputSchema` from the first and a `responseStream` from the second, whichever is listed first. Of `text/event-stream` and `application/jsonl` both with `itemSchema`, the one written first is the stream.
- **Both `schema` and `itemSchema`** on one media type: `outputSchema` comes from `schema` (when that is the media type the output schema is read from) and `responseStream` from `itemSchema`. The output schema is annotated `x-content-type` with its own media type.
- **Other responses.** A response that has its own schema still goes into `outputSchema`, and the output schema and the stream may come from different responses. A `200` stream with no schema next to a `404` JSON error gives an `outputSchema` of the 404 variant alone (`x-status-code: 404`), because the stream has none: read `responseStream` for the stream.
- **`responseStatusCodes`** lists the status codes of the output schema, so a stream's code is only in `responseStream.statusCode` (`0` for `default`).
- **Same pipeline.** The item schema is converted like an output schema: JSON Schema 2020-12, `resolveFormats`, `maxSchemaDepth` and `maxSchemaNodes`, the trimming options and a client `target` all apply to it.
- **Any version.** `itemSchema` is read whatever version the document declares.

`responseHints.streaming` is `true` whenever `responseStream` is present, and `responseHints` exists for it even when there is nothing else to report. A request body whose media type declares only `itemSchema` (a streamed upload) is not supported: the tool takes no body input and an `UNSUPPORTED_STREAMING_REQUEST_BODY` diagnostic is recorded. See [OpenAPI Versions](./openapi-versions.md#diagnostics).

---

## Status Code Metadata

Response status codes from the output schema are available in metadata:

```typescript
tool.metadata.responseStatusCodes;
// [200, 404] (from oneOf variants)
// [200]      (single response)
```

A streamed response's status code is not in this list; it is `tool.metadata.responseStream?.statusCode`.

---

**Related:** [Configuration](./configuration.md) | [Getting Started](./getting-started.md) | [API Reference](./api-reference.md)
