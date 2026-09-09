export interface ServerEnvOverrides {
  port?: number;
  host?: string | boolean;
  strictPort?: boolean;
  open?: boolean;
}

/**
 * Encodes CLI overrides for PORT/HOST/STRICT_PORT/OPEN into env vars for a
 * spawned dev/preview child process. Only opts that were actually passed
 * produce a key, so the generated server script's own config-based defaults
 * (decoded by {@link SERVER_ENV_DECODER_SOURCE}) still apply otherwise.
 *
 * @example
 * ```ts
 * childEnv({ port: 5999, host: true }); // { PORT: "5999", HOST: "" }
 * ```
 */
export function childEnv(opts: ServerEnvOverrides): Record<string, string> {
  const env: Record<string, string> = {};
  if (opts.port !== undefined) env.PORT = String(opts.port);
  if (opts.host === true) env.HOST = "";
  else if (typeof opts.host === "string") env.HOST = opts.host;
  if (opts.strictPort !== undefined) {
    env.STRICT_PORT = opts.strictPort ? "1" : "0";
  }
  if (opts.open !== undefined) env.OPEN = opts.open ? "1" : "0";
  return env;
}

/**
 * The decoder half of {@link childEnv}, emitted verbatim (as source text,
 * not a `steambun/runtime` import — these generated scripts run as
 * standalone entrypoints) into both the dev server (`synth.ts`) and the
 * preview/`--compile` server (`prod-server.ts`), so PORT/HOST/STRICT_PORT/
 * OPEN are decoded identically in both: an empty `HOST` means "bind every
 * interface" (mirrors `childEnv`'s `host: true` → `HOST: ""`), and
 * `STRICT_PORT`/`OPEN` only override their default when explicitly `"1"` or
 * `"0"`.
 */
export const SERVER_ENV_DECODER_SOURCE = `function serverOverridesFromEnv(env, defaults) {
  const envPort = Number(env.PORT);
  if (env.PORT && (!Number.isInteger(envPort) || envPort <= 0)) {
    console.warn(\`[steambun] ignoring invalid PORT "\${env.PORT}"\`);
  }
  const port = env.PORT && Number.isInteger(envPort) && envPort > 0 ? envPort : defaults.port;
  const host = env.HOST !== undefined ? env.HOST || true : defaults.host;
  const strictPort =
    env.STRICT_PORT === "1" ? true : env.STRICT_PORT === "0" ? false : defaults.strictPort;
  const open = env.OPEN === "1" ? true : env.OPEN === "0" ? false : defaults.open;
  return { port, host, strictPort, open };
}`;
