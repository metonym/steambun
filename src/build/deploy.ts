export type HeaderRules = Record<string, Record<string, string>>;

/** A glob in both merges header-by-header, `overrides` winning per key; a glob in only one passes through. */
export function mergeHeaderRules(
  base: HeaderRules,
  overrides: HeaderRules,
): HeaderRules {
  const globs = new Set([...Object.keys(base), ...Object.keys(overrides)]);
  const merged: HeaderRules = {};
  for (const glob of globs) {
    merged[glob] = { ...base[glob], ...overrides[glob] };
  }
  return merged;
}
