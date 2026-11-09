#!/usr/bin/env bun
// steambun's command line. Run it from the app's root: the folder with
// package.json, and steambun.config.ts if the app has one.
//
//   steambun dev [--native] [--home DIR] [--port N] [-- args]   core from source, hot
//   steambun build [--no-aot]                       compile the core
//   steambun build --web                            the page as a static site
//   steambun app [--open]                           build, then the .app
//   steambun gen [--check]                          generated Swift
//   steambun check                                  code stays in its runtime
//   steambun test [--tab|--both] [--serial] [-- files, folders, bun test args]
//   steambun release keygen | NEW.app OUT_DIR [OLD.app …]
//
// `steambun app` reads VERSION, BUILD, SIGN_ID, UPDATE_URL, UPDATE_KEY,
// ENTITLEMENTS, ZSTD and CORE from the environment, for release scripts.
// With CORE set, it uses that core and doesn't build.
import { loadConfig } from "./config.ts";
import { app, build, buildWeb, dev, gen, test } from "./tools.ts";
import { check, report } from "./check.ts";
import { keygen, release } from "./release.ts";
import { resolve } from "node:path";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f: string) => rest.includes(f);
const value = (f: string) => {
  const i = rest.indexOf(f);
  return i >= 0 ? rest[i + 1] : undefined;
};
const after = rest.includes("--") ? rest.slice(rest.indexOf("--") + 1) : [];

const usage = `usage: steambun <dev|build|app|test|release|gen|check>
  dev [--native] [--home DIR] [--port N] [-- args]  run the core from source under bun --hot;
                                         --native: in the shell (rebuilt if stale)
  build [--no-aot]                       compile the core (with its UI) to one binary
  build --web                            bundle the page alone as a static site in build/web
  app [--open]                           build, then the .app around it (--open: launch it)
  test [--tab|--both] [--serial] [-- args]  rebuild a stale shell; run *.e2e.ts in parallel
  release keygen | NEW.app OUT_DIR [OLD.app …]  make the update key, or publish a feed
  gen [--check]                          write the generated Swift
  check                                  fail if the page uses Bun, or the core uses the page`;

try {
  const c = await loadConfig(process.cwd());
  const env = Bun.env;
  switch (cmd) {
    case "dev":
      process.exit(
        await dev(c, {
          native: flag("--native"),
          // The caller's folder, not the app root the core runs in.
          home: value("--home") && resolve(value("--home")!),
          port: value("--port") ? Number(value("--port")) : undefined,
          args: after,
        }),
      );
    case "build":
      if (flag("--web")) await buildWeb(c);
      else await build(c, { aot: !flag("--no-aot") });
      break;
    case "app":
      if (!env.CORE) await build(c);
      await app(c, {
        core: env.CORE,
        entitlements: env.ENTITLEMENTS,
        sign: env.SIGN_ID,
        version: env.VERSION,
        build: env.BUILD,
        updateURL: env.UPDATE_URL,
        updateKey: env.UPDATE_KEY,
        zstd: env.ZSTD,
      });
      if (flag("--open")) await Bun.$`open ${c.root}/${c.out}/${c.name}.app`;
      break;
    case "test":
      process.exit(
        await test(c, {
          backends: flag("--both")
            ? ["native", "tab"]
            : flag("--tab")
              ? ["tab"]
              : ["native"],
          args: after,
          parallel: !flag("--serial"),
        }),
      );
    case "release": {
      const [a, b, ...olds] = rest;
      if (a === "keygen") keygen(c.root);
      else if (a && b)
        await release(
          c.root,
          resolve(a),
          resolve(b),
          olds.map((o) => resolve(o)),
        );
      else {
        console.error(usage);
        process.exit(2);
      }
      break;
    }
    case "check": {
      const ps = check(c);
      if (ps.length) {
        console.error(report(ps));
        process.exit(1);
      }
      console.error("steambun: check ok");
      break;
    }
    case "gen":
      if (!(await gen(c, flag("--check")))) process.exit(1);
      break;
    default:
      console.error(usage);
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
