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
} from './types';
import { DIAGNOSTIC_CODES, MAX_DIAGNOSTICS } from './types';
import {
  appendPointer,
  describeValue,
  detectSpecVersion,
  getOperation,
  isSpecObject,
  jsonPointer,
  listOperations,
  ownProperty,
  resolveOperationLayout,
  toStandardMethod,
  wireMethod,
  diagnosticKey,
  type OperationEntry,
  type OperationLayout,
  type SpecDiagnostic,
  type SpecVersionInfo,
  type WithExtensions,
} from './spec';
import type { ParserOptions } from '@apidevtools/json-schema-ref-parser';
import { isReferenceObject } from './types';
import { ParameterResolver } from './parameter-resolver';
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
  messageText,
  operationLabel,
  operationPointer,
  skippedOperationDiagnostics,
  versionError,
} from './validator';
import { GenerationError, LoadError, OverlayError, ParseError, SchemaError } from './errors';
import { BUILTIN_FORMAT_RESOLVERS, resolveSchemaFormats } from './format-resolver';
import { emitToolTypeScript } from './type-signature';
import { hostListIncludes, isBlockedHostname, normalizeSsrfOptions, safeFetch } from './ssrf';
import { copyJsonValue, type CopyBudget } from './json-copy';

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
 * Parameter locations the generator maps to a request. A parameter in any
 * other location (`querystring` until it is implemented, a Swagger-style
 * `body`, a missing `in`) would reach the mapper as an entry no request
 * builder understands, so its operation is skipped with a
 * `UNSUPPORTED_PARAMETER_LOCATION` diagnostic instead.
 */
const MAPPED_PARAMETER_LOCATIONS: readonly string[] = Object.freeze(['path', 'query', 'header', 'cookie']);

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

/** Compute response-shaping hints; undefined when there is nothing to say. */
function detectResponseHints(
  outputSchema: JsonSchema | undefined,
  mapper: McpOpenAPITool['mapper'],
): ToolMetadata['responseHints'] {
  const paginationParams = [
    ...new Set(mapper.filter((m) => m.type === 'query' && !m.security && PAGINATION_PARAM.test(m.key)).map((m) => m.key)),
  ];
  const unboundedArray = outputSchema !== undefined && hasUnboundedArray(outputSchema);

  if (!unboundedArray && paginationParams.length === 0) return undefined;

  return {
    ...(unboundedArray && { unboundedArray: true }),
    ...(paginationParams.length > 0 && { paginationParams }),
    ...(unboundedArray && paginationParams.length === 0 && { largeResponseRisk: true }),
  };
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
  private document: OpenAPIDocument;
  private dereferencedDocument?: OpenAPIDocument;
  private options: Required<Omit<LoadOptions, 'overlays'>> & Pick<LoadOptions, 'overlays'>;
  /** The version the document declares, read once after overlays apply */
  private readonly specVersion: SpecVersionInfo;
  /** The operation fields read: those the declared version defines (`resolveOperationLayout`) */
  private readonly operationLayout: OperationLayout;
  /** Validation of the (dereferenced) document: the document never changes after load, so it runs once */
  private validation?: Promise<ValidationResult>;
  /** Diagnostics in the order first noticed, keyed by `diagnosticKey`; at most `MAX_DIAGNOSTICS` */
  private readonly diagnostics = new Map<string, SpecDiagnostic>();
  /** Whether a diagnostic was refused because the list was full */
  private diagnosticsTruncated = false;
  /** Paths (`pathKey`) whose Path Item diagnostics are recorded */
  private readonly walkedPaths = new Set<string>();

  /**
   * Private constructor - use static factory methods to create instances
   */
  private constructor(document: OpenAPIDocument, rawOptions: LoadOptions = {}) {
    this.document = document;
    const options = applySecureDefaults(rawOptions);
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
    this.operationLayout = resolveOperationLayout(this.specVersion);
    for (const diagnostic of this.specVersion.diagnostics) this.addDiagnostic(diagnostic);
    const problem = versionError(this.specVersion);
    if (problem !== undefined) this.addDiagnostic(fromValidationWarning(problem));
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
      this.diagnosticsTruncated = true;
      return;
    }
    this.diagnostics.set(key, { ...diagnostic });
  }

  /**
   * What the generator noticed about the document without failing, in the
   * order first noticed, each finding once (`DIAGNOSTIC_CODES` lists every
   * code). It grows as the generator works:
   *
   * 1. at load: the declared version (`NEWER_OPENAPI_VERSION` for a 3.x minor
   *    newer than 3.2, `CONFLICTING_VERSION_FIELDS`, and
   *    `INVALID_OPENAPI_VERSION` / `MISSING_OPENAPI_VERSION` for a version that
   *    validation rejects — useful with `validate: false`);
   * 2. at the first generation with validation on: the validator's warnings
   *    (`NO_OPERATION_ID`, `NO_SERVERS`, `FEATURE_NEWER_THAN_DECLARED_VERSION`,
   *    ...). Validation errors never reach it: they throw `ParseError`.
   *    Validation runs once per generator and is not re-run if the document
   *    returned by `getDocument()` is changed;
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
   *      `components.securitySchemes` does not define, a scheme named by URI
   *      included, or it is not an object) is dropped; when every requirement
   *      of an operation is dropped, `UNSATISFIABLE_SECURITY` and the
   *      operation makes no tool;
   *    - `UNSUPPORTED_PARAMETER_LOCATION`: an operation has a parameter in a
   *      location the generator does not map (such as `querystring`); the
   *      operation makes no tool.
   *
   * At most `MAX_DIAGNOSTICS` entries are kept; past that, one final
   * `DIAGNOSTICS_TRUNCATED` entry. Every severity is `warning`.
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
    if (this.diagnosticsTruncated) {
      diagnostics.push({
        severity: 'warning',
        code: DIAGNOSTIC_CODES.DIAGNOSTICS_TRUNCATED,
        message: `Only the first ${MAX_DIAGNOSTICS} diagnostics are kept; later findings were not recorded`,
      });
    }
    return diagnostics;
  }

  /**
   * The OpenAPI version the document declares (read after overlays), as
   * `detectSpecVersion` reports it: its `status` (`supported`,
   * `newer-minor`, `swagger-2.0`, `unsupported`, `malformed`, `missing`), the
   * declared value, and the `family` (`3.0`, `3.1`, `3.2`) whose rules the
   * validator applies, `undefined` when the version cannot be processed.
   * Returns a copy.
   */
  getSpecVersion(): SpecVersionInfo {
    return { ...this.specVersion, diagnostics: this.specVersion.diagnostics.map((diagnostic) => ({ ...diagnostic })) };
  }

  /**
   * Create generator from a URL
   */
  static async fromURL(url: string, rawOptions: LoadOptions = {}): Promise<OpenAPIToolGenerator> {
    const options = applySecureDefaults(rawOptions);
    try {
      // SECURITY: validate the spec URL — and every redirect hop — against the
      // SSRF guard before fetching (resolves DNS and rejects internal targets),
      // instead of letting the HTTP client follow 3xx blindly. See ssrf.ts.
      const response = await safeFetch(url, {
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

      return new OpenAPIToolGenerator(document, options);
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
   * Create generator from a file path
   */
  static async fromFile(filePath: string, options: LoadOptions = {}): Promise<OpenAPIToolGenerator> {
    try {
      // Lazy-load Node builtins so the module is importable off-Node (Workers).
      const [path, fs] = await Promise.all([import('path'), import('fs/promises')]);
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

      return new OpenAPIToolGenerator(document, options);
    } catch (error: unknown) {
      if (error instanceof OverlayError) {
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
      if (error instanceof OverlayError) {
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
   * Create generator from a JSON object
   */
  static async fromJSON(json: object, options: LoadOptions = {}): Promise<OpenAPIToolGenerator> {
    // Clone to avoid mutations
    const document = JSON.parse(JSON.stringify(json));
    return new OpenAPIToolGenerator(document, options);
  }

  /**
   * Get the OpenAPI document: dereferenced once generation or linting has
   * run, as loaded (after overlays) before that. It is the generator's own
   * object, not a copy. Validation runs once per generator, so changing this
   * document afterwards is not re-validated, and neither the declared
   * version (`getSpecVersion()`) nor `getDiagnostics()` is recomputed.
   */
  getDocument(): OpenAPIDocument {
    return this.dereferencedDocument ?? this.document;
  }

  /**
   * Validate the OpenAPI document
   */
  async validate(): Promise<ValidationResult> {
    const validator = new Validator();
    return validator.validate(this.document);
  }

  /**
   * Lint the loaded document for agent-readiness (missing operationIds,
   * vague descriptions, unpaginated lists, oversized schemas, ...). Runs
   * after overlays and dereferencing so findings reflect what tools would
   * actually be generated from.
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
   */
  private buildRefParserOptions(): ParserOptions {
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

    const resolveConfig: Record<string, unknown> = {
      external: true,
      file: allowedProtocols.has('file') ? undefined : false,
    };

    // Configure HTTP/HTTPS resolver with security filtering
    if (hasNetworkProtocol) {
      const hasHostAllowlist = refOpts.allowedHosts.length > 0;

      resolveConfig['http'] = {
        // SECURITY: never auto-follow HTTP redirects when resolving external
        // `$ref`s. `canRead` validates only the INITIAL URL; the resolver's
        // default redirect-following (up to 5 hops) re-fetches the `Location`
        // target WITHOUT re-invoking `canRead`, so an allowlisted host could
        // 302 → `http://169.254.169.254/...` and smuggle a blocked target past
        // the allow/deny lists. `redirects: 0` refuses the first redirect, and
        // our custom `read` (below) additionally refuses redirects itself.
        redirects: 0,
        // Synchronous gate: protocol, host allow-list, and literal/known
        // internal hosts. DNS names that *resolve* to internal addresses pass
        // here (canRead cannot be async) and are caught in `read` via DNS
        // resolution — closing the `127.0.0.1.nip.io` bypass for `$ref`s too.
        canRead: (file: { url: string }): boolean => {
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
        },
        // SSRF-safe fetch: resolves DNS and rejects names that map to internal
        // addresses, and refuses redirects. NOTE: deliberately does NOT forward
        // `this.options.headers` (the spec-load credentials) to third-party
        // `$ref` hosts — that would leak the spec's auth token cross-origin.
        read: async (file: { url: string }): Promise<string> => {
          const response = await safeFetch(file.url, {
            timeoutMs: this.options.timeout,
            followRedirects: false,
            ssrf: refOpts,
          });
          if (!response.ok) {
            throw new LoadError(
              `Failed to resolve external $ref "${file.url}": ${response.status} ${response.statusText}`,
              { url: file.url, status: response.status },
            );
          }
          return response.text();
        },
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
   */
  private static hasExternalRefs(node: unknown, seen = new Set<unknown>()): boolean {
    if (node === null || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some((n) => OpenAPIToolGenerator.hasExternalRefs(n, seen));
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === 'string' && !ref.startsWith('#')) return true;
    return Object.values(node as Record<string, unknown>).some((v) =>
      OpenAPIToolGenerator.hasExternalRefs(v, seen),
    );
  }

  /**
   * Dereference local (`#/...`) `$ref`s without `$RefParser` — pure, dependency-
   * free, runtime-agnostic. A pointer cache makes circular schemas resolve to a
   * shared reference instead of recursing forever (same contract as `$RefParser`).
   *
   * The walk keeps its own stack instead of recursing: a chain of N `$ref`s
   * nests N levels deep, and a call per level would overflow the call stack
   * after a few hundred levels (issue #50).
   */
  private static dereferenceInternal(root: OpenAPIDocument): OpenAPIDocument {
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
    // A node's walked value — or `pending`, with a frame pushed to walk it
    const enter = (node: unknown): unknown => {
      if (node === null || typeof node !== 'object') return node;
      if (Array.isArray(node)) {
        // The document is JSON-cloned, so arrays are never sparse
        frames.push({ children: node, keys: null, next: 0, out: new Array(node.length), placeholder: null });
        return pending;
      }
      const ref = (node as { $ref?: unknown }).$ref;
      if (typeof ref === 'string' && ref.startsWith('#')) {
        const cached = cache.get(ref);
        if (cached !== undefined) return cached;
        const placeholder: Record<string, unknown> = {};
        cache.set(ref, placeholder); // break cycles: self-refs see the placeholder
        frames.push({ children: [resolvePointer(ref)], keys: null, next: 0, out: [], placeholder });
        return pending;
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
   * Initialize the generator (dereference if needed, then validate)
   */
  private async initialize(runValidation: boolean = this.options.validate): Promise<void> {
    if (this.options.dereference && !this.dereferencedDocument) {
      const cloned = JSON.parse(JSON.stringify(this.document)) as OpenAPIDocument;
      // Internal-only refs → dereference without `$RefParser` (no Node builtins,
      // so this path runs on V8 isolates / Cloudflare Workers). External refs →
      // fall back to `$RefParser` (Node-only file/http resolvers).
      if (!OpenAPIToolGenerator.hasExternalRefs(cloned)) {
        this.dereferencedDocument = OpenAPIToolGenerator.dereferenceInternal(cloned);
      } else {
        try {
          const { default: $RefParser } = await import('@apidevtools/json-schema-ref-parser');
          const refParserOptions = this.buildRefParserOptions();
          this.dereferencedDocument = (await $RefParser.dereference(cloned, refParserOptions)) as OpenAPIDocument;
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new ParseError(`Failed to dereference OpenAPI document: ${errorMessage}`, {
            originalError: error,
          });
        }
      }
    }

    if (runValidation) {
      const result = await this.validateOnce();
      if (!result.valid) {
        // `valid: false` always comes with at least one error
        throw new ParseError(invalidDocumentMessage(result.errors!), { errors: result.errors });
      }
    }
  }

  /**
   * Validates the document generation reads (dereferenced when dereferencing
   * is on) once per generator, recording its warnings as diagnostics. Every
   * `generateTool` call goes through `initialize()`; without this the
   * validator re-ran for each operation.
   */
  private validateOnce(): Promise<ValidationResult> {
    this.validation ??= new Validator().validate(this.getDocument()).then((result) => {
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
   * generator does not map (`UNSUPPORTED_PARAMETER_LOCATION`), or no
   * Security Requirement that can be satisfied (`UNSATISFIABLE_SECURITY`).
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
   * The first parameter of an operation (path-level ones first, as merged)
   * whose location the generator does not map, as a diagnostic; `undefined`
   * when every location is mapped. Reference Objects (left by
   * `dereference: false`) are not checked, as the resolver has always
   * passed them through. Feature-driven: a `querystring` parameter is caught
   * whatever version the document declares.
   */
  private unsupportedParameterLocation(
    pathStr: string,
    entry: OperationEntry,
    pathItem: unknown,
  ): SpecDiagnostic | undefined {
    const lists: Array<[unknown, string]> = [
      [ownProperty(pathItem, 'parameters'), jsonPointer('paths', pathStr, 'parameters')],
      [ownProperty(entry.operation, 'parameters'), appendPointer(operationPointer(pathStr, entry), 'parameters')],
    ];
    for (const [parameters, pointer] of lists) {
      if (!Array.isArray(parameters)) continue;
      for (let index = 0; index < parameters.length; index++) {
        const parameter: unknown = parameters[index];
        if (isReferenceObject(parameter)) continue;
        const location = ownProperty(parameter, 'in');
        if (typeof location === 'string' && MAPPED_PARAMETER_LOCATIONS.includes(location)) continue;
        return {
          severity: 'warning',
          code: DIAGNOSTIC_CODES.UNSUPPORTED_PARAMETER_LOCATION,
          message:
            `${operationLabel(entry.method, pathStr)}: parameter ${describeValue(ownProperty(parameter, 'name'))} has ` +
            `location (in) ${describeValue(location)}, which is not mapped to a request ` +
            `(supported: ${MAPPED_PARAMETER_LOCATIONS.join(', ')}); the operation makes no tool`,
          path: appendPointer(pointer, index),
        };
      }
    }
    return undefined;
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

    const unsupported = this.unsupportedParameterLocation(pathStr, entry, pathItem);
    if (unsupported !== undefined) {
      throw this.skipOperation(unsupported, { path: pathStr, method });
    }

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
    let pathParameters: ParameterObject[] | undefined = undefined;
    if (pathItem.parameters) {
      pathParameters = pathItem.parameters.filter(
        (p): p is ParameterObject => !isReferenceObject(p),
      );
    }

    const { inputSchema, mapper } = parameterResolver.resolve(
      operation,
      pathParameters,
      securityRequirements,
      options.includeSecurityInInput,
    );

    // Build response schema
    const responseBuilder = new ResponseBuilder(options, schemaConversion);
    const outputSchema = responseBuilder.build(operation.responses);

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

    // Bound schema nesting depth (applied last so the final schemas are
    // bounded). Floor of 1: depth 0 would strip the ROOT inputSchema's
    // properties while the mapper still lists every parameter. This also
    // materializes the conversion's shared subschemas into independent copies.
    const truncateOptions = { maxNodes: maxSchemaNodes };
    resolvedInputSchema = SchemaBuilder.truncateDepth(resolvedInputSchema, maxSchemaDepth, truncateOptions);
    if (resolvedOutputSchema) {
      resolvedOutputSchema = SchemaBuilder.truncateDepth(resolvedOutputSchema, maxSchemaDepth, truncateOptions);
    }

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
    }

    // Response-shaping hints (computed on the FINAL output schema)
    const responseHints = detectResponseHints(resolvedOutputSchema, mapper);
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
      metadata: copyValue(metadata, 'The tool metadata'),
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
      metadata.servers = servers.map((server: ServerObject) => ({
        url: this.options.baseUrl || server.url,
        description: server.description,
        // A parsed document's maps hold no `undefined` values
        variables: server.variables as ServerInfo['variables'],
      }));
    } else if (this.options.baseUrl) {
      metadata.servers = [{ url: this.options.baseUrl }];
    }

    // Extract response status codes (preserve 0 for default responses)
    const schemaObj = outputSchema as Record<string, unknown> | undefined;
    if (schemaObj && Array.isArray(schemaObj['oneOf'])) {
      const codes = (schemaObj['oneOf'] as Record<string, unknown>[])
        .map((schema) => schema['x-status-code'])
        .filter((code): code is number => code !== undefined && code !== null);
      if (codes.length > 0) {
        metadata.responseStatusCodes = codes;
      }
    } else if (schemaObj && schemaObj['x-status-code'] !== undefined && schemaObj['x-status-code'] !== null) {
      metadata.responseStatusCodes = [schemaObj['x-status-code'] as number];
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
   * schemes that are all required together. An object naming a scheme
   * `components.securitySchemes` does not define (a typo, or an OpenAPI 3.2
   * scheme named by URI, which is not resolved yet) cannot be satisfied, so
   * the whole object is dropped, with one `UNRESOLVED_SECURITY_SCHEME` per
   * missing scheme; an object that is not an object is dropped with
   * `INVALID_SECURITY_REQUIREMENT`. An empty object (`{}`, no authentication)
   * is kept. The kept objects' schemes are returned, flattened as before.
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
      let satisfiable = true;
      for (const [scheme, scopes] of Object.entries(requirement)) {
        // Own properties only: a scheme named `constructor` is not Object's
        const found = ownProperty(schemes, scheme);
        if (isSpecObject(found)) {
          resolved.push(this.toSecurityRequirement(scheme, scopes as string[], found));
          continue;
        }
        satisfiable = false;
        const byUri = /[:#/]/.test(scheme) ? ' (a scheme named by URI is not resolved yet)' : '';
        this.addDiagnostic({
          severity: 'warning',
          code: DIAGNOSTIC_CODES.UNRESOLVED_SECURITY_SCHEME,
          message:
            `Security Requirement names scheme ${describeValue(scheme)}, which components.securitySchemes does not ` +
            `define${byUri}; the requirement cannot be satisfied and is dropped with every scheme it combines`,
          path: appendPointer(pointer, index, scheme),
        });
      }
      if (!satisfiable) return;
      kept++;
      requirements.push(...resolved);
    });
    return { requirements, unsatisfiable: Boolean(schemes) && security.length > 0 && kept === 0 };
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
