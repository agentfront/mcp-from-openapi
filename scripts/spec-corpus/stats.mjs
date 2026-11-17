// Parse a spec file (JSON/YAML) as DATA and count paths / operations the way the
// library should: 3.0/3.1 methods, 3.2 adds `query` + `additionalOperations`,
// 2.0 has the classic seven. Path items that are a `$ref` are resolved locally
// (same document or a relative file); anything unresolvable is counted apart.
// Used by run.mjs (through docstats.mjs) to say how many operations a document has,
// independently of the library. Nothing in a spec is ever executed.
//
// A spec is somebody else's document, and its `$ref`s are data, not instructions: this pass reads ONLY regular files
// below the spec's own folder (`root`: the folder of a multi-file spec, or the one file of a single-file spec), through
// a reader that refuses an absolute path, `..`, a symlink anywhere on the way, a device, pipe or other special file,
// a file over MAX_FILE_BYTES and more than MAX_TOTAL_BYTES in all. A reference it refuses is an unresolved reference.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const YAML = require('yaml');

export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export function parseText(text, file) {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.parse(text); } catch { /* fall through to YAML */ }
  }
  return YAML.parse(text, { maxAliasCount: 100000 });
}

/**
 * A function `target -> text` that reads only regular files below `root` (a folder, or the one file that is allowed)
 * and throws for anything else. `root` must exist. The file is checked and read through one open descriptor, so what
 * is read is what was checked.
 */
export function confinedReader(root, { maxFileBytes = MAX_FILE_BYTES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  const lexicalRoot = path.resolve(root);
  const realRoot = fs.realpathSync(lexicalRoot);
  const rootIsFile = fs.statSync(realRoot).isFile();
  let total = 0;
  const refuse = (target, why) => { throw new Error(`refusing to read ${target}: ${why}`); };
  return (target) => {
    const lexical = path.resolve(target);
    const relative = path.relative(lexicalRoot, lexical);
    const inside = rootIsFile ? relative === '' : relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    if (!inside) refuse(target, 'outside the spec\'s own folder');
    // The real path must be where the lexical one says: a symlink anywhere between the root and the file moves it.
    const real = fs.realpathSync(lexical);
    if (real !== (relative === '' ? realRoot : path.join(realRoot, relative))) refuse(target, 'a symlink is in the way');
    // O_NOFOLLOW refuses a symlink swapped in at the last moment, O_NONBLOCK keeps a pipe from blocking the open.
    const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) refuse(target, 'not a regular file');
      if (stat.size > maxFileBytes) refuse(target, `larger than ${maxFileBytes} bytes`);
      if (total + stat.size > maxTotalBytes) refuse(target, `more than ${maxTotalBytes} bytes read for this spec`);
      const buffer = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < stat.size) {
        const n = fs.readSync(fd, buffer, offset, stat.size - offset, null);
        if (n === 0) break;
        offset += n;
      }
      total += offset;
      return buffer.toString('utf8', 0, offset);
    } finally {
      fs.closeSync(fd);
    }
  };
}

export function loadDoc(file, read = confinedReader(path.dirname(path.resolve(file)))) {
  return parseText(read(file), file);
}

const BASE_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function pointerGet(doc, ptr) {
  if (!ptr || ptr === '#' || ptr === '') return doc;
  const parts = ptr.replace(/^#?\/?/, '').split('/').map((s) => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = doc;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

export function analyzeDoc(doc, file, { read } = {}) {
  const declared = doc.openapi ?? doc.swagger;
  const v = String(declared ?? '');
  const is2 = v.startsWith('2');
  const is32 = v.startsWith('3.2');
  const methods = is2 ? ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] : BASE_METHODS;
  const dir = file ? path.dirname(file) : process.cwd();
  let unresolvedPathRefs = 0;
  const unresolved = [];

  const rootFile = file ? path.resolve(file) : null;
  // Without a reader a document may only read the folder of its own file (and none at all without a file).
  const reader = read ?? (file ? confinedReader(path.dirname(rootFile)) : (target) => { throw new Error(`refusing to read ${target}: the document has no file`); });
  const docCache = new Map();
  if (rootFile) docCache.set(rootFile, doc);
  // A file that cannot be read, is refused or does not parse is cached as null: every reference to it stays unresolved.
  const getDoc = (abs) => {
    if (!docCache.has(abs)) {
      let loaded = null;
      try { loaded = parseText(reader(abs), abs); } catch { /* unresolved */ }
      docCache.set(abs, loaded);
    }
    return docCache.get(abs);
  };
  // Resolve a (possibly $ref) object relative to the file it was read from. Returns { value, file } or null.
  function resolveObj(item, baseFile, depth = 0) {
    if (item && typeof item === 'object' && typeof item.$ref === 'string') {
      if (depth >= 10) return null;
      const ref = item.$ref;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return null;
      try {
        if (ref.startsWith('#')) {
          const d = baseFile ? getDoc(baseFile) : doc;
          const t = pointerGet(d, ref);
          return t && typeof t === 'object' ? resolveObj({ ...t }, baseFile, depth + 1) : null;
        }
        const [f, frag] = ref.split('#');
        const abs = path.resolve(baseFile ? path.dirname(baseFile) : dir, decodeURIComponent(f));
        const t = pointerGet(getDoc(abs), frag ? '#' + frag : '');
        return t && typeof t === 'object' ? resolveObj({ ...t }, abs, depth + 1) : null;
      } catch { return null; }
    }
    return { value: item, file: baseFile };
  }
  function resolvePathItem(item) {
    const r = resolveObj(item, rootFile);
    if (r === null) return null;
    // operations of the path item may themselves be $refs (DigitalOcean): resolve them one level
    const out = { ...r.value };
    for (const m of [...methods, 'query']) {
      if (out[m] && typeof out[m] === 'object' && typeof out[m].$ref === 'string') {
        const ro = resolveObj(out[m], r.file);
        if (ro) out[m] = ro.value;
      }
    }
    return out;
  }

  function opsOf(item) {
    const out = [];
    if (!item || typeof item !== 'object') return out;
    for (const m of methods) if (item[m] && typeof item[m] === 'object') out.push({ method: m, op: item[m] });
    if (is32) {
      if (item.query && typeof item.query === 'object') out.push({ method: 'query', op: item.query });
      if (item.additionalOperations && typeof item.additionalOperations === 'object') {
        for (const [m, op] of Object.entries(item.additionalOperations)) if (op && typeof op === 'object') out.push({ method: 'add:' + m, op });
      }
    }
    return out;
  }

  const paths = doc.paths && typeof doc.paths === 'object' ? Object.keys(doc.paths).filter((k) => !k.startsWith('x-')) : [];
  let operations = 0, deprecated = 0, noOperationId = 0;
  const byMethod = {};
  const opList = [];
  const ids = new Map();
  for (const p of paths) {
    const raw = doc.paths[p];
    const item = resolvePathItem(raw);
    if (item === null) { unresolvedPathRefs++; unresolved.push(p); continue; }
    for (const { method, op } of opsOf(item)) {
      operations++;
      opList.push({ path: p, method: method.startsWith('add:') ? method.slice(4) : method, deprecated: op.deprecated === true, operationId: op.operationId ?? null, kind: method.startsWith('add:') ? 'additional' : method === 'query' ? 'query' : 'fixed' });
      byMethod[method] = (byMethod[method] || 0) + 1;
      if (op.deprecated === true) deprecated++;
      if (!op.operationId) noOperationId++;
      else ids.set(op.operationId, (ids.get(op.operationId) || 0) + 1);
    }
  }
  let webhookOperations = 0;
  if (doc.webhooks && typeof doc.webhooks === 'object') {
    for (const k of Object.keys(doc.webhooks)) {
      const item = resolvePathItem(doc.webhooks[k]);
      webhookOperations += opsOf(item).length;
    }
  }
  const dupIds = [...ids.values()].filter((n) => n > 1).length;
  return {
    declaredVersion: v,
    title: doc.info?.title ?? null,
    paths: paths.length,
    operations,
    deprecatedOperations: deprecated,
    operationsWithoutOperationId: noOperationId,
    duplicateOperationIds: dupIds,
    webhookOperations,
    unresolvedPathRefs,
    unresolvedPathRefSample: unresolved.slice(0, 5),
    byMethod,
    opList,
  };
}

/** `options.root`: the folder (or the one file) the document may read; default: the folder of `file`. */
export function analyzeFile(file, { root } = {}) {
  const read = confinedReader(root ?? path.dirname(path.resolve(file)));
  return analyzeDoc(loadDoc(file, read), file, { read });
}
