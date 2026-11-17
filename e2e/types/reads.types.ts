/**
 * How consumers read the OpenAPI types: filters, naming strategies, narrowing,
 * schema and response access. All of it must keep compiling. Compiled by
 * `yarn typecheck`, never executed (see README.md).
 */
import { isReferenceObject, toJsonSchema } from 'mcp-from-openapi';
import type {
  ExampleObject,
  HTTPMethod,
  JsonSchema,
  NamingStrategy,
  OpenAPIDocument,
  OperationObject,
  OperationWithContext,
  ParameterObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  SchemaOrBoolean,
  SecuritySchemeObject,
  ServerObject,
} from 'mcp-from-openapi';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Extends<A, B> = [A] extends [B] ? true : false;

// ---------------------------------------------------------------------------
// GenerateOptions.filterFn
// ---------------------------------------------------------------------------

export const filterFn: (op: OperationWithContext) => boolean = (op) => {
  const tags: string[] | undefined = op.tags;
  const operationId: string | undefined = op.operationId;
  const deprecated: boolean | undefined = op.deprecated;
  const path: string = op.path;
  const method: string = op.method;

  // Array methods on the parameters of any version's operation
  const names = (op.parameters ?? []).map((parameter) => ('name' in parameter ? parameter.name : parameter.$ref));
  const hasQuery =
    op.parameters?.some((parameter) => !isReferenceObject(parameter) && parameter.in === 'query') ?? false;
  const inline = op.parameters?.filter((parameter) => !isReferenceObject(parameter)) ?? [];

  return (
    !deprecated &&
    (tags ?? []).includes('public') &&
    operationId !== undefined &&
    path.startsWith('/v1') &&
    method === 'get' &&
    names.length + inline.length > 0 &&
    hasQuery
  );
};

export type FilterFnParameterTypes = [
  Expect<Equal<OperationWithContext['tags'], string[] | undefined>>,
  Expect<Equal<OperationWithContext['operationId'], string | undefined>>,
  Expect<Equal<OperationWithContext['deprecated'], boolean | undefined>>,
  Expect<Equal<OperationWithContext['path'], string>>,
  Expect<Equal<OperationWithContext['method'], string>>,
];

/** `filterFn` as the option it is passed in. */
export const generateOptions: { filterFn: (operation: OperationWithContext) => boolean } = { filterFn };

// ---------------------------------------------------------------------------
// NamingStrategy.toolNameGenerator
// ---------------------------------------------------------------------------

export const toolNameGenerator: NamingStrategy['toolNameGenerator'] = (path, method, operationId, operation) => {
  const tag = operation?.tags?.[0];
  const summary = operation?.summary;
  const verb: HTTPMethod = method;
  return operationId ?? [tag, summary, verb, path].filter(Boolean).join('_');
};

export const namingStrategy: NamingStrategy = {
  toolNameGenerator,
  conflictResolver: (name, location, index) => `${location}_${name}_${index}`,
};

// ---------------------------------------------------------------------------
// Narrowing a parameter or reference
// ---------------------------------------------------------------------------

export function parameterLabel(parameter: ParameterObject | ReferenceObject): string {
  if (isReferenceObject(parameter)) {
    type Narrowed = [Expect<Equal<typeof parameter, ReferenceObject>>];
    return parameter.$ref;
  }
  type Rest = [Expect<Equal<typeof parameter, ParameterObject>>];
  const location: string = parameter.in;
  const required: boolean | undefined = parameter.required;
  const style: string | undefined = parameter.style;
  const description: string | undefined = parameter.description;
  return `${location}:${parameter.name}:${required ?? false}:${style ?? ''}:${description ?? ''}`;
}

export function parameterSchema(parameter: ParameterObject): SchemaObject | undefined {
  const schema = parameter.schema;
  if (schema === undefined || typeof schema === 'boolean') return undefined;
  if (isReferenceObject(schema)) return undefined;
  return schema;
}

export function operationParameters(operation: OperationObject): ParameterObject[] {
  const found: ParameterObject[] = [];
  for (const parameter of operation.parameters ?? []) {
    if (!isReferenceObject(parameter)) found.push(parameter);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Reading a schema
// ---------------------------------------------------------------------------

export function describeSchema(schema: SchemaObject): string {
  const type = schema.type;
  if (typeof type === 'string') {
    if (type === 'array') {
      const items = schema.items;
      return typeof items === 'object' && !isReferenceObject(items) ? `array<${String(items.type ?? '?')}>` : 'array';
    }
    return type;
  }
  if (Array.isArray(type)) return type.join('|');

  const properties = schema.properties;
  if (properties) {
    const keys = Object.keys(properties);
    for (const key of keys) {
      const property = properties[key];
      if (property !== undefined && typeof property === 'object' && !isReferenceObject(property)) {
        const nested: string | undefined = property.description;
        if (nested) return nested;
      }
    }
    return `object{${keys.join(',')}}`;
  }
  return 'unknown';
}

export const schemaRequired = (schema: SchemaObject): string[] => schema.required ?? [];

export function isBooleanSchema(schema: SchemaOrBoolean): schema is boolean {
  return typeof schema === 'boolean';
}

export type SchemaFields = [
  Expect<Extends<SchemaObject['required'], string[] | undefined>>,
  Expect<Extends<SchemaObject['description'], string | undefined>>,
  Expect<Extends<SchemaObject['format'], string | undefined>>,
  Expect<Extends<SchemaObject['enum'], unknown[] | undefined>>,
];

/** `nullable` exists in 3.0 only: narrow to read it. */
export function isNullable(schema: SchemaObject): boolean {
  if ('nullable' in schema) return schema.nullable === true;
  const type = schema.type;
  return Array.isArray(type) && type.includes('null');
}

// ---------------------------------------------------------------------------
// Iterating a document
// ---------------------------------------------------------------------------

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export function listOperationIds(document: OpenAPIDocument): string[] {
  const ids: string[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    const shared = pathItem.parameters ?? [];
    for (const method of METHODS) {
      const operation = pathItem[method];
      if (operation) ids.push(operation.operationId ?? `${method} ${path} (${shared.length} shared)`);
    }
  }
  return ids;
}

export function pathKeys(document: OpenAPIDocument): string[] {
  return Object.keys(document.paths ?? {});
}

export function documentTitle(document: OpenAPIDocument): string {
  const { title, version } = document.info;
  const servers = (document.servers ?? []).map((server) => server.url);
  return `${title}@${version} (${servers.join(', ')})`;
}

export function listSchemaNames(document: OpenAPIDocument): string[] {
  return Object.keys(document.components?.schemas ?? {});
}

export const versionString = (document: OpenAPIDocument): string => document.openapi;

// ---------------------------------------------------------------------------
// Reading a response
// ---------------------------------------------------------------------------

export function responseDescription(operation: OperationObject, status: string): string | undefined {
  const response = operation.responses?.[status];
  if (response === undefined || isReferenceObject(response)) return undefined;
  const description = response.description;
  type Description = [Expect<Equal<typeof description, string | undefined>>];
  return description;
}

export function responseMediaTypes(response: ResponseObject): string[] {
  return Object.keys(response.content ?? {});
}

export type ResponseFields = [
  Expect<Equal<ResponseObject['description'], string | undefined>>,
  Expect<Extends<ResponseObject['content'], object | undefined>>,
];

// ---------------------------------------------------------------------------
// Reading bodies, servers and security schemes
// ---------------------------------------------------------------------------

export function bodySchema(
  body: RequestBodyObject,
  mediaType = 'application/json',
): SchemaObject | ReferenceObject | boolean | undefined {
  const entry = body.content[mediaType];
  if (entry === undefined || isReferenceObject(entry)) return undefined;
  return entry.schema;
}

export function serverUrl(server: ServerObject): string {
  let url = server.url;
  for (const [name, variable] of Object.entries(server.variables ?? {})) {
    if (variable) url = url.replace(`{${name}}`, variable.default);
  }
  return url;
}

export function oauthScopes(scheme: SecuritySchemeObject): string[] {
  if (scheme.type !== 'oauth2') return [];
  const flows = scheme.flows;
  return [flows?.implicit, flows?.password, flows?.clientCredentials, flows?.authorizationCode].flatMap((flow) =>
    Object.keys(flow?.scopes ?? {}),
  );
}

export function apiKeyLocation(scheme: SecuritySchemeObject): string | undefined {
  return scheme.type === 'apiKey' ? scheme.in : undefined;
}

export type OpenEnumerations = [
  Expect<Extends<ParameterObject['in'], string>>,
  Expect<Extends<'query' | 'header' | 'path' | 'cookie', ParameterObject['in']>>,
  Expect<Extends<string, ParameterObject['in']>>,
  Expect<Extends<SecuritySchemeObject['type'], string>>,
  Expect<Extends<string, SecuritySchemeObject['type']>>,
];

// ---------------------------------------------------------------------------
// Reading free-form values
// ---------------------------------------------------------------------------

/** `enum` members, `default` and `example` are read as the document holds them: no cast, no narrowing. */
export function upperCaseEnum(schema: SchemaObject): string[] {
  return schema.enum?.map((value) => value.toUpperCase()) ?? [];
}

export function readFreeFormValues(
  schema: SchemaObject,
  parameter: ParameterObject,
  example: ExampleObject,
): unknown[] {
  return [schema.example?.name, schema.default.length, parameter.example?.id, example.value?.name];
}

// ---------------------------------------------------------------------------
// Converting a schema: a boolean schema (OpenAPI 3.1 and later) converts too
// ---------------------------------------------------------------------------

declare const eitherSchema: SchemaOrBoolean;
declare const referenceSchema: ReferenceObject;

/** `true` accepts anything and `false` nothing: both convert to a JSON Schema object, as any schema does. */
export const trueConverted: JsonSchema = toJsonSchema(true);
export const falseConverted: JsonSchema = toJsonSchema(false);
export const eitherConverted: JsonSchema = toJsonSchema(eitherSchema);
export const objectConverted: JsonSchema = toJsonSchema({ type: 'string' } satisfies SchemaObject);
export const referenceConverted: JsonSchema = toJsonSchema(referenceSchema);

/** A schema read from a document in any form is converted without a check on its form first. */
export function convertEach(schemas: SchemaOrBoolean[]): JsonSchema[] {
  return schemas.map((schema) => toJsonSchema(schema));
}

/** The result is always an object, so its keywords are read with no narrowing (`not` is a keyword, never the result). */
export function negationOf(schema: SchemaOrBoolean): JsonSchema | boolean | undefined {
  return toJsonSchema(schema).not;
}
