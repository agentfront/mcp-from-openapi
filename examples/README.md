# Examples

Runnable, tested examples — each folder pairs consumer-style code (`example.ts`, importing `mcp-from-openapi` exactly as your project would) with an e2e test (`example.e2e.ts`) that executes it against a real loopback HTTP server on every CI run. **If an example is in this folder, it works** — the suite fails otherwise.

Run them all:

```bash
yarn build && yarn test:e2e
```

| Example | Shows |
| ------- | ----- |
| [quickstart-mcp-server](https://github.com/agentfront/mcp-from-openapi/tree/main/examples/quickstart-mcp-server) | The flagship journey: OpenAPI spec → tools → a running MCP server on the official SDK, calls proxied to the API with resolved credentials |
| [http-requests](https://github.com/agentfront/mcp-from-openapi/tree/main/examples/http-requests) | The request pipeline without any framework: `buildHttpRequest` + `SecurityResolver` → `fetch`, with full OpenAPI parameter serialization |
| [secure-loading](https://github.com/agentfront/mcp-from-openapi/tree/main/examples/secure-loading) | Loading untrusted specs safely: `fromURL` with `secureDefaults`, SSRF blocking, and host allowlists |
| [curation](https://github.com/agentfront/mcp-from-openapi/tree/main/examples/curation) | Taming a big API: filtering, overlay patches, trimming, lint findings, and token-budget reports |
| [client-targets](https://github.com/agentfront/mcp-from-openapi/tree/main/examples/client-targets) | One spec, four schema dialects: `target: 'claude' \| 'openai' \| 'gemini' \| 'strict'` |
| [typed-tools](https://github.com/agentfront/mcp-from-openapi/tree/main/examples/typed-tools) | Code-execution surfaces: `dottedNaming` namespaces + `emitTypeSignatures` TypeScript contracts |
| [arazzo-workflow](https://github.com/agentfront/mcp-from-openapi/tree/main/examples/arazzo-workflow) | Multi-step workflows: an Arazzo document consolidated into one tool, executed step-by-step from its IR |

## Layout

```text
examples/<name>/
  README.md        # what it demonstrates and how it works
  example.ts       # the example — exported functions, consumer-style imports
  example.e2e.ts   # executes the example for real; runs in CI via `yarn test:e2e`
```

Examples receive their base URL and credentials as parameters, so the tests drive them against a local server — point them at a real API in your own code.
