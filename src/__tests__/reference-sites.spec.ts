import { copyReferenceSites, isExtensionKey, recordReferenceSite, referenceAt } from '../reference-sites';

describe('reference sites', () => {
  it('gives the $ref text of a site while it holds the value put there, an array index read as its text', () => {
    const owner = { type: 'object' };
    const container: Record<string, unknown> = { a: owner, flag: false };
    const list = [{}, owner];
    recordReferenceSite(container, 'a', '#/components/schemas/Owner', owner);
    recordReferenceSite(container, 'flag', '#/components/schemas/Never', false);
    recordReferenceSite(list, 1, 'other.yaml#/Owner', owner);

    expect(referenceAt(container, 'a', owner)).toBe('#/components/schemas/Owner');
    expect(referenceAt(container, 'flag', false)).toBe('#/components/schemas/Never');
    expect(referenceAt(list, 1, owner)).toBe('other.yaml#/Owner');
    expect(referenceAt(list, '1', owner)).toBe('other.yaml#/Owner');
    // A site that now holds another value is not the reference
    expect(referenceAt(container, 'flag', true)).toBeUndefined();
    expect(referenceAt(container, 'a', { type: 'object' })).toBeUndefined();
  });

  it('finds an object put in place of a $ref by itself, anywhere, with the first text recorded for it', () => {
    const owner = { type: 'object' };
    recordReferenceSite({}, 'a', '#/components/schemas/Owner', owner);
    recordReferenceSite({}, 'b', './owner.json', owner);

    expect(referenceAt({ copy: owner }, 'copy', owner)).toBe('#/components/schemas/Owner');
    // A primitive is found only at its site; an object nobody put anywhere is not found
    recordReferenceSite({}, 'c', '#/Never', false);
    expect(referenceAt({ c: false }, 'c', false)).toBeUndefined();
    expect(referenceAt({ d: {} }, 'd', {})).toBeUndefined();
    expect(referenceAt({ e: null }, 'e', null)).toBeUndefined();
  });

  it('copies the sites of one container to another, keeping those the target has', () => {
    const from = { a: false };
    const to: Record<string, unknown> = { a: false, b: true };
    recordReferenceSite(from, 'a', '#/A', false);
    recordReferenceSite(to, 'b', '#/B', true);
    copyReferenceSites(from, to);
    copyReferenceSites({}, to);

    expect(referenceAt(to, 'a', false)).toBe('#/A');
    expect(referenceAt(to, 'b', true)).toBe('#/B');
    expect(referenceAt(from, 'b', true)).toBeUndefined();
  });

  it('reads a specification extension by its x- prefix, as written', () => {
    expect(isExtensionKey('x-expansionResources')).toBe(true);
    expect(isExtensionKey('x-')).toBe(true);
    expect(isExtensionKey('X-Upper')).toBe(false);
    expect(isExtensionKey('properties')).toBe(false);
  });
});
