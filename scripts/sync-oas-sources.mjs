#!/usr/bin/env node
/**
 * Verifies or re-downloads the pinned official OpenAPI sources vendored under e2e/fixtures/oas/.
 *
 * The manifest e2e/fixtures/oas/sources.json is a flat list of
 * { id, version, kind, url, path, sha256 } entries. `path` is relative to e2e/fixtures/oas/.
 *
 * Usage:
 *   node scripts/sync-oas-sources.mjs            # offline: every listed file exists and matches its sha256,
 *                                                #          and no unlisted file sits under e2e/fixtures/oas/
 *   node scripts/sync-oas-sources.mjs --update   # download every url, write the bytes, rewrite the sha256 values
 *
 * Verification needs no network. --update downloads everything before it writes anything, so a failed
 * download leaves the tree and the manifest untouched. Each file is then written to a temp file and renamed
 * into place; a symlink at the destination (or in its directory chain) is refused.
 *
 * Downloads are limited to ALLOWED_HOSTS, never follow redirects, and are capped at MAX_BYTES each.
 *
 * Exit code: 0 on success, 1 on any mismatch, invalid manifest, or download failure.
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
/** OS metadata that may appear next to vendored files; ignored by the "unlisted file" check. */
const OS_METADATA = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/;
const SHA256 = /^[0-9a-f]{64}$/;

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--update')) {
  fail(
    'Usage: sync-oas-sources.mjs [--update]',
    '  (no flag): verify the vendored files against the manifest, offline',
    '  --update:  re-download every source and rewrite the manifest checksums',
  );
}
const update = args[0] === '--update';

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

async function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(ROOT, MANIFEST), 'utf8'));
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
  if (errors.length > 0) fail(...errors);
  return manifest;
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

async function download(entry) {
  // Redirects are not followed: a pinned URL that starts redirecting is a change to review, not to absorb.
  const response = await fetch(entry.url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (response.status !== 200) {
    const location = response.headers.get('location');
    throw new Error(`HTTP ${response.status}${location ? ` redirecting to ${location}` : ''}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error(`response exceeds ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
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

try {
  const manifest = await loadManifest();
  await (update ? updateSources(manifest) : verify(manifest));
} catch (error) {
  fail(error.message);
}
