# Client compatibility targets

Every provider accepts a different JSON Schema subset: Claude rejects top-level `oneOf`/`allOf`/`anyOf`, Gemini rejects `$ref`/`$defs` and most `format` values, OpenAI's strict mode requires closed objects with every property required. `target` emits the right dialect per connection — the clearest unserved gap in the OSS ecosystem when this library shipped it.

## What it demonstrates

- `generateTools({ target })` for `'claude' | 'openai' | 'gemini' | 'strict'` from one spec
- The test asserts each dialect's signature rule on the emitted schemas: collapsed root unions (Claude), zero `$ref` + demoted formats (Gemini), `additionalProperties: false` + all-required (OpenAI strict)
- Tool identity is dialect-independent — same names and operations everywhere

## Run it

```bash
yarn build && yarn test:e2e
```

The composable transforms behind each target (`inlineLocalRefs`, `collapseRootCompositions`, `enforceClosedObjects`, ...) are exported standalone too.

Related docs: [Client Targets](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/client-targets.md) · [Response Schemas](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/response-schemas.md)
