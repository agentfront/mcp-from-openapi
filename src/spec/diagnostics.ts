/**
 * Diagnostics: what the spec layer reports about a document without failing.
 *
 * The layer cannot throw the library's errors (it imports nothing from
 * outside `src/spec/`, see `./tsconfig.json`), and most of what it finds does
 * not warrant failing anyway. A function that finds something worth
 * reporting returns it as a `SpecDiagnostic`; the caller decides what it
 * becomes.
 *
 * Document text is untrusted, so the helpers here bound and escape it before
 * it reaches a diagnostic: `describeValue` for message fragments, the pointer
 * helpers for `path`.
 *
 * @module
 */

/** How much a diagnostic matters. Errors are the caller's to raise. */
export type SpecDiagnosticSeverity = 'warning' | 'info';

/** Something the spec layer noticed about a document. */
export interface SpecDiagnostic {
  severity: SpecDiagnosticSeverity;
  /** Stable machine-readable code; `SPEC_DIAGNOSTIC_CODES` lists this layer's. */
  code: string;
  /** What was found and what happens because of it. */
  message: string;
  /**
   * JSON Pointer (RFC 6901) to the value concerned, built with `jsonPointer`
   * or `appendPointer`: `''` is the document root, `/paths/~1pets/get` the
   * `get` operation of path `/pets`. A pointer with a truncated or escaped
   * segment is for display only (see `escapePointerSegment`).
   */
  path?: string;
  /**
   * Which document `path` points into, set only by the generator for a
   * Swagger 2.0 document, which has two: `'source'`, the 2.0 document as
   * written (every finding about a construct that exists there, parameter
   * indexes included), or `'converted'`, its OpenAPI 3.0 conversion
   * (`generator.getDocument()` once generation has run) for a construct only
   * the conversion has, such as a request body. Absent for every other
   * document, and on a diagnostic without `path`.
   */
  document?: 'source' | 'converted';
}

/**
 * The codes of the diagnostics this layer emits. Each module documents when
 * it emits each one; the values never change once released.
 */
export const SPEC_DIAGNOSTIC_CODES = Object.freeze({
  /** The document declares a 3.x minor version newer than the latest known one. */
  NEWER_OPENAPI_VERSION: 'NEWER_OPENAPI_VERSION',
  /** The document uses a feature its declared version does not define. */
  FEATURE_NEWER_THAN_DECLARED_VERSION: 'FEATURE_NEWER_THAN_DECLARED_VERSION',
  /** The document declares both `openapi` and `swagger`; `swagger` is ignored. */
  CONFLICTING_VERSION_FIELDS: 'CONFLICTING_VERSION_FIELDS',
  /** A Path Item is neither an object nor absent, so it holds no operations. */
  PATH_ITEM_NOT_OBJECT: 'PATH_ITEM_NOT_OBJECT',
  /** An operation field holds something other than an object; it is ignored. */
  OPERATION_NOT_OBJECT: 'OPERATION_NOT_OBJECT',
  /** A Path Item's `additionalOperations` is not an object; it is ignored. */
  ADDITIONAL_OPERATIONS_NOT_OBJECT: 'ADDITIONAL_OPERATIONS_NOT_OBJECT',
  /** An `additionalOperations` key is not an HTTP method token (RFC 9110); it is ignored. */
  INVALID_METHOD_TOKEN: 'INVALID_METHOD_TOKEN',
  /**
   * An `additionalOperations` key is the upper-case name of a method with a
   * fixed field (`GET` ... `QUERY`), which the specification forbids; it is
   * ignored.
   */
  DUPLICATE_FIXED_METHOD: 'DUPLICATE_FIXED_METHOD',
  /**
   * An `additionalOperations` key is another letter-case variant of a method
   * with a fixed field (`post`, `Get`). The specification allows it, but this
   * library sends every case variant of a standard method upper-cased, so it
   * is ignored.
   */
  METHOD_CASE_VARIANT: 'METHOD_CASE_VARIANT',
  /** An `additionalOperations` key names a method this library never sends (`CONNECT`); it is ignored. */
  REFUSED_METHOD: 'REFUSED_METHOD',
  /**
   * A parameter's `name` is a number or a boolean (YAML reads an unquoted
   * `2024` or `true` so); it is read as its text.
   */
  PARAMETER_NAME_NOT_STRING: 'PARAMETER_NAME_NOT_STRING',

  // Swagger 2.0 to OpenAPI 3.0 conversion (`upgradeSwagger2`, `./upgrade-v2.ts`)

  /** The document given to `upgradeSwagger2` does not declare Swagger 2.0; it is converted as if it did. */
  SWAGGER_VERSION_NOT_2_0: 'SWAGGER_VERSION_NOT_2_0',
  /** A Swagger 2.0 field holds a value of the wrong kind, or a required one is missing; it is ignored or replaced as the message says. */
  SWAGGER_INVALID_VALUE: 'SWAGGER_INVALID_VALUE',
  /** An object holds fields Swagger 2.0 does not define there (other than `x-` extensions); they are not converted. */
  SWAGGER_UNKNOWN_FIELD: 'SWAGGER_UNKNOWN_FIELD',
  /** A Swagger 2.0 construct has no OpenAPI 3.0 equivalent; it is dropped or approximated as the message says. */
  SWAGGER_NOT_CONVERTED: 'SWAGGER_NOT_CONVERTED',
  /** A `$ref` is left in a document the converter expects dereferenced; the object holding it is ignored. */
  SWAGGER_UNRESOLVED_REFERENCE: 'SWAGGER_UNRESOLVED_REFERENCE',
  /** No usable `host` and no document URI: the server URL is relative to wherever the document is served from. */
  SWAGGER_RELATIVE_SERVER_URL: 'SWAGGER_RELATIVE_SERVER_URL',
  /** No `schemes` and no document URI to take a scheme from: `https` is assumed. */
  SWAGGER_ASSUMED_SCHEME: 'SWAGGER_ASSUMED_SCHEME',
  /** No `consumes` or `produces` applies to a body: `application/json` is assumed. */
  SWAGGER_ASSUMED_MEDIA_TYPE: 'SWAGGER_ASSUMED_MEDIA_TYPE',
  /** Form parameters under a `consumes` list naming no form media type: one is added. */
  SWAGGER_FORM_MEDIA_TYPE_ADDED: 'SWAGGER_FORM_MEDIA_TYPE_ADDED',
  /** An operation has more than one `in: body` parameter; the last one is the body. */
  SWAGGER_MULTIPLE_BODY_PARAMETERS: 'SWAGGER_MULTIPLE_BODY_PARAMETERS',
  /** An operation has both `in: body` and `in: formData` parameters; the body parameter is the body. */
  SWAGGER_BODY_AND_FORM_DATA: 'SWAGGER_BODY_AND_FORM_DATA',
  /** Two `in: formData` parameters of one list share a name; the last one is used. */
  SWAGGER_DUPLICATE_FORM_DATA_PARAMETER: 'SWAGGER_DUPLICATE_FORM_DATA_PARAMETER',
  /** A `collectionFormat` OpenAPI 3.0 cannot express where it is used; the stated fallback applies. */
  SWAGGER_UNSUPPORTED_COLLECTION_FORMAT: 'SWAGGER_UNSUPPORTED_COLLECTION_FORMAT',
  /** `type: file` outside an `in: formData` parameter; it is converted to a binary string anyway. */
  SWAGGER_FILE_OUTSIDE_FORM_DATA: 'SWAGGER_FILE_OUTSIDE_FORM_DATA',
  /** A security scheme of an unknown `type` or OAuth2 `flow`; it is not converted. */
  SWAGGER_UNSUPPORTED_SECURITY_SCHEME: 'SWAGGER_UNSUPPORTED_SECURITY_SCHEME',
  /** `consumes` or `produces` lists hold more distinct media types than `MAX_MEDIA_TYPES_PER_LIST`; the rest are ignored (one diagnostic per document). */
  SWAGGER_MEDIA_TYPE_LIMIT: 'SWAGGER_MEDIA_TYPE_LIMIT',
  /** The conversion would create more than `MAX_CONVERSION_ENTRIES` entries; it is abandoned. */
  SWAGGER_CONVERSION_TOO_LARGE: 'SWAGGER_CONVERSION_TOO_LARGE',
} as const);

/** One of this layer's diagnostic codes. */
export type SpecDiagnosticCode = (typeof SPEC_DIAGNOSTIC_CODES)[keyof typeof SPEC_DIAGNOSTIC_CODES];

/**
 * The characters never put raw into a diagnostic or a message, as a regular
 * expression character class: C0 controls, DEL and C1 controls (which include
 * the single-byte CSI terminals act on), the line and paragraph separators,
 * the bidirectional formatting characters (U+061C, U+200E, U+200F,
 * U+202A-U+202E, U+2066-U+2069) and the invisible ones (U+200B-U+200D,
 * U+2060, U+FEFF). A string, so no compiler turns an escaped U+2028 into a
 * raw line separator, which would end a regular expression literal.
 */
export const UNSAFE_CHARACTER_CLASS =
  '\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff';

const UNSAFE_CHARACTERS = new RegExp(`[${UNSAFE_CHARACTER_CLASS}]`, 'g');

/** One UTF-16 code unit that is unsafe, or a surrogate (a lone one, once pairs are taken out). */
const UNSAFE_CODE_UNIT = new RegExp(`[${UNSAFE_CHARACTER_CLASS}\\ud800-\\udfff]`);

const escapeCodeUnit = (character: string): string =>
  `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** Replaces each unsafe character of `text` by its `\uXXXX` escape. */
function escapeUnsafeCharacters(text: string): string {
  return text.replace(UNSAFE_CHARACTERS, escapeCodeUnit);
}

/** Longest escaped pointer segment kept before it is cut; see `escapePointerSegment`. */
export const MAX_POINTER_SEGMENT_LENGTH = 256;

/** Appended to a pointer segment that was cut. Holds neither `/` nor `~`. */
export const POINTER_TRUNCATION_MARKER = '...(truncated)';

/**
 * Escapes one JSON Pointer reference token (RFC 6901 section 3): `~` becomes
 * `~0` and `/` becomes `~1`.
 *
 * The segment usually comes from the document, so it is also made safe to
 * display:
 *
 * - control, separator and bidirectional formatting characters, and lone
 *   surrogates, become `\uXXXX` (`\u000d` for a carriage return);
 * - an escaped segment longer than `MAX_POINTER_SEGMENT_LENGTH` is cut there
 *   (never inside an escape) and `POINTER_TRUNCATION_MARKER` appended.
 *
 * A segment of ordinary text is returned exactly as RFC 6901 escapes it, so
 * its pointer resolves. A pointer holding a cut or `\u`-escaped segment is for
 * display only: it no longer resolves to the value.
 *
 * At most `MAX_POINTER_SEGMENT_LENGTH + POINTER_TRUNCATION_MARKER.length`
 * characters; the work is bounded by that too, whatever the input size.
 */
export function escapePointerSegment(segment: string | number): string {
  const text = String(segment);
  let escaped = '';
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    // A surrogate pair is one character, kept whole
    const width = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
    const character = text.slice(index, index + width);
    const unit =
      character === '~'
        ? '~0'
        : character === '/'
          ? '~1'
          : width === 1 && UNSAFE_CODE_UNIT.test(character)
            ? escapeCodeUnit(character)
            : character;
    if (escaped.length + unit.length > MAX_POINTER_SEGMENT_LENGTH) return escaped + POINTER_TRUNCATION_MARKER;
    escaped += unit;
    index += width;
  }
  return escaped;
}

/**
 * Builds a JSON Pointer from unescaped segments: `jsonPointer('paths', '/pets',
 * 'get')` is `/paths/~1pets/get`. No segments give `''`, the whole document.
 * Each segment goes through `escapePointerSegment`.
 */
export function jsonPointer(...segments: ReadonlyArray<string | number>): string {
  return segments.map((segment) => `/${escapePointerSegment(segment)}`).join('');
}

/**
 * Extends the pointer `base` with unescaped segments. `base` is expected to
 * come from `jsonPointer`/`appendPointer`; it is not re-escaped or cut, but
 * any unsafe character in it is still replaced by its `\uXXXX` escape.
 */
export function appendPointer(base: string, ...segments: ReadonlyArray<string | number>): string {
  return escapeUnsafeCharacters(base) + jsonPointer(...segments);
}

/** Longest stretch of a document string `describeValue` quotes by default. */
export const DESCRIBED_VALUE_MAX_LENGTH = 64;

/**
 * Describes a document value for a message without pasting arbitrary content
 * into it: a string is cut to `maxLength` characters, quoted as JSON (so
 * control characters are escaped), and any remaining unsafe character (DEL,
 * C1 controls, separators, bidirectional formatting) is `\uXXXX`-escaped; an
 * object or array is named, not printed.
 */
export function describeValue(value: unknown, maxLength: number = DESCRIBED_VALUE_MAX_LENGTH): string {
  switch (typeof value) {
    case 'string':
      return escapeUnsafeCharacters(
        JSON.stringify(value.length > maxLength ? `${value.slice(0, maxLength)}...` : value),
      );
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'undefined':
      return 'undefined';
    case 'object':
      return value === null ? 'null' : Array.isArray(value) ? 'an array' : 'an object';
    default:
      return `a ${typeof value}`;
  }
}

/** Longest string `diagnosticKey` returns. */
export const DIAGNOSTIC_KEY_MAX_LENGTH = 512;

/** Characters of the full key kept in front of the hash when a key is shortened. */
const DIAGNOSTIC_KEY_PREFIX_LENGTH = 448;

/**
 * A 64-bit non-cryptographic hash (cyrb53's mixing, both 32-bit halves kept),
 * as 16 hex digits.
 */
function hash64(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/**
 * An identity for de-duplicating diagnostics, at most
 * `DIAGNOSTIC_KEY_MAX_LENGTH` (512) characters whatever their size, so a
 * `Map` or `Set` of keys hashes well (V8 hashes a string longer than 16,383
 * characters by its length alone).
 *
 * The key is `JSON.stringify([severity, code, path ?? null, message])` when
 * that fits in 512 characters, which it does for every diagnostic of this
 * layer whose `path` has a few segments. A longer one keeps its first 448
 * characters, then `#`, its length in base 36 and a 64-bit hash of the whole
 * (at most 448 + 1 + 6 + 1 + 16 = 472 characters for any JavaScript string).
 * Two different long diagnostics share a key only if they agree on those 448
 * characters and the length and their hashes collide.
 */
export function diagnosticKey(diagnostic: SpecDiagnostic): string {
  const full = JSON.stringify([diagnostic.severity, diagnostic.code, diagnostic.path ?? null, diagnostic.message]);
  return full.length <= DIAGNOSTIC_KEY_MAX_LENGTH
    ? full
    : `${full.slice(0, DIAGNOSTIC_KEY_PREFIX_LENGTH)}#${full.length.toString(36)}:${hash64(full)}`;
}
