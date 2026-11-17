#!/usr/bin/env node
/**
 * Public-type differential: compares every type exported by a candidate build of this package with a
 * published release of it, position by position and in both directions, and fails on any difference
 * that is not on the committed allowlist (scripts/public-types-allowlist.json).
 *
 * Usage:
 *   node scripts/diff-public-types.mjs [--baseline <version|dist-tag>] [--candidate <dir>]
 *                                      [--update-allowlist] [--json]
 *
 *   --baseline <v>       published version or dist-tag to compare against (default: the `baseline` the
 *                        allowlist records, so a new release never moves the target of a branch)
 *   --candidate <dir>    build output containing index.d.ts (default: ./dist, run `yarn build` first)
 *   --update-allowlist   rewrite the allowlist from the current differences and record the baseline
 *                        compared against; existing reasons are kept, new differences get "TODO: explain"
 *   --json               print machine-readable results on stdout
 *
 * Exit codes: 0 every difference is allowlisted under a cause with a reason and no entry is stale;
 *             1 otherwise; 2 environment or usage error (npm or network, missing build), which says
 *             nothing about the types.
 *
 * Allowlist: { "baseline": "<version>", "causes": [{ "reason": "...", "differences": [
 *                { "kind": "...", "direction": "...", "leaf": "...", "exports": ["..."] }, ...] }] }
 * One cause holds every position that one decision explains. A run fails on a difference that is not
 * listed (a new position, or a listed position reached from a new export), on a listed one that no
 * longer occurs (stale), and on a cause whose reason is blank or starts with TODO.
 *
 * What is compared:
 * - Each export is split into facets: its type meaning `Name` (interface, type alias, enum, class
 *   instance type) and its value meaning `typeof Name` (function, const, enum object, class constructor
 *   with its statics). Namespace exports are walked, so their members are facets `NS.Member`.
 * - For each facet present on both sides, the two types are walked together: properties, index
 *   signatures (`.*`), array and tuple elements (`[]`, `[i]`), parameters (`(name)`), return types
 *   (`()`), construct signatures (`.new(name)`), overloads (`#2(name)`), awaited values (`.await`) and
 *   the arguments of other shared generic types (`<i>`).
 * - A position reports one of these kinds:
 *     not-assignable           the old type there is not assignable to the new one (direction
 *                              baseline-to-candidate) or the new to the old (candidate-to-baseline);
 *                              reported at the deepest position that explains it. The direction is that
 *                              of the position itself, so at a parameter it is the parameter's types
 *     property-removed         a property of the old type is gone, optional or not
 *     property-added-required  the new type requires a property the old one did not have
 *     became-any, no-longer-any            one side is `any` and the other is not
 *     became-readonly, no-longer-readonly  a property, index signature, array or tuple changed
 *     export-removed           the facet is gone (an added facet is listed and never fails)
 *     truncated                an export with more than 400 positions keeps the first 400, or a walk
 *                              inside one named type stopped after 20000 steps
 *   The last four see what assignability cannot: an optional property removed, `any` coming or going,
 *   readonly changes.
 * - A position is named from the nearest enclosing type declared in the candidate (an alias, generic
 *   ones included, an interface or a class): its exported name (`OAS30.SchemaObject.type`), else its
 *   declared name (`SpecMap.*`). A change inside a shared type is therefore one position, listed with
 *   every export that reaches it. Each such type is walked once per pair; walks stop at cycles and at
 *   depth 16 inside one named type.
 * - Unions: a member the other side does not accept is compared with its most similar object member
 *   there (property names shared and agreeing on being optional, at least a third of them), else it is
 *   a position itself ("member ... has no counterpart"); that comparison reports only the direction it
 *   explains. Two members that are each other's closest match and mutually assignable are compared too,
 *   for the changes assignability cannot see.
 * - Generic interfaces, classes and type aliases are compared at their most general instantiation: each
 *   parameter at its default, else its constraint, else unknown. The probe references the type with only
 *   the parameters that lack a default, so the compiler fills the defaults; the required ones are
 *   declared, with their constraints, on `declare function f<P...>(): X<P...>`, and the type of `f()` is
 *   compared (with no inference candidates the compiler picks the constraint, or unknown).
 * - Both packages' declarations lose their private members (`private x`, `#private`) and `protected`
 *   becomes public before checking: TypeScript relates those nominally, so two copies of an unchanged
 *   class would otherwise never be assignable. Constructors keep their modifiers.
 * - Setup: a throwaway project in os.tmpdir() installs the baseline from npm as `baseline` (an alias),
 *   with the candidate's dependencies, its peer dependencies at the repo's dev ranges and Node's types,
 *   and gets a copy of the candidate's declarations as `node_modules/candidate`. Whatever the old
 *   declarations import arrives as a dependency of that old release; this repository never names it.
 *   Any type error in either package's declarations is an environment error, so an unresolved import
 *   can never turn a type into a silent `any`.
 *
 * Known limits: union members are paired by similarity, so a position inside a union may name a
 * different member than a reader would, and the structural checks (removed optional property, any,
 * readonly) see only members paired as mutual closest matches; parameters are positions like any other,
 * even where method bivariance keeps the export assignable; generic signatures, overload sets of
 * different sizes, a tuple's length and a list against an object are compared as a whole; a property
 * keyed by a well-known symbol is not a position of its own; private members and the protected modifier
 * are not compared; a generic type is checked at one instantiation only; readonly is read from
 * declarations, so readonly added through a mapped type (`Readonly<T>`) is seen only by assignability;
 * results hold for one compiler configuration (strict, NodeNext, lib es2022).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_FILE = path.join(REPO_ROOT, 'scripts', 'public-types-allowlist.json');
const BC = 'baseline-to-candidate';
const CB = 'candidate-to-baseline';
const KINDS = [
  'not-assignable',
  'property-removed',
  'property-added-required',
  'became-any',
  'no-longer-any',
  'became-readonly',
  'no-longer-readonly',
  'export-removed',
  'truncated',
];
const MAX_POSITIONS = 400; // per export
const MAX_DEPTH = 16; // segments inside one named type
const OWNER_BUDGET = 20000; // walk steps inside one named type
const SIMILAR = 1 / 3; // least share of property names for two union members to be compared
const USAGE =
  'Usage: diff-public-types.mjs [--baseline <version|dist-tag>] [--candidate <dir>] [--update-allowlist] [--json]';
// An exact version, or a dist-tag (letters first, no ':' or '/', so never a flag, path or URL).
const BASELINE_PATTERN = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[A-Za-z][A-Za-z0-9._-]{0,63})$/;
// Namespace import names in the probe; unlikely to be shadowed by a type parameter.
const NS = { baseline: '__baseline', candidate: '__candidate' };
const DIAGNOSTIC_LINES = 4;

class UsageError extends Error {}
class EnvironmentError extends Error {}

let tmpDir;
process.on('exit', () => tmpDir && fs.rmSync(tmpDir, { recursive: true, force: true }));
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

try {
  process.exitCode = main();
} catch (err) {
  const label =
    err instanceof UsageError
      ? 'USAGE ERROR'
      : err instanceof EnvironmentError
        ? 'ENVIRONMENT ERROR (not a type difference; fix the setup or re-run)'
        : 'INTERNAL ERROR';
  const message = err instanceof UsageError || err instanceof EnvironmentError ? err.message : err.stack;
  console.error(`diff-public-types: ${label}: ${message}`);
  process.exitCode = 2;
}

function main() {
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        baseline: { type: 'string' },
        candidate: { type: 'string' },
        'update-allowlist': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(`${err.message}\n${USAGE}`);
  }
  const allowlist = readAllowlist();
  const requested = args.baseline ?? allowlist.baseline;
  if (!requested) throw new UsageError(`the allowlist records no baseline: pass --baseline <version>\n${USAGE}`);
  if (!BASELINE_PATTERN.test(requested)) {
    throw new UsageError(`invalid baseline "${requested}": expected a version (1.2.3) or a dist-tag\n${USAGE}`);
  }
  const candidateDir = args.candidate ? path.resolve(args.candidate) : path.join(REPO_ROOT, 'dist');
  if (!fs.existsSync(path.join(candidateDir, 'index.d.ts'))) {
    throw new UsageError(`${path.join(candidateDir, 'index.d.ts')} not found: run \`yarn build\` first`);
  }
  let ts;
  try {
    ts = createRequire(path.join(REPO_ROOT, 'package.json'))('typescript');
  } catch {
    throw new EnvironmentError('typescript is not installed in the repository: run `yarn install` first');
  }
  const repoPkg = readJson(path.join(REPO_ROOT, 'package.json'));

  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diff-public-types-')));
  console.error(`Installing ${repoPkg.name}@${requested} as the baseline...`);
  const baselineVersion = install(tmpDir, `${repoPkg.name}@${requested}`, candidateDir, repoPkg);
  console.error(`Comparing ${repoPkg.name}@${baselineVersion} with ${candidateDir}...`);
  const { compared, added, tuples } = compare(ts, tmpDir);

  const rowKey = (d) => `${d.kind}\0${d.direction ?? ''}\0${d.leaf}`;
  const rows = new Map(); // one per position, with the exports that reach it
  for (const t of tuples) {
    if (!rows.has(rowKey(t))) rows.set(rowKey(t), { ...t, export: undefined, exports: [], diagnostics: [] });
    const row = rows.get(rowKey(t));
    row.exports.push(t.export);
    if (t.diagnostic) row.diagnostics.push(`${t.export}: ${t.diagnostic}`);
  }
  if (args['update-allowlist']) updateAllowlist(allowlist, [...rows.values()], baselineVersion, rowKey);

  const listed = new Map(); // tuple -> cause
  for (const cause of allowlist.causes) {
    for (const d of cause.differences) for (const e of d.exports) listed.set(`${rowKey(d)}\0${e}`, cause);
  }
  const found = new Set(tuples.map((t) => `${rowKey(t)}\0${t.export}`));
  const differences = [...rows.values()].map((row) => {
    const causes = row.exports.map((e) => listed.get(`${rowKey(row)}\0${e}`));
    return {
      kind: row.kind,
      ...(row.direction ? { direction: row.direction } : {}),
      leaf: row.leaf,
      detail: row.detail,
      exports: row.exports,
      unlisted: row.exports.filter((_, i) => !causes[i]),
      reason: causes.find(Boolean)?.reason,
      diagnostic: row.diagnostics[0],
    };
  });
  const stale = [];
  for (const cause of allowlist.causes) {
    for (const d of cause.differences) {
      const gone = d.exports.filter((e) => !found.has(`${rowKey(d)}\0${e}`));
      if (gone.length) stale.push({ kind: d.kind, direction: d.direction, leaf: d.leaf, exports: gone });
    }
  }
  const unexplained = allowlist.causes
    .filter((c) => !hasReason(c) && c.differences.some((d) => d.exports.some((e) => found.has(`${rowKey(d)}\0${e}`))))
    .map((c) => ({ reason: c.reason ?? '', positions: c.differences.length }));
  const ok = differences.every((d) => !d.unlisted.length) && !stale.length && !unexplained.length;
  const live = (c) => c.differences.some((d) => d.exports.some((e) => found.has(`${rowKey(d)}\0${e}`)));

  const report = {
    ok,
    baseline: { requested, source: args.baseline ? '--baseline' : 'allowlist', version: baselineVersion },
    candidate: candidateDir,
    allowlist: { file: path.relative(REPO_ROOT, ALLOWLIST_FILE), baseline: allowlist.baseline ?? null },
    compared,
    causes: allowlist.causes.filter(live).length,
    differences,
    stale,
    unexplained,
    added,
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report, repoPkg.name);
  return ok || args['update-allowlist'] ? 0 : 1;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${err.message}`);
  }
}

function readAllowlist() {
  if (!fs.existsSync(ALLOWLIST_FILE)) return { baseline: undefined, causes: [] };
  const data = readJson(ALLOWLIST_FILE);
  const validRow = (d) =>
    KINDS.includes(d?.kind) &&
    (d.kind === 'not-assignable' ? [BC, CB].includes(d.direction) : d.direction === undefined) &&
    typeof d.leaf === 'string' &&
    Array.isArray(d.exports) &&
    d.exports.every((e) => typeof e === 'string');
  const valid =
    (data?.baseline === undefined || typeof data.baseline === 'string') &&
    Array.isArray(data?.causes) &&
    data.causes.every((c) => Array.isArray(c?.differences) && c.differences.every(validRow));
  if (!valid) {
    throw new UsageError(
      `${ALLOWLIST_FILE} must be { "baseline", "causes": [{ "reason", "differences": [{ "kind", "direction", ` +
        `"leaf", "exports" }] }] }: kind one of ${KINDS.join(', ')}; direction ${BC} or ${CB}, only for not-assignable`,
    );
  }
  return data;
}

function hasReason(cause) {
  return typeof cause.reason === 'string' && cause.reason.trim() !== '' && !/^\s*TODO/i.test(cause.reason);
}

/**
 * Regroups the current positions under the causes that listed them before, export by export (an export
 * new to a listed position joins the position's first cause); new positions go to a TODO cause.
 */
function updateAllowlist(allowlist, rows, baselineVersion, rowKey) {
  const byRow = new Map();
  const byExport = new Map();
  allowlist.causes.forEach((cause, i) => {
    for (const d of cause.differences) {
      if (!byRow.has(rowKey(d))) byRow.set(rowKey(d), i);
      for (const e of d.exports) if (!byExport.has(`${rowKey(d)}\0${e}`)) byExport.set(`${rowKey(d)}\0${e}`, i);
    }
  });
  const fresh = allowlist.causes.length;
  const reasons = [...allowlist.causes.map((c) => c.reason), 'TODO: explain'];
  const causes = reasons.map((reason) => ({ reason, differences: [] }));
  for (const row of rows) {
    const groups = new Map();
    for (const e of row.exports) {
      const i = byExport.get(`${rowKey(row)}\0${e}`) ?? byRow.get(rowKey(row)) ?? fresh;
      groups.set(i, [...(groups.get(i) ?? []), e]);
    }
    const direction = row.direction ? { direction: row.direction } : {};
    for (const [i, exports] of groups) {
      causes[i].differences.push({ kind: row.kind, ...direction, leaf: row.leaf, exports });
    }
  }
  allowlist.baseline = baselineVersion;
  allowlist.causes = causes.filter((cause) => cause.differences.length);
  fs.writeFileSync(ALLOWLIST_FILE, formatAllowlist(allowlist));
  console.error(
    `Wrote ${rows.length} positions under ${allowlist.causes.length} causes to ` +
      `${path.relative(REPO_ROOT, ALLOWLIST_FILE)} (baseline ${baselineVersion}).`,
  );
}

/** JSON with one position per line, so a cause reads as a list. */
function formatAllowlist({ baseline, causes }) {
  const value = (v) => (Array.isArray(v) ? `[${v.map((s) => JSON.stringify(s)).join(', ')}]` : JSON.stringify(v));
  const row = (d) => `{ ${Object.entries(d).map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`).join(', ')} }`;
  const blocks = causes.map(
    (c) =>
      `    {\n      "reason": ${JSON.stringify(c.reason)},\n      "differences": [\n` +
      `${c.differences.map((d) => `        ${row(d)}`).join(',\n')}\n      ]\n    }`,
  );
  const list = blocks.length ? `\n${blocks.join(',\n')}\n  ` : '';
  return `{\n  "baseline": ${JSON.stringify(baseline)},\n  "causes": [${list}]\n}\n`;
}

/** Installs the baseline and copies the candidate into `dir`; returns the baseline's resolved version. */
function install(dir, baselineSpec, candidateDir, repoPkg) {
  const candidatePkgFile = path.join(candidateDir, 'package.json');
  const candidatePkg = fs.existsSync(candidatePkgFile) ? readJson(candidatePkgFile) : repoPkg;
  const devRanges = repoPkg.devDependencies ?? {};
  const dependencies = { ...candidatePkg.dependencies };
  for (const [name, range] of Object.entries(candidatePkg.peerDependencies ?? {})) {
    dependencies[name] = devRanges[name] ?? range;
  }
  dependencies['@types/node'] = devRanges['@types/node']; // the declarations import node: built-ins
  dependencies.baseline = `npm:${baselineSpec}`;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies }, null, 2));
  try {
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
  } catch (err) {
    throw new EnvironmentError(
      `npm could not install ${baselineSpec} (registry or network problem, or no such version):\n` +
        (err.stderr || err.message).trim(),
    );
  }
  // After the install: npm prunes anything in node_modules it did not put there.
  const target = path.join(dir, 'node_modules', 'candidate');
  fs.cpSync(candidateDir, target, {
    recursive: true,
    filter: (src) => fs.statSync(src).isDirectory() || /\.d\.[cm]?ts$/.test(src),
  });
  fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'candidate', types: './index.d.ts' }));
  return readJson(path.join(dir, 'node_modules', 'baseline', 'package.json')).version;
}

function compare(ts, dir) {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts'],
    types: ['node'],
    typeRoots: [path.join(dir, 'node_modules', '@types')],
    strict: true,
    noEmit: true,
  };
  const probeFile = path.join(dir, 'probe.ts');
  const imports = Object.entries(NS).map(([pkg, ns]) => `import * as ${ns} from '${pkg}';`);
  let probeText = imports.join('\n');
  const packageDirs = Object.keys(NS).map((pkg) => `${dir}/node_modules/${pkg}/`);
  const isPackageFile = (file) =>
    packageDirs.some((p) => file.startsWith(p) && !file.includes('/node_modules/', p.length));
  const parsed = new Map(); // shared by both programs, so the second one reuses every parsed file
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => dir;
  host.getSourceFile = (file, languageVersion) => {
    if (file === probeFile) return ts.createSourceFile(file, probeText, languageVersion);
    if (!parsed.has(file)) {
      const text = ts.sys.readFile(file);
      const source = text !== undefined && isPackageFile(file) ? publicSurface(ts, file, text) : text;
      parsed.set(file, source === undefined ? undefined : ts.createSourceFile(file, source, languageVersion));
    }
    return parsed.get(file);
  };

  // Program 1: enumerate both entrypoints.
  let program = ts.createProgram({ rootNames: [probeFile], options, host });
  const broken = [
    ...program.getOptionsDiagnostics(),
    ...program
      .getSourceFiles()
      .flatMap((sf) => (isPackageFile(sf.fileName) ? program.getSemanticDiagnostics(sf) : [])),
    ...program.getGlobalDiagnostics(),
  ];
  if (broken.length) {
    const shown = broken.slice(0, 10).map((d) => `  ${describe(ts, d, dir)}`);
    throw new EnvironmentError(`the installed declarations do not type-check:\n${shown.join('\n')}`);
  }
  let checker = program.getTypeChecker();
  let probe = program.getSourceFile(probeFile);
  const [baseline, candidate] = probe.statements.map((statement) => {
    const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
    if (!moduleSymbol) throw new EnvironmentError(`cannot resolve '${statement.moduleSpecifier.text}'`);
    return collectFacets(ts, checker, moduleSymbol, probe);
  });
  // Exported name of each candidate declaration, used to name positions (shortest name wins).
  const exportNames = new Map();
  for (const facet of [...candidate.values()].sort((a, b) => a.name.length - b.name.length || cmp(a.name, b.name))) {
    if (facet.declaration && !exportNames.has(facet.declaration)) exportNames.set(facet.declaration, facet.name);
  }

  // Program 2: one alias per side of every common facet, plus the assignments that explain failures.
  const common = [...baseline.keys()].filter((id) => candidate.has(id)).sort();
  const lines = [...imports];
  const assignmentLines = new Map(); // probe line -> [facet index, direction]
  common.forEach((id, i) => {
    lines.push(...aliasLines(`__b${i}`, NS.baseline, baseline.get(id)));
    lines.push(...aliasLines(`__c${i}`, NS.candidate, candidate.get(id)));
    lines.push(`declare const __b${i}_value: __b${i};`, `declare const __c${i}_value: __c${i};`);
    assignmentLines.set(lines.length, [i, BC]);
    lines.push(`const __b${i}_to_c: __c${i} = __b${i}_value;`);
    assignmentLines.set(lines.length, [i, CB]);
    lines.push(`const __c${i}_to_b: __b${i} = __c${i}_value;`);
  });
  probeText = lines.join('\n');
  program = ts.createProgram({ rootNames: [probeFile], options, host, oldProgram: program });
  checker = program.getTypeChecker();
  probe = program.getSourceFile(probeFile);

  const diagnostics = new Map(); // `${facet index}\0${direction}` -> first diagnostic of its assignment
  for (const d of [...program.getSyntacticDiagnostics(probe), ...program.getSemanticDiagnostics(probe)]) {
    const line = ts.getLineAndCharacterOfPosition(probe, d.start ?? 0).line;
    if (!assignmentLines.has(line)) {
      const message = `the comparison probe does not compile: ${describe(ts, d, dir)}`;
      throw new Error(`${message}\n  at: ${lines[line]}`);
    }
    const key = assignmentLines.get(line).join('\0');
    if (!diagnostics.has(key)) diagnostics.set(key, describe(ts, d, dir));
  }
  const types = new Map(
    probe.statements.filter(ts.isTypeAliasDeclaration).map((s) => [s.name.text, checker.getTypeFromTypeNode(s.type)]),
  );

  const walker = createWalker(ts, checker, probe, dir, exportNames);
  const tuples = [...baseline.keys()]
    .filter((id) => !candidate.has(id))
    .map((id) => ({ export: id, kind: 'export-removed', leaf: id }));
  common.forEach((id, i) => {
    const [b, c] = [types.get(`__b${i}`), types.get(`__c${i}`)];
    let found = walker.positions(b, c, id);
    if (found.length > MAX_POSITIONS) {
      const marker = { kind: 'truncated', leaf: `${id} (+${found.length - MAX_POSITIONS})` };
      found = [...found.slice(0, MAX_POSITIONS), marker];
    }
    for (const p of found) tuples.push({ export: id, ...p, diagnostic: diagnostics.get(`${i}\0${p.direction}`) });
  });
  const added = [...candidate.keys()].filter((id) => !baseline.has(id)).sort();
  return { compared: common.length, added, tuples };
}

/**
 * Walks a baseline type and a candidate type together and returns their differing positions. Named
 * candidate types are walked once per (baseline, candidate, directions) and referenced from their users,
 * so the positions of an export are those of its own walk plus every named type it reaches.
 *
 * A walk carries the directions it reports: both at an export, one where a union member was paired only
 * to explain why that member is not accepted (and swapped at a parameter, which is contravariant).
 */
function createWalker(ts, checker, probe, dir, exportNames) {
  const ids = new Map();
  const idOf = (t) => ids.get(t) ?? (ids.set(t, ids.size), ids.size - 1);
  const pairKey = (b, c) => `${idOf(b)}:${idOf(c)}`;
  const assignable = new Map();
  const isAssignable = (s, t) => {
    const key = pairKey(s, t);
    if (!assignable.has(key)) assignable.set(key, checker.isTypeAssignableTo(s, t));
    return assignable.get(key);
  };
  const flip = (d) => (d === BC ? CB : BC);
  const candidateDir = `${dir}/node_modules/candidate/`;
  const owners = new Map(); // pair and directions -> { name, items, edges, steps }
  const text = (t) => {
    const s = readable(checker.typeToString(t, probe, ts.TypeFormatFlags.NoTruncation), dir);
    return s.length > 120 ? `${s.slice(0, 119)}…` : s;
  };
  const both = (b, c) => `baseline: ${text(b)}; candidate: ${text(c)}`;
  const isAny = (t) => (t.flags & ts.TypeFlags.Any) !== 0;
  const isObjectLike = (t) =>
    (t.flags & ts.TypeFlags.Object) !== 0 ||
    ((t.flags & ts.TypeFlags.Intersection) !== 0 && t.types.every(isObjectLike));
  const isReference = (t) => (t.flags & ts.TypeFlags.Object) !== 0 && (t.objectFlags & ts.ObjectFlags.Reference) !== 0;
  const isList = (t) => checker.isArrayType(t) || checker.isTupleType(t);
  const isOptional = (p) => (p.flags & ts.SymbolFlags.Optional) !== 0;
  const isReadonly = (p) =>
    (p.declarations ?? []).some((d) => (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly) !== 0);
  const isReadonlyList = (t) =>
    checker.isTupleType(t) ? t.target.readonly : t.target.symbol?.name === 'ReadonlyArray';
  const ownDeclaration = (symbol) =>
    symbol?.declarations?.find((d) => d.getSourceFile().fileName.startsWith(candidateDir));
  // Well-known symbol keys (`__@iterator@12`) carry a compiler-internal id, so they are not positions.
  const properties = (t) => checker.getPropertiesOfType(t).filter((p) => !p.name.startsWith('__@'));

  /**
   * Name of a candidate type declared in the candidate package: an alias (generic ones too, so a recursive
   * generic alias is walked once per pair), a class or an interface. Else undefined.
   */
  const nameOf = (c) => {
    const alias = ownDeclaration(c.aliasSymbol);
    if (alias) return exportNames.get(alias) ?? c.aliasSymbol.name;
    const named = ts.ObjectFlags.ClassOrInterface | ts.ObjectFlags.Reference;
    if (!(c.flags & ts.TypeFlags.Object) || !(c.objectFlags & named)) return undefined;
    const symbol = (isReference(c) ? c.target : c).symbol;
    const declaration = ownDeclaration(symbol);
    return declaration && (exportNames.get(declaration) ?? symbol.name);
  };
  const propertySegment = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`);

  const owner = (b, c, directions, name) => {
    const key = `${pairKey(b, c)}:${directions.join()}`;
    if (!owners.has(key)) {
      const o = { name: nameOf(c) ?? name, items: [], edges: new Set(), steps: 0 };
      owners.set(key, o);
      walk(b, c, '', o, new Set(), 0, directions, true);
    }
    return key;
  };

  /**
   * Records the positions of one pair into `o`; returns the reported directions in which the pair is not
   * assignable (each of them is explained by a position at or below this one).
   */
  function walk(b, c, rel, o, stack, depth, directions, root = false) {
    if (b === c) return [];
    const fails = directions.filter((d) => !(d === BC ? isAssignable(b, c) : isAssignable(c, b)));
    const add = (kind, direction, at, detail) => {
      if (kind === 'not-assignable' && !directions.includes(direction)) return;
      o.items.push({ kind, direction, rel: at, detail });
    };
    if (++o.steps > OWNER_BUDGET) {
      if (o.steps === OWNER_BUDGET + 1) add('truncated', undefined, '', `walk stopped after ${OWNER_BUDGET} steps`);
      return fails;
    }
    if (isAny(b) !== isAny(c)) {
      add(isAny(c) ? 'became-any' : 'no-longer-any', undefined, rel, both(b, c));
      return fails;
    }
    if (isAny(b)) return fails;
    if (!root && nameOf(c) !== undefined) {
      o.edges.add(owner(b, c, directions));
      return fails;
    }
    const key = pairKey(b, c);
    if (stack.has(key)) return fails; // an anonymous cycle: reported where it started
    if (depth > MAX_DEPTH) {
      for (const d of fails) add('not-assignable', d, rel, `${both(b, c)} (walk stopped at depth ${MAX_DEPTH})`);
      return fails;
    }
    stack.add(key);
    const context = { rel, o, stack, depth, directions, add };
    if ((b.flags | c.flags) & ts.TypeFlags.Union) {
      unionPositions(b, c, context);
    } else {
      const structural = isObjectLike(b) && isObjectLike(c);
      const explained = structural ? objectPositions(b, c, context) : new Set();
      for (const d of fails) if (!explained.has(d)) add('not-assignable', d, rel, both(b, c));
    }
    stack.delete(key);
    return fails;
  }

  /**
   * A member not accepted by the other union is paired with its most similar object member, else it is a
   * position itself. Mutually assignable members are paired too, for the changes assignability misses.
   */
  function unionPositions(b, c, { rel, o, stack, depth, directions, add }) {
    const members = (t) => (t.flags & ts.TypeFlags.Union ? t.types.filter(isObjectLike) : isObjectLike(t) ? [t] : []);
    const all = (t) => (t.flags & ts.TypeFlags.Union ? t.types : [t]);
    const pairs = new Map(); // pair -> [x, y, directions]
    const pair = ([x, y], ds) => {
      const key = pairKey(x, y);
      if (!pairs.has(key)) pairs.set(key, [x, y, new Set()]);
      for (const d of ds) pairs.get(key)[2].add(d);
    };
    // Two members that are each other's closest counterpart and mutually assignable: for the changes
    // assignability cannot see.
    const closestInC = (x) => closest(x, members(c).map((y) => [x, y]), BC, SIMILAR);
    const closestInB = (y) => closest(y, members(b).map((x) => [x, y]), CB, SIMILAR);
    for (const x of members(b)) {
      const best = closestInC(x);
      if (best && closestInB(best[1])?.[0] === x && isAssignable(x, best[1]) && isAssignable(best[1], x)) {
        pair(best, directions);
      }
    }
    // A member the other union does not accept: its most similar object member, else a position here.
    for (const [direction, own, whole, candidates] of [
      [BC, all(b), c, (x) => members(c).map((y) => [x, y])],
      [CB, all(c), b, (y) => members(b).map((x) => [x, y])],
    ]) {
      if (!directions.includes(direction)) continue;
      for (const m of own) {
        if (isAssignable(m, whole)) continue;
        const best = isObjectLike(m) ? closest(m, candidates(m), direction, SIMILAR) : undefined;
        if (best) pair(best, [direction]);
        else {
          const side = direction === BC ? 'baseline' : 'candidate';
          add('not-assignable', direction, rel, `${side} member ${text(m)} has no counterpart in ${text(whole)}`);
        }
      }
    }
    for (const [x, y, ds] of pairs.values()) walk(x, y, rel, o, stack, depth + 1, directions.filter((d) => ds.has(d)));
  }

  /**
   * Of the candidate pairs for member `m`, the one whose other member is most alike: property names
   * shared and agreeing on being optional, over all names (sharing at least `threshold` of the names);
   * ties go to the same declared name, then the same version digits where declared, then the first.
   */
  function closest(m, candidates, direction, threshold) {
    const own = new Map(properties(m).map((p) => [p.name, isOptional(p)]));
    // Declared name and the version digits of where it is declared (`OpenAPIV3_1.X`, `.../v3_1".X`).
    const declared = (t) => {
      const symbol = t.aliasSymbol ?? t.symbol;
      if (!symbol || symbol.name.startsWith('__')) return {};
      const qualified = readable(checker.getFullyQualifiedName(symbol), dir);
      const version = qualified.slice(0, -symbol.name.length).replace(/\D/g, '').replace(/0+$/, '');
      return { name: symbol.name, version };
    };
    const mine = declared(m);
    const sameName = (other) => {
      const theirs = declared(other);
      return (theirs.name !== undefined && theirs.name === mine.name ? 2e-6 : 0) +
        (theirs.version && theirs.version === mine.version ? 1e-6 : 0);
    };
    let best;
    let bestScore = -1;
    for (const p of candidates) {
      const other = direction === BC ? p[1] : p[0];
      const props = properties(other);
      const shared = props.filter((q) => own.has(q.name));
      const union = own.size + props.length - shared.length;
      const similarity = union ? shared.length / union : 1;
      if (similarity < threshold) continue;
      const agreeing = shared.filter((q) => own.get(q.name) === isOptional(q)).length;
      const score = (union ? agreeing / union : 1) + sameName(other);
      if (score > bestScore) [best, bestScore] = [p, score];
    }
    return best;
  }

  /** Positions of two object types; returns the directions some position below explains. */
  function objectPositions(b, c, { rel, o, stack, depth, directions, add }) {
    const explained = new Set();
    const child = (bt, ct, at, contravariant = false) => {
      const ds = contravariant ? directions.map(flip) : directions;
      for (const d of walk(bt, ct, at, o, stack, depth + 1, ds)) explained.add(contravariant ? flip(d) : d);
    };
    const readonlyChange = (bReadonly, cReadonly, at) => {
      if (bReadonly !== cReadonly) add(cReadonly ? 'became-readonly' : 'no-longer-readonly', undefined, at, '');
    };
    if (isList(b) || isList(c)) {
      if (isList(b) && isList(c)) readonlyChange(isReadonlyList(b), isReadonlyList(c), rel);
      if (checker.isTupleType(b) && checker.isTupleType(c)) {
        const [bArgs, cArgs] = [checker.getTypeArguments(b), checker.getTypeArguments(c)];
        if (bArgs.length === cArgs.length) bArgs.forEach((t, i) => child(t, cArgs[i], `${rel}[${i}]`));
        return explained;
      }
      // Arrays, an array against a tuple or an intersection of arrays: their elements; the shape itself
      // (a tuple's length) is compared as a whole.
      const element = (t) => checker.getIndexInfosOfType(t).find((i) => i.keyType.flags & ts.TypeFlags.Number)?.type;
      const [be, ce] = [element(b), element(c)];
      if (be && ce) child(be, ce, `${rel}[]`);
      return explained;
    }
    if (isReference(b) && isReference(c) && b.target === c.target && !ownDeclaration(c.target.symbol)) {
      const segment = c.target.symbol?.name === 'Promise' ? () => '.await' : (i) => `<${i}>`;
      const cArgs = checker.getTypeArguments(c);
      checker.getTypeArguments(b).forEach((t, i) => cArgs[i] && child(t, cArgs[i], rel + segment(i)));
      return explained;
    }
    const bProps = new Map(properties(b).map((p) => [p.name, p]));
    const cProps = new Map(properties(c).map((p) => [p.name, p]));
    for (const [name, bp] of bProps) {
      const cp = cProps.get(name);
      const at = rel + propertySegment(name);
      if (!cp) {
        add('property-removed', undefined, at, `baseline: ${text(checker.getTypeOfSymbol(bp))}`);
        if (!isOptional(bp)) explained.add(CB);
        continue;
      }
      readonlyChange(isReadonly(bp), isReadonly(cp), at);
      if (isOptional(bp) !== isOptional(cp)) {
        const direction = isOptional(bp) ? BC : CB;
        const detail = `${isOptional(bp) ? 'optional' : 'required'} in the baseline, not in the candidate`;
        add('not-assignable', direction, at, detail);
        explained.add(direction);
      }
      child(checker.getTypeOfSymbol(bp), checker.getTypeOfSymbol(cp), at);
    }
    for (const [name, cp] of cProps) {
      if (bProps.has(name) || isOptional(cp)) continue;
      const detail = `candidate: ${text(checker.getTypeOfSymbol(cp))}`;
      add('property-added-required', undefined, rel + propertySegment(name), detail);
      explained.add(BC);
    }
    const cIndexes = checker.getIndexInfosOfType(c);
    for (const bi of checker.getIndexInfosOfType(b)) {
      const ci = cIndexes.find((i) => i.keyType === bi.keyType);
      if (!ci) continue;
      const at = bi.keyType.flags & ts.TypeFlags.String ? `${rel}.*` : `${rel}[${text(bi.keyType)}]`;
      readonlyChange(bi.isReadonly, ci.isReadonly, at);
      child(bi.type, ci.type, at);
    }
    for (const [kind, prefix] of [
      [ts.SignatureKind.Call, ''],
      [ts.SignatureKind.Construct, '.new'],
    ]) {
      const [bs, cs] = [checker.getSignaturesOfType(b, kind), checker.getSignaturesOfType(c, kind)];
      if (bs.length !== cs.length) continue; // compared as a whole
      bs.forEach((bSig, k) => {
        const cSig = cs[k];
        if (bSig.typeParameters?.length || cSig.typeParameters?.length) return; // compared as a whole
        const tag = prefix + (bs.length > 1 ? `#${k + 1}` : '');
        const required = (p) => {
          const d = p.valueDeclaration;
          return !(d && ts.isParameter(d) && (d.dotDotDotToken || checker.isOptionalParameter(d)));
        };
        for (let i = 0; i < Math.max(bSig.parameters.length, cSig.parameters.length); i++) {
          const [bp, cp] = [bSig.parameters[i], cSig.parameters[i]];
          const at = `${rel}${tag}(${(cp ?? bp).name})`;
          if (bp && cp) child(checker.getParameterType(bSig, i), checker.getParameterType(cSig, i), at, true);
          else if (required(bp ?? cp)) {
            const direction = bp ? BC : CB; // a required parameter only one side has
            add('not-assignable', direction, at, `required parameter only in the ${bp ? 'baseline' : 'candidate'}`);
            explained.add(direction);
          }
        }
        child(checker.getReturnTypeOfSignature(bSig), checker.getReturnTypeOfSignature(cSig), `${rel}${tag}()`);
      });
    }
    return explained;
  }

  return {
    /** Every position of a facet, deduplicated and sorted. */
    positions(b, c, facetId) {
      const found = new Map();
      const seen = new Set();
      const queue = [owner(b, c, [BC, CB], facetId)];
      while (queue.length) {
        const key = queue.pop();
        if (seen.has(key)) continue;
        seen.add(key);
        const o = owners.get(key);
        for (const item of o.items) {
          const leaf = o.name + item.rel;
          const id = `${item.kind}\0${item.direction ?? ''}\0${leaf}`;
          if (!found.has(id)) found.set(id, { kind: item.kind, direction: item.direction, leaf, detail: item.detail });
        }
        queue.push(...o.edges);
      }
      const order = (x, y) => cmp(x.leaf, y.leaf) || cmp(x.kind, y.kind) || cmp(x.direction ?? '', y.direction ?? '');
      return [...found.values()].sort(order);
    },
  };
}

/**
 * Facets of a module's exports, keyed by id: `Name` for a type meaning, `typeof Name` for a value
 * meaning. Generic types carry their type parameters, printed for the probe file.
 */
function collectFacets(ts, checker, moduleSymbol, probe) {
  const TYPE = ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum | ts.SymbolFlags.TypeAlias;
  const VALUE = ts.SymbolFlags.Variable | ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.RegularEnum;
  const printer = ts.createPrinter({ removeComments: true });
  const facets = new Map();
  const walking = new Set();
  const walk = (module, prefix, typeOnlyModule) => {
    walking.add(module);
    for (const exported of checker.getExportsOfModule(module)) {
      let target = exported;
      let typeOnly = typeOnlyModule;
      while (target && target.flags & ts.SymbolFlags.Alias) {
        typeOnly ||= (target.declarations ?? []).some((d) => ts.isTypeOnlyImportOrExportDeclaration(d));
        target = checker.getImmediateAliasedSymbol(target);
      }
      if (!target) continue;
      const name = prefix + exported.name;
      if (target.flags & TYPE) {
        facets.set(name, { name, typeParameters: typeParametersOf(target), declaration: target.declarations?.[0] });
      }
      if (target.flags & VALUE && !typeOnly) facets.set(`typeof ${name}`, { name, value: true });
      if (target.flags & ts.SymbolFlags.Module && !walking.has(target)) walk(target, `${name}.`, typeOnly);
    }
    walking.delete(module);
  };
  // The parameters without a default (always a prefix), printed with their constraints in the probe's
  // scope. A type the probe cannot name prints as an absolute import("...") type, which still compiles.
  const typeParametersOf = (symbol) => {
    const declaration = (symbol.declarations ?? []).find(
      (d) =>
        (ts.isInterfaceDeclaration(d) || ts.isClassLike(d) || ts.isTypeAliasDeclaration(d)) && d.typeParameters?.length,
    );
    const required = (declaration?.typeParameters ?? [])
      .map((p) => checker.getTypeAtLocation(p))
      .filter((p) => !checker.getDefaultFromTypeParameter(p));
    return required.map((p) => {
      const flags = ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.IgnoreErrors;
      const node = checker.typeParameterToDeclaration(p, probe, flags);
      if (!node) throw new Error(`cannot print a type parameter of ${symbol.name}`);
      return { name: node.name.text, text: printer.printNode(ts.EmitHint.Unspecified, node, probe) };
    });
  };
  walk(moduleSymbol, '', false);
  return facets;
}

/**
 * Probe lines declaring `type <alias>` as the facet's type. A generic type is referenced with only its
 * required parameters, so the compiler fills the defaults; those come from a nullary generic call.
 */
function aliasLines(alias, ns, facet) {
  if (facet.value) return [`type ${alias} = typeof ${ns}.${facet.name};`];
  if (!facet.typeParameters.length) return [`type ${alias} = ${ns}.${facet.name};`];
  const declarations = facet.typeParameters.map((p) => p.text).join(', ');
  const names = facet.typeParameters.map((p) => p.name).join(', ');
  return [
    `declare function ${alias}_instance<${declarations}>(): ${ns}.${facet.name}<${names}>;`,
    `const ${alias}_value0 = ${alias}_instance();`,
    `type ${alias} = typeof ${alias}_value0;`,
  ];
}

/** Declaration text without private members and with `protected` made public (constructors untouched). */
function publicSurface(ts, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const cuts = [];
  const visit = (node) => {
    if (ts.isClassLike(node)) {
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) continue;
        const modifiers = (ts.canHaveModifiers(member) && ts.getModifiers(member)) || [];
        const isPrivate =
          (member.name && ts.isPrivateIdentifier(member.name)) ||
          modifiers.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
        if (isPrivate) cuts.push([member.getStart(sf), member.end]);
        else {
          for (const m of modifiers) if (m.kind === ts.SyntaxKind.ProtectedKeyword) cuts.push([m.getStart(sf), m.end]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return cuts.reduceRight((out, [start, end]) => out.slice(0, start) + out.slice(end), text);
}

/** Temp paths and probe names made readable. */
function readable(text, dir) {
  return text
    .replaceAll(`${dir}/node_modules/`, '')
    .replaceAll(`${NS.baseline}.`, 'baseline.')
    .replaceAll(`${NS.candidate}.`, 'candidate.');
}

/**
 * A diagnostic's message chain, readable. A long chain keeps its outermost lines (what failed) and
 * innermost lines (the member that broke it).
 */
function describe(ts, diagnostic, dir) {
  const lines = readable(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), dir)
    .split('\n')
    .map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
  const half = DIAGNOSTIC_LINES / 2;
  const tail = lines.slice(-half);
  const depth = Math.min(...tail.map((l) => l.length - l.trimStart().length));
  const shown =
    lines.length > DIAGNOSTIC_LINES
      ? [...lines.slice(0, half), '  …', ...tail.map((l) => `    ${l.slice(depth)}`)]
      : lines;
  const file = diagnostic.file?.fileName;
  return (file && !file.endsWith('/probe.ts') ? `${readable(file, dir)}: ` : '') + shown.join('\n');
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function printReport(r, packageName) {
  const names = (list) =>
    list.length > 6 ? `${list.slice(0, 6).join(', ')}, +${list.length - 6} more` : list.join(', ');
  const position = (d) => `${d.kind}${d.direction ? ` ${d.direction}` : ''}  ${d.leaf}`;
  const source = r.baseline.source === 'allowlist' ? 'recorded in the allowlist' : `--baseline ${r.baseline.requested}`;
  const out = [`Public types: ${r.candidate} vs ${packageName}@${r.baseline.version} (${source})`];
  if (r.allowlist.baseline && r.allowlist.baseline !== r.baseline.version) {
    out.push(`Note: the allowlist was recorded against ${r.allowlist.baseline}, not ${r.baseline.version}.`);
  }
  const unlisted = r.differences.filter((d) => d.unlisted.length);
  out.push(
    `Compared ${r.compared} facets present in both: ${r.differences.length} differing positions ` +
      `(${r.differences.length - unlisted.length} fully allowlisted), ${r.added.length} facets added.`,
  );
  if (unlisted.length) {
    out.push('', `NOT ALLOWLISTED (${unlisted.length} positions):`);
    for (const d of unlisted) {
      out.push(`  ${position(d)}`, `      exports: ${names(d.unlisted)}`);
      if (d.detail) out.push(`      ${d.detail}`);
      if (d.diagnostic) out.push(...d.diagnostic.split('\n').map((l) => `      | ${l}`));
    }
  }
  if (r.stale.length) {
    const hint = 'no longer differ: remove them or run --update-allowlist';
    out.push('', `STALE allowlist entries (${r.stale.length}; ${hint}):`);
    for (const d of r.stale) out.push(`  ${position(d)}`, `      exports: ${names(d.exports)}`);
  }
  if (r.unexplained.length) {
    out.push('', 'Causes that still need a reason:');
    for (const c of r.unexplained) out.push(`  "${c.reason}" (${c.positions} positions)`);
  }
  if (r.added.length) {
    const more = r.added.length > 40 ? `, … ${r.added.length - 40} more (see --json)` : '';
    out.push('', `Added in the candidate (informational): ${r.added.slice(0, 40).join(', ')}${more}`);
  }
  out.push(
    '',
    r.ok
      ? `OK: every difference is allowlisted (${r.differences.length} positions under ${r.causes} causes).`
      : `FAIL: ${unlisted.length} positions not allowlisted, ${r.stale.length} stale, ` +
          `${r.unexplained.length} causes without a reason.`,
  );
  console.log(out.join('\n'));
}
