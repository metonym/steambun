import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { findConfigFile, loadRawConfigExport } from "./loader";
import type { UserConfig } from "./types";
import { viteConfigToUserConfig } from "./vite";

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof RegExp) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function keyPath(base: string, key: string): string {
  if (IDENTIFIER_RE.test(key)) return base ? `${base}.${key}` : key;
  return `${base}["${key}"]`;
}

// Emits JS literal syntax (not JSON) so functions and regexps can be inlined
// verbatim, rather than silently dropped like `JSON.stringify` would.
function serializeValue(
  value: unknown,
  indent: number,
  path: string,
  functions: string[],
  dropped: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "function") {
    functions.push(path);
    return value.toString();
  }
  if (value instanceof RegExp) return value.toString();

  const pad = "  ".repeat(indent);
  const childPad = "  ".repeat(indent + 1);

  if (Array.isArray(value)) {
    const items: string[] = [];
    value.forEach((item, i) => {
      const itemPath = `${path}[${i}]`;
      const s = serializeValue(item, indent + 1, itemPath, functions, dropped);
      items.push(`${childPad}${s ?? "undefined"}`);
    });
    if (items.length === 0) return "[]";
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (isPlainObject(value)) {
    const entries: string[] = [];
    for (const [key, val] of Object.entries(value)) {
      const s = serializeValue(
        val,
        indent + 1,
        keyPath(path, key),
        functions,
        dropped,
      );
      if (s === undefined) continue;
      const keyStr = IDENTIFIER_RE.test(key) ? key : JSON.stringify(key);
      entries.push(`${childPad}${keyStr}: ${s}`);
    }
    if (entries.length === 0) return "{}";
    return `{\n${entries.join(",\n")}\n${pad}}`;
  }

  dropped.push(path);
  return undefined;
}

function serializeConfig(config: UserConfig): {
  source: string;
  functions: string[];
  dropped: string[];
} {
  const functions: string[] = [];
  const dropped: string[] = [];
  const source = serializeValue(config, 0, "", functions, dropped) ?? "{}";
  return { source, functions, dropped };
}

function serializeUserConfig(config: UserConfig): string {
  const { source } = serializeConfig(config);
  return `import { defineConfig } from "steambun";

export default defineConfig(${source});
`;
}

/**
 * Converts a `vite.config.*` in `root` into `steambun.config.ts`, printing
 * one warning per unsupported key. Never overwrites an existing steambun
 * config.
 */
export async function migrate(rootInput: string): Promise<void> {
  const root = isAbsolute(rootInput)
    ? rootInput
    : join(process.cwd(), rootInput);
  const found = findConfigFile(root);
  if (found?.kind === "steambun") {
    throw new Error(
      "[steambun] A steambun config already exists — not overwriting it.",
    );
  }
  if (found?.kind !== "vite") {
    throw new Error("[steambun] No vite.config.* found in this project.");
  }

  const resolved = await loadRawConfigExport(found.path, {
    command: "build",
    mode: "production",
  });
  const config = viteConfigToUserConfig(
    (resolved as Record<string, unknown>) ?? {},
  );

  const outPath = join(root, "steambun.config.ts");
  if (existsSync(outPath)) {
    throw new Error(
      `[steambun] ${outPath} already exists — not overwriting it.`,
    );
  }
  await writeFile(outPath, serializeUserConfig(config), "utf8");
  console.log(`[steambun] wrote steambun.config.ts from ${found.path}`);
}
