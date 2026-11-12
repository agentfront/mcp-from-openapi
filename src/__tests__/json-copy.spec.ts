import { copyJsonValue, MAX_VALUE_DEPTH, type CopyBudget } from '../json-copy';
import { SchemaError } from '../errors';

const budgetOf = (maxNodes = Infinity): CopyBudget => ({
  maxNodes,
  nodes: 0,
  exceeded: () => {
    throw new Error(`over ${maxNodes}`);
  },
});

describe('copyJsonValue', () => {
  it('copies into a fresh tree: a value shared by two paths becomes two copies', () => {
    const shared = { kind: 'shared', list: [1, 2] };
    const source = { left: shared, right: [shared] };

    const copy = copyJsonValue(source, budgetOf(), { label: 'Value' }) as any;

    expect(copy).toEqual(source);
    expect(copy).not.toBe(source);
    expect(copy.left).not.toBe(shared);
    expect(copy.right[0]).not.toBe(copy.left);
    expect(copy.left.list).not.toBe(shared.list);
  });

  it('counts every copied value — objects, arrays, and primitives — and calls the owner when it runs out', () => {
    // The object, the array, `1`, the inner object, and `2`
    const value = { a: [1, { b: 2 }] };
    const budget = budgetOf(5);

    expect(copyJsonValue(value, budget, { label: 'Value' })).toEqual(value);
    expect(budget.nodes).toBe(5);
    expect(() => copyJsonValue(value, budgetOf(4), { label: 'Value' })).toThrow('over 4');

    // The budget runs out on a primitive: nested, or the whole value
    expect(() => copyJsonValue({ a: { b: 1 }, c: 2 }, budgetOf(3), { label: 'Value' })).toThrow('over 3');
    const shared = budgetOf(1);
    expect(copyJsonValue('text', shared, { label: 'Value' })).toBe('text');
    expect(() => copyJsonValue('more', shared, { label: 'Value' })).toThrow('over 1');
  });

  it('stops a value whose shared children expand exponentially at the budget', () => {
    let value: unknown = { leaf: true };
    for (let i = 0; i < 60; i++) value = { left: value, right: value };

    expect(() => copyJsonValue(value, budgetOf(100000), { label: 'Value' })).toThrow('over 100000');
  });

  it('drops a reference back to an enclosing value', () => {
    const node: any = { name: 'root', list: [] };
    node.self = node;
    node.list.push(node, 1);

    const copy = copyJsonValue(node, budgetOf(), { label: 'Value' }) as any;

    expect(JSON.stringify(copy)).toBe('{"name":"root","list":[null,1]}');
    expect('self' in copy).toBe(true);
    expect(copy.self).toBeUndefined();
  });

  it(`copies a value nested ${MAX_VALUE_DEPTH} levels deep and rejects a deeper one`, () => {
    const nested = (levels: number): unknown => {
      let value: unknown = [];
      for (let i = 1; i < levels; i++) value = i % 2 === 0 ? [value] : { next: value };
      return value;
    };

    expect(JSON.stringify(copyJsonValue(nested(1000), budgetOf(), { label: 'Value' }))).toBe(
      JSON.stringify(nested(1000)),
    );
    expect(() => copyJsonValue(nested(1001), budgetOf(), { label: 'The `default` value of a schema' })).toThrow(
      new SchemaError('The `default` value of a schema is nested more than 1000 levels deep.'),
    );
  });

  it('keeps an own __proto__ key as an own property, unless prototype keys are omitted', () => {
    const value = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "prototype": 2, "ok": 3}');

    const kept = copyJsonValue(value, budgetOf(), { label: 'Value' }) as any;
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
    expect(Object.keys(kept)).toEqual(['__proto__', 'constructor', 'prototype', 'ok']);
    expect(JSON.stringify(kept)).toBe(JSON.stringify(value));
    expect(({} as any).polluted).toBeUndefined();

    const omitted = copyJsonValue(value, budgetOf(), { label: 'Value', omitPrototypeKeys: true });
    expect(JSON.stringify(omitted)).toBe('{"ok":3}');
  });

  it('keeps the holes of a sparse array', () => {
    // eslint-disable-next-line no-sparse-arrays
    const flat = copyJsonValue([1, , 3], budgetOf(), { label: 'Value' }) as unknown[];
    expect(flat).toHaveLength(3);
    expect(1 in flat).toBe(false);
    expect(flat[2]).toBe(3);

    // eslint-disable-next-line no-sparse-arrays
    const nested = copyJsonValue([{ a: 1 }, , { b: 2 }], budgetOf(), { label: 'Value' }) as unknown[];
    expect(nested).toHaveLength(3);
    expect(1 in nested).toBe(false);
    expect(nested[2]).toEqual({ b: 2 });
  });
});
