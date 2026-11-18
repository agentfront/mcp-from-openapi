import type { McpOpenAPITool, ParameterLocation, ParameterMapper } from './types';
import { RequestBuildError } from './errors';
import { describeValue, isDotSegment, isHttpToken, isRefusedMethod, setOwnProperty, wireMethod } from './spec';
import {
  FORM_URLENCODED,
  JSON_MEDIA_TYPE,
  classifyMediaType,
  isMediaRange,
  mediaTypeEssence,
  mediaTypeList,
} from './media-type';

/**
 * Options for {@link buildHttpRequest}.
 */
export interface BuildHttpRequestOptions {
  /**
   * Base URL for the request. Overrides the tool's `metadata.servers[0].url`.
   * Must be empty (relative request) or an http/https URL.
   */
  baseUrl?: string;
}

/**
 * The composed HTTP request. Pure data — nothing has been sent.
 *
 * The records (`headers`, `query`, `cookies`) are ordinary objects whose keys
 * are all own properties: a parameter named `constructor` or `__proto__` is an
 * own key like any other, never an inherited member.
 */
export interface BuiltHttpRequest {
  /**
   * Fully composed URL: base + expanded path + encoded query string. Always
   * authoritative: send this, rather than re-encoding `query`.
   */
  url: string;

  /**
   * HTTP method as sent: a standard method (`get`, `query`, ...) upper-case
   * (`GET`, `QUERY`), an OpenAPI 3.2 `additionalOperations` method exactly as
   * written in the document (`LINK`), since methods are case-sensitive.
   */
  method: string;

  /**
   * Request headers, including a composed `Cookie` header (when cookie
   * parameters exist) and `content-type` (when the body is not a `FormData`
   * — a `FormData` body must let the HTTP client set the boundary itself; a
   * multipart body the builder writes as a Blob carries its boundary here).
   */
  headers: Record<string, string>;

  /**
   * Query parameters as sent: unencoded values, one array per name.
   *
   * A whole-query parameter (`mapper.wholeQuery`, OpenAPI 3.2
   * `in: querystring`) in `application/x-www-form-urlencoded` contributes its
   * name/value pairs here like any other query parameter. In any other media
   * type the whole query string is one serialized value, not name/value
   * pairs: it is not in this record (which is then empty, as such a tool has
   * no other query parameter) but in `queryString`.
   */
  query: Record<string, string[]>;

  /**
   * The query string exactly as it appears in `url` after the `?`
   * (percent-encoded), present only when it is not made of name/value pairs:
   * a whole-query parameter (OpenAPI 3.2 `in: querystring`) serialized in a
   * media type other than `application/x-www-form-urlencoded`, such as the
   * JSON text of the value. Absent otherwise. An empty serialized value gives
   * `''` and a `url` without `?`.
   */
  queryString?: string;

  /**
   * Cookie parameters, one value per cookie name (also folded into the
   * `Cookie` header). An exploded array with `style: cookie` sends its name
   * once per item: the `Cookie` header carries every pair and this record
   * the first value, so the `Cookie` header is the authoritative form.
   */
  cookies: Record<string, string>;

  /** Selected request body content type (also in headers, except multipart) */
  contentType?: string;

  /**
   * Serialized body ready for fetch: a JSON/form-urlencoded/text string, a
   * `FormData` for multipart, the raw value for binary bodies, or undefined.
   * A multipart body with a part header `FormData` cannot write (a text
   * part's `Content-Type`, a header from an Encoding Object) is a `Blob`
   * written by the builder, whose type and `headers['content-type']` are
   * `multipart/form-data; boundary=...`.
   */
  body?: unknown;

  /** Structured body value before serialization (object/array/primitive) */
  rawBody?: unknown;
}

/** A UTF-16 surrogate without its pair: it has no UTF-8 encoding */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Every string this builder percent-encodes or form-encodes must have a
 * UTF-8 encoding. A lone surrogate has none: `encodeURIComponent` throws a
 * bare `URIError` on it and `URLSearchParams` silently replaces it with
 * U+FFFD, so both encoders check here first and refuse it the same way.
 */
function assertWellFormed(text: string, param: string, location: string): void {
  if (LONE_SURROGATE.test(text)) {
    throw new RequestBuildError(
      `${location} parameter '${param}' contains a lone surrogate (an unpaired UTF-16 code unit), which has no UTF-8 encoding`,
      { param, location },
    );
  }
}

/**
 * The characters `allowReserved` leaves unencoded, the ONE definition for both
 * places it applies: a query parameter's value in the query string and a form
 * field's value in an `application/x-www-form-urlencoded` body or whole query.
 *
 * OpenAPI 3.2.1 Parameter Object `allowReserved`: "reserved expansion, as
 * defined by RFC6570, which allows RFC3986's reserved character set, as well
 * as percent-encoded triples, to pass through unchanged, while still
 * percent-encoding all other disallowed characters (including `%` outside of
 * percent-encoded triples). Applications are still responsible for
 * percent-encoding reserved characters that are not allowed by the rules of
 * the `in` destination or media type". Both destinations are form-urlencoded
 * text ("URL Percent-Encoding": "Content in the
 * `application/x-www-form-urlencoded` format, including query strings
 * produced by Parameter Objects with `in: "query"`, MUST also successfully
 * parse and percent-decode using [WHATWG-URL] rules, including treating
 * non-percent-encoded `+` as an escaped space character"), and Appendix C
 * names what they do not allow: "while `/` and most other reserved
 * characters are allowed in the query string by RFC3986, `[`, `]`, and `#`
 * are not, and `&`, `=`, and `+` all have special behavior in the
 * `application/x-www-form-urlencoded` format, which is what we are using in
 * the query string" ("Setting `allowReserved: true` does _not_ make reserved
 * characters that are not allowed in URIs allowed").
 *
 * So of RFC 3986's reserved set (`:/?#[]@` and `!$&'()*+,;=`) these stay
 * raw: `:` `/` `?` `@` `!` `$` `'` `(` `)` `*` `,` `;`. Always encoded:
 * `&` and `=` (they would end the pair or start a new one, so a value could
 * add a pair named like a credential), `+` (read as a space), `#` (it would
 * end the query and start a fragment), `[` and `]` (not allowed in a query:
 * RFC 3986 `query = *( pchar / "/" / "?" )`). `?` and `/` stay raw because
 * that production allows them in a query ("may represent data within the
 * query component", RFC 3986 3.4) and they mean nothing in a form. A `%`
 * stays raw only where it starts a percent-encoded triple (`%41`); any other
 * `%` is `%25`.
 */
const ALLOW_RESERVED_KEPT = ":/?@!$'()*,;";

/** Each kept character's percent-encoded form (upper-case, as both encoders write it) to the character */
const KEPT_BY_ESCAPE: Record<string, string> = Object.fromEntries(
  [...ALLOW_RESERVED_KEPT].map((char) => [`%${char.charCodeAt(0).toString(16).toUpperCase()}`, char]),
);
const KEPT_ESCAPE = new RegExp(Object.keys(KEPT_BY_ESCAPE).join('|'), 'g');

/**
 * Reserved expansion applied to a fully encoded value (by `encodeURIComponent`
 * for the query string, by the WHATWG form encoder for a form): the
 * {@link ALLOW_RESERVED_KEPT} characters back as they are, and each
 * percent-encoded triple of the original value (encoded as `%25XX`) back to
 * `%XX`. Every other character stays encoded.
 */
function keepReserved(encoded: string): string {
  return encoded.replace(KEPT_ESCAPE, (escape) => KEPT_BY_ESCAPE[escape]).replace(/%25([0-9A-Fa-f]{2})/g, '%$1');
}

/**
 * Percent-encode one URL component (RFC 3986). With `allowReserved` (a query
 * value only), reserved expansion as {@link ALLOW_RESERVED_KEPT} defines it.
 */
function percentEncode(value: string, param: string, location: string, allowReserved?: boolean): string {
  assertWellFormed(value, param, location);
  const encoded = encodeURIComponent(value);
  return allowReserved ? keepReserved(encoded) : encoded;
}

/**
 * A name/value pair of a form. The third element is `allowReserved`, for a
 * value whose Encoding Object sets it (see {@link formReservedValue}).
 */
type FormPair = readonly [name: string, value: string, allowReserved?: boolean];

/** One name or value form-encoded exactly as `URLSearchParams` writes it (WHATWG, space as `+`) */
function formComponent(text: string): string {
  return new URLSearchParams([['', text]]).toString().slice(1);
}

/**
 * A form value with `allowReserved: true` (OpenAPI Encoding Object: "reserved
 * expansion ... Applications are still responsible for percent-encoding
 * reserved characters that are not allowed in the target media type"): the
 * WHATWG form encoding (space as `+`) with the characters
 * {@link ALLOW_RESERVED_KEPT} defines, the same as a query value's, so a
 * value can never add a field; it may hold `&` pre-encoded (`%26`), which
 * passes unchanged.
 */
function formReservedValue(value: string): string {
  return keepReserved(formComponent(value));
}

/**
 * Form-encode name/value pairs (WHATWG `application/x-www-form-urlencoded`:
 * space as `+`), a pair marked `allowReserved` with
 * {@link formReservedValue}.
 */
function formEncode(pairs: ReadonlyArray<FormPair>, location: string): string {
  let reservedKept = false;
  for (const [name, value, allowReserved] of pairs) {
    assertWellFormed(name, name, location);
    assertWellFormed(value, name, location);
    if (allowReserved === true) reservedKept = true;
  }
  if (reservedKept) {
    return pairs
      .map(([name, value, allowReserved]) =>
        `${formComponent(name)}=${allowReserved === true ? formReservedValue(value) : formComponent(value)}`,
      )
      .join('&');
  }
  const params = new URLSearchParams();
  for (const [name, value] of pairs) params.append(name, value);
  return params.toString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * More context for an error about a value: the input key of the mapper entry
 * the value came from, when it is not the parameter named in the message (a
 * field of a form body or of a form whole query).
 */
type ErrorContext = { inputKey?: string };

function primitiveString(value: unknown, paramName: string, location: string, context: ErrorContext = {}): string {
  if (value === null || value === undefined || typeof value === 'object') {
    throw new RequestBuildError(
      `${location} parameter '${paramName}' must serialize to a primitive; received ${
        value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value
      }`,
      { param: paramName, location, ...context },
    );
  }
  return String(value);
}

/**
 * A record that is safe for any key: no prototype, so `constructor`,
 * `toString` and `__proto__` are ordinary own keys (assigning `__proto__`
 * creates a property instead of changing a prototype).
 */
function createRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Copy a {@link createRecord} record into an ordinary object (the shape
 * consumers have always received), every key defined as an own data
 * property, so `__proto__` stays a key. Key order is the source's.
 */
function toPlainRecord<T>(source: Record<string, T>): Record<string, T> {
  const plain: Record<string, T> = {};
  for (const key of Object.keys(source)) {
    setOwnProperty(plain, key, source[key]);
  }
  return plain;
}

/**
 * The input value for `key`, read as an own property: an inherited member
 * (`toString`, `constructor`) is never a parameter value.
 */
function readInput(input: object | undefined, key: string): unknown {
  return input !== undefined && Object.hasOwn(input, key) ? (input as Record<string, unknown>)[key] : undefined;
}

/** The credential entries of each alternative of a choice of Security Requirements (`security.alternatives`). Internal. */
export function entriesByAlternative(entries: readonly ParameterMapper[]): Map<number, ParameterMapper[]> {
  const alternatives = new Map<number, ParameterMapper[]>();
  for (const entry of entries) {
    for (const index of entry.security?.alternatives ?? []) {
      const members = alternatives.get(index);
      if (members) members.push(entry);
      else alternatives.set(index, [entry]);
    }
  }
  return alternatives;
}

/** The `mutualTLS` schemes of a choice (`security.clientCertificates`), with the alternatives that need each. Internal. */
export function clientCertificatesOf(entries: readonly ParameterMapper[]): Array<{ scheme: string; alternatives: number[] }> {
  return entries.flatMap((entry) => entry.security?.clientCertificates ?? []);
}

/**
 * The credential entries the input gives that are not needed by the first alternative it gives completely: one
 * alternative of a choice is sent. None when the input gives no alternative completely. Whether there is a client
 * certificate is not known here, so an alternative that needs one is never chosen nor ruled out: its entries stay.
 */
function unchosenCredentials(mapper: readonly ParameterMapper[], input: object | undefined): Set<ParameterMapper> {
  const given = (entry: ParameterMapper): boolean => {
    const value = readInput(input, entry.inputKey);
    return value !== undefined && value !== null;
  };
  const alternatives = entriesByAlternative(mapper);
  const needCertificate = new Set(clientCertificatesOf(mapper).flatMap((certificate) => certificate.alternatives));
  const chosen = [...alternatives.keys()]
    .filter((index) => !needCertificate.has(index))
    .sort((a, b) => a - b)
    .map((index) => alternatives.get(index)!)
    .find((entries) => entries.every(given));
  if (chosen === undefined) return new Set();
  const certificateMembers = new Set([...needCertificate].flatMap((index) => alternatives.get(index) ?? []));
  return new Set(
    mapper.filter(
      (entry) => entry.security?.alternatives !== undefined && !chosen.includes(entry) && !certificateMembers.has(entry),
    ),
  );
}

/**
 * Serialize a PATH parameter per its style/explode (OpenAPI serialization
 * table). Returns the UNENCODED replacement string; percent-encoding is
 * applied per primitive component here.
 */
function serializePathValue(mapper: ParameterMapper, value: unknown): string {
  const style = mapper.style ?? 'simple';
  const explode = mapper.explode ?? false;
  const name = mapper.key;
  const enc = (v: unknown) => percentEncode(primitiveString(v, name, 'path'), name, 'path');
  const encKey = (k: string) => percentEncode(k, name, 'path');

  if (Array.isArray(value)) {
    if (style === 'label') {
      return `.${value.map(enc).join(explode ? '.' : ',')}`;
    }
    if (style === 'matrix') {
      return explode
        ? value.map((v) => `;${name}=${enc(v)}`).join('')
        : `;${name}=${value.map(enc).join(',')}`;
    }
    return value.map(enc).join(',');
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (style === 'label') {
      return explode
        ? entries.map(([k, v]) => `.${encKey(k)}=${enc(v)}`).join('')
        : `.${entries.map(([k, v]) => `${encKey(k)},${enc(v)}`).join(',')}`;
    }
    if (style === 'matrix') {
      return explode
        ? entries.map(([k, v]) => `;${encKey(k)}=${enc(v)}`).join('')
        : `;${name}=${entries.map(([k, v]) => `${encKey(k)},${enc(v)}`).join(',')}`;
    }
    // simple
    return explode
      ? entries.map(([k, v]) => `${encKey(k)}=${enc(v)}`).join(',')
      : entries.map(([k, v]) => `${encKey(k)},${enc(v)}`).join(',');
  }

  const core = enc(value);
  if (style === 'label') return `.${core}`;
  if (style === 'matrix') return `;${name}=${core}`;
  return core;
}

/**
 * Serialize a value per a style/explode into `[name, value]` pairs: a QUERY
 * parameter, and a field of an `application/x-www-form-urlencoded` or
 * `multipart/form-data` object whose Encoding Object gives `style`, `explode`
 * or `allowReserved` (OpenAPI "Encoding Object": "The behavior follows the
 * same values as `query` parameters, including default values"), so a form
 * field is serialized exactly like a query parameter with the same
 * style/explode. Values are raw (unencoded); the caller encodes them for the
 * query string, the form body, or not at all (multipart parts). Names may
 * gain deepObject brackets.
 *
 * Where the OpenAPI style table gives a value, this is it. Its _n/a_ cells
 * are undefined by the specification; what this writes for them predates
 * form-field support and is kept for query parameters, byte for byte:
 *
 * - an array with `deepObject` is written as `form` (exploded unless
 *   `explode: false`);
 * - `deepObject` nests brackets for an object property
 *   (`filter[author][name]=x`, implementation-defined beyond one level per
 *   OpenAPI Appendix C) and repeats the name for each item of an array
 *   property (`filter[tags]=a&filter[tags]=b`);
 * - an array of objects has no `deepObject` form (servers disagree:
 *   `items[0][key]=v`, `items[][key]=v`), so it is a RequestBuildError.
 *
 * A `deepObject` object is checked like a JSON value first (no cycle, at
 * most 1,000 levels, bounded size), so the walk is bounded.
 *
 * `claimName` sees every pair name the INPUT chooses: the property names of
 * an exploded object, which replace the parameter's own name on the wire,
 * and every `deepObject` name (`filter[a]`, `filter[a][b]`), which another
 * entry may be named literally. Names are compared unencoded: the query
 * string writes a name with every character percent-encoded but `[` and `]`
 * (kept for every name alike), so two names that differ unencoded differ on
 * the wire, and `filter[a]` is the same name as an entry literally named
 * `filter[a]` (both are sent as `filter[a]`, and `filter%5Ba%5D` decodes to
 * it too).
 */
function serializeQueryPairs(
  mapper: Pick<ParameterMapper, 'key' | 'style' | 'explode'>,
  value: unknown,
  claimName: (name: string) => void,
  location = 'query',
  context: ErrorContext = {},
): Array<[string, string]> {
  const style = mapper.style ?? 'form';
  // OpenAPI explode default: true for `form`, false for every other style
  const explode = mapper.explode ?? style === 'form';
  const name = mapper.key;
  const str = (v: unknown) => primitiveString(v, name, location, context);
  // An array item: a primitive; with deepObject an object gets its own error
  const item = (v: unknown) => {
    if (style === 'deepObject' && isPlainObject(v)) {
      throw new RequestBuildError(
        `${location} parameter '${name}' has style deepObject, which has no form for an array of objects: OpenAPI defines deepObject for an object with primitive properties, and servers write the items of an array differently (${name}[0][key]=value, ${name}[][key]=value)`,
        { param: name, location, style: 'deepObject', ...context },
      );
    }
    return str(v);
  };

  if (Array.isArray(value)) {
    // deepObject applies to objects; arrays fall back to form semantics
    if ((style === 'deepObject' ? mapper.explode ?? true : explode) || value.length === 0) {
      return value.map((v) => [name, item(v)] as [string, string]);
    }
    const delimiter = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
    return [[name, value.map(item).join(delimiter)]];
  }

  if (isPlainObject(value)) {
    if (style === 'deepObject') {
      // A cyclic, too deep or too large object never reaches the walk below
      assertJsonTree(value, name, location, context, 'with style deepObject');
      // Recursive bracket notation: filter[author][name]=x (one level per the
      // spec; nesting is a widely-implemented extension)
      const pairs: Array<[string, string]> = [];
      const walk = (prefix: string, node: Record<string, unknown>): void => {
        for (const [k, v] of Object.entries(node)) {
          if (v === undefined) continue;
          if (isPlainObject(v)) {
            walk(`${prefix}[${k}]`, v);
          } else if (Array.isArray(v)) {
            for (const element of v) {
              claimName(`${prefix}[${k}]`);
              pairs.push([`${prefix}[${k}]`, item(element)]);
            }
          } else {
            claimName(`${prefix}[${k}]`);
            pairs.push([`${prefix}[${k}]`, str(v)]);
          }
        }
      };
      walk(name, value);
      return pairs;
    }
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (explode) {
      // form + explode: the parameter name disappears, each field is a pair
      return entries.map(([k, v]) => {
        claimName(k);
        return [k, str(v)] as [string, string];
      });
    }
    return [[name, entries.map(([k, v]) => `${k},${str(v)}`).join(',')]];
  }

  return [[name, str(value)]];
}

/** Serialize a HEADER parameter (style `simple`). */
function serializeHeaderValue(mapper: ParameterMapper, value: unknown): string {
  const explode = mapper.explode ?? false;
  const name = mapper.key;
  const str = (v: unknown) => primitiveString(v, name, 'header');

  if (Array.isArray(value)) {
    return value.map(str).join(',');
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    return explode
      ? entries.map(([k, v]) => `${k}=${str(v)}`).join(',')
      : entries.map(([k, v]) => `${k},${str(v)}`).join(',');
  }
  return str(value);
}

/**
 * Serialize a cookie parameter with OpenAPI 3.2 `style: cookie` ("Style
 * Values", "Style Examples"): name/value pairs joined by `; ` in the Cookie
 * header, values sent as given with no percent-encoding or other escaping.
 * Returns each cookie name with its values: a primitive is `[name, [v]]`; an
 * exploded array repeats the name (`color=blue; color=black`); an exploded
 * object makes each property its own cookie (`R=100; G=200`). An array or
 * object with `explode: false` is _n/a_ in the table (OpenAPI 3.2.1: the
 * Cookie header forbids the unencoded commas it would need), so it throws.
 * `claimName` sees each cookie name the INPUT chooses (an exploded object's
 * property names).
 */
function serializeCookieStyle(
  mapper: ParameterMapper,
  value: unknown,
  claimName: (name: string) => void,
): Array<[string, string[]]> {
  const name = mapper.key;
  const str = (v: unknown) => primitiveString(v, name, 'cookie');
  if (!Array.isArray(value) && !isPlainObject(value)) {
    return [[name, [str(value)]]];
  }
  if (mapper.explode === false) {
    throw new RequestBuildError(
      `Cookie parameter '${name}' has style 'cookie' with explode false, which cannot serialize ${
        Array.isArray(value) ? 'an array' : 'an object'
      } (n/a in the OpenAPI style table: it would need commas, which the Cookie header forbids)`,
      { param: name, location: 'cookie', style: 'cookie' },
    );
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const item of value) values.push(str(item));
    return values.length > 0 ? [[name, values]] : [];
  }
  const groups: Array<[string, string[]]> = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    claimName(k);
    groups.push([k, [str(v)]]);
  }
  return groups;
}

export function assertHeaderSafe(name: string, value: string, context: Record<string, unknown> = {}): void {
  // Header NAMES come from the spec (mapper.key) — untrusted under
  // secureDefaults, so they get the RFC 7230 token check too.
  if (!/^[\w!#$%&'*+\-.^`|~]+$/.test(name)) {
    throw new RequestBuildError(`Invalid header name '${name}' (RFC 7230 token required)`, { header: name, ...context });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00]/.test(value)) {
    throw new RequestBuildError(`Header '${name}' value contains control characters (possible header injection)`, {
      header: name,
      ...context,
    });
  }
  // RFC 9110 field-value: tab, space, visible ASCII and obs-text (0x80-0xFF).
  // Anything else (another control, DEL, a character above U+00FF) is
  // refused by HTTP clients when the request is sent; refuse it here, where
  // the parameter is known.
  // eslint-disable-next-line no-control-regex
  const invalid = /[^\t\x20-\x7e\x80-\xff]/.exec(value);
  if (invalid) {
    const codePoint = invalid[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    throw new RequestBuildError(
      `Header '${name}' value contains U+${codePoint} at index ${invalid.index}, which a header value cannot hold (only tab, space, visible ASCII and U+0080 to U+00FF)`,
      { header: name, ...context },
    );
  }
}

export function assertCookieName(name: string): void {
  if (!/^[\w!#$%&'*+\-.^`|~]+$/.test(name)) {
    throw new RequestBuildError(`Invalid cookie name '${name}' (RFC 6265 token required)`, { cookie: name });
  }
}

/**
 * Values are sent VERBATIM (no percent-encoding — '=' etc. are legal
 * cookie-octets and servers compare raw values), so characters that break the
 * Cookie header structure must fail loudly.
 *
 * - `strict` (`style: cookie` and `content` cookies, new in this form): only
 *   RFC 6265 cookie-octets, `%x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E`.
 * - Otherwise (cookie parameters without `style: cookie`, as they have always
 *   been checked): no CTL, whitespace, DQUOTE, semicolon or backslash, and no
 *   character above U+00FF, which no header can carry. Comma and the bytes
 *   0x80-0xFF are tolerated, because arrays have always been comma-joined.
 */
export function assertCookieValue(name: string, value: string, strict = false): void {
  if (
    strict
      ? !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(value)
      : // eslint-disable-next-line no-control-regex
        /[\x00-\x1f\x7f\s";\\]|[^\x00-\xff]/.test(value)
  ) {
    throw new RequestBuildError(
      `Cookie '${name}' value contains characters that break the Cookie header (RFC 6265 cookie-octet violation)`,
      { cookie: name },
    );
  }
}

/**
 * Format a security value per its scheme (mirrors SecurityResolver output).
 * Only `bearer`/`basic` get an automatic prefix — structured schemes like
 * digest (RFC 7616 username/realm/nonce/... fields) cannot be synthesized from
 * a raw credential, so their values pass through verbatim: provide the full
 * header value, or resolve credentials with SecurityResolver instead.
 *
 * NOTE: `basic` values are prefixed only, never encoded — supply the base64
 * `user:pass` token (as SecurityResolver produces), not raw credentials.
 */
function formatSecurityValue(mapper: ParameterMapper, value: string): string {
  const security = mapper.security!;
  if (security.type === 'http') {
    const scheme = (security.httpScheme ?? 'bearer').toLowerCase();
    if (scheme !== 'bearer' && scheme !== 'basic') {
      return value;
    }
    const prefix = scheme.charAt(0).toUpperCase() + scheme.slice(1);
    return value.toLowerCase().startsWith(`${scheme} `) ? value : `${prefix} ${value}`;
  }
  if (security.type === 'oauth2' || security.type === 'openIdConnect') {
    return value.toLowerCase().startsWith('bearer ') ? value : `Bearer ${value}`;
  }
  return value; // apiKey and friends: raw
}

/**
 * Resolve the tool's first server URL, substituting `{variable}` templates
 * with their spec-declared defaults. Variables without defaults are left in
 * place and caught by the unresolved-template guard in buildHttpRequest.
 */
function resolveServerUrl(tool: McpOpenAPITool): string {
  const server = tool.metadata.servers?.[0];
  if (!server) return '';
  if (typeof server.url !== 'string') {
    throw new RequestBuildError(`Server URL must be a string; received ${describeValue(server.url)}`, {
      baseUrl: server.url,
    });
  }
  let url = server.url;
  if (server.variables) {
    for (const [name, variable] of Object.entries(server.variables)) {
      if (variable && typeof variable.default === 'string') {
        url = url.replaceAll(`{${name}}`, variable.default);
      }
    }
  }
  return url;
}

/**
 * Deepest nesting {@link jsonText} serializes: the limit `copyJsonValue`
 * applies to spec values. Far beyond any real parameter, and far below the
 * depth at which `JSON.stringify` exhausts the stack.
 */
const MAX_JSON_DEPTH = 1000;

/**
 * Longest JSON text {@link jsonText} produces: V8's maximum string length
 * (`buffer.constants.MAX_STRING_LENGTH` in Node). A longer text cannot exist,
 * and V8's `JSON.stringify` only reports that after walking the whole value,
 * which for an object shared at many places (2^40 paths through 40 arrays)
 * never ends — so {@link assertJsonTree} refuses such a value first.
 */
const MAX_JSON_TEXT_LENGTH = 2 ** 29 - 24;

/**
 * Reject a value `JSON.stringify` would recurse too deep into or never finish,
 * before calling it: a cycle (an object that contains itself), nesting deeper
 * than {@link MAX_JSON_DEPTH}, or a text longer than
 * {@link MAX_JSON_TEXT_LENGTH} (judged by a lower bound of its length).
 *
 * Walked with an explicit stack, so the check itself never overflows. An
 * object reached again through another reference (shared, not cyclic) is not
 * walked again: its height and length bound are remembered, so the walk is
 * linear in the distinct objects and their slots.
 */
function assertJsonTree(
  root: unknown,
  param: string,
  location: string,
  context: ErrorContext = {},
  serialization = 'as JSON',
): void {
  if (root === null || typeof root !== 'object') return;
  const fail = (reason: string): never => {
    throw new RequestBuildError(`${location} parameter '${param}' cannot be serialized ${serialization}: ${reason}`, {
      param,
      location,
      ...context,
    });
  };
  const tooDeep = `it nests deeper than ${MAX_JSON_DEPTH} levels`;
  const tooLong = `its JSON text would be longer than ${MAX_JSON_TEXT_LENGTH} characters`;
  const done = new Map<object, { height: number; length: number }>();
  const onPath = new Set<object>();
  // `length` is a lower bound of the node's JSON text: brackets, commas,
  // quoted keys and strings, and at least one character per other value
  const stack: Array<{
    node: object;
    keys: string[] | undefined;
    slots: number;
    next: number;
    members: number;
    height: number;
    length: number;
  }> = [];
  const enter = (node: object): void => {
    if (stack.length >= MAX_JSON_DEPTH) fail(tooDeep);
    onPath.add(node);
    const keys = Array.isArray(node) ? undefined : Object.keys(node);
    const slots = keys === undefined ? (node as unknown[]).length : keys.length;
    stack.push({ node, keys, slots, next: 0, members: 0, height: 1, length: 2 });
  };
  enter(root);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.next < frame.slots) {
      const index = frame.next++;
      const key = frame.keys?.[index];
      const child: unknown = (frame.node as Record<string, unknown>)[key ?? index];
      if (key !== undefined) {
        // an object member JSON.stringify leaves out
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        frame.length += key.length + 3;
      }
      if (frame.members++ > 0) frame.length += 1;
      if (child === null || typeof child !== 'object') {
        frame.length += typeof child === 'string' ? child.length + 2 : 1;
      } else {
        if (onPath.has(child)) fail('it contains itself (a cycle)');
        const known = done.get(child);
        if (known === undefined) {
          enter(child);
          continue;
        }
        if (stack.length + known.height > MAX_JSON_DEPTH) fail(tooDeep);
        frame.height = Math.max(frame.height, known.height + 1);
        frame.length += known.length;
      }
      if (frame.length > MAX_JSON_TEXT_LENGTH) fail(tooLong);
      continue;
    }
    stack.pop();
    onPath.delete(frame.node);
    done.set(frame.node, { height: frame.height, length: frame.length });
    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      parent.height = Math.max(parent.height, frame.height + 1);
      parent.length += frame.length;
      if (parent.length > MAX_JSON_TEXT_LENGTH) fail(tooLong);
    }
  }
}

/**
 * The JSON text of a parameter value (minimal whitespace, as `JSON.stringify`
 * writes it). A cyclic or too deeply nested value, and anything
 * `JSON.stringify` refuses (a BigInt, a throwing `toJSON`) or cannot represent
 * (a function), is a {@link RequestBuildError}.
 */
function jsonText(value: unknown, param: string, location: string, context: ErrorContext = {}): string {
  let text: string | undefined;
  try {
    // The check reads the value too (a getter, a proxy), so it fails inside
    // the same boundary as JSON.stringify
    assertJsonTree(value, param, location, context);
    text = JSON.stringify(value);
  } catch (error) {
    if (error instanceof RequestBuildError) throw error;
    const reason = error instanceof Error ? error.message.split('\n', 1)[0] : describeValue(error);
    throw new RequestBuildError(`${location} parameter '${param}' cannot be serialized as JSON: ${reason}`, {
      param,
      location,
      ...context,
    });
  }
  if (text === undefined) {
    throw new RequestBuildError(
      `${location} parameter '${param}' has no JSON representation; received ${describeValue(value)}`,
      { param, location, ...context },
    );
  }
  return text;
}

/**
 * The fields of an Encoding Object (OpenAPI 3.x) the builder applies to one
 * field of a form, read and checked.
 */
interface FieldEncoding {
  /**
   * At least one of `style`, `explode` and `allowReserved` is given: the
   * field is serialized RFC 6570-style, like a query parameter with the same
   * style/explode, and `contentType` is ignored (OpenAPI 3.2.1 "If a value is
   * explicitly defined, then the value of `contentType` (implicit or
   * explicit) SHALL be ignored"; 3.0.4 RECOMMENDS the same). Otherwise the
   * field is serialized by its content type, explicit or the default.
   */
  styled: boolean;
  style?: string;
  explode?: boolean;
  allowReserved: boolean;
  /** The media types of an explicit `contentType`, in order (at least one) */
  contentTypes?: string[];
  /** `headers` as written (read only for `multipart/form-data`) */
  headers?: unknown;
}

/** An own property of an object, never an inherited one */
function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * The Encoding Object `owner` carries for the form field `field`
 * (`serialization.encoding[field]`, own properties only), or undefined when
 * it has none. A flattened body entry carries its own field's, a whole body,
 * a whole query or a `content` parameter the media type's whole map. A map or
 * an Encoding Object of the wrong shape is a RequestBuildError: guessing
 * could send another form than the document describes.
 */
function fieldEncoding(owner: ParameterMapper, field: string): FieldEncoding | undefined {
  const fail = (problem: string): never => {
    throw new RequestBuildError(
      `${owner.type} parameter '${owner.key}' (input key '${owner.inputKey}') has an invalid Encoding Object for '${field}' in serialization.encoding: ${problem}`,
      { param: owner.key, inputKey: owner.inputKey, location: owner.type, field },
    );
  };
  const map: unknown = owner.serialization?.encoding;
  if (map === undefined) return undefined;
  if (!isPlainObject(map)) return fail(`the encoding map must be an object; received ${describeValue(map)}`);
  const encoding = ownValue(map, field);
  if (encoding === undefined) return undefined;
  if (!isPlainObject(encoding)) return fail(`it must be an object; received ${describeValue(encoding)}`);

  const style = ownValue(encoding, 'style');
  const explode = ownValue(encoding, 'explode');
  const allowReserved = ownValue(encoding, 'allowReserved');
  const contentType = ownValue(encoding, 'contentType');
  if (style !== undefined && typeof style !== 'string') fail(`style must be a string; received ${describeValue(style)}`);
  if (explode !== undefined && typeof explode !== 'boolean') {
    fail(`explode must be a boolean; received ${describeValue(explode)}`);
  }
  if (allowReserved !== undefined && typeof allowReserved !== 'boolean') {
    fail(`allowReserved must be a boolean; received ${describeValue(allowReserved)}`);
  }
  let contentTypes: string[] | undefined;
  if (contentType !== undefined) {
    contentTypes = typeof contentType === 'string' ? mediaTypeList(contentType) : [];
    if (contentTypes.length === 0 || mediaTypeEssence(contentTypes[0]) === '') {
      fail(`contentType must name a media type; received ${describeValue(contentType)}`);
    }
  }
  return {
    styled: style !== undefined || explode !== undefined || allowReserved !== undefined,
    style: style as string | undefined,
    explode: explode as boolean | undefined,
    allowReserved: allowReserved === true,
    contentTypes,
    headers: ownValue(encoding, 'headers'),
  };
}

/**
 * What a form serializer needs besides the value: where each field's
 * Encoding Object and mapper entry are, and who checks the names that go on
 * the wire.
 */
interface FormContext {
  /** The mapper entry a field comes from (Encoding Object, error context) */
  ownerFor: (field: string) => ParameterMapper;
  /** Sees every pair name, with the field whose value put it on the wire */
  claim?: (field: string, name: string) => void;
}

/**
 * The text of one value serialized by content type (OpenAPI 3.2.1 "the
 * absence of all three of those fields is the equivalent of using `content`,
 * but with the media type specified in `contentType`"): the first media type
 * of an explicit `contentType`, read as a `content` parameter's is (JSON
 * text, a form string, or a primitive as it is); without one, the default
 * for the value's type: JSON text for an object or an array
 * (`application/json`), the string form of a primitive (`text/plain`).
 */
function contentText(value: unknown, encoding: FieldEncoding, field: string, location: string, context: ErrorContext): string {
  if (encoding.contentTypes !== undefined) {
    // A form nested in a field is written without Encoding Objects or name checks
    return serializeContent(field, value, encoding.contentTypes[0], location, undefined, context);
  }
  return value !== null && typeof value === 'object'
    ? jsonText(value, field, location, context)
    : primitiveString(value, field, location, context);
}

/**
 * The name/value pairs of an `application/x-www-form-urlencoded` object: the
 * one serializer behind form bodies, form whole-query parameters and form
 * `content` parameters, so all behave identically. An undefined or null
 * property is left out, as for an absent parameter (a form has no way to
 * write null).
 *
 * A field without an Encoding Object is written as it always has been, by
 * the Encoding Object defaults (OpenAPI "Encoding Object" default
 * `contentType` table, "Encoding By Name"): an array gives one pair per item,
 * each item a primitive; an object is its JSON text (`application/json`);
 * any other value its string form (`text/plain`).
 *
 * A field with an Encoding Object follows it:
 *
 * - `style`, `explode` or `allowReserved` given: the pairs a query parameter
 *   with that style/explode gets (`form`, `spaceDelimited`, `pipeDelimited`,
 *   `deepObject`; see {@link serializeQueryPairs}), each value kept with
 *   `allowReserved` when set;
 * - otherwise by content type ({@link contentText}), an array one pair per
 *   item ("Encoding By Name": "applying the given Encoding Object to produce
 *   one encoded value per array item, each with the same `name`").
 *
 * `context.claim` sees every pair name with its field: a name the input
 * chooses (an exploded object's properties, deepObject brackets) is checked
 * there.
 */
function formPairs(value: Record<string, unknown>, location: string, context?: FormContext): FormPair[] {
  const pairs: FormPair[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    const owner = context?.ownerFor(k);
    const encoding = owner === undefined ? undefined : fieldEncoding(owner, k);
    const fieldPairs: FormPair[] = [];
    if (encoding === undefined) {
      if (Array.isArray(v)) {
        for (const item of v) fieldPairs.push([k, primitiveString(item, k, location)]);
      } else {
        fieldPairs.push([k, isPlainObject(v) ? jsonText(v, k, location) : String(v)]);
      }
    } else {
      const errorContext: ErrorContext = { inputKey: owner!.inputKey };
      if (encoding.styled) {
        const styled = { key: k, style: encoding.style, explode: encoding.explode };
        for (const [name, text] of serializeQueryPairs(styled, v, () => undefined, location, errorContext)) {
          fieldPairs.push([name, text, encoding.allowReserved]);
        }
      } else {
        for (const item of Array.isArray(v) ? v : [v]) {
          fieldPairs.push([k, contentText(item, encoding, k, location, errorContext)]);
        }
      }
    }
    for (const pair of fieldPairs) {
      context?.claim?.(k, pair[0]);
      pairs.push(pair);
    }
  }
  return pairs;
}

/**
 * Serialize a value in the media type of a parameter defined with `content`
 * (OpenAPI "Fixed Fields for use with `content`"), before the location's own
 * escaping, by the media type's class (`classifyMediaType`, which gives the
 * input schema of a `content` parameter that declares none): JSON text for
 * `application/json` and `application/*+json`, a form string for
 * `application/x-www-form-urlencoded` (the value must be an object; with
 * `form`, its fields follow the parameter's Encoding Objects), and for any
 * other media type, `text/json` included, the value itself, which must be a
 * string or another primitive. The same reading serializes a form field
 * whose Encoding Object gives a `contentType`.
 *
 * In a header, JSON text is written in ASCII: every character from U+007F up
 * is a `\uXXXX` escape (always inside a JSON string, where the escape means
 * the same character), so the value is always a sendable header value.
 */
function serializeContent(
  param: string,
  value: unknown,
  contentType: string,
  location: string,
  form?: FormContext,
  context: ErrorContext = {},
): string {
  const mediaClass = classifyMediaType(contentType);
  if (mediaClass === 'json') {
    const text = jsonText(value, param, location, context);
    return location === 'header'
      ? text.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      : text;
  }
  if (mediaClass === 'form') {
    if (!isPlainObject(value)) {
      throw new RequestBuildError(
        `${location} parameter '${param}' is sent as ${FORM_URLENCODED}, which needs an object; received ${describeValue(value)}`,
        { param, location, contentType, ...context },
      );
    }
    return formEncode(formPairs(value, location, form), location);
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new RequestBuildError(
    `${location} parameter '${param}' is sent as ${contentType}, which needs a string or another primitive; received ${describeValue(value)}`,
    { param, location, contentType, ...context },
  );
}

/** The form context of a parameter whose value is one form: every field is its own */
function parameterForm(mapper: ParameterMapper, claim?: (name: string) => void): FormContext {
  return { ownerFor: () => mapper, ...(claim !== undefined && { claim: (_field: string, name: string) => claim(name) }) };
}

/** One part of a `multipart/form-data` body */
interface MultipartPart {
  /** The `name` of its `Content-Disposition` */
  name: string;
  /** Text, or a file part's bytes (its `Content-Type` is the Blob's type) */
  value: string | Blob;
  /** The `Content-Type` of a text part, when one is written */
  contentType?: string;
  /** More part headers, in order */
  headers: Array<[string, string]>;
}

/** A value sent as a file part: a Blob (a File included) or bytes */
function isBinary(value: unknown): value is Blob | Uint8Array {
  return (typeof Blob !== 'undefined' && value instanceof Blob) || value instanceof Uint8Array;
}

/**
 * The bytes of a file part. Bytes become a Blob, as they always have; a value
 * that has no type of its own takes `contentType` (one media type the
 * Encoding Object names), a File keeping its name.
 */
function fileBlob(value: Blob | Uint8Array, contentType: string | undefined): Blob {
  if (value instanceof Uint8Array) {
    return new Blob([new Uint8Array(value)], contentType === undefined ? undefined : { type: contentType });
  }
  if (contentType === undefined || value.type !== '') return value;
  return typeof File !== 'undefined' && value instanceof File
    ? new File([value], value.name, { type: contentType, lastModified: value.lastModified })
    : new Blob([value], { type: contentType });
}

/**
 * The `Content-Type` an Encoding Object's `contentType` gives a part: its
 * first media type, unless that is a range (`image/*`), which names no one
 * type. It comes from the document, so it must be a sendable header value.
 */
function partContentType(encoding: FieldEncoding, owner: ParameterMapper, field: string): string | undefined {
  const first = encoding.contentTypes?.[0];
  if (first === undefined || isMediaRange(first)) return undefined;
  assertHeaderSafe('Content-Type', first, { param: owner.key, inputKey: owner.inputKey, location: 'body', field });
  return first;
}

/**
 * The value an Encoding Object's Header Object pins: its `schema` allows one
 * value (`const`, or an `enum` of one member) that is a string, number or
 * boolean. A Header Object describes a header without giving its value, and
 * the input has no place for part headers, so a header is sent only when the
 * document leaves one value possible.
 */
function pinnedHeaderValue(header: unknown): string | undefined {
  if (!isPlainObject(header)) return undefined;
  const schema = ownValue(header, 'schema');
  if (!isPlainObject(schema)) return undefined;
  const values = Object.hasOwn(schema, 'const') ? [schema['const']] : ownValue(schema, 'enum');
  if (!Array.isArray(values) || values.length !== 1) return undefined;
  const [value] = values;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/**
 * The headers an Encoding Object adds to each part of its field (`headers`;
 * OpenAPI: "`Content-Type` is described separately and SHALL be ignored in
 * this section"). `Content-Disposition` is the builder's own, so it is
 * ignored too. Each header whose value the document pins
 * ({@link pinnedHeaderValue}) is sent, checked like any header (RFC 7230
 * name, sendable value, no CR or LF); the others are left out.
 *
 * RFC 7578 (4.8) allows no part header in `multipart/form-data` besides
 * `Content-Type`, `Content-Disposition` and `Content-Transfer-Encoding`, and
 * tells receivers to ignore others; a header the document pins is sent all
 * the same, because the document's server asks for it.
 */
function partHeaders(encoding: FieldEncoding, owner: ParameterMapper, field: string): Array<[string, string]> {
  const context = { param: owner.key, inputKey: owner.inputKey, location: 'body', field };
  if (encoding.headers === undefined) return [];
  if (!isPlainObject(encoding.headers)) {
    throw new RequestBuildError(
      `body parameter '${owner.key}' (input key '${owner.inputKey}') has an invalid Encoding Object for '${field}' in serialization.encoding: headers must be an object; received ${describeValue(encoding.headers)}`,
      context,
    );
  }
  const headers: Array<[string, string]> = [];
  for (const [name, header] of Object.entries(encoding.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'content-type' || lower === 'content-disposition') continue;
    const value = pinnedHeaderValue(header);
    if (value === undefined) continue;
    assertHeaderSafe(name, value, context);
    headers.push([name, value]);
  }
  return headers;
}

/**
 * The parts of a `multipart/form-data` object, in property order. An
 * undefined property is left out.
 *
 * A field WITHOUT an Encoding Object is sent as it always has been, which
 * predates Encoding Object support: a Blob or bytes as a file part, an object
 * or an array as ONE part holding its JSON text (OpenAPI would send an array
 * one part per item), `null` as the text `null`, any other value as its
 * string form.
 *
 * A field WITH an Encoding Object follows it ("Encoding By Name", and OpenAPI
 * 3.2.1 Appendix C for `style`):
 *
 * - `null` is left out, as in a urlencoded form;
 * - a Blob or bytes is a file part, typed by `contentType` when it has no
 *   type of its own;
 * - `style`, `explode` or `allowReserved` given: the pairs a query parameter
 *   with that style/explode gets, one text part each, never percent-encoded
 *   (an exploded array one part per item, `explode: false` one part with the
 *   delimited items, a `deepObject` object one part per `name[key]`), and no
 *   `Content-Type`;
 * - otherwise by content type: an array one part per item, each item (and a
 *   value that is not an array) its {@link contentText}; the part's
 *   `Content-Type` is the explicit `contentType` ({@link partContentType}),
 *   or `application/json` for an object or array value without one (a
 *   primitive's default, `text/plain`, is the multipart default and is not
 *   written).
 *
 * Every part of a field carries its Encoding Object's {@link partHeaders}.
 * OpenAPI 3.0 ignores `style`, `explode` and `allowReserved` in a multipart
 * body; the builder applies them as OpenAPI 3.2 does, the only reading in
 * which a document that gives them means something.
 */
function multipartParts(body: Record<string, unknown>, form: FormContext): MultipartPart[] {
  const parts: MultipartPart[] = [];
  for (const [field, value] of Object.entries(body)) {
    if (value === undefined) continue;
    const owner = form.ownerFor(field);
    const encoding = fieldEncoding(owner, field);
    if (encoding === undefined) {
      parts.push({
        name: field,
        value: isBinary(value)
          ? fileBlob(value, undefined)
          : isPlainObject(value) || Array.isArray(value)
            ? jsonText(value, field, 'body')
            : String(value),
        headers: [],
      });
      continue;
    }
    if (value === null) continue;
    const context: ErrorContext = { inputKey: owner.inputKey };
    const headers = partHeaders(encoding, owner, field);
    // `contentType` is ignored when a style field is given
    const declared = encoding.styled ? undefined : partContentType(encoding, owner, field);
    if (isBinary(value)) {
      parts.push({ name: field, value: fileBlob(value, declared), headers });
    } else if (encoding.styled) {
      const styled = { key: field, style: encoding.style, explode: encoding.explode };
      for (const [name, text] of serializeQueryPairs(styled, value, () => undefined, 'body', context)) {
        form.claim?.(field, name);
        parts.push({ name, value: text, headers });
      }
    } else {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (isBinary(item)) {
          parts.push({ name: field, value: fileBlob(item, declared), headers });
          continue;
        }
        const contentType =
          encoding.contentTypes !== undefined ? declared : item !== null && typeof item === 'object' ? 'application/json' : undefined;
        parts.push({ name: field, value: contentText(item, encoding, field, 'body', context), contentType, headers });
      }
    }
  }
  return parts;
}

/**
 * A part name or file name in `Content-Disposition`, as browsers and undici
 * write it (HTML "multipart/form-data encoding algorithm"): LF, CR and `"`
 * percent-encoded, so the name cannot end the header or the quoted string.
 */
function dispositionName(name: string): string {
  return name.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
}

/** CR, LF and CRLF line breaks as CRLF, as FormData writes text */
function crlfLines(text: string): string {
  return text.replace(/\r?\n|\r/g, '\r\n');
}

/**
 * A `multipart/form-data` body written by the builder, for parts FormData
 * cannot express (a text part's `Content-Type`, an Encoding Object header):
 * a Blob of the parts as undici writes FormData (same `Content-Disposition`,
 * file `filename` and `Content-Type`, line breaks of text and names), each
 * with its extra headers, separated by a random boundary.
 */
function multipartBody(parts: MultipartPart[]): { body: Blob; boundary: string } {
  /* c8 ignore next 3 -- Blob and crypto.randomUUID exist on Node >= 19; guard for exotic runtimes */
  if (typeof Blob === 'undefined' || typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new RequestBuildError('A multipart/form-data body with part headers needs Blob and crypto.randomUUID in this runtime', {});
  }
  const boundary = `mcp-from-openapi-${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
  const chunks: Array<string | Blob> = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${dispositionName(crlfLines(part.name))}"`;
    if (typeof part.value === 'string') {
      head += '\r\n';
      if (part.contentType !== undefined) head += `Content-Type: ${part.contentType}\r\n`;
    } else {
      const filename = typeof File !== 'undefined' && part.value instanceof File ? part.value.name : 'blob';
      if (filename !== '') head += `; filename="${dispositionName(filename)}"`;
      head += `\r\nContent-Type: ${part.value.type || 'application/octet-stream'}\r\n`;
    }
    for (const [name, value] of part.headers) head += `${name}: ${value}\r\n`;
    chunks.push(`${head}\r\n`, typeof part.value === 'string' ? crlfLines(part.value) : part.value, '\r\n');
  }
  chunks.push(`--${boundary}--\r\n`);
  return { body: new Blob(chunks, { type: `multipart/form-data; boundary=${boundary}` }), boundary };
}

/**
 * The media type a non-body parameter is serialized in: set for a parameter
 * defined with `content` and for a whole-query parameter, absent for one
 * defined with `schema` (which uses style/explode).
 */
function parameterMediaType(mapper: ParameterMapper): string | undefined {
  const contentType: unknown = mapper.serialization?.contentType;
  if (contentType === undefined) return undefined;
  if (typeof contentType !== 'string' || mediaTypeEssence(contentType) === '') {
    throw new RequestBuildError(
      `${mapper.type} parameter '${mapper.key}' (input key '${mapper.inputKey}') has an invalid media type ${describeValue(contentType)} in serialization.contentType`,
      { param: mapper.key, inputKey: mapper.inputKey, location: mapper.type },
    );
  }
  return contentType;
}

/** Where a mapper entry can put its value */
const MAPPER_LOCATIONS: ReadonlySet<ParameterLocation> = new Set(['path', 'query', 'header', 'cookie', 'body']);

/** Where a security mapper entry can put its credential */
const SECURITY_LOCATIONS: ReadonlySet<ParameterLocation> = new Set(['header', 'query', 'cookie']);

/**
 * The method to put on the wire for `tool.metadata.method`: a standard method
 * upper-cased, any other exactly as written. The method comes from a
 * document, so it must be an RFC 9110 token (no space, CR or LF can reach the
 * request line) and never `CONNECT`.
 */
function resolveWireMethod(method: unknown): string {
  if (!isHttpToken(method)) {
    throw new RequestBuildError(`HTTP method ${describeValue(method)} is not a valid method (an RFC 9110 token)`, {
      method,
    });
  }
  if (isRefusedMethod(method)) {
    throw new RequestBuildError(
      `HTTP method ${describeValue(method)} is not sent: CONNECT opens a tunnel rather than sending a request`,
      { method },
    );
  }
  return wireMethod(method);
}

/**
 * The mapper entries that put each name on the wire, for the locations where
 * the input can choose names too (an exploded object's property names,
 * deepObject brackets). `body` holds the fields of a flattened body (the
 * entries that are not `wholeBody`).
 */
interface ReservedNames {
  query: Map<string, ParameterMapper[]>;
  cookie: Map<string, ParameterMapper[]>;
  body: Map<string, ParameterMapper[]>;
}

/**
 * Check the mapper's shape before any value is read (a tool may be hand-made
 * or tampered with): an array of objects with string `key` and `inputKey`,
 * and whole-query rules (OpenAPI 3.2 "Parameter Locations": `querystring`
 * MUST NOT appear more than once, nor with any `in: query` parameter; it
 * MUST use `content`, so the entry needs `serialization.contentType`). These
 * are structural, so they fail whatever values the input holds. Returns the
 * whole-query entry, if any, and the names the tool reserves.
 */
function checkMapper(mapper: unknown): { wholeQuery: ParameterMapper | undefined; reserved: ReservedNames } {
  if (!Array.isArray(mapper)) {
    throw new RequestBuildError(`Tool mapper must be an array; received ${describeValue(mapper)}`, {});
  }
  let wholeQuery: ParameterMapper | undefined;
  let otherQuery: ParameterMapper | undefined;
  const reserved: ReservedNames = { query: new Map(), cookie: new Map(), body: new Map() };
  for (const [index, entry] of (mapper as unknown[]).entries()) {
    if (entry === null || typeof entry !== 'object') {
      throw new RequestBuildError(`Mapper entry ${index} must be an object; received ${describeValue(entry)}`, {
        index,
      });
    }
    const typed = entry as ParameterMapper;
    const { key, inputKey, type } = typed;
    if (typeof key !== 'string' || typeof inputKey !== 'string') {
      throw new RequestBuildError(
        `Mapper entry ${index} must have a string key and inputKey; received key ${describeValue(key)} and inputKey ${describeValue(inputKey)}`,
        { index },
      );
    }
    if (type === 'query' || type === 'cookie' || (type === 'body' && !typed.wholeBody)) {
      const owners = reserved[type].get(key);
      if (owners === undefined) reserved[type].set(key, [typed]);
      else owners.push(typed);
    }
    if (typed.wholeQuery) {
      if (type !== 'query' || typed.security) {
        throw new RequestBuildError(
          `Mapper entry '${key}' (input key '${inputKey}') is marked wholeQuery, which only a non-security query parameter can be`,
          { param: key, inputKey, location: type },
        );
      }
      if (wholeQuery) {
        throw new RequestBuildError(
          `A tool has at most one whole-query parameter; found '${wholeQuery.key}' and '${key}'`,
          { param: key, inputKey, location: 'query' },
        );
      }
      if (parameterMediaType(typed) === undefined) {
        throw new RequestBuildError(
          `Whole-query parameter '${key}' (input key '${inputKey}') needs serialization.contentType: the media type its value is serialized in`,
          { param: key, inputKey, location: 'query' },
        );
      }
      wholeQuery = typed;
    } else if (type === 'query' && !typed.security) {
      otherQuery ??= typed;
    }
  }
  if (wholeQuery && otherQuery) {
    throw new RequestBuildError(
      `Whole-query parameter '${wholeQuery.key}' (input key '${wholeQuery.inputKey}') is the entire query string, so it cannot be combined with the query parameter '${otherQuery.key}' (input key '${otherQuery.inputKey}')`,
      { param: wholeQuery.key, inputKey: wholeQuery.inputKey, location: 'query', conflictsWith: otherQuery.key },
    );
  }
  return { wholeQuery, reserved };
}

/**
 * The check for each pair name an entry's INPUT chooses: a form whole
 * query's property names, an exploded object's property names in the query
 * (`style: form`, `explode: true`) or with `style: cookie`, a `deepObject`
 * query parameter's names (`filter[a]`), and in a form body
 * (`application/x-www-form-urlencoded` or `multipart/form-data`) every name a
 * field's Encoding Object puts on the wire besides the field's own (an
 * exploded object's property names, deepObject's `field[key]`); in a form
 * whole query, those of every field. A name that another mapper entry puts
 * in the same location is refused — a credential, whether or not this call
 * supplies it (a framework may add it later), or another parameter (another
 * body field), whether or not it has a value — so the input can neither
 * stand in for a credential nor override a sibling parameter.
 *
 * Names are compared unencoded; percent-encoding and form-encoding are both
 * one-to-one, so names that differ here differ on the wire too. They are
 * compared as common servers read them: a name whose part before its first
 * `[` is reserved is refused (`api_key[]` and `api_key[x]` are read as
 * `api_key`), and so is a credential's name in another case (`API_KEY`; some
 * servers read names in any case, and a credential is the one to protect).
 *
 * Cookies also hold one value per name, so with `claimed` (shared by the
 * whole request) two inputs naming the same cookie are refused too, instead
 * of one silently replacing the other.
 */
function nameClaimer(
  owner: ParameterMapper,
  reserved: Map<string, ParameterMapper[]>,
  claimed?: Map<string, ParameterMapper>,
): (name: string) => void {
  const kind = owner.type === 'cookie' ? 'cookie' : owner.type === 'body' ? 'form field' : 'query parameter';
  const source = `The input of ${owner.type} parameter '${owner.key}' (input key '${owner.inputKey}')`;
  const credentialsInAnyCase = new Map<string, ParameterMapper>();
  for (const holders of reserved.values()) {
    for (const holder of holders) if (holder.security && holder !== owner) credentialsInAnyCase.set(holder.key.toLowerCase(), holder);
  }
  const holderOf = (name: string): ParameterMapper | undefined => {
    const bracket = name.indexOf('[');
    for (const reservedName of bracket > 0 ? [name, name.slice(0, bracket)] : [name]) {
      const holder = reserved.get(reservedName)?.find((other) => other !== owner);
      if (holder !== undefined) return holder;
    }
    return credentialsInAnyCase.get(name.toLowerCase());
  };
  return (name) => {
    const holder = holderOf(name);
    if (holder !== undefined) {
      throw new RequestBuildError(
        `${source} names the ${kind} '${name}', which this tool reserves for ${
          holder.security
            ? `the credential of security scheme '${holder.security.scheme}'`
            : `the ${holder.type} parameter '${holder.key}' (input key '${holder.inputKey}')`
        }`,
        { param: owner.key, inputKey: owner.inputKey, location: owner.type, name, reservedBy: holder.inputKey },
      );
    }
    if (claimed === undefined) return;
    const previous = claimed.get(name);
    if (previous !== undefined && previous !== owner) {
      throw new RequestBuildError(
        `${source} names the ${kind} '${name}', which the input of ${previous.type} parameter '${previous.key}' (input key '${previous.inputKey}') names too`,
        { param: owner.key, inputKey: owner.inputKey, location: owner.type, name, reservedBy: previous.inputKey },
      );
    }
    claimed.set(name, owner);
  };
}

/** A body entry's media type, `application/json` when it names none; one that is not text is refused */
function bodyMediaType(mapper: ParameterMapper): string {
  const declared: unknown = mapper.serialization?.contentType;
  if (declared !== undefined && declared !== null && typeof declared !== 'string') {
    throw new RequestBuildError(
      `body parameter '${mapper.key}' (input key '${mapper.inputKey}') has an invalid media type ${describeValue(declared)} in serialization.contentType`,
      { param: mapper.key, inputKey: mapper.inputKey, location: 'body' },
    );
  }
  return (declared as string | null | undefined) ?? 'application/json';
}

/** Refuse a resolved path that leaves the origin, holds a dot segment, or loses a segment its template has */
function assertPathNamesTemplateResource(template: string, path: string): void {
  if (!/^\/(?![/\\])/.test(path)) {
    throw new RequestBuildError(`The request path must start with a single '/': ${describeValue(path)}`, {
      path: describeValue(path),
    });
  }
  // A URL parser reads a backslash in an http(s) path as `/`; only a template can hold one raw (values are encoded)
  if (path.includes('\\')) {
    throw new RequestBuildError(`The request path ${describeValue(path)} holds a backslash, which a URL reads as '/'`, {
      path: describeValue(path),
    });
  }
  const templateSegments = template.split('/');
  const pathSegments = path.split('/');
  pathSegments.forEach((segment, index) => {
    const lastIndex = pathSegments.length - 1;
    const emptyAllowed = index === lastIndex && templateSegments[index] === '';
    if (isDotSegment(segment) || (segment === '' && index > 0 && !emptyAllowed)) {
      throw new RequestBuildError(
        `The request path ${describeValue(path)} has an empty or dot segment where its template ${describeValue(template)} names a resource`,
        { path: describeValue(path), template: describeValue(template) },
      );
    }
  });
}

/**
 * Build an HTTP request from a generated tool and its input values — the
 * mapper applied in full: style/explode serialization (form, spaceDelimited,
 * pipeDelimited, deepObject, simple, label, matrix, and the OpenAPI 3.2
 * `cookie` style), `allowReserved`, parameters defined with `content`
 * (serialized in their media type), OpenAPI 3.2 whole-query parameters
 * (`in: querystring`), whole-body and binary bodies, JSON / form-urlencoded /
 * multipart / text serialization, the Encoding Object of each form field
 * (`serialization.encoding`: style, explode, allowReserved, contentType,
 * part headers), cookies, and header-injection guards.
 *
 * Pure function: nothing is sent, no runtime context is consulted. Security
 * mapper entries are applied only when their value is present in `input`
 * (with scheme-aware formatting); missing security values never throw —
 * frameworks resolve credentials separately (see SecurityResolver).
 *
 * Input values are read as own properties only, so an inherited member such
 * as `toString` is never a value. `input` may be `undefined` or `null` (no
 * values); any other non-object is a {@link RequestBuildError}.
 */
export function buildHttpRequest(
  tool: McpOpenAPITool,
  input: Record<string, unknown>,
  options: BuildHttpRequestOptions = {},
): BuiltHttpRequest {
  if (tool === null || typeof tool !== 'object' || tool.metadata === null || typeof tool.metadata !== 'object') {
    throw new RequestBuildError('Tool must be an object with a metadata object', {});
  }
  const method = resolveWireMethod(tool.metadata.method);
  const rawBase = options.baseUrl ?? resolveServerUrl(tool);
  if (typeof rawBase !== 'string') {
    throw new RequestBuildError(`Base URL must be a string; received ${describeValue(rawBase)}`, { baseUrl: rawBase });
  }
  if (rawBase.includes('{')) {
    throw new RequestBuildError(
      `Base URL '${rawBase}' contains unresolved server template variables (no default value in the spec); pass an explicit baseUrl`,
      { baseUrl: rawBase },
    );
  }
  if (rawBase !== '' && !/^https?:\/\//i.test(rawBase)) {
    throw new RequestBuildError(`Base URL must be http(s) or empty; received '${rawBase}'`, { baseUrl: rawBase });
  }
  let base = rawBase;
  while (base.endsWith('/')) base = base.slice(0, -1);

  if (typeof tool.metadata.path !== 'string') {
    throw new RequestBuildError(`Tool path must be a string; received ${describeValue(tool.metadata.path)}`, {});
  }
  const { wholeQuery: wholeQueryEntry, reserved } = checkMapper(tool.mapper);
  if (input !== undefined && input !== null && typeof input !== 'object') {
    throw new RequestBuildError(`Tool input must be an object; received ${describeValue(input)}`, {});
  }
  const values: object | undefined = input ?? undefined;
  const unchosen = unchosenCredentials(tool.mapper, values);

  let path = tool.metadata.path;
  const queryPairs: Array<[key: string, value: string, allowReserved?: boolean]> = [];
  // Set when the whole-query parameter's media type is form-urlencoded (its
  // pairs are in queryPairs) or any other (its percent-encoded text)
  let formWholeQuery = false;
  let wholeQueryText: string | undefined;
  const headers = createRecord<string>();
  // Every value of each cookie name, in the order sent (style: cookie arrays
  // repeat a name); a later entry for the same name replaces earlier values
  const cookieValues = createRecord<string[]>();
  // Cookie names chosen by an input so far, and by which entry
  const inputCookieNames = new Map<string, ParameterMapper>();
  let rawBody: unknown;
  let bodyObject: Record<string, unknown> | undefined;
  let contentType: string | undefined;
  let hasBody = false;
  let binaryBody = false;
  // The mapper entry of each field of a flattened body, or of the whole body
  const bodyFields = new Map<string, ParameterMapper>();
  let wholeBodyOwner: ParameterMapper | undefined;

  for (const mapper of tool.mapper) {
    // Checked before anything else, so an entry that is skipped for lack of a
    // value is rejected too, and nothing is dropped or sent somewhere else
    if (!MAPPER_LOCATIONS.has(mapper.type)) {
      throw new RequestBuildError(
        `Unknown parameter location ${describeValue(mapper.type)} for '${mapper.key}' (input key '${mapper.inputKey}')`,
        { param: mapper.key, inputKey: mapper.inputKey, location: mapper.type },
      );
    }
    if (mapper.security && !SECURITY_LOCATIONS.has(mapper.type)) {
      throw new RequestBuildError(
        `Security parameter '${mapper.key}' (input key '${mapper.inputKey}') cannot be sent in the ${mapper.type}; credentials go in a header, the query string or a cookie`,
        { param: mapper.key, inputKey: mapper.inputKey, location: mapper.type },
      );
    }

    const value = readInput(values, mapper.inputKey);

    if (mapper.security) {
      // Security entries apply only when a value was provided, of the alternative chosen; they are never
      // treated as required here (frameworks resolve credentials separately).
      if (value === undefined || value === null || unchosen.has(mapper)) continue;
      const formatted = formatSecurityValue(mapper, primitiveString(value, mapper.key, mapper.type));
      if (mapper.type === 'header') {
        assertHeaderSafe(mapper.key, formatted);
        headers[mapper.key] = formatted;
      } else if (mapper.type === 'query') {
        queryPairs.push([mapper.key, formatted]);
      } else {
        assertCookieName(mapper.key);
        cookieValues[mapper.key] = [formatted];
      }
      continue;
    }

    if (value === undefined || (value === null && mapper.type !== 'body')) {
      if (mapper.required) {
        throw new RequestBuildError(
          `Required ${mapper.type} parameter '${mapper.key}' (input key '${mapper.inputKey}') is missing`,
          { param: mapper.key, inputKey: mapper.inputKey, location: mapper.type },
        );
      }
      continue;
    }

    // every location in MAPPER_LOCATIONS has a case: none is dropped here
    switch (mapper.type) {
      case 'path': {
        const mediaType = parameterMediaType(mapper);
        const replacement =
          mediaType === undefined
            ? serializePathValue(mapper, value)
            : percentEncode(serializeContent(mapper.key, value, mediaType, 'path', parameterForm(mapper)), mapper.key, 'path');
        // a function replacement: `$&`, `$1`, ... in a value are literal text
        path = path.replaceAll(`{${mapper.key}}`, () => replacement);
        break;
      }

      case 'query': {
        const mediaType = parameterMediaType(mapper);
        if (mapper.wholeQuery) {
          // checkMapper made sure a whole-query entry has a media type
          const wholeType = mediaType as string;
          if (classifyMediaType(wholeType) === 'form') {
            // The object's properties are the query pairs, exactly as in a
            // form body; the composed string is form-urlencoded below. The
            // input chooses these names, so none may be a reserved one.
            if (!isPlainObject(value)) {
              throw new RequestBuildError(
                `Whole-query parameter '${mapper.key}' is sent as ${FORM_URLENCODED}, which needs an object; received ${describeValue(value)}`,
                { param: mapper.key, inputKey: mapper.inputKey, location: 'query', contentType: wholeType },
              );
            }
            const claim = nameClaimer(mapper, reserved.query);
            for (const pair of formPairs(value, 'query', parameterForm(mapper, claim))) queryPairs.push([...pair]);
            formWholeQuery = true;
          } else {
            // The serialized value IS the query string, percent-encoded
            wholeQueryText = percentEncode(serializeContent(mapper.key, value, wholeType, 'query'), mapper.key, 'query');
          }
        } else if (mediaType !== undefined) {
          queryPairs.push([mapper.key, serializeContent(mapper.key, value, mediaType, 'query', parameterForm(mapper))]);
        } else {
          for (const [k, v] of serializeQueryPairs(mapper, value, nameClaimer(mapper, reserved.query))) {
            queryPairs.push([k, v, mapper.allowReserved]);
          }
        }
        break;
      }

      case 'header': {
        // A `content` header is its media type's text, sent unchanged (no
        // percent-encoding); JSON text there is ASCII and never holds a raw
        // CR, LF or NUL
        const mediaType = parameterMediaType(mapper);
        const headerValue =
          mediaType === undefined
            ? serializeHeaderValue(mapper, value)
            : serializeContent(mapper.key, value, mediaType, 'header', parameterForm(mapper));
        assertHeaderSafe(mapper.key, headerValue);
        headers[mapper.key] = headerValue;
        break;
      }

      case 'cookie': {
        const mediaType = parameterMediaType(mapper);
        if (mediaType !== undefined) {
          // A `content` cookie is its media type's text, sent unchanged: it
          // must already be a valid cookie value (RFC 6265, comma included)
          assertCookieName(mapper.key);
          const cookieValue = serializeContent(mapper.key, value, mediaType, 'cookie', parameterForm(mapper));
          assertCookieValue(mapper.key, cookieValue, true);
          cookieValues[mapper.key] = [cookieValue];
        } else if (mapper.style === 'cookie') {
          // Every name sent is checked: the parameter's own name, or each
          // property name of an exploded object (the parameter's is unused),
          // which the input chooses, so none may be a reserved one
          const claim = nameClaimer(mapper, reserved.cookie, inputCookieNames);
          for (const [name, cookieValueList] of serializeCookieStyle(mapper, value, claim)) {
            assertCookieName(name);
            for (const cookieValue of cookieValueList) assertCookieValue(name, cookieValue, true);
            cookieValues[name] = cookieValueList;
          }
        } else {
          // Default style (form): today's output, an array comma-joined
          assertCookieName(mapper.key);
          cookieValues[mapper.key] = [
            Array.isArray(value)
              ? value.map((v) => primitiveString(v, mapper.key, 'cookie')).join(',')
              : primitiveString(value, mapper.key, 'cookie'),
          ];
        }
        break;
      }

      case 'body': {
        const declared = bodyMediaType(mapper);
        hasBody = true;
        contentType = contentType ?? declared;
        // `binary` on a flattened param marks a FILE PART inside a multipart
        // form; only a whole-body binary mapper makes the entire payload raw
        if (mapper.serialization?.binary && mapper.wholeBody) binaryBody = true;
        if (mapper.wholeBody) {
          rawBody = value;
          wholeBodyOwner = mapper;
        } else {
          bodyFields.set(mapper.key, mapper);
          if (bodyObject === undefined) bodyObject = {};
          setOwnProperty(bodyObject, mapper.key, value);
        }
        break;
      }
    }
  }

  // A required body is sent though the input gave none of its properties: empty
  const requiredBody = hasBody
    ? undefined
    : tool.mapper.find((mapper) => mapper.type === 'body' && mapper.serialization?.requiredBody === true);
  if (requiredBody) {
    hasBody = true;
    contentType = bodyMediaType(requiredBody);
    bodyObject = {};
  }

  if (path.includes('{')) {
    throw new RequestBuildError(`Unresolved path parameters remain in '${path}'`, { path });
  }
  assertPathNamesTemplateResource(tool.metadata.path, path);

  if (bodyObject !== undefined) rawBody = bodyObject;
  // A form body's fields: each one's mapper entry (a flattened body) or the
  // whole body's. A name a field's input chooses may not be another field's.
  const fieldClaimers = new Map<ParameterMapper, (name: string) => void>();
  const bodyForm: FormContext = {
    ownerFor: (field) => (bodyObject !== undefined ? bodyFields.get(field)! : wholeBodyOwner!),
    claim: (field, name) => {
      // the field's own name, or a whole body (no other field to collide with)
      if (name === field || bodyObject === undefined) return;
      const owner = bodyFields.get(field)!;
      let claim = fieldClaimers.get(owner);
      if (claim === undefined) fieldClaimers.set(owner, (claim = nameClaimer(owner, reserved.body)));
      claim(name);
    },
  };

  const query = createRecord<string[]>();
  let queryString: string;
  if (wholeQueryText !== undefined) {
    // Only a security credential can be in queryPairs here (checkMapper
    // rejects any other query entry next to a whole-query one)
    if (queryPairs.length > 0) {
      throw new RequestBuildError(
        `Security parameter '${queryPairs[0][0]}' cannot be added to the query string: whole-query parameter '${wholeQueryEntry!.key}' is serialized as ${wholeQueryEntry!.serialization!.contentType}, which has no name=value pairs to add a credential to; send the credential in a header or a cookie instead`,
        { param: queryPairs[0][0], location: 'query', wholeQuery: wholeQueryEntry!.key },
      );
    }
    queryString = wholeQueryText;
  } else {
    for (const [k, v] of queryPairs) {
      (query[k] ??= []).push(v);
    }
    queryString = formWholeQuery
      ? // A form-urlencoded whole query: every pair (credentials included)
        // encoded per the media type, as in a form body (space as `+`)
        formEncode(queryPairs, 'query')
      : // Values encoded here; keys may carry deepObject brackets which stay
        // readable, with only unsafe characters escaped
        queryPairs
          .map(([k, v, allowReserved]) => {
            const encodedKey = percentEncode(k, k, 'query').replace(/%5B/gi, '[').replace(/%5D/gi, ']');
            return `${encodedKey}=${percentEncode(v, k, 'query', allowReserved)}`;
          })
          .join('&');
  }

  // Fold cookies into a single Cookie header — values verbatim, so the
  // header always matches the `cookies` record
  const cookieNames = Object.keys(cookieValues);
  const cookies = createRecord<string>();
  if (cookieNames.length > 0) {
    const cookiePairs: string[] = [];
    for (const name of cookieNames) {
      for (const cookieValue of cookieValues[name]) {
        assertCookieValue(name, cookieValue);
        cookiePairs.push(`${name}=${cookieValue}`);
      }
      cookies[name] = cookieValues[name][0];
    }
    headers['Cookie'] = cookiePairs.join('; ');
  }

  // Serialize the body per content type. Resolve any existing content-type
  // header case-insensitively first — a spec-declared `Content-Type` header
  // parameter must not end up duplicated alongside a lowercase variant.
  const contentTypeKey = Object.keys(headers).find((h) => h.toLowerCase() === 'content-type') ?? 'content-type';
  const hasExplicitContentType = contentTypeKey in headers;
  let body: unknown;
  if (hasBody && rawBody !== undefined) {
    const ct = contentType!;
    // A key of the document's `content` map: it is sent as a header value
    assertHeaderSafe(contentTypeKey, ct);
    if (binaryBody) {
      // Raw binary: pass through untouched (string, Uint8Array, Blob, ...)
      body = rawBody;
      if (!hasExplicitContentType) headers[contentTypeKey] = ct;
    } else if (ct.toLowerCase() === FORM_URLENCODED) {
      if (!isPlainObject(rawBody)) {
        throw new RequestBuildError(`form-urlencoded bodies must be objects; received ${typeof rawBody}`, {
          contentType: ct,
        });
      }
      body = formEncode(formPairs(rawBody, 'body', bodyForm), 'body');
      headers[contentTypeKey] = ct;
    } else if (ct.toLowerCase() === 'multipart/form-data') {
      /* c8 ignore next 3 -- FormData exists on Node >= 18; guard for exotic runtimes */
      if (typeof FormData === 'undefined') {
        throw new RequestBuildError('multipart/form-data requires a FormData implementation in this runtime', {});
      }
      if (!isPlainObject(rawBody)) {
        throw new RequestBuildError(`multipart bodies must be objects; received ${typeof rawBody}`, {
          contentType: ct,
        });
      }
      const parts = multipartParts(rawBody, bodyForm);
      if (parts.some((part) => part.headers.length > 0 || part.contentType !== undefined)) {
        // A part header FormData cannot write: the builder writes the body,
        // so it also sets the content-type, with its boundary
        const written = multipartBody(parts);
        body = written.body;
        headers[contentTypeKey] = `multipart/form-data; boundary=${written.boundary}`;
      } else {
        const form = new FormData();
        for (const part of parts) form.append(part.name, part.value);
        body = form;
        // Do NOT set content-type: the HTTP client must add the boundary. A
        // spec-mapped Content-Type header would ship WITHOUT a boundary and
        // break the multipart body, so it is removed too.
        if (hasExplicitContentType) delete headers[contentTypeKey];
      }
    } else if (JSON_MEDIA_TYPE.test(ct)) {
      // A body's Content-Type is matched as written, parameters and all
      // (unlike a `content` parameter's media type, which is classified by
      // its essence): `application/json; charset=utf-8` falls to the branch
      // below, which also writes an object as JSON text
      body = jsonText(rawBody, 'body', 'body');
      headers[contentTypeKey] = ct;
    } else {
      // text/plain, application/xml, ... : caller-provided string content
      body = typeof rawBody === 'object' && rawBody !== null ? jsonText(rawBody, 'body', 'body') : String(rawBody);
      headers[contentTypeKey] = ct;
    }
  }

  return {
    url: `${base}${path}${queryString ? `?${queryString}` : ''}`,
    method,
    headers: toPlainRecord(headers),
    query: toPlainRecord(query),
    ...(wholeQueryText !== undefined && { queryString: wholeQueryText }),
    cookies: toPlainRecord(cookies),
    contentType,
    body,
    rawBody,
  };
}
