/**
 * What the OpenAPI types must reject. Every case carries `@ts-expect-error`,
 * and an unused directive is itself a compile error, so a case that starts
 * compiling fails `yarn typecheck`. Keep one error per directive. Compiled by
 * `yarn typecheck`, never executed (see README.md).
 */
import {
  OpenAPIToolGenerator,
  Validator,
  buildHttpRequest,
  extractExtensionOverrides,
  fromArazzo,
  isStandardMethod,
  lintDocument,
  toJsonSchema,
} from 'mcp-from-openapi';
import type {
  ArazzoDocument,
  DiagnosticCode,
  FromArazzoOptions,
  GenerateOptions,
  HTTPMethod,
  LoadOptions,
  McpOpenAPITool,
  NamingStrategy,
  OAS30,
  OAS31,
  OAS32,
  OpenAPIDocument,
  OpenAPIVersion,
  OperationObject,
  OperationWithContext,
  ParameterLocation,
  ParameterMapper,
  ParameterObject,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseHints,
  ResponseStreamInfo,
  SchemaObject,
  SchemaOrBoolean,
  SerializationInfo,
  ServerInfo,
  ServerObject,
  StandardMethod,
  ToolMetadata,
  ValidationResult,
} from 'mcp-from-openapi';

declare const arazzo: ArazzoDocument;
declare const pathItem30: OAS30.PathItemObject;
declare const pathItem31: OAS31.PathItemObject;
declare const pathItemAny: PathItemObject;
declare const server30: OAS30.ServerObject;
declare const response30: OAS30.ResponseObject;
declare const tag30: OAS30.TagObject;
declare const document30: OAS30.OpenAPIObject;
declare const document31: OAS31.OpenAPIObject;
declare const mediaType31: OAS31.MediaTypeObject;
declare const example31: OAS31.ExampleObject;
declare const schemaAny: SchemaObject;
declare const filterNeedingMore: (operation: OperationWithContext & { extra: string }) => boolean;
declare const namerForGetOnly: (path: string, method: 'get') => string;
declare const namerForStandardOnly: (path: string, method: StandardMethod) => string;
declare const toolMetadata: ToolMetadata;
declare const countsByMethod: Record<StandardMethod, number>;
declare const toolForRequest: McpOpenAPITool;
declare const computedFlag: boolean;

// ---------------------------------------------------------------------------
// A misspelt field in a fresh literal (excess property check)
// ---------------------------------------------------------------------------

// @ts-expect-error `operationID` is not a field: the Operation Object spells it `operationId`
export const misspeltOperation: OAS31.OperationObject = { operationID: 'listPets' };

// @ts-expect-error the same check holds for the cross-version alias
export const misspeltOperationAlias: OperationObject = { operationID: 'listPets', responses: {} };

// @ts-expect-error `descripton` is not a field of the Info Object
export const misspeltInfo: OAS30.InfoObject = { title: 'Pet Store', version: '1', descripton: 'Pets' };

export const misspeltNested: OAS31.OpenAPIObject = {
  openapi: '3.1.2',
  info: { title: 'Pet Store', version: '1' },
  paths: {
    // @ts-expect-error `gett` is not an HTTP method of the Path Item Object
    '/pets': { gett: { responses: {} } },
  },
};

// @ts-expect-error `sumary` is not a field: a 3.1 Reference Object spells it `summary`
export const misspeltReference: ReferenceObject = { $ref: '#/components/schemas/Pet', sumary: 'A pet' };

// ---------------------------------------------------------------------------
// A value of the wrong type
// ---------------------------------------------------------------------------

export const numberTitle: OAS31.OpenAPIObject = {
  openapi: '3.1.2',
  // @ts-expect-error `info.title` is a string, not a number
  info: { title: 1, version: '1' },
};

export const numberTitleAlias: OpenAPIDocument = {
  openapi: '3.0.4',
  // @ts-expect-error `info.title` is a string here too, through the alias
  info: { title: 1, version: '1' },
  paths: {},
};

// @ts-expect-error `required` on a parameter is a boolean
export const stringRequired: OAS31.ParameterObject = { name: 'id', in: 'path', required: 'yes' };

// @ts-expect-error `tags` on an operation is an array of strings
export const stringTags: OAS31.OperationObject = { tags: 'pets' };

export const stringServers: OAS31.OpenAPIObject = {
  openapi: '3.1.2',
  info: { title: 'Pet Store', version: '1' },
  // @ts-expect-error `servers` is an array of Server Objects
  servers: 'https://example.com',
};

// @ts-expect-error `in` is a string, even though its known values are open
export const numberLocation: ParameterObject = { name: 'id', in: 1 };

// @ts-expect-error a Reference Object's `$ref` is a string
export const numberReference: ReferenceObject = { $ref: 1 };

// ---------------------------------------------------------------------------
// A required field left out
// ---------------------------------------------------------------------------

// @ts-expect-error `version` is required in the Info Object
export const noVersion: OAS31.InfoObject = { title: 'Pet Store' };

// @ts-expect-error `in` is required in the Parameter Object
export const noLocation: ParameterObject = { name: 'id' };

// @ts-expect-error `content` is required in the Request Body Object
export const noContent: RequestBodyObject = { description: 'A pet' };

// @ts-expect-error `url` is required in the Server Object
export const noUrl: ServerObject = { description: 'Production' };

// @ts-expect-error `openapi` is required in the root object
export const noVersionField: OpenAPIDocument = { info: { title: 'Pet Store', version: '1' }, paths: {} };

// ---------------------------------------------------------------------------
// A Schema Object is an object; its boolean form is `SchemaOrBoolean`
// ---------------------------------------------------------------------------

// @ts-expect-error a boolean is not a Schema Object
export const trueSchema: SchemaObject = true;

// @ts-expect-error `false` is not a Schema Object either
export const falseSchema: OAS31.SchemaObject = false;

// @ts-expect-error a string is not a schema in either form
export const stringSchema: SchemaOrBoolean = 'string';

// @ts-expect-error `null` is not a schema in either form
export const nullSchema: SchemaOrBoolean = null;

// @ts-expect-error `properties` in a 3.0 Schema Object holds schemas or references, never booleans
export const booleanProperty: OAS30.SchemaObject = { type: 'object', properties: { anything: true } };

// ---------------------------------------------------------------------------
// A document that is not an OpenAPI 3 document
// ---------------------------------------------------------------------------

export const swagger2Literal: OpenAPIDocument = {
  openapi: '3.0.4',
  info: { title: 'Pet Store', version: '1' },
  paths: {},
  // @ts-expect-error `host` is a 2.0 field: 3.x describes the host in `servers`
  host: 'pets.example.com',
};

declare const swagger2Document: {
  swagger: string;
  info: { title: string; version: string };
  host: string;
  basePath: string;
  paths: Record<string, never>;
};
// @ts-expect-error a parsed 2.0 document lacks `openapi` (the only error: a variable is not checked for extra fields)
export const swagger2Value: OpenAPIDocument = swagger2Document;

export const stringPaths: OpenAPIDocument = {
  openapi: '3.0.4',
  info: { title: 'Pet Store', version: '1' },
  // @ts-expect-error `paths` is a map of path to Path Item, not a string
  paths: 'paths.yaml',
};

// @ts-expect-error a Path Item holds operations, not a string
export const stringPathItem: OAS31.PathsObject = { '/pets': 'listPets' };

// ---------------------------------------------------------------------------
// Public inputs take an object, not a primitive
// ---------------------------------------------------------------------------

// @ts-expect-error YAML text is a string, not a document object (use `fromYAML`)
lintDocument('openapi: 3.0.0');

// @ts-expect-error a number is not a document
lintDocument(42);

// @ts-expect-error `null` is not a document
lintDocument(null);

// @ts-expect-error `undefined` is not a document
lintDocument(undefined);

// @ts-expect-error a boolean is not a document
lintDocument(true);

// @ts-expect-error the validator takes an object, not text
new Validator().validate('openapi: 3.0.0');

// @ts-expect-error `fromJSON` takes a parsed object, not JSON text
OpenAPIToolGenerator.fromJSON('{"openapi":"3.0.0"}');

// @ts-expect-error a schema is an object, not a type name
toJsonSchema('string');

// @ts-expect-error an operation is an object, not an operation id
extractExtensionOverrides('listPets');

// @ts-expect-error an Arazzo source is a document object or a generator, not a URL
fromArazzo(arazzo, { sources: { api: 'https://pets.example.com/openapi.json' } });

// ---------------------------------------------------------------------------
// Reading a field a version does not have
// ---------------------------------------------------------------------------

// @ts-expect-error `query` operations are new in 3.2
export const query30 = pathItem30.query;

// @ts-expect-error `additionalOperations` are new in 3.2
export const additional30 = pathItem30.additionalOperations;

// @ts-expect-error 3.1 has no `query` operation either
export const query31 = pathItem31.query;

// @ts-expect-error through the cross-version alias, a field only 3.2 defines needs narrowing first
export const queryAny = pathItemAny.query;

// @ts-expect-error a server's `name` is new in 3.2
export const serverName30 = server30.name;

// @ts-expect-error a response's `summary` is new in 3.2
export const summary30 = response30.summary;

// @ts-expect-error a tag's `parent` is new in 3.2
export const parent30 = tag30.parent;

// @ts-expect-error `$self` is new in 3.2
export const self30 = document30.$self;

// @ts-expect-error `$self` is not in 3.1
export const self31 = document31.$self;

// @ts-expect-error a media type's `itemSchema` is new in 3.2
export const itemSchema31 = mediaType31.itemSchema;

// @ts-expect-error an example's `dataValue` is new in 3.2
export const dataValue31 = example31.dataValue;

// @ts-expect-error `nullable` is 3.0 only, so the cross-version Schema Object needs narrowing before it is read
export const nullableAny = schemaAny.nullable;

// ---------------------------------------------------------------------------
// Writing a field a version does not have, in a fresh literal
// ---------------------------------------------------------------------------

// @ts-expect-error `query` operations are not in 3.1
export const query31Literal: OAS31.PathItemObject = { query: { responses: {} } };

// @ts-expect-error a server's `name` is not in 3.1
export const serverName31: OAS31.ServerObject = { url: 'https://example.com', name: 'production' };

// @ts-expect-error a tag's `parent` is not in 3.1
export const parent31: OAS31.TagObject = { name: 'pets', parent: 'nav' };

export const deviceFlow31: OAS31.OAuthFlowsObject = {
  // @ts-expect-error `deviceAuthorization` flows are new in 3.2 (the flow is complete, so this is the only error)
  deviceAuthorization: { deviceAuthorizationUrl: 'https://a', tokenUrl: 'https://t', scopes: {} },
};

// @ts-expect-error `nullable` was replaced by type arrays in 3.1
export const nullable31: OAS31.SchemaObject = { type: 'string', nullable: true };

// @ts-expect-error `exclusiveMinimum` is a boolean in 3.0; the numeric form is 3.1
export const numberExclusive30: OAS30.SchemaObject = { type: 'integer', exclusiveMinimum: 0 };

// @ts-expect-error 3.0 has one `type` per schema; type arrays are 3.1
export const typeArray30: OAS30.SchemaObject = { type: ['string', 'null'] };

// @ts-expect-error `const` is not a 3.0 keyword
export const const30: OAS30.SchemaObject = { const: 'pet' };

// @ts-expect-error `prefixItems` is not a 3.0 keyword
export const prefixItems30: OAS30.SchemaObject = { type: 'array', prefixItems: [{ type: 'string' }] };

// @ts-expect-error 3.0 requires `paths`
export const noPaths30: OAS30.OpenAPIObject = { openapi: '3.0.4', info: { title: 'Pet Store', version: '1' } };

// @ts-expect-error 3.0 requires `responses` on every operation
export const noResponses30: OAS30.OperationObject = { operationId: 'listPets' };

// @ts-expect-error `description` is required in a 3.0 response
export const noDescription30: OAS30.ResponseObject = { content: {} };

// @ts-expect-error `description` is required in a 3.1 response; it is optional from 3.2
export const noDescription31: OAS31.ResponseObject = { content: {} };

// @ts-expect-error `nme` is not a field: a 3.2 server's new field is `name`
export const misspeltServerName32: OAS32.ServerObject = { url: 'https://example.com', nme: 'production' };

// @ts-expect-error the 3.2 device flow field is `deviceAuthorizationUrl`
export const misspeltDeviceUrl32: OAS32.OAuthFlowObject = { deviceAuthorizationURL: 'https://a', scopes: {} };

// @ts-expect-error `nullable` is not a 3.2 keyword either
export const nullable32: OAS32.SchemaObject = { type: 'string', nullable: true };

// ---------------------------------------------------------------------------
// Callbacks are checked strictly: their options are properties, not bivariant methods
// ---------------------------------------------------------------------------

// @ts-expect-error a filter that needs more than the operation it is given is rejected
export const strictFilter: GenerateOptions = { filterFn: filterNeedingMore };

// @ts-expect-error a naming function that accepts only `get` is rejected: it is called with every method
export const strictNamer: NamingStrategy = { toolNameGenerator: namerForGetOnly };

// @ts-expect-error a naming function that accepts only the standard methods is rejected: an `additionalOperations` method such as `LINK` is passed to it too
export const standardOnlyNamer: NamingStrategy = { toolNameGenerator: namerForStandardOnly };

// ---------------------------------------------------------------------------
// HTTP methods: nine standard ones plus any string, but never a non-string
// ---------------------------------------------------------------------------

// @ts-expect-error a method is a string: a status code is not one
export const numberMethod: HTTPMethod = 405;

// @ts-expect-error `includeMethods` holds methods, not status codes
export const numberMethods: GenerateOptions = { includeMethods: ['get', 405] };

/**
 * `Record<HTTPMethod, T>` still takes the standard methods as required keys, now nine: the literal
 * that was exhaustive with eight keys (all but `query`, the 3.2 method) no longer compiles
 * (a literal with all nine, and any further key, does: see methods.types.ts).
 */
// @ts-expect-error property `query` is missing: the standard methods are nine, with `query` from OpenAPI 3.2
export const eightMethods: Record<HTTPMethod, string> = {
  get: 'Read',
  post: 'Create',
  put: 'Replace',
  patch: 'Update',
  delete: 'Remove',
  head: 'Headers',
  options: 'Capabilities',
  trace: 'Echo',
};

/**
 * A switch over the eight old methods, with no default, was exhaustive. The type now also holds
 * `query` and any other string, so the function can fall off its end.
 */
// @ts-expect-error function lacks an ending return statement: add a `default` branch
export function eightMethodSwitch(method: HTTPMethod): string {
  switch (method) {
    case 'get':
      return 'Read';
    case 'post':
    case 'put':
    case 'patch':
      return 'Write';
    case 'delete':
      return 'Remove';
    case 'head':
    case 'options':
    case 'trace':
      return 'Meta';
  }
}

/**
 * `isStandardMethod` returns a boolean, not a type guard (it ignores case, so `GET` is a standard
 * method but not the `StandardMethod` literal `get`): the method stays an `HTTPMethod` after the check, and a
 * lookup that narrows to `StandardMethod` is `getOperation`'s `fixed` entry (see methods.types.ts).
 */
export function isStandardMethodIsNotAGuard(): number {
  if (!isStandardMethod(toolMetadata.method)) return 0;
  // @ts-expect-error an `HTTPMethod` is not narrowed by `isStandardMethod`, so it cannot index a `Record<StandardMethod, number>`
  return countsByMethod[toolMetadata.method];
}

// ---------------------------------------------------------------------------
// OpenAPI versions: 3.0.x, 3.1.x and 3.2.x
// ---------------------------------------------------------------------------

// @ts-expect-error `4.0.0` is not a 3.x version
export const futureVersion: OpenAPIVersion = '4.0.0';

// @ts-expect-error `2.0` is a Swagger version, not an OpenAPI 3.x one
export const swaggerVersion: OpenAPIVersion = '2.0';

// ---------------------------------------------------------------------------
// The generated tool: a whole query string, a parameter's media type, a streamed response
// ---------------------------------------------------------------------------

// @ts-expect-error `wholeQuery` is the literal `true`: an entry that is not a whole query string leaves it out
export const falseWholeQuery: ParameterMapper = { inputKey: 'filter', type: 'query', key: 'filter', wholeQuery: false };

// @ts-expect-error a computed `boolean` is not `true`: set the marker conditionally (`...(flag ? { wholeQuery: true } : {})`)
export const computedWholeQuery: ParameterMapper = { inputKey: 'filter', type: 'query', key: 'filter', wholeQuery: computedFlag };

// @ts-expect-error `wholeQuery` is not `wholeBody`: it holds `true`, not the string `'true'`
export const stringWholeQuery: ParameterMapper = { inputKey: 'filter', type: 'query', key: 'filter', wholeQuery: 'true' };

// @ts-expect-error `querystring` is an OpenAPI parameter location, not a mapper one: the whole query string is a `query` entry marked `wholeQuery`
export const querystringEntry: ParameterMapper = { inputKey: 'filter', type: 'querystring', key: 'filter' };

// @ts-expect-error `ParameterLocation` is the location a value goes to in the request, which `querystring` is not
export const querystringLocation: ParameterLocation = 'querystring';

// @ts-expect-error a media type is a string
export const numericContentType: SerializationInfo = { contentType: 42 };

// @ts-expect-error `itemSchema` is required: a stream without the schema of its items is not described
export const streamWithoutItems: ResponseStreamInfo = { statusCode: 200, contentType: 'application/jsonl' };

// @ts-expect-error `statusCode` is a number (0 for `default`), not the text a document writes
export const stringStatusStream: ResponseStreamInfo = { statusCode: '200', contentType: 'application/jsonl', itemSchema: {} };

// @ts-expect-error `contentType` is a string: it names the media type, it is not a flag
export const flagContentTypeStream: ResponseStreamInfo = { statusCode: 200, contentType: true, itemSchema: {} };

// @ts-expect-error `streaming` is a boolean
export const stringStreaming: ResponseHints = { streaming: 'yes' };

// @ts-expect-error a server's `name` is a string
export const numericServerName: ServerInfo = { url: 'https://api.example.com', name: 1 };

// @ts-expect-error `nme` is not a field: the server's name is `name`
export const misspeltServerInfoName: ServerInfo = { url: 'https://api.example.com', nme: 'production' };

// @ts-expect-error a stream is read from `responseStream`, which only a streamed tool has: it is not `responseStreams`
export const misreadStream = toolMetadata.responseStreams;

export function queryStringIsOptional(): string {
  const request = buildHttpRequest(toolForRequest, {});
  // @ts-expect-error `queryString` is set only when the query is not name/value pairs: narrow `string | undefined` before use
  const raw: string = request.queryString;
  return raw;
}

export function wholeQueryIsNotAlwaysThere(entry: ParameterMapper): true {
  // @ts-expect-error `wholeQuery` is `true | undefined`: an entry that is not a whole query string leaves it out
  return entry.wholeQuery;
}

// @ts-expect-error a misspelt code is not in the registry
export const misspeltDiagnosticCode: DiagnosticCode = 'QUERYSTRING_PARAMETER_MISSING_CONTENT';

// ---------------------------------------------------------------------------
// LoadOptions.documentUri is a string: a URL object is not accepted (it would be a LoadError at runtime)
// ---------------------------------------------------------------------------

// @ts-expect-error `documentUri` is a string: pass `url.href`, not the URL object
export const documentUriAsUrlObject: LoadOptions = { documentUri: new URL('https://example.com/specs/openapi.yaml') };

// ---------------------------------------------------------------------------
// validate() returns an unreadable reference as an error; `code` may be absent
// ---------------------------------------------------------------------------

export function validationCodeIsOptional(result: ValidationResult): string {
  // @ts-expect-error `errors` is absent in a valid result and an error may carry no `code`: the value is `string | undefined`
  return result.errors?.[0]?.code;
}

// ---------------------------------------------------------------------------
// One documentUri cannot be shared by the raw sources of an Arazzo document
// ---------------------------------------------------------------------------

// @ts-expect-error `loadOptions` is shared by every source and has no `documentUri`: load a source with its own and pass the generator
export const arazzoSharedDocumentUri: FromArazzoOptions = { sources: {}, loadOptions: { documentUri: 'https://example.com/openapi.yaml' } };
