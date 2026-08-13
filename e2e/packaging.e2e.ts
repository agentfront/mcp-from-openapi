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
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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
});
