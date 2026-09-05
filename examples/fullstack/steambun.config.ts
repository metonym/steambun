import tailwind from "bun-plugin-tailwind";
import { defineConfig } from "steambun";
import type { Middleware } from "steambun/runtime";

// A custom native Bun plugin: onLoad turns a `.upper` file's contents into an
// uppercased JS string export. Plugins don't have to come from a package —
// any { name, setup } object works, in both dev and build.
const upperLoaderPlugin = {
  name: "upper-loader",
  setup(build: import("bun").PluginBuilder) {
    build.onLoad({ filter: /\.upper$/ }, async (args) => {
      const text = await Bun.file(args.path).text();
      return {
        contents: `export default ${JSON.stringify(text.trim().toUpperCase())};`,
        loader: "js" as const,
      };
    });
  },
};

// A middleware factory (like design's `middleware: [auth()]`) — applies to
// native api routes and proxy entries, not the static HTML/asset routes
// (see runtime/middleware.ts for why).
function logger(): Middleware {
  return async (req, next) => {
    const start = performance.now();
    const res = await next();
    // `next()` resolves to undefined when the terminal handler is a
    // WebSocket upgrade (e.g. the /legacy proxy's ws: true route) — nothing
    // to log or respond with in that case, so just pass it through.
    if (!res) return res as unknown as Response;
    const ms = (performance.now() - start).toFixed(1);
    console.log(
      `[logger] ${req.method} ${new URL(req.url).pathname} -> ${res.status} (${ms}ms)`,
    );
    return res;
  };
}

// A hooks plugin (as opposed to a native { name, setup } Bun plugin like
// upperLoaderPlugin above) — participates in steambun's own lifecycle
// instead of Bun's bundler.
const hooksPlugin = {
  name: "hooks-demo",
  configResolved(config: import("steambun").ResolvedConfig) {
    console.log(`[hooks-demo] resolved for mode=${config.mode}`);
  },
  configureApp(app: import("steambun/runtime").App) {
    app.routes["/_hooks/ping"] = () => Response.json({ pong: true });
  },
  transformHtml(html: string) {
    return html.replace(
      "</head>",
      `  <meta name="x-built-by" content="steambun" />\n  </head>`,
    );
  },
};

export default defineConfig({
  server: {
    port: 5177,
    proxy: {
      // A pre-existing backend this project doesn't own (bun run legacy-api).
      // ws: true also proxies the WebSocket echo route at /legacy/echo.
      "/legacy": {
        target: "http://localhost:4200",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  // File-based API routes: src/api/health.ts -> /api/health,
  // src/api/users/[id].ts -> /api/users/:id.
  api: "./src/api",
  middleware: [logger()],
  plugins: [tailwind, upperLoaderPlugin, hooksPlugin],
  define: {
    "import.meta.env.PUBLIC_TITLE": JSON.stringify("from steambun.config.ts"),
  },
  build: {
    // Adds integrity=/crossorigin to local <script src>/<link stylesheet>
    // tags, and writes dist/_headers.json with a Content-Security-Policy
    // (both read by dist/server.js and steambun preview).
    sri: true,
    csp: "strict",
    // splitting turns src/nav.ts (shared by main.ts and about.ts) into its
    // own chunk; importMap keys chunk-to-chunk imports by a
    // content-independent id, so editing nav.ts only re-hashes that one
    // file instead of both pages' entry scripts.
    splitting: true,
    importMap: true,
  },
  // build --compile bundles the static assets, api routes, proxy, and
  // middleware above into a single executable (bin/server).
  compile: true,
});
