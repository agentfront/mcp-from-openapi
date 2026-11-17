/**
 * Swagger 2.0 in practice: load the document through the same factory as any
 * OpenAPI 3.x one, send its tools with buildHttpRequest, read what the
 * conversion could not carry over, and convert the document on its own.
 */
import {
  OpenAPIToolGenerator,
  SecurityResolver,
  buildHttpRequest,
  createSecurityContext,
  upgradeSwagger2,
} from 'mcp-from-openapi';
import type { McpOpenAPITool, OAS20, SecurityContext } from 'mcp-from-openapi';

/**
 * One small Swagger 2.0 document: `host`, `basePath` and `schemes` instead of
 * `servers`, an `in: body` parameter, `in: formData` parameters (one of them
 * `type: file`), `collectionFormat` on array parameters and an API key from
 * `securityDefinitions`.
 */
export const petStore: OAS20.SwaggerObject = {
  swagger: '2.0',
  info: { title: 'Pet Store', version: '1.0.0' },
  host: 'petstore.example.com',
  basePath: '/v2',
  schemes: ['https'],
  consumes: ['application/json'],
  produces: ['application/json'],
  securityDefinitions: { apiKey: { type: 'apiKey', name: 'X-Api-Key', in: 'header' } },
  security: [{ apiKey: [] }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [
          // csv is the default: ?tags=a,b
          { name: 'tags', in: 'query', type: 'array', items: { type: 'string' }, collectionFormat: 'csv' },
          // multi repeats the parameter: ?status=sold&status=pending
          { name: 'status', in: 'query', type: 'array', items: { type: 'string' }, collectionFormat: 'multi' },
          // OpenAPI 3.0 has no tab-separated style: see `diagnosticsOf`
          { name: 'fields', in: 'query', type: 'array', items: { type: 'string' }, collectionFormat: 'tsv' },
        ],
        responses: { 200: { description: 'Pets', schema: { type: 'array', items: { type: 'object' } } } },
      },
      post: {
        operationId: 'addPet',
        // `in: body`: the properties of its schema become the tool's inputs
        parameters: [
          {
            name: 'pet',
            in: 'body',
            required: true,
            schema: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string' }, tag: { type: 'string' } },
            },
          },
        ],
        responses: { 201: { description: 'Created' } },
      },
    },
    '/pets/{petId}': {
      post: {
        operationId: 'updatePetWithForm',
        consumes: ['application/x-www-form-urlencoded'],
        parameters: [
          { name: 'petId', in: 'path', required: true, type: 'integer' },
          { name: 'name', in: 'formData', type: 'string' },
          { name: 'status', in: 'formData', type: 'string', enum: ['available', 'sold'] },
        ],
        responses: { 200: { description: 'Updated' } },
      },
    },
    '/pets/{petId}/photo': {
      post: {
        operationId: 'uploadPhoto',
        consumes: ['multipart/form-data'],
        parameters: [
          { name: 'petId', in: 'path', required: true, type: 'integer' },
          { name: 'caption', in: 'formData', type: 'string' },
          { name: 'photo', in: 'formData', type: 'file', required: true },
        ],
        responses: { 200: { description: 'Uploaded' } },
      },
    },
  },
};

/** Generate the tools; the generator is returned too, for the version and the diagnostics. */
export async function loadTools(spec: OAS20.SwaggerObject) {
  const generator = await OpenAPIToolGenerator.fromJSON(spec);
  const tools = await generator.generateTools();
  return { generator, tools: new Map(tools.map((tool) => [tool.name, tool])) };
}

/**
 * Everything the conversion to OpenAPI 3.0 could not carry over exactly, one
 * line per finding: run it on a document before you rely on its tools.
 */
export async function diagnosticsOf(spec: OAS20.SwaggerObject): Promise<string[]> {
  const { generator } = await loadTools(spec);
  return generator.getDiagnostics().map((d) => `${d.severity} ${d.code} ${d.path}`);
}

/**
 * Mapper → request → fetch. `apiBaseUrl` replaces the server the document names
 * (`https://petstore.example.com/v2`, `basePath` included); leave it out to
 * call that server. The API key of `securityDefinitions` is resolved by its
 * `name` (the header or query parameter it travels in).
 */
export async function callTool(
  tool: McpOpenAPITool,
  input: Record<string, unknown>,
  options: { apiBaseUrl?: string; auth?: Partial<SecurityContext> } = {},
) {
  const security = await new SecurityResolver().resolve(tool.mapper, createSecurityContext(options.auth ?? {}));
  // Each resolved credential goes to buildHttpRequest as input, under its security mapper entry's inputKey: it places
  // the value (a header, or a query pair for `in: query`). Never append a credential to the URL yourself. A credential
  // the context does not hold is `undefined` here ON PURPOSE: it replaces whatever `input` carries under that key, so
  // the caller of the tool (a model) can never supply or override a credential.
  const where: Record<string, Record<string, string> | undefined> = { header: security.headers, query: security.query };
  const credentials = Object.fromEntries(
    tool.mapper.filter((m) => m.security).map((m) => [m.inputKey, where[m.type]?.[m.key]]),
  );
  const built = buildHttpRequest(tool, { ...input, ...credentials }, { baseUrl: options.apiBaseUrl });
  const response = await fetch(built.url, {
    method: built.method,
    // A multipart body has no content-type here: fetch adds it, with the boundary
    headers: built.headers,
    body: built.body as never,
  });
  return { status: response.status, body: await response.text() };
}

/**
 * The conversion on its own: the OpenAPI 3.0 document the generator reads, to
 * save (`JSON.stringify(document)`) or hand to a tool that only reads OpenAPI 3.
 * It takes a dereferenced document (no `$ref` to another file).
 */
export function toOpenApi3(spec: OAS20.SwaggerObject) {
  return upgradeSwagger2(spec);
}
