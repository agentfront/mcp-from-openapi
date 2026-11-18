# Releasing

How a version of `mcp-from-openapi` reaches npm, and the repository and npm settings the release workflows rely on. For maintainers.

## The flow

```text
release/X.Y.x ──(1) Prepare Release──▶ pull request release-pr/vX.Y.Z → release/X.Y.x
                                         │ change: package.json version + CHANGELOG.md entry
                                         │ description: the release notes
                                         ▼
                              (2) review and edit, CI runs
                                         ▼
                              (3) merge ──▶ Publish Release (push to release/X.Y.x)
                                              detect → build → publish (approve `release`) → release
```

1. **Prepare.** Run **Prepare Release** (`prepare-release.yml`) from the `release/X.Y.x` branch (Actions → Prepare Release → Run workflow, choose the branch). It computes the next version from the tags of the line (`scripts/compute-next-patch.mjs`), writes the release notes (a model call for a stable release, a plain installation note for an `rc` or `beta`), and opens a pull request from `release-pr/vX.Y.Z` into the release branch:
   - its **change** is the version in `package.json` and, for a stable release, the `CHANGELOG.md` entry;
   - its **description** is the release notes, and its **title** (`chore(release): vX.Y.Z — <headline>`) the release name without the `chore(release): ` prefix.

   With **Dry run** it opens nothing: the version and the notes are in the run summary. Running it again for the same version replaces the branch and updates the open pull request.
2. **Review.** Read and edit the description and the title: they are published as they are when the pull request is merged. The `CHANGELOG.md` entry is part of the diff, so it is reviewed like code. CI runs on the pull request (the prepare workflow starts it, since a pull request opened by a workflow starts none by itself).
3. **Merge.** Merging pushes to the release branch, which runs **Publish Release** (`publish-release.yml`):
   - `detect` finds the merged pull request `release-pr/v<package.json version>` of this repository for the pushed commit. Any other push to a release branch stops here, as does a version already tagged.
   - `build` typechecks, tests, builds and packs `dist/` into a tarball. It installs and runs the dependencies, and it can neither publish nor write.
   - `publish` waits for an approval of the `release` environment, then publishes that tarball with `npm publish --provenance`, authenticated by GitHub's OIDC token. It has no checkout, no install and no build, and it runs no repository code.
   - `release` tags the merge commit `vX.Y.Z` and creates the GitHub release from the merged pull request: its title is the release name, its description the notes (a pre-release is marked so).

The npm dist-tag follows the version: `latest` for `X.Y.Z`, `rc` for `X.Y.Z-rc.N`, `beta` for `X.Y.Z-beta.N`. A tag never moves back to an older version: when it already names a newer one (a patch of an older release line, or a run approved after a later one), the version is published with its line's tag instead, such as `latest-2.8`, and when that one does too, with its own, such as `latest-2.8.3`.

A new release line starts with **Create release branch** (`create-release-branch.yml`), which makes `release/X.Y.x` from `main` at version `X.Y.0`. The first Prepare Release on it releases `X.Y.0`.

Release pull requests are not cherry-picked to `main` (`cherry-pick-prompt.yml` skips a head branch starting with `release-pr/`); other pull requests merged into a release branch still are.

## When something fails

- **Prepare** fails before the pull request exists: fix the cause and run it again.
- **Publish** fails: rerun the failed jobs of the run. Each step is safe to repeat: `publish` skips a version npm already has, and `release` skips a release that exists.
- **Wrong notes after the release:** edit the GitHub release. The `CHANGELOG.md` entry is changed by a normal pull request.
- **Abandon a release:** close the pull request and delete its `release-pr/` branch. Nothing was published.

## One-time settings

### npm (package settings on npmjs.com)

1. **Trusted publisher** (Settings → Trusted publishing → GitHub Actions):
   - Organization or user: `agentfront`
   - Repository: `mcp-from-openapi`
   - Workflow filename: `publish-release.yml`
   - Environment name: `release`

   The workflow file name and the environment must stay as they are, or npm refuses the OIDC token.
2. **Publishing access:** once a release has been published through the trusted publisher, choose *Require two-factor authentication and disallow tokens*, and revoke any automation token that was used for this package.

### GitHub (repository settings)

1. **Environment `release`** (Settings → Environments):
   - required reviewers: the maintainers who may approve a publish, with *Prevent self-review* if more than one;
   - deployment branches: selected branches matching `release/*.*.x` only (no `refs/pull/*`);
   - *Allow administrators to bypass configured protection rules* turned off.
2. **Environment `release-branch`**, used by Create release branch, which runs from `main`: required reviewers, deployment branches `main` only. It is created by the first run if it does not exist yet, without protection, so create it first.
3. **Branch protection** (a ruleset for `main` and `release/*.*.x`): pull request required, required status checks (the `Build & Test` jobs and `Public type compatibility`), no force push, no deletion.
4. **Actions** (Settings → Actions → General → Workflow permissions): *Allow GitHub Actions to create and approve pull requests* turned on, which the prepare and cherry-pick workflows need.
5. **Secrets:** `OPENAI_API_KEY` for the release notes. Delete `NPM_TOKEN`: no workflow reads it, and publishing uses the trusted publisher.

## Permissions at a glance

| Workflow | Job | Permissions | Secrets |
| --- | --- | --- | --- |
| Prepare Release | `notes` | `contents: read` | `OPENAI_API_KEY` |
| Prepare Release | `pull-request` | `contents: write`, `pull-requests: write`, `actions: write` | none |
| Publish Release | `detect` | `contents: read`, `pull-requests: read` | none |
| Publish Release | `build` | `contents: read` | none |
| Publish Release | `publish` (environment `release`) | `id-token: write` | none |
| Publish Release | `release` | `contents: write`, `pull-requests: read` | none |
