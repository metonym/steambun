// The PATH for child processes.
//
// GUI apps start with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so a core run by
// the native shell can't find gh, Homebrew's git, or bun. The shell used to
// ask the login shell for PATH before it started the core, which held up
// launch by 45–70 ms. Now it passes STEAMBUN_LOGIN_SHELL and the core asks, in
// the background, while it starts serving. Spawns wait for the answer
// (`await spawnEnv()`); the first one comes well after it lands.
//
// Bun reads PATH for spawn lookup from the env passed to Bun.spawn, not
// from a later change to process.env, so callers must pass `env`.

import { log } from "./log.ts";

const SHELL = process.env.STEAMBUN_LOGIN_SHELL;
delete process.env.STEAMBUN_LOGIN_SHELL;

// Homebrew and /usr/local, for when the login shell fails.
const FALLBACK = ["/opt/homebrew/bin", "/usr/local/bin"];

const g = globalThis as { __steambunPath?: Promise<string> };

/** `-l` without `-i` skips .zshrc and takes about 50 ms. */
async function resolve(): Promise<string> {
  const base = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  if (!SHELL) return base;
  const t0 = performance.now();
  try {
    const p = Bun.spawn([SHELL, "-l", "-c", 'printf %s "$PATH"'], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    });
    const [out, code] = await Promise.all([
      new Response(p.stdout).text(),
      p.exited,
    ]);
    if (code === 0 && out.trim()) {
      log(
        "env",
        `login PATH resolved in ${Math.round(performance.now() - t0)} ms`,
      );
      return out.trim();
    }
  } catch {
    // Fall through.
  }
  log("env", "login PATH failed; using fallback");
  const have = base.split(":");
  return [...FALLBACK.filter((d) => !have.includes(d)), ...have].join(":");
}

// On globalThis so a hot reload doesn't ask again.
const path = (g.__steambunPath ??= resolve());
// Children of a hot-reloaded core keep the same answer.
void path.then((p) => {
  process.env.PATH = p;
});

/** The environment for a child process, with the login PATH. */
export async function spawnEnv(
  extra: Record<string, string> = {},
): Promise<Record<string, string | undefined>> {
  return { ...process.env, PATH: await path, ...extra };
}

/** Bun.which on the login PATH. */
export async function which(cmd: string): Promise<string | null> {
  return Bun.which(cmd, { PATH: await path });
}
