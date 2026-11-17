/**
 * The Swagger 2.0 types (`OAS20`), the way a consumer sees them: one realistic
 * document, how it is read, which keys are required and which exist, and what
 * the cross-version aliases (`OpenAPIDocument`, ...) say about it: they are not
 * 2.0 types, because a 2.0 document is converted to OpenAPI 3.0 before the
 * library reads it. The required sets are the ones in the official JSON Schema
 * under `e2e/fixtures/oas/schemas/2.0` (the parity story compares every field).
 * Every `@ts-expect-error` has one reason to fail. Compiled by `yarn typecheck`,
 * never executed (see README.md).
 */
import {
  DIAGNOSTIC_CODES,
  MAX_CONVERSION_ENTRIES,
  MAX_MEDIA_TYPES_PER_LIST,
  OpenAPIToolGenerator,
  Validator,
  upgradeSwagger2,
} from 'mcp-from-openapi';
import type {
  DiagnosticCode,
  OAS20,
  OAS30,
  OAS31,
  OAS32,
  OpenAPIDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  ResponseObject,
  SchemaObject,
  SecuritySchemeObject,
  SpecDiagnostic,
  UpgradeSwagger2Options,
  UpgradeSwagger2Result,
  WithExtensions,
} from 'mcp-from-openapi';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Extends<A, B> = [A] extends [B] ? true : false;
type Not<T extends boolean> = T extends true ? false : true;

/** The keys a value of `T` must have. */
type RequiredKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? never : K }[keyof T];
/** The keys a value of `T` may leave out. */
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
/** Whether `T` declares the key `K`. */
type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;

// ---------------------------------------------------------------------------
// One realistic document: `host`, `basePath` and `schemes` instead of `servers`, `consumes` and `produces`, an
// `in: body` parameter and `in: formData` parameters (one of `type: file`), `collectionFormat`, `definitions`, and an
// oauth2 `accessCode` flow in `securityDefinitions`
// ---------------------------------------------------------------------------

export const oas20: OAS20.SwaggerObject = {
  swagger: '2.0',
  info: {
    title: 'Pet Store',
    description: 'Everything about pets',
    termsOfService: 'https://pets.example.com/terms',
    contact: { name: 'Pet team', url: 'https://pets.example.com', email: 'pets@example.com' },
    license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    version: '1.0.0',
  },
  host: 'pets.example.com',
  basePath: '/v1',
  schemes: ['https', 'wss'],
  consumes: ['application/json'],
  produces: ['application/json'],
  tags: [{ name: 'pets', description: 'Everything about pets', externalDocs: { url: 'https://docs.example.com/pets' } }],
  externalDocs: { description: 'The handbook', url: 'https://docs.example.com' },
  security: [{ oauth: ['read:pets'] }, {}],
  securityDefinitions: {
    basic: { type: 'basic', description: 'A user name and a password' },
    apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
    oauth: {
      type: 'oauth2',
      flow: 'accessCode',
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: { 'read:pets': 'Read pets', 'write:pets': 'Change pets' },
    },
  },
  parameters: {
    PageSize: { name: 'limit', in: 'query', type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  responses: {
    NotFound: { description: 'Not found', schema: { $ref: '#/definitions/Error' } },
  },
  paths: {
    '/pets': {
      parameters: [{ $ref: '#/parameters/PageSize' }],
      get: {
        tags: ['pets'],
        summary: 'List pets',
        operationId: 'listPets',
        produces: ['application/json', 'text/csv'],
        parameters: [
          {
            name: 'kinds',
            in: 'query',
            type: 'array',
            items: { type: 'string', enum: ['dog', 'cat'] },
            collectionFormat: 'multi',
          },
          {
            name: 'ids',
            in: 'query',
            type: 'array',
            items: { type: 'integer', format: 'int64' },
            collectionFormat: 'csv',
            minItems: 1,
            uniqueItems: true,
          },
          { name: 'X-Request-Id', in: 'header', type: 'string', pattern: '^[a-f0-9-]+$' },
        ],
        responses: {
          '200': {
            description: 'A page of pets',
            schema: { type: 'array', items: { $ref: '#/definitions/Pet' } },
            headers: {
              'X-Next': { type: 'string', description: 'The next page' },
              'X-Total': { type: 'integer', format: 'int32' },
              'X-Tags': { type: 'array', items: { type: 'string' }, collectionFormat: 'pipes' },
            },
            examples: { 'application/json': [{ name: 'Rex' }] },
          },
          default: { $ref: '#/responses/NotFound' },
        },
        security: [{ oauth: ['read:pets'] }],
      },
      post: {
        operationId: 'createPet',
        consumes: ['application/json'],
        parameters: [{ name: 'pet', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }],
        responses: { '201': { description: 'Created' }, '400': { $ref: '#/responses/NotFound' } },
        deprecated: false,
        schemes: ['https'],
      },
    },
    '/pets/{petId}/photo': {
      put: {
        operationId: 'uploadPhoto',
        consumes: ['multipart/form-data'],
        parameters: [
          { name: 'petId', in: 'path', required: true, type: 'string' },
          { name: 'caption', in: 'formData', type: 'string', allowEmptyValue: true },
          { name: 'photo', in: 'formData', required: true, type: 'file' },
        ],
        responses: { '204': { description: 'Stored' } },
      },
      get: {
        operationId: 'getPhoto',
        produces: ['image/png'],
        responses: { '200': { description: 'The photo', schema: { type: 'file' } } },
      },
    },
  },
  definitions: {
    Pet: {
      type: 'object',
      required: ['name'],
      discriminator: 'kind',
      properties: {
        id: { type: 'integer', format: 'int64', readOnly: true },
        name: { type: 'string', maxLength: 64 },
        kind: { type: 'string' },
        age: { type: 'integer', minimum: 0, exclusiveMinimum: true, maximum: 40, exclusiveMaximum: false },
        tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        status: { type: 'string', enum: ['available', 'sold'], default: 'available' },
      },
      xml: { name: 'pet', wrapped: false },
      externalDocs: { url: 'https://docs.example.com/pet' },
      example: { name: 'Rex' },
    },
    Dog: {
      allOf: [{ $ref: '#/definitions/Pet' }, { type: 'object', properties: { barks: { type: 'boolean' } } }],
    },
    Labels: { type: 'object', additionalProperties: { type: 'string' } },
    Error: { type: 'object', required: ['message'], properties: { message: { type: 'string' } }, additionalProperties: false },
  },
};

/** The smallest document the official schema accepts, as an inferred type (a variable, not a literal to check for extras). */
const minimal20 = { swagger: '2.0', info: { title: 'Pet Store', version: '1.0.0' }, paths: {} } satisfies OAS20.SwaggerObject;

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/** The names of the `formData` parameters that are files: a parameter or a reference is told apart by `$ref`. */
export function fileParameters(operation: OAS20.OperationObject): string[] {
  return (operation.parameters ?? []).flatMap((parameter) =>
    '$ref' in parameter ? [] : parameter.in === 'formData' && parameter.type === 'file' ? [parameter.name] : [],
  );
}

/** An `in: body` parameter carries the schema of the whole request body, every other location a `type`. */
export function bodySchema(operation: OAS20.OperationObject): OAS20.SchemaObject | undefined {
  for (const parameter of operation.parameters ?? []) {
    if (!('$ref' in parameter) && parameter.in === 'body') return parameter.schema;
  }
  return undefined;
}

/** How an array parameter is serialized: the format, defaulting to `csv`. */
export function arrayFormat(parameter: OAS20.ParameterObject): string {
  const format: string | undefined = parameter.collectionFormat;
  return parameter.type === 'array' ? (format ?? 'csv') : 'none';
}

export function oauthFlow(scheme: OAS20.SecuritySchemeObject): string | undefined {
  if (scheme.type !== 'oauth2') return undefined;
  const scopes: string[] = Object.keys(scheme.scopes ?? {});
  return `${scheme.flow ?? 'unknown'} ${scheme.authorizationUrl ?? scheme.tokenUrl ?? ''} ${scopes.join(',')}`;
}

/** The effective transfer protocols: an operation's `schemes` replace the root's. */
export function schemesOf(document: OAS20.SwaggerObject, operation: OAS20.OperationObject): string[] {
  return operation.schemes ?? document.schemes ?? [];
}

/** Maps hold a value or nothing: a lookup can miss. */
export function definitionNamed(document: OAS20.SwaggerObject, name: string): OAS20.SchemaObject | undefined {
  return document.definitions?.[name];
}

/** `x-` extensions are read through `WithExtensions`, as in the other versions (2.0 documents use `x-nullable` a lot). */
export const nullableName: WithExtensions<OAS20.SchemaObject> = { type: 'string', 'x-nullable': true };
export const swaggerWithExtensions: WithExtensions<OAS20.SwaggerObject> = { ...oas20, 'x-generated-by': 'a tool' };
export const isNullable: unknown = (nullableName as WithExtensions<OAS20.SchemaObject>)['x-nullable'];
/** Dropping the helper is always allowed. */
export const plainSwagger: OAS20.SwaggerObject = swaggerWithExtensions;

/** Free-form values (`default`, `enum` members, `example`) are `any` in 2.0 too: read as the document holds them. */
export function readFreeFormValues(schema: OAS20.SchemaObject, parameter: OAS20.ParameterObject): unknown[] {
  return [schema.example?.name, schema.default.length, schema.enum?.map((value) => value.toUpperCase()), parameter.default?.x];
}

// ---------------------------------------------------------------------------
// Every public entry that takes a parsed document takes a 2.0 one
// ---------------------------------------------------------------------------

export async function swaggerReachesEveryEntry(): Promise<void> {
  await OpenAPIToolGenerator.fromJSON(oas20);
  await OpenAPIToolGenerator.fromJSON(minimal20);
  await OpenAPIToolGenerator.fromJSON(swaggerWithExtensions);
  await new Validator().validate(oas20);
  await new Validator().validate(minimal20);
}

// ---------------------------------------------------------------------------
// The conversion as a function: `upgradeSwagger2`
// ---------------------------------------------------------------------------

declare const oas30Result: UpgradeSwagger2Result;

/** The converted document is an OpenAPI 3.0 one, whatever options say about where the 2.0 document came from. */
export function convertSwagger(document: OAS20.SwaggerObject): OAS30.OpenAPIObject {
  const options: UpgradeSwagger2Options = { documentUri: 'https://pets.example.com/swagger.yaml', maxEntries: 50_000 };
  const result: UpgradeSwagger2Result = upgradeSwagger2(document, options);
  return result.document;
}

/** Any value is taken (a document read from anywhere), the options are optional, and `null` or `undefined` is no options. */
export const convertedUnknown: UpgradeSwagger2Result = upgradeSwagger2(JSON.parse('{}') as unknown);
export const convertedWithNull: UpgradeSwagger2Result = upgradeSwagger2(oas20, null);
export const convertedWithUndefined: UpgradeSwagger2Result = upgradeSwagger2(oas20, undefined);
export const convertedWithEmpty: UpgradeSwagger2Result = upgradeSwagger2(oas20, {});
export const convertedOnlyUri: UpgradeSwagger2Result = upgradeSwagger2(oas20, { documentUri: 'https://pets.example.com/swagger.yaml' });
export const convertedOnlyBudget: UpgradeSwagger2Result = upgradeSwagger2(oas20, { maxEntries: 1000 });

/** A conversion abandoned for being too large says so with `tooLarge: true`, and its last diagnostic with the code. */
export function wasAbandoned(result: UpgradeSwagger2Result): boolean {
  const flag: true | undefined = result.tooLarge;
  const last: SpecDiagnostic | undefined = result.diagnostics[result.diagnostics.length - 1];
  return flag === true && last?.code === DIAGNOSTIC_CODES.SWAGGER_CONVERSION_TOO_LARGE;
}

/** Where a parameter of a converted `parameters` list was in the 2.0 list: a list is a key, so any object will do. */
export function sourceIndex(result: UpgradeSwagger2Result, converted: object, index: number): number {
  return result.parameterIndexes.get(converted)?.[index] ?? index;
}

/** The converted document is read like any OpenAPI 3.0 one: servers, components and an operation with a request body. */
export function readConverted(result: UpgradeSwagger2Result): string[] {
  const document: OAS30.OpenAPIObject = result.document;
  const urls: string[] = (document.servers ?? []).map((server) => server.url);
  const schemes: string[] = Object.keys(document.components?.securitySchemes ?? {});
  return [document.openapi, ...urls, ...schemes];
}

/** The bounds are numbers to compare with or pass back; a budget at the most is the default. */
export const mediaTypeCap: number = MAX_MEDIA_TYPES_PER_LIST;
export const largestBudget: UpgradeSwagger2Options = { maxEntries: MAX_CONVERSION_ENTRIES };

/**
 * `document` says which document a diagnostic's `path` is into, for a Swagger 2.0 document: `source` (the 2.0 one as
 * written), `converted` (the OpenAPI 3.0 one generation reads) or, for any other document, nothing. A switch over it
 * with no `default` is exhaustive.
 */
export function whereItPoints(diagnostic: SpecDiagnostic): string {
  const path: string = diagnostic.path ?? '';
  switch (diagnostic.document) {
    case 'source':
      return `${path} in the Swagger 2.0 document as written`;
    case 'converted':
      return `${path} in the OpenAPI 3.0 document it was converted to`;
    case undefined:
      return `${path} in the only document there is`;
    default: {
      const unreachable: never = diagnostic.document;
      return unreachable;
    }
  }
}

export async function pointersIntoTheSource(generator: OpenAPIToolGenerator): Promise<string[]> {
  await generator.generateTools();
  return generator.getDiagnostics().flatMap(({ document, path }) => (document === 'source' && path !== undefined ? [path] : []));
}

/** A diagnostic of the conversion is found by its code, from the one registry. */
export const limitCode: DiagnosticCode = DIAGNOSTIC_CODES.SWAGGER_MEDIA_TYPE_LIMIT;
export const tooLargeCode: DiagnosticCode = 'SWAGGER_CONVERSION_TOO_LARGE';

// ---------------------------------------------------------------------------
// Required keys: the ones of the official 2.0 schema
// ---------------------------------------------------------------------------

export type RequiredKeysOfEachObject = [
  Expect<Equal<RequiredKeys<OAS20.SwaggerObject>, 'swagger' | 'info' | 'paths'>>,
  Expect<Equal<RequiredKeys<OAS20.InfoObject>, 'title' | 'version'>>,
  Expect<Equal<RequiredKeys<OAS20.LicenseObject>, 'name'>>,
  Expect<Equal<RequiredKeys<OAS20.ContactObject>, never>>,
  Expect<Equal<RequiredKeys<OAS20.PathItemObject>, never>>,
  Expect<Equal<RequiredKeys<OAS20.OperationObject>, 'responses'>>,
  Expect<Equal<RequiredKeys<OAS20.ExternalDocumentationObject>, 'url'>>,
  Expect<Equal<RequiredKeys<OAS20.ResponseObject>, 'description'>>,
  Expect<Equal<RequiredKeys<OAS20.HeaderObject>, 'type'>>,
  Expect<Equal<RequiredKeys<OAS20.TagObject>, 'name'>>,
  Expect<Equal<RequiredKeys<OAS20.ReferenceObject>, '$ref'>>,
  Expect<Equal<RequiredKeys<OAS20.SecuritySchemeObject>, 'type'>>,
  Expect<Equal<RequiredKeys<OAS20.SchemaObject>, never>>,
  Expect<Equal<RequiredKeys<OAS20.XMLObject>, never>>,
];

/**
 * A parameter requires its `name` and `in` whichever location it is in: the schema's `parameter` is a `oneOf` over a
 * body parameter (requiring `schema`) and four others (requiring `type`), and no field but those two is required by all
 * of them. The Items Object requires nothing, although the text calls its `type` required.
 */
export type ParameterRequiredKeys = [
  Expect<Equal<RequiredKeys<OAS20.ParameterObject>, 'name' | 'in'>>,
  Expect<Extends<'schema' | 'type' | 'required', OptionalKeys<OAS20.ParameterObject>>>,
  Expect<Equal<RequiredKeys<OAS20.ItemsObject>, never>>,
  Expect<Extends<'type', OptionalKeys<OAS20.ItemsObject>>>,
];

/** Maps are string-keyed and hold a value or nothing: a lookup can miss. */
export type MapsHoldOptionalValues = [
  Expect<Equal<OAS20.PathsObject[string], OAS20.PathItemObject | undefined>>,
  Expect<Equal<OAS20.ResponsesObject[string], OAS20.ResponseObject | OAS20.ReferenceObject | undefined>>,
  Expect<Equal<OAS20.DefinitionsObject[string], OAS20.SchemaObject | undefined>>,
  Expect<Equal<OAS20.ParametersDefinitionsObject[string], OAS20.ParameterObject | undefined>>,
  Expect<Equal<OAS20.ResponsesDefinitionsObject[string], OAS20.ResponseObject | undefined>>,
  Expect<Equal<OAS20.SecurityDefinitionsObject[string], OAS20.SecuritySchemeObject | undefined>>,
  Expect<Equal<OAS20.HeadersObject[string], OAS20.HeaderObject | undefined>>,
  Expect<Equal<OAS20.ScopesObject[string], string | undefined>>,
  Expect<Equal<OAS20.SecurityRequirementObject[string], string[] | undefined>>,
];

// ---------------------------------------------------------------------------
// Keys 2.0 has and 3.x does not, and the reverse
// ---------------------------------------------------------------------------

export type Swagger2Only = [
  Expect<Has<OAS20.SwaggerObject, 'swagger'>>,
  Expect<Has<OAS20.SwaggerObject, 'host'>>,
  Expect<Has<OAS20.SwaggerObject, 'basePath'>>,
  Expect<Has<OAS20.SwaggerObject, 'schemes'>>,
  Expect<Has<OAS20.SwaggerObject, 'consumes'>>,
  Expect<Has<OAS20.SwaggerObject, 'produces'>>,
  Expect<Has<OAS20.SwaggerObject, 'definitions'>>,
  Expect<Has<OAS20.SwaggerObject, 'securityDefinitions'>>,
  Expect<Has<OAS20.OperationObject, 'consumes'>>,
  Expect<Has<OAS20.OperationObject, 'schemes'>>,
  // a parameter is typed in place; there is no `content`, `style`, `explode` or request body
  Expect<Has<OAS20.ParameterObject, 'type'>>,
  Expect<Has<OAS20.ParameterObject, 'collectionFormat'>>,
  Expect<Has<OAS20.ParameterObject, 'items'>>,
  Expect<Has<OAS20.ParameterObject, 'allowEmptyValue'>>,
  Expect<Has<OAS20.ResponseObject, 'examples'>>,
  Expect<Has<OAS20.HeaderObject, 'type'>>,
  Expect<Has<OAS20.SecuritySchemeObject, 'flow'>>,
  Expect<Has<OAS20.SecuritySchemeObject, 'scopes'>>,
  // the 2.0 Schema Object keeps `discriminator` a string and the exclusive bounds booleans
  Expect<Has<OAS20.SchemaObject, 'readOnly'>>,
  Expect<Has<OAS20.SchemaObject, 'discriminator'>>,
];

export type NotInSwagger2 = [
  Expect<Not<Has<OAS20.SwaggerObject, 'openapi'>>>,
  Expect<Not<Has<OAS20.SwaggerObject, 'servers'>>>,
  Expect<Not<Has<OAS20.SwaggerObject, 'components'>>>,
  Expect<Not<Has<OAS20.SwaggerObject, 'webhooks'>>>,
  Expect<Not<Has<OAS20.SwaggerObject, '$self'>>>,
  Expect<Not<Has<OAS20.PathItemObject, 'trace'>>>,
  Expect<Not<Has<OAS20.PathItemObject, 'query'>>>,
  Expect<Not<Has<OAS20.PathItemObject, 'servers'>>>,
  Expect<Not<Has<OAS20.PathItemObject, 'summary'>>>,
  Expect<Not<Has<OAS20.OperationObject, 'requestBody'>>>,
  Expect<Not<Has<OAS20.OperationObject, 'callbacks'>>>,
  Expect<Not<Has<OAS20.OperationObject, 'servers'>>>,
  Expect<Not<Has<OAS20.ParameterObject, 'content'>>>,
  Expect<Not<Has<OAS20.ParameterObject, 'style'>>>,
  Expect<Not<Has<OAS20.ParameterObject, 'explode'>>>,
  Expect<Not<Has<OAS20.ParameterObject, 'example'>>>,
  Expect<Not<Has<OAS20.ResponseObject, 'content'>>>,
  Expect<Not<Has<OAS20.ResponseObject, 'links'>>>,
  Expect<Not<Has<OAS20.SecuritySchemeObject, 'flows'>>>,
  Expect<Not<Has<OAS20.SecuritySchemeObject, 'scheme'>>>,
  Expect<Not<Has<OAS20.SecuritySchemeObject, 'openIdConnectUrl'>>>,
  Expect<Not<Has<OAS20.SchemaObject, 'nullable'>>>,
  Expect<Not<Has<OAS20.SchemaObject, 'oneOf'>>>,
  Expect<Not<Has<OAS20.SchemaObject, 'anyOf'>>>,
  Expect<Not<Has<OAS20.SchemaObject, 'not'>>>,
  Expect<Not<Has<OAS20.SchemaObject, 'const'>>>,
  Expect<Not<Has<OAS20.SchemaObject, 'prefixItems'>>>,
];

/** What a field holds: the 2.0 forms differ from the 3.x ones. */
export type FieldTypes = [
  Expect<Equal<OAS20.SwaggerObject['swagger'], string>>,
  Expect<Equal<OAS20.SchemaObject['discriminator'], string | undefined>>,
  Expect<Equal<OAS20.SchemaObject['exclusiveMinimum'], boolean | undefined>>,
  Expect<Equal<OAS20.SchemaObject['exclusiveMaximum'], boolean | undefined>>,
  Expect<Equal<OAS20.ParameterObject['required'], boolean | undefined>>,
  Expect<Equal<OAS20.ParameterObject['schema'], OAS20.SchemaObject | undefined>>,
  Expect<Equal<OAS20.ParameterObject['items'], OAS20.ItemsObject | undefined>>,
  Expect<Equal<OAS20.ItemsObject['items'], OAS20.ItemsObject | undefined>>,
  Expect<Equal<OAS20.ResponseObject['schema'], OAS20.SchemaObject | undefined>>,
  Expect<Equal<OAS20.ResponseObject['headers'], OAS20.HeadersObject | undefined>>,
  Expect<Equal<OAS20.OperationObject['security'], OAS20.SecurityRequirementObject[] | undefined>>,
  Expect<Equal<OAS20.SecuritySchemeObject['scopes'], OAS20.ScopesObject | undefined>>,
  // enumerated strings are open, as in every version
  Expect<Extends<'body' | 'formData' | 'query' | 'header' | 'path', OAS20.ParameterObject['in']>>,
  Expect<Extends<string, OAS20.ParameterObject['in']>>,
  Expect<Extends<'string' | 'number' | 'integer' | 'boolean' | 'array' | 'file', NonNullable<OAS20.ParameterObject['type']>>>,
  Expect<Extends<'basic' | 'apiKey' | 'oauth2', OAS20.SecuritySchemeObject['type']>>,
  Expect<Extends<'implicit' | 'password' | 'application' | 'accessCode', NonNullable<OAS20.SecuritySchemeObject['flow']>>>,
  Expect<Extends<string, OAS20.SecuritySchemeObject['type']>>,
];

// ---------------------------------------------------------------------------
// Not part of the cross-version aliases
// ---------------------------------------------------------------------------

/**
 * The aliases are unions of the 3.0, 3.1 and 3.2 objects, nothing else: Swagger 2.0 appears only under `OAS20`. The
 * unions are exactly their three members, and a 2.0 document is not an `OpenAPIDocument` (nor the reverse).
 */
export type AliasesAreOpenApi3 = [
  Expect<Equal<OpenAPIDocument, OAS30.OpenAPIObject | OAS31.OpenAPIObject | OAS32.OpenAPIObject>>,
  Expect<Equal<OperationObject, OAS30.OperationObject | OAS31.OperationObject | OAS32.OperationObject>>,
  Expect<Equal<ParameterObject, OAS30.ParameterObject | OAS31.ParameterObject | OAS32.ParameterObject>>,
  Expect<Equal<SchemaObject, OAS30.SchemaObject | OAS31.SchemaObject | OAS32.SchemaObject>>,
  Expect<Equal<ResponseObject, OAS30.ResponseObject | OAS31.ResponseObject | OAS32.ResponseObject>>,
  Expect<Equal<PathItemObject, OAS30.PathItemObject | OAS31.PathItemObject | OAS32.PathItemObject>>,
  Expect<Equal<SecuritySchemeObject, OAS30.SecuritySchemeObject | OAS31.SecuritySchemeObject | OAS32.SecuritySchemeObject>>,
  Expect<Not<Extends<OAS20.SwaggerObject, OpenAPIDocument>>>,
  Expect<Not<Extends<OAS20.SwaggerObject, OAS30.OpenAPIObject>>>,
  Expect<Not<Extends<OAS20.SwaggerObject, OAS31.OpenAPIObject>>>,
  Expect<Not<Extends<OAS20.SwaggerObject, OAS32.OpenAPIObject>>>,
  Expect<Not<Extends<OpenAPIDocument, OAS20.SwaggerObject>>>,
];

/** The control for the rejection below: the 2.0 document with an `openapi` member is an OpenAPI 3 document. */
export const withOpenapiMember: OpenAPIDocument = { ...minimal20, openapi: '3.0.4' };

// @ts-expect-error a 2.0 document has `swagger` where an OpenAPI 3 one has `openapi`: nothing else of this document differs (see `withOpenapiMember`)
export const swaggerAsDocument: OpenAPIDocument = minimal20;

// ---------------------------------------------------------------------------
// Rejections: what 2.0 does not have, and what it requires
// ---------------------------------------------------------------------------

const info20 = { title: 'Pet Store', version: '1.0.0' };

// @ts-expect-error `hosts` is not a field: the Swagger Object spells it `host`
export const misspeltHost: OAS20.SwaggerObject = { swagger: '2.0', info: info20, paths: {}, hosts: 'pets.example.com' };

// @ts-expect-error `servers` is OpenAPI 3: Swagger 2.0 says where the API is with `host`, `basePath` and `schemes`
export const servers20: OAS20.SwaggerObject = { swagger: '2.0', info: info20, paths: {}, servers: [{ url: 'https://pets.example.com' }] };

// @ts-expect-error `components` is OpenAPI 3: reusable objects are `definitions`, `parameters`, `responses` and `securityDefinitions` in 2.0
export const components20: OAS20.SwaggerObject = { swagger: '2.0', info: info20, paths: {}, components: {} };

// @ts-expect-error a Swagger document declares `swagger`, never `openapi`
export const openapiMember20: OAS20.SwaggerObject = { swagger: '2.0', openapi: '3.0.4', info: info20, paths: {} };

// @ts-expect-error `swagger` is required in the Swagger Object
export const noSwaggerMember: OAS20.SwaggerObject = { info: info20, paths: {} };

// @ts-expect-error `paths` is required in the Swagger Object (it is optional from OpenAPI 3.1)
export const noPaths20: OAS20.SwaggerObject = { swagger: '2.0', info: info20 };

// @ts-expect-error `schemes` is a list of protocols, not one
export const stringSchemes: OAS20.SwaggerObject = { swagger: '2.0', info: info20, paths: {}, schemes: 'https' };

// @ts-expect-error `responses` is required in every 2.0 operation
export const noResponses20: OAS20.OperationObject = { operationId: 'listPets' };

// @ts-expect-error a request body is an `in: body` parameter in 2.0: `requestBody` is OpenAPI 3
export const requestBody20: OAS20.OperationObject = { responses: {}, requestBody: { content: {} } };

// @ts-expect-error `trace` is not a Path Item operation in 2.0
export const trace20: OAS20.PathItemObject = { trace: { responses: {} } };

// @ts-expect-error `description` is required in a 2.0 response
export const noDescription20: OAS20.ResponseObject = { schema: {} };

// @ts-expect-error `content` is OpenAPI 3: a 2.0 response has a `schema` and the operation's `produces`
export const content20: OAS20.ResponseObject = { description: 'ok', content: {} };

// @ts-expect-error `in` is required in a 2.0 parameter
export const noLocation20: OAS20.ParameterObject = { name: 'id', type: 'string' };

// @ts-expect-error `content` is OpenAPI 3: a 2.0 parameter is typed in place
export const parameterContent20: OAS20.ParameterObject = { name: 'id', in: 'query', content: {} };

// @ts-expect-error `style` is OpenAPI 3: a 2.0 array is serialized by `collectionFormat`
export const parameterStyle20: OAS20.ParameterObject = { name: 'ids', in: 'query', type: 'array', style: 'form' };

// @ts-expect-error `collectionFormat` is one format, not a list of them
export const listFormat: OAS20.ParameterObject = { name: 'ids', in: 'query', type: 'array', collectionFormat: ['csv'] };

// @ts-expect-error `type` is required in a header
export const noHeaderType: OAS20.HeaderObject = { description: 'The next page' };

// @ts-expect-error `nullable` is OpenAPI 3.0: Swagger 2.0 documents use the `x-nullable` extension (read through `WithExtensions`)
export const nullable20: OAS20.SchemaObject = { type: 'string', nullable: true };

// @ts-expect-error `oneOf` is not a 2.0 keyword (`allOf` is the only combinator)
export const oneOf20: OAS20.SchemaObject = { oneOf: [{ type: 'string' }] };

// @ts-expect-error `exclusiveMinimum` is a boolean in 2.0 (the numeric form is OpenAPI 3.1)
export const numericExclusive20: OAS20.SchemaObject = { type: 'integer', minimum: 0, exclusiveMinimum: 0 };

// @ts-expect-error `discriminator` is a property name in 2.0 (an object with `propertyName` is OpenAPI 3)
export const discriminator20: OAS20.SchemaObject = { type: 'object', discriminator: { propertyName: 'kind' } };

// @ts-expect-error `flows` is OpenAPI 3: a 2.0 oauth2 definition is one flow, named by `flow`
export const flows20: OAS20.SecuritySchemeObject = { type: 'oauth2', flows: {} };

// @ts-expect-error scopes are a map of names to descriptions, not a list
export const listScopes: OAS20.SecuritySchemeObject = { type: 'oauth2', flow: 'implicit', scopes: ['read'] };

// @ts-expect-error `type` is required in a security definition
export const noSecurityType: OAS20.SecuritySchemeObject = { description: 'A key' };

// @ts-expect-error `url` is required in the External Documentation Object
export const noDocsUrl: OAS20.ExternalDocumentationObject = { description: 'The handbook' };

// @ts-expect-error a Reference Object is `$ref` and nothing else
export const referenceSummary: OAS20.ReferenceObject = { $ref: '#/definitions/Pet', summary: 'A pet' };

// @ts-expect-error `title` is required in the Info Object
export const noTitle20: OAS20.InfoObject = { version: '1.0.0' };

// ---------------------------------------------------------------------------
// Rejections: the conversion as a function, and which document a diagnostic points into
// ---------------------------------------------------------------------------

// @ts-expect-error `document` is `source` or `converted`: `other` is neither
export const otherDocument: SpecDiagnostic = { severity: 'warning', code: 'SWAGGER_INVALID_VALUE', message: 'm', path: '/a', document: 'other' };

// @ts-expect-error the values are lower-case: `Source` is not `source`
export const capitalMarker: SpecDiagnostic['document'] = 'Source';

export function misspeltMarker(diagnostic: SpecDiagnostic): string {
  switch (diagnostic.document) {
    // @ts-expect-error `converter` is no document: `source`, `converted` or nothing
    case 'converter':
      return 'the converter';
    default:
      return 'other';
  }
}

// @ts-expect-error `maxEntries` is a number, not the text of one
upgradeSwagger2(oas20, { maxEntries: '1000' });

// @ts-expect-error `documentUri` is a string, not a `URL`
upgradeSwagger2(oas20, { documentUri: new URL('https://pets.example.com/swagger.yaml') });

// @ts-expect-error the option is `maxEntries`, not `maxEntry`
upgradeSwagger2(oas20, { maxEntry: 1000 });

// @ts-expect-error the document to convert is required
upgradeSwagger2();

// @ts-expect-error `upgradeSwagger2` takes a document and options, nothing else
upgradeSwagger2(oas20, {}, 3);

// @ts-expect-error `tooLarge` is `true` when the conversion was abandoned and absent otherwise: it is never `false`
export const neverFalse: UpgradeSwagger2Result['tooLarge'] = false;

// @ts-expect-error a `parameters` list is an object (a WeakMap key), not the text of its pointer
oas30Result.parameterIndexes.get('/paths/~1pets/get/parameters');

// @ts-expect-error the converted document is OpenAPI 3.0: it has no `host`, only `servers`
export const convertedHost = upgradeSwagger2(oas20).document.host;

// @ts-expect-error the converted document is OpenAPI 3.0: it is declared by `openapi`, not `swagger`
export const convertedSwagger = upgradeSwagger2(oas20).document.swagger;

// @ts-expect-error the code is `SWAGGER_MEDIA_TYPE_LIMIT`, in the singular
export const misspeltLimitCode: DiagnosticCode = 'SWAGGER_MEDIA_TYPES_LIMIT';

// @ts-expect-error the bounds are constants: they are read, not set
MAX_MEDIA_TYPES_PER_LIST = 64;
