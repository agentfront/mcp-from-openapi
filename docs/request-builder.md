# Request Builder

[Home](../README.md) | [Parameter Conflicts](./parameter-conflicts.md) | [API Reference](./api-reference.md)

---

## Overview

`buildHttpRequest(tool, input, options?)` turns a generated tool plus its input values into a ready-to-send HTTP request — the mapper applied in full, including the OpenAPI serialization rules that hand-written request builders routinely get wrong.

It is a **pure function**: nothing is sent, no runtime context is consulted, and the library never imports an HTTP client.

```typescript
import { OpenAPIToolGenerator, buildHttpRequest } from "mcp-from-openapi";

const generator = await OpenAPIToolGenerator.fromURL(
  "https://api.example.com/openapi.json",
);
const [tool] = await generator.generateTools();

const request = buildHttpRequest(tool, { id: "42", filter: { tag: "news" } });

await fetch(request.url, {
  method: request.method,
  headers: request.headers,
  body: request.body as BodyInit,
});
```

## What it handles

| Concern         | Coverage                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Query styles    | `form` (explode both ways), `spaceDelimited`, `pipeDelimited`, `deepObject` (recursive brackets)                                 |
| Path styles     | `simple`, `label`, `matrix` — primitives, arrays, and objects, explode both ways                                                 |
| Headers/cookies | `simple` serialization, folded `Cookie` header with verbatim values, RFC 6265 name/value validation                              |
| `allowReserved` | RFC 3986 reserved characters left unencoded in query values                                                                      |
| Bodies          | JSON (incl. `+json`), `x-www-form-urlencoded`, `multipart/form-data` (real `FormData`), raw binary pass-through, text            |
| `wholeBody`     | Non-object/union bodies sent as the entire body (never wrapped)                                                                  |
| Security        | Values applied only when present in `input`; `bearer`/`basic` get prefixes, structured schemes (digest) pass through verbatim    |
| Safety          | Header-injection guards (CR/LF), path traversal-safe encoding, http(s)-only base URLs, unresolved path/server-template detection |

## Result shape

```typescript
interface BuiltHttpRequest {
  url: string; // base + expanded path + encoded query
  method: string; // uppercase
  headers: Record<string, string>; // incl. content-type and Cookie when applicable
  query: Record<string, string[]>; // query params as sent (unencoded values)
  cookies: Record<string, string>;
  contentType?: string;
  body?: unknown; // string | FormData | raw binary | undefined
  rawBody?: unknown; // structured body before serialization
}
```

Two things to know:

- **Multipart bodies** come back as `FormData` and the `content-type` header is deliberately _not_ set — your HTTP client must add the boundary itself. `contentType` still reports `multipart/form-data` for routing.
- **Binary bodies** (`serialization.binary`) pass through untouched (string, `Uint8Array`, `Blob`, ...); everything else serializes per the content type.

## Server URLs

The tool's first server URL is used as the base, with `{variable}` templates substituted from their spec-declared defaults. Templates without defaults throw a `RequestBuildError` — pass an explicit `baseUrl` in that case (it always wins over the spec's servers).

## Explode defaults

`explode` follows the OpenAPI table: `true` for `form` (and `deepObject`), `false` for every other style — a `spaceDelimited` array without an explicit `explode` serializes space-joined, not as repeated keys.

## Errors

All failures throw `RequestBuildError` (with a `context` object): missing required parameters, `null` where a primitive is needed, objects in plain query slots, header injection attempts, invalid cookie names, non-http base URLs, and unresolved path placeholders.

## Security values

Security mapper entries are applied only when a value is present in `input` — pass resolved credentials under the mapper's `inputKey` (e.g. from [SecurityResolver](./security.md)) or leave them out and inject auth in your transport layer. `bearer`/`basic`/`oauth2` schemes get their prefixes automatically (never doubled); structured schemes like digest pass through verbatim — supply the full header value or use [SecurityResolver](./security.md).

---

**Related:** [Parameter Conflicts](./parameter-conflicts.md) | [Security](./security.md) | [API Reference](./api-reference.md)
