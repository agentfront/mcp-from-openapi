/** Executes the typed-tools example and compiles its output with real tsc. */
import * as ts from 'typescript';
import { buildTypedSurface } from './example';

/* eslint-disable @typescript-eslint/no-explicit-any */

const spec: any = {
  openapi: '3.0.0',
  info: { title: 'Billing API', version: '1.0.0' },
  paths: {
    '/invoices': {
      get: {
        operationId: 'listInvoices',
        tags: ['billing'],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } } },
                  required: ['items'],
                },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createInvoice',
        tags: ['billing'],
        requestBody: {
          required: true, // otherwise the whole body — and its fields — are optional
          content: {
            'application/json': {
              schema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
            },
          },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
  },
};

describe('example: typed-tools', () => {
  it('emits namespaced names and compiling TypeScript contracts', async () => {
    const surface = await buildTypedSurface(spec);

    // CodeCall-bindable ns.method names
    expect(Object.keys(surface.signatures).sort()).toEqual(['billing.createInvoice', 'billing.listInvoices']);
    expect(surface.signatures['billing.createInvoice']).toContain('amount: number');

    // The concatenated declarations compile under the real TypeScript compiler
    const options: ts.CompilerOptions = { noEmit: true, strict: true, skipLibCheck: true, lib: ['lib.es2022.d.ts'], types: [] };
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const getSourceFile = host.getSourceFile.bind(host);
    host.readFile = (name) => (name === 'surface.ts' ? surface.declarations : readFile(name));
    host.fileExists = (name) => name === 'surface.ts' || fileExists(name);
    host.getSourceFile = (name, version, ...rest) =>
      name === 'surface.ts' ? ts.createSourceFile(name, surface.declarations, version, true) : getSourceFile(name, version, ...rest);
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(['surface.ts'], options, host));
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);

    expect(surface.declarations).toContain('declare function billingListInvoices');
  });
});
