import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { BunPlugin } from "../config/types";
import { type AliasEntry, aliasEntries, matchAlias } from "./alias";
import { isIdentifier } from "./guards";
import { posixRelative, toPosix } from "./specifier";

// Bun 1.4.2 has no bundle-time `import.meta.glob` (the call throws at runtime), so it is expanded
// here. Eager imports are appended to the file (ESM hoists them); the replacement keeps the call's
// line count so stack traces and sourcemaps stay aligned.

const NEEDLE = "import.meta.glob";
// `!(`, `@(`, and `+(` open an extglob (Bun 1.4.4+); a bare `(` is literal, like a `(group)` directory.
const GLOB_CHARS = /[*?[\]{}]|[!@+]\(/;

export interface ImportGlobContext {
  /** Absolute path of the file being transformed. */
  importer: string;
  root: string;
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
}

const OPTION_KEYS = ["eager", "import", "query"];

function fail(importer: string, message: string): never {
  throw new Error(`[steambun] import.meta.glob in ${importer}: ${message}`);
}

// The scanner skips every other character in a tight charCodeAt loop, which JITs far better than a
// branch per character or a regex exec per token.
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
const TOP_LEVEL = table(SLASH, DQUOTE, SQUOTE, BACKTICK);
const NESTED = table(SLASH, DQUOTE, SQUOTE, BACKTICK, LBRACE, RBRACE);
const TEMPLATE = table(BACKSLASH, BACKTICK, DOLLAR);
const IN_TEMPLATE = -1;

// A scanner, not a parser: regex literals are recognized heuristically (by the preceding token), and
// a string or regex that is unterminated ends at its line so a stray quote can't swallow later code.
/** Offsets of `import.meta.glob` in code, skipping comments, strings, and template text. */
function findCallSites(src: string): number[] {
  const hits: number[] = [];
  // Per nesting level: IN_TEMPLATE, or the open-brace depth of code (a `}` at 0 closes its `${`).
  const stack: number[] = [0];
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
    } else if (c === SLASH) {
      i = startsRegex(src, i) ? skipRegex(src, i) : i + 1;
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
    // The skipped comment or string may have swallowed the needle.
    if (needle < i) needle = src.indexOf(NEEDLE, i);
  }
  return hits;
}

/** End offset of the string starting at `start`; an unterminated one ends at its line, as in JS. */
function skipString(src: string, start: number): number {
  const quote = src.charCodeAt(start);
  let i = start + 1;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === quote) return i + 1;
    if (c === BACKSLASH) {
      i += src.startsWith("\r\n", i + 1) ? 3 : 2;
    } else if (c === 10 || c === 13) {
      return i;
    } else i += 1;
  }
  return src.length;
}

// `<` and `>` are left out so JSX closing tags (`</div>`) aren't read as regexes; `=>` is handled below.
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%~^";
const REGEX_KEYWORDS =
  /(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|void|delete|throw|new|instanceof|yield|await)$/;

/** Whether a `/` at `index` starts a regex literal rather than dividing, judged by what precedes it. */
function startsRegex(src: string, index: number): boolean {
  let j = index - 1;
  while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--;
  if (j < 0) return true;
  const prev = src[j]!;
  if (
    prev === "\n" ||
    prev === "\r" ||
    REGEX_PRECEDERS.includes(prev) ||
    (prev === ">" && src[j - 1] === "=")
  ) {
    return true;
  }
  return (
    /[\w$]/.test(prev) &&
    REGEX_KEYWORDS.test(src.slice(Math.max(0, j - 10), j + 1))
  );
}

/** End offset of the regex literal at `start` (its closing `/`, or the end of the line if unterminated). */
function skipRegex(src: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\n" || c === "\r") return i;
    if (c === "\\") i += 1;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
  }
  return src.length;
}

/** The value of a JS string literal's body, following JS escape rules. */
function unescapeString(raw: string): string {
  if (!raw.includes("\\")) return raw;
  return raw.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r\n|([\s\S]))/g,
    (_, codePoint, unit, hex, other) => {
      const code = codePoint ?? unit ?? hex;
      if (code !== undefined)
        return String.fromCodePoint(Number.parseInt(code, 16));
      switch (other) {
        case undefined:
        case "\n":
        case "\r":
        case "\u2028":
        case "\u2029":
          return "";
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "b":
          return "\b";
        case "f":
          return "\f";
        case "v":
          return "\v";
        case "0":
          return "\0";
        default:
          return other;
      }
    },
  );
}

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
      if (this.src[end - 1] !== c || end - 1 === this.pos) {
        fail(this.importer, "unterminated string literal");
      }
      const raw = this.src.slice(this.pos + 1, end - 1);
      this.pos = end;
      return unescapeString(raw);
    }
    if (c === "`") {
      let end = this.pos + 1;
      while (end < this.src.length && this.src[end] !== "`") {
        end += this.src[end] === "\\" ? 2 : 1;
      }
      const raw = this.src.slice(this.pos + 1, end);
      if (end >= this.src.length || /(?<!\\)(?:\\\\)*\$\{/.test(raw)) {
        fail(
          this.importer,
          // biome-ignore lint/suspicious/noTemplateCurlyInString: names the literal ${} syntax in the message
          "template literals can't contain ${} expressions",
        );
      }
      this.pos = end + 1;
      return unescapeString(raw);
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
    if (!OPTION_KEYS.includes(key)) {
      fail(
        importer,
        `unsupported option "${key}" (supported: ${OPTION_KEYS.join(", ")})`,
      );
    }
  }
  const { eager = false, import: importName, query } = options;
  if (typeof eager !== "boolean") fail(importer, "`eager` must be a boolean");
  if (importName !== undefined && typeof importName !== "string") {
    fail(importer, "`import` must be a string");
  }
  if (query !== undefined && typeof query !== "string") {
    fail(importer, "`query` must be a string");
  }
  return {
    start,
    end: reader.pos,
    patterns: patterns as string[],
    eager,
    importName: importName === "*" ? undefined : importName,
    query: query ? (query.startsWith("?") ? query : `?${query}`) : "",
  };
}

interface FilePattern {
  negative: boolean;
  /** Directory the pattern is anchored to; `tail` is the rest of the pattern. */
  dir: string;
  tail: string;
  /** Vite keys relative patterns by importer-relative path, `/`-rooted and aliased ones by root-relative path. */
  rootKeys: boolean;
}

/** A bare exclusion like `!**\/*.test.ts`, matched against importer-relative paths (fast-glob's `ignore`, as in Vite). */
interface BareExclusion {
  bare: InstanceType<typeof Bun.Glob>;
}

function resolvePattern(
  pattern: string,
  ctx: ImportGlobContext,
  aliases: readonly AliasEntry[],
  relativeDir: string,
): FilePattern | BareExclusion {
  const negative = pattern.startsWith("!");
  const body = negative ? pattern.slice(1) : pattern;
  if (body.startsWith("./") || body.startsWith("../")) {
    return { negative, dir: relativeDir, tail: body, rootKeys: false };
  }
  if (body.startsWith("/")) {
    return { negative, dir: ctx.root, tail: body.slice(1), rootKeys: true };
  }
  const alias = matchAlias(body, aliases);
  if (alias) {
    return { negative, dir: alias.to, tail: alias.rest, rootKeys: true };
  }
  if (negative) return { bare: new Bun.Glob(body) };
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

/** The pattern's literal leading directories, resolved, and the index of its first glob segment (-1 if none). */
function splitPattern(pattern: FilePattern) {
  // Split on the pattern, not the resolved path, so a directory named `[id]` isn't read as a glob.
  const segments = pattern.tail.split("/");
  const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
  const literal = firstGlob === -1 ? segments : segments.slice(0, firstGlob);
  return { segments, firstGlob, base: resolve(pattern.dir, ...literal) };
}

function expand(
  pattern: FilePattern,
  importerDir: string,
  root: string,
): Match[] {
  const { segments, firstGlob, base } = splitPattern(pattern);
  const stat = statSync(base, { throwIfNoEntry: false });
  if (firstGlob === -1) {
    if (!stat?.isFile()) return [];
    return [
      {
        file: base,
        fromImporter: posixRelative(importerDir, base),
        fromRoot: posixRelative(root, base),
      },
    ];
  }
  if (!stat?.isDirectory()) return [];
  // Every match sits under `base`, so its relative paths are base's plus the match.
  const under = (dir: string) => {
    const rel = posixRelative(dir, base);
    return rel === "" ? "" : `${rel}/`;
  };
  const importerPrefix = under(importerDir);
  const rootPrefix = under(root);
  const matches: Match[] = [];
  for (const raw of new Bun.Glob(segments.slice(firstGlob).join("/")).scanSync({
    cwd: base,
    onlyFiles: true,
    followSymlinks: true,
  })) {
    const match = toPosix(raw);
    // Like Vite: dotfiles are skipped by Bun.Glob, and node_modules below the pattern's literal prefix is too.
    if (match.startsWith("node_modules/") || match.includes("/node_modules/")) {
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

const dotSlash = (rel: string) =>
  rel.startsWith("../") || rel.startsWith("./") ? rel : `./${rel}`;

function generate(
  call: GlobCall,
  callIndex: number,
  ctx: ImportGlobContext,
  aliases: readonly AliasEntry[],
  hoisted: string[],
): string {
  const importerDir = dirname(ctx.importer);
  const included = new Map<string, { match: Match; rootKeys: boolean }>();
  const excluded = new Set<string>();
  const bareExclusions: Array<InstanceType<typeof Bun.Glob>> = [];
  const resolved: FilePattern[] = [];
  for (const raw of call.patterns) {
    const pattern = resolvePattern(raw, ctx, aliases, importerDir);
    if ("bare" in pattern) bareExclusions.push(pattern.bare);
    else resolved.push(pattern);
  }
  for (const pattern of resolved) {
    for (const match of expand(pattern, importerDir, ctx.root)) {
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
      const relativeKey = dotSlash(match.fromImporter);
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
          : `import { ${isIdentifier(name) ? name : JSON.stringify(name)} as ${local} } from ${spec};`,
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

/** Expands every `import.meta.glob(...)` call in `source`; `undefined` when there are none. */
export function transformImportGlobs(
  source: string,
  ctx: ImportGlobContext,
): string | undefined {
  if (!source.includes(NEEDLE)) return undefined;
  const sites = findCallSites(source);
  if (sites.length === 0) return undefined;

  const aliases = aliasEntries(ctx.alias, ctx.root);
  const hoisted: string[] = [];
  let output = "";
  let cursor = 0;
  sites.forEach((site, index) => {
    const call = parseCall(source, site, ctx.importer);
    const newlines = source.slice(call.start, call.end).split("\n").length - 1;
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

const PROJECT_SOURCE_FILTER =
  /^(?!.*[\\/]node_modules[\\/]).*\.(ts|tsx|js|jsx|mts|mjs)$/;

/**
 * Vite's `import.meta.glob` as a Bun `onLoad` plugin for client bundles. `steambun dev` folds the
 * same transform into its env plugin, since Bun runs only the first `onLoad` that returns contents.
 *
 * Returns every project file's contents, transformed or not: falling through with `undefined`
 * makes Bun redo the load (~4x the cost). It claims every project source, so it must come after
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
