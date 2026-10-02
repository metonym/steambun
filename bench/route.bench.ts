import { group, task } from "ostia";
import { z } from "zod";
import { route } from "../src/runtime/route";

// `alloc` records bytes allocated per call.
const params = { id: "42" };
const withParams = (req: Request) =>
  Object.assign(req, { params }) as Request & { params: typeof params };

group(
  "runtime/route: route() without schemas (per-request hot path)",
  () => {
    const bare = route(({ params }) => ({ id: params.id }));
    const req = withParams(
      new Request("http://localhost:5173/api/users/42?page=2&tag=a&tag=b"),
    );
    task("bare route(fn), JSON return", () => bare(req));
  },
  { alloc: true },
);

group(
  "runtime/route: route(schemas, fn) with zod (per-request hot path)",
  () => {
    const validated = route(
      {
        params: z.object({ id: z.coerce.number() }),
        query: z.object({ page: z.coerce.number().default(1) }),
      },
      ({ params, query }) => ({ id: params.id, page: query.page }),
    );
    const req = withParams(
      new Request("http://localhost:5173/api/users/42?page=2"),
    );
    task("params + query schemas", () => validated(req));

    const withBody = route(
      {
        body: z.object({ name: z.string().min(1), tags: z.array(z.string()) }),
      },
      ({ body }) => body,
    );
    const payload = JSON.stringify({ name: "ada", tags: ["a", "b", "c"] });
    // The body stream is single-use, so each call builds its Request.
    task("JSON body schema (includes new Request)", () =>
      withBody(
        withParams(
          new Request("http://localhost:5173/api/users", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: payload,
          }),
        ),
      ),
    );
  },
  { alloc: true },
);
