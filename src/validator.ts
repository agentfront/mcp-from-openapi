import type { OpenAPIDocument, ValidationResult, ValidationErrorDetail, ValidationWarning } from './types';
import { DIAGNOSTIC_CODES, LEGACY_PATH_KEY_MAX_LENGTH, MAX_DIAGNOSTICS, isPresentSchema, isReferenceObject } from './types';
import {
  analyzeParameters,
  describeContentWithoutSchema,
  parameterIdentity,
  readParameterContent,
  type ParameterSlot,
} from './parameter-resolver';
import { readSelfField } from './base-uri';
import {
  LATEST_SPEC_FAMILY,
  SPEC_DIAGNOSTIC_CODES,
  SPEC_FEATURES,
  SPEC_PROFILES,
  appendPointer,
  describeSpecVersionProblem,
  describeValue,
  detectSpecVersion,
  diagnosticKey,
  featureNewerThanDeclared,
  getSpecProfile,
  isDotSegment,
  isSpecObject,
  jsonPointer,
  listOperations,
  listSkippedNewerOperations,
  ownProperty,
  parameterNameNotStringDiagnostic,
  readParameterName,
  readSwagger2BasePath,
  resolveOperationLayout,
  swagger2SkippedOperations,
  wireMethod,
  type OperationEntry,
  type OperationLayout,
  type SpecDiagnostic,
  type SpecFeatureId,
  type SpecProfile,
  type SpecVersionInfo,
} from './spec';

/**
 * Findings of the operation walker (`listOperations`) that are validation
 * errors, because the document breaks a rule of the specification:
 *
 * - `OPERATION_NOT_OBJECT`: a method field holding something other than an
 *   Operation Object. For a fixed field this keeps the outcome earlier
 *   releases gave (`get: "x"` was rejected, through `NO_RESPONSES`); a fixed
 *   field holding `null` stays silently skipped, as it always was.
 * - `ADDITIONAL_OPERATIONS_NOT_OBJECT`, `INVALID_METHOD_TOKEN`,
 *   `DUPLICATE_FIXED_METHOD`: `additionalOperations` must map RFC 9110 tokens
 *   other than the upper-case fixed methods to operations (OpenAPI 3.2 only,
 *   so no earlier document is affected).
 *
 * The others are warnings. `PATH_ITEM_NOT_OBJECT` covers `"/pets": null`,
 * which earlier releases accepted. `METHOD_CASE_VARIANT` (`Get`) and
 * `REFUSED_METHOD` (`CONNECT`) name methods the specification allows: the
 * document is valid, the library just does not send them, which
 * `generator.getDiagnostics()` reports.
 */
const WALKER_ERROR_CODES: ReadonlySet<string> = new Set([
  SPEC_DIAGNOSTIC_CODES.OPERATION_NOT_OBJECT,
  SPEC_DIAGNOSTIC_CODES.ADDITIONAL_OPERATIONS_NOT_OBJECT,
  SPEC_DIAGNOSTIC_CODES.INVALID_METHOD_TOKEN,
  SPEC_DIAGNOSTIC_CODES.DUPLICATE_FIXED_METHOD,
]);

/**
 * Parameter locations that only some versions define, with the feature that
 * names them. A location the declared version lacks but a later one defines
 * is reported as a feature newer than the declared version, not as invalid.
 */
const LOCATION_FEATURES: Readonly<Record<string, SpecFeatureId>> = Object.freeze({
  querystring: 'querystringParameter',
});

/** Longest method text a message quotes. */
const METHOD_TEXT_MAX_LENGTH = 64;

/**
 * Characters never put raw into a message (the spec layer's set): C0 and C1
 * controls, DEL, the line and paragraph separators, bidirectional formatting
 * characters, and lone surrogates (a cut can split a pair).
 */
// Built from a string: a compiler may turn the escape of U+2028 in a regex
// literal into a raw line separator, which ends the literal
const UNSAFE_MESSAGE_CHARACTERS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]' +
    '|[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]',
  'g',
);

/**
 * Document text inside a message: cut to `maxLength` characters (with
 * `...`), each unsafe character (control, separator, bidirectional
 * formatting, lone surrogate) replaced by its `\uXXXX` escape, so no
 * newline or terminal escape sequence reaches a log. Ordinary text,
 * quotes included, comes back unchanged.
 */
export function messageText(text: string, maxLength: number = LEGACY_PATH_KEY_MAX_LENGTH): string {
  const cut = text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  return cut.replace(
    UNSAFE_MESSAGE_CHARACTERS,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** A value inside a message: a string as `messageText`, anything else as `describeValue`. */
function valueText(value: unknown): string {
  return typeof value === 'string' ? messageText(value) : describeValue(value);
}

/** `GET /pets/{id}`: an operation in a message, its method as sent and its path, bounded and escaped. */
export function operationLabel(method: string, path: string): string {
  return `${messageText(wireMethod(method), METHOD_TEXT_MAX_LENGTH)} ${messageText(path)}`;
}

/**
 * The historical path of a path item in validation findings: `/paths/` and
 * the key as written, unescaped, cut past `LEGACY_PATH_KEY_MAX_LENGTH`.
 */
function legacyPathBase(path: string): string {
  return `/paths/${legacyKey(path)}`;
}

/** A document key in a historical path: as written, unescaped, cut past `LEGACY_PATH_KEY_MAX_LENGTH`. */
function legacyKey(key: string): string {
  return key.length > LEGACY_PATH_KEY_MAX_LENGTH ? `${key.slice(0, LEGACY_PATH_KEY_MAX_LENGTH)}...` : key;
}

/** A key of bounded length for a set of document strings (see `diagnosticKey`). */
function boundedKey(...parts: unknown[]): string {
  return diagnosticKey({ severity: 'info', code: '', message: JSON.stringify(parts.map(String)) });
}

/**
 * A list of findings that keeps at most `MAX_DIAGNOSTICS`, then one final
 * `DIAGNOSTICS_TRUNCATED` entry: a document with thousands of bad entries
 * must not grow the result without bound.
 */
class FindingList {
  readonly items: ValidationErrorDetail[] = [];
  private truncated = false;

  constructor(private readonly noun: 'errors' | 'warnings') {}

  push(...findings: ValidationErrorDetail[]): void {
    for (const finding of findings) {
      if (this.items.length < MAX_DIAGNOSTICS) {
        this.items.push(finding);
      } else if (!this.truncated) {
        this.truncated = true;
        this.items.push({
          message: `Only the first ${MAX_DIAGNOSTICS} ${this.noun} are listed; the document has more`,
          code: 'DIAGNOSTICS_TRUNCATED',
        });
      }
    }
  }
}

/** What one `validate` call reads and fills. */
interface ValidationContext {
  /** The version the document declares. */
  version: SpecVersionInfo;
  /** The declared version's profile; the latest one when the version is not usable. */
  profile: SpecProfile;
  /** The document is Swagger 2.0, validated with the 2.0 rules. */
  swagger: boolean;
  /** The operation fields read: the declared version's (`resolveOperationLayout`). */
  layout: OperationLayout;
  /** The map local parameter references point into: `components.parameters` (2.0: `parameters`). */
  componentParameters: unknown;
  /** A local reference to one of them: `#/components/parameters/<name>` (2.0: `#/parameters/<name>`). */
  parameterRef: RegExp;
  /** The errors found, capped. */
  errors: FindingList;
  /** The warnings found, capped. */
  warnings: FindingList;
  /** Each `operationId` seen so far, by its bounded key. */
  operationIds: Set<string>;
}

/** `Swagger 2.0`, `OpenAPI 3.1`: the name of a family, for a message. */
function specName(family: string): string {
  return family === '2.0' ? 'Swagger 2.0' : `OpenAPI ${family}`;
}

function toFinding(diagnostic: SpecDiagnostic): ValidationWarning {
  return { message: diagnostic.message, path: diagnostic.path, code: diagnostic.code };
}

/**
 * A walker finding as a validation error. Its message ends with what
 * generation does about it (`; the operation is ignored`), which is not true
 * of a document validation rejects, so that clause is dropped.
 */
function toError(diagnostic: SpecDiagnostic): ValidationErrorDetail {
  return { ...toFinding(diagnostic), message: diagnostic.message.replace(/; [^;]*$/, '') };
}

/**
 * Why a document's declared version cannot be processed, as the validation
 * error `validate` reports (`MISSING_OPENAPI_VERSION` when no version is
 * declared, `INVALID_OPENAPI_VERSION` otherwise); `undefined` when it can.
 */
export function versionError(version: SpecVersionInfo): ValidationErrorDetail | undefined {
  const message = describeSpecVersionProblem(version);
  if (message === undefined) return undefined;
  return {
    message,
    path: `/${version.field ?? 'openapi'}`,
    code: version.status === 'missing' ? 'MISSING_OPENAPI_VERSION' : 'INVALID_OPENAPI_VERSION',
  };
}

/** JSON Pointer of an operation: its fixed field, or its `additionalOperations` entry. */
export function operationPointer(path: string, entry: Pick<OperationEntry, 'method' | 'source'>): string {
  return entry.source === 'fixed'
    ? jsonPointer('paths', path, entry.method)
    : jsonPointer('paths', path, 'additionalOperations', entry.method);
}

/**
 * One `FEATURE_NEWER_THAN_DECLARED_VERSION` warning for each operation field
 * of a Path Item that the declared version's layout does not read (`query`,
 * `additionalOperations` in a document declaring 3.0 or 3.1): the operation
 * is ignored, and declaring the version that added it enables it. Nothing
 * for a version that cannot be processed (read with the legacy layout).
 * Shared with the generator, so both report the same diagnostic.
 */
export function skippedOperationDiagnostics(
  pathItem: unknown,
  layout: OperationLayout,
  version: SpecVersionInfo,
  pointer: string,
): SpecDiagnostic[] {
  // Swagger 2.0: the fields 2.0 does not define (`trace` among them), as the converter reports them
  if (version.family === '2.0') return swagger2SkippedOperations(pathItem, pointer);
  const found: SpecDiagnostic[] = [];
  for (const skipped of listSkippedNewerOperations(pathItem, layout, { pointer })) {
    // Every field a known layout leaves out is a feature (`queryMethod`, `additionalOperations`)
    const feature = skipped.feature as SpecFeatureId;
    const diagnostic = featureNewerThanDeclared(feature, version, skipped.path);
    if (diagnostic === undefined) continue;
    found.push({
      ...diagnostic,
      message: `${diagnostic.message}, so it is ignored (no tool); declare OpenAPI ${SPEC_FEATURES[feature].since} or later to read it`,
    });
  }
  return found;
}

/**
 * `parameter` with a number or boolean `name` replaced by its text (see
 * `readParameterName`), so it is merged and compared as generation reads
 * it; any other value is returned as it is.
 */
export function withTextName(parameter: unknown): unknown {
  if (!isSpecObject(parameter)) return parameter;
  const name = readParameterName(parameter['name']);
  return name.kind === 'coerced' ? { ...parameter, name: name.name } : parameter;
}

/** `"limit" (in: "query")`: a parameter in a message, its name and location bounded and escaped. */
function parameterText(parameter: Record<string, unknown>): string {
  return `${describeValue(parameter['name'])} (in: ${describeValue(parameter['in'])})`;
}

/**
 * The `INVALID_PARAMETER_CONTENT` warnings for a parameter's `content`, each
 * saying what generation does instead; none when it has no `content` or
 * `content` holds one usable media type:
 *
 * - the parameter defines both `schema` and `content`, which OpenAPI
 *   forbids: `content` is ignored (`schema` is, for `in: querystring`);
 * - `content` does not hold exactly one media type: of several, one is
 *   used; an empty one or one that is not a map is ignored. A querystring
 *   parameter without a media type is not covered: that is
 *   `QUERYSTRING_PARAMETER_WITHOUT_CONTENT`;
 * - the media type used is not a Media Type Object (`null`, a string, ...);
 * - the media type used declares `itemSchema`, which describes the items of
 *   a stream and is not read for a parameter.
 *
 * `pointer` locates the parameter. Shared with the generator, so both report
 * the same diagnostics. A media type left as a Reference Object is not
 * reported here: before dereferencing that is normal (the generator reports
 * one it reads unresolved).
 */
export function parameterContentDiagnostics(parameter: unknown, pointer: string): SpecDiagnostic[] {
  if (!isSpecObject(parameter) || isReferenceObject(parameter)) return [];
  const content = readParameterContent(parameter);
  if (content.kind === 'absent') return [];
  const querystring = parameter['in'] === 'querystring';
  const schema = parameter['schema'];
  const found: SpecDiagnostic[] = [];
  const warn = (problem: string): void => {
    found.push({
      severity: 'warning',
      code: DIAGNOSTIC_CODES.INVALID_PARAMETER_CONTENT,
      message: `Parameter ${parameterText(parameter)}: ${problem}`,
      path: pointer,
    });
  };

  if (schema !== undefined && schema !== null) {
    // A parameter with both reads `schema`, but a querystring one reads `content`
    if (!querystring) {
      warn('defines both schema and content, but must define only one; content is ignored and schema is used');
      return found;
    }
    if (content.kind === 'media') {
      warn('defines both schema and content, but must define only one; schema is ignored and content is used');
    }
  }
  if (content.kind !== 'media') {
    if (!querystring) {
      const what = content.kind === 'empty' ? 'no media type' : describeValue(content.value);
      warn(
        `content must hold exactly one media type, found ${what}; content is ignored and the value is read as a string`,
      );
    }
    return found;
  }

  const mediaType = describeValue(content.mediaType);
  if (content.count > 1) {
    warn(`content must hold exactly one media type, found ${content.count} media types; ${mediaType} is used`);
  }
  const media = ownProperty(ownProperty(parameter, 'content'), content.mediaType);
  if (content.media === undefined) {
    warn(
      `the media type ${mediaType} is not a Media Type Object (found ${describeValue(media)}); ` +
        describeContentWithoutSchema(content.mediaType),
    );
  } else if (ownProperty(media, 'itemSchema') !== undefined) {
    const hasSchema = ownProperty(media, 'schema') !== undefined && ownProperty(media, 'schema') !== null;
    warn(
      `the media type ${mediaType} declares itemSchema, which describes the items of a stream and is not read for a ` +
        `parameter; ${hasSchema ? 'its schema is used' : describeContentWithoutSchema(content.mediaType)}`,
    );
  }
  return found;
}

/**
 * The `DUPLICATE_PARAMETER` warning for a parameter dropped because a later
 * one in its own list (`kept`) has the same `name` and `in`. `listPointer`
 * locates the list. Shared with the generator.
 */
export function duplicateParameterDiagnostic(
  dropped: ParameterSlot,
  kept: ParameterSlot,
  listPointer: string,
): SpecDiagnostic {
  return {
    severity: 'warning',
    code: DIAGNOSTIC_CODES.DUPLICATE_PARAMETER,
    message:
      `Parameter ${parameterText(dropped.parameter as Record<string, unknown>)} appears again at index ${kept.index} ` +
      `of the same list, but a parameter list must not repeat a name and location; this one is ignored`,
    path: appendPointer(listPointer, dropped.index),
  };
}

/**
 * Validates OpenAPI documents with the rules of the version they declare.
 *
 * - The version comes from `detectSpecVersion`. Swagger 2.0 and OpenAPI 3.0,
 *   3.1 and 3.2 are supported; a newer 3.x minor version is valid with a
 *   `NEWER_OPENAPI_VERSION` warning and checked with the latest rules.
 *   Anything else is an `INVALID_OPENAPI_VERSION` error (another major or
 *   minor, a malformed value) or `MISSING_OPENAPI_VERSION`.
 * - Swagger 2.0 is validated as written, with its own rules (the generator
 *   converts it to OpenAPI 3.0 afterwards): the seven methods of a 2.0 Path
 *   Item (no `trace`, no `query`: each is a `FEATURE_NEWER_THAN_DECLARED_VERSION`
 *   warning); locations `path`, `query`, `header`, `formData` and `body`
 *   (`INVALID_PARAMETER_IN` for any other, `cookie` and `querystring`
 *   included); `responses` required; a body parameter needs `schema` and any
 *   other `type` (`MISSING_PARAMETER_SCHEMA`); per operation (path-level
 *   parameters included) at most one body parameter
 *   (`SWAGGER_MULTIPLE_BODY_PARAMETERS`) and none next to `formData` ones
 *   (`SWAGGER_BODY_AND_FORM_DATA`), rules of the 2.0 text the official schema
 *   cannot express; local parameter references are `#/parameters/<name>`;
 *   `basePath` must start with `/` and be usable in a URL
 *   (`INVALID_BASE_PATH`: no `{`, `}`, whitespace, `?`, `#`, backslash, `.`
 *   or `..` segment; `readSwagger2BasePath`). `NO_SERVERS` warns about a
 *   missing `host`, `NO_SECURITY_SCHEMES` about `security` without
 *   `securityDefinitions`.
 * - A parameter `name` that is a number or a boolean (YAML reads an unquoted
 *   `2024` so) is read as its text, with a `PARAMETER_NAME_NOT_STRING`
 *   warning, in every version; an absent, `null` or empty name is
 *   `MISSING_PARAMETER_NAME`, an object or array `INVALID_PARAMETER_NAME`.
 * - Operations are those the declared version defines
 *   (`resolveOperationLayout`), exactly the ones the generator turns into
 *   tools: `query` and `additionalOperations` from 3.2 on. In an older
 *   document they are not read; each gets a
 *   `FEATURE_NEWER_THAN_DECLARED_VERSION` warning.
 * - `responses` is required in 3.0 only (`NO_RESPONSES`); when present it
 *   must not be empty in any version.
 * - Parameter locations come from the declared version; `querystring` (3.2)
 *   in an older document is a warning. It must use `content` with a media
 *   type, appear at most once per operation, and not be combined with
 *   `in: query` parameters.
 * - Warnings, as generation copes with them: a parameter's `content` that
 *   does not hold exactly one media type (`INVALID_PARAMETER_CONTENT`), and
 *   a parameter list repeating a `name` and `in` (`DUPLICATE_PARAMETER`).
 * - `$self` (3.2 and later) must be a string in the form of a URI reference,
 *   without a fragment (`INVALID_SELF`, an error). In a 3.0 or 3.1 document
 *   it is a `FEATURE_NEWER_THAN_DECLARED_VERSION` warning. The rules the
 *   generator adds before using it as a base (no user information, an http,
 *   https or file scheme, ...) depend on where the document was read from,
 *   which the validator does not know: they are generator diagnostics.
 * - `errors` and `warnings` each keep at most `MAX_DIAGNOSTICS` entries, then
 *   one `DIAGNOSTICS_TRUNCATED` entry.
 *
 * Paths: see `ValidationErrorDetail.path` (historical form for the codes that
 * predate OpenAPI 3.2 support, JSON Pointers for the others).
 */
export class Validator {
  /**
   * Validate an OpenAPI document. Accepts any object, like the generator's
   * factories.
   */
  async validate(document: object): Promise<ValidationResult> {
    // Any object is accepted; read it as an OpenAPI document
    const doc = document as OpenAPIDocument;
    const version = detectSpecVersion(document);
    const swagger = version.family === '2.0';
    const context: ValidationContext = {
      version,
      profile: getSpecProfile(version.family) ?? SPEC_PROFILES[LATEST_SPEC_FAMILY],
      swagger,
      layout: resolveOperationLayout(version),
      componentParameters: swagger ? ownProperty(doc, 'parameters') : ownProperty(doc.components, 'parameters'),
      parameterRef: swagger ? /^#\/parameters\/(.+)$/ : /^#\/components\/parameters\/(.+)$/,
      errors: new FindingList('errors'),
      warnings: new FindingList('warnings'),
      operationIds: new Set(),
    };
    const { errors, warnings } = context;

    // Check OpenAPI version
    const versionProblem = versionError(version);
    if (versionProblem !== undefined) errors.push(versionProblem);
    warnings.push(...version.diagnostics.map(toFinding));

    // `$self` (3.2 and later): a URI reference without a fragment. In an
    // older document it is not read, which the generator reports too
    const self = readSelfField(document, version);
    if (self.kind === 'invalid') errors.push(toError(self.diagnostic));
    else if (self.kind === 'not-read' && self.diagnostic !== undefined) warnings.push(toFinding(self.diagnostic));

    // Check info
    if (!doc.info) {
      errors.push({
        message: 'Missing required field: info',
        path: '/info',
        code: 'MISSING_INFO',
      });
    } else {
      if (!doc.info.title) {
        errors.push({
          message: 'Missing required field: info.title',
          path: '/info/title',
          code: 'MISSING_TITLE',
        });
      }
      if (!doc.info.version) {
        errors.push({
          message: 'Missing required field: info.version',
          path: '/info/version',
          code: 'MISSING_VERSION',
        });
      }
    }

    // Check paths
    if (!doc.paths || Object.keys(doc.paths).length === 0) {
      warnings.push({
        message: 'No paths defined in OpenAPI document',
        path: '/paths',
        code: 'NO_PATHS',
      });
    } else {
      this.validatePaths(doc.paths, context);
    }

    // Swagger 2.0 `basePath`: the official schema requires a leading "/"
    // (#/properties/basePath/pattern), and a server URL cannot carry some paths
    const basePathValue = ownProperty(doc, 'basePath');
    if (swagger && basePathValue !== undefined) {
      const basePath = readSwagger2BasePath(basePathValue);
      if (basePath.kind !== 'usable') {
        errors.push({
          message:
            basePath.kind === 'missing-slash'
              ? `basePath must start with "/", found ${describeValue(basePathValue)}`
              : `basePath cannot be used: ${basePath.problem}`,
          path: '/basePath',
          code: 'INVALID_BASE_PATH',
        });
      }
    }

    // Check servers. Swagger 2.0 has one, from `host`: without it the API is on the
    // host serving the document, which a generator knows only from where it read it
    if (swagger) {
      if (ownProperty(doc, 'host') === undefined) {
        warnings.push({
          message:
            'No host defined: the API is on the host serving the document, known only when it is loaded with ' +
            'fromURL or LoadOptions.documentUri. You may need to provide a baseUrl option.',
          path: '/host',
          code: 'NO_SERVERS',
        });
      }
    } else if (!doc.servers || doc.servers.length === 0) {
      warnings.push({
        message: 'No servers defined. You may need to provide a baseUrl option.',
        path: '/servers',
        code: 'NO_SERVERS',
      });
    }

    // Check security schemes (Swagger 2.0: `securityDefinitions`)
    const schemes = swagger ? ownProperty(doc, 'securityDefinitions') : doc.components?.securitySchemes;
    if (doc.security && !schemes) {
      warnings.push({
        message: 'Security requirements defined but no security schemes found',
        path: '/security',
        code: 'NO_SECURITY_SCHEMES',
      });
    }

    return {
      valid: errors.items.length === 0,
      errors: errors.items.length > 0 ? errors.items : undefined,
      warnings: warnings.items.length > 0 ? warnings.items : undefined,
    };
  }

  /**
   * Resolve a local `#/components/parameters/<name>` reference (Swagger 2.0:
   * `#/parameters/<name>`; JSON Pointer tokens decoded). Returns undefined for
   * external or dangling references.
   */
  private resolveParameterRef(param: any, context: ValidationContext): any {
    if (!param || typeof param !== 'object' || !('$ref' in param)) return param;
    const match = context.parameterRef.exec(String(param.$ref));
    if (!match) return undefined;
    const name = match[1].replace(/~1/g, '/').replace(/~0/g, '~');
    // Own properties only: a name like `constructor` must not resolve through the prototype
    return ownProperty(context.componentParameters, name);
  }

  /** Walker findings of one Path Item become errors or warnings, see `WALKER_ERROR_CODES`. */
  private reportWalkerDiagnostics(
    pathItem: unknown,
    pointer: string,
    diagnostics: SpecDiagnostic[],
    context: ValidationContext,
  ): void {
    // A fixed field holding `null` was always skipped silently
    const nullFields = new Set(
      context.layout.fixedMethods
        .filter((method) => ownProperty(pathItem, method) === null)
        .map((method) => appendPointer(pointer, method)),
    );
    for (const diagnostic of diagnostics) {
      if (diagnostic.code === SPEC_DIAGNOSTIC_CODES.OPERATION_NOT_OBJECT && nullFields.has(diagnostic.path!)) continue;
      if (WALKER_ERROR_CODES.has(diagnostic.code)) context.errors.push(toError(diagnostic));
      else context.warnings.push(toFinding(diagnostic));
    }
  }

  /**
   * Validate paths
   */
  private validatePaths(paths: Record<string, any>, context: ValidationContext): void {
    const { errors, warnings } = context;
    for (const [path, pathItem] of Object.entries(paths)) {
      const pointer = jsonPointer('paths', path);
      const legacyBase = legacyPathBase(path);
      // The operations the declared version defines, as the generator reads them
      const listed = listOperations(pathItem, { layout: context.layout, pointer });
      this.reportWalkerDiagnostics(pathItem, pointer, listed.diagnostics, context);
      if (!pathItem) continue;

      // Check path format
      if (!path.startsWith('/')) {
        errors.push({
          message: `Path must start with '/': ${messageText(path)}`,
          path: legacyBase,
          code: 'INVALID_PATH_FORMAT',
        });
      } else {
        const problem = pathTemplateProblem(path);
        if (problem !== undefined) {
          errors.push({ message: `Path ${messageText(path)} ${problem}`, path: legacyBase, code: 'INVALID_PATH_FORMAT' });
        }
      }
      if (!isSpecObject(pathItem)) continue;

      // Operation fields the declared version does not define: not read, reported
      warnings.push(...skippedOperationDiagnostics(pathItem, context.layout, context.version, pointer).map(toFinding));

      // Path-item-level parameters apply to every operation (OpenAPI 4.8.9).
      // They get their own validation pass (their location is the path item,
      // not any single operation) before contributing to template coverage.
      const pathLevelParameters: unknown[] = Array.isArray(pathItem['parameters']) ? pathItem['parameters'] : [];
      const pathLevelPointer = appendPointer(pointer, 'parameters');
      if (pathLevelParameters.length > 0) {
        this.validateParameters(pathLevelParameters, `${legacyBase}/parameters`, pathLevelPointer, context);
      }
      const resolvedPathLevel = pathLevelParameters.map((p: unknown) => withTextName(this.resolveParameterRef(p, context)));
      const pathLevel = parameterFacts(resolvedPathLevel);
      // A path-level violation is reported once, here, not again for each operation. Swagger 2.0
      // has no `in: querystring` (its body rules are checked per operation instead)
      const pathLevelQuerystringValid =
        context.swagger ||
        this.validateQuerystringUse(pathLevel, pathLevelPointer, `Path ${messageText(path)}`, context);
      // Template expressions the path item does not define, by bounded key; each operation must then define them
      const templateNames = new Map(
        (path.match(/\{([^{}]+)\}/g) ?? [])
          .map((expression): [string, string] => [boundedKey(expression.slice(1, -1)), expression.slice(1, -1)])
          .filter(([key]) => !pathLevel.pathNames.has(key)),
      );

      for (const entry of listed.operations) {
        this.validateOperation(entry, path, resolvedPathLevel, pathLevel, templateNames, pathLevelQuerystringValid, context);
      }

      if (listed.operations.length === 0 && !pathItem['$ref']) {
        warnings.push({
          message: `Path has no operations: ${messageText(path)}`,
          path: legacyBase,
          code: 'NO_OPERATIONS',
        });
      }
    }
  }

  /**
   * Validate an operation
   */
  private validateOperation(
    entry: OperationEntry,
    path: string,
    resolvedPathLevel: unknown[],
    pathLevel: ParameterFacts,
    templateNames: ReadonlyMap<string, string>,
    pathLevelQuerystringValid: boolean,
    context: ValidationContext,
  ): void {
    const { errors, warnings } = context;
    const { method, operation } = entry;
    const legacyBase = legacyPathBase(path);
    const basePath =
      entry.source === 'fixed' ? `${legacyBase}/${method}` : `${legacyBase}/additionalOperations/${legacyKey(method)}`;
    const pointer = operationPointer(path, entry);
    const label = operationLabel(method, path);

    // Check for operationId
    if (!operation.operationId) {
      warnings.push({
        message: `Operation missing operationId: ${label}`,
        path: `${basePath}/operationId`,
        code: 'NO_OPERATION_ID',
      });
    }
    const operationId: unknown = operation.operationId;
    if (typeof operationId === 'string' && operationId !== '') {
      const key = boundedKey(operationId);
      if (context.operationIds.has(key)) {
        warnings.push({
          message: `Operation ${label} repeats the operationId ${describeValue(operationId)}, which must be unique; its tool gets a different name, and includeOperations matches every operation using it`,
          path: appendPointer(pointer, 'operationId'),
          code: 'DUPLICATE_OPERATION_ID',
        });
      }
      context.operationIds.add(key);
    }

    // Check for responses: required in 3.0 only; never empty when present
    const responses = operation.responses;
    const responsesInvalid =
      responses === undefined
        ? context.profile.operationResponsesRequired
        : !responses || Object.keys(responses).length === 0;
    if (responsesInvalid) {
      errors.push({
        message: `Operation missing responses: ${label}`,
        path: `${basePath}/responses`,
        code: 'NO_RESPONSES',
      });
    }

    // Validate parameters
    const operationParameters: unknown[] = Array.isArray(operation.parameters) ? operation.parameters : [];
    if (operationParameters.length > 0) {
      this.validateParameters(operationParameters, `${basePath}/parameters`, appendPointer(pointer, 'parameters'), context);
    }

    const resolvedOperationLevel = operationParameters.map((p) => withTextName(this.resolveParameterRef(p, context)));
    if (context.swagger) {
      this.validateBodyParameters(
        effectiveParameters(resolvedPathLevel, resolvedOperationLevel),
        appendPointer(pointer, 'parameters'),
        `Operation ${label}`,
        context,
      );
    }
    // Merged with the path item's by counting: the path item's are never listed again for each operation
    const operationLevel = parameterFacts(resolvedOperationLevel, pathLevel.identities);
    if (!context.swagger && pathLevelQuerystringValid) {
      this.validateQuerystringUse(
        {
          querystrings: pathLevel.querystrings + operationLevel.querystrings,
          queries: pathLevel.queries + operationLevel.queries,
        },
        appendPointer(pointer, 'parameters'),
        `Operation ${label}`,
        context,
      );
    }

    // Check for path parameters in path string. Path-item-level parameters
    // count too — the spec merges them into every operation. Local
    // `#/components/parameters/...` references are resolved so a query-param
    // ref cannot mask a missing path variable; only refs that CANNOT be
    // resolved here (external or dangling) defer the check to the
    // dereferenced validation pass in initialize().
    if (pathLevel.unresolvable || operationLevel.unresolvable) return;
    for (const [key, name] of templateNames) {
      if (!operationLevel.pathNames.has(key)) {
        errors.push({
          message: `Path parameter '${messageText(name)}' not defined in parameters: ${label}`,
          path: `${basePath}/parameters`,
          code: 'MISSING_PATH_PARAMETER',
        });
      }
    }
  }

  /**
   * The OpenAPI 3.2 rules on `in: querystring` across one parameter list (a
   * path item's, or an operation's merged with it): at most one such
   * parameter, and never together with `in: query` parameters. These are
   * errors whatever the declared version, since the generator reads the
   * location anyway. Returns whether the list follows them.
   */
  private validateQuerystringUse(
    { querystrings, queries }: Pick<ParameterFacts, 'querystrings' | 'queries'>,
    pointer: string,
    where: string,
    context: ValidationContext,
  ): boolean {
    if (querystrings === 0) return true;
    let valid = true;
    if (querystrings > 1) {
      context.errors.push({
        message: `${where}: ${querystrings} parameters are in: querystring; at most one is allowed`,
        path: pointer,
        code: 'MULTIPLE_QUERYSTRING_PARAMETERS',
      });
      valid = false;
    }
    if (queries > 0) {
      context.errors.push({
        message: `${where}: a parameter in: querystring is combined with parameters in: query, but a querystring parameter holds the whole query string`,
        path: pointer,
        code: 'QUERYSTRING_WITH_QUERY_PARAMETERS',
      });
      valid = false;
    }
    return valid;
  }

  /**
   * Swagger 2.0: an `in: body` parameter needs a Schema Object in `schema`;
   * any other needs `type` (2.0 schema #/definitions/bodyParameter/required,
   * #/definitions/nonBodyParameter/required), and `schema` is not one of its
   * fields. `MISSING_PARAMETER_SCHEMA`, the code of a 3.x parameter that does
   * not say what values it takes.
   */
  private validateSwaggerParameterType(
    param: Record<string, unknown>,
    location: unknown,
    name: string,
    paramPath: string,
    errors: FindingList,
  ): void {
    if (location === 'body') {
      if (!isSpecObject(param['schema'])) {
        errors.push({
          message: `Parameter '${name}' (in: body) missing schema: a body parameter is described by a Schema Object`,
          path: `${paramPath}`,
          code: 'MISSING_PARAMETER_SCHEMA',
        });
      }
    } else if (param['type'] === undefined) {
      const instead = param['schema'] === undefined ? '' : ' (Swagger 2.0 has no schema for it)';
      errors.push({
        message: `Parameter '${name}' missing type: a parameter not in: body is described by type${instead}`,
        path: `${paramPath}`,
        code: 'MISSING_PARAMETER_SCHEMA',
      });
    }
  }

  /**
   * Swagger 2.0, across an operation's parameters merged with its path
   * item's: at most one `in: body` parameter, and none together with
   * `in: formData` parameters. The 2.0 text states both ("There can be one
   * 'body' parameter at most", "Form parameters ... cannot be declared
   * together with a body parameter"); the official 2.0 schema checks each
   * parameter alone and cannot. Errors, with the codes the converter reports
   * the same cases with when validation is off.
   */
  private validateBodyParameters(
    parameters: unknown[],
    pointer: string,
    where: string,
    context: ValidationContext,
  ): void {
    const objects = parameters.filter(isSpecObject);
    const bodies = objects.filter((p) => p['in'] === 'body').length;
    if (bodies > 1) {
      context.errors.push({
        message: `${where}: ${bodies} parameters are in: body (path-level ones included), but a request has one body`,
        path: pointer,
        code: SPEC_DIAGNOSTIC_CODES.SWAGGER_MULTIPLE_BODY_PARAMETERS,
      });
    }
    if (bodies > 0 && objects.some((p) => p['in'] === 'formData')) {
      context.errors.push({
        message: `${where}: a parameter in: body and parameters in: formData cannot be declared together (path-level ones included)`,
        path: pointer,
        code: SPEC_DIAGNOSTIC_CODES.SWAGGER_BODY_AND_FORM_DATA,
      });
    }
  }

  /**
   * Validate parameters. `basePath` is the historical path of the list (path
   * key unescaped), `pointer` its JSON Pointer.
   */
  private validateParameters(
    parameters: unknown[],
    basePath: string,
    pointer: string,
    context: ValidationContext,
  ): void {
    const { errors, warnings, profile } = context;

    for (let i = 0; i < parameters.length; i++) {
      const param = parameters[i];
      const paramPath = `${basePath}/${i}`;

      if (!isSpecObject(param)) {
        errors.push({
          message: `Parameter must be a Parameter Object or a Reference Object, found ${describeValue(param)}`,
          path: appendPointer(pointer, i),
          code: 'INVALID_PARAMETER',
        });
        continue;
      }

      // Reference Objects are opaque until dereferenced (initialize() resolves
      // them before its validation pass) — structural checks don't apply
      if ('$ref' in param) {
        continue;
      }

      // A number or boolean name (an unquoted YAML `2024`) is read as its text, with a warning;
      // `String()` is never applied to an object, whose text can throw and is no name to send
      const nameValue = param['name'];
      const nameRead = readParameterName(nameValue);
      const name = valueText(nameRead.kind === 'invalid' ? nameValue : nameRead.name);
      if (nameRead.kind === 'coerced') {
        warnings.push(toFinding(parameterNameNotStringDiagnostic(nameValue as number | boolean, appendPointer(pointer, i))));
      } else if (nameValue === undefined || nameValue === null || nameValue === '') {
        errors.push({
          message: 'Parameter missing name',
          path: `${paramPath}/name`,
          code: 'MISSING_PARAMETER_NAME',
        });
      } else if (nameRead.kind === 'invalid') {
        errors.push({
          message: `Parameter name must be a string, found ${describeValue(nameValue)}`,
          path: appendPointer(pointer, i, 'name'),
          code: 'INVALID_PARAMETER_NAME',
        });
      }

      const location = param['in'];
      if (!location) {
        errors.push({
          message: 'Parameter missing "in" field',
          path: `${paramPath}/in`,
          code: 'MISSING_PARAMETER_IN',
        });
      } else if (!(profile.parameterLocations as readonly unknown[]).includes(location)) {
        // A location a later OpenAPI 3 version defines is a newer feature, not an error. Not in
        // Swagger 2.0, whose parameters are converted: an OpenAPI 3 location is not 2.0
        const feature =
          typeof location === 'string' && Object.hasOwn(LOCATION_FEATURES, location) && !context.swagger
            ? LOCATION_FEATURES[location]
            : undefined;
        const newer =
          feature === undefined ? undefined : featureNewerThanDeclared(feature, context.version, appendPointer(pointer, i, 'in'));
        if (newer) {
          warnings.push(toFinding(newer));
        } else {
          errors.push({
            message: `Invalid parameter location: ${valueText(location)}. ${specName(profile.family)} allows ${profile.parameterLocations.join(', ')}`,
            path: `${paramPath}/in`,
            code: 'INVALID_PARAMETER_IN',
          });
        }
      }

      if (location === 'path' && !param['required']) {
        errors.push({
          message: `Path parameter '${name}' must be required`,
          path: `${paramPath}/required`,
          code: 'PATH_PARAMETER_NOT_REQUIRED',
        });
      }

      if (context.swagger) {
        // Swagger 2.0: a body parameter is described by `schema`, any other by `type` (2.0 schema
        // #/definitions/bodyParameter/required, #/definitions/nonBodyParameter/required)
        this.validateSwaggerParameterType(param, location, name, paramPath, errors);
        continue;
      }

      if (location === 'querystring') {
        // OpenAPI 3.2: the whole query string is serialized by a media type
        const content = readParameterContent(param);
        if (content.kind === 'absent') {
          errors.push({
            message: `Parameter '${name}' in: querystring must define content (a media type and its schema), not schema`,
            path: appendPointer(pointer, i),
            code: 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT',
          });
        } else if (content.kind !== 'media') {
          errors.push({
            message:
              `Parameter '${name}' in: querystring must define content with one media type, found ` +
              `${content.kind === 'empty' ? 'none' : describeValue(content.value)}`,
            path: appendPointer(pointer, i, 'content'),
            code: 'QUERYSTRING_PARAMETER_WITHOUT_CONTENT',
          });
        }
      } else if (!isPresentSchema(param['schema']) && !param['content']) {
        errors.push({
          message: `Parameter '${name}' missing schema or content`,
          path: `${paramPath}`,
          code: 'MISSING_PARAMETER_SCHEMA',
        });
      }

      // `content`: one usable media type, and not together with `schema`
      warnings.push(...parameterContentDiagnostics(param, appendPointer(pointer, i)).map(toFinding));
    }

    // A list must not repeat a parameter (`name` and `in`)
    for (const { dropped, kept } of analyzeParameters(parameters.map(withTextName), []).duplicates) {
      warnings.push(toFinding(duplicateParameterDiagnostic(dropped, kept, pointer)));
    }
  }
}

/** Why a path key starting with `/` is no path template a URL keeps as written, or `undefined` */
function pathTemplateProblem(path: string): string | undefined {
  if (path.includes('\\')) return 'holds a backslash, which URL parsers read as a slash';
  const segments = path.split('/');
  if (segments.slice(1, -1).some((segment) => segment === '')) return 'has an empty segment (`//`)';
  if (segments.some(isDotSegment)) {
    return 'has a `.` or `..` segment, which URL parsers resolve to another path';
  }
  if (!/^(?:[^{}]|\{[^{}]+\})*$/.test(path)) return 'has a `{` or `}` that is not part of a `{name}` template expression';
  return undefined;
}

/**
 * An operation's parameters merged with its path item's as generation merges
 * them (`analyzeParameters`): an operation-level parameter replaces the
 * path-level one with the same `name` and `in` (OpenAPI Operation Object
 * `parameters`; a header name in any case), and of a repeated one in a list
 * the last is kept. Unresolved entries are kept as they are.
 */
function effectiveParameters(pathLevel: unknown[], operationLevel: unknown[]): unknown[] {
  return analyzeParameters(pathLevel, operationLevel).effective.map((slot) => slot.parameter);
}

/**
 * What the querystring and path template rules read from one parameter list, merged within itself. An
 * operation's list is merged with its path item's by counting (`replaced`), never by listing both again.
 */
interface ParameterFacts {
  /** The identity (`name` and `in`) of each parameter that has one */
  identities: Set<string>;
  /** How many are `in: querystring`, not counting one that replaces a parameter of `replaced` */
  querystrings: number;
  /** How many are `in: query`, counted the same way */
  queries: number;
  /** The bounded keys of the names of the `in: path` parameters */
  pathNames: Set<string>;
  /** Whether one is a reference the validator cannot resolve */
  unresolvable: boolean;
}

function parameterFacts(parameters: unknown[], replaced: ReadonlySet<string> = new Set()): ParameterFacts {
  const facts: ParameterFacts = {
    identities: new Set(),
    querystrings: 0,
    queries: 0,
    pathNames: new Set(),
    unresolvable: false,
  };
  for (const parameter of effectiveParameters(parameters, [])) {
    if (parameter === undefined) facts.unresolvable = true;
    if (!isSpecObject(parameter)) continue;
    const identity = parameterIdentity(parameter);
    if (identity === undefined) continue;
    facts.identities.add(identity);
    if (replaced.has(identity)) continue;
    if (parameter['in'] === 'querystring') facts.querystrings++;
    if (parameter['in'] === 'query') facts.queries++;
    if (parameter['in'] === 'path') facts.pathNames.add(boundedKey(parameter['name']));
  }
  return facts;
}
