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

`sources` maps every source description **name** to a resolved OpenAPI document or a pre-built `OpenAPIToolGenerator`. URLs in `sourceDescriptions` are **never fetched** — supplying documents keeps loading under the caller's control (and its SSRF posture). A source used by any step must be supplied; unknown keys are rejected; `type: 'arazzo'` sources cannot be used by steps. Step operations resolve by `operationId` (searched across all supplied sources; ambiguity is an error — pin with `$sourceDescriptions.<name>.<operationId>`) or by `operationPath` (`{$sourceDescriptions.pets.url}#/paths/~1pets~1{petId}/get`). Both reach the operations the source's declared version defines, the same ones `generateTools()` turns into tools: in a source declaring 3.2 or newer that includes the `query` operation and `additionalOperations`, while a 3.0 or 3.1 source has only the eight classic methods and a Swagger 2.0 source the seven of its Path Item (no `trace`) (a step naming `query` or an additional operation in a 3.0 or 3.1 source, or `trace` in a 2.0 source, is an `ArazzoError`, and an `operationId` declared under one is not found). A Swagger 2.0 source works like any other: each step's tool is built from the source's OpenAPI 3.0 conversion, as `generateTool` builds it, so its `operation.servers`, `mapper` and schemas are those of the converted document. An `operationPath` for an additional operation points through the map, `{$sourceDescriptions.pets.url}#/paths/~1pets~1{petId}/additionalOperations/LINK`. The key is matched exactly as written (`additionalOperations/link` does not find `LINK`) and must be an HTTP method token with no fixed field: `GET`, `post` and `CONNECT` there are an `ArazzoError`. A standard method in a fixed-field pointer matches in any case (`#/paths/~1pets/QUERY`). The fragment is a JSON Pointer in a URI reference, so it is percent-decoded first (`%7BpetId%7D` is `{petId}`, `%4CINK` is `LINK`); a `%` that does not start a valid escape stays as written.

**Relative references and `documentUri`.** A raw document in `sources` has no location, so a relative `$ref` in it resolves against the process working directory and, under the default options, is refused (the `ArazzoError` carries the dereference message: `Cannot read $ref "./schemas/pet.json" resolved against "..." ... it is read as a local file`). The exception is a raw OpenAPI 3.2 source whose `$self` is an absolute `http` or `https` URI: with no retrieval URI, that `$self` is the base its relative references are read against, so `./schemas/pet.json` becomes a URL on the `$self`'s host and is fetched, not refused as a local file. It still has to pass the reference-resolution rules, which for a raw source are the defaults (`http` and `https` allowed, internal addresses and the `file` protocol blocked). `fromArazzo`'s `loadOptions` takes only `dereference`, `validate`, `baseUrl` and `overlays` (`Pick<LoadOptions, ...>`), so `secureDefaults` and `refResolution` (`allowedProtocols`, `allowedHosts`, `blockedHosts`, `allowInternalIPs`) are not set there: build the source yourself with `OpenAPIToolGenerator.fromJSON(document, { secureDefaults: true })` (or `fromYAML`, `fromURL`, `fromFile`) and pass the generator in `sources`, as in the example below. The raw sources share one set of `loadOptions`, and a URI names one document, so `loadOptions.documentUri` is rejected with an `ArazzoError` (`loadOptions.documentUri would give every source the same URI; load a source with its own documentUri (OpenAPIToolGenerator.fromJSON(document, { documentUri })) and pass the generator in options.sources`, with `path` `''`). Load a source that needs a location yourself, with `OpenAPIToolGenerator.fromJSON(document, { documentUri })` (or `fromFile` or `fromURL`), and pass the generator in `sources`: its relative references and its references to its own URI then resolve as they do for any generator.

```typescript
import { OpenAPIToolGenerator, fromArazzo } from 'mcp-from-openapi';

// A 3.2 source with `$self: 'https://api.example.com/openapi.json'` and a relative
// `$ref: './schemas/pet.json'`. With `secureDefaults: true` no request is made and the
// reference stays as written in the step's schema; with the default options the schema is
// fetched from the `$self` host (`refResolution: { allowInternalIPs: true }` for a local server).
const pets = await OpenAPIToolGenerator.fromJSON(petstoreDocument, { secureDefaults: true });
const tools = await fromArazzo(arazzoDocument, { sources: { pets } });
```

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

A step's `method` is the `metadata.method` of its operation: the lowercase field name (`'get'`, `'query'`) or, for an additional operation, the key as written in the document (`'LINK'`). Each operation step embeds the resolved operation's essentials — its `mapper` feeds [`buildHttpRequest`](./request-builder.md) directly. Nested workflow invocations appear as `{ kind: 'workflow', workflowId }` steps (recursion is rejected). `successCriteria` conditions are carried **raw** and never evaluated; `onSuccess`/`onFailure` actions (`end`/`goto`/`retry` with `retryAfter`/`retryLimit`) are captured faithfully. Request bodies keep the verbatim `payload` plus a pointer-keyed `payloadExpressions` substitution list (RFC 6901) and parsed `replacements`.

**Placeholders:** a workflow tool's `metadata.path` is `arazzo:<workflowId>` and `method` is `'post'` — never feed the workflow tool itself to `buildHttpRequest`; its top-level `mapper` is `[]` by design. Executors drive each step's `operation.mapper`.

**Treat the IR as immutable:** steps referencing the same operation share embedded schema/mapper structure in memory (JSON serialization is unaffected). Documents are normalized through a JSON round-trip on input — YAML anchors expand into distinct nodes, YAML-only scalars become their JSON forms, and cyclic or absurdly deep documents are rejected with `ArazzoError`. Cross-document `dependsOn` entries (`$sourceDescriptions.<name>.<workflowId>`) are accepted and carried verbatim; cross-document *step* invocations are not supported. One documented strictness deviation: `workflowId`/`stepId` must match `[A-Za-z0-9_-]+` (a SHOULD in the spec, enforced here so `$steps.<id>` references stay parseable).

## Runtime expressions

Every Arazzo runtime expression is parsed into a serializable AST (`{ type, raw, path, source?, name?, pointer? }`) — `$inputs.x`, `$steps.id.outputs.y`, `$response.body#/json/pointer`, `$request.header.Name`, `$message.body`, `$statusCode`, `$url`, `$method`, `$workflows.*`, `$sourceDescriptions.*`, `$components.*`. Strings with embedded `{$...}` become templates; strings whose `$` prefix matches no known root (like `"$50"` or `"$request-id"`) stay literals. The parser is exported standalone:

```typescript
import { parseRuntimeExpression } from 'mcp-from-openapi';
parseRuntimeExpression('$steps.fetch.outputs.pet');
// { type: 'steps', raw: '...', path: ['fetch', 'outputs', 'pet'] }
```

## Output schema derivation

Workflow `outputs` derive the tool's output schema best-effort: `$statusCode` → `number`; `$url` / `$method` / header refs → `string`; `$inputs.<name>` → that input's schema; `$steps.<id>.outputs.<name>` is chased (depth-capped) into the step's `$response.body` schema, following `#/pointers` through `properties`/`items`. Anything unresolvable degrades to an unconstrained schema. Every derived property keeps the raw expression in its `description` (`Arazzo output: $steps.fetch.outputs.pet`), and outputs are never `required` — they exist only after successful execution.

## Options

`ArazzoGenerateOptions` is the schema-shaping subset of [`GenerateOptions`](./configuration.md): `target`, `maxSchemaDepth`, `maxSchemaNodes`, `maxProperties`, `maxDescriptionLength`, `stripExamples`, `includeExamples`, `resolveFormats`/`formatResolvers`, `preferredStatusCodes`, `includeAllResponses`, `maxToolNameLength`, `includeSecurityInInput`, and `emitTypeSignatures`. They apply to the per-step embedded schemas AND the consolidated workflow schemas, in the same order as `generateTool` (formats → depth truncation → trims → client target). A workflow's input or output schema over `maxSchemaNodes` at `maxSchemaDepth` is cut at the deepest depth that fits, as `generateTool` cuts an operation's (an output that returns an input is derived from the inputs converted at each depth tried); only when not even depth 1 fits does the workflow fail with an `ArazzoError` (`Failed to build workflow "getPetFlow": its input schema exceeds the node budget of 40 (maxSchemaNodes) even cut at depth 1 ...`).

`fromArazzo` returns only the tools, so `onDiagnostic(diagnostic, source?)` receives its findings once every tool is made (never when it throws): a workflow schema cut shallower (`SCHEMA_DEPTH_REDUCED`, `path` `/workflows/0/inputs` or `/workflows/0/outputs`, no `source`), then the diagnostics of each generator `fromArazzo` created for a raw document in `sources` (`source` is its name, `path` points into that document), a step's tool cut shallower among them. A generator you pass in `sources` keeps its findings in its own `getDiagnostics()`.

```typescript
const tools = await fromArazzo(doc, {
  sources: { pets: petstoreDoc },
  onDiagnostic: (diagnostic, source) => console.warn(source ?? 'arazzo', diagnostic.code, diagnostic.message),
});
```

Operation-filtering options have no meaning here and are not accepted.

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
