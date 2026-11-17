/**
 * How consumers read HTTP methods, declared OpenAPI versions and diagnostics:
 * the nine standard methods plus any `additionalOperations` token, the
 * `3.0.x` / `3.1.x` / `3.2.x` version strings, and what the generator reports
 * about a document. All of it must keep compiling; the matching rejections are
 * in `rejections.types.ts` and the type-level facts in `shapes.types.ts`.
 * Compiled by `yarn typecheck`, never executed (see README.md).
 */
import {
  DIAGNOSTIC_CODES,
  MAX_DIAGNOSTICS,
  detectSpecVersion,
  getOperation,
  isStandardMethod,
  listOperations,
  resolveOperationLayout,
} from 'mcp-from-openapi';
import type {
  DiagnosticCode,
  GenerateOptions,
  HTTPMethod,
  McpOpenAPITool,
  NamingStrategy,
  OpenAPIDocument,
  OpenAPIToolGenerator,
  OpenAPIVersion,
  OperationLayout,
  OperationList,
  SpecDiagnostic,
  SpecFamily,
  SpecVersionInfo,
  SpecVersionStatus,
  StandardMethod,
} from 'mcp-from-openapi';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const openApiDocument: OpenAPIDocument;
declare const generator: OpenAPIToolGenerator;

// ---------------------------------------------------------------------------
// HTTPMethod: the nine standard methods and any other token
// ---------------------------------------------------------------------------

export const getMethod: HTTPMethod = 'get';
export const postMethod: HTTPMethod = 'post';
export const putMethod: HTTPMethod = 'put';
export const patchMethod: HTTPMethod = 'patch';
export const deleteMethod: HTTPMethod = 'delete';
export const headMethod: HTTPMethod = 'head';
export const optionsMethod: HTTPMethod = 'options';
export const traceMethod: HTTPMethod = 'trace';
/** OpenAPI 3.2 `query`, a field of the Path Item Object. */
export const queryMethod: HTTPMethod = 'query';
/** An OpenAPI 3.2 `additionalOperations` key, as written: any HTTP token. */
export const linkMethod: HTTPMethod = 'LINK';
export const purgeMethod: HTTPMethod = 'PURGE';

/** A plain `string` is accepted too, as a method read from a document at runtime is. */
declare const runtimeMethod: string;
export const methodFromString: HTTPMethod = runtimeMethod;

// ---------------------------------------------------------------------------
// ToolMetadata.method: a string to read, compare and switch over
// ---------------------------------------------------------------------------

export function describeMethod(tool: McpOpenAPITool): string {
  const method = tool.metadata.method;
  const upper: string = method.toUpperCase();
  const reads = method === 'get' || method === 'head' || method === 'query';
  const isLink = method === 'LINK';
  const known = ['get', 'query'].includes(method);
  return `${upper} ${tool.metadata.path} ${reads} ${isLink} ${known} ${method.length}`;
}

/** A switch over the method needs a `default`: the type is open. */
export function accessOf(method: HTTPMethod): 'read' | 'write' | 'other' {
  switch (method) {
    case 'get':
    case 'head':
    case 'options':
    case 'query':
      return 'read';
    case 'post':
    case 'put':
    case 'patch':
    case 'delete':
      return 'write';
    default:
      return 'other';
  }
}

/** A `Record<HTTPMethod, T>` takes the nine standard keys, and any other key as well. */
export const methodLabels: Record<HTTPMethod, string> = {
  get: 'Read',
  post: 'Create',
  put: 'Replace',
  patch: 'Update',
  delete: 'Remove',
  head: 'Headers',
  options: 'Capabilities',
  trace: 'Echo',
  query: 'Query',
  LINK: 'Link',
};

export const purgeLabel: string = methodLabels['PURGE'];

// ---------------------------------------------------------------------------
// GenerateOptions.includeMethods / excludeMethods, NamingStrategy.toolNameGenerator
// ---------------------------------------------------------------------------

/** A standard method matches in any case; an `additionalOperations` method only exactly as written. */
export const methodFilter: GenerateOptions = {
  includeMethods: ['get', 'LINK'],
  excludeMethods: ['query', 'PURGE'],
};

export const standardMethodsInAnyCase: GenerateOptions = { includeMethods: ['GET', 'Query'] };

export const everyStandardMethod: GenerateOptions = {
  includeMethods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'query'],
};

export async function toolsForMethods(): Promise<McpOpenAPITool[]> {
  return generator.generateTools(methodFilter);
}

export const methodAwareNamer: NamingStrategy['toolNameGenerator'] = (path, method, operationId) => {
  const verb: HTTPMethod = method;
  const suffix = verb === 'LINK' ? '_link' : '';
  return operationId ?? `${method.toLowerCase()}${path.replace(/\W+/g, '_')}${suffix}`;
};

export const methodNaming: NamingStrategy = { toolNameGenerator: methodAwareNamer };

// ---------------------------------------------------------------------------
// isStandardMethod is a boolean, not a type guard: it ignores case (`GET` is
// standard), so it cannot say the value is the lowercase literal. The lookup
// that narrows is getOperation: a `fixed` entry's method is a StandardMethod.
// ---------------------------------------------------------------------------

export function countStandardOperations(tools: McpOpenAPITool[]): Record<StandardMethod, number> {
  const counts: Record<StandardMethod, number> = {
    get: 0,
    post: 0,
    put: 0,
    patch: 0,
    delete: 0,
    head: 0,
    options: 0,
    trace: 0,
    query: 0,
  };
  for (const tool of tools) {
    // usable as a plain condition
    if (!isStandardMethod(tool.metadata.method)) continue;
    const entry = getOperation(openApiDocument.paths?.[tool.metadata.path], tool.metadata.method);
    if (entry?.source === 'fixed') {
      type Narrowed = [Expect<Equal<typeof entry.method, StandardMethod>>];
      counts[entry.method] += 1;
    } else if (entry?.source === 'additional') {
      type Open = [Expect<Equal<typeof entry.method, string>>];
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The operations the generator will generate: the layout the declared version
// defines (`query` and `additionalOperations` from 3.2), passed to the walk
// ---------------------------------------------------------------------------

export function enumerateGeneratedOperations(): string[] {
  const layout: OperationLayout = resolveOperationLayout(detectSpecVersion(openApiDocument));
  const found: string[] = [];
  for (const [path, pathItem] of Object.entries(openApiDocument.paths ?? {})) {
    const list: OperationList = listOperations(pathItem, { layout });
    for (const entry of list.operations) found.push(`${entry.method} ${path} ${entry.source}`);
    // an `additionalOperations` method is matched exactly as written
    const link = getOperation(pathItem, 'LINK', { layout });
    if (link !== undefined) found.push(`${link.method} ${path} ${link.source}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// OpenAPIVersion: any 3.0.x, 3.1.x or 3.2.x string
// ---------------------------------------------------------------------------

/** The five literals the type held before patch versions and 3.2. */
export const legacyVersions: OpenAPIVersion[] = ['3.0.0', '3.0.1', '3.0.2', '3.0.3', '3.1.0'];
export const patchVersions: OpenAPIVersion[] = ['3.0.4', '3.1.2', '3.2.1'];
export const releaseCandidate: OpenAPIVersion = '3.2.0-rc1';

export function declaredVersion(version: OpenAPIVersion): { openapi: OpenAPIVersion; title: string } {
  return { openapi: version, title: 'Pet Store' };
}

// ---------------------------------------------------------------------------
// OpenAPIToolGenerator.getDiagnostics / getSpecVersion
// ---------------------------------------------------------------------------

export async function readDiagnostics(): Promise<string[]> {
  await generator.generateTools();
  const diagnostics: SpecDiagnostic[] = generator.getDiagnostics();
  return diagnostics.map((diagnostic) => {
    const severity: 'warning' | 'info' = diagnostic.severity;
    const code: string = diagnostic.code;
    const message: string = diagnostic.message;
    const path: string | undefined = diagnostic.path;
    // codes of the spec layer and of the generator come from the one registry
    const ignoredMethod =
      code === DIAGNOSTIC_CODES.REFUSED_METHOD || code === DIAGNOSTIC_CODES.INVALID_METHOD_TOKEN;
    const droppedSecurity = code === DIAGNOSTIC_CODES.UNRESOLVED_SECURITY_SCHEME;
    return `${severity} ${code} ${path ?? ''} ${ignoredMethod} ${droppedSecurity} ${message}`;
  });
}

/** A diagnostic code is a string: it can be compared with, and used where, a string is. */
export const specCode: DiagnosticCode = DIAGNOSTIC_CODES.NEWER_OPENAPI_VERSION;
export const generatorCode: DiagnosticCode = DIAGNOSTIC_CODES.UNSATISFIABLE_SECURITY;
export const knownCodeAsString: string = specCode;

/** The list keeps at most `MAX_DIAGNOSTICS` findings, then one `DIAGNOSTICS_TRUNCATED` entry. */
export function wasTruncated(diagnostics: SpecDiagnostic[]): boolean {
  const cap: number = MAX_DIAGNOSTICS;
  return diagnostics.length > cap || diagnostics[diagnostics.length - 1]?.code === DIAGNOSTIC_CODES.DIAGNOSTICS_TRUNCATED;
}

export function readSpecVersion(): string {
  const info: SpecVersionInfo = generator.getSpecVersion();
  const status: SpecVersionStatus = info.status;
  const family: SpecFamily | undefined = info.family;
  const major: number | undefined = info.major;
  const minor: number | undefined = info.minor;
  const declared: unknown = info.declared;
  const diagnostics: SpecDiagnostic[] = info.diagnostics;
  const version = `${major ?? ''}.${minor ?? ''}`;
  return `${status} ${family ?? 'unprocessable'} ${version} ${String(declared)} ${diagnostics.length}`;
}
