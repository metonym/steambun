// The dev loop: `steambun dev` for a page with no core. On a copy of hello
// in its build folder, so the example's own files stay as they are.
//
// The page accepts hot updates, so an edit swaps the module in place. A
// full reload works in a plain script, but under ostia Bun.WebView throws
// an unhandled "Completion handler ... no longer reachable" that ends the
// run, so this times the HMR path only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { group, task } from "ostia";
import { launch } from "../src/test.ts";

{
  const dir = join(import.meta.dir, "../examples/hello/build/bench-hot");
  const main = join(dir, "main.ts");
  let n = 0;
  const write = () =>
    Bun.write(
      main,
      `document.querySelector("h1")!.textContent = "v${++n}";\nimport.meta.hot.accept();\n`,
    );
  mkdirSync(dir, { recursive: true });
  await Bun.write(
    join(dir, "index.html"),
    `<!doctype html><html><body><h1>v0</h1><script type="module" src="./main.ts"></script></body></html>\n`,
  );
  await Bun.write(
    join(dir, "package.json"),
    `{ "name": "bench-hot", "private": true }\n`,
  );
  await write();
  let app: Awaited<ReturnType<typeof launch>>;
  const hooks = {
    before: async () => {
      app = await launch({ root: dir, backend: "tab", ready: "h1", hot: true });
    },
    after: () => app.close(),
  };
  group(
    "dev, hot reload",
    () => {
      task(
        "edit to screen, hot reload (tab)",
        async () => {
          await write();
          await app.waitFor(
            `document.querySelector("h1")?.textContent === "v${n}"`,
          );
        },
        { samples: 20 },
      );
    },
    hooks,
  );
  // After the hot group: these servers slow the hot reloads that follow.
  group("dev, page server", () => {
    task(
      "page server, start to first response",
      async () => {
        const p = Bun.spawn(
          [
            "bun",
            join(import.meta.dir, "../src/devpage.ts"),
            join(dir, "index.html"),
          ],
          {
            cwd: dir,
            env: {
              ...Bun.env,
              STEAMBUN_PORT: "0",
              STEAMBUN_PARENT_PID: String(process.pid),
            },
            stdout: "pipe",
            stderr: "ignore",
          },
        );
        const reader = p.stdout.getReader();
        let out = "";
        while (!/STEAMBUN_READY (\d+)/.test(out)) {
          const { value, done } = await reader.read();
          if (done) throw new Error("devpage exited before it was ready");
          out += new TextDecoder().decode(value);
        }
        const port = out.match(/STEAMBUN_READY (\d+)/)![1];
        await (await fetch(`http://127.0.0.1:${port}/`)).text();
        p.kill();
        await p.exited;
      },
      { samples: 10 },
    );
  });
}
