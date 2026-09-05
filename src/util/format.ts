/** `1024` → `"1.0 KB"`. Bytes under 1024 print as `"N B"`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export type BuildFileType = "html" | "css" | "js";

/** `.html` / `.css` / `.js` (and `.mjs`) → its type; everything else is `undefined`. */
export function buildFileType(path: string): BuildFileType | undefined {
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "js";
  return undefined;
}
