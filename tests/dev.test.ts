import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { freePort, linkSteambun, spawnBin, tmpRoot } from "./helpers";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = tmpRoot("dev");
  roots.push(root);
  linkSteambun(root);
  writeFileSync(join(root, "index.html"), "<html></html>");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

const count = (output: string, text: string) => output.split(text).length - 1;

test.concurrent("dev keeps restarting on changes after recovering from a crash", async () => {
  const root = project({
    "api/x.ts": "process.exit(3);\n",
    "steambun.config.ts": `export default { api: "./api" };\n`,
  });
  const dev = spawnBin(["dev", "--port", String(await freePort())], root);
  try {
    await dev.until((o) => count(o, "waiting for a change") === 1, "the crash");

    writeFileSync(
      join(root, "api", "x.ts"),
      "export const GET = () => new Response('ok');\n",
    );
    writeFileSync(join(root, ".env"), "A=1\n");
    await dev.until(
      (o) => count(o, "starting dev server") === 2,
      "the first restart",
    );
    await Bun.sleep(300);

    writeFileSync(join(root, ".env"), "A=2\n");
    await dev.until(
      (o) => count(o, "starting dev server") === 3,
      "the second restart",
    );
    expect(count(dev.output(), "changed, restarting")).toBe(2);
  } finally {
    await dev.stop();
  }
}, 30_000);

test.concurrent("dev waits for a change instead of exiting when a restart fails to start", async () => {
  const root = project({ "steambun.config.ts": "export default {};\n" });
  const dev = spawnBin(["dev", "--port", String(await freePort())], root);
  try {
    await dev.until((o) => count(o, "starting dev server") === 1, "the start");
    await Bun.sleep(300);

    writeFileSync(
      join(root, "steambun.config.ts"),
      `throw new Error("broken config");\n`,
    );
    await dev.until(
      (o) =>
        o.includes("broken config") &&
        count(o, "waiting for a change to restart") === 1,
      "the wait message",
    );

    writeFileSync(join(root, "steambun.config.ts"), "export default {};\n");
    await dev.until(
      (o) => count(o, "starting dev server") === 2,
      "the recovery",
    );
  } finally {
    await dev.stop();
  }
}, 30_000);

test.concurrent("dev exits 1 instead of waiting when the very first start fails env validation", async () => {
  const root = project({
    "steambun.config.ts": `export default { envSchema: { "~standard": { version: 1, vendor: "test", validate: () => ({ issues: [{ message: "required", path: ["API_URL"] }] }) } } };\n`,
  });
  const dev = spawnBin(["dev", "--port", String(await freePort())], root);
  await dev.until((o) => o.includes("Invalid environment"), "the error");
  expect(await dev.stop()).toBe(1);
});

test.concurrent.each([
  [undefined, "development"],
  ["staging", "development"],
  ["production", "production"],
])(
  "dev --mode %p runs the server with NODE_ENV=%p",
  async (mode, expected) => {
    const root = project({});
    const nodeEnv = join(root, "node-env");
    mkdirSync(join(root, "api"));
    writeFileSync(
      join(root, "api", "x.ts"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(nodeEnv)}, process.env.NODE_ENV ?? "");\nexport const GET = () => new Response("ok");\n`,
    );
    writeFileSync(
      join(root, "steambun.config.ts"),
      `export default { api: "./api" };\n`,
    );
    const dev = spawnBin(
      [
        "dev",
        "--port",
        String(await freePort()),
        ...(mode ? ["--mode", mode] : []),
      ],
      root,
    );
    try {
      await dev.until(
        () => existsSync(nodeEnv) && readFileSync(nodeEnv, "utf8") !== "",
        "the server",
      );
      expect(readFileSync(nodeEnv, "utf8")).toBe(expected);
    } finally {
      await dev.stop();
    }
  },
  30_000,
);

test.concurrent("dev --port binds the server to the requested port", async () => {
  const root = project({});
  const port = await freePort();
  const dev = spawnBin(["dev", "--port", String(port)], root);
  try {
    await dev.until((o) => o.includes(`:${port}/`), "the requested port");
  } finally {
    await dev.stop();
  }
});
