/**
 * Packaging story: the BUILT artifacts work exactly as consumers see them.
 *
 * - CJS (`require('dist/index.js')`), ESM (`import('dist/esm/index.mjs')`),
 *   and in-process src produce identical tools from the same spec.
 * - The exports map resolves for both module systems when dist/ is mounted
 *   as an installed `node_modules/mcp-from-openapi` package (dist/package.json
 *   is the stripped publishable manifest).
 * - The declarations import nothing a consumer would have to install beyond
 *   the peer dependency (`zod`) and Node built-ins, reference only ES libs
 *   (never `dom`) and declare no ambient modules.
 *
 * Requires `yarn build` first — fails loudly otherwise.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as ts from 'typescript';
import { OpenAPIToolGenerator } from '../src';

const repoRoot = join(__dirname, '..');
const cjsPath = join(repoRoot, 'dist', 'index.js');
const esmPath = join(repoRoot, 'dist', 'esm', 'index.mjs');
const distDir = join(repoRoot, 'dist');

/** Bare specifiers the published declarations may import: the peer dependency and Node built-ins. */
const ALLOWED_DECLARATION_IMPORTS = ['zod/v4/core', 'node:http', 'node:https', 'openapi-spec'];

/**
 * What a declaration file asks of its consumer. Walks the syntax tree, so
 * text that only appears in comments (JSDoc `@example` blocks) is ignored.
 */
interface DeclarationScan {
  /**
   * Bare (non-relative) specifiers: `import`/`export ... from`,
   * `import x = require()`, `import('...')` type expressions and
   * `/// <reference types>` directives.
   */
  specifiers: string[];
  /** `/// <reference lib>` names. */
  libs: string[];
  /** Names declared by ambient `declare module '...'` blocks. */
  ambientModules: string[];
}

const scanDeclaration = (fileName: string, text: string): DeclarationScan => {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022);
  const specifiers = sourceFile.typeReferenceDirectives.map((directive) => directive.fileName);
  const ambientModules: string[] = [];
  const addSpecifier = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteral(node)) specifiers.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) addSpecifier(node.moduleSpecifier);
    else if (ts.isExternalModuleReference(node)) addSpecifier(node.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) addSpecifier(node.argument.literal);
    else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) ambientModules.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    specifiers: specifiers.filter((specifier) => !specifier.startsWith('.')),
    libs: sourceFile.libReferenceDirectives.map((directive) => directive.fileName),
    ambientModules,
  };
};

/** The build targets ES2022: `es5`, `es2015` ... `es2022` and their parts (`es2022.array`) are fine; `dom` is not. */
const isTargetedEsLib = (lib: string): boolean => {
  const match = /^es(\d+)(\.[a-z.]+)?$/i.exec(lib);
  return match !== null && Number(match[1]) <= 2022;
};

/** Scans every `dist/**\/*.d.ts`; keys are paths relative to dist/. */
const scanBuiltDeclarations = (): Map<string, DeclarationScan> => {
  const files = readdirSync(distDir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.d.ts'))
    .sort();
  return new Map(files.map((file) => [file, scanDeclaration(file, readFileSync(join(distDir, file), 'utf8'))]));
};

/** Groups `value -> files` pairs, one line per value, for failure messages. */
const groupByValue = (scans: Map<string, DeclarationScan>, pick: (scan: DeclarationScan) => string[]): string[] => {
  const files = new Map<string, Set<string>>();
  for (const [file, scan] of scans) {
    for (const value of pick(scan)) files.set(value, (files.get(value) ?? new Set()).add(file));
  }
  return [...files].map(([value, where]) => `${value} (in ${[...where].join(', ')})`);
};

const spec = {
  openapi: '3.0.0',
  info: { title: 'Packaging API', version: '1.0.0' },
  paths: {
    '/things/{id}': {
      get: {
        operationId: 'getThing',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } },
            },
          },
        },
      },
    },
  },
};

/**
 * Static consumer script — no string-built code (inputs arrive via env), so
 * there is nothing to sanitize. Loads the entry as CJS or ESM by extension.
 */
const CONSUMER_SCRIPT = `
const { pathToFileURL } = require('url');
const spec = JSON.parse(process.env.MCP_E2E_SPEC);
const entry = process.env.MCP_E2E_ENTRY;
const load = entry.endsWith('.mjs') ? import(pathToFileURL(entry).href) : Promise.resolve(require(entry));
load
  .then((mcp) => mcp.OpenAPIToolGenerator.fromJSON(spec))
  .then((generator) => generator.generateTools())
  .then((tools) => process.stdout.write(JSON.stringify(tools)))
  .catch((error) => { console.error(error); process.exit(1); });
`;

const runConsumer = (scriptPath: string, entry: string): string =>
  execFileSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, MCP_E2E_ENTRY: entry, MCP_E2E_SPEC: JSON.stringify(spec) },
  });

describe('packaging: built artifacts', () => {
  beforeAll(() => {
    if (!existsSync(cjsPath) || !existsSync(esmPath)) {
      throw new Error('dist/ not found — run "yarn build" before "yarn test:e2e"');
    }
  });

  it('produces identical tools from CJS, ESM, and source entrypoints', async () => {
    const inProcess = await (await OpenAPIToolGenerator.fromJSON(spec)).generateTools();

    const scriptDir = mkdtempSync(join(tmpdir(), 'mcp-e2e-consumer-'));
    try {
      const scriptPath = join(scriptDir, 'consumer.cjs');
      writeFileSync(scriptPath, CONSUMER_SCRIPT);
      const cjsOut = runConsumer(scriptPath, cjsPath);
      const esmOut = runConsumer(scriptPath, esmPath);

      expect(JSON.parse(cjsOut)).toEqual(JSON.parse(JSON.stringify(inProcess)));
      expect(JSON.parse(esmOut)).toEqual(JSON.parse(cjsOut));
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it('resolves the exports map for require and import consumers of the installed package', () => {
    const consumerDir = mkdtempSync(join(tmpdir(), 'mcp-e2e-'));
    try {
      mkdirSync(join(consumerDir, 'node_modules'));
      symlinkSync(join(repoRoot, 'dist'), join(consumerDir, 'node_modules', 'mcp-from-openapi'), 'dir');

      const cjs = execFileSync(
        process.execPath,
        ['-e', `const m = require('mcp-from-openapi'); process.stdout.write(typeof m.OpenAPIToolGenerator);`],
        { encoding: 'utf8', cwd: consumerDir },
      );
      expect(cjs).toBe('function');

      const esm = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import('mcp-from-openapi').then((m) => process.stdout.write(typeof m.OpenAPIToolGenerator));`,
        ],
        { encoding: 'utf8', cwd: consumerDir },
      );
      expect(esm).toBe('function');
    } finally {
      rmSync(consumerDir, { recursive: true, force: true });
    }
  });

  it('built declarations import nothing outside the allowlist', () => {
    const scans = scanBuiltDeclarations();
    expect([...scans.keys()]).toContain('index.d.ts');

    const unexpected = groupByValue(scans, (scan) =>
      scan.specifiers.filter((specifier) => !ALLOWED_DECLARATION_IMPORTS.includes(specifier)),
    );
    expect(unexpected).toEqual([]);
  });

  it('built declarations reference only ES libs and declare no ambient modules', () => {
    const scans = scanBuiltDeclarations();

    expect([
      ...groupByValue(scans, (scan) =>
        scan.libs.filter((lib) => !isTargetedEsLib(lib)).map((lib) => `reference lib="${lib}"`),
      ),
      ...groupByValue(scans, (scan) => scan.ambientModules.map((name) => `declare module '${name}'`)),
    ]).toEqual([]);
  });

  it('the declaration scan flags every kind of dependency it guards against', () => {
    const scan = scanDeclaration(
      'sample.d.ts',
      [
        '/// <reference lib="dom" />',
        '/// <reference lib="es2022.array" />',
        '/// <reference types="node" />',
        '/** @example import { ignored } from "in-a-comment"; */',
        "import type { A } from 'pkg-a';",
        "export type { B } from 'pkg-b';",
        "import C = require('pkg-c');",
        "export type D = import('pkg-d').D;",
        "export type E = typeof import('node:http');",
        "export * from './relative';",
        "declare module 'ambient' {}",
      ].join('\n'),
    );
    expect(scan.specifiers.sort()).toEqual(['node', 'node:http', 'pkg-a', 'pkg-b', 'pkg-c', 'pkg-d']);
    expect(scan.libs.filter((lib) => !isTargetedEsLib(lib))).toEqual(['dom']);
    expect(['es5', 'es2015.promise', 'es2022', 'es2023', 'esnext'].filter((lib) => !isTargetedEsLib(lib))).toEqual([
      'es2023',
      'esnext',
    ]);
    expect(scan.ambientModules).toEqual(['ambient']);
  });
});
