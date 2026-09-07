import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "steambun";
import { createApp } from "steambun/runtime";

describe("examples/testing api routes", () => {
  test("GET /api/health returns json", async () => {
    const root = `${import.meta.dir}/..`;
    const config = await loadConfig({
      root,
      command: "build",
      mode: "production",
    });
    const app = await createApp({
      config,
      mode: "preview",
      outDir: join(root, "dist"),
      apiDir: join(root, "src/api"),
    });

    const res = await app.fetch(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
