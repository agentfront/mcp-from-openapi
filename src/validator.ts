import type { OpenAPIDocument, ValidationResult, ValidationErrorDetail, ValidationWarning } from './types';
import { DIAGNOSTIC_CODES, LEGACY_PATH_KEY_MAX_LENGTH, MAX_DIAGNOSTICS, isReferenceObject } from './types';
import {
  analyzeParameters,
  describeContentWithoutSchema,
  readParameterContent,
  type ParameterSlot,
} from './parameter-resolver';
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
  isSpecObject,
  jsonPointer,
  listOperations,
  listSkippedNewerOperations,
  ownProperty,
  resolveOperationLayout,
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
  return `/paths/${path.length > LEGACY_PATH_KEY_MAX_LENGTH ? `${path.slice(0, LEGACY_PATH_KEY_MAX_LENGTH)}...` : path}`;
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
  version: SpecVersionInfo;
  /** The declared version's profile; the latest one when the version is not usable. */
  profile: SpecProfile;
  /** The operation fields read: the declared version's (`resolveOperationLayout`). */
  layout: OperationLayout;
  componentParameters: unknown;
  errors: FindingList;
  warnings: FindingList;
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
 * - The version comes from `detectSpecVersion`. OpenAPI 3.0, 3.1 and 3.2 are
 *   supported; a newer 3.x minor version is valid with a
 *   `NEWER_OPENAPI_VERSION` warning and checked with the latest rules.
 *   Anything else is an `INVALID_OPENAPI_VERSION` error (Swagger 2.0, another
 *   major, a malformed value) or `MISSING_OPENAPI_VERSION`.
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
    const context: ValidationContext = {
      version,
      profile: getSpecProfile(version.family) ?? SPEC_PROFILES[LATEST_SPEC_FAMILY],
      layout: resolveOperationLayout(version),
      componentParameters: ownProperty(doc.components, 'parameters'),
      errors: new FindingList('errors'),
      warnings: new FindingList('warnings'),
    };
    const { errors, warnings } = context;

    // Check OpenAPI version
    const versionProblem = versionError(version);
    if (versionProblem !== undefined) errors.push(versionProblem);
    warnings.push(...version.diagnostics.map(toFinding));

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

    // Check servers
    if (!doc.servers || doc.servers.length === 0) {
      warnings.push({
        message: 'No servers defined. You may need to provide a baseUrl option.',
        path: '/servers',
        code: 'NO_SERVERS',
      });
    }

    // Check security schemes
    if (doc.security && !doc.components?.securitySchemes) {
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
   * Resolve a local `#/components/parameters/<name>` reference (JSON Pointer
   * tokens decoded). Returns undefined for external or dangling references.
   */
  private resolveParameterRef(param: any, componentParameters: unknown): any {
    if (!param || typeof param !== 'object' || !('$ref' in param)) return param;
    const match = /^#\/components\/parameters\/(.+)$/.exec(String(param.$ref));
    if (!match) return undefined;
    const name = match[1].replace(/~1/g, '/').replace(/~0/g, '~');
    // Own properties only: a name like `constructor` must not resolve through the prototype
    return ownProperty(componentParameters, name);
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
      const resolvedPathLevel = pathLevelParameters.map((p: unknown) =>
        this.resolveParameterRef(p, context.componentParameters),
      );
      // A path-level violation is reported once, here, not again for each operation
      const pathLevelQuerystringValid = this.validateQuerystringUse(
        effectiveParameters(resolvedPathLevel, []),
        pathLevelPointer,
        `Path ${messageText(path)}`,
        context,
      );

      for (const entry of listed.operations) {
        this.validateOperation(entry, path, pathLevelParameters, resolvedPathLevel, pathLevelQuerystringValid, context);
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
    pathLevelParameters: unknown[],
    resolvedPathLevel: unknown[],
    pathLevelQuerystringValid: boolean,
    context: ValidationContext,
  ): void {
    const { errors, warnings } = context;
    const { method, operation } = entry;
    const legacyBase = legacyPathBase(path);
    const basePath =
      entry.source === 'fixed' ? `${legacyBase}/${method}` : `${legacyBase}/additionalOperations/${method}`;
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

    const resolvedOperationLevel = operationParameters.map((p) =>
      this.resolveParameterRef(p, context.componentParameters),
    );
    if (pathLevelQuerystringValid) {
      this.validateQuerystringUse(
        effectiveParameters(resolvedPathLevel, resolvedOperationLevel),
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
    const allParameters = [...resolvedPathLevel, ...resolvedOperationLevel];
    const hasUnresolvableRefs = allParameters.some((p: any) => p === undefined);
    const pathParams = path.match(/\{([^{}]+)\}/g)?.map((p) => p.slice(1, -1)) ?? [];
    // Bounded keys: a set of long strings of one length hashes into one bucket
    const definedPathParams = new Set(
      allParameters
        .filter((p: any) => p && p.in === 'path' && typeof p.name === 'string')
        .map((p: any) => boundedKey(p.name)),
    );

    for (const param of pathParams) {
      if (!hasUnresolvableRefs && !definedPathParams.has(boundedKey(param))) {
        errors.push({
          message: `Path parameter '${messageText(param)}' not defined in parameters: ${label}`,
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
    parameters: unknown[],
    pointer: string,
    where: string,
    context: ValidationContext,
  ): boolean {
    const objects = parameters.filter(isSpecObject);
    const querystrings = objects.filter((p) => p['in'] === 'querystring').length;
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
    if (objects.some((p) => p['in'] === 'query')) {
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

      const name = valueText(param['name']);
      if (!param['name']) {
        errors.push({
          message: 'Parameter missing name',
          path: `${paramPath}/name`,
          code: 'MISSING_PARAMETER_NAME',
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
        // A location a later version defines is a newer feature, not an error
        const feature =
          typeof location === 'string' && Object.hasOwn(LOCATION_FEATURES, location)
            ? LOCATION_FEATURES[location]
            : undefined;
        const newer =
          feature === undefined ? undefined : featureNewerThanDeclared(feature, context.version, appendPointer(pointer, i, 'in'));
        if (newer) {
          warnings.push(toFinding(newer));
        } else {
          errors.push({
            message: `Invalid parameter location: ${valueText(location)}. OpenAPI ${profile.family} allows ${profile.parameterLocations.join(', ')}`,
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
      } else if (!param['schema'] && !param['content']) {
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
    for (const { dropped, kept } of analyzeParameters(parameters, []).duplicates) {
      warnings.push(toFinding(duplicateParameterDiagnostic(dropped, kept, pointer)));
    }
  }
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
