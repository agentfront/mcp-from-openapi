/**
 * E2E story suite: real fixtures, real loopback HTTP, real MCP SDK transport,
 * and the built dist/ artifacts. No coverage — the 100% gate is a unit-suite
 * contract owned by jest.config.js. Run with `yarn test:e2e` (the packaging
 * story requires `yarn build` first).
 */
const base = require('./jest.config.js');

module.exports = {
  displayName: 'mcp-from-openapi-e2e',
  testEnvironment: 'node',
  roots: ['<rootDir>/e2e', '<rootDir>/examples'],
  testMatch: ['**/*.e2e.ts'],
  // Examples import the real package name so they read exactly like consumer
  // code; the runner maps it onto the source entrypoint.
  moduleNameMapper: { '^mcp-from-openapi$': '<rootDir>/src/index.ts' },
  transform: base.transform,
  // ref-parser is ESM-only and reached through src/generator.ts; the MCP SDK
  // ships CJS (exports.require -> dist/cjs) and needs no allowlisting.
  transformIgnorePatterns: base.transformIgnorePatterns,
  moduleFileExtensions: base.moduleFileExtensions,
  testTimeout: 30_000,
  maxWorkers: '50%',
};
