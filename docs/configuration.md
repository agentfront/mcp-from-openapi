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
| `dereference`     | `boolean`                              | `true`  | Resolve all `$ref` pointers in the spec                                                                                                                                                             |
| `baseUrl`         | `string`                               | `''`    | Override server URLs from the spec                                                                                                                                                                  |
| `headers`         | `Record<string, string>`               | `{}`    | Custom HTTP headers for URL loading                                                                                                                                                                 |
| `timeout`         | `number`                               | `30000` | HTTP request timeout in milliseconds                                                                                                                                                                |
| `validate`        | `boolean`                              | `true`  | Validate the OpenAPI document on load                                                                                                                                                               |
| `followRedirects` | `boolean`                              | `true`  | Follow HTTP redirects when loading from URL                                                                                                                                                         |
| `refResolution`   | `RefResolutionOptions`                 | `{}`    | Security settings for `$ref` resolution                                                                                                                                                             |
| `secureDefaults`  | `boolean`                              | `false` | One-flag strict posture for untrusted specs: redirects off, external `$ref` resolution disabled. Explicit values win **per key** — tightening one `refResolution` knob keeps the rest of the preset |
| `overlays`        | `OverlayDocument \| OverlayDocument[]` | -       | OpenAPI Overlay 1.0 docs applied before dereferencing/validation — see [Curation](./curation.md)                                                                                                    |

### RefResolutionOptions

Controls how external `$ref` pointers are resolved during dereferencing. See [SSRF Prevention](./ssrf-prevention.md) for details.

| Option             | Type       | Default             | Description                         |
| ------------------ | ---------- | ------------------- | ----------------------------------- |
| `allowedProtocols` | `string[]` | `['http', 'https']` | Protocols allowed for external refs |
| `allowedHosts`     | `string[]` | `[]` (all allowed)  | Whitelist specific hostnames        |
| `blockedHosts`     | `string[]` | `[]`                | Additional hostnames to block       |
| `allowInternalIPs` | `boolean`  | `false`             | Disable built-in SSRF protection    |

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
| `preferredStatusCodes`              | `number[]`                                                   | `[200, 201, 204, 202, 203, 206]` | Preferred response codes (in order)                                                        |
| `includeDeprecated`                 | `boolean`                                                    | `false`                          | Include deprecated operations                                                              |
| `includeAllResponses`               | `boolean`                                                    | `true`                           | Include all status codes as oneOf union                                                    |
| `maxSchemaDepth`                    | `number`                                                     | `10`                             | Maximum schema nesting depth; deeper structures are truncated with a note                  |
| `includeExamples`                   | `boolean`                                                    | `false`                          | Include parameter/media-type example values in schemas                                     |
| `includeSecurityInInput`            | `boolean \| string[]`                                        | `false`                          | Add security params to inputSchema; an array selects specific schemes                      |
| `inferAnnotations`                  | `boolean`                                                    | `true`                           | Infer MCP tool annotations from HTTP method semantics                                      |
| `maxToolNameLength`                 | `number`                                                     | `64`                             | Tool name length cap (clamped to MCP's 128 max); longer names get a hash suffix            |
| `includeTags` / `excludeTags`       | `string[]`                                                   | -                                | Filter operations by OpenAPI tags                                                          |
| `includeMethods` / `excludeMethods` | `HTTPMethod[]`                                               | -                                | Filter operations by HTTP method                                                           |
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

The `filterFn` receives an `OperationWithContext` -- the OpenAPI operation object extended with `path` and `method` properties:

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

Input and output schemas are bounded to `maxSchemaDepth` levels of nesting (default `10`, minimum `1` — values below 1 are clamped so the root schema always keeps its properties). Nodes at the limit keep their scalar keywords (`type`, `description`, `format`, ...) but have child schemas stripped and `[Truncated: nested schema exceeds maxSchemaDepth]` appended to their description. Truncation covers all JSON Schema 2020-12 structural keywords (`properties`, `patternProperties`, `$defs`, `prefixItems`, `if`/`then`/`else`, `dependentSchemas`, compositions, ...). This keeps pathological or deeply recursive schemas from flooding an agent's context window.

### includeExamples

When `true`, OpenAPI **parameter-level** and **media-type-level** `example`/`examples` values are copied into the generated schemas as JSON Schema `examples` arrays. They override schema-level examples where both exist (matching OpenAPI precedence). The `examples` map wins over the singular `example`; `$ref` example entries are skipped. For flattened object bodies, object-valued media-type examples are distributed onto the matching properties (`example: { name: 'Ada' }` → `name.examples: ['Ada']`).

Note: **schema-level** `example` keywords are always normalized to `examples` arrays by `toJsonSchema()`, regardless of this option — this option only controls the additional parameter/media-type sources.

### inferAnnotations

When `true` (default), each tool gets MCP [tool annotations](./annotations.md) derived from HTTP method semantics (RFC 9110 safety/idempotency):

| Method                    | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| ------------------------- | -------------- | ----------------- | ---------------- | --------------- |
| GET, HEAD, OPTIONS, TRACE | `true`         | `false`           | `true`           | `false`         |
| PUT, DELETE               | `false`        | `true`            | `true`           | `false`         |
| POST, PATCH               | `false`        | `true`            | `false`          | `false`         |

Extension overrides (`x-speakeasy-mcp`, `x-mcp`, `x-frontmcp`) are merged on top and still apply when inference is disabled. See [Annotations & Extensions](./annotations.md).

### maxToolNameLength

Tool names are always normalized to MCP's rules (`[A-Za-z0-9_.-]`, 1-128 chars) and capped at `maxToolNameLength` (default `64`, matching the strictest common client limits — Claude and Bedrock cap tool names at 64 characters). Names over the cap are truncated and given an 8-character hash suffix derived from the full original name, so truncated names stay unique and stable across regenerations. See [Naming Strategies](./naming-strategies.md).

### includeSecurityInInput

By default (`false`), security parameters appear **only** in the mapper with a `security` field. Frameworks resolve auth from environment variables, context, or vaults -- not from user input.

When set to `true`, security parameters are also added to the `inputSchema` as required string properties, allowing callers to pass auth values directly as tool inputs.

When set to a **string array**, only the named schemes appear in the `inputSchema` (the rest stay mapper-only): `includeSecurityInInput: ['ApiKeyAuth']`. All schemes are always present in the mapper regardless.

### includeAllResponses

When `true` (default), the output schema is a `oneOf` union of all response status codes. Each variant includes an `x-status-code` annotation.

When `false`, only the single preferred status code schema is used (based on `preferredStatusCodes` order).

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
