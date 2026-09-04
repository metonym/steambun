import { group, task } from "ostia";
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

  task("0 middleware", () => none(req));
  task("1 middleware", () => one(req));
  task("5 middleware", () => five(req));
  task("20 middleware", () => twenty(req));
});

group("runtime/middleware: withMiddleware (construction)", () => {
  task("build a 5-deep chain", () => chain(5));
});
