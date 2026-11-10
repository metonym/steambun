#!/usr/bin/env bun
// steambun's command line: a thin wrapper over tools.ts. Run it from the
// app's root, the folder with package.json. `steambun --help` says the rest.
//
// Exit codes: 0 done, 1 found problems (check, gen --check, tests, a build
// error), 2 called wrong or no app here. Unknown options fail with code 2,
// never pass silently.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, report } from "./check.ts";
import { loadConfig } from "./config.ts";
import { keygen, release } from "./release.ts";
import { bold, dim, done, error, json } from "./term.ts";
import { app, build, BuildError, buildWeb, dev, gen, test } from "./tools.ts";

interface Spec {
  /** What it does, in one line. */
  about: string;
  /** Usage after the command name. */
  args?: string;
  /** Switches, with what each does. */
  flags?: Record<string, string>;
  /** Options that take a value: its name, and what the option does. */
  values?: Record<string, [string, string]>;
  /** Takes plain arguments, as release does. */
  positional?: boolean;
  /** Takes arguments after `--`: what they are. */
  rest?: string;
}

const COMMANDS: Record<string, Spec> = {
  dev: {
    about: "the page, or the core, from source with hot reload",
    flags: { "--native": "in the Mac app; builds the shell if it's stale" },
    values: {
      "--home": ["DIR", "the app's data folder"],
      "--port": ["N", "the port of the core or the page"],
    },
    rest: "arguments for the core",
  },
  build: {
    about: "compile the core with its page, or bundle the page",
    flags: {
      "--web": "the page alone, as a static site in build/web",
      "--no-aot": "skip AOT: a faster build, a slower start",
      "--json": "print one JSON object on stdout, for scripts and agents",
    },
  },
  app: {
    about: "build, then make and sign build/<Name>.app",
    flags: {
      "--open": "open the app when it's built",
      "--json": "print one JSON object on stdout, for scripts and agents",
    },
  },
  test: {
    about: "run the *.e2e.ts tests; builds the shell if it's stale",
    flags: {
      "--tab": "in a browser tab, not the Mac app",
      "--both": "in the Mac app, then in a tab",
      "--serial": "one test file at a time",
    },
    rest: "test files, folders, or bun test options",
  },
  gen: {
    about: "write the generated Swift",
    flags: {
      "--check": "write nothing; fail if a file is stale",
      "--json": "print one JSON object on stdout, for scripts and agents",
    },
  },
  check: {
    about: "fail if the page imports Bun, or the core imports the page",
    flags: {
      "--json": "print one JSON object on stdout, for scripts and agents",
    },
  },
  release: {
    about: "make the update key, or publish a signed update feed",
    args: "keygen | NEW.app OUT_DIR [OLD.app …]",
    positional: true,
  },
};

const GLOBAL: Record<string, string> = {
  "-h, --help": "this help; `steambun <command> --help` for one command",
  "-v, --version": "steambun's version",
  "--verbose": "every log line: timings, links, the shell's internals",
};

function commandHelp(name: string, s: Spec) {
  const lines = [`  ${bold(name.padEnd(9))} ${s.about}`];
  if (s.args) lines.push(`            ${s.args}`);
  const opts: [string, string][] = [
    ...Object.entries(s.flags ?? {}),
    ...Object.entries(s.values ?? {}).map(
      ([f, [arg, text]]) => [`${f} ${arg}`, text] as [string, string],
    ),
  ];
  for (const [f, text] of opts) lines.push(`    ${f.padEnd(16)} ${dim(text)}`);
  if (s.rest) lines.push(`    ${"-- ARGS".padEnd(16)} ${dim(s.rest)}`);
  return lines.join("\n");
}

const usage = (only?: string) => {
  if (only)
    return `usage: steambun ${only} [options]\n\n${commandHelp(only, COMMANDS[only]!)}`;
  return `steambun: Mac apps from a web page and a Bun core

usage: steambun <command> [options]

${bold("Commands")}
${Object.entries(COMMANDS)
  .map(([n, s]) => commandHelp(n, s))
  .join("\n")}

${bold("Options")}
${Object.entries(GLOBAL)
  .map(([f, what]) => `  ${f.padEnd(22)} ${dim(what)}`)
  .join("\n")}

${bold("Environment")}
  ${"VERSION BUILD".padEnd(22)} ${dim("the .app's version and build number (app)")}
  ${"SIGN_ID".padEnd(22)} ${dim("a Developer ID to sign with; default ad hoc (app)")}
  ${"UPDATE_URL UPDATE_KEY".padEnd(22)} ${dim("the update feed and its public key (app)")}
  ${"CORE ENTITLEMENTS".padEnd(22)} ${dim("a core built elsewhere, and its entitlements (app)")}
  ${"ZSTD".padEnd(22)} ${dim("where libzstd is; default Homebrew's (app)")}
  ${"NO_COLOR".padEnd(22)} ${dim("no color; FORCE_COLOR=1 for color in a pipe")}

${bold("Exit codes")}
  0 done · 1 found problems (check, gen --check, tests, a build error) · 2 called wrong, or no app here

${bold("Examples")}
  steambun dev --native            ${dim("the app, with hot reload")}
  steambun app --open              ${dim("build the .app and open it")}
  steambun test --both -- test/    ${dim("the tests, in the Mac app and a tab")}
  steambun check --json            ${dim('{"ok":false,"problems":[…]} on stdout')}`;
};

class UsageError extends Error {}

/** Optimal string alignment distance: a swap of neighbors is one edit. */
function distance(a: string, b: string) {
  // d[i][j]: the distance from a's first i letters to b's first j.
  const d = Array.from({ length: a.length + 1 }, (_r, i) =>
    Array.from(
      { length: b.length + 1 },
      (_c, j) => Math.max(i, j) * +(i * j === 0),
    ),
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

const closest = (s: string, from: string[]) =>
  from
    .map((f) => [f, distance(s, f)] as const)
    .filter(([, n]) => n <= 2)
    .sort((x, y) => x[1] - y[1])[0]?.[0];

const SEE = "steambun --help lists them";

/** "a", "a and b", "a, b and c". */
const list = (xs: string[]) =>
  xs.length < 2
    ? xs.join("")
    : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

interface Parsed {
  cmd?: string;
  flags: Set<string>;
  values: Map<string, string>;
  positional: string[];
  rest: string[];
}

/** Flags anywhere, `--flag value` or `--flag=value`. Unknown ones throw. */
export function parse(argv: string[]): Parsed {
  const p: Parsed = {
    flags: new Set(),
    values: new Map(),
    positional: [],
    rest: [],
  };
  const dash = argv.indexOf("--");
  const args = dash >= 0 ? argv.slice(0, dash) : argv;
  p.rest = dash >= 0 ? argv.slice(dash + 1) : [];
  const globals = ["--help", "-h", "--version", "-v", "--verbose"];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) {
      if (p.cmd === undefined) {
        if (!COMMANDS[a] && a !== "help") {
          const near = closest(a, Object.keys(COMMANDS));
          throw new UsageError(
            `unknown command ${a}${near ? ` (did you mean ${near}?)` : `: ${SEE}`}`,
          );
        }
        p.cmd = a;
      } else p.positional.push(a);
      continue;
    }
    const [name, inline] = a.includes("=")
      ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
      : [a, undefined];
    if (globals.includes(name!)) {
      p.flags.add(name!);
      continue;
    }
    // Flags can come before the command: look the name up in all of them.
    const spec = p.cmd ? COMMANDS[p.cmd] : undefined;
    const owners = Object.entries(COMMANDS).filter(
      ([, s]) => name! in (s.flags ?? {}) || name! in (s.values ?? {}),
    );
    const mine = spec
      ? name! in (spec.flags ?? {}) || name! in (spec.values ?? {})
      : owners.length > 0;
    if (!mine) {
      const known = [
        ...globals,
        ...Object.keys(spec?.flags ?? {}),
        ...Object.keys(spec?.values ?? {}),
      ];
      const near = closest(name!, known);
      const where = p.cmd ? ` for ${p.cmd}` : "";
      let why = `: steambun ${p.cmd ? `${p.cmd} ` : ""}--help lists them`;
      if (owners.length > 0)
        why = ` (${list(owners.map(([n]) => n))} take${owners.length === 1 ? "s" : ""} it)`;
      if (near) why = ` (did you mean ${near}?)`;
      throw new UsageError(`unknown option ${name}${where}${why}`);
    }
    const takesValue = owners.some(([, s]) => name! in (s.values ?? {}));
    if (takesValue) {
      const v = inline ?? args[++i];
      if (v === undefined || v.startsWith("-"))
        throw new UsageError(`${name} needs a value`);
      p.values.set(name!, v);
    } else if (inline === undefined || inline === "true") p.flags.add(name!);
    else if (inline !== "false")
      throw new UsageError(`${name} is a switch: give it no value`);
  }
  // Flags given before the command must belong to it.
  if (p.cmd && p.cmd !== "help") {
    const s = COMMANDS[p.cmd]!;
    for (const f of [...p.flags, ...p.values.keys()])
      if (
        !globals.includes(f) &&
        !(f in (s.flags ?? {})) &&
        !(f in (s.values ?? {}))
      )
        throw new UsageError(`unknown option ${f} for ${p.cmd}`);
    if (p.positional.length > 0 && !s.positional)
      throw new UsageError(
        `${p.cmd} takes no argument ${p.positional[0]}${s.rest ? "; put it after --" : ""}`,
      );
    if (p.rest.length > 0 && !s.rest)
      throw new UsageError(`${p.cmd} takes no arguments after --`);
  }
  return p;
}

function port(v: string) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535)
    throw new UsageError(`--port takes a number from 0 to 65535, not ${v}`);
  return n;
}

function version() {
  // src/cli.ts in the repo, cli.ts in the published package.
  for (const f of ["package.json", "../package.json"]) {
    const p = join(import.meta.dir, f);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")).version;
  }
  return "unknown";
}

async function main(argv: string[]): Promise<number> {
  const p = parse(argv);
  if (p.flags.has("--version") || p.flags.has("-v")) {
    console.log(version());
    return 0;
  }
  if (
    p.cmd === "help" ||
    p.flags.has("--help") ||
    p.flags.has("-h") ||
    !p.cmd
  ) {
    const only = p.cmd === "help" ? p.positional[0] : p.cmd;
    // Help goes to stdout: it's what was asked for.
    console.log(usage(only && COMMANDS[only] ? only : undefined));
    return 0;
  }
  if (p.flags.has("--verbose")) process.env.STEAMBUN_VERBOSE = "1";
  json.on = p.flags.has("--json");
  const root = process.cwd();
  if (
    !existsSync(join(root, "package.json")) &&
    !existsSync(join(root, "steambun.config.ts"))
  )
    throw new UsageError(
      `no app here: ${root} has no package.json. Run steambun in your app's folder.`,
    );
  const c = await loadConfig(root).catch((e: Error) => {
    throw new UsageError(e.message);
  });
  const flag = (f: string) => p.flags.has(f);
  const env = Bun.env;
  switch (p.cmd) {
    case "dev":
      return dev(c, {
        native: flag("--native"),
        // The caller's folder, not the app root the core runs in.
        home: p.values.has("--home")
          ? resolve(p.values.get("--home")!)
          : undefined,
        port: p.values.has("--port")
          ? port(p.values.get("--port")!)
          : undefined,
        args: p.rest,
      });
    case "build":
      if (flag("--web")) await buildWeb(c);
      else await build(c, { aot: !flag("--no-aot") });
      return result({ ok: true, steps: json.steps });
    case "app": {
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
      const where = join(c.root, c.out, `${c.name}.app`);
      if (flag("--open")) await Bun.$`open ${where}`;
      return result({ ok: true, steps: json.steps });
    }
    case "test":
      return test(c, {
        backends: flag("--both")
          ? ["native", "tab"]
          : [flag("--tab") ? "tab" : "native"],
        args: p.rest,
        parallel: !flag("--serial"),
      });
    case "release": {
      const [a, b, ...olds] = p.positional;
      if (a === "keygen" && !b) keygen(c.root);
      else if (a && b && a !== "keygen")
        await release(
          c.root,
          resolve(a),
          resolve(b),
          olds.map((o) => resolve(o)),
        );
      else
        throw new UsageError(
          `release needs keygen, or NEW.app and OUT_DIR: steambun release --help`,
        );
      return 0;
    }
    case "check": {
      const ps = check(c);
      if (ps.length > 0) {
        error(`code crosses runtimes\n${report(ps)}`);
        return result({ ok: false, problems: ps }, 1);
      }
      done({
        step: "check",
        note: "the page and the core stay in their runtimes",
      });
      return result({ ok: true, problems: [] });
    }
    case "gen": {
      const stale = await gen(c, flag("--check"));
      for (const f of stale) error(`${f} is stale: run steambun gen`);
      if (stale.length > 0) return result({ ok: false, stale }, 1);
      done({
        step: "gen",
        note: flag("--check")
          ? "the generated Swift is current"
          : "wrote the generated Swift",
      });
      return result({ ok: true, stale: [] });
    }
  }
  return 2;
}

/** With --json, the run's one line on stdout. Returns the exit code. */
function result(o: object, code = 0) {
  if (json.on) console.log(JSON.stringify(o));
  return code;
}

if (import.meta.main) {
  // Before parse, so a usage error comes back as JSON too.
  json.on = process.argv.includes("--json");
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(
      /^steambun: /,
      "",
    );
    const code = e instanceof UsageError ? 2 : 1;
    if (json.on)
      process.exit(
        result(
          {
            ok: false,
            error: msg,
            ...(e instanceof BuildError && { logs: e.logs }),
            steps: json.steps,
          },
          code,
        ),
      );
    if (code === 2) {
      error(msg);
      process.exit(2);
    }
    error(msg);
    if (process.env.STEAMBUN_VERBOSE === "1" && e instanceof Error && e.stack)
      console.error(dim(e.stack));
    process.exit(1);
  }
}
