// What the downloaded corpus must look like on disk, shared by download.mjs (which makes it so) and run.mjs (which refuses
// to run what is not). One definition of the digest, so the two can never disagree about it.
//
// A single-file spec is the file at `spec.file`, recorded as `bytes` and `sha256`. A multi-file spec (`spec.tree`) is the
// root document plus every file its relative `$ref`s reach, laid out as in the repository in `specs/<version>/<slug>/`;
// the tree digest is the sha256 of the lines "<sha256 of file>  <path>\n" of every file, sorted by path (bytewise).
//
// Nothing here fetches anything, and nothing in a downloaded file is executed or imported.

import { createHash } from 'node:crypto';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Why `p` cannot be a path below a folder (absolute, `..`, empty or odd segments, control characters), or null. */
export function pathProblem(p) {
  if (typeof p !== 'string' || p === '' || p.length > 1024) return 'must be a non-empty string of at most 1024 characters';
  if (/[\\\0-\x1f\x7f]/.test(p)) return 'must not contain backslashes or control characters';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'must be relative';
  if (p.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return 'must not contain empty, "." or ".." segments';
  return null;
}

/** `specs/<version>/<slug>`: the folder a multi-file spec is laid out in; <version> is the one of its root document's `file`. */
export const treeFolderOf = (file, slug) => `specs/${file.split('/')[1]}/${slug}`;

/** `relative` below `corpus` as an absolute path, refusing a symlink anywhere between the corpus folder and it. */
export async function corpusPath(corpus, relative) {
  const problem = pathProblem(relative);
  if (problem) throw new Error(`${relative}: ${problem}`);
  let current = corpus;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (stat === null) break;
    if (stat.isSymbolicLink()) throw new Error(`${current}: is a symlink; refusing to use it`);
  }
  return path.join(corpus, relative);
}

/** Every regular file below `dir`: [{ rel, file }] sorted by path; a symlink or special file makes it null (not verifiable). */
export async function walkFiles(dir) {
  const out = [];
  const visit = async (current, prefix) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!(await visit(path.join(current, entry.name), rel))) return false;
      } else if (entry.isFile()) {
        out.push({ rel, file: path.join(current, entry.name) });
      } else return false;
    }
    return true;
  };
  return (await visit(dir, '')) ? out.sort((a, b) => byteOrder(a.rel, b.rel)) : null;
}

/** { files, bytes, sha256 } of [{ rel, sha256, size }] (see the top of this file for the digest). */
export function digestOf(hashed) {
  const sorted = [...hashed].sort((a, b) => byteOrder(a.rel, b.rel));
  return {
    files: sorted.length,
    bytes: sorted.reduce((sum, entry) => sum + entry.size, 0),
    sha256: sha256(Buffer.from(sorted.map((entry) => `${entry.sha256}  ${entry.rel}\n`).join(''))),
  };
}

/** The `{ rel, sha256, size }` of entries held in memory ([{ rel, data }]). */
export const hashEntries = (entries) => entries.map(({ rel, data }) => ({ rel, sha256: sha256(data), size: data.length }));

/** The `{ rel, sha256, size }` of the files on disk ([{ rel, file }]), read a few at a time and never kept. */
export async function hashFiles(listed) {
  const out = new Array(listed.length);
  let next = 0;
  const worker = async () => {
    while (next < listed.length) {
      const index = next++;
      const handle = await open(listed[index].file, 'r');
      try {
        const data = await handle.readFile();
        out[index] = { rel: listed[index].rel, sha256: sha256(data), size: data.length };
      } finally {
        await handle.close();
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

/** Is `folder` (a directory) exactly the tree `expected` ({ files, bytes, sha256 }) records? Null when it is, else why not. */
export async function treeMismatch(folder, expected, label) {
  const listed = await walkFiles(folder);
  if (listed === null) return `${label} holds something that is not a regular file`;
  const digest = digestOf(await hashFiles(listed));
  if (digest.files !== expected.files || digest.bytes !== expected.bytes || digest.sha256 !== expected.sha256) {
    return `${label} holds ${digest.files} files / ${digest.bytes} bytes, the digest differs from the recorded ${expected.files} / ${expected.bytes}`;
  }
  return null;
}

/**
 * Is the spec on disk below `corpus` exactly what sources.json records (root document size and sha256, and for a multi-file
 * spec the file count, byte count and digest of its folder)? Null when it is; 'not downloaded' when the root is missing;
 * otherwise the reason. A symlink in the way, a file that is not a regular one, or a spec without a `file` is a mismatch.
 */
export async function verifyOnDisk(corpus, spec) {
  if (typeof spec.file !== 'string') return 'sources.json has no "file" for it';
  let root;
  try {
    const target = await corpusPath(corpus, spec.file);
    const stat = await lstat(target);
    if (!stat.isFile()) return `${spec.file} is not a regular file`;
    const handle = await open(target, 'r');
    try {
      root = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    return error.code === 'ENOENT' ? 'not downloaded' : error.message;
  }
  if (root.length !== spec.bytes || sha256(root) !== spec.sha256) return `${spec.file} differs from the recorded size or checksum`;
  if (!spec.tree) return null;
  const folder = treeFolderOf(spec.file, spec.slug);
  try {
    return await treeMismatch(await corpusPath(corpus, folder), spec.tree, folder);
  } catch (error) {
    return error.code === 'ENOENT' ? `${folder} is missing` : error.message;
  }
}
