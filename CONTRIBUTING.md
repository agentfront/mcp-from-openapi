# Contributing to mcp-from-openapi

Thanks for your interest in contributing! This document covers everything you
need to get a change from idea to merged PR.

## Getting started

**Requirements**: Node.js >= 22.19, Yarn 4 (via corepack).

```bash
git clone https://github.com/agentfront/mcp-from-openapi.git
cd mcp-from-openapi
corepack enable
yarn install
yarn test
```

Useful commands:

| Command                 | Purpose                               |
| ----------------------- | ------------------------------------- |
| `yarn test`             | Run all tests (unit + integration)    |
| `yarn test:unit`        | Unit tests only                       |
| `yarn test:integration` | Integration tests only                |
| `yarn test:e2e`         | E2E story suite (run `yarn build` first) |
| `yarn test:coverage`    | Tests with the enforced coverage gate |
| `yarn typecheck`        | Type-check src, e2e, examples, and type tests |
| `yarn build`            | Build CJS + ESM + type declarations   |

Project architecture, module layout, and conventions are documented in
[CLAUDE.md](./CLAUDE.md) and [docs/architecture.md](./docs/architecture.md).

## The quality bar

- **100% coverage is enforced** — statements, branches, functions, and lines
  (`coverageThreshold` in `jest.config.js`). `yarn test:coverage` fails on any
  regression. For defensive branches that are genuinely unreachable through the
  public API, use `/* c8 ignore next */` with a comment explaining why —
  never lower the thresholds.
- **Tests live next to the module**: one `src/__tests__/<module>.spec.ts` per
  module, inline spec objects (no fixture files), real loopback servers for
  network paths (see the Testing Patterns section of CLAUDE.md).
- **TypeScript strictness**: `yarn typecheck` must pass (it type-checks `src`,
  `e2e`, `examples`, and the type tests, which Jest's SWC transform skips).
  Avoid multi-step casts (`as unknown as`) — if a cast needs more than one
  step, fix the type design instead.
- **Runtime-agnostic**: the library must keep working on V8 isolates
  (Cloudflare Workers). Node builtins may only be imported lazily inside
  Node-only code paths (see `fromFile` in `src/generator.ts`).

### Public type compatibility check

The `public-types` CI job compares every type the built package exports with
the release recorded as `baseline` in `scripts/public-types-allowlist.json`,
member by member and in both directions. It also catches what assignability
alone misses: a removed optional property, `any` appearing or disappearing,
and `readonly` changes. It also reports index signatures that were removed or
added, and compares rest-tuple parameters element by element. Each difference
must be listed in that file under a cause with a reason, and a listed
difference that no longer occurs fails too.

Run it locally (it needs network access, to install the baseline from npm):

```bash
yarn build
node scripts/diff-public-types.mjs
```

When it fails:

- **The difference is a mistake**: fix the type and run it again.
- **The difference is intended**: run
  `node scripts/diff-public-types.mjs --update-allowlist`. New differences
  land under a `"TODO: explain"` cause; move each one under the cause it
  belongs to, or replace the TODO with a specific reason (what changed and
  why). The check fails while any reason starts with TODO.
- **Exit code 2 with `ENVIRONMENT ERROR`** is not about the types (npm or the
  network failed, or the build is missing): re-run the job.

After a release, compare against it: run
`node scripts/diff-public-types.mjs --update-allowlist --baseline <new version>`,
which records the new baseline. The causes of the released changes are no longer
differences, so they drop out; anything left still needs its reason.

### Maintaining OpenAPI version support

Which OpenAPI versions the library reads, and how a new version or a new schema
iteration from the OpenAPI Initiative is absorbed, is written down step by step
in [docs/maintaining-openapi-support.md](./docs/maintaining-openapi-support.md).
Three scripts support it:

- `node scripts/sync-oas-sources.mjs` verifies the official schemas and test
  documents vendored under `e2e/fixtures/oas/` against their pinned checksums
  (offline); `--update` re-downloads them; `--latest` (read-only, needs the
  network) reports what is newer upstream and exits 3 when something is. The
  `spec-watch` workflow runs it weekly and keeps one issue up to date.
- `node scripts/diff-public-types.mjs` is the public-type check described above.
- `node scripts/spec-corpus/download.mjs` and `run.mjs` download 38 real-world
  specs into the git-ignored `.spec-corpus/` and run them through the built
  library. It is a local survey, not a CI gate, and no spec is ever committed
  (see [scripts/spec-corpus/README.md](./scripts/spec-corpus/README.md)).

## Commits and pull requests

- **Branch from the target branch** (usually a `release/X.Y.x` branch or
  `main`) and push your branch under its **own name** — never push directly to
  `main` or `release/*`.
- **One-line conventional commit messages**: `feat: ...`, `fix: ...`,
  `docs: ...`, `test: ...`, `ci: ...`, `chore: ...`. No trailers.
- Keep each commit focused: one feature or fix per commit, including its tests.
- Open a PR with a summary and a test plan. Every PR gets an automated review;
  please respond to (or fix) each finding — maintainers merge once review and
  CI are green.
- Security-relevant changes (anything touching `src/ssrf.ts`, URL/`$ref`
  handling, request building, or overlays) get extra scrutiny — explain the
  threat model in the PR description.

## Documentation

- All feature docs live in `docs/`; new options and exports must be reflected
  in `docs/configuration.md` and `docs/api-reference.md`.
- Links in `README.md` must use absolute GitHub URLs
  (`https://github.com/agentfront/mcp-from-openapi/blob/main/docs/<file>.md`)
  because npm renders the README on its own domain.

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/agentfront/mcp-from-openapi/issues/new/choose).
For anything security-sensitive, **do not open a public issue** — see
[SECURITY.md](./SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating, you are expected to uphold it.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](./LICENSE).
