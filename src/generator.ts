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
  HTTPMethod,
  ParameterObject,
  SecurityRequirement,
  AuthType,
  OperationObject,
  OperationWithContext,
  ToolMetadata,
  ServerObject,
  PathItemObject,
  JsonSchema,
  ToolIcon,
} from './types';
import type { ParserOptions } from '@apidevtools/json-schema-ref-parser';
import { isReferenceObject } from './types';
import { ParameterResolver } from './parameter-resolver';
import { ResponseBuilder } from './response-builder';
import { SchemaBuilder } from './schema-builder';
import { extractExtensionOverrides, inferAnnotationsFromMethod, resolveExtensionEnabled } from './annotations';
import { applyClientTarget } from './client-targets';
import { applyOverlay } from './overlay';
import { lintDocument, PAGINATION_PARAM, type LintResult } from './lint';
import { Validator } from './validator';
import { GenerationError, LoadError, OverlayError, ParseError } from './errors';
import { BUILTIN_FORMAT_RESOLVERS, resolveSchemaFormats } from './format-resolver';
import { emitToolTypeScript } from './type-signature';
import { isBlockedHostname, normalizeSsrfOptions, safeFetch } from './ssrf';

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
  const fallback = `${method.toUpperCase()} ${pathStr}`;
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
  const logo = (info as Record<string, unknown>)['x-logo'];
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
  const lower = src?.toLowerCase();
  if (lower !== undefined && (lower.startsWith('https:') || lower.startsWith('data:'))) {
    return [{ src: src as string }];
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
   * Get the OpenAPI document
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
      const hostAllowSet = new Set(refOpts.allowedHosts);

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

            // Check host allowlist (if configured)
            if (hasHostAllowlist && !hostAllowSet.has(parsed.hostname)) {
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
    const walk = (node: unknown): unknown => {
      if (node === null || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(walk);
      const ref = (node as { $ref?: unknown }).$ref;
      if (typeof ref === 'string' && ref.startsWith('#')) {
        const cached = cache.get(ref);
        if (cached !== undefined) return cached;
        const placeholder: Record<string, unknown> = {};
        cache.set(ref, placeholder); // break cycles: self-refs see the placeholder
        const resolved = walk(resolvePointer(ref));
        if (resolved && typeof resolved === 'object') Object.assign(placeholder, resolved);
        return placeholder;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    };
    return walk(root) as OpenAPIDocument;
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
      const validator = new Validator();
      const documentToValidate = this.dereferencedDocument ?? this.document;
      const result = await validator.validate(documentToValidate);
      if (!result.valid) {
        throw new ParseError('Invalid OpenAPI document', { errors: result.errors });
      }
    }
  }

  /**
   * Generate all tools from the OpenAPI specification
   */
  async generateTools(options: GenerateOptions = {}): Promise<McpOpenAPITool[]> {
    await this.initialize();

    const document = this.getDocument();
    const tools: McpOpenAPITool[] = [];
    const usedNames = new Set<string>();

    if (!document.paths) {
      return tools;
    }

    // Deterministic ordering (MCP 2026-07-28 SHOULD): paths sorted by code
    // unit (locale-independent), methods in the fixed canonical order below.
    // Stable output across spec re-serializations keeps clients' prompt
    // caches effective.
    // (object keys are unique, so the comparator never sees equal paths)
    const sortedPaths = Object.entries(document.paths).sort(([a], [b]) => (a < b ? -1 : 1));

    for (const [pathStr, pathItem] of sortedPaths) {
      if (!pathItem || '$ref' in pathItem) continue;

      const methods: HTTPMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

      for (const method of methods) {
        const operation = pathItem[method];
        if (!operation) continue;

        // Apply filters
        if (!this.shouldIncludeOperation(operation, pathStr, method, options, document, pathItem)) {
          continue;
        }

        try {
          let tool = await this.generateTool(pathStr, method, options);
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
                  `Unable to find a unique tool name for "${tool.name}" (${method.toUpperCase()} ${pathStr}) ` +
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
          /* c8 ignore next */
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.warn(`Failed to generate tool for ${method.toUpperCase()} ${pathStr}:`, errorMessage);
        }
      }
    }

    return tools;
  }

  /**
   * Generate a specific tool for a path and method
   */
  async generateTool(pathStr: string, method: string, options: GenerateOptions = {}): Promise<McpOpenAPITool> {
    await this.initialize();

    const document = this.getDocument();

    if (!document.paths) {
      throw new Error('No paths defined in OpenAPI document');
    }

    const pathItem = document.paths[pathStr];
    const operation = pathItem?.[method.toLowerCase() as HTTPMethod];

    if (!operation) {
      throw new Error(`Operation not found: ${method.toUpperCase()} ${pathStr}`);
    }

    // Resolve parameters
    const parameterResolver = new ParameterResolver(options.namingStrategy, {
      includeExamples: options.includeExamples,
    });

    // Filter out ReferenceObjects from parameters
    let pathParameters: ParameterObject[] | undefined = undefined;
    if (pathItem.parameters) {
      pathParameters = pathItem.parameters.filter(
        (p): p is ParameterObject => !isReferenceObject(p),
      ) as ParameterObject[];
    }

    // Extract security requirements
    let securityRequirements: SecurityRequirement[] | undefined = undefined;
    const securitySpec = operation.security ?? document.security;
    if (securitySpec) {
      securityRequirements = this.extractSecurityRequirements(securitySpec as Record<string, string[]>[], document);
    }

    const { inputSchema, mapper } = parameterResolver.resolve(
      operation,
      pathParameters,
      securityRequirements,
      options.includeSecurityInInput,
    );

    // Build response schema
    const responseBuilder = new ResponseBuilder(options);
    const outputSchema = responseBuilder.build(operation.responses);

    // Extension overrides (x-speakeasy-mcp < x-mcp < x-frontmcp)
    const overrides = extractExtensionOverrides(operation);

    // Generate tool name (an extension name override takes the operationId's
    // place, including as the value passed to a custom toolNameGenerator)
    const name = this.generateToolName(
      pathStr,
      method as HTTPMethod,
      overrides.name ?? operation.operationId,
      options,
      operation,
    );

    // Generate description (extension override > strategy)
    const description =
      overrides.description ??
      composeDescription(operation, method, pathStr, options.descriptionStrategy ?? 'summaryOnly');

    // Display title (MCP Tool.title): extension override, else operation summary
    const title = overrides.title ?? operation.summary;

    // Annotations: HTTP-method inference (opt-out) + extension overrides on top.
    // Lowercase first — the public generateTool(path, method) accepts any case.
    const inferred =
      options.inferAnnotations !== false
        ? inferAnnotationsFromMethod(method.toLowerCase() as HTTPMethod)
        : undefined;
    const annotations =
      inferred || overrides.annotations ? { ...inferred, ...overrides.annotations } : undefined;

    // Extract metadata
    const metadata = this.extractMetadata(pathStr, method as HTTPMethod, operation, document, outputSchema);

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
    // properties while the mapper still lists every parameter.
    const maxSchemaDepth = Math.max(1, options.maxSchemaDepth ?? 10);
    resolvedInputSchema = SchemaBuilder.truncateDepth(resolvedInputSchema, maxSchemaDepth);
    if (resolvedOutputSchema) {
      resolvedOutputSchema = SchemaBuilder.truncateDepth(resolvedOutputSchema, maxSchemaDepth);
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
      resolvedInputSchema = applyClientTarget(resolvedInputSchema, options.target);
      if (resolvedOutputSchema) {
        resolvedOutputSchema = applyClientTarget(resolvedOutputSchema, options.target);
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
        'dev.agentfront.openapi/operation': {
          path: pathStr,
          method,
          ...(operation.operationId !== undefined && { operationId: operation.operationId }),
          ...(operation.tags && { tags: [...operation.tags] }),
          ...(operation.deprecated !== undefined && { deprecated: operation.deprecated }),
          ...(typeof info?.['title'] === 'string' && { specTitle: info['title'] }),
          ...(typeof info?.['version'] === 'string' && { specVersion: info['version'] }),
        },
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
      ...(title !== undefined && { title }),
      description: finalDescription,
      ...(annotations && { annotations }),
      ...(toolMeta && { _meta: toolMeta }),
      ...(icons && { icons }),
      inputSchema: resolvedInputSchema,
      outputSchema: resolvedOutputSchema,
      mapper,
      metadata,
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

    // Method filters
    const lowerMethod = method.toLowerCase() as HTTPMethod;
    if (options.includeMethods && !options.includeMethods.includes(lowerMethod)) {
      return false;
    }
    if (options.excludeMethods?.includes(lowerMethod)) {
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
        ...inferAnnotationsFromMethod(lowerMethod),
        ...extractExtensionOverrides(operation).annotations,
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
    outputSchema?: unknown,
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

    // Extract security requirements
    if (operation.security || document.security) {
      metadata.security = this.extractSecurityRequirements(
        (operation.security ?? document.security) as Record<string, string[]>[],
        document,
      );
    }

    // Extract servers
    const servers = (operation as { servers?: ServerObject[] }).servers ?? document.servers;
    if (servers) {
      metadata.servers = servers.map((server: ServerObject) => ({
        url: this.options.baseUrl || server.url,
        description: server.description,
        variables: server.variables,
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
    const operationWithExt = operation as Record<string, unknown>;
    if (operationWithExt['x-frontmcp']) {
      metadata.frontmcp = operationWithExt['x-frontmcp'] as ToolMetadata['frontmcp'];
    }

    return metadata;
  }

  /**
   * Extract security requirements
   */
  private extractSecurityRequirements(
    security: Record<string, string[]>[],
    document: OpenAPIDocument,
  ): SecurityRequirement[] {
    if (!security || !document.components?.securitySchemes) {
      return [];
    }

    return security.flatMap((req) =>
      Object.entries(req).map(([scheme, scopes]): SecurityRequirement => {
        const securityScheme = document.components!.securitySchemes![scheme];

        // Skip if it's a reference object
        if (isReferenceObject(securityScheme)) {
          return { scheme, type: 'http', scopes };
        }

        const apiKeyIn = 'in' in securityScheme ? securityScheme.in : undefined;
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
      }),
    );
  }
}
