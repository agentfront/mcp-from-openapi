/** The name of a specification extension field: any key starting with `x-`. */
export type ExtensionName = `x-${string}`;

/**
 * A spec object read together with its specification extensions.
 *
 * The object types never declare `x-` fields, so that documents typed with
 * the caller's own interfaces stay assignable to them. To read an extension,
 * view the object through this type:
 *
 * ```ts
 * const logo = (document.info as WithExtensions<InfoObject>)['x-logo']; // unknown
 * ```
 *
 * An extension's value is whatever the document holds, so it is `unknown`
 * until checked.
 */
export type WithExtensions<T extends object = object> = T & { readonly [Name in ExtensionName]?: unknown };
