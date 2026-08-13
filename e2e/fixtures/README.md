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
