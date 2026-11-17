# Supplementary OpenAPI documents

These documents are **hand-written for this repository**. They are not vendored, they have no upstream, and they are not listed in `e2e/fixtures/oas/sources.json` (that folder is reserved for the pinned official OpenAPI Initiative sources and is checked by `scripts/sync-oas-sources.mjs`, which never looks here).

They exist because the official test documents leave out, where a tool is built, the constructs the library reads (`in: querystring`, a parameter defined with `content`, `itemSchema` in a response, named servers, overrides by name and location, a `query` operation next to `additionalOperations`). The official set only ever mentions most of them under `components` or on a path with no operation, so the story can only pin their absence. These documents give each a place where a tool is made.

## How they are checked

`e2e/official-documents.e2e.ts` runs them through the same five checks as an official PASS document:

1. each `pass` document **must validate against the official JSON Schema for its version** (`e2e/helpers/oas-validate.ts`, offline): the approved source decides that our documents are valid, not us;
2. it type-checks against our `OAS30` / `OAS31` / `OAS32` types;
3. our validator accepts it;
4. `generateTools()` returns exactly the pinned tools, in order, each as `[name, method, path, readOnlyHint, facts?]`, where `facts` holds what the 3.2 reads make observable: the whole-query entry, the media types of parameters defined with `content`, the streamed response, the server names;
5. generation reports exactly the diagnostics pinned for the document (none, unless the document is there to produce one).

No known gap is allowed for these documents: a failing check is a bug in the document or in the library.

The pins are in `e2e/expected/supplementary-documents.json`. They were written by hand from each document and the specification, then compared with the library's output. A difference is reported, not copied into the pin.

## Invalid documents

A document under `invalid/` is **deliberately not valid** against the official schema of its version, to pin what the library does with something its declared version does not define. The story asserts the official schema rejects it (a document that merely failed by accident belongs in `pass`) and then skips the schema and type checks. Pinned instead: our validator's verdict and findings, the tools, the diagnostics, and that nothing crashes the pipeline.

## Documents

### OpenAPI 3.2 (`3.2/pass`)

| Document | Covers |
| --- | --- |
| `querystring-form` | An `in: querystring` parameter whose `content` is `application/x-www-form-urlencoded`, with an Encoding Object |
| `querystring-json` | An `in: querystring` parameter whose `content` is `application/json`, next to a path and a header parameter |
| `parameter-content` | Parameters defined with `content` in path, query, header (JSON, plain text, plain text with no schema, JSON with no schema) and cookie |
| `cookie-style` | Cookie parameters with `style: cookie`: an array, an object, and an array with `explode: false` |
| `cookie-json-content` | JSON `content` cookie parameters: an object (cannot be sent, warned about), an integer and a boolean (can) |
| `security-query-credential` | A JSON whole query string with an API key in the query (warned about), a form one (fine), a JSON one with the key in a header (fine) |
| `event-stream` | A `text/event-stream` response with `itemSchema` |
| `jsonl-stream` | An `application/jsonl` response with `itemSchema` through a `$ref` |
| `multi-media-response` | A response offering `text/event-stream` (listed first) and `application/json`: the output schema comes from the second, the stream from the first |
| `stream-media-types` | A response offering several streamed media types (each with `itemSchema`) in three orders: event stream before JSON Lines, JSON Lines before event stream, two vendor types: which one is reported |
| `response-summary` | Response Objects with a `summary` and no `description` |
| `data-value-examples` | Example Objects with `dataValue` and `serializedValue` |
| `named-servers` | Servers with a unique `name`, next to one without |
| `parameter-override` | Path-level parameters overridden by `(name, in)` at operation level: a query parameter, a header (names compared without regard to case), and a query name that differs only in case (kept) |
| `query-and-additional-operations` | A `query` operation and two `additionalOperations` written out of order (PURGE before LINK), `post` before `get`, paths out of order |

`3.2/invalid`:

| Document | Covers |
| --- | --- |
| `parameter-schema-and-content` | A parameter with both `schema` and `content` (the schema must have exactly one) |

### OpenAPI 3.1 (`3.1/pass`) and 3.0 (`3.0/pass`)

| Document | Covers |
| --- | --- |
| `parameter-content` | A query and a header parameter defined with `content` (exists since 3.0) |
| `parameter-override` | The same path-level override as in 3.2 |

`3.1/invalid`:

| Document | Covers |
| --- | --- |
| `query-and-additional-operations` | A `query` operation and `additionalOperations` under a 3.1 declaration: ignored, with a `FEATURE_NEWER_THAN_DECLARED_VERSION` diagnostic each |
| `querystring-parameter` | An `in: querystring` parameter under a 3.1 declaration: warned about, and still read as the whole query string |

## Adding a document

Put it under `<version>/pass/` (or `<version>/invalid/`), keep it focused and realistic, and give every operation an `operationId`. Then pin its tools and facts in `e2e/expected/supplementary-documents.json` from the document, not from the library's output, and update the literal counts in `SUPPLEMENTARY_VERSIONS` in the story.
