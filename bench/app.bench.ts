import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import { resolveDefaults } from "../src/config/loader";
import { createApp } from "../src/runtime/app";

const root = mkdtempSync(join(tmpdir(), "steambun-app-bench-"));
const outDir = join(root, "dist");
mkdirSync(outDir);
writeFileSync(join(outDir, "index.html"), "<!doctype html>");
const apiDir = join(root, "api");
mkdirSync(join(apiDir, "users"), { recursive: true });
for (let i = 0; i < 40; i++) {
  writeFileSync(
    join(apiDir, `r${i}.ts`),
    `export const GET = () => Response.json({ i: ${i} });\n`,
  );
}
for (let i = 0; i < 10; i++) {
  writeFileSync(
    join(apiDir, "users", `[id${i}].ts`),
    `export const GET = (req) => Response.json({ id: req.params.id${i} });\n`,
  );
}

const config = resolveDefaults(
  { api: "api", server: { cors: true, headers: { "x-a": "1" } } },
  { root, command: "preview", mode: "production", configFile: null },
);

group("runtime/app: createApp (startup path)", () => {
  // Imports are cached after the first trial, so this measures wiring only.
  task("D1 createApp preview, 50 api route files (warm module cache)", () =>
    createApp({ config, mode: "preview", outDir, apiDir }),
  );
});

const app = await createApp({ config, mode: "preview", outDir, apiDir });

group("runtime/app: app.fetch (real Bun.serve round trip)", () => {
  const exact = new Request("http://localhost/api/r7");
  const param = new Request("http://localhost/api/users/42");

  task(
    "D2 sync api handler through withSseTimeout + cors + headers (exact route)",
    () => app.fetch(exact),
  );
  task("D3 param route (10 users/[idN].ts files registered)", () =>
    app.fetch(param),
  );
});
