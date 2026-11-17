import { parseDocument, visit } from 'yaml';
import { assertBoundedExpansion } from './json-copy';

/** Aliases a YAML document may use: resolving each one scans the document, so many cost quadratic time */
export const MAX_YAML_ALIASES = 2_000;

/** `yaml.parse`, refusing too many aliases before resolving them and an alias graph that expands without bound */
export function parseYamlText(text: string): unknown {
  const document = parseDocument(text);
  if (document.errors.length > 0) throw document.errors[0];
  let aliases = 0;
  visit(document, {
    Alias() {
      aliases++;
      return aliases > MAX_YAML_ALIASES ? visit.BREAK : undefined;
    },
  });
  if (aliases > MAX_YAML_ALIASES) throw new Error(`The YAML document uses more than ${MAX_YAML_ALIASES} aliases`);
  const value = document.toJS();
  assertBoundedExpansion(value);
  return value;
}
