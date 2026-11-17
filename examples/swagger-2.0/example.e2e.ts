/** Executes the swagger-2.0 example and asserts what reaches the wire. */
import { OpenAPIToolGenerator } from 'mcp-from-openapi';
import type { OAS20 } from 'mcp-from-openapi';
import { createLoopbackServer, type LoopbackHandler } from '../../src/__tests__/helpers/loopback';
import { callTool, diagnosticsOf, loadTools, petStore, toOpenApi3 } from './example';

describe('example: swagger-2.0', () => {
  const handler: LoopbackHandler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  const loopback = createLoopbackServer(() => handler);
  let apiBaseUrl: string;
  const auth = { apiKeys: { 'X-Api-Key': 'k-123' } };

  beforeAll(async () => {
    // The document's server is https://petstore.example.com/v2: the tests send to the loopback server instead,
    // under the same basePath
    apiBaseUrl = `${await loopback.listen()}/v2`;
  });
  afterAll(() => loopback.close());
  beforeEach(() => loopback.reset());

  it('loads a Swagger 2.0 document through the same factory and reports its version', async () => {
    const { generator, tools } = await loadTools(petStore);

    expect([...tools.keys()]).toEqual(['listPets', 'addPet', 'updatePetWithForm', 'uploadPhoto']);
    expect(generator.getSpecVersion()).toMatchObject({ status: 'supported', field: 'swagger', family: '2.0' });
    // Once tools are generated the document is the OpenAPI 3.0 one they were read from
    expect(generator.getDocument()).toMatchObject({ openapi: '3.0.3' });
  });

  it('turns host, basePath and schemes into the server', async () => {
    const { tools } = await loadTools(petStore);
    const list = tools.get('listPets')!;

    expect(list.metadata.servers).toEqual([{ url: 'https://petstore.example.com/v2' }]);
    expect(list.metadata.path).toBe('/pets');
  });

  it('reports what the conversion could not carry over', async () => {
    expect(await diagnosticsOf(petStore)).toEqual([
      // OpenAPI 3.0 has no tab-separated style: the array is sent comma-separated
      'warning SWAGGER_UNSUPPORTED_COLLECTION_FORMAT /paths/~1pets/get/parameters/2/collectionFormat',
    ]);
  });

  it('sends collectionFormat csv, multi and the API key of securityDefinitions', async () => {
    const { tools } = await loadTools(petStore);

    const result = await callTool(
      tools.get('listPets')!,
      { tags: ['a', 'b'], status: ['sold', 'pending'], fields: ['id', 'name'] },
      { apiBaseUrl, auth },
    );

    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
    const wire = loopback.requests.at(-1)!;
    expect(wire.method).toBe('GET');
    // csv: one parameter, items joined by a comma (percent-encoded); multi: the parameter repeated
    expect(wire.url).toBe('/v2/pets?tags=a%2Cb&status=sold&status=pending&fields=id%2Cname');
    const query = new URL(`http://x${wire.url}`).searchParams;
    expect(query.get('tags')).toBe('a,b');
    expect(query.getAll('status')).toEqual(['sold', 'pending']);
    expect(query.get('fields')).toBe('id,name'); // tsv: sent as csv, and the diagnostic above says so
    expect(wire.headers['x-api-key']).toBe('k-123');
  });

  it('sends an in: body parameter as a JSON body whose properties are the tool inputs', async () => {
    const { tools } = await loadTools(petStore);
    const add = tools.get('addPet')!;

    expect(Object.keys(add.inputSchema.properties ?? {})).toEqual(['name', 'tag']);
    expect(add.inputSchema.required).toEqual(['name']);

    await callTool(add, { name: 'Rex', tag: 'dog' }, { apiBaseUrl, auth });

    const wire = loopback.requests.at(-1)!;
    expect(wire.method).toBe('POST');
    expect(wire.url).toBe('/v2/pets');
    expect(wire.headers['content-type']).toBe('application/json');
    expect(wire.body.toString()).toBe('{"name":"Rex","tag":"dog"}');
    expect(wire.headers['x-api-key']).toBe('k-123');
  });

  it('sends in: formData parameters form-urlencoded when the operation consumes it', async () => {
    const { tools } = await loadTools(petStore);

    await callTool(tools.get('updatePetWithForm')!, { petId: 7, name: 'Rex Jr', status: 'sold' }, { apiBaseUrl, auth });

    const wire = loopback.requests.at(-1)!;
    expect(wire.method).toBe('POST');
    expect(wire.url).toBe('/v2/pets/7');
    expect(wire.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(wire.body.toString()).toBe('name=Rex+Jr&status=sold');
  });

  it('sends type: file as a binary part of a multipart body', async () => {
    const { tools } = await loadTools(petStore);
    const upload = tools.get('uploadPhoto')!;

    // The file is a binary string in the input schema, and a binary entry in the mapper
    expect(upload.inputSchema.properties?.['photo']).toMatchObject({ type: 'string', format: 'binary' });
    expect(upload.inputSchema.required).toEqual(['petId', 'photo']);
    expect(upload.mapper.find((m) => m.inputKey === 'photo')?.serialization).toEqual({
      contentType: 'multipart/form-data',
      binary: true,
    });

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await callTool(
      upload,
      { petId: 7, caption: 'Rex at the park', photo: new Blob([png], { type: 'image/png' }) },
      { apiBaseUrl, auth },
    );

    const wire = loopback.requests.at(-1)!;
    expect(wire.method).toBe('POST');
    expect(wire.url).toBe('/v2/pets/7/photo');
    expect(wire.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    // Read the body back with the platform's own multipart parser
    const form = await new Response(wire.body, { headers: { 'content-type': wire.headers['content-type']! } }).formData();
    const parts = [...form.entries()];
    expect(parts.map(([name]) => name)).toEqual(['caption', 'photo']);
    expect(parts[0][1]).toBe('Rex at the park');
    const photo = parts[1][1] as File;
    expect(photo.type).toBe('image/png');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(png);
  });

  it('converts the document on its own to OpenAPI 3.0, and the saved copy gives the same tools', async () => {
    const { document, diagnostics } = toOpenApi3(petStore);

    expect(document.openapi).toBe('3.0.3');
    expect(document.servers).toEqual([{ url: 'https://petstore.example.com/v2' }]);
    // `in: body` became a request body, under the media type `consumes` names
    expect(document.paths?.['/pets']?.post?.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' }, tag: { type: 'string' } },
          },
        },
      },
    });
    // collectionFormat multi became style form with explode
    expect(document.paths?.['/pets']?.get?.parameters?.[1]).toEqual({
      name: 'status',
      in: 'query',
      style: 'form',
      explode: true,
      schema: { type: 'array', items: { type: 'string' } },
    });
    // The generator reports exactly the conversion's findings
    expect(diagnostics.map((d) => `${d.severity} ${d.code} ${d.path}`)).toEqual(await diagnosticsOf(petStore));

    // The document is plain JSON: save it, load it later as OpenAPI 3.0 (the same tools come out)
    const saved: unknown = JSON.parse(JSON.stringify(document));
    const reloaded = await OpenAPIToolGenerator.fromJSON(saved as object);
    expect(reloaded.getSpecVersion()).toMatchObject({ status: 'supported', field: 'openapi', family: '3.0' });
    const original = (await loadTools(petStore)).tools;
    expect(await reloaded.generateTools()).toEqual([...original.values()]);
  });

  it('needs a dereferenced document to convert on its own, which the generator makes first', async () => {
    const shared: OAS20.SwaggerObject = {
      ...petStore,
      parameters: { limit: { name: 'limit', in: 'query', type: 'integer' } },
      paths: {
        '/pets': {
          get: {
            operationId: 'listPets',
            parameters: [{ $ref: '#/parameters/limit' }],
            responses: { 200: { description: 'Pets' } },
          },
        },
      },
    };

    // On its own the converter does not follow the $ref: the parameter is left out, and it says so
    const { document, diagnostics } = toOpenApi3(shared);
    expect(diagnostics.map((d) => d.code)).toEqual(['SWAGGER_UNRESOLVED_REFERENCE']);
    expect(document.paths?.['/pets']?.get?.parameters).toBeUndefined();

    // The generator dereferences first
    const { tools } = await loadTools(shared);
    expect(tools.get('listPets')!.mapper.map((m) => m.inputKey)).toEqual(['limit', 'apiKey']);
  });
});
