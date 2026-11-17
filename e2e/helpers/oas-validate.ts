/**
 * Validation of an OpenAPI document against the official OpenAPI Initiative
 * JSON Schema for its version, entirely offline: every schema comes from the
 * pinned copies under e2e/fixtures/oas/schemas (listed, with checksums, in
 * e2e/fixtures/oas/sources.json) and is registered with Ajv by its `$id`, so
 * nothing is ever fetched.
 *
 * - 3.0 is one JSON Schema draft-04 document (`ajv-draft-04`).
 * - 3.1 and 3.2 are validated through `schema-base.json`, the entry point the
 *   OAI test suite uses (it wraps `schema.json` and also validates Schema
 *   Objects against the OAS dialect), on `Ajv2020` with the pinned JSON Schema
 *   2020-12 meta-schemas.
 *
 * Ajv options, and why each is needed:
 *
 * - `meta: false` (3.1/3.2): Ajv2020 pre-registers its own copy of the
 *   2020-12 meta-schema under `https://json-schema.org/draft/2020-12/schema`,
 *   which differs from the official file (it adds a `$vocabulary` member to
 *   `meta/core`) and would collide with the pinned one registered here.
 * - `validateSchema: false` (3.1/3.2): the schemas are not validated against a
 *   meta-schema as they are added (the meta-schemas are themselves among them
 *   and are not registered yet when the first one is added).
 * - `strictTypes: false`: the official schemas use `properties`,
 *   `patternProperties` and `required` without a sibling `type: object`.
 * - `allowMatchingProperties: true` (3.1/3.2): the Components Object lists
 *   properties (`schemas`, `responses`, ...) that its own `patternProperties`
 *   pattern also matches.
 * - `strictSchema: true` stays on, so an unknown keyword in an official schema
 *   fails loudly instead of being ignored. `strictTuples` is on as well.
 * - `validateFormats: false`: `format` is an annotation in the OAS dialect
 *   (the `format-annotation` vocabulary), so it asserts nothing. This also
 *   keeps `ajv-formats` out of the dependencies for the draft-04 schema.
 * - `allErrors: true`: reports every violation, not only the first.
 *
 * One transformation is not an option. Ajv resolves `$dynamicRef` against the
 * schema's own root, not through the dynamic scope that `schema-base.json`
 * opens (Ajv's own comment calls the assumption out in
 * `vocabularies/dynamic/dynamicRef.js`). Every Schema Object position in the
 * OAS schema, the dialect, the 2020-12 vocabularies and the OAS vocabulary is a
 * `$dynamicRef: "#meta"` that, entered through `schema-base.json`, resolves to
 * its `$defs/schema` (the first `$dynamicAnchor: meta` in the dynamic scope).
 * With Ajv's resolution those positions validate a Schema Object as a whole
 * OpenAPI document and reject every document that has one. `bindDynamicMeta`
 * therefore resolves that reference statically, the way the dynamic scope
 * does for this entry point: each `{ "$dynamicRef": "#meta" }` becomes
 * `{ "$ref": "<schema-base>#/$defs/schema" }` and the now-unused
 * `$dynamicAnchor` members are dropped. It touches nothing else, and it fails
 * if it meets any other dynamic reference or anchor.
 */
import type { ErrorObject, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import Ajv04 from 'ajv-draft-04';
import { loadFixture, loadJsonFixture } from './fixtures';

export type OasVersion = '3.0' | '3.1' | '3.2';

export interface OasValidation {
  valid: boolean;
  /** The violations as `<instance path>: <message>`, the first {@link MAX_ERRORS}, then `(and N more)`. */
  errors: string[];
}

interface Manifest {
  sources: Array<{ id: string; kind: string; path: string }>;
}

const MAX_ERRORS = 100;
const JSON_SCHEMA_DIR = 'schemas/json-schema-2020-12/';
const META_ANCHOR = 'meta';

/** Reads a JSON file listed in the manifest (path relative to `e2e/fixtures/oas/`). */
const loadOasJson = (path: string): Record<string, unknown> =>
  JSON.parse(loadFixture(`oas/${path}`)) as Record<string, unknown>;

/**
 * Copies `node`, resolving `{ "$dynamicRef": "#meta" }` to `target` and
 * dropping `$dynamicAnchor`. Throws on any other dynamic reference or anchor,
 * so a pinned schema that starts using one cannot be validated wrongly.
 */
export function bindDynamicMeta(node: unknown, target: string, seen: { refs: number } = { refs: 0 }): unknown {
  if (Array.isArray(node)) return node.map((member) => bindDynamicMeta(member, target, seen));
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // A string value is the keyword; an object value is a property *named* `$dynamicRef` (meta/core.json).
    if (key === '$dynamicRef' && typeof value === 'string') {
      if (value !== `#${META_ANCHOR}`) throw new Error(`unsupported $dynamicRef ${JSON.stringify(value)}`);
      out['$ref'] = target;
      seen.refs++;
    } else if (key === '$dynamicAnchor' && typeof value === 'string') {
      if (value !== META_ANCHOR) throw new Error(`unsupported $dynamicAnchor ${JSON.stringify(value)}`);
    } else {
      out[key] = bindDynamicMeta(value, target, seen);
    }
  }
  return out;
}

function createValidator(version: OasVersion): ValidateFunction {
  if (version === '3.0') {
    const ajv = new Ajv04({
      allErrors: true,
      strictSchema: true,
      strictTypes: false,
      strictTuples: true,
      validateFormats: false,
    });
    return ajv.compile(loadOasJson('schemas/3.0/schema.json'));
  }

  const ajv = new Ajv2020({
    allErrors: true,
    meta: false,
    validateSchema: false,
    strictSchema: true,
    strictTypes: false,
    strictTuples: true,
    allowMatchingProperties: true,
    validateFormats: false,
  });
  const manifest = loadJsonFixture<Manifest>('oas/sources.json');
  const files = manifest.sources
    .map((entry) => entry.path)
    .filter((path) => path.startsWith(`schemas/${version}/`) || path.startsWith(JSON_SCHEMA_DIR));
  const base = loadOasJson(`schemas/${version}/schema-base.json`);
  const baseId = base['$id'] as string;
  const seen = { refs: 0 };
  for (const path of files) {
    const schema = loadOasJson(path);
    ajv.addSchema(bindDynamicMeta(schema, `${baseId}#/$defs/schema`, seen) as object, schema['$id'] as string);
  }
  // 2020-12 vocabularies, OAS schema, dialect and OAS vocabulary all contain Schema Object positions.
  if (seen.refs === 0) throw new Error(`no $dynamicRef found in the ${version} schemas`);
  return ajv.getSchema(baseId) as ValidateFunction;
}

const validators = new Map<OasVersion, ValidateFunction>();

const describeError = (error: ErrorObject): string => {
  const detail = Object.values(error.params as Record<string, unknown>).filter((value) => typeof value === 'string');
  return `${error.instancePath || '/'}: ${error.message}${detail.length > 0 ? ` (${detail.join(', ')})` : ''}`;
};

/** Validates `document` against the official schema for `version`. */
export function validateOasDocument(version: OasVersion, document: unknown): OasValidation {
  let validate = validators.get(version);
  if (!validate) {
    validate = createValidator(version);
    validators.set(version, validate);
  }
  const valid = validate(document) as boolean;
  if (valid) return { valid, errors: [] };
  const all = validate.errors ?? [];
  const errors = all.slice(0, MAX_ERRORS).map(describeError);
  if (all.length > MAX_ERRORS) errors.push(`(and ${all.length - MAX_ERRORS} more)`);
  return { valid, errors };
}
