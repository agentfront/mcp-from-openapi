/**
 * Reading `x-` specification extensions. The object types declare none, so
 * that a consumer's own interfaces stay assignable to them; `WithExtensions`
 * is the one place extensions are typed. Compiled by `yarn typecheck`, never
 * executed (see README.md).
 */
import { extractExtensionOverrides } from 'mcp-from-openapi';
import type {
  ExtensionName,
  OAS30,
  OAS31,
  OAS32,
  OpenAPIDocument,
  OperationObject,
  SchemaObject,
  WithExtensions,
} from 'mcp-from-openapi';

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

declare const document: OpenAPIDocument;
declare const operation: OperationObject;
declare const schema: SchemaObject;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** An extension's value is `unknown` until the reader checks it. */
export const logo = (document.info as WithExtensions<OpenAPIDocument['info']>)['x-logo'];
export const tagGroups = (document as WithExtensions<OpenAPIDocument>)['x-tagGroups'];
export const mcp = (operation as WithExtensions)['x-mcp'];
export const internal = (schema as WithExtensions<SchemaObject>)['x-internal'];

export type ReadsAreUnknown = [
  Expect<Equal<typeof logo, unknown>>,
  Expect<Equal<typeof tagGroups, unknown>>,
  Expect<Equal<typeof mcp, unknown>>,
  Expect<Equal<typeof internal, unknown>>,
];

/** The extension name is any `x-` key. */
export const extensionName: ExtensionName = 'x-logo';

// @ts-expect-error a name without the `x-` prefix is not an extension name
export const notAnExtensionName: ExtensionName = 'logo';

/** The declared fields keep their types. */
export type DeclaredFieldsSurvive = [
  Expect<Equal<WithExtensions<OAS31.InfoObject>['title'], string>>,
  Expect<Equal<WithExtensions<OAS31.InfoObject>['summary'], string | undefined>>,
  Expect<Equal<WithExtensions<OAS30.InfoObject>['version'], string>>,
];

/** An extension value is checked, then used. */
export function logoUrl(): string | undefined {
  const value = (document.info as WithExtensions<OpenAPIDocument['info']>)['x-logo'];
  if (typeof value === 'object' && value !== null && 'url' in value && typeof value.url === 'string') return value.url;
  return undefined;
}

export function isHidden(candidate: OperationObject): boolean {
  return (candidate as WithExtensions<OperationObject>)['x-hidden'] === true;
}

/** An operation viewed with its extensions is still an operation. */
export function overridesOf(candidate: OperationObject) {
  const viewed: WithExtensions<OperationObject> = candidate;
  return extractExtensionOverrides(viewed);
}

// ---------------------------------------------------------------------------
// Writing: a literal with extensions is annotated with the helper
// ---------------------------------------------------------------------------

export const infoWithLogo: WithExtensions<OAS31.InfoObject> = {
  title: 'Pet Store',
  version: '1.0.0',
  'x-logo': { url: 'https://pets.example.com/logo.png', altText: 'Pets' },
};

export const operationWithExtensions: WithExtensions<OAS32.OperationObject> = {
  operationId: 'listPets',
  'x-mcp': { enabled: true },
  'x-internal': false,
};

export const documentWithExtensions: WithExtensions<OAS30.OpenAPIObject> = {
  openapi: '3.0.4',
  info: infoWithLogo,
  paths: {},
  'x-tagGroups': [{ name: 'Pets', tags: ['pets'] }],
};

/** Dropping the helper is always allowed: the value is still the plain object. */
export const plainInfo: OAS31.InfoObject = infoWithLogo;
export const plainOperation: OAS32.OperationObject = operationWithExtensions;
export const plainDocument: OAS30.OpenAPIObject = documentWithExtensions;
export const aliasDocument: OpenAPIDocument = documentWithExtensions;

/** A value that already exists (parsed, built elsewhere) keeps its extensions when assigned. */
declare const parsed: {
  openapi: string;
  info: { title: string; version: string; 'x-logo': { url: string } };
  paths: Record<string, never>;
  'x-generated-by': string;
};
export const parsedAsDocument: OpenAPIDocument = parsed;
export const parsedViewed: WithExtensions<OpenAPIDocument> = parsed;

// ---------------------------------------------------------------------------
// Interface-typed objects
// ---------------------------------------------------------------------------

interface AppInfo {
  title: string;
  version: string;
}
declare const appInfo: AppInfo;

/** A cast views an interface-typed object with its extensions. */
export const appLogo = (appInfo as WithExtensions<AppInfo>)['x-logo'];

// ---------------------------------------------------------------------------
// Rejections
// ---------------------------------------------------------------------------

// @ts-expect-error a plain object type declares no extension, so a fresh literal with one is an excess property
export const plainWithExtension: OAS31.InfoObject = { title: 'Pet Store', version: '1.0.0', 'x-logo': 'logo.png' };

// @ts-expect-error only names starting with `x-` are extensions: `x_logo` is an unknown property
export const underscore = (document.info as WithExtensions<OpenAPIDocument['info']>).x_logo;

// @ts-expect-error `WithExtensions` types extensions, not arbitrary keys
export const arbitraryKey = (operation as WithExtensions<OperationObject>)['logo'];

// @ts-expect-error a plain operation has no extension to read without the helper
export const unviewed = operation['x-mcp'];

export function extensionsAreReadOnly(viewed: WithExtensions<OpenAPIDocument['info']>): void {
  // @ts-expect-error extensions are read through the helper, never written through it
  viewed['x-logo'] = 'logo.png';
}

// @ts-expect-error only objects carry extensions
export type NotAnObject = WithExtensions<string>;
