import { readFileSync, type Stats, statSync } from "node:fs";
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
  /**
   * Cache resolved paths (file, stat-derived etag/size, precompressed
   * variants, matched `_headers.json` rules) per decoded pathname, bounded
   * to 10,000 entries. Default `true`.
   *
   * Safe because `outDir` is immutable for the entire lifetime of the
   * process that serves it: `steambun preview`, the generated
   * `dist/server.js`, and a `--compile`d binary all serve a build that was
   * produced once and never changes underneath the running server (a
   * rebuild restarts the process). `steambun dev` never calls
   * `createStaticHandler` at all. Set `cache: false` only if you are
   * calling this handler yourself against a directory that can change
   * while the process is alive.
   */
  cache?: boolean;
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

type EncodingName = "zstd" | "br" | "gzip";

const ENCODING_PREFERENCE: Array<{ name: EncodingName; ext: string }> = [
  { name: "zstd", ext: ".zst" },
  { name: "br", ext: ".br" },
  { name: "gzip", ext: ".gz" },
];

const EMPTY_SET: ReadonlySet<string> = new Set();
const ACCEPT_ENCODING_CACHE_LIMIT = 64;
const acceptEncodingCache = new Map<string, ReadonlySet<string>>();

/** Memoized by raw header string — browsers send a handful of distinct values. */
function acceptedEncodings(header: string | null): ReadonlySet<string> {
  if (!header) return EMPTY_SET;
  let accepted = acceptEncodingCache.get(header);
  if (!accepted) {
    accepted = new Set(
      header.split(",").map((part) => part.split(";")[0]!.trim().toLowerCase()),
    );
    if (acceptEncodingCache.size >= ACCEPT_ENCODING_CACHE_LIMIT) {
      acceptEncodingCache.clear();
    }
    acceptEncodingCache.set(header, accepted);
  }
  return accepted;
}

/** Server-side build inputs, never served even though they live in outDir. */
const DENIED_METADATA_FILES = new Set([
  "_headers.json",
  ".steambun-chunks.json",
]);

interface EncodingVariant {
  file: ReturnType<typeof Bun.file>;
  size: number;
}

interface Entry {
  filePath: string;
  file: ReturnType<typeof Bun.file>;
  size: number;
  etag: string;
  type: string;
  immutable: boolean;
  variants: Partial<Record<EncodingName, EncodingVariant>>;
  extraHeaders: [string, string][];
}

const RESOLVE_CACHE_LIMIT = 10_000;

/**
 * Candidate file paths for `safePath`, in resolution order: the exact path,
 * then `<path>.html` (when the last segment has no extension), then
 * `<path>/index.html`, then (spa only) `outDir/index.html`. Checking
 * `<path>/index.html` directly makes a separate `isDirectory()` probe on
 * `<path>` redundant — if that candidate is a file, `<path>` was a
 * directory.
 */
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
  if (spa) candidates.push(join(outDir, "index.html"));
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

function resolveExtraHeaders(
  outDir: string,
  filePath: string,
  headersRules: HeadersRule[],
): [string, string][] {
  if (headersRules.length === 0) return [];
  const matchPath = `/${relative(outDir, filePath).split(sep).join("/")}`;
  const extraHeaders: [string, string][] = [];
  for (const rule of headersRules) {
    if (!rule.matcher.match(matchPath)) continue;
    for (const [key, value] of Object.entries(rule.headers)) {
      extraHeaders.push([key, value]);
    }
  }
  return extraHeaders;
}

/**
 * Resolves `decoded` (a decoded pathname) to a fully-populated `Entry`: the
 * `BunFile`, stat-derived etag/size, pre-stat'd precompressed siblings, and
 * pre-matched `_headers.json` rules. Runs the filesystem probes exactly
 * once per pathname; callers are expected to cache the result (see
 * `StaticHandlerOptions.cache`).
 */
function resolveEntry(
  outDir: string,
  decoded: string,
  spa: boolean,
  immutablePrefix: string | undefined,
  precompressed: boolean,
  headersRules: HeadersRule[],
): Entry | null {
  if (decoded.includes("\0")) return null;
  const safePath = decoded.replace(/^\/+|\/+$/g, "");
  if (safePath.split("/").some((segment) => segment === "..")) return null;
  if (DENIED_METADATA_FILES.has(safePath)) return null;

  const found = findFile(outDir, safePath, spa);
  if (!found) return null;
  const { filePath, stat } = found;

  const file = Bun.file(filePath);
  const isHtml = filePath.endsWith(".html");
  const immutable =
    !isHtml && !!immutablePrefix && decoded.startsWith(immutablePrefix);
  const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs).toString(16)}"`;

  return {
    filePath,
    file,
    size: stat.size,
    etag,
    type: file.type,
    immutable,
    variants: resolveVariants(filePath, precompressed),
    extraHeaders: resolveExtraHeaders(outDir, filePath, headersRules),
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
    if (req.headers.get("if-none-match") === entry.etag) {
      status = 304;
      body = null;
    }
  }

  if (status === 200 && precompressed) {
    const accepted = acceptedEncodings(req.headers.get("accept-encoding"));
    for (const { name } of ENCODING_PREFERENCE) {
      if (!accepted.has(name)) continue;
      const variant = entry.variants[name];
      if (!variant) continue;
      headers.set("content-encoding", name);
      headers.set("vary", "Accept-Encoding");
      if (entry.type) headers.set("content-type", entry.type);
      body = variant.file;
      size = variant.size;
      break;
    }
  }

  for (const [key, value] of entry.extraHeaders) headers.set(key, value);

  if (status === 200 && body) headers.set("content-length", String(size));
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
): (req: Request) => Response {
  const {
    outDir,
    spa,
    immutablePrefix,
    precompressed = true,
    base = "/",
    cache: cacheEnabled = true,
  } = opts;
  const headersRules = loadHeadersRules(opts.headersFile);
  const chunkMap =
    readJsonFile<Record<string, string>>(opts.chunkMapFile) ?? {};
  const chunkPattern = new RegExp(
    `^${escapeRegExp(base)}@chunk/([a-z0-9]+)\\.js$`,
  );
  const resolveCache: Map<string, Entry | null> | null = cacheEnabled
    ? new Map()
    : null;

  function lookup(decoded: string): Entry | null {
    if (!resolveCache) {
      return resolveEntry(
        outDir,
        decoded,
        spa,
        immutablePrefix,
        precompressed,
        headersRules,
      );
    }
    const cached = resolveCache.get(decoded);
    if (cached !== undefined) return cached;
    const entry = resolveEntry(
      outDir,
      decoded,
      spa,
      immutablePrefix,
      precompressed,
      headersRules,
    );
    if (resolveCache.size >= RESOLVE_CACHE_LIMIT) resolveCache.clear();
    resolveCache.set(decoded, entry);
    return entry;
  }

  return (req: Request) => {
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

    let decoded: string;
    try {
      decoded = pathname.includes("%")
        ? decodeURIComponent(pathname)
        : pathname;
    } catch {
      return new Response("Bad Request", { status: 400 });
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
