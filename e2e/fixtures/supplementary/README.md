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

Two more pins, for the documents where it is a value that tells a rule from its opposite: the `type` of input properties (`inputTypes`: a parameter whose schema is a `$ref` that was not resolved has none) and the security schemes a tool resolves (`securitySchemes`, each as `name:type`: a Security Requirement key that is a URI can become a scheme of this document or be dropped).

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
| `self-uri` | `$self` and `$ref`s that name it, written as the whole URI and relative to it: resolved from the document (the story allows no external reference), so the parameters have a `type` |
| `self-relative` | A relative `$self` in a document with no retrieval URI (parsed from text): ignored, with an UNRESOLVABLE_SELF diagnostic |
| `self-refused` | A `$self` with a scheme that is not http, https or file: ignored, with a REFUSED_SELF diagnostic |
| `security-scheme-uri` | Security Requirement keys that are URIs: one naming a scheme of this document by its `$self` and one by a fragment resolve to that scheme; one naming another document is dropped with an UNRESOLVED_SECURITY_SCHEME diagnostic, and the operation keeps the alternative that resolves |

`3.2/invalid`:

| Document | Covers |
| --- | --- |
| `parameter-schema-and-content` | A parameter with both `schema` and `content` (the schema must have exactly one) |
| `self-fragment` | A `$self` with a fragment (the official schema requires none): ignored with an INVALID_SELF diagnostic, and the validator rejects the document |

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
| `self` | `$self` (a 3.2 field) under a 3.1 declaration: ignored, with a `FEATURE_NEWER_THAN_DECLARED_VERSION` diagnostic, and the document stays valid for the library |

## The multi-file tree (`multi-file/`)

One API described over several files, for `e2e/multi-file.e2e.ts`: what a relative `$ref` is read against, for each way a document gets into the library (`fromFile`, `fromURL` with and without redirects, `fromJSON` / `fromYAML` with `documentUri`), and what `$self` does and does not change (it names the document, so a reference to it stays local, but it never moves where the references are read from, except for a document with no retrieval URI at all); also the errors for a reference that cannot be read, the 2,048-character cap on a document's URIs, and an Arazzo document over a multi-file source. It is not run through the five checks above (those read one document at a time, offline); the story reads it from disk, serves it from a loopback HTTP server and records every request. Hand-written, not vendored.

```text
multi-file/
  openapi-3.0.yaml  openapi-3.1.yaml  openapi-3.2.yaml    the same root in each version: three path items by `$ref`
  paths/
    pets.yaml            GET /pets (listPets), POST /pets (createPet)
    pets-by-id.yaml      GET /pets/{petId} (getPet), with a path-level parameter by `$ref`
    owners/owner.yaml    GET /owners/{ownerId} (getOwner): reaches back up with ../../
  parameters/
    PetId.yaml  OwnerId.yaml          path parameters whose schema is `../schemas/Id.yaml`
    paging/Limit.yaml                 the `limit` query parameter, one folder down
  schemas/
    Pet.yaml  Owner.yaml              a cycle: a pet has an owner, an owner has pets
    NewPet.yaml  Error.yaml  Id.yaml  `Id.yaml` is reached from five files, `Error.yaml` from two
  responses/
    PetList.yaml  Problem.yaml  NotFound.yaml    `NotFound.yaml` is reached from two path items by two spellings
```

Every root declares four tools, in this order: `getOwner` (`GET /owners/{ownerId}`), `listPets` (`GET /pets`), `createPet` (`POST /pets`), `getPet` (`GET /pets/{petId}`); loading one makes 14 requests for the files next to the root (15 with the root itself, when it is fetched), each file once. The files are version-neutral, so the three roots share them. Each root is valid by the official schema of its version with its references unresolved (the story checks it). Adding or removing a file changes the pinned list in the story on purpose.

## Adding a document

Put it under `<version>/pass/` (or `<version>/invalid/`), keep it focused and realistic, and give every operation an `operationId`. Then pin its tools and facts in `e2e/expected/supplementary-documents.json` from the document, not from the library's output, and update the literal counts in `SUPPLEMENTARY_VERSIONS` in the story and the counts in `e2e/fixtures/README.md`.
