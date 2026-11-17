import { ParseError } from '../errors';
import { OpenAPIToolGenerator } from '../generator';
import { DEFAULT_MAX_REFERENCED_DOCUMENTS, DEFAULT_MAX_REFERENCED_BYTES } from '../types';
import { createLoopbackServer, type LoopbackHandler } from './helpers/loopback';

function documentReferencing(urls: string[]): Record<string, unknown> {
  const properties = Object.fromEntries(urls.map((url, index) => [`p${index}`, { $ref: url }]));
  return {
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {
      '/p': {
        get: {
          operationId: 'p',
          responses: {
            200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties } } } },
          },
        },
      },
    },
  };
}

describe('external $ref fetching is bounded', () => {
  let handler: LoopbackHandler;
  const loopback = createLoopbackServer(() => handler);
  let baseUrl: string;
  let active = 0;
  let peakActive = 0;

  beforeAll(async () => {
    baseUrl = await loopback.listen();
  });

  afterAll(async () => {
    await loopback.close();
  });

  beforeEach(() => {
    loopback.reset();
    active = 0;
    peakActive = 0;
  });

  const answerJson =
    (body: unknown, delayMs = 0): LoopbackHandler =>
    (_req, res) => {
      active++;
      peakActive = Math.max(peakActive, active);
      setTimeout(() => {
        active--;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }, delayMs);
    };

  async function failureOf(document: Record<string, unknown>, refResolution: Record<string, unknown>, timeout = 5000) {
    const generator = await OpenAPIToolGenerator.fromJSON(document, {
      refResolution: { allowInternalIPs: true, ...refResolution },
      timeout,
    });
    return generator.generateTools().then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it('stops an endless chain of documents at maxDocuments', async () => {
    handler = (req, res) => {
      const index = Number(/d(\d+)\.json/.exec(req.url ?? '')?.[1] ?? 0);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'object', properties: { next: { $ref: `./d${index + 1}.json` } } }));
    };
    const failure = await failureOf(documentReferencing([`${baseUrl}/d0.json`]), { maxDocuments: 20 });
    expect(failure).toBeInstanceOf(ParseError);
    expect((failure as ParseError).context).toMatchObject({ rule: 'too-many-documents' });
    expect(loopback.requests.length).toBeLessThanOrEqual(20);
  });

  it('reads at most 8 documents at a time', async () => {
    handler = answerJson({ type: 'string' }, 30);
    const urls = Array.from({ length: 40 }, (_, index) => `${baseUrl}/s${index}.json`);
    await expect(failureOf(documentReferencing(urls), {})).resolves.toBeUndefined();
    expect(loopback.requests).toHaveLength(40);
    expect(peakActive).toBeLessThanOrEqual(8);
  });

  it('stops once the documents read hold more than maxTotalBytes', async () => {
    handler = answerJson({ type: 'string', description: 'x'.repeat(300_000) });
    const urls = Array.from({ length: 40 }, (_, index) => `${baseUrl}/big${index}.json`);
    const failure = await failureOf(documentReferencing(urls), { maxTotalBytes: 1_000_000 });
    expect(failure).toBeInstanceOf(ParseError);
    expect((failure as ParseError).context).toMatchObject({ rule: 'too-large' });
    expect(loopback.requests.length).toBeLessThanOrEqual(4 + 8);
  });

  it('gives up a dereference that runs past ten times the timeout', async () => {
    handler = (req, res) => {
      const index = Number(/d(\d+)\.json/.exec(req.url ?? '')?.[1] ?? 0);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'object', properties: { next: { $ref: `./d${index + 1}.json` } } }));
      }, 40);
    };
    const started = Date.now();
    const failure = await failureOf(documentReferencing([`${baseUrl}/d0.json`]), {}, 100);
    expect(failure).toBeInstanceOf(ParseError);
    expect((failure as ParseError).context).toMatchObject({ rule: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('validate() reports a document past the limits as unreadable', async () => {
    handler = answerJson({ type: 'string' });
    const urls = Array.from({ length: 5 }, (_, index) => `${baseUrl}/v${index}.json`);
    const generator = await OpenAPIToolGenerator.fromJSON(documentReferencing(urls), {
      refResolution: { allowInternalIPs: true, maxDocuments: 2 },
    });
    const result = await generator.validate();
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.code).toBe('UNREADABLE_REFERENCE');
  });

  it('has generous defaults', () => {
    expect(DEFAULT_MAX_REFERENCED_DOCUMENTS).toBe(10_000);
    expect(DEFAULT_MAX_REFERENCED_BYTES).toBe(100 * 1024 * 1024);
  });

  it.each([Number.NaN, 0, -1, 'many'])('reads a maxDocuments of %p as the default', async (maxDocuments) => {
    handler = answerJson({ type: 'string' });
    await expect(
      failureOf(documentReferencing([`${baseUrl}/x.json`]), { maxDocuments, maxTotalBytes: maxDocuments }),
    ).resolves.toBeUndefined();
  });
});
