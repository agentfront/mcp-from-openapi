/**
 * Security elicitation descriptors.
 *
 * Derives MCP-elicitation-compatible `{ message, requestedSchema }` request
 * descriptors from a tool's resolved security data, so a server can ask the
 * user for missing credentials in the shape `elicitInput` expects. Pure data
 * derivation — transport policy is the consumer's. Note the MCP guidance:
 * servers SHOULD NOT elicit secrets over untrusted paths; prefer dedicated
 * credential flows where available.
 */
import type { McpOpenAPITool, SecurityParameterInfo } from './types';

/** A flat string property in an elicitation `requestedSchema`. */
export interface ElicitationField {
  type: 'string';
  title?: string;
  description?: string;
}

/** MCP elicitation request descriptor derived from a tool's security data. */
export interface SecurityElicitation {
  /**
   * OpenAPI security scheme name (as declared in `components.securitySchemes`).
   */
  scheme: string;

  /**
   * Human-readable prompt (`ElicitRequest.message`).
   */
  message: string;

  /**
   * Flat requested schema — primitive string properties only, per MCP
   * elicitation rules.
   */
  requestedSchema: {
    type: 'object';
    properties: Record<string, ElicitationField>;
    required: string[];
  };
}

/** Normalized view over `mapper[].security` / `metadata.security` entries. */
interface SecuritySource {
  scheme: string;
  type: string;
  httpScheme?: string;
  bearerFormat?: string;
  scopes?: string[];
  apiKeyName?: string;
  apiKeyIn?: string;
}

function buildElicitation(source: SecuritySource): SecurityElicitation | undefined {
  const { scheme, type } = source;
  if (type === 'http') {
    const httpScheme = (source.httpScheme ?? 'bearer').toLowerCase();
    if (httpScheme === 'basic' || httpScheme === 'digest') {
      return {
        scheme,
        message: `Provide HTTP ${httpScheme} credentials for "${scheme}".`,
        requestedSchema: {
          type: 'object',
          properties: {
            username: { type: 'string', title: 'Username' },
            password: { type: 'string', title: 'Password', description: 'Handled as a secret — never logged.' },
          },
          required: ['username', 'password'],
        },
      };
    }
    const format = source.bearerFormat ? ` (${source.bearerFormat})` : '';
    return {
      scheme,
      message: `Provide the ${httpScheme} token for "${scheme}".`,
      requestedSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', title: 'Token', description: `HTTP ${httpScheme} authentication token${format}.` },
        },
        required: ['token'],
      },
    };
  }
  if (type === 'apiKey') {
    const keyName = source.apiKeyName ?? scheme;
    const location = source.apiKeyIn ?? 'header';
    return {
      scheme,
      message: `Provide the API key for "${scheme}".`,
      requestedSchema: {
        type: 'object',
        properties: {
          apiKey: { type: 'string', title: 'API key', description: `API key "${keyName}" sent via ${location}.` },
        },
        required: ['apiKey'],
      },
    };
  }
  if (type === 'oauth2' || type === 'openIdConnect') {
    const scopes = source.scopes && source.scopes.length > 0 ? ` Scopes: ${source.scopes.join(', ')}.` : '';
    return {
      scheme,
      message: `Provide an OAuth2 access token for "${scheme}".${scopes}`,
      requestedSchema: {
        type: 'object',
        properties: {
          accessToken: { type: 'string', title: 'Access token', description: `OAuth2 access token.${scopes}` },
        },
        required: ['accessToken'],
      },
    };
  }
  // mutualTLS and custom types have no elicitable string credentials
  return undefined;
}

/**
 * Derive credential-elicitation descriptors from a generated tool — one per
 * distinct security scheme, in mapper order. Falls back to
 * `metadata.security` for hand-built tools without security mapper entries.
 * Returns `[]` when the tool declares no security.
 */
export function deriveSecurityElicitations(tool: McpOpenAPITool): SecurityElicitation[] {
  const sources: SecuritySource[] = [];
  const seen = new Set<string>();

  for (const entry of tool.mapper) {
    const security: SecurityParameterInfo | undefined = entry.security;
    if (security && !seen.has(security.scheme)) {
      seen.add(security.scheme);
      sources.push(security);
    }
  }

  if (sources.length === 0 && tool.metadata.security) {
    for (const requirement of tool.metadata.security) {
      if (!seen.has(requirement.scheme)) {
        seen.add(requirement.scheme);
        sources.push({
          scheme: requirement.scheme,
          type: requirement.type,
          httpScheme: requirement.httpScheme,
          bearerFormat: requirement.bearerFormat,
          scopes: requirement.scopes,
          apiKeyName: requirement.name,
          apiKeyIn: requirement.in,
        });
      }
    }
  }

  const result: SecurityElicitation[] = [];
  for (const source of sources) {
    const elicitation = buildElicitation(source);
    if (elicitation) {
      result.push(elicitation);
    }
  }
  return result;
}
