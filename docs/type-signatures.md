# TypeScript Call Signatures

[Home](../README.md) | [Configuration](./configuration.md) | [API Reference](./api-reference.md)

---

Code-execution surfaces (like FrontMCP CodeCall) present tools to the model as importable, typed functions instead of raw tool JSON — Anthropic measured a ~98.7% token reduction for this pattern. The library can render each tool's call contract as TypeScript text, computed from the **final** schemas (after format resolution, depth truncation, trimming, and client-target transforms), so the emitted types match exactly what the tool accepts and returns.

## Emitting signatures

```typescript
const tools = await generator.generateTools({ emitTypeSignatures: true });

tools[0].metadata.typescript?.signature;
// "(input: { id: string; limit?: number }) => Promise<{ name: string }>"

tools[0].metadata.typescript?.declaration;
// /** Get a user */
// interface GetUserInput {
//   /** @format uuid */
//   id: string;
//   limit?: number;
// }
//
// interface GetUserOutput {
//   name: string;
// }
//
// declare function getUser(input: GetUserInput): Promise<GetUserOutput>;
```

`signature` is a one-line arrow type with inline anonymous types — suitable for compact tool listings. `declaration` is a self-contained block: JSDoc from the tool description and schema `description`/`format`/`default`/`deprecated` fields, named `<ToolName>Input` / `<ToolName>Output` types (PascalCase from the tool name), and a `declare function` using the camelCase form of the name. Both are deterministic: the same tool always renders the same text.

When collision dedup renames a tool during `generateTools()`, the declaration is recomputed with the final name, so the type names never drift from `tool.name`.

## The unwrapped-return contract

The emitted return type is always the **unwrapped OpenAPI response type**. Frameworks that wrap tool results (for example FrontMCP's `{ status, ok, data, error }` envelope) apply that wrapper *after* this library — they must wrap the emitted type themselves. This keeps the library's output framework-neutral.

## Standalone usage

The printer is exported for use outside generation:

```typescript
import { emitToolTypeScript, toPascalIdentifier } from 'mcp-from-openapi';

const { signature, declaration } = emitToolTypeScript(
  'users.get',            // tool name → UsersGetInput / UsersGetOutput / usersGet
  'Fetch a user.',        // optional description → leading JSDoc
  tool.inputSchema,
  tool.outputSchema,
  { maxDepth: 8 },        // optional; default 8 (generation passes maxSchemaDepth here)
);

toPascalIdentifier('3d.scan'); // "T3dScan"
```

## Printing rules

| Schema construct | TypeScript |
| ---------------- | ---------- |
| `string` / `boolean` / `null` | `string` / `boolean` / `null` |
| `number` / `integer` | `number` (`format` becomes a JSDoc `@format` hint) |
| `enum` | literal union (`"a" \| "b" \| 1`) |
| primitive `const` | literal type |
| `nullable` wrapper (`anyOf: [X, {type:'null'}]`) | `X \| null` |
| `oneOf` / `anyOf` | union; root output status variants gain `/** status 200 (application/json) */` comments from `x-status-code` / `x-content-type` |
| `allOf` | intersection (`A & B`) |
| `array` + `items` | `T[]`; `prefixItems` become tuples (`[string, ...number[]]`) |
| object with `properties` | object type; optionality from `required`; non-identifier keys quoted |
| bare object | `Record<string, unknown>` (`Record<string, never>` when `additionalProperties: false`) |
| typed `additionalProperties` / `patternProperties` | `Record<string, T>` (intersected when properties also exist) |
| boolean schemas | `true` → `unknown`, `false` → `never` |
| `$ref` leftovers | `unknown` (declarations are always self-contained) |
| cycles / nesting beyond `maxDepth` | `unknown` (during generation the printer depth follows `maxSchemaDepth`, so it never collapses levels the schema still carries; standalone default 8) |

All `x-` annotation keywords (`x-parameter-location`, `x-status-code`, `x-mcp-header`, …) are ignored for typing.

---

**Related:** [Configuration](./configuration.md) | [Curation](./curation.md) | [Client Targets](./client-targets.md)
