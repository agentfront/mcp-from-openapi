# Arazzo Workflows

[Home](../README.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)

---

Tool consolidation is the ecosystem's consensus answer to context bloat, and [Arazzo 1.0](https://spec.openapis.org/arazzo/v1.0.0.html) is its standards-track format: a document describing multi-step workflows over one or more OpenAPI APIs. `fromArazzo()` turns each workflow into **one** consolidated MCP tool — workflow inputs become the tool's input schema, workflow outputs derive its output schema, and a pure, JSON-serializable IR carries the step sequence. The library never fetches source URLs, performs HTTP, or evaluates expressions — an executor (e.g. a framework like FrontMCP) drives the IR.

## Quick start

```typescript
import { fromArazzo } from 'mcp-from-openapi';

const tools = await fromArazzo(arazzoYamlOrObject, {
  sources: { pets: petstoreDocument, orders: ordersGenerator }, // name → document or generator
  generateOptions: { target: 'claude', emitTypeSignatures: true },
});
// one McpOpenAPITool per workflow, in document order
```

## Sources

`sources` maps every source description **name** to a resolved OpenAPI document or a pre-built `OpenAPIToolGenerator`. URLs in `sourceDescriptions` are **never fetched** — supplying documents keeps loading under the caller's control (and its SSRF posture). A source used by any step must be supplied; unknown keys are rejected; `type: 'arazzo'` sources cannot be used by steps. Step operations resolve by `operationId` (searched across all supplied sources; ambiguity is an error — pin with `$sourceDescriptions.<name>.<operationId>`) or by `operationPath` (`{$sourceDescriptions.pets.url}#/paths/~1pets~1{petId}/get`).

## The workflow IR

The tool's `metadata.workflow` is the complete, self-contained execution plan:

```typescript
const ir = tool.metadata.workflow!;
ir.steps[0];
// {
//   kind: 'operation', stepId: 'fetch', source: 'pets',
//   path: '/pets/{petId}', method: 'get', operationId: 'getPet',
//   parameters: [{ name: 'petId', in: 'path', value: { kind: 'expression', expression: {...} } }],
//   operation: { inputSchema, outputSchema, mapper, security, servers },  // no second spec pass needed
//   outputs: { pet: { type: 'response', source: 'body', raw: '$response.body', ... } },
// }
```

Each operation step embeds the resolved operation's essentials — its `mapper` feeds [`buildHttpRequest`](./request-builder.md) directly. Nested workflow invocations appear as `{ kind: 'workflow', workflowId }` steps (recursion is rejected). `successCriteria` conditions are carried **raw** and never evaluated; `onSuccess`/`onFailure` actions (`end`/`goto`/`retry` with `retryAfter`/`retryLimit`) are captured faithfully. Request bodies keep the verbatim `payload` plus a pointer-keyed `payloadExpressions` substitution list (RFC 6901) and parsed `replacements`.

**Placeholders:** a workflow tool's `metadata.path` is `arazzo:<workflowId>` and `method` is `'post'` — never feed the workflow tool itself to `buildHttpRequest`; its top-level `mapper` is `[]` by design. Executors drive each step's `operation.mapper`.

## Runtime expressions

Every Arazzo runtime expression is parsed into a serializable AST (`{ type, raw, path, source?, name?, pointer? }`) — `$inputs.x`, `$steps.id.outputs.y`, `$response.body#/json/pointer`, `$request.header.Name`, `$statusCode`, `$url`, `$method`, `$workflows.*`, `$sourceDescriptions.*`, `$components.*`. Strings with embedded `{$...}` become templates; strings whose `$` prefix matches no known root (like `"$50"`) stay literals. The parser is exported standalone:

```typescript
import { parseRuntimeExpression } from 'mcp-from-openapi';
parseRuntimeExpression('$steps.fetch.outputs.pet');
// { type: 'steps', raw: '...', path: ['fetch', 'outputs', 'pet'] }
```

## Output schema derivation

Workflow `outputs` derive the tool's output schema best-effort: `$statusCode` → `number`; `$url` / `$method` / header refs → `string`; `$inputs.<name>` → that input's schema; `$steps.<id>.outputs.<name>` is chased (depth-capped) into the step's `$response.body` schema, following `#/pointers` through `properties`/`items`. Anything unresolvable degrades to an unconstrained schema. Every derived property keeps the raw expression in its `description` (`Arazzo output: $steps.fetch.outputs.pet`), and outputs are never `required` — they exist only after successful execution.

## Options

`ArazzoGenerateOptions` is the schema-shaping subset of [`GenerateOptions`](./configuration.md): `target`, `maxSchemaDepth`, `maxProperties`, `maxDescriptionLength`, `stripExamples`, `includeExamples`, `resolveFormats`/`formatResolvers`, `preferredStatusCodes`, `includeAllResponses`, `maxToolNameLength`, `includeSecurityInInput`, and `emitTypeSignatures`. They apply to the per-step embedded schemas AND the consolidated workflow schemas, in the same order as `generateTool` (formats → depth truncation → trims → client target). Operation-filtering options have no meaning here and are not accepted.

## Errors

Every failure throws `ArazzoError` with a JSON-Pointer `path` into the Arazzo document:

```typescript
try {
  await fromArazzo(doc, { sources });
} catch (error) {
  if (error instanceof ArazzoError) {
    console.error(error.message, error.path); // e.g. '/workflows/0/steps/2'
  }
}
```

Structural violations (missing ids, duplicate names, malformed criteria/actions), unresolvable references (`$components.*`, unknown operationIds, missing sources), cyclic `dependsOn` chains, and recursive workflow invocations are all rejected at parse time.

---

**Related:** [Request Builder](./request-builder.md) | [Type Signatures](./type-signatures.md) | [Configuration](./configuration.md)
