import type { ResolvedConfig } from "../config/types";
import { isPlainObject } from "../util/guards";
import {
  isStandardSchema,
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

/** Returns the schema's output (defaults and transforms applied), or `undefined` when no schema is set. Throws {@link EnvValidationError}. */
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
  const result = await validateWith(schema, env);
  if (!result.ok) throw new EnvValidationError(result.issues);
  const value = result.value;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Why `value` can't be inlined into client code as a JSON define, or `undefined` if it can. */
function nonJsonReason(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  switch (typeof value) {
    case "string":
    case "boolean":
      return undefined;
    case "number":
      return Number.isFinite(value) ? undefined : "a non-finite number";
    case "object": {
      if (Array.isArray(value)) {
        return value.map(nonJsonReason).find((reason) => reason);
      }
      if (!isPlainObject(value)) {
        return `a ${value.constructor?.name ?? "non-plain object"}`;
      }
      return Object.values(value)
        .map(nonJsonReason)
        .find((reason) => reason);
    }
    default:
      return `a ${typeof value}`;
  }
}

/**
 * The envPrefix-matched subset of a validated env, i.e. what gets inlined as `import.meta.env.*`.
 * Throws {@link EnvValidationError} for a value JSON can't carry (Date, bigint, ...), which would
 * otherwise be inlined as something else.
 */
export function publicOutput(
  output: Record<string, unknown> | undefined,
  prefixes: string[],
): Record<string, unknown> | undefined {
  if (!output) return undefined;
  const out: Record<string, unknown> = {};
  const issues: ValidationIssue[] = [];
  for (const [key, value] of Object.entries(output)) {
    if (value === undefined || !prefixes.some((p) => key.startsWith(p))) {
      continue;
    }
    const reason = nonJsonReason(value);
    if (reason) {
      issues.push({
        path: key,
        message: `output is ${reason}, which can't be inlined into client code; use a string, number, boolean, array, or plain object`,
      });
    }
    out[key] = value;
  }
  if (issues.length > 0) throw new EnvValidationError(issues);
  return out;
}

/** `writeEnvDts`'s schema argument; only a TS config can carry `envSchema`. */
export function envSchemaTypes(
  config: ResolvedConfig,
  typedPublicEnv: Record<string, unknown> | undefined,
):
  | { configFile: string; prefixes: string[]; schemaKeys: string[] }
  | undefined {
  if (!config.envSchema || !typedPublicEnv || !config.configFile) {
    return undefined;
  }
  return {
    configFile: config.configFile,
    prefixes: config.envPrefix,
    schemaKeys: Object.keys(typedPublicEnv),
  };
}
