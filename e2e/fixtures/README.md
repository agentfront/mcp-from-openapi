# E2E Fixtures — Vendored Real-World OpenAPI Specs

Real specs for the e2e story suite. **Unit tests never use fixture files** (inline specs only — see CLAUDE.md); these exist so the e2e stories exercise real-world spec weirdness that hand-built specs can't anticipate. They already earned their keep: vendoring them surfaced two product bugs (cyclic-schema infinite recursion in `toJsonSchema`, path-item-level parameters ignored by the validator).

## Files

| File | Source | Pinned commit | Retrieved | License | Size |
| ---- | ------ | ------------- | --------- | ------- | ---- |
| `petstore-3.0.yaml` | [swagger-api/swagger-petstore](https://github.com/swagger-api/swagger-petstore) `src/main/resources/openapi.yaml` (OAS 3.0.4) | `8f0dd286987880b4af7bce552aca3813166f3049` | 2026-08-13 | Apache-2.0 ([upstream LICENSE](https://github.com/swagger-api/swagger-petstore/blob/master/LICENSE)) | ~23 KB, vendored whole |
| `github-trimmed-3.0.json` | [github/rest-api-description](https://github.com/github/rest-api-description) `descriptions/api.github.com/api.github.com.json` (OAS 3.0.3, 12.9 MB upstream) | `b26c240ded1c8b79cb0fb09dee4a21239061fa23` | 2026-08-13 | MIT — © GitHub, Inc. ([upstream LICENSE](https://github.com/github/rest-api-description/blob/main/LICENSE.md)) | ~579 KB (78 operations) |
| `discord-trimmed-3.1.json` | [discord/discord-api-spec](https://github.com/discord/discord-api-spec) `specs/openapi.json` (OAS **3.1.0**, 1.18 MB upstream; dense `const`/`prefixItems`/`oneOf`, cyclic schemas) | `1314ec6fee3b2fdfb2c09b85fb49e467f84c1dd7` | 2026-08-13 | MIT — © Discord Inc. ([upstream LICENSE](https://github.com/discord/discord-api-spec/blob/main/LICENSE)) | ~410 KB (60 operations) |
| `netlify-trimmed-2.0.json` | [netlify/open-api](https://github.com/netlify/open-api) `swagger.yml` (**Swagger 2.0**, YAML, 188 KB upstream; `in: body`, a `type: file` form part, `consumes`/`produces` overrides, global `parameters` and `responses`, an oauth2 `securityDefinitions`, `x-nullable`) | `96b688490fa406c71e4453e041ec5a0587d35f0b` | 2026-11-17 | MIT — © Netlify ([upstream LICENSE](https://github.com/netlify/open-api/blob/96b688490fa406c71e4453e041ec5a0587d35f0b/LICENSE)) | ~245 KB (177 operations) |

The MIT license texts are vendored verbatim in [NOTICES.md](./NOTICES.md), as required for the redistributed portions; the trimmed files carry an `info['x-fixture-provenance']` note pointing back here.

**Why Netlify for Swagger 2.0.** Four real-world 2.0 descriptions were counted (Kubernetes `swagger.json`, GitLab `openapi_v2.yaml`, Netlify, Slack Web API) for the 2.0-only constructs a conversion has to translate. Netlify is the one that has the most of them in the least space (a whole description is 188 KB of YAML, 262 KB as JSON, where the others are 1.2 to 4.4 MB); none of the four uses `collectionFormat` at all, which the official `petstore-*` examples (`oas/documents/2.0`) and the hand-written `supplementary/equivalence` API cover instead. GitLab was ruled out on licence: its description lives under `doc/`, which GitLab's `LICENSE` puts under CC BY-SA 4.0 (ShareAlike), not a permissive licence.

| Count (whole description) | Kubernetes | GitLab | Netlify | Slack |
| ------------------------- | ---------- | ------ | ------- | ----- |
| Operations | 1,175 | 1,150 | 188 | 174 |
| `in: body` parameters | 559 | 418 | 52 | 0 |
| `in: formData` parameters (of which `type: file`) | 0 | 357 (12) | 1 (1) | 293 (0) |
| Operations with their own `consumes` / `produces` | 1,171 / 1,173 | 515 / 1,150 | 36 / 1 | 174 / 174 |
| `collectionFormat` | 0 | 0 | 0 | 0 |
| Global `parameters` / global `responses` | 48 / 0 | 0 / 0 | 3 / 1 (referenced 169 times in the trim) | 0 / 0 |
| `securityDefinitions` | 1 `apiKey` | 2 `apiKey` (header, query) | 1 `oauth2` (`implicit`) | 1 `oauth2` (`accessCode`) |
| Operation-level `security` | 0 | 0 | 1 (`[]`) | 174 |
| `x-nullable` / `discriminator` / `allOf` in definitions | 0 / 6 / 1 | 0 / 0 / 2 | 6 / 0 / 4 | 0 / 0 / 0 |
| Size | 4.4 MB JSON | 2.5 MB YAML | 188 KB YAML | 1.2 MB JSON |

The trim keeps the 39 tags (every tag the description groups under `x-tagGroups`, plus `aiGateway` for its `security: []` operation) and so drops 11 operations that carry only the tags `x-internal`, `hiddenAgentRunner`, `edgeFunction` or `agentRunnerHook` (the four tags left out); in the trim: 177 operations on 118 paths, 102 definitions, the 3 global parameters (`page`, `per_page` and the `X-Nf-Retry-Count` header) and the global `error` response. Its operations include `createSiteBuild` (`multipart/form-data` with a `zip` file part), three `PUT` operations that consume `application/octet-stream` (`uploadDeployFile`, `uploadDeployFunction`, `uploadDeployServer`), `getAgentRunnerDiff` (its own `produces: text/plain`) and `getAIGatewayProviders` (`security: []`). The one `oauth2` definition has no `scopes` member, which the official 2.0 schema allows and OpenAPI 3.0 requires.

## Regenerating

Trimming is done by the vendored [`trim-openapi.mjs`](https://github.com/agentfront/mcp-from-openapi/blob/main/e2e/fixtures/trim-openapi.mjs) (operation filter by tags or path prefixes + transitive `$ref` component closure, stable key order). It reads OpenAPI 3.x (references under `#/components/...`) and Swagger 2.0 (`swagger: "2.0"`: references under `#/definitions`, `#/parameters` and `#/responses`, `securityDefinitions`, `host`, `basePath`, `schemes`, `consumes` and `produces` kept as they are, and `tags`, `externalDocs` and `x-` members of the root dropped as for 3.x); the input may be JSON or, by its `.yml`/`.yaml` name, YAML; the output is always JSON. Exact invocations:

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

NL_SHA=96b688490fa406c71e4453e041ec5a0587d35f0b
curl -fsSL "https://raw.githubusercontent.com/netlify/open-api/${NL_SHA}/swagger.yml" -o /tmp/netlify-swagger.yml
node e2e/fixtures/trim-openapi.mjs /tmp/netlify-swagger.yml e2e/fixtures/netlify-trimmed-2.0.json --tags ticket,accessToken,user,accountMembership,member,accountType,paymentMethod,auditLog,site,environmentVariables,file,metadata,purge,snippet,dnsZone,sniCertificate,deploy,deployedBranch,deployKey,build,buildLogMsg,devServer,agentRunner,agentRunnerSession,hook,hookType,buildHook,devServerHook,service,serviceInstance,identityUser,function,database,form,submission,splitTest,asset,assetPublicSignature,aiGateway
```

The Netlify tag list is every tag under `x-tagGroups` plus `aiGateway`. Changing the tool must leave the 3.x output byte-identical: re-run the first two invocations into a temporary folder and compare with `cmp` against the two committed files (they matched byte for byte before and after the Swagger 2.0 support was added).

**Regenerating a fixture (new commit or different trim) requires updating the literal tool-count and lint-finding assertions in `e2e/real-specs.e2e.ts` and `e2e/curation-journey.e2e.ts`** — the literals pin fixture↔spec drift on purpose. (`netlify-trimmed-2.0.json` is pinned in `e2e/real-specs.e2e.ts` like the others: 177 tools, and 0 errors, 45 warnings and 261 infos from lint, with the counts of four lint codes explained in that file's header. `e2e/swagger2.e2e.ts` also reads the document, through the converter, so run it after regenerating the trim too. `e2e/curation-journey.e2e.ts` does not read it.)

## Official OpenAPI schemas (`oas/`)

The OpenAPI Initiative's own JSON Schemas for Swagger 2.0 and OpenAPI 3.0, 3.1 and 3.2, plus the JSON Schema meta-schemas they depend on (draft-04 for 2.0 and 3.0's own schema, 2020-12 for 3.1 and 3.2), vendored byte-for-byte and pinned by checksum. They are the source of truth for the schema-to-types parity story (every field in the official schema exists in our spec types, and our types add nothing the schema lacks) and for validating OpenAPI and Swagger documents. Unit tests never read them.

[`oas/sources.json`](./oas/sources.json) is the manifest, `{ "upstream": { ... }, "sources": [ ... ] }`:

- **`sources`** is a flat list of `{ id, version, kind, url, path, sha256 }` entries (152 today), where `path` is relative to `oas/`. The same format pins the OAI test documents below (kinds `document-pass` and `document-fail`, URLs at a fixed commit): each source is a URL, a path and a checksum.
- **`upstream`** says where the test documents came from, which the entries alone do not: `repository` (`OAI/OpenAPI-Specification`), `documents` (one row per pinned commit, `{ commit, version, ref?, folders, note? }`: `ref` is the OAI branch the commit was taken from, absent for a frozen pin such as the 2.0 examples, and `folders` are the folders taken from it) and `acknowledgedBranches` (development branches already known and deliberately not pinned). Verification checks that the table and the entries agree: every source on `raw.githubusercontent.com` is under a row's commit and one of its folders, and every row explains a source, so a pin moved without its row fails. `--latest` follows each `ref`. See [Maintaining OpenAPI Support](../../docs/maintaining-openapi-support.md#the-pinned-sources).

| File (under `oas/`) | Source | Pinned iteration | Retrieved | License | Size |
| ------------------- | ------ | ---------------- | --------- | ------- | ---- |
| `schemas/2.0/schema.json` | [Swagger 2.0 schema](https://spec.openapis.org/oas/2.0/schema/2017-08-27) (JSON Schema draft-04, `id` `http://swagger.io/v2/schema.json#`) | `2017-08-27` | 2026-11-17 | Apache-2.0 ([upstream LICENSE](https://github.com/OAI/OpenAPI-Specification/blob/e77481c73e1c703c7de2e4249047b42b8e9b56f4/LICENSE)) | ~40 KB |
| `schemas/3.0/schema.json` | [OAS 3.0 schema](https://spec.openapis.org/oas/3.0/schema/2024-10-18) (JSON Schema draft-04) | `2024-10-18` | 2026-11-17 | Apache-2.0 ([upstream LICENSE](https://github.com/OAI/OpenAPI-Specification/blob/main/LICENSE)) | ~36 KB |
| `schemas/3.1/schema.json` | [OAS 3.1 schema](https://spec.openapis.org/oas/3.1/schema/2026-11-05) | `2026-11-05` | 2026-11-17 | Apache-2.0 | ~33 KB |
| `schemas/3.1/schema-base.json` | [OAS 3.1 schema-base](https://spec.openapis.org/oas/3.1/schema-base/2026-11-05) | `2026-11-05` | 2026-11-17 | Apache-2.0 | ~0.7 KB |
| `schemas/3.1/dialect.json` | [OAS 3.1 dialect](https://spec.openapis.org/oas/3.1/dialect/2024-11-10) | `2024-11-10` | 2026-11-17 | Apache-2.0 | ~1 KB |
| `schemas/3.1/meta.json` | [OAS 3.1 meta](https://spec.openapis.org/oas/3.1/meta/2024-11-10) | `2024-11-10` | 2026-11-17 | Apache-2.0 | ~2 KB |
| `schemas/3.2/schema.json` | [OAS 3.2 schema](https://spec.openapis.org/oas/3.2/schema/2026-11-12) | `2026-11-12` | 2026-11-17 | Apache-2.0 | ~41 KB |
| `schemas/3.2/schema-base.json` | [OAS 3.2 schema-base](https://spec.openapis.org/oas/3.2/schema-base/2026-11-12) | `2026-11-12` | 2026-11-17 | Apache-2.0 | ~0.7 KB |
| `schemas/3.2/dialect.json` | [OAS 3.2 dialect](https://spec.openapis.org/oas/3.2/dialect/2026-02-26) | `2026-02-26` | 2026-11-17 | Apache-2.0 | ~1 KB |
| `schemas/3.2/meta.json` | [OAS 3.2 meta](https://spec.openapis.org/oas/3.2/meta/2026-02-26) | `2026-02-26` | 2026-11-17 | Apache-2.0 | ~2.5 KB |

All of the above are published by [OAI/OpenAPI-Specification](https://github.com/OAI/OpenAPI-Specification) and vendored unmodified, so no license text is reproduced (see [NOTICES.md](./NOTICES.md)). `schema` describes documents without validating Schema Objects; `schema-base` wraps it and also validates Schema Objects against the OAS dialect; `dialect` and `meta` are that dialect and its base vocabulary (3.1 and 3.2 only; 2.0 and 3.0 are single draft-04 schemas). The published 2.0 schema is byte-identical to `schemas/v2.0/schema.json` at commit `e77481c73e1c703c7de2e4249047b42b8e9b56f4` of that repository, the commit the 2.0 documents below are pinned to.

Two things to know when compiling the 2.0 schema. It `$ref`s fifteen JSON pointers into the draft-04 meta-schema by URL (`http://json-schema.org/draft-04/schema#/properties/title`, ...), so the meta-schema is vendored too (next section) and has to be registered under that URL. And Ajv's strict schema mode refuses it: `additionalItems` sits next to an `items` that is not an array (in `vendorExtension` and `parametersList`), where it does nothing, so compile with `strictSchema: false`.

### JSON Schema draft-04 meta-schema

The Swagger 2.0 schema `$ref`s the draft-04 meta-schema by URL, so it is pinned here as well. Ajv's own copy (`ajv-draft-04/dist/refs/json-schema-draft-04.json`) is not the official file (it adds `format: uri` to `id` and `$schema` and leaves out the `format` property), the same reason as for 2020-12 below. The URL is not dated, so the `sha256` in the manifest is the pin. At retrieval the file was byte-identical to `schema.json` of [json-schema-org/json-schema-spec](https://github.com/json-schema-org/json-schema-spec) at commit `dba92b702c94858162f653590230e7573c8b7dd0` (2017-10-15), which is the commit that [json-schema-org/website](https://github.com/json-schema-org/website) (the repository that serves json-schema.org) pins as its `_includes/draft-04` submodule at commit `a2d03f7db807a759aa6bc61a8792e5452dc996e8` (its `public/draft-04/schema` is a symlink to it), and to the head of the `draft-04` branch of the first repository (`955d185db846cfca84269d9d711b10f4f3353d38`).

| File (under `oas/`) | Source | Pinned URL | Retrieved | License | Size |
| ------------------- | ------ | ---------- | --------- | ------- | ---- |
| `schemas/json-schema-draft-04/schema.json` | [JSON Schema draft-04 meta-schema](https://json-schema.org/draft-04/schema) | `https://json-schema.org/draft-04/schema` | 2026-11-17 | BSD-3-Clause (or AFL-3.0; [upstream LICENSE](https://github.com/json-schema-org/website/blob/a2d03f7db807a759aa6bc61a8792e5452dc996e8/LICENSE)) | ~4.4 KB |

The `draft-04` branch carries no LICENSE file. The LICENSE of the website repository at the commit above (the repository that publishes the file) is the same text as the one of `json-schema-spec` cited for 2020-12 below (byte for byte, 11,739 bytes: the BSD 3-clause license followed by the AFL-3.0 text), so the file is redistributed unmodified under the BSD 3-clause option, whose notice is reproduced in [NOTICES.md](./NOTICES.md).

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

### OpenAPI Initiative test documents

The OAI's own schema test documents (and, for Swagger 2.0, its example documents), vendored byte-for-byte under `oas/documents/<version>/{pass,fail}/<name>.yaml` and pinned to a full commit SHA in the URL of each manifest entry (ids `oas-<version>-doc-<pass|fail>-<name>`, kinds `document-pass` / `document-fail`). OAI's own suite (`tests/schema/schema.test.mjs` on the 3.1 and 3.2 branches, `_archive_/schemas/v3.0/schema.test.mjs` on `main`) requires every `pass` document to validate against its schema and every `fail` document (3.1 and 3.2 only) to be rejected by `schema-base`. The official-documents story (`e2e/official-documents.e2e.ts`, with `e2e/helpers/oas-validate.ts`) repeats that check offline and then runs each document through our types, validator and generator. Unit tests never read them.

| Files (under `oas/documents/`) | Source | Pinned commit | Commit date | Retrieved | License | Count |
| ------------------------------ | ------ | ------------- | ----------- | --------- | ------- | ----- |
| `3.2/pass/*.yaml`, `3.2/fail/*.yaml` | [OAI/OpenAPI-Specification](https://github.com/OAI/OpenAPI-Specification) branch `v3.2-dev`, `tests/schema/pass` and `tests/schema/fail` | `6d86f6560681d0c461cd06b3faa80814aa120fda` | 2026-11-12 | 2026-11-17 | Apache-2.0 ([upstream LICENSE](https://github.com/OAI/OpenAPI-Specification/blob/main/LICENSE)) | 37 pass, 31 fail |
| `3.1/pass/*.yaml`, `3.1/fail/*.yaml` | same repository, branch `v3.1-dev`, `tests/schema/pass` and `tests/schema/fail` | `642ee90575f60233302ad3e82f9de83e02996532` | 2026-11-12 | 2026-11-17 | Apache-2.0 | 35 pass, 12 fail |
| `3.0/pass/*.yaml` | same repository, branch `main`, `_archive_/schemas/v3.0/pass` (the archive has no `fail` documents) | `4f86429f134f7e48b6351563549b4502fc69de52` | 2026-10-18 | 2026-11-17 | Apache-2.0 | 6 pass |
| `2.0/pass/*.yaml`, `2.0/pass/petstore-separate/**` | same repository, `examples/v2.0/yaml` (the Swagger 2.0 example documents; the folder was removed from this repository in `18bf2771eb98f19cdcb1c23d45d8c2a1f49a54d8`, "Remove examples folder", so the pin is its parent) | `e77481c73e1c703c7de2e4249047b42b8e9b56f4` | 2024-10-29 | 2026-11-17 | Apache-2.0 ([upstream LICENSE](https://github.com/OAI/OpenAPI-Specification/blob/e77481c73e1c703c7de2e4249047b42b8e9b56f4/LICENSE)) | 7 documents and the 5 files of the multi-file `petstore-separate` (12 files; no `fail` documents exist for 2.0) |

All are vendored unmodified, so no license text is reproduced (see [NOTICES.md](./NOTICES.md)). The 2.0 documents are the YAML variants of `api-with-examples`, `petstore`, `petstore-expanded`, `petstore-minimal`, `petstore-simple`, `petstore-with-external-docs` and `uber`, and the `petstore-separate` tree with its folders intact (`spec/swagger.yaml` is the root; it reaches `spec/Pet.yaml`, `spec/NewPet.yaml`, `spec/parameters.yaml#/tagsParam` and `common/Error.yaml` with relative `$ref`s, so it is read from disk, not from a string). Of the 2.0 documents, the eight that are whole documents (the seven and `petstore-separate/spec/swagger.yaml`) validate against the pinned official 2.0 schema; the other four files are fragments of the multi-file tree and are not documents. Only the first level of `2.0/pass/` holds single-file documents: `petstore-separate/` is a tree.

**Which source for the 2.0 documents.** The same 24 files (12 YAML, 12 JSON) are also published in [OAI/learn.openapis.org](https://github.com/OAI/learn.openapis.org) `examples/v2.0` (checked at its commit `5f26927b00d5d3d10c1a1a6bbe2d9b41b4a726e7`: every one of the 24 git blobs is identical to the one at `e77481c`), but that repository is licensed CC-BY-4.0, which asks for attribution, a link to the licence and a note of changes. The Apache-2.0 repository at the last commit before the folder was removed has the same bytes under the same licence as every other source here, so it is the pin; no CC-BY notice is needed. The JSON variants were not vendored. The `info.license` members inside the documents (MIT, Apache 2.0) describe the Petstore API they model, not these files.

One caveat for 3.1 and 3.2: OAI's source schemas carry `WORK-IN-PROGRESS` in their ids, and the 3.1 and 3.2 `pass/json_schema_dialect.yaml` document names that dialect, while the published schemas pinned above name the dated one. That document therefore fails the schema check as pinned; the story records it and proves it validates once the URI is replaced.

To move the pin of one branch: set the new full SHA in the `url` of its entries (every entry of that version and kind carries the same one), add the entries of new files and drop those of deleted files, then run `--update` and review the diff. Entries for a folder at a commit are generated with:

```bash
SHA=6d86f6560681d0c461cd06b3faa80814aa120fda VERSION=3.2 DIR=tests/schema KIND=pass   # KIND: pass | fail
gh api "repos/OAI/OpenAPI-Specification/git/trees/${SHA}?recursive=1" --jq '.tree[].path' \
  | grep -E "^${DIR}/${KIND}/[^/]+\.yaml$" | sort | node -e '
const [sha, version, kind] = process.argv.slice(1);
const files = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
console.log(JSON.stringify(files.map((file) => {
  const name = file.split("/").pop();
  return {
    id: `oas-${version}-doc-${kind}-${name.replace(/\.yaml$/, "")}`,
    version,
    kind: `document-${kind}`,
    url: `https://raw.githubusercontent.com/OAI/OpenAPI-Specification/${sha}/${file}`,
    path: `documents/${version}/${kind}/${name}`,
  };
}), null, 2));
' "$SHA" "$VERSION" "$KIND"
```

(`DIR` is `_archive_/schemas/v3.0` for 3.0. The 2.0 documents are not in a `pass` folder upstream: list `examples/v2.0/yaml` at the pin with `gh api "repos/OAI/OpenAPI-Specification/git/trees/e77481c73e1c703c7de2e4249047b42b8e9b56f4?recursive=1" --jq '.tree[].path' | grep -E '^examples/v2\.0/yaml/.+\.yaml$' | sort`; each file `examples/v2.0/yaml/<path>` goes to `documents/2.0/pass/<path>`, with an id `oas-2.0-doc-pass-<path without .yaml, `/` as `-`, lower case>`, for example `oas-2.0-doc-pass-petstore-separate-spec-swagger`.) Paste the printed entries into `oas/sources.json` (without `sha256`, which `--update` fills in), then run `node scripts/sync-oas-sources.mjs --update`. **When the pin moves, also update the story:** the literal document counts (`VERSIONS`) and the verdict table for FAIL documents (`VALIDATOR_VERDICTS`) in `e2e/official-documents.e2e.ts`, the pinned tools of each PASS document (`[name, method, path, readOnlyHint]`, in order, written from the document's operations under `paths`) in `e2e/expected/official-documents.json` (kept outside `oas/`, which the sync script treats as vendored upstream bytes only), and review `KNOWN_GAPS` (a gap that no longer fails, or a new failure, fails the story by design). Update the counts in the table above too.

### Regenerating and verifying

[`scripts/sync-oas-sources.mjs`](https://github.com/agentfront/mcp-from-openapi/blob/main/scripts/sync-oas-sources.mjs) downloads the pinned URLs, writes the exact response bytes, and rewrites the `sha256` values in the manifest:

```bash
node scripts/sync-oas-sources.mjs --update   # re-download every source, rewrite checksums
node scripts/sync-oas-sources.mjs            # offline: every file exists and matches its sha256, no unlisted files, the upstream table matches the entries
node scripts/sync-oas-sources.mjs --latest   # read-only, needs the network: what is NEWER upstream than what is pinned (exit 3 when something is)
```

To pin a newer iteration, change the entry's `url` (and its `path` only if the layout changes) in `oas/sources.json`, run `--update`, and review the diff. A redirect, a non-200 response, a body over 5 MB, or a host outside the script's allowlist (`spec.openapis.org`, `json-schema.org`, `raw.githubusercontent.com`) fails the update and writes nothing. `--update` downloads sequentially, one request per entry, and takes about 40 seconds for the full manifest. Files are written through a temp file and a rename, and a symlink at a destination is refused; OS metadata such as `.DS_Store` is ignored by the unlisted-file check.

## Supplementary documents (`supplementary/`)

Hand-written OpenAPI and Swagger documents, not vendored: they have no upstream, no pin and no entry in `oas/sources.json`, and `scripts/sync-oas-sources.mjs` never looks at the folder. They exist because the official test documents leave out, where a tool is built, constructs the library reads: `in: querystring`, a parameter defined with `content`, `itemSchema` in a response, named servers, an override by name and location, the `query` operation next to `additionalOperations`, and `$self` with the Security Requirement keys that are URIs. Each supplementary document gives one of them a place where a tool is made. [`supplementary/README.md`](./supplementary/README.md) lists every document and what it covers.

The folders are `supplementary/<version>/pass/` and `supplementary/<version>/invalid/`:

| Folder (under `supplementary/`) | Documents | Held to |
| ------------------------------- | --------- | ------- |
| `3.0/pass`, `3.1/pass`, `3.2/pass` | 2, 2 and 19 | The five checks of an official PASS document, with no known gap allowed: the official JSON Schema for its version (offline, `e2e/helpers/oas-validate.ts`), our `OAS30` / `OAS31` / `OAS32` types, our validator, the pinned tools, the pinned diagnostics |
| `3.1/invalid`, `3.2/invalid` | 3 and 2 | **Deliberately invalid** against the official schema of the declared version, to pin what the library does with what that version does not define (a `query` operation, an `in: querystring` parameter and `$self` in a 3.1 document, a parameter with both `schema` and `content`, a `$self` with a fragment). The story asserts the official schema rejects each one, then pins our validator's verdict, the tools, the diagnostics, and that nothing crashes |
| `2.0/pass` | 10 | **Swagger 2.0**, one construct each (no `host`, two `schemes`, `ws`/`wss` next to `https` in `schemes`, `collectionFormat` `tsv` and the other locations, a `type: file` response, a file upload whose `consumes` lists a urlencoded media type, `x-nullable`, a global body parameter used with two `consumes`, a global response used by an operation that overrides `produces`). Each validates against the official Swagger 2.0 schema pinned under `oas/schemas/2.0/` |
| `2.0/invalid` | 2 | Break the 2.0 *text*: a body parameter next to `formData` parameters (the official schema **accepts** it, it cannot see a rule across parameters) and a path parameter without `required: true` (the official schema **rejects** it). The verdict of the schema is recorded per document |

The story `e2e/official-documents.e2e.ts` runs them. Tools and facts (the whole-query entry, the media types of parameters defined with `content`, the streamed response, the server names) and diagnostics are pinned by hand in [`e2e/expected/supplementary-documents.json`](../expected/supplementary-documents.json), written from the document and the specification and then compared with the library's output: a difference is reported, never copied into the pin.

**Adding a document:** put it under `<version>/pass/` (or `invalid/`), keep it focused and realistic, give every operation an `operationId`, pin its tools and facts in `e2e/expected/supplementary-documents.json`, and update the literal counts in `SUPPLEMENTARY_VERSIONS` in the story and the counts in this section.

### The multi-file tree (`supplementary/multi-file/`)

One API described over 17 files, for `e2e/multi-file.e2e.ts`. It is not run through the five checks above (those read one document at a time, offline): the story reads it from disk, serves it from a loopback HTTP server and records every request, to pin what a relative `$ref` is read against for each way a document gets into the library (`fromFile`, `fromURL` with and without redirects, `fromJSON` / `fromYAML` with `documentUri`) and that `$self` names the document without moving a read. Hand-written, not vendored, and not in `oas/sources.json`.

```text
multi-file/
  openapi-3.0.yaml  openapi-3.1.yaml  openapi-3.2.yaml    the same root in each version: three path items by `$ref`
  paths/                  pets.yaml, pets-by-id.yaml, owners/owner.yaml (reaches back up with ../../)
  parameters/             PetId.yaml, OwnerId.yaml, paging/Limit.yaml
  schemas/                Pet.yaml and Owner.yaml (a cycle), NewPet.yaml, Error.yaml, Id.yaml
  responses/              PetList.yaml, Problem.yaml, NotFound.yaml
```

Three roots and 14 files they share (the files are version-neutral). Every root declares four tools (`getOwner`, `listPets`, `createPet`, `getPet`), and loading one reads 14 files, each once (15 requests when the root is fetched too). Each root is valid by the official schema of its version with its references unresolved. [`supplementary/README.md`](./supplementary/README.md) describes the tree; adding or removing a file changes the pinned list in the story on purpose.

### The equivalence API (`supplementary/equivalence/`)

One 10-operation API, the Lending Library, written five times with the same meaning: `swagger-2.0.yaml`, the same 2.0 API over 12 files (`swagger-2.0-split/`: shared parameters, responses and definitions in sibling files, reached by relative `$ref`s), and the hand-written OpenAPI `openapi-3.0.yaml`, `openapi-3.1.yaml` and `openapi-3.2.yaml` that a correct conversion produces. The 2.0 form uses every construct the conversion has to translate (`host`/`basePath`/`schemes`; global and operation-level `consumes` and `produces`; a JSON body parameter; a urlencoded form and a multipart upload with `type: file`; `collectionFormat` `csv`, `pipes` and `multi`; a header parameter; a path parameter at path-item level; global `parameters` and `responses`; `allOf`, an enum, a recursive schema and a string `discriminator`; response `headers` and `examples`; `basic`, `apiKey` in a header and in a query, and `oauth2` with `accessCode` and `application`). Every form is valid by the official schema of its version. [`supplementary/README.md`](./supplementary/README.md#the-equivalence-api-equivalence) has the operations, the construct-by-construct mapping and the exact list of what the five forms cannot say in the same way.
