// Type-level test compiled by `bun run typecheck` (tsc), not `bun test` —
// no assertions run; a compile error here fails the typecheck script.
import "../fixtures/typed/routes.d.ts";
import { api, href } from "steambun/client";

async function check() {
  // route()'s phantom __steambun_return carries the real value type through
  // Response.json(...)'s erasure — see client.d.ts's HandlerOf/ReturnOf.
  const user = await api("get", "/api/users/:id", { params: { id: "1" } });
  user satisfies { id: string; name: string };

  // @ts-expect-error wrong param name
  await api("get", "/api/users/:id", { params: { wrongName: "1" } });

  href("/");
  href("/api/users/:id", { id: "1" });
}

void check;
