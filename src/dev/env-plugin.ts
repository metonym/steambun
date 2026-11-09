import { readFileSync } from "node:fs";
import type { BunPlugin } from "bun";
import { transformImportGlobs } from "../util/import-glob";
import { GENERATED_HEADER } from "../util/paths";
import { escapeRegExp } from "../util/regexp";

const TEMPLATE_RUN = /[^\\`$]+/y;
const SOURCE_FILE = /^(?!.*[\\/]node_modules[\\/]).*\.(ts|tsx|js|jsx|mts|mjs)$/;

// Scanner, not a parser: a regex literal with an unbalanced quote or comment-like sequence can misparse.
// Strings, comments, and keys that prefix a longer identifier (FOO in FOOBAR) are left alone.
function createDefineSubstituter(
  defines: Record<string, string>,
): (src: string) => string {
  const keys = Object.keys(defines).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return (src) => src;
  const byFirstChar = new Map<string, string[]>();
  for (const key of keys) {
    const list = byFirstChar.get(key[0]);
    if (list) list.push(key);
    else byFirstChar.set(key[0], [key]);
  }
  const anyKey = new RegExp(keys.map(escapeRegExp).join("|"));
  // The next place the scanner has to look at: a delimiter or a possible key start.
  const stop = new RegExp(
    `[{}\`/"'${[...byFirstChar.keys()].map(escapeRegExp).join("")}]`,
    "g",
  );

  return (src) => {
    if (!anyKey.test(src)) return src;
    const n = src.length;
    let i = 0;
    let out = "";

    const matchKey = (): string | undefined => {
      for (const key of byFirstChar.get(src[i]) ?? []) {
        if (!src.startsWith(key, i)) continue;
        if (/[\w$.]/.test(src[i - 1] ?? "")) continue;
        if (/[\w$]/.test(src[i + key.length] ?? "")) continue;
        return key;
      }
      return undefined;
    };

    const copyTo = (end: number): void => {
      out += src.slice(i, end);
      i = end;
    };

    const quoted = (quote: string): void => {
      let j = i + 1;
      while (j < n && src[j] !== quote) j += src[j] === "\\" ? 2 : 1;
      copyTo(Math.min(j + 1, n));
    };

    // `i` is just past the opening backtick.
    const template = (): void => {
      while (i < n) {
        TEMPLATE_RUN.lastIndex = i;
        const run = TEMPLATE_RUN.exec(src);
        if (run) copyTo(i + run[0].length);
        if (i >= n) return;
        const c = src[i];
        if (c === "\\") copyTo(i + 2);
        else if (c === "`") {
          copyTo(i + 1);
          return;
        } else if (c === "$" && src[i + 1] === "{") {
          copyTo(i + 2);
          code(true);
          if (i < n) copyTo(i + 1);
        } else copyTo(i + 1);
      }
    };

    // Brace nesting is tracked so a nested block can't end a template interpolation on the wrong `}`.
    const code = (stopAtBrace: boolean): void => {
      while (i < n) {
        const c = src[i];
        if (c === "}" && stopAtBrace) return;
        if (c === "{") {
          copyTo(i + 1);
          code(true);
          if (i < n) copyTo(i + 1);
        } else if (c === "`") {
          copyTo(i + 1);
          template();
        } else if (c === "/" && src[i + 1] === "/") {
          const eol = src.indexOf("\n", i);
          copyTo(eol === -1 ? n : eol);
        } else if (c === "/" && src[i + 1] === "*") {
          const close = src.indexOf("*/", i + 2);
          copyTo(close === -1 ? n : close + 2);
        } else if (c === '"' || c === "'") {
          quoted(c);
        } else {
          const key = matchKey();
          if (key) {
            out += defines[key];
            i += key.length;
          } else {
            // A delimiter that isn't special here, or a key start that didn't match: copy it and run to the next stop.
            stop.lastIndex = i + 1;
            copyTo(stop.exec(src)?.index ?? n);
          }
        }
      }
    };

    code(false);
    return out;
  };
}

/**
 * Bun's dev bundler has no JS-level `define`, so defines go through an onLoad plugin. Bun runs only
 * the first onLoad that returns contents, so `import.meta.glob` expansion shares this hook; it
 * returns every project source (falling through makes Bun redo the load, which costs more), so it
 * must be registered after every other dev plugin.
 */
export function createDevTransformPlugin(
  defines: Record<string, string>,
  importGlob: { root: string; alias?: Record<string, string> },
): BunPlugin {
  const substitute = createDefineSubstituter(defines);
  return {
    name: "steambun-env-define",
    setup(build) {
      build.onLoad({ filter: SOURCE_FILE }, (args) => {
        const original = readFileSync(args.path, "utf8");
        const globbed = transformImportGlobs(original, {
          ...importGlob,
          importer: args.path,
        });
        // Bun's default .js loader parses JSX; an explicit "js" doesn't.
        const loader = args.path.endsWith(".tsx")
          ? "tsx"
          : args.path.endsWith(".ts") || args.path.endsWith(".mts")
            ? "ts"
            : "jsx";
        return { contents: substitute(globbed ?? original), loader };
      });
    },
  };
}

/** The dev plugin must `export default { name, setup }`: calling the global plugin() registrar throws (Bun 1.4.0). */
export function generateEnvPluginSource(
  defines: Record<string, string>,
  importGlob: { root: string; alias?: Record<string, string> },
): string {
  return `${GENERATED_HEADER}
import { createDevTransformPlugin } from "steambun/internal";

export default createDevTransformPlugin(
  ${JSON.stringify(defines, null, 2)},
  ${JSON.stringify(importGlob)},
);
`;
}
