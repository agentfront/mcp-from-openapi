/**
 * Loading untrusted specs safely.
 *
 * `fromURL` ships SSRF protection: DNS resolution with connection pinning,
 * internal/private address blocking (cloud metadata endpoints included), and
 * per-hop redirect re-validation. `secureDefaults: true` is the recommended
 * one-flag posture — redirects off, external $ref resolution disabled.
 */
import { OpenAPIToolGenerator, SsrfError } from 'mcp-from-openapi';
import type { LoadOptions, McpOpenAPITool } from 'mcp-from-openapi';

/**
 * Load a spec from an untrusted URL with the hardened posture, optionally
 * pinned to an allowlist of hosts.
 */
export async function loadUntrustedSpec(url: string, options: Pick<LoadOptions, 'refResolution'> = {}): Promise<McpOpenAPITool[]> {
  const generator = await OpenAPIToolGenerator.fromURL(url, {
    secureDefaults: true, // redirects off + external $refs off; explicit options still win
    ...options,
  });
  return generator.generateTools();
}

/**
 * Classify a load failure: SSRF blocks throw `SsrfError`, so callers can
 * distinguish "the URL was hostile" from "the spec was broken".
 */
export async function tryLoad(url: string): Promise<{ ok: true; tools: McpOpenAPITool[] } | { ok: false; blocked: boolean; message: string }> {
  try {
    return { ok: true, tools: await loadUntrustedSpec(url) };
  } catch (error) {
    return {
      ok: false,
      blocked: error instanceof SsrfError,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
