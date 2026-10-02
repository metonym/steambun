import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  readUserBunfig,
  relocateBunfigPaths,
  serializeMergedBunfig,
} from "../config/bunfig";
import { toConfigEnv } from "../config/loader";
import type { ConfigEnv, ResolvedConfig } from "../config/types";
import { GENERATED_HEADER, STEAMBUN_DIR_NAME } from "../util/paths";
import { isBunPlugin } from "../util/plugins";
import { SERVER_ENV_DECODER_SOURCE } from "../util/server-env";
import { toImportSpecifier } from "../util/specifier";
import { writeIfChanged } from "../util/write-if-changed";
import { type HtmlEntry, htmlServePath } from "./discover";
import { generateEnvPluginSource } from "./env-plugin";

/** A generated module that re-exports one `steambun/internal` plugin factory call. */
function internalPlugin(factory: string, ...args: unknown[]): string {
  return `${GENERATED_HEADER}
import { ${factory} } from "steambun/internal";
export default ${factory}(${args.map((arg) => JSON.stringify(arg)).join(", ")});
`;
}

// bunfig `plugins` only takes module paths, but user plugins are values in the
// config, so each gets a wrapper that re-resolves the config and re-exports one.
function pluginWrapperSource(
  configSpecifier: string,
  index: number,
  env: ConfigEnv,
): string {
  return `${GENERATED_HEADER}
import configExport from ${JSON.stringify(configSpecifier)};

const resolved =
  typeof configExport === "function"
    ? await configExport(${JSON.stringify(env)})
    : configExport;

export default (resolved?.plugins ?? [])[${index}];
`;
}

// serve.ts imports the HTML entries statically (Bun's bundler requires it) and
// reloads the config itself, so middleware/plugin functions needn't be serialized.
export async function synthesizeDevServer(
  config: ResolvedConfig,
  htmlEntries: HtmlEntry[],
  publicEnvDefine: Record<string, string>,
): Promise<{ bunfigPath: string; servePath: string }> {
  const dir = join(config.root, STEAMBUN_DIR_NAME);
  await mkdir(dir, { recursive: true });

  const pluginPaths: string[] = [];
  const emitPlugin = async (name: string, source: string) => {
    const path = join(dir, name);
    pluginPaths.push(path);
    await writeIfChanged(path, source);
  };

  const { alias } = config.resolve;
  // First, so an alias can't resolve a `.server` import before it's checked.
  await emitPlugin(
    "server-boundary-plugin.ts",
    internalPlugin(
      "createServerBoundaryPlugin",
      config.root,
      config.api ?? null,
      alias,
    ),
  );
  if (Object.keys(alias).length > 0) {
    await emitPlugin(
      "alias-plugin.ts",
      internalPlugin("createAliasPlugin", alias, config.root),
    );
  }
  await emitPlugin(
    "vite-suffix-plugin.ts",
    internalPlugin("createViteSuffixPlugin", alias, config.root),
  );

  // Only a steambun.config.* can hold plugin values; bunfig and Vite configs contribute none.
  if (config.configFile) {
    const configSpecifier = toImportSpecifier(dir, config.configFile);
    for (const [index, plugin] of config.plugins.entries()) {
      if (!isBunPlugin(plugin)) continue;
      await emitPlugin(
        `plugin-${index}.ts`,
        pluginWrapperSource(
          configSpecifier,
          index,
          toConfigEnv(config.command, config.mode),
        ),
      );
    }
  }

  // Last: it claims every project source file (see env-plugin.ts).
  await emitPlugin(
    "env-plugin.ts",
    generateEnvPluginSource(publicEnvDefine, { root: config.root, alias }),
  );

  const bunfigPath = join(dir, "bunfig.toml");
  await writeIfChanged(
    bunfigPath,
    serializeMergedBunfig(
      await userBunfigForMerge(config, dir),
      pluginPaths.map((path) => toImportSpecifier(dir, path)),
    ),
  );

  const servePath = join(dir, "serve.ts");
  await writeIfChanged(
    servePath,
    generateServeSource(config, htmlEntries, dir),
  );

  return { bunfigPath, servePath };
}

async function userBunfigForMerge(
  config: ResolvedConfig,
  dir: string,
): Promise<Record<string, unknown>> {
  const raw = await readUserBunfig(config.root, config.configFile);
  return raw ? relocateBunfigPaths(raw, config.root, dir) : {};
}

function generateServeSource(
  config: ResolvedConfig,
  htmlEntries: HtmlEntry[],
  dir: string,
): string {
  const htmlImports = htmlEntries
    .map(
      (entry, i) =>
        `import entry_${i} from ${JSON.stringify(toImportSpecifier(dir, entry.file))};`,
    )
    .join("\n");

  const htmlRouteEntries = htmlEntries
    .map(
      (entry, i) =>
        `  ${JSON.stringify(htmlServePath(entry, config.appType))}: entry_${i},`,
    )
    .join("\n");

  return `${GENERATED_HEADER}
${htmlImports}
import {
  createApp,
  displayServerUrls,
  hostnameFromHost,
  loadConfig,
  openBrowser,
  resolveOpenUrl,
  serveWithPortRetry,
  tlsFromHttps,
} from "steambun/internal";

const startedAt = performance.now();

const config = await loadConfig({
  root: ${JSON.stringify(config.root)},
  command: "dev",
  mode: ${JSON.stringify(config.mode)},
  ${config.configFile ? `configFile: ${JSON.stringify(config.configFile)},` : ""}
});

const app = await createApp({
  config,
  mode: "dev",
  htmlRoutes: {
${htmlRouteEntries}
  },
});

${SERVER_ENV_DECODER_SOURCE}
const { port, host, strictPort, open } = serverOverridesFromEnv(process.env, {
  port: config.server.port,
  host: config.server.host,
  strictPort: config.server.strictPort,
  open: config.server.open,
});

const server = serveWithPortRetry(
  {
    port,
    hostname: hostnameFromHost(host),
    tls: tlsFromHttps(config.server.https, config.root, { devCert: true }),
    ...app.serveOptions,
  },
  { strictPort, label: "dev" },
);

const { local, network } = displayServerUrls(server.url);
const elapsed = Math.round(performance.now() - startedAt);
console.log(\`[steambun] dev server ready in \${elapsed}ms\`);
console.log(\`  Local:   \${local}\`);
for (const url of network) console.log(\`  Network: \${url}\`);
// \`bun --hot\` re-evaluates this module on every reload; open the browser once per process.
const openUrl = resolveOpenUrl(local, open);
const opened = globalThis as { __steambunOpened?: boolean };
if (openUrl && !opened.__steambunOpened) {
  opened.__steambunOpened = true;
  openBrowser(openUrl);
}
`;
}
