import { isTomlConfigPath } from "../config/bunfig";
import type { ResolvedConfig } from "../config/types";
import {
  isStandardSchema,
  type StandardSchemaV1,
  type ValidationIssue,
  validateWith,
} from "../util/standard-schema";

export class EnvValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    // Keys and messages only — never values, which may be secrets.
    super(
      `[steambun] Invalid environment (envSchema):\n${issues
        .map((issue) => `  ${issue.path || "(root)"}: ${issue.message}`)
        .join("\n")}`,
    );
    this.name = "EnvValidationError";
  }
}

/**
 * Validates `env` against `envSchema`. Returns the schema's output (with
 * defaults and transforms applied), or `undefined` when no schema is set.
 * Throws {@link EnvValidationError} listing every failing key.
 */
export async function validateEnv(
  schema: unknown,
  env: Record<string, string>,
): Promise<Record<string, unknown> | undefined> {
  if (schema === undefined) return undefined;
  if (!isStandardSchema(schema)) {
    throw new Error(
      "[steambun] envSchema must be a Standard Schema (zod, valibot, arktype, ...).",
    );
  }
  const result = await validateWith(schema as StandardSchemaV1, env);
  if (!result.ok) throw new EnvValidationError(result.issues);
  const value = result.value;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The envPrefix-matched subset of a validated env — what gets inlined as `import.meta.env.*`. */
export function publicOutput(
  output: Record<string, unknown> | undefined,
  prefixes: string[],
): Record<string, unknown> | undefined {
  if (!output) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(output)) {
    if (value !== undefined && prefixes.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
  }
  return out;
}

/** `writeEnvDts`'s schema argument, when `envSchema` comes from a TS config file. */
export function envSchemaTypes(
  config: ResolvedConfig,
  typedPublicEnv: Record<string, unknown> | undefined,
):
  | { configFile: string; prefixes: string[]; schemaKeys: string[] }
  | undefined {
  if (!config.envSchema || !typedPublicEnv || !config.configFile) {
    return undefined;
  }
  if (isTomlConfigPath(config.configFile)) return undefined;
  return {
    configFile: config.configFile,
    prefixes: config.envPrefix,
    schemaKeys: Object.keys(typedPublicEnv),
  };
}
