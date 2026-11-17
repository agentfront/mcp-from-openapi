# Configuration

[Home](../README.md) | [Getting Started](./getting-started.md) | [API Reference](./api-reference.md)

---

## LoadOptions

Passed to factory methods (`fromURL`, `fromFile`, `fromYAML`, `fromJSON`).

```typescript
const generator = await OpenAPIToolGenerator.fromURL(url, {
  dereference: true,
  baseUrl: "https://staging.api.example.com",
  headers: { Authorization: "Bearer token" },
  timeout: 15000,
  validate: true,
  followRedirects: true,
  refResolution: {
    allowedProtocols: ["https"],
    blockedHosts: ["evil.com"],
  },
});
```

| Option            | Type                                   | Default | Description                                                                                                                                                                                         |
| ----------------- | -------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dereference`     | `boolean`                              | `true`  | Resolve all `$ref` pointers in the spec. A Swagger 2.0 document needs it: it is converted to OpenAPI 3.0 once dereferenced, so `false` is refused (`DEREFERENCE_REQUIRED`: `generateTools()`, `generateTool()` and `lint()` throw a `ParseError`, `validate()` returns the error). To read no other document, keep it `true` and use `secureDefaults` or `refResolution.allowedProtocols: []` |
| `baseUrl`         | `string`                               | `''`    | Override server URLs from the spec (each server keeps its `name` and `description`)                                                                                                                 |
| `documentUri`     | `string`                               | -       | Where the document was retrieved from: what its relative `$ref`s are read against, and one of the URIs that name it. An absolute `http`, `https` or `file` URI of at most 2,048 characters without user information, fragment or (for `file:`) host, else `LoadError` before anything is fetched or read. Replaces the URL or file `fromURL` / `fromFile` read. Not `baseUrl`: it never changes `servers` of an OpenAPI 3 document; for a Swagger 2.0 document with no `host` it is where the server's host and scheme come from. See [Document URI](#document-uri) |
| `headers`         | `Record<string, string>`               | `{}`    | Custom HTTP headers for URL loading. Sent only to the spec URL's origin: dropped once a redirect leaves it, and never sent to external `$ref` hosts                                                 |
| `timeout`         | `number`                               | `30000` | HTTP request timeout in milliseconds                                                                                                                                                                |
| `validate`        | `boolean`                              | `true`  | Validate the document with the rules of the version it declares, at the first `generateTools()` / `generateTool()` — see [OpenAPI Versions](./openapi-versions.md). `false` skips it; the declared version is still read when the document is loaded: `getSpecVersion()` reports it, and a version the library cannot process or one newer than 3.2 is also recorded in `getDiagnostics()`. A Swagger 2.0 document is converted either way, and the conversion's `SWAGGER_*` findings are recorded. `generator.validate()` is not affected by this option: it always validates, and dereferences first when the document has a `$ref` that does not start with `#` |
| `followRedirects` | `boolean`                              | `true`  | Follow HTTP redirects when loading from URL                                                                                                                                                         |
| `refResolution`   | `RefResolutionOptions`                 | `{}`    | Security settings for `$ref` resolution |
| `secureDefaults`  | `boolean`                              | `false` | One-flag strict posture for untrusted specs: redirects off, external `$ref` resolution disabled (a reference to the document's own URI is not external: it is still resolved, without a fetch). Explicit values win **per key** — tightening one `refResolution` knob keeps the rest of the preset |
| `overlays`        | `OverlayDocument \| OverlayDocument[]` | -       | OpenAPI Overlay 1.0 docs applied before dereferencing/validation — see [Curation](./curation.md)                                                                                                    |

### RefResolutionOptions

Controls how external `$ref` pointers are resolved during dereferencing. See [SSRF Prevention](./ssrf-prevention.md) for details.

| Option             | Type       | Default             | Description                         |
| ------------------ | ---------- | ------------------- | ----------------------------------- |
| `allowedProtocols` | `string[]` | `['http', 'https']` | Protocols allowed for external refs. A relative `$ref` is checked as the absolute URL it resolves to, and a local path counts as `file`: a multi-file spec on disk needs `file`, which lets the document read any file the process can read (see [Trust Model](./ssrf-prevention.md#trust-model)) |
| `allowedHosts`     | `string[]` | `[]` (all allowed)  | Whitelist specific hostnames        |
| `blockedHosts`     | `string[]` | `[]`                | Additional hostnames to block       |
| `allowInternalIPs` | `boolean`  | `false`             | Disable built-in SSRF protection    |

Host entries match case-insensitively and ignore trailing root dots and IPv6 brackets: `['internal.corp']` also blocks `internal.corp.` and `INTERNAL.CORP`.

A `$ref` that no resolver may read fails with a `ParseError` that names the reference, its base, the rule that refused it and the option that would allow it, and carries them in `error.context`: see [When a Reference Cannot Be Read](./ssrf-prevention.md#when-a-reference-cannot-be-read).

### Document URI

A relative `$ref` (`./schemas/pet.json`) is read against the document's **retrieval URI**:

| Loaded with | Retrieval URI |
| --- | --- |
| `fromURL` | The final URL after redirects, without user information or fragment |
| `fromFile` | The file's `file:` URL |
| `documentUri`, any factory | `documentUri` |
| `fromJSON`, `fromYAML` without `documentUri` | None: relative references resolve against an absolute `$self` of a 3.2 document, else against the process working directory, as in earlier releases |

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  documentUri: "file:///tmp/petstore/openapi.json",
  refResolution: { allowedProtocols: ["file"] },
});
```

For a Swagger 2.0 document the retrieval URI has a second use: when the document has no `host`, an `http` or `https` retrieval URI supplies the server's host and (without `schemes`) its scheme. A `file:` URL, which `fromFile` records, supplies neither, so such a document keeps a relative server URL (`SWAGGER_RELATIVE_SERVER_URL`); see [Servers](./openapi-versions.md#servers-host-basepath-and-schemes).

`$self` (OpenAPI 3.2) names the document but never moves where its references are read from, whenever a retrieval URI exists (see [The `$self` Field](./ssrf-prevention.md#the-self-field)). A `$ref` to the document's own URI (its retrieval URI or `$self`) is resolved from the document, with no fetch, also under `secureDefaults`.

The base changes which URL a relative reference becomes, never which URLs may be read: the result passes `allowedProtocols`, `allowedHosts`, `blockedHosts` and the internal-address check like an absolute reference. A `documentUri`, a `$self` and a retrieval URI each have at most 2,048 characters. `documentUri` is checked first, so a bad value costs no request and no file read. The messages, the limits and what counts as the same document are in [SSRF Prevention](./ssrf-prevention.md#base-uris-and-relative-references).

---

## GenerateOptions

Passed to `generateTools()` and `generateTool()`.

```typescript
const tools = await generator.generateTools({
  includeOperations: ["getUser", "createUser"],
  excludeOperations: ["deleteUser"],
  includeDeprecated: false,
  includeAllResponses: true,
  preferredStatusCodes: [200, 201],
  maxSchemaDepth: 10,
  includeExamples: false,
  includeSecurityInInput: false,
});
```

| Option                              | Type                                                         | Default                          | Description                                                                                |
| ----------------------------------- | ------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------ |
| `includeOperations`                 | `string[]`                                                   | -                                | Only include these operation IDs                                                           |
| `excludeOperations`                 | `string[]`                                                   | -                                | Exclude these operation IDs                                                                |
| `filterFn`                          | `(op: OperationWithContext) => boolean`                      | -                                | Custom filter function                                                                     |
| `namingStrategy`                    | `NamingStrategy`                                             | -                                | Custom naming for conflicts and tool names                                                 |
| `preferredStatusCodes`              | `number[]`                                                   | `[200, 201, 204, 202, 203, 206]` | Preferred response codes (in order) for `includeAllResponses: false`; also picks the streamed response when several stream. A range key (`2XX`) is the fallback for codes the document does not list: see [includeAllResponses](#includeallresponses) |
| `includeDeprecated`                 | `boolean`                                                    | `false`                          | Include deprecated operations                                                              |
| `includeAllResponses`               | `boolean`                                                    | `true`                           | Include all status codes as oneOf union                                                    |
| `maxSchemaDepth`                    | `number`                                                     | `10`                             | Maximum schema nesting depth; deeper structures are truncated with a note                  |
| `maxSchemaNodes`                    | `number`                                                     | `25000`                          | Node budget per generated schema; a schema over it is cut shallower (`SCHEMA_DEPTH_REDUCED`); the tool fails with `SchemaError` when not even depth 1 fits, or when its extension meta, copied values or client-target inlining exceed it |
| `includeExamples`                   | `boolean`                                                    | `false`                          | Include parameter/media-type example values in schemas                                     |
| `includeSecurityInInput`            | `boolean \| string[]`                                        | `false`                          | Add security params to inputSchema; an array selects specific schemes                      |
| `inferAnnotations`                  | `boolean`                                                    | `true`                           | Infer MCP tool annotations from HTTP method semantics                                      |
| `maxToolNameLength`                 | `number`                                                     | `64`                             | Tool name length cap (clamped to MCP's 128 max); longer names get a hash suffix            |
| `includeTags` / `excludeTags`       | `string[]`                                                   | -                                | Filter operations by OpenAPI tags                                                          |
| `includeMethods` / `excludeMethods` | `HTTPMethod[]`                                               | -                                | Filter operations by HTTP method. A standard method (`get`, `query`, ...) matches in any case (`'GET'` works); an `additionalOperations` method (`'LINK'`) matches only exactly as written in the document (`'link'` does not match `LINK`). `excludeMethods` is a denylist: see [Filtering Operations](#filtering-operations) |
| `includePaths` / `excludePaths`     | `string[]`                                                   | -                                | Filter by path globs (`*` per segment, `**` across, `?` one char)                          |
| `readOnlyOnly`                      | `boolean`                                                    | `false`                          | Safety switch: only operations whose effective annotations are read-only                   |
| `target`                            | `'claude' \| 'openai' \| 'gemini' \| 'strict'`               | -                                | Per-client schema dialect transforms — see [Client Targets](./client-targets.md)           |
| `descriptionStrategy`               | `'summaryOnly' \| 'descriptionOnly' \| 'combined' \| 'full'` | `'summaryOnly'`                  | How descriptions are assembled from summary/description/operationId                        |
| `appendResponseSummary`             | `boolean`                                                    | `false`                          | Append a compact `Returns: ...` line from the output schema                                |
| `maxProperties`                     | `number`                                                     | -                                | Cap object nodes to their first N properties (drop noted); root input params never dropped |
| `maxDescriptionLength`              | `number`                                                     | -                                | Ellipsis-truncate every schema description at N chars                                      |
| `stripExamples`                     | `boolean`                                                    | `false`                          | Remove all `examples` arrays from generated schemas                                        |
| `emitTypeSignatures`                | `boolean`                                                    | `false`                          | Render `metadata.typescript = { signature, declaration }` — see [Type Signatures](./type-signatures.md) |
| `emitMeta`                          | `boolean`                                                    | `false`                          | Emit the `dev.agentfront.openapi/operation` entry on tool `_meta` — see [Modern MCP Fields](./modern-mcp-fields.md) |
| `inheritDocumentIcons`              | `boolean`                                                    | `false`                          | Fall back to `info['x-logo']` as a tool icon when no extension icons exist |

### Filtering Operations

Filter which operations become tools by tag, method, path glob, operation ID, annotation safety, extension flags, or a custom function:

```typescript
const tools = await generator.generateTools({
  includeTags: ["public"],
  excludeMethods: ["delete"],
  excludePaths: ["/admin/**", "/internal/*"],
  readOnlyOnly: true, // only read-only operations survive
});
```

**Method filters and OpenAPI 3.2.** Which operations a document has depends on the version it declares: the `query` operation and `additionalOperations` exist only in a document declaring 3.2 or newer; a 3.0 or 3.1 document is read with the eight classic methods (see [OpenAPI Versions](./openapi-versions.md)). So an `excludeMethods` list written for the eight old methods cannot be bypassed by a new method in such a document. A 3.2 document is different: `additionalOperations` accepts any HTTP method token, and a method the document adds later is in no denylist. `excludeMethods` is a denylist and cannot cover methods you have not seen; where a 3.2 document can add arbitrary methods, use `includeMethods` (an allowlist) or `readOnlyOnly`, which keeps only operations whose effective annotations are read-only (an additional method is not, unless an `x-mcp` extension says so):

```typescript
// Only these methods; any other method the document adds is left out
const tools = await generator.generateTools({ includeMethods: ["get", "query"] });
```

Spec authors can also exclude operations declaratively with `x-mcp: false` at the **root, path, or operation** level (operation wins, then path, then root — a root-level `false` flips the whole spec to opt-in). See [Annotations & Extensions](./annotations.md).

The original mechanisms still apply:

**By operation ID:**

```typescript
// Include only specific operations
const tools = await generator.generateTools({
  includeOperations: ["getUser", "createUser"],
});

// Exclude specific operations
const tools = await generator.generateTools({
  excludeOperations: ["deleteUser", "adminReset"],
});
```

**By custom filter:**

The `filterFn` receives an `OperationWithContext` -- the OpenAPI operation object extended with `path` and `method` properties. `method` is the canonical form: lowercase for a standard method (`"get"`, `"query"`), the key exactly as written for an `additionalOperations` operation (`"LINK"`). It only sees the operations the declared version defines:

```typescript
// Only GET operations
const tools = await generator.generateTools({
  filterFn: (op) => op.method === "get",
});

// Only operations tagged "public"
const tools = await generator.generateTools({
  filterFn: (op) => op.tags?.includes("public") ?? false,
});

// Combine: GET operations on /users paths
const tools = await generator.generateTools({
  filterFn: (op) => op.method === "get" && op.path.startsWith("/users"),
});
```

### maxSchemaDepth

Input, output and streamed-response item schemas are bounded to `maxSchemaDepth` levels of nesting (default `10`, minimum `1` — values below 1 are clamped so the root schema always keeps its properties). Nodes at the limit keep their scalar keywords (`type`, `description`, `format`, ...) but have child schemas stripped and `[Truncated: nested schema exceeds maxSchemaDepth]` appended to their description. Truncation covers all JSON Schema 2020-12 structural keywords (`properties`, `patternProperties`, `$defs`, `prefixItems`, `if`/`then`/`else`, `dependentSchemas`, compositions, ...). This keeps pathological or deeply recursive schemas from flooding an agent's context window.

The bound is applied while schemas are converted, not only afterwards: conversion stops descending once it is past `maxSchemaDepth`, and a schema reused through `$ref` (a pagination envelope, a money or address type) is converted once and reused for its other occurrences. Generation cost therefore follows the size of the output, not the number of paths through the spec — a few-KB spec whose schemas each reference the same child twice, chained dozens of levels deep, generates in milliseconds instead of minutes.

No step before truncation recurses once per level of nesting: dereferencing, conversion, request-body flattening, and format resolution walk schemas with explicit stacks, so a chain of thousands of `$ref`s generates like a short one. (`allOf` members don't count toward the depth, because request-body flattening hoists their properties, so an `allOf` chain is walked to its end.) Truncation and the steps after it recurse once per level they keep, so a `maxSchemaDepth` in the hundreds or more can be too deep to process: generating that tool then fails with a `SchemaError` that names the option.

### maxSchemaNodes

The emitted schemas still spell every occurrence of a shared schema out, so a small spec can describe an enormous tree — for example, five properties per level that all reference the next level keep 5^10 nodes after depth truncation. `maxSchemaNodes` (default `25000`) caps several things for each tool.

**A schema over the budget is cut shallower, not dropped.** When an input, output or stream item schema exceeds the budget at `maxSchemaDepth` (its conversion or its truncated tree), that schema alone is built again at the deepest depth that fits, found by bisection, and the operation gets a `SCHEMA_DEPTH_REDUCED` warning naming the schema and the depth (`GET /item: its output schema exceeds the node budget of 25000 (maxSchemaNodes) at maxSchemaDepth 10, so it is cut at depth 5; raise maxSchemaNodes to keep more of it`). The result is exactly the schema `maxSchemaDepth` set to that depth gives. Only when not even depth 1 fits does generating the tool fail, with a `SchemaError` (`The output schema of GET /item exceeds the node budget of 20 (maxSchemaNodes) even cut at depth 1 ...`, `context`: `maxNodes`, `maxSchemaDepth`, `schema`); `generateTools()` skips that tool with a warning, like any other per-tool failure. The other limits below fail the tool as before, since a shallower schema would not make them smaller.

- Each generated input/output schema (and a streamed response's item schema): every JSON value in it counts — each schema object, each keyword's value, and everything inside those (`default`, `examples`, `enum`, `required`, `x-*`, ...). A schema with thousands of keywords, reached through many references, therefore cannot expand past the budget.
- The conversion work for each parameter, request body, and emitted response: one node per schema visited, plus one per keyword of each schema converted (a schema on a cycle is converted once per path). With `includeAllResponses: false`, the responses left out are never converted.
- The `x-mcp`/`x-frontmcp` meta copied into a tool's `_meta` (see [Modern MCP fields](./modern-mcp-fields.md)), and the other values a tool takes from the spec: its title, `metadata`, and the objects in its `mapper`.
- With a client [`target`](./client-targets.md), the inlining of local `$ref`s: a definition is inlined once per `$ref` to it, and every value of the result counts.

Values from the spec are copied, never shared: dereferencing resolves `$ref`s inside examples and defaults too, so one value can expand like a schema can, and is copied whole at any depth (a shallower schema does not shrink it). A tool therefore shares no object with the document or with other tools. A reference back to an enclosing value (a cycle) is dropped, and a value nested more than 1,000 levels deep fails the tool.

A schema's specification extensions (`x-...`) are the exception: OpenAPI never reads their values, so a `$ref` in one is not a Reference Object, and the tool keeps it as the document wrote it. Stripe, for example, names the schemas an expandable field expands to in `x-expansionResources: { oneOf: [{ $ref: '#/components/schemas/customer' }] }`: the tool has those two `$ref`s, where it used to have the whole `customer` graph (millions of nodes, so the tool failed). The `$ref` is the text the dereferencer read, so it is relative to the file it was written in (not to the tool's schema), a reference to the document's own URI is in its local `#/...` form, and keywords written next to it are not kept. The one `$ref` that stays resolved is one to a boolean schema placed directly as an extension of a schema that `$RefParser` (a `$ref` with siblings) or the Swagger 2.0 conversion (a schema it rewrites) copied. `getDocument()` still returns the dereferenced document, and the `x-mcp` / `x-frontmcp` meta of an operation is still resolved (see [Modern MCP fields](./modern-mcp-fields.md)).

For scale, at the default depth: every tool of the full GitHub REST spec generates within a budget of 22,232 nodes, and every tool of the vendored Discord spec within 19,225 — the largest schemas' JSON values, which cost more than any conversion — so the default keeps them whole. The budget was `100000` before the shallower cut existed, when a schema over it cost the tool; at `100000`, Stripe's expandable fields and Microsoft Graph's navigation properties made tools of up to 3 MB and 20 MB. At `25000` all 606 Stripe operations make a tool, 171 of them with a schema cut shallower, the largest 0.9 MB (the median stays about 140 KB), and Graph's largest is 5 MB. A node budget cannot bound bytes (Graph's descriptions average about 124 bytes a node): lower `maxSchemaDepth` to shrink every tool, lower `maxSchemaNodes` to cut only the largest ones shallower, raise it to keep them deeper, or pass `Infinity` to disable the budget.

### includeExamples

When `true`, OpenAPI **parameter-level** and **media-type-level** `example`/`examples` values are copied into the generated schemas as JSON Schema `examples` arrays. They override schema-level examples where both exist (matching OpenAPI precedence). The `examples` map wins over the singular `example`; `$ref` example entries are skipped. Of an Example Object, the data form is used: OpenAPI 3.2 `dataValue` when present, otherwise `value`; an example that has only `serializedValue` or `externalValue` is left out, since neither is data. A parameter defined with `content` takes its own `example`/`examples` first, then those of its media type. For flattened object bodies, object-valued media-type examples are distributed onto the matching properties (`example: { name: 'Ada' }` → `name.examples: ['Ada']`).

Note: **schema-level** `example` keywords are always normalized to `examples` arrays by `toJsonSchema()`, regardless of this option — this option only controls the additional parameter/media-type sources.

### inferAnnotations

When `true` (default), each tool gets MCP [tool annotations](./annotations.md) derived from HTTP method semantics (RFC 9110 safety/idempotency):

| Method                           | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| -------------------------------- | -------------- | ----------------- | ---------------- | --------------- |
| GET, HEAD, OPTIONS, TRACE, QUERY | `true`         | `false`           | `true`           | `false`         |
| PUT, DELETE                      | `false`        | `true`            | `true`           | `false`         |
| POST, PATCH                      | `false`        | `true`            | `false`          | `false`         |
| Any other method (OpenAPI 3.2 `additionalOperations`, such as LINK) | `false` | `true` | `false` | `false` |

Extension overrides (`x-speakeasy-mcp`, `x-mcp`, `x-frontmcp`) are merged on top and still apply when inference is disabled. See [Annotations & Extensions](./annotations.md).

### maxToolNameLength

Tool names are always normalized to MCP's rules (`[A-Za-z0-9_.-]`, 1-128 chars) and capped at `maxToolNameLength` (default `64`, matching the strictest common client limits — Claude and Bedrock cap tool names at 64 characters). Names over the cap are truncated and given an 8-character hash suffix derived from the full original name, so truncated names stay unique and stable across regenerations. See [Naming Strategies](./naming-strategies.md).

### includeSecurityInInput

By default (`false`), security parameters appear **only** in the mapper with a `security` field. Frameworks resolve auth from environment variables, context, or vaults -- not from user input.

When set to `true`, security parameters are also added to the `inputSchema` as required string properties, allowing callers to pass auth values directly as tool inputs.

When set to a **string array**, only the named schemes appear in the `inputSchema` (the rest stay mapper-only): `includeSecurityInInput: ['ApiKeyAuth']`. All schemes are always present in the mapper regardless.

### includeAllResponses

When `true` (default), the output schema is a `oneOf` union of all response status codes. Each variant includes an `x-status-code` annotation.

When `false`, only the single preferred response is used. It is the first of these that finds a response with a schema:

1. an explicit status code in `preferredStatusCodes`, in its order;
2. any explicit 2xx code;
3. a range key (`2XX`, any case in the document) covering a code in `preferredStatusCodes`, in its order, else the `2XX` range;
4. any explicit 3xx code, else the `3XX` range;
5. the first response with a schema (`default` only when nothing else has one).

An explicit code beats a range of its own class for 2xx (rule 2 precedes every range rule), for a code listed in `preferredStatusCodes` (rule 1), and for 3xx while no range covers a code of `preferredStatusCodes`: with responses `299` and `2XX` the answer is 299, although `2XX` covers the preferred 200. In the other classes a range covering a code of `preferredStatusCodes` wins (rule 3): with `499` and `4XX` and `preferredStatusCodes: [404]` the answer is `4XX`. A range key keeps its name in the output: `x-status-code` is `'2XX'` and `metadata.responseStatusRanges` lists it (`metadata.responseStatusCodes` holds only numbers). See [Response Schemas](./response-schemas.md#selection-priority).

A streamed response (OpenAPI 3.2 `itemSchema`) is not part of the union either way: it is reported in `metadata.responseStream`. The response is chosen by the same status code preference (ranges included; its `statusCode` is then `'2XX'`); within it, the stream's media type is the first one with `itemSchema` in document order, independent of the media type the output schema comes from. See [Response Schemas](./response-schemas.md#streaming-responses).

---

## NamingStrategy

Customize how parameter conflicts are resolved and how tools are named. See [Naming Strategies](./naming-strategies.md) for details.

```typescript
const tools = await generator.generateTools({
  namingStrategy: {
    conflictResolver: (paramName, location, index) => {
      return `${location.toUpperCase()}_${paramName}`;
    },
    toolNameGenerator: (path, method, operationId) => {
      return operationId ?? `${method}_${path.replace(/\//g, "_")}`;
    },
  },
});
```

---

**Related:** [Getting Started](./getting-started.md) | [SSRF Prevention](./ssrf-prevention.md) | [Naming Strategies](./naming-strategies.md)
