# Contributing

Layout, rules and checks for changes to steambun.

## Setup

Install the [requirements](README.md#requirements), then:

```sh
bun install
bun run test           # unit tests
bun run test:e2e       # every example, in the Mac app
bun run test:changed   # only the unit tests your changes can reach (bivium)
bun run typecheck      # bun check
bun run lint           # bun fmt --check and bun lint; `bun run fmt` formats
bun run knip           # unused files, exports and dependencies
bun run build          # dist/: the package as npm gets it
bun run test:package   # build, pack, install in a new app, run the quick start
```

The repo is a Bun workspace. The root is the package. Each folder in
`examples/` is an app that depends on `steambun` through the workspace,
as a user's app depends on the published package. To run one:

```sh
cd examples/hello
bun run dev           # the page in a browser tab, with hot reload
bun run dev:native    # the same, in the Mac app
bun run app           # build the .app and open it
bun run build:web     # the page as a static site, in build/web
bun run test          # the e2e tests in the Mac app
```

Each example has the same scripts.

## Layout

| Path             | What it is                                                                       |
| ---------------- | -------------------------------------------------------------------------------- |
| `src/cli.ts`     | The `steambun` bin. A thin wrapper over `src/tools.ts`.                          |
| `src/tools.ts`   | `build`, `app`, `dev`, `gen`: everything that reads the user's app and config    |
| `src/config.ts`  | `defineApp`, and how the config's defaults come from the app's folder            |
| `src/schema.ts`  | `defineBridge`, `op` and `t`: the op schema both compilers check                 |
| `src/bridge.ts`  | The framework's own ops and events, written with that schema                     |
| `src/gen/`       | The schema and the config, turned into Swift and `Info.plist`                    |
| `src/check.ts`   | `steambun check`: the page and the core stay in their runtimes                   |
| `src/devpage.ts` | `steambun dev` for an app with no core                                           |
| `src/release.ts` | `steambun release`: the update key and the signed feed                           |
| `src/test.ts`    | `steambun/test`: the harness, on the shell or a headless tab                     |
| `src/svelte.ts`  | The Svelte 5 plugin                                                              |
| `src/core/`      | `steambun/core`: `serve()`, the shell's link, browser panes, settings            |
| `src/ui/`        | `steambun/ui`: `native`, settings, window glue, the hot reload keeper            |
| `src/native/`    | The Swift shell. `Bridge.gen.swift` is generated; `steambun gen --check` says so |
| `tests/`         | Unit tests                                                                       |
| `scripts/`       | `build.ts` and `test-package.ts`                                                 |
| `docs/`          | Everything the README leaves out                                                 |

The package's API is flat: each entry in `package.json`'s `exports` is
one import path, such as `steambun/ui`. Code lives in `src/`, and
`scripts/build.ts` points the exports into it.

## How it ships

steambun ships its TypeScript and Swift as they are. Bun runs the
TypeScript, and `steambun app` compiles the Swift on the user's machine.
So `bun run build` copies `src/` to `dist/` with a `package.json` that
drops the dev fields. It isn't a bundle.

`bun run test:package` checks what a user gets: it builds and packs
`dist/`, checks that the package imports only Bun and Node builtins (and
`svelte/compiler`, from the Svelte plugin), installs it in a new app the
way the README says, then builds and tests that app in the Mac app and in
a tab.

## Rules every change must keep

- **Zero runtime dependencies.** `src/` imports Bun and Node builtins,
  and nothing else. The Svelte plugin imports `svelte/compiler`, which
  the user installs. The package doesn't declare it, even as a peer.
  `test:package` checks this.
- **Never pass silently.** A test file that registers no tests, a stale
  generated file, or a page that imports Bun must fail, not skip.
- **The page and the core stay apart.** `steambun check` fails if the
  page reaches `bun`, `bun:*` or `steambun/core`, or if the core reaches
  `steambun/ui`. Shared code and type-only imports are fine.
- **Both backends, one test.** A harness method works the same in the
  Mac app and in a tab, or says it's native only. `app.js()` and
  `app.waitFor()` return plain JSON on both.
- **Regenerate after a schema change.** Edit `src/bridge.ts` or
  `src/gen/`, then run `bunx steambun gen` in an example. CI runs
  `gen --check`.
- **Docs change with the code.** A change to what steambun does updates
  the README or the doc in `docs/` that describes it, in the same commit.
  A user-visible change also gets a `CHANGELOG.md` entry under
  `## Unreleased`.
- **Comments say why.** JSDoc is for the public API. Elsewhere, a
  comment states a reason or a limit the code can't show.

## Tests

| What                       | Covers                                                                  |
| -------------------------- | ----------------------------------------------------------------------- |
| `tests/check.test.ts`      | `steambun check`: imports that cross runtimes, and ones that may        |
| `tests/config.test.ts`     | Config defaults from the app's folder, and config errors                |
| `tests/host.test.ts`       | `serve()`: its routes, settings and the shell's link                    |
| `tests/web.test.ts`        | `steambun build --web`: `hello` and `core` as static sites in a browser |
| `examples/*/test/*.e2e.ts` | Each example, end to end, in the Mac app and in a tab                   |
| `scripts/test-package.ts`  | The packed package in a new app                                         |

A behavior fix needs a test that fails before the fix and passes after.
A harness fix usually belongs in an example's e2e test, run on both
backends.

A pull request runs only the tests its changes can reach, which
[bivium](https://github.com/metonym/bivium) finds from
`bivium.config.ts`. A change to `docs/` runs nothing. A change to the
Swift shell runs every example. A new test that reads a file outside its
imports says so there. `bunx bivium check` lists any that don't.

CI runs on a macOS runner whose WebKit is older than yours. Some bugs
show up only there. When a test fails in CI, read the failure folder it
uploads: the screenshot, the HTML and the logs.

## Benchmarks

[ostia](https://github.com/metonym/ostia) runs them. Results stay in
`.ostia/` (gitignored): a baseline only holds on the machine that saved
it.

| Command                    | Runs                                                                   |
| -------------------------- | ---------------------------------------------------------------------- |
| `bun run bench`            | Every suite in `bench/*.bench.ts`. Launches apps; takes a few minutes. |
| `bun run bench:quick`      | Config, check, gen and the core server. No apps; seconds.              |
| `bun run bench:memory`     | Memory and size of each example's built `.app`, idle.                  |
| `bunx ostia baseline save` | Every workload in `ostia.config.ts`, saved as the baseline.            |
| `bun run bench:ci`         | The same workloads, compared to that baseline. Fails on a regression.  |

| Suite                  | Covers                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| `bench/app.bench.ts`   | Launch to a ready page, test-harness round trips, page → shell ops |
| `bench/build.bench.ts` | Page and core bundles (plain, JIT, AOT) and the Swift shell build  |
| `bench/core.bench.ts`  | `serve()` against bare `Bun.serve`, settings, WebSocket            |
| `bench/dev.bench.ts`   | Dev page server start, and edit to screen under hot reload         |
| `bench/tools.bench.ts` | Config loading, `check`, Swift and plist generation                |

`ostia.config.ts` adds the CLI as a user runs it (a fresh process) and a
built `.app`'s cold launch to its page, to its first paint report and
to WebKit's own first paint (`bench/paint.ts`).

To test a speedup: save a baseline on `master`, switch to your branch,
then run `bun run bench:ci`. Build the examples' apps first
(`steambun app` in each); the launch and memory benches use them.

## Releasing

1. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z — YYYY-MM-DD`.
2. Bump `version` in `package.json` and commit as `vX.Y.Z` on master.
3. Tag it with `git tag -s -m vX.Y.Z vX.Y.Z`, then push master and the
   tag: `git push origin master vX.Y.Z`. The tag starts `release.yml`,
   which tests the packed package, publishes `dist/` to npm with
   provenance, and creates the GitHub release from the CHANGELOG. It
   needs the `NPM_AUTH_TOKEN` secret.
4. Check that `npm view steambun version` shows the new version.

## Before you finish

- [ ] `bun run lint`, `bun run typecheck`, `bun run knip`, `bun run test`
      and `bun run test:package` pass. Check the exit code: piping into
      `tail` hides a failure.
- [ ] Changes to the shell, the harness or the CLI: `bun run test:e2e`
      passes, and `bunx steambun test --both` in the examples you touched.
- [ ] The README, `docs/` and this guide still describe what the code
      does.
