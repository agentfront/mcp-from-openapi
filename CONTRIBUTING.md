# Contributing to mcp-from-openapi

Thanks for your interest in contributing! This document covers everything you
need to get a change from idea to merged PR.

## Getting started

**Requirements**: Node.js >= 20, Yarn 4 (via corepack).

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
| `yarn test:coverage`    | Tests with the enforced coverage gate |
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
- **TypeScript strictness**: `npx tsc -p tsconfig.lib.json --noEmit` must pass.
  Avoid multi-step casts (`as unknown as`) — if a cast needs more than one
  step, fix the type design instead.
- **Runtime-agnostic**: the library must keep working on V8 isolates
  (Cloudflare Workers). Node builtins may only be imported lazily inside
  Node-only code paths (see `fromFile` in `src/generator.ts`).

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
