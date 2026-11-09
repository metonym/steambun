import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const BIN = join(REPO_ROOT, "src", "bin.ts");

export function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `steambun-${prefix}-`));
}

/** Generated scripts import `steambun/internal`; a symlinked package lets them resolve from a temp project. */
export function linkSteambun(root: string): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(REPO_ROOT, join(root, "node_modules", "steambun"));
}

export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const port = server.port as number;
  await server.stop(true);
  return port;
}

export interface RunningBin {
  output(): string;
  /** Resolves once the combined stdout+stderr satisfies `predicate`; rejects on timeout. */
  until(predicate: (output: string) => boolean, what: string): Promise<void>;
  /** Waits for the process to exit on its own and returns its exit code. */
  exited(): Promise<number>;
  /** Interrupts the process the way Ctrl-C does and waits for it to exit. */
  stop(): Promise<number>;
}

/** Runs `steambun <args>` in `cwd` without a terminal, collecting its output. */
export function spawnBin(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): RunningBin {
  return spawnBun([BIN, ...args], cwd, env);
}

/** Runs `bun <args>` in `cwd`, with `env` layered over a copy of the parent's. */
export function spawnBun(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): RunningBin {
  const proc = Bun.spawn({
    cmd: ["bun", ...args],
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  };
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  return {
    output: () => output,
    async until(predicate, what) {
      const deadline = Date.now() + 15_000;
      while (!predicate(output)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${what}; got:\n${output}`);
        }
        await Bun.sleep(25);
      }
    },
    async exited() {
      const code = await proc.exited;
      await pumps;
      return code;
    },
    async stop() {
      proc.kill("SIGINT");
      return this.exited();
    },
  };
}
