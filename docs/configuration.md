# Configuration

[Home](../README.md) | [Getting Started](./getting-started.md) | [API Reference](./api-reference.md)

---

## LoadOptions

Passed to factory methods (`fromURL`, `fromFile`, `fromYAML`, `fromJSON`).

```typescript
const generator = await OpenAPIToolGenerator.fromURL(url, {
  dereference: true,
  baseUrl: 'https://staging.api.example.com',
  headers: { Authorization: 'Bearer token' },
  timeout: 15000,
  validate: true,
  followRedirects: true,
  refResolution: {
    allowedProtocols: ['https'],
    blockedHosts: ['evil.com'],
  },
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dereference` | `boolean` | `true` | Resolve all `$ref` pointers in the spec |
| `baseUrl` | `string` | `''` | Override server URLs from the spec |
| `headers` | `Record<string, string>` | `{}` | Custom HTTP headers for URL loading |
| `timeout` | `number` | `30000` | HTTP request timeout in milliseconds |
| `validate` | `boolean` | `true` | Validate the OpenAPI document on load |
| `followRedirects` | `boolean` | `true` | Follow HTTP redirects when loading from URL |
| `refResolution` | `RefResolutionOptions` | `{}` | Security settings for `$ref` resolution |

### RefResolutionOptions

Controls how external `$ref` pointers are resolved during dereferencing. See [SSRF Prevention](./ssrf-prevention.md) for details.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowedProtocols` | `string[]` | `['http', 'https']` | Protocols allowed for external refs |
| `allowedHosts` | `string[]` | `[]` (all allowed) | Whitelist specific hostnames |
| `blockedHosts` | `string[]` | `[]` | Additional hostnames to block |
| `allowInternalIPs` | `boolean` | `false` | Disable built-in SSRF protection |

---

## GenerateOptions

Passed to `generateTools()` and `generateTool()`.

```typescript
const tools = await generator.generateTools({
  includeOperations: ['getUser', 'createUser'],
  excludeOperations: ['deleteUser'],
  includeDeprecated: false,
  includeAllResponses: true,
  preferredStatusCodes: [200, 201],
  maxSchemaDepth: 10,
  includeExamples: false,
  includeSecurityInInput: false,
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `includeOperations` | `string[]` | - | Only include these operation IDs |
| `excludeOperations` | `string[]` | - | Exclude these operation IDs |
| `filterFn` | `(op: OperationWithContext) => boolean` | - | Custom filter function |
| `namingStrategy` | `NamingStrategy` | - | Custom naming for conflicts and tool names |
| `preferredStatusCodes` | `number[]` | `[200, 201, 204, 202, 203, 206]` | Preferred response codes (in order) |
| `includeDeprecated` | `boolean` | `false` | Include deprecated operations |
| `includeAllResponses` | `boolean` | `true` | Include all status codes as oneOf union |
| `maxSchemaDepth` | `number` | `10` | Maximum nesting depth for schemas |
| `includeExamples` | `boolean` | `false` | Include example values in schemas |
| `includeSecurityInInput` | `boolean` | `false` | Add security params to inputSchema |

### Filtering Operations

Three ways to filter which operations become tools:

**By operation ID:**

```typescript
// Include only specific operations
const tools = await generator.generateTools({
  includeOperations: ['getUser', 'createUser'],
});

// Exclude specific operations
const tools = await generator.generateTools({
  excludeOperations: ['deleteUser', 'adminReset'],
});
```

**By custom filter:**

The `filterFn` receives an `OperationWithContext` -- the OpenAPI operation object extended with `path` and `method` properties:

```typescript
// Only GET operations
const tools = await generator.generateTools({
  filterFn: (op) => op.method === 'get',
});

// Only operations tagged "public"
const tools = await generator.generateTools({
  filterFn: (op) => op.tags?.includes('public') ?? false,
});

// Combine: GET operations on /users paths
const tools = await generator.generateTools({
  filterFn: (op) => op.method === 'get' && op.path.startsWith('/users'),
});
```

### includeSecurityInInput

By default (`false`), security parameters appear **only** in the mapper with a `security` field. Frameworks resolve auth from environment variables, context, or vaults -- not from user input.

When set to `true`, security parameters are also added to the `inputSchema` as required string properties, allowing callers to pass auth values directly as tool inputs.

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
      return operationId ?? `${method}_${path.replace(/\//g, '_')}`;
    },
  },
});
```

---

**Related:** [Getting Started](./getting-started.md) | [SSRF Prevention](./ssrf-prevention.md) | [Naming Strategies](./naming-strategies.md)
