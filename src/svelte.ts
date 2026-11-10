// steambun's Svelte plugin for Bun. Replaces bun-plugin-svelte.
//
// List it in bunfig.toml; the dev server and `steambun build` both read it:
//
//   [serve.static]
//   plugins = ["steambun/svelte"]
//
// - Client only: steambun apps never render on the server.
// - Component CSS goes out as a virtual .css module, so Bun bundles it
//   into the page's CSS file instead of a string in the JS.
// - Compiles are cached by source on globalThis, so a second Bun.build in
//   the same process (a watch script, `bun --hot` of a build) skips files
//   that didn't change. The dev server keeps its own bundle anyway.
// - Release builds get no HMR or dev code. bun-plugin-svelte compiled HMR
//   in unless NODE_ENV=production.
// - Under the dev server, Svelte emits its HMR accept code and dev
//   checks. Bun.build gets production output. One plugin object serves
//   both, so bunfig.toml is the only plugin list.
import type { BunPlugin, OnLoadArgs } from "bun";
import { compile, compileModule } from "svelte/compiler";

interface Out {
  js: string;
  css?: string;
}
const g = globalThis as { __svelteCache?: Map<string, Out> };
const cache = (g.__svelteCache ??= new Map());

const NS = "svelte-css";
const key = (s: string) => Bun.hash(s).toString(36);

export function svelte(opts: { dev?: boolean } = {}): BunPlugin {
  const css = new Map<string, string>();
  const ts = new Bun.Transpiler({ loader: "ts" });
  return {
    name: "steambun-svelte",
    setup(b) {
      // Resolve component packages through their "svelte" export.
      if (b.config) {
        const c = b.config.conditions ?? [];
        b.config.conditions = [...(typeof c === "string" ? [c] : c), "svelte"];
      }
      const minify = Boolean(b.config?.minify);
      // Dev output for the dev server, production output for Bun.build.
      // Bun passes no hmr flag (1.4), but only Bun.build's config has
      // entrypoints. A future hmr flag on onLoad wins.
      const devServer = !b.config?.entrypoints;
      const dev = (a: OnLoadArgs) =>
        Boolean((a as { hmr?: boolean }).hmr ?? opts.dev ?? devServer);

      b.onLoad({ filter: /\.svelte$/ }, async (a) => {
        const src = await Bun.file(a.path).text();
        const d = dev(a);
        const k = key(`c${+d}${+minify}${a.path}\0${src}`);
        let o = cache.get(k);
        if (!o) {
          const r = compile(src, {
            filename: a.path,
            generate: "client",
            css: "external",
            dev: d,
            hmr: d,
            preserveComments: !minify,
            preserveWhitespace: !minify,
          });
          o = { js: r.js.code, css: r.css?.code || undefined };
          cache.set(k, o);
        }
        let js = o.js;
        if (o.css) {
          const id = `${NS}:${key(a.path)}.css`;
          css.set(id, o.css);
          js += `\nimport ${JSON.stringify(id)};`;
        }
        return { contents: js, loader: "js" };
      });

      // Runes in plain modules (*.svelte.ts).
      b.onLoad({ filter: /\.svelte\.[jt]s$/ }, async (a) => {
        let src = await Bun.file(a.path).text();
        const d = dev(a);
        const k = key(`m${+d}${a.path}\0${src}`);
        let o = cache.get(k);
        if (!o) {
          if (a.path.endsWith(".ts")) src = ts.transformSync(src);
          const r = compileModule(src, {
            filename: a.path,
            generate: "client",
            dev: d,
          });
          o = { js: r.js.code };
          cache.set(k, o);
        }
        return { contents: o.js, loader: "js" };
      });

      b.onResolve({ filter: new RegExp(`^${NS}:`) }, (a) => ({
        path: a.path,
        namespace: NS,
      }));
      b.onLoad({ filter: /\.css$/, namespace: NS }, (a) => {
        const c = css.get(a.path);
        if (c == null) throw new Error(`no CSS for ${a.path}`);
        return { contents: c, loader: "css" };
      });
    },
  };
}

export default svelte();
