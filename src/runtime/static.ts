import { type Stats, statSync } from "node:fs";
import { join } from "node:path";

export interface StaticHandlerOptions {
  outDir: string;
  spa: boolean;
  /** Path prefix (e.g. "/assets/") whose files get immutable caching. */
  immutablePrefix?: string;
  /** Serve `.br`/`.zst`/`.gz` siblings when `Accept-Encoding` allows. Default `true`. */
  precompressed?: boolean;
  /** Path prefix requests are served under (stripped before lookup). Default `"/"`. */
  base?: string;
  /**
   * Cache stat results per decoded pathname (bounded to 10,000). Default `true`.
   * Safe for `dist/server.js` and compiled binaries, whose `outDir` never
   * changes while serving; set `false` for a directory that does (`preview`).
   */
  cache?: boolean;
  /** Root-relative paths that are never served, compared case-insensitively (some filesystems are). */
  exclude?: readonly string[];
}

type EncodingName = "zstd" | "br" | "gzip";

const ENCODING_PREFERENCE: Array<{ name: EncodingName; ext: string }> = [
  { name: "zstd", ext: ".zst" },
  { name: "br", ext: ".br" },
  { name: "gzip", ext: ".gz" },
];

const EMPTY_SET: ReadonlySet<string> = new Set();
const ACCEPT_ENCODING_CACHE_LIMIT = 64;
const acceptEncodingCache = new Map<string, ReadonlySet<string>>();

const Q_ZERO = /;\s*q=0(?:\.0*)?\s*$/i;

/** Memoized by raw header string — browsers send a handful of distinct values. */
function acceptedEncodings(header: string | null): ReadonlySet<string> {
  if (!header) return EMPTY_SET;
  let accepted = acceptEncodingCache.get(header);
  if (!accepted) {
    accepted = new Set(
      header
        .split(",")
        .filter((part) => !Q_ZERO.test(part))
        .map((part) => part.split(";")[0]!.trim().toLowerCase()),
    );
    if (acceptEncodingCache.size >= ACCEPT_ENCODING_CACHE_LIMIT) {
      acceptEncodingCache.clear();
    }
    acceptEncodingCache.set(header, accepted);
  }
  return accepted;
}

/** RFC 9110 weak comparison of `If-None-Match` (`*`, comma list, `W/` prefixes) against our weak ETag. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const bare = etag.replace(/^W\//, "");
  return header
    .split(",")
    .some((candidate) => candidate.trim().replace(/^W\//, "") === bare);
}

interface EncodingVariant {
  file: ReturnType<typeof Bun.file>;
  size: number;
}

interface Entry {
  file: ReturnType<typeof Bun.file>;
  size: number;
  etag: string;
  type: string;
  immutable: boolean;
  variants: Partial<Record<EncodingName, EncodingVariant>>;
}

interface ResolveContext {
  outDir: string;
  excluded: ReadonlySet<string>;
  spa: boolean;
  immutablePrefix: string | undefined;
  precompressed: boolean;
}

const RESOLVE_CACHE_LIMIT = 10_000;

/** In order: the path, `<path>.html` (extensionless last segment), `<path>/index.html`, then (spa) `index.html`. */
function candidatePaths(
  outDir: string,
  safePath: string,
  spa: boolean,
): string[] {
  const filePath = join(outDir, safePath || "index.html");
  const last = safePath.split("/").pop() ?? "";
  const candidates = [filePath];
  if (last && !last.includes(".")) candidates.push(`${filePath}.html`);
  candidates.push(join(filePath, "index.html"));
  // A missing asset (`/assets/x.js`) is a 404, not the app shell.
  if (spa && !last.includes(".")) candidates.push(join(outDir, "index.html"));
  return candidates;
}

function findFile(
  outDir: string,
  safePath: string,
  spa: boolean,
): { filePath: string; stat: Stats } | null {
  for (const candidate of candidatePaths(outDir, safePath, spa)) {
    const stat = statSync(candidate, { throwIfNoEntry: false });
    if (stat?.isFile()) return { filePath: candidate, stat };
  }
  return null;
}

function resolveVariants(
  filePath: string,
  precompressed: boolean,
): Partial<Record<EncodingName, EncodingVariant>> {
  if (!precompressed) return {};
  const variants: Partial<Record<EncodingName, EncodingVariant>> = {};
  for (const { name, ext } of ENCODING_PREFERENCE) {
    const variantPath = `${filePath}${ext}`;
    const stat = statSync(variantPath, { throwIfNoEntry: false });
    if (stat?.isFile()) {
      variants[name] = { file: Bun.file(variantPath), size: stat.size };
    }
  }
  return variants;
}

/** Does all filesystem probing for a decoded pathname once, so the result can be cached. */
function resolveEntry(
  { outDir, excluded, spa, immutablePrefix, precompressed }: ResolveContext,
  decoded: string,
): Entry | null {
  if (decoded.includes("\0")) return null;
  const safePath = decoded.replace(/^\/+|\/+$/g, "");
  // `\` separates segments on Windows, so `..\..\x` is a traversal there.
  if (safePath.split(/[\\/]/).some((segment) => segment === "..")) return null;

  if (excluded.has(safePath.toLowerCase())) return null;

  const found = findFile(outDir, safePath, spa);
  if (!found) return null;
  const { filePath, stat } = found;

  const file = Bun.file(filePath);
  const isHtml = filePath.endsWith(".html");
  const immutable =
    !isHtml && !!immutablePrefix && decoded.startsWith(immutablePrefix);
  const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs).toString(16)}"`;

  return {
    file,
    size: stat.size,
    etag,
    type: file.type,
    immutable,
    variants: resolveVariants(filePath, precompressed),
  };
}

function buildResponse(
  entry: Entry,
  req: Request,
  precompressed: boolean,
): Response {
  const headers = new Headers();
  let status = 200;
  let body: ReturnType<typeof Bun.file> | null = entry.file;
  let size = entry.size;

  if (entry.immutable) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  } else {
    headers.set("cache-control", "no-cache");
    headers.set("etag", entry.etag);
    if (etagMatches(req.headers.get("if-none-match"), entry.etag)) {
      status = 304;
      body = null;
    }
  }

  // Also on the uncompressed and 304 responses, so a cache never serves one encoding for another.
  if (precompressed && Object.keys(entry.variants).length > 0) {
    headers.set("vary", "Accept-Encoding");
  }

  if (status === 200 && precompressed) {
    const accepted = acceptedEncodings(req.headers.get("accept-encoding"));
    for (const { name } of ENCODING_PREFERENCE) {
      if (!accepted.has(name)) continue;
      const variant = entry.variants[name];
      if (!variant) continue;
      headers.set("content-encoding", name);
      if (entry.type) headers.set("content-type", entry.type);
      body = variant.file;
      size = variant.size;
      break;
    }
  }

  if (status === 200 && body) headers.set("content-length", String(size));
  if (req.method === "HEAD") body = null;

  return new Response(body, { status, headers });
}

/**
 * Preview / `--compile` catch-all for built files, directory
 * `index.html`, and the SPA fallback. Serves precompressed siblings,
 * conditional GETs (weak ETag), and immutable caching under `immutablePrefix`.
 *
 * @example
 * ```ts
 * Bun.serve({
 *   routes: { "/*": createStaticHandler({ outDir: "dist", spa: true }) },
 * });
 * ```
 */
export function createStaticHandler(
  opts: StaticHandlerOptions,
): (req: Request) => Response {
  const {
    outDir,
    spa,
    immutablePrefix,
    precompressed = true,
    base = "/",
    cache: cacheEnabled = true,
    exclude = [],
  } = opts;
  const context: ResolveContext = {
    outDir,
    excluded: new Set(exclude.map((path) => path.toLowerCase())),
    spa,
    immutablePrefix,
    precompressed,
  };
  const basePrefix = base.endsWith("/") ? base : `${base}/`;
  const stripBase = basePrefix.startsWith("/") && basePrefix !== "/";
  const resolveCache = cacheEnabled
    ? new Map<string, Entry | null>()
    : undefined;

  function lookup(decoded: string): Entry | null {
    if (!resolveCache) return resolveEntry(context, decoded);
    let entry = resolveCache.get(decoded);
    if (entry === undefined) {
      entry = resolveEntry(context, decoded);
      if (resolveCache.size >= RESOLVE_CACHE_LIMIT) resolveCache.clear();
      resolveCache.set(decoded, entry);
    }
    return entry;
  }

  return (req: Request) => {
    const pathname = new URL(req.url).pathname;

    let decoded: string;
    try {
      decoded = pathname.includes("%")
        ? decodeURIComponent(pathname)
        : pathname;
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    if (stripBase) {
      if (decoded.startsWith(basePrefix)) {
        decoded = decoded.slice(basePrefix.length - 1);
      } else if (decoded === basePrefix.slice(0, -1)) {
        decoded = "/";
      }
    }

    const entry = lookup(decoded);
    if (!entry) {
      return new Response(req.method === "HEAD" ? null : "Not Found", {
        status: 404,
      });
    }
    return buildResponse(entry, req, precompressed);
  };
}
