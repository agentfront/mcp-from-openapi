# Arazzo workflows: many API calls, one tool

Instead of exposing `createOrder` and `getOrderStatus` as separate tools and hoping the model chains them correctly, an [Arazzo 1.0](https://spec.openapis.org/arazzo/v1.0.0.html) workflow declares the chain — and `fromArazzo()` consolidates it into **one** MCP tool. The workflow's inputs become the tool's input schema; a pure, serializable IR on `metadata.workflow` carries the step sequence with each operation's schemas and request mapper embedded.

## What it demonstrates

- `fromArazzo(document, { sources })` — sources are supplied as documents, never fetched
- The IR contract: `$inputs.sku`, `$steps.place.outputs.orderId`, and `$response.body#/id` as parsed ASTs; each step's `operation.mapper` feeding `buildHttpRequest` directly (no second spec pass)
- A compact executor (~70 lines) driving the IR over live HTTP — the test asserts step 2's URL was built from step 1's response
- The library/runtime split: the library emits the IR and never executes; the executor here is *your* side of the contract (frameworks like FrontMCP ship their own)

## Run it

```bash
yarn build && yarn test:e2e
```

Related docs: [Arazzo Workflows](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/arazzo.md) · [Request Builder](https://github.com/agentfront/mcp-from-openapi/blob/main/docs/request-builder.md)
