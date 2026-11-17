#!/usr/bin/env node
/**
 * Downloads the real-world specs listed in scripts/spec-corpus/sources.json into .spec-corpus/specs/ (git-ignored),
 * verifying each against the size and sha256 recorded there. Nothing is committed: the specs are other people's
 * documents under their own licences, and this script only fetches them for local use.
 *
 *   node scripts/spec-corpus/download.mjs                    every spec; what is already present and verified is skipped
 *   node scripts/spec-corpus/download.mjs --version 3.1      only specs declaring 3.1.x (also 3.2, 3.0, 2.0)
 *   node scripts/spec-corpus/download.mjs --slug a,b         only these slugs
 *   node scripts/spec-corpus/download.mjs --kind production  only production | example | test-fixture
 *   node scripts/spec-corpus/download.mjs --max-total-mb 400 cap on the bytes downloaded in this run (default 400)
 *   node scripts/spec-corpus/download.mjs --update           download the selected specs again and REWRITE their size,
 *                                                            checksum and (for a new entry) title, version, format and file
 *                                                            in sources.json: how a spec is added or a pin is moved
 *
 * A single-file entry is one GET of `url`. A multi-file entry (`tree`) is the document at `tree.root` plus every file its
 * relative `$ref`s reach, crawled at the pinned commit of `repo` and laid out as in the repository (below its common
 * directory) in specs/<major.minor of the declared version>/<slug>/; the result is checked against the file count, byte count
 * and digest recorded in `tree`. The digest is the sha256 of the lines "<sha256 of file>  <path>\n" of every file, sorted by
 * path (integrity.mjs, which run.mjs uses too, to refuse a spec that does not match). A new entry needs no `file`: `--update`
 * derives it (the folder from the version the root document declares, then the root's path in it).
 *
 * A tree that cannot be laid out as in the repository fails its spec: two paths that differ only in letter case or Unicode
 * form would be ONE file on macOS or Windows, and a file whose whole content is a single short string is how
 * raw.githubusercontent.com serves a symbolic link. What is written is read back from disk and compared with the digest
 * before it takes the place of the previous copy.
 *
 * Two entries are live endpoints with no commit to pin (their `url` serves whatever is current, and one embeds a build
 * hash in `info.version`). A pinned entry that does not match its checksum fails; one of these is kept and reported as
 * `changed` (exit 0), and `--update --slug <slug>` records the new bytes.
 *
 * Safety: https only, no credentials, the hosts in ALLOWED_HOSTS, redirects followed by hand (at most MAX_REDIRECTS, each
 * hop checked like the first request), MAX_FILE_BYTES per file and --max-total-mb in all, no symlink is written through
 * and no downloaded path can leave its folder. Downloaded text is only ever parsed as data (JSON, YAML to find `$ref`s):
 * nothing in it is executed or imported. A file is written to a temp name and renamed into place, so an interrupted run
 * leaves no half-written spec.
 *
 * SPEC_CORPUS_DIR=<dir> downloads into <dir> instead of .spec-corpus/ (run.mjs reads the same variable).
 *
 * Exit code: 0 when every selected spec is present and verified, 1 otherwise.
 */

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { corpusPath as corpusPathIn, digestOf, hashEntries, pathProblem, sha256, treeFolderOf, treeMismatch, verifyOnDisk } from './integrity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
/** Where the specs go: `.spec-corpus/` of the repository (git-ignored), or SPEC_CORPUS_DIR (to download somewhere else). */
const CORPUS = process.env.SPEC_CORPUS_DIR ? path.resolve(process.env.SPEC_CORPUS_DIR) : path.join(REPO, '.spec-corpus');
const SOURCES = path.join(HERE, 'sources.json');

/** The hosts a spec may come from: GitHub raw files, GitLab raw files, and the two live endpoints of the corpus. */
const ALLOWED_HOSTS = new Set(['raw.githubusercontent.com', 'gitlab.com', 'api.elevenlabs.io', 'developer.atlassian.com']);
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const DEFAULT_TOTAL_MB = 400;
const MAX_TREE_FILES = 4000;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const ATTEMPTS = 3;
const USER_AGENT = 'spec-corpus-download';
const KINDS = new Set(['production', 'example', 'test-fixture']);
const SLUG = /^[a-z0-9][a-z0-9.-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function fail(...lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

const mb = (bytes) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

// ----------------------------------------------------------------------------------------------------------- arguments

const USAGE = [
  'Usage: download.mjs [--slug a,b] [--version 3.1] [--kind production] [--max-total-mb N] [--update]',
  '  (no flag): download every spec of sources.json that is missing or does not match, verify it, skip the rest',
  '  --update:  download the selected specs again and rewrite their size, checksum and tree digest in sources.json',
];

function parseArgs(argv) {
  const options = { slug: null, version: null, kind: null, update: false, maxTotal: DEFAULT_TOTAL_MB * 1024 * 1024 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail(`${arg} needs a value`, ...USAGE);
      return argv[++i];
    };
    if (arg === '--update') options.update = true;
    else if (arg === '--slug') options.slug = new Set(value().split(','));
    else if (arg === '--version') options.version = value();
    else if (arg === '--kind') options.kind = value();
    else if (arg === '--max-total-mb') {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0) fail('--max-total-mb must be a positive number');
      options.maxTotal = n * 1024 * 1024;
    } else fail(`Unknown argument ${arg}`, ...USAGE);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

// -------------------------------------------------------------------------------------------------------------- sources

/** Why `value` is not an acceptable download URL, or null. */
function urlProblem(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return 'is not a valid URL';
  }
  if (url.protocol !== 'https:') return `must use https (got ${url.protocol})`;
  if (url.username || url.password || url.port || url.hash) return 'must have no credentials, port or fragment';
  if (!ALLOWED_HOSTS.has(url.host)) return `host must be one of ${[...ALLOWED_HOSTS].join(', ')}`;
  return null;
}

/** The `file` of every spec of sources.json (case-folded) and the slug it belongs to: a new one must not take another's. */
let claimedFiles = new Map();

/** A path as a case-insensitive, normalization-insensitive file system (macOS, Windows) sees it. */
const foldCase = (p) => p.normalize('NFD').toLowerCase();

async function loadSources() {
  let sources;
  try {
    sources = JSON.parse(await readFile(SOURCES, 'utf8'));
  } catch (error) {
    fail(`Cannot read sources.json: ${error.message}`);
  }
  if (!sources || !Array.isArray(sources.specs)) fail('sources.json: expected { "specs": [...] }');
  const errors = [];
  const slugs = new Set();
  const files = new Map();
  sources.specs.forEach((spec, index) => {
    const label = `sources.json specs[${index}]${spec && typeof spec.slug === 'string' ? ` (${spec.slug})` : ''}`;
    const bad = (message) => errors.push(`${label}: ${message}`);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return bad('must be an object');
    if (typeof spec.slug !== 'string' || !SLUG.test(spec.slug) || spec.slug.includes('..')) bad('"slug" must be lower-case letters, digits, "." and "-"');
    if (slugs.has(spec.slug)) bad('duplicate slug');
    slugs.add(spec.slug);
    if (!KINDS.has(spec.kind)) bad(`"kind" must be one of ${[...KINDS].join(', ')}`);
    if (typeof spec.licence !== 'string' || spec.licence === '') bad('"licence" must say what is known about the licence (even "unknown")');
    const problem = urlProblem(spec.url);
    if (problem) bad(`"url" ${problem}`);
    if (spec.commit !== undefined) {
      if (typeof spec.commit !== 'string' || !COMMIT.test(spec.commit)) bad('"commit" must be 40 lowercase hex characters');
      else if (typeof spec.url === 'string' && !spec.url.includes(`/${spec.commit}/`)) bad('"url" must contain the "commit" it is pinned to');
      if (typeof spec.repo !== 'string' || spec.repo === '') bad('"repo" is required with "commit"');
    }
    if (spec.file !== undefined) {
      const fileProblem = pathProblem(spec.file);
      if (fileProblem) bad(`"file" ${fileProblem}`);
      else if (!/^specs\/[^/]+\/./.test(spec.file)) bad('"file" must be below specs/<version>/');
      else if (files.has(foldCase(spec.file))) bad(`duplicate file ${spec.file}`);
      files.set(foldCase(spec.file), spec.slug);
    } else if (!options.update) bad('"file" is missing: run with --update to fill it in');
    if (!options.update) {
      if (!Number.isSafeInteger(spec.bytes) || spec.bytes < 0 || spec.bytes > MAX_FILE_BYTES) bad('"bytes" must be the size of the document');
      if (typeof spec.sha256 !== 'string' || !SHA256.test(spec.sha256)) bad('"sha256" must be 64 lowercase hex characters');
    }
    if (spec.tree !== undefined) {
      const tree = spec.tree;
      if (!tree || typeof tree !== 'object') return bad('"tree" must be an object');
      const rootProblem = pathProblem(tree.root);
      if (rootProblem) bad(`"tree.root" ${rootProblem} (the path of the root document in the repository)`);
      if (typeof spec.commit !== 'string' || typeof spec.url !== 'string' || !spec.url.startsWith('https://raw.githubusercontent.com/')) {
        bad('a "tree" needs a raw.githubusercontent.com "url" pinned to a "commit"');
      } else if (!rootProblem && typeof spec.repo === 'string' && spec.url !== rawUrl(spec.repo, spec.commit, tree.root)) {
        bad('"url" must be the raw URL of "repo", "commit" and "tree.root"');
      }
      if (!options.update && (!Number.isSafeInteger(tree.files) || tree.files < 1 || tree.files > MAX_TREE_FILES || !Number.isSafeInteger(tree.bytes) || typeof tree.sha256 !== 'string' || !SHA256.test(tree.sha256))) {
        bad('"tree" must record "files", "bytes" and "sha256"');
      }
    }
  });
  if (errors.length > 0) fail(...errors);
  claimedFiles = files;
  return sources;
}

function rawUrl(repo, commit, repoPath) {
  return `https://raw.githubusercontent.com/${repo}/${commit}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
}

function selected(sources) {
  let list = sources.specs;
  if (options.slug) {
    const unknown = [...options.slug].filter((slug) => !list.some((spec) => spec.slug === slug));
    if (unknown.length > 0) fail(`No such slug in sources.json: ${unknown.join(', ')}`);
    list = list.filter((spec) => options.slug.has(spec.slug));
  }
  if (options.version) {
    list = list.filter((spec) => spec.declaredVersion === options.version || String(spec.declaredVersion).startsWith(`${options.version}.`));
  }
  if (options.kind) list = list.filter((spec) => spec.kind === options.kind);
  return list;
}

// -------------------------------------------------------------------------------------------------------------- network

const budget = { used: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request with redirects followed by hand, every hop held to the same rules as the first URL. */
async function fetchOnce(startUrl) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const problem = urlProblem(url);
    if (problem) throw Object.assign(new Error(`${problem}`), { final: true });
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location'), url).href;
      continue;
    }
    return response;
  }
  throw Object.assign(new Error(`more than ${MAX_REDIRECTS} redirects`), { final: true });
}

/** The bytes of `url`, or null for a 404 when `allowMissing`. Retries a network error, 429 and 5xx. */
async function get(url, { allowMissing = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetchOnce(url);
      if (response.status === 404 && allowMissing) {
        await response.body?.cancel();
        return null;
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(attempt * 1500);
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw Object.assign(new Error(`HTTP ${response.status}`), { final: true });
      }
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_FILE_BYTES) throw Object.assign(new Error(`larger than ${mb(MAX_FILE_BYTES)} (content-length ${declared})`), { final: true });
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        budget.used += chunk.length;
        if (size > MAX_FILE_BYTES) throw Object.assign(new Error(`larger than ${mb(MAX_FILE_BYTES)}`), { final: true });
        if (budget.used > options.maxTotal) throw Object.assign(new Error(`this run downloaded more than ${mb(options.maxTotal)} (--max-total-mb)`), { final: true });
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error.final) throw new Error(`${url}: ${error.message}`);
      lastError = error;
      await sleep(attempt * 1500);
    }
  }
  throw new Error(`${url}: ${lastError?.cause?.message ?? lastError?.message ?? 'request failed'}`);
}

// ------------------------------------------------------------------------------------------------------------ the disk

/** `relative` below CORPUS as an absolute path, refusing a symlink anywhere between CORPUS and it (CORPUS is made if need be). */
async function corpusPath(relative) {
  await mkdir(CORPUS, { recursive: true });
  return corpusPathIn(CORPUS, relative);
}

async function writeAtomic(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Is the spec on disk exactly what sources.json records? Returns null when it is, else why not (see integrity.mjs). */
const mismatch = (spec) => verifyOnDisk(CORPUS, spec);

/** `major.minor` of a declared version (`3.1.0` -> `3.1`, `2.0` -> `2.0`): the folder below specs/. */
function versionFolder(declaredVersion) {
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(String(declaredVersion ?? ''));
  if (!match) throw new Error(`the document declares version ${JSON.stringify(declaredVersion)}, which is not <major>.<minor>[.<patch>]`);
  return `${match[1]}.${match[2]}`;
}

// ------------------------------------------------------------------------------------------------------------- parsing

/** JSON or YAML text as data. */
function parseData(text) {
  const start = text.trimStart();
  if (start.startsWith('{') || start.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      // not JSON after all: YAML flow syntax
    }
  }
  return parseYaml(text, { maxAliasCount: 100000 });
}

/** Every string `$ref` of a parsed document (iterative, cycle-safe). */
function collectRefs(doc) {
  const refs = new Set();
  const stack = [doc];
  const seen = new Set();
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (typeof node.$ref === 'string') refs.add(node.$ref);
    for (const value of Object.values(node)) if (value && typeof value === 'object') stack.push(value);
  }
  return refs;
}

/** What a downloaded document declares, read as data: { declaredVersion, title }. */
function describeDocument(bytes) {
  const doc = parseData(bytes.toString('utf8'));
  const declared = doc?.openapi ?? doc?.swagger;
  if (declared === undefined || declared === null) throw new Error('not an OpenAPI or Swagger document (no "openapi" or "swagger" field)');
  return { declaredVersion: String(declared), title: typeof doc.info?.title === 'string' ? doc.info.title : null };
}

// --------------------------------------------------------------------------------------------------------------- fetch

/** Fetches a multi-file spec: [{ rel, data }] below the common folder, plus the root's path in it and what 404ed. */
async function crawl(spec) {
  const { repo, commit } = spec;
  const root = spec.tree.root;
  const files = new Map();
  const problems = [];
  const queue = [root];
  const seen = new Set([root]);
  let total = 0;
  while (queue.length > 0) {
    const batch = queue.splice(0, CONCURRENCY);
    await Promise.all(
      batch.map(async (repoPath) => {
        const data = await get(rawUrl(repo, commit, repoPath), { allowMissing: true });
        if (data === null) {
          problems.push(`${repoPath}: 404`);
          return;
        }
        total += data.length;
        files.set(repoPath, data);
        if (files.size > MAX_TREE_FILES) throw new Error(`more than ${MAX_TREE_FILES} files`);
        if (total > MAX_FILE_BYTES) throw new Error(`the tree is larger than ${mb(MAX_FILE_BYTES)}`);
        if (!/\.(json|ya?ml)$/i.test(repoPath)) return;
        let parsed;
        try {
          parsed = parseData(data.toString('utf8'));
        } catch {
          problems.push(`${repoPath}: not parseable, kept but not followed`);
          return;
        }
        // raw.githubusercontent.com serves a symbolic link as a file holding the path it points to: never a document.
        if (typeof parsed === 'string' && data.length <= 1024) {
          throw new Error(`${repoPath} is a single string (${JSON.stringify(parsed.slice(0, 80))}), which is what a symbolic link in the repository looks like; refusing it`);
        }
        for (const ref of collectRefs(parsed)) {
          if (ref.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
          let reference;
          try {
            reference = decodeURIComponent(ref.split('#')[0]);
          } catch {
            continue;
          }
          if (!reference) continue;
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), reference));
          if (seen.has(target)) continue;
          if (target === '..' || target.startsWith('../')) {
            problems.push(`${repoPath}: ${JSON.stringify(ref.slice(0, 120))} leaves the repository, not followed`);
            continue;
          }
          if (pathProblem(target)) {
            problems.push(`${target}: ${pathProblem(target)}`);
            continue;
          }
          seen.add(target);
          queue.push(target);
        }
      }),
    );
  }
  if (!files.has(root)) throw new Error(`the root ${root} was not found`);
  const dirs = [...files.keys()].map((repoPath) => {
    const dir = path.posix.dirname(repoPath);
    return dir === '.' ? [] : dir.split('/');
  });
  let common = dirs[0];
  for (const dir of dirs) {
    let i = 0;
    while (i < common.length && i < dir.length && common[i] === dir[i]) i++;
    common = common.slice(0, i);
  }
  const prefix = common.join('/');
  const entries = [...files].map(([repoPath, data]) => ({ rel: prefix ? repoPath.slice(prefix.length + 1) : repoPath, data }));
  return { entries, rootRel: prefix ? root.slice(prefix.length + 1) : root, problems };
}

/** Why `entries` cannot be laid out as in the repository on a file system that ignores case (macOS, Windows), or null. */
function layoutProblem(entries) {
  const files = new Map(); // folded path -> path as in the repository
  const folders = new Map(); // folded path of a folder -> a file below it
  for (const { rel } of entries) {
    const problem = pathProblem(rel);
    if (problem) return `${rel}: ${problem}`;
    const key = foldCase(rel);
    if (files.has(key)) {
      return files.get(key) === rel
        ? `${rel} is listed twice`
        : `${files.get(key)} and ${rel} differ only in letter case (or Unicode form): on a case-insensitive file system (macOS, Windows) one would overwrite the other, so this tree cannot be laid out as in the repository`;
    }
    files.set(key, rel);
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) folders.set(parts.slice(0, i).join('/'), rel);
  }
  for (const [key, rel] of files) {
    if (folders.has(key)) return `${rel} is a file and ${folders.get(key)} needs it to be a folder (names that differ only in letter case, or a path inside a file)`;
  }
  return null;
}

/**
 * Puts the crawled files in `folderRel`, replacing what is there, without ever leaving it half written. The files are first
 * written to a new folder next to it, and that folder must hold exactly `expected` ({ files, bytes, sha256 }) when read back
 * from disk before it takes the place of the old one.
 */
async function placeTree(spec, folderRel, entries, expected) {
  const problem = layoutProblem(entries);
  if (problem) throw new Error(`${problem}`);
  const folder = await corpusPath(folderRel);
  const parent = path.dirname(folder);
  await mkdir(parent, { recursive: true });
  const suffix = randomBytes(4).toString('hex');
  const fresh = path.join(parent, `.${spec.slug}.${suffix}.new`);
  const old = path.join(parent, `.${spec.slug}.${suffix}.old`);
  try {
    await mkdir(fresh);
    for (const { rel, data } of entries) {
      const dest = path.join(fresh, ...rel.split('/'));
      if (!path.resolve(dest).startsWith(fresh + path.sep)) throw new Error(`${rel}: leaves the folder`);
      await mkdir(path.dirname(dest), { recursive: true });
      // 'wx': a file is never written over another one, whatever the file system does with names.
      await writeFile(dest, data, { flag: 'wx' });
    }
    const wrong = await treeMismatch(fresh, expected, `${folderRel} as written`);
    if (wrong) throw new Error(`what was written is not what was downloaded: ${wrong}`);
    const existed = await lstat(folder).then(() => true, () => false);
    if (existed) await rename(folder, old);
    await rename(fresh, folder);
    if (existed) await rm(old, { recursive: true, force: true });
  } catch (error) {
    await rm(fresh, { recursive: true, force: true });
    throw error;
  }
}

/** Downloads one spec. Returns the fields to record: { bytes, sha256, tree?, declaredVersion, title, file } */
async function fetchSpec(spec) {
  if (spec.tree) {
    const { entries, rootRel, problems } = await crawl(spec);
    const layout = layoutProblem(entries);
    if (layout) throw new Error(`${layout}`);
    const rootData = entries.find((entry) => entry.rel === rootRel).data;
    // A new entry has no `file` yet: its folder is specs/<major.minor of the version the root declares>/<slug>/.
    const described = options.update ? describeDocument(rootData) : {};
    const folder = spec.file ? treeFolderOf(spec.file, spec.slug) : `specs/${versionFolder(described.declaredVersion)}/${spec.slug}`;
    const file = spec.file ?? `${folder}/${rootRel}`;
    if (file !== `${folder}/${rootRel}`) throw new Error(`the root lands at ${folder}/${rootRel}, sources.json says ${file}`);
    claim(spec, file);
    const hashed = hashEntries(entries);
    const digest = digestOf(hashed);
    if (!options.update) {
      if (digest.files !== spec.tree.files || digest.bytes !== spec.tree.bytes || digest.sha256 !== spec.tree.sha256) {
        throw new Error(
          `the tree is ${digest.files} files / ${digest.bytes} bytes, sources.json records ${spec.tree.files} / ${spec.tree.bytes}` +
            `${problems.length > 0 ? ` (${problems.length} reference problems, e.g. ${problems[0]})` : ''}; use --update to accept it`,
        );
      }
      if (rootData.length !== spec.bytes || sha256(rootData) !== spec.sha256) {
        throw new Error(`the root ${rootRel} is ${rootData.length} bytes with sha256 ${sha256(rootData)}, sources.json records ${spec.bytes} / ${spec.sha256}; use --update to accept it`);
      }
    } else if (problems.length > 0) {
      console.log(`note        ${spec.slug}: ${problems.length} reference(s) not followed or not found, e.g. ${problems.slice(0, 3).join('; ')}`);
    }
    await placeTree(spec, folder, entries, options.update ? digest : spec.tree);
    return { ...described, file, bytes: rootData.length, sha256: sha256(rootData), tree: { root: spec.tree.root, ...digest } };
  }
  const data = await get(spec.url);
  // A document pinned to a commit must match. One served live (no commit) can change under us, and its bytes are kept with a notice.
  const drifted = !options.update && (data.length !== spec.bytes || sha256(data) !== spec.sha256);
  if (drifted && spec.commit) {
    throw new Error(`downloaded ${data.length} bytes with sha256 ${sha256(data)}, sources.json records ${spec.bytes} / ${spec.sha256}; use --update to accept it`);
  }
  // Parsing a document of tens of megabytes is only worth it when its title and version are being recorded.
  const described = options.update ? describeDocument(data) : {};
  const extension = data.toString('utf8', 0, 64).trimStart().startsWith('{') ? 'json' : 'yaml';
  const file = spec.file ?? `specs/${versionFolder(described.declaredVersion)}/${spec.slug}.${extension}`;
  claim(spec, file);
  const target = await corpusPath(file);
  await writeAtomic(target, data);
  // What is on disk is what is reported: read it back.
  const written = await readFile(target);
  if (written.length !== data.length || sha256(written) !== sha256(data)) throw new Error(`${file} read back from disk differs from what was downloaded`);
  return { ...described, file, bytes: data.length, sha256: sha256(data), ...(drifted ? { drifted: true } : {}) };
}

/** A spec may only write below the file name sources.json gives it, or one nobody else has. */
function claim(spec, file) {
  const owner = claimedFiles.get(foldCase(file));
  if (owner !== undefined && owner !== spec.slug) throw new Error(`${file} is already the file of ${owner}`);
}

// ---------------------------------------------------------------------------------------------------------------- main

/** The entry with its recorded fields in the file's usual order, then anything else it carries. */
function recorded(spec, fetched) {
  const known = ['slug', 'title', 'declaredVersion', 'kind', 'format', 'licence', 'file', 'bytes', 'sha256', 'url', 'repo', 'commit', 'tree'];
  const merged = { ...spec, ...fetched, format: spec.format ?? (fetched.file.endsWith('.json') ? 'json' : 'yaml') };
  const ordered = {};
  for (const key of known) if (merged[key] !== undefined) ordered[key] = merged[key];
  for (const key of Object.keys(merged)) if (!(key in ordered)) ordered[key] = merged[key];
  return ordered;
}

const sources = await loadSources();
const list = selected(sources);
if (list.length === 0) fail('No spec matches the filters.');

const counts = { present: 0, downloaded: 0, changed: 0, failed: 0 };
const updates = new Map();
for (const spec of list) {
  const label = `${spec.slug}${spec.declaredVersion ? ` (${spec.declaredVersion})` : ''}`;
  try {
    if (!options.update) {
      const why = await mismatch(spec);
      if (why === null) {
        counts.present++;
        console.log(`present     ${label}${spec.tree ? `, ${spec.tree.files} files` : `, ${mb(spec.bytes)}`}`);
        continue;
      }
      if (why !== 'not downloaded') console.log(`mismatch    ${label}: ${why}; downloading again`);
    }
    const { drifted, ...fetched } = await fetchSpec(spec);
    counts.downloaded++;
    if (options.update) updates.set(spec.slug, recorded(spec, fetched));
    if (drifted) {
      counts.changed++;
      console.log(`changed     ${label}: a live endpoint, not pinned to a commit, now serves other bytes (${fetched.bytes} bytes, sha256 ${fetched.sha256.slice(0, 12)}; sources.json records ${spec.sha256.slice(0, 12)}); kept. --update --slug ${spec.slug} records them`);
    } else {
      console.log(`downloaded  ${label}${fetched.tree ? `, ${fetched.tree.files} files` : `, ${mb(fetched.bytes)}`}, sha256 ${fetched.sha256.slice(0, 12)}`);
    }
  } catch (error) {
    counts.failed++;
    console.error(`FAILED      ${label}: ${error.message}`);
  }
}

if (options.update && updates.size > 0) {
  const specs = sources.specs.map((spec) => updates.get(spec.slug) ?? spec);
  await writeAtomic(SOURCES, Buffer.from(`${JSON.stringify({ ...sources, specs }, null, 2)}\n`));
  console.log(`sources.json updated for ${updates.size} spec(s)`);
}
console.log(
  `${list.length} selected: ${counts.present} present and verified, ${counts.downloaded - counts.changed} downloaded${options.update ? '' : ' and verified'}, ` +
    `${counts.changed} changed upstream (live endpoints), ${counts.failed} failed (${mb(budget.used)} transferred)`,
);
process.exitCode = counts.failed > 0 ? 1 : 0;
