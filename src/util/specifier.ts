import { relative } from "node:path";

/** `path`, with any backslash normalized to `/` — regardless of the current
 * platform's separator, so a config value written with either style (or a
 * `node:path` result on Windows) converts the same way. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/** `relative(from, to)`, normalized to POSIX separators — needed anywhere
 * the result is used as an import specifier, a route path, or a
 * `.d.ts`-relative path rather than a filesystem path. */
export function posixRelative(from: string, to: string): string {
  return toPosix(relative(from, to));
}

export function toImportSpecifier(fromDir: string, toFile: string): string {
  const rel = posixRelative(fromDir, toFile);
  return rel.startsWith(".") ? rel : `./${rel}`;
}
