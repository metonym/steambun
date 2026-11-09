// `steambun dev` for an app with no core: serve the page with hot reload.
// The shell loads it in place of steambun://app/. Like the built app,
// there's no /_steambun/*, so settings stay in localStorage.
//
//   bun --hot steambun/devpage.ts ./index.html
import { resolve } from "node:path";

const file = process.argv[2];
if (!file) throw new Error("usage: devpage.ts <page.html>");
const page = (await import(resolve(file))).default;

const server = Bun.serve({
  port: process.env.STEAMBUN_PORT ? Number(process.env.STEAMBUN_PORT) : 3000,
  hostname: "127.0.0.1",
  development: { hmr: true, console: true },
  routes: {
    "/_steambun/*": new Response("no core", { status: 404 }),
    "/*": page,
  },
});

console.error(`steambun: page at ${server.url}`);
const parent = Number(process.env.STEAMBUN_PARENT_PID);
if (parent) {
  console.log(`STEAMBUN_READY ${server.port}`);
  setInterval(() => process.ppid !== parent && process.exit(0), 1000).unref();
}
