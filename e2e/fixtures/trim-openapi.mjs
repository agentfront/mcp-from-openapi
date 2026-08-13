#!/usr/bin/env node
/**
 * One-off fixture trimmer: reduce a large OpenAPI document to the operations
 * selected by --tags or --path-prefixes plus the transitive component closure
 * they reference. The OUTPUT is what gets vendored; this script is committed
 * so regeneration is reproducible (see fixtures README for the exact
 * invocations and source commits).
 *
 * Usage:
 *   node trim-openapi.mjs <input.json> <output.json> --tags a,b,c
 *   node trim-openapi.mjs <input.json> <output.json> --path-prefixes /users,/channels
 */
import { readFileSync, writeFileSync } from 'fs';

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: trim-openapi.mjs <input.json> <output.json> [--tags a,b] [--path-prefixes /a,/b]');
  process.exit(1);
}
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  args[rest[i].replace(/^--/, '')] = rest[i + 1];
}
const tags = args.tags ? args.tags.split(',') : undefined;
const prefixes = args['path-prefixes'] ? args['path-prefixes'].split(',') : undefined;
if (!tags && !prefixes) {
  console.error('one of --tags or --path-prefixes is required');
  process.exit(1);
}

const doc = JSON.parse(readFileSync(input, 'utf8'));
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

const keepOperation = (pathStr, operation) => {
  if (tags) return Array.isArray(operation.tags) && operation.tags.some((t) => tags.includes(t));
  return prefixes.some((p) => pathStr === p || pathStr.startsWith(`${p}/`) || pathStr.startsWith(`${p}?`));
};

// 1. Filter paths to selected operations
const paths = {};
for (const [pathStr, item] of Object.entries(doc.paths ?? {})) {
  if (!item || typeof item !== 'object') continue;
  const kept = {};
  for (const [key, value] of Object.entries(item)) {
    if (!METHODS.includes(key)) {
      kept[key] = value; // parameters, servers, summary, ...
      continue;
    }
    if (keepOperation(pathStr, value)) kept[key] = value;
  }
  if (METHODS.some((m) => kept[m])) paths[pathStr] = kept;
}

// 2. Transitive $ref closure over #/components/...
const refs = new Set();
const collect = (node) => {
  if (Array.isArray(node)) return node.forEach(collect);
  if (!node || typeof node !== 'object') return;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/')) refs.add(node.$ref);
  Object.values(node).forEach(collect);
};
collect(paths);
if (doc.security) collect(doc.security);

// JSON Pointer tokens: `~1` is `/`, `~0` is `~` (RFC 6901)
const decodePointerSegment = (segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~');
const resolveRef = (ref) => {
  const [, , group, name] = ref.split('/').map(decodePointerSegment);
  return { group, name, target: doc.components?.[group]?.[name] };
};

let previousSize = -1;
while (refs.size !== previousSize) {
  previousSize = refs.size;
  for (const ref of [...refs]) {
    const { target } = resolveRef(ref);
    if (target) collect(target);
  }
}

// 3. Copy only reachable components (securitySchemes always kept whole).
// An unresolvable reference means the trim would vendor a dangling $ref —
// fail loudly instead of silently skipping it.
const components = {};
for (const ref of refs) {
  const { group, name, target } = resolveRef(ref);
  if (target === undefined) {
    console.error(`unresolved component reference: ${ref}`);
    process.exit(1);
  }
  components[group] ??= {};
  components[group][name] = target;
}
if (doc.components?.securitySchemes) components.securitySchemes = doc.components.securitySchemes;

// 4. Assemble with provenance, stable key order for reviewable diffs
const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sortKeys(value[k])]),
  );
};

const out = {
  openapi: doc.openapi,
  info: {
    ...doc.info,
    'x-fixture-provenance': `Trimmed by e2e/fixtures/trim-openapi.mjs (${tags ? `--tags ${args.tags}` : `--path-prefixes ${args['path-prefixes']}`}) — see e2e/fixtures/README.md`,
  },
  ...(doc.servers && { servers: doc.servers }),
  ...(doc.security && { security: doc.security }),
  paths: sortKeys(paths),
  ...(Object.keys(components).length > 0 && { components: sortKeys(components) }),
};

writeFileSync(output, `${JSON.stringify(out, null, 2)}\n`);
const operations = Object.values(paths).flatMap((p) => METHODS.filter((m) => p[m])).length;
console.log(`${output}: ${operations} operations, ${Object.keys(paths).length} paths, ${refs.size} component refs`);
