/** `config.build.features` merged with comma-separated `STEAMBUN_FEATURES`, deduped. */
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
