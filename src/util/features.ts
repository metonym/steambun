/** `config.build.features` merged with `STEAMBUN_FEATURES` (comma-separated), deduped. */
export function mergeFeatures(
  configFeatures: string[] | undefined,
  envValue: string | undefined,
): string[] {
  const fromEnv =
    envValue
      ?.split(",")
      .map((f) => f.trim())
      .filter(Boolean) ?? [];
  return [...new Set([...(configFeatures ?? []), ...fromEnv])];
}
