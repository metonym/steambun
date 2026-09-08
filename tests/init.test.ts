import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/init";

const ownVersion = (
  JSON.parse(
    await Bun.file(join(import.meta.dir, "..", "package.json")).text(),
  ) as {
    version: string;
  }
).version;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "steambun-init-"));
}

describe("init", () => {
  test("scaffolds the minimal template into an empty dir", async () => {
    const cwd = tmpDir();
    const dir = "my-app";

    await init({ dir, cwd });

    const targetDir = join(cwd, dir);
    const pkg = JSON.parse(
      await Bun.file(join(targetDir, "package.json")).text(),
    ) as { name: string; devDependencies: Record<string, string> };

    expect(pkg.name).toBe("my-app");
    expect(pkg.devDependencies.steambun).toBe(`^${ownVersion}`);
    expect(existsSync(join(targetDir, ".gitignore"))).toBe(true);
    expect(existsSync(join(targetDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(targetDir, "steambun.config.ts"))).toBe(true);
  });

  test("rejects a non-empty dir without force, succeeds with force", async () => {
    const cwd = tmpDir();
    const dir = "existing";
    const targetDir = join(cwd, dir);
    await Bun.write(join(targetDir, "keep.txt"), "hi");

    await expect(init({ dir, cwd })).rejects.toThrow("not empty");
    await expect(init({ dir, cwd, force: true })).resolves.toBeUndefined();
  });
});
