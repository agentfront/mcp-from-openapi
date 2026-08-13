# Curation: budgets, overlays, trimming, lint

Model accuracy measurably degrades past ~30–40 tools, and raw tool definitions routinely cost ~1,000 tokens each. This example runs the full curation toolkit over a **real GitHub API subset** (78 operations, ~600k tokens raw) and produces a 20-tool curated slice at a fraction of the context bill.

## What it demonstrates

- `analyzeToolSet` — the context bill and curation warnings, before and after
- `lintDocument` — agent-readiness findings on a production spec (vague descriptions, unpaginated lists)
- `LoadOptions.overlays` — an OpenAPI Overlay 1.0 patch applied at load time, so hand-tuned descriptions survive spec regeneration instead of living in a fork
- Trimming (`stripExamples`, `maxDescriptionLength`, `maxProperties`, `maxSchemaDepth`) — the test asserts a >5× token reduction
- `includeTags` filtering — ship the slice the agent needs, not the phone book

## Run it

```bash
yarn build && yarn test:e2e
```

[example.e2e.ts](./example.e2e.ts) runs against the vendored real spec at [`e2e/fixtures/github-trimmed-3.0.json`](https://github.com/agentfront/mcp-from-openapi/blob/main/e2e/fixtures/github-trimmed-3.0.json) and asserts the overlay patch appears verbatim on the generated tool.

Related docs: [Curation](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/curation.md) · [Configuration](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/configuration.md)
