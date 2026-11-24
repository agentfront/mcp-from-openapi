# Maintaining OpenAPI Support

[Home](../README.md) | [OpenAPI Versions](./openapi-versions.md) | [Architecture](./architecture.md) | [Contributing](../CONTRIBUTING.md)

---

A runbook for maintainers: where the library's knowledge of OpenAPI versions lives, what to do when the OpenAPI Initiative (OAI) publishes something new, and which test proves what. [OpenAPI Versions](./openapi-versions.md) is the support matrix for users; this page is about keeping it true.

Everything below names a file or a command that exists in the tree. Commands use `corepack yarn` (the repository pins Yarn 4; a global Yarn 1 is not the right one).

## Where versions are represented

Everything that knows about OpenAPI versions is the **spec layer**, which is its own package: [`openapi-spec`](https://github.com/agentfront/openapi-spec), a dependency (`package.json`). Every module imports it as `'openapi-spec'`, and `src/index.ts` re-exports its public names, so users of this library see them as before. Its own runbook, [Maintaining OpenAPI Support in openapi-spec](https://github.com/agentfront/openapi-spec/blob/main/docs/maintaining-openapi-support.md), covers the types, the profiles, the schema-to-types parity story and the weekly spec watch. A change to the spec layer is made there, released, then the dependency moves here.

| What | Where (in `openapi-spec`) |
| ---- | ----- |
| The version a document declares, and what it means (`supported`, `newer-minor`, `unsupported`, `malformed`, `missing`) | `detectSpecVersion` |
| The known versions (`SpecFamily`, `SPEC_FAMILIES`, `LATEST_SPEC_FAMILY`) and what each allows (one `SpecProfile` per family in `SPEC_PROFILES`) | `src/versions.ts` |
| Which operations a document has | `resolveOperationLayout(detectSpecVersion(document))`, the one decision; the walker is `listOperations` / `getOperation` |
| Which version introduced each construct | `SPEC_FEATURES`, read by `featureNewerThanDeclared` for the `FEATURE_NEWER_THAN_DECLARED_VERSION` warning |
| The types of the documents we read | `OAS20`, `OAS30`, `OAS31`, `OAS32` and the cross-version unions (`OpenAPIDocument`, `OperationObject`, ...) |
| Diagnostic codes of the spec layer | `SPEC_DIAGNOSTIC_CODES`; the library-wide registry `DIAGNOSTIC_CODES` in this repository's `src/types.ts` extends it |

Three rules to keep in mind (the full statement is in [CLAUDE.md](../CLAUDE.md) and [OpenAPI Versions](./openapi-versions.md)):

- **The patch number never matters.** Rules are those of the declared `major.minor`.
- **Operation discovery follows the declared version; everything else follows features.** A construct the library understands is processed whatever version the document declares, except which operations are read (`query`, `additionalOperations`).
- **A newer 3.x minor is processed with the latest profile** and a `NEWER_OPENAPI_VERSION` warning. A version added in `openapi-spec` moves `LATEST_SPEC_FAMILY`, so the boundary of `newer-minor` moves with it.

### Swagger 2.0

The types (`OAS20`), the profile (`SPEC_PROFILES['2.0']`, see `isSwagger2`) and the converter to OpenAPI 3.0 (`upgradeSwagger2`) come from `openapi-spec`. This repository holds what the generator reads: the official 2.0 schema (`e2e/fixtures/oas/schemas/2.0`) and example documents (`e2e/fixtures/oas/documents/2.0`), our own documents (`e2e/fixtures/supplementary/2.0`), the equivalence API (`e2e/fixtures/supplementary/equivalence`) and a real description (`e2e/fixtures/netlify-trimmed-2.0.json`). How a 2.0 document moves through the generator, the validator and lint is described in [OpenAPI Versions](./openapi-versions.md); this page does not repeat it.

## The pinned sources

The stories validate documents against the official sources vendored under `e2e/fixtures/oas/` and pinned in `e2e/fixtures/oas/sources.json`: the OAI JSON Schemas, the JSON Schema meta-schemas they use, and OAI's test documents (`sources`: `{ id, version, kind, url, path, sha256 }`; `upstream`: the OAI branch and folders each commit came from). `openapi-spec` pins **the same sources**: keep the two manifests identical, so a document is held to the same schema in both repositories.

`scripts/sync-oas-sources.mjs` is the tool for them:

```bash
node scripts/sync-oas-sources.mjs            # offline: every file exists and matches its sha256; no unlisted file; the upstream table matches the entries
node scripts/sync-oas-sources.mjs --update   # download every url, write the bytes, rewrite the sha256 values (about 40 seconds)
node scripts/sync-oas-sources.mjs --latest   # read-only, needs network: what is NEWER upstream than what is pinned (exit 0 nothing, 3 something, 1 error)
```

Downloads are limited to `spec.openapis.org`, `json-schema.org` and `raw.githubusercontent.com`, never follow a redirect and stop at 5 MiB. The findings `--latest` reports, and the weekly spec watch that runs it and keeps one issue up to date, are documented and run in `openapi-spec`. This repository has no watch of its own.

## When the pins move (a new schema iteration, moved test documents)

The spec watch of `openapi-spec` reports it. Then:

1. In `openapi-spec`, follow its runbook: move the pin, run its parity and official-documents stories, and release.
2. Here, move `openapi-spec` to that release (`corepack yarn add openapi-spec@^<version>`), copy its `e2e/fixtures/oas/sources.json` over this one, and run `node scripts/sync-oas-sources.mjs --update`. Read `git diff e2e/fixtures/oas/`: that diff is the change in the specification you are about to absorb.
3. Run what it can break here: `corepack yarn test:e2e oas-sources official-documents swagger2 multi-file`. For new or changed test documents, update the counts (`VERSIONS`), the verdicts of FAIL documents (`VALIDATOR_VERDICTS`) and `KNOWN_GAPS` in `e2e/official-documents.e2e.ts`, and pin the tools of each PASS document in `e2e/expected/official-documents.json`, written from the document's operations under `paths`, not from what the library prints.
4. Update the date and "retrieved" columns in the tables of `e2e/fixtures/README.md`.

## Adding a new OpenAPI version (for example 3.3)

Work in this order; each step has a test that tells you what is missing.

1. **In `openapi-spec`**: pin the official schemas and test documents, add the types module, register the version (family, profile, features), extend its parity and official-documents stories, and release. Its runbook has each step.
2. **Move the dependency and the pins here**, as in [When the pins move](#when-the-pins-move-a-new-schema-iteration-moved-test-documents). Let the validation helper know the version: widen `OasVersion` in `e2e/helpers/oas-validate.ts`.
3. **Run the official documents and fix what they report.** In `e2e/official-documents.e2e.ts` add the version to `VERSIONS` (document counts) and `SUPPLEMENTARY_VERSIONS`, write the `VALIDATOR_VERDICTS` row of every FAIL document (does our validator reject it, and why), and pin the tools of every PASS document in `e2e/expected/official-documents.json` (`[name, method, path, readOnlyHint]`, written from the document's operations under `paths`). Run `corepack yarn test:e2e official-documents`. What does not hold yet goes in `KNOWN_GAPS` with the exact failure lines.
4. **Add supplementary documents** for the constructs the official documents leave out where a tool is built, in `e2e/fixtures/supplementary/3.3/{pass,invalid}/` (see [its README](../e2e/fixtures/supplementary/README.md#adding-a-document)): each `pass` document must validate against the official schema, each `invalid` one must be rejected by it, and tools, facts and diagnostics are pinned by hand in `e2e/expected/supplementary-documents.json`. Update the counts in `SUPPLEMENTARY_VERSIONS`.
5. **Implement the new semantics.** Everything a tool can show: operations (read through `listOperations` with the version's layout), parameters, bodies, responses, security, base URIs. A feature the library understands is processed whatever version the document declares, and the validator reports it for an older declared version through `featureNewerThanDeclared`. Anything skipped or ignored is a diagnostic registered in `DIAGNOSTIC_CODES`, never a silent drop. Unit tests with inline documents, wire tests in `e2e/wire-serialization.e2e.ts` where the request changes.
6. **Type tests.** Add the version to `e2e/types/shapes.types.ts`, `documents.types.ts` and the cases of `rejections.types.ts` that depend on the version; `corepack yarn typecheck` compiles them (see `e2e/types/README.md`).
7. **Public types.** `corepack yarn build && node scripts/diff-public-types.mjs`. A new namespace is only additions, but a change in a shared type (a cross-version union gains a member) is a difference: give it a cause with a reason in `scripts/public-types-allowlist.json` (`--update-allowlist`, then replace each `TODO: explain`).
8. **Docs.** `docs/openapi-versions.md` (the declared-versions table, the per-version validation table, the feature tables) and the version numbers named in `README.md` and `CLAUDE.md`.

Before the pull request: `corepack yarn typecheck`, `corepack yarn test:coverage`, `corepack yarn build && corepack yarn test:e2e`, `node scripts/diff-public-types.mjs`. Optionally the [real-world corpus](#the-local-real-world-corpus) over the specs that declare the new version.

## What each test layer proves

| Layer | Files | What it proves | Command |
| ----- | ----- | -------------- | ------- |
| Unit tests | `src/__tests__/*.spec.ts` (one per module: `validator`, `generator`, ...) | Behaviour of each module with inline documents; 100% statements, branches, functions and lines | `corepack yarn test:coverage` |
| Type checking | `e2e/tsconfig.json` (src, e2e, examples, type tests) | Jest with SWC strips types without checking them, so only this proves the types compile | `corepack yarn typecheck` |
| Type tests | `e2e/types/*.types.ts` | What a consumer sees: `documents`, `reads`, `methods`, `tools`, `extensions`, `fixtures` and `swagger2` (the `OAS20` types in one place) must compile; `rejections` must not (each `@ts-expect-error` has one reason to fail); `shapes` states required keys and field types as assertions. Compiled by `typecheck`, never run | `corepack yarn typecheck` |
| Pinned sources and the 2.0 schema | `e2e/oas-sources.e2e.ts`, `scripts/sync-oas-sources.mjs`, `e2e/helpers/oas-validate.ts` | The vendored files match their checksums, none is unlisted, the `upstream` table explains every commit; every Swagger 2.0 document the stories read validates against the official 2.0 schema except the ones meant not to (pinned verdicts); the validation helper checks something | `corepack yarn test:e2e oas-sources` |
| Official documents | `e2e/official-documents.e2e.ts`, `e2e/fixtures/oas/documents/`, `e2e/expected/official-documents.json` | Each OAI PASS document validates against the official schema, type-checks against our types, passes our validator, generates exactly the pinned tools and reports no diagnostic for something it could not process; each FAIL document is rejected by the schema, never crashes the pipeline and has a recorded validator verdict. `KNOWN_GAPS` is asserted to still fail, so it only shrinks | `corepack yarn test:e2e official-documents` |
| Supplementary documents | `e2e/fixtures/supplementary/<version>/{pass,invalid}/`, `e2e/expected/supplementary-documents.json` | The constructs the official documents leave out where a tool is built, held to the same five checks with no known gap allowed; tools, facts and diagnostics pinned by hand from the document and the specification | same story as above |
| Multi-file story | `e2e/multi-file.e2e.ts`, `e2e/fixtures/supplementary/multi-file/` | Relative `$ref`s are read against the retrieval URI for each way a document gets in (`fromFile` from any working directory, `fromURL` against a loopback server with every request recorded, `fromJSON` / `fromYAML` with `documentUri`), `$self` names the document without moving a read, nothing but 127.0.0.1 is contacted | `corepack yarn test:e2e multi-file` |
| Swagger 2.0 story | `e2e/swagger2.e2e.ts`, `e2e/fixtures/supplementary/equivalence/`, `e2e/fixtures/netlify-trimmed-2.0.json` | The conversion to OpenAPI 3.0 held to the specifications: the converted document of every 2.0 document we have (generator and `upgradeSwagger2` alike) is the same and validates against the official 3.0 schema; the Lending Library API written five times (2.0 in one and twelve files, 3.0, 3.1, 3.2) gives one tool contract; `dereference: false`, a missing `host`, `collectionFormat`, `consumes`/`produces`, `type: file`, OAuth2 flows, the states of `getDocument()`, `lint()` and an Arazzo workflow over a 2.0 source | `corepack yarn test:e2e swagger2` |
| Real specs and wire tests | `e2e/real-specs.e2e.ts`, `e2e/curation-journey.e2e.ts`, `e2e/wire-serialization.e2e.ts`, `e2e/mcp-server.e2e.ts`, `e2e/packaging.e2e.ts` | Vendored trims of real descriptions (literal tool counts pin drift on purpose), real loopback HTTP, the real MCP SDK, and the built `dist/` (the packaging story also checks the emitted declarations import nothing unexpected) | `corepack yarn build && corepack yarn test:e2e` |
| Public-type differential | `scripts/diff-public-types.mjs`, `scripts/public-types-allowlist.json`, CI job `public-types` | Every exported type is compared, both directions, with the baseline release; each difference must be allowlisted under a cause with a reason, and a stale entry fails too. The types re-exported from `openapi-spec` are named as when they were ours (`OWN_DEPENDENCIES`). Needs the network and a build | `corepack yarn build && node scripts/diff-public-types.mjs` |
| Real-world corpus (local) | `scripts/spec-corpus/` | A survey of 38 public documents through the built library. Not part of CI, nothing is committed, results are local | see below |

CI runs unit tests with coverage, `typecheck`, the e2e stories (the checksum verification among them) and the public-type job from `.github/workflows/push.yml`. The schema-to-types parity story runs in `openapi-spec`, with the types.

## The local real-world corpus

`scripts/spec-corpus/` downloads 38 real documents (15 declaring OpenAPI 3.2, 8 declaring 3.1, 10 declaring 3.0, 5 Swagger 2.0) into the git-ignored `.spec-corpus/` and runs each through the built library in its own process, writing `results.json` and `REPORT.md` there. It is a survey, not a gate: use it after a change to loading, validation or generation, or when adding a version, to see what real documents do that inline ones do not.

```bash
corepack yarn build
node scripts/spec-corpus/download.mjs               # about 160 MB; what is present and verified is skipped
node scripts/spec-corpus/run.mjs --version 3.1      # or no filter for all 38
```

**Run it only on specs you are willing to trust, or in a sandbox.** Every multi-file spec gets a `local-refs` attempt that sets `refResolution.allowedProtocols: ['file', 'http', 'https']`, so that the spec can read its sibling files. With `file` allowed a reference can name any file the process can read: a relative path (`../` is not confined to the spec's folder), an absolute path or a `file:` URL, and what is read becomes part of the document the library generates tools from. The first (`default`) attempt allows only `http` and `https`, so a spec with remote `$ref`s makes the library fetch them. A spec in `sources.json` is pinned and checksummed, which shows it is the document that was looked at, not that it is harmless; a spec you add or edit (`--no-verify`) has had no review at all. Use a container or a virtual machine with no credentials in it for anything you did not read.

`run.mjs` first checks each selected spec against the size, sha256 and (for a multi-file spec) tree digest in `sources.json` and skips one that does not match (`HASH MISMATCH`, exit 1; `--no-verify` overrides), and the operation counts are made by a pass that reads only the spec's own folder. [`scripts/spec-corpus/README.md`](../scripts/spec-corpus/README.md) has the flags, the cost, how to add a spec and the licence position (no spec is redistributed; `sources.json` records where each comes from and its licence as found).
