import { OverlayError } from './errors';

/**
 * A single Overlay action (OpenAPI Overlay Specification 1.0.0).
 */
export interface OverlayAction {
  /** JSONPath expression selecting the nodes to act on (see supported subset below) */
  target: string;

  /** Human note; ignored by the processor */
  description?: string;

  /**
   * Value merged into each matched node: objects deep-merge, arrays append
   * the value, primitives are replaced.
   */
  update?: unknown;

  /** Remove each matched node from its parent instead of updating */
  remove?: boolean;
}

/**
 * An OpenAPI Overlay document. Applied to specs at load time (before
 * dereferencing and validation), overlays keep spec curation — agent-tuned
 * descriptions, `x-mcp` flags — in a small separate file that survives every
 * regeneration of the source spec.
 */
export interface OverlayDocument {
  /** Overlay Specification version (1.x) */
  overlay: string;
  info?: { title?: string; version?: string };
  /** URL of the spec this overlay targets; informational here */
  extends?: string;
  actions: OverlayAction[];
}

/** A resolved JSONPath match: the node plus its parent slot (null parent = document root). */
interface Match {
  parent: Record<string, unknown> | unknown[] | null;
  key: string | number | null;
  value: unknown;
}

type Segment =
  | { kind: 'child'; name: string; recursive: boolean }
  | { kind: 'wildcard'; recursive: boolean }
  | { kind: 'index'; index: number; recursive: boolean }
  | { kind: 'filter'; field: string; op: 'exists' | '==' | '!='; literal?: unknown; recursive: boolean };

/**
 * Parse the supported JSONPath subset:
 *
 * - `$` root
 * - `.name` / `['name']` / `["name"]` — named child (quotes allow any chars)
 * - `.*` / `[*]` — wildcard over object values / array elements
 * - `[3]` — array index
 * - `[?(@.field)]` / `[?(@.field == 'v')]` / `[?(@.field != 42)]` — filters
 *   (literals: quoted strings, numbers, true/false)
 * - `..` before any of the above — recursive descent
 */
function parsePath(path: string): Segment[] {
  if (typeof path !== 'string' || !path.startsWith('$')) {
    throw new OverlayError(`Overlay target must be a JSONPath starting with '$'; received '${String(path)}'`, {
      target: path,
    });
  }

  const segments: Segment[] = [];
  let rest = path.slice(1);

  while (rest.length > 0) {
    let recursive = false;
    if (rest.startsWith('..')) {
      recursive = true;
      rest = rest.slice(2);
      // `..name` — recursive named child without brackets
      const bare = rest.match(/^([A-Za-z_][\w-]*)/);
      if (bare) {
        segments.push({ kind: 'child', name: bare[1], recursive });
        rest = rest.slice(bare[0].length);
        continue;
      }
    } else if (rest.startsWith('.')) {
      rest = rest.slice(1);
      if (rest.startsWith('*')) {
        segments.push({ kind: 'wildcard', recursive });
        rest = rest.slice(1);
        continue;
      }
      const bare = rest.match(/^([A-Za-z_][\w-]*)/);
      if (bare) {
        segments.push({ kind: 'child', name: bare[1], recursive });
        rest = rest.slice(bare[0].length);
        continue;
      }
      throw new OverlayError(`Invalid JSONPath segment after '.' in '${path}'`, { target: path });
    }

    if (!rest.startsWith('[')) {
      throw new OverlayError(`Invalid JSONPath segment at '${rest}' in '${path}'`, { target: path });
    }

    const bracket = matchBracket(rest, path);
    const inner = bracket.inner.trim();
    rest = bracket.rest;

    if (inner === '*') {
      segments.push({ kind: 'wildcard', recursive });
    } else if (/^-?\d+$/.test(inner)) {
      segments.push({ kind: 'index', index: parseInt(inner, 10), recursive });
    } else if (/^'.*'$/.test(inner) || /^".*"$/.test(inner)) {
      segments.push({ kind: 'child', name: inner.slice(1, -1), recursive });
    } else if (inner.startsWith('?(') && inner.endsWith(')')) {
      segments.push(parseFilter(inner.slice(2, -1).trim(), path, recursive));
    } else {
      throw new OverlayError(`Unsupported JSONPath selector '[${inner}]' in '${path}'`, { target: path });
    }
  }

  return segments;
}

/**
 * Extract a bracketed selector, respecting quotes (`['a[0]']`) AND nested
 * unquoted brackets (`[?(@['name'] == 'x')]`).
 */
function matchBracket(input: string, fullPath: string): { inner: string; rest: string } {
  let quote: string | null = null;
  let depth = 0;
  for (let i = 1; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '[') {
      depth++;
    } else if (char === ']') {
      if (depth === 0) {
        return { inner: input.slice(1, i), rest: input.slice(i + 1) };
      }
      depth--;
    }
  }
  throw new OverlayError(`Unterminated '[' selector in '${fullPath}'`, { target: fullPath });
}

function parseFilter(expr: string, path: string, recursive: boolean): Segment {
  const match = expr.match(/^@(?:\.([A-Za-z_][\w-]*)|\['([^']*)'\]|\["([^"]*)"\])\s*(?:(==|!=)\s*(.+))?$/);
  if (!match) {
    throw new OverlayError(`Unsupported filter expression '?(${expr})' in '${path}'`, { target: path });
  }
  const field = match[1] ?? match[2] ?? match[3];
  const op = match[4] as '==' | '!=' | undefined;
  if (!op) {
    return { kind: 'filter', field, op: 'exists', recursive };
  }

  const raw = match[5].trim();
  let literal: unknown;
  if (/^'.*'$/.test(raw) || /^".*"$/.test(raw)) {
    literal = raw.slice(1, -1);
  } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
    literal = parseFloat(raw);
  } else if (raw === 'true' || raw === 'false') {
    literal = raw === 'true';
  } else {
    throw new OverlayError(`Unsupported filter literal '${raw}' in '${path}'`, { target: path });
  }
  return { kind: 'filter', field, op, literal, recursive };
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object';
}

/** All descendant matches of a node (self excluded), depth-first. */
function descendants(match: Match): Match[] {
  const result: Match[] = [];
  const walk = (node: unknown): void => {
    if (!isContainer(node)) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        result.push({ parent: node, key: index, value: item });
        walk(item);
      });
    } else {
      for (const [key, value] of Object.entries(node)) {
        result.push({ parent: node, key, value });
        walk(value);
      }
    }
  };
  walk(match.value);
  return result;
}

function applySegment(matches: Match[], segment: Segment): Match[] {
  const scope: Match[] = segment.recursive ? matches.flatMap((m) => [m, ...descendants(m)]) : matches;
  const next: Match[] = [];

  for (const match of scope) {
    const node = match.value;
    switch (segment.kind) {
      case 'child': {
        if (isContainer(node) && !Array.isArray(node) && segment.name in node) {
          next.push({ parent: node, key: segment.name, value: node[segment.name] });
        }
        break;
      }
      case 'wildcard': {
        if (Array.isArray(node)) {
          node.forEach((item, index) => next.push({ parent: node, key: index, value: item }));
        } else if (isContainer(node)) {
          for (const [key, value] of Object.entries(node)) {
            next.push({ parent: node, key, value });
          }
        }
        break;
      }
      case 'index': {
        if (Array.isArray(node)) {
          const index = segment.index < 0 ? node.length + segment.index : segment.index;
          if (index >= 0 && index < node.length) {
            next.push({ parent: node, key: index, value: node[index] });
          }
        }
        break;
      }
      case 'filter': {
        // Filters select MEMBERS of the matched node (array elements or object values)
        const members: Match[] = Array.isArray(node)
          ? node.map((item, index) => ({ parent: node, key: index, value: item }))
          : isContainer(node)
            ? Object.entries(node).map(([key, value]) => ({ parent: node, key, value }))
            : [];
        for (const member of members) {
          if (!isContainer(member.value) || Array.isArray(member.value)) continue;
          const fieldValue = (member.value as Record<string, unknown>)[segment.field];
          const keep =
            segment.op === 'exists'
              ? fieldValue !== undefined
              : segment.op === '=='
                ? fieldValue === segment.literal
                : fieldValue !== segment.literal;
          if (keep) next.push(member);
        }
        break;
      }
    }
  }

  return next;
}

/** Structured merge per the Overlay spec: objects deep-merge, everything else replaces. */
function deepMerge(target: Record<string, unknown>, update: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(update)) {
    const existing = target[key];
    if (
      isContainer(value) &&
      !Array.isArray(value) &&
      isContainer(existing) &&
      !Array.isArray(existing)
    ) {
      deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

/**
 * Apply an OpenAPI Overlay 1.0 document to a spec, returning a NEW document
 * (the input is never mutated). Actions run in order; targets that match
 * nothing are skipped silently, per the Overlay specification.
 *
 * Update semantics: object targets deep-merge the update, array targets
 * append it, primitive targets are replaced. `remove: true` deletes matched
 * nodes (array elements are spliced, preserving order).
 */
export function applyOverlay<T extends object>(document: T, overlay: OverlayDocument): T {
  if (!overlay || typeof overlay !== 'object' || !Array.isArray(overlay.actions)) {
    throw new OverlayError('Overlay document must have an actions array', {});
  }

  // Overlays run before dereferencing, so the document is JSON-safe
  const result = JSON.parse(JSON.stringify(document)) as T;

  for (const [index, action] of overlay.actions.entries()) {
    if (!action || typeof action !== 'object' || typeof action.target !== 'string') {
      throw new OverlayError(`Overlay action #${index} must have a string target`, { index });
    }
    if (action.update === undefined && action.remove !== true) {
      throw new OverlayError(`Overlay action #${index} needs 'update' or 'remove: true'`, {
        index,
        target: action.target,
      });
    }

    const segments = parsePath(action.target);
    let matches: Match[] = [{ parent: null, key: null, value: result }];
    for (const segment of segments) {
      matches = applySegment(matches, segment);
    }

    if (action.remove === true) {
      // Delete array elements from the highest index down so earlier splices
      // don't shift later ones; object keys are order-independent.
      const ordered = [...matches].sort((a, b) =>
        typeof b.key === 'number' && typeof a.key === 'number' ? b.key - a.key : 0,
      );
      for (const match of ordered) {
        if (match.parent === null) {
          throw new OverlayError('Overlay cannot remove the document root', { target: action.target });
        }
        if (Array.isArray(match.parent)) {
          match.parent.splice(match.key as number, 1);
        } else {
          delete match.parent[match.key as string];
        }
      }
      continue;
    }

    for (const match of matches) {
      const node = match.value;
      if (Array.isArray(node)) {
        node.push(action.update);
      } else if (isContainer(node) && isContainer(action.update) && !Array.isArray(action.update)) {
        deepMerge(node as Record<string, unknown>, action.update as Record<string, unknown>);
      } else {
        if (match.parent === null) {
          throw new OverlayError('Overlay cannot replace the document root with a non-object', {
            target: action.target,
          });
        }
        (match.parent as Record<string, unknown>)[match.key as string] = action.update;
      }
    }
  }

  return result;
}
