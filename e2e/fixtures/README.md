# E2E Fixtures — Vendored Real-World OpenAPI Specs

Real specs for the e2e story suite. **Unit tests never use fixture files** (inline specs only — see CLAUDE.md); these exist so the e2e stories exercise real-world spec weirdness that hand-built specs can't anticipate. They already earned their keep: vendoring them surfaced two product bugs (cyclic-schema infinite recursion in `toJsonSchema`, path-item-level parameters ignored by the validator).

## Files

| File | Source | Pinned commit | Retrieved | License | Size |
| ---- | ------ | ------------- | --------- | ------- | ---- |
| `petstore-3.0.yaml` | [swagger-api/swagger-petstore](https://github.com/swagger-api/swagger-petstore) `src/main/resources/openapi.yaml` (OAS 3.0.4) | `8f0dd286987880b4af7bce552aca3813166f3049` | 2026-08-13 | Apache-2.0 ([upstream LICENSE](https://github.com/swagger-api/swagger-petstore/blob/master/LICENSE)) | ~23 KB, vendored whole |
| `github-trimmed-3.0.json` | [github/rest-api-description](https://github.com/github/rest-api-description) `descriptions/api.github.com/api.github.com.json` (OAS 3.0.3, 12.9 MB upstream) | `b26c240ded1c8b79cb0fb09dee4a21239061fa23` | 2026-08-13 | MIT — © GitHub, Inc. ([upstream LICENSE](https://github.com/github/rest-api-description/blob/main/LICENSE.md)) | ~579 KB (78 operations) |
| `discord-trimmed-3.1.json` | [discord/discord-api-spec](https://github.com/discord/discord-api-spec) `specs/openapi.json` (OAS **3.1.0**, 1.18 MB upstream; dense `const`/`prefixItems`/`oneOf`, cyclic schemas) | `1314ec6fee3b2fdfb2c09b85fb49e467f84c1dd7` | 2026-08-13 | MIT — © Discord Inc. ([upstream LICENSE](https://github.com/discord/discord-api-spec/blob/main/LICENSE)) | ~410 KB (60 operations) |

The MIT license texts are vendored verbatim in [NOTICES.md](./NOTICES.md), as required for the redistributed portions; the trimmed files carry an `info['x-fixture-provenance']` note pointing back here.

## Regenerating

Trimming is done by the vendored [`trim-openapi.mjs`](https://github.com/agentfront/mcp-from-openapi/blob/main/e2e/fixtures/trim-openapi.mjs) (operation filter by tags or path prefixes + transitive `$ref` component closure, stable key order). Exact invocations:

```bash
PET_SHA=8f0dd286987880b4af7bce552aca3813166f3049
curl -fsSL "https://raw.githubusercontent.com/swagger-api/swagger-petstore/${PET_SHA}/src/main/resources/openapi.yaml" \
  -o e2e/fixtures/petstore-3.0.yaml

GH_SHA=b26c240ded1c8b79cb0fb09dee4a21239061fa23
curl -fsSL "https://raw.githubusercontent.com/github/rest-api-description/${GH_SHA}/descriptions/api.github.com/api.github.com.json" -o /tmp/github-full.json
node e2e/fixtures/trim-openapi.mjs /tmp/github-full.json e2e/fixtures/github-trimmed-3.0.json --tags issues,gists

DIS_SHA=1314ec6fee3b2fdfb2c09b85fb49e467f84c1dd7
curl -fsSL "https://raw.githubusercontent.com/discord/discord-api-spec/${DIS_SHA}/specs/openapi.json" -o /tmp/discord-full.json
node e2e/fixtures/trim-openapi.mjs /tmp/discord-full.json e2e/fixtures/discord-trimmed-3.1.json --path-prefixes "/channels/{channel_id},/users"
```

**Regenerating a fixture (new commit or different trim) requires updating the literal tool-count and lint-finding assertions in `e2e/real-specs.e2e.ts` and `e2e/curation-journey.e2e.ts`** — the literals pin fixture↔spec drift on purpose.

## Official OpenAPI schemas (`oas/`)

The OpenAPI Initiative's own JSON Schemas for OpenAPI 3.0, 3.1 and 3.2, plus the JSON Schema 2020-12 meta-schemas they depend on, vendored byte-for-byte and pinned by checksum. They are the source of truth for the schema-to-types parity story (every field in the official schema exists in our spec types, and our types add nothing the schema lacks) and for validating official OpenAPI documents. Unit tests never read them.

[`oas/sources.json`](./oas/sources.json) is the manifest: a flat list of `{ id, version, kind, url, path, sha256 }` entries, where `path` is relative to `oas/`. The same format is meant to pin further official sources (for example OAI test documents at a fixed commit) as long as each one is a URL, a path and a checksum.

| File (under `oas/`) | Source | Pinned iteration | Retrieved | License | Size |
| ------------------- | ------ | ---------------- | --------- | ------- | ---- |
| `schemas/3.0/schema.json` | [OAS 3.0 schema](https://spec.openapis.org/oas/3.0/schema/2024-10-18) (JSON Schema draft-04) | `2024-10-18` | 2026-11-17 | Apache-2.0 ([upstream LICENSE](https://github.com/OAI/OpenAPI-Specification/blob/main/LICENSE)) | ~36 KB |
| `schemas/3.1/schema.json` | [OAS 3.1 schema](https://spec.openapis.org/oas/3.1/schema/2026-11-05) | `2026-11-05` | 2026-11-17 | Apache-2.0 | ~33 KB |
| `schemas/3.1/schema-base.json` | [OAS 3.1 schema-base](https://spec.openapis.org/oas/3.1/schema-base/2026-11-05) | `2026-11-05` | 2026-11-17 | Apache-2.0 | ~0.7 KB |
| `schemas/3.1/dialect.json` | [OAS 3.1 dialect](https://spec.openapis.org/oas/3.1/dialect/2024-11-10) | `2024-11-10` | 2026-11-17 | Apache-2.0 | ~1 KB |
| `schemas/3.1/meta.json` | [OAS 3.1 meta](https://spec.openapis.org/oas/3.1/meta/2024-11-10) | `2024-11-10` | 2026-11-17 | Apache-2.0 | ~2 KB |
| `schemas/3.2/schema.json` | [OAS 3.2 schema](https://spec.openapis.org/oas/3.2/schema/2026-11-12) | `2026-11-12` | 2026-11-17 | Apache-2.0 | ~41 KB |
| `schemas/3.2/schema-base.json` | [OAS 3.2 schema-base](https://spec.openapis.org/oas/3.2/schema-base/2026-11-12) | `2026-11-12` | 2026-11-17 | Apache-2.0 | ~0.7 KB |
| `schemas/3.2/dialect.json` | [OAS 3.2 dialect](https://spec.openapis.org/oas/3.2/dialect/2026-02-26) | `2026-02-26` | 2026-11-17 | Apache-2.0 | ~1 KB |
| `schemas/3.2/meta.json` | [OAS 3.2 meta](https://spec.openapis.org/oas/3.2/meta/2026-02-26) | `2026-02-26` | 2026-11-17 | Apache-2.0 | ~2.5 KB |

All of the above are published by [OAI/OpenAPI-Specification](https://github.com/OAI/OpenAPI-Specification) and vendored unmodified, so no license text is reproduced (see [NOTICES.md](./NOTICES.md)). `schema` describes documents without validating Schema Objects; `schema-base` wraps it and also validates Schema Objects against the OAS dialect; `dialect` and `meta` are that dialect and its base vocabulary (3.1 and 3.2 only; 3.0 is a single draft-04 schema).

### JSON Schema 2020-12 meta-schemas

The OpenAPI 3.1 and 3.2 schemas are JSON Schema 2020-12 documents and their dialects `$ref` its schema, which in turn `$ref`s the vocabulary meta-schemas. They are pinned here instead of being read from `node_modules/ajv`, an unpinned copy that is not the official file (ajv 8.20.0 adds a `$vocabulary` member to `meta/core`). The URLs are not dated, so the `sha256` in the manifest is the pin. At retrieval every file was byte-identical to the same file on the `2020-12` branch of [json-schema-org/json-schema-spec](https://github.com/json-schema-org/json-schema-spec) (commit `601a66c8b0f25246bf0e1fb488c5b5f030a79b72`).

| File (under `oas/`) | Source | Pinned URL | Retrieved | License | Size |
| ------------------- | ------ | ---------- | --------- | ------- | ---- |
| `schemas/json-schema-2020-12/schema.json` | [JSON Schema 2020-12 schema](https://json-schema.org/draft/2020-12/schema) | `https://json-schema.org/draft/2020-12/schema` | 2026-11-17 | BSD-3-Clause (or AFL-3.0; [upstream LICENSE](https://github.com/json-schema-org/json-schema-spec/blob/4e87b9141e62483383987ddbd27947f1c484b905/LICENSE)) | ~2.5 KB |
| `schemas/json-schema-2020-12/meta/core.json` | [core vocabulary](https://json-schema.org/draft/2020-12/meta/core) | `https://json-schema.org/draft/2020-12/meta/core` | 2026-11-17 | BSD-3-Clause | ~1.5 KB |
| `schemas/json-schema-2020-12/meta/applicator.json` | [applicator vocabulary](https://json-schema.org/draft/2020-12/meta/applicator) | `https://json-schema.org/draft/2020-12/meta/applicator` | 2026-11-17 | BSD-3-Clause | ~1.5 KB |
| `schemas/json-schema-2020-12/meta/unevaluated.json` | [unevaluated vocabulary](https://json-schema.org/draft/2020-12/meta/unevaluated) | `https://json-schema.org/draft/2020-12/meta/unevaluated` | 2026-11-17 | BSD-3-Clause | ~0.4 KB |
| `schemas/json-schema-2020-12/meta/validation.json` | [validation vocabulary](https://json-schema.org/draft/2020-12/meta/validation) | `https://json-schema.org/draft/2020-12/meta/validation` | 2026-11-17 | BSD-3-Clause | ~2.7 KB |
| `schemas/json-schema-2020-12/meta/meta-data.json` | [meta-data vocabulary](https://json-schema.org/draft/2020-12/meta/meta-data) | `https://json-schema.org/draft/2020-12/meta/meta-data` | 2026-11-17 | BSD-3-Clause | ~0.8 KB |
| `schemas/json-schema-2020-12/meta/format-annotation.json` | [format-annotation vocabulary](https://json-schema.org/draft/2020-12/meta/format-annotation) | `https://json-schema.org/draft/2020-12/meta/format-annotation` | 2026-11-17 | BSD-3-Clause | ~0.3 KB |
| `schemas/json-schema-2020-12/meta/content.json` | [content vocabulary](https://json-schema.org/draft/2020-12/meta/content) | `https://json-schema.org/draft/2020-12/meta/content` | 2026-11-17 | BSD-3-Clause | ~0.4 KB |

The upstream repository is licensed under either the BSD 3-clause license or the Academic Free License v3.0 ([LICENSE](https://github.com/json-schema-org/json-schema-spec/blob/4e87b9141e62483383987ddbd27947f1c484b905/LICENSE) at `main` commit `4e87b9141e62483383987ddbd27947f1c484b905`, © 2022 JSON Schema Specification Authors; the `2020-12` branch carries no LICENSE file and its README says "AFL or BSD"). The files are redistributed unmodified under the BSD 3-clause option, which requires its notice to accompany them, so the text is reproduced verbatim in [NOTICES.md](./NOTICES.md).

### Regenerating and verifying

[`scripts/sync-oas-sources.mjs`](https://github.com/agentfront/mcp-from-openapi/blob/main/scripts/sync-oas-sources.mjs) downloads the pinned URLs, writes the exact response bytes, and rewrites the `sha256` values in the manifest:

```bash
node scripts/sync-oas-sources.mjs --update   # re-download every source, rewrite checksums
node scripts/sync-oas-sources.mjs            # offline: every file exists and matches its sha256, no unlisted files
```

To pin a newer iteration, change the entry's `url` (and its `path` only if the layout changes) in `oas/sources.json`, run `--update`, and review the diff. A redirect, a non-200 response, a body over 5 MB, or a host outside the script's allowlist (`spec.openapis.org`, `json-schema.org`, `raw.githubusercontent.com`) fails the update and writes nothing. Files are written through a temp file and a rename, and a symlink at a destination is refused; OS metadata such as `.DS_Store` is ignored by the unlisted-file check.
