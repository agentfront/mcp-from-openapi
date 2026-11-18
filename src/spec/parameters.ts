/**
 * Parameter names, as every part of the library reads them.
 *
 * A Parameter Object's `name` is a string. YAML reads an unquoted `2024` or
 * `true` as a number or a boolean, so a document can hold one where its
 * author wrote a name: it is read as its text, with a warning. A value that
 * cannot be a name (absent, `null`, `''`, an object, an array) is not read.
 *
 * @module
 */

import { SPEC_DIAGNOSTIC_CODES, appendPointer, describeValue, type SpecDiagnostic } from './diagnostics';
import { isSpecObject } from './operations';

/** What `readParameterName` found. */
export type ParameterName =
  /** A non-empty string, used as written. */
  | { kind: 'string'; name: string }
  /** A number or a boolean, read as its text (`2024`, `true`); see `parameterNameNotStringDiagnostic`. */
  | { kind: 'coerced'; name: string }
  /** Absent, `null`, `''`, an object, an array or any other value: no name. */
  | { kind: 'invalid' };

/** Reads a parameter's `name` value. Never throws. */
export function readParameterName(value: unknown): ParameterName {
  if (typeof value === 'string') return value === '' ? { kind: 'invalid' } : { kind: 'string', name: value };
  if (typeof value === 'number' || typeof value === 'boolean') return { kind: 'coerced', name: String(value) };
  return { kind: 'invalid' };
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

/**
 * The `PARAMETER_NAME_NOT_STRING` warning for a parameter whose `name` is a
 * number or a boolean, at `<pointer>/name` (`pointer` locates the parameter).
 * Shared by the validator, the generator and the Swagger 2.0 converter, so a
 * name is reported once whichever finds it.
 */
export function parameterNameNotStringDiagnostic(value: number | boolean, pointer: string): SpecDiagnostic {
  return {
    severity: 'warning',
    code: SPEC_DIAGNOSTIC_CODES.PARAMETER_NAME_NOT_STRING,
    message:
      `Parameter name ${describeValue(value)} is a ${typeof value}, not a string (YAML reads an unquoted ` +
      `${typeof value} so); it is read as ${describeValue(String(value))}`,
    path: appendPointer(typeof pointer === 'string' ? pointer : '', 'name'),
  };
}
