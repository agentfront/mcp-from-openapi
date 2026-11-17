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

### Swagger 2.0 (`2.0/pass`, `2.0/invalid`)

Swagger 2.0 documents, one construct each, for what the 2.0 support has to translate (to the 3.x shape the library reads) or to refuse. They are held to the **official 2.0 JSON Schema** pinned under `oas/schemas/2.0/`, offline, through `e2e/helpers/oas-validate.ts` (`validateOasDocument('2.0', ...)`, the same call as for 3.0, 3.1 and 3.2): the pinned schema, the pinned draft-04 meta-schema registered under `http://json-schema.org/draft-04/schema`, `validateFormats: false`, and `strictSchema: 'log'` with every logged message but one refused. That one is why strict mode cannot stay on: the official 2.0 schema writes `additionalItems` next to an `items` that is not an array (in `vendorExtension` and `parametersList`), which Ajv's strict mode refuses, and the keyword does nothing there. The helper's own header says why for each option.

| Document | Covers |
| --- | --- |
| `no-host` | No `host` and no `schemes`, only a `basePath`: a 3.x form has one relative server |
| `two-schemes` | `schemes: [https, http]` with a `host` that has a port: one server per scheme, in the order written |
| `collection-format-tsv` | `collectionFormat: tsv` in a query and a header parameter: 3.x has no style for it |
| `collection-format-locations` | `ssv` in a query, `csv` written in a header, and a query array and a path array with no `collectionFormat` (csv) |
| `websocket-schemes` | `schemes: [wss, https]`: every operation is an HTTP call, never sent over `ws` or `wss`, so a 3.x form has the one https server, and a diagnostic says the socket scheme was left out |
| `file-upload-consumes` | A `type: file` parameter under `consumes` that lists urlencoded first and multipart second (`uploadAvatar`), and under one that lists urlencoded only (`uploadScan`): the 2.0 text allows both lists, a file's bytes only travel in a multipart part, so a 3.x form offers `multipart/form-data` only, and says so for the second operation |
| `file-response` | A response whose schema is `type: file`, under two `produces` media types, with a response header |
| `x-nullable` | `x-nullable: true` and `false` on a string, an integer, an object, an array and the items of an array |
| `global-body-two-consumes` | One global body parameter (`#/parameters/Pet`) used by two operations, one on the document's `consumes`, one on its own `application/xml` |
| `global-response-produces-override` | A global response (`#/responses/Problem`) used by an operation that overrides `produces` |

`2.0/invalid`:

| Document | Covers | Official schema says |
| --- | --- | --- |
| `body-and-form-data` | A body parameter and `formData` parameters in one operation (the 2.0 text forbids it: "form parameters ... cannot be declared together with a body parameter for the same operation") | **valid**: the schema cannot express the rule |
| `path-parameter-not-required` | A path parameter without `required: true`, common in real descriptions: the validator rejects it, and the conversion makes the parameter required (a diagnostic says so), so the converted document is valid OpenAPI 3.0 | **invalid** (`required` must be `true` for `in: path`) |

The `2.0/invalid` folder holds documents that break the 2.0 *text*, not only its schema: the official 2.0 schema checks each parameter alone and cannot see a rule across parameters, so `body-and-form-data` is accepted by it. A check that asserts "the schema rejects every document under `invalid/`" (as for 3.1 and 3.2 above) holds for `path-parameter-not-required` only; the verdict of the schema is recorded per document in the table (and in `e2e/expected/supplementary-documents.json`, as `officialSchema: "accepts"`).

These documents are also read by `e2e/swagger2.e2e.ts` (the story of the conversion itself): each is converted both by the generator and by `upgradeSwagger2`, the two must agree, and the converted document must validate in full against the official OpenAPI 3.0 schema, the `invalid/` ones included. Its inline documents cover what no file here does: `basePath` (without its slash, or unusable) and the `schemes` variants, the media types of a file form, security definitions the conversion cannot carry over, parameter examples and names that are no string, the cap on a media type list and the budget of a conversion.

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

## The equivalence API (`equivalence/`)

One small API, the Lending Library, written five times with the same meaning. The library reads a Swagger 2.0 document by converting it to OpenAPI 3.0 when it loads it, so these five files are the proof: a correct conversion of `swagger-2.0.yaml` and of `swagger-2.0-split/` gives the tools of `openapi-3.0.yaml`, and the 3.0 form gives those of `openapi-3.1.yaml` and `openapi-3.2.yaml`. Hand-written, not vendored, and not in `oas/sources.json`. The operation ids, parameter names, summaries and descriptions are the same in all five.

```text
equivalence/
  swagger-2.0.yaml            the original: one Swagger 2.0 file
  swagger-2.0-split/          the same 2.0 API over 12 files, joined by relative `$ref`s
    swagger.yaml              the root: info, host, servers, security, paths (no parameters, responses or definitions sections)
    parameters.yaml           BookId, Limit, Offset, RequestId: reached as `parameters.yaml#/Limit`
    responses.yaml            NotFound, Unauthorized, Unexpected: reached as `responses.yaml#/NotFound`
    definitions/              one schema per file: Book.yaml reaches CatalogItem.yaml and BookStatus.yaml next to it,
                              Category.yaml reaches itself, Error.yaml is reached from responses.yaml one folder up
  openapi-3.0.yaml            what a correct conversion produces, as OpenAPI 3.0.3
  openapi-3.1.yaml            the same as OpenAPI 3.1.0
  openapi-3.2.yaml            the same as OpenAPI 3.2.0
```

The 3.0 form was written from the OpenAPI 3.0.4 text (the Parameter Object `style` table, which says it replaces `collectionFormat`; the Request Body and Media Type Objects; "file input/output content ... is described with the same semantics as any other schema type"; the OAuth Flows Object, whose `clientCredentials` and `authorizationCode` were `application` and `accessCode` in 2.0) and the 2.0 text, not generated by a converter. The 3.1 and 3.2 files are the 3.0 file with the version changed: nothing the API uses is spelled differently in the three (it has no `nullable`, no exclusive bounds, no schema `example`, and it keeps `format: binary` for files, which 3.1 and 3.2 still accept and the library reads as binary), so a correct conversion differs from them only in that line.

### The API

Base `https://library.example.com/api/v1` (and `http://`); JSON by default; the key in `X-API-Key` unless an operation says otherwise.

| Operation | Request | What it exercises |
| --- | --- | --- |
| `listBooks` | `GET /books` | Array query parameters in `csv` (`genres`), `pipes` (`statuses`, with an enum in `items`) and `multi` (`tags`); global parameters `Limit`, `Offset` and the header `X-Request-Id`; response headers and `examples`; two alternative API keys (header or query); global `401` and `default` responses |
| `createBook` | `POST /books` | A JSON `in: body` parameter (`book`); oauth2 `accessCode` with `write:books`; a `Location` response header; an inline `400` |
| `getBook` | `GET /books/{bookId}` | The path parameter shared at path-item level, by a global `$ref`; the header parameter again; `security: []` (public, overriding the root); an `allOf` + `discriminator` schema; global `404` |
| `patchBook` | `PATCH /books/{bookId}` | An operation `consumes` override (`application/merge-patch+json`) with a body parameter (`patch`); no `security`, so the root API key applies |
| `deleteBook` | `DELETE /books/{bookId}` | oauth2 `application` (`admin`); a `204` with no body |
| `uploadBookCover` | `POST /books/{bookId}/cover` | `consumes: multipart/form-data` with `in: formData` parameters, one of them `type: file` and required; oauth2 `accessCode` |
| `listCategories` | `GET /categories` | A recursive schema (`Category.children` is a list of `Category`); no `security`, so the root API key applies |
| `createLoan` | `POST /loans` | `consumes: application/x-www-form-urlencoded` with three `in: formData` parameters; HTTP `basic` |
| `listMemberLoans` | `GET /members/{memberId}/loans` | A path parameter defined inline at path-item level; an enum query parameter with a default; global `Limit` and `Offset`; oauth2 `accessCode` with `read:loans` |
| `exportBooks` | `GET /exports/books` | An operation `produces` override (`text/csv`) with a plain string schema and a `text/csv` example; oauth2 `application` (`reports`); responses with no schema |

The tools come out in this order (path ascending, then method): `listBooks`, `createBook`, `getBook`, `patchBook`, `deleteBook`, `uploadBookCover`, `listCategories`, `exportBooks`, `createLoan`, `listMemberLoans`.

### Construct by construct

| Swagger 2.0 construct | In `swagger-2.0.yaml` | In `swagger-2.0-split/` | In the 3.0 / 3.1 / 3.2 forms |
| --- | --- | --- | --- |
| `host`, `basePath`, `schemes` | root members; two schemes | the same, in `swagger.yaml` | `servers`: `https://library.example.com/api/v1`, then `http://...` |
| Root `consumes`, `produces` | both `application/json` | the same | no root member: the media type is the key of `requestBody.content` / `responses.*.content` of each operation, and of `components.responses` |
| Operation `consumes` override | `patchBook`, `uploadBookCover`, `createLoan` | the same | the media type key of that operation's `requestBody.content` |
| Operation `produces` override | `exportBooks` (`text/csv`) | the same | the media type key of its `200` `content` |
| JSON `in: body` parameter | `createBook` (`book`), `patchBook` (`patch`) | the same | `requestBody` with `description`, `required` and `content.<media type>.schema`; the parameter name is dropped |
| `in: formData`, urlencoded | `createLoan`: `bookId`, `memberId`, `dueDate` | the same | `requestBody.content.application/x-www-form-urlencoded.schema`, an object whose `properties` are the parameters and whose `required` lists the required ones; `requestBody.required: true` |
| `in: formData`, multipart, `type: file` | `uploadBookCover`: `cover`, `caption` | the same | `requestBody.content.multipart/form-data.schema`; `cover` is `type: string, format: binary` |
| `collectionFormat` `csv`, `pipes`, `multi` on query arrays | `genres`, `statuses`, `tags` of `listBooks` | the same | `style: form` + `explode: false`, `style: pipeDelimited` + `explode: false`, `style: form` + `explode: true` |
| Header parameter | global `RequestId` (`X-Request-Id`), used by `listBooks` and `getBook` | `parameters.yaml#/RequestId` | `components.parameters.RequestId` (`in: header`), the same two `$ref`s |
| Path parameter at path-item level | `/books/{bookId}` and `/books/{bookId}/cover` (a global `$ref`); `/members/{memberId}/loans` (inline) | `parameters.yaml#/BookId`; inline | the same place, `parameters` of the path item |
| Global `parameters` | `parameters`: `BookId`, `Limit`, `Offset`, `RequestId` | `parameters.yaml` | `components.parameters`, with `schema` |
| Global `responses` | `responses`: `NotFound`, `Unauthorized`, `Unexpected` | `responses.yaml` | `components.responses`, with `content.application/json` (the root `produces`) |
| `definitions` | `definitions` | `definitions/*.yaml` | `components.schemas`, the same schemas, references re-pointed |
| `allOf` | `Book`, `Audiobook` | `definitions/Book.yaml`, `definitions/Audiobook.yaml` | the same |
| Enum | `BookStatus`; the items of `statuses`; `status` of `listMemberLoans`; `Loan.status` | the same | the same |
| Recursive schema | `Category.children` | `definitions/Category.yaml` refers to itself | the same, through `#/components/schemas/Category` |
| String `discriminator` | `CatalogItem`: `discriminator: kind` | `definitions/CatalogItem.yaml` | `discriminator: { propertyName: kind }` |
| Response `headers` | `X-Total-Count`, `X-Rate-Limit-Remaining`, `Location`, `Content-Disposition`, and `WWW-Authenticate` in the global `Unauthorized` | the same | `headers.<name>` with a `schema` wrapping the 2.0 header's type |
| Response `examples` | `listBooks`, `getBook`, `listMemberLoans` (`application/json`), `exportBooks` (`text/csv`) | the same | `content.<media type>.example` |
| `securityDefinitions` `basic` | `basicAuth`; used by `createLoan` | the same | `securitySchemes.basicAuth`: `type: http`, `scheme: basic` |
| `apiKey`, header and query | `apiKeyHeader` (the root default), `apiKeyQuery`; `listBooks` accepts either | the same | `securitySchemes`, unchanged |
| `oauth2`, `accessCode` | `oauthMember` (`read:loans`, `write:books`); used by `createBook`, `uploadBookCover`, `listMemberLoans` | the same | `flows.authorizationCode` |
| `oauth2`, `application` | `oauthService` (`admin`, `reports`); used by `deleteBook`, `exportBooks` | the same | `flows.clientCredentials` |
| Root `security`, and `security: []` | `apiKeyHeader`; `getBook` turns it off | the same | the same members |

In the split form every `$ref` is a file or a file and a pointer, resolved against the file that holds it (`definitions/Book.yaml` reaches `CatalogItem.yaml` as a sibling, `responses.yaml` reaches `definitions/Error.yaml` from the root folder).

### What cannot be made equal

The five forms say the same thing to a tool, but not the same words, and these differences are real:

1. **A body parameter's name has no 3.x place.** `book` (`createBook`) and `patch` (`patchBook`) are the `name` of the 2.0 body parameters. An OpenAPI 3.x Request Body has no name, so the three 3.x forms omit it. A conversion that keeps it in an extension (some converters write `x-codegen-request-body-name`) differs from these forms by exactly that member.
2. **`consumes` and `produces` become media types only where something uses them.** The root `consumes` shows in 3.x as the key of `requestBody.content` of the operations that have a body, and as nothing on the others (`listBooks`, `getBook`, `deleteBook`, ...). A `produces` shows as the key of `content` of the responses that have a schema, and as nothing on a response without one (`deleteBook`'s `204`, the `401` and `default` of `exportBooks`). Equal in effect for every operation, but the 3.x forms cannot tell which media types the 2.0 document declared at the root and which at an operation.
3. **A global response takes the root `produces`.** In 2.0 a response has no media type of its own; in 3.x `components.responses.NotFound` has to name one, so it takes the root `produces` (`application/json`). That is equal for every operation that uses it here because none of them overrides `produces` and uses a global response (`exportBooks` writes its `401` and `default` inline for that reason). An operation that does both cannot be equal: see `2.0/pass/global-response-produces-override`.
4. **A global body parameter cannot be shared between operations with different `consumes`.** The API has no global body parameter, because it has no 3.x form that is the same for every operation that uses it: see `2.0/pass/global-body-two-consumes`.
5. **`type: file` and `format: binary` are not the same statement.** 2.0 `file` is a type that only a `formData` parameter or a response may have; a 3.x `type: string, format: binary` can be anywhere. The 3.1 and 3.2 forms would more idiomatically say `contentMediaType` (3.1 and later treat `format` as an annotation); they keep `format: binary` so that all five forms, and the tools the library builds from them, carry the same input schema.
6. **`collectionFormat` omitted is `csv`, and 3.x writes it out.** A 2.0 array with no `collectionFormat` is csv, which is `style: form, explode: false` in a query and `style: simple` in a path or header, not the 3.x default (`explode: true` in a query). The API writes `csv` explicitly in 2.0 so that the five forms read alike; `tsv` has no 3.x style at all (`2.0/pass/collection-format-tsv`).
7. **A `formData` parameter is not a parameter in 3.x.** The five `formData` parameters are properties of a request body schema; their `in` is gone, and `requestBody.required` is derived (true when a form parameter is required, as for `cover`; 2.0 cannot say a form as a whole is optional). The 3.x `encoding` of a multipart part (the media type of `cover`) has no 2.0 spelling, so the 3.x forms do not use it.
8. **One 2.0 oauth2 definition is one flow; a 3.x scheme can hold several.** The 3.x forms keep two schemes, `oauthMember` and `oauthService`, because operations name them; one scheme with two flows would be valid and not equal. The `scopes` map is required of an oauth2 flow in 3.x, and the official 2.0 schema does not require it (the 2.0 text does), so a 2.0 definition without one (the Netlify fixture's) has a valid 3.x form only once `scopes: {}` is added.
9. **`servers` can say more than `host`, `basePath` and `schemes`.** 2.0 has one `basePath` for every scheme; 3.x could give each scheme its own path, so the two servers are equal here and not in general. A 2.0 document without a `host` has a relative server (`2.0/pass/no-host`).
10. **`discriminator` is a name in 2.0 and an object in 3.x.** The 3.x object can carry a `mapping`; the 2.0 string means the value of the property is the name of the definition, which is also the 3.x default, so no `mapping` is written and the two are equal.
11. **The split form is equal only once its references are resolved.** It has no `parameters`, `responses` or `definitions` section, so a conversion that left the external references alone would have an empty `components` where the 3.x forms have `components.parameters`, `components.responses` and `components.schemas`. Dereferenced, its `paths` and everything else except those three sections equal those of the single file (checked for these files).
12. **The version members** (`swagger: '2.0'`, `openapi: 3.x`) and `servers` differ by definition.

### How they were checked

- `swagger-2.0.yaml` and `swagger-2.0-split/swagger.yaml` validate against the official 2.0 schema (offline, the pinned copy; the same `ajv-draft-04` script as for `2.0/pass`). The split root was also bundled with `@apidevtools/json-schema-ref-parser` (every sibling file resolved) and the bundle validates too.
- Dereferenced, the split form equals the single file in everything except the three sections it does not have (a cycle-safe deep comparison, with a negative control).
- `openapi-3.0.yaml`, `openapi-3.1.yaml` and `openapi-3.2.yaml` validate against the official schema of their version through `e2e/helpers/oas-validate.ts`.
- The hand-written 3.x forms were compared with the result of applying the mapping rules of the table above, in memory, to `swagger-2.0.yaml` (a throwaway script, with a negative control): no difference. That script only checked the files; it wrote none of them.
- The library reads the three 3.x forms into the same 10 tools, identical in input schema, output schema, mapper and metadata.

## Adding a document

Put it under `<version>/pass/` (or `<version>/invalid/`), keep it focused and realistic, and give every operation an `operationId`. Then pin its tools and facts in `e2e/expected/supplementary-documents.json` from the document, not from the library's output, and update the literal counts in `SUPPLEMENTARY_VERSIONS` in the story and the counts in `e2e/fixtures/README.md`. A Swagger 2.0 document also goes into `DOCUMENTS` in `e2e/swagger2.e2e.ts` (that story fails for a file the table does not list, and pins the number of documents) with the 2.0-only constructs it holds.
