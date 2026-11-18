import type { ParameterMapper, SecurityParameterInfo } from './types';
import { assertCookieName, assertCookieValue, assertHeaderSafe, entriesByAlternative } from './request-builder';

/**
 * Context for resolving security parameters
 * Frameworks should implement this interface based on their auth system
 */
export interface SecurityContext {
  /**
   * JWT/Bearer token
   */
  jwt?: string;

  /**
   * Basic auth credentials (base64 encoded "username:password")
   */
  basic?: string;

  /**
   * Digest auth credentials
   * Object with username, password, realm, nonce, etc.
   */
  digest?: DigestAuthCredentials;

  /**
   * API key (single key for backward compatibility)
   */
  apiKey?: string;

  /**
   * Multiple API keys by name
   * Use this when API requires different keys for different purposes
   * @example { 'X-API-Key': 'key1', 'X-Client-Id': 'client123' }
   */
  apiKeys?: Record<string, string>;

  /**
   * OAuth2 access token
   */
  oauth2Token?: string;

  /**
   * Client certificate for mutual TLS (mTLS)
   */
  clientCertificate?: ClientCertificate;

  /**
   * Private key for signature-based auth (HMAC, AWS Signature V4, etc.)
   */
  privateKey?: string;

  /**
   * Public key (if needed for verification)
   */
  publicKey?: string;

  /**
   * HMAC secret for HMAC-based authentication
   */
  hmacSecret?: string;

  /**
   * AWS credentials for AWS Signature V4
   */
  awsCredentials?: AWSCredentials;

  /**
   * Custom headers for proprietary authentication
   * @example { 'X-Custom-Auth': 'custom-value' }
   */
  customHeaders?: Record<string, string>;

  /**
   * Session cookies
   */
  cookies?: Record<string, string>;

  /**
   * Custom resolver for framework-specific auth
   * @param security - Security parameter info from mapper
   * @returns The auth value to use, or undefined if not available
   */
  customResolver?: (security: SecurityParameterInfo) => string | Promise<string | undefined>;

  /**
   * Signature generator for signature-based auth
   * @param data - Data to sign (typically the request)
   * @param security - Security parameter info
   * @returns The signature or signed value
   */
  signatureGenerator?: (data: SignatureData, security: SecurityParameterInfo) => string | Promise<string>;
}

/**
 * Digest authentication credentials
 */
export interface DigestAuthCredentials {
  username: string;
  password: string;
  realm?: string;
  nonce?: string;
  uri?: string;
  qop?: string;
  nc?: string;
  cnonce?: string;
  response?: string;
  opaque?: string;
}

/**
 * Client certificate for mTLS
 */
export interface ClientCertificate {
  /**
   * Certificate in PEM format
   */
  cert: string;

  /**
   * Private key in PEM format
   */
  key: string;

  /**
   * Passphrase for encrypted key
   */
  passphrase?: string;

  /**
   * CA certificates
   */
  ca?: string | string[];
}

/**
 * AWS credentials for Signature V4
 */
export interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
  service?: string;
}

/**
 * Data to be signed for signature-based auth
 */
export interface SignatureData {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timestamp?: number;
}

/**
 * Resolved security parameters ready to be added to HTTP request
 */
export interface ResolvedSecurity {
  /**
   * Headers to add to the request
   */
  headers: Record<string, string>;

  /**
   * Query parameters to add to the request
   */
  query: Record<string, string>;

  /**
   * Cookie values to add to the request
   */
  cookies: Record<string, string>;

  /**
   * Client certificate for mTLS (if applicable)
   */
  clientCertificate?: ClientCertificate;

  /**
   * Whether signature-based auth is required
   * If true, you need to call signRequest() before sending
   */
  requiresSignature?: boolean;

  /**
   * Signature metadata (if signature-based auth is used)
   */
  signatureInfo?: {
    scheme: string;
    algorithm?: string;
  };
}

/** `record[key]` when it is an own, non-empty value: a key such as `constructor` is never read from the prototype */
function ownValue(record: Record<string, string> | undefined, key: string | undefined): string | undefined {
  if (record === undefined || key === undefined || !Object.hasOwn(record, key)) return undefined;
  return record[key] || undefined;
}

/** The `mutualTLS` schemes a choice names (`security.clientCertificates`), with the alternatives that need each */
function clientCertificatesOf(entries: ParameterMapper[]): Array<{ scheme: string; alternatives: number[] }> {
  return entries.flatMap((entry) => entry.security?.clientCertificates ?? []);
}

/**
 * The credential entries a call applies: every entry, or with a choice of Security Requirement objects
 * (`security.alternatives`) those of the first alternative whose entries are all filled and whose client
 * certificate (`security.clientCertificates`) the context holds; `undefined` when no alternative is.
 */
function appliedEntries(
  entries: ParameterMapper[],
  filled: (entry: ParameterMapper) => boolean,
  hasCertificate: boolean,
): ParameterMapper[] | undefined {
  const alternatives = entriesByAlternative(entries);
  if (alternatives.size === 0) return entries;
  const needCertificate = new Set(clientCertificatesOf(entries).flatMap((certificate) => certificate.alternatives));
  const first = [...new Set([...alternatives.keys(), ...needCertificate])]
    .sort((a, b) => a - b)
    .find((index) => (hasCertificate || !needCertificate.has(index)) && (alternatives.get(index) ?? []).every(filled));
  return first === undefined ? undefined : (alternatives.get(first) ?? []);
}

/** `entry`, or one entry per alternative when the alternatives ask it for different scopes (`alternativeScopes`) */
function perAlternative(entry: ParameterMapper): ParameterMapper[] {
  const { alternatives, alternativeScopes, ...security } = entry.security!;
  if (alternatives === undefined || alternativeScopes === undefined) return [entry];
  return alternatives.map((alternative, position) => ({
    ...entry,
    security: { ...security, alternatives: [alternative], scopes: alternativeScopes[position] },
  }));
}

/** Whether the mapper has exactly one apiKey scheme, the only case `SecurityContext.apiKey` is used for */
function singleApiKeyScheme(mappers: ParameterMapper[]): boolean {
  const apiKeySchemes = mappers.filter((mapper) => mapper.security?.type === 'apiKey').map((mapper) => mapper.security!.scheme);
  return new Set(apiKeySchemes).size === 1;
}

/**
 * Security resolver that maps OpenAPI security requirements to actual auth values
 *
 * This helper handles security parameters from any OpenAPI spec, regardless of
 * custom naming (BearerAuth, JWT, Authorization, etc.). It uses the mapper's
 * security metadata to determine the auth type and format.
 *
 * @example
 * ```typescript
 * // In FrontMCP
 * const resolver = new SecurityResolver();
 * const resolved = await resolver.resolve(tool.mapper, {
 *   jwt: context.authInfo.jwt,
 *   apiKey: process.env.API_KEY
 * });
 *
 * // Set resolved.headers last, through Headers, so a credential replaces another header in any case
 * const headers = new Headers(otherHeaders);
 * for (const [name, value] of Object.entries(resolved.headers)) headers.set(name, value);
 * fetch(url, { headers });
 * ```
 *
 * @example
 * ```typescript
 * // Custom resolver for framework-specific auth
 * const resolved = await resolver.resolve(tool.mapper, {
 *   customResolver: (security) => {
 *     if (security.type === 'http' && security.httpScheme === 'bearer') {
 *       return myFramework.getAuthToken();
 *     }
 *     return undefined;
 *   }
 * });
 * ```
 */
export class SecurityResolver {
  /**
   * Resolve security parameters from mapper entries
   *
   * @param mappers - Parameter mappers from the tool definition
   * @param context - Security context with auth values or custom resolver
   * @returns Resolved headers, query params, and cookies with auth applied
   */
  async resolve(mappers: ParameterMapper[], context: SecurityContext): Promise<ResolvedSecurity> {
    const resolved: ResolvedSecurity = {
      headers: {},
      query: {},
      cookies: {},
    };

    // Add client certificate if available (for mTLS)
    if (context.clientCertificate) {
      resolved.clientCertificate = context.clientCertificate;
    }

    // Check if signature-based auth is needed
    let requiresSignature = false;
    let signatureScheme: string | undefined;
    const { applied, values } = await this.credentials(mappers, context);

    for (const mapper of applied ?? []) {
      // Check for signature-based auth
      if (this.isSignatureBasedAuth(mapper.security!)) {
        requiresSignature = true;
        signatureScheme = mapper.security!.scheme;
        // Signature will be added later by signRequest()
        continue;
      }

      const authValue = values.get(mapper);
      if (!authValue) {
        // Auth value not available - skip this security requirement
        // Framework may want to throw an error or log a warning
        continue;
      }

      // Apply to the correct location
      const headerName = mapper.key;

      // A value that cannot be sent there is refused, as buildHttpRequest refuses it
      if (mapper.type === 'header') {
        assertHeaderSafe(headerName, authValue);
        resolved.headers[headerName] = authValue;
      } else if (mapper.type === 'query') {
        resolved.query[headerName] = authValue;
      } else if (mapper.type === 'cookie') {
        assertCookieName(headerName);
        assertCookieValue(headerName, authValue);
        resolved.cookies[headerName] = authValue;
      }
    }

    // Add context cookies if available
    if (context.cookies) {
      resolved.cookies = { ...resolved.cookies, ...context.cookies };
    }

    // Add signature metadata if needed
    if (requiresSignature) {
      resolved.requiresSignature = true;
      resolved.signatureInfo = {
        /* c8 ignore next -- signatureScheme is always set from security.scheme */
        scheme: signatureScheme || 'unknown',
      };
    }

    return resolved;
  }

  /**
   * The credential entries of `mappers` (`perAlternative`), the value the context gives each (none for a signature
   * entry, which `signRequest` signs), whether each is filled, and the entries a call applies (`appliedEntries`).
   */
  private async credentials(mappers: ParameterMapper[], context: SecurityContext) {
    const entries = mappers.filter((mapper) => mapper.security !== undefined).flatMap(perAlternative);
    const fallbackApiKey = singleApiKeyScheme(mappers);
    const values = new Map<ParameterMapper, string | undefined>();
    for (const entry of entries) {
      if (!this.isSignatureBasedAuth(entry.security!)) {
        values.set(entry, await this.resolveAuthValue(entry.security!, context, fallbackApiKey));
      }
    }
    // A signature entry is filled by signRequest, which needs a signatureGenerator
    const filled = (entry: ParameterMapper): boolean =>
      this.isSignatureBasedAuth(entry.security!) ? context.signatureGenerator !== undefined : Boolean(values.get(entry));
    const applied = appliedEntries(entries, filled, context.clientCertificate !== undefined);
    return { entries, values, filled, applied };
  }

  /**
   * Whether an HTTP authentication scheme requires request signing, by the
   * names of schemes that do (`aws4`, `hmac`, `signature`, `hawk`). Only an
   * `http` scheme: an API key named `TomahawkKey` is an API key.
   */
  private isSignatureBasedAuth(security: SecurityParameterInfo): boolean {
    const signatureSchemes = ['aws4', 'hmac', 'signature', 'hawk', 'custom-signature'];
    return security.type === 'http' && signatureSchemes.some((scheme) => security.scheme.toLowerCase().includes(scheme));
  }

  /**
   * Resolve the actual auth value based on security type
   */
  private async resolveAuthValue(
    security: SecurityParameterInfo,
    context: SecurityContext,
    fallbackApiKey: boolean,
  ): Promise<string | undefined> {
    // Try custom resolver first
    if (context.customResolver) {
      const customValue = await context.customResolver(security);
      if (customValue !== undefined) {
        return customValue;
      }
    }

    // Handle standard security types
    if (security.type === 'http') {
      return this.resolveHttpAuth(security, context);
    } else if (security.type === 'apiKey') {
      return this.resolveApiKey(security, context, fallbackApiKey);
    } else if (security.type === 'oauth2' || security.type === 'openIdConnect') {
      return this.resolveOAuth2(security, context);
    }

    return undefined;
  }

  /**
   * Resolve HTTP authentication (bearer, basic, digest, etc.)
   */
  private resolveHttpAuth(
    security: SecurityParameterInfo,
    context: SecurityContext
  ): string | undefined {
    const scheme = security.httpScheme?.toLowerCase() || 'bearer';

    switch (scheme) {
      case 'bearer':
        return this.resolveBearerAuth(context);

      case 'basic':
        return this.resolveBasicAuth(context);

      case 'digest':
        return this.resolveDigestAuth(context);

      /* c8 ignore next -- hoba is part of the same fall-through as mutual/negotiate/vapid/scram */
      case 'hoba':
      case 'mutual':
      case 'negotiate':
      case 'vapid':
      case 'scram':
        // These schemes typically require custom implementation
        // Try custom headers or signature generator
        return this.resolveCustomHttpScheme(scheme, security, context);

      default:
        // Unknown scheme - try custom resolver
        return undefined;
    }
  }

  /**
   * Resolve Bearer token authentication
   */
  private resolveBearerAuth(context: SecurityContext): string | undefined {
    const token = context.jwt;
    if (!token) return undefined;
    return `Bearer ${token}`;
  }

  /**
   * Resolve Basic authentication
   */
  private resolveBasicAuth(context: SecurityContext): string | undefined {
    const credentials = context.basic;
    if (!credentials) return undefined;
    return `Basic ${credentials}`;
  }

  /**
   * Resolve Digest authentication
   */
  private resolveDigestAuth(context: SecurityContext): string | undefined {
    const digest = context.digest;
    if (!digest) return undefined;

    // SECURITY: digest field values are interpolated into a single header line.
    // Strip CR/LF (header/response-splitting) and backslash-escape `"` so a value
    // containing a quote can't break out of its quoted field. `qop`/`nc` are
    // unquoted tokens — strip CR/LF, quotes, and commas (the field separator).
    // Backslashes are escaped FIRST — otherwise a value ending in `\` turns
    // our escaped closing quote into a literal and breaks out of the field.
    const quoted = (v: string): string =>
      String(v).replace(/[\r\n]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const token = (v: string): string => String(v).replace(/[\r\n",]/g, '');

    // Build digest auth header
    const parts: string[] = [
      `username="${quoted(digest.username)}"`,
      digest.realm ? `realm="${quoted(digest.realm)}"` : '',
      digest.nonce ? `nonce="${quoted(digest.nonce)}"` : '',
      digest.uri ? `uri="${quoted(digest.uri)}"` : '',
      digest.response ? `response="${quoted(digest.response)}"` : '',
      digest.opaque ? `opaque="${quoted(digest.opaque)}"` : '',
      digest.qop ? `qop=${token(digest.qop)}` : '',
      digest.nc ? `nc=${token(digest.nc)}` : '',
      digest.cnonce ? `cnonce="${quoted(digest.cnonce)}"` : '',
    ].filter(Boolean);

    return `Digest ${parts.join(', ')}`;
  }

  /**
   * Resolve custom HTTP authentication schemes
   */
  private resolveCustomHttpScheme(
    scheme: string,
    security: SecurityParameterInfo,
    context: SecurityContext
  ): string | undefined {
    return ownValue(context.customHeaders, security.apiKeyName || `X-${scheme.toUpperCase()}`);
  }

  /**
   * Resolve API key authentication
   */
  private resolveApiKey(
    security: SecurityParameterInfo,
    context: SecurityContext,
    fallbackApiKey: boolean,
  ): string | undefined {
    // Named API keys first (for multiple keys), then custom headers (proprietary auth headers like X-Custom-Auth)
    const named = ownValue(context.apiKeys, security.apiKeyName) ?? ownValue(context.customHeaders, security.apiKeyName);
    // The single apiKey only for a tool with one apiKey scheme: it is never sent in another scheme's place
    return named ?? (fallbackApiKey ? context.apiKey : undefined);
  }

  /**
   * Resolve OAuth2/OpenID Connect authentication
   */
  private resolveOAuth2(
    security: SecurityParameterInfo,
    context: SecurityContext
  ): string | undefined {
    const token = context.oauth2Token;
    if (!token) return undefined;

    // OAuth2 tokens are typically formatted as "Bearer {token}"
    return `Bearer ${token}`;
  }

  /**
   * Check if any security requirements are missing from context
   *
   * @param mappers - Parameter mappers from the tool definition
   * @param context - Security context with auth values
   * @returns Array of missing security scheme names
   */
  async checkMissingSecurity(
    mappers: ParameterMapper[],
    context: SecurityContext
  ): Promise<string[]> {
    const { entries, applied, filled } = await this.credentials(mappers, context);
    // A choice is satisfied by one alternative, or by none when one is empty
    const choice = entries.some((entry) => entry.security!.alternatives !== undefined);
    if (choice && (applied !== undefined || entries.some((entry) => entry.security!.optional))) return [];
    const unfilled = entries.filter((entry) => !filled(entry)).map((entry) => entry.security!.scheme);
    const certificates = context.clientCertificate ? [] : clientCertificatesOf(entries).map((certificate) => certificate.scheme);
    return [...new Set([...unfilled, ...certificates])];
  }

  /**
   * Sign a request for signature-based authentication
   *
   * Use this when resolved.requiresSignature is true.
   * This method will call the signatureGenerator from context to sign the request. With a choice of Security
   * Requirements it signs the entries of the alternative `resolve` applies, reading the context's credentials
   * again to find it.
   *
   * @param mappers - Parameter mappers from the tool definition
   * @param signatureData - Request data to sign
   * @param context - Security context with signature generator
   * @returns Headers with signature added
   *
   * @example
   * ```typescript
   * const resolved = await resolver.resolve(tool.mapper, context);
   * if (resolved.requiresSignature) {
   *   const signedHeaders = await resolver.signRequest(
   *     tool.mapper,
   *     { method: 'GET', url: 'https://api.example.com/data', headers: resolved.headers },
   *     context
   *   );
   *   // Use signedHeaders in request
   * }
   * ```
   */
  async signRequest(
    mappers: ParameterMapper[],
    signatureData: SignatureData,
    context: SecurityContext
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...signatureData.headers };

    if (!context.signatureGenerator) {
      throw new Error('Signature-based auth required but no signatureGenerator provided');
    }

    // The signature entries of the alternative `resolve` applies: the same choice, made again
    const { applied } = await this.credentials(mappers, context);
    for (const mapper of applied ?? []) {
      if (!this.isSignatureBasedAuth(mapper.security!)) {
        continue;
      }

      // Call signature generator
      const signature = await context.signatureGenerator(signatureData, mapper.security!);

      // Add signature to appropriate location
      if (mapper.type === 'header') {
        headers[mapper.key] = signature;
      }
      // Note: Query/cookie signatures would be handled differently
    }

    return headers;
  }
}

/**
 * Create a basic security context from common auth sources
 *
 * @example
 * ```typescript
 * const context = createSecurityContext({
 *   jwt: process.env.JWT_TOKEN,
 *   apiKey: process.env.API_KEY
 * });
 * ```
 */
export function createSecurityContext(
  auth: Partial<SecurityContext>
): SecurityContext {
  return {
    ...auth,
    jwt: auth.jwt,
    basic: auth.basic,
    apiKey: auth.apiKey,
    oauth2Token: auth.oauth2Token,
    customResolver: auth.customResolver,
  };
}
