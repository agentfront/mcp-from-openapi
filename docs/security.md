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

A Security Requirement object lists schemes that must all be satisfied together (`{ a: [], b: [] }`). If it names a scheme `components.securitySchemes` does not define (a typo, or an OpenAPI 3.2 scheme named by URI, which is not resolved yet), the object cannot be satisfied and is **dropped as a whole**, including the schemes it names that do exist. Each missing scheme records one `UNRESOLVED_SECURITY_SCHEME` diagnostic (`generator.getDiagnostics()`). A requirement that is not an object records `INVALID_SECURITY_REQUIREMENT` and is dropped. The objects that remain still apply, and an empty object (`{}`, no authentication) is kept.

```yaml
security:
  - apiKey: []
    missing: [] # not defined: the whole object is dropped, `apiKey` with it
  - bearer: [] # kept: the tool's security is `bearer` alone
```

If every requirement of an operation is dropped, no way to authenticate is known, so the operation makes **no tool**: `generateTools()` leaves it out and records `UNSATISFIABLE_SECURITY`, and `generateTool()` throws a `GenerationError` (context `path`, `method`, `pointer`). A document-level `security` that cannot be satisfied therefore drops every operation that inherits it. The exception is a document that has `security` requirements but no `components.securitySchemes` at all: its tools are still generated, with empty security, and the validator's `NO_SECURITY_SCHEMES` warning applies.

Requirements listed as alternatives (`security: [{ a: [] }, { b: [] }]`) are not kept as a choice: every scheme of every requirement object that can be satisfied becomes a requirement of the tool. See [OpenAPI Versions](./openapi-versions.md#diagnostics).

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

Schemes with names containing `aws4`, `hmac`, `signature`, `hawk`, or `custom-signature` are automatically detected as signature-based.

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
