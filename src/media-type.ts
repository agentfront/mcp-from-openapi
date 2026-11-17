/**
 * One reading of a media type for everything that decides what a
 * parameter's `content` means: `ParameterResolver` (the input schema of a
 * `content` parameter that declares none), `buildHttpRequest` (how the value
 * is serialized) and the diagnostics that describe either. A leaf module: it
 * imports nothing, so generation and request assembly share it without
 * depending on each other.
 *
 * @module
 */

/**
 * How a media type is read: `json` (the value is written as JSON text, so
 * any JSON value is valid), `form` (a form-urlencoded string built from an
 * object) or `other` (the value itself, a string or another primitive).
 */
export type MediaTypeClass = 'json' | 'form' | 'other';

/** The media type of a form: `application/x-www-form-urlencoded` */
export const FORM_URLENCODED = 'application/x-www-form-urlencoded';

/**
 * The JSON rule: a media type is JSON when it is `application/json`, or
 * `application/` followed by at least one character and `+json`
 * (`application/problem+json`, `application/vnd.api+json`), in any case.
 * `text/json`, `text/foo+json`, `application/jsonl`, `application/json-seq`
 * and `application/+json` are not.
 *
 * It matches a whole string, so it is meant for the {@link mediaTypeEssence}
 * of a media type; {@link classifyMediaType} does that. The request body
 * serializer matches a body's `Content-Type` header with it as written, which
 * is why it is exported.
 */
export const JSON_MEDIA_TYPE = /^application\/(.+\+)?json$/i;

/**
 * The media type without its parameters, trimmed and lower-cased:
 * `application/json` for `Application/JSON; charset=utf-8`. An empty string
 * for a media type that has none (`''`, `; charset=utf-8`).
 */
export function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(';', 1)[0].trim().toLowerCase();
}

/**
 * Classifies a media type, as the essence of it (parameters ignored, case
 * ignored, surrounding space ignored):
 *
 * - `json` when the essence is `application/json` or `application/` + one or
 *   more characters + `+json` (see {@link JSON_MEDIA_TYPE});
 * - `form` when it is `application/x-www-form-urlencoded`;
 * - `other` for everything else: `text/json`, `text/plain`,
 *   `application/xml`, an empty string, and a value that is not a string.
 *
 * The one classification behind a `content` parameter's input schema without
 * a `schema` (`{}` for `json`, `{ type: 'object' }` for `form`,
 * `{ type: 'string' }` for `other`) and behind how `buildHttpRequest`
 * serializes a `content` parameter or a whole query (JSON text, a form
 * string, the primitive itself), so a value the input schema allows is one
 * the builder accepts. Never throws.
 */
export function classifyMediaType(mediaType: unknown): MediaTypeClass {
  if (typeof mediaType !== 'string') return 'other';
  const essence = mediaTypeEssence(mediaType);
  if (JSON_MEDIA_TYPE.test(essence)) return 'json';
  return essence === FORM_URLENCODED ? 'form' : 'other';
}

/**
 * The media types of an Encoding Object's `contentType`, in order: a
 * comma-separated list of media types and media ranges (OpenAPI 3.2
 * "Encoding Object": `media-range *( "," OWS media-range )`), such as
 * `image/png, image/jpeg`. Each element is trimmed and empty elements are
 * dropped; a comma inside a quoted parameter value (`text/plain; x="a,b"`)
 * does not split. Never throws.
 */
export function mediaTypeList(contentType: string): string[] {
  const list: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < contentType.length; index++) {
    const char = contentType[index];
    if (quoted && char === '\\') index++; // a quoted-pair: the next character is literal
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      list.push(contentType.slice(start, index));
      start = index + 1;
    }
  }
  list.push(contentType.slice(start));
  return list.map((element) => element.trim()).filter((element) => element !== '');
}

/**
 * Whether a media type is a range rather than one media type: its type or
 * subtype is `*` (`image/*`, `*\/*`), or it has no subtype at all. A range
 * says which media types are acceptable, so it cannot be the `Content-Type`
 * of a part.
 */
export function isMediaRange(mediaType: string): boolean {
  const [type, subtype] = mediaTypeEssence(mediaType).split('/', 2);
  return type === '*' || subtype === undefined || subtype === '' || subtype === '*';
}
