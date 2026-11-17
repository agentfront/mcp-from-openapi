/**
 * Tests for the base URI of a document (src/base-uri.ts): URI comparison,
 * `LoadOptions.documentUri`, `$self` and its security rules, self-reference
 * rewriting, and Security Requirement keys named by URI. The generator-level
 * behaviour (fetches, errors) is in generator.spec.ts.
 */

import {
  MAX_BASE_URI_LENGTH,
  findRelativeReference,
  findSelfReferences,
  fragmentPointerTokens,
  isSameDocument,
  parseDocumentUri,
  pointerTargetProblem,
  readSelfField,
  redactUserInfo,
  refParserScopesIds,
  userInfoOf,
  resolveDocumentBase,
  resolveSecuritySchemeUri,
  retrievalUriOf,
  uriComparisonKey,
  type DocumentBase,
} from '../base-uri';
import { LoadError } from '../errors';
import { DIAGNOSTIC_CODES } from '../types';
import { detectSpecVersion } from '../spec';

const v = (openapi: string) => detectSpecVersion({ openapi });
const V32 = v('3.2.0');

/** The base of a 3.2 document with `$self` (or none), read from `retrievalUri`. */
const baseOf = (retrievalUri: string | undefined, self?: unknown): DocumentBase => {
  const document = self === undefined ? { openapi: '3.2.0' } : { openapi: '3.2.0', $self: self };
  const result = resolveDocumentBase(document, V32, retrievalUri);
  expect(result.diagnostics).toEqual([]);
  return result.base!;
};

describe('uriComparisonKey', () => {
  const key = (uri: string) => uriComparisonKey(new URL(uri));

  it.each([
    ['scheme and host case', 'HTTPS://API.Example.COM/a', 'https://api.example.com/a'],
    ['a default port', 'https://example.com:443/a', 'https://example.com/a'],
    ['the http default port', 'http://example.com:80/a', 'http://example.com/a'],
    ['dot segments', 'https://example.com/x/./y/../a', 'https://example.com/x/a'],
    ['encoded dot segments', 'https://example.com/x/%2e%2E/a', 'https://example.com/a'],
    ['percent-encoding case', 'https://example.com/a%2fb', 'https://example.com/a%2Fb'],
    ['an encoded unreserved character', 'https://example.com/%7Euser/%61pi', 'https://example.com/~user/api'],
    ['an encoded unreserved character in the query', 'https://example.com/a?x=%41', 'https://example.com/a?x=A'],
    ['an empty path', 'https://example.com', 'https://example.com/'],
    ['the fragment', 'https://example.com/a#/components', 'https://example.com/a'],
    ['an internationalized host', 'https://BÜCHER.example/a', 'https://xn--bcher-kva.example/a'],
    ['a file URI with localhost', 'file://localhost/srv/openapi.yaml', 'file:///srv/openapi.yaml'],
  ])('treats URIs differing only in %s as equal', (_what, a, b) => {
    expect(key(a)).toBe(key(b));
    expect(key(a)).toBeDefined();
  });

  it.each([
    ['the path', 'https://example.com/api/openapi', 'https://example.com/api/openapi2'],
    ['the path case', 'https://example.com/API', 'https://example.com/api'],
    ['an encoded reserved character', 'https://example.com/a%2Fb', 'https://example.com/a/b'],
    ['the query', 'https://example.com/a?v=1', 'https://example.com/a?v=2'],
    ['the query order', 'https://example.com/a?x=1&y=2', 'https://example.com/a?y=2&x=1'],
    ['an empty query', 'https://example.com/a?', 'https://example.com/a'],
    ['user information', 'https://user@example.com/a', 'https://example.com/a'],
    ['a password', 'https://user:a@example.com/a', 'https://user:b@example.com/a'],
    ['the scheme', 'http://example.com/a', 'https://example.com/a'],
    ['a non-default port', 'https://example.com:8443/a', 'https://example.com/a'],
    ['the host', 'https://example.com/a', 'https://example.org/a'],
  ])('keeps URIs differing in %s apart', (_what, a, b) => {
    expect(key(a)).not.toBe(key(b));
  });

  it('has no key for a URI that cannot be a base', () => {
    expect(key('urn:uuid:f26cdaad-3193-4398-a838-4ecb7326c4c5')).toBeUndefined();
    expect(key('javascript:alert(1)')).toBeUndefined();
    expect(key('ftp://example.com/a')).toBeUndefined();
  });
});

describe('parseDocumentUri', () => {
  it.each([
    ['https://example.com/api/openapi.yaml', 'https://example.com/api/openapi.yaml'],
    ['HTTP://Example.com:80/a/../openapi.json', 'http://example.com/openapi.json'],
    ['file:///srv/specs/openapi.yaml', 'file:///srv/specs/openapi.yaml'],
    ['https://example.com/openapi?version=2', 'https://example.com/openapi?version=2'],
  ])('accepts %s', (value, href) => {
    expect(parseDocumentUri(value)).toBe(href);
  });

  it.each([
    [42, 'must be a string'],
    ['openapi.yaml', 'must be an absolute URI'],
    ['/srv/openapi.yaml', 'must be an absolute URI'],
    ['https://exa mple.com/', 'must be a URI (RFC 3986 characters only)'],
    ['https://example.com/a\r\nX-Injected: 1', 'must be a URI (RFC 3986 characters only)'],
    ['https://example.com/é', 'must be a URI (RFC 3986 characters only)'],
    ['https://example.com/%zz', 'must be a URI (RFC 3986 characters only)'],
    ['http://[zz]/', 'must be an absolute URI'],
    ['ftp://example.com/openapi.yaml', 'must be an http, https or file URI'],
    ['javascript:alert(1)', 'must be an http, https or file URI'],
    ['https://user:pass@example.com/openapi.yaml', 'must not contain user information'],
    ['https://example.com/openapi.yaml#/info', 'must not contain a fragment'],
    ['https://example.com/openapi.yaml#', 'must not contain a fragment'],
    ['file://fileserver/share/openapi.yaml', 'must not name a host in a file URI'],
    [`https://example.com/${'a'.repeat(MAX_BASE_URI_LENGTH)}`, `must be at most ${MAX_BASE_URI_LENGTH} characters`],
  ])('rejects %p (%s)', (value, problem) => {
    expect(() => parseDocumentUri(value)).toThrow(LoadError);
    expect(() => parseDocumentUri(value)).toThrow(`LoadOptions.documentUri ${problem}`);
  });

  it('quotes a rejected value bounded and escaped', () => {
    const long = `https://example.com/${'a'.repeat(1500)}#`;
    let message = '';
    try {
      parseDocumentUri(long);
    } catch (error) {
      message = (error as Error).message;
      expect(JSON.stringify((error as LoadError).context).length).toBeLessThan(400);
    }
    expect(message.length).toBeLessThan(400);
    expect(() => parseDocumentUri('a\nb')).toThrow('found "a\\nb"');
  });

  it('never quotes user information, in the message or the context', () => {
    for (const value of [
      'https://admin:hunter2@example.com/x',
      'https://admin:hunter2@example.com/x#frag',
      'ftp://admin:hunter2@h/',
      // Malformed: refused for another reason first, still never quoted with its credential
      ' https://admin:hunter2@example.com/spec.yaml',
      'https:admin:hunter2@example.com/spec.yaml',
      'https:\\\\admin:hunter2@example.com\\spec.yaml',
      'https://admin:hunter 2@example.com/spec.yaml',
    ]) {
      try {
        parseDocumentUri(value);
        throw new Error('expected a LoadError');
      } catch (error) {
        expect(error).toBeInstanceOf(LoadError);
        expect(JSON.stringify({ message: (error as Error).message, context: (error as LoadError).context })).not.toContain(
          'hunter2',
        );
        expect((error as Error).message).toContain('***@');
      }
    }
  });
});

describe('redactUserInfo', () => {
  it.each([
    ['https://user:secret@example.com/a', 'https://***@example.com/a'],
    ['//user@example.com/a', '//***@example.com/a'],
    ['https://example.com/a@b', 'https://example.com/a@b'],
    ['https://example.com/a?x=@', 'https://example.com/a?x=@'],
    ['not a uri', 'not a uri'],
    // Malformed values a URL parser still reads as user information
    [' https://admin:secret@example.com/spec.yaml', ' https://***@example.com/spec.yaml'],
    // Tabs and line breaks are removed, as a URL parser does, and leading controls skipped
    ['\thttps://admin:secret@example.com', 'https://***@example.com'],
    ['https:/\t/u:p@h/x', 'https://***@h/x'],
    ['https:\n//u:p@h', 'https://***@h'],
    ['ht\rtps://u:p@h', 'https://***@h'],
    ['\u0001https://u:p@h', '\u0001https://***@h'],
    // A special scheme reads an authority without `//`; inside a path too (a reference resolved as a local path)
    ['https:user:secret@host/pet.json', 'https:***@host/pet.json'],
    ['HTTPS:u:p@h', 'HTTPS:***@h'],
    ['/srv/specs/https:user:secret@host/pet.json', '/srv/specs/https:***@host/pet.json'],
    ['file:///srv/ws:u:p@h/x?q@r', 'file:///srv/ws:***@h/x?q@r'],
    // Another scheme only with `//`
    ['foo://u:p@h/x', 'foo://***@h/x'],
    ['https:admin:secret@example.com/a', 'https:***@example.com/a'],
    ['https:\\\\admin:secret@example.com\\a', 'https:\\\\***@example.com\\a'],
    ['https://admin:se cret@exa mple.com/a', 'https://***@exa mple.com/a'],
    ['https://a@b:secret@example.com#x@y', 'https://***@example.com#x@y'],
    // Not user information for a URL parser: an opaque URI, or a file name with a scheme-like prefix
    ['admin:secret@example.com', 'admin:secret@example.com'],
    ['mailto:a@b', 'mailto:a@b'],
    ['a:b@c.yaml', 'a:b@c.yaml'],
    ['schemas/a:b@c.yaml', 'schemas/a:b@c.yaml'],
    ['a\nb@c', 'a\nb@c'],
    // A relative reference has no authority: an `@` in its path is not user information
    ['pet@v2.yaml', 'pet@v2.yaml'],
    ['@scope/schemas.yaml#/Pet', '@scope/schemas.yaml#/Pet'],
    ['./a@b/c.yaml', './a@b/c.yaml'],
    ['/a@b', '/a@b'],
  ])('redacts %p', (value, shown) => {
    expect(redactUserInfo(value)).toBe(shown);
  });
});

describe('userInfoOf', () => {
  it.each<[string, string[]]>([
    ['https://user:secret@example.com/a', ['user:secret']],
    ['https:user:secret@host/pet.json', ['user:secret']],
    ['https:/\t/u:p@h/x', ['u:p']],
    ['/srv/https:u:p@h/x', ['u:p']],
    ['https://a@b/c/http:d@e/f', ['a', 'd']],
    ['https://@h', []],
    ['pet@v2.yaml', []],
    ['a:b@c.yaml', []],
  ])('finds the user information of %p', (text, parts) => {
    expect(userInfoOf(text)).toEqual(parts);
  });
});

describe('retrievalUriOf', () => {
  it('drops user information and the fragment', () => {
    expect(retrievalUriOf('https://user:secret@example.com/api/openapi.json?x=1#top')).toBe(
      'https://example.com/api/openapi.json?x=1',
    );
    expect(retrievalUriOf('http://127.0.0.1:8080/openapi.yaml')).toBe('http://127.0.0.1:8080/openapi.yaml');
  });
});

describe('readSelfField', () => {
  it('is absent without $self', () => {
    expect(readSelfField({ openapi: '3.2.0' }, V32)).toEqual({ kind: 'absent' });
    expect(readSelfField({ openapi: '3.2.0', $self: undefined }, V32)).toEqual({ kind: 'absent' });
    expect(readSelfField(null, V32)).toEqual({ kind: 'absent' });
  });

  it('reads a URI reference without a fragment in 3.2 and later', () => {
    for (const value of ['https://example.com/api/openapi', '/api/openapi', '../openapi.yaml', '']) {
      expect(readSelfField({ $self: value }, V32)).toEqual({ kind: 'reference', value });
    }
    expect(readSelfField({ $self: '/api' }, v('3.3.0'))).toEqual({ kind: 'reference', value: '/api' });
  });

  it.each(['3.0.3', '3.1.1'])('does not read $self in a document declaring %s', (declared) => {
    expect(readSelfField({ $self: 'https://example.com/api' }, v(declared))).toEqual({
      kind: 'not-read',
      diagnostic: {
        severity: 'warning',
        code: 'FEATURE_NEWER_THAN_DECLARED_VERSION',
        message:
          `The \`$self\` field needs OpenAPI 3.2 or later, but the document declares OpenAPI "${declared}"; it is ` +
          'ignored, and references resolve as if it were absent',
        path: '/$self',
      },
    });
  });

  it('does not read $self, silently, when the version cannot be processed', () => {
    expect(readSelfField({ $self: 'https://example.com/api' }, detectSpecVersion({}))).toEqual({ kind: 'not-read' });
    expect(readSelfField({ $self: 'https://example.com/api' }, v('4.0.0'))).toEqual({ kind: 'not-read' });
  });

  it.each([
    [42, 'must be a string holding a URI reference, found 42'],
    [null, 'must be a string holding a URI reference, found null'],
    [{ href: 'x' }, 'must be a string holding a URI reference, found an object'],
    ['https://example.com/a b', 'must be a URI reference (RFC 3986), found "https://example.com/a b"'],
    ['https://example.com/\r\nSet-Cookie: x', 'must be a URI reference (RFC 3986), found "https://example.com/\\r\\nSet-Cookie: x"'],
    ['https://exämple.com/', 'must be a URI reference (RFC 3986), found "https://exämple.com/"'],
    ['http://[zz]/api', 'must be a URI reference (RFC 3986), found "http://[zz]/api"'],
    ['https://example.com:99999/', 'must be a URI reference (RFC 3986), found "https://example.com:99999/"'],
    ['https://example.com/api#/info', 'must not contain a fragment, found "https://example.com/api#/info"'],
    ['#', 'must not contain a fragment, found "#"'],
    // User information is never quoted, even in a value that is refused for another reason
    ['https://admin:secret@example.com/a b', 'must be a URI reference (RFC 3986), found "https://***@example.com/a b"'],
    ['https://admin:secret@example.com/api#x', 'must not contain a fragment, found "https://***@example.com/api#x"'],
  ])('reports %p as INVALID_SELF', (value, problem) => {
    expect(readSelfField({ $self: value }, V32)).toEqual({
      kind: 'invalid',
      diagnostic: {
        severity: 'warning',
        code: DIAGNOSTIC_CODES.INVALID_SELF,
        message: `\`$self\` ${problem}; it is ignored, and references resolve as if it were absent`,
        path: '/$self',
      },
    });
  });
});

describe('resolveDocumentBase', () => {
  const resolve = (self: unknown, retrievalUri?: string, openapi = '3.2.0') =>
    resolveDocumentBase({ openapi, $self: self }, v(openapi), retrievalUri);
  const refused = (problem: string) => [
    {
      severity: 'warning',
      code: DIAGNOSTIC_CODES.REFUSED_SELF,
      message: `\`$self\` ${problem}; it is ignored, and references resolve as if it were absent`,
      path: '/$self',
    },
  ];

  it('has no base without a retrieval URI or $self', () => {
    expect(resolveDocumentBase({ openapi: '3.2.0' }, V32, undefined)).toEqual({ diagnostics: [] });
  });

  it('uses the retrieval URI alone', () => {
    expect(baseOf('https://example.com/api/openapi.yaml')).toEqual({
      href: 'https://example.com/api/openapi.yaml',
      retrievalUri: 'https://example.com/api/openapi.yaml',
      identities: new Set(['https://example.com/api/openapi.yaml']),
      retrievalTooLong: false,
    });
  });

  // Appendix F, "Base URI Within Content": $self names the document. Where its relative
  // references are read from is the retrieval URI: an implementation choice the
  // specification leaves open (it takes $self as the base for both)
  it('knows the document by an absolute $self too, and still reads from the retrieval URI', () => {
    expect(baseOf('file:///home/someone/src/api/openapi.yaml', 'https://example.com/api/openapi')).toEqual({
      href: 'file:///home/someone/src/api/openapi.yaml',
      retrievalUri: 'file:///home/someone/src/api/openapi.yaml',
      selfUri: 'https://example.com/api/openapi',
      identities: new Set(['file:///home/someone/src/api/openapi.yaml', 'https://example.com/api/openapi']),
      retrievalTooLong: false,
    });
  });

  // Appendix F, "Resolving Relative $self and $id"
  it('resolves a relative $self against the retrieval URI', () => {
    expect(baseOf('https://staging.example.com/api/openapi', '/api/openapi').selfUri).toBe(
      'https://staging.example.com/api/openapi',
    );
    expect(baseOf('https://staging.example.com/x/openapi', '/api/shared/foo')).toMatchObject({
      href: 'https://staging.example.com/x/openapi',
      selfUri: 'https://staging.example.com/api/shared/foo',
    });
    expect(baseOf('https://example.com/a/b/openapi.yaml', '../v2/openapi').selfUri).toBe('https://example.com/a/v2/openapi');
    expect(baseOf('https://example.com/api/openapi?x=1', '').selfUri).toBe('https://example.com/api/openapi?x=1');
  });

  it('reads relative references from an absolute $self only without a retrieval URI', () => {
    expect(baseOf(undefined, 'https://example.com/api/openapi')).toEqual({
      href: 'https://example.com/api/openapi',
      selfUri: 'https://example.com/api/openapi',
      identities: new Set(['https://example.com/api/openapi']),
      retrievalTooLong: false,
    });
    expect(baseOf(undefined, 'file:///srv/api/openapi.yaml').href).toBe('file:///srv/api/openapi.yaml');
  });

  it('accepts a $self naming an internal address or any host: it is never fetched by itself', () => {
    expect(baseOf(undefined, 'http://10.0.0.1/api/openapi').href).toBe('http://10.0.0.1/api/openapi');
    expect(baseOf('https://example.com/openapi', 'http://169.254.169.254/latest/')).toMatchObject({
      href: 'https://example.com/openapi',
      selfUri: 'http://169.254.169.254/latest/',
    });
  });

  it('ignores a relative $self without a retrieval URI (UNRESOLVABLE_SELF)', () => {
    expect(resolve('/api/openapi')).toEqual({
      diagnostics: [
        {
          severity: 'warning',
          code: DIAGNOSTIC_CODES.UNRESOLVABLE_SELF,
          message:
            '`$self` is a relative reference ("/api/openapi"), but the document has no retrieval URI to resolve it ' +
            'against (load it with fromURL or fromFile, or pass LoadOptions.documentUri); it is ignored, and ' +
            'references resolve as if it were absent',
          path: '/$self',
        },
      ],
    });
    // A network-path reference is relative too; its user information is not quoted
    const networkPath = resolve('//admin:hunter2@example.com/api').diagnostics[0];
    expect(networkPath.code).toBe(DIAGNOSTIC_CODES.UNRESOLVABLE_SELF);
    expect(networkPath.message).toContain('("//***@example.com/api")');
    expect(networkPath.message).not.toContain('hunter2');
  });

  it('refuses a $self with user information, without quoting it', () => {
    const result = resolve('https://admin:hunter2@example.com/api', 'https://example.com/openapi');
    expect(result.diagnostics).toEqual(refused('contains user information (a credential before the host)'));
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(result.base?.href).toBe('https://example.com/openapi');
    expect(result.base?.selfUri).toBeUndefined();
    expect(resolve('//user@evil.example/api', 'https://example.com/openapi').diagnostics).toEqual(
      refused('contains user information (a credential before the host)'),
    );
  });

  it.each([
    ['javascript:alert(1)', 'uses the "javascript" scheme; only http, https and file URIs can name a document'],
    ['data:text/plain,x', 'uses the "data" scheme; only http, https and file URIs can name a document'],
    ['urn:uuid:f26cdaad-3193-4398-a838-4ecb7326c4c5', 'uses the "urn" scheme; only http, https and file URIs can name a document'],
    ['ftp://example.com/api', 'uses the "ftp" scheme; only http, https and file URIs can name a document'],
  ])('refuses a $self with the scheme of %s', (self, problem) => {
    expect(resolve(self).diagnostics).toEqual(refused(problem));
    expect(resolve(self).base).toBeUndefined();
  });

  it.each(['https://example.com/api/openapi', 'http://example.com/api/openapi'])(
    'refuses a file $self in a document retrieved from %s',
    (retrieval) => {
      const scheme = retrieval.slice(0, retrieval.indexOf(':'));
      const result = resolve('file:///etc/', retrieval);
      expect(result.diagnostics).toEqual(
        refused(
          `is a file URI, but the document was retrieved over ${scheme}: a document read from the network cannot ` +
            'name itself with a local file',
        ),
      );
      expect(result.base?.identities).toEqual(new Set([retrieval]));
    },
  );

  it('allows a file $self in a file document, or one with no retrieval URI', () => {
    expect(baseOf('file:///srv/a/openapi.yaml', 'file:///srv/b/openapi.yaml')).toMatchObject({
      href: 'file:///srv/a/openapi.yaml',
      selfUri: 'file:///srv/b/openapi.yaml',
    });
    expect(baseOf('file:///srv/a/openapi.yaml', '/srv/c/openapi.yaml').selfUri).toBe('file:///srv/c/openapi.yaml');
  });

  it('refuses a file $self that names a host, or that cannot be resolved against a file URI', () => {
    expect(resolve('file://fileserver/share/openapi.yaml').diagnostics).toEqual(
      refused('is a file URI that names a host'),
    );
    expect(resolve('//fileserver/share/openapi.yaml', 'file:///srv/openapi.yaml').diagnostics).toEqual(
      refused('is a file URI that names a host'),
    );
    expect(resolve('//fileserver:8080/x', 'file:///srv/openapi.yaml').diagnostics).toEqual(
      refused('cannot be resolved against the retrieval URI'),
    );
  });

  it(`refuses a $self, or what it resolves to, longer than ${MAX_BASE_URI_LENGTH} characters`, () => {
    const long = `https://example.com/${'a'.repeat(MAX_BASE_URI_LENGTH)}`;
    expect(resolve(long).diagnostics).toEqual(refused(`is longer than ${MAX_BASE_URI_LENGTH} characters`));
    const atLimit = `https://example.com/${'a'.repeat(MAX_BASE_URI_LENGTH - 'https://example.com/'.length)}`;
    expect(resolve(atLimit).base?.href).toBe(atLimit);
    // A relative $self within the limit can resolve past it
    const retrieval = `https://example.com/${'r'.repeat(MAX_BASE_URI_LENGTH - 100)}/openapi`;
    expect(resolve(`x/${'s'.repeat(200)}`, retrieval).diagnostics).toEqual(
      refused(`resolves to a URI longer than ${MAX_BASE_URI_LENGTH} characters`),
    );
  });

  it('does not use a retrieval URI longer than the limit, and says so', () => {
    const tooLong = `https://example.com/spec.json?sig=${'x'.repeat(MAX_BASE_URI_LENGTH)}`;
    const tooLongDiagnostic = {
      severity: 'warning',
      code: DIAGNOSTIC_CODES.BASE_URI_TOO_LONG,
      message:
        `The URI the document was retrieved from is longer than ${MAX_BASE_URI_LENGTH} characters, so it is not used: ` +
        'a reference to the document by that URI is not recognised as local, and a relative reference to another ' +
        'document cannot be resolved',
    };
    expect(resolveDocumentBase({ openapi: '3.2.0' }, V32, tooLong)).toEqual({
      base: { identities: new Set(), retrievalTooLong: true },
      diagnostics: [tooLongDiagnostic],
    });
    // An absolute $self still names the document, but relative references are not read from it
    expect(resolve('https://example.com/api/openapi', tooLong)).toEqual({
      base: {
        selfUri: 'https://example.com/api/openapi',
        identities: new Set(['https://example.com/api/openapi']),
        retrievalTooLong: true,
      },
      diagnostics: [tooLongDiagnostic],
    });
    expect(resolve('/api/openapi', tooLong).diagnostics[1]).toMatchObject({
      code: DIAGNOSTIC_CODES.UNRESOLVABLE_SELF,
      message: expect.stringContaining('but the URI the document was retrieved from is too long to be used'),
    });
  });

  it('reports an invalid $self and keeps the retrieval URI', () => {
    const result = resolve('https://example.com/api#frag', 'https://example.com/openapi.json');
    expect(result.diagnostics.map((d) => d.code)).toEqual([DIAGNOSTIC_CODES.INVALID_SELF]);
    expect(result.base?.href).toBe('https://example.com/openapi.json');
    expect(result.base?.selfUri).toBeUndefined();
  });

  it('ignores $self in a 3.1 document, with the newer-feature diagnostic', () => {
    const result = resolve('https://example.com/api', 'https://example.com/openapi.json', '3.1.0');
    expect(result.diagnostics.map((d) => d.code)).toEqual(['FEATURE_NEWER_THAN_DECLARED_VERSION']);
    expect(result.base?.identities).toEqual(new Set(['https://example.com/openapi.json']));
  });
});

describe('fragmentPointerTokens', () => {
  it.each<[string, string[] | undefined]>([
    ['', []],
    ['/', ['']],
    ['/components/schemas/Pet', ['components', 'schemas', 'Pet']],
    ['/components/schemas/A%20B', ['components', 'schemas', 'A B']],
    ['/paths/~1pets~1%7Bid%7D', ['paths', '/pets/{id}']],
    ['/a~01/b%7E1', ['a~1', 'b/']],
    ['/a%25b', ['a%b']],
    ['/bad%zz/x', ['bad%zz', 'x']],
    ['/%E0%A4%A', ['%E0%A4%A']],
    ['%2Fcomponents', ['components']],
    ['Pet', undefined],
    ['%50et', undefined],
  ])('reads %p as %p', (fragment, tokens) => {
    expect(fragmentPointerTokens(fragment)).toEqual(tokens);
  });
});

describe('findSelfReferences', () => {
  const base = baseOf('https://example.com/api/openapi.yaml');
  const scan = (ref: unknown, at: DocumentBase = base) => {
    const node = { $ref: ref };
    const { references } = findSelfReferences({ wrapper: node }, at);
    return references.map(({ node: found, ref: written, resolved, fragment, tokens }) => ({
      same: found === node,
      written,
      resolved,
      fragment,
      tokens,
    }));
  };

  it.each<[string, string, string[]]>([
    ['https://example.com/api/openapi.yaml#/components/schemas/Pet', '/components/schemas/Pet', ['components', 'schemas', 'Pet']],
    ['openapi.yaml#/components/schemas/Pet', '/components/schemas/Pet', ['components', 'schemas', 'Pet']],
    ['./openapi.yaml#/paths/~1pets', '/paths/~1pets', ['paths', '/pets']],
    ['../api/openapi.yaml#/components/schemas/A%20B', '/components/schemas/A%20B', ['components', 'schemas', 'A B']],
    ['openapi.yaml#/components/schemas/A B', '/components/schemas/A%20B', ['components', 'schemas', 'A B']],
    ['HTTPS://EXAMPLE.COM:443/api/./x/../openapi.yaml#/info', '/info', ['info']],
    ['https://example.com/api/%6Fpenapi.yaml#/info', '/info', ['info']],
    ['//example.com/api/openapi.yaml#/info', '/info', ['info']],
    ['https://example.com/api/openapi.yaml', '', []],
    ['openapi.yaml#', '', []],
    ['', '', []],
  ])('reads %p as the pointer %p', (ref, fragment, tokens) => {
    expect(scan(ref)).toEqual([
      { same: true, written: ref, resolved: expect.stringMatching(/^https:\/\/example\.com\/api\/(openapi|%6Fpenapi)\.yaml/), fragment, tokens },
    ]);
  });

  it.each([
    ['#/components/schemas/Pet', 'a local reference'],
    ['https://example.com/api/openapi.yaml#Pet', 'a plain-name fragment ($anchor)'],
    ['other.yaml#/components/schemas/Pet', 'another document'],
    ['https://example.com/api/openapi.yaml?v=2#/info', 'another query'],
    ['https://user@example.com/api/openapi.yaml#/info', 'user information'],
    ['http://example.com/api/openapi.yaml#/info', 'another scheme'],
    ['https://example.com:8443/api/openapi.yaml#/info', 'another port'],
    ['https://example.com/api/OPENAPI.yaml#/info', 'another path case'],
    ['https://[zz]/#/info', 'an unparseable URI'],
  ])('leaves %p alone (%s)', (ref) => {
    expect(scan(ref)).toEqual([]);
  });

  it('knows the document by its retrieval URI and by $self, resolving relative references against both', () => {
    const both = baseOf('file:///srv/api/openapi.yaml', 'https://example.com/api/openapi');
    expect(scan('https://example.com/api/openapi#/info', both)).toHaveLength(1);
    expect(scan('file:///srv/api/openapi.yaml#/info', both)).toHaveLength(1);
    expect(scan('openapi#/info', both)).toHaveLength(1);
    expect(scan('openapi.yaml#/info', both)).toHaveLength(1);
    expect(scan('other.yaml#/info', both)).toHaveLength(0);
    // Without a usable retrieval URI, a relative reference is resolved against $self alone
    const tooLong = resolveDocumentBase(
      { openapi: '3.2.0', $self: 'https://example.com/api/openapi' },
      V32,
      `https://example.com/${'x'.repeat(MAX_BASE_URI_LENGTH)}`,
    ).base!;
    expect(scan('openapi#/info', tooLong)).toHaveLength(1);
    expect(scan('', tooLong)).toHaveLength(1);
    const nothing = resolveDocumentBase({ openapi: '3.2.0' }, V32, `https://example.com/${'x'.repeat(MAX_BASE_URI_LENGTH)}`).base!;
    expect(scan('', nothing)).toEqual([]);
  });

  it('finds them in document order, with where each is, and only absolute ones under a schema with its own $id', () => {
    const document = {
      paths: { '/pets': { $ref: 'https://example.com/api/openapi.yaml#/components/pathItems/Pets' } },
      components: {
        schemas: {
          Pet: { properties: { tags: { items: [{ $ref: 'openapi.yaml#/components/schemas/Tag' }] } } },
          Scoped: {
            $id: 'https://example.com/schemas/s',
            properties: {
              a: { $ref: 'openapi.yaml#/x' },
              b: { $ref: 'https://example.com/api/openapi.yaml#/components/schemas/B' },
              c: { $ref: '//example.com/api/openapi.yaml#/c' },
            },
          },
          Unscoped: { $id: '', $ref: 'openapi.yaml#/y' },
          Other: { $ref: 'other.yaml#/Other' },
          Inherited: Object.create({ $ref: 'openapi.yaml#/z' }),
          NotAString: { $ref: 42 },
        },
      },
    };
    const { references } = findSelfReferences(document, base);
    expect(references.map((r) => [r.ref, r.location(), r.scoped])).toEqual([
      ['https://example.com/api/openapi.yaml#/components/pathItems/Pets', ['paths', '/pets'], false],
      ['openapi.yaml#/components/schemas/Tag', ['components', 'schemas', 'Pet', 'properties', 'tags', 'items', '0'], false],
      // An absolute reference names the document whatever the $id; a relative one (even network-path) is the $id's
      [
        'https://example.com/api/openapi.yaml#/components/schemas/B',
        ['components', 'schemas', 'Scoped', 'properties', 'b'],
        true,
      ],
      ['openapi.yaml#/y', ['components', 'schemas', 'Unscoped'], false],
    ]);
    // Nothing is changed
    expect(document.paths['/pets'].$ref).toBe('https://example.com/api/openapi.yaml#/components/pathItems/Pets');
  });

  it('resolves each distinct $ref string once, against each base it needs', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ $ref: i % 2 === 0 ? 'openapi.yaml#/a' : 'other.yaml#/a' }));
    expect(findSelfReferences({ many }, base)).toMatchObject({ resolutions: 2 });
    const both = baseOf('file:///srv/api/openapi.yaml', 'https://example.com/api/openapi');
    // `openapi.yaml#/a` is found against the first base; `other.yaml#/a` is tried against both
    expect(findSelfReferences({ many }, both)).toMatchObject({ resolutions: 3 });
  });

  it('does work bounded by the distinct references, not their number (perf guard)', () => {
    // A base at the length limit, and 300,000 references of two spellings
    const longBase = baseOf(`https://example.com/${'p/'.repeat(1000)}openapi.json`.slice(0, MAX_BASE_URI_LENGTH));
    const refs = Array.from({ length: 300000 }, (_, i) => ({ $ref: i % 2 === 0 ? '#/local' : 'other.json#/x' }));
    const started = Date.now();
    const scan = findSelfReferences({ refs }, longBase);
    expect(scan).toEqual({ references: [], resolutions: 1 });
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('visits a shared or cyclic object once, and deep nesting without recursion', () => {
    const shared: Record<string, unknown> = { $ref: 'openapi.yaml#/components/schemas/A' };
    const cyclic: Record<string, unknown> = { child: shared };
    cyclic['self'] = cyclic;
    expect(findSelfReferences({ x: shared, y: shared, z: cyclic }, base).references).toHaveLength(1);
    let node: Record<string, unknown> = { $ref: 'openapi.yaml#/deep' };
    for (let i = 0; i < 20000; i++) node = { next: node };
    const [deep] = findSelfReferences(node, base).references;
    expect(deep.tokens).toEqual(['deep']);
    expect(deep.location()).toHaveLength(20000);
  });
});

describe('refParserScopesIds', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['OpenAPI 3.1', { openapi: '3.1.0' }, true],
    ['OpenAPI 3.1 without a patch', { openapi: '3.1' }, true],
    ['OpenAPI 3.0', { openapi: '3.0.3' }, false],
    ['OpenAPI 3.2', { openapi: '3.2.0' }, false],
    ['OpenAPI 3.10', { openapi: '3.10.0' }, false],
    ['Swagger 2.0', { swagger: '2.0' }, false],
    ['a root $id', { openapi: '3.0.3', $id: 'https://example.com/x' }, true],
    ['an empty root $id', { openapi: '3.0.3', $id: '' }, false],
    ['a draft-04 id', { $schema: 'http://json-schema.org/draft-04/schema#', id: 'https://example.com/x' }, true],
    ['a 2020-12 dialect', { openapi: '3.2.0', $schema: 'https://json-schema.org/draft/2020-12/schema' }, true],
    ['the OpenAPI 3.1 dialect', { $schema: 'https://spec.openapis.org/oas/3.1/dialect/base' }, true],
    ['another $schema', { openapi: '3.0.3', $schema: 'https://example.com/mine' }, false],
    ['not an object', 'x' as unknown as Record<string, unknown>, false],
  ])('%s: %p', (_label, document, expected) => {
    expect(refParserScopesIds(document)).toBe(expected);
  });
});

describe('pointerTargetProblem', () => {
  const root = {
    components: { schemas: { Pet: { type: 'object' }, 'A B': {}, Ref: { $ref: '#/components/schemas/Pet', title: 't' } } },
    list: [{ a: 1 }, null],
  };

  it.each<string[][]>([[[]], [['components', 'schemas', 'Pet']], [['components', 'schemas', 'A B']], [['list', '0', 'a']], [['list', '1']], [['components', 'schemas', 'Ref']]])(
    'accepts %p',
    (tokens) => {
      expect(pointerTargetProblem(root, tokens)).toBeUndefined();
    },
  );

  it.each<[string[], string]>([
    [['components', 'schemas', 'Nope'], '"#/components/schemas/Nope" points to nothing in it'],
    [['list', '2'], '"#/list/2" points to nothing in it'],
    [['list', '01'], '"#/list/01" points to nothing in it'],
    [['list', '-'], '"#/list/-" points to nothing in it'],
    [['list', 'length'], '"#/list/length" points to nothing in it'],
    [['components', 'constructor'], '"#/components/constructor" points to nothing in it'],
    [['components', 'schemas', 'Pet', 'type', 'x'], '"#/components/schemas/Pet/type/x" points to nothing in it'],
    [['a/b', '~'], '"#/a~1b/~0" points to nothing in it'],
    [
      ['components', 'schemas', 'Ref', 'title'],
      'its pointer goes through another $ref (at "#/components/schemas/Ref"), which is not followed',
    ],
  ])('refuses %p', (tokens, problem) => {
    expect(pointerTargetProblem(root, tokens)).toBe(problem);
  });
});

describe('findRelativeReference', () => {
  it('finds the first relative reference to another document, in document order', () => {
    expect(
      findRelativeReference({
        a: { $ref: '#/local' },
        b: { $ref: '' },
        c: [{ $ref: 'https://example.com/x.json' }, { $ref: 'file:///x.json' }],
        d: { e: { $ref: 'schemas/pet.yaml' } },
        f: { $ref: '../other.yaml' },
      }),
    ).toEqual({ ref: 'schemas/pet.yaml', location: ['d', 'e'] });
    const shared = { $ref: 'x.yaml' };
    expect(findRelativeReference({ a: shared, b: shared })).toEqual({ ref: 'x.yaml', location: ['a'] });
    expect(findRelativeReference({ a: [{ $ref: '#/x' }], b: Object.create({ $ref: 'x.yaml' }) })).toBeUndefined();
  });
});

describe('isSameDocument', () => {
  it('compares a URL with the identities of a base', () => {
    const base = baseOf('https://example.com/api/openapi.yaml');
    expect(isSameDocument(new URL('https://EXAMPLE.com/api/openapi.yaml#/x'), base)).toBe(true);
    expect(isSameDocument(new URL('https://example.com/api/other.yaml'), base)).toBe(false);
    expect(isSameDocument(new URL('urn:x'), base)).toBe(false);
  });
});

describe('resolveSecuritySchemeUri', () => {
  const base = baseOf('https://example.com/api/openapi.yaml');
  const noBase =
    'cannot be resolved: the document has no base URI (load it with fromURL or fromFile, or pass ' +
    'LoadOptions.documentUri)';

  it('reads a fragment-only key as this document, with or without a base', () => {
    expect(resolveSecuritySchemeUri('#/components/securitySchemes/bearer', undefined)).toEqual({ name: 'bearer' });
    expect(resolveSecuritySchemeUri('#/components/securitySchemes/bearer', base)).toEqual({ name: 'bearer' });
  });

  it.each([
    ['https://example.com/api/openapi.yaml#/components/securitySchemes/bearer', 'bearer'],
    ['openapi.yaml#/components/securitySchemes/bearer', 'bearer'],
    ['./openapi.yaml#/components/securitySchemes/bearer', 'bearer'],
    ['#/components/securitySchemes/my~1scheme~0v2', 'my/scheme~v2'],
    ['#/components/securitySchemes/my%20scheme', 'my scheme'],
    ['openapi.yaml#/components/securitySchemes/my scheme', 'my scheme'],
    ['#/components/securitySchemes/%7E01', '~1'],
    ['#/components/securitySchemes/', ''],
  ])('reads %s as the scheme %p', (key, name) => {
    expect(resolveSecuritySchemeUri(key, base)).toEqual({ name });
  });

  it('knows the document by $self too', () => {
    const both = baseOf('https://mirror.example.org/openapi.yaml', 'https://example.com/api/openapi');
    expect(resolveSecuritySchemeUri('https://example.com/api/openapi#/components/securitySchemes/k', both)).toEqual({
      name: 'k',
    });
    expect(resolveSecuritySchemeUri('openapi#/components/securitySchemes/k', both)).toEqual({ name: 'k' });
    expect(resolveSecuritySchemeUri('openapi.yaml#/components/securitySchemes/k', both)).toEqual({ name: 'k' });
  });

  it('does not read another document, and never quotes where it would be: ./foo names the document foo', () => {
    for (const key of ['./foo', 'other.yaml#/components/securitySchemes/bearer']) {
      expect(resolveSecuritySchemeUri(key, baseOf('file:///home/someone/api/openapi.yaml'))).toEqual({
        problem: 'names a scheme in another document, which is not read',
      });
    }
  });

  it('cannot resolve a relative or absolute key without a usable base', () => {
    const tooLong = resolveDocumentBase({ openapi: '3.2.0' }, V32, `https://example.com/${'x'.repeat(MAX_BASE_URI_LENGTH)}`).base;
    for (const key of ['./foo', 'https://example.com/api/openapi.yaml#/components/securitySchemes/bearer']) {
      expect(resolveSecuritySchemeUri(key, undefined)).toEqual({ problem: noBase });
      expect(resolveSecuritySchemeUri(key, tooLong)).toEqual({ problem: noBase });
    }
  });

  it('reports a key that is not a URI reference, or points elsewhere in this document', () => {
    expect(resolveSecuritySchemeUri('http://[zz]/#/components/securitySchemes/a', base)).toEqual({
      problem: 'is neither a component name nor a URI reference',
    });
    expect(resolveSecuritySchemeUri('#/components/schemas/Pet', base)).toEqual({
      problem: 'points to "#/components/schemas/Pet" in this document, which is not under /components/securitySchemes',
    });
    expect(resolveSecuritySchemeUri('#/components/securitySchemes/a/b', base)).toEqual({
      problem:
        'points to "#/components/securitySchemes/a/b" in this document, which is not under /components/securitySchemes',
    });
    expect(resolveSecuritySchemeUri('openapi.yaml', base)).toEqual({
      problem: 'points to "#" in this document, which is not under /components/securitySchemes',
    });
    expect(resolveSecuritySchemeUri('#/components/securitySchemes/%E0%A4%A', base)).toEqual({
      problem: 'has a fragment that is not valid percent-encoding',
    });
  });
});
