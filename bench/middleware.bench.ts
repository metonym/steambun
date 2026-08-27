import { bench, do_not_optimize, group } from "mitata";
import type { Middleware } from "../src/runtime/middleware";
import { withMiddleware } from "../src/runtime/middleware";

const OK = new Response("ok");
const passthrough: Middleware = (_req, next) => next();
const handler = () => OK;

function chain(length: number) {
  return withMiddleware(
    Array.from({ length }, () => passthrough),
    handler,
  );
}

group("runtime/middleware: withMiddleware (per-request hot path)", () => {
  const req = new Request("http://localhost:5173/api/hello");

  const none = chain(0);
  const one = chain(1);
  const five = chain(5);
  const twenty = chain(20);

  bench("0 middleware", async () => {
    do_not_optimize(await none(req));
  });

  bench("1 middleware", async () => {
    do_not_optimize(await one(req));
  });

  bench("5 middleware", async () => {
    do_not_optimize(await five(req));
  });

  bench("20 middleware", async () => {
    do_not_optimize(await twenty(req));
  });
});

group("runtime/middleware: withMiddleware (construction)", () => {
  bench("build a 5-deep chain", () => {
    do_not_optimize(chain(5));
  });
});
