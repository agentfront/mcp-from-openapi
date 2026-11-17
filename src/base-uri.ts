/**
 * The URIs of an OpenAPI document, and the decisions that depend on them
 * (OpenAPI 3.2.1 "Establishing the Base URI", RFC 3986 section 5.1).
 *
 * A document has two kinds of URI, kept apart on purpose:
 *
 * - **Identity**: the URIs that name the document, so a `$ref` to them is a
 *   reference to the document itself and stays local instead of being
 *   fetched (`findSelfReferences`), and a Security Requirement key that is
 *   such a URI names one of its schemes (`resolveSecuritySchemeUri`). These
 *   are its retrieval URI and, from OpenAPI 3.2, its `$self` (resolved
 *   against the retrieval URI), as the specification describes.
 * - **Retrieval base**: what a relative reference to another document is
 *   resolved against before it is read. This is the retrieval URI (the final
 *   URL of `fromURL`, the file of `fromFile`, or `LoadOptions.documentUri`)
 *   whenever one is known, so a file reads the files next to it and a mirror
 *   serves its own copies. Only a document with no retrieval URI at all
 *   (`fromJSON`/`fromYAML` without `documentUri`) and an absolute `$self`
 *   resolves relative references against `$self`. The specification takes
 *   `$self` as the base for both; where to retrieve a document from is left
 *   to implementations, and this one never lets a document's own claim move
 *   its reads to another location. With neither, references resolve as they
 *   always did (relative ones against the working directory).
 *
 * A document is untrusted: it controls `$self` and every `$ref`. Nothing here
 * fetches anything or decides what may be fetched; a resolved URL passes the
 * same protocol, host and address gates as an absolute `$ref` written in the
 * document. No URI here carries user information, so no credential of the
 * spec URL travels with a reference resolved against it. Every URI used is
 * at most `MAX_BASE_URI_LENGTH` characters: each reference is resolved
 * against it, so a longer one would multiply into every resolution.
 *
 * @module
 */

import { LoadError } from './errors';
import { DIAGNOSTIC_CODES } from './types';
import {
  describeValue,
  featureNewerThanDeclared,
  getSpecProfile,
  ownProperty,
  type SpecDiagnostic,
  type SpecVersionInfo,
} from './spec';

/** URI schemes a document URI may have: the ones a document can be retrieved from. */
const BASE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'file:']);

/**
 * The longest URI used as a document's URI (`$self`, a retrieval URI,
 * `documentUri`). Every reference is resolved against it, so the work grows
 * with its length; real document URIs are far shorter.
 */
export const MAX_BASE_URI_LENGTH = 2048;

/** JSON Pointer of the `$self` field. */
const SELF_POINTER = '/$self';

/** Base used only to check that a relative reference parses; never resolved against for real. */
const PARSE_CHECK_BASE = 'https://base.invalid/';

/**
 * Every character a URI reference may hold (RFC 3986 section 2: unreserved,
 * reserved, and `%` followed by two hex digits). Spaces, controls, non-ASCII
 * and `"<>\^`{|}` are not URI characters. Checked before parsing because the
 * WHATWG URL parser silently drops tabs and line breaks and trims spaces.
 */
const URI_REFERENCE_CHARACTERS = /^(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;

/** A URI that starts with a scheme (RFC 3986 section 3.1), so it is not a relative reference. */
const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** The URIs a document is known by. */
export interface DocumentBase {
  /**
   * What relative references are resolved against to be read: the retrieval
   * URI, or `$self` when there is no retrieval URI and it is absolute.
   * `undefined` when neither is usable; then a relative reference cannot be
   * resolved (see `retrievalTooLong`).
   */
  readonly href?: string;
  /** Where the document was retrieved from (or `documentUri`), when known and usable. */
  readonly retrievalUri?: string;
  /** `$self` resolved against the retrieval URI, when it is used. */
  readonly selfUri?: string;
  /**
   * `uriComparisonKey` of each URI that names this document: the retrieval
   * URI and `$self`. OpenAPI says references should use `$self` when it is
   * present and allows the retrieval URI too, so both count.
   */
  readonly identities: ReadonlySet<string>;
  /**
   * The document has a retrieval URI longer than `MAX_BASE_URI_LENGTH`,
   * which is not used: its relative references to other documents are
   * refused rather than resolved against anything else.
   */
  readonly retrievalTooLong: boolean;
}

/** `%7e` becomes `~` (unreserved, RFC 3986 section 6.2.2.2) and `%2f` becomes `%2F` (section 6.2.2.1). */
function normalizeEscapes(text: string): string {
  return text.replace(/%[0-9A-Fa-f]{2}/g, (escape) => {
    const character = String.fromCharCode(parseInt(escape.slice(1), 16));
    return /^[A-Za-z0-9\-._~]$/.test(character) ? character : escape.toUpperCase();
  });
}

/**
 * A key under which two URIs are equal exactly when they name the same
 * document, or `undefined` for a URI that cannot be a document's URI (any
 * scheme other than http, https and file).
 *
 * The WHATWG URL parser, which produced `url`, has already lowercased the
 * scheme and host, converted an internationalized host to its ASCII form,
 * removed a port that is the scheme's default, removed `.` and `..` segments
 * (also written `%2e`), and made an empty http(s) path `/`. On top of that,
 * this key upper-cases the hex digits of percent-encodings and decodes the
 * ones that encode an unreserved character, in the path and the query. The
 * fragment is dropped.
 *
 * Kept apart: a different path, a different query (an empty query `?` is not
 * the same as none, and the order of its parameters matters), and user
 * information (any URI that has some never equals one that has none).
 */
export function uriComparisonKey(url: URL): string | undefined {
  if (!BASE_PROTOCOLS.has(url.protocol)) return undefined;
  const href = url.href;
  const hash = href.indexOf('#');
  const withoutFragment = hash === -1 ? href : href.slice(0, hash);
  const question = withoutFragment.indexOf('?');
  const query = question === -1 ? '' : `?${normalizeEscapes(withoutFragment.slice(question + 1))}`;
  const userInfo = url.username !== '' || url.password !== '' ? `${url.username}:${url.password}@` : '';
  return `${url.protocol}//${userInfo}${url.host}${normalizeEscapes(url.pathname)}${query}`;
}

/** `new URL(reference, base)`, or `undefined` when it does not parse. */
function parseUri(reference: string, base?: string): URL | undefined {
  try {
    return new URL(reference, base);
  } catch {
    return undefined;
  }
}

/** Whether `url` names the document `base` describes (see `uriComparisonKey`). */
export function isSameDocument(url: URL, base: DocumentBase): boolean {
  const key = uriComparisonKey(url);
  return key !== undefined && base.identities.has(key);
}

/**
 * `text` with the user information of a URI it starts with replaced by
 * `***`, for a message: user information may be a real credential.
 */
export function redactUserInfo(text: string): string {
  return text.replace(/^((?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)[^/?#]*@/, '$1***@');
}

/**
 * Checks `LoadOptions.documentUri` and returns it as a parsed URL's `href`.
 * Throws a `LoadError` unless it is an absolute http, https or file URI of
 * at most `MAX_BASE_URI_LENGTH` characters, made of URI characters, without
 * user information (a credential would travel with every reference resolved
 * against it; it is never quoted back), without a fragment (a base URI has
 * none), and, for a file URI, without a host (a network share).
 */
export function parseDocumentUri(value: unknown): string {
  const problem = (what: string): LoadError => {
    const shown = typeof value === 'string' ? redactUserInfo(value) : value;
    return new LoadError(`LoadOptions.documentUri ${what}, found ${describeValue(shown, 256)}`, {
      documentUri: typeof shown === 'string' ? describeValue(shown, 256) : shown,
    });
  };
  if (typeof value !== 'string') throw problem('must be a string');
  if (value.length > MAX_BASE_URI_LENGTH) throw problem(`must be at most ${MAX_BASE_URI_LENGTH} characters`);
  if (!URI_REFERENCE_CHARACTERS.test(value)) throw problem('must be a URI (RFC 3986 characters only)');
  const url = HAS_SCHEME.test(value) ? parseUri(value) : undefined;
  if (url === undefined) throw problem('must be an absolute URI, such as https://example.com/openapi.yaml');
  if (!BASE_PROTOCOLS.has(url.protocol)) throw problem('must be an http, https or file URI');
  if (url.username !== '' || url.password !== '') throw problem('must not contain user information');
  if (value.includes('#')) throw problem('must not contain a fragment');
  if (url.protocol === 'file:' && url.host !== '') throw problem('must not name a host in a file URI');
  return url.href;
}

/**
 * The retrieval URI of a document fetched from `url` (the final URL, after
 * redirects): the URL without its user information and fragment.
 */
export function retrievalUriOf(url: string): string {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.href;
}

/** What `readSelfField` found. */
export type SelfField =
  /** The document has no `$self`. */
  | { kind: 'absent' }
  /**
   * The declared version does not define `$self` (3.0, 3.1), so it is
   * ignored: `diagnostic` is `FEATURE_NEWER_THAN_DECLARED_VERSION`. Absent
   * for a version that cannot be processed, which is read with the rules of
   * no version.
   */
  | { kind: 'not-read'; diagnostic?: SpecDiagnostic }
  /** `$self` breaks the specification (`INVALID_SELF`): it is ignored, and the validator rejects it. */
  | { kind: 'invalid'; diagnostic: SpecDiagnostic }
  /** `$self` is a URI reference without a fragment, as the specification requires. */
  | { kind: 'reference'; value: string };

/** A warning about `$self` at `/$self`, ending with what happens to it. */
function selfDiagnostic(code: string, problem: string): SpecDiagnostic {
  return {
    severity: 'warning',
    code,
    message: `\`$self\` ${problem}; it is ignored, and references resolve as if it were absent`,
    path: SELF_POINTER,
  };
}

/**
 * Reads the OpenAPI Object's `$self` with the specification's rules: a
 * string in the form of a URI reference (RFC 3986 section 4.1), without a
 * fragment (the official 3.2 schema: `pattern: ^[^#]*$`). Read only when the
 * declared version is OpenAPI 3.2 or later. Shared by the validator (which
 * rejects an `invalid` one) and the generator.
 */
export function readSelfField(document: unknown, version: SpecVersionInfo): SelfField {
  const value = ownProperty(document, '$self');
  if (value === undefined) return { kind: 'absent' };
  const processable = version.status === 'supported' || version.status === 'newer-minor';
  if (!(processable && getSpecProfile(version.family)?.self)) {
    const newer = featureNewerThanDeclared('self', version, SELF_POINTER);
    return newer === undefined
      ? { kind: 'not-read' }
      : {
          kind: 'not-read',
          diagnostic: {
            ...newer,
            message: `${newer.message}; it is ignored, and references resolve as if it were absent`,
          },
        };
  }
  if (typeof value !== 'string') {
    return {
      kind: 'invalid',
      diagnostic: selfDiagnostic(
        DIAGNOSTIC_CODES.INVALID_SELF,
        `must be a string holding a URI reference, found ${describeValue(value)}`,
      ),
    };
  }
  if (!URI_REFERENCE_CHARACTERS.test(value) || parseUri(value, PARSE_CHECK_BASE) === undefined) {
    return {
      kind: 'invalid',
      diagnostic: selfDiagnostic(
        DIAGNOSTIC_CODES.INVALID_SELF,
        `must be a URI reference (RFC 3986), found ${describeValue(value)}`,
      ),
    };
  }
  if (value.includes('#')) {
    return {
      kind: 'invalid',
      diagnostic: selfDiagnostic(
        DIAGNOSTIC_CODES.INVALID_SELF,
        `must not contain a fragment, found ${describeValue(value)}`,
      ),
    };
  }
  return { kind: 'reference', value };
}

/** What `resolveDocumentBase` found. */
export interface DocumentBaseResult {
  /** The document's URIs; `undefined` when it has none (no retrieval URI and no usable `$self`). */
  base?: DocumentBase;
  /** Why `$self` or the retrieval URI is not used, when one is present and not used. */
  diagnostics: SpecDiagnostic[];
}

/**
 * The URIs of a document whose retrieval URI is `retrievalUri` (absolute,
 * without fragment or user information; `undefined` when unknown).
 *
 * A retrieval URI longer than `MAX_BASE_URI_LENGTH` is not used
 * (`BASE_URI_TOO_LONG`): a reference to it is not recognised as local, and
 * the document's relative references are refused when read, never resolved
 * against the working directory instead.
 *
 * `$self` (OpenAPI 3.2 or later) is resolved against the retrieval URI and
 * names the document; it is the retrieval base only without a retrieval URI.
 * It is ignored with a diagnostic when:
 *
 * - `INVALID_SELF`: not a URI reference, or it has a fragment (see
 *   `readSelfField`);
 * - `UNRESOLVABLE_SELF`: a relative reference, and no usable retrieval URI to
 *   resolve it against;
 * - `REFUSED_SELF`: it, or the URI it resolves to, is longer than
 *   `MAX_BASE_URI_LENGTH`; it has user information (`https://user:pass@host/`:
 *   a credential must never ride on references); its scheme is not http,
 *   https or file; it is a file URI naming a host; or it is a file URI in a
 *   document retrieved over the network.
 *
 * `$self` never affects `servers` (OpenAPI resolves a relative server URL
 * against the retrieval URI), and it is not a trust origin: every URI
 * resolved against it is fetched, if at all, through the same gates as an
 * absolute reference.
 */
export function resolveDocumentBase(
  document: unknown,
  version: SpecVersionInfo,
  retrievalUri: string | undefined,
): DocumentBaseResult {
  const diagnostics: SpecDiagnostic[] = [];
  const retrievalTooLong = retrievalUri !== undefined && retrievalUri.length > MAX_BASE_URI_LENGTH;
  if (retrievalTooLong) {
    diagnostics.push({
      severity: 'warning',
      code: DIAGNOSTIC_CODES.BASE_URI_TOO_LONG,
      message:
        `The URI the document was retrieved from is longer than ${MAX_BASE_URI_LENGTH} characters, so it is not ` +
        'used: a reference to the document by that URI is not recognised as local, and a relative reference to ' +
        'another document cannot be resolved',
    });
  }
  const retrieval = retrievalUri === undefined || retrievalTooLong ? undefined : new URL(retrievalUri);
  let self: URL | undefined;
  const field = readSelfField(document, version);
  if (field.kind === 'not-read' || field.kind === 'invalid') {
    if (field.diagnostic !== undefined) diagnostics.push(field.diagnostic);
  } else if (field.kind === 'reference') {
    self = usableSelf(field.value, retrieval, retrievalTooLong, diagnostics);
  }

  if (retrieval === undefined && self === undefined && !retrievalTooLong) return { diagnostics };
  const identities = new Set<string>();
  for (const uri of [retrieval, self]) {
    // A retrieval URI and a usable `$self` are always http, https or file
    if (uri !== undefined) identities.add(uriComparisonKey(uri) as string);
  }
  // With a retrieval URI (even an unusable one), `$self` names the document but never moves its reads
  const href = retrievalTooLong ? undefined : (retrieval ?? self)?.href;
  return {
    base: {
      ...(href === undefined ? {} : { href }),
      ...(retrieval === undefined ? {} : { retrievalUri: retrieval.href }),
      ...(self === undefined ? {} : { selfUri: self.href }),
      identities,
      retrievalTooLong,
    },
    diagnostics,
  };
}

/** `$self` (a URI reference without fragment) resolved, or `undefined` with the reason in `diagnostics`. */
function usableSelf(
  value: string,
  retrieval: URL | undefined,
  retrievalTooLong: boolean,
  diagnostics: SpecDiagnostic[],
): URL | undefined {
  const refuse = (problem: string): undefined => {
    diagnostics.push(selfDiagnostic(DIAGNOSTIC_CODES.REFUSED_SELF, problem));
    return undefined;
  };
  if (value.length > MAX_BASE_URI_LENGTH) return refuse(`is longer than ${MAX_BASE_URI_LENGTH} characters`);
  if (retrieval === undefined && !HAS_SCHEME.test(value)) {
    const why = retrievalTooLong
      ? 'the URI the document was retrieved from is too long to be used'
      : 'the document has no retrieval URI to resolve it against (load it with fromURL or fromFile, or pass ' +
        'LoadOptions.documentUri)';
    diagnostics.push(
      selfDiagnostic(DIAGNOSTIC_CODES.UNRESOLVABLE_SELF, `is a relative reference (${describeValue(value)}), but ${why}`),
    );
    return undefined;
  }
  const resolved = parseUri(value, retrieval?.href);
  // `readSelfField` parsed it against an https base; a file base is stricter (no port)
  if (resolved === undefined) return refuse(`cannot be resolved against the retrieval URI`);
  // The value is not quoted: user information may be a real credential
  if (resolved.username !== '' || resolved.password !== '') {
    return refuse('contains user information (a credential before the host)');
  }
  if (!BASE_PROTOCOLS.has(resolved.protocol)) {
    return refuse(
      `uses the ${describeValue(resolved.protocol.slice(0, -1))} scheme; only http, https and file URIs can name a document`,
    );
  }
  if (resolved.protocol === 'file:') {
    if (retrieval !== undefined && retrieval.protocol !== 'file:') {
      return refuse(
        `is a file URI, but the document was retrieved over ${retrieval.protocol.slice(0, -1)}: a document read ` +
          'from the network cannot name itself with a local file',
      );
    }
    if (resolved.host !== '') return refuse('is a file URI that names a host');
  }
  if (resolved.href.length > MAX_BASE_URI_LENGTH) {
    return refuse(`resolves to a URI longer than ${MAX_BASE_URI_LENGTH} characters`);
  }
  return resolved;
}

/**
 * What a fragment holds as a JSON Pointer (RFC 6901 section 6: the fragment
 * is the pointer percent-encoded): the reference tokens, `[]` for the whole
 * document, or `undefined` when it is not a pointer (a plain name, such as an
 * `$anchor`).
 *
 * Percent-decoding is lenient exactly like `$RefParser`'s (a `%` that does
 * not start a valid escape stays as it is), so both dereferencers read a
 * rewritten reference the same way.
 */
export function fragmentPointerTokens(fragment: string): string[] | undefined {
  let pointer: string;
  try {
    pointer = decodeURIComponent(fragment);
  } catch {
    try {
      pointer = decodeURIComponent(fragment.replace(/%(?![\dA-F]{2})/gi, '%25'));
    } catch {
      pointer = fragment;
    }
  }
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) return undefined;
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/** A `$ref` that names its own document, found by `findSelfReferences`. */
export interface SelfReference {
  /** The object holding the `$ref` */
  readonly node: Record<string, unknown>;
  /** The `$ref` as written */
  readonly ref: string;
  /** The URL it resolves to, fragment included */
  readonly resolved: string;
  /** Its fragment as the URL parser normalized it, without `#` (`$RefParser` decodes the same text) */
  readonly fragment: string;
  /** The JSON Pointer the fragment holds, as reference tokens (`[]`: the whole document) */
  readonly tokens: readonly string[];
  /** The tokens of where the `$ref` itself is, from the document root */
  location(): string[];
}

/** What `findSelfReferences` found, and how much URI work it did. */
export interface SelfReferenceScan {
  /** In document order. */
  references: SelfReference[];
  /** URI resolutions performed: one per distinct `$ref` string and base tried (it is memoised). */
  resolutions: number;
}

/** What one distinct `$ref` string amounts to, memoised by `findSelfReferences`. */
type Resolution = { resolved: string; fragment: string; tokens: string[] } | null;

/**
 * The URIs a reference is resolved against to decide whether it names the
 * document: the retrieval base, and `$self` when it differs (the
 * specification resolves against `$self`; this library reads from the
 * retrieval URI, and a reference written either way names the document).
 */
function identityBases(base: DocumentBase): string[] {
  const bases = base.href === undefined ? [] : [base.href];
  if (base.selfUri !== undefined && base.selfUri !== base.href) bases.push(base.selfUri);
  return bases;
}

/**
 * Every `$ref` of `root` that names the document `base` describes, in
 * document order, without changing anything. A reference names the document
 * when, resolved against the retrieval base or against `$self`, it is one of
 * the document's URIs (`uriComparisonKey`), and its fragment is empty or a
 * JSON Pointer (a plain-name fragment, an `$anchor`, is left alone). `""`,
 * the same-document reference of RFC 3986, names the whole document.
 *
 * A Schema Object with its own non-empty `$id` sets the base of its
 * references and its subschemas' (JSON Schema 2020-12 section 8.2), so
 * nothing under it is taken. Walks with its own stack, visiting each object
 * once; each distinct `$ref` string is resolved once.
 */
export function findSelfReferences(root: unknown, base: DocumentBase): SelfReferenceScan {
  const bases = identityBases(base);
  const memo = new Map<string, Resolution>();
  let resolutions = 0;
  const resolve = (ref: string): Resolution => {
    if (memo.has(ref)) return memo.get(ref) as Resolution;
    let found: Resolution = null;
    for (const against of bases) {
      resolutions++;
      const url = parseUri(ref, against);
      if (url === undefined || !isSameDocument(url, base)) continue;
      const fragment = url.hash.slice(1);
      const tokens = fragmentPointerTokens(fragment);
      if (tokens !== undefined) found = { resolved: url.href, fragment, tokens };
      break;
    }
    memo.set(ref, found);
    return found;
  };

  interface Visit {
    node: unknown;
    parent: Visit | null;
    key: string;
  }
  const locationOf = (visit: Visit): string[] => {
    const tokens: string[] = [];
    for (let at: Visit | null = visit; at !== null && at.parent !== null; at = at.parent) tokens.push(at.key);
    return tokens.reverse();
  };
  const references: SelfReference[] = [];
  const seen = new Set<object>();
  const stack: Visit[] = [{ node: root, parent: null, key: '' }];
  while (stack.length > 0) {
    const visit = stack.pop() as Visit;
    const { node } = visit;
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (!Array.isArray(node)) {
      const id = ownProperty(record, '$id');
      if (typeof id === 'string' && id !== '') continue;
      const ref = ownProperty(record, '$ref');
      if (typeof ref === 'string' && !ref.startsWith('#') && bases.length > 0) {
        const found = resolve(ref);
        if (found !== null) references.push({ node: record, ref, ...found, location: () => locationOf(visit) });
      }
    }
    // Pushed in reverse, so they are visited in document order
    const keys = Object.keys(record);
    for (let index = keys.length - 1; index >= 0; index--) {
      stack.push({ node: record[keys[index]], parent: visit, key: keys[index] });
    }
  }
  return { references, resolutions };
}

/**
 * The first `$ref` of `root`, in document order, that is a relative
 * reference to another document (not empty, not starting with `#`, without a
 * scheme), with where it is; `undefined` when there is none. Walks with its
 * own stack.
 */
export function findRelativeReference(root: unknown): { ref: string; location: string[] } | undefined {
  const seen = new Set<object>();
  const stack: Array<{ node: unknown; location: string[] }> = [{ node: root, location: [] }];
  while (stack.length > 0) {
    const { node, location } = stack.pop() as { node: unknown; location: string[] };
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const ref = Array.isArray(node) ? undefined : ownProperty(node, '$ref');
    if (typeof ref === 'string' && ref !== '' && !ref.startsWith('#') && !HAS_SCHEME.test(ref)) {
      return { ref, location };
    }
    const record = node as Record<string, unknown>;
    const keys = Object.keys(record);
    for (let index = keys.length - 1; index >= 0; index--) {
      stack.push({ node: record[keys[index]], location: [...location, keys[index]] });
    }
  }
  return undefined;
}

/**
 * Why the reference tokens `tokens` do not lead to a value of `root` as
 * written (RFC 6901, own properties only), or `undefined` when they do.
 *
 * A pointer that goes through another `$ref` on its way is refused too: one
 * dereferencer would follow that reference and the other would not, so the
 * result would depend on the rest of the document.
 */
export function pointerTargetProblem(root: unknown, tokens: readonly string[]): string | undefined {
  let current: unknown = root;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (index > 0 && typeof ownProperty(current, '$ref') === 'string') {
      return `its pointer goes through another $ref (at ${describeValue(pointerText(tokens.slice(0, index)), 256)}), which is not followed`;
    }
    const next = Array.isArray(current)
      ? /^(0|[1-9][0-9]*)$/.test(token) && Number(token) < current.length
        ? current[Number(token)]
        : undefined
      : ownProperty(current, token);
    if (next === undefined) {
      return `${describeValue(pointerText(tokens), 256)} points to nothing in it`;
    }
    current = next;
  }
  return undefined;
}

/** `#/a/b~1c`: reference tokens as a fragment, for a message. */
function pointerText(tokens: readonly string[]): string {
  return `#${tokens.map((token) => `/${token.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('')}`;
}

/** What a Security Requirement key that is not a component name refers to. */
export type SecuritySchemeTarget =
  /** The scheme `components.securitySchemes[name]` of this document (it may not exist). */
  | { name: string }
  /** Why the key does not name a scheme of this document, for a message. */
  | { problem: string };

/** `/components/securitySchemes/<name>`, the only pointer a scheme of this document has. */
const SECURITY_SCHEME_POINTER = /^\/components\/securitySchemes\/([^/]*)$/;

/**
 * Reads a Security Requirement key that is not a component name as a URI
 * reference to a Security Scheme Object (OpenAPI 3.2, Security Requirement
 * Object). It names a scheme of this document when it resolves, against the
 * retrieval base or `$self`, to this document with the fragment
 * `/components/securitySchemes/<name>` (percent-decoded, then JSON Pointer
 * unescaped). A fragment-only key (`#/components/securitySchemes/x`) is a
 * same-document reference with or without a base URI.
 *
 * Anything else is not resolved: a scheme in another document (nothing is
 * fetched for a scheme), a relative reference when the document has no URI,
 * or another part of this document. `./foo` is a reference to the document
 * `foo` next to this one, never the component `foo`: that is how the
 * specification lets a URI collide with a component name. The messages never
 * quote a resolved URI (it can be a local path).
 */
export function resolveSecuritySchemeUri(key: string, base: DocumentBase | undefined): SecuritySchemeTarget {
  const hash = key.indexOf('#');
  let fragment = hash === -1 ? '' : key.slice(hash + 1);
  if (hash !== 0) {
    const bases = base === undefined ? [] : identityBases(base);
    if (bases.length === 0) {
      return {
        problem:
          'cannot be resolved: the document has no base URI (load it with fromURL or fromFile, or pass ' +
          'LoadOptions.documentUri)',
      };
    }
    const targets = bases.map((against) => parseUri(key, against));
    if (targets[0] === undefined) return { problem: 'is neither a component name nor a URI reference' };
    const own = targets.find((target) => target !== undefined && isSameDocument(target, base as DocumentBase));
    if (own === undefined) return { problem: 'names a scheme in another document, which is not read' };
    fragment = own.hash.slice(1);
  }
  let pointer: string;
  try {
    pointer = decodeURIComponent(fragment);
  } catch {
    return { problem: 'has a fragment that is not valid percent-encoding' };
  }
  const match = SECURITY_SCHEME_POINTER.exec(pointer);
  if (match === null) {
    return {
      problem: `points to ${describeValue(`#${fragment}`, 256)} in this document, which is not under /components/securitySchemes`,
    };
  }
  return { name: match[1].replace(/~1/g, '/').replace(/~0/g, '~') };
}
