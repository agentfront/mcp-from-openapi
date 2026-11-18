# SSRF Prevention

[Home](../README.md) | [Configuration](./configuration.md) | [Security](./security.md)

---

## Overview

When dereferencing `$ref` pointers, the library resolves external URLs. A malicious OpenAPI spec could point `$ref` to internal services, cloud metadata endpoints, or the local filesystem -- enabling SSRF (Server-Side Request Forgery) and local file read attacks. The library blocks these by default.

This page covers the checks every fetch goes through, how relative references and `$self` become URLs that go through them, the error a refused reference gives, and, last, what a document can make the library read under each configuration ([Trust Model](#trust-model)).

### Attack Scenarios

Without protection, a crafted OpenAPI spec could:

- **Cloud credential theft** -- `$ref` pointing to `http://169.254.169.254/latest/meta-data/` steals AWS/GCP/Azure instance metadata
- **Internal network scanning** -- `$ref` values probe internal services and ports
- **Local file read** -- `file:///etc/passwd` reads arbitrary files from the server filesystem

All it takes is processing an untrusted OpenAPI spec.

> **Acknowledgment:** Thanks to [@TharVid](https://github.com/TharVid) for responsibly reporting the SSRF via `$ref` dereferencing attack vector, which led to the implementation of these protections.

---

## Default Protections

Out of the box, the following are blocked:

### Blocked Protocols

- `file://` -- Local filesystem access is blocked. A relative `$ref` counts as a file read when the document's base is a file (`fromFile`, or a `file:` `documentUri`) or the document has no base URI at all, so such a document cannot read its sibling files until you allow `file` (see [Multi-file specifications](./getting-started.md#multi-file-specifications))
- Only `http://` and `https://` are allowed

### Blocked Hostnames and IP Ranges

| Pattern | Description |
|---------|-------------|
| `localhost` | Loopback hostname |
| `127.0.0.0/8` | IPv4 loopback range |
| `10.0.0.0/8` | RFC 1918 private range |
| `172.16.0.0/12` | RFC 1918 private range |
| `192.168.0.0/16` | RFC 1918 private range |
| `169.254.0.0/16` | Link-local / cloud metadata (AWS, GCP) |
| `0.0.0.0` | Unspecified address |
| `metadata.google.internal` | GCP metadata endpoint |
| `::1` | IPv6 loopback |
| `fd00::/8` | IPv6 Unique Local Address |
| `fe80::/10` | IPv6 link-local |
| `64:ff9b:1::/48` | Local-use NAT64 prefix (never globally routable) |

Bracketed IPv6 forms (`[::1]`, `[fd00:...]`, `[fe80:...]`) are also blocked.

IPv6 addresses that embed an IPv4 address are checked against the IPv4 ranges above, because a NAT64 gateway, 6to4 relay, or dual-stack host may carry them to that IPv4 target:

| Form | Example | Embedded IPv4 |
|------|---------|---------------|
| IPv4-mapped (`::ffff:0:0/96`) | `::ffff:7f00:1` | `127.0.0.1` |
| IPv4-translated (`::ffff:0:0:0/96`) | `::ffff:0:a00:1` | `10.0.0.1` |
| IPv4-compatible (`::/96`, deprecated) | `::7f00:1` | `127.0.0.1` |
| NAT64 well-known prefix (`64:ff9b::/96`) | `64:ff9b::a9fe:a9fe` | `169.254.169.254` |
| 6to4 (`2002::/16`) | `2002:c0a8:101::1` | `192.168.1.1` |

### Hostname Matching

Hostnames are compared in a normalized form: lowercase, with trailing root dots and IPv6 brackets removed. This applies to the built-in names above and to every `allowedHosts` / `blockedHosts` entry, on both sides of the comparison. `localhost.`, `LOCALHOST`, and `localhost` are the same host, so a `blockedHosts: ['internal.corp']` entry also blocks `http://internal.corp./`.

`allowedHosts` and `blockedHosts` entries are also compared as hosts, not spellings. A Unicode name is its ASCII form (`bücher.example` is `xn--bcher-kva.example`), and an IPv6 address matches however its groups are written. In `blockedHosts` only, an IPv6 address that embeds an IPv4 address (mapped, NAT64, 6to4, ...) is that IPv4 address, so `blockedHosts: ['169.254.169.254']` also blocks `http://[::ffff:a9fe:a9fe]/`. An `allowedHosts` entry admits exactly its own host: `8.8.8.8` does not admit `[::ffff:8.8.8.8]`, and one 6to4 address does not admit another of the same network.

`blockedHosts` also applies to the addresses a name resolves to: an address entry blocks every name that resolves to it. With `allowInternalIPs: true`, a name is resolved, and the connection pinned to what was checked, only when `blockedHosts` holds an address; a name that cannot be resolved is then refused (`dns-failed`).

---

## Configuration

Use `RefResolutionOptions` in `LoadOptions` to customize behavior:

### Restrict to Specific Hosts

Only allow refs from trusted hosts:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    allowedHosts: ['schemas.example.com', 'api.example.com'],
  },
});
```

When `allowedHosts` is set, **only** these hosts are permitted (in addition to passing the block list check).

### Add Custom Blocked Hosts

Block additional hostnames on top of the default list:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    blockedHosts: ['untrusted-cdn.com', 'internal.corp.net'],
  },
});
```

### Restrict Protocols

Allow only HTTPS:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    allowedProtocols: ['https'],
  },
});
```

### Disable All External Resolution

Pass an empty protocols list to block all external `$ref` resolution:

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    allowedProtocols: [],
  },
});
```

### Allow Internal IPs (Not Recommended)

Disables the built-in IP block list. Only user-provided `blockedHosts` are checked (an address in it also blocks the names that resolve to it):

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  refResolution: {
    allowInternalIPs: true, // WARNING: SSRF risk
  },
});
```

> **Warning:** Enabling this may expose your application to SSRF attacks against cloud metadata endpoints and internal services.

---

## How It Works

The library configures `@apidevtools/json-schema-ref-parser` with a custom `canRead` function that:

1. Parses the `$ref` URL
2. Checks the protocol against `allowedProtocols`
3. Checks the hostname against `allowedHosts` (if configured)
4. Checks the hostname against the blocked list (built-in + `blockedHosts`)
5. Returns `false` (block) if any check fails

This happens transparently during the dereference step. A reference that none of the resolvers may read does not fall through to a generic "Unable to resolve" failure: it fails with an error that names the reference, the base it was resolved against, the rule that refused it and the option that would allow it (see [When a Reference Cannot Be Read](#when-a-reference-cannot-be-read)).

Every network fetch -- the spec URL in `fromURL` and each external `$ref` -- then goes through `safeFetch`, which:

1. Resolves the hostname and rejects it if **any** resolved address is internal (this closes the `127.0.0.1.nip.io` class of bypass)
2. Pins the connection to the exact address it just validated, so the socket never looks the name up again (this closes DNS rebinding), while keeping the original hostname for the `Host` header and TLS SNI
3. Opens a fresh socket for every request, so a pooled keep-alive socket that was connected elsewhere is never reused
4. Re-validates every redirect hop before following it (`$ref` fetches refuse redirects entirely)

### Headers and Redirects

`LoadOptions.headers` (typically the spec host's `Authorization` or API key) is sent only while the request stays on the origin of the URL passed to `fromURL`. If a redirect leaves that origin (another host, another port, or an `https` → `http` downgrade), **all** caller headers are dropped for that hop and for every later hop, even if the chain later returns to the original origin. An open redirect on the spec host therefore cannot pass your credentials to a third party. External `$ref` fetches never send `headers`.

If your spec host redirects to a different origin that also needs credentials, load the final URL directly, or pass `followRedirects: false` to stop at the redirect.

Connection pinning needs Node's `node:http`/`node:https`. On runtimes without them (Web/edge), and whenever you pass a custom `fetchImpl` to `safeFetch`, only the pre-fetch checks apply. For untrusted input there, combine `allowedHosts` with network egress controls.

---

## Base URIs and Relative References

A relative `$ref` such as `./schemas/pet.json` becomes a URL only against a base URI. A document has two kinds of URI, and the library keeps them apart:

- its **retrieval URI**: where it was actually read from. Relative references to other documents are read against it.
- its **identity**: the URIs that name it, which are its retrieval URI and, from OpenAPI 3.2, `$self`. A `$ref` to any of them is a reference to the document itself (see [References to the document itself](#references-to-the-document-itself)), and a Security Requirement key that is one of them names one of its schemes.

| Loaded with | Retrieval URI: what relative `$ref`s are read against |
|-------------|--------------------------------------------------------|
| `fromURL(url)` | The URL the document was finally read from, after redirects, without user information or fragment. Its query stays in the base, but a relative reference never inherits it |
| `fromFile(path)` | The file's `file:` URL (a relative path is made absolute against the working directory first) |
| Any factory, with `documentUri` | `documentUri`, instead of the row above |
| `fromJSON`, `fromYAML`, without `documentUri` | None. A relative reference is read against an absolute `$self` of a 3.2 document, and otherwise against the process working directory, as in earlier releases |

OpenAPI 3.2 makes `$self` the base URI of relative references. The specification leaves open where an implementation retrieves a document from, so identity follows the specification and the retrieval location is an implementation choice. This library reads from where the document actually came from, whatever `$self` says: a file reads the files next to it, a mirror serves its own copies, and a document's claim about its own address never moves a read (see [The `$self` Field](#the-self-field)).

The reference then resolves against the retrieval URI as RFC 3986 says, and the result is an ordinary absolute URL that goes through every check in this page, exactly like an absolute `$ref` written in the document. (This is why a document read with `fromURL` whose relative references used to fail now fetches them from its own location, under the default options: an absolute `$ref` to that host was always fetched.)

```typescript
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  // spec holds { "$ref": "./schemas/pet.json" } in a response schema
  documentUri: "https://specs.example.com/petstore/openapi.json",
  refResolution: { allowedHosts: ["trusted.example.org"] },
});
await generator.generateTools();
// ParseError: Failed to dereference OpenAPI document: Cannot read $ref "./schemas/pet.json"
//   resolved against "https://specs.example.com/petstore/openapi.json"
//   to "https://specs.example.com/petstore/schemas/pet.json":
//   its host "specs.example.com" is not in refResolution.allowedHosts;
//   add the host to refResolution.allowedHosts to read it
```

Nothing is fetched here: the host check refuses the URL first. The base changes only which URL a relative reference turns into. It does not change which URLs may be read:

- `file` is still blocked by default, so a document read with `fromFile` cannot read the files next to it until you allow `file`.
- Hosts, internal addresses, redirects and DNS pinning are checked as before.
- `LoadOptions.headers` is used for the spec fetch only: neither it nor any credential in the spec URL is ever sent on a `$ref` fetch. No URI the library keeps for a document carries user information, so nothing of the spec URL's credentials can travel with a reference resolved against it.

### `documentUri`

`LoadOptions.documentUri` states where a document came from, for a document you did not load from there: a local copy of a published spec, or a string read from a database. It must be an absolute `http`, `https` or `file` URI of at most 2,048 characters made of URI characters (RFC 3986), without user information, without a fragment and, for a `file:` URI, without a host (`file://localhost/...` is fine). Anything else throws a `LoadError`:

| Value | Message |
|-------|---------|
| `42`, `null`, `{}` | `LoadOptions.documentUri must be a string, found 42` |
| More than 2,048 characters | `LoadOptions.documentUri must be at most 2048 characters, found "https://example.com/aaaa..."` (the value is cut) |
| `./openapi.json`, `openapi.json`, `/srv/openapi.json`, `""` | `LoadOptions.documentUri must be an absolute URI, such as https://example.com/openapi.yaml, found "./openapi.json"` |
| `ftp://example.com/openapi.json`, `urn:example:api` | `LoadOptions.documentUri must be an http, https or file URI, found "ftp://example.com/openapi.json"` |
| `https://admin:s3cret@example.com/openapi.json`, `https://token@example.com/openapi.json` | `LoadOptions.documentUri must not contain user information, found "https://***@example.com/openapi.json"` |
| `https://example.com/openapi.json#top` (also a bare `#`) | `LoadOptions.documentUri must not contain a fragment, found "https://example.com/openapi.json#top"` |
| `file://server/share/openapi.json` | `LoadOptions.documentUri must not name a host in a file URI, found "file://server/share/openapi.json"` |
| A space, a non-ASCII character, a backslash | `LoadOptions.documentUri must be a URI (RFC 3986 characters only), found "https://example.com/my spec.json"` |

User information is never echoed: it is shown as `***@` in the message and in `error.context.documentUri`, which otherwise holds the value as the message quotes it (cut at 256 characters). The value is checked first, before `fromURL` sends a request and before `fromFile` reads the file, so a bad `documentUri` costs nothing. When `documentUri` is passed to `fromURL` or `fromFile` it replaces the URL or file the document was read from. A Swagger 2.0 document with no `host` also takes its server's host and scheme from an `http` or `https` retrieval URI; this adds no read (it only decides the `servers` URL a tool is built with), and a `file:` URI supplies nothing (see [Swagger 2.0](./openapi-versions.md#servers-host-basepath-and-schemes)).

A document that has no base at all (`fromJSON` and `fromYAML` without `documentUri`, and no absolute `$self`) behaves as in earlier releases: a relative reference resolves against the process working directory, and the error says so:

```
... Cannot read $ref "./schemas/pet.json" resolved against "<working directory>/" to "<working directory>/schemas/pet.json": it is read as a local file,
and refResolution.allowedProtocols ("http", "https") does not include "file"; add "file" to refResolution.allowedProtocols to read it
(the document has no base URI, so its relative references resolve against the working directory:
load it with fromFile or fromURL, or pass LoadOptions.documentUri)
```

### Length limits

Each relative reference is resolved against the URIs of its document, so the work grows with their length. Every URI the library keeps for a document is at most **2,048 characters**:

- a longer `documentUri` is a `LoadError` (above);
- a longer `$self`, or one that resolves to a longer URI, is ignored with `REFUSED_SELF`;
- a longer retrieval URI (the final URL of `fromURL` after its redirects, or the `file:` URL of a `fromFile` path, which percent-encoding can make several times longer than the path) is not used. The generator records `BASE_URI_TOO_LONG` at load, a reference to the document by that URI is not recognised as local, and a relative reference to another document fails the load with rule `base-too-long`: it is never resolved against the working directory instead.

### References to the document itself

A `$ref` that names the document's own URI is resolved from the document itself, with no fetch. That includes `secureDefaults`, which turns every external reference off. The document's own URIs are its retrieval URI (`documentUri` replaces it) and, in a 3.2 document, its `$self`. A relative reference counts when, resolved against either of them, it is one of the two.

```typescript
// spec: a schema is { "$ref": "https://specs.example.com/petstore/openapi.json#/components/schemas/Pet" }
const generator = await OpenAPIToolGenerator.fromJSON(spec, {
  documentUri: "https://specs.example.com/petstore/openapi.json",
  secureDefaults: true,
});
const [tool] = await generator.generateTools();
tool.outputSchema;
// { type: 'object', properties: { id: { type: 'integer' } }, 'x-status-code': 200, description: 'ok', ... }
```

The reference becomes a local one before dereferencing, and it is held to this:

- **The fragment is a percent-encoded JSON Pointer** (RFC 6901 section 6): `#/components/schemas/My%20Pet` reaches the schema `My Pet`, and `~1` is `/`.
- **No fragment, an empty one (`#`) and `""` mean the whole document.** `""` counts only when the document has a base; without one it is left as written.
- **The target must exist as written.** A pointer that leads nowhere fails the load with a `ParseError` of rule `missing-target`: `it names this document, but "#/components/schemas/Nope" points to nothing in it`. It never becomes `{}`.
- **The pointer may not pass through another `$ref`.** `#/components/schemas/Alias/properties`, where `Alias` is `{ "$ref": "#/components/schemas/Pet" }`, is refused with the same rule (`its pointer goes through another $ref (at "#/components/schemas/Alias"), which is not followed`): the two dereferencers the library uses would not agree on it.
- **Keywords next to the `$ref` are dropped**, as for any `#/...` reference (the siblings were kept when the document was fetched again). In a document declaring 3.1 or later, the constraints beside a schema's `$ref` apply instead ([`$ref` beside other keywords](./openapi-versions.md#ref-beside-other-keywords)).

An ordinary local reference (`#/...`) keeps the reading it always had: its percent-escapes are not decoded, and one that leads nowhere becomes `{}` without an error. Only a reference that names the document by URI is checked.

The limits:

- **Only JSON Pointer fragments.** A plain-name fragment (`#Pet`, a `$anchor`) is not a JSON Pointer and is left to the reference resolver: under `secureDefaults` it stays an unresolved `$ref`, otherwise dereferencing fails with `Invalid $ref pointer "Pet". Pointers must begin with "#/"` (rule `missing-target`).
- **Not under a Schema Object that has its own `$id`**, in any OpenAPI version: that `$id` sets the base of the references below it (JSON Schema 2020-12), so they are not rewritten.
- **Only when the document has a URI.** Without one the library cannot tell which URL is its own.

#### How URIs are compared

Two URIs name the same document when these are equal: scheme, host, port, path and query, with the fragment ignored. Before comparing, the host is lowercased (an internationalized host is converted to ASCII), a default port (`:443` for `https`, `:80` for `http`) is dropped, `.` and `..` path segments are removed, the hex digits of percent-encodings are upper-cased, and a percent-encoding of an unreserved character (`%41` for `A`, `%7e` for `~`) is decoded, in the path and the query. These are different documents: a different path, a path in another case, `%2F` against `/`, a query that differs in any way (an empty `?` is not no query, and the order of parameters matters), a trailing slash, another scheme, and any URI with user information against one without.

---

## The `$self` Field

A document that declares OpenAPI 3.2 or newer may carry `$self`, a URI reference naming the document. The library uses it for what the specification says it is for, the document's **identity**: a `$ref` to it is a [reference to the document itself](#references-to-the-document-itself), and a Security Requirement key can name the document's schemes by it. A relative `$self` first resolves against the retrieval URI. The retrieval URI keeps naming the document too.

`$self` does **not** move where references are read from. Relative references are read against the retrieval URI whenever there is one (see [Base URIs and Relative References](#base-uris-and-relative-references)). It is the base of reads for one kind of document only: one with no retrieval URI (`fromJSON` or `fromYAML` without `documentUri`) and an absolute `$self`. Because identity follows the specification and the retrieval location is an implementation choice the specification leaves open, two things follow:

- **A file-loaded spec reads its sibling files whatever `$self` says.** A document read with `fromFile` whose `$self` is `https://specs.example.com/v1/openapi.json` still resolves `./schemas/pet.json` next to the file: with the default options that is refused as a local file (rule `protocol`), with `file` allowed it is read from disk, and nothing is requested from `specs.example.com` either way.
- **A mirror serves its own copies.** A document fetched from `https://mirror.example.net/...` whose `$self` names the original host has its relative references fetched from the mirror, and the original host is not contacted.

A document controls `$self`, so it is read with these rules. A `$self` that fails one of them is ignored, a warning is recorded in `generator.getDiagnostics()` at load, and references resolve as if it were absent:

| `$self` | Diagnostic |
|---------|------------|
| Is not a string, holds characters a URI cannot hold (a space, a non-ASCII character), or has a fragment | `INVALID_SELF`. Also an error of `validate()`, so with `validate: true` the first `generateTools()` throws a `ParseError` |
| Has user information (`https://user:pw@host/`: a credential must never ride on references), uses a scheme other than `http`, `https` or `file`, is a `file:` URI that names a host, is a `file:` URI in a document retrieved over the network (`fromURL`, or an `http`/`https` `documentUri`), or is longer than 2,048 characters, or resolves to a URI longer than that | `REFUSED_SELF` |
| Is a relative reference and the document has no usable retrieval URI to resolve it against (`fromJSON` or `fromYAML` without `documentUri`, or a retrieval URI too long to be used) | `UNRESOLVABLE_SELF` |
| Sits in a document declaring 3.0 or 3.1 | `FEATURE_NEWER_THAN_DECLARED_VERSION`: the field does not exist in those versions, so it is ignored. A document declaring a newer 3.x minor is read as 3.2 |

For example, `$self` with user information gives `` `$self` contains user information (a credential before the host); it is ignored, and references resolve as if it were absent `` (the value is not quoted, because it may be a real credential). The messages of the other codes name the rule and quote the value. A `file:` `$self` is accepted in a document that was not retrieved over the network.

What `$self` does not change:

- **It adds no reach beyond an absolute `$ref`.** Where it is the base of reads (no retrieval URI), a relative reference resolved against it is an ordinary URL that passes the protocol allow-list, the host gate, the internal-address check, the pinned transport and the refusal of redirects. With `$self: "http://169.254.169.254/api/openapi.json"` in a `fromJSON` document, the reference `./schemas/pet.json` fails with `its host "169.254.169.254" is an internal address`, without a request. A `$self` on a host outside `allowedHosts` is refused the same way, and under `secureDefaults` the reference is not read at all.
- **It never affects `servers`.** A relative server URL stays as written; OpenAPI resolves it against the retrieval URI, not `$self`.
- **No credential travels with it.** The spec URL's `headers` are never sent to a `$ref` fetch, whichever host `$self` names, and a `$self` with user information is refused.
- **Only the root document's `$self` is read.** A referenced document's `$self` is ignored: its own relative references resolve against the URL it was fetched from.

---

## When a Reference Cannot Be Read

A reference that the allow-list, the host gate or the network guard refuses, or that fails to read, fails the dereference (the first `generateTools()`, or `validate()`) with a `ParseError` that names it:

```
Failed to dereference OpenAPI document: Cannot read $ref "<reference>" [at "<pointer>"] resolved against "<base>" to "<resolved>": <reason>[; <what would allow it>][ (<hint>)]
```

- `<reference>` is the `$ref` as written, `<base>` what it was resolved against and `<resolved>` the URL or path it became. For a file base, `<base>` and `<resolved>` are local paths. The document's author may read the message, so none of the three shows:
  - a query, shown as `?...`, because a URL can carry a token there;
  - user information, shown as `***`, also where resolving moved it into a path (percent-encoded or not);
  - the process working directory, shown as `<working directory>/`.
  A name that resolves to an internal address is refused without naming the address. `at "<pointer>"` is added when the reference resolver says where in the document the reference is (it does not for a document declaring 3.1, or one with no base).
- Each quoted part is cut at 256 characters and written with control and bidirectional characters escaped, because the document controls all of them, in the message and in `error.context` alike.
- The `<hint>` appears only when the document has no base URI and the reference is relative.
- When several references cannot be read, the one named is the first in document order (the entry document depth first, then each referenced document as it is read), whatever order the network or the disk answers in.
- When any read or parse fails (a refused or unreadable reference, or a referenced document that is neither JSON nor YAML), no new read is started, and the rejection settles only after the reads already started have ended. A failed dereference (the `ParseError` of `generateTools()` or `initialize()`, or the `UNREADABLE_REFERENCE` of `validate()`) therefore leaves no request or file read running, and no further reference is read after it. The cost is time: a failure can wait for a slow read that was already in flight, at most `LoadOptions.timeout` for an HTTP one (a slow `/a.json` of 3 s with `timeout: 800` rejected after 831 ms).

`error.context` holds the same facts, bounded and escaped the same way:

```typescript
try {
  await generator.generateTools();
} catch (error) {
  if (error instanceof ParseError && error.context?.rule) {
    const { rule, reference, base, resolved } = error.context;
    // rule:      'protocol'
    // reference: './schemas/pet.json'
    // base:      '/tmp/petstore/openapi.json'
    // resolved:  '/tmp/petstore/schemas/pet.json'
  }
}
```

`rule` is always there. `reference`, `base` and `resolved` come with the rules that name a reference, and `path`, the JSON Pointer of the `$ref` in the document being loaded (`/paths/~1pets/get/responses/200/content/application~1json/schema`), when the resolver or the library knows it: the document of the example above declares 3.1, for which the resolver reports no location, so it has no `path`, where a 3.0 or 3.2 one does. The raw error is not kept in `context`. A failure the library cannot tie to a reference (`invalid-document`, `missing-target` in a referenced document, `unreadable`) keeps the resolver's message and has only `rule`.

| `rule` | The reference could not be read because | To allow it |
|--------|-----------------------------------------|-------------|
| `protocol` | Its protocol is not in `refResolution.allowedProtocols` (a path or relative reference counts as `file`), or it is allowed but not one the network fetcher reads (only `http` and `https` are fetched) | Add the protocol, `file` for a local path (see below) |
| `host-not-allowed` | `allowedHosts` is set and does not list its host | Add the host to `allowedHosts` |
| `host-blocked` | Its host, or an address its name resolves to, is in `blockedHosts` | Remove it from `blockedHosts` |
| `too-many-documents` | The document needs more than `refResolution.maxDocuments` referenced documents (default 10,000) | Raise `maxDocuments` |
| `internal-address` | Its host is a loopback, private, link-local or cloud-metadata name or address | `allowInternalIPs: true` (unsafe for documents you do not trust) |
| `resolved-address` | Its name resolves to an internal address (`Host "..." resolves to a blocked internal address`) | `allowInternalIPs: true` (unsafe) |
| `dns-failed` | Its name could not be resolved | Fix the name |
| `too-large` | The response or local file exceeds 10 MiB (`Response body exceeds 10485760 bytes`), or the referenced documents read hold more than `refResolution.maxTotalBytes` together (default 100 MiB) | Raise `maxTotalBytes` for the second |
| `timeout` | No answer within `LoadOptions.timeout` (`no answer within 300 ms (LoadOptions.timeout)`), or reading every referenced document takes longer than ten times it | Raise `timeout` |
| `response` | The server answered with a failure status (`the server answered 404 "Not Found"`). A redirect is not followed for a `$ref`, so a `302` is this too | Fix the reference or the server |
| `fetch-failed` | The fetch failed for another reason (`connect ECONNREFUSED 127.0.0.1:8080`) | |
| `file-error` | A local file cannot be read (`the file cannot be read (ENOENT)`), is not a regular file, or is named by a `file:` URL with a host | |
| `missing-target` | A pointer leads nowhere: in the document itself (a reference by its own URI, see [above](#references-to-the-document-itself)), in a referenced document (`Missing $ref pointer "#/nothing". Token "nothing" does not exist.`), or a plain-name fragment | Fix the pointer |
| `invalid-document` | A referenced document is not JSON or YAML | |
| `base-too-long` | A relative reference of a document whose retrieval URI is longer than 2,048 characters | See [Length limits](#length-limits) |
| `unreadable` | Anything else (`Invalid URL`) | |

`generator.validate()` does not throw for these: it returns `{ valid: false, errors: [{ code: 'UNREADABLE_REFERENCE', message, path }] }`. See [API Reference](./api-reference.md#instance-methods).

The spec URL itself goes through the same guard. When `fromURL` is refused, it throws an `SsrfError` (a `LoadError`) whose `context.reason` is one of `invalid-url`, `protocol`, `host-not-allowed`, `host-blocked`, `internal-address`, `resolved-address`, `dns-failed`, `too-large`, `too-many-redirects` and `no-transport` (no fetch implementation exists). The rules above of the same names are these reasons.

### Allowing `file`

```typescript
const generator = await OpenAPIToolGenerator.fromFile("/tmp/petstore/openapi.json", {
  refResolution: { allowedProtocols: ["file"] },
});
```

`file` lets the document read any local file the process can read, by relative path, absolute path or `file:` URL, with no confinement to the document's directory: read [Trust Model](#trust-model) before you set it for a document you did not write.

Only a regular file of at most 10 MiB is read. A device (`/dev/zero`), a named pipe, a directory or a socket is refused (`file-error`, `it is not a regular file`) without waiting on it. A larger file is refused before it is read (`too-large`). A `file:` URL that names a host (`file://server/share/a.json`, a network share) is refused (`file-error`).

---

## Trust Model

A document is untrusted input. It chooses every `$ref` and, from 3.2, `$self`. What it can make the library read depends on your options, not on the document.

| Configuration | Network | Local files |
|---------------|---------|-------------|
| **Default options** | A `GET` of any `http` or `https` URL whose host passes `allowedHosts` and `blockedHosts` and does not resolve to an internal address. The URL may be absolute, or relative to the retrieval URI (or, for a document with none, to its absolute `$self`). No redirects, at most 10 MiB per response, `timeout` applies, no credentials of yours are sent | None. A reference that resolves to a local file is refused (the `protocol` rule): a `file:` URL, or a path in a document whose base is a file or that has no base |
| **`secureDefaults: true`** | None. External references are not read: they stay in the generated schemas as written (`{ "$ref": "./schemas/pet.json" }`), with no error and no diagnostic. A reference to the document's own URI is still resolved, from the document. `fromURL` follows no redirects for the spec | None |
| **`file` allowed** in `allowedProtocols` | As the row it is added to | Any file the process can read: a relative path (`../` is not confined to the document's directory), an absolute path, or a `file:` URL. See the residual risk below |
| **`allowInternalIPs: true`** | Also loopback, private, link-local and cloud-metadata addresses | |

Explicit `refResolution` values win over `secureDefaults` key by key: `secureDefaults: true` with `allowedProtocols: ["file"]` reads files again.

Under the default options a document cannot:

- read a local file;
- reach an internal address, by an IP literal or by a name that resolves to one;
- make the library send the spec URL's headers or credentials anywhere but to the spec URL's own origin;
- be redirected to a target the checks have not seen: redirects of a `$ref` are refused;
- move where its references are read from by claiming another address: `$self` never replaces the retrieval URI, so a file-loaded document keeps reading (or, by default, refusing) files, and a fetched one keeps reading from where it was fetched;
- point its references at your filesystem when it was retrieved over the network: a relative reference resolves against the network retrieval URI, and a `file:` `$self` is refused (`REFUSED_SELF`).

What it can do is make the library fetch public `http` and `https` URLs of its choosing, which is the purpose of an external `$ref`. If that is too much for documents you do not control, use `secureDefaults: true`, or restrict `allowedHosts`.

**A relative reference adds no new reach.** Resolving a reference against a base produces an absolute URL that passes the same checks as an absolute `$ref`, and any absolute `$ref` in the document could already name that URL. One thing behaves differently than before because a base now exists: **a document read with `fromURL` has its relative references fetched from its own location under the default options**, where they used to fail (they were read as local files and refused). A document with no retrieval URI and an absolute `$self` (a `fromJSON` document, say) now resolves its relative references against that `$self` too, where it used to resolve them against the working directory. Both are requests the document could already have caused with an absolute `$ref`, through every gate above. A `$self` does not change anything for a document read with `fromFile` or `fromURL`, or one given a `documentUri`.

### Residual risk: `file` and a document from the network

With `file` allowed, **a document fetched from the network can read local files through an absolute `file:` reference**. The base only decides what a relative reference means, so it does not help: an absolute reference ignores it.

```typescript
// The document served at https://specs.example.com/openapi.json contains:
//   { "$ref": "file:///home/dev/.config/app/secrets.json" }
const generator = await OpenAPIToolGenerator.fromURL("https://specs.example.com/openapi.json", {
  refResolution: { allowedProtocols: ["https", "file"] },
});
const [tool] = await generator.generateTools();
tool.outputSchema; // holds the contents of /home/dev/.config/app/secrets.json
```

The same happens with `fromJSON` and `fromYAML`. The contents of a JSON or YAML file become part of the dereferenced document and so of the generated tools, and a file that is neither (a text file) becomes a character-indexed object. This predates base URIs: `file` has always been a global switch, not scoped to documents read from disk.

What to do:

- **Do not allow `file` for documents you do not control.** The default options and `secureDefaults` never read a local file.
- Use one generator configuration per kind of source: allow `file` only for documents you read yourself with `fromFile` from a directory you trust, and load documents that come from the network or from users with the options you would use for any untrusted spec.
- If you must process an untrusted multi-file spec, bundle it into one document in a step that cannot see your filesystem, and give the library that one document.

A `fromJSON` or `fromYAML` document with `file` allowed reads files relative to the working directory, as before (or next to a `file:` `documentUri`, or `file:` `$self`, when it has one), so apply the same rule to documents you assemble from user input.

---

**Related:** [Security](./security.md) | [Configuration](./configuration.md) | [Getting Started](./getting-started.md) | [OpenAPI Versions](./openapi-versions.md)
