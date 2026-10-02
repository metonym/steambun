import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppType } from "./config/types";
import type { HtmlEntry } from "./dev/discover";
import { htmlServePath } from "./dev/discover";
import { discoverApiFiles, hasWebsocketExport } from "./runtime/api-routes";
import { GENERATED_HEADER, STEAMBUN_DIR_NAME } from "./util/paths";
import { toImportSpecifier } from "./util/specifier";
import { writeIfChanged } from "./util/write-if-changed";

function paramsTypeFor(path: string): string {
  // Like Bun's ExtractRouteParams: a trailing `*` contributes no param.
  const params = [...path.matchAll(/:([^/]+)/g)].map(
    (m) => `${JSON.stringify(m[1])}: string`,
  );
  return params.length === 0 ? "{}" : `{ ${params.join("; ")} }`;
}

function stripPageWildcard(path: string): string {
  return path.endsWith("/*") ? path.slice(0, -2) || "/" : path;
}

function withoutExt(specifier: string): string {
  return specifier.replace(/\.[^/.]+$/, "");
}

export interface GenerateRoutesDtsInput {
  dtsDir: string;
  apiEntries: Array<{ file: string; paths: string[]; hasWebsocket?: boolean }>;
  htmlEntries: HtmlEntry[];
  appType: AppType;
}

/** `.steambun/routes.d.ts` source: the route/param manifest `steambun/client` types against. */
export function generateRoutesDts(input: GenerateRoutesDtsInput): string {
  const { dtsDir, apiEntries, htmlEntries, appType } = input;

  const imports: string[] = [];
  const routeLines: string[] = [];
  apiEntries.forEach((entry, i) => {
    const specifier = withoutExt(toImportSpecifier(dtsDir, entry.file));
    imports.push(`import type * as R${i} from "${specifier}";`);
    for (const path of entry.paths) {
      routeLines.push(
        `    ${JSON.stringify(path)}: { params: ${paramsTypeFor(path)}; module: typeof R${i}; websocket: ${entry.hasWebsocket ? "true" : "false"} };`,
      );
    }
  });

  const pageLines = [
    ...new Set(
      htmlEntries.map((entry) =>
        stripPageWildcard(htmlServePath(entry, appType)),
      ),
    ),
  ].map((path) => `    ${JSON.stringify(path)}: {};`);

  return `${GENERATED_HEADER}
${imports.join("\n")}
declare module "steambun/client" {
  interface SteambunRoutes {
${routeLines.join("\n")}
  }
  interface SteambunPages {
${pageLines.join("\n")}
  }
}
export {};
`;
}

export async function writeRoutesDts(
  root: string,
  apiDir: string | undefined,
  htmlEntries: HtmlEntry[],
  appType: AppType,
): Promise<string> {
  const dtsDir = join(root, STEAMBUN_DIR_NAME);
  await mkdir(dtsDir, { recursive: true });
  const fileEntries = apiDir ? (await discoverApiFiles(apiDir)).files : [];
  const apiEntries = await Promise.all(
    fileEntries.map(async (entry) => ({
      ...entry,
      hasWebsocket: await hasWebsocketExport(entry.file),
    })),
  );
  const source = generateRoutesDts({
    dtsDir,
    apiEntries,
    htmlEntries,
    appType,
  });
  const path = join(dtsDir, "routes.d.ts");
  await writeIfChanged(path, source);
  return path;
}
