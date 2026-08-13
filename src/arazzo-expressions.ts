/**
 * Arazzo runtime-expression parsing.
 *
 * Hand-rolled tokenizer over the Arazzo 1.0 runtime-expression grammar
 * (`$url`, `$method`, `$statusCode`, `$request.…`, `$response.…`, `$message.…`, `$inputs.…`,
 * `$outputs.…`, `$steps.…`, `$workflows.…`, `$sourceDescriptions.…`,
 * `$components.…`), producing a small serializable AST. Expressions are
 * parsed, never evaluated.
 */
import { ArazzoError } from './errors';
import type { ExpressionValueIR, PayloadExpressionIR, RuntimeExpressionAST, RuntimeExpressionType } from './arazzo-types';

const EXACT_ROOTS: Record<string, RuntimeExpressionType> = {
  $url: 'url',
  $method: 'method',
  $statusCode: 'statusCode',
};

const DOTTED_ROOTS: Record<string, RuntimeExpressionType> = {
  $inputs: 'inputs',
  $outputs: 'outputs',
  $steps: 'steps',
  $workflows: 'workflows',
  $sourceDescriptions: 'sourceDescriptions',
  $components: 'components',
};

/**
 * All roots the grammar knows, with the exact boundary each requires —
 * used to decide expression-vs-literal. `$request-id` matches no root
 * (the source roots require a literal dot) and stays a literal.
 */
const KNOWN_ROOT = /^\$(?:(?:url|method|statusCode)$|(?:request|response|message)\.|(?:inputs|outputs|steps|workflows|sourceDescriptions|components)\.)/;

function fail(message: string, docPath: string, expression: string): never {
  throw new ArazzoError(message, { path: docPath, expression });
}

/** RFC 7230 token characters (header names). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function parseSourceRef(
  prefix: 'request' | 'response' | 'message',
  rest: string,
  raw: string,
  docPath: string,
): RuntimeExpressionAST {
  if (rest.startsWith('header.')) {
    const name = rest.slice('header.'.length);
    if (name === '' || !TOKEN.test(name)) {
      fail(`Invalid header name in runtime expression "${raw}"`, docPath, raw);
    }
    return { type: prefix, raw, path: [], source: 'header', name };
  }
  if (rest.startsWith('query.') || rest.startsWith('path.')) {
    const source = rest.startsWith('query.') ? 'query' : 'path';
    const name = rest.slice(source.length + 1);
    if (name === '') {
      fail(`Empty ${source} parameter name in runtime expression "${raw}"`, docPath, raw);
    }
    return { type: prefix, raw, path: [], source, name };
  }
  if (rest === 'body' || rest.startsWith('body#')) {
    const node: RuntimeExpressionAST = { type: prefix, raw, path: [], source: 'body' };
    if (rest.startsWith('body#')) {
      const pointer = rest.slice('body#'.length);
      if (pointer !== '' && !pointer.startsWith('/')) {
        fail(`JSON Pointer in "${raw}" must be empty or start with "/"`, docPath, raw);
      }
      node.pointer = pointer;
    }
    return node;
  }
  fail(`Invalid $${prefix} reference "${raw}" — expected header.<name>, query.<name>, path.<name>, or body[#<pointer>]`, docPath, raw);
}

/**
 * Parse a runtime expression into its structured form. Throws `ArazzoError`
 * (with the document path in `context.path`) on any grammar violation.
 */
export function parseRuntimeExpression(raw: string, docPath = ''): RuntimeExpressionAST {
  const exact = EXACT_ROOTS[raw];
  if (exact) {
    return { type: exact, raw, path: [] };
  }
  for (const key of Object.keys(EXACT_ROOTS)) {
    if (raw.startsWith(key) && raw !== key) {
      fail(`Unexpected characters after "${key}" in runtime expression "${raw}"`, docPath, raw);
    }
  }

  for (const prefix of ['request', 'response', 'message'] as const) {
    if (raw.startsWith(`$${prefix}.`)) {
      return parseSourceRef(prefix, raw.slice(prefix.length + 2), raw, docPath);
    }
  }

  const dot = raw.indexOf('.');
  const rootToken = dot === -1 ? raw : raw.slice(0, dot);
  const root = DOTTED_ROOTS[rootToken];
  if (root) {
    const rest = dot === -1 ? '' : raw.slice(dot + 1);
    if (rest === '') {
      fail(`Runtime expression "${raw}" is missing a name after "${rootToken}."`, docPath, raw);
    }
    const path = rest.split('.');
    if (path.some((segment) => segment === '' || /\s/.test(segment))) {
      fail(`Runtime expression "${raw}" contains an empty or whitespace path segment`, docPath, raw);
    }
    return { type: root, raw, path };
  }

  fail(`Invalid runtime expression "${raw}"`, docPath, raw);
}

/**
 * Interpret a step/parameter value: non-strings are literals; strings that
 * start with a known expression root must parse as expressions; strings with
 * embedded `{$...}` become templates; everything else is a literal (`"$50"`
 * has no known root and stays literal).
 */
export function parseExpressionValue(value: unknown, docPath = ''): ExpressionValueIR {
  if (typeof value !== 'string') {
    return { kind: 'literal', value };
  }
  if (value.startsWith('$')) {
    if (KNOWN_ROOT.test(value)) {
      return { kind: 'expression', expression: parseRuntimeExpression(value, docPath) };
    }
    return { kind: 'literal', value };
  }
  if (!value.includes('{$')) {
    return { kind: 'literal', value };
  }

  // Template scan: `{$...}` embeds (no nesting per spec)
  const parts: Array<string | RuntimeExpressionAST> = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf('{$', cursor);
    if (open === -1) {
      parts.push(value.slice(cursor));
      break;
    }
    if (open > cursor) {
      parts.push(value.slice(cursor, open));
    }
    const close = value.indexOf('}', open);
    if (close === -1) {
      fail(`Unterminated "{$" template expression in "${value}"`, docPath, value);
    }
    parts.push(parseRuntimeExpression(value.slice(open + 1, close), docPath));
    cursor = close + 1;
  }
  return { kind: 'template', raw: value, parts };
}

/** Escape an object key per RFC 6901. */
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Walk a request-body payload and record every string that parses to an
 * expression or template, keyed by its RFC 6901 pointer (`''` = the payload
 * itself is the value).
 */
export function collectPayloadExpressions(payload: unknown, docPath = ''): PayloadExpressionIR[] {
  const found: PayloadExpressionIR[] = [];
  const seen = new Set<object>();

  const visit = (node: unknown, pointer: string): void => {
    if (typeof node === 'string') {
      const value = parseExpressionValue(node, docPath);
      if (value.kind !== 'literal') {
        found.push({ pointer, value });
      }
      return;
    }
    if (!node || typeof node !== 'object') {
      return;
    }
    /* c8 ignore next 3 -- payloads come from JSON/YAML and cannot be cyclic */
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${pointer}/${index}`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      visit(value, `${pointer}/${escapePointerSegment(key)}`);
    }
  };

  visit(payload, '');
  return found;
}
