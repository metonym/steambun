import { relative, sep } from "node:path";

/** Native separators become `/`. On POSIX a backslash is a legal filename character and is left alone. */
export function toPosix(path: string, separator: string = sep): string {
  return separator === "\\" ? path.replace(/\\/g, "/") : path;
}

export function posixRelative(from: string, to: string): string {
  return toPosix(relative(from, to));
}

export function toImportSpecifier(fromDir: string, toFile: string): string {
  const rel = posixRelative(fromDir, toFile);
  return rel === ".." || rel.startsWith("../") ? rel : `./${rel}`;
}
