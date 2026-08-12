/**
 * Naming presets.
 *
 * `dottedNaming` produces two-segment `ns.method` tool names whose halves are
 * valid JavaScript identifiers — the shape code-execution surfaces (FrontMCP
 * CodeCall) bind as ergonomic namespaces: a tool named `billing.listInvoices`
 * becomes `await billing.listInvoices({...})` in sandbox code. Names with any
 * other shape (no dot, or a half that is not an identifier) still work via
 * `callTool('name', input)` but get no namespace binding.
 */
import type { HTTPMethod, NamingStrategy, OperationObject } from './types';

/**
 * Namespace identifiers reserved by FrontMCP CodeCall's sandbox globals —
 * a namespace equal to one of these would shadow (or be shadowed by) a
 * sandbox binding, so `dottedNaming` suffixes it with `_`.
 */
export const CODECALL_RESERVED_NAMESPACES: readonly string[] = [
  'console',
  'Math',
  'JSON',
  'Object',
  'Promise',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Error',
  'Symbol',
  'Map',
  'Set',
  'globalThis',
  'undefined',
  'NaN',
  'Infinity',
  'callTool',
  'getTool',
  'mcpLog',
  'mcpNotify',
];

/** Options for the {@link dottedNaming} preset. */
export interface DottedNamingOptions {
  /**
   * Where the namespace half comes from: the operation's first tag, or the
   * first path segment. `'tag'` falls back to the first path segment when the
   * operation has no tags, then to `'api'`.
   * @default 'tag'
   */
  namespaceFrom?: 'tag' | 'firstPathSegment';

  /**
   * Additional reserved namespace names, merged with
   * {@link CODECALL_RESERVED_NAMESPACES}.
   */
  reservedNamespaces?: string[];
}

/**
 * Sanitize a string into a JavaScript identifier that is also MCP-name-safe
 * (`$` is a valid identifier character but not a valid MCP name character, so
 * it is excluded): non-identifier characters become `_`, runs collapse,
 * leading/trailing `_` are trimmed (loop-based — no backtracking-prone
 * regex), and a leading digit gains a `_` prefix. Returns '' when nothing
 * survives.
 */
function sanitizeIdentifier(value: string | undefined): string {
  if (value === undefined) {
    return '';
  }
  let out = value.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_');
  let start = 0;
  let end = out.length;
  while (start < end && out[start] === '_') start++;
  while (end > start && out[end - 1] === '_') end--;
  out = out.slice(start, end);
  if (out === '') {
    return '';
  }
  return /^[0-9]/.test(out) ? `_${out}` : out;
}

function firstPathSegment(path: string): string {
  for (const segment of path.split('/')) {
    if (segment !== '' && !segment.startsWith('{')) {
      return sanitizeIdentifier(segment);
    }
  }
  return '';
}

/** Path remainder → method half: `/users/{id}/posts` → `users_by_id_posts`. */
function pathMethodHalf(method: HTTPMethod, path: string, ns: string): string {
  const segments = path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      const templated = s.replace(/\{([^{}]+)\}/g, 'by_$1');
      return sanitizeIdentifier(templated);
    })
    .filter((s) => s !== '');
  if (segments.length > 0 && segments[0] === ns) {
    segments.shift();
  }
  const joined = segments.join('_');
  return joined === '' ? method : `${method}_${joined}`;
}

/**
 * Naming preset producing two-segment `ns.method` tool names bindable by
 * code-execution namespaces (e.g. FrontMCP CodeCall's `await ns.method({...})`).
 *
 * The namespace half comes from the operation's first tag (or first path
 * segment); the method half from the operationId (an `x-mcp` family name
 * override arrives through the operationId argument), falling back to the
 * HTTP method plus the path. Both halves are sanitized to identifiers, so the
 * emitted name contains exactly one dot.
 *
 * Collision dedup in `generateTools()` appends `_<hash>` to the method half,
 * which keeps the name namespace-parseable. Under very small
 * `maxToolNameLength` caps, hash truncation can remove the dot — such names
 * remain valid MCP names but lose namespace binding.
 */
export function dottedNaming(options: DottedNamingOptions = {}): NamingStrategy {
  const namespaceFrom = options.namespaceFrom ?? 'tag';
  const reserved = new Set([...CODECALL_RESERVED_NAMESPACES, ...(options.reservedNamespaces ?? [])]);

  return {
    toolNameGenerator: (path: string, method: HTTPMethod, operationId?: string, operation?: OperationObject): string => {
      let ns = '';
      if (namespaceFrom === 'tag') {
        ns = sanitizeIdentifier(operation?.tags?.[0]);
      }
      if (ns === '') {
        ns = firstPathSegment(path);
      }
      if (ns === '') {
        ns = 'api';
      }
      if (reserved.has(ns)) {
        ns = `${ns}_`;
      }

      const methodHalf = sanitizeIdentifier(operationId) || pathMethodHalf(method, path, ns);
      return `${ns}.${methodHalf}`;
    },
  };
}
