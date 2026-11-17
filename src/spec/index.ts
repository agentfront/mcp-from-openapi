/**
 * The spec layer: everything that knows about OpenAPI versions.
 *
 * Nothing under `src/spec/` imports from outside it (enforced by
 * `src/spec/tsconfig.json`), so the layer can be extracted as is.
 *
 * @module
 */

export type * from './types';
