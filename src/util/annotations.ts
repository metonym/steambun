export type CiAnnotationLevel = "error" | "warning" | "notice";
export interface CiAnnotationOptions {
  file?: string;
  line?: number;
}

function ciEnabled(): boolean {
  return process.env.GITHUB_ACTIONS === "true" || process.env.STEAMBUN_CI === "1";
}

// GitHub's workflow-command escaping rules (docs.github.com/actions/using-workflows/workflow-commands-for-github-actions)
function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** Prints a GitHub Actions workflow command (`::error file=...::message`) so a failure surfaces
 * inline on a PR diff, but only under `GITHUB_ACTIONS=true` or `STEAMBUN_CI=1`. No-op otherwise. */
export function ciAnnotation(
  level: CiAnnotationLevel,
  message: string,
  opts: CiAnnotationOptions = {},
): void {
  if (!ciEnabled()) return;
  const props = Object.entries(opts)
    .filter((e): e is [string, string | number] => e[1] !== undefined)
    .map(([key, value]) => `${key}=${escapeProperty(String(value))}`)
    .join(",");
  console.log(`::${level}${props ? ` ${props}` : ""}::${escapeData(message)}`);
}
