# Request Builder

[Home](../README.md) | [Parameter Conflicts](./parameter-conflicts.md) | [API Reference](./api-reference.md)

---

## Overview

`buildHttpRequest(tool, input, options?)` turns a generated tool plus its input values into a ready-to-send HTTP request — the mapper applied in full, including the OpenAPI serialization rules that hand-written request builders routinely get wrong.

It is a **pure function**: nothing is sent, no runtime context is consulted, and the library never imports an HTTP client.

```typescript
import { OpenAPIToolGenerator, buildHttpRequest } from "mcp-from-openapi";

const generator = await OpenAPIToolGenerator.fromURL(
  "https://api.example.com/openapi.json",
);
const [tool] = await generator.generateTools();

const request = buildHttpRequest(tool, { id: "42", filter: { tag: "news" } });

await fetch(request.url, {
  method: request.method,
  headers: request.headers,
  body: request.body as BodyInit,
});
```

## What it handles

| Concern         | Coverage                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Query styles    | `form` (explode both ways), `spaceDelimited`, `pipeDelimited`, `deepObject` (recursive brackets)                                 |
| Whole query     | An OpenAPI 3.2 `in: querystring` parameter: the value is the entire query string, serialized in its media type (`wholeQuery`)    |
| `content`       | A parameter defined with `content` instead of `schema`, in a path, query, header or cookie, serialized in its media type         |
| Path styles     | `simple`, `label`, `matrix` — primitives, arrays, and objects, explode both ways                                                 |
| Headers         | `simple` serialization, RFC 7230 name check, value check (tab, space, visible ASCII, U+0080 to U+00FF; CR/LF/NUL named as injection)  |
| Cookies         | Folded `Cookie` header with verbatim values, RFC 6265 name/value validation; `form` (the default) and the OpenAPI 3.2 `cookie` style |
| Reserved names  | A name the input chooses (a form whole query, an exploded `form` object in the query, an exploded `style: cookie` object) never adds or replaces a credential or a sibling parameter |
| `allowReserved` | RFC 3986 reserved characters left unencoded in query values                                                                      |
| Bodies          | JSON (incl. `+json`), `x-www-form-urlencoded` (`null` properties left out), `multipart/form-data` (real `FormData`), raw binary pass-through, text |
| `wholeBody`     | Non-object/union bodies sent as the entire body (never wrapped)                                                                  |
| Security        | Values applied only when present in `input`; `bearer`/`basic` get prefixes, structured schemes (digest) pass through verbatim    |
| Methods         | A standard method is sent upper-case (`GET`, `QUERY`); an OpenAPI 3.2 `additionalOperations` method is sent exactly as written in the document (`LINK`, `M-SEARCH`) because HTTP methods are case-sensitive. The method must be an RFC 9110 token, and `CONNECT` is refused                                    |
| Safety          | Header-injection guards (CR/LF), sendable header and cookie values, lone surrogates refused, path traversal-safe encoding, http(s)-only base URLs, unresolved path/server-template detection |

## Result shape

```typescript
interface BuiltHttpRequest {
  url: string; // base + expanded path + encoded query; always authoritative
  method: string; // standard methods upper-case ('GET', 'QUERY'); additionalOperations methods as written ('LINK')
  headers: Record<string, string>; // incl. content-type and Cookie when applicable
  query: Record<string, string[]>; // query pairs as sent (unencoded values); {} for a non-form whole query
  queryString?: string; // the query exactly as in `url` after the `?`; only for a non-form whole query
  cookies: Record<string, string>; // one value per cookie name (the first, for an exploded array)
  contentType?: string;
  body?: unknown; // string | FormData | raw binary | undefined
  rawBody?: unknown; // structured body before serialization
}
```

Things to know:

- **`url` is authoritative.** Send it as it is. `query` and `queryString` describe it for logging and inspection; re-encoding them yourself can change what the server receives (see [Do not rebuild the query string](#do-not-rebuild-the-query-string)).
- **Multipart bodies** come back as `FormData` and the `content-type` header is deliberately _not_ set — your HTTP client must add the boundary itself. `contentType` still reports `multipart/form-data` for routing.
- **Binary bodies** (`serialization.binary`) pass through untouched (string, `Uint8Array`, `Blob`, ...); everything else serializes per the content type.
- **The records are ordinary objects.** `headers`, `query` and `cookies` have `Object.prototype` and every key is an own property, so a parameter named `constructor` or `toString` is a key like any other. Input values are read as own properties too: an inherited member such as `toString` is never a value, and neither is a value held only on a prototype (a class instance's getter).

## Server URLs

The tool's first server URL is used as the base, with `{variable}` templates substituted from their spec-declared defaults. Templates without defaults throw a `RequestBuildError` — pass an explicit `baseUrl` in that case (it always wins over the spec's servers).

## Explode defaults

`explode` follows the OpenAPI table: `true` for `form` (and `deepObject`), `false` for every other style — a `spaceDelimited` array without an explicit `explode` serializes space-joined, not as repeated keys.

## Parameters defined with `content`

A parameter can be defined with `content` (one media type and its schema) instead of `schema`. OpenAPI says `style`, `explode` and `allowReserved` do not apply to it: the value is serialized in the media type. The generator reads it in every version, for every location:

- the input schema is the media type's `schema`, annotated `x-parameter-content-type`. A media type with no schema gives an unconstrained input (`{}`) for a JSON media type (`application/json`, `application/*+json`), `{ type: 'object' }` for `application/x-www-form-urlencoded` (its value is built from an object) and `{ type: 'string' }` for any other, since its value is sent as written (`text/plain`, `application/xml`, and `text/json`, which is not a JSON media type here). The input schema and `buildHttpRequest` read the media type the same way (parameters and case ignored), so a value the input schema allows is one the builder accepts;
- the mapper entry carries `serialization: { contentType }` (and the media type's `encoding`, when it has one) and no `style`, `explode` or `allowReserved`;
- a parameter that has both `schema` and `content` is read as `schema`, as it always was (an `in: querystring` parameter is the exception: it is defined by `content`);
- a `content` that holds several media types (the specification allows one) uses one of them, chosen as a request body's is (`application/json`, `application/x-www-form-urlencoded`, `multipart/form-data`, `application/xml`, `text/plain`, else the first). A `content` that is empty or not a map is ignored: the parameter is read as a string.

Each of these cases, and three more, records an `INVALID_PARAMETER_CONTENT` warning and the document stays valid: a parameter that defines both `schema` and `content`; a media type that is not a Media Type Object (`null`, a string); a media type left as a `$ref` that was not resolved (`dereference: false`; only generation sees it); and a media type that declares `itemSchema`, which describes the items of a stream and is not read for a parameter. The message says what is used instead.

`buildHttpRequest` serializes the value by its media type first, then applies the location's own escaping:

| Media type | Value | Serialized as |
| --- | --- | --- |
| `application/json`, `application/*+json` | any JSON value | The JSON text. A string is quoted: `"abc"` |
| `application/x-www-form-urlencoded` | an object | A form string (`a=1&b=x`), the one a form body gets: an array property is one pair per item, an object property is JSON text, and a `null` or `undefined` property is left out (see [Form serialization](#form-serialization)) |
| any other (`text/plain`, `application/xml`, ...) | a string, number, boolean or bigint | The value as it is |

| Location | What is sent |
| --- | --- |
| `path` | The text, percent-encoded, in place of `{name}` |
| `query` | One `name=value` pair with the text percent-encoded; `query[name]` holds the unencoded text |
| `header` | The text unchanged (no percent-encoding), which must be a valid header value ([Header and cookie values](#header-and-cookie-values)). JSON text is written in ASCII: every character from U+007F up becomes `\uXXXX`, so JSON is always sendable |
| `cookie` | The text unchanged, which must hold only RFC 6265 cookie-octets. JSON strings and objects are refused (they contain `"`), and so is any text with whitespace, a comma, `;`, `\` or a non-ASCII character. A JSON number or boolean passes. The generator warns about a JSON cookie whose schema allows a string, object or array (`COOKIE_CONTENT_NOT_SENDABLE`) |

```typescript
import { OpenAPIToolGenerator, buildHttpRequest } from "mcp-from-openapi";

const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.1.0",
  info: { title: "Places", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/places": {
      get: {
        operationId: "findPlaces",
        parameters: [
          {
            name: "coordinates",
            in: "query",
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["lat", "long"],
                  properties: { lat: { type: "number" }, long: { type: "number" } },
                },
              },
            },
          },
          { name: "X-Filter", in: "header", content: { "application/json": { schema: { type: "object" } } } },
        ],
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
const [tool] = await generator.generateTools();

tool.mapper[0];
// { inputKey: 'coordinates', type: 'query', key: 'coordinates', required: true,
//   serialization: { contentType: 'application/json' } }

const request = buildHttpRequest(tool, { coordinates: { lat: 10, long: 20 }, "X-Filter": { tag: "news" } });
request.url; // 'https://api.example.com/places?coordinates=%7B%22lat%22%3A10%2C%22long%22%3A20%7D'
request.query; // { coordinates: ['{"lat":10,"long":20}'] }
request.headers; // { 'X-Filter': '{"tag":"news"}' }
```

The value is the structured value, not its text: pass the object, not a JSON string. A string given to an `application/json` parameter is a JSON string, so it is quoted and escaped once more.

## Whole-query parameters

An OpenAPI 3.2 parameter `in: querystring` holds the entire query string, serialized by its media type. The generator makes it one input whose mapper entry has `type: 'query'` and `wholeQuery: true` (the counterpart of `wholeBody`), with `serialization.contentType` set to the media type. The entry's `key` is the parameter's name, which is never sent. The input property is annotated `x-parameter-location: 'query'` and `x-parameter-whole-query: true`.

| Media type | Query string | `request.query` | `request.queryString` |
| --- | --- | --- | --- |
| `application/x-www-form-urlencoded` | The object's properties as `name=value` pairs, as a form body writes them (space as `+`; an array is one pair per item; a nested object is JSON text; a `null` property is left out) | The pairs | absent |
| JSON (`application/json`, `+json`) | The percent-encoded JSON text of the value | `{}` | The encoded text |
| any other (`text/plain`) | The value percent-encoded | `{}` | The encoded text |

```typescript
const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.2.0",
  info: { title: "Search", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/search": {
      get: {
        operationId: "search",
        parameters: [
          {
            name: "query",
            in: "querystring",
            content: {
              "application/json": {
                schema: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer" } } },
              },
            },
          },
        ],
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
const [tool] = await generator.generateTools();

tool.mapper[0];
// { inputKey: 'query', type: 'query', key: 'query', required: false,
//   serialization: { contentType: 'application/json' }, wholeQuery: true }

const request = buildHttpRequest(tool, { query: { q: "a b&c", limit: 5 } });
request.url; // 'https://api.example.com/search?%7B%22q%22%3A%22a%20b%26c%22%2C%22limit%22%3A5%7D'
request.query; // {}
request.queryString; // '%7B%22q%22%3A%22a%20b%26c%22%2C%22limit%22%3A5%7D'
```

An optional whole-query parameter that is absent adds nothing (no `?`). A value that serializes to an empty string (`''` as `text/plain`, an empty object as a form) gives a `url` without `?`; for a non-form media type `queryString` is then `''`.

A form-urlencoded whole query ignores the Encoding Objects (`serialization.encoding`), as a form body does: the mapper carries them, the builder does not apply them.

**Query credentials.** A security `apiKey` entry `in: query` is added to a form whole query as one more `name=value` pair, in mapper order. A JSON or other whole query has no pairs to add it to, so a credential value in the input is a `RequestBuildError`: send the credential in a header or a cookie. When the whole-query value is absent, the credential is sent as an ordinary pair. A form whole query may not name a pair after a credential either ([Names the input chooses](#names-the-input-chooses)). The generator warns about the JSON or other case before any call is made (`QUERYSTRING_WITH_QUERY_CREDENTIAL`, one per scheme).

**Structural rules.** The OpenAPI 3.2 rules are checked before any value is read, so they fail whatever the input holds: a whole-query entry must be a non-security `type: 'query'` entry with a `serialization.contentType` (a media type is how the value is serialized, so an entry without one fails even when the input leaves the parameter out), a tool has at most one, and none may sit next to another non-security `query` entry. The generator never produces such a mapper; a hand-made or modified tool can.

### Do not rebuild the query string

A non-form whole query is **one serialized value, not name/value pairs**. Code that takes `request.url` apart and puts it back through a pairs API corrupts it. Reading it with `URLSearchParams` takes the whole JSON text for the name of a pair that has no value, and writing it back changes the encoding (`%20` becomes `+`) and appends a `=`:

```typescript
const request = buildHttpRequest(tool, { query: { q: "a b&c", limit: 5 } });

const url = new URL(request.url);
url.searchParams.append("apiKey", "k"); // wrong
url.toString();
// 'https://api.example.com/search?%7B%22q%22%3A%22a+b%26c%22%2C%22limit%22%3A5%7D=&apiKey=k'
```

Compared with `request.url`, the space is now written `+`, a stray `=` follows the JSON text, and a second pair was added, so the server no longer receives the JSON text of the value. The same happens with `url.search = new URLSearchParams(url.searchParams).toString()` and with any code that rebuilds the query from `request.query` (which is `{}` here).

The safe pattern: send `request.url` as it is, change the origin with the `baseUrl` option rather than by editing the URL, and add nothing to the query yourself. When you must add a pair, do it on the string, and only when `queryString` is absent:

```typescript
import type { BuiltHttpRequest } from "mcp-from-openapi";

function withExtraPair(request: BuiltHttpRequest, name: string, value: string): string {
  if (request.queryString !== undefined) {
    throw new Error("the query string is one serialized value: it has no name=value pairs to add to");
  }
  const separator = request.url.includes("?") ? "&" : "?";
  return `${request.url}${separator}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}
```

This is correct for every other query (and for a form whole query), where `url` is made of pairs. Even there, changing `new URL(request.url).searchParams` re-serializes the whole query: `filter[tag]=news&path=a/b:c&q=a%20b` becomes `filter%5Btag%5D=news&path=a%2Fb%3Ac&q=a+b` (`deepObject` brackets and `allowReserved` characters are escaped again, `%20` becomes `+`), so prefer the string form. Reading the URL does not change it: `new URL(request.url).href` equals `request.url`; only the pairs API rewrites the query.

## Form serialization

One serializer writes every `application/x-www-form-urlencoded` object: a form request body, a form whole query and a form `content` parameter, so all three behave alike. It applies the Encoding Object defaults: an array property is one pair per item (each item a primitive), an object property is its JSON text, and any other value is its string form. A property that is `undefined` **or `null`** is left out, as an absent parameter is, because a form has no way to write null (before, a `null` in a form body was sent as the text `null`). A `null` array item is still a `RequestBuildError`. Explicit Encoding Objects (`serialization.encoding`) are not applied.

Only the form serializers drop `null`. A JSON body keeps it (`{"a":"1","z":null}`), and a `multipart/form-data` part with a `null` value is still sent as the text `null`.

```typescript
// a form body { a: '1', z: null }
buildHttpRequest(tool, { a: "1", z: null }).body; // 'a=1'
```

## Names the input chooses

Three serializations let the **input** decide the names that go on the wire, because an object's property names become the names themselves:

- a form whole query (`in: querystring`, `application/x-www-form-urlencoded`): every property is a query pair;
- an exploded `form` object in the query (`style: form`, `explode: true`, the default for an object): the parameter's name disappears and each property is a pair;
- an exploded `style: cookie` object: each property is a cookie.

An input that names a property `api_key` would add a query pair or a cookie of that name, which is how a value chosen by the caller could add or replace a credential (or override a sibling parameter). `buildHttpRequest` refuses such a name with a `RequestBuildError` when another mapper entry in the same location puts that name on the wire:

- **a credential** (a security entry in the query or a cookie), whether or not this call supplies it, because a framework may add the credential after the request is built;
- **a sibling parameter** (another `query` or `cookie` entry), whether or not it has a value, so one parameter's input cannot override another.

An entry's own name is allowed (the exploded object `filter` may have a property `filter`). Names are compared exactly, as query and cookie names are on the wire (`API_KEY` is not `api_key`). For cookies, two exploded objects that name the same cookie are refused as well, instead of one replacing the other. `context` holds `param`, `inputKey`, `location`, `name` and `reservedBy` (the input key of the entry that holds the name). A `deepObject` query names `filter[...]`, and a JSON whole query has no names, so neither is affected.

```typescript
// An `apiKey` scheme `key` in the query (named api_key) and an exploded `filter` object in the query
buildHttpRequest(tool, { filter: { color: "blue" }, key: "S3CRET" }).url;
// 'https://api.example.com/items?color=blue&api_key=S3CRET'

buildHttpRequest(tool, { filter: { color: "blue", api_key: "ATTACKER" } });
// RequestBuildError: The input of query parameter 'filter' (input key 'filter') names the query
// parameter 'api_key', which this tool reserves for the credential of security scheme 'key'
```

Before, the second call built `https://api.example.com/items?color=blue&api_key=ATTACKER` when the credential was not supplied, and `?api_key=ATTACKER&api_key=S3CRET` when it was.

## Header and cookie values

Values are sent as they are, so the builder refuses what a client would refuse later, naming the parameter.

**Header values** may hold tab, space, visible ASCII (U+0020 to U+007E) and U+0080 to U+00FF. CR, LF and NUL keep their injection error. Any other control character, DEL, and any character above U+00FF (a lone surrogate included) is a `RequestBuildError` that names the character and its index. Before, such a value was built and failed inside the HTTP client (`new Headers({ 'X-Note': '€5' })` throws `TypeError: Cannot convert argument to a ByteString because the character at index 0 has a value of 8364 which is greater than 255`). A JSON `content` header is written in ASCII, so it always passes: `{ city: 'München €' }` is sent as `{"city":"M\u00fcnchen \u20ac"}`.

**Cookie values** are checked by kind:

| Cookie | Allowed in a value |
| --- | --- |
| A cookie parameter without `style: cookie` or `content` (including a credential) | Anything except control characters, whitespace (U+00A0 included), `"`, `;`, `\` and characters above U+00FF. A comma and U+0080 to U+00FF are tolerated, because arrays have always been comma-joined |
| `style: cookie` and a `content` cookie | RFC 6265 cookie-octets only: printable ASCII except space, `"`, `,`, `;` and `\`. No non-ASCII character |

**Lone surrogates.** A lone surrogate (an unpaired UTF-16 code unit) has no UTF-8 encoding. Every encoder the builder runs refuses it with a `RequestBuildError` naming the parameter, instead of throwing a bare `URIError` (`encodeURIComponent`) or silently writing U+FFFD (`URLSearchParams`): path, query names and values, a whole query, and form-encoded bodies and parameters. A JSON body writes it as the escape `\ud800`, which is valid JSON, and a multipart part is not checked (`FormData` writes U+FFFD).

## Cookies and `style: cookie`

A cookie parameter without `style: cookie` is serialized as it always was (the default style is `form`): a primitive is `name=value`, an array is comma-joined into one cookie (`color=blue,black,brown`), an empty array is `color=`, and an object is a `RequestBuildError`. A comma in such a value is tolerated; the rules for the value are in [Header and cookie values](#header-and-cookie-values).

`style: cookie` (OpenAPI 3.2) writes name/value pairs separated by `; ` in the `Cookie` header, with each value as given (no percent-encoding). `explode` defaults to `true`:

| Value | `style: cookie` (exploded) | `explode: false` |
| --- | --- | --- |
| primitive | `id=abc` | `id=abc` |
| array | One pair per item with the parameter's name: `color=blue; color=black; color=brown`. An empty array sends no cookie | `RequestBuildError` |
| object | One cookie per property; the parameter's name is not sent: `R=100; G=200; B=150`. An `undefined` property is skipped; `null` or a nested value is a `RequestBuildError` | `RequestBuildError` |

An array or object with `explode: false` has no cookie form: it would need unencoded commas, which the `Cookie` header does not allow. Every name sent is checked as a cookie name (the property names of an exploded object included), and every value must hold only RFC 6265 cookie-octets ([Header and cookie values](#header-and-cookie-values)). The property names of an exploded object come from the input, so they are checked against the cookies the tool reserves ([Names the input chooses](#names-the-input-chooses)). `request.cookies` holds one value per name (the first, for an exploded array); the `Cookie` header carries every pair and is the authoritative form.

```typescript
const generator = await OpenAPIToolGenerator.fromJSON({
  openapi: "3.2.0",
  info: { title: "Cookies", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  paths: {
    "/colors": {
      get: {
        operationId: "colors",
        parameters: [
          { name: "id", in: "cookie", style: "cookie", schema: { type: "string" } },
          { name: "color", in: "cookie", style: "cookie", schema: { type: "array", items: { type: "string" } } },
          {
            name: "rgb",
            in: "cookie",
            style: "cookie",
            schema: { type: "object", properties: { R: { type: "integer" }, G: { type: "integer" }, B: { type: "integer" } } },
          },
        ],
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
const [tool] = await generator.generateTools();

const request = buildHttpRequest(tool, {
  id: "abc",
  color: ["blue", "black"],
  rgb: { R: 100, G: 200, B: 150 },
});
request.headers.Cookie; // 'id=abc; color=blue; color=black; R=100; G=200; B=150'
request.cookies; // { id: 'abc', color: 'blue', R: '100', G: '200', B: '150' }
```

## Errors

All failures throw `RequestBuildError` (with a `context` object): missing required parameters, `null` where a primitive is needed, objects in plain query slots, header injection attempts, invalid cookie names, non-http base URLs, unresolved path placeholders, and the cases below.

- **A method that is not an RFC 9110 token** (empty, or containing a space, CR or LF): `context.method` holds the value. The method comes from a document, so nothing that could end a request line reaches the wire.
- **`CONNECT`**, in any case: it opens a tunnel instead of sending a request, so the builder never sends it. The generator already ignores a `CONNECT` operation (`REFUSED_METHOD`); this guards tools built by hand.
- **An unknown mapper `type`** (anything but `path`, `query`, `header`, `cookie`, `body`), checked before the entry's value is read, so an entry without a value is rejected too. `context` holds `param`, `inputKey` and `location`.
- **A security entry whose `type` is `body` or `path`**: credentials go in a header, the query string or a cookie.
- **A whole-query entry that is not allowed** (checked first, whatever the input): `wholeQuery` on an entry that is not a non-security `query` entry, a second whole-query entry, one without a media type, or a whole-query entry next to another non-security `query` entry. `context` holds `param`, `inputKey` and `location` (`conflictsWith` for the last).
- **A missing or invalid media type**: a whole-query entry whose `serialization.contentType` is missing or is not a non-empty string (reported whatever the input holds), or a `content` entry whose `serialization.contentType` is not a non-empty string (reported when its value is given). `context` holds `param`, `inputKey` and `location`.
- **A value its media type cannot carry**: an `application/x-www-form-urlencoded` parameter that is not an object, or any other media type given something that is not a string, number, boolean or bigint (`context.contentType` holds the media type); an array item in a form that is not a primitive.
- **A value that is not JSON**: a cycle, a nesting deeper than 1,000 levels, a JSON text longer than V8's maximum string length, a BigInt, a function, or whatever a throwing `toJSON` raises. `context` holds `param` and `location`.
- **A credential added to a whole query that has no pairs** (JSON or other media type): `context` holds `param`, `location` and `wholeQuery` (the whole-query parameter's name).
- **A name the input chooses that the tool reserves**: a form whole query, an exploded form object in the query or an exploded `style: cookie` object that names a credential or a sibling parameter, or two cookie objects naming one cookie (`context` holds `param`, `inputKey`, `location`, `name`, `reservedBy`; see [Names the input chooses](#names-the-input-chooses)).
- **A cookie that cannot be sent**: `style: cookie` with `explode: false` for an array or an object (`context.style` is `cookie`), a cookie name that is not an RFC 6265 token, or a value with a character its kind of cookie cannot carry (including a JSON string or object in a `content` cookie; see [Header and cookie values](#header-and-cookie-values)).
- **A header that cannot be sent**: a name that is not an RFC 7230 token, CR, LF or NUL in the value, or any other character a header value cannot hold (`context.header`).
- **A lone surrogate** in a value or name that is percent-encoded or form-encoded (`context` holds `param` and `location`).

## Security values

Security mapper entries are applied only when a value is present in `input` — pass resolved credentials under the mapper's `inputKey` (e.g. from [SecurityResolver](./security.md)) or leave them out and inject auth in your transport layer. `bearer`/`basic`/`oauth2` schemes get their prefixes automatically (never doubled); structured schemes like digest pass through verbatim — supply the full header value or use [SecurityResolver](./security.md). A credential `in: query` next to a whole-query parameter follows the rules above.

---

**Related:** [Parameter Conflicts](./parameter-conflicts.md) | [Security](./security.md) | [API Reference](./api-reference.md) | [OpenAPI Versions](./openapi-versions.md)
