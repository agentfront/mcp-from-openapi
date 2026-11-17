#!/usr/bin/env node
/**
 * Verifies, re-downloads, or looks for newer versions of the pinned official OpenAPI sources vendored under
 * e2e/fixtures/oas/.
 *
 * The manifest e2e/fixtures/oas/sources.json is { "upstream"?: {...}, "sources": [...] }. `sources` is a flat list of
 * { id, version, kind, url, path, sha256 } entries; `path` is relative to e2e/fixtures/oas/. The optional `upstream`
 * table records, for each commit the OAI test documents are pinned to, the branch it came from and the folders
 * taken from it (see docs/maintaining-openapi-support.md); only --latest reads the branch.
 *
 * Usage:
 *   node scripts/sync-oas-sources.mjs            # offline: every listed file exists and matches its sha256,
 *                                                #          and no unlisted file sits under e2e/fixtures/oas/
 *   node scripts/sync-oas-sources.mjs --update   # download every url, write the bytes, rewrite the sha256 values
 *   node scripts/sync-oas-sources.mjs --latest   # read-only, needs network: report what is NEWER upstream than
 *                                                #          what is pinned (add --json for machines)
 *
 * Verification needs no network. --update downloads everything before it writes anything, so a failed
 * download leaves the tree and the manifest untouched. Each file is then written to a temp file and renamed
 * into place; a symlink at the destination (or in its directory chain) is refused.
 *
 * Downloads are limited to ALLOWED_HOSTS, never follow redirects, and are capped at MAX_BYTES each.
 *
 * --latest writes nothing. It asks, with the same redirect and size rules (and api.github.com added to the hosts,
 * for the branches, tags and folder trees of the OAI repository):
 *   - the index https://spec.openapis.org/oas/: a later dated iteration of a pinned schema, schema-base, dialect or
 *     meta, and any OpenAPI version directory (or specification text) that is not pinned at all;
 *   - the pinned OAI branches: head moved AND the files under the pinned folders differ (git tree comparison), or the
 *     branch no longer exists (a finding of its own kind, `branch-gone`, not an error);
 *   - the release tags newer than the newest pinned version, and `v<major>.<minor>-dev` branches of versions that
 *     have no pinned sources (unless listed in `upstream.acknowledgedBranches`).
 * JSON Schema meta-schemas are frozen and are not checked. GITHUB_TOKEN, when set, is sent to api.github.com only.
 * `--manifest <file>` reads another manifest (for a doctored copy); nothing else changes.
 *
 * Exit code: 0 on success (--latest: nothing is newer), 1 on any mismatch, invalid manifest, download failure or
 * failed request (a rate limited GitHub API included), 3 with --latest when something is newer.
 */

import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../e2e/fixtures/oas/', import.meta.url));
const MANIFEST = 'sources.json';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(['spec.openapis.org', 'json-schema.org', 'raw.githubusercontent.com']);
/** Hosts --latest may ask: the download hosts, plus the GitHub API (read-only listings of one repository). */
const GITHUB_API_HOST = 'api.github.com';
const LATEST_HOSTS = new Set([...ALLOWED_HOSTS, GITHUB_API_HOST]);
const SPEC_INDEX_URL = 'https://spec.openapis.org/oas/';
const USER_AGENT = 'sync-oas-sources';
/** Exit code of --latest when something is newer, apart from 1 (an error). */
const EXIT_NEWER = 3;
/** OS metadata that may appear next to vendored files; ignored by the "unlisted file" check. */
const OS_METADATA = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** A branch name safe to put in a URL path (no `..`, no empty segment; checked again in `refProblem`). */
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const FOLDER_NAME = /^[A-Za-z0-9._/-]+$/;
const MAJOR_MINOR = /^\d+\.\d+$/;

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const USAGE = [
  'Usage: sync-oas-sources.mjs [--update | --latest [--json] [--manifest <file>]]',
  '  (no flag): verify the vendored files against the manifest, offline',
  '  --update:  re-download every source and rewrite the manifest checksums',
  `  --latest:  report what is newer upstream than what is pinned (network, writes nothing); exit 0 nothing newer,`,
  `             ${EXIT_NEWER} something newer, 1 error. --json prints the report as JSON; --manifest reads another manifest`,
];

/** Reads the command line; anything but one of the documented forms is a usage error. */
function parseArgs(argv) {
  const options = { mode: 'verify', json: false, manifest: null };
  let modeSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--update' || arg === '--latest') {
      if (modeSeen) fail(...USAGE);
      modeSeen = true;
      options.mode = arg.slice(2);
    } else if (arg === '--json' && !options.json) {
      options.json = true;
    } else if (arg === '--manifest' && options.manifest === null && i + 1 < argv.length) {
      options.manifest = path.resolve(argv[++i]);
    } else {
      fail(...USAGE);
    }
  }
  if ((options.json || options.manifest !== null) && options.mode !== 'latest') fail(...USAGE);
  return options;
}

const options = parseArgs(process.argv.slice(2));
const update = options.mode === 'update';
const latest = options.mode === 'latest';

/** Returns a problem description for an invalid manifest `path`, or null when it is a safe relative path. */
function pathProblem(p) {
  if (typeof p !== 'string' || p === '') return 'must be a non-empty string';
  if (p.includes('\\') || p.includes('\0')) return 'must not contain backslashes or NUL';
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) return 'must be relative';
  if (p.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'must not contain empty, "." or ".." segments';
  }
  if (p === MANIFEST) return `must not be the manifest itself (${MANIFEST})`;
  return null;
}

async function loadManifest(file = path.join(ROOT, MANIFEST)) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read ${MANIFEST}: ${error.message}`);
  }
  if (!manifest || !Array.isArray(manifest.sources)) fail(`${MANIFEST}: expected { "sources": [...] }`);

  const errors = [];
  const ids = new Set();
  const paths = new Set();
  manifest.sources.forEach((entry, index) => {
    const label = `${MANIFEST} sources[${index}]${entry && typeof entry.id === 'string' ? ` (${entry.id})` : ''}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: must be an object`);
      return;
    }
    for (const key of ['id', 'version', 'kind', 'url', 'path']) {
      if (typeof entry[key] !== 'string' || entry[key] === '') errors.push(`${label}: "${key}" must be a non-empty string`);
    }
    // A new entry may omit sha256 until its first --update; verification always requires it.
    const hash = entry.sha256;
    if (!(update && hash === undefined) && (typeof hash !== 'string' || !SHA256.test(hash))) {
      errors.push(`${label}: "sha256" must be 64 lowercase hex characters`);
    }
    if (typeof entry.url === 'string' && entry.url !== '') {
      let url = null;
      try {
        url = new URL(entry.url);
      } catch {
        errors.push(`${label}: "url" is not a valid URL`);
      }
      if (url && url.protocol !== 'https:') errors.push(`${label}: "url" must use https (got ${url.protocol})`);
      else if (url && (url.username || url.password || !ALLOWED_HOSTS.has(url.host))) {
        errors.push(`${label}: "url" host must be one of ${[...ALLOWED_HOSTS].join(', ')} (no credentials or port)`);
      }
    }
    if (typeof entry.path === 'string') {
      const problem = pathProblem(entry.path);
      if (problem) errors.push(`${label}: "path" ${problem}`);
    }
    if (ids.has(entry.id)) errors.push(`${label}: duplicate id`);
    if (paths.has(entry.path)) errors.push(`${label}: duplicate path ${entry.path}`);
    ids.add(entry.id);
    paths.add(entry.path);
  });
  if (manifest.upstream !== undefined) errors.push(...upstreamProblems(manifest.upstream, manifest.sources));
  if (errors.length > 0) fail(...errors);
  return manifest;
}

/** Why a branch name from the manifest cannot be used in a request, or null. */
function refProblem(ref) {
  if (typeof ref !== 'string' || !REF_NAME.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock')) {
    return 'must be a plain branch name (letters, digits, ".", "_", "-" and "/")';
  }
  return null;
}

/**
 * Problems with the optional `upstream` table, which names the branch and folders each commit of the OAI test documents
 * was taken from: { repository, documents: [{ commit, version, ref?, folders, note? }], acknowledgedBranches? }.
 * A row without `ref` is frozen (nothing to follow). Every source on raw.githubusercontent.com must be explained by a row
 * (same repository, commit and version, under one of its folders), and every row must explain one, so moving a pin
 * without the table fails verification.
 */
function upstreamProblems(upstream, sources) {
  const label = `${MANIFEST} upstream`;
  const errors = [];
  if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream)) return [`${label}: must be an object`];
  if (typeof upstream.repository !== 'string' || !REPOSITORY.test(upstream.repository)) {
    errors.push(`${label}: "repository" must be "<owner>/<name>"`);
  }
  if (!Array.isArray(upstream.documents)) errors.push(`${label}: "documents" must be an array`);
  if (upstream.acknowledgedBranches !== undefined) {
    const list = upstream.acknowledgedBranches;
    if (!Array.isArray(list) || list.some((name) => refProblem(name) !== null)) {
      errors.push(`${label}: "acknowledgedBranches" must be an array of plain branch names`);
    }
  }
  if (errors.length > 0 || !Array.isArray(upstream.documents)) return errors;

  const commits = new Map();
  upstream.documents.forEach((row, index) => {
    const where = `${label}.documents[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    if (typeof row.commit !== 'string' || !COMMIT.test(row.commit)) errors.push(`${where}: "commit" must be 40 lowercase hex characters`);
    else if (commits.has(row.commit)) errors.push(`${where}: duplicate commit ${row.commit}`);
    else commits.set(row.commit, { row, used: false });
    if (typeof row.version !== 'string' || !MAJOR_MINOR.test(row.version)) errors.push(`${where}: "version" must be "<major>.<minor>"`);
    if (row.ref !== undefined && refProblem(row.ref) !== null) errors.push(`${where}: "ref" ${refProblem(row.ref)}`);
    if (row.note !== undefined && typeof row.note !== 'string') errors.push(`${where}: "note" must be a string`);
    if (!Array.isArray(row.folders) || row.folders.length === 0) errors.push(`${where}: "folders" must be a non-empty array`);
    else {
      for (const folder of row.folders) {
        const problem = pathProblem(folder) ?? (FOLDER_NAME.test(folder) ? null : 'may only use letters, digits, ".", "_", "-" and "/"');
        if (problem) errors.push(`${where}: folder ${JSON.stringify(folder)} ${problem}`);
      }
    }
  });
  if (errors.length > 0) return errors;

  const unexplained = new Map();
  for (const entry of sources) {
    const raw = entry && typeof entry === 'object' ? rawGitHubFile(entry.url) : null;
    if (raw === null) continue;
    const where = `${MANIFEST} (${entry.id})`;
    const hit = commits.get(raw.commit);
    if (raw.repository !== upstream.repository || !hit) {
      const key = `${raw.repository} at ${raw.commit}`;
      unexplained.set(key, [...(unexplained.get(key) ?? []), entry.id]);
      continue;
    }
    hit.used = true;
    if (hit.row.version !== entry.version) errors.push(`${where}: version ${entry.version}, but the row of ${raw.commit} says ${hit.row.version}`);
    if (!hit.row.folders.some((folder) => raw.file.startsWith(`${folder}/`))) {
      errors.push(`${where}: ${raw.file} is not under a folder of the row of ${raw.commit}`);
    }
  }
  for (const [key, ids] of unexplained) {
    errors.push(`${MANIFEST}: ${ids.length} source(s) (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', ...' : ''}) come from ${key}, which has no row in ${label}.documents`);
  }
  for (const [commit, { used }] of commits) {
    if (!used) errors.push(`${label}: the row of ${commit} matches no source`);
  }
  return errors;
}

/** { repository, commit, file } of a raw.githubusercontent.com URL pinned to a full commit; null for any other URL. */
function rawGitHubFile(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.host !== 'raw.githubusercontent.com') return null;
  const [owner, name, commit, ...rest] = url.pathname.split('/').filter((_, index) => index > 0);
  return { repository: `${owner}/${name}`, commit: commit ?? '', file: rest.join('/') };
}

/** Every file under ROOT (POSIX-style relative paths), excluding the manifest. */
async function listVendoredFiles() {
  const entries = await readdir(ROOT, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((file) => file !== MANIFEST && !OS_METADATA.test(path.posix.basename(file)))
    .sort();
}

async function verify(manifest) {
  const problems = [];
  for (const entry of manifest.sources) {
    let bytes;
    try {
      bytes = await readFile(path.join(ROOT, entry.path));
    } catch (error) {
      problems.push(`${entry.path}: ${error.code === 'ENOENT' ? 'missing' : error.message}`);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== entry.sha256) problems.push(`${entry.path}: sha256 mismatch (expected ${entry.sha256}, got ${actual})`);
  }
  const listed = new Set(manifest.sources.map((entry) => entry.path));
  for (const file of await listVendoredFiles()) {
    if (!listed.has(file)) problems.push(`${file}: not listed in ${MANIFEST}`);
  }
  if (problems.length > 0) fail(...problems, `${problems.length} problem(s); fix the files or run with --update`);
  console.log(`${manifest.sources.length} sources verified`);
}

/** The whole body of `response`, refusing more than MAX_BYTES. */
async function readCapped(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`response exceeds ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function download(entry) {
  // Redirects are not followed: a pinned URL that starts redirecting is a change to review, not to absorb.
  const response = await fetch(entry.url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status !== 200) {
    const location = response.headers.get('location');
    throw new Error(`HTTP ${response.status}${location ? ` redirecting to ${location}` : ''}`);
  }
  const bytes = await readCapped(response);
  if (entry.path.endsWith('.json')) {
    try {
      JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new Error(`response is not valid JSON (${error.message})`);
    }
  }
  return bytes;
}

/** Creates the directory for `file` and returns its real path; refuses a symlink at `file` or between ROOT and it. */
async function prepareTarget(file) {
  await mkdir(path.dirname(file), { recursive: true });
  // The real directory must be where the lexical path says it is, so no symlink sits between ROOT and the file.
  const dir = await realpath(path.dirname(file));
  if (dir !== path.join(await realpath(ROOT), path.relative(ROOT, path.dirname(file)))) {
    throw new Error(`${file}: a parent directory is a symlink`);
  }
  const existing = await lstat(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error(`${file}: is a symlink; refusing to write through it`);
  return dir;
}

/** Writes `bytes` to `file` via a temp file + rename, so an interrupted write never leaves a half-written file. */
async function writeAtomic(file, bytes) {
  const tmp = path.join(await prepareTarget(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function updateSources(manifest) {
  const downloaded = [];
  const problems = [];
  for (const entry of manifest.sources) {
    try {
      downloaded.push(await download(entry));
    } catch (error) {
      const reason = error.cause?.message ? `${error.message}: ${error.cause.message}` : error.message;
      problems.push(`${entry.url}: ${reason}`);
    }
  }
  if (problems.length > 0) fail(...problems, `${problems.length} download(s) failed; nothing was written`);

  // Check every destination before writing any, so a refused symlink leaves the tree untouched.
  for (const entry of manifest.sources) await prepareTarget(path.join(ROOT, entry.path));
  await prepareTarget(path.join(ROOT, MANIFEST));

  const sources = [];
  for (const [index, entry] of manifest.sources.entries()) {
    await writeAtomic(path.join(ROOT, entry.path), downloaded[index]);
    sources.push({ ...entry, sha256: sha256(downloaded[index]) });
  }
  await writeAtomic(path.join(ROOT, MANIFEST), Buffer.from(`${JSON.stringify({ ...manifest, sources }, null, 2)}\n`));
  console.log(`${sources.length} sources updated`);
}

// ---------------------------------------------------------------------------------------------------------------
// --latest: what is newer upstream than what is pinned. Reads only; the answer is the exit code and the report.
// ---------------------------------------------------------------------------------------------------------------

/** Longest list of names in one finding, and most findings of one type; the rest is counted, not listed. */
const MAX_LISTED = 20;
const MAX_FINDINGS = 50;
/**
 * The compact JSON of the report stays under this many bytes: the weekly workflow keeps it in one environment variable (at most
 * 128 KiB on Linux), and the issue is built from it. What does not fit is counted in `omitted`, never dropped silently. A
 * part of the budget is kept back for `checked` and `omitted`.
 */
const MAX_REPORT_BYTES = 48 * 1024;
const RESERVED_BYTES = 2 * 1024;
const MAX_PAGES = 10;
const PER_PAGE = 100;
/** A pinned dated iteration: https://spec.openapis.org/oas/<version>/<kind>/<date>. */
const PINNED_ITERATION = /^https:\/\/spec\.openapis\.org\/oas\/(\d+\.\d+)\/([a-z][a-z-]*)\/(\d{4}-\d{2}-\d{2})$/;
/** The same links on the index page, with or without the `.html` of the rendered page. */
const INDEX_ITERATION = /href=["']\/oas\/(\d+\.\d+)\/([a-z][a-z-]*)\/(\d{4}-\d{2}-\d{2})(?:\.html)?["']/g;
/** A specification text on the index page (`v2.0.html`, `v3.2.1.html`, `v3.3.0-rc0.html`). */
const INDEX_SPEC_TEXT = /href=["']\/oas\/v((\d+\.\d+)(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\.html["']/g;
const RELEASE_TAG = /^refs\/tags\/(\d+)\.(\d+)\.\d+(-rc\d+)?$/;
const DEV_BRANCH = /^refs\/heads\/(v(\d+)\.(\d+)-dev)$/;
const FINDING_ORDER = ['schema-iteration', 'unpinned-version', 'documents-changed', 'branch-gone', 'release-tag', 'dev-branch'];

/** A response other than 200; `status` tells a folder that is gone (404) from a failure. */
class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * Text that came from upstream, with anything outside a plain character set written as \u{...}, cut so that the RESULT is at
 * most `max` characters (and `...` when it was cut): an escaped character is longer than the one it replaces.
 */
function safeText(value, max = 200) {
  let out = '';
  for (const char of String(value)) {
    const piece = /^[A-Za-z0-9._:/ -]$/u.test(char) ? char : `\\u{${char.codePointAt(0).toString(16)}}`;
    if (out.length + piece.length > max) return `${out}...`;
    out += piece;
  }
  return out;
}

function compareVersions(a, b) {
  const [aMajor, aMinor] = a.split('.').map(Number);
  const [bMajor, bMinor] = b.split('.').map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

/** The first `MAX_LISTED` names and how many there are. */
function listed(names) {
  const sorted = [...names].sort().map((name) => safeText(name));
  return { count: sorted.length, names: sorted.slice(0, MAX_LISTED) };
}

/** The error for a response that is not a 200, saying what to do about a rate limited GitHub API. */
function requestError(url, response, token) {
  if (url.host === GITHUB_API_HOST) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');
    if ((response.status === 403 || response.status === 429) && (remaining === '0' || retryAfter !== null)) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const when =
        retryAfter !== null && Number.isFinite(Number(retryAfter))
          ? `retry after ${Number(retryAfter)} s`
          : reset > 0
            ? `the limit resets at ${new Date(reset * 1000).toISOString()}`
            : 'try again later';
      return new Error(
        `GitHub API rate limit reached (${token ? 'with GITHUB_TOKEN' : 'unauthenticated'}); ${when}.` +
          (token ? '' : ' Set GITHUB_TOKEN (no scopes are needed for a public repository) to raise the limit.'),
      );
    }
    if (response.status === 401) return new Error('GitHub rejected GITHUB_TOKEN (HTTP 401): unset it or use a valid token');
  }
  const location = response.headers.get('location');
  return new HttpError(
    `${url.host}${url.pathname}: HTTP ${response.status}${location ? ` redirecting to ${safeText(location)}` : ''}`,
    response.status,
  );
}

/**
 * GET with the rules of --update (https, an allowed host, no redirect followed, MAX_BYTES at most) and the GitHub
 * API added to the hosts. GITHUB_TOKEN goes to api.github.com and nowhere else.
 */
async function fetchLatest(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !LATEST_HOSTS.has(url.host)) {
    throw new Error(`${url.origin}: host not allowed (allowed: ${[...LATEST_HOSTS].join(', ')})`);
  }
  const token = (process.env.GITHUB_TOKEN ?? '').trim();
  const headers = { 'user-agent': USER_AGENT };
  if (url.host === GITHUB_API_HOST) {
    headers.accept = 'application/vnd.github+json';
    headers['x-github-api-version'] = '2022-11-28';
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw requestError(url, response, token);
  }
  return readCapped(response).catch((error) => {
    throw new Error(`${url.host}${url.pathname}: ${error.message}`);
  });
}

async function githubJson(pathname) {
  const bytes = await fetchLatest(`https://${GITHUB_API_HOST}${pathname}`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${GITHUB_API_HOST}${pathname.split('?')[0]}: response is not valid JSON`);
  }
}

/**
 * Every ref of `kind` ("heads" or "tags") whose name starts with `prefix`: [{ ref, sha }], from the paginated listings
 * (`/tags` and `/branches`: `per_page` honoured, `page` walked until a short page). Not `git/matching-refs`, which ignores
 * `per_page` and `page` and answers every match in one response: looping over its "pages" reads the same answer again and
 * again (and, with a hundred matches or more, never ends before MAX_PAGES). A ref seen twice (an item that moved between
 * pages while the list changed) is kept once.
 */
async function listRefs(repository, kind, prefix) {
  const endpoint = kind === 'tags' ? 'tags' : 'branches';
  const refs = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await githubJson(`/repos/${repository}/${endpoint}?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`${GITHUB_API_HOST}: unexpected answer listing ${kind}`);
    for (const item of batch) {
      if (typeof item?.name !== 'string' || !item.name.startsWith(prefix)) continue;
      const ref = `refs/${kind}/${item.name}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      refs.push({ ref, sha: typeof item.commit?.sha === 'string' ? item.commit.sha : '' });
    }
    if (batch.length < PER_PAGE) return refs;
  }
  throw new Error(`${GITHUB_API_HOST}: more than ${MAX_PAGES * PER_PAGE} ${kind} listed`);
}

/** What the index page lists: dated iterations per "<version>/<kind>", and the specification texts per version. */
function readIndex(html) {
  const iterations = new Map();
  const texts = new Map();
  for (const [, version, kind, date] of html.matchAll(INDEX_ITERATION)) {
    const key = `${version}/${kind}`;
    if (!iterations.has(key)) iterations.set(key, new Set());
    iterations.get(key).add(date);
  }
  for (const [, full, version] of html.matchAll(INDEX_SPEC_TEXT)) {
    if (!texts.has(version)) texts.set(version, new Set());
    texts.get(version).add(full);
  }
  return { iterations, texts };
}

/** The "<major>.<minor>" versions any source of the manifest belongs to (JSON Schema dialects are not versions). */
function pinnedVersions(manifest) {
  return new Set(manifest.sources.map((entry) => entry.version).filter((version) => MAJOR_MINOR.test(version)));
}

/** A later dated iteration of each pinned schema, schema-base, dialect and meta. */
function iterationFindings(manifest, index) {
  const findings = [];
  let checked = 0;
  for (const entry of manifest.sources) {
    const pinned = PINNED_ITERATION.exec(entry.url);
    if (!pinned) continue;
    const [, version, kind, date] = pinned;
    const dates = index.iterations.get(`${version}/${kind}`);
    // The index must still list what is pinned: otherwise its layout changed and "nothing newer" would mean nothing.
    if (!dates?.has(date)) {
      throw new Error(`${SPEC_INDEX_URL} does not list ${version}/${kind}/${date} (${entry.id}); the page may have changed, check it by hand`);
    }
    checked++;
    const newer = [...dates].filter((other) => other > date).sort();
    if (newer.length > 0) {
      const latest = newer[newer.length - 1];
      findings.push({
        type: 'schema-iteration',
        id: entry.id,
        version,
        kind,
        pinned: date,
        latest,
        newer: newer.slice(-MAX_LISTED),
        url: `${SPEC_INDEX_URL}${version}/${kind}/${latest}`,
      });
    }
  }
  return { findings, checked };
}

/** A version directory or specification text on the index that no source is pinned for. */
function unpinnedVersionFindings(manifest, index) {
  const known = pinnedVersions(manifest);
  const evidence = new Map();
  const see = (version, text) => evidence.set(version, [...(evidence.get(version) ?? []), text]);
  for (const [key, dates] of index.iterations) see(key.split('/')[0], `${key}/${[...dates].sort().pop()}`);
  for (const [version, texts] of index.texts) for (const full of texts) see(version, `specification v${full}`);
  return [...evidence]
    .filter(([version]) => !known.has(version))
    .sort(([a], [b]) => compareVersions(a, b))
    .map(([version, items]) => ({ type: 'unpinned-version', version, evidence: items.sort().slice(0, MAX_LISTED) }));
}

/** The blobs of `folder` at `commit`: { sha of the folder's tree, Map path -> blob sha }. */
async function folderAt(repository, commit, folder) {
  const tree = await githubJson(`/repos/${repository}/git/trees/${commit}:${folder}?recursive=1`);
  if (!tree || typeof tree.sha !== 'string' || !Array.isArray(tree.tree)) throw new Error(`${GITHUB_API_HOST}: unexpected answer for ${folder} at ${commit}`);
  if (tree.truncated) throw new Error(`${folder} at ${commit}: the tree listing is truncated`);
  const blobs = new Map();
  for (const item of tree.tree) {
    if (item?.type === 'blob' && typeof item.path === 'string' && typeof item.sha === 'string') blobs.set(item.path, item.sha);
  }
  return { sha: tree.sha, blobs };
}

/** A pin followed on a branch: reported when the head moved AND a pinned folder differs between the pin and the head. */
async function documentFinding(repository, pin) {
  let ref;
  try {
    ref = await githubJson(`/repos/${repository}/git/ref/heads/${pin.ref}`);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
    // A branch that was deleted or renamed upstream is a finding: the pin can no longer be followed. But a 404 for the branch
    // while the repository itself cannot be read is a failure to check, not news about the branch.
    await githubJson(`/repos/${repository}`);
    return { type: 'branch-gone', version: pin.version, ref: pin.ref, pinned: pin.commit };
  }
  const head = ref?.object?.sha;
  if (typeof head !== 'string' || !COMMIT.test(head)) throw new Error(`${GITHUB_API_HOST}: unexpected answer for branch ${pin.ref}`);
  if (head === pin.commit) return null;

  const folders = [];
  for (const folder of pin.folders) {
    const before = await folderAt(repository, pin.commit, folder);
    const after = await folderAt(repository, head, folder).catch((error) => {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    });
    if (after === null) {
      folders.push({ folder, status: 'removed' });
    } else if (after.sha !== before.sha) {
      const added = [...after.blobs.keys()].filter((name) => !before.blobs.has(name));
      const removed = [...before.blobs.keys()].filter((name) => !after.blobs.has(name));
      const modified = [...after.blobs].filter(([name, sha]) => before.blobs.has(name) && before.blobs.get(name) !== sha).map(([name]) => name);
      folders.push({ folder, status: 'changed', added: listed(added), removed: listed(removed), modified: listed(modified) });
    }
  }
  if (folders.length === 0) return null;
  return {
    type: 'documents-changed',
    version: pin.version,
    ref: pin.ref,
    pinned: pin.commit,
    head,
    compare: `https://github.com/${repository}/compare/${pin.commit}...${head}`,
    folders,
  };
}

/** Release tags of a newer version than any pinned, and development branches of versions with no pinned source. */
async function releaseFindings(manifest, upstream) {
  const known = pinnedVersions(manifest);
  const newest = [...known].sort(compareVersions).pop() ?? '0.0';
  const acknowledged = new Set(upstream.acknowledgedBranches ?? []);
  const findings = [];

  const tags = await listRefs(upstream.repository, 'tags', '');
  for (const { ref } of tags) {
    const match = RELEASE_TAG.exec(ref);
    if (!match) continue;
    const version = `${match[1]}.${match[2]}`;
    if (compareVersions(version, newest) > 0) {
      findings.push({ type: 'release-tag', tag: ref.slice('refs/tags/'.length), version, prerelease: match[3] !== undefined });
    }
  }
  const branches = await listRefs(upstream.repository, 'heads', 'v');
  for (const { ref, sha } of branches) {
    const match = DEV_BRANCH.exec(ref);
    if (!match || acknowledged.has(match[1])) continue;
    const version = `${match[2]}.${match[3]}`;
    if (!known.has(version)) findings.push({ type: 'dev-branch', branch: match[1], version, commit: COMMIT.test(sha) ? sha : '' });
  }
  return { findings, tags: tags.length, branches: branches.length, newest };
}

async function latestReport(manifest) {
  const upstream = manifest.upstream;
  if (!upstream) {
    throw new Error(`${MANIFEST} has no "upstream" table (the branch and folders each OAI commit was taken from): see docs/maintaining-openapi-support.md`);
  }
  const index = readIndex((await fetchLatest(SPEC_INDEX_URL)).toString('utf8'));
  const iterations = iterationFindings(manifest, index);
  const findings = [...iterations.findings, ...unpinnedVersionFindings(manifest, index)];

  let followed = 0;
  for (const pin of upstream.documents) {
    if (pin.ref === undefined) continue;
    followed++;
    const finding = await documentFinding(upstream.repository, pin);
    if (finding) findings.push(finding);
  }
  const releases = await releaseFindings(manifest, upstream);
  findings.push(...releases.findings);

  findings.sort((a, b) => FINDING_ORDER.indexOf(a.type) - FINDING_ORDER.indexOf(b.type));
  // Findings are kept in order while the report fits (MAX_FINDINGS of a type, MAX_REPORT_BYTES in all); each one that does not
  // is counted under its type.
  const omitted = {};
  const kept = [];
  const perType = new Map();
  let room = MAX_REPORT_BYTES - RESERVED_BYTES;
  for (const finding of findings) {
    const count = perType.get(finding.type) ?? 0;
    perType.set(finding.type, count + 1);
    const size = Buffer.byteLength(JSON.stringify(finding)) + 1;
    if (count < MAX_FINDINGS && size <= room) {
      kept.push(finding);
      room -= size;
    } else omitted[finding.type] = (omitted[finding.type] ?? 0) + 1;
  }
  return {
    newer: findings.length > 0,
    findings: kept,
    ...(Object.keys(omitted).length > 0 ? { omitted } : {}),
    checked: {
      iterations: iterations.checked,
      followedDocumentPins: followed,
      frozenDocumentPins: upstream.documents.length - followed,
      releaseTags: releases.tags,
      developmentBranches: releases.branches,
      newestPinnedVersion: releases.newest,
    },
  };
}

const short = (sha) => sha.slice(0, 7);
const files = (group) => `${group.count} ${group.count === 1 ? 'file' : 'files'}${group.names.length > 0 ? ` (${group.names.join(', ')}${group.count > group.names.length ? ', ...' : ''})` : ''}`;

/** The report as short human-readable text. */
function formatReport(report) {
  const c = report.checked;
  const checked = `Checked ${c.iterations} schema iterations, ${c.followedDocumentPins} document pins followed on a branch (${c.frozenDocumentPins} frozen), ${c.releaseTags} tags and ${c.developmentBranches} v*-dev branches (newest pinned version ${c.newestPinnedVersion}).`;
  if (!report.newer) return `Nothing is newer upstream than what is pinned.\n${checked}\n`;
  const lines = ['Newer upstream than what is pinned (see docs/maintaining-openapi-support.md):', ''];
  const heading = {
    'schema-iteration': 'Published schema iterations',
    'unpinned-version': 'OpenAPI versions with no pinned sources',
    'documents-changed': 'OAI test documents (branch head moved and the pinned folders differ)',
    'branch-gone': 'Followed branches that no longer exist',
    'release-tag': `OAI release tags newer than ${c.newestPinnedVersion}`,
    'dev-branch': 'Development branches of versions with no pinned sources',
  };
  let section = '';
  for (const f of report.findings) {
    if (f.type !== section) {
      if (section) lines.push('');
      lines.push(heading[f.type]);
      section = f.type;
    }
    if (f.type === 'schema-iteration') {
      lines.push(`  ${f.id}: pinned ${f.pinned}, latest ${f.latest}${f.newer.length > 1 ? ` (${f.newer.length} newer)` : ''}`, `    ${f.url}`);
    } else if (f.type === 'unpinned-version') {
      lines.push(`  ${f.version}: ${f.evidence.join('; ')}`);
    } else if (f.type === 'documents-changed') {
      lines.push(`  ${f.version} (${f.ref}): ${short(f.pinned)} -> ${short(f.head)}`, `    ${f.compare}`);
      for (const folder of f.folders) {
        if (folder.status === 'removed') lines.push(`    ${folder.folder}: no longer exists at the branch head`);
        else {
          const parts = ['added', 'removed', 'modified'].filter((kind) => folder[kind].count > 0).map((kind) => `${kind} ${files(folder[kind])}`);
          lines.push(`    ${folder.folder}: ${parts.length > 0 ? parts.join('; ') : 'tree differs (file modes)'}`);
        }
      }
    } else if (f.type === 'branch-gone') {
      lines.push(`  ${f.ref} (${f.version}): pinned at ${short(f.pinned)}; name its successor in upstream.documents[].ref of the manifest, or drop "ref" to freeze the pin`);
    } else if (f.type === 'release-tag') {
      lines.push(`  ${f.tag}${f.prerelease ? ' (pre-release)' : ''}`);
    } else {
      lines.push(`  ${f.branch}${f.commit ? ` at ${short(f.commit)}` : ''}: no ${f.version} source is pinned`);
    }
  }
  for (const [type, count] of Object.entries(report.omitted ?? {})) lines.push('', `and ${count} more ${type} findings, not listed (the report is capped)`);
  return `${lines.join('\n')}\n\n${checked}\n`;
}

async function runLatest(manifest) {
  const report = await latestReport(manifest);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  process.exitCode = report.newer ? EXIT_NEWER : 0;
}

try {
  const manifest = await loadManifest(options.manifest ?? undefined);
  await (latest ? runLatest(manifest) : update ? updateSources(manifest) : verify(manifest));
} catch (error) {
  fail(error.message);
}
