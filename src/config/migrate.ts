import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { findConfigFile, loadRawConfigExport } from "./loader";
import type { UserConfig } from "./types";
import { viteConfigToUserConfig } from "./vite";

function serializeUserConfig(config: UserConfig): string {
  return `import { defineConfig } from "steambun";

export default defineConfig(${JSON.stringify(config, null, 2)});
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
