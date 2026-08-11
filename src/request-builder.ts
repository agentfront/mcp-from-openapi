import type { McpOpenAPITool, ParameterMapper } from './types';
import { RequestBuildError } from './errors';

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
 */
export interface BuiltHttpRequest {
  /** Fully composed URL: base + expanded path + encoded query string */
  url: string;

  /** Uppercase HTTP method */
  method: string;

  /**
   * Request headers, including a composed `Cookie` header (when cookie
   * parameters exist) and `content-type` (when the body is not multipart —
   * multipart bodies must let the HTTP client set the boundary itself).
   */
  headers: Record<string, string>;

  /** Query parameters as sent (unencoded values, one array per key) */
  query: Record<string, string[]>;

  /** Cookie parameters (also folded into the `Cookie` header) */
  cookies: Record<string, string>;

  /** Selected request body content type (also in headers, except multipart) */
  contentType?: string;

  /**
   * Serialized body ready for fetch: a JSON/form-urlencoded/text string, a
   * `FormData` for multipart, the raw value for binary bodies, or undefined.
   */
  body?: unknown;

  /** Structured body value before serialization (object/array/primitive) */
  rawBody?: unknown;
}

/** RFC 3986 reserved characters restored after encodeURIComponent when `allowReserved` is set */
const RESERVED_DECODE: Record<string, string> = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%23': '#', '%5B': '[', '%5D': ']',
  '%40': '@', '%24': '$', '%26': '&', '%2B': '+', '%2C': ',', '%3B': ';', '%3D': '=',
};

function encodeValue(value: string, allowReserved?: boolean): string {
  const encoded = encodeURIComponent(value);
  if (!allowReserved) return encoded;
  return encoded.replace(/%3A|%2F|%3F|%23|%5B|%5D|%40|%24|%26|%2B|%2C|%3B|%3D/gi, (m) => RESERVED_DECODE[m.toUpperCase()]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function primitiveString(value: unknown, paramName: string, location: string): string {
  if (value === null || value === undefined || typeof value === 'object') {
    throw new RequestBuildError(
      `${location} parameter '${paramName}' must serialize to a primitive; received ${
        value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value
      }`,
      { param: paramName, location },
    );
  }
  return String(value);
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
  const enc = (v: unknown) => encodeValue(primitiveString(v, name, 'path'));

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
        ? entries.map(([k, v]) => `.${encodeValue(k)}=${enc(v)}`).join('')
        : `.${entries.map(([k, v]) => `${encodeValue(k)},${enc(v)}`).join(',')}`;
    }
    if (style === 'matrix') {
      return explode
        ? entries.map(([k, v]) => `;${encodeValue(k)}=${enc(v)}`).join('')
        : `;${name}=${entries.map(([k, v]) => `${encodeValue(k)},${enc(v)}`).join(',')}`;
    }
    // simple
    return explode
      ? entries.map(([k, v]) => `${encodeValue(k)}=${enc(v)}`).join(',')
      : entries.map(([k, v]) => `${encodeValue(k)},${enc(v)}`).join(',');
  }

  const core = enc(value);
  if (style === 'label') return `.${core}`;
  if (style === 'matrix') return `;${name}=${core}`;
  return core;
}

/**
 * Serialize a QUERY parameter per its style/explode into `[key, value]`
 * pairs. Values are raw (unencoded); keys may gain deepObject brackets.
 */
function serializeQueryPairs(mapper: ParameterMapper, value: unknown): Array<[string, string]> {
  const style = mapper.style ?? 'form';
  const explode = mapper.explode ?? true;
  const name = mapper.key;
  const str = (v: unknown) => primitiveString(v, name, 'query');

  if (Array.isArray(value)) {
    if (explode || value.length === 0) {
      return value.map((v) => [name, str(v)] as [string, string]);
    }
    const delimiter = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
    return [[name, value.map(str).join(delimiter)]];
  }

  if (isPlainObject(value)) {
    if (style === 'deepObject') {
      // Recursive bracket notation: filter[author][name]=x (one level per the
      // spec; nesting is a widely-implemented extension)
      const pairs: Array<[string, string]> = [];
      const walk = (prefix: string, node: Record<string, unknown>): void => {
        for (const [k, v] of Object.entries(node)) {
          if (v === undefined) continue;
          if (isPlainObject(v)) {
            walk(`${prefix}[${k}]`, v);
          } else if (Array.isArray(v)) {
            for (const item of v) pairs.push([`${prefix}[${k}]`, str(item)]);
          } else {
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
      return entries.map(([k, v]) => [k, str(v)] as [string, string]);
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

function assertHeaderSafe(name: string, value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\x00]/.test(value)) {
    throw new RequestBuildError(`Header '${name}' value contains control characters (possible header injection)`, {
      header: name,
    });
  }
}

function assertCookieName(name: string): void {
  if (!/^[\w!#$%&'*+\-.^`|~]+$/.test(name)) {
    throw new RequestBuildError(`Invalid cookie name '${name}' (RFC 6265 token required)`, { cookie: name });
  }
}

/** Format a security value per its scheme (mirrors SecurityResolver output). */
function formatSecurityValue(mapper: ParameterMapper, value: string): string {
  const security = mapper.security!;
  if (security.type === 'http') {
    const scheme = security.httpScheme ?? 'bearer';
    const prefix = scheme.charAt(0).toUpperCase() + scheme.slice(1);
    return value.toLowerCase().startsWith(`${scheme.toLowerCase()} `) ? value : `${prefix} ${value}`;
  }
  if (security.type === 'oauth2' || security.type === 'openIdConnect') {
    return value.toLowerCase().startsWith('bearer ') ? value : `Bearer ${value}`;
  }
  return value; // apiKey and friends: raw
}

const JSON_CONTENT = /^application\/(.+\+)?json$/i;

/**
 * Build an HTTP request from a generated tool and its input values — the
 * mapper applied in full: style/explode serialization (form, spaceDelimited,
 * pipeDelimited, deepObject, simple, label, matrix), `allowReserved`,
 * whole-body and binary bodies, JSON / form-urlencoded / multipart / text
 * serialization, cookies, and header-injection guards.
 *
 * Pure function: nothing is sent, no runtime context is consulted. Security
 * mapper entries are applied only when their value is present in `input`
 * (with scheme-aware formatting); missing security values never throw —
 * frameworks resolve credentials separately (see SecurityResolver).
 */
export function buildHttpRequest(
  tool: McpOpenAPITool,
  input: Record<string, unknown>,
  options: BuildHttpRequestOptions = {},
): BuiltHttpRequest {
  const rawBase = options.baseUrl ?? tool.metadata.servers?.[0]?.url ?? '';
  if (rawBase !== '' && !/^https?:\/\//i.test(rawBase)) {
    throw new RequestBuildError(`Base URL must be http(s) or empty; received '${rawBase}'`, { baseUrl: rawBase });
  }
  let base = rawBase;
  while (base.endsWith('/')) base = base.slice(0, -1);

  let path = tool.metadata.path;
  const queryPairs: Array<[key: string, value: string, allowReserved?: boolean]> = [];
  const query: Record<string, string[]> = {};
  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  let rawBody: unknown;
  let bodyObject: Record<string, unknown> | undefined;
  let contentType: string | undefined;
  let hasBody = false;
  let binaryBody = false;

  for (const mapper of tool.mapper) {
    const value = input[mapper.inputKey];

    if (mapper.security) {
      // Security entries apply only when a value was provided; they are never
      // treated as required here (frameworks resolve credentials separately).
      if (value === undefined || value === null) continue;
      const formatted = formatSecurityValue(mapper, String(value));
      if (mapper.type === 'header') {
        assertHeaderSafe(mapper.key, formatted);
        headers[mapper.key] = formatted;
      } else if (mapper.type === 'query') {
        queryPairs.push([mapper.key, formatted]);
      } else {
        assertCookieName(mapper.key);
        cookies[mapper.key] = formatted;
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

    switch (mapper.type) {
      case 'path':
        path = path.replaceAll(`{${mapper.key}}`, serializePathValue(mapper, value));
        break;

      case 'query':
        for (const [k, v] of serializeQueryPairs(mapper, value)) {
          queryPairs.push([k, v, mapper.allowReserved]);
        }
        break;

      case 'header': {
        const headerValue = serializeHeaderValue(mapper, value);
        assertHeaderSafe(mapper.key, headerValue);
        headers[mapper.key] = headerValue;
        break;
      }

      case 'cookie': {
        assertCookieName(mapper.key);
        cookies[mapper.key] = Array.isArray(value)
          ? value.map((v) => primitiveString(v, mapper.key, 'cookie')).join(',')
          : primitiveString(value, mapper.key, 'cookie');
        break;
      }

      case 'body':
        hasBody = true;
        contentType = contentType ?? mapper.serialization?.contentType ?? 'application/json';
        if (mapper.serialization?.binary) binaryBody = true;
        if (mapper.wholeBody) {
          rawBody = value;
        } else {
          if (bodyObject === undefined) bodyObject = {};
          bodyObject[mapper.key] = value;
        }
        break;
    }
  }

  if (path.includes('{')) {
    throw new RequestBuildError(`Unresolved path parameters remain in '${path}'`, { path });
  }

  if (bodyObject !== undefined) rawBody = bodyObject;

  // Compose the query string (values encoded here; keys may carry deepObject
  // brackets which stay readable, with only unsafe characters escaped)
  const queryString = queryPairs
    .map(([k, v, allowReserved]) => {
      query[k] = query[k] ?? [];
      query[k].push(v);
      const encodedKey = encodeURIComponent(k).replace(/%5B/gi, '[').replace(/%5D/gi, ']');
      return `${encodedKey}=${encodeValue(v, allowReserved)}`;
    })
    .join('&');

  // Fold cookies into a single Cookie header
  const cookieEntries = Object.entries(cookies);
  if (cookieEntries.length > 0) {
    headers['Cookie'] = cookieEntries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }

  // Serialize the body per content type
  let body: unknown;
  if (hasBody && rawBody !== undefined) {
    const ct = contentType!;
    if (binaryBody) {
      // Raw binary: pass through untouched (string, Uint8Array, Blob, ...)
      body = rawBody;
      headers['content-type'] = headers['content-type'] ?? ct;
    } else if (ct.toLowerCase() === 'application/x-www-form-urlencoded') {
      const params = new URLSearchParams();
      if (!isPlainObject(rawBody)) {
        throw new RequestBuildError(`form-urlencoded bodies must be objects; received ${typeof rawBody}`, {
          contentType: ct,
        });
      }
      for (const [k, v] of Object.entries(rawBody)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) params.append(k, primitiveString(item, k, 'body'));
        } else {
          params.append(k, isPlainObject(v) ? JSON.stringify(v) : String(v));
        }
      }
      body = params.toString();
      headers['content-type'] = ct;
    } else if (ct.toLowerCase() === 'multipart/form-data') {
      /* c8 ignore next 3 -- FormData exists on Node >= 18; guard for exotic runtimes */
      if (typeof FormData === 'undefined') {
        throw new RequestBuildError('multipart/form-data requires a FormData implementation in this runtime', {});
      }
      const form = new FormData();
      if (!isPlainObject(rawBody)) {
        throw new RequestBuildError(`multipart bodies must be objects; received ${typeof rawBody}`, {
          contentType: ct,
        });
      }
      for (const [k, v] of Object.entries(rawBody)) {
        if (v === undefined) continue;
        if (typeof Blob !== 'undefined' && v instanceof Blob) {
          form.append(k, v);
        } else if (v instanceof Uint8Array) {
          form.append(k, new Blob([v]));
        } else if (isPlainObject(v) || Array.isArray(v)) {
          form.append(k, JSON.stringify(v));
        } else {
          form.append(k, String(v));
        }
      }
      body = form;
      // Do NOT set content-type: the HTTP client must add the boundary.
    } else if (JSON_CONTENT.test(ct)) {
      body = JSON.stringify(rawBody);
      headers['content-type'] = ct;
    } else {
      // text/plain, application/xml, ... : caller-provided string content
      body = isPlainObject(rawBody) || Array.isArray(rawBody) ? JSON.stringify(rawBody) : String(rawBody);
      headers['content-type'] = ct;
    }
  }

  return {
    url: `${base}${path}${queryString ? `?${queryString}` : ''}`,
    method: tool.metadata.method.toUpperCase(),
    headers,
    query,
    cookies,
    contentType,
    body,
    rawBody,
  };
}
