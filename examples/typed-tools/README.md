# Typed tools for code-execution surfaces

Code-mode runtimes present an API as importable, typed functions the model calls from generated code — instead of pushing every tool's JSON into context (Anthropic measured ~98.7% token reduction for this pattern). This example builds that surface: namespaced names plus TypeScript call contracts.

## What it demonstrates

- `dottedNaming()` — two-segment `namespace.method` names (`billing.listInvoices`) that code sandboxes bind as `await billing.listInvoices({...})`; reserved sandbox globals are automatically suffixed
- `emitTypeSignatures` — `metadata.typescript = { signature, declaration }` computed on the final schemas: one-line signatures for compact listings, self-contained declarations with JSDoc for the full typed surface
- The output is *proven* TypeScript: the test compiles the concatenated declarations with the real compiler and asserts zero diagnostics

## Run it

```bash
yarn build && yarn test:e2e
```

Related docs: [Type Signatures](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/type-signatures.md) · [Naming Strategies](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/naming-strategies.md)
