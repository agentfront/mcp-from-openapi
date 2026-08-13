/**
 * User story: "spec → running MCP server" — the flagship journey from
 * docs/examples.md, executed for real. Petstore tools registered on an actual
 * MCP SDK server; a real client lists and calls them; the call handler runs
 * SecurityResolver + buildHttpRequest and fetches a real loopback HTTP server
 * that asserts what arrived on the wire.
 */
import { OpenAPIToolGenerator, SecurityResolver, buildHttpRequest, createSecurityContext } from '../src';
import type { McpOpenAPITool } from '../src';
import { createLoopbackServer, type LoopbackHandler } from '../src/__tests__/helpers/loopback';
import { loadFixture } from './helpers/fixtures';
import { sendBuiltRequest } from './helpers/http';
import { startMcpPair, type McpPair } from './helpers/mcp';

describe('story: spec → running MCP server', () => {
  let tools: McpOpenAPITool[];
  let pair: McpPair;
  let baseUrl: string;
  let handler: LoopbackHandler = (_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  };
  const loopback = createLoopbackServer(() => handler);
  const securityContext = createSecurityContext({ apiKey: 'e2e-key-123' });

  beforeAll(async () => {
    baseUrl = await loopback.listen();
    const generator = await OpenAPIToolGenerator.fromYAML(loadFixture('petstore-3.0.yaml'));
    tools = await generator.generateTools({ preferredStatusCodes: [200], includeAllResponses: false });

    pair = await startMcpPair(tools, async (tool, args) => {
      const security = await new SecurityResolver().resolve(tool.mapper, securityContext);
      const built = buildHttpRequest(tool, args, { baseUrl });
      const response = await sendBuiltRequest(built, security);
      const payload = (await response.json()) as Record<string, unknown>;
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        // structuredContent is validated against the advertised outputSchema —
        // it describes SUCCESS shapes, so error payloads go in content only
        ...(response.ok && { structuredContent: payload }),
        isError: !response.ok,
      };
    });
  });

  afterAll(async () => {
    await pair.shutdown();
    await loopback.close();
  });

  beforeEach(() => loopback.reset());

  it('advertises every generated tool intact through the protocol', async () => {
    const listed = await pair.client.listTools();
    expect(listed.tools).toHaveLength(tools.length);

    const names = listed.tools.map((t) => t.name);
    for (const tool of tools) {
      expect(names).toContain(tool.name);
    }

    const getPet = listed.tools.find((t) => t.name === 'getPetById')!;
    const generated = tools.find((t) => t.name === 'getPetById')!;
    // JSON round-trip through the transport must not alter the schema
    expect(getPet.inputSchema).toEqual(JSON.parse(JSON.stringify(generated.inputSchema)));
    expect(getPet.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });

  it('calls a GET tool end-to-end: path templating and api key land on the wire', async () => {
    const pet = { id: 42, name: 'Rex', photoUrls: ['https://example.com/rex.png'], status: 'available' };
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(pet));
    };

    const result = await pair.client.callTool({ name: 'getPetById', arguments: { petId: 42 } });

    const captured = loopback.requests.at(-1)!;
    expect(captured.method).toBe('GET');
    expect(captured.url).toBe('/pet/42');
    expect(captured.headers['api_key']).toBe('e2e-key-123');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(pet);
  });

  it('calls a POST tool end-to-end: JSON body arrives as sent', async () => {
    const order = { id: 7, petId: 42, quantity: 1, status: 'placed', complete: false };
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(order));
    };

    const result = await pair.client.callTool({
      name: 'placeOrder',
      arguments: { petId: 42, quantity: 1, status: 'placed' },
    });

    const captured = loopback.requests.at(-1)!;
    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('/store/order');
    expect(captured.headers['content-type']).toBe('application/json');
    expect(JSON.parse(captured.body.toString())).toEqual({ petId: 42, quantity: 1, status: 'placed' });
    expect(result.structuredContent).toEqual(order);
  });

  it('surfaces HTTP failures as isError results', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'no such pet' }));
    };

    const result = await pair.client.callTool({ name: 'getPetById', arguments: { petId: 999 } });
    expect(result.isError).toBe(true);
  });
});
