/**
 * The spec layer: everything that knows about OpenAPI versions.
 *
 * Nothing under `src/spec/` imports from outside it (enforced by
 * `src/spec/tsconfig.json`), so the layer can be extracted as is.
 *
 * @module
 */

export type * from './types';

export {
  SPEC_DIAGNOSTIC_CODES,
  DESCRIBED_VALUE_MAX_LENGTH,
  DIAGNOSTIC_KEY_MAX_LENGTH,
  MAX_POINTER_SEGMENT_LENGTH,
  POINTER_TRUNCATION_MARKER,
  appendPointer,
  describeValue,
  diagnosticKey,
  escapePointerSegment,
  jsonPointer,
} from './diagnostics';
export type { SpecDiagnostic, SpecDiagnosticCode, SpecDiagnosticSeverity } from './diagnostics';

export {
  FULL_OPERATION_LAYOUT,
  LEGACY_OPERATION_LAYOUT,
  REFUSED_METHODS,
  STANDARD_METHODS,
  getOperation,
  isHttpToken,
  isRefusedMethod,
  isSpecObject,
  isStandardMethod,
  listOperations,
  ownProperty,
  toStandardMethod,
  wireMethod,
} from './operations';
export type {
  GetOperationOptions,
  ListOperationsOptions,
  OperationEntry,
  OperationLayout,
  OperationList,
  OperationSource,
  StandardMethod,
} from './operations';

export {
  LATEST_SPEC_FAMILY,
  SPEC_FAMILIES,
  SPEC_FEATURES,
  SPEC_PROFILES,
  SUPPORTED_SPEC_VERSIONS,
  compareSpecFamilies,
  describeSpecVersionProblem,
  detectSpecVersion,
  featureNewerThanDeclared,
  getSpecProfile,
  isFeatureAvailable,
  listSkippedNewerOperations,
  resolveOperationLayout,
} from './versions';
export type {
  ListSkippedNewerOperationsOptions,
  ParameterLocationName,
  SkippedOperationField,
  SpecFamily,
  SpecFeature,
  SpecFeatureId,
  SpecProfile,
  SpecVersionField,
  SpecVersionInfo,
  SpecVersionStatus,
} from './versions';
