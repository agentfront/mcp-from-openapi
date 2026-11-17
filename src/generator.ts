import * as yaml from 'yaml';
// NOTE: `node:path` / `node:fs` are imported LAZILY inside `fromFile` (the only
// consumer) so this module stays importable on V8-isolate runtimes (Cloudflare
// Workers / Deno), where those builtins (and the `node:process` they pull) are
// unavailable. `fromJSON` / `fromYAML` / generation / `SecurityResolver` never
// touch the filesystem and therefore never load them.
import type {
  OpenAPIDocument,
  LoadOptions,
  RefResolutionOptions,
  GenerateOptions,
  McpOpenAPITool,
  ValidationResult,
  ValidationErrorDetail,
  ValidationWarning,
  HTTPMethod,
  ParameterObject,
  SecurityRequirement,
  AuthType,
  OperationObject,
  OperationWithContext,
  ParameterMapper,
  ToolMetadata,
  ServerObject,
  ServerInfo,
  PathItemObject,
  JsonSchema,
  ToolIcon,
  SecuritySchemeObject,
  ReferenceObject,
  ResponseStatusRange,
} from './types';
import { DIAGNOSTIC_CODES, MAX_DIAGNOSTICS } from './types';
import {
  appendPointer,
  describeValue,
  detectSpecVersion,
  getOperation,
  isFeatureAvailable,
  isSpecObject,
  jsonPointer,
  listOperations,
  ownProperty,
  parameterNameNotStringDiagnostic,
  readParameterName,
  resolveOperationLayout,
  toStandardMethod,
  MAX_CONVERSION_ENTRIES,
  upgradeSwagger2,
  wireMethod,
  diagnosticKey,
  type OperationEntry,
  type OperationLayout,
  type SpecDiagnostic,
  type SpecVersionInfo,
  type WithExtensions,
} from './spec';
import type { ParserOptions } from '@apidevtools/json-schema-ref-parser';
import { isNeverSchema, isPresentSchema, isReferenceObject } from './types';
import {
  ParameterResolver,
  analyzeParameters,
  describeContentWithoutSchema,
  isJsonMediaType,
  readParameterContent,
  selectRequestMediaType,
  type ParameterAnalysis,
  type ParameterSlot,
  type QuerystringProblem,
} from './parameter-resolver';
import { ResponseBuilder } from './response-builder';
import { SchemaBuilder, resolveSchemaLimits } from './schema-builder';
import {
  extractExtensionOverrides,
  extractExtensionSettings,
  inferAnnotationsFromMethod,
  isAllowedIconSrc,
  resolveExtensionEnabled,
} from './annotations';
import { applyClientTarget } from './client-targets';
import { applyOverlay } from './overlay';
import { lintDocument, PAGINATION_PARAM, type LintResult } from './lint';
import {
  Validator,
  duplicateParameterDiagnostic,
  messageText,
  operationLabel,
  operationPointer,
  parameterContentDiagnostics,
  skippedOperationDiagnostics,
  versionError,
} from './validator';
import { GenerationError, LoadError, OverlayError, ParseError, SchemaError, SsrfError } from './errors';
import { BUILTIN_FORMAT_RESOLVERS, resolveSchemaFormats } from './format-resolver';
import { emitToolTypeScript } from './type-signature';
import {
  hostListIncludes,
  isBlockedHostname,
  normalizeSsrfOptions,
  safeFetch,
  safeFetchWithFinalUrl,
} from './ssrf';
import {
  findRelativeReference,
  findSelfReferences,
  fragmentPointerTokens,
  parseDocumentUri,
  pointerTargetProblem,
  redactUserInfo,
  refParserScopesIds,
  userInfoOf,
  resolveDocumentBase,
  resolveSecuritySchemeUri,
  retrievalUriOf,
  type DocumentBase,
} from './base-uri';
import { copyJsonValue, type CopyBudget } from './json-copy';
import { classifyMediaType } from './media-type';

/** MCP hard limit for tool name length (spec revision 2025-11-25, SEP-986) */
const MCP_MAX_TOOL_NAME_LENGTH = 128;

/** Default tool name cap — the strictest common client limit (Claude/Bedrock: 64) */
const DEFAULT_MAX_TOOL_NAME_LENGTH = 64;

/**
 * Bound on collision-dedup retries. Generous for real specs (the first retry
 * almost always succeeds), but finite so a tiny `maxToolNameLength` whose
 * entire name space is exhausted fails loudly instead of looping forever.
 */
const MAX_NAME_DEDUP_ATTEMPTS = 256;

/**
 * Parameter locations the generator maps to a request (`querystring`, from
 * OpenAPI 3.2, as a whole-query `query` entry). A parameter in any other
 * location (a Swagger-style `body`, a missing `in`) would reach the mapper as
 * an entry no request builder understands, so its operation is skipped with a
 * `UNSUPPORTED_PARAMETER_LOCATION` diagnostic instead.
 */
const MAPPED_PARAMETER_LOCATIONS: readonly string[] = Object.freeze(['path', 'query', 'querystring', 'header', 'cookie']);

/**
 * Whether `method` (an operation's method as `listOperations` gives it)
 * passes a method filter: a standard method matches in any case (`'GET'`
 * matches `get`), an `additionalOperations` method only exactly as written.
 */
function matchesMethodFilter(filter: readonly string[], method: string): boolean {
  const standard = toStandardMethod(method);
  return filter.some((candidate) =>
    standard === undefined ? candidate === method : toStandardMethod(candidate) === standard,
  );
}

/**
 * Sets `key` as an own data property. Plain assignment of the key
 * `__proto__` replaces the object's prototype instead, so a document key
 * `__proto__` (which `JSON.parse` creates as an own property) would vanish
 * and its value's fields would be inherited by the object.
 */
function setOwnProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/** A validation warning as a diagnostic. */
function fromValidationWarning(warning: ValidationWarning): SpecDiagnostic {
  return {
    severity: 'warning',
    /* c8 ignore next -- the Validator gives every warning a code; the type leaves it optional */
    code: warning.code ?? 'VALIDATION_WARNING',
    message: warning.message,
    path: warning.path,
  };
}

/**
 * The most dropped findings remembered (by their bounded `diagnosticKey`) so
 * a finding found again is not counted twice in `DIAGNOSTICS_TRUNCATED`;
 * past it, a finding found again counts again.
 */
const MAX_DROPPED_KEYS = 10_000;

/** Longest stretch of the first validation error quoted in a `ParseError` message. */
const PARSE_ERROR_DETAIL_MAX_LENGTH = 512;

/**
 * `Invalid OpenAPI document: <first error>`, counting the rest. The first
 * error's message can quote the document, so it is cut and escaped; every
 * error stays in full in the `ParseError`'s `context.errors`.
 */
function invalidDocumentMessage(errors: ValidationErrorDetail[]): string {
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more; see the error's context.errors)` : '';
  return `Invalid OpenAPI document: ${messageText(errors[0].message, PARSE_ERROR_DETAIL_MAX_LENGTH)}${more}`;
}

/**
 * A key of bounded length for a path string: a `Set` of long strings of one
 * length hashes them into one bucket (V8 hashes a string past 16,383
 * characters by its length).
 */
function pathKey(path: string): string {
  return diagnosticKey({ severity: 'info', code: '', message: path });
}

/**
 * Errors thrown for an operation that is skipped on purpose, with a
 * diagnostic already recorded: `generateTools` leaves them out silently
 * instead of warning.
 */
const skippedOperations = new WeakSet<object>();

/**
 * Apply the `secureDefaults` load preset: redirects off, external `$ref`
 * resolution disabled. Explicitly-set options always win over the preset.
 */
function applySecureDefaults(options: LoadOptions): LoadOptions {
  if (!options.secureDefaults) return options;
  return {
    ...options,
    followRedirects: options.followRedirects ?? false,
    // Merge PER KEY: a user tightening one refResolution knob (e.g.
    // blockedHosts) must not silently discard the preset's external-$ref
    // lockdown. A DEFINED allowedProtocols still wins — but an explicitly
    // undefined one (programmatic option building) must not defeat the
    // preset via object spread copying undefined-valued keys.
    refResolution: {
      ...options.refResolution,
      allowedProtocols: options.refResolution?.allowedProtocols ?? [],
    },
  };
}

/** What `$RefParser` tells a resolver about a document it needs (a subset of its `FileInfo`). */
interface RefTarget {
  /** The resolved URL, without fragment; a local path when it has no `<scheme>://` */
  url: string;
  /** The `$ref` as written, without fragment */
  reference?: string;
  /** What `reference` was resolved against; may end with the JSON Pointer of the `$ref` */
  baseUrl?: string;
}

/** The part of `$RefParser`'s `$Refs` a resolver reads: where the entry document is. */
interface RefParserRefs {
  _root$Ref?: { path?: string };
}

/** Longest stretch of a reference, base or URL quoted in a dereference error. */
const REF_TEXT_MAX_LENGTH = 256;

/** Longest dereference failure quoted in a `ParseError` message. */
const DEREFERENCE_ERROR_MAX_LENGTH = 2048;

/** How every dereference failure's `ParseError` message starts. */
const DEREFERENCE_ERROR_PREFIX = 'Failed to dereference OpenAPI document: ';

/**
 * Whether `$RefParser` reads `url` as a local file: it has no
 * `<scheme>://` prefix (of two or more characters), or its scheme is
 * `file`. Mirrors the resolver's own test, so the decision of which
 * resolver reads a reference stays the one it always was.
 */
function isLocalFileRef(url: string): boolean {
  const scheme = /^(\w{2,}):\/\//.exec(url);
  return scheme === null || scheme[1].toLowerCase() === 'file';
}

/**
 * Why a reference could not be read: `ParseError.context.rule` of a failed
 * dereference, one of
 *
 * - refused before any request: `protocol` (not in
 *   `refResolution.allowedProtocols`; a local path counts as `file`),
 *   `host-not-allowed` (not in `allowedHosts`), `host-blocked` (in
 *   `blockedHosts`), `internal-address` (an internal name or literal address);
 * - while fetching: `resolved-address` (the name resolves to an internal
 *   address), `dns-failed`, `too-large` (the body exceeds the limit),
 *   `timeout`, `response` (an HTTP error status), `fetch-failed` (anything
 *   else, such as a refused connection);
 * - while reading a file: `file-error`;
 * - in a document: `missing-target` (a pointer that leads nowhere),
 *   `invalid-document` (a referenced document that is not JSON or YAML),
 *   `base-too-long` (a relative reference in a document whose retrieval URI
 *   is too long to be used);
 * - `unreadable`: any other failure.
 */
type RefRule =
  | 'protocol'
  | 'host-not-allowed'
  | 'host-blocked'
  | 'internal-address'
  | 'resolved-address'
  | 'dns-failed'
  | 'too-large'
  | 'timeout'
  | 'response'
  | 'fetch-failed'
  | 'file-error'
  | 'missing-target'
  | 'invalid-document'
  | 'base-too-long'
  | 'unreadable';

/** Why a reference cannot be read, for `ExternalRefError`. */
interface RefRefusal {
  /** Which rule refused it */
  rule: RefRule;
  /** What is wrong, in a sentence fragment */
  reason: string;
  /** The option that would allow it, when one would */
  allow?: string;
}

/** The ref policy `explainUnreadableRef` reads. */
interface RefPolicy {
  allowedProtocols: ReadonlySet<string>;
  allowedHosts: string[];
  blockedHosts: string[];
  allowInternalIPs: boolean;
}

/**
 * Why no resolver may read `url`: its protocol is not in
 * `allowedProtocols` (a local path counts as `file`), its host is not in
 * `allowedHosts`, it is in `blockedHosts`, or it is an internal address.
 */
function explainUnreadableRef(url: string, policy: RefPolicy): RefRefusal {
  const allowed = [...policy.allowedProtocols].map((protocol) => describeValue(protocol, 32)).join(', ');
  const scheme = /^(\w{2,}):\/\//.exec(url);
  const protocol = scheme === null ? 'file' : scheme[1].toLowerCase();
  if (!policy.allowedProtocols.has(protocol)) {
    return {
      rule: 'protocol',
      reason:
        protocol === 'file'
          ? `it is read as a local file, and refResolution.allowedProtocols (${allowed}) does not include "file"`
          : `its protocol ${describeValue(protocol, 32)} is not in refResolution.allowedProtocols (${allowed})`,
      allow: `add ${describeValue(protocol, 32)} to refResolution.allowedProtocols to read it`,
    };
  }
  // An allowed `file` reference is the file resolver's, never refused
  const parsed = parseUrl(url);
  if (parsed === undefined) return { rule: 'unreadable', reason: 'it is not a valid URL' };
  const host = describeValue(parsed.hostname, REF_TEXT_MAX_LENGTH);
  if (policy.allowedHosts.length > 0 && !hostListIncludes(policy.allowedHosts, parsed.hostname)) {
    return {
      rule: 'host-not-allowed',
      reason: `its host ${host} is not in refResolution.allowedHosts`,
      allow: 'add the host to refResolution.allowedHosts to read it',
    };
  }
  if (hostListIncludes(policy.blockedHosts, parsed.hostname)) {
    return { rule: 'host-blocked', reason: `its host ${host} is in refResolution.blockedHosts` };
  }
  // The http resolver's canRead refuses an allowed protocol for no other reason
  /* c8 ignore next 3 -- defensive */
  if (!isBlockedHostname(parsed.hostname, policy)) {
    return { rule: 'unreadable', reason: 'no resolver can read it' };
  }
  return {
    rule: 'internal-address',
    reason: `its host ${host} is an internal address (loopback, private, link-local or cloud metadata)`,
    allow: 'refResolution.allowInternalIPs would allow it (unsafe for documents you do not trust)',
  };
}

/** The rule of each `SsrfError.context.reason` the guard can give while fetching a reference. */
const SSRF_REASON_RULES: ReadonlyMap<unknown, RefRule> = new Map<unknown, RefRule>([
  ['protocol', 'protocol'],
  ['host-not-allowed', 'host-not-allowed'],
  ['host-blocked', 'host-blocked'],
  ['internal-address', 'internal-address'],
  ['resolved-address', 'resolved-address'],
  ['dns-failed', 'dns-failed'],
  ['too-large', 'too-large'],
]);

/** Why fetching a reference failed, from the error the fetch threw. */
function fetchFailure(error: unknown, timeoutMs: number): RefRefusal {
  // By name and fields: Node's own errors can come from another realm, where `instanceof Error` is false
  const { name, message } = Object(error) as { name?: unknown; message?: unknown };
  if (error instanceof SsrfError) {
    // Every reason the guard gives for an allowed URL has a rule; the others cannot happen here
    const rule = SSRF_REASON_RULES.get(error.context?.['reason']);
    /* c8 ignore next */
    return { rule: rule ?? 'fetch-failed', reason: messageText(error.message, REF_TEXT_MAX_LENGTH) };
  }
  if (name === 'AbortError') {
    return { rule: 'timeout', reason: `no answer within ${timeoutMs} ms (LoadOptions.timeout)` };
  }
  return { rule: 'fetch-failed', reason: messageText(String(message), REF_TEXT_MAX_LENGTH) };
}

/** `new URL(url)`, or `undefined` when it does not parse. */
function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * `url` with its query shown as `?...`: a spec URL can carry a token there,
 * and a relative reference never inherits it. The fragment is kept.
 */
function withoutQuery(url: string): string {
  return url.replace(/\?[^#]*/s, '?...');
}

/**
 * An external reference that cannot be read, thrown from a `$RefParser`
 * resolver (and carried out as the `cause` of its error) or before it runs:
 * its message names the reference, where it is, the base it was resolved
 * against, the URL it resolved to, the rule that refused it and the option
 * that would allow it. A document controls all of it, so each is quoted
 * bounded and escaped, in the message and in `details`; the query of a base
 * or resolved URL is not shown.
 */
class ExternalRefError extends Error {
  /** For `ParseError.context`: every string bounded and escaped */
  readonly details: { rule: RefRule; reference?: string; base?: string; resolved: string };
  /** JSON Pointer of the `$ref` when it is in the entry document, for `validate()` */
  readonly pointer?: string;

  constructor(
    target: RefTarget,
    refusal: RefRefusal,
    options: { documentHasBase: boolean; location?: readonly string[] },
  ) {
    const hash = target.baseUrl?.indexOf('#') ?? -1;
    const at =
      options.location !== undefined
        ? `#${jsonPointer(...options.location)}`
        : hash === -1
          ? ''
          : (target.baseUrl as string).slice(hash);
    const base = (hash === -1 ? target.baseUrl : target.baseUrl?.slice(0, hash))?.replace(/\?.*$/s, '?...');
    // A reference can carry user information, which may be a real credential: never quoted, also where
    // resolving moved it into a path (`https:u:p@h/x` read as the local file `<cwd>/u:p@h/x`)
    const secrets = target.reference === undefined ? [] : userInfoOf(target.reference);
    const scrub = (text: string): string =>
      secrets.reduce((scrubbed, secret) => scrubbed.split(secret).join('***'), redactUserInfo(text));
    const resolved = scrub(withoutQuery(target.url));
    const reference = target.reference === undefined ? undefined : redactUserInfo(target.reference);
    const quote = (text: string): string => describeValue(text, REF_TEXT_MAX_LENGTH);
    const what =
      reference === undefined
        ? `external $ref ${quote(resolved)}`
        : `$ref ${quote(reference)}${at === '' || at === '#' ? '' : ` at ${quote(at)}`}` +
          `${base === undefined ? '' : ` resolved against ${quote(base)}`} to ${quote(resolved)}`;
    // A relative reference of a document that has no base URI resolves against the working directory
    const relative = reference !== undefined && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(reference);
    const hint =
      !options.documentHasBase && relative
        ? ' (the document has no base URI, so its relative references resolve against the working directory: ' +
          'load it with fromFile or fromURL, or pass LoadOptions.documentUri)'
        : '';
    super(`Cannot read ${what}: ${refusal.reason}${refusal.allow === undefined ? '' : `; ${refusal.allow}`}${hint}`);
    this.name = 'ExternalRefError';
    const bounded = (text: string): string => messageText(text, REF_TEXT_MAX_LENGTH);
    this.details = {
      rule: refusal.rule,
      ...(reference === undefined ? {} : { reference: bounded(reference) }),
      ...(base === undefined ? {} : { base: bounded(base) }),
      resolved: bounded(resolved),
    };
    if (options.location !== undefined) this.pointer = jsonPointer(...options.location);
  }
}

/** The error classes of `$RefParser` that `dereferenceError` tells apart. */
interface RefParserErrorClasses {
  ParserError?: new (...args: never[]) => Error;
  MissingPointerError?: new (...args: never[]) => Error;
  InvalidPointerError?: new (...args: never[]) => Error;
}

/**
 * The `ParseError` for a failed dereference: `Failed to dereference OpenAPI
 * document: <why>`, cut and escaped (it can quote the document), with
 * `context.rule` (see `RefRule`). An `ExternalRefError` anywhere in the
 * `cause` chain gives the message and the rest of `context` (`reference`,
 * `base`, `resolved`, and `path`, the JSON Pointer of the `$ref` when it is
 * in the entry document), each bounded and escaped; no raw error is kept.
 */
function dereferenceError(error: unknown, classes: RefParserErrorClasses = {}): ParseError {
  let refError: ExternalRefError | undefined;
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 8; depth++) {
    if (cause instanceof ExternalRefError) {
      refError = cause;
      break;
    }
    cause = cause.cause;
  }
  if (refError !== undefined) {
    return new ParseError(`${DEREFERENCE_ERROR_PREFIX}${messageText(refError.message, DEREFERENCE_ERROR_MAX_LENGTH)}`, {
      ...refError.details,
      ...(refError.pointer === undefined ? {} : { path: refError.pointer }),
    });
  }
  const is = (kind: RefParserErrorClasses[keyof RefParserErrorClasses]): boolean =>
    kind !== undefined && error instanceof kind;
  const rule: RefRule = is(classes.ParserError)
    ? 'invalid-document'
    : is(classes.MissingPointerError) || is(classes.InvalidPointerError)
      ? 'missing-target'
      : 'unreadable';
  const detail = error instanceof Error ? error.message : String(error);
  return new ParseError(`${DEREFERENCE_ERROR_PREFIX}${messageText(detail, DEREFERENCE_ERROR_MAX_LENGTH)}`, { rule });
}

/** The copy of a document that is dereferenced (see `OpenAPIToolGenerator.prepare`). */
interface PreparedDocument {
  copy: OpenAPIDocument;
  /** Whether a `$ref` to another document remains */
  external: boolean;
  /** Each reference to the document's own URI, by its `$ref` object: the reference tokens of its target */
  exact: ReadonlyMap<object, readonly string[]>;
}

/** Waits for the next turn of the event loop, after every pending promise reaction has run. */
const nextTurn = (): Promise<void> =>
  /* c8 ignore next -- `$RefParser` runs on Node, which has setImmediate */
  new Promise((resolve) => (typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0)));

/** The reads of one dereference (see {@link orderedReads}). */
interface OrderedReads {
  /** Starts `read` (unless reading has stopped) and delivers its result in the order asked. */
  read: <T>(read: () => Promise<T>) => Promise<T>;
  /**
   * Stops reading: no read asked from now on is started. Resolves once every
   * read already started has ended, so a failed dereference leaves no
   * request or file read running after it settles.
   */
  settle(): Promise<void>;
}

const ignore = (): void => undefined;

/**
 * Wraps the reads of one dereference so their results are delivered in the
 * order they were asked for, one per turn of the event loop, while the reads
 * themselves run in parallel. `$RefParser` asks in document order (the entry
 * document's references depth-first, then each document's as it is parsed),
 * so the first reference that cannot be read is always the one reported,
 * whatever order the network or the disk answers in. Once one fails, reads
 * asked for later are not started; neither are they once `settle` is called
 * (the dereference failed some other way: a document that does not parse).
 */
function orderedReads(): OrderedReads {
  let tail: Promise<unknown> = Promise.resolve();
  let failed = false;
  const started: Array<Promise<void>> = [];
  return {
    read: <T>(read: () => Promise<T>): Promise<T> => {
      const reading = failed ? Promise.reject(new Error('Not read: an earlier reference could not be read')) : read();
      if (!failed) started.push(reading.then(ignore, ignore));
      reading.catch(ignore);
      const delivered = tail.then(() => reading);
      delivered.catch(() => {
        failed = true;
      });
      tail = delivered.then(nextTurn, nextTurn);
      return delivered;
    },
    settle: async () => {
      failed = true;
      await Promise.all(started);
    },
  };
}

/** Does the schema tree contain an array without maxItems? Cycle-safe. */
function hasUnboundedArray(node: unknown, seen = new Set<unknown>()): boolean {
  /* c8 ignore next -- seen-guard is defensive: ResponseBuilder output cannot be circular */
  if (node === null || typeof node !== 'object' || seen.has(node)) return false;
  seen.add(node);
  const record = node as Record<string, unknown>;

  const type = record['type'];
  const isArray = type === 'array' || (Array.isArray(type) && type.includes('array'));
  if (isArray && record['maxItems'] === undefined) return true;

  const children: unknown[] = [];
  const properties = record['properties'];
  if (properties && typeof properties === 'object') children.push(...Object.values(properties));
  for (const key of ['items', 'additionalProperties', 'contentSchema']) {
    const value = record[key];
    if (Array.isArray(value)) children.push(...value); // tuple-style items
    else if (value && typeof value === 'object') children.push(value);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(record[key])) children.push(...(record[key] as unknown[]));
  }
  return children.some((child) => hasUnboundedArray(child, seen));
}

/**
 * Compute response-shaping hints; undefined when there is nothing to say.
 * `streaming`: the operation has a streamed response (`responseStream`).
 */
function detectResponseHints(
  outputSchema: JsonSchema | undefined,
  mapper: McpOpenAPITool['mapper'],
  streaming: boolean,
): ToolMetadata['responseHints'] {
  // A whole-query parameter's key is not sent, so it never names a pagination control
  const paginationParams = [
    ...new Set(
      mapper
        .filter((m) => m.type === 'query' && !m.security && !m.wholeQuery && PAGINATION_PARAM.test(m.key))
        .map((m) => m.key),
    ),
  ];
  const unboundedArray = outputSchema !== undefined && hasUnboundedArray(outputSchema);

  if (!unboundedArray && paginationParams.length === 0 && !streaming) return undefined;

  return {
    ...(unboundedArray && { unboundedArray: true }),
    ...(paginationParams.length > 0 && { paginationParams }),
    ...(unboundedArray && paginationParams.length === 0 && { largeResponseRisk: true }),
    ...(streaming && { streaming: true }),
  };
}

/**
 * Whether a schema allows only JSON numbers, booleans and `null`: its
 * `type` is one of `number`, `integer`, `boolean`, `null`, or a list of
 * them. Without a `type` (or for `true`) anything is allowed; `false`
 * allows nothing, so nothing a cookie cannot carry.
 */
function onlyScalarJson(schema: unknown): boolean {
  if (schema === false) return true;
  const type = ownProperty(schema, 'type');
  const types: unknown[] | undefined = typeof type === 'string' ? [type] : Array.isArray(type) ? type : undefined;
  return (
    types !== undefined &&
    types.length > 0 &&
    types.every((t) => t === 'number' || t === 'integer' || t === 'boolean' || t === 'null')
  );
}

/** Assemble the tool description per the configured strategy. */
function composeDescription(
  operation: OperationObject,
  method: string,
  pathStr: string,
  strategy: 'summaryOnly' | 'descriptionOnly' | 'combined' | 'full',
): string {
  // The method as sent: a standard one upper-cased, an additional one as written
  const fallback = `${wireMethod(method)} ${pathStr}`;
  const summary = operation.summary?.trim();
  const description = operation.description?.trim();

  switch (strategy) {
    case 'descriptionOnly':
      return description || summary || fallback;
    case 'combined':
      if (summary && description && summary !== description) {
        return `${summary}\n\n${description}`;
      }
      return summary || description || fallback;
    case 'full': {
      const parts: string[] = [];
      if (summary) parts.push(summary);
      if (description && description !== summary) parts.push(description);
      if (operation.operationId) parts.push(`Operation: ${operation.operationId}`);
      parts.push(fallback);
      return parts.join('\n\n');
    }
    default:
      return summary || description || fallback;
  }
}

/** Names of an object schema's properties, capped for prose use. */
function propertyNames(schema: Record<string, unknown>, cap = 8): string {
  const properties = schema['properties'];
  /* c8 ignore next -- callers verify properties exist before delegating here */
  if (!properties || typeof properties !== 'object') return '';
  const names = Object.keys(properties);
  const listed = names.slice(0, cap).join(', ');
  return names.length > cap ? `${listed}, …` : listed;
}

/**
 * One-line summary of an output schema for description appending: top-level
 * shape plus field names, never the full schema.
 */
function summarizeOutputSchema(schema: JsonSchema): string | undefined {
  const record = schema as Record<string, unknown>;

  const variants = record['oneOf'];
  if (Array.isArray(variants) && variants.length > 0) {
    const first = variants[0];
    /* c8 ignore next 2 -- ResponseBuilder variants are always objects; guard for hand-built schemas */
    const firstSummary =
      first && typeof first === 'object' ? summarizeOutputSchema(first as JsonSchema) : undefined;
    return firstSummary ? `${firstSummary} (${variants.length} response variants)` : undefined;
  }

  const type = record['type'];
  if (type === 'object' || (type === undefined && record['properties'])) {
    const names = propertyNames(record);
    return names ? `object with fields: ${names}` : 'object';
  }
  if (type === 'array') {
    const items = record['items'];
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      const itemRecord = items as Record<string, unknown>;
      if (itemRecord['type'] === 'object' || itemRecord['properties']) {
        const names = propertyNames(itemRecord);
        return names ? `array of objects with fields: ${names}` : 'array of objects';
      }
      if (typeof itemRecord['type'] === 'string') {
        return `array of ${itemRecord['type']}`;
      }
    }
    return 'array';
  }
  if (typeof type === 'string' && type !== 'null') {
    return type;
  }
  // type 'null' (a no-content response) or no recognizable shape: say nothing
  return undefined;
}

/**
 * Convert a path glob to a RegExp: `*` matches within one path segment,
 * `**` across segments, `?` a single non-slash character.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i++;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`);
}

function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * Trim leading/trailing underscores without regex — `/_+$/`-style trailing
 * repetition is polynomial on adversarial inputs (CodeQL js/polynomial-redos),
 * and tool names derive from uncontrolled spec data.
 */
/**
 * Map the document's `info['x-logo']` (Redoc convention: a URL string or an
 * object with `url`) to a single tool icon.
 */
function iconsFromInfoLogo(info: unknown): ToolIcon[] | undefined {
  if (!info || typeof info !== 'object') {
    return undefined;
  }
  const logo = (info as WithExtensions)['x-logo'];
  let src: string | undefined;
  if (typeof logo === 'string') {
    src = logo;
  } else if (logo && typeof logo === 'object' && !Array.isArray(logo)) {
    const url = (logo as Record<string, unknown>)['url'];
    if (typeof url === 'string') {
      src = url;
    }
  }
  // Same scheme contract as extension icons (https:/data: only)
  if (src !== undefined && isAllowedIconSrc(src)) {
    return [{ src }];
  }
  return undefined;
}

function trimUnderscores(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '_') start++;
  while (end > start && value[end - 1] === '_') end--;
  return value.slice(start, end);
}

/**
 * 32-bit FNV-1a hash rendered as 8 hex chars. Used for stable, content-derived
 * name suffixes (no Node `crypto` dependency, so V8-isolate runtimes work).
 */
export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Sanitize and cap a tool name per MCP rules: only `[A-Za-z0-9_.-]`, 1-128
 * chars. Invalid characters become underscores (collapsed); names longer than
 * `maxLength` are truncated with a hash suffix derived from the FULL original
 * name, keeping truncated names unique and stable across regenerations.
 * `fallbackSeed` names the operation (method + path) when sanitization leaves
 * nothing usable.
 */
export function normalizeToolName(raw: string, maxLength: number, fallbackSeed: string): string {
  // Hash the RAW name, not the sanitized one: two raws differing only in
  // invalid characters must not collapse to the same truncation suffix.
  let hashSeed = raw;
  let name = trimUnderscores(raw.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/_+/g, '_'));

  if (name.length === 0) {
    hashSeed = fallbackSeed;
    name = `tool_${fnv1aHex(fallbackSeed)}`;
  }

  const cap = Math.min(Math.max(1, maxLength), MCP_MAX_TOOL_NAME_LENGTH);
  if (name.length > cap) {
    // 9 = '_' + 8-char hash. Below that there is no room for a readable base.
    if (cap >= 13) {
      name = `${name.slice(0, cap - 9)}_${fnv1aHex(hashSeed)}`;
    } else {
      name = fnv1aHex(hashSeed).slice(0, cap);
    }
  }

  return name;
}

/**
 * Main class for generating MCP tools from OpenAPI specifications
 */
export class OpenAPIToolGenerator {
  /** The document as loaded, after overlays */
  private document: OpenAPIDocument;
  /** `document` dereferenced, still in its declared version (Swagger 2.0 included) */
  private dereferencedDocument?: OpenAPIDocument;
  /**
   * Swagger 2.0 only: `dereferencedDocument` converted to OpenAPI 3.0
   * (`upgradeSwagger2`), the document generation and lint read
   */
  private upgradedDocument?: OpenAPIDocument;
  /** The document declares Swagger 2.0: it is converted to OpenAPI 3.0 once dereferenced */
  private readonly swagger: boolean;
  /** The dereference in progress, so concurrent callers share one (and its fetches) */
  private dereferencing?: Promise<void>;
  private options: Required<Omit<LoadOptions, 'overlays' | 'documentUri'>> & Pick<LoadOptions, 'overlays'>;
  /** The version the document declares, read once after overlays apply */
  private readonly specVersion: SpecVersionInfo;
  /**
   * The document's URIs (retrieval URI, `$self`), read once after overlays
   * apply; `undefined` when it has none, and then references resolve as in
   * earlier releases (relative ones against the working directory)
   */
  private readonly documentBase?: DocumentBase;
  /** The operation fields read: those the declared version defines (`resolveOperationLayout`) */
  private readonly operationLayout: OperationLayout;
  /** Validation of the (dereferenced) document: the document never changes after load, so it runs once */
  private validation?: Promise<ValidationResult>;
  /** Diagnostics in the order first noticed, keyed by `diagnosticKey`; at most `MAX_DIAGNOSTICS` */
  private readonly diagnostics = new Map<string, SpecDiagnostic>();
  /** The keys of the `info` entries of `diagnostics`, in the order recorded: a warning can take the last one's place */
  private readonly infoKeys: string[] = [];
  /** Findings not recorded because the list was full, by severity */
  private readonly dropped = { warning: 0, info: 0 };
  /** Keys of the findings counted in `dropped`, so one found again is not counted twice (bounded) */
  private readonly droppedKeys = new Set<string>();
  /** Swagger 2.0: the source index of each entry of a converted `parameters` list (`upgradeSwagger2`) */
  private parameterIndexes?: WeakMap<object, readonly number[]>;
  /** Swagger 2.0: why the document could not be converted, once that is known */
  private upgradeError?: ParseError;
  /** Paths (`pathKey`) whose Path Item diagnostics are recorded */
  private readonly walkedPaths = new Set<string>();

  /**
   * Private constructor - use static factory methods to create instances.
   * `retrievalUri` is where the factory read the document (absolute, without
   * user information or fragment); `LoadOptions.documentUri` replaces it.
   */
  private constructor(document: OpenAPIDocument, rawOptions: LoadOptions = {}, retrievalUri?: string) {
    this.document = document;
    const options = applySecureDefaults(rawOptions);
    // Checked before anything else: a bad option fails the load, whatever the document
    const documentUri = options.documentUri === undefined ? retrievalUri : parseDocumentUri(options.documentUri);
    this.options = {
      dereference: options.dereference ?? true,
      baseUrl: options.baseUrl ?? '',
      headers: options.headers ?? {},
      timeout: options.timeout ?? 30000,
      validate: options.validate ?? true,
      followRedirects: options.followRedirects ?? true,
      refResolution: options.refResolution ?? {},
      secureDefaults: options.secureDefaults ?? false,
      overlays: options.overlays,
    };

    // Overlays apply EAGERLY (they are synchronous): validate(), lint(),
    // getDocument(), and generation must all agree on one curated document —
    // a lazily-applied overlay would make a getter's result depend on which
    // other method ran first.
    if (this.options.overlays) {
      const overlays = Array.isArray(this.options.overlays) ? this.options.overlays : [this.options.overlays];
      for (const overlay of overlays) {
        this.document = applyOverlay(this.document, overlay);
      }
    }

    // The declared version: its warnings (a newer 3.x minor, conflicting
    // version fields), and why it cannot be processed if it cannot — an error
    // when validation runs, a warning to read when `validate: false` skips it
    this.specVersion = detectSpecVersion(this.document);
    this.swagger = this.specVersion.family === '2.0';
    this.operationLayout = resolveOperationLayout(this.specVersion);
    for (const diagnostic of this.specVersion.diagnostics) this.addDiagnostic(diagnostic);
    const problem = versionError(this.specVersion);
    if (problem !== undefined) this.addDiagnostic(fromValidationWarning(problem));

    // The base URI: `$self` (3.2+) resolved against the retrieval URI, or the
    // retrieval URI; why `$self` is not used, when it is not
    const base = resolveDocumentBase(this.document, this.specVersion, documentUri);
    this.documentBase = base.base;
    for (const diagnostic of base.diagnostics) this.addDiagnostic(diagnostic);
  }

  /**
   * Records a diagnostic once: a finding reported twice (by the validator and
   * again while generating, or once per tool for a document-level value) is
   * kept at its first position. Past `MAX_DIAGNOSTICS`, new findings are
   * dropped and `getDiagnostics()` ends with `DIAGNOSTICS_TRUNCATED`.
   */
  private addDiagnostic(diagnostic: SpecDiagnostic): void {
    const key = diagnosticKey(diagnostic);
    if (this.diagnostics.has(key)) return;
    if (this.diagnostics.size >= MAX_DIAGNOSTICS) {
      // Full: a warning takes the place of the latest info, if there is one; an info is not recorded
      const evicted = diagnostic.severity === 'info' ? undefined : this.infoKeys.pop();
      if (evicted === undefined) {
        this.countDropped(key, diagnostic.severity);
        return;
      }
      this.countDropped(evicted, 'info');
      this.diagnostics.delete(evicted);
    }
    // For Swagger 2.0, which of its two documents `path` points into (the 2.0 one unless the caller says otherwise)
    const entry = { ...diagnostic };
    if (this.swagger && entry.path !== undefined) entry.document ??= 'source';
    this.diagnostics.set(key, entry);
    if (entry.severity === 'info') this.infoKeys.push(key);
  }

  /** Counts a finding left out of the full list, once per finding as far as `MAX_DROPPED_KEYS` allows. */
  private countDropped(key: string, severity: SpecDiagnostic['severity']): void {
    if (this.droppedKeys.has(key)) return;
    if (this.droppedKeys.size < MAX_DROPPED_KEYS) this.droppedKeys.add(key);
    this.dropped[severity]++;
  }

  /**
   * What the generator noticed about the document without failing, in the
   * order first noticed, each finding once (`DIAGNOSTIC_CODES` lists every
   * code). It grows as the generator works:
   *
   * 1. at load: the declared version (`NEWER_OPENAPI_VERSION` for a 3.x minor
   *    newer than 3.2, `CONFLICTING_VERSION_FIELDS`, and
   *    `INVALID_OPENAPI_VERSION` / `MISSING_OPENAPI_VERSION` for a version that
   *    validation rejects — useful with `validate: false`), and why `$self`
   *    is not used when it is present and ignored (`INVALID_SELF`,
   *    `REFUSED_SELF`, `UNRESOLVABLE_SELF`, or
   *    `FEATURE_NEWER_THAN_DECLARED_VERSION` in a 3.0 or 3.1 document), and
   *    `BASE_URI_TOO_LONG` when the URI the document was retrieved from is
   *    too long to be used;
   * 2. at the first generation with validation on: the validator's warnings
   *    (`NO_OPERATION_ID`, `NO_SERVERS`, `FEATURE_NEWER_THAN_DECLARED_VERSION`,
   *    ...). Validation errors never reach it: they throw `ParseError`.
   *    Validation runs once per generator and is not re-run if the document
   *    returned by `getDocument()` is changed;
   * 2b. for a Swagger 2.0 document, at the first generation or `lint()`
   *    (after validation): what its conversion to OpenAPI 3.0 could not
   *    carry over exactly, with the `SWAGGER_*` codes (`upgradeSwagger2`), and
   *    a `FEATURE_NEWER_THAN_DECLARED_VERSION` for a `trace`, `query` or
   *    `additionalOperations` field, which Swagger 2.0 does not have. Their
   *    `path` points into the 2.0 document as written;
   * 3. while generating — `generateTools()` for every path, `generateTool()`
   *    (and Arazzo steps, which use it) for the path item and operation it
   *    builds:
   *    - the operation walker's findings, each a value generation ignores
   *      (`PATH_ITEM_NOT_OBJECT`, `OPERATION_NOT_OBJECT`,
   *      `ADDITIONAL_OPERATIONS_NOT_OBJECT`, `INVALID_METHOD_TOKEN`,
   *      `DUPLICATE_FIXED_METHOD`, `METHOD_CASE_VARIANT`, `REFUSED_METHOD`);
   *    - `FEATURE_NEWER_THAN_DECLARED_VERSION` for a `query` operation or
   *      `additionalOperations` in a document declaring 3.0 or 3.1: they are
   *      read only from 3.2 on, so they make no tool;
   *    - `UNRESOLVED_SECURITY_SCHEME` / `INVALID_SECURITY_REQUIREMENT`: a
   *      Security Requirement that cannot be satisfied (it names a scheme
   *      `components.securitySchemes` does not define, or by URI a scheme
   *      that is not one of this document's, or it is not an object) is
   *      dropped; when every requirement of an operation is dropped,
   *      `UNSATISFIABLE_SECURITY` and the operation makes no tool;
   *    - `UNSUPPORTED_PARAMETER_LOCATION`: an operation has a parameter in a
   *      location the generator does not map (a Swagger-style `body`, a
   *      missing `in`); the operation makes no tool;
   *    - `MULTIPLE_QUERYSTRING_PARAMETERS`, `QUERYSTRING_WITH_QUERY_PARAMETERS`,
   *      `QUERYSTRING_PARAMETER_WITHOUT_CONTENT`: an operation's parameters
   *      break an OpenAPI 3.2 querystring rule the validator rejects (seen
   *      with `validate: false`); the operation makes no tool;
   *    - `DUPLICATE_PARAMETER`: a parameter list repeats a `name` and `in`; the
   *      last one is used. `INVALID_PARAMETER_CONTENT`: a parameter's
   *      `content` cannot be read as defined (not exactly one media type,
   *      next to `schema`, a media type that is not an object or is an
   *      unresolved reference, `itemSchema`). Both are also validator
   *      warnings (but for the unresolved reference);
   *    - `COOKIE_CONTENT_NOT_SENDABLE`, `QUERYSTRING_WITH_QUERY_CREDENTIAL`:
   *      the tool is made, but some calls cannot be built (a JSON cookie
   *      value other than a number, boolean or null; a credential in the
   *      query next to a whole query string that is not form-encoded);
   *    - `UNSUPPORTED_STREAMING_REQUEST_BODY`: a request body declares only
   *      `itemSchema` (a streamed upload); the tool takes no body input.
   *
   * At most `MAX_DIAGNOSTICS` entries are kept, warnings in preference to
   * infos: once the list is full, a new warning takes the place of the most
   * recently recorded info (while there is one) and a new info is not
   * recorded. So the list holds every warning found while there was room,
   * and the infos that still fit, each in the order found. One final
   * `DIAGNOSTICS_TRUNCATED` entry then says how many warnings and infos were
   * not recorded. Every severity is `warning`, except Swagger 2.0 conversion
   * notes that change nothing a tool does (`SWAGGER_UNKNOWN_FIELD`,
   * `SWAGGER_ASSUMED_MEDIA_TYPE`, ...), which are `info`.
   *
   * For a Swagger 2.0 document every entry with a `path` has `document`:
   * `'source'` when `path` points into the 2.0 document as written, which
   * every finding about a construct that exists there does (generation
   * findings about a parameter name its index in the 2.0 list, not in the
   * converted one), and `'converted'` for a construct only the conversion
   * has (its request body); no finding of this release points there for a
   * converted document. Other documents never set `document`.
   *
   * `path` comes in two forms, like `ValidationErrorDetail.path`: a
   * forwarded validator warning whose code predates OpenAPI 3.2 support
   * (`NO_OPERATION_ID`, `NO_OPERATIONS`) keeps its historical form, the path
   * key unescaped (`/paths//pets/get/operationId`); every other diagnostic
   * carries an RFC 6901 JSON Pointer (`/paths/~1pets/get`), whose segments
   * are escaped for display and capped, so a capped one does not resolve.
   *
   * Returns a copy.
   */
  getDiagnostics(): SpecDiagnostic[] {
    const diagnostics = [...this.diagnostics.values()].map((diagnostic) => ({ ...diagnostic }));
    const { warning, info } = this.dropped;
    if (warning + info > 0) {
      diagnostics.push({
        severity: 'warning',
        code: DIAGNOSTIC_CODES.DIAGNOSTICS_TRUNCATED,
        message:
          `Only ${MAX_DIAGNOSTICS} diagnostics are kept, warnings in preference to infos; ${warning} ` +
          `${warning === 1 ? 'warning' : 'warnings'} and ${info} ${info === 1 ? 'info' : 'infos'} were not recorded`,
      });
    }
    return diagnostics;
  }

  /**
   * The OpenAPI version the document declares (read after overlays), as
   * `detectSpecVersion` reports it: its `status` (`supported`,
   * `newer-minor`, `unsupported`, `malformed`, `missing`), the declared
   * value, and the `family` (`2.0`, `3.0`, `3.1`, `3.2`) whose rules the
   * validator applies, `undefined` when the version cannot be processed. A
   * Swagger 2.0 document reports `{ status: 'supported', field: 'swagger',
   * family: '2.0' }` before and after its conversion to OpenAPI 3.0.
   * Returns a copy.
   */
  getSpecVersion(): SpecVersionInfo {
    return { ...this.specVersion, diagnostics: this.specVersion.diagnostics.map((diagnostic) => ({ ...diagnostic })) };
  }

  /**
   * Create generator from a URL. The document's base URI (what relative
   * `$ref`s resolve against) is the URL it was finally read from, after
   * redirects, without user information or fragment: `LoadOptions.headers`
   * and credentials in `url` are used for the spec itself only, never for a
   * `$ref`.
   */
  static async fromURL(url: string, rawOptions: LoadOptions = {}): Promise<OpenAPIToolGenerator> {
    const options = applySecureDefaults(rawOptions);
    try {
      // A bad option fails before anything is fetched
      if (options.documentUri !== undefined) parseDocumentUri(options.documentUri);
      // SECURITY: validate the spec URL — and every redirect hop — against the
      // SSRF guard before fetching (resolves DNS and rejects internal targets),
      // instead of letting the HTTP client follow 3xx blindly. See ssrf.ts.
      const { response, url: finalUrl } = await safeFetchWithFinalUrl(url, {
        headers: options.headers,
        timeoutMs: options.timeout ?? 30000,
        followRedirects: options.followRedirects ?? true,
        ssrf: normalizeSsrfOptions(options.refResolution),
      });

      if (!response.ok) {
        throw new LoadError(`Failed to fetch OpenAPI spec from URL: ${response.status} ${response.statusText}`, {
          url,
          status: response.status,
        });
      }

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();

      let document: OpenAPIDocument;
      if (contentType.includes('yaml') || contentType.includes('yml') || url.match(/\.ya?ml$/i)) {
        document = yaml.parse(text);
      } else {
        document = JSON.parse(text);
      }

      return new OpenAPIToolGenerator(document, options, retrievalUriOf(finalUrl));
    } catch (error: unknown) {
      if (error instanceof LoadError || error instanceof OverlayError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new LoadError(`Failed to load OpenAPI spec from URL: ${errorMessage}`, {
        url,
        originalError: error,
      });
    }
  }

  /**
   * Create generator from a file path. The document's base URI (what
   * relative `$ref`s resolve against) is the file's `file:` URL, so they
   * resolve next to the file, whatever the working directory and whatever
   * `$self` says. Reading them still needs `file` in
   * `refResolution.allowedProtocols`, which allows any local file the
   * process can read: references are not confined to the file's folder.
   */
  static async fromFile(filePath: string, options: LoadOptions = {}): Promise<OpenAPIToolGenerator> {
    try {
      // A bad option fails before anything is read
      if (options.documentUri !== undefined) parseDocumentUri(options.documentUri);
      // Lazy-load Node builtins so the module is importable off-Node (Workers).
      const [path, fs, url] = await Promise.all([import('path'), import('fs/promises'), import('url')]);
      /* c8 ignore next -- both branches tested but V8 source-map misaligns ternary */
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
      const content = await fs.readFile(absolutePath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();

      let document: OpenAPIDocument;
      if (ext === '.yaml' || ext === '.yml') {
        document = yaml.parse(content);
      } else if (ext === '.json') {
        document = JSON.parse(content);
      } else {
        // Try to parse as JSON first, then YAML
        try {
          document = JSON.parse(content);
        } catch {
          document = yaml.parse(content);
        }
      }

      return new OpenAPIToolGenerator(document, options, url.pathToFileURL(absolutePath).href);
    } catch (error: unknown) {
      if (error instanceof OverlayError || error instanceof LoadError) {
        throw error;
      }
      /* c8 ignore next */
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new LoadError(`Failed to load OpenAPI spec from file: ${errorMessage}`, {
        filePath,
        originalError: error,
      });
    }
  }

  /**
   * Create generator from a YAML string
   */
  static async fromYAML(yamlString: string, options: LoadOptions = {}): Promise<OpenAPIToolGenerator> {
    try {
      const document = yaml.parse(yamlString);
      return new OpenAPIToolGenerator(document, options);
    } catch (error: unknown) {
      // An overlay or `documentUri` problem is not a YAML one
      if (error instanceof OverlayError || error instanceof LoadError) {
        throw error;
      }
      /* c8 ignore next */
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new ParseError(`Failed to parse YAML: ${errorMessage}`, {
        originalError: error,
      });
    }
  }

  /**
   * Create generator from a JSON object. The object is copied as JSON (so
   * later changes to it do not reach the generator); one that cannot be
   * copied throws a `ParseError`: nested too deeply for `JSON.stringify`
   * (maximum call stack size exceeded), containing itself, or holding a
   * value JSON has no form for (a `BigInt`).
   */
  static async fromJSON(json: object, options: LoadOptions = {}): Promise<OpenAPIToolGenerator> {
    let document: OpenAPIDocument;
    try {
      document = JSON.parse(JSON.stringify(json));
    } catch (error: unknown) {
      // JSON throws an Error for each: a RangeError for the call stack (or a text too long), a TypeError, ...
      const message = String((error as Error).message);
      const detail =
        error instanceof RangeError && /call stack/i.test(message)
          ? 'it is nested too deeply to copy (maximum call stack size exceeded)'
          : messageText(message, DEREFERENCE_ERROR_MAX_LENGTH);
      throw new ParseError(`Failed to read the JSON document: ${detail}`, { originalError: error });
    }
    return new OpenAPIToolGenerator(document, options);
  }

  /**
   * Get the OpenAPI document: dereferenced once generation or linting has
   * run (or `validate()`, for a document that references other documents),
   * as loaded (after overlays) before that. It is the generator's own
   * object, not a copy. Validation runs once per generator, so changing this
   * document afterwards is not re-validated, and neither the declared
   * version (`getSpecVersion()`) nor `getDiagnostics()` is recomputed.
   *
   * A Swagger 2.0 document has a third state: once generation or linting
   * has run, this is the OpenAPI 3.0 document it was converted to
   * (`openapi: "3.0.3"`, see `upgradeSwagger2`), which is what tools are
   * generated from; before that it is the 2.0 document as loaded or (after
   * `validate()` read the documents it references) dereferenced.
   * `getSpecVersion()` keeps reporting the declared Swagger 2.0.
   */
  getDocument(): OpenAPIDocument {
    return this.upgradedDocument ?? this.dereferencedDocument ?? this.document;
  }

  /** The document in its declared version: dereferenced once that has run, else as loaded. What validation reads. */
  private declaredDocument(): OpenAPIDocument {
    return this.dereferencedDocument ?? this.document;
  }

  /**
   * `DEREFERENCE_REQUIRED`: a Swagger 2.0 document loaded with
   * `dereference: false`, which the converter cannot read. The one error of
   * `validate()`, and `context.errors` of the `ParseError` of generation and
   * lint.
   */
  private dereferenceRequired(): ValidationErrorDetail {
    return {
      message:
        'A Swagger 2.0 document needs LoadOptions.dereference: true (the default): it is converted to OpenAPI 3.0 ' +
        'once its $refs are resolved. To read no other document, keep dereferencing on and set secureDefaults: ' +
        'true (or refResolution.allowedProtocols: [])',
      path: '/swagger',
      code: DIAGNOSTIC_CODES.DEREFERENCE_REQUIRED,
    };
  }

  /**
   * Validate the document with the rules of the version it declares.
   *
   * A document holding a `$ref` that does not start with `#` is validated as
   * generation reads it: with `dereference` on (the default), it is
   * dereferenced first and the result is validated, so the two agree. A
   * reference to the document's own URI is made local and needs nothing
   * read; a reference to another document is read, so `validate()` can read
   * files and make network requests, with exactly the `refResolution` gates,
   * SSRF protections and redirect rules of generation, at most once per
   * generator (generation reuses the result, and the reverse).
   *
   * A reference that cannot be read (refused by a rule, missing, not JSON or
   * YAML, a pointer that leads nowhere, ...) does not throw: the result is
   * `{ valid: false, errors: [{ code: 'UNREADABLE_REFERENCE', message, path }] }`,
   * `message` being the `ParseError` message generation throws (without its
   * `Failed to dereference OpenAPI document:` prefix), bounded and escaped,
   * and `path` the JSON Pointer of the `$ref` when it is in this document.
   * Only a document JSON cannot copy (a YAML alias that makes it contain
   * itself, or nesting deeper than JSON supports) still throws the
   * `ParseError`, as generation does.
   *
   * Every other document (only `#` references, or `dereference: false`) is
   * validated as loaded, after overlays, without reading anything: the
   * result earlier releases gave. The validator follows local parameter
   * references itself.
   *
   * A Swagger 2.0 document is validated as written (dereferenced like any
   * other), with the 2.0 rules: `validate()` never converts it. Loaded with
   * `dereference: false`, which generation cannot convert, the result is
   * `{ valid: false, errors: [{ code: 'DEREFERENCE_REQUIRED', message, path: '/swagger' }] }`
   * and nothing else, as for a reference that cannot be read.
   *
   * Does not add to `getDiagnostics()`.
   */
  async validate(): Promise<ValidationResult> {
    const validator = new Validator();
    if (this.swagger && !this.options.dereference) {
      return { valid: false, errors: [this.dereferenceRequired()] };
    }
    if (this.options.dereference && OpenAPIToolGenerator.hasExternalRefs(this.document)) {
      try {
        await this.dereferenceOnce();
      } catch (error: unknown) {
        if (!(error instanceof ParseError) || error.context?.['rule'] === undefined) throw error;
        const path: unknown = error.context['path'];
        return {
          valid: false,
          errors: [
            {
              message: error.message.slice(DEREFERENCE_ERROR_PREFIX.length),
              ...(typeof path === 'string' ? { path } : {}),
              code: DIAGNOSTIC_CODES.UNREADABLE_REFERENCE,
            },
          ],
        };
      }
      return validator.validate(this.declaredDocument());
    }
    return validator.validate(this.document);
  }

  /**
   * Lint the loaded document for agent-readiness (missing operationIds,
   * vague descriptions, unpaginated lists, oversized schemas, ...). Runs
   * after overlays and dereferencing so findings reflect what tools would
   * actually be generated from: a Swagger 2.0 document is converted first
   * and its OpenAPI 3.0 form is linted (the operations and their labels are
   * the same). Throws the `ParseError` generation throws for a 2.0 document
   * loaded with `dereference: false`.
   */
  async lint(): Promise<LintResult> {
    // Diagnostics must run on the imperfect specs they exist to diagnose:
    // overlays + dereferencing apply, but validation never gates linting.
    await this.initialize(false);
    return lintDocument(this.getDocument());
  }

  // NOTE: internal/private-address blocking + IPv4-mapped-IPv6 decoding now live
  // in `ssrf.ts` (`isBlockedHostname` / `isBlockedAddress` / `decodeIpv4MappedIpv6`),
  // shared by the spec-URL fetch (`fromURL`) and the `$ref` resolver below, and
  // augmented there with DNS resolution (closing the DNS-name-to-internal bypass)
  // and per-hop redirect re-validation (`safeFetch`).

  /**
   * Build $RefParser options based on refResolution configuration.
   * Defaults: allow http/https, block file://, block internal IPs.
   *
   * Which resolver reads a reference is decided as it always was: the file
   * resolver (when `file` is allowed) takes what `$RefParser` reads as a local
   * path, the http resolver takes what passes its `canRead` gate. A third
   * one, `refused`, reads nothing: it takes exactly the references neither
   * may read, to fail with an `ExternalRefError` saying which reference,
   * resolved against which base, was refused by which rule, and what would
   * allow it (instead of `$RefParser`'s "Unable to resolve $ref pointer").
   * A file or a fetch that fails becomes an `ExternalRefError` too, and every
   * read goes through `orderedReads`, so the failure reported is the first in
   * document order whatever order the reads finish in.
   *
   * `fileResolver` is `$RefParser`'s own file resolver, whose `read` is
   * wrapped (its `canRead` is kept); `ordered` is the dereference's read queue.
   */
  private buildRefParserOptions(
    fileResolver: { read(file: RefTarget): unknown },
    ordered: OrderedReads['read'],
  ): ParserOptions {
    const raw = this.options.refResolution;
    const refOpts: Required<RefResolutionOptions> = {
      allowedProtocols: raw.allowedProtocols ?? ['http', 'https'],
      allowedHosts: raw.allowedHosts ?? [],
      blockedHosts: raw.blockedHosts ?? [],
      allowInternalIPs: raw.allowInternalIPs ?? false,
    };

    const allowedProtocols = new Set(refOpts.allowedProtocols);
    const hasNetworkProtocol = allowedProtocols.size > 0 &&
      !([...allowedProtocols].length === 1 && allowedProtocols.has('file'));

    // If no protocols allowed at all, disable external resolution entirely
    if (allowedProtocols.size === 0) {
      return { resolve: { external: false } } as ParserOptions;
    }

    const hasHostAllowlist = refOpts.allowedHosts.length > 0;
    // Synchronous gate: protocol, host allow-list, and literal/known
    // internal hosts. DNS names that *resolve* to internal addresses pass
    // here (canRead cannot be async) and are caught in `read` via DNS
    // resolution — closing the `127.0.0.1.nip.io` bypass for `$ref`s too.
    const canReadHttp = (file: { url: string }): boolean => {
      try {
        const parsed = new URL(file.url);
        const protocol = parsed.protocol.replace(':', '');

        // Check protocol allowlist
        if (!allowedProtocols.has(protocol)) {
          return false;
        }

        // Check host allowlist (if configured), case- and trailing-dot-insensitively
        if (hasHostAllowlist && !hostListIncludes(refOpts.allowedHosts, parsed.hostname)) {
          return false;
        }

        // Check blocked hosts (internal IPs, known internal names, etc.)
        if (isBlockedHostname(parsed.hostname, refOpts)) {
          return false;
        }

        return true;
      } catch {
        return false;
      }
    };
    const fileAllowed = allowedProtocols.has('file');
    const documentHasBase = this.documentBase?.href !== undefined;
    // Where the `$ref` is, when it is in the entry document (`$RefParser` passes its `$Refs` third)
    const locate = (file: RefTarget, refs: RefParserRefs | undefined): string[] | undefined => {
      const hash = file.baseUrl?.indexOf('#') ?? -1;
      if (hash === -1 || (file.baseUrl as string).slice(0, hash) !== refs?._root$Ref?.path) return undefined;
      return fragmentPointerTokens((file.baseUrl as string).slice(hash + 1));
    };
    const refuse = (file: RefTarget, refs: RefParserRefs | undefined, refusal: RefRefusal): never => {
      throw new ExternalRefError(file, refusal, { documentHasBase, location: locate(file, refs) });
    };

    const resolveConfig: Record<string, unknown> = {
      external: true,
      file: fileAllowed
        ? {
            read: (file: RefTarget, _callback: unknown, refs?: RefParserRefs): Promise<unknown> =>
              ordered(async () => {
                try {
                  return await fileResolver.read(file);
                } catch (error: unknown) {
                  // `$RefParser`'s file resolver gives the I/O error's code (ENOENT, EISDIR, ...)
                  const { ioErrorCode, message } = Object(error) as { ioErrorCode?: unknown; message?: unknown };
                  return refuse(file, refs, {
                    rule: 'file-error',
                    /* c8 ignore next 4 -- defensive: an error without a code is described by its message */
                    reason:
                      typeof ioErrorCode === 'string'
                        ? `the file cannot be read (${messageText(ioErrorCode, 32)})`
                        : messageText(String(message), REF_TEXT_MAX_LENGTH),
                  });
                }
              }),
          }
        : false,
      refused: {
        order: 1,
        canRead: (file: RefTarget): boolean =>
          !(fileAllowed && isLocalFileRef(file.url)) && !(hasNetworkProtocol && canReadHttp(file)),
        read: (file: RefTarget, _callback: unknown, refs?: RefParserRefs): Promise<never> =>
          ordered(async () => refuse(file, refs, explainUnreadableRef(file.url, { ...refOpts, allowedProtocols }))),
      },
    };

    // Configure HTTP/HTTPS resolver with security filtering
    if (hasNetworkProtocol) {
      resolveConfig['http'] = {
        // SECURITY: never auto-follow HTTP redirects when resolving external
        // `$ref`s. `canRead` validates only the INITIAL URL; the resolver's
        // default redirect-following (up to 5 hops) re-fetches the `Location`
        // target WITHOUT re-invoking `canRead`, so an allowlisted host could
        // 302 → `http://169.254.169.254/...` and smuggle a blocked target past
        // the allow/deny lists. `redirects: 0` refuses the first redirect, and
        // our custom `read` (below) additionally refuses redirects itself.
        redirects: 0,
        canRead: canReadHttp,
        // SSRF-safe fetch: resolves DNS and rejects names that map to internal
        // addresses, and refuses redirects. NOTE: deliberately does NOT forward
        // `this.options.headers` (the spec-load credentials) to third-party
        // `$ref` hosts — that would leak the spec's auth token cross-origin.
        read: (file: RefTarget, _callback: unknown, refs?: RefParserRefs): Promise<string> =>
          ordered(async () => {
            let response: Response;
            try {
              response = await safeFetch(file.url, {
                timeoutMs: this.options.timeout,
                followRedirects: false,
                ssrf: refOpts,
              });
            } catch (error: unknown) {
              // The guard's refusal (an address the name resolves to, a body too large, ...), a
              // timeout or a network failure, with the reference it concerns
              return refuse(file, refs, fetchFailure(error, this.options.timeout));
            }
            if (!response.ok) {
              refuse(file, refs, {
                rule: 'response',
                reason: `the server answered ${response.status} ${describeValue(response.statusText, REF_TEXT_MAX_LENGTH)}`,
              });
            }
            return response.text();
          }),
      };
    } else {
      resolveConfig['http'] = false;
    }

    return { resolve: resolveConfig } as ParserOptions;
  }

  /**
   * Does the document contain any EXTERNAL `$ref` (a ref that is not a local
   * JSON-pointer beginning with `#`)? Only external refs require the full
   * `$RefParser` (file/http resolvers, which pull Node builtins). A document
   * with only internal refs can be dereferenced with the runtime-agnostic
   * resolver below — so it works on V8 isolates (Cloudflare Workers) too.
   *
   * Walks with its own stack (issue #50): `validate()` runs it on every
   * document, however deeply nested.
   */
  private static hasExternalRefs(root: unknown): boolean {
    const seen = new Set<unknown>();
    const stack: unknown[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === null || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const item of node) stack.push(item);
        continue;
      }
      const ref = (node as { $ref?: unknown }).$ref;
      if (typeof ref === 'string' && !ref.startsWith('#')) return true;
      for (const value of Object.values(node as Record<string, unknown>)) stack.push(value);
    }
    return false;
  }

  /**
   * Dereference local (`#/...`) `$ref`s without `$RefParser` — pure, dependency-
   * free, runtime-agnostic. A pointer cache makes circular schemas resolve to a
   * shared reference instead of recursing forever (same contract as `$RefParser`).
   *
   * The walk keeps its own stack instead of recursing: a chain of N `$ref`s
   * nests N levels deep, and a call per level would overflow the call stack
   * after a few hundred levels (issue #50).
   *
   * `exact` maps the `$ref` objects that were references to the document's
   * own URI to the reference tokens of their (checked) target: they are
   * resolved by those tokens, exactly as `$RefParser` reads their fragment.
   * Every other `$ref` keeps the reading it always had here (no
   * percent-decoding, empty tokens skipped, `{}` for a pointer that leads
   * nowhere).
   *
   * A `$ref` to a boolean schema (`false`, `true`) becomes that boolean, as
   * `$RefParser` makes it: an object placeholder would turn `false` (no value)
   * into `{}` (any value). A boolean has no children, so no cycle reaches it.
   * A `$ref` to any other non-object value still becomes `{}`.
   */
  private static dereferenceInternal(
    root: OpenAPIDocument,
    exact: ReadonlyMap<object, readonly string[]> = new Map(),
  ): OpenAPIDocument {
    const cache = new Map<string, unknown>();
    const resolvePointer = (ptr: string): unknown => {
      const parts = ptr
        .replace(/^#\/?/, '')
        .split('/')
        .filter((p) => p.length > 0)
        .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
      let cur: unknown = root;
      for (const p of parts) cur = (cur as Record<string, unknown> | undefined)?.[p];
      return cur;
    };

    // A node whose children are being walked, depth-first and in order. A
    // `$ref` is a frame with one child, its target: the walked target is
    // copied into the placeholder that other references to it already hold.
    interface WalkFrame {
      children: unknown[];
      /** The children's property names for an object; `null` for an array or a `$ref` */
      keys: string[] | null;
      /** Index of the next child to walk; the one before it is being walked */
      next: number;
      out: Record<string, unknown> | unknown[];
      placeholder: Record<string, unknown> | null;
    }
    const frames: WalkFrame[] = [];
    const pending = {};
    // The value of a `$ref` (cached under `key`) to `target`: a boolean schema
    // as it is; else a placeholder, cached first so a cycle back to it sees
    // it, filled once its walked target is known
    const refTo = (key: string, target: unknown): unknown => {
      if (typeof target === 'boolean') {
        cache.set(key, target);
        return target;
      }
      const placeholder: Record<string, unknown> = {};
      cache.set(key, placeholder);
      frames.push({ children: [target], keys: null, next: 0, out: [], placeholder });
      return pending;
    };
    // A node's walked value — or `pending`, with a frame pushed to walk it
    const enter = (node: unknown): unknown => {
      if (node === null || typeof node !== 'object') return node;
      if (Array.isArray(node)) {
        // The document is JSON-cloned, so arrays are never sparse
        frames.push({ children: node, keys: null, next: 0, out: new Array(node.length), placeholder: null });
        return pending;
      }
      const tokens = exact.get(node);
      if (tokens !== undefined) {
        // Its own cache namespace: a `#` key never starts with a NUL
        const key = `\u0000${JSON.stringify(tokens)}`;
        const cached = cache.get(key);
        if (cached !== undefined) return cached;
        let target: unknown = root;
        for (const token of tokens) target = (target as Record<string, unknown>)[token];
        return refTo(key, target);
      }
      const ref = (node as { $ref?: unknown }).$ref;
      if (typeof ref === 'string' && ref.startsWith('#')) {
        const cached = cache.get(ref);
        if (cached !== undefined) return cached;
        return refTo(ref, resolvePointer(ref));
      }
      const record = node as Record<string, unknown>;
      const keys = Object.keys(record);
      frames.push({ children: keys.map((key) => record[key]), keys, next: 0, out: {}, placeholder: null });
      return pending;
    };
    const store = (frame: WalkFrame, index: number, value: unknown): void => {
      if (frame.keys) setOwnProperty(frame.out as Record<string, unknown>, frame.keys[index], value);
      else (frame.out as unknown[])[index] = value;
    };

    // The document is the single child of a top frame
    const top: WalkFrame = { children: [root], keys: null, next: 0, out: [], placeholder: null };
    frames.push(top);
    for (;;) {
      const frame = frames[frames.length - 1];
      if (frame.next < frame.children.length) {
        const index = frame.next++;
        const value = enter(frame.children[index]);
        if (value !== pending) store(frame, index, value);
        continue;
      }
      frames.pop();
      if (frame === top) return (top.out as unknown[])[0] as OpenAPIDocument;
      let value: unknown = frame.out;
      if (frame.placeholder) {
        const resolved = (frame.out as unknown[])[0];
        if (resolved && typeof resolved === 'object') {
          // Not Object.assign: it would turn an own `__proto__` key into the prototype
          const record = resolved as Record<string, unknown>;
          for (const key of Object.keys(record)) setOwnProperty(frame.placeholder, key, record[key]);
        }
        value = frame.placeholder;
      }
      const parent = frames[frames.length - 1];
      store(parent, parent.next - 1, value);
    }
  }

  /**
   * The copy of the document to dereference, made afresh for each attempt
   * (`$RefParser` replaces references inside it as it goes, so a failed
   * attempt can leave some resolved):
   *
   * - every `$ref` that names the document itself (its retrieval URI or
   *   `$self`, see `src/base-uri.ts`) is made local: its fragment is
   *   percent-decoded into a JSON Pointer (RFC 6901 section 6) that must lead
   *   to a value of the document as written, else the load fails with a
   *   `ParseError` (rule `missing-target`) naming the reference, whichever
   *   dereferencer runs. Like every local reference, it drops the keywords
   *   next to it (a `description` beside the `$ref`). Without a base URI
   *   nothing is rewritten. Inside a Schema Object with its own `$id`, only an
   *   absolute reference names the document, and it is rewritten unless
   *   `$RefParser` will read this document with `$id` scopes (another
   *   document is needed and `refParserScopesIds`): it would resolve the
   *   `#` form against the `$id`, so the reference is left as written;
   * - with a retrieval URI too long to be used, a relative reference to
   *   another document fails the load (rule `base-too-long`): it is never
   *   resolved against the working directory instead;
   * - whether a `$ref` to another document remains.
   */
  private prepare(): PreparedDocument {
    let copy: OpenAPIDocument;
    try {
      copy = JSON.parse(JSON.stringify(this.document)) as OpenAPIDocument;
    } catch (error: unknown) {
      // A YAML alias can make a document refer to itself, and nesting can go deeper than JSON
      // supports: either way JSON throws an Error
      const detail = (error as Error).message;
      throw new ParseError(`${DEREFERENCE_ERROR_PREFIX}${messageText(detail, DEREFERENCE_ERROR_MAX_LENGTH)}`, {
        originalError: error,
      });
    }
    const exact = new Map<object, readonly string[]>();
    const base = this.documentBase;
    if (base !== undefined) {
      const references = findSelfReferences(copy, base).references;
      // A reference inside a schema with its own `$id` can be made local only if the dereferencer
      // that runs reads `#` from the document root: the internal one always does, `$RefParser`
      // unless it applies `$id` scopes to this document. It runs when another document is needed
      let localScoped = true;
      if (references.some((reference) => reference.scoped) && refParserScopesIds(copy)) {
        for (const reference of references) reference.node['$ref'] = `#${reference.fragment}`;
        localScoped = !OpenAPIToolGenerator.hasExternalRefs(copy);
        for (const reference of references) reference.node['$ref'] = reference.ref;
      }
      for (const reference of references) {
        // Left as written: read like any other absolute reference
        if (reference.scoped && !localScoped) continue;
        const problem = pointerTargetProblem(copy, reference.tokens);
        if (problem !== undefined) {
          throw dereferenceError(
            new ExternalRefError(
              { url: reference.resolved, reference: reference.ref, ...(base.href === undefined ? {} : { baseUrl: base.href }) },
              { rule: 'missing-target', reason: `it names this document, but ${problem}` },
              { documentHasBase: true, location: reference.location() },
            ),
          );
        }
        // What `$RefParser` reads from the fragment; the internal dereferencer uses the tokens
        reference.node['$ref'] = `#${reference.fragment}`;
        exact.set(reference.node, reference.tokens);
      }
      const relative = base.retrievalTooLong ? findRelativeReference(copy) : undefined;
      if (relative !== undefined) {
        throw dereferenceError(
          new ExternalRefError(
            { url: relative.ref, reference: relative.ref },
            {
              rule: 'base-too-long',
              reason:
                'it is relative, and the URI the document was retrieved from is too long to be used as its base ' +
                '(BASE_URI_TOO_LONG)',
            },
            { documentHasBase: true, location: relative.location },
          ),
        );
      }
    }
    return { copy, external: OpenAPIToolGenerator.hasExternalRefs(copy), exact };
  }

  /** Dereferences the document into `dereferencedDocument`, throwing a `ParseError` on failure. */
  private async dereference(): Promise<void> {
    const { copy, external, exact } = this.prepare();
    // Internal-only refs (self-references included, once rewritten) →
    // dereference without `$RefParser` (no Node builtins, so this path runs on
    // V8 isolates / Cloudflare Workers, and under `secureDefaults`). External
    // refs → `$RefParser` (Node-only file/http resolvers).
    if (!external) {
      this.dereferencedDocument = OpenAPIToolGenerator.dereferenceInternal(copy, exact);
      return;
    }
    let refParser: typeof import('@apidevtools/json-schema-ref-parser') | undefined;
    const reads = orderedReads();
    try {
      refParser = await import('@apidevtools/json-schema-ref-parser');
      // Its `read` is a function; the type also allows the static forms a plugin may take
      const fileResolver = refParser.FileResolver as unknown as { read(file: RefTarget): unknown };
      const refParserOptions = this.buildRefParserOptions(fileResolver, reads.read);
      const root = await this.refParserRoot();
      // Without a base URI, as in earlier releases: relative refs resolve against the working directory
      this.dereferencedDocument = (await (root === undefined
        ? refParser.default.dereference(copy, refParserOptions)
        : refParser.default.dereference(root, copy, refParserOptions))) as OpenAPIDocument;
    } catch (error: unknown) {
      // `$RefParser` rejects at the first failure while other reads may still run, and goes on
      // parsing what they deliver: start no more, and wait for those, so none outlives the rejection
      await reads.settle();
      // A retry prepares a new copy: this one may hold references resolved before the failure
      throw dereferenceError(error, refParser);
    }
  }

  /**
   * Where `$RefParser` resolves the document's relative references from: the
   * retrieval base (see `src/base-uri.ts`), a `file:` one as the local path
   * the file resolver reads; `undefined` without one.
   */
  private async refParserRoot(): Promise<string | undefined> {
    const base = this.documentBase?.href;
    if (base === undefined || !base.startsWith('file:')) return base;
    const { fileURLToPath } = await import('url');
    return fileURLToPath(base);
  }

  /** Dereferences the document once (when `dereference` is on): concurrent callers share one run. */
  private async dereferenceOnce(): Promise<void> {
    if (this.options.dereference && !this.dereferencedDocument) {
      // One dereference at a time: concurrent callers share it (and its
      // fetches); after a failure the next call tries again
      this.dereferencing ??= this.dereference().finally(() => {
        this.dereferencing = undefined;
      });
      await this.dereferencing;
    }
  }

  /**
   * Initialize the generator: dereference if needed, then validate (the
   * document as declared), then, for Swagger 2.0, convert it to OpenAPI 3.0.
   * A 2.0 document with `dereference: false` fails first, whatever it holds.
   */
  private async initialize(runValidation: boolean = this.options.validate): Promise<void> {
    if (this.swagger && !this.options.dereference) {
      const detail = this.dereferenceRequired();
      throw new ParseError(detail.message, { errors: [detail] });
    }
    await this.dereferenceOnce();

    if (runValidation) {
      const result = await this.validateOnce();
      if (!result.valid) {
        // `valid: false` always comes with at least one error
        throw new ParseError(invalidDocumentMessage(result.errors!), { errors: result.errors });
      }
    }

    if (this.swagger) this.upgradeOnce();
  }

  /**
   * Converts the dereferenced Swagger 2.0 document to OpenAPI 3.0, once,
   * recording the converter's diagnostics. A document without `host` gets
   * its server from the URI it was retrieved from (`fromURL`'s final URL, or
   * `LoadOptions.documentUri`), as the 2.0 specification says; without one
   * (or with a `file:` one) its server URL stays relative
   * (`SWAGGER_RELATIVE_SERVER_URL`).
   */
  private upgradeOnce(): void {
    if (this.upgradedDocument !== undefined) return;
    if (this.upgradeError !== undefined) throw this.upgradeError;
    const retrievalUri = this.documentBase?.retrievalUri;
    const result = upgradeSwagger2(this.dereferencedDocument, { documentUri: retrievalUri });
    for (const diagnostic of result.diagnostics) this.addDiagnostic(diagnostic);
    if (result.tooLarge) {
      // Abandoned at MAX_CONVERSION_ENTRIES: the document cannot be read, now or on a later call
      this.upgradeError = new ParseError(
        `Cannot convert the Swagger 2.0 document to OpenAPI 3.0: it needs more than ${MAX_CONVERSION_ENTRIES} media ` +
          'type, encoding, header and form property entries (MAX_CONVERSION_ENTRIES), as its `consumes`, `produces` ' +
          'and path-level parameters apply to every operation',
        { code: DIAGNOSTIC_CODES.SWAGGER_CONVERSION_TOO_LARGE, maxEntries: MAX_CONVERSION_ENTRIES },
      );
      throw this.upgradeError;
    }
    this.parameterIndexes = result.parameterIndexes;
    this.upgradedDocument = result.document as unknown as OpenAPIDocument;
  }

  /**
   * Validates the document generation reads (dereferenced when dereferencing
   * is on) once per generator, recording its warnings as diagnostics. Every
   * `generateTool` call goes through `initialize()`; without this the
   * validator re-ran for each operation. A Swagger 2.0 document is validated
   * in its declared version, never its OpenAPI 3.0 conversion.
   */
  private validateOnce(): Promise<ValidationResult> {
    this.validation ??= new Validator().validate(this.declaredDocument()).then((result) => {
      for (const warning of result.warnings ?? []) this.addDiagnostic(fromValidationWarning(warning));
      return result;
    });
    return this.validation;
  }

  /**
   * Generate all tools from the OpenAPI specification
   */
  async generateTools(options: GenerateOptions = {}): Promise<McpOpenAPITool[]> {
    await this.initialize();

    const document = this.getDocument();
    const tools: McpOpenAPITool[] = [];
    const usedNames = new Set<string>();

    if (!isSpecObject(document.paths)) {
      return tools;
    }

    // Deterministic ordering (MCP 2026-07-28 SHOULD): paths sorted by code
    // unit (locale-independent), then the operations in `listOperations`
    // order: the eight historical methods in their fixed order, then, from
    // OpenAPI 3.2, `query` and `additionalOperations` sorted by method. Stable
    // output across spec re-serializations keeps clients' prompt caches
    // effective. (object keys are unique, so the comparator never sees equal paths)
    const sortedPaths = Object.entries(document.paths).sort(([a], [b]) => (a < b ? -1 : 1));

    for (const [pathStr, pathItem] of sortedPaths) {
      // A path item that is still a reference (dereferencing off) is skipped, as before
      if (ownProperty(pathItem, '$ref') !== undefined) continue;

      for (const entry of this.walkPathItem(pathStr, pathItem, true)) {
        // Fixed methods are lowercase field names (names and dedup hashes are
        // seeded with them); an additional method is its key as written
        const { method, operation } = entry;

        // Apply filters
        if (!this.shouldIncludeOperation(operation, pathStr, method, options, document, pathItem as PathItemObject)) {
          continue;
        }

        try {
          // The entry found by the walk is built directly: looking it up again
          // per operation would make a large path item quadratic
          let tool = this.buildToolGuarded(pathStr, pathItem, entry, options);
          // Resolve tool-name collisions (e.g. duplicate operationIds) with a
          // stable, content-derived suffix — the (method, path) pair is unique
          // per operation, so the suffixed name is deterministic across runs.
          if (usedNames.has(tool.name)) {
            const maxLength = options.maxToolNameLength ?? DEFAULT_MAX_TOOL_NAME_LENGTH;
            // Recheck after renaming: the suffixed name can itself be taken
            // (e.g. an operationId that mimics a suffixed name, or truncated
            // hash-only names under tiny caps). Extending the seed reseeds
            // the hash deterministically until a free name is found — bounded,
            // because a tiny cap (e.g. 1 = 16 possible hex names) can exhaust
            // the name space entirely.
            let seed = `${method} ${pathStr}`;
            let deduped = normalizeToolName(`${tool.name}_${fnv1aHex(seed)}`, maxLength, seed);
            let attempts = 1;
            while (usedNames.has(deduped)) {
              if (attempts >= MAX_NAME_DEDUP_ATTEMPTS) {
                throw new GenerationError(
                  `Unable to find a unique tool name for "${tool.name}" (${operationLabel(method, pathStr)}) ` +
                    `within ${MAX_NAME_DEDUP_ATTEMPTS} attempts — the name space under maxToolNameLength=${maxLength} ` +
                    `is exhausted. Increase maxToolNameLength or rename the operation.`,
                  { name: tool.name, method, path: pathStr, maxToolNameLength: maxLength },
                );
              }
              seed += '#';
              deduped = normalizeToolName(`${tool.name}_${fnv1aHex(seed)}`, maxLength, seed);
              attempts++;
            }
            tool = { ...tool, name: deduped };
            // The TypeScript declaration derives its type names from the tool
            // name — recompute it so a dedup rename can't leave them stale.
            if (tool.metadata.typescript) {
              tool.metadata = {
                ...tool.metadata,
                typescript: emitToolTypeScript(deduped, tool.description, tool.inputSchema, tool.outputSchema, {
                  maxDepth: Math.max(1, options.maxSchemaDepth ?? 10),
                }),
              };
            }
          }
          usedNames.add(tool.name);
          tools.push(tool);
        } catch (error: unknown) {
          // Skipped on purpose: the reason is already a diagnostic
          if (skippedOperations.has(error as object)) continue;
          /* c8 ignore next */
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.warn(`Failed to generate tool for ${operationLabel(method, pathStr)}:`, errorMessage);
        }
      }
    }

    return tools;
  }

  /**
   * The operations of one Path Item that the declared version defines, in
   * `listOperations` order. The first walk of a path records its diagnostics
   * (values the walk ignores, operation fields the declared version does not
   * define). With `list` false, a path already walked is not walked again and
   * nothing is returned: `generateTool` records the diagnostics of the path
   * item it builds from without walking it once per call.
   */
  private walkPathItem(pathStr: string, pathItem: unknown, list: boolean): OperationEntry[] {
    const key = pathKey(pathStr);
    const walked = this.walkedPaths.has(key);
    if (walked && !list) return [];
    const pointer = jsonPointer('paths', pathStr);
    const listed = listOperations(pathItem, { layout: this.operationLayout, pointer });
    if (!walked) {
      this.walkedPaths.add(key);
      for (const diagnostic of listed.diagnostics) this.addDiagnostic(diagnostic);
      for (const diagnostic of skippedOperationDiagnostics(pathItem, this.operationLayout, this.specVersion, pointer)) {
        this.addDiagnostic(diagnostic);
      }
    }
    return listed.operations;
  }

  /**
   * Generate a specific tool for a path and method.
   *
   * `method` names a standard method in any case (`'get'`, `'GET'`) or an
   * OpenAPI 3.2 `additionalOperations` method exactly as written (`'LINK'`
   * does not find `link`). Only the operations the declared version defines
   * are found: `query` and `additionalOperations` from 3.2 on. The tool's
   * `metadata.method` is the canonical form: the lowercase field name of a
   * standard method, the key as written otherwise.
   *
   * Records the diagnostics of the path item and operation it builds (see
   * `getDiagnostics()`). Throws a `GenerationError` for an operation
   * `generateTools` skips with a diagnostic: a parameter in a location the
   * generator does not map (`UNSUPPORTED_PARAMETER_LOCATION`), parameters
   * breaking a querystring rule (`MULTIPLE_QUERYSTRING_PARAMETERS`,
   * `QUERYSTRING_WITH_QUERY_PARAMETERS`,
   * `QUERYSTRING_PARAMETER_WITHOUT_CONTENT`), or no Security Requirement that
   * can be satisfied (`UNSATISFIABLE_SECURITY`).
   */
  async generateTool(pathStr: string, method: string, options: GenerateOptions = {}): Promise<McpOpenAPITool> {
    await this.initialize();
    const document = this.getDocument();

    if (!document.paths) {
      throw new Error('No paths defined in OpenAPI document');
    }

    // Own-property lookups: a path or method named `constructor` must not
    // resolve through the prototype chain. One lookup, constant time.
    const pathItem = ownProperty(document.paths, pathStr);
    if (pathItem !== undefined) this.walkPathItem(pathStr, pathItem, false);
    const entry = getOperation(pathItem, method, { layout: this.operationLayout });

    if (!entry) {
      throw new Error(`Operation not found: ${operationLabel(String(method), pathStr)}`);
    }
    return this.buildToolGuarded(pathStr, pathItem, entry, options);
  }

  /**
   * `buildTool`, with a call-stack overflow turned into a `SchemaError`.
   * Every walk before depth truncation keeps its own stack, so schemas of any
   * nesting convert. Truncation and the steps after it (trims, client
   * targets, type signatures) recurse once per level they keep, so only a
   * maxSchemaDepth in the hundreds or more can overflow the call stack.
   */
  private buildToolGuarded(
    pathStr: string,
    pathItem: unknown,
    entry: OperationEntry,
    options: GenerateOptions,
  ): McpOpenAPITool {
    try {
      return this.buildTool(pathStr, pathItem as PathItemObject, entry, options);
    } catch (error: unknown) {
      if (error instanceof RangeError && /call stack/i.test(error.message)) {
        const { maxDepth } = resolveSchemaLimits(options);
        throw new SchemaError(
          `Schemas of ${operationLabel(entry.method, pathStr)} are nested too deeply to process at maxSchemaDepth ` +
            `${maxDepth} (maximum call stack size exceeded); lower maxSchemaDepth.`,
          { path: pathStr, method: entry.method, maxSchemaDepth: maxDepth },
        );
      }
      throw error;
    }
  }

  /**
   * Records `diagnostic` and returns the `GenerationError` for an operation
   * skipped on purpose (`generateTools` drops it without warning).
   */
  private skipOperation(diagnostic: SpecDiagnostic, context: Record<string, unknown>): GenerationError {
    this.addDiagnostic(diagnostic);
    const error = new GenerationError(diagnostic.message, { ...context, pointer: diagnostic.path });
    skippedOperations.add(error);
    return error;
  }

  /**
   * The index a parameter of a `parameters` list has in the document as the
   * user wrote it: for a Swagger 2.0 document, the index in the 2.0 list (its
   * `in: body` and `in: formData` parameters became the request body, so the
   * converted list can be shorter); otherwise `index` itself.
   */
  private sourceIndex(list: unknown, index: number): number {
    // A WeakMap finds nothing for a value that is not an object
    return this.parameterIndexes?.get(list as object)?.[index] ?? index;
  }

  /**
   * The first parameter of an operation (path-level ones first, as merged)
   * that cannot be mapped to a request, as a diagnostic; `undefined` when
   * every one can. Reference Objects (left by `dereference: false`) are not
   * checked, as the resolver has always passed them through.
   *
   * - `UNSUPPORTED_PARAMETER_LOCATION`: its location is not mapped.
   *   Feature-driven: a `querystring` parameter is mapped whatever version
   *   the document declares.
   * - `INVALID_PARAMETER_NAME`: its `name` cannot be a name (absent, `null`,
   *   `''`, an object, an array). A number or a boolean is a name (its text).
   */
  private unmappableParameter(pathStr: string, entry: OperationEntry, pathItem: unknown): SpecDiagnostic | undefined {
    const lists: Array<[unknown, string]> = [
      [ownProperty(pathItem, 'parameters'), jsonPointer('paths', pathStr, 'parameters')],
      [ownProperty(entry.operation, 'parameters'), appendPointer(operationPointer(pathStr, entry), 'parameters')],
    ];
    let unnamed: SpecDiagnostic | undefined;
    for (const [parameters, pointer] of lists) {
      if (!Array.isArray(parameters)) continue;
      for (let index = 0; index < parameters.length; index++) {
        const parameter: unknown = parameters[index];
        if (isReferenceObject(parameter)) continue;
        const name = ownProperty(parameter, 'name');
        const at = appendPointer(pointer, this.sourceIndex(parameters, index));
        if (unnamed === undefined && readParameterName(name).kind === 'invalid') {
          unnamed = {
            severity: 'warning',
            code: DIAGNOSTIC_CODES.INVALID_PARAMETER_NAME,
            message:
              `${operationLabel(entry.method, pathStr)}: a parameter's name must be a non-empty string, found ` +
              `${describeValue(name)}, so it cannot be sent; the operation makes no tool`,
            path: appendPointer(at, 'name'),
          };
        }
        const location = ownProperty(parameter, 'in');
        if (typeof location === 'string' && MAPPED_PARAMETER_LOCATIONS.includes(location)) continue;
        return {
          severity: 'warning',
          code: DIAGNOSTIC_CODES.UNSUPPORTED_PARAMETER_LOCATION,
          message:
            `${operationLabel(entry.method, pathStr)}: parameter ${describeValue(name)} has ` +
            `location (in) ${describeValue(location)}, which is not mapped to a request ` +
            `(supported: ${MAPPED_PARAMETER_LOCATIONS.join(', ')}); the operation makes no tool`,
          path: at,
        };
      }
    }
    return unnamed;
  }

  /**
   * A parameter list with each number or boolean `name` read as its text,
   * recording `PARAMETER_NAME_NOT_STRING` for each (`pointer` locates the
   * list). The list itself when nothing changes.
   */
  private withTextNames(list: unknown[], pointer: string): unknown[] {
    let changed = false;
    const named = list.map((parameter, index) => {
      if (!isSpecObject(parameter) || isReferenceObject(parameter)) return parameter;
      const name = readParameterName(parameter['name']);
      if (name.kind !== 'coerced') return parameter;
      changed = true;
      this.addDiagnostic(
        parameterNameNotStringDiagnostic(
          parameter['name'] as number | boolean,
          appendPointer(pointer, this.sourceIndex(list, index)),
        ),
      );
      return { ...parameter, name: name.name };
    });
    return changed ? named : list;
  }

  /**
   * Checks an operation's parameters, merged with its path item's as the
   * resolver merges them (`analyzeParameters`), before its tool is built.
   * Returns the diagnostic of a reason to skip the operation, `undefined`
   * when it can be built:
   *
   * - `UNSUPPORTED_PARAMETER_LOCATION`, `INVALID_PARAMETER_NAME` (see
   *   `unmappableParameter`);
   * - the OpenAPI 3.2 querystring rules the validator enforces, for
   *   `validate: false` (a mapper breaking one could not be serialized): more
   *   than one `in: querystring` parameter (`MULTIPLE_QUERYSTRING_PARAMETERS`),
   *   one together with `in: query` parameters, path-level ones included
   *   (`QUERYSTRING_WITH_QUERY_PARAMETERS`), or one without `content` holding
   *   a media type (`QUERYSTRING_PARAMETER_WITHOUT_CONTENT`).
   *
   * Records as warnings each number or boolean `name`, read as its text
   * (`PARAMETER_NAME_NOT_STRING`), each parameter dropped for repeating a
   * `name` and `in` in its own list (`DUPLICATE_PARAMETER`) and, for each
   * parameter that applies, the problems of its `content`
   * (`INVALID_PARAMETER_CONTENT`: the validator's findings, and a media type
   * left as an unresolved Reference Object) and a JSON cookie value no cookie
   * can carry (`COOKIE_CONTENT_NOT_SENDABLE`). For a Swagger 2.0 document,
   * each points at the parameter's place in the 2.0 document
   * (`sourceIndex`).
   *
   * Returns the merge as well, with a pointer for each parameter, for the
   * checks that need the operation's security (`wholeQueryCredentialDiagnostics`),
   * and the two lists with their names read as text, which the tool is built
   * from.
   */
  private checkParameters(
    pathStr: string,
    entry: OperationEntry,
    pathItem: unknown,
  ):
    | { skip: SpecDiagnostic }
    | {
        skip?: undefined;
        analysis: ParameterAnalysis;
        pointerOf: (slot: ParameterSlot) => string;
        pathLevel: unknown[];
        operationLevel: unknown[];
      } {
    const unmappable = this.unmappableParameter(pathStr, entry, pathItem);
    if (unmappable !== undefined) return { skip: unmappable };

    const pathList = ownProperty(pathItem, 'parameters');
    const operationList = ownProperty(entry.operation, 'parameters');
    const listOf = (level: ParameterSlot['level']): unknown => (level === 'path' ? pathList : operationList);
    const listPointer = (level: ParameterSlot['level']): string =>
      level === 'path'
        ? jsonPointer('paths', pathStr, 'parameters')
        : appendPointer(operationPointer(pathStr, entry), 'parameters');
    // A slot as the user wrote it: its index in the source list
    const source = (slot: ParameterSlot): ParameterSlot => ({ ...slot, index: this.sourceIndex(listOf(slot.level), slot.index) });
    const pointerOf = (slot: ParameterSlot): string => appendPointer(listPointer(slot.level), source(slot).index);
    const pathLevel = this.withTextNames(Array.isArray(pathList) ? pathList : [], listPointer('path'));
    const operationLevel = this.withTextNames(Array.isArray(operationList) ? operationList : [], listPointer('operation'));
    const analysis = analyzeParameters(pathLevel, operationLevel);
    for (const { dropped, kept } of analysis.duplicates) {
      this.addDiagnostic(duplicateParameterDiagnostic(source(dropped), source(kept), listPointer(dropped.level)));
    }
    if (analysis.querystring) {
      return { skip: this.querystringDiagnostic(pathStr, entry, analysis.querystring, pointerOf(analysis.querystring.slot)) };
    }
    for (const slot of analysis.effective) {
      const pointer = pointerOf(slot);
      for (const problem of parameterContentDiagnostics(slot.parameter, pointer)) this.addDiagnostic(problem);
      const generationOnly = this.parameterUseDiagnostic(slot.parameter, pointer);
      if (generationOnly !== undefined) this.addDiagnostic(generationOnly);
    }
    return { analysis, pointerOf, pathLevel, operationLevel };
  }

  /**
   * Problems of a parameter read from `content` that only generation sees
   * (the validator reads the document before it is dereferenced):
   *
   * - `INVALID_PARAMETER_CONTENT`: the media type is a Reference Object
   *   left unresolved (`dereference: false`, or a `$ref` the dereferencer
   *   could not follow), so its schema is not read;
   * - `COOKIE_CONTENT_NOT_SENDABLE`: a cookie parameter sent as JSON whose
   *   schema allows a string, an object or an array. Their JSON text holds a
   *   `"` (and an object or array a `,`), which a cookie value cannot carry
   *   (RFC 6265), so `buildHttpRequest` refuses such a value: only numbers,
   *   booleans and `null` can be sent. The tool is still made.
   */
  private parameterUseDiagnostic(parameter: unknown, pointer: string): SpecDiagnostic | undefined {
    if (!isSpecObject(parameter) || isReferenceObject(parameter)) return undefined;
    // Read from `content` only without `schema`, or in the query string
    const schema = parameter['schema'];
    if (parameter['in'] !== 'querystring' && schema !== undefined && schema !== null) return undefined;
    const content = readParameterContent(parameter);
    if (content.kind !== 'media') return undefined;
    const label = `Parameter ${describeValue(parameter['name'])} (in: ${describeValue(parameter['in'])})`;
    const mediaType = describeValue(content.mediaType);
    if (content.media !== undefined && isReferenceObject(content.media)) {
      return {
        severity: 'warning',
        code: DIAGNOSTIC_CODES.INVALID_PARAMETER_CONTENT,
        message:
          `${label}: the media type ${mediaType} is a reference that is not resolved, so its schema is not read; ` +
          describeContentWithoutSchema(content.mediaType),
        path: pointer,
      };
    }
    if (parameter['in'] !== 'cookie' || !isJsonMediaType(content.mediaType)) return undefined;
    if (onlyScalarJson(ownProperty(content.media, 'schema'))) return undefined;
    return {
      severity: 'warning',
      code: DIAGNOSTIC_CODES.COOKIE_CONTENT_NOT_SENDABLE,
      message:
        `${label} is sent as ${mediaType}, but its schema allows a string, an object or an array, whose JSON text ` +
        `holds characters a cookie value cannot carry ('"', ','); a call with such a value fails, only a number, ` +
        `boolean or null can be sent`,
      path: pointer,
    };
  }

  /**
   * `QUERYSTRING_WITH_QUERY_CREDENTIAL`, one per scheme: the operation's
   * whole-query parameter is serialized in a media type other than
   * `application/x-www-form-urlencoded`, so the query string has no
   * name=value pairs, yet a security scheme can send an API key in the query
   * string. `buildHttpRequest` refuses to combine them, so a call
   * authenticating with that scheme fails. The tool is still made.
   */
  private wholeQueryCredentialDiagnostics(
    pathStr: string,
    entry: OperationEntry,
    analysis: ParameterAnalysis,
    pointerOf: (slot: ParameterSlot) => string,
    securityRequirements: SecurityRequirement[] | undefined,
  ): SpecDiagnostic[] {
    const querystring = analysis.effective.find((slot) => ownProperty(slot.parameter, 'in') === 'querystring');
    if (querystring === undefined) return [];
    // A checked querystring parameter has a media type
    const { mediaType } = readParameterContent(querystring.parameter) as { mediaType: string };
    if (classifyMediaType(mediaType) === 'form') return [];
    const schemes = new Set(
      (securityRequirements ?? []).filter((r) => r.type === 'apiKey' && r.in === 'query').map((r) => r.scheme),
    );
    return [...schemes].map((scheme) => ({
      severity: 'warning' as const,
      code: DIAGNOSTIC_CODES.QUERYSTRING_WITH_QUERY_CREDENTIAL,
      message:
        `${operationLabel(entry.method, pathStr)}: parameter ${describeValue(ownProperty(querystring.parameter, 'name'))} ` +
        `holds the whole query string as ${describeValue(mediaType)}, which has no name=value pairs, but security ` +
        `scheme ${describeValue(scheme)} sends its API key in the query string; a call using that scheme cannot be ` +
        `built (send the key in a header or a cookie, or use application/x-www-form-urlencoded)`,
      path: pointerOf(querystring),
    }));
  }

  /** The diagnostic skipping an operation whose parameters break a querystring rule; `pointer` locates `problem.slot`. */
  private querystringDiagnostic(
    pathStr: string,
    entry: OperationEntry,
    problem: QuerystringProblem,
    pointer: string,
  ): SpecDiagnostic {
    const label = operationLabel(entry.method, pathStr);
    const name = describeValue(ownProperty(problem.slot.parameter, 'name'));
    let message: string;
    if (problem.code === 'MULTIPLE_QUERYSTRING_PARAMETERS') {
      message =
        `${label}: ${problem.querystrings} parameters are in: querystring (path-level ones included), but at most ` +
        `one is allowed, as each holds the whole query string; the operation makes no tool`;
    } else if (problem.code === 'QUERYSTRING_WITH_QUERY_PARAMETERS') {
      message =
        `${label}: parameter ${name} is in: querystring, which holds the whole query string, but the operation also ` +
        `has parameters in: query (path-level ones included); the operation makes no tool`;
    } else {
      const content = readParameterContent(problem.slot.parameter);
      const found =
        content.kind === 'absent'
          ? 'no content'
          : content.kind === 'empty'
            ? 'a content with no media type'
            : `a content that is not a map of media types (${describeValue((content as { value: unknown }).value)})`;
      message =
        `${label}: parameter ${name} is in: querystring but has ${found}; it must define content with one media ` +
        `type, which serializes the whole query string; the operation makes no tool`;
    }
    return { severity: 'warning', code: DIAGNOSTIC_CODES[problem.code], message, path: pointer };
  }

  /**
   * `REQUIRED_INPUT_ACCEPTS_NOTHING`, one per required input (a parameter, a
   * body property or a whole body) whose schema accepts no value: `false`, or
   * `{ not: {} }` (`isNeverSchema`). No call of the tool can be valid; it is
   * still made, as the document describes it.
   */
  private requiredInputDiagnostics(pathStr: string, entry: OperationEntry, inputSchema: JsonSchema): SpecDiagnostic[] {
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    return required
      .filter((key) => isNeverSchema(ownProperty(inputSchema.properties, key)))
      .map((key) => ({
        severity: 'warning' as const,
        code: DIAGNOSTIC_CODES.REQUIRED_INPUT_ACCEPTS_NOTHING,
        message:
          `${operationLabel(entry.method, pathStr)}: the required input ${describeValue(key)} accepts no value (its ` +
          `schema is false, or { not: {} }), so no call of the tool can succeed; the tool is still made`,
        path: operationPointer(pathStr, entry),
      }));
  }

  /**
   * `UNSUPPORTED_STREAMING_REQUEST_BODY` when the media type a request body
   * is read in declares `itemSchema` (OpenAPI 3.2, a streamed upload) and no
   * `schema`: the body is left out of the tool's input.
   */
  private streamingRequestBodyDiagnostic(pathStr: string, entry: OperationEntry): SpecDiagnostic | undefined {
    const content = ownProperty(ownProperty(entry.operation, 'requestBody'), 'content');
    if (!isSpecObject(content)) return undefined;
    const mediaType = selectRequestMediaType(content);
    // The resolver reads the body when its media type has a schema (`false` included)
    const media = mediaType === undefined ? undefined : ownProperty(content, mediaType);
    if (!isSpecObject(media) || isPresentSchema(media['schema'])) return undefined;
    const itemSchema = ownProperty(media, 'itemSchema');
    if (itemSchema === undefined || itemSchema === null) return undefined;
    return {
      severity: 'warning',
      code: DIAGNOSTIC_CODES.UNSUPPORTED_STREAMING_REQUEST_BODY,
      message:
        `${operationLabel(entry.method, pathStr)}: the request body's media type ${describeValue(mediaType)} ` +
        `declares only itemSchema (a streamed body), which is not supported; the tool takes no body input`,
      path: appendPointer(operationPointer(pathStr, entry), 'requestBody', 'content', mediaType!, 'itemSchema'),
      // A Swagger 2.0 document has no request body: it is one of the conversion's, which never
      // declares itemSchema, so this is defensive
      /* c8 ignore next */
      ...(this.swagger ? { document: 'converted' as const } : {}),
    };
  }

  /**
   * Build the tool for one operation (an entry of `walkPathItem` or
   * `getOperation`) of the initialized document
   */
  private buildTool(
    pathStr: string,
    pathItem: PathItemObject,
    entry: OperationEntry,
    options: GenerateOptions,
  ): McpOpenAPITool {
    const document = this.getDocument();
    // The canonical method from here on: lowercase for a fixed field, the
    // additionalOperations key as written
    const { method, operation } = entry;

    const parameterCheck = this.checkParameters(pathStr, entry, pathItem);
    if (parameterCheck.skip !== undefined) {
      throw this.skipOperation(parameterCheck.skip, { path: pathStr, method });
    }
    const streamingBody = this.streamingRequestBodyDiagnostic(pathStr, entry);
    if (streamingBody !== undefined) this.addDiagnostic(streamingBody);

    // Extract security requirements, once: both the mapper and the metadata
    // read them (an operation's own `security` replaces the document's)
    let securityRequirements: SecurityRequirement[] | undefined = undefined;
    const securitySpec = operation.security ?? document.security;
    if (securitySpec) {
      const securityPointer =
        operation.security !== undefined ? appendPointer(operationPointer(pathStr, entry), 'security') : '/security';
      const extracted = this.extractSecurityRequirements(securitySpec, document, securityPointer);
      if (extracted.unsatisfiable) {
        throw this.skipOperation(
          {
            severity: 'warning',
            code: DIAGNOSTIC_CODES.UNSATISFIABLE_SECURITY,
            message:
              `${operationLabel(method, pathStr)}: none of its Security Requirements can be satisfied (each names a ` +
              `scheme components.securitySchemes does not define, or is not an object), so no way to authenticate ` +
              `is known; the operation makes no tool`,
            path: operationPointer(pathStr, entry),
          },
          { path: pathStr, method },
        );
      }
      securityRequirements = extracted.requirements;
    }
    for (const diagnostic of this.wholeQueryCredentialDiagnostics(
      pathStr,
      entry,
      parameterCheck.analysis,
      parameterCheck.pointerOf,
      securityRequirements,
    )) {
      this.addDiagnostic(diagnostic);
    }

    // Schema limits: conversion stops descending at the same depth the final
    // truncation cuts at (so work stays bounded by what the output keeps), and
    // both phases share the node budget
    const { maxDepth: maxSchemaDepth, maxNodes: maxSchemaNodes } = resolveSchemaLimits(options);
    const schemaConversion = { maxDepth: maxSchemaDepth, maxNodes: maxSchemaNodes };

    // Resolve parameters
    const parameterResolver = new ParameterResolver(options.namingStrategy, {
      includeExamples: options.includeExamples,
      schemaConversion,
    });

    // Filter out ReferenceObjects from parameters (an operation was found, so
    // the path item is an object)
    // The lists as checked: a number or boolean `name` read as its text
    let pathParameters: ParameterObject[] | undefined = undefined;
    if (pathItem.parameters) {
      const list = Array.isArray(pathItem.parameters)
        ? (parameterCheck.pathLevel as typeof pathItem.parameters)
        : pathItem.parameters;
      pathParameters = list.filter((p): p is ParameterObject => !isReferenceObject(p));
    }
    const resolvedOperation =
      Array.isArray(operation.parameters) && parameterCheck.operationLevel !== operation.parameters
        ? { ...operation, parameters: parameterCheck.operationLevel as typeof operation.parameters }
        : operation;

    const { inputSchema, mapper } = parameterResolver.resolve(
      resolvedOperation,
      pathParameters,
      securityRequirements,
      options.includeSecurityInInput,
    );
    for (const diagnostic of this.requiredInputDiagnostics(pathStr, entry, inputSchema)) this.addDiagnostic(diagnostic);

    // Build response schema, and the streamed response's item schema (OpenAPI
    // 3.2 `itemSchema`), which is reported in metadata, never as outputSchema
    const responseBuilder = new ResponseBuilder(options, schemaConversion);
    const outputSchema = responseBuilder.build(operation.responses);
    const responseStream = responseBuilder.buildStream(operation.responses);

    // Extension overrides (x-speakeasy-mcp < x-mcp < x-frontmcp); their meta
    // shares the node budget, as $refs in it are dereferenced too
    const overrides = extractExtensionOverrides(operation, { maxMetaNodes: maxSchemaNodes });

    // Generate tool name (an extension name override takes the operationId's
    // place, including as the value passed to a custom toolNameGenerator)
    const name = this.generateToolName(pathStr, method, overrides.name ?? operation.operationId, options, operation);

    // Generate description (extension override > strategy)
    const description =
      overrides.description ??
      composeDescription(operation, method, pathStr, options.descriptionStrategy ?? 'summaryOnly');

    // Display title (MCP Tool.title): extension override, else operation summary
    const title = overrides.title ?? operation.summary;

    // Annotations: HTTP-method inference (opt-out) + extension overrides on top.
    // `method` is canonical, so a generateTool(path, 'GET') call infers like 'get'.
    const inferred = options.inferAnnotations !== false ? inferAnnotationsFromMethod(method) : undefined;
    const annotations =
      inferred || overrides.annotations ? { ...inferred, ...overrides.annotations } : undefined;

    // Extract metadata
    const metadata = this.extractMetadata(pathStr, method, operation, document, outputSchema, securityRequirements);

    // Apply format resolution if configured
    const formatResolvers = {
      ...(options.resolveFormats ? BUILTIN_FORMAT_RESOLVERS : {}),
      ...options.formatResolvers,
    };
    const hasFormatResolvers = Object.keys(formatResolvers).length > 0;
    let resolvedInputSchema = hasFormatResolvers ? resolveSchemaFormats(inputSchema, formatResolvers) : inputSchema;
    let resolvedOutputSchema = hasFormatResolvers && outputSchema ? resolveSchemaFormats(outputSchema, formatResolvers) : outputSchema;
    // The stream's item schema goes through every step an output schema does
    let itemSchema = responseStream?.itemSchema;
    if (hasFormatResolvers && itemSchema) itemSchema = resolveSchemaFormats(itemSchema, formatResolvers);

    // Bound schema nesting depth (applied last so the final schemas are
    // bounded). Floor of 1: depth 0 would strip the ROOT inputSchema's
    // properties while the mapper still lists every parameter. This also
    // materializes the conversion's shared subschemas into independent copies.
    const truncateOptions = { maxNodes: maxSchemaNodes };
    resolvedInputSchema = SchemaBuilder.truncateDepth(resolvedInputSchema, maxSchemaDepth, truncateOptions);
    if (resolvedOutputSchema) {
      resolvedOutputSchema = SchemaBuilder.truncateDepth(resolvedOutputSchema, maxSchemaDepth, truncateOptions);
    }
    if (itemSchema) itemSchema = SchemaBuilder.truncateDepth(itemSchema, maxSchemaDepth, truncateOptions);

    // Trimming controls (after depth truncation, before client targets so the
    // dialect transforms see the final trimmed shape). Description caps run
    // BEFORE limitProperties so the "[N properties omitted]" notes survive.
    const applyTrim = (schema: JsonSchema, isInputRoot: boolean): JsonSchema => {
      let trimmed = schema;
      if (options.stripExamples) trimmed = SchemaBuilder.stripExamples(trimmed);
      if (options.maxDescriptionLength !== undefined) {
        trimmed = SchemaBuilder.capDescriptions(trimmed, options.maxDescriptionLength);
      }
      if (options.maxProperties !== undefined) {
        if (isInputRoot) {
          // ROOT input properties are mapper-backed parameters — dropping one
          // makes required calls impossible. The cap applies per parameter
          // subtree; the parameter list itself is never trimmed.
          const properties = trimmed.properties;
          if (properties && typeof properties === 'object') {
            const limited: Record<string, JsonSchema> = {};
            for (const [key, value] of Object.entries(properties)) {
              limited[key] = SchemaBuilder.limitProperties(value as JsonSchema, options.maxProperties);
            }
            trimmed = { ...trimmed, properties: limited };
          }
        } else {
          trimmed = SchemaBuilder.limitProperties(trimmed, options.maxProperties);
        }
      }
      return trimmed;
    };
    if (options.stripExamples || options.maxProperties !== undefined || options.maxDescriptionLength !== undefined) {
      resolvedInputSchema = applyTrim(resolvedInputSchema, true);
      if (resolvedOutputSchema) {
        resolvedOutputSchema = applyTrim(resolvedOutputSchema, false);
      }
      if (itemSchema) itemSchema = applyTrim(itemSchema, false);
    }

    // Client dialect transforms (final step — the emitted schemas must be
    // exactly what the targeted client accepts)
    if (options.target) {
      // Inlining local $refs expands each definition once per reference: bounded like the schemas
      const targetOptions = { maxNodes: maxSchemaNodes };
      resolvedInputSchema = applyClientTarget(resolvedInputSchema, options.target, targetOptions);
      if (resolvedOutputSchema) {
        resolvedOutputSchema = applyClientTarget(resolvedOutputSchema, options.target, targetOptions);
      }
      if (itemSchema) itemSchema = applyClientTarget(itemSchema, options.target, targetOptions);
    }

    // Response-shaping hints (computed on the FINAL output schema)
    const responseHints = detectResponseHints(resolvedOutputSchema, mapper, responseStream !== undefined);
    if (responseHints) {
      metadata.responseHints = responseHints;
    }

    // Optional compact response summary appended to the description
    let finalDescription = description;
    if (options.appendResponseSummary && resolvedOutputSchema) {
      const summary = summarizeOutputSchema(resolvedOutputSchema);
      if (summary) {
        finalDescription = `${finalDescription}\n\nReturns: ${summary}`;
      }
    }

    // TypeScript call contract (computed on the FINAL schemas)
    if (options.emitTypeSignatures) {
      metadata.typescript = emitToolTypeScript(name, finalDescription, resolvedInputSchema, resolvedOutputSchema, {
        // Print at least as deep as the schemas were truncated, so the
        // emitted types never collapse levels the schema still carries.
        maxDepth: Math.max(1, options.maxSchemaDepth ?? 10),
      });
    }

    // Values from the spec outside the schemas — the title, the mapper's
    // encodings, the metadata (tags, servers, externalDocs, x-frontmcp, ...),
    // and _meta's operation entry — are copied like schema values: into fresh
    // trees that share nothing with the document, bounded by the node budget
    // because a `$ref` resolved inside one can expand exponentially
    const valueBudget: CopyBudget = {
      maxNodes: maxSchemaNodes,
      nodes: 0,
      exceeded: () => {
        throw new SchemaError(
          `The metadata of ${operationLabel(method, pathStr)} exceeds the node budget of ${maxSchemaNodes} ` +
            `(maxSchemaNodes): with its $refs resolved, a value copied from the spec (tags, servers, externalDocs, ` +
            `x-frontmcp, request encodings, ...) expands into more nodes than allowed.`,
          { maxNodes: maxSchemaNodes },
        );
      },
    };
    const copyValue = <T>(value: T, label: string, omitPrototypeKeys = false): T =>
      copyJsonValue(value, valueBudget, { label, omitPrototypeKeys }) as T;
    // The mapper has an entry per parameter, built here: only the objects in
    // it (serialization, encodings, security) can hold values from the spec,
    // so only they count — a wide body must not exhaust the budget
    const copyEntry = (entry: ParameterMapper): ParameterMapper => {
      const copy = { ...entry } as Record<string, unknown>;
      for (const key of Object.keys(copy)) {
        const value = copy[key];
        if (value !== null && typeof value === 'object') copy[key] = copyValue(value, 'A parameter mapper entry');
      }
      return copy as unknown as ParameterMapper;
    };

    // MCP `_meta`: generated operation entry (opt-in) + extension pass-through (always)
    let toolMeta: Record<string, unknown> | undefined;
    if (overrides.meta) {
      // Extension meta may not claim the generated reserved namespace —
      // consumers must be able to trust `dev.agentfront.openapi/*` entries
      toolMeta = {};
      for (const [key, value] of Object.entries(overrides.meta)) {
        if (!key.startsWith('dev.agentfront.openapi/')) {
          toolMeta[key] = value;
        }
      }
    }
    if (options.emitMeta) {
      const info = document.info as Record<string, unknown> | undefined;
      toolMeta = {
        ...toolMeta,
        'dev.agentfront.openapi/operation': copyValue(
          {
            path: pathStr,
            method,
            ...(operation.operationId !== undefined && { operationId: operation.operationId }),
            ...(operation.tags && { tags: operation.tags }),
            ...(operation.deprecated !== undefined && { deprecated: operation.deprecated }),
            ...(typeof info?.['title'] === 'string' && { specTitle: info['title'] }),
            ...(typeof info?.['version'] === 'string' && { specVersion: info['version'] }),
          },
          'The _meta operation entry',
          true,
        ),
      };
    }
    if (toolMeta && Object.keys(toolMeta).length === 0) {
      toolMeta = undefined;
    }

    // Icons: extension-supplied wins; document logo only on explicit opt-in
    const icons =
      overrides.icons ?? (options.inheritDocumentIcons ? iconsFromInfoLogo(document.info) : undefined);

    const toolMetadata = copyValue(metadata, 'The tool metadata');
    if (responseStream) {
      // The item schema is a fresh tree already (depth truncation copies), like the output schema
      toolMetadata.responseStream = {
        statusCode: responseStream.statusCode,
        contentType: responseStream.contentType,
        itemSchema: itemSchema!,
      };
    }

    return {
      name,
      ...(title !== undefined && { title: copyValue(title, 'The tool title') }),
      description: finalDescription,
      ...(annotations && { annotations }),
      ...(toolMeta && { _meta: toolMeta }),
      ...(icons && { icons }),
      inputSchema: resolvedInputSchema,
      outputSchema: resolvedOutputSchema,
      mapper: mapper.map(copyEntry),
      metadata: toolMetadata,
    };
  }

  /**
   * Check if an operation should be included
   */
  private shouldIncludeOperation(
    operation: OperationObject,
    path: string,
    method: string,
    options: GenerateOptions,
    document: OpenAPIDocument,
    pathItem: PathItemObject,
  ): boolean {
    // Extension enable/exclude with root < path < operation precedence
    // (x-mcp at every level; the whole family at the operation level)
    if (!resolveExtensionEnabled(document, pathItem, operation)) {
      return false;
    }

    // Check deprecated
    if (operation.deprecated && !options.includeDeprecated) {
      return false;
    }

    // Method filters: a standard method in any case, an additional one as written
    if (options.includeMethods && !matchesMethodFilter(options.includeMethods, method)) {
      return false;
    }
    if (options.excludeMethods && matchesMethodFilter(options.excludeMethods, method)) {
      return false;
    }

    // Path glob filters
    if (options.includePaths && !matchesAnyGlob(path, options.includePaths)) {
      return false;
    }
    if (options.excludePaths && matchesAnyGlob(path, options.excludePaths)) {
      return false;
    }

    // Tag filters
    const tags = operation.tags ?? [];
    if (options.includeTags && !tags.some((tag) => options.includeTags!.includes(tag))) {
      return false;
    }
    if (options.excludeTags && tags.some((tag) => options.excludeTags!.includes(tag))) {
      return false;
    }

    // Check operation ID filters
    if (options.includeOperations && operation.operationId) {
      if (!options.includeOperations.includes(operation.operationId)) {
        return false;
      }
    }

    if (options.excludeOperations && operation.operationId) {
      if (options.excludeOperations.includes(operation.operationId)) {
        return false;
      }
    }

    // Read-only safety switch: effective annotations must say read-only.
    // Uses inference + extension overrides even when inferAnnotations is off —
    // the filter's semantics must not depend on output formatting options.
    if (options.readOnlyOnly) {
      const effective = {
        ...inferAnnotationsFromMethod(method),
        ...extractExtensionSettings(operation).annotations,
      };
      if (effective.readOnlyHint !== true) {
        return false;
      }
    }

    // Custom filter
    if (options.filterFn) {
      return options.filterFn({
        ...operation,
        path,
        method,
      } as OperationWithContext);
    }

    return true;
  }

  /**
   * Generate a tool name
   */
  private generateToolName(
    path: string,
    method: HTTPMethod,
    operationId?: string,
    options: GenerateOptions = {},
    operation?: OperationObject,
  ): string {
    let rawName: string;

    if (options.namingStrategy?.toolNameGenerator) {
      rawName = options.namingStrategy.toolNameGenerator(path, method, operationId, operation);
    } else if (operationId) {
      rawName = operationId;
    } else {
      // Generate from path and method
      const sanitized = trimUnderscores(
        path
          .replace(/\{([^{}]+)\}/g, 'By_$1')
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .replace(/_+/g, '_'),
      );

      rawName = `${method}_${sanitized}`;
    }

    // MCP name rules are hard client constraints, so they apply to every
    // source — operationIds and custom toolNameGenerator output included.
    return normalizeToolName(
      rawName,
      options.maxToolNameLength ?? DEFAULT_MAX_TOOL_NAME_LENGTH,
      `${method} ${path}`,
    );
  }

  /**
   * Extract metadata from operation
   */
  private extractMetadata(
    path: string,
    method: HTTPMethod,
    operation: OperationObject,
    document: OpenAPIDocument,
    outputSchema: unknown,
    securityRequirements: SecurityRequirement[] | undefined,
  ): ToolMetadata {
    const metadata: ToolMetadata = {
      path,
      method,
      operationId: operation.operationId,
      operationSummary: operation.summary,
      operationDescription: operation.description,
      tags: operation.tags,
      deprecated: operation.deprecated,
    };

    // Security requirements (extracted once by buildTool; copied with the metadata)
    if (securityRequirements) {
      metadata.security = securityRequirements;
    }

    // Extract servers
    const servers = operation.servers ?? document.servers;
    if (servers) {
      metadata.servers = servers.map((server: ServerObject) => {
        // OpenAPI 3.2 `name`, when the document gives a string
        const name = ownProperty(server, 'name');
        return {
          url: this.options.baseUrl || server.url,
          ...(typeof name === 'string' && { name }),
          description: server.description,
          // A parsed document's maps hold no `undefined` values
          variables: server.variables as ServerInfo['variables'],
        };
      });
    } else if (this.options.baseUrl) {
      metadata.servers = [{ url: this.options.baseUrl }];
    }

    // Extract response status codes (preserve 0 for default responses); a
    // range (`'2XX'`) is a string, listed apart
    const schemaObj = outputSchema as Record<string, unknown> | undefined;
    const statuses: unknown[] =
      schemaObj && Array.isArray(schemaObj['oneOf'])
        ? (schemaObj['oneOf'] as Record<string, unknown>[]).map((schema) => schema['x-status-code'])
        : [schemaObj?.['x-status-code']];
    const codes = statuses.filter((code): code is number => typeof code === 'number');
    if (codes.length > 0) {
      metadata.responseStatusCodes = codes;
    }
    const ranges = statuses.filter((code): code is ResponseStatusRange => typeof code === 'string');
    if (ranges.length > 0) {
      metadata.responseStatusRanges = ranges;
    }

    // External docs
    if (operation.externalDocs) {
      metadata.externalDocs = operation.externalDocs;
    }

    // FrontMCP extension (x-frontmcp)
    const operationWithExt = operation as WithExtensions<OperationObject>;
    if (operationWithExt['x-frontmcp']) {
      metadata.frontmcp = operationWithExt['x-frontmcp'] as ToolMetadata['frontmcp'];
    }

    return metadata;
  }

  /**
   * Extract security requirements. `pointer` locates `security` (the
   * operation's, or the document's `/security`) for diagnostics.
   *
   * `security` lists alternatives; each Security Requirement Object lists
   * schemes that are all required together. A scheme is found by component
   * name or, from OpenAPI 3.2, by a URI naming one of this document's schemes
   * (`findSecurityScheme`; reported under its component name, and named
   * twice in one object it counts once, with the scopes of both). An object
   * naming a scheme that is not found (a typo, another document's scheme)
   * cannot be satisfied, so the whole object is dropped, with one
   * `UNRESOLVED_SECURITY_SCHEME` per missing scheme; an object that is not an
   * object is dropped with `INVALID_SECURITY_REQUIREMENT`. An empty object
   * (`{}`, no authentication) is kept. The kept objects' schemes are
   * returned, flattened as before.
   *
   * `unsatisfiable` is true when `security` is not empty and every object was
   * dropped, and the document defines security schemes: earlier releases
   * failed such a tool (with a `TypeError`). A document defining no schemes
   * at all keeps the output it always had: its requirements are reported but
   * the tool is generated, with no security.
   */
  private extractSecurityRequirements(
    security: unknown,
    document: OpenAPIDocument,
    pointer: string,
  ): { requirements: SecurityRequirement[]; unsatisfiable: boolean } {
    const schemes: unknown = document.components?.securitySchemes;
    if (!Array.isArray(security)) {
      // Not a list: without schemes there was never anything to read; with
      // them the tool fails, as it always has (now with a typed error)
      if (!schemes) return { requirements: [], unsatisfiable: false };
      throw new GenerationError(
        `${pointer} must be an array of Security Requirement Objects, found ${describeValue(security)}`,
        { pointer },
      );
    }

    const requirements: SecurityRequirement[] = [];
    let kept = 0;
    security.forEach((requirement: unknown, index: number) => {
      if (!isSpecObject(requirement)) {
        this.addDiagnostic({
          severity: 'warning',
          code: DIAGNOSTIC_CODES.INVALID_SECURITY_REQUIREMENT,
          message: `A Security Requirement must be an object, found ${describeValue(requirement)}; it is dropped`,
          path: appendPointer(pointer, index),
        });
        return;
      }
      const resolved: SecurityRequirement[] = [];
      // The component each scheme resolved to: a URI and a name can both name one
      const byComponent = new Map<string, SecurityRequirement>();
      let satisfiable = true;
      for (const [scheme, scopes] of Object.entries(requirement)) {
        const found = this.findSecurityScheme(scheme, schemes);
        if ('scheme' in found) {
          const seen = byComponent.get(found.name);
          if (seen === undefined) {
            const entry = this.toSecurityRequirement(found.name, scopes as string[], found.scheme);
            byComponent.set(found.name, entry);
            resolved.push(entry);
          } else if (Array.isArray(scopes)) {
            // Both are required together, so the scopes of both are
            const merged = Array.isArray(seen.scopes) ? [...seen.scopes] : [];
            for (const scope of scopes as string[]) if (!merged.includes(scope)) merged.push(scope);
            seen.scopes = merged;
          }
          continue;
        }
        satisfiable = false;
        this.addDiagnostic({
          severity: 'warning',
          code: DIAGNOSTIC_CODES.UNRESOLVED_SECURITY_SCHEME,
          message:
            `Security Requirement names scheme ${describeValue(scheme)}, which ${found.problem}; the requirement ` +
            `cannot be satisfied and is dropped with every scheme it combines`,
          path: appendPointer(pointer, index, scheme),
        });
      }
      if (!satisfiable) return;
      kept++;
      requirements.push(...resolved);
    });
    return { requirements, unsatisfiable: Boolean(schemes) && security.length > 0 && kept === 0 };
  }

  /**
   * The Security Scheme Object a Security Requirement key names, with the
   * component name it is reported under, or why none is found (for an
   * `UNRESOLVED_SECURITY_SCHEME` message: "names scheme X, which ...").
   *
   * A key that is the name of a component of `components.securitySchemes` is
   * that component, always: OpenAPI 3.2 gives the name precedence over a URI.
   * In a document declaring OpenAPI 3.2 or later, another key that holds `:`,
   * `/` or `#` is read as a URI reference (`resolveSecuritySchemeUri`): it
   * names the component `<name>` when it resolves to this document with the
   * fragment `/components/securitySchemes/<name>`. A key without those
   * characters (`foo`) could only be a relative reference to another
   * document, so it is reported simply as not defined. Another document's
   * schemes are never read.
   */
  private findSecurityScheme(
    key: string,
    schemes: unknown,
  ): { name: string; scheme: Record<string, unknown> } | { problem: string } {
    // Own properties only: a scheme named `constructor` is not Object's
    const found = ownProperty(schemes, key);
    if (isSpecObject(found)) return { name: key, scheme: found };
    const notDefined = 'components.securitySchemes does not define';
    if (!/[:#/]/.test(key)) return { problem: notDefined };
    const family = this.specVersion.family;
    if (family === undefined || !isFeatureAvailable('securitySchemeUri', family)) {
      return { problem: `${notDefined} (a scheme named by URI needs OpenAPI 3.2 or later)` };
    }
    const target = resolveSecuritySchemeUri(key, this.documentBase);
    if ('problem' in target) return { problem: `${notDefined}, and read as a URI it ${target.problem}` };
    const byUri = ownProperty(schemes, target.name);
    if (isSpecObject(byUri)) return { name: target.name, scheme: byUri };
    return {
      problem: `names the scheme ${describeValue(target.name)} of this document by URI, but ${notDefined} it`,
    };
  }

  /** One resolved scheme of a Security Requirement, as tool metadata. */
  private toSecurityRequirement(scheme: string, scopes: string[], found: Record<string, unknown>): SecurityRequirement {
    const securityScheme = found as unknown as SecuritySchemeObject | ReferenceObject;

    // Skip if it's a reference object
    if (isReferenceObject(securityScheme)) {
      return { scheme, type: 'http', scopes };
    }

    // Typed as a plain string so the equality checks below narrow it to the known locations
    const apiKeyIn: string | undefined = 'in' in securityScheme ? securityScheme.in : undefined;
    const result: SecurityRequirement = {
      scheme,
      type: securityScheme.type as AuthType,
      scopes,
      name: 'name' in securityScheme ? securityScheme.name : undefined,
      in:
        apiKeyIn && (apiKeyIn === 'query' || apiKeyIn === 'header' || apiKeyIn === 'cookie') ? apiKeyIn : undefined,
    };

    // Add HTTP-specific metadata
    if (securityScheme.type === 'http') {
      result.httpScheme = 'scheme' in securityScheme ? securityScheme.scheme : undefined;
      result.bearerFormat = 'bearerFormat' in securityScheme ? securityScheme.bearerFormat : undefined;
    }

    // Add description if available
    result.description = 'description' in securityScheme ? securityScheme.description : undefined;

    return result;
  }
}
