/**
 * A Schema Object's `$ref` beside other keywords, in a document whose schemas
 * are JSON Schema 2020-12 (OpenAPI 3.1 and later, `schemaReferenceSiblings`).
 *
 * There `$ref` applies together with the keywords beside it, while a
 * dereferencer replaces the whole object with its target. Moved into `allOf`
 * first, the reference means the same and both apply.
 *
 * @module
 */

import { ownProperty } from './operations';

/** Where a value sits in a document: a Schema Object, a map or list of them, or another part */
type Position = 'root' | 'components' | 'other' | 'schema' | 'schemas';

/** Schema Object keywords holding a map or a list of schemas */
const SCHEMA_COLLECTION_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'dependentSchemas',
  '$defs',
  'definitions',
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
]);

/** Schema Object keywords holding one schema (`items` a list of them, before JSON Schema 2020-12) */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'contentSchema',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Fields of the other objects (Parameter, Header, Media Type) that hold a schema */
const SCHEMA_FIELDS: ReadonlySet<string> = new Set(['schema', 'itemSchema']);

/** Fields holding data, never the document's structure */
const DATA_FIELDS: ReadonlySet<string> = new Set(['example', 'examples', 'default', 'enum', 'const']);

/** Siblings of a `$ref` that only describe: with no other, the target is read as before */
const DESCRIPTIVE_SIBLINGS: ReadonlySet<string> = new Set(['$ref', 'summary', 'description', 'title', '$comment']);

/** The position of the value under `key` of a value at `position`; `undefined` for data */
function childPosition(position: Position, key: string): Position | undefined {
  // A map of schemas is keyed by names, which can be any text
  if (position === 'schemas') return 'schema';
  if (key.startsWith('x-') || DATA_FIELDS.has(key)) return undefined;
  if (position === 'schema') {
    if (SCHEMA_COLLECTION_KEYWORDS.has(key)) return 'schemas';
    return SCHEMA_KEYWORDS.has(key) ? 'schema' : 'other';
  }
  if (position === 'root') return key === 'components' ? 'components' : 'other';
  if (position === 'components' && key === 'schemas') return 'schemas';
  return SCHEMA_FIELDS.has(key) ? 'schema' : 'other';
}

/** `schema` with a `$ref` that has a keyword beside it other than a description: the reference goes first in `allOf` */
function wrapReference(schema: Record<string, unknown>): void {
  const ref = ownProperty(schema, '$ref');
  const allOf = ownProperty(schema, 'allOf');
  if (typeof ref !== 'string' || (allOf !== undefined && !Array.isArray(allOf))) return;
  if (Object.keys(schema).every((key) => DESCRIPTIVE_SIBLINGS.has(key) || key.startsWith('x-'))) return;
  delete schema['$ref'];
  schema['allOf'] = [{ $ref: ref }, ...((allOf as unknown[] | undefined) ?? [])];
}

/**
 * Moves the `$ref` of each Schema Object of `document` that has a constraint
 * beside it into `allOf`, in place: `{ $ref, maxLength }` becomes
 * `{ allOf: [{ $ref }], maxLength }`. A `$ref` with only `summary`,
 * `description`, `title`, `$comment` or `x-` fields beside it is left, as is
 * any other object's (a Parameter or Response reference) and any data
 * (`example`, `default`, `enum`, an extension). For a document whose
 * profile has `schemaReferenceSiblings`.
 */
export function wrapReferenceSiblings(document: unknown): void {
  const seen = new Set<object>();
  const pending: Array<{ value: unknown; position: Position }> = [{ value: document, position: 'root' }];
  while (pending.length > 0) {
    const { value, position } = pending.pop()!;
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      const itemPosition = position === 'schemas' ? 'schema' : position;
      for (const item of value) pending.push({ value: item, position: itemPosition });
      continue;
    }
    const record = value as Record<string, unknown>;
    if (position === 'schema') wrapReference(record);
    for (const key of Object.keys(record)) {
      const child = childPosition(position, key);
      if (child !== undefined) pending.push({ value: record[key], position: child });
    }
  }
}
