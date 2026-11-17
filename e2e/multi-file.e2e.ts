/**
 * Multi-file story: one API described over several files (e2e/fixtures/
 * supplementary/multi-file, listed in the README there) is loaded the four
 * ways a document gets into the library, and what its relative `$ref`s are
 * read against is its retrieval URI (OpenAPI 3.2 "Establishing the Base URI"):
 * the file for `fromFile`, the final URL after redirects for `fromURL`, and
 * `LoadOptions.documentUri` for `fromJSON` / `fromYAML`. `$self` (OpenAPI 3.2
 * and later) names the document, so a `$ref` to it stays local, but it never
 * moves where the document's references are read from: only a document with
 * no retrieval URI at all (`fromJSON` / `fromYAML` without `documentUri`) is
 * read against an absolute `$self`.
 *
 * The tree has a root document in each of 3.0, 3.1 and 3.2, and files in
 * subfolders: path items, parameters, schemas and responses, a reference from
 * a file two folders down back up to a shared one, a cycle between two schema
 * files, and files reached from several places. The tools, and the facts that
 * prove a file was actually read (a pattern two files away, a limit in a
 * parameter file, the cycle cut), are written below from the fixture files, not
 * from what the library prints.
 *
 * What each part shows, with real files, a real loopback HTTP server and its
 * record of every request:
 *
 * - from disk: every tool generates and `validate()` passes whatever the
 *   process working directory is, and the working directory is only used when
 *   the document has no base URI (`fromJSON` without `documentUri`); the
 *   default options refuse the files: generation throws a `ParseError` that
 *   names the `file` protocol and the option that allows it, `validate()`
 *   returns an `UNREADABLE_REFERENCE` error with the same message, and nothing
 *   else is read; a `$self` that is a network URL does not send a file's
 *   references to the network;
 * - over HTTP: each file is requested once, from the origin of the spec URL;
 *   the headers and credentials given for the spec are not sent on `$ref`
 *   requests; after redirects, even to another origin, references are read
 *   against the final URL; a mirror whose `$self` names another origin still
 *   serves its own references; `documentUri` gives the same tools;
 * - an unreadable reference names the first one in document order and the
 *   rule that refused it (`context.rule`), whatever the order the files or the
 *   network answer in;
 * - a `$ref` to the document's own URI is resolved locally, without a request,
 *   also under `secureDefaults`: its fragment is percent-decoded, a target
 *   that does not exist is a `missing-target` error and `$ref: ""` is the
 *   whole document; a reference to another document is not read;
 * - `$self` in a form that is refused or invalid is ignored with a diagnostic
 *   (or, when invalid, rejected by the validator) and never changes where
 *   anything is fetched or read from; the URIs of a document (`$self`,
 *   `documentUri`, the retrieval URI) are capped at 2,048 characters, and a
 *   bad `documentUri` is reported before any request;
 * - a Security Requirement that names a scheme of this document by URI
 *   resolves to it; one that names another document is not resolved, and
 *   nothing is fetched for it;
 * - an Arazzo document gets a multi-file source as a generator loaded with its
 *   own `documentUri`; one `documentUri` shared by every source is refused.
 *
 * Everything stays on 127.0.0.1 (and `.invalid` names that are never
 * resolved or fetched): the story contacts no external host.
 */
import { cpSync, mkdtempSync, promises as fsPromises, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, sep } from 'path';
import { pathToFileURL } from 'url';
import * as yaml from 'yaml';
import { ArazzoError, LoadError, OpenAPIToolGenerator, ParseError, fromArazzo } from '../src';
import type { ArazzoDocument, FromArazzoOptions, LoadOptions, McpOpenAPITool } from '../src';
import { createLoopbackServer, type LoopbackHandler } from '../src/__tests__/helpers/loopback';
import { fixturePath } from './helpers/fixtures';
import { validateOasDocument, type OasVersion } from './helpers/oas-validate';

const TREE = fixturePath('supplementary/multi-file');

const ROOTS: Array<{ version: OasVersion; root: string }> = [
  { version: '3.0', root: 'openapi-3.0.yaml' },
  { version: '3.1', root: 'openapi-3.1.yaml' },
  { version: '3.2', root: 'openapi-3.2.yaml' },
];
const ROOT_32 = 'openapi-3.2.yaml';

/** The files every root references, relative to the tree, written out from the fixture. */
const SIBLINGS = [
  'parameters/OwnerId.yaml',
  'parameters/PetId.yaml',
  'parameters/paging/Limit.yaml',
  'paths/owners/owner.yaml',
  'paths/pets-by-id.yaml',
  'paths/pets.yaml',
  'responses/NotFound.yaml',
  'responses/PetList.yaml',
  'responses/Problem.yaml',
  'schemas/Error.yaml',
  'schemas/Id.yaml',
  'schemas/NewPet.yaml',
  'schemas/Owner.yaml',
  'schemas/Pet.yaml',
];

/** What every root declares under `paths`, in generation order: paths sorted, then the methods. */
const TOOLS: Array<[name: string, method: string, path: string]> = [
  ['getOwner', 'get', '/owners/{ownerId}'],
  ['listPets', 'get', '/pets'],
  ['createPet', 'post', '/pets'],
  ['getPet', 'get', '/pets/{petId}'],
];

/** `schemas/Id.yaml`, reached by a parameter file and by several schema files. */
const ID_PATTERN = '^[a-z0-9-]{1,32}$';

/** Allow the file resolver, and only it. */
const FILES: LoadOptions = { refResolution: { allowedProtocols: ['file'] } };
/** Loopback is an internal address, blocked unless allowed. */
const LOOPBACK: LoadOptions = { refResolution: { allowInternalIPs: true } };

// ---------------------------------------------------------------------------
// The tree and what a tool holds
// ---------------------------------------------------------------------------

const listFiles = (directory: string, prefix = ''): string[] =>
  readdirSync(join(directory, prefix), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory() ? listFiles(directory, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    )
    .sort();

const readTree = (file: string): string => readFileSync(join(TREE, file), 'utf8');
const parseTree = (file: string): Record<string, unknown> => yaml.parse(readTree(file)) as Record<string, unknown>;

/** A value `path` deep in `value`; `undefined` where there is none. */
const at = (value: unknown, ...path: Array<string | number>): unknown =>
  path.reduce<unknown>(
    (node, key) => (node !== null && typeof node === 'object' ? (node as Record<string | number, unknown>)[key] : undefined),
    value,
  );

/**
 * The tools of the tree, and facts that only hold when the files that carry
 * them were read: each comment names the file the fact is written in.
 */
function expectTheTools(tools: McpOpenAPITool[]): void {
  expect(tools.map((tool) => [tool.name, tool.metadata.method, tool.metadata.path])).toEqual(TOOLS);
  const [getOwner, listPets, createPet, getPet] = tools;

  // parameters/paging/Limit.yaml, from paths/pets.yaml
  expect(at(listPets.inputSchema, 'properties', 'limit', 'maximum')).toBe(100);
  // parameters/PetId.yaml (path-level, from paths/pets-by-id.yaml) -> schemas/Id.yaml
  expect(at(getPet.inputSchema, 'properties', 'petId', 'pattern')).toBe(ID_PATTERN);
  expect(at(getPet.inputSchema, 'required')).toEqual(['petId']);
  // parameters/OwnerId.yaml, from paths/owners/owner.yaml (two folders down, so reached by `../../`)
  expect(at(getOwner.inputSchema, 'properties', 'ownerId', 'pattern')).toBe(ID_PATTERN);
  // schemas/NewPet.yaml -> schemas/Id.yaml
  expect(at(createPet.inputSchema, 'required')).toEqual(['name']);
  expect(at(createPet.inputSchema, 'properties', 'ownerId', 'pattern')).toBe(ID_PATTERN);

  // responses/NotFound.yaml -> schemas/Error.yaml, reached from two path items by two spellings of one file
  const notFound = at(getPet.outputSchema, 'oneOf', 1);
  expect(at(notFound, 'required')).toEqual(['code', 'message']);
  expect(at(getOwner.outputSchema, 'oneOf', 1)).toEqual(notFound);
  // responses/PetList.yaml -> schemas/Pet.yaml
  expect(at(listPets.outputSchema, 'maxItems')).toBe(100);
  expect(at(listPets.outputSchema, 'items', 'properties', 'name')).toEqual({ type: 'string' });

  // schemas/Pet.yaml <-> schemas/Owner.yaml: each file's contents are there once, and the loop ends there
  expect(at(getPet.outputSchema, 'oneOf', 0, 'properties', 'owner', 'properties', 'pets', 'maxItems')).toBe(50);
  expect(at(getPet.outputSchema, 'oneOf', 0, 'properties', 'owner', 'properties', 'pets', 'items', 'properties')).toBeUndefined();
  expect(at(getOwner.outputSchema, 'oneOf', 0, 'properties', 'pets', 'items', 'properties', 'name')).toEqual({ type: 'string' });
  expect(at(getOwner.outputSchema, 'oneOf', 0, 'properties', 'pets', 'items', 'properties', 'owner', 'properties')).toBeUndefined();
  // a tool is plain JSON: nothing of the cycle is left in the object graph
  expect(() => JSON.stringify(tools)).not.toThrow();
}

// ---------------------------------------------------------------------------
// Process state: the working directory, and the files read
// ---------------------------------------------------------------------------

/** Runs `run` with the working directory set to `directory`, and restores it whatever happens. */
async function inDirectory<T>(directory: string, run: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  try {
    process.chdir(directory);
    return await run();
  } finally {
    process.chdir(before);
  }
}

/** Runs `run` in a new empty temporary directory, which is removed (by its exact path) afterwards. */
async function inEmptyDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'multi-file-story-'));
  try {
    return await inDirectory(directory, () => run(directory));
  } finally {
    rmSync(directory, { recursive: true });
  }
}

/**
 * The files of the tree that were opened (relative, with `/`), recorded by
 * wrapping `fs.promises.readFile`, which the library and its reference parser
 * read files with. Anything outside the tree is not recorded.
 */
const treeReads: string[] = [];
const realReadFile = fsPromises.readFile;
const recordReads = (): void => {
  Object.defineProperty(fsPromises, 'readFile', {
    configurable: true,
    writable: true,
    value: function recordedReadFile(path: unknown, ...rest: unknown[]) {
      if (typeof path === 'string' && path.startsWith(TREE + sep)) treeReads.push(relative(TREE, path).split(sep).join('/'));
      return Reflect.apply(realReadFile, fsPromises, [path, ...rest]);
    },
  });
};
const stopRecordingReads = (): void => {
  Object.defineProperty(fsPromises, 'readFile', { configurable: true, writable: true, value: realReadFile });
};

// ---------------------------------------------------------------------------
// The loopback servers
// ---------------------------------------------------------------------------

/** The tree served under `prefix`; `overrides` replaces the body of a file (by its path in the tree). */
interface Mount {
  prefix: string;
  overrides: Record<string, string>;
}
const mounts: Mount[] = [];
const redirects = new Map<string, string>();
/** Milliseconds to wait before answering a path. */
const delays = new Map<string, number>();
const mount = (prefix: string, overrides: Record<string, string> = {}): void => {
  mounts.push({ prefix, overrides });
};

const TREE_FILES = [...ROOTS.map(({ root }) => root), ...SIBLINGS];

const serveTree: LoopbackHandler = (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://loopback.invalid').pathname;
  const location = redirects.get(pathname);
  if (location !== undefined) {
    res.writeHead(302, { location });
    res.end();
    return;
  }
  for (const { prefix, overrides } of mounts) {
    if (!pathname.startsWith(prefix)) continue;
    const file = pathname.slice(prefix.length);
    // Only files of the tree are ever served, by an exact match: nothing is joined onto a path from the request
    const body = overrides[file] ?? (TREE_FILES.includes(file) ? readTree(file) : undefined);
    if (body !== undefined) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/yaml' });
        res.end(body);
      }, delays.get(pathname) ?? 0);
      return;
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('no such file');
};

/** Where a redirecting server sends every request. */
let redirectTarget = '';
const server = createLoopbackServer(() => serveTree);
const elsewhere = createLoopbackServer(() => (_req, res) => {
  res.writeHead(302, { location: redirectTarget });
  res.end();
});

/** What `server` received, as the request paths sorted. */
const requested = (): string[] => server.requests.map((request) => request.url).sort();
/** The files of the tree under a path prefix, sorted: what a complete read of them requests. */
const under = (prefix: string, files: string[]): string[] => files.map((file) => `${prefix}${file}`).sort();

/** The root of the tree with `$self` set to `self`, as a JSON text (a YAML document too). */
const rootWithSelf = (self: unknown, root = ROOT_32): string => JSON.stringify({ ...parseTree(root), $self: self });

const failureOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure, but nothing failed');
};

const codes = (generator: OpenAPIToolGenerator): string[] => generator.getDiagnostics().map(({ code }) => code);

/** The `ParseError` generation throws for a reference it cannot read, as data. */
const parseError = async (generator: OpenAPIToolGenerator): Promise<ParseError> => {
  const error = await failureOf(() => generator.generateTools());
  expect(error).toBeInstanceOf(ParseError);
  return error as ParseError;
};

/** What `validate()` returns for the same reference: no throw, the error of the same message and place. */
async function expectUnreadableReference(generator: OpenAPIToolGenerator, error: ParseError): Promise<void> {
  const validation = await generator.validate();
  expect(validation.valid).toBe(false);
  expect(validation.errors).toEqual([
    {
      code: 'UNREADABLE_REFERENCE',
      message: error.message.replace(/^Failed to dereference OpenAPI document: /, ''),
      ...(typeof error.context?.['path'] === 'string' ? { path: error.context['path'] } : {}),
    },
  ]);
}

/** A URL of exactly `length` characters: `base` with a query of `s`s as long as that takes. */
const urlOfLength = (base: string, length: number): string => `${base}?sig=${'s'.repeat(length - base.length - '?sig='.length)}`;

// ---------------------------------------------------------------------------
// The story
// ---------------------------------------------------------------------------

describe('story: an API described over several files', () => {
  let origin: string;
  let otherOrigin: string;
  /**
   * The 3.2 tree read from disk: what every other way of loading it must
   * produce. Read once, before the tests, so that what a test records is its
   * own; a failure to read it fails the tests that compare with it, not the rest.
   */
  let referenceRun: Promise<McpOpenAPITool[]>;
  const referenceTools = (): Promise<McpOpenAPITool[]> => referenceRun;

  beforeAll(async () => {
    origin = await server.listen();
    otherOrigin = await elsewhere.listen();
    recordReads();
    referenceRun = OpenAPIToolGenerator.fromFile(join(TREE, ROOT_32), FILES).then((generator) => generator.generateTools());
    await referenceRun.catch(() => undefined);
  });

  afterAll(async () => {
    stopRecordingReads();
    await server.close();
    await elsewhere.close();
  });

  beforeEach(() => {
    treeReads.length = 0;
  });

  afterEach(() => {
    server.reset();
    elsewhere.reset();
    mounts.length = 0;
    redirects.clear();
    delays.clear();
  });

  describe('the fixture', () => {
    it('holds the pinned set of files', () => {
      expect(listFiles(TREE)).toEqual([...TREE_FILES].sort());
    });

    it('reads the same tools from disk as the documents declare', async () => {
      expectTheTools(await referenceTools());
    });

    it.each(ROOTS)('has a $version root that is valid by the official schema, with its references unresolved', ({ version, root }) => {
      const document = parseTree(root);
      expect(validateOasDocument(version, document)).toEqual({ valid: true, errors: [] });
      expect(Object.values(at(document, 'paths') as Record<string, { $ref: string }>).map((item) => item.$ref)).toEqual([
        './paths/pets.yaml',
        './paths/pets-by-id.yaml',
        './paths/owners/owner.yaml',
      ]);
    });
  });

  describe('read from disk (fromFile)', () => {
    it.each(ROOTS)('generates every tool of the $version variant, and validates, from any working directory', async ({ root }) => {
      await inEmptyDirectory(async (directory) => {
        const generator = await OpenAPIToolGenerator.fromFile(join(TREE, root), FILES);
        expect(process.cwd()).not.toBe(TREE);
        expect(process.cwd()).toBe(realpathSync(directory));

        // `validate()` reads the files first (it validates the document as generation reads it) ...
        const validation = await generator.validate();
        expect(validation.valid).toBe(true);
        expect(validation.errors).toBeUndefined();
        const readByValidation = [...treeReads].sort();
        expect(readByValidation).toEqual([root, ...SIBLINGS].sort());

        // ... and generation reuses what it read
        expectTheTools(await generator.generateTools());
        expect([...treeReads].sort()).toEqual(readByValidation);
      });
    });

    it('resolves next to the file, with the same tools as every other way of loading it', async () => {
      await inEmptyDirectory(async () => {
        const generator = await OpenAPIToolGenerator.fromFile(join(TREE, ROOT_32), FILES);
        expect(await generator.generateTools()).toEqual(await referenceTools());
      });
    });

    it('resolves a relative path of the file against the working directory, and its references next to it', async () => {
      await inDirectory(join(TREE, 'paths'), async () => {
        const generator = await OpenAPIToolGenerator.fromFile(`../${ROOT_32}`, FILES);
        expectTheTools(await generator.generateTools());
      });
    });

    it('resolves the references of a document given to fromJSON against the working directory, as before', async () => {
      // No retrieval URI: a relative reference has nothing but the working directory to resolve against
      await inDirectory(TREE, async () => {
        const generator = await OpenAPIToolGenerator.fromJSON(parseTree(ROOT_32), FILES);
        expectTheTools(await generator.generateTools());
      });

      await inEmptyDirectory(async () => {
        const generator = await OpenAPIToolGenerator.fromJSON(parseTree(ROOT_32), FILES);
        const error = await failureOf(() => generator.generateTools());
        expect(error).toBeInstanceOf(ParseError);
        const { message, context } = error as ParseError;
        // the first reference in document order, looked for under the working directory
        expect(context).toMatchObject({
          rule: 'file-error',
          reference: './paths/pets.yaml',
          resolved: join(process.cwd(), 'paths', 'pets.yaml'),
          path: '/paths/~1pets',
        });
        expect(message).toContain('the file cannot be read (ENOENT)');
        // and it says why there is nowhere else to look
        expect(message).toContain('the document has no base URI');
      });
    });

    it('resolves the references of a fromYAML document next to the file its documentUri names, from any directory', async () => {
      await inEmptyDirectory(async () => {
        const documentUri = pathToFileURL(join(TREE, ROOT_32)).href;
        const generator = await OpenAPIToolGenerator.fromYAML(readTree(ROOT_32), { ...FILES, documentUri });
        expect(await generator.generateTools()).toEqual(await referenceTools());
        expect([...treeReads].sort()).toEqual([...SIBLINGS].sort());
      });
    });

    it('refuses the files by default, naming the file protocol and the option that allows it, and reads nothing else', async () => {
      await inEmptyDirectory(async () => {
        const generator = await OpenAPIToolGenerator.fromFile(join(TREE, ROOT_32));
        expect(treeReads).toEqual([ROOT_32]);

        // generation throws, and the first reference in document order is the one it names
        const error = await failureOf(() => generator.generateTools());
        expect(error).toBeInstanceOf(ParseError);
        const { message, context } = error as ParseError;
        expect(message).toContain('it is read as a local file');
        expect(message).toContain('does not include "file"');
        expect(message).toContain('add "file" to refResolution.allowedProtocols to read it');
        // the reference, what it was resolved against and to, where it is, and the rule, as data
        expect(context).toEqual({
          rule: 'protocol',
          reference: './paths/pets.yaml',
          base: join(TREE, ROOT_32),
          resolved: join(TREE, 'paths', 'pets.yaml'),
          path: '/paths/~1pets',
        });

        // validate() does not throw: it returns the same finding as a validation error
        const validation = await generator.validate();
        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual([
          {
            code: 'UNREADABLE_REFERENCE',
            message: message.replace(/^Failed to dereference OpenAPI document: /, ''),
            path: '/paths/~1pets',
          },
        ]);
        // the root, read by fromFile; no file of the tree was opened for a reference
        expect(treeReads).toEqual([ROOT_32]);
      });
    });

    it('does not send the references of a file to the network when its $self is a URL', async () => {
      // A copy of the tree with a root whose $self is on the loopback server, which serves the tree: a reference
      // read from $self would be answered, and recorded
      mount('/canonical/');
      const directory = mkdtempSync(join(tmpdir(), 'multi-file-story-'));
      try {
        cpSync(TREE, directory, { recursive: true });
        writeFileSync(join(directory, ROOT_32), rootWithSelf(`${origin}/canonical/${ROOT_32}`));

        const generator = await OpenAPIToolGenerator.fromFile(join(directory, ROOT_32), {
          refResolution: { allowedProtocols: ['file', 'http', 'https'], allowInternalIPs: true },
        });
        expect(await generator.generateTools()).toEqual(await referenceTools());
        expect(codes(generator)).toEqual([]);
        expect(server.requests).toEqual([]);
      } finally {
        rmSync(directory, { recursive: true });
      }
    });
  });

  describe('served over HTTP (fromURL)', () => {
    it.each(ROOTS)('requests each file of the $version variant once, from the origin of the spec URL', async ({ root }) => {
      mount('/spec/');
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/spec/${root}`, LOOPBACK);

      expect(await generator.validate()).toMatchObject({ valid: true });
      expect(requested()).toEqual(under('/spec/', [root, ...SIBLINGS]));
      expect(server.requests.every((request) => request.method === 'GET')).toBe(true);

      expectTheTools(await generator.generateTools());
      // generation reused what validation fetched
      expect(requested()).toEqual(under('/spec/', [root, ...SIBLINGS]));
      expect(treeReads).toEqual([]);
    });

    it('resolves a nested file against the file that holds the reference, not against the spec', async () => {
      mount('/a/b/');
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/a/b/${ROOT_32}`, LOOPBACK);
      expect(await generator.generateTools()).toEqual(await referenceTools());
      // paths/owners/owner.yaml reaches ../../responses/NotFound.yaml: under /a/b/, not under /a/ or /
      expect(requested()).toEqual(under('/a/b/', [ROOT_32, ...SIBLINGS]));
    });

    it('does not send the headers given for the spec on the requests for its references', async () => {
      mount('/spec/');
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/spec/${ROOT_32}`, {
        ...LOOPBACK,
        headers: { Authorization: 'Bearer spec-token', 'X-Spec-Token': 'spec-only' },
      });
      await generator.generateTools();

      const [specRequest, ...referenceRequests] = server.requests;
      expect(specRequest.url).toBe(`/spec/${ROOT_32}`);
      expect(specRequest.headers['authorization']).toBe('Bearer spec-token');
      expect(specRequest.headers['x-spec-token']).toBe('spec-only');
      expect(referenceRequests).toHaveLength(SIBLINGS.length);
      for (const request of referenceRequests) {
        expect(request.headers['authorization']).toBeUndefined();
        expect(request.headers['x-spec-token']).toBeUndefined();
        expect(request.headers['cookie']).toBeUndefined();
      }
    });

    it('does not carry credentials written in the spec URL into the requests for its references', async () => {
      mount('/spec/');
      const withCredentials = origin.replace('http://', 'http://reader:s3cret@');
      const generator = await OpenAPIToolGenerator.fromURL(`${withCredentials}/spec/${ROOT_32}`, LOOPBACK);
      expect(await generator.generateTools()).toEqual(await referenceTools());

      expect(requested()).toEqual(under('/spec/', [ROOT_32, ...SIBLINGS]));
      // the spec itself is requested with them (HTTP Basic), its references are not
      const [specRequest, ...referenceRequests] = server.requests;
      expect(specRequest.headers['authorization']).toBe(`Basic ${Buffer.from('reader:s3cret').toString('base64')}`);
      expect(referenceRequests).toHaveLength(SIBLINGS.length);
      for (const request of referenceRequests) {
        expect(request.headers['authorization']).toBeUndefined();
      }
    });

    it('resolves references against the final URL after redirects', async () => {
      mount('/releases/1.0/');
      redirects.set('/latest/openapi.yaml', '/stable/openapi.yaml');
      redirects.set('/stable/openapi.yaml', `/releases/1.0/${ROOT_32}`);

      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/latest/openapi.yaml`, LOOPBACK);
      expect(await generator.generateTools()).toEqual(await referenceTools());

      // two redirect hops, then the file, then its references next to the file: nothing next to the URL that was asked for
      expect(server.requests.slice(0, 3).map((request) => request.url)).toEqual([
        '/latest/openapi.yaml',
        '/stable/openapi.yaml',
        `/releases/1.0/${ROOT_32}`,
      ]);
      expect(requested()).toEqual(
        [...under('/releases/1.0/', [ROOT_32, ...SIBLINGS]), '/latest/openapi.yaml', '/stable/openapi.yaml'].sort(),
      );
    });

    it('resolves references against the final origin when a redirect leaves the origin, without the spec headers', async () => {
      mount('/spec/');
      redirectTarget = `${origin}/spec/${ROOT_32}`;

      const generator = await OpenAPIToolGenerator.fromURL(`${otherOrigin}/moved/openapi.yaml`, {
        ...LOOPBACK,
        headers: { Authorization: 'Bearer spec-token' },
      });
      expect(await generator.generateTools()).toEqual(await referenceTools());

      // the first server saw the request for the spec, with its headers, and nothing else
      expect(elsewhere.requests.map((request) => [request.url, request.headers['authorization']])).toEqual([
        ['/moved/openapi.yaml', 'Bearer spec-token'],
      ]);
      // the second saw the redirected request and the references, none with the header
      expect(requested()).toEqual(under('/spec/', [ROOT_32, ...SIBLINGS]));
      for (const request of server.requests) expect(request.headers['authorization']).toBeUndefined();
    });

    it('reads the references of a URL at the limit, and refuses the relative ones of a URL past it', async () => {
      mount('/releases/1.0/');
      const final = `${origin}/releases/1.0/${ROOT_32}`;

      // 2,048 characters is the longest retrieval URI that is used
      redirects.set('/start', urlOfLength(final, 2048).slice(origin.length));
      const atLimit = await OpenAPIToolGenerator.fromURL(`${origin}/start`, LOOPBACK);
      expect(codes(atLimit)).toEqual([]);
      expect(await atLimit.generateTools()).toEqual(await referenceTools());

      // one more and it is not used: the relative references are refused, never read from anywhere else
      server.reset();
      const target = urlOfLength(final, 2049).slice(origin.length);
      redirects.set('/start', target);
      const past = await OpenAPIToolGenerator.fromURL(`${origin}/start`, LOOPBACK);
      expect(codes(past)).toEqual(['BASE_URI_TOO_LONG']);
      const error = await parseError(past);
      expect(error.context).toMatchObject({ rule: 'base-too-long', reference: './paths/pets.yaml', path: '/paths/~1pets' });
      expect(error.message).toContain('BASE_URI_TOO_LONG');
      await expectUnreadableReference(past, error);
      // the spec was fetched (through the redirect); no reference was
      expect(requested()).toEqual(['/start', target].sort());
    });
  });

  describe('a document with a documentUri (fromJSON)', () => {
    it('resolves its references against the documentUri, with the same tools as when fetched from there', async () => {
      mount('/spec/');
      const generator = await OpenAPIToolGenerator.fromJSON(parseTree(ROOT_32), {
        ...LOOPBACK,
        documentUri: `${origin}/spec/${ROOT_32}`,
      });
      expect(await generator.generateTools()).toEqual(await referenceTools());

      // the document itself was given: only its references were requested
      expect(requested()).toEqual(under('/spec/', SIBLINGS));
      expect(codes(generator)).toEqual([]);
    });

    it('does not use the document URI for anything but references: servers stay as declared', async () => {
      mount('/spec/');
      const generator = await OpenAPIToolGenerator.fromJSON(parseTree(ROOT_32), {
        ...LOOPBACK,
        documentUri: `${origin}/spec/${ROOT_32}`,
      });
      const tools = await generator.generateTools();
      expect(tools.every((tool) => tool.metadata.servers?.[0]?.url === 'https://api.example.com/v1')).toBe(true);
    });

    const BAD_DOCUMENT_URIS: Array<[what: string, documentUri: unknown]> = [
      ['user information', `http://reader:s3cret@127.0.0.1/${ROOT_32}`],
      ['a fragment', `http://127.0.0.1/${ROOT_32}#/paths`],
      ['a relative reference', `spec/${ROOT_32}`],
      ['a scheme that is no document source', `ftp://127.0.0.1/${ROOT_32}`],
      ['a file URI that names a host', `file://fileserver.invalid/specs/${ROOT_32}`],
      ['2,049 characters', `http://127.0.0.1/${'a'.repeat(2049 - 'http://127.0.0.1/'.length)}`],
      ['not a string', 42],
    ];

    it.each(BAD_DOCUMENT_URIS)(
      'rejects a documentUri with %s from every factory, before anything is requested or read',
      async (_what, documentUri) => {
        mount('/spec/');
        const options: LoadOptions = { ...LOOPBACK, documentUri: documentUri as string };
        const loads = [
          () => OpenAPIToolGenerator.fromJSON(parseTree(ROOT_32), options),
          () => OpenAPIToolGenerator.fromYAML(readTree(ROOT_32), options),
          () => OpenAPIToolGenerator.fromURL(`${origin}/spec/${ROOT_32}`, options),
          () => OpenAPIToolGenerator.fromFile(join(TREE, ROOT_32), options),
        ];
        for (const load of loads) {
          const error = await failureOf(load);
          expect(error).toBeInstanceOf(LoadError);
          expect((error as LoadError).message).toContain('LoadOptions.documentUri');
        }
        // not the spec, and not a file
        expect(server.requests).toEqual([]);
        expect(treeReads).toEqual([]);
      },
    );

    it('never repeats the user information of a documentUri, in the message or in the context', async () => {
      const documentUri = `http://reader:s3cret@127.0.0.1/${ROOT_32}`;
      for (const load of [
        () => OpenAPIToolGenerator.fromJSON(parseTree(ROOT_32), { documentUri }),
        () => OpenAPIToolGenerator.fromURL(`${origin}/spec/${ROOT_32}`, { ...LOOPBACK, documentUri }),
        () => OpenAPIToolGenerator.fromFile(join(TREE, ROOT_32), { documentUri }),
      ]) {
        const error = (await failureOf(load)) as LoadError;
        expect(error.message).toContain('must not contain user information');
        const shown = `${error.message}\n${JSON.stringify(error.context)}`;
        expect(shown).not.toContain('s3cret');
        expect(shown).not.toContain('reader');
      }
    });

    it('takes a documentUri of 2,048 characters', async () => {
      const documentUri = `http://127.0.0.1/${'a'.repeat(2048 - 'http://127.0.0.1/'.length)}`;
      expect(documentUri).toHaveLength(2048);
      const generator = await OpenAPIToolGenerator.fromJSON(
        { openapi: '3.1.0', info: { title: 'Ping', version: '1.0.0' }, paths: {} },
        { documentUri },
      );
      expect(codes(generator)).toEqual([]);
    });
  });

  describe('a reference to the document itself', () => {
    /** A document whose only operation reads its schemas through `$ref`s written as `spellings`. */
    const referencing = (openapi: string, spellings: string[], extra: Record<string, unknown> = {}) => ({
      openapi,
      info: { title: 'Self-referencing API', version: '1.0.0' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            responses: {
              '200': {
                description: 'The pets',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: Object.fromEntries(spellings.map((spelling, index) => [`pet${index}`, { $ref: spelling }])),
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: { Pet: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } },
      ...extra,
    });

    const expectLocal = (tools: McpOpenAPITool[], count: number): void => {
      expect(tools.map((tool) => tool.name)).toEqual(['listPets']);
      for (let index = 0; index < count; index++) {
        expect(at(tools[0].outputSchema, 'properties', `pet${index}`)).toEqual({
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        });
      }
    };

    it('is resolved locally, in every spelling of the URI, under secureDefaults, with no request', async () => {
      const own = `${origin}/spec/openapi.yaml`;
      const spellings = [
        `${own}#/components/schemas/Pet`,
        `${origin}/spec/./nested/../openapi.yaml#/components/schemas/Pet`,
        `${origin.toUpperCase()}/spec/openapi.yaml#/components/schemas/Pet`,
        `./openapi.yaml#/components/schemas/Pet`,
        `../spec/openapi.yaml#/components/schemas/Pet`,
      ];
      const generator = await OpenAPIToolGenerator.fromJSON(referencing('3.1.0', spellings), {
        secureDefaults: true,
        documentUri: own,
      });
      expectLocal(await generator.generateTools(), spellings.length);
      expect(server.requests).toEqual([]);
    });

    it('is resolved locally with the default options too, instead of fetching the document it is in', async () => {
      const own = `${origin}/spec/openapi.yaml`;
      mount('/spec/', { 'openapi.yaml': 'openapi: 3.1.0' });
      const generator = await OpenAPIToolGenerator.fromJSON(referencing('3.1.0', [`${own}#/components/schemas/Pet`]), {
        ...LOOPBACK,
        documentUri: own,
      });
      expectLocal(await generator.generateTools(), 1);
      expect(server.requests).toEqual([]);
    });

    it('makes one request, for the spec itself, when the document is fetched under secureDefaults', async () => {
      const own = `${origin}/spec/openapi.yaml`;
      mount('/spec/', { 'openapi.yaml': JSON.stringify(referencing('3.1.0', [`${own}#/components/schemas/Pet`])) });
      const generator = await OpenAPIToolGenerator.fromURL(own, { secureDefaults: true, ...LOOPBACK });
      expectLocal(await generator.generateTools(), 1);
      expect(requested()).toEqual(['/spec/openapi.yaml']);
    });

    it('is resolved locally through $self (OpenAPI 3.2), under secureDefaults, with no request', async () => {
      const self = `${origin}/canonical/pets/openapi.yaml`;
      const generator = await OpenAPIToolGenerator.fromJSON(
        referencing('3.2.0', [`${self}#/components/schemas/Pet`, `openapi.yaml#/components/schemas/Pet`], { $self: self }),
        { secureDefaults: true },
      );
      expectLocal(await generator.generateTools(), 2);
      expect(server.requests).toEqual([]);
      expect(codes(generator)).toEqual([]);
    });

    it('is resolved locally through the retrieval URI as well when the document has a $self', async () => {
      const self = `${origin}/canonical/pets/openapi.yaml`;
      const retrieval = `${origin}/mirror/openapi.yaml`;
      const generator = await OpenAPIToolGenerator.fromJSON(
        referencing('3.2.0', [`${self}#/components/schemas/Pet`, `${retrieval}#/components/schemas/Pet`], { $self: self }),
        { secureDefaults: true, documentUri: retrieval },
      );
      expectLocal(await generator.generateTools(), 2);
      expect(server.requests).toEqual([]);
    });

    it('leaves a reference to another document unread under secureDefaults, without a request', async () => {
      const own = `${origin}/spec/openapi.yaml`;
      const other = `${origin}/spec/other.yaml#/components/schemas/Pet`;
      mount('/spec/');
      const generator = await OpenAPIToolGenerator.fromJSON(referencing('3.1.0', [`${own}#/components/schemas/Pet`, other]), {
        secureDefaults: true,
        documentUri: own,
      });
      const [tool] = await generator.generateTools();
      expect(at(tool.outputSchema, 'properties', 'pet0', 'type')).toBe('object');
      expect(at(tool.outputSchema, 'properties', 'pet1')).toEqual({ $ref: other });
      expect(server.requests).toEqual([]);
    });

    describe.each([
      ['the default options', LOOPBACK],
      ['secureDefaults', { secureDefaults: true }],
    ] as Array<[string, LoadOptions]>)('under %s', (_posture, posture) => {
      const own = (): string => `${origin}/spec/openapi.yaml`;
      /** `referencing` with schemas whose names need decoding, each marked by its title. */
      const named = (ref: string, extra: Record<string, unknown> = {}) => {
        const document = referencing('3.1.0', [ref], extra);
        Object.assign(document.components.schemas, {
          'A B': { type: 'object', title: 'with a space' },
          '50%': { type: 'object', title: 'with a percent' },
          'a/b': { type: 'object', title: 'with a slash' },
          'ü': { type: 'object', title: 'not ASCII' },
        });
        return document;
      };

      it.each([
        ['#/components/schemas/A%20B', 'with a space'],
        ['#/components/schemas/50%25', 'with a percent'],
        ['#/components/schemas/a~1b', 'with a slash'],
        ['#/components/schemas/a%7E1b', 'with a slash'],
        ['#/components/schemas/%C3%BC', 'not ASCII'],
        ['#/components/%73chemas/A%20B', 'with a space'],
      ])('decodes the fragment of a reference to the document: %s', async (fragment, title) => {
        const generator = await OpenAPIToolGenerator.fromJSON(named(`${own()}${fragment}`), {
          ...posture,
          documentUri: own(),
        });
        const [tool] = await generator.generateTools();
        expect(at(tool.outputSchema, 'properties', 'pet0', 'title')).toBe(title);
        expect(server.requests).toEqual([]);
      });

      it('fails the load for a reference to the document whose target does not exist, and tells validate() the same', async () => {
        const generator = await OpenAPIToolGenerator.fromJSON(named(`${own()}#/components/schemas/Nope`), {
          ...posture,
          documentUri: own(),
        });
        const error = await parseError(generator);
        expect(error.context).toEqual({
          rule: 'missing-target',
          reference: `${own()}#/components/schemas/Nope`,
          base: own(),
          resolved: `${own()}#/components/schemas/Nope`,
          path: '/paths/~1pets/get/responses/200/content/application~1json/schema/properties/pet0',
        });
        expect(error.message).toContain('it names this document, but');
        expect(error.message).toContain('points to nothing in it');
        await expectUnreadableReference(generator, error);
        // a missing target is not looked for anywhere: nothing was requested
        expect(server.requests).toEqual([]);
      });

      it('decodes the fragment once: %2520 is the name `A%20B`, which no schema has, so the load fails', async () => {
        const generator = await OpenAPIToolGenerator.fromJSON(named(`${own()}#/components/schemas/A%2520B`), {
          ...posture,
          documentUri: own(),
        });
        expect((await parseError(generator)).context).toMatchObject({ rule: 'missing-target' });
      });

      it('reads $ref "" as the whole document when it has a base URI', async () => {
        const document = referencing('3.1.0', [`${own()}#/components/schemas/Pet`]);
        Object.assign(document.components.schemas, { Doc: { $ref: '' } });
        const generator = await OpenAPIToolGenerator.fromJSON(document, { ...posture, documentUri: own() });
        await generator.generateTools();

        const whole = at(generator.getDocument(), 'components', 'schemas', 'Doc');
        expect(at(whole, 'openapi')).toBe('3.1.0');
        expect(at(whole, 'info', 'title')).toBe('Self-referencing API');
        expect(server.requests).toEqual([]);
      });
    });
  });

  describe('$self', () => {
    it.each([
      ['on another origin', '/mirror/other-origin/', (_origin: string, other: string) => `${other}/canonical/v1/${ROOT_32}`],
      ['in another folder of the same origin', '/mirror/same-origin/', (base: string) => `${base}/canonical/v1/${ROOT_32}`],
      ['relative to where the document was fetched', '/mirror/relative/', () => `../../canonical/v1/${ROOT_32}`],
    ])(
      'names the document without moving its references: a mirror whose $self is %s serves its own',
      async (_what, folder, self) => {
        // The tree is also served where $self points, so a reference read from there would be answered, and recorded
        mount(folder, { [ROOT_32]: rootWithSelf(self(origin, otherOrigin)) });
        mount('/canonical/v1/');
        const generator = await OpenAPIToolGenerator.fromURL(`${origin}${folder}${ROOT_32}`, LOOPBACK);
        expect(await generator.generateTools()).toEqual(await referenceTools());
        // $self is usable: nothing is reported
        expect(codes(generator)).toEqual([]);

        expect(requested()).toEqual(under(folder, [ROOT_32, ...SIBLINGS]));
        expect(elsewhere.requests).toEqual([]);
      },
    );

    it('is the base only of a document with no retrieval URI at all', async () => {
      mount('/canonical/v1/');
      const generator = await OpenAPIToolGenerator.fromJSON(JSON.parse(rootWithSelf(`${origin}/canonical/v1/${ROOT_32}`)), LOOPBACK);
      expect(await generator.generateTools()).toEqual(await referenceTools());
      expect(codes(generator)).toEqual([]);
      expect(requested()).toEqual(under('/canonical/v1/', SIBLINGS));
    });

    it('does not outrank a documentUri: the references are read against it', async () => {
      mount('/canonical/v1/');
      mount('/mirror/');
      const generator = await OpenAPIToolGenerator.fromJSON(JSON.parse(rootWithSelf(`${origin}/canonical/v1/${ROOT_32}`)), {
        ...LOOPBACK,
        documentUri: `${origin}/mirror/${ROOT_32}`,
      });
      expect(await generator.generateTools()).toEqual(await referenceTools());
      expect(requested()).toEqual(under('/mirror/', SIBLINGS));
    });

    it('does not move where references are read from when the document declares OpenAPI 3.1: it is reported and ignored', async () => {
      const root = 'openapi-3.1.yaml';
      mount('/mirror/', { [root]: rootWithSelf('https://schemas.invalid/pets/openapi.yaml', root) });
      const generator = await OpenAPIToolGenerator.fromURL(`${origin}/mirror/${root}`, LOOPBACK);
      expectTheTools(await generator.generateTools());

      expect(codes(generator)).toEqual(['FEATURE_NEWER_THAN_DECLARED_VERSION']);
      expect(generator.getDiagnostics()[0].path).toBe('/$self');
      expect(requested()).toEqual(under('/mirror/', [root, ...SIBLINGS]));
    });

    describe('in a form that is refused or invalid', () => {
      /** Serves a 3.2 root with `$self` set to `self` at its own folder, and loads it from there. */
      const load = async (name: string, self: unknown, options: LoadOptions = LOOPBACK) => {
        mount(`/hostile/${name}/`, { [ROOT_32]: rootWithSelf(self) });
        return OpenAPIToolGenerator.fromURL(`${origin}/hostile/${name}/${ROOT_32}`, options);
      };
      const fetchedFromTheRetrievalFolder = (name: string): string[] =>
        under(`/hostile/${name}/`, [ROOT_32, ...SIBLINGS]);

      it('ignores user information in $self, and never repeats the credential', async () => {
        const generator = await load('userinfo', 'https://reader:s3cret@schemas.invalid/pets/openapi.yaml');
        expect(await generator.generateTools()).toEqual(await referenceTools());

        expect(codes(generator)).toEqual(['REFUSED_SELF']);
        expect(generator.getDiagnostics()[0].path).toBe('/$self');
        expect(JSON.stringify(generator.getDiagnostics())).not.toContain('s3cret');
        expect(requested()).toEqual(fetchedFromTheRetrievalFolder('userinfo'));
      });

      it('ignores a file: $self in a document fetched over the network, and reads no local file, even when files are allowed', async () => {
        const self = pathToFileURL(join(TREE, ROOT_32)).href;
        const generator = await load('file', self, {
          refResolution: { allowInternalIPs: true, allowedProtocols: ['http', 'https', 'file'] },
        });
        expect(await generator.generateTools()).toEqual(await referenceTools());

        expect(codes(generator)).toEqual(['REFUSED_SELF']);
        expect(requested()).toEqual(fetchedFromTheRetrievalFolder('file'));
        expect(treeReads).toEqual([]);
      });

      /** An absolute `$self` of exactly `length` characters. */
      const selfOfLength = (length: number): string => {
        const prefix = 'https://schemas.invalid/';
        return `${prefix}${'a'.repeat(length - prefix.length - '.yaml'.length)}.yaml`;
      };

      it.each([
        ['a scheme that is no document source', 'ftp://schemas.invalid/pets/openapi.yaml'],
        ['a file URI that names a host', 'file://schemas.invalid/pets/openapi.yaml'],
        ['a URI of 2,049 characters', selfOfLength(2049)],
      ])('ignores $self naming %s', async (_what, self) => {
        const generator = await load('refused', self);
        expect(await generator.generateTools()).toEqual(await referenceTools());

        expect(codes(generator)).toEqual(['REFUSED_SELF']);
        expect(requested()).toEqual(fetchedFromTheRetrievalFolder('refused'));
      });

      it('takes a $self of 2,048 characters', async () => {
        const generator = await load('limit', selfOfLength(2048));
        expect(await generator.generateTools()).toEqual(await referenceTools());
        expect(codes(generator)).toEqual([]);
        expect(requested()).toEqual(fetchedFromTheRetrievalFolder('limit'));
      });

      it.each([
        ['a fragment', 'https://schemas.invalid/pets/openapi.yaml#section'],
        ['a number', 42],
        ['a list', ['https://schemas.invalid/pets/openapi.yaml']],
      ])('rejects $self that is %s as an invalid document, and with validation off ignores it', async (_what, self) => {
        // validation on: the document is invalid (a specification error), after its references were read as if $self were absent
        const strict = await load('invalid', self);
        const error = await failureOf(() => strict.generateTools());
        expect(error).toBeInstanceOf(ParseError);
        expect((error as ParseError).context?.['errors']).toMatchObject([{ code: 'INVALID_SELF', path: '/$self' }]);
        expect(requested()).toEqual(fetchedFromTheRetrievalFolder('invalid'));
        expect(codes(strict)).toEqual(['INVALID_SELF']);

        // validation off: ignored, the tools generate
        server.reset();
        const lenient = await load('invalid', self, { ...LOOPBACK, validate: false });
        expect(await lenient.generateTools()).toEqual(await referenceTools());
        expect(codes(lenient)).toEqual(['INVALID_SELF']);
        expect(requested()).toEqual(fetchedFromTheRetrievalFolder('invalid'));
      });

      it('ignores a relative $self when the document has nothing to resolve it against', async () => {
        const generator = await OpenAPIToolGenerator.fromJSON(
          {
            openapi: '3.2.0',
            $self: 'pets/openapi.yaml',
            info: { title: 'No retrieval URI', version: '1.0.0' },
            servers: [{ url: 'https://api.example.com' }],
            paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'pong' } } } } },
          },
          LOOPBACK,
        );
        expect((await generator.generateTools()).map((tool) => tool.name)).toEqual(['ping']);
        expect(codes(generator)).toEqual(['UNRESOLVABLE_SELF']);
        expect(generator.getDiagnostics()[0].path).toBe('/$self');
        expect(server.requests).toEqual([]);
      });

      it('does not read the references of a fetched document from the host its $self names, so allowedHosts is not in the way', async () => {
        const generator = await load('other-host', 'https://schemas.invalid/pets/openapi.yaml', {
          refResolution: { allowInternalIPs: true, allowedHosts: ['127.0.0.1'] },
        });
        expect(await generator.generateTools()).toEqual(await referenceTools());
        expect(codes(generator)).toEqual([]);
        expect(requested()).toEqual(fetchedFromTheRetrievalFolder('other-host'));
      });

      it('is no trusted origin for a document with no retrieval URI: allowedHosts still refuses its references', async () => {
        const self = 'https://schemas.invalid/pets/openapi.yaml';
        const generator = await OpenAPIToolGenerator.fromJSON(JSON.parse(rootWithSelf(self)), {
          refResolution: { allowInternalIPs: true, allowedHosts: ['127.0.0.1'] },
        });
        // $self is usable, so it is the base: the references go to its host, and the gate refuses the first of them
        expect(codes(generator)).toEqual([]);
        const error = await parseError(generator);
        expect(error.context).toEqual({
          rule: 'host-not-allowed',
          reference: './paths/pets.yaml',
          base: self,
          resolved: 'https://schemas.invalid/pets/paths/pets.yaml',
          path: '/paths/~1pets',
        });
        expect(error.message).toContain('add the host to refResolution.allowedHosts to read it');
        await expectUnreadableReference(generator, error);
        expect(server.requests).toEqual([]);
      });
    });
  });

  describe('a reference that cannot be read', () => {
    /** The tree's 3.2 root, as a document retrieved from `documentUri`, loaded with `options`. */
    const loadedFrom = (documentUri: string, options: LoadOptions): Promise<OpenAPIToolGenerator> =>
      OpenAPIToolGenerator.fromJSON(parseTree(ROOT_32), { ...options, documentUri });

    type Cause = [
      rule: string,
      load: () => Promise<OpenAPIToolGenerator>,
      /** A stable part of the message: what is wrong, or the option that would allow it */
      says: string,
    ];
    const causes = (): Cause[] => [
      [
        'protocol',
        () => loadedFrom(`${origin}/spec/${ROOT_32}`, { refResolution: { allowedProtocols: ['file'] } }),
        'is not in refResolution.allowedProtocols',
      ],
      [
        'host-not-allowed',
        () => loadedFrom(`${origin}/spec/${ROOT_32}`, { refResolution: { allowInternalIPs: true, allowedHosts: ['api.invalid'] } }),
        'add the host to refResolution.allowedHosts to read it',
      ],
      [
        'host-blocked',
        () => loadedFrom(`${origin}/spec/${ROOT_32}`, { refResolution: { allowInternalIPs: true, blockedHosts: ['127.0.0.1'] } }),
        'refResolution.blockedHosts',
      ],
      ['internal-address', () => loadedFrom(`${origin}/spec/${ROOT_32}`, {}), 'refResolution.allowInternalIPs would allow it'],
      ['response', () => loadedFrom(`${origin}/nothing/${ROOT_32}`, LOOPBACK), '404'],
      [
        'file-error',
        () => loadedFrom(pathToFileURL(join(TREE, 'nowhere', ROOT_32)).href, FILES),
        'the file cannot be read (ENOENT)',
      ],
    ];

    it.each(causes().map(([rule]) => rule))('names the rule %s, and the first reference in document order', async (rule) => {
      mount('/spec/');
      const [, load, says] = causes().find(([name]) => name === rule) as Cause;
      const generator = await load();
      const error = await parseError(generator);
      expect(error.context).toMatchObject({ rule, reference: './paths/pets.yaml', path: '/paths/~1pets' });
      expect(error.message).toContain('Cannot read $ref "./paths/pets.yaml" at "#/paths/~1pets"');
      expect(error.message).toContain(says);
      await expectUnreadableReference(generator, error);
    });

    it('names fetch-failed for a server that refuses the connection', async () => {
      const closed = createLoopbackServer(() => () => undefined);
      const closedOrigin = await closed.listen();
      await closed.close();
      const generator = await loadedFrom(`${closedOrigin}/spec/${ROOT_32}`, LOOPBACK);
      const error = await parseError(generator);
      expect(error.context).toMatchObject({ rule: 'fetch-failed', reference: './paths/pets.yaml' });
      await expectUnreadableReference(generator, error);
    });

    it('names timeout for a server that does not answer within LoadOptions.timeout', async () => {
      const silent = createLoopbackServer(() => () => undefined);
      const silentOrigin = await silent.listen();
      try {
        const generator = await loadedFrom(`${silentOrigin}/spec/${ROOT_32}`, { ...LOOPBACK, timeout: 200 });
        const error = await parseError(generator);
        expect(error.context).toMatchObject({ rule: 'timeout', reference: './paths/pets.yaml' });
        expect(error.message).toContain('LoadOptions.timeout');
        await expectUnreadableReference(generator, error);
      } finally {
        await silent.close();
      }
    });

    it('names invalid-document for a referenced file that is neither JSON nor YAML', async () => {
      mount('/spec/', { 'paths/pets.yaml': 'a: [unclosed' });
      const generator = await loadedFrom(`${origin}/spec/${ROOT_32}`, LOOPBACK);
      const error = await parseError(generator);
      expect(error.context).toMatchObject({ rule: 'invalid-document' });
      await expectUnreadableReference(generator, error);
    });

    it('names the first reference in document order whatever order the files answer in', async () => {
      // The first path item is the slowest to answer and the later ones fail at once: which is named does not depend on that
      mount('/spec/', Object.fromEntries(SIBLINGS.filter((file) => file.startsWith('paths/')).map((file) => [file, 'a: [unclosed'])));
      delays.set('/spec/paths/pets.yaml', 250);
      const generator = await loadedFrom(`${origin}/spec/${ROOT_32}`, LOOPBACK);
      const error = await parseError(generator);
      expect(error.context).toMatchObject({ rule: 'invalid-document' });
      expect(error.message).toContain('/spec/paths/pets.yaml');
      expect(error.message).not.toContain('pets-by-id.yaml');
      expect(error.message).not.toContain('owner.yaml');
    });
  });

  describe('an Arazzo document over a multi-file source', () => {
    const workflows: ArazzoDocument = {
      arazzo: '1.0.0',
      info: { title: 'Pet flows', version: '1.0.0' },
      sourceDescriptions: [{ name: 'registry', url: `./${ROOT_32}`, type: 'openapi' }],
      workflows: [
        {
          workflowId: 'readFirstPet',
          summary: 'List pets, then read the first',
          inputs: { type: 'object', properties: { limit: { type: 'integer' } } },
          steps: [
            {
              stepId: 'list',
              operationId: 'listPets',
              parameters: [{ name: 'limit', in: 'query', value: '$inputs.limit' }],
              outputs: { firstId: '$response.body#/0/id' },
            },
            {
              stepId: 'read',
              operationId: 'getPet',
              parameters: [{ name: 'petId', in: 'path', value: '$steps.list.outputs.firstId' }],
              outputs: { pet: '$response.body' },
            },
          ],
          outputs: { pet: '$steps.read.outputs.pet' },
        },
      ],
    };

    it('takes the source as a generator loaded with its own documentUri, whose references are read from there', async () => {
      mount('/spec/');
      const source = await OpenAPIToolGenerator.fromJSON(parseTree(ROOT_32), { ...LOOPBACK, documentUri: `${origin}/spec/${ROOT_32}` });
      const [workflow] = await fromArazzo(workflows, { sources: { registry: source } });

      expect(workflow.name).toBe('readFirstPet');
      expect(workflow.metadata.workflow?.steps.map((step) => step.stepId)).toEqual(['list', 'read']);
      expect(requested()).toEqual(under('/spec/', SIBLINGS));
    });

    it('refuses a documentUri in loadOptions, which would give every source the same URI', async () => {
      // `documentUri` is not in the type of `loadOptions`: it takes a variable with a field the type has to get past it
      const loadOptions = { dereference: true, documentUri: `${origin}/spec/${ROOT_32}` };
      const error = await failureOf(() => fromArazzo(workflows, { sources: { registry: parseTree(ROOT_32) }, loadOptions }));
      expect(error).toBeInstanceOf(ArazzoError);
      expect((error as ArazzoError).message).toContain('loadOptions.documentUri');
      expect(server.requests).toEqual([]);
    });
  });

  describe('a security requirement that names a scheme by URI', () => {
    const DOCUMENT_URI = 'https://specs.invalid/pets/openapi.yaml';
    const SCHEME = (name: string, uri = DOCUMENT_URI) => `${uri}#/components/securitySchemes/${name}`;

    const secured = (openapi: string, requirements: Array<Record<string, string[]>>, extra: Record<string, unknown> = {}) => ({
      openapi,
      info: { title: 'Secured API', version: '1.0.0' },
      servers: [{ url: 'https://api.example.com' }],
      components: {
        securitySchemes: {
          apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      paths: {
        '/pets': { get: { operationId: 'listPets', security: requirements, responses: { '200': { description: 'The pets' } } } },
      },
      ...extra,
    });

    /** The security entries of a tool's mapper, as `scheme:type`. */
    const schemesOf = (tool: McpOpenAPITool): string[] =>
      tool.mapper.flatMap((entry) => (entry.security === undefined ? [] : `${entry.security.scheme}:${entry.security.type}`));

    it('resolves to that scheme of the document, by its retrieval URI', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(secured('3.2.0', [{ [SCHEME('apiKeyAuth')]: [] }]), {
        documentUri: DOCUMENT_URI,
      });
      const [tool] = await generator.generateTools();
      expect(schemesOf(tool)).toEqual(['apiKeyAuth:apiKey']);
      expect(tool.mapper.find((entry) => entry.security)?.security).toMatchObject({ apiKeyName: 'X-API-Key', apiKeyIn: 'header' });
      expect(codes(generator)).toEqual([]);
    });

    it('resolves a key that is only a fragment, with no base URI at all', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(
        secured('3.2.0', [{ '#/components/securitySchemes/bearerAuth': [] }]),
      );
      const [tool] = await generator.generateTools();
      expect(schemesOf(tool)).toEqual(['bearerAuth:http']);
      expect(codes(generator)).toEqual([]);
    });

    it('resolves a key naming the document by its $self, and one naming it by its retrieval URI', async () => {
      const self = 'https://specs.invalid/canonical/pets/openapi.yaml';
      const generator = await OpenAPIToolGenerator.fromJSON(
        secured('3.2.0', [{ [SCHEME('apiKeyAuth', self)]: [] }, { [SCHEME('bearerAuth')]: [] }], { $self: self }),
        { documentUri: DOCUMENT_URI },
      );
      const [tool] = await generator.generateTools();
      expect(schemesOf(tool).sort()).toEqual(['apiKeyAuth:apiKey', 'bearerAuth:http']);
      expect(codes(generator)).toEqual([]);
    });

    it('keeps the requirement that names a scheme of another document unresolved, fetching nothing for it', async () => {
      // The other document is on the loopback server, so a fetch for its scheme would be recorded
      const generator = await OpenAPIToolGenerator.fromJSON(
        secured('3.2.0', [{ [SCHEME('apiKeyAuth')]: [] }, { [SCHEME('bearerAuth', `${origin}/other/openapi.yaml`)]: [] }]),
        { ...LOOPBACK, documentUri: DOCUMENT_URI },
      );
      const [tool] = await generator.generateTools();

      // the alternative that resolves stays; the other is dropped with a diagnostic
      expect(schemesOf(tool)).toEqual(['apiKeyAuth:apiKey']);
      const unresolved = generator.getDiagnostics().filter(({ code }) => code === 'UNRESOLVED_SECURITY_SCHEME');
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0].path).toMatch(/^\/paths\/~1pets\/get\/security\/1\//);
      expect(unresolved[0].message).toContain('names a scheme in another document');
      expect(server.requests).toEqual([]);
    });

    const unresolvedForms: Array<[what: string, requirements: Array<Record<string, string[]>>, options: LoadOptions, reason: string]> = [
      [
        'another document',
        [{ [SCHEME('apiKeyAuth', 'https://other.invalid/openapi.yaml')]: [] }],
        { documentUri: DOCUMENT_URI },
        'names a scheme in another document',
      ],
      [
        'a part of this document that is no scheme',
        [{ [`${DOCUMENT_URI}#/components/schemas/Pet`]: [] }],
        { documentUri: DOCUMENT_URI },
        'not under /components/securitySchemes',
      ],
      [
        'a document next to this one, by a relative URI',
        [{ './other.yaml#/components/securitySchemes/apiKeyAuth': [] }],
        { documentUri: DOCUMENT_URI },
        'names a scheme in another document',
      ],
      [
        'a relative URI of a document that has no base URI',
        [{ './openapi.yaml#/components/securitySchemes/apiKeyAuth': [] }],
        {},
        'the document has no base URI',
      ],
    ];

    it.each(unresolvedForms)(
      'drops a requirement that names a scheme of %s, and an operation with nothing left makes no tool',
      async (_what, requirements, options, reason) => {
        const generator = await OpenAPIToolGenerator.fromJSON(secured('3.2.0', requirements), options);
        expect(await generator.generateTools()).toEqual([]);

        expect(codes(generator)).toEqual(['UNRESOLVED_SECURITY_SCHEME', 'UNSATISFIABLE_SECURITY']);
        expect(generator.getDiagnostics()[0].message).toContain(reason);
      },
    );

    it('does not read a URI as a scheme in a document that declares OpenAPI 3.1', async () => {
      const generator = await OpenAPIToolGenerator.fromJSON(secured('3.1.0', [{ [SCHEME('apiKeyAuth')]: [] }]), {
        documentUri: DOCUMENT_URI,
      });
      expect(await generator.generateTools()).toEqual([]);
      const unresolved = generator.getDiagnostics().find(({ code }) => code === 'UNRESOLVED_SECURITY_SCHEME');
      expect(unresolved?.message).toContain('a scheme named by URI needs OpenAPI 3.2 or later');
    });
  });
});
