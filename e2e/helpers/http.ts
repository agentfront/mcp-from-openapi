/**
 * Drive a BuiltHttpRequest over real HTTP with optional resolved security.
 * The one place the FormData/undici hand-off happens: buildHttpRequest
 * constructs the GLOBAL FormData, so passing it to global fetch is same-realm
 * and undici sets the multipart boundary itself (which is exactly why
 * buildHttpRequest omits content-type for multipart).
 */
import type { BuiltHttpRequest, ResolvedSecurity } from '../../src';

export async function sendBuiltRequest(built: BuiltHttpRequest, security?: ResolvedSecurity): Promise<Response> {
  const url = new URL(built.url);
  for (const [key, value] of Object.entries(security?.query ?? {})) {
    url.searchParams.append(key, value);
  }

  const headers: Record<string, string> = { ...built.headers, ...(security?.headers ?? {}) };
  const securityCookies = Object.entries(security?.cookies ?? {});
  if (securityCookies.length > 0) {
    const extra = securityCookies.map(([name, value]) => `${name}=${value}`).join('; ');
    headers['Cookie'] = headers['Cookie'] ? `${headers['Cookie']}; ${extra}` : extra;
  }

  return fetch(url.toString(), {
    method: built.method,
    headers,
    body: built.body as BodyInit | undefined,
  });
}
