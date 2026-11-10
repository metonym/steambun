// Where the app keeps its data. The shell passes STEAMBUN_HOME, from the
// config's `home`. With no shell, the app can call `setHome`; otherwise it
// is `.steambun/` in the working folder.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let dir = process.env.STEAMBUN_HOME ?? join(process.cwd(), ".steambun");

/** The app's data folder. Made on first use. */
export function home(...parts: string[]): string {
  mkdirSync(dir, { recursive: true });
  return join(dir, ...parts);
}

/** Use another folder, unless the shell chose one. Call before `serve`. */
export function setHome(d: string) {
  if (!process.env.STEAMBUN_HOME) dir = d;
}
