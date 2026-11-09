// Type-level test compiled by `bun run typecheck` (`bun check`), not `bun test` —
// no assertions run; a compile error here fails the typecheck script.
import "../fixtures/typed/routes.d.ts";
import { api, href, ws } from "steambun/client";

async function check() {
  // route()'s phantom __steambun_return carries the real value type through
  // Response.json(...)'s erasure — see client.d.ts's HandlerOf/ReturnOf.
  const user = await api("get", "/api/users/:id", { params: { id: "1" } });
  user satisfies { id: string; name: string };

  // @ts-expect-error wrong param name
  await api("get", "/api/users/:id", { params: { wrongName: "1" } });

  // route(schemas, fn)'s input types flow to body/query via __steambun_input.
  const patched = await api("patch", "/api/users/:id", {
    params: { id: "1" },
    query: { notify: true },
    body: { name: "grace" },
  });
  patched satisfies { id: string; name: string };

  // @ts-expect-error body doesn't match the route's schema
  await api("patch", "/api/users/:id", { body: { name: 1 } });

  href("/");
  href("/api/users/:id", { params: { id: "1" } });
  href("/about", { query: { tab: "info" } });
  href("/api/users/:id", { params: { id: "1" }, query: { debug: "1" } });

  // @ts-expect-error a route with params needs them
  href("/api/users/:id");

  href("/about", { query: { tag: ["a", "b"] } });

  const socket = ws("/api/chat/:room", {
    params: { room: "1" },
    query: { tag: ["a", "b"] },
  });
  socket.on("message", () => {}) satisfies () => void;

  // @ts-expect-error not a websocket route
  ws("/api/users/:id", { params: { id: "1" } });

  const lazy = import.meta.glob<{ name: string }>("./pages/*.ts");
  lazy satisfies Record<string, () => Promise<{ name: string }>>;
  const eager = import.meta.glob<string>("./icons/*.svg", {
    eager: true,
    import: "default",
  });
  eager satisfies Record<string, string>;
}

void check;
