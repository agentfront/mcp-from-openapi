import { SchemaError } from './errors';

/**
 * A node budget that every value copied for one schema, or one tool, counts
 * against. The owner decides the error, so it can name its own limit.
 */
export interface CopyBudget {
  readonly maxNodes: number;
  /** Values copied so far */
  nodes: number;
  /** Throw the owner's error: more than `maxNodes` values were copied */
  readonly exceeded: () => never;
}

/** Charge `cost` nodes against `budget`, calling its owner once it is exceeded */
export function chargeBudget(budget: CopyBudget, cost = 1): void {
  if ((budget.nodes += cost) > budget.maxNodes) budget.exceeded();
}

/** Options for {@link copyJsonValue} */
export interface CopyOptions {
  /** What is copied, for the error when it nests too deeply — e.g. "The `default` value of a schema" */
  label: string;
  /**
   * Drop the keys that reach `Object.prototype` when assigned (`__proto__`,
   * `constructor`, `prototype`) — for values that consumers deep-merge, like
   * `_meta`. Otherwise every key is kept, `__proto__` as an own property.
   */
  omitPrototypeKeys?: boolean;
}

/**
 * How deeply a copied value may nest. A deeper value is an error, so that
 * every generated tool stays safe to serialize: `JSON.stringify` overflows the
 * call stack at a few thousand levels.
 */
export const MAX_VALUE_DEPTH = 1000;

/** A container being copied: its keys (`null` for an array), their values, and the copy. */
interface CopyFrame {
  node: object;
  keys: string[] | null;
  values: unknown[];
  next: number;
  out: Record<string, unknown> | unknown[];
}

/**
 * Copy a JSON value from the spec into a fresh tree, so a generated tool
 * shares nothing with the document it came from.
 *
 * Dereferencing resolves `$ref`s wherever they appear — in examples, defaults,
 * and extensions too — so the value may share objects, which are copied once
 * per occurrence. A few `$ref`s to values that share a child can therefore
 * expand exponentially: every copied value (object, array, or primitive)
 * counts against `budget`. A reference back to an enclosing value (a cycle)
 * is dropped, and a value nested more than `MAX_VALUE_DEPTH` levels throws a
 * `SchemaError`. The walk keeps its own stack, so depth costs no call stack.
 */
export function copyJsonValue(root: unknown, budget: CopyBudget, options: CopyOptions): unknown {
  if (root === null || typeof root !== 'object') {
    chargeBudget(budget);
    return root;
  }
  return copyFlat(root, budget, options) ?? copyTree(root, budget, options);
}

/**
 * Copy a container that holds only primitives — most keyword values
 * (`required`, `enum`, `type`, ...) — without the walk's bookkeeping;
 * `undefined` when it holds a container.
 */
function copyFlat(node: object, budget: CopyBudget, options: CopyOptions): object | undefined {
  if (Array.isArray(node)) {
    let present = 0;
    for (let i = 0; i < node.length; i++) {
      if (!(i in node)) continue;
      const value: unknown = node[i];
      if (value !== null && typeof value === 'object') return undefined;
      present++;
    }
    chargeBudget(budget, 1 + present);
    // Holes stay holes
    return node.slice();
  }
  const record = node as Record<string, unknown>;
  const keys = keptKeys(record, options);
  for (const key of keys) {
    const value = record[key];
    if (value !== null && typeof value === 'object') return undefined;
  }
  chargeBudget(budget, 1 + keys.length);
  if (!options.omitPrototypeKeys) {
    // Spread defines each key as an own property — `__proto__` included
    return { ...record };
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = record[key];
  return out;
}

/** The keys of an object to copy */
function keptKeys(record: object, options: CopyOptions): string[] {
  const keys = Object.keys(record);
  // Literal comparisons (not a shared Set) so static analysis recognizes the
  // prototype-pollution sanitizer
  return options.omitPrototypeKeys
    ? keys.filter((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
    : keys;
}

/** Copy a container that holds containers: walked with an explicit stack. */
function copyTree(root: object, budget: CopyBudget, options: CopyOptions): unknown {
  // Containers on the path from the root to the one being copied
  const path = new Set<object>();
  const frames: CopyFrame[] = [];
  const pending = {};
  const push = (node: object): void => {
    chargeBudget(budget);
    path.add(node);
    if (Array.isArray(node)) {
      frames.push({ node, keys: null, values: node, next: 0, out: new Array<unknown>(node.length) });
    } else {
      const keys = keptKeys(node, options);
      const record = node as Record<string, unknown>;
      frames.push({ node, keys, values: keys.map((key) => record[key]), next: 0, out: {} });
    }
  };
  // A value's copy — or `pending`, with a frame pushed to copy it
  const enter = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object' || path.has(node)) {
      chargeBudget(budget);
      // A reference back to an enclosing container (a cycle) is dropped
      return node === null || typeof node !== 'object' ? node : undefined;
    }
    if (frames.length >= MAX_VALUE_DEPTH) {
      throw new SchemaError(`${options.label} is nested more than ${MAX_VALUE_DEPTH} levels deep.`, {
        maxDepth: MAX_VALUE_DEPTH,
      });
    }
    const flat = copyFlat(node, budget, options);
    if (flat) return flat;
    push(node);
    return pending;
  };
  const store = (frame: CopyFrame, index: number, value: unknown): void => {
    if (!frame.keys) {
      (frame.out as unknown[])[index] = value;
      return;
    }
    const key = frame.keys[index];
    if (key === '__proto__') {
      // An own `__proto__` key (JSON.parse creates one); assigning it would
      // set the copy's prototype instead
      Object.defineProperty(frame.out, key, { value, enumerable: true, writable: true, configurable: true });
    } else {
      (frame.out as Record<string, unknown>)[key] = value;
    }
  };

  push(root);
  for (;;) {
    const frame = frames[frames.length - 1];
    if (!frame.keys) {
      // Holes stay holes, as with `.map`
      while (frame.next < frame.values.length && !(frame.next in frame.values)) frame.next++;
    }
    if (frame.next < frame.values.length) {
      const index = frame.next++;
      const child = enter(frame.values[index]);
      if (child !== pending) store(frame, index, child);
      continue;
    }
    frames.pop();
    path.delete(frame.node);
    const parent = frames[frames.length - 1];
    if (!parent) return frame.out;
    store(parent, parent.next - 1, frame.out);
  }
}
