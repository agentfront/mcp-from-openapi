// One attempt on one spec, run in its own process by run.mjs.
// usage: node --max-old-space-size=4096 child.mjs <specFile> <outJson> <optionsJson>
// The library is loaded ONLY from the repo's built output (dist/index.js). The spec is parsed as data
// (by the library and by stats.mjs); nothing in it is ever executed.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const [specFile, outFile, optionsJson] = process.argv.slice(2);
const attemptOptions = JSON.parse(optionsJson || '{}');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(REPO, 'package.json'));
const lib = require(path.join(REPO, 'dist', 'index.js'));
const { OpenAPIToolGenerator, buildHttpRequest } = lib;

// ---- console capture (the library warns per failed tool) ----
const captured = { count: 0, distinct: new Map(), byOperation: new Map() };
function capture(level, args) {
  const text = args.map((a) => (typeof a === 'string' ? a : (a && a.message) || JSON.stringify(a))).join(' ');
  captured.count++;
  const norm = text.slice(0, 400);
  captured.distinct.set(norm, (captured.distinct.get(norm) || 0) + 1);
  const m = /^Failed to generate tool for (\S+) (.+?):\s/.exec(text);
  if (m) captured.byOperation.set(`${m[1].toLowerCase()} ${m[2]}`, text.slice(0, 300));
}
for (const level of ['warn', 'error', 'log', 'info', 'debug']) console[level] = (...a) => capture(level, a);

const t = (() => { let last = performance.now(); return () => { const n = performance.now(); const d = n - last; last = n; return Math.round(d); }; })();
const result = { specFile, attemptOptions, nodeVersion: process.version, phases: {} };
const rssMB = () => Math.round(process.resourceUsage().maxRSS / 1024);

function describeError(e) {
  const out = { class: e?.constructor?.name ?? typeof e, name: e?.name, message: String(e?.message ?? e).slice(0, 500) };
  const errs = e?.errors ?? e?.context?.errors;
  if (Array.isArray(errs)) {
    out.validationErrorCount = errs.length;
    out.validationErrors = errs.slice(0, 10).map((x) => ({ code: x.code ?? null, message: String(x.message ?? x).slice(0, 220), path: x.path ?? null }));
    const byCode = {};
    for (const x of errs) byCode[x.code ?? 'NO_CODE'] = (byCode[x.code ?? 'NO_CODE'] || 0) + 1;
    out.validationErrorsByCode = byCode;
  }
  if (e?.context && typeof e.context === 'object') {
    const keys = Object.keys(e.context).filter((k) => k !== 'errors' && k !== 'originalError');
    if (keys.length) out.contextKeys = keys.slice(0, 8);
  }
  if (e?.stack) out.stackTop = String(e.stack).split('\n').slice(0, 4).join(' | ').slice(0, 400);
  return out;
}

// ---- synthetic input from an inputSchema (required properties only) ----
function synth(schema, depth) {
  if (!schema || typeof schema !== 'object') return 'x';
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  for (const k of ['oneOf', 'anyOf']) if (Array.isArray(schema[k]) && schema[k].length) return synth(schema[k][0], depth);
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const parts = schema.allOf.map((s) => synth(s, depth));
    if (parts.every((p) => p && typeof p === 'object' && !Array.isArray(p))) return Object.assign({}, ...parts);
    return parts[0];
  }
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((x) => x !== 'null') ?? type[0];
  if (!type) type = schema.properties ? 'object' : schema.items ? 'array' : 'string';
  switch (type) {
    case 'string': return 'x';
    case 'integer': return 1;
    case 'number': return 1;
    case 'boolean': return true;
    case 'null': return null;
    case 'array': return depth >= 3 ? [] : [synth(schema.items ?? {}, depth + 1)];
    case 'object': {
      const o = {};
      if (depth >= 3) return o;
      const req = Array.isArray(schema.required) ? schema.required : [];
      for (const k of req) o[k] = synth(schema.properties?.[k] ?? {}, depth + 1);
      return o;
    }
    default: return 'x';
  }
}
function synthInput(tool) {
  const s = tool.inputSchema ?? {};
  const input = {};
  const req = Array.isArray(s.required) ? s.required : [];
  for (const k of req) input[k] = synth(s.properties?.[k] ?? {}, 1);
  return input;
}

async function main() {
  const abs = path.resolve(specFile);
  const options = JSON.parse(JSON.stringify(attemptOptions));
  // No chdir: relative external $refs of a file are read against the file's own location (its file: URL).
  let generator;
  const tStart = performance.now();
  try {
    generator = await OpenAPIToolGenerator.fromFile(abs, options);
  } catch (e) {
    result.phases.load = { ok: false, ms: t(), error: describeError(e) };
    result.ok = false; result.failedAt = 'load'; return;
  }
  result.phases.load = { ok: true, ms: t() };

  let tools;
  try {
    tools = await generator.generateTools();
    result.phases.generate = { ok: true, ms: t() };
  } catch (e) {
    result.phases.generate = { ok: false, ms: t(), error: describeError(e) };
    result.ok = false; result.failedAt = 'generateTools';
    try { result.diagnostics = groupDiagnostics(generator.getDiagnostics()); } catch { /* ignore */ }
    return;
  }
  result.ok = true;
  result.toolCount = tools.length;
  result.firstToolNames = tools.slice(0, 5).map((x) => x.name);
  result.diagnostics = groupDiagnostics(generator.getDiagnostics());
  try { const v = generator.getSpecVersion(); result.specVersionInfo = JSON.parse(JSON.stringify(v)); } catch { /* optional */ }
  try {
    const v = await generator.validate();
    result.validate = { valid: v.valid, errorCount: v.errors?.length ?? 0, warningCount: v.warnings?.length ?? 0,
      warningsByCode: countBy(v.warnings ?? [], (w) => w.code ?? 'NO_CODE'), errorsByCode: countBy(v.errors ?? [], (w) => w.code ?? 'NO_CODE') };
  } catch (e) { result.validate = { threw: describeError(e) }; }
  t();

  // ---- tool keys go to a side file; the parent compares them with the document's operations
  // (keeps this process's memory/time free of a second parse of the spec) ----
  fs.writeFileSync(outFile + '.keys.json', JSON.stringify({
    tools: tools.map((x) => [x.metadata.method, x.metadata.path, x.name]),
    warned: [...captured.byOperation.keys()],
    diagnostics: generator.getDiagnostics().slice(0, 100000).map((d) => [d.code, d.severity, d.path ?? null]),
  }));
  result.phases.keys = { ms: t() };

  // ---- buildHttpRequest on the first 200 tools ----
  const reqRes = { attempted: 0, ok: 0, failed: 0, failures: {} };
  const sample = tools.slice(0, Number(process.env.CORPUS_REQUEST_LIMIT) || 200);
  for (const tool of sample) {
    reqRes.attempted++;
    try {
      const input = synthInput(tool);
      buildHttpRequest(tool, input, { baseUrl: 'https://example.invalid' });
      reqRes.ok++;
    } catch (e) {
      reqRes.failed++;
      const msg = `${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? e)}`.slice(0, 80);
      const f = (reqRes.failures[msg] ||= { count: 0, sampleTool: tool.name, fullMessage: String(e?.message ?? e).slice(0, 300) });
      f.count++;
    }
  }
  result.requests = reqRes;
  result.phases.requests = { ms: t() };

  // ---- lint ----
  try {
    const lr = await generator.lint();
    result.lint = { counts: lr.counts, total: lr.findings.length, byCode: countBy(lr.findings, (f) => `${f.severity}:${f.code}`) };
  } catch (e) { result.lint = { threw: describeError(e) }; }
  result.phases.lint = { ms: t() };
  result.phases.totalMs = Math.round(performance.now() - tStart);
}

function countBy(arr, fn) { const o = {}; for (const x of arr) { const k = fn(x); o[k] = (o[k] || 0) + 1; } return o; }
function groupDiagnostics(diags) {
  const g = {};
  for (const d of diags) {
    const e = (g[d.code] ||= { severity: d.severity, count: 0, samples: [] });
    e.count++;
    if (e.samples.length < 2) e.samples.push({ message: String(d.message).slice(0, 240), path: d.path ?? null });
  }
  return { total: diags.length, byCode: g };
}

let fatal = null;
try { await main(); } catch (e) { fatal = describeError(e); result.ok = false; result.failedAt = 'unexpected'; result.phases.unexpected = fatal; }
result.consoleMessages = { count: captured.count, distinct: captured.distinct.size, first5: [...captured.distinct.entries()].slice(0, 5).map(([m, c]) => ({ message: m, count: c })) };
result.perToolFailureWarnings = captured.byOperation.size;
result.childMaxRssMB = rssMB();
fs.writeFileSync(outFile, JSON.stringify(result));
process.exit(0);
