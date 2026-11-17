import { copyJsonValue, MAX_VALUE_DEPTH, type CopyBudget } from '../json-copy';
import { SchemaError } from '../errors';
import { recordReferenceSite } from '../reference-sites';

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

  it('counts each hole of an array as the null it serializes as, rejecting a long array before scanning it', () => {
    // The array and its five slots
    expect(copyJsonValue(new Array(5), budgetOf(6), { label: 'Value' })).toHaveLength(5);
    expect(() => copyJsonValue(new Array(5), budgetOf(5), { label: 'Value' })).toThrow('over 5');
    // The array, `{ a: 1 }` and its 1, the hole, `{ b: 2 }` and its 2
    // eslint-disable-next-line no-sparse-arrays
    const nested = [{ a: 1 }, , { b: 2 }];
    expect(() => copyJsonValue(nested, budgetOf(6), { label: 'Value' })).not.toThrow();
    expect(() => copyJsonValue(nested, budgetOf(5), { label: 'Value' })).toThrow('over 5');
    expect(() => copyJsonValue({ list: new Array(1e9) }, budgetOf(100), { label: 'Value' })).toThrow('over 100');
    expect(() => copyJsonValue([{ a: 1 }, ...new Array(10)], budgetOf(5), { label: 'Value' })).toThrow('over 5');
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

  describe('asWritten', () => {
    const target = () => ({ type: 'object', properties: { id: { type: 'string' } } });
    /** A value as a dereferencer leaves it: `target` sits where `{ $ref }` stood, and is recorded there */
    const resolved = () => {
      const customer = target();
      const list: unknown[] = [customer, 'literal'];
      const nested = { oneOf: list, also: customer, flag: false };
      recordReferenceSite(list, 0, '#/components/schemas/Customer', customer);
      recordReferenceSite(nested, 'also', '#/components/schemas/Customer', customer);
      recordReferenceSite(nested, 'flag', '#/components/schemas/Never', false);
      return nested;
    };

    it('gives back each value put in place of a $ref as that $ref, two nodes each', () => {
      const budget = budgetOf();
      const copy = copyJsonValue(resolved(), budget, { label: 'Value', asWritten: true });

      expect(copy).toEqual({
        oneOf: [{ $ref: '#/components/schemas/Customer' }, 'literal'],
        also: { $ref: '#/components/schemas/Customer' },
        // A $ref to a boolean schema became the boolean: given back too
        flag: { $ref: '#/components/schemas/Never' },
      });
      // The value, the array, its two members (2 + 1), and the two other $refs (2 each)
      expect(budget.nodes).toBe(1 + 1 + 3 + 2 + 2);
    });

    it('copies the resolved values without it, as before', () => {
      expect(copyJsonValue(resolved(), budgetOf(), { label: 'Value' })).toEqual({
        oneOf: [target(), 'literal'],
        also: target(),
        flag: false,
      });
    });

    it('finds a resolved object again in a copy of its container, and drops a site whose value was replaced', () => {
      const value = resolved();
      // A copy of the container (a $ref with siblings, a rewritten schema): the object is found by itself
      const copied = { ...value, flag: true };
      // The value at a site replaced afterwards is not the reference
      value.also = { replaced: true } as any;

      expect(copyJsonValue({ copied }, budgetOf(), { label: 'Value', asWritten: true })).toEqual({
        copied: {
          oneOf: [{ $ref: '#/components/schemas/Customer' }, 'literal'],
          also: { $ref: '#/components/schemas/Customer' },
          // A boolean is found only at its site: here it is a new value
          flag: true,
        },
      });
      expect((copyJsonValue(value, budgetOf(), { label: 'Value', asWritten: true }) as any).also).toEqual({
        replaced: true,
      });
    });

    it('checks a container that holds only primitives, and leaves the root to the caller', () => {
      const flat = { flag: false, name: 'n' };
      recordReferenceSite(flat, 'flag', '#/Never', false);

      expect(copyJsonValue(flat, budgetOf(), { label: 'Value', asWritten: true })).toEqual({
        flag: { $ref: '#/Never' },
        name: 'n',
      });
      expect(copyJsonValue({ inner: flat }, budgetOf(), { label: 'Value', asWritten: true })).toEqual({
        inner: { flag: { $ref: '#/Never' }, name: 'n' },
      });
      expect(copyJsonValue('text', budgetOf(), { label: 'Value', asWritten: true })).toBe('text');
    });

    it('counts a $ref given back against the budget', () => {
      expect(() => copyJsonValue(resolved(), budgetOf(4), { label: 'Value', asWritten: true })).toThrow('over 4');
    });
  });
});
