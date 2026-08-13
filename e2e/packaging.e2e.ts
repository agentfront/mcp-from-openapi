/**
 * Packaging story: the BUILT artifacts work exactly as consumers see them.
 *
 * - CJS (`require('dist/index.js')`), ESM (`import('dist/esm/index.mjs')`),
 *   and in-process src produce identical tools from the same spec.
 * - The exports map resolves for both module systems when dist/ is mounted
 *   as an installed `node_modules/mcp-from-openapi` package (dist/package.json
 *   is the stripped publishable manifest).
 *
 * Requires `yarn build` first — fails loudly otherwise.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { OpenAPIToolGenerator } from '../src';

const repoRoot = join(__dirname, '..');
const cjsPath = join(repoRoot, 'dist', 'index.js');
const esmPath = join(repoRoot, 'dist', 'esm', 'index.mjs');

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

/** Body shared by every consumer: generate tools and print them as JSON. */
const generateSnippet = `mcp.OpenAPIToolGenerator.fromJSON(${JSON.stringify(spec)})
  .then((g) => g.generateTools())
  .then((t) => process.stdout.write(JSON.stringify(t)))
  .catch((e) => { console.error(e); process.exit(1); });`;

const runNode = (args: string[]): string => execFileSync(process.execPath, args, { encoding: 'utf8' });

describe('packaging: built artifacts', () => {
  beforeAll(() => {
    if (!existsSync(cjsPath) || !existsSync(esmPath)) {
      throw new Error('dist/ not found — run "yarn build" before "yarn test:e2e"');
    }
  });

  it('produces identical tools from CJS, ESM, and source entrypoints', async () => {
    const inProcess = await (await OpenAPIToolGenerator.fromJSON(spec)).generateTools();

    const cjsOut = runNode(['-e', `const mcp = require(${JSON.stringify(cjsPath)}); ${generateSnippet}`]);
    const esmOut = runNode([
      '--input-type=module',
      '-e',
      `import(${JSON.stringify(pathToFileURL(esmPath).href)}).then((mcp) => { ${generateSnippet} });`,
    ]);

    expect(JSON.parse(cjsOut)).toEqual(JSON.parse(JSON.stringify(inProcess)));
    expect(JSON.parse(esmOut)).toEqual(JSON.parse(cjsOut));
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
});
