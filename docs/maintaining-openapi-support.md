# Maintaining OpenAPI Support

[Home](../README.md) | [OpenAPI Versions](./openapi-versions.md) | [Architecture](./architecture.md) | [Contributing](../CONTRIBUTING.md)

---

A runbook for maintainers: how the library represents OpenAPI versions, what to do when the OpenAPI Initiative (OAI) publishes something new, and which test proves what. [OpenAPI Versions](./openapi-versions.md) is the support matrix for users; this page is about keeping it true.

Everything below names a file or a command that exists in the tree. Commands use `corepack yarn` (the repository pins Yarn 4; a global Yarn 1 is not the right one).

## How versions are represented

| What | Where |
| ---- | ----- |
| The version a document declares, and what it means (`supported`, `newer-minor`, `unsupported`, `malformed`, `missing`) | `detectSpecVersion` in `src/spec/versions.ts` |
| The known versions, oldest first (`SpecFamily`, `SPEC_FAMILIES`, `LATEST_SPEC_FAMILY`) | `src/spec/versions.ts` |
| What each version allows (fixed methods, `additionalOperations`, parameter locations, whether `responses` / `paths` / response `description` are required, `webhooks`, `$self`, ...) | one `SpecProfile` per family in `SPEC_PROFILES`; each value cites the schema pointer it comes from |
| Which operations a document has | `resolveOperationLayout(detectSpecVersion(document))`, the one decision; the walker is `listOperations` / `getOperation` in `src/spec/operations.ts` (`STANDARD_METHODS`, `LEGACY_OPERATION_LAYOUT`, `FULL_OPERATION_LAYOUT`) |
| Which version introduced each construct | `SPEC_FEATURES` (`since`, `label`), read by `featureNewerThanDeclared` for the `FEATURE_NEWER_THAN_DECLARED_VERSION` warning |
| The types of the documents we read | `src/spec/types/`: `v2_0.ts` (`OAS20`), `v3_0.ts` (`OAS30`), `v3_1.ts` (`OAS31`), `v3_2.ts` (`OAS32`, written as `Override<OAS31 object, changes>`), shared pieces in `common.ts` (`SpecMap`, `FreeFormValue`, `Override`), the Schema Object dialect in `json-schema-2020-12.ts`, `extensions.ts` (`WithExtensions`); `index.ts` holds the namespaces, the cross-version unions (`OpenAPIDocument`, `OperationObject`, ...) and the list of deliberate deviations from the official schemas |
| Diagnostic codes of the spec layer | `SPEC_DIAGNOSTIC_CODES` in `src/spec/diagnostics.ts`; the library-wide registry `DIAGNOSTIC_CODES` in `src/types.ts` extends it |
| The boundary | `src/spec/tsconfig.json` (`rootDir: "."`, `types: []`): nothing under `src/spec/` can import from outside it. `corepack yarn typecheck` compiles it |

Three rules to keep in mind (the full statement is in [CLAUDE.md](../CLAUDE.md) and [OpenAPI Versions](./openapi-versions.md)):

- **The patch number never matters.** Rules are those of the declared `major.minor`.
- **Operation discovery follows the declared version; everything else follows features.** A construct the library understands is processed whatever version the document declares, except which operations are read (`query`, `additionalOperations`).
- **A newer 3.x minor is processed with the latest profile** and a `NEWER_OPENAPI_VERSION` warning. Adding a version moves `LATEST_SPEC_FAMILY`, so the boundary of `newer-minor` moves with it.

### Swagger 2.0

These pieces exist: the types (`src/spec/types/v2_0.ts`, namespace `OAS20`, not part of the cross-version unions), its profile (`SPEC_PROFILES['2.0']`; the family is declared by `swagger` instead of `openapi`, see `isSwagger2`), the converter to OpenAPI 3.0 (`upgradeSwagger2` in `src/spec/upgrade-v2.ts`, with `swagger2SkippedOperations` and `UPGRADED_OPENAPI_VERSION`; unit tests in `src/__tests__/spec-upgrade-v2.spec.ts`), and the fixtures: the official 2.0 schema (`e2e/fixtures/oas/schemas/2.0`) and example documents (`e2e/fixtures/oas/documents/2.0`), our own documents (`e2e/fixtures/supplementary/2.0`), the equivalence API (`e2e/fixtures/supplementary/equivalence`) and a real description (`e2e/fixtures/netlify-trimmed-2.0.json`). How a 2.0 document moves through the generator, the validator and lint is described in [OpenAPI Versions](./openapi-versions.md); this page does not repeat it.

## The pinned sources

Everything the stories compare against is vendored under `e2e/fixtures/oas/` and pinned in `e2e/fixtures/oas/sources.json`:

- `sources`: a flat list of `{ id, version, kind, url, path, sha256 }`. The schemas come from `https://spec.openapis.org/oas/<version>/<kind>/<YYYY-MM-DD>` (kinds `schema`, `schema-base`, `dialect`, `meta`; 2.0 and 3.0 have only `schema`); the JSON Schema meta-schemas from `json-schema.org`; the OAI test documents from `raw.githubusercontent.com` at a full commit SHA.
- `upstream`: where the test documents came from. One row per commit: `{ commit, version, ref, folders, note? }`. `ref` is the OAI branch the commit was taken from (`v3.2-dev`, `v3.1-dev`, `main` for the 3.0 archive); a row without `ref` is frozen (the 2.0 examples folder was removed from the repository, so the pin is its parent and there is nothing to follow). `folders` are the folders taken from the commit. `acknowledgedBranches` lists development branches already known and deliberately not pinned (see below). The sync script checks the table against the entries: every source on `raw.githubusercontent.com` must be explained by a row (same commit and version, under one of its folders) and every row must explain one, so moving a pin without the table fails verification.

`scripts/sync-oas-sources.mjs` is the one tool for it:

```bash
node scripts/sync-oas-sources.mjs            # offline: every file exists and matches its sha256; no unlisted file; the upstream table matches the entries
node scripts/sync-oas-sources.mjs --update   # download every url, write the bytes, rewrite the sha256 values (about 40 seconds)
node scripts/sync-oas-sources.mjs --latest   # read-only, needs network: what is NEWER upstream than what is pinned
node scripts/sync-oas-sources.mjs --latest --json
node scripts/sync-oas-sources.mjs --latest --manifest <file>   # the same against another manifest (a doctored copy, to see a finding)
```

Downloads are limited to `spec.openapis.org`, `json-schema.org` and `raw.githubusercontent.com`, never follow a redirect and stop at 5 MiB; `--latest` also asks `api.github.com`, with the same rules. `GITHUB_TOKEN`, when set, is sent to `api.github.com` only (no scope is needed, the repository is public). Without it the API allows 60 requests an hour per address; a `--latest` run in which no followed branch has moved makes five (three branch heads, one page of tags, one page of branches; each further hundred tags or branches is one more request), and two more for each pinned folder of a branch that has moved.

`--latest` exits **0** when nothing is newer, **3** when something is, and **1** on any error (an unreachable host, a rate limited API, a changed index page, an invalid manifest), so automation can tell "nothing to do" from "could not check". JSON Schema meta-schemas are frozen and are not checked. It reports:

| Finding (`type` in the JSON) | Meaning | Source |
| --- | --- | --- |
| `schema-iteration` | A later dated iteration of a pinned `schema`, `schema-base`, `dialect` or `meta` for the same version | the index https://spec.openapis.org/oas/ |
| `unpinned-version` | A version directory (or a specification text such as `v3.3.0.html`) on the index that no source is pinned for | the index |
| `documents-changed` | The head of the pinned branch moved **and** a pinned folder differs between the pinned commit and the head (compared by git tree, so a moved head with identical folders is not reported). Lists the added, removed and modified files and a compare link | `api.github.com`, `git/ref` and `git/trees` |
| `branch-gone` | A branch an `upstream.documents` row follows (`ref`) no longer exists (deleted or renamed). The pin cannot be followed: name its successor in `ref`, or drop `ref` to freeze the pin. A missing branch is a finding, not an error; a repository that cannot be read at all is still an error (exit 1) | `git/ref`, then the repository itself |
| `release-tag` | A release tag of `OAI/OpenAPI-Specification` (`3.3.0`, `3.3.0-rc0`) whose `major.minor` is newer than the newest pinned version | `tags` (paginated, 100 per page) |
| `dev-branch` | A `v<major>.<minor>-dev` branch of a version with no pinned sources and not in `acknowledgedBranches` | `branches` (paginated, 100 per page) |

If the index no longer lists an iteration that is pinned, the script fails (exit 1) instead of reporting "nothing newer": the page layout probably changed and the answer would mean nothing.

The report is bounded, because the weekly workflow carries it in an environment variable: at most 50 findings of a type, at most 48 KiB of compact JSON in all, and 20 names in any list. What does not fit is counted in `omitted` (per type) and shown as `and N more ... findings`, never dropped silently. Tags and branches are read from the paginated `tags` and `branches` listings; `git/matching-refs` is not used because it ignores `page` and `per_page` and answers every match at once.

## Adding a new OpenAPI version (for example 3.3)

Work in this order; each step has a test that tells you what is missing.

1. **Pin the official schemas and test documents.**
   - In `e2e/fixtures/oas/sources.json` add the four schema entries (`oas-3.3-schema`, `oas-3.3-schema-base`, `oas-3.3-dialect`, `oas-3.3-meta`: `version: "3.3"`, `url: https://spec.openapis.org/oas/3.3/<kind>/<date>` with the dates from the index, `path: schemas/3.3/<kind>.json`). The dialect and meta dates differ from the schema's.
   - Add the test documents: generate the entries for `tests/schema/pass` and `tests/schema/fail` at a full commit of `v3.3-dev` with the snippet in [`e2e/fixtures/README.md`](../e2e/fixtures/README.md#openapi-initiative-test-documents) (`documents/3.3/{pass,fail}/<name>.yaml`, ids `oas-3.3-doc-<pass|fail>-<name>`), and add the row to `upstream.documents`: `{ "commit": "<sha>", "version": "3.3", "ref": "v3.3-dev", "folders": ["tests/schema/pass", "tests/schema/fail"] }`.
   - `node scripts/sync-oas-sources.mjs --update`, then `git diff e2e/fixtures/oas/` and read it: the new files and checksums are the only change. Run the plain verify afterwards.
   - Record the pins in the tables of `e2e/fixtures/README.md` and check `e2e/fixtures/NOTICES.md` (the OAI sources are Apache-2.0 and vendored unmodified, so no licence text is reproduced).
   - If the new version has been published, pin the release's commit rather than the branch head. OAI's source schemas carry `WORK-IN-PROGRESS` in their ids and a `json_schema_dialect` test document names that dialect; expect the same known gap the 3.1 and 3.2 documents have.
   - Let the validator helper know the version: widen `OasVersion` in `e2e/helpers/oas-validate.ts`. For a 3.x version that keeps the 3.1 and 3.2 shape, the helper finds the schemas by their path (`schemas/<version>/`, validated through `schema-base.json`) and nothing else changes; a version that changes the shape (as 2.0 and 3.0 differ from the rest: draft-04) needs its own branch in `createValidator`.

2. **Add the types module.** Create `src/spec/types/v3_3.ts` the way `v3_2.ts` extends `v3_1.ts`: every object is the 3.2 object unchanged (`export type InfoObject = OAS32.InfoObject`) or `Override<OAS32.X, { ...changes }>`, and an object also changes when an object it holds changes. Write it from the specification text and the new schema, cite both in the header, and keep the reader-type rules of `src/spec/types/index.ts` (open enumerations, `SpecMap`, `FreeFormValue`, no index signatures). Register it in `src/spec/types/index.ts` (`import type * as OAS33`, `export type * as OAS33`, and `| OAS33.X` in every cross-version union) and in the `OAS20, OAS30, OAS31, OAS32` export of `src/index.ts`.

3. **Register the version.** In `src/spec/versions.ts`: add the family to `SpecFamily` and `SPEC_FAMILIES`, move `LATEST_SPEC_FAMILY`, add `PROFILE_3_3` to `SPEC_PROFILES` (every value with the schema pointer it comes from, as the existing profiles do), and add each new construct to `FEATURES` with `since: '3.3'`. If the version adds an operation field, it also goes in `STANDARD_METHODS` in `src/spec/operations.ts` (as `query` did for 3.2, which `LEGACY_OPERATION_LAYOUT` filters out), and only the profiles that define it list it in `fixedMethods`. The validator picks the profile up through `getSpecProfile` (`src/validator.ts`); the version lists in messages come from `SUPPORTED_SPEC_VERSIONS`. Update the unit tests that pin the lists (`src/__tests__/spec-versions.spec.ts`: `SPEC_FAMILIES`, one case per profile; `spec-operations.spec.ts`; `validator.spec.ts`) and keep the 100% coverage gate: `corepack yarn test:coverage`.

4. **Extend the parity story and run it.** In `e2e/spec-types-parity.e2e.ts` add `const OAS33: VersionCase` next to `OAS32` (the same `oas3xMappings([...flows])`, `kinds`, a `probeRoot` with `openapi: '3.3.0'`, the `unmapped` definitions the new schema adds with a reason each, the `kindCoverage` count) and add it to `VERSIONS`. Then:

   ```bash
   corepack yarn build
   corepack yarn test:e2e spec-types-parity
   ```

   Each failure names the version, the schema definition, the type and the exact fields: a field the schema has and the type lacks (or the reverse), a required-ness or value-kind difference, a definition that is mapped to no type, a type that accepts a string. Fix the types, or record a deliberate deviation in the version's allowlist with its reason (never to silence a failure). The story also checks that the vendored files match their checksums and that `src/spec` imports nothing from outside itself.

5. **Run the official documents and fix what they report.** In `e2e/official-documents.e2e.ts` add the version to `VERSIONS` (document counts) and `SUPPLEMENTARY_VERSIONS`, write the `VALIDATOR_VERDICTS` row of every FAIL document (does our validator reject it, and why), and pin the tools of every PASS document in `e2e/expected/official-documents.json` (`[name, method, path, readOnlyHint]`, written from the document's operations under `paths`, not from what the library prints). Run `corepack yarn test:e2e official-documents`. What does not hold yet goes in `KNOWN_GAPS` with the exact failure lines; a gap that starts to hold fails the story until its entry is deleted, so the list only shrinks deliberately.

6. **Add supplementary documents** for the constructs the official documents leave out where a tool is built. They live in `e2e/fixtures/supplementary/3.3/{pass,invalid}/` (see [its README](../e2e/fixtures/supplementary/README.md#adding-a-document)): each `pass` document must validate against the official schema, each `invalid` one must be rejected by it, and tools, facts and diagnostics are pinned by hand in `e2e/expected/supplementary-documents.json`. Update the counts in `SUPPLEMENTARY_VERSIONS`.

7. **Implement the new semantics.** Everything a tool can show: operations (the profile's `fixedMethods` / `additionalOperations`, read by `listOperations`), parameters, bodies, responses, security, base URIs. Follow the existing pattern: a feature the library understands is processed whatever version the document declares, and the validator reports it for an older declared version through `featureNewerThanDeclared`. Anything skipped or ignored is a diagnostic registered in `DIAGNOSTIC_CODES`, never a silent drop. Unit tests with inline documents, wire tests in `e2e/wire-serialization.e2e.ts` where the request changes, and a root for the multi-file story (`e2e/fixtures/supplementary/multi-file/`) if how `$self` or references work changes.

8. **Type tests.** Add the version to `e2e/types/shapes.types.ts` (required keys, keys per version), `documents.types.ts` and the cases of `rejections.types.ts` that depend on the version; `corepack yarn typecheck` compiles them (see `e2e/types/README.md`).

9. **Public types.** `corepack yarn build && node scripts/diff-public-types.mjs`. A new namespace is only additions, but a change in a shared type (a cross-version union gains a member) is a difference: give it a cause with a reason in `scripts/public-types-allowlist.json` (`--update-allowlist`, then replace each `TODO: explain`).

10. **Docs.** `docs/openapi-versions.md` (the declared-versions table, the per-version validation table, the feature tables), the version numbers named in `README.md` and `CLAUDE.md`, and the supported-version tables in `e2e/fixtures/README.md`.

Before the pull request: `corepack yarn typecheck`, `corepack yarn test:coverage`, `corepack yarn build && corepack yarn test:e2e`, `node scripts/sync-oas-sources.mjs`, `node scripts/diff-public-types.mjs`. Optionally the [real-world corpus](#the-local-real-world-corpus) over the specs that declare the new version.

## When OAI publishes a new schema iteration

A `schema-iteration` finding names the manifest entry (`id`), the pinned date, the newest date and the URL. To move the pin:

1. In `e2e/fixtures/oas/sources.json` change the date in the entry's `url` (keep its `path` unless the layout changed). `schema` and `schema-base` usually move together; `dialect` and `meta` rarely, and their dates differ from the schema's.
2. `node scripts/sync-oas-sources.mjs --update` and read the diff of the vendored file (`git diff --no-index` against the old copy, or `git diff` on the working tree): that diff is the change in the specification you are about to absorb.
3. Run what the new schema can break, in this order:
   - `corepack yarn test:e2e spec-types-parity`: a field the new schema added or removed, a changed required-ness or value kind, a new `$defs` entry that no type is mapped to. Fix `src/spec/types/` (and the profile in `src/spec/versions.ts` if a rule changed), or record a deviation with its reason.
   - `corepack yarn test:e2e official-documents`: the schema layer of every PASS and FAIL document, and the supplementary documents, which must still validate (an `invalid` one must still be rejected).
   - `corepack yarn typecheck`, `corepack yarn test:coverage`.
4. Update the date and "retrieved" columns in the tables of `e2e/fixtures/README.md`, and `kindCoverage` in the parity story if the count of compared fields changed.

A `documents-changed` finding is the same for the test documents: set the new full commit in the `url` of every entry of that version and kind **and** in the row of `upstream.documents` (the verification fails until both agree), add the entries of new files and drop those of deleted ones (the snippet in `e2e/fixtures/README.md` lists a folder at a commit), run `--update`, and update the document counts (`VERSIONS`), the verdict table (`VALIDATOR_VERDICTS`), the pinned tools in `e2e/expected/official-documents.json` and `KNOWN_GAPS` in `e2e/official-documents.e2e.ts`. A `release-tag` or `unpinned-version` finding for a minor version nobody supports yet is the trigger for [adding the version](#adding-a-new-openapi-version-for-example-33). A `dev-branch` finding is an early notice; once you have decided it needs no action yet, add its name to `upstream.acknowledgedBranches` in the manifest so the weekly run stops reporting it (it is still found through the index and the tags when the version is published).

## What each test layer proves

| Layer | Files | What it proves | Command |
| ----- | ----- | -------------- | ------- |
| Unit tests | `src/__tests__/*.spec.ts` (one per module: `spec-versions`, `spec-operations`, `spec-upgrade-v2`, `validator`, ...) | Behaviour of each module with inline documents; 100% statements, branches, functions and lines | `corepack yarn test:coverage` |
| Type checking | `e2e/tsconfig.json` (src, e2e, examples, type tests) and `src/spec/tsconfig.json` (the boundary) | Jest with SWC strips types without checking them, so only this proves the types compile and that `src/spec` imports nothing outside itself | `corepack yarn typecheck` |
| Type tests | `e2e/types/*.types.ts` | What a consumer sees: `documents`, `reads`, `methods`, `tools`, `extensions`, `fixtures` and `swagger2` (the `OAS20` types in one place) must compile; `rejections` must not (each `@ts-expect-error` has one reason to fail); `shapes` states required keys and field types as assertions. Compiled by `typecheck`, never run | `corepack yarn typecheck` |
| Schema-to-types parity | `e2e/spec-types-parity.e2e.ts`, `e2e/helpers/oas-schema.ts` | `OAS20`, `OAS30`, `OAS31` and `OAS32` declare exactly the fields of the official OAI JSON Schemas (required-ness, value kinds, map objects, which types accept a primitive); every schema definition is mapped to a type or listed as unmapped with a reason; the vendored files match their checksums. Deviations are allowlisted per version with a reason | `corepack yarn test:e2e spec-types-parity` |
| Official documents | `e2e/official-documents.e2e.ts`, `e2e/helpers/oas-validate.ts`, `e2e/fixtures/oas/documents/`, `e2e/expected/official-documents.json` | Each OAI PASS document validates against the official schema, type-checks against our types, passes our validator, generates exactly the pinned tools and reports no diagnostic for something it could not process; each FAIL document is rejected by the schema, never crashes the pipeline and has a recorded validator verdict. `KNOWN_GAPS` is asserted to still fail, so it only shrinks | `corepack yarn test:e2e official-documents` |
| Supplementary documents | `e2e/fixtures/supplementary/<version>/{pass,invalid}/`, `e2e/expected/supplementary-documents.json` | The constructs the official documents leave out where a tool is built, held to the same five checks with no known gap allowed; tools, facts and diagnostics pinned by hand from the document and the specification | same story as above |
| Multi-file story | `e2e/multi-file.e2e.ts`, `e2e/fixtures/supplementary/multi-file/` | Relative `$ref`s are read against the retrieval URI for each way a document gets in (`fromFile` from any working directory, `fromURL` against a loopback server with every request recorded, `fromJSON` / `fromYAML` with `documentUri`), `$self` names the document without moving a read, nothing but 127.0.0.1 is contacted | `corepack yarn test:e2e multi-file` |
| Swagger 2.0 story | `e2e/swagger2.e2e.ts`, `e2e/fixtures/supplementary/equivalence/`, `e2e/fixtures/netlify-trimmed-2.0.json` | The conversion to OpenAPI 3.0 held to the specifications: the converted document of every 2.0 document we have (generator and `upgradeSwagger2` alike) is the same and validates against the official 3.0 schema; the Lending Library API written five times (2.0 in one and twelve files, 3.0, 3.1, 3.2) gives one tool contract; `dereference: false`, a missing `host`, `collectionFormat`, `consumes`/`produces`, `type: file`, OAuth2 flows, the states of `getDocument()`, `lint()` and an Arazzo workflow over a 2.0 source | `corepack yarn test:e2e swagger2` |
| Real specs and wire tests | `e2e/real-specs.e2e.ts`, `e2e/curation-journey.e2e.ts`, `e2e/wire-serialization.e2e.ts`, `e2e/mcp-server.e2e.ts`, `e2e/packaging.e2e.ts` | Vendored trims of real descriptions (literal tool counts pin drift on purpose), real loopback HTTP, the real MCP SDK, and the built `dist/` (the packaging story also checks the emitted declarations import nothing unexpected) | `corepack yarn build && corepack yarn test:e2e` |
| Public-type differential | `scripts/diff-public-types.mjs`, `scripts/public-types-allowlist.json`, CI job `public-types` | Every exported type is compared, both directions, with the baseline release; each difference must be allowlisted under a cause with a reason, and a stale entry fails too. Needs the network and a build | `corepack yarn build && node scripts/diff-public-types.mjs` |
| Pinned sources | `scripts/sync-oas-sources.mjs`, `e2e/fixtures/oas/sources.json` | Every vendored file matches its checksum, none is unlisted, the `upstream` table explains every commit | `node scripts/sync-oas-sources.mjs` |
| Real-world corpus (local) | `scripts/spec-corpus/` | A survey of 38 public documents through the built library. Not part of CI, nothing is committed, results are local | see below |

CI runs unit tests with coverage, `typecheck`, the e2e stories and the public-type job from `.github/workflows/push.yml`. The sync script's offline verification is not a CI step; it is run by hand before a change to `e2e/fixtures/oas/` is committed, and the stories fail on a checksum that does not match.

## The local real-world corpus

`scripts/spec-corpus/` downloads 38 real documents (15 declaring OpenAPI 3.2, 8 declaring 3.1, 10 declaring 3.0, 5 Swagger 2.0) into the git-ignored `.spec-corpus/` and runs each through the built library in its own process, writing `results.json` and `REPORT.md` there. It is a survey, not a gate: use it after a change to loading, validation or generation, or when adding a version, to see what real documents do that inline ones do not.

```bash
corepack yarn build
node scripts/spec-corpus/download.mjs               # about 160 MB; what is present and verified is skipped
node scripts/spec-corpus/run.mjs --version 3.1      # or no filter for all 38
```

**Run it only on specs you are willing to trust, or in a sandbox.** Every multi-file spec gets a `local-refs` attempt that sets `refResolution.allowedProtocols: ['file', 'http', 'https']`, so that the spec can read its sibling files. With `file` allowed a reference can name any file the process can read: a relative path (`../` is not confined to the spec's folder), an absolute path or a `file:` URL, and what is read becomes part of the document the library generates tools from. The first (`default`) attempt allows only `http` and `https`, so a spec with remote `$ref`s makes the library fetch them. A spec in `sources.json` is pinned and checksummed, which shows it is the document that was looked at, not that it is harmless; a spec you add or edit (`--no-verify`) has had no review at all. Use a container or a virtual machine with no credentials in it for anything you did not read.

`run.mjs` first checks each selected spec against the size, sha256 and (for a multi-file spec) tree digest in `sources.json` and skips one that does not match (`HASH MISMATCH`, exit 1; `--no-verify` overrides), and the operation counts are made by a pass that reads only the spec's own folder. [`scripts/spec-corpus/README.md`](../scripts/spec-corpus/README.md) has the flags, the cost, how to add a spec and the licence position (no spec is redistributed; `sources.json` records where each comes from and its licence as found).

## The spec-watch workflow

[`.github/workflows/spec-watch.yml`](../.github/workflows/spec-watch.yml) runs `node scripts/sync-oas-sources.mjs --latest --json` every Wednesday (06:23 UTC) and on demand (`workflow_dispatch`). It opens, or updates, **one** issue titled `OpenAPI sources: newer versions available` listing the findings and pointing here.

- **Two jobs.** `check` has `contents: read` only and reads the network; it hands the report to `report` as one JSON value in an environment variable (the script keeps it under 48 KiB; the job refuses one over 100,000 bytes). `report` has `issues: write` only and checks nothing out. Both run only in `agentfront/mcp-from-openapi`, never in a fork. No secret is used: the token is the workflow's own, and its only use in `check` is lifting the unauthenticated GitHub API limit.
- **No injection.** Nothing fetched is interpolated into a shell command or a workflow expression inside a `run:` block. The report travels in an environment variable, the script has already restricted every upstream name to a plain character set (branch names, tags and dates must match fixed patterns, file names are escaped), and the issue text is built from the JSON by `jq`, with each value in a code span.
- **No duplicates, and no adopted strangers.** The workflow's own issue is the open issue that has exactly that title, was written by `github-actions[bot]` (the identity of the workflow's token, which nobody else can use) and carries the `spec-watch` label. `report` creates the label once if it is missing (it needs only the `issues: write` it already has), asks the API for the open issues with that label and reads every page of the answer, then takes the lowest-numbered match and edits its text only when it differs; with none it creates the issue with the label. An issue with the same title written by someone else, or without the label, or a pull request, is left alone. `concurrency: spec-watch` stops two runs from racing. Close the issue when the pins are moved; a new one opens only if something is still newer.
- **A failed check is not "nothing newer".** An unreachable host, a rate limited API or a changed index page fails the `check` job (exit 1 of the script), which GitHub reports as a failed run.
- **Fail closed.** Every step runs with `set -euo pipefail`. The `check` job refuses output that is not a report agreeing with the script's exit code, and `report` refuses an empty or malformed report, an empty issue text, and an empty body at the moment it would create or edit an issue (a failed `jq` inside an `echo` would otherwise hand over an empty report and open an empty issue). The issue text is cut at a line end below GitHub's limit when it is too long, and says so.
- **Dry run.** *Actions, Spec watch, Run workflow* with `dry_run` set prints the issue text in the job summary and touches no issue. The `check` job always prints the full JSON report in its summary, so a run that finds nothing still shows what was checked.

To reproduce what the workflow sees: `GITHUB_TOKEN="$(gh auth token)" node scripts/sync-oas-sources.mjs --latest`.
