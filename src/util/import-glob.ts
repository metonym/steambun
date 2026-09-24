import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BunPlugin } from "../config/types";

// Bun has no bundle-time `import.meta.glob` (Bun 1.4.2 leaves the call in
// place and it throws at runtime), so steambun expands it as an onLoad
// transform: each call becomes an object literal of lazy `import()`s, or of
// namespace bindings from imports appended to the end of the file (ESM hoists
// them) when `eager: true`. The replacement keeps the call's line count so
// stack traces and sourcemaps still point at the right line.

const NEEDLE = "import.meta.glob";
const SOURCE_FILTER = /\.(ts|tsx|js|jsx|mts|mjs)$/;
const GLOB_CHARS = /[*?[\]{}]/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export interface ImportGlobContext {
  /** Absolute path of the file being transformed. */
  importer: string;
  root: string;
  /** Vite-shaped `resolve.alias`, as in `createAliasPlugin`. */
  alias?: Record<string, string>;
}

type Literal = string | boolean | Literal[] | { [key: string]: Literal };

interface GlobCall {
  start: number;
  end: number;
  patterns: string[];
  eager: boolean;
  importName?: string;
  query: string;
  exhaustive: boolean;
}

const OPTION_KEYS = new Set(["eager", "import", "query", "exhaustive"]);

function fail(importer: string, message: string): never {
  throw new Error(`[steambun] import.meta.glob in ${importer}: ${message}`);
}

/** Offsets of `import.meta.glob` in code — skipping comments, string
 * literals, and template-literal text, but not `${}` interpolations. Same
 * scanner-not-parser trade-off as the dev env plugin: a regex literal with
 * an unbalanced quote can misparse. */
function findCallSites(src: string): number[] {
  const hits: number[] = [];
  // Each code frame counts its open braces; a `}` at depth 0 closes the
  // `${` that opened it and resumes the enclosing template.
  const stack: Array<{ template: boolean; depth: number }> = [
    { template: false, depth: 0 },
  ];
  let i = 0;
  while (i < src.length) {
    const frame = stack[stack.length - 1]!;
    const c = src[i]!;
    if (frame.template) {
      if (c === "\\") i += 2;
      else if (c === "`") {
        stack.pop();
        i += 1;
      } else if (c === "$" && src[i + 1] === "{") {
        stack.push({ template: false, depth: 0 });
        i += 2;
      } else i += 1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const j = src.indexOf("\n", i);
      i = j === -1 ? src.length : j;
    } else if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      i = j === -1 ? src.length : j + 2;
    } else if (c === '"' || c === "'") {
      i = skipString(src, i);
    } else if (c === "`") {
      stack.push({ template: true, depth: 0 });
      i += 1;
    } else if (c === "{") {
      frame.depth += 1;
      i += 1;
    } else if (c === "}") {
      if (frame.depth === 0 && stack.length > 1) stack.pop();
      else frame.depth -= 1;
      i += 1;
    } else if (
      c === "i" &&
      src.startsWith(NEEDLE, i) &&
      !/[\w$.]/.test(src[i - 1] ?? "") &&
      !/[\w$]/.test(src[i + NEEDLE.length] ?? "")
    ) {
      hits.push(i);
      i += NEEDLE.length;
    } else {
      i += 1;
    }
  }
  return hits;
}

function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === quote) return i + 1;
    else i += 1;
  }
  return i;
}

/** Recursive-descent reader for the literal arguments Vite also requires. */
class ArgReader {
  constructor(
    private readonly src: string,
    public pos: number,
    private readonly importer: string,
  ) {}

  skipTrivia(): void {
    for (;;) {
      while (/\s/.test(this.src[this.pos] ?? "")) this.pos += 1;
      if (this.src.startsWith("//", this.pos)) {
        const j = this.src.indexOf("\n", this.pos);
        this.pos = j === -1 ? this.src.length : j;
      } else if (this.src.startsWith("/*", this.pos)) {
        const j = this.src.indexOf("*/", this.pos + 2);
        this.pos = j === -1 ? this.src.length : j + 2;
      } else return;
    }
  }

  peek(): string | undefined {
    this.skipTrivia();
    return this.src[this.pos];
  }

  expect(char: string): void {
    if (this.peek() !== char) {
      fail(
        this.importer,
        `expected "${char}" at offset ${this.pos}, found ${JSON.stringify(this.src[this.pos] ?? "end of file")}`,
      );
    }
    this.pos += 1;
  }

  /** Skips a TS type-argument list (`import.meta.glob<Module>(...)`),
   * treating `=>` as an arrow rather than a closing `>`. */
  skipTypeArguments(): void {
    if (this.peek() !== "<") return;
    let depth = 0;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === "<") depth += 1;
      else if (c === ">" && this.src[this.pos - 1] !== "=") {
        depth -= 1;
        if (depth === 0) {
          this.pos += 1;
          return;
        }
      }
      this.pos += 1;
    }
  }

  value(): Literal {
    const c = this.peek();
    if (c === '"' || c === "'") {
      const end = skipString(this.src, this.pos);
      const raw = this.src.slice(this.pos + 1, end - 1);
      this.pos = end;
      return raw.replace(/\\(.)/g, "$1");
    }
    if (c === "`") {
      const end = this.src.indexOf("`", this.pos + 1);
      const raw = this.src.slice(this.pos + 1, end);
      if (end === -1 || raw.includes("${")) {
        fail(
          this.importer,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: names the literal ${} syntax in the message
          "template literals can't contain ${} expressions",
        );
      }
      this.pos = end + 1;
      return raw;
    }
    if (c === "[") return this.array();
    if (c === "{") return this.object();
    for (const word of ["true", "false"] as const) {
      if (
        this.src.startsWith(word, this.pos) &&
        !/[\w$]/.test(this.src[this.pos + word.length] ?? "")
      ) {
        this.pos += word.length;
        return word === "true";
      }
    }
    return fail(
      this.importer,
      `arguments must be literals (strings, arrays, and a plain options object) — found ${JSON.stringify(this.src.slice(this.pos, this.pos + 20))}`,
    );
  }

  private array(): Literal[] {
    this.expect("[");
    const items: Literal[] = [];
    while (this.peek() !== "]") {
      items.push(this.value());
      if (this.peek() === ",") this.pos += 1;
      else break;
    }
    this.expect("]");
    return items;
  }

  private object(): { [key: string]: Literal } {
    this.expect("{");
    const out: { [key: string]: Literal } = {};
    while (this.peek() !== "}") {
      const c = this.peek();
      let key: string;
      if (c === '"' || c === "'") key = this.value() as string;
      else {
        const match = /^[A-Za-z_$][\w$]*/.exec(this.src.slice(this.pos));
        if (!match) fail(this.importer, "expected an options object key");
        key = match[0];
        this.pos += key.length;
      }
      this.expect(":");
      out[key] = this.value();
      if (this.peek() === ",") this.pos += 1;
      else break;
    }
    this.expect("}");
    return out;
  }
}

function parseCall(src: string, start: number, importer: string): GlobCall {
  const reader = new ArgReader(src, start + NEEDLE.length, importer);
  reader.skipTypeArguments();
  reader.expect("(");
  const first = reader.value();
  const patterns = typeof first === "string" ? [first] : first;
  if (
    !Array.isArray(patterns) ||
    patterns.length === 0 ||
    !patterns.every((p) => typeof p === "string")
  ) {
    fail(importer, "the first argument must be a string or array of strings");
  }
  let options: { [key: string]: Literal } = {};
  if (reader.peek() === ",") {
    reader.pos += 1;
    if (reader.peek() !== ")") {
      const value = reader.value();
      if (typeof value !== "object" || Array.isArray(value)) {
        fail(importer, "the second argument must be an options object");
      }
      options = value;
      if (reader.peek() === ",") reader.pos += 1;
    }
  }
  reader.expect(")");

  for (const key of Object.keys(options)) {
    if (key === "as") {
      fail(
        importer,
        '`as` was removed in Vite 5 — use `query: "?raw"` (or "?url") with `import: "default"`',
      );
    }
    if (!OPTION_KEYS.has(key)) fail(importer, `unsupported option "${key}"`);
  }
  const { eager = false, import: importName, exhaustive = false } = options;
  if (typeof eager !== "boolean" || typeof exhaustive !== "boolean") {
    fail(importer, "`eager` and `exhaustive` must be booleans");
  }
  if (importName !== undefined && typeof importName !== "string") {
    fail(importer, "`import` must be a string");
  }
  return {
    start,
    end: reader.pos,
    patterns: patterns as string[],
    eager,
    importName: importName === "*" ? undefined : importName,
    query: toQuery(options.query, importer),
    exhaustive,
  };
}

function toQuery(query: Literal | undefined, importer: string): string {
  if (query === undefined) return "";
  if (typeof query === "string") {
    if (query === "") return "";
    return query.startsWith("?") ? query : `?${query}`;
  }
  if (typeof query !== "object" || Array.isArray(query)) {
    return fail(importer, "`query` must be a string or a flat object");
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "object") {
      fail(importer, "`query` object values must be strings or booleans");
    }
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function relativeSpecifier(fromDir: string, file: string): string {
  const rel = toPosix(relative(fromDir, file));
  return rel.startsWith("../") ? rel : `./${rel}`;
}

type ResolvedPattern =
  | {
      negative: boolean;
      /** Absolute pattern: a literal base directory followed by glob segments. */
      absolute: string;
      /** Vite keys relative patterns by their importer-relative path, and
       * `/`-rooted or aliased patterns by their root-relative path. */
      rootKeys: boolean;
    }
  | {
      negative: true;
      /** A bare exclusion like `!**\/*.test.ts`, matched against each
       * file's importer-relative path (fast-glob's `ignore`, as in Vite). */
      bare: InstanceType<typeof Bun.Glob>;
    };

function resolvePattern(
  pattern: string,
  ctx: ImportGlobContext,
  aliases: Array<readonly [string, string]>,
): ResolvedPattern {
  const negative = pattern.startsWith("!");
  const body = negative ? pattern.slice(1) : pattern;
  if (body.startsWith("./") || body.startsWith("../")) {
    return {
      negative,
      absolute: resolve(dirname(ctx.importer), body),
      rootKeys: false,
    };
  }
  if (body.startsWith("/")) {
    return { negative, absolute: join(ctx.root, body), rootKeys: true };
  }
  for (const [from, to] of aliases) {
    const prefix = from.endsWith("/") ? from : `${from}/`;
    if (body.startsWith(prefix)) {
      return {
        negative,
        absolute: join(to, body.slice(prefix.length)),
        rootKeys: true,
      };
    }
  }
  if (negative) return { negative, bare: new Bun.Glob(body) };
  return fail(
    ctx.importer,
    `pattern "${pattern}" must start with "./", "../", "/", or a resolve.alias key`,
  );
}

function expand(pattern: { absolute: string }, exhaustive: boolean): string[] {
  const segments = toPosix(pattern.absolute).split("/");
  const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
  if (firstGlob === -1) {
    return existsSync(pattern.absolute) ? [pattern.absolute] : [];
  }
  const base = segments.slice(0, firstGlob).join("/") || "/";
  const rest = segments.slice(firstGlob).join("/");
  if (!existsSync(base)) return [];
  const skipNodeModules = !exhaustive && !rest.includes("node_modules");
  const files: string[] = [];
  for (const match of new Bun.Glob(rest).scanSync({
    cwd: base,
    onlyFiles: true,
    dot: exhaustive,
  })) {
    if (skipNodeModules && toPosix(match).split("/").includes("node_modules"))
      continue;
    files.push(join(base, match));
  }
  return files;
}

function generate(
  call: GlobCall,
  callIndex: number,
  ctx: ImportGlobContext,
  aliases: Array<readonly [string, string]>,
  hoisted: string[],
): string {
  const resolved = call.patterns.map((p) => resolvePattern(p, ctx, aliases));
  const included = new Map<string, boolean>();
  const excluded = new Set<string>();
  const bareExclusions: Array<InstanceType<typeof Bun.Glob>> = [];
  for (const pattern of resolved) {
    if ("bare" in pattern) {
      bareExclusions.push(pattern.bare);
      continue;
    }
    for (const file of expand(pattern, call.exhaustive)) {
      if (pattern.negative) excluded.add(file);
      else if (!included.has(file)) included.set(file, pattern.rootKeys);
    }
  }
  const importerDir = dirname(ctx.importer);
  const entries = [...included]
    .filter(
      ([file]) =>
        !excluded.has(file) &&
        file !== ctx.importer &&
        !bareExclusions.some((glob) =>
          glob.match(toPosix(relative(importerDir, file))),
        ),
    )
    .map(([file, rootKeys]) => {
      const specifier = relativeSpecifier(importerDir, file) + call.query;
      const rootRel = toPosix(relative(ctx.root, file));
      const key =
        rootKeys && !rootRel.startsWith("../") && !isAbsolute(rootRel)
          ? `/${rootRel}`
          : relativeSpecifier(importerDir, file);
      return { key, specifier };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const props = entries.map(({ key, specifier }, i) => {
    const spec = JSON.stringify(specifier);
    if (call.eager) {
      const local = `__steambun_glob_${callIndex}_${i}`;
      const name = call.importName;
      hoisted.push(
        name === undefined
          ? `import * as ${local} from ${spec};`
          : `import { ${IDENTIFIER.test(name) ? name : JSON.stringify(name)} as ${local} } from ${spec};`,
      );
      return `${JSON.stringify(key)}: ${local}`;
    }
    const pick =
      call.importName === undefined
        ? ""
        : `.then((m) => m[${JSON.stringify(call.importName)}])`;
    return `${JSON.stringify(key)}: () => import(${spec})${pick}`;
  });
  return `({${props.join(", ")}})`;
}

/**
 * Expands every `import.meta.glob(...)` call in `source`. Returns
 * `undefined` when the file has none, so an onLoad hook can fall through.
 *
 * @example
 * ```ts
 * import { transformImportGlobs } from "steambun/runtime";
 *
 * const out = transformImportGlobs(
 *   'const pages = import.meta.glob("./pages/*.ts");',
 *   { importer: "/app/src/main.ts", root: "/app" },
 * );
 * ```
 */
export function transformImportGlobs(
  source: string,
  ctx: ImportGlobContext,
): string | undefined {
  if (!source.includes(NEEDLE)) return undefined;
  const sites = findCallSites(source);
  if (sites.length === 0) return undefined;

  const aliases = Object.entries(ctx.alias ?? {})
    .map(
      ([from, to]) => [from, isAbsolute(to) ? to : join(ctx.root, to)] as const,
    )
    .sort((a, b) => b[0].length - a[0].length);
  const hoisted: string[] = [];
  let output = "";
  let cursor = 0;
  sites.forEach((site, index) => {
    const call = parseCall(source, site, ctx.importer);
    const original = source.slice(call.start, call.end);
    const newlines = original.split("\n").length - 1;
    output += source.slice(cursor, call.start);
    output += generate(call, index, ctx, aliases, hoisted);
    output += "\n".repeat(newlines);
    cursor = call.end;
  });
  output += source.slice(cursor);
  if (hoisted.length > 0) output += `\n${hoisted.join("\n")}\n`;
  return output;
}

function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts") || path.endsWith(".mts")) return "ts";
  if (path.endsWith(".jsx")) return "jsx";
  return "js";
}

/**
 * Vite's `import.meta.glob` as a Bun `onLoad` plugin for client bundles.
 * `steambun build` adds it automatically; `steambun dev` folds the same
 * transform into its env plugin, since Bun runs only the first `onLoad`
 * that returns contents for a file.
 */
export function createImportGlobPlugin(
  root: string,
  alias?: Record<string, string>,
): BunPlugin {
  return {
    name: "steambun-import-glob",
    setup(build) {
      build.onLoad({ filter: SOURCE_FILTER }, async (args) => {
        if (args.path.includes("/node_modules/")) return undefined;
        const source = await Bun.file(args.path).text();
        const contents = transformImportGlobs(source, {
          importer: args.path,
          root,
          alias,
        });
        if (contents === undefined) return undefined;
        return { contents, loader: loaderFor(args.path) };
      });
    },
  };
}
