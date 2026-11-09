import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "../src/build/build";
import { freePort, linkSteambun, spawnBin, spawnBun, tmpRoot } from "./helpers";

// Hand-rolled Standard Schema: a temp project can't resolve zod.
const CONFIG = `export default {
  api: "./api",
  envSchema: {
    "~standard": {
      version: 1,
      vendor: "test",
      validate(env) {
        const issues = [];
        if (!env.DATABASE_URL) issues.push({ message: "Required", path: ["DATABASE_URL"] });
        if (env.PUBLIC_FLAG !== "true") issues.push({ message: "Must be true", path: ["PUBLIC_FLAG"] });
        return issues.length ? { issues } : { value: { PUBLIC_FLAG: true } };
      },
    },
  },
};
`;

let root: string;
// `steambun preview` validates against .env files and process.env, and the build-time .env is gone.
const previewEnv = { DATABASE_URL: "x", PUBLIC_FLAG: "true" };
const server = (env: Record<string, string>) =>
  spawnBun(["dist/server.js"], root, env);

beforeAll(async () => {
  root = tmpRoot("prod-server");
  linkSteambun(root);
  mkdirSync(join(root, "api"));
  writeFileSync(
    join(root, "index.html"),
    '<!doctype html><html><body><script type="module" src="./main.ts"></script></body></html>',
  );
  writeFileSync(
    join(root, "main.ts"),
    "console.log(import.meta.env.PUBLIC_FLAG);\n",
  );
  writeFileSync(
    join(root, "api", "hello.ts"),
    "export const GET = () => Response.json({ hello: process.env.DATABASE_URL });\n",
  );
  writeFileSync(join(root, "steambun.config.ts"), CONFIG);
  writeFileSync(join(root, ".env"), "DATABASE_URL=x\nPUBLIC_FLAG=true\n");
  await build({ root });
  // `bun dist/server.js` would otherwise autoload it from the cwd.
  rmSync(join(root, ".env"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("dist/server.js serves the SPA, assets, and api routes", async () => {
  const port = await freePort();
  const proc = server({ PORT: String(port), DATABASE_URL: "db://x" });
  try {
    await proc.until((o) => o.includes(`:${port}`), "the server");
    const base = `http://localhost:${port}`;
    expect(await (await fetch(`${base}/api/hello`)).json()).toEqual({
      hello: "db://x",
    });
    const page = await fetch(`${base}/no/such/route`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<script");
    const asset = readFileSync(join(root, "dist", "index.html"), "utf8").match(
      /assets\/[^"]+\.js/,
    )?.[0];
    const res = await fetch(`${base}/${asset}`);
    expect(res.headers.get("cache-control")).toContain("immutable");
  } finally {
    await proc.stop();
  }
});

test("dist/server.js does not serve its own bundle (it embeds the config)", async () => {
  const port = await freePort();
  const proc = server({ PORT: String(port), DATABASE_URL: "db://x" });
  try {
    await proc.until((o) => o.includes(`:${port}`), "the server");
    for (const path of ["/server.js", "/server.js?x=1", "/%73erver.js"]) {
      const res = await fetch(`http://localhost:${port}${path}`);
      expect(await res.text()).not.toContain("DATABASE_URL");
    }
  } finally {
    await proc.stop();
  }
});

test("dist/server.js checks process.env over the build-time public values and exits 1", async () => {
  // PUBLIC_FLAG came from .env at build time, so a plain run needs only DATABASE_URL.
  const missing = server({ PORT: String(await freePort()) });
  expect(await missing.exited()).toBe(1);
  expect(missing.output()).toContain("DATABASE_URL");
  expect(missing.output()).not.toContain("PUBLIC_FLAG");

  const overridden = server({
    PORT: String(await freePort()),
    DATABASE_URL: "x",
    PUBLIC_FLAG: "false",
  });
  expect(await overridden.exited()).toBe(1);
  expect(overridden.output()).toContain("PUBLIC_FLAG");
});

test("dist/server.js refuses a taken port, `steambun preview` moves to the next one", async () => {
  const taken = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("busy"),
  });
  try {
    const port = String(taken.port);
    const deployed = server({
      PORT: port,
      HOST: "127.0.0.1",
      DATABASE_URL: "x",
    });
    expect(await deployed.exited()).toBe(1);
    expect(deployed.output()).toContain(port);

    const preview = spawnBin(
      ["preview", "--port", port, "--host", "127.0.0.1"],
      root,
      previewEnv,
    );
    try {
      await preview.until((o) => o.includes("Local:"), "the server");
      expect(preview.output()).not.toContain(`:${port}/`);
    } finally {
      await preview.stop();
    }
  } finally {
    await taken.stop(true);
  }
});

test("`steambun preview` serves a rebuild without a restart", async () => {
  const port = await freePort();
  const preview = spawnBin(
    ["preview", "--port", String(port)],
    root,
    previewEnv,
  );
  try {
    await preview.until((o) => o.includes(`:${port}`), "the server");
    const url = `http://localhost:${port}/robots.txt`;
    expect((await fetch(url)).status).toBe(404);
    writeFileSync(join(root, "dist", "robots.txt"), "second");
    expect(await (await fetch(url)).text()).toBe("second");
  } finally {
    await preview.stop();
  }
});

test.each([
  ["bunfig.toml", (port: number) => `[steambun.server]\nport = ${port}\n`],
  [
    "vite.config.ts",
    (port: number) => `export default { server: { port: ${port} } };\n`,
  ],
  [
    "steambun.config.ts",
    (port: number) =>
      `export default ({ command }) => ({ server: { port: ${port} } });\n`,
  ],
])("dist/server.js loads server.port from %s", async (file, content) => {
  const project = tmpRoot("prod-config");
  const port = await freePort();
  linkSteambun(project);
  writeFileSync(join(project, "index.html"), "<html></html>");
  writeFileSync(join(project, file), content(port));
  await build({ root: project });
  const proc = spawnBun(["dist/server.js"], project);
  try {
    await proc.until((o) => o.includes(`:${port}`), "the configured port");
  } finally {
    await proc.stop();
    rmSync(project, { recursive: true, force: true });
  }
});
