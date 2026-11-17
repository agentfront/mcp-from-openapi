/**
 * Tests for the spec layer's version registry (detection, profiles,
 * features), its diagnostic helpers, and its barrel.
 */

import * as spec from '../spec';
import * as diagnosticsModule from '../spec/diagnostics';
import * as operationsModule from '../spec/operations';
import * as versionsModule from '../spec/versions';
import {
  DESCRIBED_VALUE_MAX_LENGTH,
  DIAGNOSTIC_KEY_MAX_LENGTH,
  LATEST_SPEC_FAMILY,
  LEGACY_OPERATION_LAYOUT,
  MAX_POINTER_SEGMENT_LENGTH,
  POINTER_TRUNCATION_MARKER,
  SPEC_DIAGNOSTIC_CODES,
  SPEC_FAMILIES,
  SPEC_FEATURES,
  SPEC_PROFILES,
  STANDARD_METHODS,
  SUPPORTED_SPEC_VERSIONS,
  appendPointer,
  compareSpecFamilies,
  describeSpecVersionProblem,
  describeValue,
  detectSpecVersion,
  diagnosticKey,
  escapePointerSegment,
  featureNewerThanDeclared,
  getSpecProfile,
  isFeatureAvailable,
  jsonPointer,
  listSkippedNewerOperations,
  resolveOperationLayout,
  type OperationLayout,
  type SpecDiagnostic,
  type SpecFamily,
  type SpecFeatureId,
  type SpecProfile,
  type SpecVersionInfo,
} from '../spec';

/* eslint-disable @typescript-eslint/no-explicit-any */

const EXPECTED = 'Expected OpenAPI 3.0.x, 3.1.x or 3.2.x (a later 3.x is read with the 3.2 rules)';

describe('detectSpecVersion', () => {
  it.each([
    ['3.0.0', '3.0', 0],
    ['3.0.3', '3.0', 0],
    ['3.0.4', '3.0', 0],
    ['3.0.10', '3.0', 0],
    ['3.1.0', '3.1', 1],
    ['3.1.2', '3.1', 1],
    ['3.1.0-rc1', '3.1', 1],
    ['3.2.0', '3.2', 2],
    ['3.2.1', '3.2', 2],
    ['3.2.0-rc.2+build.5', '3.2', 2],
    ['3.2.00', '3.2', 2],
  ])('reads openapi %p as supported %s', (declared, family, minor) => {
    expect(detectSpecVersion({ openapi: declared })).toEqual({
      status: 'supported',
      field: 'openapi',
      declared,
      major: 3,
      minor,
      family,
      diagnostics: [],
    });
  });

  it('ignores the patch number', () => {
    const first = detectSpecVersion({ openapi: '3.1.0' });
    const later = detectSpecVersion({ openapi: '3.1.99' });

    expect({ ...later, declared: first.declared }).toEqual(first);
  });

  it.each([
    ['3.3.0', 3],
    ['3.7.1', 7],
    ['3.10.0', 10],
    ['3.3.0-rc1', 3],
  ])('reads openapi %p as a newer minor processed with the latest profile', (declared, minor) => {
    expect(detectSpecVersion({ openapi: declared })).toEqual({
      status: 'newer-minor',
      field: 'openapi',
      declared,
      major: 3,
      minor,
      family: '3.2',
      diagnostics: [
        {
          severity: 'warning',
          code: SPEC_DIAGNOSTIC_CODES.NEWER_OPENAPI_VERSION,
          message: `The document declares OpenAPI "${declared}", newer than the latest version this library knows (3.2); it is processed with the OpenAPI 3.2 rules`,
          path: '/openapi',
        },
      ],
    });
    expect(getSpecProfile(detectSpecVersion({ openapi: declared }).family)).toBe(SPEC_PROFILES['3.2']);
  });

  it('cuts a long declared version in the newer-minor message', () => {
    const declared = `3.3.0-${'a'.repeat(1000)}`;
    const [diagnostic] = detectSpecVersion({ openapi: declared }).diagnostics;

    expect(diagnostic.message).toContain(`OpenAPI "${declared.slice(0, 32)}...", newer`);
    expect(diagnostic.message.length).toBeLessThan(200);
  });

  it('escapes terminal control sequences in a declared version', () => {
    const [diagnostic] = detectSpecVersion({ openapi: '3.3.0-\u001b[2J\u009b31m\u202e' }).diagnostics;

    expect(diagnostic.message).toContain('OpenAPI "3.3.0-\\u001b[2J\\u009b31m\\u202e", newer');
    expect(diagnostic.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e]/);
  });

  it.each([
    ['1.0.0', 1, 0],
    ['2.0.0', 2, 0],
    ['4.0.0', 4, 0],
    ['0.9.0', 0, 9],
    ['10.1.0', 10, 1],
  ])('reads openapi %p as unsupported', (declared, major, minor) => {
    expect(detectSpecVersion({ openapi: declared })).toEqual({
      status: 'unsupported',
      field: 'openapi',
      declared,
      major,
      minor,
      diagnostics: [],
    });
  });

  it.each([
    '3.1',
    '3',
    'banana',
    '',
    ' 3.1.0',
    '3.1.0 ',
    'v3.1.0',
    '3.1.x',
    '03.1.0',
    '3.01.0',
    '3.1.0-',
    '3.1.0-\nrc1',
    '3.1.0\n',
    '3.1.0.1',
    '3.99999999999999999999.0',
    '99999999999999999999.0.0',
  ])('reads openapi %p as malformed', (declared) => {
    expect(detectSpecVersion({ openapi: declared })).toEqual({
      status: 'malformed',
      field: 'openapi',
      declared,
      diagnostics: [],
    });
  });

  it.each([3.1, 3, 310, true, null, {}, ['3.1.0'], 3n])('reads the non-string openapi %p as malformed', (declared) => {
    expect(detectSpecVersion({ openapi: declared })).toEqual({
      status: 'malformed',
      field: 'openapi',
      declared,
      diagnostics: [],
    });
  });

  it('reads very long version strings in linear time', () => {
    const started = Date.now();

    expect(detectSpecVersion({ openapi: `3.1.${'0'.repeat(200_000)}x` }).status).toBe('malformed');
    expect(detectSpecVersion({ openapi: `3.1.0-${'a'.repeat(200_000)}\n` }).status).toBe('malformed');
    expect(detectSpecVersion({ openapi: `${'1'.repeat(200_000)}.0.0` }).status).toBe('malformed');
    expect(detectSpecVersion({ openapi: `3.1.0-${'a'.repeat(200_000)}` }).status).toBe('supported');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it.each(['2.0', 2])('reads swagger %p as Swagger 2.0', (declared) => {
    expect(detectSpecVersion({ swagger: declared })).toEqual({
      status: 'swagger-2.0',
      field: 'swagger',
      declared,
      major: 2,
      minor: 0,
      diagnostics: [],
    });
  });

  it.each([
    ['1.2', 1, 2],
    ['2.1', 2, 1],
    ['3.0', 3, 0],
  ])('reads swagger %p as unsupported', (declared, major, minor) => {
    expect(detectSpecVersion({ swagger: declared })).toEqual({
      status: 'unsupported',
      field: 'swagger',
      declared,
      major,
      minor,
      diagnostics: [],
    });
  });

  it.each(['2', '2.0.0', '2.0 ', 'x', '', '02.0', '99999999999999999999.0', 2.1, 1.2, 3, null, true, {}])(
    'reads swagger %p as malformed',
    (declared) => {
      expect(detectSpecVersion({ swagger: declared })).toEqual({
        status: 'malformed',
        field: 'swagger',
        declared,
        diagnostics: [],
      });
    },
  );

  it.each([
    {},
    { info: {} },
    { openapi: undefined },
    { swagger: undefined },
    null,
    undefined,
    'openapi',
    42,
    [],
    ['3.1.0'],
  ])('reads %p as declaring no version', (document) => {
    expect(detectSpecVersion(document)).toEqual({ status: 'missing', diagnostics: [] });
  });

  it('reads own fields only: an inherited openapi does not count', () => {
    expect(detectSpecVersion(Object.create({ openapi: '3.1.0' })).status).toBe('missing');
  });

  it('lets openapi decide when both fields are present, and reports the ignored swagger', () => {
    const conflicting = {
      severity: 'warning',
      code: SPEC_DIAGNOSTIC_CODES.CONFLICTING_VERSION_FIELDS,
      message: 'The document declares both `openapi` and `swagger`; `swagger` is ignored',
      path: '/swagger',
    };

    expect(detectSpecVersion({ openapi: '3.1.0', swagger: '2.0' })).toMatchObject({
      status: 'supported',
      family: '3.1',
      diagnostics: [conflicting],
    });
    expect(detectSpecVersion({ openapi: 'x', swagger: '2.0' })).toMatchObject({
      status: 'malformed',
      field: 'openapi',
      diagnostics: [conflicting],
    });
    expect(detectSpecVersion({ openapi: null, swagger: '2.0' })).toMatchObject({ status: 'malformed' });
    expect(detectSpecVersion({ openapi: '3.4.0', swagger: '2.0' }).diagnostics.map((d) => d.code)).toEqual([
      SPEC_DIAGNOSTIC_CODES.NEWER_OPENAPI_VERSION,
      SPEC_DIAGNOSTIC_CODES.CONFLICTING_VERSION_FIELDS,
    ]);
  });

  it('reads swagger when openapi is undefined', () => {
    expect(detectSpecVersion({ openapi: undefined, swagger: '2.0' })).toMatchObject({
      status: 'swagger-2.0',
      diagnostics: [],
    });
  });

  it('returns fresh diagnostics arrays', () => {
    const first = detectSpecVersion({ openapi: '3.1.0' });
    first.diagnostics.push({ severity: 'info', code: 'X', message: 'x' });

    expect(detectSpecVersion({ openapi: '3.1.0' }).diagnostics).toEqual([]);
  });
});

describe('describeSpecVersionProblem', () => {
  it.each(['3.0.0', '3.1.0', '3.2.0', '3.3.0'])('has nothing to say about openapi %p', (openapi) => {
    expect(describeSpecVersionProblem(detectSpecVersion({ openapi }))).toBeUndefined();
  });

  it.each<[unknown, string]>([
    [{ swagger: '2.0' }, `Swagger 2.0 documents are not supported. ${EXPECTED}`],
    [{ swagger: 2 }, `Swagger 2.0 documents are not supported. ${EXPECTED}`],
    [{ openapi: '4.0.0' }, `Unsupported version: OpenAPI "4.0.0". ${EXPECTED}`],
    [{ openapi: '2.0.0' }, `Unsupported version: OpenAPI "2.0.0". ${EXPECTED}`],
    [{ swagger: '1.2' }, `Unsupported version: Swagger "1.2". ${EXPECTED}`],
    [
      { openapi: '3.1' },
      `Malformed version: \`openapi\` must be a version string such as "3.1.0", found "3.1". ${EXPECTED}`,
    ],
    [
      { openapi: 3.1 },
      `Malformed version: \`openapi\` must be a version string such as "3.1.0", found 3.1. ${EXPECTED}`,
    ],
    [
      { openapi: { $ref: 'x' } },
      `Malformed version: \`openapi\` must be a version string such as "3.1.0", found an object. ${EXPECTED}`,
    ],
    [{ swagger: '2.0.0' }, `Malformed version: \`swagger\` must be "2.0", found "2.0.0". ${EXPECTED}`],
    [{}, `Missing version: the document has no \`openapi\` field. ${EXPECTED}`],
    [null, `Missing version: the document has no \`openapi\` field. ${EXPECTED}`],
  ])('describes %p', (document, message) => {
    expect(describeSpecVersionProblem(detectSpecVersion(document))).toBe(message);
  });

  it('cuts a long or hostile declared value', () => {
    const unsupported = describeSpecVersionProblem(detectSpecVersion({ openapi: `4.0.0-${'z'.repeat(5000)}` }));
    const malformed = describeSpecVersionProblem(detectSpecVersion({ openapi: `x\n\u009b${'z'.repeat(5000)}` }));

    expect(unsupported!.length).toBeLessThan(200);
    expect(malformed!.length).toBeLessThan(250);
    expect(malformed).toContain('found "x\\n\\u009bzz');
    expect(malformed).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe('families', () => {
  it('lists the known families oldest first, with the latest and the supported versions', () => {
    expect(SPEC_FAMILIES).toEqual(['3.0', '3.1', '3.2']);
    expect(LATEST_SPEC_FAMILY).toBe(SPEC_FAMILIES[SPEC_FAMILIES.length - 1]);
    expect(SUPPORTED_SPEC_VERSIONS).toEqual(['3.0.x', '3.1.x', '3.2.x']);
    expect(Object.isFrozen(SPEC_FAMILIES)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_SPEC_VERSIONS)).toBe(true);
  });

  it.each<[SpecFamily, SpecFamily, number]>([
    ['3.0', '3.1', -1],
    ['3.0', '3.2', -2],
    ['3.1', '3.1', 0],
    ['3.2', '3.0', 2],
  ])('compares %s with %s as %d', (a, b, expected) => {
    expect(compareSpecFamilies(a, b)).toBe(expected);
  });
});

describe('profiles', () => {
  const PROFILE_FIELDS: Record<SpecFamily, Omit<SpecProfile, 'family'>> = {
    '3.0': {
      fixedMethods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'],
      additionalOperations: false,
      parameterLocations: ['path', 'query', 'header', 'cookie'],
      querystringParameter: false,
      operationResponsesRequired: true,
      responseDescriptionRequired: true,
      pathsRequired: true,
      rootRequiresAnyOf: [],
      webhooks: false,
      componentsPathItems: false,
      componentsMediaTypes: false,
      self: false,
    },
    '3.1': {
      fixedMethods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'],
      additionalOperations: false,
      parameterLocations: ['path', 'query', 'header', 'cookie'],
      querystringParameter: false,
      operationResponsesRequired: false,
      responseDescriptionRequired: true,
      pathsRequired: false,
      rootRequiresAnyOf: ['paths', 'components', 'webhooks'],
      webhooks: true,
      componentsPathItems: true,
      componentsMediaTypes: false,
      self: false,
    },
    '3.2': {
      fixedMethods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'query'],
      additionalOperations: true,
      parameterLocations: ['path', 'query', 'querystring', 'header', 'cookie'],
      querystringParameter: true,
      operationResponsesRequired: false,
      responseDescriptionRequired: false,
      pathsRequired: false,
      rootRequiresAnyOf: ['paths', 'components', 'webhooks'],
      webhooks: true,
      componentsPathItems: true,
      componentsMediaTypes: true,
      self: true,
    },
  };

  it('has a profile for every family and no other', () => {
    expect(Object.keys(SPEC_PROFILES)).toEqual([...SPEC_FAMILIES]);
  });

  it.each(SPEC_FAMILIES.map((family) => [family]))('states what OpenAPI %s allows', (family) => {
    expect(getSpecProfile(family)).toEqual({ family, ...PROFILE_FIELDS[family] });
    expect(getSpecProfile(family)).toBe(SPEC_PROFILES[family]);
  });

  it.each(SPEC_FAMILIES.map((family) => [family]))('keeps the %s profile internally consistent', (family) => {
    const profile = SPEC_PROFILES[family];

    expect(profile.fixedMethods).toEqual(STANDARD_METHODS.filter((method) => profile.fixedMethods.includes(method)));
    expect(profile.querystringParameter).toBe(profile.parameterLocations.includes('querystring'));
    expect(profile.pathsRequired).toBe(profile.rootRequiresAnyOf.length === 0);
  });

  it.each(SPEC_FAMILIES.map((family) => [family]))('freezes the %s profile and its lists', (family) => {
    const profile = SPEC_PROFILES[family];

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.fixedMethods)).toBe(true);
    expect(Object.isFrozen(profile.parameterLocations)).toBe(true);
    expect(Object.isFrozen(profile.rootRequiresAnyOf)).toBe(true);
    expect(Object.isFrozen(SPEC_PROFILES)).toBe(true);
  });

  it('never loosens a rule from one minor version to the next', () => {
    // Each later minor version allows at least what the previous one did
    for (let index = 1; index < SPEC_FAMILIES.length; index++) {
      const older = SPEC_PROFILES[SPEC_FAMILIES[index - 1]];
      const newer = SPEC_PROFILES[SPEC_FAMILIES[index]];
      expect(newer.fixedMethods).toEqual(expect.arrayContaining([...older.fixedMethods]));
      expect(newer.parameterLocations).toEqual(expect.arrayContaining([...older.parameterLocations]));
    }
  });

  it.each([undefined, '3.3', '2.0', '3', '', 'constructor', '__proto__', 'toString', 3.1, null])(
    'has no profile for %p',
    (family) => {
      expect(getSpecProfile(family as any)).toBeUndefined();
    },
  );

  it('gives the profile of a detected version', () => {
    expect(getSpecProfile(detectSpecVersion({ openapi: '3.1.1' }).family)).toBe(SPEC_PROFILES['3.1']);
    expect(getSpecProfile(detectSpecVersion({ openapi: '4.0.0' }).family)).toBeUndefined();
  });
});

describe('features', () => {
  const featureIds = Object.keys(SPEC_FEATURES) as SpecFeatureId[];
  const firstFamilyWhere = (test: (profile: SpecProfile) => boolean): SpecFamily | undefined =>
    SPEC_FAMILIES.find((family) => test(SPEC_PROFILES[family]));

  it.each<[SpecFeatureId, SpecFamily]>([
    ['webhooks', '3.1'],
    ['jsonSchemaDialect', '3.1'],
    ['componentsPathItems', '3.1'],
    ['mutualTLS', '3.1'],
    ['self', '3.2'],
    ['queryMethod', '3.2'],
    ['additionalOperations', '3.2'],
    ['querystringParameter', '3.2'],
    ['cookieStyle', '3.2'],
    ['itemSchema', '3.2'],
    ['componentsMediaTypes', '3.2'],
    ['responseSummary', '3.2'],
    ['exampleDataValue', '3.2'],
    ['serverName', '3.2'],
    ['securitySchemeUri', '3.2'],
  ])('dates %s to OpenAPI %s', (feature, since) => {
    expect(SPEC_FEATURES[feature].since).toBe(since);
  });

  it('dates every feature after 3.0 and labels it', () => {
    for (const feature of featureIds) {
      const { since, label } = SPEC_FEATURES[feature];
      expect(SPEC_FAMILIES).toContain(since);
      expect(compareSpecFamilies(since, '3.0')).toBeGreaterThan(0);
      expect(label).toMatch(/\S/);
    }
  });

  it('agrees with the profiles on the features they also describe', () => {
    expect(SPEC_FEATURES.webhooks.since).toBe(firstFamilyWhere((p) => p.webhooks));
    expect(SPEC_FEATURES.componentsPathItems.since).toBe(firstFamilyWhere((p) => p.componentsPathItems));
    expect(SPEC_FEATURES.componentsMediaTypes.since).toBe(firstFamilyWhere((p) => p.componentsMediaTypes));
    expect(SPEC_FEATURES.self.since).toBe(firstFamilyWhere((p) => p.self));
    expect(SPEC_FEATURES.additionalOperations.since).toBe(firstFamilyWhere((p) => p.additionalOperations));
    expect(SPEC_FEATURES.querystringParameter.since).toBe(firstFamilyWhere((p) => p.querystringParameter));
    expect(SPEC_FEATURES.queryMethod.since).toBe(firstFamilyWhere((p) => p.fixedMethods.includes('query')));
  });

  it('freezes the table and its entries', () => {
    expect(Object.isFrozen(SPEC_FEATURES)).toBe(true);
    for (const feature of featureIds) expect(Object.isFrozen(SPEC_FEATURES[feature])).toBe(true);
  });

  it.each<[SpecFeatureId, SpecFamily, boolean]>([
    ['queryMethod', '3.1', false],
    ['queryMethod', '3.2', true],
    ['webhooks', '3.0', false],
    ['webhooks', '3.1', true],
    ['webhooks', '3.2', true],
  ])('says whether %s is available in %s: %p', (feature, family, expected) => {
    expect(isFeatureAvailable(feature, family)).toBe(expected);
  });

  it.each(['unknownFeature', 'constructor', '__proto__', 'toString'])(
    'treats the unknown feature %p as available',
    (feature) => {
      expect(isFeatureAvailable(feature as SpecFeatureId, '3.0')).toBe(true);
      const version = detectSpecVersion({ openapi: '3.0.0' });
      expect(featureNewerThanDeclared(feature as SpecFeatureId, version)).toBeUndefined();
    },
  );
});

describe('featureNewerThanDeclared', () => {
  it('reports a feature newer than the declared version, at the given path', () => {
    const version = detectSpecVersion({ openapi: '3.1.0' });

    expect(featureNewerThanDeclared('queryMethod', version, jsonPointer('paths', '/pets', 'query'))).toEqual({
      severity: 'warning',
      code: SPEC_DIAGNOSTIC_CODES.FEATURE_NEWER_THAN_DECLARED_VERSION,
      message: 'The `query` operation needs OpenAPI 3.2 or later, but the document declares OpenAPI "3.1.0"',
      path: '/paths/~1pets/query',
    });
  });

  it('omits the path when none is given', () => {
    const diagnostic = featureNewerThanDeclared('webhooks', detectSpecVersion({ openapi: '3.0.3' }));

    expect(diagnostic).toEqual({
      severity: 'warning',
      code: SPEC_DIAGNOSTIC_CODES.FEATURE_NEWER_THAN_DECLARED_VERSION,
      message: 'The `webhooks` field needs OpenAPI 3.1 or later, but the document declares OpenAPI "3.0.3"',
    });
    expect(Object.keys(diagnostic!)).not.toContain('path');
  });

  it.each(['3.2.0', '3.2.1', '3.3.0', '3.9.0'])('reports nothing for openapi %p', (openapi) => {
    const version = detectSpecVersion({ openapi });

    for (const feature of Object.keys(SPEC_FEATURES) as SpecFeatureId[]) {
      expect(featureNewerThanDeclared(feature, version, '/x')).toBeUndefined();
    }
  });

  it.each<[unknown]>([
    [{ openapi: '4.0.0' }],
    [{ openapi: 'banana' }],
    [{ swagger: '2.0' }],
    [{}],
  ])('reports nothing for a version that cannot be processed: %p', (document) => {
    expect(featureNewerThanDeclared('queryMethod', detectSpecVersion(document))).toBeUndefined();
  });

  it('cuts a long declared version in the message', () => {
    const declared = `3.0.0-${'x'.repeat(500)}`;
    const diagnostic = featureNewerThanDeclared('itemSchema', detectSpecVersion({ openapi: declared }));

    expect(diagnostic!.message).toBe(
      `Media Type \`itemSchema\` needs OpenAPI 3.2 or later, but the document declares OpenAPI "${declared.slice(0, 32)}..."`,
    );
  });
});

describe('diagnostic helpers', () => {
  it('names every code after itself, in a frozen table', () => {
    for (const [name, code] of Object.entries(SPEC_DIAGNOSTIC_CODES)) expect(code).toBe(name);
    expect(Object.isFrozen(SPEC_DIAGNOSTIC_CODES)).toBe(true);
    expect(Object.keys(SPEC_DIAGNOSTIC_CODES).sort()).toEqual([
      'ADDITIONAL_OPERATIONS_NOT_OBJECT',
      'CONFLICTING_VERSION_FIELDS',
      'DUPLICATE_FIXED_METHOD',
      'FEATURE_NEWER_THAN_DECLARED_VERSION',
      'INVALID_METHOD_TOKEN',
      'METHOD_CASE_VARIANT',
      'NEWER_OPENAPI_VERSION',
      'OPERATION_NOT_OBJECT',
      'PATH_ITEM_NOT_OBJECT',
      'REFUSED_METHOD',
    ]);
  });

  it.each<[string | number, string]>([
    ['a', 'a'],
    ['a/b', 'a~1b'],
    ['a~b', 'a~0b'],
    ['~1', '~01'],
    ['/~', '~1~0'],
    ['', ''],
    [0, '0'],
  ])('escapes the pointer segment %p as %p', (segment, expected) => {
    expect(escapePointerSegment(segment)).toBe(expected);
  });

  it.each<[string, string]>([
    ['a\u0000b', 'a\\u0000b'],
    ['line\r\nbreak', 'line\\u000d\\u000abreak'],
    ['\u001b[2J', '\\u001b[2J'],
    ['del\u007f', 'del\\u007f'],
    ['csi\u009b', 'csi\\u009b'],
    ['sep\u2028\u2029', 'sep\\u2028\\u2029'],
    ['bidi\u202e\u2066\u200f', 'bidi\\u202e\\u2066\\u200f'],
    ['lone\ud800x', 'lone\\ud800x'],
    ['lone\udc00', 'lone\\udc00'],
    ['end\ud83d', 'end\\ud83d'],
    ['high\ud83d\ue000', 'high\\ud83d\ue000'],
    ['pair\ud83d\ude00', 'pair\ud83d\ude00'],
    ['caf\u00e9 \u0422', 'caf\u00e9 \u0422'],
  ])('escapes the unsafe characters of the segment %p', (segment, expected) => {
    expect(escapePointerSegment(segment)).toBe(expected);
  });

  it('cuts a long segment at a bound, with a marker, without splitting an escape or a surrogate pair', () => {
    expect(MAX_POINTER_SEGMENT_LENGTH).toBe(256);
    expect(POINTER_TRUNCATION_MARKER).toBe('...(truncated)');
    expect(POINTER_TRUNCATION_MARKER).not.toMatch(/[/~]/);
    expect(escapePointerSegment('a'.repeat(256))).toBe('a'.repeat(256));
    expect(escapePointerSegment('a'.repeat(257))).toBe(`${'a'.repeat(256)}...(truncated)`);
    expect(escapePointerSegment(`${'a'.repeat(255)}~`)).toBe(`${'a'.repeat(255)}...(truncated)`);
    expect(escapePointerSegment(`${'a'.repeat(254)}/`)).toBe(`${'a'.repeat(254)}~1`);
    expect(escapePointerSegment(`${'a'.repeat(251)}\u0007`)).toBe(`${'a'.repeat(251)}...(truncated)`);
    expect(escapePointerSegment(`${'a'.repeat(255)}\ud83d\ude00`)).toBe(`${'a'.repeat(255)}...(truncated)`);
  });

  it('bounds the work and the output for a huge segment', () => {
    const started = Date.now();
    const escaped = escapePointerSegment('\u0000'.repeat(10_000_000));

    expect(escaped).toBe(`${'\\u0000'.repeat(42)}...(truncated)`);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('builds pointers from unescaped segments', () => {
    expect(jsonPointer()).toBe('');
    expect(jsonPointer('')).toBe('/');
    expect(jsonPointer('paths', '/pets/{id}', 'get')).toBe('/paths/~1pets~1{id}/get');
    expect(jsonPointer('tags', 0, 'name')).toBe('/tags/0/name');
  });

  it('extends an escaped pointer with unescaped segments', () => {
    expect(appendPointer('/paths/~1pets', 'additionalOperations', 'A/B')).toBe(
      '/paths/~1pets/additionalOperations/A~1B',
    );
    expect(appendPointer('', 'x')).toBe('/x');
    expect(appendPointer('/x')).toBe('/x');
    expect(appendPointer('/paths/a\nb', 'get')).toBe('/paths/a\\u000ab/get');
    expect(jsonPointer('paths', 'x'.repeat(1000), 'get')).toBe(`/paths/${'x'.repeat(256)}...(truncated)/get`);
  });

  it.each<[unknown, string]>([
    ['abc', '"abc"'],
    ['a\nb', '"a\\nb"'],
    ['', '""'],
    [42, '42'],
    [true, 'true'],
    [10n, '10'],
    [undefined, 'undefined'],
    [null, 'null'],
    [[], 'an array'],
    [{ secret: 'x' }, 'an object'],
    [() => 1, 'a function'],
    [Symbol('s'), 'a symbol'],
    ['\u001b[2J', '"\\u001b[2J"'],
    ['\u009b\u007f', '"\\u009b\\u007f"'],
    ['\u2028\u202e', '"\\u2028\\u202e"'],
    ['\ud800', '"\\ud800"'],
    ['\ud83d\ude00 caf\u00e9', '"\ud83d\ude00 caf\u00e9"'],
  ])('describes %p as %s', (value, expected) => {
    expect(describeValue(value)).toBe(expected);
  });

  it('cuts a long string', () => {
    expect(DESCRIBED_VALUE_MAX_LENGTH).toBe(64);
    expect(describeValue('x'.repeat(64))).toBe(`"${'x'.repeat(64)}"`);
    expect(describeValue('x'.repeat(65))).toBe(`"${'x'.repeat(64)}..."`);
    expect(describeValue('abcdef', 3)).toBe('"abc..."');
  });
});

describe('diagnosticKey', () => {
  const base: SpecDiagnostic = { severity: 'warning', code: 'X', message: 'm', path: '/p' };

  it('is the JSON of the four fields for an ordinary diagnostic', () => {
    expect(diagnosticKey(base)).toBe('["warning","X","/p","m"]');
    expect(diagnosticKey({ severity: 'info', code: 'X', message: 'm' })).toBe('["info","X",null,"m"]');
  });

  it('is equal for equal diagnostics and differs when any field differs', () => {
    const variants: SpecDiagnostic[] = [
      { ...base, severity: 'info' },
      { ...base, code: 'Y' },
      { ...base, message: 'n' },
      { ...base, path: '/q' },
      { ...base, path: '' },
      { severity: 'warning', code: 'X', message: 'm' },
      { ...base, path: '/p","m' },
    ];

    expect(diagnosticKey({ ...base })).toBe(diagnosticKey(base));
    expect(new Set([base, ...variants].map(diagnosticKey)).size).toBe(variants.length + 1);
  });

  it('stays within the bound for any size, keeping a prefix and hashing the whole', () => {
    const long = { ...base, message: 'z'.repeat(1_000_000) };
    const key = diagnosticKey(long);

    expect(DIAGNOSTIC_KEY_MAX_LENGTH).toBe(512);
    expect(key.length).toBeLessThanOrEqual(DIAGNOSTIC_KEY_MAX_LENGTH);
    expect(key).toMatch(/^\["warning","X","\/p","z+#[0-9a-z]+:[0-9a-f]{16}$/);
    expect(key.startsWith(JSON.stringify(['warning', 'X', '/p', long.message]).slice(0, 448))).toBe(true);
    expect(diagnosticKey({ ...long })).toBe(key);
  });

  it('tells apart long diagnostics of the same length that differ only at the end', () => {
    const keys = new Set(
      ['a', 'b', 'c', 'd'].map((last) => diagnosticKey({ ...base, message: `${'z'.repeat(20_000)}${last}` })),
    );

    expect(keys.size).toBe(4);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(DIAGNOSTIC_KEY_MAX_LENGTH);
  });

  it('switches to the hashed form just past the bound', () => {
    const fitting = { ...base, message: 'z'.repeat(512 - '["warning","X","/p",""]'.length) };
    const over = { ...base, message: `${fitting.message}z` };

    expect(diagnosticKey(fitting)).toBe(JSON.stringify(['warning', 'X', '/p', fitting.message]));
    expect(diagnosticKey(over)).toMatch(/#[0-9a-z]+:[0-9a-f]{16}$/);
  });
});

describe('resolveOperationLayout', () => {
  it.each<[string, SpecFamily]>([
    ['3.0.4', '3.0'],
    ['3.1.1', '3.1'],
    ['3.2.0', '3.2'],
    ['3.3.0', '3.2'],
  ])('reads openapi %p with the %s profile', (openapi, family) => {
    expect(resolveOperationLayout(detectSpecVersion({ openapi }))).toBe(SPEC_PROFILES[family]);
  });

  it.each<[unknown]>([[{}], [{ openapi: 'banana' }], [{ openapi: '4.0.0' }], [{ swagger: '2.0' }], [null]])(
    'reads %p with the legacy layout',
    (document) => {
      expect(resolveOperationLayout(detectSpecVersion(document))).toBe(LEGACY_OPERATION_LAYOUT);
    },
  );

  it('trusts the status, not a family set by hand', () => {
    const malformed: SpecVersionInfo = { status: 'malformed', family: '3.2', diagnostics: [] };
    const familyless: SpecVersionInfo = { status: 'supported', diagnostics: [] };

    expect(resolveOperationLayout(malformed)).toBe(LEGACY_OPERATION_LAYOUT);
    expect(resolveOperationLayout(familyless)).toBe(LEGACY_OPERATION_LAYOUT);
  });
});

describe('listSkippedNewerOperations', () => {
  const op = { responses: {} };
  const pathItem = { get: op, query: op, additionalOperations: { LINK: op } };

  it('names the query field and additionalOperations a 3.1 layout leaves out, with their features', () => {
    const pointer = jsonPointer('paths', '/x');

    expect(listSkippedNewerOperations(pathItem, SPEC_PROFILES['3.1'], { pointer })).toEqual([
      { field: 'query', feature: 'queryMethod', path: '/paths/~1x/query' },
      { field: 'additionalOperations', feature: 'additionalOperations', path: '/paths/~1x/additionalOperations' },
    ]);
  });

  it('names nothing under a layout that reads both', () => {
    expect(listSkippedNewerOperations(pathItem, SPEC_PROFILES['3.2'])).toEqual([]);
  });

  it('counts a present field whatever it holds, with paths relative to the path item by default', () => {
    expect(listSkippedNewerOperations({ query: null, additionalOperations: 'x' }, LEGACY_OPERATION_LAYOUT)).toEqual([
      { field: 'query', feature: 'queryMethod', path: '/query' },
      { field: 'additionalOperations', feature: 'additionalOperations', path: '/additionalOperations' },
    ]);
  });

  it('ignores absent, undefined and inherited fields', () => {
    const inherited = Object.create({ query: op, additionalOperations: {} });

    expect(listSkippedNewerOperations({ get: op }, LEGACY_OPERATION_LAYOUT)).toEqual([]);
    expect(listSkippedNewerOperations({ query: undefined }, LEGACY_OPERATION_LAYOUT)).toEqual([]);
    expect(listSkippedNewerOperations(inherited, LEGACY_OPERATION_LAYOUT)).toEqual([]);
  });

  it.each([null, undefined, 'x', [], 1])('names nothing for the non-object path item %p', (value) => {
    expect(listSkippedNewerOperations(value, LEGACY_OPERATION_LAYOUT)).toEqual([]);
  });

  it('names a left-out field no later version added without a feature', () => {
    const layout: OperationLayout = { fixedMethods: ['get', 'post'], additionalOperations: true };
    const [skipped] = listSkippedNewerOperations({ trace: op }, layout);

    expect(skipped).toEqual({ field: 'trace', path: '/trace' });
    expect('feature' in skipped).toBe(false);
  });

  it('feeds featureNewerThanDeclared, which reports only against a processable older version', () => {
    const report = (document: unknown): SpecDiagnostic[] => {
      const version = detectSpecVersion(document);
      return listSkippedNewerOperations(pathItem, resolveOperationLayout(version), { pointer: '/paths/~1x' }).flatMap(
        (skipped) => featureNewerThanDeclared(skipped.feature!, version, skipped.path) ?? [],
      );
    };

    expect(report({ openapi: '3.1.0' }).map((d) => [d.code, d.path])).toEqual([
      [SPEC_DIAGNOSTIC_CODES.FEATURE_NEWER_THAN_DECLARED_VERSION, '/paths/~1x/query'],
      [SPEC_DIAGNOSTIC_CODES.FEATURE_NEWER_THAN_DECLARED_VERSION, '/paths/~1x/additionalOperations'],
    ]);
    expect(report({ openapi: '3.2.0' })).toEqual([]);
    expect(report({ openapi: 'banana' })).toEqual([]);
  });
});

describe('the spec barrel', () => {
  const RUNTIME_EXPORTS = {
    diagnostics: [
      'DESCRIBED_VALUE_MAX_LENGTH',
      'DIAGNOSTIC_KEY_MAX_LENGTH',
      'MAX_POINTER_SEGMENT_LENGTH',
      'POINTER_TRUNCATION_MARKER',
      'SPEC_DIAGNOSTIC_CODES',
      'appendPointer',
      'describeValue',
      'diagnosticKey',
      'escapePointerSegment',
      'jsonPointer',
    ],
    operations: [
      'FULL_OPERATION_LAYOUT',
      'LEGACY_OPERATION_LAYOUT',
      'REFUSED_METHODS',
      'STANDARD_METHODS',
      'getOperation',
      'isHttpToken',
      'isRefusedMethod',
      'isSpecObject',
      'isStandardMethod',
      'listOperations',
      'ownProperty',
      'toStandardMethod',
      'wireMethod',
    ],
    versions: [
      'LATEST_SPEC_FAMILY',
      'SPEC_FAMILIES',
      'SPEC_FEATURES',
      'SPEC_PROFILES',
      'SUPPORTED_SPEC_VERSIONS',
      'compareSpecFamilies',
      'describeSpecVersionProblem',
      'detectSpecVersion',
      'featureNewerThanDeclared',
      'getSpecProfile',
      'isFeatureAvailable',
      'listSkippedNewerOperations',
      'resolveOperationLayout',
    ],
  };
  const modules: Record<keyof typeof RUNTIME_EXPORTS, Record<string, unknown>> = {
    diagnostics: diagnosticsModule,
    operations: operationsModule,
    versions: versionsModule,
  };

  it('exports every runtime value of the layer and nothing else', () => {
    expect(Object.keys(spec).sort()).toEqual(Object.values(RUNTIME_EXPORTS).flat().sort());
  });

  it.each(Object.keys(RUNTIME_EXPORTS) as Array<keyof typeof RUNTIME_EXPORTS>)(
    're-exports each value of %s unchanged',
    (module) => {
      for (const name of RUNTIME_EXPORTS[module]) {
        expect((spec as Record<string, unknown>)[name]).toBe(modules[module][name]);
      }
      expect(Object.keys(modules[module]).sort()).toEqual([...RUNTIME_EXPORTS[module]].sort());
    },
  );
});
