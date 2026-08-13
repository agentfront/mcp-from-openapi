/**
 * Type-signature story: every emitted TypeScript declaration and signature
 * from real specs compiles under the real TypeScript compiler with zero
 * diagnostics — the invalid-TS bug class as a permanent regression test.
 */
import * as ts from 'typescript';
import { OpenAPIToolGenerator } from '../src';
import type { McpOpenAPITool, OpenAPIDocument } from '../src';
import { loadFixture, loadJsonFixture } from './helpers/fixtures';
import * as yaml from 'yaml';

/** Compile virtual source text; return flattened diagnostics (empty = valid). */
function compileVirtual(fileName: string, source: string): string[] {
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    lib: ['lib.es2022.d.ts'],
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (name) => (name === fileName ? source : readFile(name));
  host.fileExists = (name) => name === fileName || fileExists(name);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, ...rest);

  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => `${diagnostic.file?.fileName ?? ''}:${diagnostic.start ?? 0} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
}

const cases: Array<{ file: string }> = [{ file: 'petstore-3.0.yaml' }, { file: 'github-trimmed-3.0.json' }];

describe.each(cases)('story: emitted TypeScript compiles ($file)', ({ file }) => {
  let tools: McpOpenAPITool[];

  beforeAll(async () => {
    const document: OpenAPIDocument = file.endsWith('.yaml')
      ? (yaml.parse(loadFixture(file)) as OpenAPIDocument)
      : loadJsonFixture<OpenAPIDocument>(file);
    tools = await (await OpenAPIToolGenerator.fromJSON(document)).generateTools({ emitTypeSignatures: true });
  });

  it('emits a signature and declaration for every tool', () => {
    for (const tool of tools) {
      expect(tool.metadata.typescript?.signature).toMatch(/^\(.*\) => Promise<.+>$/s);
      expect(tool.metadata.typescript?.declaration).toContain('declare function');
    }
  });

  it('compiles all declarations with zero diagnostics', () => {
    const source = tools.map((tool) => tool.metadata.typescript!.declaration).join('\n\n');
    expect(compileVirtual('declarations.ts', source)).toEqual([]);
  });

  it('compiles all signatures as type aliases with zero diagnostics', () => {
    const source = tools
      .map((tool, index) => `type S${index} = ${tool.metadata.typescript!.signature};`)
      .join('\n');
    expect(compileVirtual('signatures.ts', source)).toEqual([]);
  });
});
