import type { AppType } from "../config/types";

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

/** Netlify/Cloudflare Pages `_headers` text format. `**` globs collapse to `/*`; other globs pass through verbatim. */
export function toNetlifyHeaders(rules: HeaderRules): string {
  const blocks = Object.entries(rules).map(([glob, headers]) => {
    const path = glob.includes("**") ? "/*" : glob;
    const lines = [
      path,
      ...Object.entries(headers).map(([key, value]) => `  ${key}: ${value}`),
    ];
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/** SPA client fallback, or `""` for `"mpa"` (real 404s — caller skips writing the file when empty). */
export function toRedirects(appType: AppType): string {
  return appType === "spa" ? "/* /index.html 200\n" : "";
}

export interface VercelConfig {
  headers: Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
  }>;
  rewrites: Array<{ source: string; destination: string }>;
}

export function toVercelJson(
  rules: HeaderRules,
  appType: AppType,
): VercelConfig {
  return {
    headers: Object.entries(rules).map(([source, headers]) => ({
      source,
      headers: Object.entries(headers).map(([key, value]) => ({ key, value })),
    })),
    rewrites:
      appType === "spa"
        ? [{ source: "/(.*)", destination: "/index.html" }]
        : [],
  };
}
