/**
 * TypeScript call-signature emission.
 *
 * Renders a tool's final JSON Schemas (2020-12, post client-target transforms)
 * as TypeScript type text for code-execution surfaces such as FrontMCP
 * CodeCall, which present tools as importable typed functions instead of raw
 * tool JSON. The emitted return type is always the UNWRAPPED OpenAPI response
 * type — consumers that wrap results (e.g. `{status, ok, data, error}`) must
 * wrap the type themselves.
 */
import type { JsonSchema } from './types';

/** TypeScript rendering of one tool's call contract. */
export interface ToolTypeScriptInfo {
  /**
   * One-line arrow type with inline anonymous types, e.g.
   * `(input: { id: string; limit?: number }) => Promise<{ name: string }>`
   */
  signature: string;
  /**
   * Self-contained declaration text: JSDoc from schema descriptions, named
   * `<ToolName>Input` / `<ToolName>Output` types, and a `declare function`.
   */
  declaration: string;
}

/** Options for the type-signature printer. */
export interface TypeSignatureOptions {
  /**
   * Nesting depth beyond which types collapse to `unknown`.
   * @default 8
   */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

type SchemaRecord = Record<string, unknown>;

interface PrintContext {
  mode: 'compact' | 'pretty';
  maxDepth: number;
  /** Ancestor schemas on the current path — true cycles collapse to `unknown`,
   * diamond-shared nodes still print fully. */
  stack: Set<object>;
}

/**
 * Derive a PascalCase TypeScript identifier from an MCP tool name
 * (`[A-Za-z0-9_.-]`). Empty results become `Tool`; a leading digit is
 * prefixed with `T` (`3d.scan` → `T3dScan`).
 */
export function toPascalIdentifier(toolName: string): string {
  const segments = toolName.split(/[^A-Za-z0-9]+/).filter((s) => s.length > 0);
  const joined = segments.map((s) => s[0].toUpperCase() + s.slice(1)).join('');
  if (joined === '') {
    return 'Tool';
  }
  return /^[0-9]/.test(joined) ? `T${joined}` : joined;
}

function lowerFirst(name: string): string {
  return name[0].toLowerCase() + name.slice(1);
}

function isSchemaRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullSchema(value: unknown): boolean {
  return isSchemaRecord(value) && value['type'] === 'null';
}

/** Wrap union/intersection expressions in parentheses where composition
 * requires it; over-parenthesizing is valid TS, so the check is conservative. */
function paren(expr: string): string {
  return expr.includes(' | ') || expr.includes(' & ') ? `(${expr})` : expr;
}

function dedupe(parts: string[]): string[] {
  return [...new Set(parts)];
}

function quoteKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function literalOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  const t = typeof value;
  if (t === 'number') {
    // JSON.stringify(Infinity/NaN) is 'null' — degrade to `number` instead
    return Number.isFinite(value) ? JSON.stringify(value) : 'number';
  }
  if (t === 'string' || t === 'boolean') {
    return JSON.stringify(value);
  }
  return 'unknown';
}

/** Words that cannot name a `declare function` in a strict-mode module. */
const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield', 'await',
]);

function escapeJsdoc(text: string): string {
  return text.replace(/\*\//g, '*\\/');
}

/** JSDoc lines for a property in pretty mode (description, @format, @default,
 * @deprecated) — empty array when there is nothing to say. */
function jsdocLines(prop: unknown): string[] {
  if (!isSchemaRecord(prop)) {
    return [];
  }
  const lines: string[] = [];
  const description = prop['description'];
  if (typeof description === 'string' && description !== '') {
    lines.push(...escapeJsdoc(description).split('\n'));
  }
  const format = prop['format'];
  if (typeof format === 'string' && format !== '') {
    lines.push(`@format ${escapeJsdoc(format)}`);
  }
  if ('default' in prop && !(typeof prop['default'] === 'number' && !Number.isFinite(prop['default']))) {
    const rendered = JSON.stringify(prop['default']);
    if (rendered !== undefined) {
      lines.push(`@default ${escapeJsdoc(rendered)}`);
    }
  }
  if (prop['deprecated'] === true) {
    lines.push('@deprecated');
  }
  return lines;
}

function renderJsdoc(lines: string[], indent: string): string {
  if (lines.length === 1) {
    return `${indent}/** ${lines[0]} */\n`;
  }
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

function hasObjectShape(r: SchemaRecord): boolean {
  return (
    r['type'] === 'object' ||
    (r['type'] === undefined &&
      (r['properties'] !== undefined || r['additionalProperties'] !== undefined || r['patternProperties'] !== undefined))
  );
}

function typeExpr(schema: unknown, ctx: PrintContext, depth: number, indent: string): string {
  if (schema === true) {
    return 'unknown';
  }
  if (schema === false) {
    return 'never';
  }
  if (!isSchemaRecord(schema)) {
    return 'unknown';
  }
  if (ctx.stack.has(schema)) {
    return 'unknown';
  }
  if (depth >= ctx.maxDepth) {
    return 'unknown';
  }
  if (schema['$ref'] !== undefined) {
    return 'unknown';
  }
  ctx.stack.add(schema);
  try {
    return typeExprInner(schema, ctx, depth, indent);
  } finally {
    ctx.stack.delete(schema);
  }
}

function typeExprInner(r: SchemaRecord, ctx: PrintContext, depth: number, indent: string): string {
  // Literals win over structural typing
  if ('const' in r) {
    const rendered = literalOf(r['const']);
    if (rendered !== 'unknown') {
      return rendered;
    }
    // non-primitive const: fall through to structural rules
  }
  const enumMembers = r['enum'];
  if (Array.isArray(enumMembers)) {
    if (enumMembers.length === 0) {
      return 'unknown';
    }
    return dedupe(enumMembers.map(literalOf)).join(' | ');
  }

  // Nullable wrapper produced by toJsonSchema: anyOf [X, {type:'null'}]
  const anyOf = r['anyOf'];
  if (Array.isArray(anyOf) && anyOf.length === 2) {
    const nullIdx = anyOf.findIndex(isNullSchema);
    if (nullIdx >= 0 && !isNullSchema(anyOf[1 - nullIdx])) {
      return `${paren(typeExpr(anyOf[1 - nullIdx], ctx, depth + 1, indent))} | null`;
    }
  }

  const allOf = r['allOf'];
  if (Array.isArray(allOf)) {
    const parts = allOf.map((m) => paren(typeExpr(m, ctx, depth + 1, indent)));
    if (r['properties'] !== undefined) {
      parts.push(paren(objectExpr(r, ctx, depth, indent)));
    }
    return parts.length === 0 ? 'unknown' : dedupe(parts).join(' & ');
  }

  const union = Array.isArray(r['oneOf']) ? (r['oneOf'] as unknown[]) : Array.isArray(anyOf) ? anyOf : undefined;
  if (union) {
    if (union.length === 0) {
      return 'unknown';
    }
    return dedupe(union.map((m) => typeExpr(m, ctx, depth + 1, indent))).join(' | ');
  }

  const type = r['type'];
  if (Array.isArray(type)) {
    // String members only — the spread creates a fresh object per member, so a
    // crafted self-referential array element would bypass the identity guard
    const parts = type.filter((t): t is string => typeof t === 'string').map((t) => typeExpr({ ...r, type: t }, ctx, depth, indent));
    return parts.length === 0 ? 'unknown' : dedupe(parts).join(' | ');
  }
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return arrayExpr(r, ctx, depth, indent);
    default:
      if (hasObjectShape(r)) {
        return objectExpr(r, ctx, depth, indent);
      }
      return 'unknown';
  }
}

function arrayExpr(r: SchemaRecord, ctx: PrintContext, depth: number, indent: string): string {
  const items = r['items'];
  const prefix = Array.isArray(r['prefixItems']) ? (r['prefixItems'] as unknown[]) : Array.isArray(items) ? items : undefined;
  if (prefix) {
    const parts = prefix.map((m) => typeExpr(m, ctx, depth + 1, indent));
    let rest = '';
    // 2020-12: `items` beside `prefixItems` types the remaining elements
    if (Array.isArray(r['prefixItems']) && items !== undefined && !Array.isArray(items)) {
      rest = `, ...${paren(typeExpr(items, ctx, depth + 1, indent))}[]`;
    }
    return `[${parts.join(', ')}${rest}]`;
  }
  if (items === undefined) {
    return 'unknown[]';
  }
  return `${paren(typeExpr(items, ctx, depth + 1, indent))}[]`;
}

function objectExpr(r: SchemaRecord, ctx: PrintContext, depth: number, indent: string): string {
  const properties = isSchemaRecord(r['properties']) ? (r['properties'] as SchemaRecord) : {};
  const entries = Object.entries(properties);
  const required = new Set(Array.isArray(r['required']) ? (r['required'] as unknown[]) : []);

  // Value type for unnamed keys: additionalProperties plus patternProperties
  const extraTypes: string[] = [];
  const ap = r['additionalProperties'];
  if (ap === true) {
    extraTypes.push('unknown');
  } else if (isSchemaRecord(ap)) {
    extraTypes.push(typeExpr(ap, ctx, depth + 1, indent));
  }
  const patternProps = r['patternProperties'];
  if (isSchemaRecord(patternProps)) {
    for (const value of Object.values(patternProps)) {
      extraTypes.push(typeExpr(value, ctx, depth + 1, indent));
    }
  }
  const extra = extraTypes.length > 0 ? dedupe(extraTypes).join(' | ') : undefined;

  if (entries.length === 0) {
    if (extra !== undefined) {
      return `Record<string, ${extra}>`;
    }
    return ap === false ? 'Record<string, never>' : 'Record<string, unknown>';
  }

  const suffix = extra !== undefined ? ` & Record<string, ${extra}>` : '';
  if (ctx.mode === 'compact') {
    const members = entries.map(
      ([key, prop]) => `${quoteKey(key)}${required.has(key) ? '' : '?'}: ${typeExpr(prop, ctx, depth + 1, indent)}`,
    );
    return `{ ${members.join('; ')} }${suffix}`;
  }

  const inner = indent + '  ';
  let body = '{\n';
  for (const [key, prop] of entries) {
    const doc = jsdocLines(prop);
    if (doc.length > 0) {
      body += renderJsdoc(doc, inner);
    }
    body += `${inner}${quoteKey(key)}${required.has(key) ? '' : '?'}: ${typeExpr(prop, ctx, depth + 1, inner)};\n`;
  }
  body += `${indent}}`;
  return `${body}${suffix}`;
}

/**
 * True when the schema renders as a lone `{ ... }` object body with no
 * union/intersection suffix — the only shape valid as an `interface` body.
 * Mirrors the printer's branch order.
 */
function isPlainObjectBody(schema: unknown): boolean {
  if (!isSchemaRecord(schema) || schema['$ref'] !== undefined) {
    return false;
  }
  if (('const' in schema && literalOf(schema['const']) !== 'unknown') || Array.isArray(schema['enum'])) {
    return false;
  }
  if (Array.isArray(schema['allOf']) || Array.isArray(schema['oneOf']) || Array.isArray(schema['anyOf'])) {
    return false;
  }
  if (Array.isArray(schema['type']) || !hasObjectShape(schema)) {
    return false;
  }
  const properties = isSchemaRecord(schema['properties']) ? (schema['properties'] as SchemaRecord) : {};
  if (Object.keys(properties).length === 0) {
    return false; // renders as Record<...>
  }
  const ap = schema['additionalProperties'];
  if (ap === true || isSchemaRecord(ap) || isSchemaRecord(schema['patternProperties'])) {
    return false; // renders with a `& Record<...>` suffix
  }
  return true;
}

/** Emit a named root type: `interface` for plain object bodies, alias otherwise. */
function namedRoot(name: string, schema: unknown, ctx: PrintContext): string {
  const expr = typeExpr(schema, ctx, 0, '');
  return isPlainObjectBody(schema) ? `interface ${name} ${expr}` : `type ${name} = ${expr};`;
}

/** Render the parameter list for the signature / declare-function forms. */
function paramList(inputSchema: unknown, typeText: string): string {
  if (inputSchema === true) {
    return `(input?: ${typeText})`;
  }
  if (!isSchemaRecord(inputSchema)) {
    return '()';
  }
  const properties = isSchemaRecord(inputSchema['properties']) ? (inputSchema['properties'] as SchemaRecord) : {};
  const keys = Object.keys(properties);
  if (keys.length === 0) {
    const ap = inputSchema['additionalProperties'];
    const hasExtra = ap === true || isSchemaRecord(ap) || isSchemaRecord(inputSchema['patternProperties']);
    const objectish = inputSchema['type'] === 'object' || inputSchema['type'] === undefined;
    // Composed roots (oneOf/anyOf/allOf/enum/const) type real data even
    // though they declare no properties of their own.
    const composed =
      Array.isArray(inputSchema['allOf']) ||
      Array.isArray(inputSchema['oneOf']) ||
      Array.isArray(inputSchema['anyOf']) ||
      Array.isArray(inputSchema['enum']) ||
      'const' in inputSchema;
    // A closed, empty object root truly takes no input; anything else
    // (typed additionalProperties, composed or non-object roots) carries data.
    return objectish && !hasExtra && !composed ? '()' : `(input: ${typeText})`;
  }
  const required = new Set(Array.isArray(inputSchema['required']) ? (inputSchema['required'] as unknown[]) : []);
  const allOptional = keys.every((k) => !required.has(k));
  return allOptional ? `(input?: ${typeText})` : `(input: ${typeText})`;
}

/** Root output oneOf variants annotated from x-status-code / x-content-type. */
function outputVariantsDeclaration(name: string, variants: unknown[], ctx: PrintContext): string {
  const lines = variants.map((member) => {
    let comment = '';
    if (isSchemaRecord(member)) {
      const status = member['x-status-code'];
      if (typeof status === 'number' || typeof status === 'string') {
        const contentType = member['x-content-type'];
        // Content types like `*/*` would terminate the comment unescaped
        const ct = typeof contentType === 'string' ? ` (${escapeJsdoc(contentType)})` : '';
        comment = `/** status ${escapeJsdoc(String(status))}${ct} */ `;
      }
    }
    return `  | ${comment}${typeExpr(member, ctx, 1, '  ')}`;
  });
  return `type ${name} =\n${lines.join('\n')};`;
}

/**
 * Render a tool's TypeScript signature and self-contained declaration from
 * its final (post-transform) schemas. Pure and deterministic.
 */
export function emitToolTypeScript(
  toolName: string,
  description: string | undefined,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema | undefined,
  options: TypeSignatureOptions = {},
): ToolTypeScriptInfo {
  const maxDepth =
    typeof options.maxDepth === 'number' && Number.isFinite(options.maxDepth)
      ? Math.max(1, Math.floor(options.maxDepth))
      : DEFAULT_MAX_DEPTH;
  const compact: PrintContext = { mode: 'compact', maxDepth, stack: new Set() };
  const pretty: PrintContext = { mode: 'pretty', maxDepth, stack: new Set() };

  const inputCompact = typeExpr(inputSchema, compact, 0, '');
  const outputCompact = outputSchema === undefined ? 'unknown' : typeExpr(outputSchema, compact, 0, '');
  const signature = `${paramList(inputSchema, inputCompact)} => Promise<${outputCompact}>`;

  const base = toPascalIdentifier(toolName);
  const inputName = `${base}Input`;
  const outputName = `${base}Output`;
  const blocks: string[] = [];

  if (typeof description === 'string' && description !== '') {
    blocks.push(renderJsdoc(escapeJsdoc(description).split('\n'), '').trimEnd());
  }

  blocks.push(namedRoot(inputName, inputSchema, pretty));

  const outputUnion =
    isSchemaRecord(outputSchema) && Array.isArray(outputSchema['oneOf'])
      ? (outputSchema['oneOf'] as unknown[])
      : undefined;
  if (outputSchema === undefined) {
    blocks.push(`type ${outputName} = unknown;`);
  } else if (outputUnion && outputUnion.some((m) => isSchemaRecord(m) && m['x-status-code'] !== undefined)) {
    blocks.push(outputVariantsDeclaration(outputName, outputUnion, pretty));
  } else {
    blocks.push(namedRoot(outputName, outputSchema, pretty));
  }

  let fnName = lowerFirst(base);
  if (RESERVED_WORDS.has(fnName)) {
    fnName = `${fnName}_`;
  }
  blocks.push(`declare function ${fnName}${paramList(inputSchema, inputName)}: Promise<${outputName}>;`);

  return { signature, declaration: blocks.join('\n\n') };
}
