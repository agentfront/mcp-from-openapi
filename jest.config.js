module.exports = {
  displayName: 'mcp-from-openapi',
  testEnvironment: 'node',
  coverageProvider: 'v8',
  transform: {
    '^.+\\.[tj]s$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          parser: {
            syntax: 'typescript',
            decorators: true,
            dynamicImport: true,
          },
          transform: {
            decoratorMetadata: true,
            legacyDecorator: true,
          },
          keepClassNames: true,
          externalHelpers: true,
          loose: true,
        },
        module: {
          type: 'es6',
        },
        sourceMaps: true,
        swcrc: false,
      },
    ],
  },
  transformIgnorePatterns: [
    'node_modules/(?!@apidevtools/json-schema-ref-parser)',
  ],
  moduleFileExtensions: ['ts', 'js'],
  testMatch: ['**/__tests__/**/*.spec.ts', '**/*.spec.ts', '**/*.test.ts'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    // Types-only module (import type everywhere) — never loaded at runtime
    '!src/arazzo-types.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
  ],
  // Hard gate: `yarn test:coverage` (run in CI on every push) fails if any
  // metric regresses. Defensive branches unreachable through the public API
  // are annotated with `/* c8 ignore next */` rather than lowering these numbers.
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
};
