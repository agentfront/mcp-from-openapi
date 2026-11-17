#!/usr/bin/env node
// Runs every spec of scripts/spec-corpus/sources.json through the library's BUILT output (<repo>/dist/index.js), one child
// process per attempt, and writes results.json + REPORT.md under .spec-corpus/ (git-ignored; SPEC_CORPUS_DIR moves it).
// The specs come from `node scripts/spec-corpus/download.mjs`. Results are local: this is a survey of real documents, not a CI gate.
//
//   node scripts/spec-corpus/run.mjs                      all specs
//   node scripts/spec-corpus/run.mjs --version 3.2        only specs declaring 3.2.x   (also 3.1, 3.0, 2.0)
//   node scripts/spec-corpus/run.mjs --slug a,b           only these slugs
//   node scripts/spec-corpus/run.mjs --kind production    only production | example | test-fixture
//   node scripts/spec-corpus/run.mjs --timeout 60         per-attempt kill time in seconds (default 120)
//   node scripts/spec-corpus/run.mjs --no-build           never rebuild dist/ on a module error
//   node scripts/spec-corpus/run.mjs --no-verify          run specs whose bytes do not match sources.json (local experiments)
//   node scripts/spec-corpus/run.mjs --report-only        regenerate REPORT.md from results.json
//   node scripts/spec-corpus/run.mjs --request-limit 100000 --results results-requests-full.json --no-report
//                                                         supplementary sweep: build a request for EVERY tool (default: the first 200)
// A filtered run MERGES into the existing results.json (other specs keep their last result).
//
// Before a spec runs, its bytes are checked against sources.json (the sha256 of the root document and, for a multi-file spec,
// the file count, byte count and digest of its folder: integrity.mjs, the same code download.mjs verifies with). A spec that
// does not match is reported as HASH MISMATCH and skipped, its previous result untouched, and the exit code is 1. Without
// this a half-downloaded or edited file would be surveyed as if it were the pinned document. --no-verify runs it anyway.
//
// Loading: every attempt uses OpenAPIToolGenerator.fromFile(<abs path>, options) from a child process started in a scratch
// directory (not the spec's folder): relative external $refs are read against the file's own location, and a multi-file
// spec needs `file` among refResolution.allowedProtocols. Attempts per spec: `default` ({}); if it throws, `validate:false`;
// for multi-file specs also `local-refs` ({refResolution:{allowedProtocols:['file','http','https']}}) and, if that throws,
// `local-refs+validate:false`. No HTTP request is ever sent by this runner (buildHttpRequest only assembles; note a spec with
// remote https $refs makes the library fetch them).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { treeFolderOf, verifyOnDisk } from './integrity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
/** The downloaded specs and the results: `.spec-corpus/` of the repository (git-ignored), or SPEC_CORPUS_DIR. */
const CORPUS = process.env.SPEC_CORPUS_DIR ? path.resolve(process.env.SPEC_CORPUS_DIR) : path.join(REPO, '.spec-corpus');
const KNOWN_FLAGS = new Set(['slug', 'version', 'kind', 'timeout', 'no-build', 'no-verify', 'report-only', 'results', 'no-report', 'request-limit']);
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) { console.error(`Unexpected argument ${a}`); process.exit(2); }
  const k = a.slice(2);
  if (!KNOWN_FLAGS.has(k)) { console.error(`Unknown flag ${a}. Flags: ${[...KNOWN_FLAGS].map((f) => `--${f}`).join(' ')}`); process.exit(2); }
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[k] = true; else { args[k] = next; i++; }
}
const TIMEOUT_MS = (Number(args.timeout) || 120) * 1000;
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8'));
if (/[\\/]/.test(typeof args.results === 'string' ? args.results : '')) { console.error('--results is a file name inside the corpus folder'); process.exit(2); }
const resultsPath = path.join(CORPUS, typeof args.results === 'string' ? args.results : 'results.json');
const REQ_LIMIT = Number(args['request-limit']) || 200;
process.env.CORPUS_REQUEST_LIMIT = String(REQ_LIMIT);
fs.mkdirSync(CORPUS, { recursive: true });
/** A temp folder the children run in (so no spec's own folder is their working directory); made once a run starts. */
let scratch = null;
const prior = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : { specs: {} };

function selected() {
  let list = manifest.specs.filter((s) => s.file);
  if (args.slug) { const set = new Set(String(args.slug).split(',')); list = list.filter((s) => set.has(s.slug)); }
  if (args.version) list = list.filter((s) => s.declaredVersion === String(args.version) || String(s.declaredVersion).startsWith(`${args.version}.`));
  if (args.kind) list = list.filter((s) => s.kind === args.kind);
  return list;
}

function distInfo() {
  const p = path.join(REPO, 'dist', 'index.js');
  const st = fs.existsSync(p) ? fs.statSync(p) : null;
  const g = (a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout?.trim();
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
  return { distBuiltAt: st ? st.mtime.toISOString() : null, gitBranch: g(['rev-parse', '--abbrev-ref', 'HEAD']), gitHead: g(['rev-parse', '--short', 'HEAD']), dirtyFiles: (g(['status', '--porcelain']) || '').split('\n').filter(Boolean).length, packageVersion: version };
}

function runChild(specFile, options, label) {
  return new Promise((resolve) => {
    const out = path.join(scratch, `${label}-${Math.random().toString(36).slice(2)}.json`);
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--max-old-space-size=4096', path.join(HERE, 'child.mjs'), specFile, out, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe'], cwd: scratch });
    let stderr = '', stdout = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-2000); });
    let peakKB = 0;
    const poll = setInterval(() => {
      const r = spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' });
      const kb = Number((r.stdout || '').trim());
      if (kb > peakKB) peakKB = kb;
    }, 400);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearInterval(poll); clearTimeout(timer);
      const wallMs = Date.now() - t0;
      let res = null, keys = null;
      try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* none */ }
      try { keys = JSON.parse(fs.readFileSync(out + '.keys.json', 'utf8')); } catch { /* none */ }
      for (const f of [out, out + '.keys.json']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      const peakMB = Math.round(Math.max(peakKB, (res?.childMaxRssMB ?? 0) * 1024) / 1024);
      resolve({ label, options, wallMs, peakRssMB: peakMB, exitCode: code, signal, timedOut, stderrTail: res ? undefined : stderr.slice(-800), stdoutTail: stdout ? stdout.slice(-300) : undefined, result: res, keys });
    });
  });
}

let rebuilt = false;
async function attempt(specFile, options, label) {
  let r = await runChild(specFile, options, label);
  const modErr = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(r.stderrTail || '') && !r.result;
  if (modErr && !args['no-build'] && !rebuilt) {
    rebuilt = true;
    console.error('  module error -> rebuilding dist with `corepack yarn build`');
    spawnSync('corepack', ['yarn', 'build'], { cwd: REPO, encoding: 'utf8', timeout: 600000 });
    r = await runChild(specFile, options, label);
  }
  return r;
}

/** Bump when stats.mjs counts differently, so cached counts of the old pass are not reused. */
const STATS_CACHE_VERSION = 2;

function docStats(spec) {
  const cacheDir = path.join(CORPUS, '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  // Keyed by what was verified: the root's sha256 and, for a multi-file spec, its tree digest. Bytes that were NOT verified
  // (--no-verify) are never cached, nor read from the cache.
  const key = [spec.slug, spec.sha256.slice(0, 12), spec.tree ? spec.tree.sha256.slice(0, 12) : null, `v${STATS_CACHE_VERSION}`].filter(Boolean).join('.');
  const cache = path.join(cacheDir, `${key}.json`);
  if (!args['no-verify'] && fs.existsSync(cache)) { try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { /* recount */ } }
  // The pass may read only the spec's own folder (a multi-file spec) or file (a single-file one).
  const root = spec.tree ? path.join(CORPUS, treeFolderOf(spec.file, spec.slug)) : path.join(CORPUS, spec.file);
  const out = path.join(scratch, `${spec.slug}.stats.json`);
  const r = spawnSync(process.execPath, ['--max-old-space-size=4096', path.join(HERE, 'docstats.mjs'), path.join(CORPUS, spec.file), out, root], { encoding: 'utf8', timeout: 300000, cwd: scratch });
  let st;
  try { st = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return { error: (r.stderr || 'docstats failed').slice(-300) }; }
  finally { fs.rmSync(out, { force: true }); }
  // A failed count is not remembered: the next run tries again.
  if (!st.error && !args['no-verify']) fs.writeFileSync(cache, JSON.stringify(st));
  return st;
}

// '/paths/~1pets~1{id}/get' -> 'get /pets/{id}'; '/paths/~1x/additionalOperations/LINK' -> 'LINK /x'
function opFromPointer(ptr) {
  if (typeof ptr !== 'string' || !ptr.startsWith('/paths/')) return null;
  const parts = ptr.split('/').slice(2);
  const unesc = (x) => { try { x = decodeURIComponent(x); } catch { /* keep */ } return x.replace(/~1/g, '/').replace(/~0/g, '~'); };
  if (parts.length < 2) return null;
  if (parts[1] === 'additionalOperations' && parts[2]) return `${unesc(parts[2])} ${unesc(parts[0])}`;
  return `${unesc(parts[1])} ${unesc(parts[0])}`;
}

// '/paths/~1x/parameters/1' (a path-level finding) -> the path '/x'
function pathFromPointer(ptr) {
  if (typeof ptr !== 'string' || !ptr.startsWith('/paths/')) return null;
  const seg = ptr.split('/')[2];
  if (seg === undefined) return null;
  try { return decodeURIComponent(seg).replace(/~1/g, '/').replace(/~0/g, '~'); } catch { return seg.replace(/~1/g, '/').replace(/~0/g, '~'); }
}

function compareOps(st, keys, warnedSet) {
  if (!st || st.error || !keys) return { error: st?.error ?? 'no tool keys (generation failed)' };
  const k = (m, p) => `${m} ${p}`;
  const toolKeys = new Set(keys.tools.map(([m, p]) => k(m, p)));
  const docKeys = new Set(st.opList.map((o) => k(o.method, o.path)));
  const missing = st.opList.filter((o) => !toolKeys.has(k(o.method, o.path)));
  const out = { inDocument: st.opList.length, deprecatedInDocument: st.deprecatedOperations, webhookOperationsInDocument: st.webhookOperations, pathsInDocument: st.paths,
    unresolvedPathRefs: st.unresolvedPathRefs, unresolvedPathRefSample: st.unresolvedPathRefSample, duplicateOperationIds: st.duplicateOperationIds, withoutOperationId: st.operationsWithoutOperationId,
    tools: keys.tools.length, missing: missing.length, missingBecauseDeprecated: 0, missingWithWarning: 0, missingWithDiagnostic: 0, missingDiagnosticCodes: {}, missingUnexplained: 0, missingUnexplainedSample: [] };
  const unexplained = [];
  const diagByOp = new Map();
  const diagByPath = new Map();
  for (const [code, severity, p] of keys.diagnostics ?? []) {
    const o = opFromPointer(p);
    if (o && !/\/(parameters|servers|security)(\/|$)/.test(p.split('/').slice(3).map((x) => '/' + x).join('')) && p.split('/').length >= 4 && !p.split('/')[3].startsWith('parameters')) { const l = diagByOp.get(o) ?? new Set(); l.add(code); diagByOp.set(o, l); }
    else { const pp = pathFromPointer(p); if (pp !== null) { const l = diagByPath.get(pp) ?? new Set(); l.add(code); diagByPath.set(pp, l); } }
  }
  for (const o of missing) {
    const dk = `${o.method} ${o.path}`;
    if (o.deprecated) out.missingBecauseDeprecated++;
    else if (warnedSet.has(`${o.method.toLowerCase()} ${o.path}`)) out.missingWithWarning++;
    else if (diagByOp.has(dk) || diagByPath.has(o.path)) { out.missingWithDiagnostic++; for (const c of new Set([...(diagByOp.get(dk) ?? []), ...(diagByPath.get(o.path) ?? [])])) out.missingDiagnosticCodes[c] = (out.missingDiagnosticCodes[c] || 0) + 1; }
    else unexplained.push(o);
  }
  out.missingUnexplained = unexplained.length;
  out.missingUnexplainedSample = unexplained.slice(0, 8).map((o) => `${o.method} ${o.path}`);
  const extra = keys.tools.filter(([m, p]) => !docKeys.has(k(m, p)));
  out.toolsNotInDocument = extra.length;
  out.toolsNotInDocumentSample = extra.slice(0, 5).map(([m, p]) => `${m} ${p}`);
  out.toolNameCollisions = keys.tools.length - new Set(keys.tools.map((t) => t[2])).size;
  out.methodsMissingByKind = {};
  for (const o of unexplained) out.methodsMissingByKind[o.kind] = (out.methodsMissingByKind[o.kind] || 0) + 1;
  return out;
}

async function runSpec(spec) {
  const specFile = path.join(CORPUS, spec.file);
  const entry = { slug: spec.slug, title: spec.title, declaredVersion: spec.declaredVersion, kind: spec.kind, file: spec.file, multiFile: !!spec.tree, bytes: spec.bytes, attempts: [] };
  const attempts = [['default', {}]];
  const done = [];
  for (const [label, options] of attempts) {
    const a = await attempt(specFile, options, label);
    done.push(a);
    process.stderr.write(`  ${spec.slug} [${label}] ${a.timedOut ? 'TIMEOUT' : a.result ? (a.result.ok ? `${a.result.toolCount} tools` : `FAILED at ${a.result.failedAt}: ${a.result.phases?.[a.result.failedAt === 'generateTools' ? 'generate' : a.result.failedAt]?.error?.class}`) : 'CRASH'} ${(a.wallMs / 1000).toFixed(1)}s ${a.peakRssMB}MB\n`);
    if (label === 'default' && !(a.result && a.result.ok)) attempts.push(['validate:false', { validate: false }]);
    if (label === 'default' && entry.multiFile) attempts.push(['local-refs', { refResolution: { allowedProtocols: ['file', 'http', 'https'] } }]);
    if (label === 'local-refs' && !(a.result && a.result.ok)) attempts.push(['local-refs+validate:false', { validate: false, refResolution: { allowedProtocols: ['file', 'http', 'https'] } }]);
  }
  const st = docStats(spec);
  for (const a of done) {
    const warned = new Set(a.keys?.warned ?? []);
    entry.attempts.push({
      label: a.label, options: a.options, wallMs: a.wallMs, peakRssMB: a.peakRssMB, timedOut: a.timedOut, exitCode: a.exitCode, signal: a.signal, stderrTail: a.stderrTail,
      ok: !!(a.result && a.result.ok), result: a.result ? { ...a.result, operations: compareOps(st, a.keys, warned) } : null,
    });
  }
  entry.docStats = st.error ? { error: st.error } : { declaredVersion: st.declaredVersion, paths: st.paths, operations: st.operations, deprecatedOperations: st.deprecatedOperations, webhookOperations: st.webhookOperations, unresolvedPathRefs: st.unresolvedPathRefs, byMethod: st.byMethod };
  return entry;
}

// ------------------------------------------------------------------ report
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
function primary(e) { // the attempt the summary table reports: first that produced tools; else default
  return e.attempts.find((a) => a.label === 'default' && a.ok) || e.attempts.find((a) => a.ok && a.label.startsWith('local-refs') && !a.label.includes('validate')) || e.attempts.find((a) => a.ok) || e.attempts[0];
}
function reason(er) {
  if (!er) return '?';
  const m = String(er.message || '');
  if (/Swagger 2\.0 documents are not supported/.test(m)) return `rejected: Swagger 2.0${er.validationErrorCount ? ` (${er.validationErrorCount} errors)` : ''}`;
  if (/^Invalid OpenAPI document/.test(m)) return `rejected: invalid${er.validationErrorsByCode ? ' ' + Object.keys(er.validationErrorsByCode).slice(0, 2).join('/') : ''} (${er.validationErrorCount ?? '?'} errors)`;
  if (/Error parsing .*\.(ya?ml|json)/.test(m)) return 'load: invalid YAML/JSON in a referenced file';
  if (/Unable to resolve \$ref pointer/.test(m)) return 'load: external $ref not resolved';
  if (/node budget/.test(m)) return 'SchemaError: node budget';
  return `${er.class}: ${m.slice(0, 40)}`;
}
function validationOutcome(e) {
  const d = e.attempts.find((a) => a.label === 'default');
  if (!d) return 'n/a';
  if (d.timedOut) return 'timeout';
  if (!d.result) return 'crash';
  if (d.ok) return d.result.validate ? (d.result.validate.valid ? `pass${d.result.validate.warningCount ? ` (${d.result.validate.warningCount} warn)` : ''}` : `invalid (${d.result.validate.errorCount})`) : 'pass';
  return reason(d.result.phases?.generate?.error ?? d.result.phases?.load?.error);
}
function isClean(e) {
  const d = e.attempts.find((a) => a.label === 'default');
  if (!d?.ok) return false;
  const r = d.result, o = r.operations || {};
  return !o.error && o.missingUnexplained === 0 && (r.consoleMessages?.count ?? 0) === 0 && (r.requests?.failed ?? 0) === 0 && !Object.values(r.diagnostics?.byCode ?? {}).some((x) => x.severity !== 'info');
}

function renderReport(results, meta) {
  const L = [];
  const entries = Object.values(results.specs).sort((a, b) => String(b.declaredVersion).localeCompare(String(a.declaredVersion), undefined, { numeric: true }) || a.slug.localeCompare(b.slug));
  L.push('# Spec corpus run report', '');
  L.push(`Generated ${meta.generatedAt}. Library: built \`dist/\` of branch \`${meta.dist.gitBranch}\` @ ${meta.dist.gitHead} (dist built ${meta.dist.distBuiltAt}; ${meta.dist.dirtyFiles} uncommitted files in the tree), Node ${process.version}.`);
  if (meta.distChangedDuringRun) L.push(`**Warning: dist/ was rebuilt during this run (started with a build from ${meta.distBuiltAtStartOfRun}); re-run for a consistent result.**`, '');
  L.push(`Each attempt runs in its own process (\`--max-old-space-size=4096\`, killed after ${TIMEOUT_MS / 1000}s) with DEFAULT options; \`validate:false\` and, for multi-file specs, \`local-refs\` attempts are listed as extra rows. Re-run: \`node scripts/spec-corpus/run.mjs\`.`, '');
  L.push('## Summary', '');
  L.push('Columns: ops = operations in the document (3.2 counts `query` and `additionalOperations`; `$ref` path items resolved locally); dep = deprecated ops (excluded by the library default `includeDeprecated: false`); % = tools / ops; % non-dep = tools / (ops - dep). Time and memory are for the row\'s attempt (peak RSS of the child process).', '');
  L.push('| spec | version | kind | ops | dep | tools | % of ops | % non-dep | validation | diagnostics | console warns | req ok/tried | time | peak MB |');
  L.push('|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|---|---:|---:|');
  for (const e of entries) {
    for (const a of e.attempts) {
      const isDefault = a.label === 'default';
      if (!isDefault && !a.result) { /* still list crashes of extra attempts */ }
      const r = a.result, o = r?.operations ?? {};
      const ops = e.docStats?.operations ?? o.inDocument ?? '?';
      const dep = e.docStats?.deprecatedOperations ?? '?';
      const tools = r?.ok ? r.toolCount : a.timedOut ? 'timeout' : 0;
      const nonDep = typeof ops === 'number' && typeof dep === 'number' ? ops - dep : null;
      L.push(`| ${isDefault ? `**${e.slug}**` : `↳ ${e.slug} \`${a.label}\``} | ${e.declaredVersion} | ${e.kind} | ${ops} | ${dep} | ${tools} | ${typeof tools === 'number' ? pct(tools, ops) : '-'} | ${typeof tools === 'number' && nonDep ? pct(tools, nonDep) : '-'} | ${isDefault ? validationOutcome(e) : (a.ok ? 'ok' : (a.timedOut ? 'timeout' : a.result ? reason(a.result.phases?.generate?.error ?? a.result.phases?.load?.error) : 'crash'))} | ${r?.diagnostics?.total ?? '-'} | ${r?.consoleMessages?.count ?? '-'} | ${r?.requests ? `${r.requests.ok}/${r.requests.attempted}` : '-'} | ${sec(a.wallMs)} | ${a.peakRssMB} |`);
    }
  }
  L.push('');
  const clean = entries.filter(isClean);
  L.push(`Clean passes (default attempt generated every non-deprecated operation, no warnings, no diagnostics above info, all sampled requests built): ${clean.length} of ${entries.length}${clean.length ? ' - ' + clean.map((e) => e.slug).join(', ') : ''}.`, '');

  L.push('## Per-spec details (anything that is not a clean pass)', '');
  for (const e of entries) {
    if (isClean(e)) continue;
    L.push(`### ${e.slug} (${e.declaredVersion}, ${e.kind})`, '');
    L.push(`${e.title ?? ''} - \`${e.file}\`${e.multiFile ? ' (multi-file)' : ''}; document: ${e.docStats?.paths ?? '?'} paths, ${e.docStats?.operations ?? '?'} operations, ${e.docStats?.deprecatedOperations ?? '?'} deprecated, ${e.docStats?.webhookOperations ?? 0} webhook operations, ${e.docStats?.unresolvedPathRefs ?? 0} unresolvable path-item refs.`, '');
    for (const a of e.attempts) {
      const r = a.result;
      L.push(`- **attempt \`${a.label}\`**: ${a.timedOut ? `TIMED OUT after ${sec(a.wallMs)}` : !r ? `CRASH (exit ${a.exitCode}${a.signal ? ', ' + a.signal : ''}): ${(a.stderrTail || '').replace(/\s+/g, ' ').slice(0, 300)}` : r.ok ? `${r.toolCount} tools in ${sec(a.wallMs)}, ${a.peakRssMB} MB peak` : `failed at ${r.failedAt} in ${sec(a.wallMs)}`}`);
      if (!r) continue;
      if (!r.ok) {
        const er = r.phases?.generate?.error ?? r.phases?.load?.error ?? r.phases?.unexpected;
        if (er) {
          L.push(`  - error: \`${er.class}\`: ${String(er.message).replace(/\n/g, ' ').slice(0, 400)}`);
          for (const v of er.validationErrors ?? []) L.push(`    - ${v.code ?? ''} ${v.path ? `\`${v.path}\` ` : ''}${v.message}`);
          if (er.validationErrorsByCode) L.push(`  - validation errors by code: ${Object.entries(er.validationErrorsByCode).map(([c, n]) => `${c} x${n}`).join(', ')}`);
        }
        continue;
      }
      const o = r.operations ?? {};
      if (!o.error) L.push(`  - operations: ${o.inDocument} in document, ${o.tools} tools; missing ${o.missing} = ${o.missingBecauseDeprecated} deprecated + ${o.missingWithWarning} failed with a console warning + ${o.missingWithDiagnostic ?? 0} skipped with a diagnostic${o.missingWithDiagnostic ? ' (' + Object.entries(o.missingDiagnosticCodes).map(([c, n]) => `${c} x${n}`).join(', ') + ')' : ''} + ${o.missingUnexplained} unexplained${o.missingUnexplained ? ` (e.g. ${o.missingUnexplainedSample.slice(0, 4).join('; ')})` : ''}; tools not matching a document operation: ${o.toolsNotInDocument}${o.toolsNotInDocument ? ` (e.g. ${o.toolsNotInDocumentSample.slice(0, 3).join('; ')})` : ''}; tool-name collisions: ${o.toolNameCollisions}.`);
      L.push(`  - first tools: ${r.firstToolNames.map((n) => `\`${n}\``).join(', ')}`);
      const dg = r.diagnostics?.byCode ?? {};
      if (Object.keys(dg).length) L.push(`  - diagnostics (${r.diagnostics.total}): ${Object.entries(dg).map(([c, d]) => `${c} [${d.severity}] x${d.count}`).join(', ')}`);
      if (r.validate && !r.validate.valid) L.push(`  - validate(): ${r.validate.errorCount} errors (${Object.entries(r.validate.errorsByCode).map(([c, n]) => `${c} x${n}`).join(', ')})`);
      if (r.validate?.warningCount) L.push(`  - validate() warnings: ${Object.entries(r.validate.warningsByCode).map(([c, n]) => `${c} x${n}`).join(', ')}`);
      if (r.consoleMessages?.count) { L.push(`  - console output: ${r.consoleMessages.count} messages (${r.consoleMessages.distinct} distinct); first 5:`); for (const m of r.consoleMessages.first5) L.push(`    - x${m.count} \`${m.message.replace(/`/g, "'").replace(/\n/g, ' ').slice(0, 260)}\``); }
      if (r.requests) { L.push(`  - buildHttpRequest on first ${r.requests.attempted} tools: ${r.requests.ok} ok, ${r.requests.failed} failed`); for (const [m, f] of Object.entries(r.requests.failures)) L.push(`    - x${f.count} \`${m.replace(/`/g, "'")}\` (e.g. tool \`${f.sampleTool}\`)`); }
      if (r.lint && !r.lint.threw) L.push(`  - lint: ${r.lint.counts.error} errors, ${r.lint.counts.warning} warnings, ${r.lint.counts.info} infos`);
      if (r.lint?.threw) L.push(`  - lint threw: ${r.lint.threw.class}: ${r.lint.threw.message.slice(0, 200)}`);
      L.push(`  - phases: load ${sec(r.phases.load.ms)}, generate ${sec(r.phases.generate.ms)}, requests ${sec(r.phases.requests?.ms ?? 0)}, lint ${sec(r.phases.lint?.ms ?? 0)}`);
    }
    L.push('');
  }

  // ---- auto-grouped signals (data-driven; the class is a heuristic, see the column) ----
  const sigs = new Map();
  const sig = (id, title, cls) => { if (!sigs.has(id)) sigs.set(id, { id, title, cls, specs: new Set(), ops: 0, evidence: [] }); return sigs.get(id); };
  const addEv = (g, e) => { if (g.evidence.length < 3 && !g.evidence.includes(e)) g.evidence.push(e); };
  const clip = (m, n = 230) => String(m).split(`${CORPUS}/`).join('.spec-corpus/').replace(/\s+/g, ' ').slice(0, n);
  for (const e of entries) {
    const d = e.attempts.find((a) => a.label === 'default');
    const best = e.attempts.find((a) => a.ok);
    const docOps = e.docStats?.operations ?? 0;
    const derr = d?.result?.phases?.generate?.error ?? d?.result?.phases?.load?.error;
    if (d?.timedOut) { const g = sig('timeout', 'attempt killed at the time limit', '(d)'); g.specs.add(e.slug); g.ops += docOps; }
    else if (d && !d.result) { const g = sig('crash', 'child process crashed (no result)', '(a)'); g.specs.add(e.slug); g.ops += docOps; addEv(g, `${e.slug}: ${clip(d.stderrTail || '')}`); }
    if (derr) {
      const m = String(derr.message);
      if (/Swagger 2\.0 documents are not supported/.test(m)) {
        const g = sig('swagger2', 'Swagger 2.0 document rejected (and, with validate:false, tools lose body/formData operations and parameter types)', '(b) unsupported version');
        g.specs.add(e.slug); g.ops += docOps; addEv(g, `${e.slug}: ${clip(m, 150)} [${derr.validationErrorCount ?? '?'} errors; validate:false -> ${e.attempts.find((a) => a.label.includes('validate:false') && a.ok)?.result?.toolCount ?? 0} of ${docOps} ops]`);
      } else if (/Unable to resolve \$ref pointer/.test(m)) {
        const g = sig('extref', 'relative external $ref files not resolved with default options (the `file` protocol is not allowed by default)', '(b) limitation, unhelpful message');
        g.specs.add(e.slug); g.ops += docOps; addEv(g, `${e.slug}: ${clip(m, 190)}`);
      } else if (/Error parsing .*\.(ya?ml|json)/.test(m)) {
        const g = sig('badref', 'a referenced file is not valid YAML/JSON', '(c) invalid spec');
        g.specs.add(e.slug); g.ops += docOps; addEv(g, `${e.slug}: ${clip(m, 190)}`);
      } else if (/^Invalid OpenAPI document/.test(m)) {
        for (const code of Object.keys(derr.validationErrorsByCode ?? { UNKNOWN: 1 })) {
          const g = sig('val:' + code, `document rejected by validation: ${code}`, '(c) invalid spec, correctly rejected (strict, all-or-nothing)');
          g.specs.add(e.slug); g.ops += docOps; addEv(g, `${e.slug}: ${(derr.validationErrors ?? []).filter((v) => v.code === code).slice(0, 1).map((v) => `${v.path ?? ''} ${v.message}`).join('')}`);
        }
      } else { const g = sig('other:' + derr.class, `other failure: ${derr.class}`, '(d)'); g.specs.add(e.slug); g.ops += docOps; addEv(g, `${e.slug}: ${clip(m, 160)}`); }
    }
    for (const a of e.attempts) {
      const r = a.result; if (!r?.ok) continue;
      const swagger = String(e.declaredVersion).startsWith('2');
      if (r.consoleMessages?.count) {
        const bud = r.consoleMessages.first5.filter((x) => /node budget/.test(x.message)).length;
        const g = sig(bud ? 'budget' : 'console', bud ? 'tool skipped: schema exceeds maxSchemaNodes (default 100000) after depth truncation' : 'console warnings from the library', bud ? '(b) limitation (hard per-tool failure, raising the budget does not help)' : '(d)');
        if (a === best) { g.specs.add(e.slug); g.ops += r.perToolFailureWarnings ?? r.consoleMessages.count; addEv(g, `${e.slug}: ${r.perToolFailureWarnings} tools; ${clip(r.consoleMessages.first5[0].message, 150)}`); }
      }
      if (a === best) {
        for (const [msg, f] of Object.entries(r.requests?.failures ?? {})) { const key = msg.replace(/'[^']*'/g, "'..'").slice(0, 60); const g = sig('req:' + key, `buildHttpRequest failure: ${key}`, '(b/d) request building'); g.specs.add(e.slug); g.ops += f.count; addEv(g, `${e.slug}: tool ${f.sampleTool}: ${clip(f.fullMessage, 120)}`); }
        const o = r.operations ?? {};
        for (const [code, n] of Object.entries(o.missingDiagnosticCodes ?? {})) { const g = sig('skip:' + code, `operation skipped with diagnostic ${code}`, swagger ? '(b) Swagger 2.0 constructs' : '(c) spec defect or (d)'); g.specs.add(e.slug); g.ops += n; }
        if (r.validate && r.validate.valid === false && !swagger && !a.label.includes('validate:false')) { const g = sig('validate-raw', 'generator.validate() reports the document invalid although generateTools() validated it fine (it checks the raw, not the dereferenced, document)', '(a) inconsistency'); g.specs.add(e.slug); g.ops += o.tools ?? 0; addEv(g, `${e.slug} [${a.label}]: ${r.validate.errorCount} errors ${JSON.stringify(r.validate.errorsByCode)}`); }
        for (const [code, x] of Object.entries(r.diagnostics?.byCode ?? {})) if (x.severity !== 'info' && !/UNSUPPORTED_PARAMETER_LOCATION|INVALID_OPENAPI_VERSION|UNRESOLVED_SECURITY_SCHEME/.test(code) && !(swagger)) { const g = sig('diag:' + code, `diagnostic ${code} [${x.severity}]`, '(c) spec quality'); g.specs.add(e.slug); g.ops += x.count; addEv(g, `${e.slug}: ${clip(x.samples[0]?.message ?? '', 150)}`); }
      }
    }
    const b = e.attempts.find((a) => a.ok);
    if (b?.result?.operations && !b.result.operations.error && b.result.operations.missingUnexplained) { const g = sig('unexplained', 'operations without a tool and without any warning or diagnostic', '(a) candidate bug'); g.specs.add(e.slug); g.ops += b.result.operations.missingUnexplained; addEv(g, `${e.slug}: ${b.result.operations.missingUnexplainedSample.slice(0, 3).join('; ')}`); }
  }
  L.push('## Findings', '');
  L.push('### Auto-grouped by root cause (generated from results.json; ranked by specs affected, then operations)', '');
  L.push('"Ops" = operations in the affected documents for document-level failures, or the number of skipped tools / failures for per-tool signals. Class is a heuristic: (a) library bug or inconsistency, (b) limitation / unsupported feature, (c) invalid spec correctly rejected, (d) unclear.', '');
  L.push('| # | root cause | specs | ops | class |', '|---:|---|---:|---:|---|');
  const ranked = [...sigs.values()].sort((a, b) => b.specs.size - a.specs.size || b.ops - a.ops);
  ranked.forEach((g, i) => L.push(`| ${i + 1} | ${g.title} | ${g.specs.size} | ${g.ops} | ${g.cls} |`));
  L.push('');
  ranked.forEach((g, i) => { L.push(`${i + 1}. **${g.title}** - specs: ${[...g.specs].join(', ')}`); for (const ev of g.evidence) L.push(`   - ${ev.replace(/`/g, "'")}`); });
  L.push('');
  const findingsPath = path.join(CORPUS, 'findings.md');
  L.push(fs.existsSync(findingsPath) ? fs.readFileSync(findingsPath, 'utf8').trim() : '_Hand-written findings (classification and excerpts) are not part of this file: put them in `.spec-corpus/findings.md` and run `node scripts/spec-corpus/run.mjs --report-only` to include them here._');
  L.push('');
  return L.join('\n');
}

// ------------------------------------------------------------------ main
if (!args['report-only']) {
  let list = selected();
  if (list.length === 0) { console.error('No spec matches the filters.'); process.exit(2); }
  const missing = list.filter((s) => !fs.existsSync(path.join(CORPUS, s.file)));
  if (missing.length > 0) {
    console.error(`Not downloaded: ${missing.map((s) => s.slug).join(', ')}`);
    console.error(`Run: node scripts/spec-corpus/download.mjs${args.slug || args.version || args.kind ? ' (with the same filters)' : ''}`);
    process.exit(2);
  }
  // Only the bytes sources.json records are surveyed (see the top of this file).
  let skipped = 0;
  if (!args['no-verify']) {
    const kept = [];
    for (const s of list) {
      const why = await verifyOnDisk(CORPUS, s);
      if (why === null) { kept.push(s); continue; }
      skipped++;
      const fix = s.commit
        ? `\`node scripts/spec-corpus/download.mjs --slug ${s.slug}\` restores the pinned bytes`
        : `a live endpoint, not pinned to a commit: \`node scripts/spec-corpus/download.mjs --update --slug ${s.slug}\` records what it serves now`;
      console.error(`HASH MISMATCH ${s.slug}: ${why}; skipped. ${fix}; --no-verify runs it anyway`);
    }
    list = kept;
    if (skipped > 0) process.exitCode = 1;
    if (list.length === 0) { console.error(`No spec left to run: ${skipped} skipped for not matching sources.json.`); process.exit(1); }
  }
  scratch = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'spec-corpus-run-'));
  console.error(`corpus run: ${list.length} specs, per-attempt timeout ${TIMEOUT_MS / 1000}s`);
  const tStart = Date.now();
  const distAtStart = distInfo();
  const results = prior.specs ? prior : { specs: {} };
  for (const spec of list) {
    console.error(`${spec.slug} (${spec.declaredVersion}, ${(spec.bytes / 1048576).toFixed(2)} MB)`);
    results.specs[spec.slug] = await runSpec(spec);
    fs.writeFileSync(resultsPath, JSON.stringify({ ...results, meta: { generatedAt: new Date().toISOString(), dist: distInfo(), distBuiltAtStartOfRun: distAtStart.distBuiltAt, distChangedDuringRun: distAtStart.distBuiltAt !== distInfo().distBuiltAt, node: process.version, timeoutMs: TIMEOUT_MS, lastRunWallMs: Date.now() - tStart, lastRunSlugs: list.map((s) => s.slug) } }, null, 1));
  }
  const final = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  // drop results of specs no longer in the manifest
  const known = new Set(manifest.specs.map((s) => s.slug));
  for (const k of Object.keys(final.specs)) if (!known.has(k)) delete final.specs[k];
  fs.writeFileSync(resultsPath, JSON.stringify(final, null, 1));
  console.error(`done in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);
}
const finalResults = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
if (!args['no-report']) { fs.writeFileSync(path.join(CORPUS, 'REPORT.md'), renderReport(finalResults, finalResults.meta)); console.error(`wrote ${path.basename(resultsPath)} and REPORT.md`); } else console.error(`wrote ${path.basename(resultsPath)}`);
if (scratch) { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ } }
