import { describe, expect, test } from "bun:test";
import type { Middleware } from "../src/runtime/middleware";
import { withMiddleware } from "../src/runtime/middleware";

const passthrough: Middleware = (_req, next) => next() ?? new Response("ok");
const handler = () => new Response("ok");

describe("withMiddleware", () => {
  const req = new Request("http://localhost/api/hello");

  test("0 middleware returns the handler result", async () => {
    const wrapped = withMiddleware([], handler);
    const res = await wrapped(req);
    expect(await res?.text()).toBe("ok");
  });

  test("1 passthrough middleware still reaches the handler", async () => {
    const wrapped = withMiddleware([passthrough], handler);
    const res = await wrapped(req);
    expect(await res?.text()).toBe("ok");
  });

  test("5 passthrough middlewares still reach the handler", async () => {
    const chain = Array.from({ length: 5 }, () => passthrough);
    const wrapped = withMiddleware(chain, handler);
    const res = await wrapped(req);
    expect(await res?.text()).toBe("ok");
  });

  test("middleware that does not call next short-circuits", async () => {
    const blocked = new Response("blocked", { status: 401 });
    const deny: Middleware = () => blocked;
    const wrapped = withMiddleware([deny, passthrough], handler);
    const res = await wrapped(req);
    expect(res?.status).toBe(401);
    expect(await res?.text()).toBe("blocked");
  });

  test("double next() throws", () => {
    const double: Middleware = (_req, next) => {
      next();
      return next() ?? new Response("ok");
    };
    const wrapped = withMiddleware([double], handler);
    expect(() => wrapped(req)).toThrow("next() called multiple times");
  });

  test("handler sees the same Request", async () => {
    let seen: Request | undefined;
    const wrapped = withMiddleware([passthrough], (incoming) => {
      seen = incoming;
      return new Response("ok");
    });
    await wrapped(req);
    expect(seen).toBe(req);
  });

  test("extra second argument is forwarded to the inner handler", async () => {
    const server = { upgrade: () => true };
    let seen: unknown;
    const wrapped = withMiddleware([passthrough], (_req, extra) => {
      seen = extra;
      return new Response("ok");
    });
    await wrapped(req, server);
    expect(seen).toBe(server);
  });
});
