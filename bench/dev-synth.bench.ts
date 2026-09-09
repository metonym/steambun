import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { group, task } from "ostia";
import { resolveDefaults } from "../src/config/loader";
import { discoverHtmlEntries } from "../src/dev/discover";
import { synthesizeDevServer } from "../src/dev/synth";
import { writeEnvDts } from "../src/env/types";
import { writeRoutesDts } from "../src/routes-dts";

// `routes.d.ts`/`env.d.ts` and the synthesized dev server are regenerated on
// every restart; writeIfChanged (P11) skips the actual write when the
// content is byte-identical, avoiding an mtime bump that would otherwise
// trigger an editor's or `tsc --watch`'s re-check for no reason.
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "steambun-dev-synth-"));
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><html><body></body></html>\n",
  );
  writeFileSync(
    join(root, "about.html"),
    "<!doctype html><html><body></body></html>\n",
  );
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.ts"), "export {};\n");
  return root;
}

const publicEnvDefine = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [
    `import.meta.env.VITE_VAR_${i}`,
    JSON.stringify(`v${i}`),
  ]),
);
const publicEnv = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [`VITE_VAR_${i}`, `v${i}`]),
);

async function synthAll(root: string): Promise<void> {
  const config = resolveDefaults(
    {},
    { root, command: "dev", mode: "development", configFile: null },
  );
  const htmlEntries = await discoverHtmlEntries(root);
  await synthesizeDevServer(config, htmlEntries, publicEnvDefine);
  await writeRoutesDts(root, undefined, htmlEntries, config.appType);
  await writeEnvDts(root, publicEnv);
}

let fixtureRoot: string;

group("dev/synth: synthesizeDevServer + writeRoutesDts + writeEnvDts", () => {
  // Two calls per trial against the same fixture root: the first is a
  // cold write only on the very first trial (every later trial's "first"
  // call already matches what the previous trial wrote), the second is
  // always the no-change path — the pair this bench exists to measure.
  task(
    "write, then write again unchanged",
    async () => {
      await synthAll(fixtureRoot);
      await synthAll(fixtureRoot);
    },
    {
      before: () => {
        fixtureRoot = makeFixture();
      },
    },
  );
});
