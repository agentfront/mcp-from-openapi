# Modern MCP Fields: \_meta, Icons, Headers & Elicitation

[Home](../README.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)

---

The MCP spec arc from 2025-06-18 through 2026-07-28 added client-visible surfaces beyond schemas: namespaced `_meta`, tool icons, and elicitation. This page covers how generated tools carry them — all as pure data; wiring them to a live server is the consumer's job.

## Tool `_meta`

```typescript
const tool = await generator.generateTool('/items', 'get', { emitMeta: true });

tool._meta;
// {
//   'dev.agentfront.openapi/operation': {
//     path: '/items', method: 'get', operationId: 'listItems',
//     tags: ['items'], deprecated: true,
//     specTitle: 'Items API', specVersion: '2.0.0',
//   },
// }
```

With `emitMeta: true`, every tool gets a `dev.agentfront.openapi/operation` entry (reverse-DNS key per MCP `_meta` conventions) carrying the source operation's coordinates — absent fields are elided. Spec authors can add their own entries via the extensions:

```yaml
x-mcp:
  meta: { "com.example/billing-tier": "pro" }
```

Extension-supplied `meta` is emitted **even when `emitMeta` is off**, merged key-by-key with `x-frontmcp.meta` winning over `x-mcp.meta`. Keys under the reserved `dev.agentfront.openapi/` namespace are ignored from extensions — consumers can trust the generated entry's operation coordinates. Pollution-gadget keys (`__proto__`, `constructor`, `prototype`) are stripped recursively. `x-speakeasy-mcp` does not participate (outside its published contract).

## Tool icons

```yaml
x-frontmcp:
  icons: [{ src: "https://example.com/invoice.png", mimeType: "image/png", sizes: ["48x48"] }]
```

Icons (MCP spec 2025-11-25: `{ src, mimeType?, sizes? }`) come from `x-frontmcp.icons` or `x-mcp.icons` (later replaces wholesale; malformed entries are dropped, and `src` must be an `https:` or `data:` URI — anything else, `javascript:` included, is rejected). With `inheritDocumentIcons: true`, operations without extension icons fall back to the document's `info['x-logo']` (Redoc convention — a URL string or `{ url }` object, same scheme rule) as a single icon on every tool. The fallback is off by default so one logo doesn't silently inflate every tool definition.

Neither `_meta` nor `icons` count toward `estimateToolTokens` — they are client chrome, not model-facing text.

## `x-mcp-header`

Every header-located input property is annotated with its original wire header name:

```typescript
tool.inputSchema.properties.headerTrace;
// { type: 'string', 'x-parameter-location': 'header', 'x-mcp-header': 'trace' }
```

This is always on. Conflict renames only change the input key, so `x-mcp-header` preserves the true header; security-derived header inputs (when `includeSecurityInInput` is set) carry it too (`Authorization`, or the API-key header name). All client targets preserve `x-` keywords, so the marker survives `target` transforms. Generic MCP-to-HTTP bridges can use it to route inputs into headers without consulting the mapper.

## Security elicitation descriptors

```typescript
import { deriveSecurityElicitations } from 'mcp-from-openapi';

const [request] = deriveSecurityElicitations(tool);
// {
//   scheme: 'bearerAuth',
//   message: 'Provide the bearer token for "bearerAuth".',
//   requestedSchema: {
//     type: 'object',
//     properties: { token: { type: 'string', title: 'Token', description: 'HTTP bearer authentication token (JWT).' } },
//     required: ['token'],
//   },
// }
```

`deriveSecurityElicitations(tool)` derives one MCP-elicitation-compatible `{ message, requestedSchema }` descriptor per distinct security scheme, from the mapper's security entries (falling back to `metadata.security`). Shapes per scheme type: basic/digest → `username` + `password`; bearer and other HTTP schemes → `token`; API key → `apiKey`; OAuth2/OIDC → `accessToken` (scopes in the description). Mutual-TLS and custom signature schemes are skipped — they have no elicitable string credential.

The requested schemas are flat string-property objects, as MCP elicitation requires. **Caveat:** the MCP spec advises servers not to elicit secrets over untrusted paths — this function gives you the shape; whether and where to ask is transport policy.

---

**Related:** [Configuration](./configuration.md) | [Annotations & Extensions](./annotations.md) | [Security](./security.md)
