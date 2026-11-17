/**
 * Where dereferencing put a value in place of a `$ref`, and the `$ref` text it
 * replaced.
 *
 * Both dereferencers record here (`dereferenceInternal` and `$RefParser`'s
 * `onDereference`), for the document copy they produce, so a value the
 * document wrote with a `$ref` can be given back as a `$ref`. That matters for
 * specification extensions: a `$ref` inside an `x-` value is not a Reference
 * Object in any OpenAPI version, yet a dereferencer resolves it anyway, and a
 * few such references (Stripe's `x-expansionResources`) expand into whole
 * schema graphs once copied into a tool.
 *
 * Two records, both `WeakMap`s, so the document gains no property, an object
 * nobody dereferenced has no entry, and a document the garbage collector frees
 * takes its entries with it:
 *
 * - by site, the container and key that held the `$ref`, with the value put
 *   there: the exact text, while that key still holds that value (a value a
 *   caller puts there later is not the reference);
 * - by value, for an object put in place of a `$ref`: what finds it again in a
 *   copy of its container, which `$RefParser` makes for a `$ref` with
 *   siblings and the Swagger 2.0 conversion for a schema it rewrites. The
 *   first text recorded for the value is kept.
 *
 * The text is the one the dereferencer read: a reference to the document's
 * own URI in the local form `prepare` gave it, relative to the file it was
 * written in for a multi-file document, without the keywords written next to
 * it. An object defined inside an extension and referenced from elsewhere is
 * that same object to `$RefParser`, so it comes back as such a reference.
 * Internal: not part of the barrel.
 */
const sites = new WeakMap<object, Map<string, { ref: string; value: unknown }>>();
const byValue = new WeakMap<object, string>();

/** Record that `container[key]` held `{ $ref: ref }`, replaced by `value` */
export function recordReferenceSite(container: object, key: string | number, ref: string, value: unknown): void {
  let byKey = sites.get(container);
  if (!byKey) {
    byKey = new Map();
    sites.set(container, byKey);
  }
  byKey.set(String(key), { ref, value });
  if (value !== null && typeof value === 'object' && !byValue.has(value)) byValue.set(value, ref);
}

/** Give `to` the sites recorded for `from`: a dereferencer that copies a walked object into another one */
export function copyReferenceSites(from: object, to: object): void {
  const byKey = sites.get(from);
  if (byKey) for (const [key, site] of byKey) recordReferenceSite(to, key, site.ref, site.value);
}

/**
 * The `$ref` text that `value`, found at `container[key]`, was put in place
 * of: by its site while it holds the value put there, else, for an object, by
 * the value itself. `undefined` for a value no `$ref` became.
 */
export function referenceAt(container: object, key: string | number, value: unknown): string | undefined {
  const site = sites.get(container)?.get(String(key));
  if (site && site.value === value) return site.ref;
  return value !== null && typeof value === 'object' ? byValue.get(value) : undefined;
}

/** Whether `key` names a specification extension (`x-...`), whose value OpenAPI never reads */
export function isExtensionKey(key: string): boolean {
  return key.startsWith('x-');
}
