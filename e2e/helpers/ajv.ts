/**
 * JSON Schema 2020-12 validity checking for generated schemas.
 *
 * A fresh Ajv2020 instance per schema sidesteps `$id` collisions across
 * tools; `strict: false` tolerates the generator's `x-` annotation keywords
 * (`x-parameter-location`, `x-status-code`, ...); `validateFormats: false`
 * tolerates OpenAPI formats (int64, binary) without pulling in ajv-formats.
 */
import Ajv2020 from 'ajv/dist/2020';

/** Compile every schema; returns human-readable failures (empty = all valid). */
export function compileAll(schemas: Array<{ label: string; schema: unknown }>): string[] {
  const failures: string[] = [];
  for (const { label, schema } of schemas) {
    try {
      const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
      ajv.compile(schema as object);
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}
