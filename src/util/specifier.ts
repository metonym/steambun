import { relative, sep } from "node:path";

export function toImportSpecifier(fromDir: string, toFile: string): string {
  const rel = relative(fromDir, toFile).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}
