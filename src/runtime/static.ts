import { statSync } from "node:fs";
import { join } from "node:path";

export interface StaticHandlerOptions {
  outDir: string;
  spa: boolean;
}

/**
 * Preview / --compile catch-all for files outside the native assetsDir
 * route: publicDir copies, directory index.html, and SPA fallback.
 *
 * @example
 * ```ts
 * import { createStaticHandler } from "steambun/runtime";
 *
 * Bun.serve({
 *   routes: { "/*": createStaticHandler({ outDir: "dist", spa: true }) },
 * });
 * ```
 */
export function createStaticHandler(
  opts: StaticHandlerOptions,
): (req: Request) => Response | Promise<Response> {
  const { outDir, spa } = opts;
  const indexFile = spa ? Bun.file(join(outDir, "index.html")) : null;

  return async (req: Request) => {
    const pathname = new URL(req.url).pathname;
    const safePath = pathname.replace(/^\/+|\/+$/g, "");
    const filePath = join(outDir, safePath || "index.html");

    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    const base = safePath.split("/").pop() ?? "";
    if (base && !base.includes(".")) {
      const htmlFile = Bun.file(`${filePath}.html`);
      if (await htmlFile.exists()) return new Response(htmlFile);
    }

    try {
      if (statSync(filePath).isDirectory()) {
        const nested = Bun.file(join(filePath, "index.html"));
        if (await nested.exists()) return new Response(nested);
      }
    } catch {
      // ENOENT — not a directory either
    }

    if (indexFile && (await indexFile.exists())) {
      return new Response(indexFile);
    }
    return new Response("Not Found", { status: 404 });
  };
}
