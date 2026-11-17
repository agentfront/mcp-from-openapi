# Real-world spec corpus

A local survey: 38 public OpenAPI and Swagger documents (15 declaring OpenAPI 3.2, 8 declaring 3.1, 10 declaring 3.0, 5 Swagger 2.0; 32 production APIs, 4 examples, 2 test fixtures) are downloaded and run through the **built** library, one child process per attempt, to see what real documents do that inline test documents do not. It writes `results.json` and `REPORT.md` under `.spec-corpus/`.

- **Not a CI gate.** Nothing in CI runs it, nothing asserts on its results, and the numbers change with the library and with what you have downloaded. Use it after a change to loading, validation or generation, or when adding an OpenAPI version.
- **Nothing is redistributed.** No spec is committed. `.spec-corpus/` is git-ignored for everyone (`/.spec-corpus/` in `.gitignore`); [`sources.json`](./sources.json) only says where each document comes from, which commit, and what its licence is as far as anyone checked.

Maintainer's guide to where this fits: [Maintaining OpenAPI support](../../docs/maintaining-openapi-support.md#the-local-real-world-corpus).

## Download and run

```bash
corepack yarn build                                  # the runner loads <repo>/dist/index.js and nothing else
node scripts/spec-corpus/download.mjs                # about 160 MB; what is present and verified is skipped
node scripts/spec-corpus/run.mjs                     # all 38
node scripts/spec-corpus/run.mjs --version 3.1       # only specs declaring 3.1.x
```

**Cost.** Disk: 158 MB in 4,950 files under `.spec-corpus/specs/` (143 MB for the 38 root documents; the rest is the files the multi-file specs reach). A download from nothing took about four minutes and transferred 143 MB (the 3,624-file DigitalOcean tree is most of the requests; `msgraph-v1` alone is 43 MB). A full run takes one to two minutes and about 4 GB of memory for its largest document (`msgraph-v1`, which each child may use up to `--max-old-space-size=4096`); `--version 3.1` takes a few seconds.

### `download.mjs`

| Flag | Meaning |
| ---- | ------- |
| `--slug a,b` | only these specs |
| `--version 3.1` | only specs declaring 3.1.x (`3.2`, `3.0`, `2.0`) |
| `--kind production` | only `production`, `example` or `test-fixture` |
| `--max-total-mb N` | stop when this run has downloaded more than N MB (default 400) |
| `--update` | download the selected specs again and **rewrite** their size, checksum and tree digest in `sources.json` (see "Adding a spec") |

Each spec is checked against the size and sha256 in `sources.json` and skipped when it is already present and matches; a present spec that does not match is downloaded again. A multi-file spec (`tree` in `sources.json`) is the root document plus every file its relative `$ref`s reach, crawled at the pinned commit and laid out as in the repository; the result must have the recorded file count, byte count and digest (the sha256 of the lines `<sha256 of file>  <path>` of every file, sorted by path). Fetching is https only, from `raw.githubusercontent.com`, `gitlab.com`, `api.elevenlabs.io` and `developer.atlassian.com`; redirects are followed by hand and every hop is held to the same rules; one file is at most 60 MB; a symlink in the way is refused; and a downloaded document is only ever parsed as data (JSON, or YAML to find `$ref`s), never executed or imported. A tree is written to a new folder next to its place and read back from disk, and must hold exactly the recorded file count, byte count and digest before it replaces the previous copy; a single file is read back too. A tree that cannot be laid out as in the repository fails its spec (exit 1): two paths that differ only in letter case (or Unicode form) would be one file on macOS or Windows, and a referenced file whose whole content is one short string is how a symbolic link in the repository is served, so it is refused rather than kept as a document. A `$ref` that leaves the repository, or names a path with a backslash or `..` segments, is not followed (`--update` prints a note). `SPEC_CORPUS_DIR=<dir>` downloads into `<dir>` instead of `.spec-corpus/` (the runner reads the same variable).

Two entries are **live endpoints** with no commit to pin (`elevenlabs-api`, `jira-cloud-platform`; Atlassian's file embeds a build hash in `info.version`). They change under you: when the bytes differ from `sources.json` the file is kept and reported as `changed`, and the run still succeeds. `--update --slug <slug>` records the new bytes. Every other spec is pinned to a commit, so a mismatch is an error.

### `run.mjs`

| Flag | Meaning |
| ---- | ------- |
| `--slug a,b`, `--version 3.1`, `--kind production` | which specs |
| `--timeout 60` | seconds before an attempt is killed (default 120) |
| `--no-build` | never rebuild `dist/` when a module cannot be found (otherwise it runs `corepack yarn build` once) |
| `--no-verify` | run specs whose bytes do not match `sources.json` (for a local experiment on an edited document); by default such a spec is skipped |
| `--report-only` | rebuild `REPORT.md` from the existing `results.json` |
| `--results name.json` | write to another file in `.spec-corpus/` instead of `results.json` |
| `--no-report` | do not write `REPORT.md` |
| `--request-limit N` | build a request (`buildHttpRequest`) for the first N tools of each spec (default 200) |

Before a spec runs, its bytes are checked against `sources.json` with the code `download.mjs` verifies with (`integrity.mjs`): the sha256 of the root document and, for a multi-file spec, the file count, byte count and digest of its folder. A spec that does not match is reported as `HASH MISMATCH`, **skipped** (its previous result stays), and the run exits 1; a live endpoint that now serves other bytes (`elevenlabs-api`, `jira-cloud-platform`) is such a spec until `download.mjs --update --slug <slug>` records them. A filtered run **merges** into the existing `results.json`, so the other specs keep their last result. Each attempt is `OpenAPIToolGenerator.fromFile(<path>, options)` in a child process started in a scratch directory (not the spec's folder: relative `$ref`s are read against the file's own location). Attempts per spec: `default`; if that throws, `validate: false`; for a multi-file spec also `local-refs` (`refResolution.allowedProtocols: ['file', 'http', 'https']`, because reading sibling files needs `file`, which is not allowed by default) and, if that throws, `local-refs+validate: false`. No HTTP request is sent by the runner; `buildHttpRequest` only assembles. A spec with remote `https` `$ref`s makes the library fetch them.

**Trust.** The `local-refs` attempts allow `file` references, and the library does not confine them to the spec's folder: a multi-file spec whose `$ref` names an absolute path can make the run read any file the process can read (the content can then appear in a generated tool, in `results.json` or in the report). The checksum in `sources.json` only proves the bytes are the ones recorded, not that they are harmless. Add a multi-file spec only after reading its references, and run a corpus you have not reviewed in a sandbox.

What the report holds: per spec the tools generated against the operations the document declares (counted independently, by `stats.mjs`, which reads only regular files below the spec's own folder or file: a `$ref` to an absolute path, `..`, a symlink, a device or a file over 64 MB is an unresolved reference there), validation outcome, diagnostics, console warnings, how many sampled requests built, time and peak memory; and findings grouped by root cause. Write your own notes in `.spec-corpus/findings.md` and they are appended on the next `--report-only`.

## Files

| File | What |
| ---- | ---- |
| `sources.json` | The specs: slug, title, declared version, kind, format, licence as recorded, file (below `.spec-corpus/`), size and sha256 of the root document, `url` (pinned to `commit` of `repo` where it is a git host), and for a multi-file spec `tree` (`root`, `files`, `bytes`, `sha256`) |
| `download.mjs` | Downloads and verifies |
| `integrity.mjs` | What the corpus must look like on disk (the size and sha256 of a file, the digest of a tree, symlink-refusing paths); shared by `download.mjs` and `run.mjs` |
| `run.mjs` | The runner and the report |
| `child.mjs` | One attempt in its own process; requires the library only from `dist/index.js` |
| `stats.mjs`, `docstats.mjs` | Count the operations of a document as data, independently of the library |

## Adding a spec

1. Add an entry to `sources.json` with what cannot be computed: `slug` (lower case, letters, digits, `.` and `-`), `kind` (`production`, `example` or `test-fixture`), `licence` (what the repository says; write `unknown (...)` and why when nothing is stated), `url` (for a git host, the raw file URL **at a full commit** and `repo` and `commit`; a live endpoint has no commit and drifts), and for a multi-file spec `tree: { "root": "<path of the root document in the repository>" }` with a `url` that is the raw URL of that root. No `file`: it is filled in.
2. `node scripts/spec-corpus/download.mjs --update --slug <slug>` downloads it, and fills in the title, declared version, format, file, size, sha256 and, for a tree, its file count, byte count and digest. The file is `specs/<major.minor of the declared version>/<slug>.<json|yaml>`, or for a tree `specs/<major.minor>/<slug>/<path of the root below the common folder of the crawled files>`. A tree whose files cannot be laid out as in the repository (see above) fails here. Check the diff of `sources.json`.
3. `node scripts/spec-corpus/run.mjs --slug <slug>`.
4. Commit `sources.json` only. Never a downloaded document.

To move a pin, change `commit` and the commit in `url` (and `tree.root` if the path moved) and run `--update --slug <slug>`.

## Licences

The documents belong to their authors and keep their own licences. The recorded licence is what the first survey found: 16 of the 38 are MIT, 10 Apache-2.0, 1 BSD-3-Clause, 1 GPL-3.0 (`openproject-apiv3`), 1 CC-BY-4.0 (`oai-learn-3.2-query-example`) and 9 are `unknown` (no licence file, GitHub reports none, or a live endpoint that states none). That is why nothing is vendored: the script downloads onto your machine for your use, the way `curl` would, and the repository holds pointers and checksums. The `gitlab-api-v2` entry carries a `note`: its licence is recorded as MIT, but the description lives under `doc/`, which GitLab licenses under CC BY-SA 4.0. Do not copy a corpus document into the repository, into a test, or into an issue; when one is needed as a regression case, write a minimal document of your own (or use one of `e2e/fixtures/supplementary/`) that shows the same construct.
