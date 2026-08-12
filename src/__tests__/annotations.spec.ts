/**
 * Tests for annotation inference and x-mcp extension family overrides
 */

import { inferAnnotationsFromMethod, extractExtensionOverrides } from '../annotations';
import type { HTTPMethod, OperationObject } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('inferAnnotationsFromMethod', () => {
  it.each(['get', 'head', 'options', 'trace'] as HTTPMethod[])(
    'should mark %s as read-only, idempotent, non-destructive',
    (method) => {
      expect(inferAnnotationsFromMethod(method)).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    },
  );

  it.each(['put', 'delete'] as HTTPMethod[])('should mark %s as destructive but idempotent', (method) => {
    expect(inferAnnotationsFromMethod(method)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it.each(['post', 'patch'] as HTTPMethod[])('should mark %s as destructive and non-idempotent', (method) => {
    expect(inferAnnotationsFromMethod(method)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });
});

describe('extractExtensionOverrides', () => {
  const op = (extensions: Record<string, unknown>): OperationObject =>
    ({ responses: {}, ...extensions }) as unknown as OperationObject;

  it('should return empty overrides for an operation without extensions', () => {
    expect(extractExtensionOverrides(op({}))).toEqual({});
  });

  describe('x-speakeasy-mcp', () => {
    it('should read disabled, name, title, description, and top-level hints', () => {
      const result = extractExtensionOverrides(
        op({
          'x-speakeasy-mcp': {
            disabled: true,
            name: 'speak_name',
            title: 'Speak Title',
            description: 'Speak description',
            readOnlyHint: true,
            idempotentHint: true,
          },
        }),
      );

      expect(result).toEqual({
        disabled: true,
        name: 'speak_name',
        title: 'Speak Title',
        description: 'Speak description',
        annotations: { readOnlyHint: true, idempotentHint: true },
      });
    });

    it('should not treat the speakeasy title as an annotation title', () => {
      const result = extractExtensionOverrides(
        op({ 'x-speakeasy-mcp': { title: 'Display', readOnlyHint: true } }),
      );

      expect(result.annotations).toEqual({ readOnlyHint: true });
      expect(result.title).toBe('Display');
    });

    it('should ignore wrongly-typed fields', () => {
      const result = extractExtensionOverrides(
        op({ 'x-speakeasy-mcp': { disabled: 'yes', name: 42, readOnlyHint: 'true' } }),
      );

      expect(result).toEqual({});
    });
  });

  describe('x-mcp', () => {
    it('should treat x-mcp: false as disabled', () => {
      expect(extractExtensionOverrides(op({ 'x-mcp': false }))).toEqual({ disabled: true });
    });

    it('should treat x-mcp: true as explicitly enabled', () => {
      expect(extractExtensionOverrides(op({ 'x-mcp': true }))).toEqual({ disabled: false });
    });

    it('should read the object form with enabled, name, title, description, annotations', () => {
      const result = extractExtensionOverrides(
        op({
          'x-mcp': {
            enabled: false,
            name: 'mcp_name',
            title: 'Mcp Title',
            description: 'Mcp description',
            annotations: { destructiveHint: false, title: 'Annotation Title' },
          },
        }),
      );

      expect(result).toEqual({
        disabled: true,
        name: 'mcp_name',
        title: 'Mcp Title',
        description: 'Mcp description',
        annotations: { destructiveHint: false, title: 'Annotation Title' },
      });
    });

    it('should leave disabled undefined when the object form omits enabled', () => {
      const result = extractExtensionOverrides(op({ 'x-mcp': { name: 'named' } }));

      expect(result.disabled).toBeUndefined();
      expect(result.name).toBe('named');
    });
  });

  describe('x-frontmcp', () => {
    it('should read annotations including the title', () => {
      const result = extractExtensionOverrides(
        op({
          'x-frontmcp': {
            annotations: { title: 'Front Title', readOnlyHint: true },
            cache: { ttl: 60 },
          },
        }),
      );

      expect(result).toEqual({
        title: 'Front Title',
        annotations: { title: 'Front Title', readOnlyHint: true },
      });
    });

    it('should ignore x-frontmcp without annotations', () => {
      expect(extractExtensionOverrides(op({ 'x-frontmcp': { cache: { ttl: 60 } } }))).toEqual({});
    });

    it('should ignore annotations with no valid fields', () => {
      expect(extractExtensionOverrides(op({ 'x-frontmcp': { annotations: { title: 42 } } }))).toEqual({});
    });
  });

  describe('precedence', () => {
    it('should let x-mcp override x-speakeasy-mcp field-by-field', () => {
      const result = extractExtensionOverrides(
        op({
          'x-speakeasy-mcp': {
            disabled: true,
            name: 'speak_name',
            description: 'Speak description',
            readOnlyHint: true,
          },
          'x-mcp': { enabled: true, name: 'mcp_name', annotations: { destructiveHint: true } },
        }),
      );

      expect(result.disabled).toBe(false); // x-mcp enabled:true wins
      expect(result.name).toBe('mcp_name'); // x-mcp wins
      expect(result.description).toBe('Speak description'); // untouched by x-mcp
      expect(result.annotations).toEqual({ readOnlyHint: true, destructiveHint: true }); // merged
    });

    it('should let x-frontmcp annotations win over everything', () => {
      const result = extractExtensionOverrides(
        op({
          'x-speakeasy-mcp': { readOnlyHint: true, title: 'Speak' },
          'x-mcp': { annotations: { readOnlyHint: false, idempotentHint: true }, title: 'Mcp' },
          'x-frontmcp': { annotations: { readOnlyHint: true, title: 'Front' } },
        }),
      );

      expect(result.annotations).toEqual({
        readOnlyHint: true, // x-frontmcp wins
        idempotentHint: true, // preserved from x-mcp
        title: 'Front',
      });
      expect(result.title).toBe('Front');
    });
  });
});

describe('meta and icons extension extraction', () => {
  it('reads meta and icons from the x-mcp object form', () => {
    const overrides = extractExtensionOverrides({
      'x-mcp': {
        meta: { 'com.example/a': 1 },
        icons: [{ src: 'https://e.com/i.png', mimeType: 'image/png', sizes: ['48x48'] }],
      },
    } as any);
    expect(overrides.meta).toEqual({ 'com.example/a': 1 });
    expect(overrides.icons).toEqual([{ src: 'https://e.com/i.png', mimeType: 'image/png', sizes: ['48x48'] }]);
  });

  it('reads meta and icons from x-frontmcp even without annotations', () => {
    const overrides = extractExtensionOverrides({
      'x-frontmcp': { meta: { 'com.example/b': 2 }, icons: [{ src: 'https://e.com/f.png' }] },
    } as any);
    expect(overrides.meta).toEqual({ 'com.example/b': 2 });
    expect(overrides.icons).toEqual([{ src: 'https://e.com/f.png' }]);
    expect(overrides.annotations).toBeUndefined();
    expect(overrides.title).toBeUndefined();
  });

  it('merges meta key-by-key and replaces icons wholesale across layers', () => {
    const overrides = extractExtensionOverrides({
      'x-mcp': { meta: { keep: 1, shared: 'mcp' }, icons: [{ src: 'https://e.com/mcp.png' }] },
      'x-frontmcp': { meta: { shared: 'frontmcp' }, icons: [{ src: 'https://e.com/front.png' }] },
    } as any);
    expect(overrides.meta).toEqual({ keep: 1, shared: 'frontmcp' });
    expect(overrides.icons).toEqual([{ src: 'https://e.com/front.png' }]);
  });

  it('ignores malformed meta and icon entries', () => {
    const overrides = extractExtensionOverrides({
      'x-mcp': {
        meta: ['not', 'an', 'object'],
        icons: [
          'not-an-object',
          { mimeType: 'image/png' },
          { src: '' },
          { src: 'https://e.com/ok.png', mimeType: 42, sizes: ['48x48', 7] },
          ['array'],
        ],
      },
    } as any);
    expect(overrides.meta).toBeUndefined();
    expect(overrides.icons).toEqual([{ src: 'https://e.com/ok.png' }]);
  });

  it('returns undefined icons when nothing well-formed remains', () => {
    const overrides = extractExtensionOverrides({ 'x-mcp': { icons: [{ bad: true }] } } as any);
    expect(overrides.icons).toBeUndefined();
  });

  it('does not read meta or icons from x-speakeasy-mcp', () => {
    const overrides = extractExtensionOverrides({
      'x-speakeasy-mcp': { meta: { 'com.example/x': 1 }, icons: [{ src: 'https://e.com/s.png' }] },
    } as any);
    expect(overrides.meta).toBeUndefined();
    expect(overrides.icons).toBeUndefined();
  });

  it('still promotes x-frontmcp annotations.title alongside meta', () => {
    const overrides = extractExtensionOverrides({
      'x-frontmcp': { annotations: { title: 'Nice', readOnlyHint: true }, meta: { m: 1 } },
    } as any);
    expect(overrides.title).toBe('Nice');
    expect(overrides.annotations).toEqual({ title: 'Nice', readOnlyHint: true });
    expect(overrides.meta).toEqual({ m: 1 });
  });
});
