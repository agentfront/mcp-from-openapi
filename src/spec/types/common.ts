/**
 * Building blocks shared by the version modules.
 *
 * @module
 */

/**
 * A map in a specification object: paths, status codes, media types,
 * component names, scope names and so on, each to its value.
 *
 * A value may be `undefined`. A lookup can miss, and a document imported as a
 * JSON module needs it: where sibling maps have different keys (two security
 * requirements, two `oneOf` members with different `properties`), TypeScript
 * infers each missing key as `key?: undefined`, which must still be accepted.
 */
export type SpecMap<T> = Record<string, T | undefined>;

/**
 * A value the specification leaves free-form: an example, a default, an
 * `enum` member, a `const`, a link's parameter values and request body.
 *
 * Deliberately `any` rather than `unknown`: these are reader types, and code
 * written against earlier OpenAPI typings reads such values directly (for
 * example `schema.enum?.map((value) => value.toUpperCase())`). Check a value
 * before relying on its shape; the document decides what it holds.
 */
export type FreeFormValue = any;

/**
 * `Base` with the fields named in `Changes` replaced by (or, when `Base` lacks
 * them, added as) the ones in `Changes`. A version module uses it to state
 * only what changed since the previous version.
 */
export type Override<Base, Changes> = Omit<Base, keyof Changes> & Changes;
