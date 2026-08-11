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
