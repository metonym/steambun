export interface ServerEnvOverrides {
  port?: number;
  host?: string | boolean;
  strictPort?: boolean;
  open?: boolean;
}

/** Encodes CLI overrides as env vars for the dev/preview child; unset opts produce no key. `host: true` is `HOST=""`. */
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

/** Decoder half of {@link childEnv}, inlined as source into the generated dev and preview/compile scripts, which run standalone. A malformed value warns and falls back to the default. */
export const SERVER_ENV_DECODER_SOURCE = `function serverOverridesFromEnv(env, defaults) {
  const ignore = (name) => console.warn(\`[steambun] ignoring invalid \${name} "\${env[name]}"\`);
  const flag = (name, fallback) => {
    const value = env[name];
    if (!value) return fallback;
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    ignore(name);
    return fallback;
  };
  let port = defaults.port;
  if (env.PORT) {
    const parsed = Number(env.PORT);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) port = parsed;
    else ignore("PORT");
  }
  return {
    port,
    host: env.HOST !== undefined ? env.HOST || true : defaults.host,
    strictPort: flag("STRICT_PORT", defaults.strictPort),
    open: flag("OPEN", defaults.open),
  };
}`;
