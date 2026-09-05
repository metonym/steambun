/** `1024` → `"1.0 KB"`. Bytes under 1024 print as `"N B"`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
