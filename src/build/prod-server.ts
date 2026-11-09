import { basename, join } from "node:path";
import { configKindOf } from "../config/loader";
import type { ResolvedConfig } from "../config/types";
import { GENERATED_HEADER, STEAMBUN_DIR_NAME } from "../util/paths";
import { SERVER_ENV_DECODER_SOURCE } from "../util/server-env";
import { posixRelative, toImportSpecifier } from "../util/specifier";
import { writeIfChanged } from "../util/write-if-changed";

export interface ProdServeOptions {
  /** The script is bundled into `outDir` (`dist/server.js`), so `import.meta.dir` is `outDir`. */
  embedOutDir?: boolean;
  /** Check `envSchema` at startup against `process.env` layered over these build-time public values. */
  envCheck?: Record<string, string>;
  /** `steambun preview`: skips the response cache and `strictPort` defaults off. A deployed server defaults it on so it never silently moves ports. */
  local?: boolean;
}

/** Writes the serve script under `.steambun/` and returns its path. */
export async function writeProdServe(
  config: ResolvedConfig,
  outDir: string,
  file: "prod-serve.ts" | "dist-serve.ts",
  opts: ProdServeOptions = {},
): Promise<string> {
  const path = join(config.root, STEAMBUN_DIR_NAME, file);
  await writeIfChanged(path, generateProdServeSource(config, outDir, opts));
  return path;
}

function generateProdServeSource(
  config: ResolvedConfig,
  outDir: string,
  opts: ProdServeOptions = {},
): string {
  const serveDir = join(config.root, STEAMBUN_DIR_NAME);
  const outDirRelative = posixRelative(serveDir, outDir);
  // A compiled binary's embedded `assets` dirs are only reachable by basename under /$bunfs/root.
  const outDirBasename = basename(outDir);
  const apiBasename = config.api ? basename(config.api) : null;
  const outDirBlock = opts.embedOutDir
    ? `const outDir = import.meta.dir;`
    : `const outDirCandidates = [
  join(import.meta.dir, ${JSON.stringify(outDirRelative)}),
  join(import.meta.dir, ${JSON.stringify(outDirBasename)}),
];
const outDir = outDirCandidates.find(existsSync) ?? outDirCandidates[0];`;

  const kind = config.configFile ? configKindOf(config.configFile) : null;
  const configImport = config.configFile
    ? `import configExport from ${JSON.stringify(toImportSpecifier(serveDir, config.configFile))};`
    : `const configExport = {};`;
  const envCheck = opts.envCheck && config.envSchema ? opts.envCheck : null;
  const internalNames = [
    ...(kind === "bunfig"
      ? ["bunfigToUserConfig", "resolveBunfigModules"]
      : []),
    ...(kind === "vite" ? ["viteConfigToUserConfig"] : []),
    ...(kind === "steambun" || kind === "vite" ? ["toConfigEnv"] : []),
    "resolveDefaults",
    ...(envCheck ? ["validateEnv"] : []),
  ];
  const envCheckBlock = envCheck
    ? `
try {
  await validateEnv(config.envSchema, {
    ...${JSON.stringify(envCheck)},
    ...process.env,
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
`
    : "";
  const callConfig = `const exported =
  typeof configExport === "function"
    ? await configExport(toConfigEnv("preview", ${JSON.stringify(config.mode)}))
    : await configExport;`;
  const rawConfigBlock =
    kind === "bunfig"
      ? `const rawConfig = await resolveBunfigModules(
  bunfigToUserConfig(configExport),
  configExport,
  ${JSON.stringify(config.root)},
);`
      : kind === "vite"
        ? `${callConfig}
const rawConfig = viteConfigToUserConfig(exported ?? {});`
        : kind === "steambun"
          ? `${callConfig}
const rawConfig = exported;`
          : "const rawConfig = configExport;";

  return `${GENERATED_HEADER}
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  ${internalNames.join(",\n  ")},
  createApp,
  displayServerUrls,
  hostnameFromHost,
  openBrowser,
  resolveOpenUrl,
  serveWithPortRetry,
  tlsFromHttps,
} from "steambun/internal";
${configImport}

${outDirBlock}

${rawConfigBlock}

const config = resolveDefaults(rawConfig ?? {}, {
  root: ${JSON.stringify(config.root)},
  command: "preview",
  mode: ${JSON.stringify(config.mode)},
  configFile: ${JSON.stringify(config.configFile)},
});
${envCheckBlock}
const apiDirCandidates = config.api
  ? [config.api, join(import.meta.dir, ${JSON.stringify(apiBasename ?? "")})]
  : [];
const apiDir = apiDirCandidates.find(existsSync) ?? config.api;

${SERVER_ENV_DECODER_SOURCE}
const { port, host, strictPort, open } = serverOverridesFromEnv(process.env, {
  port: config.server.port,
  host: config.server.host,
  strictPort: config.server.strictPort ?? ${opts.local !== true},
  open: config.server.open,
});
// \`HOST\` can name the hostname \`server.allowedHosts\` should accept.
config.server.host = host;

const app = await createApp({ config, mode: "preview", outDir, apiDir, ${opts.local ? "cache: false" : "deployed: true"} });

const server = serveWithPortRetry(
  {
    port,
    hostname: hostnameFromHost(host),
    tls: tlsFromHttps(config.server.https, config.root),
    ...app.serveOptions,
  },
  { strictPort },
);

const { local, network } = displayServerUrls(server.url);
console.log(\`[steambun] server ready\`);
console.log(\`  Local:   \${local}\`);
for (const url of network) console.log(\`  Network: \${url}\`);
const openUrl = resolveOpenUrl(local, open);
if (openUrl) openBrowser(openUrl);
`;
}
