import { readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { escapeRegExp } from "../util/regexp";

export interface StaticHandlerOptions {
  outDir: string;
  spa: boolean;
  /** Path prefix (e.g. "/assets/") whose files get immutable caching. */
  immutablePrefix?: string;
  /** Serve .br/.zst/.gz siblings when Accept-Encoding allows. Default true. */
  precompressed?: boolean;
  /**
   * Path to a `_headers.json` (glob, relative to `outDir` with a leading
   * `/` — e.g. `"/*.html"` — → extra headers). Read once at startup;
   * matched against the resolved file's path, merged into the response.
   */
  headersFile?: string;
  /**
   * Path to `.steambun-chunks.json` (`build.importMap`'s id → renamed-file
   * map). Read once at startup; a request for `${base}@chunk/<id>.js` (the
   * dynamic-import preload helper's stable-id URL, which import maps don't
   * apply to) 308-redirects to the current hashed file. Missing file or
   * unknown id → no match / 404.
   */
  chunkMapFile?: string;
  /** Path prefix requests are served under. Default `"/"`. */
  base?: string;
}

interface HeadersRule {
  matcher: InstanceType<typeof Bun.Glob>;
  headers: Record<string, string>;
}

/** Parses a JSON file; a missing path, unreadable file, or bad JSON yields `undefined`. */
function readJsonFile<T>(file: string | undefined): T | undefined {
  if (!file) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function loadHeadersRules(headersFile: string | undefined): HeadersRule[] {
  const raw = readJsonFile<Record<string, Record<string, string>>>(headersFile);
  if (!raw) return [];
  return Object.entries(raw).map(([glob, headers]) => ({
    matcher: new Bun.Glob(glob),
    headers,
  }));
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

/** Server-side build inputs, never served even though they live in outDir. */
const DENIED_METADATA_FILES = new Set([
  "_headers.json",
  ".steambun-chunks.json",
]);

async function resolvePath(
  outDir: string,
  pathname: string,
  spa: boolean,
): Promise<string | null> {
  if (pathname.includes("\0")) return null;
  const safePath = pathname.replace(/^\/+|\/+$/g, "");
  if (safePath.split("/").some((segment) => segment === "..")) return null;
  if (DENIED_METADATA_FILES.has(safePath)) return null;
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
  opts: {
    outDir: string;
    immutablePrefix?: string;
    precompressed: boolean;
    headersRules: HeadersRule[];
  },
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

  if (opts.headersRules.length > 0) {
    const matchPath = `/${relative(opts.outDir, filePath).split(sep).join("/")}`;
    for (const rule of opts.headersRules) {
      if (!rule.matcher.match(matchPath)) continue;
      for (const [key, value] of Object.entries(rule.headers)) {
        headers.set(key, value);
      }
    }
  }

  if (status === 200 && body) {
    headers.set("content-length", String(body.size));
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
  const {
    outDir,
    spa,
    immutablePrefix,
    precompressed = true,
    base = "/",
  } = opts;
  const headersRules = loadHeadersRules(opts.headersFile);
  const chunkMap =
    readJsonFile<Record<string, string>>(opts.chunkMapFile) ?? {};
  const chunkPattern = new RegExp(
    `^${escapeRegExp(base)}@chunk/([a-z0-9]+)\\.js$`,
  );

  return async (req: Request) => {
    const pathname = new URL(req.url).pathname;

    const chunkMatch = pathname.match(chunkPattern);
    if (chunkMatch) {
      const target = chunkMap[chunkMatch[1]!];
      if (!target) return new Response("Not Found", { status: 404 });
      return new Response(null, {
        status: 308,
        headers: { location: `${base}${target}`, "cache-control": "no-cache" },
      });
    }

    let decodedPathname: string;
    try {
      decodedPathname = decodeURIComponent(pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const filePath = await resolvePath(outDir, decodedPathname, spa);
    if (!filePath) {
      return new Response(req.method === "HEAD" ? null : "Not Found", {
        status: 404,
      });
    }
    return buildResponse(filePath, pathname, req, {
      outDir,
      immutablePrefix,
      precompressed,
      headersRules,
    });
  };
}
