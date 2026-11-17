/**
 * Both sides of the schema-to-types parity story: what the official OpenAPI
 * JSON Schemas say an object holds, and what our TypeScript types declare.
 *
 * Schema side. `SchemaRegistry` holds JSON Schema documents by `$id` (`id` in
 * draft-04) and resolves `$ref`s between them; `extractObjectFields` collects,
 * for one schema location, the fields that apply to an instance of that
 * object. It follows only the in-place applicators — `properties`, `required`,
 * `allOf`/`anyOf`/`oneOf`, `if`/`then`/`else`, `dependentSchemas` (and draft-04
 * `dependencies`) and `$ref` — and never descends into what describes a child
 * value (`properties` values, `items`, `additionalProperties`,
 * `patternProperties` values); it records where those child schemas are, so
 * `KindResolver` can say what kind of value each field holds. Spec-extension
 * patterns (`^x-`) are not fields. A field counts as required only when every
 * instance needs it: required in one branch of `anyOf`/`oneOf`/`if` is
 * conditional, unless every branch requires it.
 *
 * Type side. `SpecTypeReader` loads the spec types with the real TypeScript
 * compiler (through the `src/spec` boundary project's compiler options) and
 * reports, per exported type, its properties, which are required, and the
 * kind of value each holds.
 *
 * Value kinds are compared as canonical text on both sides: `string`,
 * `boolean`, `number`, `null`, `free` (anything: an unconstrained schema, or
 * `any`/`unknown`), `object` (an inline object), a mapped type's name,
 * `array<kind>` and `map<kind>`, joined with ` | ` and sorted. `undefined` is
 * dropped: optionality is compared separately.
 *
 * `moduleSpecifiers` lists every module a source file refers to, for the
 * `src/spec` boundary check.
 */
import { dirname } from 'path';
import * as ts from 'typescript';

// ---------------------------------------------------------------------------
// Schema side
// ---------------------------------------------------------------------------

/** One JSON Schema document and the short label locations are written with. */
export interface SchemaSource {
  /** Short, unique name used in locations: `schema.json#/$defs/info`. */
  label: string;
  schema: unknown;
}

/** What the official schema gives an object. */
export interface ObjectFields {
  /** Field names an instance may hold. */
  properties: Set<string>;
  /** Field names every instance must hold. */
  required: Set<string>;
  /**
   * Keys beyond the fixed fields: each non-extension `patternProperties`
   * pattern, and `additionalProperties` / `unevaluatedProperties` when they
   * accept something. Empty for an object with fixed fields only.
   */
  dynamicKeys: Set<string>;
  /** Field name to the locations of every schema its value must match. */
  propertySchemas: Map<string, string[]>;
  /** The locations of the schemas the values of `dynamicKeys` must match. */
  valueSchemas: string[];
}

type SchemaObjectNode = { readonly [keyword: string]: unknown };

interface Resource {
  label: string;
  uri: string;
  root: unknown;
  /** Draft-04 ignores keywords next to `$ref` and names the base URI `id`. */
  draft04: boolean;
}

/** A resolved schema location. */
export interface Located {
  resource: Resource;
  pointer: string;
  node: unknown;
  /** `label#pointer`. */
  location: string;
}

const isObject = (value: unknown): value is SchemaObjectNode =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const escapePointer = (token: string): string => token.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapePointer = (token: string): string => token.replace(/~1/g, '/').replace(/~0/g, '~');

const entriesOf = (value: unknown): Array<[string, unknown]> => (isObject(value) ? Object.entries(value) : []);

const withoutFragment = (uri: string): string => uri.replace(/#.*$/, '');

/** The base URI a document declares: `$id`, or draft-04 `id`. */
function documentUri(label: string, schema: unknown, draft04: boolean): string {
  const id = isObject(schema) ? (draft04 ? schema['id'] : schema['$id']) : undefined;
  if (typeof id !== 'string' || id === '') {
    throw new Error(`${label}: the document declares no ${draft04 ? 'id' : '$id'}, so its $refs cannot be resolved`);
  }
  return withoutFragment(new URL(id).href);
}

/** JSON Schema documents by URI, with `$ref` resolution between them. */
export class SchemaRegistry {
  private readonly byUri = new Map<string, Resource>();
  private readonly byLabel = new Map<string, Resource>();

  constructor(sources: readonly SchemaSource[]) {
    for (const { label, schema } of sources) {
      const dialect = isObject(schema) ? schema['$schema'] : undefined;
      const draft04 = typeof dialect === 'string' && dialect.includes('draft-04');
      const resource: Resource = { label, uri: documentUri(label, schema, draft04), root: schema, draft04 };
      if (this.byLabel.has(label)) throw new Error(`duplicate schema label ${label}`);
      if (this.byUri.has(resource.uri)) throw new Error(`${label}: duplicate schema URI ${resource.uri}`);
      this.byLabel.set(label, resource);
      this.byUri.set(resource.uri, resource);
    }
  }

  /** Resolve a `label#/json/pointer` location. */
  locate(location: string): Located {
    const hash = location.indexOf('#');
    const label = hash < 0 ? location : location.slice(0, hash);
    const resource = this.byLabel.get(label);
    if (!resource) throw new Error(`${location}: no schema document is labelled ${label}`);
    return this.atPointer(resource, hash < 0 ? '' : location.slice(hash + 1), location);
  }

  /** Resolve a `$ref` written in `from`. */
  resolveRef(from: Resource, ref: string, location: string): Located {
    const target = new URL(ref, from.uri);
    const fragment = decodeURIComponent(target.hash.replace(/^#/, ''));
    const resource = this.byUri.get(withoutFragment(target.href));
    if (!resource) throw new Error(`${location}: $ref ${ref} names ${target.href}, which no loaded document declares`);
    if (fragment !== '' && !fragment.startsWith('/')) {
      throw new Error(`${location}: $ref ${ref} uses an anchor; only JSON Pointer fragments are supported`);
    }
    return this.atPointer(resource, fragment, location);
  }

  /**
   * Every definition the labelled documents declare, as locations: each
   * document root, and every `$defs` / `definitions` entry at any depth.
   */
  definitions(labels: readonly string[]): string[] {
    const found: string[] = [];
    for (const label of labels) {
      const resource = this.byLabel.get(label);
      if (!resource) throw new Error(`no schema document is labelled ${label}`);
      found.push(`${label}#`);
      walkSubschemas(resource.root, '', (node, pointer) => {
        for (const keyword of ['$defs', 'definitions']) {
          for (const [name] of entriesOf(node[keyword])) {
            found.push(`${label}#${pointer}/${keyword}/${escapePointer(name)}`);
          }
        }
      });
    }
    return found;
  }

  private atPointer(resource: Resource, pointer: string, location: string): Located {
    let node: unknown = resource.root;
    if (pointer !== '') {
      for (const token of pointer.slice(1).split('/').map(unescapePointer)) {
        if (Array.isArray(node) && /^(0|[1-9][0-9]*)$/.test(token)) node = node[Number(token)];
        else if (isObject(node) && Object.prototype.hasOwnProperty.call(node, token)) node = node[token];
        else throw new Error(`${location}: ${resource.label}#${pointer} does not exist`);
      }
    }
    return { resource, pointer, node, location: `${resource.label}#${pointer}` };
  }
}

/** Keywords whose value is one subschema. */
const SINGLE_SUBSCHEMA = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
];
/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_ARRAYS = ['allOf', 'anyOf', 'items', 'oneOf', 'prefixItems'];
/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAPS = ['$defs', 'definitions', 'dependentSchemas', 'patternProperties', 'properties'];

/** Visit every schema object in a document (not values like `enum` or `default`). */
function walkSubschemas(
  node: unknown,
  pointer: string,
  visit: (node: SchemaObjectNode, pointer: string) => void,
): void {
  if (!isObject(node)) return;
  visit(node, pointer);
  for (const keyword of SINGLE_SUBSCHEMA) {
    if (isObject(node[keyword])) walkSubschemas(node[keyword], `${pointer}/${keyword}`, visit);
  }
  for (const keyword of SUBSCHEMA_ARRAYS) {
    const members = node[keyword];
    if (Array.isArray(members)) {
      members.forEach((member, i) => walkSubschemas(member, `${pointer}/${keyword}/${i}`, visit));
    }
  }
  for (const keyword of [...SUBSCHEMA_MAPS, 'dependencies']) {
    for (const [name, value] of entriesOf(node[keyword])) {
      walkSubschemas(value, `${pointer}/${keyword}/${escapePointer(name)}`, visit);
    }
  }
}

/** Patterns that only match specification extension names. */
const isExtensionPattern = (pattern: string): boolean => pattern.startsWith('^x-');

/**
 * The exact names an anchored pattern matches, when it matches only literal
 * names: `^\$ref$` (the 3.0 Reference Object's only field) or
 * `^(?:schemas|responses)$`. Anything else is a real pattern: `undefined`.
 */
export function literalNames(pattern: string): string[] | undefined {
  if (!pattern.startsWith('^') || !pattern.endsWith('$') || pattern.endsWith('\\$')) return undefined;
  let body = pattern.slice(1, -1);
  const grouped = body.startsWith('(?:') && body.endsWith(')');
  if (grouped) body = body.slice(3, -1);
  const names: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char === '\\') {
      const next = body[i + 1];
      // `\d`, `\w`, ... are classes, not literal characters.
      if (next === undefined || /[A-Za-z0-9]/.test(next)) return undefined;
      current += next;
      i++;
    } else if (char === '|') {
      if (!grouped || current === '') return undefined;
      names.push(current);
      current = '';
    } else if ('^$.*+?()[]{}'.includes(char)) {
      return undefined;
    } else {
      current += char;
    }
  }
  if (current === '') return undefined;
  names.push(current);
  return names;
}

const emptyFields = (): ObjectFields => ({
  properties: new Set(),
  required: new Set(),
  dynamicKeys: new Set(),
  propertySchemas: new Map(),
  valueSchemas: [],
});

const addPropertySchema = (fields: ObjectFields, name: string, location: string): void => {
  fields.properties.add(name);
  const locations = fields.propertySchemas.get(name) ?? [];
  if (!locations.includes(location)) locations.push(location);
  fields.propertySchemas.set(name, locations);
};

/** Add `from` to `into`; its required fields too only when `withRequired`. */
function mergeFields(into: ObjectFields, from: ObjectFields, withRequired: boolean): void {
  from.properties.forEach((name) => into.properties.add(name));
  from.dynamicKeys.forEach((key) => into.dynamicKeys.add(key));
  from.propertySchemas.forEach((locations, name) => locations.forEach((l) => addPropertySchema(into, name, l)));
  from.valueSchemas.forEach((location) => into.valueSchemas.includes(location) || into.valueSchemas.push(location));
  if (withRequired) from.required.forEach((name) => into.required.add(name));
}

const intersect = (sets: ReadonlyArray<Set<string>>): Set<string> =>
  sets.length === 0 ? new Set() : new Set([...sets[0]!].filter((name) => sets.every((set) => set.has(name))));

/**
 * The fields of an instance that is valid against any one of `alternatives`:
 * every field any of them allows; required only when all of them require it.
 */
export function anyOfFields(alternatives: readonly ObjectFields[]): ObjectFields {
  const fields = emptyFields();
  alternatives.forEach((alternative) => mergeFields(fields, alternative, false));
  intersect(alternatives.map((alternative) => alternative.required)).forEach((name) => fields.required.add(name));
  return fields;
}

/** The fields the schema at `location` (`label#/json/pointer`) gives an instance. */
export function extractObjectFields(registry: SchemaRegistry, location: string): ObjectFields {
  const { resource, pointer, node } = registry.locate(location);
  return collect(registry, resource, node, pointer, []);
}

function collect(
  registry: SchemaRegistry,
  resource: Resource,
  node: unknown,
  pointer: string,
  stack: readonly string[],
): ObjectFields {
  const location = `${resource.label}#${pointer}`;
  if (typeof node === 'boolean') return emptyFields();
  if (!isObject(node)) throw new Error(`${location}: not a schema`);
  if (stack.includes(location)) {
    throw new Error(`in-place applicator cycle: ${[...stack, location].join(' -> ')}`);
  }
  const path = [...stack, location];
  const sub = (keyword: string, child: unknown): ObjectFields =>
    collect(registry, resource, child, `${pointer}/${keyword}`, path);
  const follow = (ref: string): ObjectFields => {
    const target = registry.resolveRef(resource, ref, location);
    return collect(registry, target.resource, target.node, target.pointer, path);
  };

  for (const keyword of ['$dynamicRef', '$recursiveRef']) {
    if (keyword in node) {
      throw new Error(
        `${location}: an in-place ${keyword} cannot be followed statically; extract from the schema it binds to`,
      );
    }
  }
  const embeddedId = resource.draft04 ? typeof node['id'] === 'string' : '$id' in node;
  if (pointer !== '' && embeddedId) {
    throw new Error(`${location}: embedded schema resources ($id below the root) are not supported`);
  }
  // Draft-04: `$ref` replaces the whole schema object; its siblings are ignored.
  if (resource.draft04 && typeof node['$ref'] === 'string') return follow(node['$ref']);

  const fields = emptyFields();
  for (const [name, schema] of entriesOf(node['properties'])) {
    if (schema !== false) addPropertySchema(fields, name, `${location}/properties/${escapePointer(name)}`);
  }
  for (const [pattern, schema] of entriesOf(node['patternProperties'])) {
    if (schema === false || isExtensionPattern(pattern)) continue;
    const at = `${location}/patternProperties/${escapePointer(pattern)}`;
    const names = literalNames(pattern);
    if (names) {
      names.forEach((name) => addPropertySchema(fields, name, at));
    } else {
      fields.dynamicKeys.add(`patternProperties ${pattern}`);
      fields.valueSchemas.push(at);
    }
  }
  for (const keyword of ['additionalProperties', 'unevaluatedProperties']) {
    if (keyword in node && node[keyword] !== false) {
      fields.dynamicKeys.add(keyword);
      fields.valueSchemas.push(`${location}/${keyword}`);
    }
  }
  const required = node['required'];
  if (Array.isArray(required)) required.forEach((name) => typeof name === 'string' && fields.required.add(name));

  if (typeof node['$ref'] === 'string') mergeFields(fields, follow(node['$ref']), true);

  const allOf = node['allOf'];
  if (Array.isArray(allOf)) allOf.forEach((member, i) => mergeFields(fields, sub(`allOf/${i}`, member), true));
  for (const keyword of ['anyOf', 'oneOf']) {
    const members = node[keyword];
    if (Array.isArray(members)) {
      mergeFields(fields, anyOfFields(members.map((member, i) => sub(`${keyword}/${i}`, member))), true);
    }
  }

  if ('if' in node) {
    // `if` evaluates the instance in place (its annotations count when it
    // passes); `then`/`else` apply conditionally, so a field is required only
    // when both branches require it.
    mergeFields(fields, sub('if', node['if']), false);
    const branches = (['then', 'else'] as const).map((keyword) =>
      keyword in node ? sub(keyword, node[keyword]) : emptyFields(),
    );
    mergeFields(fields, anyOfFields(branches), true);
  }

  // A dependent schema applies only when its trigger field is present.
  for (const keyword of ['dependentSchemas', 'dependencies']) {
    for (const [name, schema] of entriesOf(node[keyword])) {
      if (!Array.isArray(schema)) mergeFields(fields, sub(`${keyword}/${escapePointer(name)}`, schema), false);
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Value kinds, schema side
// ---------------------------------------------------------------------------

/** The kind of value a field holds, by the official schema. */
export interface SchemaKind {
  /** Canonical kind text, e.g. `ParameterObject | ReferenceObject` or `map<string>`. */
  kind: string;
  /** Mapped definitions named by a top-level `$ref` (`implicit` → `oauth-flows/$defs/implicit`), with their type. */
  refs: Array<{ definition: string; type: string }>;
}

/** Why a field's kind is not compared. */
export interface SkippedKind {
  skip: string;
}

/** Kind atoms (`string`, `ParameterObject`, `array<string>`, ...) and the top-level refs behind them. */
interface Atoms {
  atoms: Set<string>;
  refs: Map<string, string>;
}

/** Canonical text of a set of atoms: `free` absorbs everything; otherwise sorted and joined. */
export const formatKind = (atoms: ReadonlySet<string>): string =>
  atoms.has('free') ? 'free' : atoms.size === 0 ? 'never' : [...atoms].sort().join(' | ');

const atomOfValue = (value: unknown): string =>
  typeof value === 'string'
    ? 'string'
    : typeof value === 'boolean'
      ? 'boolean'
      : typeof value === 'number'
        ? 'number'
        : value === null
          ? 'null'
          : Array.isArray(value)
            ? 'array<free>'
            : 'object';

/**
 * Reads the kind of value a field holds from the schemas that constrain it.
 * A `$ref` to a mapped definition is that definition's type (plus `boolean`
 * when the definition allows the boolean schema form); a `$dynamicRef` is
 * bound the same way through the mapped definition that declares its
 * `$dynamicAnchor`. Anything the resolver cannot read plainly is skipped with
 * the reason.
 */
export class KindResolver {
  constructor(
    private readonly registry: SchemaRegistry,
    /** The (canonical) type name a definition location is mapped to, if any. */
    private readonly typeOf: (definition: string) => string | undefined,
    /** `$dynamicAnchor` name to the type it binds to and whether the boolean schema form is allowed. */
    private readonly dynamicAnchors: ReadonlyMap<string, { type: string; boolean: boolean }>,
  ) {}

  /**
   * The kind of a value that must match every schema at `locations` (one
   * field defined in several places). Schemas that state no kind (only
   * `default`, `pattern`, `deprecated`, ...) are neutral; when none states a
   * kind the value is `free`. Definitions stating different kinds are skipped.
   */
  kindOf(locations: readonly string[]): SchemaKind | SkippedKind {
    const stated: Array<{ location: string; atoms: Atoms }> = [];
    for (const location of locations) {
      const located = this.registry.locate(location);
      const result = this.atomsAt(located, []);
      if (result === 'neutral') continue;
      if ('skip' in result) return { skip: `${location}: ${result.skip}` };
      stated.push({ location, atoms: result });
    }
    if (stated.length === 0) return { kind: 'free', refs: [] };
    const kinds = new Set(stated.map((entry) => formatKind(entry.atoms.atoms)));
    if (kinds.size > 1) {
      const each = stated.map((entry) => `${formatKind(entry.atoms.atoms)} (${entry.location})`);
      return { skip: `its definitions state different kinds: ${each.join(', ')}` };
    }
    const refs = new Map<string, string>();
    stated.forEach((entry) => entry.atoms.refs.forEach((type, definition) => refs.set(definition, type)));
    return { kind: [...kinds][0]!, refs: [...refs].map(([definition, type]) => ({ definition, type })) };
  }

  /** Atoms for one schema, `neutral` when it states no kind. */
  private atomsAt(located: Located, stack: readonly string[]): Atoms | 'neutral' | SkippedKind {
    const { node, resource, location } = located;
    if (node === true) return single('free');
    if (node === false) return { atoms: new Set(), refs: new Map() };
    if (!isObject(node)) return { skip: 'not a schema' };
    if (stack.includes(location)) return { skip: `recursive definition (${[...stack, location].join(' -> ')})` };
    const path = [...stack, location];
    if (typeof node['$ref'] !== 'string') return this.ownAtoms(located, node, path);

    const target = this.registry.resolveRef(resource, node['$ref'], location);
    const type = this.typeOf(target.location);
    if (type !== undefined) {
      const atoms = new Set([type]);
      if (allowsBooleanForm(target.node)) atoms.add('boolean');
      return { atoms, refs: new Map([[target.location, type]]) };
    }
    const fromRef = this.atomsAt(target, path);
    // Draft-04: `$ref` replaces the schema object. From 2019-09 on it applies
    // next to its siblings (`type: object` beside a `$ref` to the extensions
    // mixin), so both must agree.
    if (resource.draft04) return fromRef;
    const fromSiblings = this.ownAtoms(located, node, path);
    if (fromRef === 'neutral') return fromSiblings;
    if (fromSiblings === 'neutral' || 'skip' in fromRef) return fromRef;
    if ('skip' in fromSiblings) return fromSiblings;
    const [refKind, siblingKind] = [formatKind(fromRef.atoms), formatKind(fromSiblings.atoms)];
    return refKind === siblingKind
      ? fromSiblings
      : { skip: `its $ref states ${refKind}, its other keywords ${siblingKind}` };
  }

  /** Atoms stated by a schema's own keywords, `$ref` aside. */
  private ownAtoms(located: Located, node: SchemaObjectNode, path: readonly string[]): Atoms | 'neutral' | SkippedKind {
    const sub = (suffix: string): Atoms | SkippedKind => this.subAtoms(`${located.location}/${suffix}`, path);
    if (typeof node['$dynamicRef'] === 'string') {
      const anchor = /^#([A-Za-z_][-A-Za-z0-9._]*)$/.exec(node['$dynamicRef'])?.[1];
      const bound = anchor === undefined ? undefined : this.dynamicAnchors.get(anchor);
      if (!bound) return { skip: `$dynamicRef ${node['$dynamicRef']} binds to no mapped definition` };
      return { atoms: new Set(bound.boolean ? [bound.type, 'boolean'] : [bound.type]), refs: new Map() };
    }
    const type = node['type'];
    if (typeof type === 'string' || Array.isArray(type)) {
      const parts: Array<Atoms | SkippedKind> = [];
      for (const name of typeof type === 'string' ? [type] : type) {
        if (name === 'string' || name === 'boolean' || name === 'null') parts.push(single(name));
        else if (name === 'number' || name === 'integer') parts.push(single('number'));
        else if (name === 'array') parts.push(arrayAtoms(node, sub));
        else if (name === 'object') parts.push(objectAtoms(node, sub));
        else return { skip: `unknown type ${JSON.stringify(name)}` };
      }
      return unionAtoms(parts, false);
    }
    for (const keyword of ['anyOf', 'oneOf']) {
      const members = node[keyword];
      if (Array.isArray(members)) return unionAtoms(members.map((_, i) => sub(`${keyword}/${i}`)), true);
    }
    if ('if' in node) {
      if (!('then' in node && 'else' in node)) return { skip: 'a conditional value (if without both then and else)' };
      return unionAtoms([sub('then'), sub('else')], true);
    }
    if (Array.isArray(node['enum'])) return { atoms: new Set(node['enum'].map(atomOfValue)), refs: new Map() };
    if ('const' in node) return single(atomOfValue(node['const']));
    if ('allOf' in node) return { skip: 'an allOf value' };
    return 'neutral';
  }

  /** Atoms of a subschema; one that states no kind holds anything (`free`). */
  private subAtoms(location: string, path: readonly string[]): Atoms | SkippedKind {
    const result = this.atomsAt(this.registry.locate(location), path);
    return result === 'neutral' ? single('free') : result;
  }
}

const single = (atom: string): Atoms => ({ atoms: new Set([atom]), refs: new Map() });

/** Every atom of `parts`; their top-level refs too when `keepRefs` (alternatives, not element kinds). */
function unionAtoms(parts: ReadonlyArray<Atoms | SkippedKind>, keepRefs: boolean): Atoms | SkippedKind {
  const atoms = new Set<string>();
  const refs = new Map<string, string>();
  for (const part of parts) {
    if ('skip' in part) return part;
    part.atoms.forEach((atom) => atoms.add(atom));
    if (keepRefs) part.refs.forEach((type, definition) => refs.set(definition, type));
  }
  return { atoms, refs };
}

/** `array<items>`; a tuple is skipped. */
function arrayAtoms(node: SchemaObjectNode, sub: (suffix: string) => Atoms | SkippedKind): Atoms | SkippedKind {
  if (Array.isArray(node['items'])) return { skip: 'a tuple (items as an array)' };
  if (node['items'] === undefined) return single('array<free>');
  const element = sub('items');
  return 'skip' in element ? element : single(`array<${formatKind(element.atoms)}>`);
}

/**
 * `map<values>` when the object accepts keys beyond fixed fields
 * (`additionalProperties`, non-extension `patternProperties`); `object` for
 * an inline object with fixed fields; `map<free>` for a bare `type: object`.
 */
function objectAtoms(node: SchemaObjectNode, sub: (suffix: string) => Atoms | SkippedKind): Atoms | SkippedKind {
  const values: Array<Atoms | SkippedKind> = [];
  if ('additionalProperties' in node && node['additionalProperties'] !== false) {
    values.push(sub('additionalProperties'));
  }
  for (const [pattern, schema] of entriesOf(node['patternProperties'])) {
    if (schema !== false && !isExtensionPattern(pattern)) {
      values.push(sub(`patternProperties/${escapePointer(pattern)}`));
    }
  }
  if (values.length > 0) {
    const merged = unionAtoms(values, false);
    return 'skip' in merged ? merged : single(`map<${formatKind(merged.atoms)}>`);
  }
  return 'properties' in node || node['additionalProperties'] === false ? single('object') : single('map<free>');
}

/** Whether a schema allows the boolean schema form (`type` includes `boolean`). */
const allowsBooleanForm = (node: unknown): boolean =>
  isObject(node) &&
  (node['type'] === 'boolean' || (Array.isArray(node['type']) && node['type'].includes('boolean')));

/**
 * `$dynamicAnchor` name to the type it binds to, from the mapped definitions
 * that declare one (in 3.1/3.2, `meta` → the Schema Object, which allows the
 * boolean form). Throws when one anchor is mapped to two types.
 */
export function dynamicAnchorBindings(
  registry: SchemaRegistry,
  mapped: ReadonlyArray<{ definition: string; type: string }>,
): Map<string, { type: string; boolean: boolean }> {
  const bindings = new Map<string, { type: string; boolean: boolean }>();
  for (const { definition, type } of mapped) {
    const node = registry.locate(definition).node;
    const anchor = isObject(node) ? node['$dynamicAnchor'] : undefined;
    if (typeof anchor !== 'string') continue;
    const bound = bindings.get(anchor);
    if (bound && bound.type !== type) {
      throw new Error(`$dynamicAnchor ${anchor} is declared by definitions mapped to ${bound.type} and ${type}`);
    }
    bindings.set(anchor, { type, boolean: (bound?.boolean ?? false) || allowsBooleanForm(node) });
  }
  return bindings;
}

// ---------------------------------------------------------------------------
// Type side
// ---------------------------------------------------------------------------

/** A mapped type a property's value refers to at its top level. */
export interface TypeRef {
  /** Canonical name of the mapped type. */
  type: string;
  /** `false` when the value narrows the type (`OAuthFlowObject & { tokenUrl: string }`). */
  exact: boolean;
  /** The declared shape of the value, narrowing included. */
  shape: () => TypeShape;
}

/** One declared property. */
export interface PropertyShape {
  /** Declared without `?`. */
  required: boolean;
  /** Canonical kind text of its value, `undefined` dropped. */
  kind: string;
  atoms: ReadonlySet<string>;
  refs: TypeRef[];
}

/** What a TypeScript type declares. */
export interface TypeShape {
  properties: Map<string, PropertyShape>;
  /** Whether arbitrary string keys are accepted (a string index signature, as in `Record<string, T>`). */
  stringIndex: boolean;
  /** Kind atoms of the index signature's values (empty without one). */
  indexAtoms: ReadonlySet<string>;
}

const propertyShape = (required: boolean, atoms: ReadonlySet<string>, refs: TypeRef[]): PropertyShape => ({
  required,
  kind: formatKind(atoms),
  atoms,
  refs,
});

/** The constituents of an intersection, or the type itself. */
const membersOf = (type: ts.Type): readonly ts.Type[] => (type.isIntersection() ? type.types : [type]);

/**
 * The types of one version namespace, with references to the mapped object
 * types recognised in property values.
 *
 * A reference is recognised by identity: the type itself, or an intersection
 * with the same constituents (`JsonSchema2020<V>` written inside the generic
 * is a different object than the `SchemaObject` alias of it, built from the
 * same parts). An intersection holding every constituent of a mapped type
 * plus more narrows it (`OAuthFlowObject & { tokenUrl: string }`).
 */
export class NamespaceTypes {
  private readonly mapped: Array<{ name: string; type: ts.Type; members: ReadonlySet<ts.Type> }> = [];

  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly exports: ReadonlyMap<string, ts.Type>,
    readonly namespace: string,
    mappedNames: readonly string[],
  ) {
    // Two names may denote one type; they share the canonical name `A=B`.
    const groups = new Map<ts.Type, string[]>();
    for (const name of [...mappedNames].sort()) {
      const type = this.declared(name);
      groups.set(type, [...(groups.get(type) ?? []), name]);
    }
    groups.forEach((names, type) => {
      this.mapped.push({ name: names.join('='), type, members: new Set(membersOf(type)) });
    });
  }

  /** The canonical name kinds use for a mapped type. */
  canonical(name: string): string {
    const type = this.declared(name);
    return this.mapped.find((candidate) => candidate.type === type)?.name ?? name;
  }

  /** The mapped type `type` is (`exact`) or narrows, if any. */
  private recognise(type: ts.Type): { name: string; exact: boolean } | undefined {
    const members = membersOf(type);
    let narrowed: { name: string; size: number } | undefined;
    for (const candidate of this.mapped) {
      if (candidate.type === type) return { name: candidate.name, exact: true };
      if (![...candidate.members].every((member) => members.includes(member))) continue;
      if (candidate.members.size === members.length) return { name: candidate.name, exact: true };
      if (!narrowed || candidate.members.size > narrowed.size) {
        narrowed = { name: candidate.name, size: candidate.members.size };
      }
    }
    return narrowed && { name: narrowed.name, exact: false };
  }

  /** The declared properties of an exported type, aliases resolved. */
  shape(name: string): TypeShape {
    return this.shapeOf(this.declared(name), `${this.namespace}.${name}`);
  }

  private declared(name: string): ts.Type {
    const type = this.exports.get(name);
    if (!type) throw new Error(`${this.namespace}.${name} is not exported`);
    return type;
  }

  /** A union declares every property any member declares; one is required only when every member requires it. */
  private shapeOf(type: ts.Type, label: string): TypeShape {
    if (type.isUnion()) {
      const members = type.types.map((member) => this.shapeOf(member, label));
      const properties = new Map<string, PropertyShape>();
      for (const member of members) {
        for (const [name, property] of member.properties) {
          const previous = properties.get(name);
          properties.set(
            name,
            propertyShape(
              members.every((other) => other.properties.get(name)?.required === true),
              new Set([...(previous?.atoms ?? []), ...property.atoms]),
              [...(previous?.refs ?? []), ...property.refs],
            ),
          );
        }
      }
      return {
        properties,
        stringIndex: members.some((member) => member.stringIndex),
        indexAtoms: new Set(members.flatMap((member) => [...member.indexAtoms])),
      };
    }
    if ((type.flags & ts.TypeFlags.Object) === 0 && !type.isIntersection()) {
      throw new Error(`${label} is not an object type: ${this.checker.typeToString(type)}`);
    }
    const properties = new Map<string, PropertyShape>();
    for (const property of this.checker.getPropertiesOfType(type)) {
      const refs: TypeRef[] = [];
      const atoms = this.atoms(this.checker.getTypeOfSymbol(property), refs, 0);
      properties.set(property.getName(), propertyShape((property.flags & ts.SymbolFlags.Optional) === 0, atoms, refs));
    }
    const index = this.checker.getIndexInfoOfType(type, ts.IndexKind.String);
    return {
      properties,
      stringIndex: index !== undefined,
      indexAtoms: index ? this.atoms(index.type, undefined, 0) : new Set(),
    };
  }

  /** Kind atoms of a value type; top-level references to mapped types go to `refs`. */
  private atoms(type: ts.Type, refs: TypeRef[] | undefined, depth: number): Set<string> {
    const label = this.checker.typeToString(type);
    if (type.isIntersection() && type.types.some((member) => (member.flags & ts.TypeFlags.StringLike) !== 0)) {
      // `string & {}`: the open end of a string enumeration.
      return new Set(['string']);
    }
    const recognised = this.recognise(type);
    if (recognised) {
      refs?.push({ type: recognised.name, exact: recognised.exact, shape: () => this.shapeOf(type, label) });
      return new Set([recognised.name]);
    }
    if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return new Set(['free']);
    if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never)) !== 0) return new Set();
    if ((type.flags & ts.TypeFlags.Null) !== 0) return new Set(['null']);
    if (type.isUnion()) {
      return new Set(type.types.flatMap((member) => [...this.atoms(member, refs, depth)]));
    }
    if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return new Set(['boolean']);
    if ((type.flags & ts.TypeFlags.StringLike) !== 0) return new Set(['string']);
    if ((type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0) return new Set(['number']);
    if (type.isIntersection() || depth > 8) return new Set(['object']);
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
      const elements = this.checker.getTypeArguments(type as ts.TypeReference);
      const atoms = new Set(elements.flatMap((element) => [...this.atoms(element, undefined, depth + 1)]));
      return new Set([`array<${formatKind(atoms)}>`]);
    }
    if ((type.flags & ts.TypeFlags.Object) !== 0) {
      const index = this.checker.getIndexInfoOfType(type, ts.IndexKind.String);
      if (index && this.checker.getPropertiesOfType(type).length === 0) {
        return new Set([`map<${formatKind(this.atoms(index.type, undefined, depth + 1))}>`]);
      }
    }
    return new Set(['object']);
  }
}

/** The spec types, loaded with the real TypeScript compiler. */
export class SpecTypeReader {
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  private readonly entrySymbol: ts.Symbol;

  /**
   * @param entryFile the module exporting the version namespaces (`src/spec/types/index.ts`)
   * @param tsconfigFile whose compiler options to use (`src/spec/tsconfig.json`)
   */
  constructor(
    private readonly entryFile: string,
    tsconfigFile: string,
  ) {
    const config = ts.readConfigFile(tsconfigFile, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(tsconfigFile));
    this.program = ts.createProgram({ rootNames: [entryFile], options: { ...options, noEmit: true } });
    this.checker = this.program.getTypeChecker();
    const source = this.program.getSourceFile(entryFile);
    const symbol = source && this.checker.getSymbolAtLocation(source);
    if (!symbol) throw new Error(`${entryFile}: not a module`);
    this.entrySymbol = symbol;
  }

  /** Compiler diagnostics for the loaded files, flattened (empty = they compile). */
  diagnostics(): string[] {
    return ts.getPreEmitDiagnostics(this.program).map((diagnostic) => {
      const where = diagnostic.file
        ? `${diagnostic.file.fileName}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}`
        : this.entryFile;
      return `${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    });
  }

  /** The names of the types a version namespace (`OAS32`) exports. */
  typeNames(namespace: string): string[] {
    return [...this.exportedTypes(namespace).keys()].sort();
  }

  /** A version namespace whose `mappedNames` are recognised as references in value kinds. */
  namespace(namespace: string, mappedNames: readonly string[]): NamespaceTypes {
    return new NamespaceTypes(this.checker, this.exportedTypes(namespace), namespace, mappedNames);
  }

  private exportedTypes(namespace: string): Map<string, ts.Type> {
    const types = new Map<string, ts.Type>();
    for (const symbol of this.checker.getExportsOfModule(this.namespaceSymbol(namespace))) {
      const resolved = this.resolve(symbol);
      if ((resolved.flags & ts.SymbolFlags.Type) !== 0) {
        types.set(symbol.getName(), this.checker.getDeclaredTypeOfSymbol(resolved));
      }
    }
    return types;
  }

  private namespaceSymbol(namespace: string): ts.Symbol {
    const symbol = this.checker.getExportsOfModule(this.entrySymbol).find((s) => s.getName() === namespace);
    if (!symbol) throw new Error(`${this.entryFile} exports no namespace ${namespace}`);
    return this.resolve(symbol);
  }

  private resolve(symbol: ts.Symbol): ts.Symbol {
    return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? this.checker.getAliasedSymbol(symbol) : symbol;
  }
}

// ---------------------------------------------------------------------------
// Module specifiers
// ---------------------------------------------------------------------------

/** One reference from a source file to another module. */
export interface ModuleReference {
  /** How it refers: `import`, `export`, `import()` type, `reference types`, ... */
  form: string;
  specifier: string;
  line: number;
}

/**
 * Every module a TypeScript source file refers to: import and export
 * declarations, `import x = require()`, `import()` types and calls, `require()`
 * calls, `declare module '...'` blocks and triple-slash references.
 */
export function moduleSpecifiers(fileName: string, text: string): ModuleReference[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: ModuleReference[] = [];
  const add = (form: string, specifier: string, position: number): void => {
    found.push({ form, specifier, line: source.getLineAndCharacterOfPosition(position).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        add(ts.isImportDeclaration(node) ? 'import' : 'export', node.moduleSpecifier.text, node.getStart());
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteral(expression)) add('import = require()', expression.text, node.getStart());
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        add('import() type', argument.literal.text, node.getStart());
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]!)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isImport || isRequire) add(isImport ? 'import()' : 'require()', node.arguments[0].text, node.getStart());
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      add('declare module', node.name.text, node.getStart());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  source.referencedFiles.forEach((ref) => add('reference path', ref.fileName, ref.pos));
  source.typeReferenceDirectives.forEach((ref) => add('reference types', ref.fileName, ref.pos));
  source.libReferenceDirectives.forEach((ref) => add('reference lib', ref.fileName, ref.pos));
  return found;
}
