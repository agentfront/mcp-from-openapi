/**
 * Where operations live in a Path Item. Every caller that walks or looks up
 * operations goes through this module, so a new method or a new place for
 * operations is added here once.
 *
 * A Path Item holds operations in two places:
 *
 * - fixed fields named after HTTP methods (`get`, `post`, ..., and `query`
 *   from OpenAPI 3.2), whose method is sent upper-cased;
 * - from OpenAPI 3.2, the `additionalOperations` map, whose keys are sent
 *   exactly as written (RFC 9110 methods are case-sensitive).
 *
 * The document is untrusted: every read is an own-property read (a path item
 * never yields `constructor` or `__proto__` from its prototype), any value may
 * be of any type, and nothing here recurses.
 *
 * @module
 */

import { SPEC_DIAGNOSTIC_CODES, appendPointer, describeValue, type SpecDiagnostic } from './diagnostics';
import type { OperationObject } from './types';

/**
 * Whether `value` is a non-null, non-array object, the only shape a spec
 * object can take.
 */
export function isSpecObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads `key` from `value` only if `value` is an object that owns it, so an
 * untrusted key never resolves through the prototype chain
 * (`ownProperty({}, 'constructor')` is `undefined`).
 */
export function ownProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Sets `key` as an own enumerable data property. Plain assignment of the key
 * `__proto__` replaces the object's prototype instead, so a document key
 * `__proto__` (which `JSON.parse` creates as an own property) would vanish
 * and its value's fields would be inherited by the object.
 */
export function setOwnProperty(target: object, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    (target as Record<string, unknown>)[key] = value;
  }
}

/**
 * The methods with a fixed Path Item field, lowercase as the field names are.
 *
 * The first eight keep the order the library has always used (tool order and
 * name-dedup hashes depend on it); `query` (OpenAPI 3.2) comes last. Never
 * reorder: append.
 */
export const STANDARD_METHODS = Object.freeze([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
  'query',
] as const);

/** A method with a fixed Path Item field. */
export type StandardMethod = (typeof STANDARD_METHODS)[number];

/**
 * Methods the library never sends, in upper case (compared
 * case-insensitively). `CONNECT` asks the server to open a tunnel, which is
 * not a request an API tool can make.
 */
export const REFUSED_METHODS = Object.freeze(['CONNECT'] as const);

/** RFC 9110 section 5.6.2 `token`: the OAS 3.2 schema's `#/$defs/token` pattern, verbatim. */
const HTTP_TOKEN = /^[0-9A-Za-z!#$%&'*+.^_`|~-]+$/;

/**
 * Lower-cases ASCII letters only. HTTP methods are ASCII tokens, and Unicode
 * case mapping would let a non-ASCII key compare equal to an ASCII method.
 */
function asciiLowerCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/**
 * Whether `value` is an RFC 9110 `token`, the syntax of an HTTP method:
 * one or more of `A-Z a-z 0-9 ! # $ % & ' * + - . ^ _ ` | ~`.
 */
export function isHttpToken(value: unknown): value is string {
  return typeof value === 'string' && HTTP_TOKEN.test(value);
}

/**
 * The standard method `method` names, compared case-insensitively (`'GET'`,
 * `'Get'` and `'get'` all give `'get'`); `undefined` for any other value.
 */
export function toStandardMethod(method: unknown): StandardMethod | undefined {
  if (typeof method !== 'string') return undefined;
  const lower = asciiLowerCase(method);
  return STANDARD_METHODS.find((standard) => standard === lower);
}

/**
 * Whether `method` names a method with a fixed Path Item field, compared
 * case-insensitively. Use `toStandardMethod` for the normalized name.
 */
export function isStandardMethod(method: unknown): boolean {
  return toStandardMethod(method) !== undefined;
}

/** Whether `method` is one the library never sends (`CONNECT`, in any case). */
export function isRefusedMethod(method: unknown): boolean {
  if (typeof method !== 'string') return false;
  const lower = asciiLowerCase(method);
  return REFUSED_METHODS.some((refused) => asciiLowerCase(refused) === lower);
}

/**
 * The method to put on the wire: a standard method upper-cased (`get` and
 * `Get` give `GET`), any other exactly as written, since methods are
 * case-sensitive and an `additionalOperations` key is sent as written.
 *
 * It does not validate: check `isHttpToken` and `isRefusedMethod` first.
 */
export function wireMethod(method: string): string {
  const standard = toStandardMethod(method);
  return standard === undefined ? method : standard.toUpperCase();
}

/**
 * Which Path Item fields hold operations. A `SpecProfile` is one, so a
 * version's layout is passed as its profile. Which layout applies to a
 * document is decided in one place: `resolveOperationLayout` (`./versions`).
 */
export interface OperationLayout {
  /** The fixed method fields read. */
  readonly fixedMethods: readonly StandardMethod[];
  /** Whether `additionalOperations` is read. */
  readonly additionalOperations: boolean;
}

/** Every place an operation can be: all nine fixed fields and `additionalOperations` (the 3.2 layout). */
export const FULL_OPERATION_LAYOUT: OperationLayout = Object.freeze({
  fixedMethods: STANDARD_METHODS,
  additionalOperations: true,
});

/**
 * What the library read before OpenAPI 3.2 support: the eight historical
 * fixed fields, no `query`, no `additionalOperations`. The layout of 3.0 and
 * 3.1, and of a document whose version cannot be processed.
 */
export const LEGACY_OPERATION_LAYOUT: OperationLayout = Object.freeze({
  fixedMethods: Object.freeze(STANDARD_METHODS.filter((method) => method !== 'query')),
  additionalOperations: false,
});

/**
 * An operation found in a Path Item.
 *
 * - `source: 'fixed'`: `method` is the lowercase field name.
 * - `source: 'additional'`: `method` is the `additionalOperations` key exactly
 *   as written. It is a valid HTTP token but may be any token, such as
 *   `constructor`: never use it as a key of a plain object.
 *
 * `operation` is the document's own object (not a copy), checked only to be
 * an object.
 */
export type OperationEntry =
  | { method: StandardMethod; operation: OperationObject; source: 'fixed' }
  | { method: string; operation: OperationObject; source: 'additional' };

/** Where an operation was found. */
export type OperationSource = OperationEntry['source'];

/**
 * The layout `options` name, read the way a malformed document is: options
 * that are not an object, or a `layout` that is not one with a
 * `fixedMethods` list, count as absent (`FULL_OPERATION_LAYOUT`).
 */
function layoutOption(options: unknown): OperationLayout {
  const layout = ownProperty(options, 'layout');
  return isSpecObject(layout) && Array.isArray(layout['fixedMethods'])
    ? (layout as unknown as OperationLayout)
    : FULL_OPERATION_LAYOUT;
}

/** Options of `listOperations`. */
export interface ListOperationsOptions {
  /** The fields read. Default: `FULL_OPERATION_LAYOUT`; pass `resolveOperationLayout(version)` for a document. */
  layout?: OperationLayout;
  /**
   * JSON Pointer of the Path Item, prefixed to the diagnostics' `path`
   * (`jsonPointer('paths', '/pets')`). Default `''`: paths relative to the
   * Path Item.
   */
  pointer?: string;
}

/** What `listOperations` found. */
export interface OperationList {
  operations: OperationEntry[];
  /** Each value ignored, and why. */
  diagnostics: SpecDiagnostic[];
}

/** Options of `getOperation`. */
export interface GetOperationOptions {
  /** The fields read. Default: `FULL_OPERATION_LAYOUT`; pass `resolveOperationLayout(version)` for a document. */
  layout?: OperationLayout;
}

type AdditionalEntry = Extract<OperationEntry, { source: 'additional' }>;

const byMethod = (a: AdditionalEntry, b: AdditionalEntry): number => (a.method < b.method ? -1 : 1);

/**
 * Why an `additionalOperations` key is ignored, or `undefined` when it is
 * usable. Checked in this order: token syntax, refused method, the upper-case
 * name of a fixed method, another case variant of one. Constant time apart
 * from the token check, which is linear in the key.
 */
function additionalKeyProblem(key: string): { code: string; message: string } | undefined {
  if (!isHttpToken(key)) {
    return {
      code: SPEC_DIAGNOSTIC_CODES.INVALID_METHOD_TOKEN,
      message: `additionalOperations key ${describeValue(key)} is not an HTTP method (RFC 9110 token); the operation is ignored`,
    };
  }
  if (isRefusedMethod(key)) {
    return {
      code: SPEC_DIAGNOSTIC_CODES.REFUSED_METHOD,
      message: `additionalOperations key ${describeValue(key)} names CONNECT, which opens a tunnel rather than sending a request; the operation is ignored`,
    };
  }
  const standard = toStandardMethod(key);
  if (standard === undefined) return undefined;
  const wire = standard.toUpperCase();
  return key === wire
    ? {
        code: SPEC_DIAGNOSTIC_CODES.DUPLICATE_FIXED_METHOD,
        message: `additionalOperations key ${describeValue(key)} is the method of the fixed \`${standard}\` field, which the specification forbids; the operation is ignored`,
      }
    : {
        code: SPEC_DIAGNOSTIC_CODES.METHOD_CASE_VARIANT,
        message: `additionalOperations key ${describeValue(key)} differs from ${wire} only in letter case; this library sends every case of a standard method as ${wire} (the \`${standard}\` field), so the operation is ignored`,
      };
}

function operationNotObject(where: string, value: unknown, base: string, key: string): SpecDiagnostic {
  return {
    severity: 'warning',
    code: SPEC_DIAGNOSTIC_CODES.OPERATION_NOT_OBJECT,
    message: `${where} must hold an Operation Object, found ${describeValue(value)}; it is ignored`,
    path: appendPointer(base, key),
  };
}

/**
 * Every operation of a Path Item, in a stable order: the fixed method fields
 * in `STANDARD_METHODS` order, then the `additionalOperations` entries sorted
 * by key (code-unit order, so `LINK` sorts before `lock`).
 *
 * An absent value (`undefined`) is skipped silently. Everything else that is
 * not listed gets a warning diagnostic:
 *
 * - `PATH_ITEM_NOT_OBJECT`: `pathItem` is not an object (`null`, an array, ...).
 * - `OPERATION_NOT_OBJECT`: a fixed field or `additionalOperations` value that
 *   is not an object.
 * - `ADDITIONAL_OPERATIONS_NOT_OBJECT`: `additionalOperations` is not an object.
 * - `INVALID_METHOD_TOKEN`: an `additionalOperations` key that is not an
 *   RFC 9110 token (empty, with a space, a newline, non-ASCII, ...).
 * - `REFUSED_METHOD`: an `additionalOperations` key `CONNECT`, in any case.
 * - `DUPLICATE_FIXED_METHOD`: an `additionalOperations` key that is the
 *   upper-case name of a standard method (`GET` ... `QUERY`); the
 *   specification forbids it.
 * - `METHOD_CASE_VARIANT`: an `additionalOperations` key that is another case
 *   of a standard method (`post`, `Get`). Allowed by the specification, but
 *   the wire method is a pure function of the string (`wireMethod`), which
 *   sends it upper-cased, so only the fixed field serves that method.
 *
 * Only the fields in `options.layout` are read; any other field is left to
 * the validator (`listSkippedNewerOperations` in `./versions` reports the
 * operation fields a version's layout leaves out).
 *
 * Linear in the size of `additionalOperations`, plus sorting it.
 */
export function listOperations(pathItem: unknown, options?: ListOperationsOptions | null): OperationList {
  const layout = layoutOption(options);
  const pointerOption = ownProperty(options, 'pointer');
  const base = typeof pointerOption === 'string' ? pointerOption : '';
  const operations: OperationEntry[] = [];
  const diagnostics: SpecDiagnostic[] = [];
  if (pathItem === undefined) return { operations, diagnostics };
  if (!isSpecObject(pathItem)) {
    diagnostics.push({
      severity: 'warning',
      code: SPEC_DIAGNOSTIC_CODES.PATH_ITEM_NOT_OBJECT,
      message: `A Path Item must be an object, found ${describeValue(pathItem)}; it holds no operations`,
      path: appendPointer(base),
    });
    return { operations, diagnostics };
  }
  for (const method of STANDARD_METHODS) {
    if (!layout.fixedMethods.includes(method)) continue;
    const operation = ownProperty(pathItem, method);
    if (operation === undefined) continue;
    if (!isSpecObject(operation)) {
      diagnostics.push(operationNotObject(`The \`${method}\` field`, operation, base, method));
      continue;
    }
    operations.push({ method, operation: operation as OperationObject, source: 'fixed' });
  }
  if (!layout.additionalOperations) return { operations, diagnostics };
  const container = ownProperty(pathItem, 'additionalOperations');
  if (container === undefined) return { operations, diagnostics };
  const pointer = appendPointer(base, 'additionalOperations');
  if (!isSpecObject(container)) {
    diagnostics.push({
      severity: 'warning',
      code: SPEC_DIAGNOSTIC_CODES.ADDITIONAL_OPERATIONS_NOT_OBJECT,
      message: `additionalOperations must be an object mapping methods to operations, found ${describeValue(container)}; it is ignored`,
      path: pointer,
    });
    return { operations, diagnostics };
  }
  const additional: AdditionalEntry[] = [];
  // Object.entries reads own enumerable string keys only, including an own
  // `__proto__` key created by JSON.parse
  for (const [key, operation] of Object.entries(container)) {
    if (operation === undefined) continue;
    const problem = additionalKeyProblem(key);
    if (problem !== undefined) {
      diagnostics.push({ severity: 'warning', ...problem, path: appendPointer(pointer, key) });
      continue;
    }
    if (!isSpecObject(operation)) {
      diagnostics.push(operationNotObject(`additionalOperations key ${describeValue(key)}`, operation, pointer, key));
      continue;
    }
    additional.push({ method: key, operation: operation as OperationObject, source: 'additional' });
  }
  // One push per entry: spreading the list into push() passes it as call
  // arguments, which overflows the stack for a large map (about 125,000 entries)
  for (const entry of additional.sort(byMethod)) operations.push(entry);
  return { operations, diagnostics };
}

/**
 * The operation `listOperations` would list for `method`, or `undefined`.
 * Constant time: one own-property read and the checks of that one key.
 *
 * - A standard method in any case (`GET`, `get`) is looked up in its fixed
 *   field only, never in `additionalOperations`.
 * - Any other method is the `additionalOperations` key matched exactly as
 *   written (`LINK` does not find `link`), as pointers and method filters are.
 */
export function getOperation(
  pathItem: unknown,
  method: string,
  options?: GetOperationOptions | null,
): OperationEntry | undefined {
  if (typeof method !== 'string' || !isSpecObject(pathItem)) return undefined;
  const layout = layoutOption(options);
  const standard = toStandardMethod(method);
  if (standard !== undefined) {
    if (!layout.fixedMethods.includes(standard)) return undefined;
    const operation = ownProperty(pathItem, standard);
    return isSpecObject(operation)
      ? { method: standard, operation: operation as OperationObject, source: 'fixed' }
      : undefined;
  }
  if (!layout.additionalOperations) return undefined;
  const container = ownProperty(pathItem, 'additionalOperations');
  if (!isSpecObject(container)) return undefined;
  const operation = ownProperty(container, method);
  if (!isSpecObject(operation) || additionalKeyProblem(method) !== undefined) return undefined;
  return { method, operation: operation as OperationObject, source: 'additional' };
}
