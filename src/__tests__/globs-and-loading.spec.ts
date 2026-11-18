import { ParseError, SsrfError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import {
  assertUrlSafe,
  hostListIncludes,
  isBlockedHostname,
  type ResolvedAddress,
  type ResolvedSsrfOptions,
} from '../ssrf';
import { createLoopbackServer, type LoopbackHandler } from './helpers/loopback';

const ok = { 200: { description: 'ok' } };

const lookupTo = (...addresses: string[]) =>
  jest.fn(async (): Promise<ResolvedAddress[]> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );

const ssrfOptions = (options: Partial<ResolvedSsrfOptions>): ResolvedSsrfOptions => ({
  allowedHosts: [],
  blockedHosts: [],
  allowInternalIPs: false,
  ...options,
});

async function refusalOf(url: string, ssrf: ResolvedSsrfOptions, lookup = lookupTo('93.184.216.34')) {
  return assertUrlSafe(url, ssrf, lookup).then(
    () => undefined,
    (error: unknown) => error as SsrfError,
  );
}

describe('path globs match in time linear in the glob and the path', () => {
  it.each([
    ['/**/a/**/a/**/a/**/x', `${'/a'.repeat(400)}x/y`],
    ['/**/a/**/a/**/a/**/a/**/x', `${'/a'.repeat(1000)}x/y`],
    ['/*a*a*a*/y', `/${'a'.repeat(2000)}/z`],
  ])('excludePaths %s against a long path key', async (glob, path) => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: { [path]: { get: { operationId: 'p', responses: ok } } },
      },
      { validate: false },
    );
    const started = Date.now();
    const tools = await generator.generateTools({ excludePaths: [glob] });
    expect(Date.now() - started).toBeLessThan(500);
    expect(tools).toHaveLength(1);
  });

  it.each([
    ['/api/**', '/api/v1/users', true],
    ['/api/*', '/api/v1/users', false],
    ['/api/*/users', '/api/v1/users', true],
    ['/api/v?/users', '/api/v1/users', true],
    ['/api/v?/users', '/api/v12/users', false],
    ['/a**b', '/aX/Yb', true],
    ['/**', '/', true],
    ['/users/{id}', '/users/{id}', true],
    ['/users/(id)', '/users/id', false],
  ])('%s matching %s is %s', async (glob, path, matches) => {
    const generator = await OpenAPIToolGenerator.fromJSON(
      {
        openapi: '3.0.3',
        info: { title: 't', version: '1' },
        paths: { [path]: { get: { operationId: 'p', responses: ok } } },
      },
      { validate: false },
    );
    const tools = await generator.generateTools({ includePaths: [glob] });
    expect(tools.length === 1).toBe(matches);
  });
});

describe('blockedHosts compares addresses, not spellings', () => {
  const metadata = '169.254.169.254';

  it.each(['http://[::ffff:169.254.169.254]/x', 'http://[::ffff:a9fe:a9fe]/x', 'http://[64:ff9b::a9fe:a9fe]/x'])(
    'refuses %s when the address is blocked and internal addresses are allowed',
    async (url) => {
      const refusal = await refusalOf(url, ssrfOptions({ allowInternalIPs: true, blockedHosts: [metadata] }));
      expect(refusal?.context).toMatchObject({ reason: 'host-blocked' });
    },
  );

  it('refuses a name that resolves to a blocked address, and pins one that does not', async () => {
    const options = ssrfOptions({ allowInternalIPs: true, blockedHosts: [metadata] });
    const refusal = await refusalOf('http://meta.example.test/x', options, lookupTo(metadata));
    expect(refusal?.context).toMatchObject({ reason: 'host-blocked' });
    await expect(assertUrlSafe('http://ok.example.test/x', options, lookupTo('10.0.0.5'))).resolves.toEqual([
      { address: '10.0.0.5', family: 4 },
    ]);
  });

  it('refuses a name that resolves to a blocked public address under the default options', async () => {
    const options = ssrfOptions({ blockedHosts: ['93.184.216.34'] });
    const refusal = await refusalOf('http://site.example.test/x', options, lookupTo('93.184.216.34'));
    expect(refusal?.context).toMatchObject({ reason: 'host-blocked' });
    await expect(
      assertUrlSafe('http://other.example.test/x', options, lookupTo('93.184.216.35')),
    ).resolves.toHaveLength(1);
  });

  it('reports a blocked literal as host-blocked, not as an internal address', async () => {
    const refusal = await refusalOf('http://93.184.216.34/x', ssrfOptions({ blockedHosts: ['93.184.216.34'] }));
    expect(refusal?.context).toMatchObject({ reason: 'host-blocked' });
  });

  it.each(['http://xn--bcher-kva.example/x', 'http://bücher.example/x'])(
    'matches a Unicode entry for %s',
    async (url) => {
      const refusal = await refusalOf(url, ssrfOptions({ blockedHosts: ['bücher.example'] }));
      expect(refusal?.context).toMatchObject({ reason: 'host-blocked' });
    },
  );

  it('refuses an IPv4-mapped spelling in the synchronous $ref gate', () => {
    const options = ssrfOptions({ allowInternalIPs: true, blockedHosts: ['127.0.0.1'] });
    expect(isBlockedHostname('[::ffff:7f00:1]', options)).toBe(true);
    expect(isBlockedHostname('[::1]', options)).toBe(false);
  });

  it('compares an entry no URL can hold as written', () => {
    expect(hostListIncludes(['bad host'], 'bad host')).toBe(true);
    expect(hostListIncludes(['bad host'], 'bad')).toBe(false);
  });

  it('resolves no name when blockedHosts holds only names and internal addresses are allowed', async () => {
    const lookup = lookupTo(metadata);
    await expect(
      assertUrlSafe(
        'http://meta.example.test/x',
        ssrfOptions({ allowInternalIPs: true, blockedHosts: ['evil.example'] }),
        lookup,
      ),
    ).resolves.toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('a refused reference tells nothing about the host it runs on', () => {
  it('never names the internal address a host resolves to', async () => {
    const refusal = await refusalOf('http://db.corp.example/x', ssrfOptions({}), lookupTo('10.20.30.40'));
    expect(refusal?.context).toMatchObject({ reason: 'resolved-address' });
    expect(refusal?.message).not.toContain('10.20.30.40');
  });

  const documentReferencing = (ref: string) => ({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {
      '/p': {
        get: {
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } },
          },
        },
      },
    },
  });

  it.each(['http://localhost/x.json', 'other.json'])(
    'never names the working directory, for %s in a document without a base URI',
    async (ref) => {
      const generator = await OpenAPIToolGenerator.fromJSON(documentReferencing(ref));
      const failure = (await generator.generateTools().catch((error: unknown) => error)) as ParseError;
      expect(failure).toBeInstanceOf(ParseError);
      const validation = await generator.validate();
      for (const text of [failure.message, JSON.stringify(failure.context), validation.errors?.[0]?.message]) {
        expect(text).not.toContain(process.cwd());
      }
    },
  );

  it('names a root working directory as it is, since it tells nothing', async () => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/');
    try {
      const generator = await OpenAPIToolGenerator.fromJSON(documentReferencing('other.json'));
      const failure = (await generator.generateTools().catch((error: unknown) => error)) as ParseError;
      expect(failure.context).toMatchObject({ resolved: '/other.json' });
    } finally {
      cwd.mockRestore();
    }
  });

  it('shows a relative reference against the working directory by name', async () => {
    const generator = await OpenAPIToolGenerator.fromJSON(documentReferencing('other.json'));
    const failure = (await generator.generateTools().catch((error: unknown) => error)) as ParseError;
    expect(failure.context).toMatchObject({ resolved: '<working directory>/other.json' });
  });
});

describe('user information in a reference is never quoted', () => {
  const secrets = ['SECRETU', 'SECRETP', 'SECRET U', 'SECRET%20U', 'token=abc'];
  const documentUri = 'https://base.example/dir/doc.yaml';

  async function textsOf(ref: string, options: Record<string, unknown>): Promise<string[]> {
    const document = {
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {
        '/p': {
          get: {
            responses: {
              200: { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } },
            },
          },
        },
      },
    };
    const generator = await OpenAPIToolGenerator.fromJSON(document, options);
    const failure = (await generator.generateTools().catch((error: unknown) => error)) as ParseError;
    expect(failure).toBeInstanceOf(ParseError);
    const validation = await generator.validate();
    return [failure.message, JSON.stringify(failure.context), JSON.stringify(validation.errors)];
  }

  it.each([
    ['an authority written with backslashes', '\\\\SECRETU:SECRETP@other.example/x.yaml'],
    ['an authority after a slash and a backslash', '/\\SECRETU:SECRETP@other.example/x.yaml'],
    ['user information moved into a path, percent-encoded', 'https:SECRET U:SECRET P@h/x'],
    ['a query', 'https://h.example/x.json?token=abc'],
  ])('%s', async (_label, ref) => {
    const texts = await textsOf(ref, { documentUri, refResolution: { allowedHosts: ['nothing.example'] } });
    for (const text of texts) for (const secret of secrets) expect(text).not.toContain(secret);
  });

  describe('in the URL of a referenced document', () => {
    let handler: LoopbackHandler;
    const loopback = createLoopbackServer(() => handler);
    let baseUrl: string;

    beforeAll(async () => {
      baseUrl = await loopback.listen();
    });

    afterAll(async () => {
      await loopback.close();
    });

    it('is not quoted as the base of a reference that document holds', async () => {
      handler = (req, res) => {
        if (req.url === '/a.json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'object', properties: { b: { $ref: 'b.json' } } }));
        } else {
          res.writeHead(404);
          res.end();
        }
      };
      const ref = baseUrl.replace('http://', 'http://SECRETU:SECRETP@') + '/a.json';
      const texts = await textsOf(ref, { refResolution: { allowInternalIPs: true } });
      expect(texts[1]).toContain('"rule":"response"');
      for (const text of texts) for (const secret of secrets) expect(text).not.toContain(secret);
    });
  });
});
