import type { JsonSchema } from './types';

/**
 * Client dialect targets. Every MCP client accepts a different JSON Schema
 * subset; a target applies the transforms that make schemas valid for it:
 *
 * - `strict`  — the safe baseline for all clients: local `$ref`/`$defs`
 *   inlined, arrays always carry `items`, root-level compositions collapsed
 * - `claude`  — `strict` (Claude additionally rejects top-level unions on
 *   `input_schema` and caps tool names at 64 chars — both already covered by
 *   the generator's defaults)
 * - `openai`  — `strict` + every object closed (`additionalProperties: false`,
 *   required by OpenAI strict function calling)
 * - `gemini`  — `strict` + unions collapsed at every level and unsupported
 *   `format` values demoted to descriptions (Gemini rejects `$ref`/`$defs`,
 *   union-heavy schemas, and most string formats)
 */
export type ClientTarget = 'claude' | 'openai' | 'gemini' | 'strict';

type SchemaRecord = Record<string, unknown>;

/** Keys whose value is a map of schemas */
const MAP_KEYS = ['properties', 'patternProperties', 'dependentSchemas'] as const;
/** Keys whose value is a single schema (or a tuple array for `items`) */
const SCHEMA_KEYS = [
  'items',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'propertyNames',
  'contains',
  'contentSchema',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;
/** Keys whose value is an array of schemas */
const LIST_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

function isSchemaObject(value: unknown): value is SchemaRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Generic copy-on-write walk: `visit` transforms each node top-down, then
 * children are walked. The visitor must return a new node when it changes
 * anything.
 */
function walkSchema(node: JsonSchema, visit: (node: SchemaRecord) => SchemaRecord): JsonSchema {
  /* c8 ignore next -- guard for boolean/degenerate schemas in recursive traversal */
  if (!isSchemaObject(node)) return node;

  const visited = visit({ ...(node as SchemaRecord) });

  for (const key of MAP_KEYS) {
    const value = visited[key];
    if (isSchemaObject(value)) {
      const mapped: SchemaRecord = {};
      for (const [name, sub] of Object.entries(value)) {
        mapped[name] = walkSchema(sub as JsonSchema, visit);
      }
      visited[key] = mapped;
    }
  }

  for (const key of SCHEMA_KEYS) {
    const value = visited[key];
    if (Array.isArray(value)) {
      visited[key] = value.map((item) => walkSchema(item as JsonSchema, visit));
    } else if (isSchemaObject(value)) {
      visited[key] = walkSchema(value as JsonSchema, visit);
    }
  }

  for (const key of LIST_KEYS) {
    const value = visited[key];
    if (Array.isArray(value)) {
      visited[key] = value.map((member) => walkSchema(member as JsonSchema, visit));
    }
  }

  return visited as JsonSchema;
}

/**
 * Resolve local `$ref` pointers against the schema's own `$defs`/`definitions`
 * and strip the definition blocks. Cycles and unresolvable pointers become
 * permissive `{}` nodes with an explanatory description. (Generated schemas
 * are usually fully dereferenced already — this covers `dereference: false`
 * flows and hand-fed schemas.)
 */
export function inlineLocalRefs(schema: JsonSchema): JsonSchema {
  /* c8 ignore next -- guard for degenerate root schemas */
  if (!isSchemaObject(schema)) return schema;

  const root = schema as SchemaRecord;
  const resolvePointer = (pointer: string): unknown => {
    const parts = pointer
      .replace(/^#\/?/, '')
      .split('/')
      .filter((part) => part.length > 0)
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    let current: unknown = root;
    for (const part of parts) {
      if (!isSchemaObject(current)) return undefined;
      current = current[part];
    }
    return current;
  };

  const inline = (node: JsonSchema, seenPointers: Set<string>): JsonSchema => {
    /* c8 ignore next -- guard for boolean/degenerate schemas in recursive traversal */
    if (!isSchemaObject(node)) return node;
    const record = node as SchemaRecord;

    const ref = record['$ref'];
    if (typeof ref === 'string' && !ref.startsWith('#')) {
      // Non-local refs (URLs, relative files) cannot be resolved here — with
      // secureDefaults external resolution is off, so they must not survive
      // into schemas shipped to clients that reject $ref.
      const { $ref: _external, ...siblings } = record;
      return { description: `[External $ref ${ref} removed for client compatibility]`, ...siblings } as JsonSchema;
    }
    if (typeof ref === 'string') {
      // 2020-12 allows keywords alongside $ref; siblings win over the target
      const { $ref: _ref, ...siblings } = record;
      if (seenPointers.has(ref)) {
        return { description: '[Circular $ref removed for client compatibility]', ...siblings } as JsonSchema;
      }
      const resolved = resolvePointer(ref);
      if (!isSchemaObject(resolved)) {
        return { description: `[Unresolvable $ref ${ref} removed for client compatibility]`, ...siblings } as JsonSchema;
      }
      const inlined = inline(resolved as JsonSchema, new Set([...seenPointers, ref]));
      /* c8 ignore next -- inline() only returns non-objects for degenerate boolean schemas */
      if (!isSchemaObject(inlined)) return inlined;
      return { ...(inlined as SchemaRecord), ...siblings } as JsonSchema;
    }

    const copy: SchemaRecord = { ...record };
    delete copy['$defs'];
    delete copy['definitions'];

    for (const key of MAP_KEYS) {
      const value = copy[key];
      if (isSchemaObject(value)) {
        const mapped: SchemaRecord = {};
        for (const [name, sub] of Object.entries(value)) {
          mapped[name] = inline(sub as JsonSchema, seenPointers);
        }
        copy[key] = mapped;
      }
    }
    for (const key of SCHEMA_KEYS) {
      const value = copy[key];
      if (Array.isArray(value)) {
        copy[key] = value.map((item) => inline(item as JsonSchema, seenPointers));
      } else if (isSchemaObject(value)) {
        copy[key] = inline(value as JsonSchema, seenPointers);
      }
    }
    for (const key of LIST_KEYS) {
      const value = copy[key];
      if (Array.isArray(value)) {
        copy[key] = value.map((member) => inline(member as JsonSchema, seenPointers));
      }
    }

    return copy as JsonSchema;
  };

  return inline(schema, new Set());
}

/** Ensure every array schema carries an `items` schema (permissive when absent). */
export function ensureArrayItems(schema: JsonSchema): JsonSchema {
  return walkSchema(schema, (node) => {
    const type = node['type'];
    const isArray = type === 'array' || (Array.isArray(type) && type.includes('array'));
    if (isArray && node['items'] === undefined) {
      return { ...node, items: {} };
    }
    return node;
  });
}

/**
 * Merge `allOf` members into one node (properties/required union, later
 * scalar keywords win). Members carrying their own `allOf` are merged
 * recursively first, so nested compositions cannot leak into the result and
 * their properties are not lost.
 */
function mergeAllOf(node: SchemaRecord): SchemaRecord {
  const members = node['allOf'] as SchemaRecord[];
  const merged: SchemaRecord = {};
  const properties: SchemaRecord = {};
  const required = new Set<string>();

  for (const rawMember of members) {
    /* c8 ignore next -- boolean allOf members are degenerate and rare */
    if (!isSchemaObject(rawMember)) continue;
    const member = Array.isArray(rawMember['allOf']) ? mergeAllOf(rawMember) : rawMember;
    const { properties: memberProps, required: memberRequired, ...scalars } = member;
    Object.assign(merged, scalars);
    if (isSchemaObject(memberProps)) Object.assign(properties, memberProps);
    if (Array.isArray(memberRequired)) memberRequired.forEach((field) => required.add(String(field)));
  }

  const { allOf: _allOf, properties: ownProps, required: ownRequired, ...rest } = node;
  Object.assign(merged, rest);
  if (isSchemaObject(ownProps)) Object.assign(properties, ownProps);
  if (Array.isArray(ownRequired)) ownRequired.forEach((field) => required.add(String(field)));

  if (Object.keys(properties).length > 0) merged['properties'] = properties;
  if (required.size > 0) merged['required'] = [...required];
  return merged;
}

/** Is this the `anyOf: [X, { type: 'null' }]` wrapper toJsonSchema emits for nullable schemas? */
function nullableWrapperMember(node: SchemaRecord): SchemaRecord | undefined {
  const anyOf = node['anyOf'];
  if (!Array.isArray(anyOf) || anyOf.length !== 2) return undefined;
  const nullIndex = anyOf.findIndex((m) => isSchemaObject(m) && (m as SchemaRecord)['type'] === 'null');
  if (nullIndex === -1) return undefined;
  const other = anyOf[1 - nullIndex];
  return isSchemaObject(other) ? (other as SchemaRecord) : undefined;
}

function describeVariants(members: unknown[]): string {
  return members
    .map((member, index) => {
      /* c8 ignore next -- boolean union members are degenerate and rare */
      if (!isSchemaObject(member)) return `variant ${index + 1}`;
      const record = member as SchemaRecord;
      return (
        (typeof record['title'] === 'string' && record['title']) ||
        (typeof record['description'] === 'string' && record['description']) ||
        (typeof record['type'] === 'string' && `type ${record['type']}`) ||
        `variant ${index + 1}`
      );
    })
    .join('; ');
}

/**
 * Collapse ROOT-level compositions only: `allOf` merges; `oneOf`/`anyOf`
 * become a permissive node that documents the variants and preserves them
 * under `x-variants`. The nullable wrapper unwraps to its non-null member.
 */
export function collapseRootCompositions(schema: JsonSchema): JsonSchema {
  /* c8 ignore next -- guard for degenerate root schemas */
  if (!isSchemaObject(schema)) return schema;
  const node = { ...(schema as SchemaRecord) };

  if (Array.isArray(node['allOf'])) {
    // Re-enter: a member may have contributed a union that now sits at the root
    return collapseRootCompositions(mergeAllOf(node) as JsonSchema);
  }

  const nullableMember = nullableWrapperMember(node);
  if (nullableMember) {
    const { anyOf: _anyOf, ...rest } = node;
    const merged = { ...nullableMember, ...rest };
    const note = 'May be null.';
    merged['description'] = merged['description'] ? `${merged['description']} ${note}` : note;
    return merged as JsonSchema;
  }

  for (const key of ['oneOf', 'anyOf'] as const) {
    const members = node[key];
    if (Array.isArray(members)) {
      const { [key]: _members, ...rest } = node;
      return {
        ...rest,
        description: `${
          typeof rest['description'] === 'string' ? `${rest['description']} ` : ''
        }Accepts one of ${members.length} variants: ${describeVariants(members)}.`,
        'x-variants': members,
      } as JsonSchema;
    }
  }

  return node as JsonSchema;
}

/**
 * Collapse unions at EVERY level (Gemini): nullable wrappers unwrap with a
 * note; other `oneOf`/`anyOf` keep their first variant and document the
 * omitted alternatives; `allOf` merges.
 */
export function collapseNestedUnions(schema: JsonSchema): JsonSchema {
  return walkSchema(schema, (node) => {
    // Fixpoint: unwrapping one union can expose another (a nullable wrapper
    // whose member is itself a union, a kept variant carrying its own anyOf).
    // Each pass strictly removes one composition layer, so this terminates.
    let current = node;
    for (;;) {
      if (Array.isArray(current['allOf'])) {
        current = mergeAllOf(current);
        continue;
      }

      // Type ARRAYS are unions too (`type: ['string', 'null']` from OpenAPI
      // 3.0 nullable): keep the first non-null type, document the rest.
      const type = current['type'];
      if (Array.isArray(type)) {
        const nonNull = type.filter((t) => t !== 'null');
        const notes: string[] = [];
        if (nonNull.length > 1) notes.push(`Alternative types accepted: ${nonNull.slice(1).join(', ')}.`);
        if (nonNull.length !== type.length) notes.push('May be null.');
        current = { ...current, type: nonNull[0] ?? 'null' };
        if (notes.length > 0) {
          const joined = notes.join(' ');
          current['description'] = current['description'] ? `${current['description']} ${joined}` : joined;
        }
        continue;
      }

      const nullableMember = nullableWrapperMember(current);
      if (nullableMember) {
        const { anyOf: _anyOf, ...rest } = current;
        const merged = { ...nullableMember, ...rest };
        const note = 'May be null.';
        merged['description'] = merged['description'] ? `${merged['description']} ${note}` : note;
        current = merged;
        continue;
      }

      let collapsedUnion = false;
      for (const key of ['oneOf', 'anyOf'] as const) {
        const members = current[key];
        if (Array.isArray(members) && members.length > 0 && isSchemaObject(members[0])) {
          const { [key]: _members, ...rest } = current;
          const first = { ...(members[0] as SchemaRecord) };
          const note =
            members.length > 1
              ? `${members.length - 1} alternative schema variant(s) omitted for client compatibility: ${describeVariants(
                  members.slice(1),
                )}.`
              : undefined;
          const merged = { ...first, ...rest };
          if (note) {
            merged['description'] = merged['description'] ? `${merged['description']} ${note}` : note;
          }
          current = merged;
          collapsedUnion = true;
          break;
        }
      }
      if (collapsedUnion) continue;

      return current;
    }
  });
}

/** Formats Gemini accepts on string schemas; everything else is demoted to the description. */
const GEMINI_SUPPORTED_FORMATS = new Set(['date-time', 'enum']);

/** Formats Gemini accepts on NUMERIC schemas (integer/number nodes only). */
const GEMINI_NUMERIC_FORMATS = new Set(['int32', 'int64', 'float', 'double']);

function isNumericNode(node: SchemaRecord): boolean {
  const type = node['type'];
  return (
    type === 'integer' ||
    type === 'number' ||
    (Array.isArray(type) && (type.includes('integer') || type.includes('number')))
  );
}

/** Demote unsupported `format` values into descriptions (Gemini). */
export function demoteFormats(schema: JsonSchema, supported: Set<string> = GEMINI_SUPPORTED_FORMATS): JsonSchema {
  return walkSchema(schema, (node) => {
    const format = node['format'];
    if (typeof format !== 'string' || supported.has(format)) return node;
    // int32/int64/float/double are valid ONLY on numeric nodes — a string
    // schema carrying `format: int64` still gets demoted.
    if (GEMINI_NUMERIC_FORMATS.has(format) && isNumericNode(node)) return node;
    const { format: _format, ...rest } = node;
    const note = `(format: ${format})`;
    rest['description'] = rest['description'] ? `${rest['description']} ${note}` : note;
    return rest;
  });
}

function isObjectNode(node: SchemaRecord): boolean {
  const type = node['type'];
  return (
    type === 'object' ||
    (Array.isArray(type) && type.includes('object')) ||
    (type === undefined && isSchemaObject(node['properties']))
  );
}

/** Close every object node (`additionalProperties: false`) — OpenAI strict mode. */
export function enforceClosedObjects(schema: JsonSchema): JsonSchema {
  return walkSchema(schema, (node) => {
    // A schema-valued additionalProperties is a typed map — leave it alone.
    if (isObjectNode(node) && (node['additionalProperties'] === undefined || node['additionalProperties'] === true)) {
      return { ...node, additionalProperties: false };
    }
    return node;
  });
}

/**
 * OpenAI strict function calling requires EVERY property to be listed in
 * `required`; optional fields are expressed as required-but-nullable. This
 * rewrites each object node accordingly (typed optionals gain a `null` type;
 * untyped optionals are already permissive).
 */
export function requireAllProperties(schema: JsonSchema): JsonSchema {
  return walkSchema(schema, (node) => {
    if (!isObjectNode(node) || !isSchemaObject(node['properties'])) return node;

    const properties = node['properties'] as SchemaRecord;
    const originallyRequired = new Set(Array.isArray(node['required']) ? node['required'].map(String) : []);
    const rewritten: SchemaRecord = {};

    for (const [name, propSchema] of Object.entries(properties)) {
      // const-constrained properties are left untouched: adding null would
      // contradict the const, and const already admits exactly one value.
      if (originallyRequired.has(name) || !isSchemaObject(propSchema) || (propSchema as SchemaRecord)['const'] !== undefined) {
        rewritten[name] = propSchema;
        continue;
      }
      const prop = propSchema as SchemaRecord;
      // The null branch must stay satisfiable: an enum that omits null would
      // override the widened type and make the property required again.
      const withNullEnum = (next: SchemaRecord): SchemaRecord => {
        const enumValues = next['enum'];
        if (Array.isArray(enumValues) && !enumValues.includes(null)) {
          return { ...next, enum: [...enumValues, null] };
        }
        return next;
      };
      const type = prop['type'];
      if (typeof type === 'string' && type !== 'null') {
        rewritten[name] = withNullEnum({ ...prop, type: [type, 'null'] });
      } else if (Array.isArray(type) && !type.includes('null')) {
        rewritten[name] = withNullEnum({ ...prop, type: [...type, 'null'] });
      } else {
        // no declared type (or already nullable): null validates the widened
        // type, but an enum still needs the null member
        rewritten[name] = withNullEnum(prop);
      }
    }

    return { ...node, properties: rewritten, required: Object.keys(properties) };
  });
}

/**
 * Apply a client target's transform pipeline to a schema. Also exported for
 * standalone use on schemas that did not come from the generator.
 */
export function applyClientTarget(schema: JsonSchema, target: ClientTarget): JsonSchema {
  let result = inlineLocalRefs(schema);
  result = ensureArrayItems(result);

  if (target === 'gemini') {
    // Gemini never sees `x-variants`: its nested collapse handles the root
    // union too, keeping the first variant and documenting the rest — raw
    // preserved-variant metadata would be rejected by its schema subset.
    result = collapseNestedUnions(result);
    result = demoteFormats(result);
    return result;
  }

  result = collapseRootCompositions(result);
  if (target === 'openai') {
    result = enforceClosedObjects(result);
    result = requireAllProperties(result);
  }

  return result;
}
