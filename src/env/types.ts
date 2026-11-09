import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isIdentifier } from "../util/guards";
import { GENERATED_HEADER, STEAMBUN_DIR_NAME } from "../util/paths";
import { toImportSpecifier } from "../util/specifier";
import { writeIfChanged } from "../util/write-if-changed";

const BUILTIN_KEYS = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"]);

function fieldLine(key: string): string {
  const name = isIdentifier(key) ? key : JSON.stringify(key);
  return `  readonly ${name}: string;`;
}

interface EnvSchemaTypes {
  /** Specifier of the TS config file, relative to `.steambun/`. */
  configSpecifier: string;
  prefixes: string[];
  /** Keys typed by the schema's output, so excluded from the plain `string` fields. */
  schemaKeys: string[];
}

/** Ambient `ImportMetaEnv` for envPrefix-matched keys. Builtins live in `steambun/client`. */
export function generateEnvDts(
  publicKeys: string[],
  hasRoutesDts = false,
  schema?: EnvSchemaTypes,
): string {
  const schemaKeys = new Set(schema?.schemaKeys);
  const extra = publicKeys
    .filter((key) => !BUILTIN_KEYS.has(key) && !schemaKeys.has(key))
    .sort()
    .map(fieldLine);

  const header = `${GENERATED_HEADER}
/// <reference types="steambun/client" />${hasRoutesDts ? '\n/// <reference path="./routes.d.ts" />' : ""}
`;

  if (!schema && extra.length === 0) return header;

  const prefixUnion =
    schema && schema.prefixes.length > 0
      ? schema.prefixes.map((p) => JSON.stringify(p)).join(" | ")
      : "never";
  const schemaBlock = schema
    ? `import type { PublicEnvOf } from "steambun/client";

type SchemaEnv = PublicEnvOf<
  typeof import(${JSON.stringify(schema.configSpecifier)}).default,
  ${prefixUnion}
>;
`
    : "export {};\n";

  return `${header}
${schemaBlock}
declare global {
  interface ImportMetaEnv${schema ? " extends SchemaEnv" : ""} {${
    extra.length > 0
      ? `\n${extra.map((line) => `  ${line}`).join("\n")}\n  `
      : ""
  }}
}
`;
}

export async function writeEnvDts(
  root: string,
  publicEnv: Record<string, string>,
  schema?: Omit<EnvSchemaTypes, "configSpecifier"> & { configFile: string },
): Promise<string> {
  const dir = join(root, STEAMBUN_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "env.d.ts");
  const hasRoutesDts = existsSync(join(dir, "routes.d.ts"));
  await writeIfChanged(
    path,
    generateEnvDts(
      Object.keys(publicEnv),
      hasRoutesDts,
      schema && {
        // Extensionless: a `.ts` specifier would need allowImportingTsExtensions.
        configSpecifier: toImportSpecifier(dir, schema.configFile).replace(
          /\.(m?ts|m?js)$/,
          "",
        ),
        prefixes: schema.prefixes,
        schemaKeys: schema.schemaKeys,
      },
    ),
  );
  return path;
}
