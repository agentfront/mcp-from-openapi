import { ParseError, SchemaError } from './errors';
import { referenceAt } from './reference-sites';
import { setOwnProperty } from './spec';

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

/** Call the budget's owner now if `cost` more nodes cannot fit — without charging them */
export function ensureBudget(budget: CopyBudget, cost: number): void {
  if (budget.nodes + cost > budget.maxNodes) budget.exceeded();
}

/**
 * Map the members of an array with `fn`, which charges each member, while
 * charging the array itself and each of its holes: a hole serializes as
 * `null`, so every slot counts. Holes stay holes, as with `.map`. An array
 * longer than the budget left is rejected before it is walked.
 */
export function mapSlots<T, U>(array: T[], budget: CopyBudget, fn: (member: T) => U): U[] {
  ensureBudget(budget, 1 + array.length);
  chargeBudget(budget);
  let present = 0;
  const mapped = array.map((member) => {
    present++;
    return fn(member);
  });
  chargeBudget(budget, array.length - present);
  return mapped;
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
  /**
   * Give back as `{ $ref }` each value dereferencing put in place of a `$ref`
   * (src/reference-sites.ts), as the document wrote it, instead of copying the
   * resolved value — for a specification extension, where a `$ref` is no
   * Reference Object. Each costs two nodes, the object and its text. The root
   * itself is the caller's to check: only its container knows it.
   */
  asWritten?: boolean;
}

/**
 * How deeply a copied value may nest. A deeper value is an error, so that
 * every generated tool stays safe to serialize: `JSON.stringify` overflows the
 * call stack at a few thousand levels.
 */
export const MAX_VALUE_DEPTH = 1000;

/** Values a document may repeat through shared objects or YAML aliases, beyond the ones it holds */
export const MAX_REPEATED_VALUES = 500_000;

interface ExpansionFrame {
  node: object;
  children: unknown[];
  next: number;
  size: number;
}

/** Refuse a value whose shared objects a JSON copy would repeat more than `MAX_REPEATED_VALUES` times; cycles are left to the copy */
export function assertBoundedExpansion(root: unknown): void {
  if (root === null || typeof root !== 'object') return;
  const sizes = new Map<object, number>();
  const onPath = new Set<object>([root]);
  const frameOf = (node: object): ExpansionFrame => {
    const children = Object.values(node);
    // An array hole, which a copy writes as `null`, is one value too: counted, never walked
    const holes = Array.isArray(node) ? node.length - children.length : 0;
    return { node, children, next: 0, size: 1 + holes };
  };
  const frames: ExpansionFrame[] = [frameOf(root)];
  let repeated = 0;
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.next < frame.children.length) {
      const child = frame.children[frame.next++];
      if (child === null || typeof child !== 'object') {
        frame.size++;
        continue;
      }
      const knownSize = sizes.get(child);
      if (knownSize !== undefined) {
        repeated += knownSize;
        frame.size += knownSize;
        if (repeated > MAX_REPEATED_VALUES) {
          throw new ParseError(
            `The document repeats shared values (YAML aliases or shared objects) that expand to more than ${MAX_REPEATED_VALUES} values when copied`,
            { maxRepeatedValues: MAX_REPEATED_VALUES },
          );
        }
      } else if (!onPath.has(child)) {
        onPath.add(child);
        frames.push(frameOf(child));
      }
      continue;
    }
    frames.pop();
    onPath.delete(frame.node);
    sizes.set(frame.node, frame.size);
    if (frames.length > 0) frames[frames.length - 1].size += frame.size;
  }
}

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
 * counts against `budget`, and so does every hole in an array, which
 * serializes as `null`. A reference back to an enclosing value (a cycle)
 * is dropped, and a value nested more than `MAX_VALUE_DEPTH` levels throws a
 * `SchemaError`. The walk keeps its own stack, so depth costs no call stack.
 * With `asWritten` (a schema's extension), each resolved `$ref` is given back
 * as the `$ref` instead, so it is neither shared nor expanded.
 */
export function copyJsonValue(root: unknown, budget: CopyBudget, options: CopyOptions): unknown {
  if (root === null || typeof root !== 'object') {
    chargeBudget(budget);
    return root;
  }
  // A flat container may hold a `$ref` given back as written (one to a boolean schema)
  return (options.asWritten ? undefined : copyFlat(root, budget, options)) ?? copyTree(root, budget, options);
}

/**
 * Copy a container that holds only primitives — most keyword values
 * (`required`, `enum`, `type`, ...) — without the walk's bookkeeping;
 * `undefined` when it holds a container.
 */
function copyFlat(node: object, budget: CopyBudget, options: CopyOptions): object | undefined {
  if (Array.isArray(node)) {
    // Every slot counts, a hole as the `null` it serializes as — so an array
    // longer than the budget left is rejected before it is scanned
    ensureBudget(budget, 1 + node.length);
    for (let i = 0; i < node.length; i++) {
      if (!(i in node)) continue;
      const value: unknown = node[i];
      if (value !== null && typeof value === 'object') return undefined;
    }
    chargeBudget(budget, 1 + node.length);
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
    if (Array.isArray(node)) ensureBudget(budget, 1 + node.length);
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
    const flat = options.asWritten ? undefined : copyFlat(node, budget, options);
    if (flat) return flat;
    push(node);
    return pending;
  };
  const store = (frame: CopyFrame, index: number, value: unknown): void => {
    if (!frame.keys) {
      (frame.out as unknown[])[index] = value;
      return;
    }
    setOwnProperty(frame.out, frame.keys[index], value);
  };

  push(root);
  for (;;) {
    const frame = frames[frames.length - 1];
    if (!frame.keys) {
      // Holes stay holes, as with `.map` — each counts, as the `null` it serializes as
      while (frame.next < frame.values.length && !(frame.next in frame.values)) {
        chargeBudget(budget);
        frame.next++;
      }
    }
    if (frame.next < frame.values.length) {
      const index = frame.next++;
      const ref = options.asWritten
        ? referenceAt(frame.node, frame.keys ? frame.keys[index] : index, frame.values[index])
        : undefined;
      if (ref !== undefined) {
        chargeBudget(budget, 2);
        store(frame, index, { $ref: ref });
        continue;
      }
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
