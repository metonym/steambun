import { statSync } from "node:fs";
import { join } from "node:path";

export interface StaticHandlerOptions {
  outDir: string;
  spa: boolean;
  /** Path prefix (e.g. "/assets/") whose files get immutable caching. */
  immutablePrefix?: string;
  /** Serve .br/.zst/.gz siblings when Accept-Encoding allows. Default true. */
  precompressed?: boolean;
}

const ENCODING_PREFERENCE: Array<{ name: string; ext: string }> = [
  { name: "zstd", ext: ".zst" },
  { name: "br", ext: ".br" },
  { name: "gzip", ext: ".gz" },
];

function acceptedEncodings(header: string | null): Set<string> {
  if (!header) return new Set();
  return new Set(
    header.split(",").map((part) => part.split(";")[0]!.trim().toLowerCase()),
  );
}

async function resolvePrecompressed(
  filePath: string,
  acceptEncodingHeader: string | null,
): Promise<{ file: ReturnType<typeof Bun.file>; encoding: string } | null> {
  const accepted = acceptedEncodings(acceptEncodingHeader);
  for (const { name, ext } of ENCODING_PREFERENCE) {
    if (!accepted.has(name)) continue;
    const variant = Bun.file(`${filePath}${ext}`);
    if (await variant.exists()) return { file: variant, encoding: name };
  }
  return null;
}

async function resolvePath(
  outDir: string,
  pathname: string,
  spa: boolean,
): Promise<string | null> {
  const safePath = pathname.replace(/^\/+|\/+$/g, "");
  const filePath = join(outDir, safePath || "index.html");

  if (await Bun.file(filePath).exists()) return filePath;

  const base = safePath.split("/").pop() ?? "";
  if (base && !base.includes(".")) {
    const htmlPath = `${filePath}.html`;
    if (await Bun.file(htmlPath).exists()) return htmlPath;
  }

  try {
    if (statSync(filePath).isDirectory()) {
      const nested = join(filePath, "index.html");
      if (await Bun.file(nested).exists()) return nested;
    }
  } catch {
    // ENOENT — not a directory either
  }

  if (spa) {
    const indexPath = join(outDir, "index.html");
    if (await Bun.file(indexPath).exists()) return indexPath;
  }

  return null;
}

async function buildResponse(
  filePath: string,
  pathname: string,
  req: Request,
  opts: { immutablePrefix?: string; precompressed: boolean },
): Promise<Response> {
  const isHtml = filePath.endsWith(".html");
  const immutable =
    !isHtml &&
    !!opts.immutablePrefix &&
    pathname.startsWith(opts.immutablePrefix);

  const headers = new Headers();
  let status = 200;
  let body: ReturnType<typeof Bun.file> | null = Bun.file(filePath);

  if (immutable) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  } else {
    headers.set("cache-control", "no-cache");
    const stat = statSync(filePath);
    const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    headers.set("etag", etag);
    if (req.headers.get("if-none-match") === etag) {
      status = 304;
      body = null;
    }
  }

  if (status === 200 && opts.precompressed) {
    const variant = await resolvePrecompressed(
      filePath,
      req.headers.get("accept-encoding"),
    );
    if (variant) {
      headers.set("content-encoding", variant.encoding);
      headers.set("vary", "Accept-Encoding");
      const contentType = Bun.file(filePath).type;
      if (contentType) headers.set("content-type", contentType);
      body = variant.file;
    }
  }

  if (req.method === "HEAD") body = null;

  return new Response(body, { status, headers });
}

/**
 * Preview / --compile catch-all for files outside the native assetsDir
 * route: publicDir copies, directory index.html, and SPA fallback.
 * Precompressed `.br`/`.zst`/`.gz` siblings are served when the request's
 * `Accept-Encoding` allows, with conditional-GET (weak ETag) for everything
 * else and immutable caching under `immutablePrefix`.
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
  const { outDir, spa, immutablePrefix, precompressed = true } = opts;

  return async (req: Request) => {
    const pathname = new URL(req.url).pathname;
    const filePath = await resolvePath(outDir, pathname, spa);
    if (!filePath) {
      return new Response(req.method === "HEAD" ? null : "Not Found", {
        status: 404,
      });
    }
    return buildResponse(filePath, pathname, req, {
      immutablePrefix,
      precompressed,
    });
  };
}
