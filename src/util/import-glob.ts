import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BunPlugin } from "../config/types";

// Bun has no bundle-time `import.meta.glob` (Bun 1.4.2 leaves the call in
// place and it throws at runtime), so steambun expands it as an onLoad
// transform: each call becomes an object literal of lazy `import()`s, or of
// namespace bindings from imports appended to the end of the file (ESM hoists
// them) when `eager: true`. The replacement keeps the call's line count so
// stack traces and sourcemaps still point at the right line.

const NEEDLE = "import.meta.glob";
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

// Character codes that can change the scanner's state. The scanner skips
// everything else in a tight charCodeAt loop, which JITs far better than
// stepping through each character's branches (or a regex exec per token).
const SLASH = 47;
const DQUOTE = 34;
const SQUOTE = 39;
const BACKTICK = 96;
const LBRACE = 123;
const RBRACE = 125;
const BACKSLASH = 92;
const DOLLAR = 36;
const table = (...codes: number[]) => {
  const t = new Uint8Array(128);
  for (const code of codes) t[code] = 1;
  return t;
};
// Brace depth only matters inside a template's `${}`, so top-level code
// skips braces entirely.
const TOP_LEVEL = table(SLASH, DQUOTE, SQUOTE, BACKTICK);
const NESTED = table(SLASH, DQUOTE, SQUOTE, BACKTICK, LBRACE, RBRACE);
const TEMPLATE = table(BACKSLASH, BACKTICK, DOLLAR);
const IN_TEMPLATE = -1;

/** Offsets of `import.meta.glob` in code — skipping comments, string
 * literals, and template-literal text, but not `${}` interpolations. Same
 * scanner-not-parser trade-off as the dev env plugin: a regex literal with
 * an unbalanced quote can misparse. */
function findCallSites(src: string): number[] {
  const hits: number[] = [];
  // One entry per nesting level: IN_TEMPLATE for template text, else the
  // code's open-brace depth. A `}` at depth 0 closes the `${` that opened
  // it and resumes the enclosing template.
  const stack: number[] = [0];
  // Needle positions come from indexOf; the scan only has to decide whether
  // each one sits in code. Nothing after the last one can be a call site.
  let needle = src.indexOf(NEEDLE);
  let i = 0;
  while (needle !== -1) {
    const top = stack.length - 1;
    const inTemplate = stack[top] === IN_TEMPLATE;
    const interesting = inTemplate ? TEMPLATE : top === 0 ? TOP_LEVEL : NESTED;
    let c = src.charCodeAt(i);
    while (i < needle && (c >= 128 || interesting[c] === 0)) {
      c = src.charCodeAt(++i);
    }
    if (i >= needle) {
      // Reached the needle in the current state: a call site if in code
      // at an identifier boundary, template text otherwise.
      i = needle;
      if (
        !inTemplate &&
        !/[\w$.]/.test(src[i - 1] ?? "") &&
        !/[\w$]/.test(src[i + NEEDLE.length] ?? "")
      ) {
        hits.push(i);
      }
      i += NEEDLE.length;
      needle = src.indexOf(NEEDLE, i);
      continue;
    }
    if (inTemplate) {
      if (c === BACKSLASH) i += 2;
      else if (c === BACKTICK) {
        stack.pop();
        i += 1;
      } else if (src.charCodeAt(i + 1) === LBRACE) {
        stack.push(0);
        i += 2;
      } else i += 1;
      continue;
    }
    const next = src.charCodeAt(i + 1);
    if (c === SLASH && next === SLASH) {
      const j = src.indexOf("\n", i);
      i = j === -1 ? src.length : j;
    } else if (c === SLASH && next === 42 /* * */) {
      const j = src.indexOf("*/", i + 2);
      i = j === -1 ? src.length : j + 2;
    } else if (c === DQUOTE || c === SQUOTE) {
      i = skipString(src, i);
    } else if (c === BACKTICK) {
      stack.push(IN_TEMPLATE);
      i += 1;
    } else if (c === LBRACE) {
      stack[top]! += 1;
      i += 1;
    } else if (c === RBRACE) {
      if (stack[top] === 0 && top > 0) stack.pop();
      else stack[top]! -= 1;
      i += 1;
    } else {
      i += 1;
    }
    // A comment or string just skipped may have swallowed the needle.
    if (needle < i) needle = src.indexOf(NEEDLE, i);
  }
  return hits;
}

/** End of the string literal opening at `start`: the next matching quote
 * not escaped by an odd run of backslashes (or end of file). */
function skipString(src: string, start: number): number {
  const quote = src[start]!;
  let from = start + 1;
  for (;;) {
    const end = src.indexOf(quote, from);
    if (end === -1) return src.length;
    let backslashes = 0;
    for (let k = end - 1; k > start && src[k] === "\\"; k--) backslashes++;
    if (backslashes % 2 === 0) return end + 1;
    from = end + 1;
  }
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

interface Match {
  file: string;
  /** POSIX path relative to the importer's directory. */
  fromImporter: string;
  /** POSIX path relative to the project root. */
  fromRoot: string;
}

/** Every match sits under one base directory, so its relative paths are
 * that base's (computed once) plus the match — not two `path.relative()`
 * calls per file. */
function expand(
  pattern: { absolute: string },
  exhaustive: boolean,
  importerDir: string,
  root: string,
): Match[] {
  const segments = toPosix(pattern.absolute).split("/");
  const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
  if (firstGlob === -1) {
    if (!existsSync(pattern.absolute)) return [];
    const file = pattern.absolute;
    return [
      {
        file,
        fromImporter: toPosix(relative(importerDir, file)),
        fromRoot: toPosix(relative(root, file)),
      },
    ];
  }
  const base = segments.slice(0, firstGlob).join("/") || "/";
  const rest = segments.slice(firstGlob).join("/");
  if (!existsSync(base)) return [];
  const under = (dir: string) => {
    const rel = toPosix(relative(dir, base));
    return rel === "" ? "" : `${rel}/`;
  };
  const importerPrefix = under(importerDir);
  const rootPrefix = under(root);
  const skipNodeModules = !exhaustive && !rest.includes("node_modules");
  const matches: Match[] = [];
  for (const raw of new Bun.Glob(rest).scanSync({
    cwd: base,
    onlyFiles: true,
    dot: exhaustive,
  })) {
    const match = toPosix(raw);
    if (
      skipNodeModules &&
      (match.startsWith("node_modules/") || match.includes("/node_modules/"))
    ) {
      continue;
    }
    matches.push({
      file: join(base, match),
      fromImporter: importerPrefix + match,
      fromRoot: rootPrefix + match,
    });
  }
  return matches;
}

function generate(
  call: GlobCall,
  callIndex: number,
  ctx: ImportGlobContext,
  aliases: Array<readonly [string, string]>,
  hoisted: string[],
): string {
  const resolved = call.patterns.map((p) => resolvePattern(p, ctx, aliases));
  const importerDir = dirname(ctx.importer);
  const included = new Map<string, { match: Match; rootKeys: boolean }>();
  const excluded = new Set<string>();
  const bareExclusions: Array<InstanceType<typeof Bun.Glob>> = [];
  for (const pattern of resolved) {
    if ("bare" in pattern) {
      bareExclusions.push(pattern.bare);
      continue;
    }
    for (const match of expand(
      pattern,
      call.exhaustive,
      importerDir,
      ctx.root,
    )) {
      if (pattern.negative) excluded.add(match.file);
      else if (!included.has(match.file)) {
        included.set(match.file, { match, rootKeys: pattern.rootKeys });
      }
    }
  }
  const entries = [...included.values()]
    .filter(
      ({ match }) =>
        !excluded.has(match.file) &&
        match.file !== ctx.importer &&
        !bareExclusions.some((glob) => glob.match(match.fromImporter)),
    )
    .map(({ match, rootKeys }) => {
      const relativeKey = match.fromImporter.startsWith("../")
        ? match.fromImporter
        : `./${match.fromImporter}`;
      const key =
        rootKeys &&
        !match.fromRoot.startsWith("../") &&
        !isAbsolute(match.fromRoot)
          ? `/${match.fromRoot}`
          : relativeKey;
      return { key, specifier: relativeKey + call.query };
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

// Bun's default loader for .js parses JSX; an explicit "js" loader doesn't.
function loaderFor(path: string): "ts" | "tsx" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts") || path.endsWith(".mts")) return "ts";
  return "jsx";
}

// Project sources only: node_modules never reaches the JS callback.
const PROJECT_SOURCE_FILTER =
  /^(?!.*[\\/]node_modules[\\/]).*\.(ts|tsx|js|jsx|mts|mjs)$/;

/**
 * Vite's `import.meta.glob` as a Bun `onLoad` plugin for client bundles.
 * `steambun build` adds it automatically; `steambun dev` folds the same
 * transform into its env plugin, since Bun runs only the first `onLoad`
 * that returns contents for a file.
 *
 * It returns every file's contents, transformed or not: falling through
 * with `undefined` makes Bun redo the load, which measured ~4× the cost of
 * handing back the source it already has (400-module build: +16ms vs
 * +3.5ms). Since that claims every project source file, it must come after
 * any other `onLoad` plugin.
 */
export function createImportGlobPlugin(
  root: string,
  alias?: Record<string, string>,
): BunPlugin {
  return {
    name: "steambun-import-glob",
    setup(build) {
      build.onLoad({ filter: PROJECT_SOURCE_FILTER }, (args) => {
        const source = readFileSync(args.path, "utf8");
        const contents = transformImportGlobs(source, {
          importer: args.path,
          root,
          alias,
        });
        return { contents: contents ?? source, loader: loaderFor(args.path) };
      });
    },
  };
}
