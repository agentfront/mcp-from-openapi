/**
 * In-process TypeScript compiler helper: type-checks virtual source text with
 * the real compiler, without touching disk.
 */
import { resolve } from 'path';
import * as ts from 'typescript';

export interface CompileVirtualOptions {
  /**
   * Directory the virtual file is placed in, so its relative imports resolve
   * against it (for example `__dirname` to `import '../src'` from an e2e
   * story). Defaults to the working directory.
   */
  baseDir?: string;
  /**
   * Compiler options merged over the defaults. Importing from `src/` needs
   * matching ones (ES2022 target, NodeNext module resolution, `types: ['node']`).
   */
  compilerOptions?: ts.CompilerOptions;
}

const normalizeSlashes = (name: string): string => name.replace(/\\/g, '/');

/** Compile virtual source text; return flattened diagnostics (empty = valid). */
export function compileVirtual(
  fileName: string,
  source: string,
  { baseDir, compilerOptions }: CompileVirtualOptions = {},
): string[] {
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    lib: ['lib.es2022.d.ts'],
    types: [],
    ...compilerOptions,
  };
  const virtualName = normalizeSlashes(baseDir ? resolve(baseDir, fileName) : fileName);
  const isVirtual = (name: string): boolean => normalizeSlashes(name) === virtualName;

  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (name) => (isVirtual(name) ? source : readFile(name));
  host.fileExists = (name) => isVirtual(name) || fileExists(name);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    isVirtual(name)
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, ...rest);

  const program = ts.createProgram([virtualName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map(
      (diagnostic) =>
        `${diagnostic.file?.fileName ?? ''}:${diagnostic.start ?? 0} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    );
}
