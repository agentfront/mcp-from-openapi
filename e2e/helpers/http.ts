/**
 * Drive a BuiltHttpRequest over real HTTP with optional resolved security.
 * The one place the FormData/undici hand-off happens: buildHttpRequest
 * constructs the GLOBAL FormData, so passing it to global fetch is same-realm
 * and undici sets the multipart boundary itself (which is exactly why
 * buildHttpRequest omits content-type for multipart).
 *
 * Query credentials are appended to `built.url` text as it stands, never
 * through `URL.searchParams` (which re-serializes every pair already in the
 * query). A request whose query string is not name=value pairs
 * (`built.queryString`, an OpenAPI 3.2 `in: querystring` serialized as JSON or
 * another media type) has nothing to append a pair to, so a query credential
 * is refused with an error. To send a credential with such a tool, place it
 * through buildHttpRequest instead (input under the security mapper entry's
 * `inputKey`), which refuses it the same way, or use a header or cookie scheme.
 *
 * Every cookie of `security.cookies` is joined to the `Cookie` header `built`
 * already has, whether or not a mapper entry names it: pass `security` for
 * them, or place them through buildHttpRequest, not both (a name would be sent twice).
 */
import type { BuiltHttpRequest, ResolvedSecurity } from '../../src';

export async function sendBuiltRequest(built: BuiltHttpRequest, security?: ResolvedSecurity): Promise<Response> {
  let url = built.url;
  const queryCredentials = Object.entries(security?.query ?? {});
  if (queryCredentials.length > 0) {
    if (built.queryString !== undefined) {
      throw new Error(
        `Cannot append the query credential(s) ${queryCredentials.map(([name]) => `'${name}'`).join(', ')} to '${built.url}': ` +
          `its query string is not name=value pairs (queryString: '${built.queryString}')`,
      );
    }
    const pairs = queryCredentials.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    url += `${url.includes('?') ? '&' : '?'}${pairs.join('&')}`;
  }

  const headers: Record<string, string> = { ...built.headers, ...(security?.headers ?? {}) };
  const securityCookies = Object.entries(security?.cookies ?? {});
  if (securityCookies.length > 0) {
    const extra = securityCookies.map(([name, value]) => `${name}=${value}`).join('; ');
    headers['Cookie'] = headers['Cookie'] ? `${headers['Cookie']}; ${extra}` : extra;
  }

  // Node's fetch typing comes from undici — derive the body type from it
  return fetch(url, {
    method: built.method,
    headers,
    body: built.body as NonNullable<Parameters<typeof fetch>[1]>['body'],
  });
}
