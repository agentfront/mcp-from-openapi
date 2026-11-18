# Security

[Home](../README.md) | [Getting Started](./getting-started.md) | [SSRF Prevention](./ssrf-prevention.md)

---

## Overview

The `SecurityResolver` class handles OpenAPI security schemes and converts them to actual HTTP auth values. It works with any OpenAPI security scheme name -- your spec can call it `BearerAuth`, `JWT`, `MyCustomAuth`, etc. The resolver uses the scheme's **type** and **metadata**, not its name.

---

## How Security Flows Through the Library

1. **Generation**: OpenAPI security schemes become `SecurityParameterInfo` entries on mapper items
2. **Resolution**: `SecurityResolver.resolve()` maps a `SecurityContext` to actual headers/query/cookies
3. **Execution**: Your framework applies the resolved values to HTTP requests

```typescript
import { OpenAPIToolGenerator, SecurityResolver, createSecurityContext } from 'mcp-from-openapi';

// 1. Generate tools
const generator = await OpenAPIToolGenerator.fromJSON(spec);
const tools = await generator.generateTools();

// 2. Resolve security for a tool
const resolver = new SecurityResolver();
const context = createSecurityContext({
  jwt: 'eyJhbGciOiJIUzI1NiIs...',
  apiKey: 'sk-abc123',
});

const resolved = await resolver.resolve(tools[0].mapper, context);

// 3. Apply to HTTP request
const response = await fetch(url, {
  headers: { ...resolved.headers },
  // resolved.query, resolved.cookies also available
});
```

### Requirements that name an undefined scheme

A Security Requirement object lists schemes that must all be satisfied together (`{ a: [], b: [] }`). If it names a scheme `components.securitySchemes` does not define (for a Swagger 2.0 document, whose `securityDefinitions` become `components.securitySchemes` in the conversion, one that `securityDefinitions` does not define or the conversion could not convert, such as an `oauth2` with an unknown `flow`: `SWAGGER_UNSUPPORTED_SECURITY_SCHEME`) (a typo, or a scheme named by URI that is not one of this document's, see [below](#schemes-named-by-uri-openapi-32)), the object cannot be satisfied and is **dropped as a whole**, including the schemes it names that do exist. Each missing scheme records one `UNRESOLVED_SECURITY_SCHEME` diagnostic (`generator.getDiagnostics()`). A requirement that is not an object records `INVALID_SECURITY_REQUIREMENT` and is dropped. The objects that remain still apply, and an empty object (`{}`, no authentication) is kept.

```yaml
security:
  - apiKey: []
    missing: [] # not defined: the whole object is dropped, `apiKey` with it
  - bearer: [] # kept: the tool's security is `bearer` alone
```

If every requirement of an operation is dropped, no way to authenticate is known, so the operation makes **no tool**: `generateTools()` leaves it out and records `UNSATISFIABLE_SECURITY`, and `generateTool()` throws a `GenerationError` (context `path`, `method`, `pointer`). A document-level `security` that cannot be satisfied therefore drops every operation that inherits it. The exception is a document that has `security` requirements but defines no schemes at all (no `components.securitySchemes`; for Swagger 2.0, no `securityDefinitions`): its tools are still generated, with empty security, and the validator's `NO_SECURITY_SCHEMES` warning applies. A defined map counts as schemes even when it is empty, or when none of its entries could be converted: a Swagger 2.0 document with `securityDefinitions` always converts to a `components.securitySchemes` (`{}` when nothing converted), so an operation that requires a scheme the conversion could not make (an unknown `type`, or an `oauth2` with an unknown `flow`: `SWAGGER_UNSUPPORTED_SECURITY_SCHEME`) is skipped with `UNSATISFIABLE_SECURITY`, whether or not other schemes exist. An operation that lists another requirement naming a scheme that did convert (`security: [{ weird: [] }, { key: [] }]`) is still generated, with that requirement alone.

A scheme the library cannot send drops the requirements that name it the same way, with an `UNSUPPORTED_SECURITY_SCHEME` diagnostic: a `type` that is none of `apiKey`, `http`, `oauth2`, `openIdConnect`, `mutualTLS` (compared exactly: `HTTP` is not `http`), or an `apiKey` scheme whose `in` is none of `query`, `header`, `cookie` or that has no `name`. Its key is never sent in a place the scheme does not name. `validate()` reports such a scheme as an `INVALID_SECURITY_SCHEME` error, with the values of the declared version (Swagger 2.0: `basic`, `apiKey`, `oauth2`, an `apiKey` in `header` or `query`; `mutualTLS` from OpenAPI 3.1). A `mutualTLS` scheme keeps its tool: the HTTP client presents the certificate (`clientCertificate`), so the tool has no input for it, and an `info` diagnostic says so.

Requirements listed as alternatives (`security: [{ a: [] }, { b: [] }]`) are not kept as a choice: every scheme of every requirement object that can be satisfied becomes a requirement of the tool. See [OpenAPI Versions](./openapi-versions.md#diagnostics).

### Schemes named by URI (OpenAPI 3.2)

In a document declaring 3.2 or newer, a key of a Security Requirement may be the URI of a Security Scheme Object instead of a component name. The library resolves a URI that names a scheme of this same document:

```yaml
openapi: 3.2.0
components:
  securitySchemes:
    ApiKey:
      type: apiKey
      in: header
      name: X-Key
security:
  - "#/components/securitySchemes/ApiKey": []
```

The tool's `metadata.security` holds the scheme under its component name (`scheme: 'ApiKey'`, `type: 'apiKey'`, `in: 'header'`, `name: 'X-Key'`), the same as if the requirement had said `ApiKey: []`. The rules:

- **A component name wins.** A key that is the name of a component is always that component, even when it looks like a URI. Only another key is read as a URI.
- **A key with `:`, `/` or `#` is a URI reference.** It resolves against the document's URIs (the URL or file it was loaded from or `documentUri`, and `$self`: see [SSRF Prevention](./ssrf-prevention.md#base-uris-and-relative-references)) and names a scheme of this document when it is the document's own URI, by either of them, with the fragment `/components/securitySchemes/<name>`. The fragment is percent-decoded and read as a JSON Pointer, so `#/components/securitySchemes/my~1key` names the scheme `my/key`. A fragment-only key (`#/components/securitySchemes/ApiKey`) works with or without a URI; any other form needs one.
- **Another document's scheme is not read.** `https://other.example/openapi.json#/components/securitySchemes/ApiKey` names a scheme in a document the library does not fetch for security: nothing is requested, the object is dropped, and `UNRESOLVED_SECURITY_SCHEME` says `names a scheme in another document, which is not read` (the URL it resolved to is not quoted: it can be a local path).
- **`./foo` is never the component `foo`.** It is a reference to the document `foo` next to this one, so it is dropped even when a component `foo` exists. Write `foo`, or `#/components/securitySchemes/foo`.
- **The URI and the name can both appear.** In one requirement object they count as one scheme, with the scopes of both.
- **In a 3.0 or 3.1 document there are no URI keys.** The key is an undefined name; the diagnostic adds `(a scheme named by URI needs OpenAPI 3.2 or later)`.
- **Anything else is reported with its reason**: a URI whose fragment is not under `/components/securitySchemes`, one that is not valid percent-encoding, or a relative reference in a document with no base URI (the message says to load it with `fromURL` or `fromFile`, or to pass `documentUri`).

---

## Supported Auth Types

### Bearer / JWT

```typescript
const context = createSecurityContext({
  jwt: 'eyJhbGciOiJIUzI1NiIs...',
});
// Produces: { headers: { Authorization: "Bearer eyJhbGci..." } }
```

Works with any HTTP bearer scheme, regardless of the OpenAPI scheme name.

### Basic Auth

```typescript
const context = createSecurityContext({
  basic: btoa('username:password'), // Base64 encoded
});
// Produces: { headers: { Authorization: "Basic dXNlcm5hbWU6cGFzc3dvcmQ=" } }
```

### Digest Auth

```typescript
const context = createSecurityContext({
  digest: {
    username: 'user',
    password: 'pass',
    realm: 'example.com',
    nonce: 'abc123',
    uri: '/api/data',
    qop: 'auth',
    nc: '00000001',
    cnonce: 'xyz789',
    response: 'computed-hash',
    opaque: 'opaque-value',
  },
});
// Produces: { headers: { Authorization: "Digest username=\"user\", realm=\"example.com\", ..." } }
```

### API Key (Single)

The single `apiKey` is used only for a tool with one `apiKey` scheme. With several, each needs its own entry in `apiKeys` (below): one key is never sent in another scheme's place, such as a header key in a URL.

```typescript
const context = createSecurityContext({
  apiKey: 'sk-abc123',
});
// Depending on the scheme's "in" field:
// header: { headers: { "X-API-Key": "sk-abc123" } }
// query:  { query: { "api_key": "sk-abc123" } }
// cookie: { cookies: { "api_key": "sk-abc123" } }
```

### Multiple API Keys

When your API requires different keys for different purposes:

```typescript
const context = createSecurityContext({
  apiKeys: {
    'X-API-Key': 'key-for-auth',
    'X-Client-Id': 'client-123',
  },
});
```

Named API keys are matched by the scheme's `apiKeyName` from the OpenAPI spec.

### OAuth2 / OpenID Connect

```typescript
const context = createSecurityContext({
  oauth2Token: 'access-token-here',
});
// Produces: { headers: { Authorization: "Bearer access-token-here" } }
```

### Mutual TLS (mTLS)

```typescript
const context = createSecurityContext({
  clientCertificate: {
    cert: '-----BEGIN CERTIFICATE-----\n...',
    key: '-----BEGIN PRIVATE KEY-----\n...',
    passphrase: 'optional-passphrase',
    ca: '-----BEGIN CERTIFICATE-----\n...',
  },
});
// resolved.clientCertificate is set for your HTTP client to use
```

### Custom Headers

For proprietary auth schemes:

```typescript
const context = createSecurityContext({
  customHeaders: {
    'X-Custom-Auth': 'custom-value',
    'X-Tenant-Id': 'tenant-123',
  },
});
```

---

## Custom Resolver

For framework-specific auth (e.g., pulling tokens from a session store):

```typescript
const context = createSecurityContext({
  customResolver: async (security) => {
    if (security.type === 'http' && security.httpScheme === 'bearer') {
      return await mySessionStore.getToken();
    }
    if (security.type === 'apiKey') {
      return await myVault.getSecret(security.apiKeyName);
    }
    return undefined; // Fall through to default resolution
  },
});
```

The custom resolver is tried **first** for every security parameter. Return `undefined` to fall through to built-in resolution.

---

## Signature-Based Auth

For HMAC, AWS Signature V4, and other signature-based schemes:

```typescript
const context = createSecurityContext({
  signatureGenerator: async (data, security) => {
    // data: { method, url, headers, body, timestamp }
    // security: SecurityParameterInfo
    const signature = await computeHMAC(data, mySecret);
    return signature;
  },
});

const resolved = await resolver.resolve(tool.mapper, context);

if (resolved.requiresSignature) {
  const signedHeaders = await resolver.signRequest(
    tool.mapper,
    {
      method: 'GET',
      url: 'https://api.example.com/data',
      headers: resolved.headers,
    },
    context,
  );
  // Use signedHeaders in your request
}
```

An `http` scheme whose name contains `aws4`, `hmac`, `signature`, `hawk`, or `custom-signature` is detected as signature-based. Another type is not, whatever its name: an `apiKey` scheme named `TomahawkKey` is filled like any API key. `checkMissingSecurity` reports a signature-based scheme as missing when the context has no `signatureGenerator`.

`apiKeys` and `customHeaders` are read by own keys only (a scheme named `constructor` finds nothing), and `resolve()` throws a `RequestBuildError` for a header or cookie value that cannot be sent, as `buildHttpRequest` does (a token holding a line break). Spread `resolved.headers` after your other headers, so none of them replaces a credential.

---

## Checking Missing Auth

Validate that all required security is available before making requests:

```typescript
const missing = await resolver.checkMissingSecurity(tool.mapper, context);

if (missing.length > 0) {
  console.error('Missing security schemes:', missing);
  // e.g., ["BearerAuth", "ApiKeyAuth"]
}
```

---

## includeSecurityInInput

By default, security parameters only appear in the mapper (with a `security` field). Set `includeSecurityInInput: true` to also add them to the `inputSchema`:

```typescript
const tools = await generator.generateTools({
  includeSecurityInInput: true,
});

// Now inputSchema includes security params:
// { properties: { BearerAuth: { type: "string", description: "Bearer authentication token" } } }
```

This is useful when callers provide auth values directly (e.g., in testing or when the framework doesn't manage auth).

---

## Identifying Security Mappers

Security mapper entries have a `security` field:

```typescript
for (const m of tool.mapper) {
  if (m.security) {
    console.log(`Auth: ${m.security.scheme} (${m.security.type})`);
    console.log(`  Header: ${m.key}`);
    console.log(`  HTTP scheme: ${m.security.httpScheme}`);
  }
}
```

---

**Related:** [SSRF Prevention](./ssrf-prevention.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)
