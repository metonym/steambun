import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { posixRelative } from "../util/specifier";

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else files.push(path);
  }
  return files;
}

/** Servable (non-dotfile) files under `publicDir` with their URL paths; warns about HTML and `.env` files. */
export async function listPublicFiles(
  publicDir: string,
): Promise<{ urlPath: string; file: string }[]> {
  const found: { urlPath: string; file: string }[] = [];
  if (!existsSync(publicDir)) return found;
  for (const file of await collectFiles(publicDir)) {
    const rel = relative(publicDir, file);
    const base = basename(file);
    if (base.endsWith(".html")) {
      console.warn(
        `[steambun] publicDir contains ${rel} — HTML under publicDir is not an app entry`,
      );
    }
    if (/^\.env(\..+)?$/.test(base)) {
      console.warn(
        `[steambun] publicDir contains ${rel} — .env files should not be published`,
      );
    }
    if (base.startsWith(".")) continue;
    const urlPath = `/${posixRelative(publicDir, file).split("/").map(encodeURIComponent).join("/")}`;
    found.push({ urlPath, file });
  }
  return found;
}
