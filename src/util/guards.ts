/** A plain `{}`/`Object.create(null)` object — excludes arrays, `null`, class
 * instances, and (since a `RegExp`'s prototype is never `Object.prototype`)
 * regexes. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

/** `undefined` unless every element is a string — a partially-string array is
 * rejected outright rather than silently filtered. */
export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return undefined;
  }
  return value;
}
