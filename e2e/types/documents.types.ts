/**
 * Documents the OpenAPI types must accept. Compiled by `yarn typecheck`, never
 * executed (see README.md). Everything is imported from the package entry, as
 * a consumer would.
 */
import {
  OpenAPIToolGenerator,
  Validator,
  applyOverlay,
  extractExtensionOverrides,
  fromArazzo,
  lintDocument,
  resolveExtensionEnabled,
  toJsonSchema,
} from 'mcp-from-openapi';
import type {
  ArazzoDocument,
  OAS30,
  OAS31,
  OAS32,
  OpenAPIDocument,
  OperationObject,
  ParameterObject,
  PathItemObject,
  SchemaObject,
  SchemaOrBoolean,
  SecuritySchemeObject,
  ServerObject,
} from 'mcp-from-openapi';

type Expect<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

// ---------------------------------------------------------------------------
// 1. A consumer's own interface-typed document. Interfaces have no implicit
//    index signature, so a type that declared one would reject every value
//    below. Each public entry that takes a spec value accepts any object.
// ---------------------------------------------------------------------------

interface AppSchema {
  type: string;
  format?: string;
  properties?: Record<string, AppSchema>;
  required?: string[];
}

interface AppParameter {
  name: string;
  in: string;
  required?: boolean;
  style?: string;
  schema?: AppSchema;
}

interface AppResponse {
  description: string;
  content?: Record<string, { schema?: AppSchema }>;
}

interface AppOperation {
  operationId?: string;
  tags?: string[];
  parameters?: AppParameter[];
  responses: Record<string, AppResponse>;
}

interface AppPathItem {
  summary?: string;
  get?: AppOperation;
  post?: AppOperation;
  parameters?: AppParameter[];
}

interface AppServer {
  url: string;
  description?: string;
}

interface AppInfo {
  title: string;
  version: string;
}

interface AppDocument {
  openapi: string;
  info: AppInfo;
  servers?: AppServer[];
  paths: Record<string, AppPathItem>;
  components?: { schemas?: Record<string, AppSchema> };
}

declare const appDocument: AppDocument;
declare const appOperation: AppOperation;
declare const appPathItem: AppPathItem;
declare const appSchema: AppSchema;
declare const appArazzo: ArazzoDocument;

/** Every public entry that takes a spec value accepts the interface-typed document. */
export async function interfaceDocumentsReachEveryEntry(): Promise<void> {
  const generator = await OpenAPIToolGenerator.fromJSON(appDocument);
  await generator.generateTools();
  await new Validator().validate(appDocument);
  lintDocument(appDocument);
  toJsonSchema(appSchema);
  extractExtensionOverrides(appOperation);
  resolveExtensionEnabled(appDocument, appPathItem, appOperation);
  applyOverlay(appDocument, { overlay: '1.0.0', info: { title: 'o', version: '1' }, actions: [] });
  await fromArazzo(appArazzo, { sources: { api: appDocument } });
}

/** Interface-typed pieces assign to the aliases without a cast. */
export const interfacePieces = {
  operation: appOperation satisfies OperationObject,
  pathItem: appPathItem satisfies PathItemObject,
  parameter: appOperation.parameters![0]! satisfies ParameterObject,
  server: appDocument.servers![0]! satisfies ServerObject,
  schema: appSchema satisfies SchemaObject,
  document: appDocument satisfies OpenAPIDocument,
};

/** Every version's types accept it too: an index signature in any one of them would reject the interfaces. */
export const interfaceDocuments = {
  v30: appDocument satisfies OAS30.OpenAPIObject,
  v31: appDocument satisfies OAS31.OpenAPIObject,
  v32: appDocument satisfies OAS32.OpenAPIObject,
};

// ---------------------------------------------------------------------------
// 2. A loosely typed document: every enumerated field is a plain `string`,
//    as in a document parsed from JSON or YAML and cast once.
// ---------------------------------------------------------------------------

type LooseDocument = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<
    string,
    {
      get?: {
        operationId?: string;
        parameters?: Array<{
          name: string;
          in: string;
          style?: string;
          schema?: { type: string; format?: string };
        }>;
        responses: Record<string, { description: string }>;
      };
    }
  >;
  components?: {
    securitySchemes?: Record<string, { type: string; in?: string; name?: string; scheme?: string }>;
  };
};

declare const looseDocument: LooseDocument;
declare const looseSecurityScheme: { type: string; in?: string; name?: string };
declare const looseSchema: { type: string; format?: string; items?: { type: string } };

export const looseAsAlias: OpenAPIDocument = looseDocument;
export const looseAs30: OAS30.OpenAPIObject = looseDocument;
export const looseAs31: OAS31.OpenAPIObject = looseDocument;
export const looseAs32: OAS32.OpenAPIObject = looseDocument;
export const looseSecurityAsAlias: SecuritySchemeObject = looseSecurityScheme;
export const looseSchemaAsAlias: SchemaObject = looseSchema;
export const looseSchemaAsBoolean: SchemaOrBoolean = looseSchema;

/** Enumerated fields stay open: a value the spec does not list still compiles. */
export const openEnumerations: ParameterObject = { name: 'q', in: 'custom-location', style: 'custom-style' };

// ---------------------------------------------------------------------------
// 3. One realistic document per version, annotated with the version's type.
// ---------------------------------------------------------------------------

/** 3.0: `nullable`, boolean `exclusiveMinimum`, responses required. */
export const oas30: OAS30.OpenAPIObject = {
  openapi: '3.0.4',
  info: {
    title: 'Pet Store',
    version: '1.0.0',
    license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  },
  servers: [
    { url: 'https://{region}.pets.example.com/v1', variables: { region: { default: 'eu', enum: ['eu', 'us'] } } },
  ],
  security: [{ apiKey: [] }],
  tags: [{ name: 'pets', description: 'Everything about pets' }],
  paths: {
    '/pets': {
      parameters: [{ $ref: '#/components/parameters/Trace' }],
      get: {
        operationId: 'listPets',
        tags: ['pets'],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer', minimum: 0, exclusiveMinimum: true, maximum: 100, exclusiveMaximum: false },
          },
          {
            name: 'tags',
            in: 'query',
            style: 'form',
            explode: false,
            schema: { type: 'array', items: { type: 'string' } },
          },
        ],
        responses: {
          '200': {
            description: 'A page of pets',
            headers: { 'X-Next': { schema: { type: 'string' } } },
            content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } },
          },
          default: { $ref: '#/components/responses/Problem' },
        },
      },
      post: {
        operationId: 'createPet',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' }, example: { name: 'Rex' } } },
        },
        responses: { '201': { description: 'Created' } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', nullable: true },
          age: { type: 'integer', minimum: 0, exclusiveMinimum: true, example: 3 },
          owner: { $ref: '#/components/schemas/Owner' },
        },
        discriminator: { propertyName: 'kind', mapping: { dog: '#/components/schemas/Dog' } },
        xml: { name: 'pet' },
      },
      Owner: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', format: 'uuid' } } },
    },
    parameters: { Trace: { name: 'X-Trace', in: 'header', schema: { type: 'string' } } },
    responses: {
      Problem: {
        description: 'Problem details',
        content: { 'application/problem+json': { schema: { type: 'object' } } },
      },
    },
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      oauth: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://auth.example.com/authorize',
            tokenUrl: 'https://auth.example.com/token',
            scopes: { read: 'Read pets' },
          },
        },
      },
    },
  },
};

/** 3.1: type arrays, `const`, `prefixItems`, webhooks, path item components, boolean subschemas, `$ref` siblings. */
export const oas31: OAS31.OpenAPIObject = {
  openapi: '3.1.2',
  jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
  info: { title: 'Pet Store', summary: 'Pets', version: '1.0.0', license: { name: 'MIT', identifier: 'MIT' } },
  servers: [{ url: 'https://pets.example.com' }],
  webhooks: {
    petAdopted: {
      post: {
        operationId: 'onPetAdopted',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { '200': { description: 'Acknowledged' } },
      },
    },
  },
  paths: {
    '/pets/{petId}': { $ref: '#/components/pathItems/PetById', summary: 'One pet' },
    '/health': { get: { operationId: 'health' } },
  },
  components: {
    schemas: {
      Pet: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: ['string', 'null'], minLength: 1 },
          kind: { const: 'pet' },
          location: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], items: false, minItems: 2 },
          age: { type: 'integer', exclusiveMinimum: 0, examples: [3] },
          owner: { $ref: '#/components/schemas/Owner', description: 'Who adopted the pet' },
          anything: true,
          nothing: false,
        },
        unevaluatedProperties: false,
        discriminator: { propertyName: 'kind' },
        $defs: { Tag: { type: 'string' } },
      },
      Owner: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      Anything: true,
    },
    parameters: {
      PetId: { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
    },
    pathItems: {
      PetById: {
        parameters: [{ $ref: '#/components/parameters/PetId', description: 'Which pet' }],
        get: {
          operationId: 'getPet',
          responses: {
            '200': {
              description: 'The pet',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
            },
          },
        },
      },
    },
    securitySchemes: {
      mutual: { type: 'mutualTLS' },
      bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
};

/**
 * 3.2: `$self`, QUERY and additional operations, `querystring`, `itemSchema`, media type components, response
 * `summary` without `description`.
 */
export const oas32: OAS32.OpenAPIObject = {
  openapi: '3.2.0',
  $self: 'https://pets.example.com/openapi.json',
  info: { title: 'Pet Store', version: '1.0.0' },
  servers: [{ url: 'https://pets.example.com', name: 'production', description: 'The live API' }],
  tags: [
    { name: 'nav', summary: 'Navigation', kind: 'nav' },
    { name: 'pets', parent: 'nav', kind: 'badge', description: 'Everything about pets' },
  ],
  paths: {
    '/pets': {
      query: {
        operationId: 'searchPets',
        tags: ['pets'],
        parameters: [
          {
            name: 'filter',
            in: 'querystring',
            content: {
              'application/x-www-form-urlencoded': {
                schema: { type: 'object', properties: { name: { type: 'string' } } },
              },
            },
          },
        ],
        responses: {
          '200': {
            description: 'Matches',
            content: { 'application/json': { schema: { type: 'array', items: { type: 'object' } } } },
          },
        },
      },
      additionalOperations: {
        LINK: { operationId: 'linkPet', responses: { '204': { summary: 'Linked' } } },
      },
      post: {
        operationId: 'createPet',
        parameters: [{ name: 'session', in: 'cookie', style: 'cookie', schema: { type: 'string' } }],
        requestBody: {
          content: {
            'multipart/mixed': {
              schema: {
                type: 'array',
                prefixItems: [{ type: 'object' }, { type: 'string', contentMediaType: 'image/png' }],
              },
              prefixEncoding: [{ contentType: 'application/json' }, { contentType: 'image/png' }],
              itemEncoding: { contentType: 'application/octet-stream' },
            },
          },
        },
        responses: { '201': { summary: 'Created' } },
      },
    },
    '/events': {
      get: {
        operationId: 'streamEvents',
        responses: {
          '200': {
            summary: 'A stream of events',
            content: {
              'text/event-stream': { itemSchema: { type: 'object', properties: { id: { type: 'string' } } } },
              'application/jsonl': { $ref: '#/components/mediaTypes/EventLine' },
            },
          },
        },
      },
    },
  },
  components: {
    mediaTypes: {
      EventLine: { itemSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
    },
    examples: {
      Rex: { summary: 'Rex', dataValue: { name: 'Rex' }, serializedValue: '{"name":"Rex"}' },
    },
    schemas: {
      Pet: {
        type: 'object',
        discriminator: { propertyName: 'kind', defaultMapping: '#/components/schemas/Pet' },
        xml: { nodeType: 'element', name: 'pet' },
      },
    },
    securitySchemes: {
      device: {
        type: 'oauth2',
        oauth2MetadataUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
        deprecated: false,
        flows: {
          deviceAuthorization: {
            deviceAuthorizationUrl: 'https://auth.example.com/device',
            tokenUrl: 'https://auth.example.com/token',
            scopes: { read: 'Read pets' },
          },
        },
      },
    },
  },
};

/** Documents migrated from 3.0 still carry its boolean `exclusiveMinimum`; 3.1 and 3.2 readers accept it. */
export const migratedSchema31: OAS31.SchemaObject = { type: 'integer', minimum: 0, exclusiveMinimum: true };
export const migratedSchema32: OAS32.SchemaObject = { type: 'integer', maximum: 10, exclusiveMaximum: true };

// ---------------------------------------------------------------------------
// 4. The same documents under the cross-version alias.
// ---------------------------------------------------------------------------

export const documents: OpenAPIDocument[] = [oas30, oas31, oas32];
export const document30: OpenAPIDocument = oas30;
export const document31: OpenAPIDocument = oas31;
export const document32: OpenAPIDocument = oas32;

/** Each version's object is a member of the cross-version union. */
export type VersionsAreMembers = [
  Expect<Extends<OAS30.OpenAPIObject, OpenAPIDocument>>,
  Expect<Extends<OAS31.OpenAPIObject, OpenAPIDocument>>,
  Expect<Extends<OAS32.OpenAPIObject, OpenAPIDocument>>,
  Expect<Extends<OAS30.OperationObject, OperationObject>>,
  Expect<Extends<OAS31.PathItemObject, PathItemObject>>,
  Expect<Extends<OAS32.SchemaObject, SchemaObject>>,
];

/** A version's document is also valid input to every public entry. */
export async function versionsReachEveryEntry(): Promise<void> {
  for (const document of [oas30, oas31, oas32]) {
    await OpenAPIToolGenerator.fromJSON(document);
    await new Validator().validate(document);
    lintDocument(document);
  }
}
