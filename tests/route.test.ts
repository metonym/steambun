import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { route } from "../src/runtime/route";

function request(
  url: string,
  init: RequestInit = {},
  params: Record<string, string> = {},
): Request & { params: Record<string, string> } {
  return Object.assign(new Request(`http://localhost${url}`, init), { params });
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("route()", () => {
  test("without schemas, JSON-encodes the return value and parses the query", async () => {
    const handler = route(({ params, query, body }) => ({
      params,
      query,
      body,
    }));
    const res = await handler(request("/x?a=1&t=x&t=y", {}, { id: "7" }));
    expect(await res.json()).toEqual({
      params: { id: "7" },
      query: { a: "1", t: ["x", "y"] },
    });
  });

  test("parses the query like URLSearchParams", async () => {
    const handler = route(({ query }) => query);
    const url =
      "/x?q=hello+world&e=%C3%A9&flag&=v&k=a%2Bb&bad=%E0%A4%A&t=1&t=2";
    const expected: Record<string, string | string[]> = {};
    for (const [key, value] of new URL(`http://localhost${url}`).searchParams) {
      const existing = expected[key];
      if (existing === undefined) expected[key] = value;
      else expected[key] = [existing, value].flat();
    }
    const res = await handler(request(url));
    expect(await res.json()).toEqual(expected);
  });

  test("passes a returned Response through", async () => {
    const handler = route(() => new Response("hi", { status: 201 }));
    const res = await handler(request("/x"));
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hi");
  });

  test("validates and transforms params, query, and body", async () => {
    const handler = route(
      {
        params: z.object({ id: z.coerce.number() }),
        query: z.object({ page: z.coerce.number().default(1) }),
        body: z.object({ name: z.string().min(1) }),
      },
      ({ params, query, body }) => ({
        id: params.id,
        page: query.page,
        name: body.name,
      }),
    );
    const res = await handler(
      request("/x?page=3", json({ name: "ada" }), { id: "42" }),
    );
    expect(await res.json()).toEqual({ id: 42, page: 3, name: "ada" });
  });

  test("returns 400 with every failing location before calling the handler", async () => {
    let called = false;
    const handler = route(
      {
        query: z.object({ page: z.coerce.number() }),
        body: z.object({ name: z.string(), tags: z.array(z.string()) }),
      },
      () => {
        called = true;
        return {};
      },
    );
    const res = await handler(
      request("/x?page=nope", json({ name: 1, tags: ["a", 2] })),
    );
    expect(res.status).toBe(400);
    const payload = (await res.json()) as {
      error: string;
      issues: Array<{ in: string; path: string }>;
    };
    expect(payload.error).toBe("invalid request");
    expect(
      payload.issues.map(({ in: where, path }) => `${where}:${path}`),
    ).toEqual(["query:page", "body:name", "body:tags.1"]);
    expect(called).toBe(false);
  });

  test("malformed JSON is a 400 body issue", async () => {
    const handler = route({ body: z.object({}) }, () => ({}));
    const res = await handler(
      request("/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid request",
      issues: [{ in: "body", path: "", message: "Invalid JSON" }],
    });
  });

  test("form bodies become objects, repeated keys become arrays", async () => {
    const handler = route(
      { body: z.object({ name: z.string(), tag: z.array(z.string()) }) },
      ({ body }) => body,
    );
    const form = new URLSearchParams([
      ["name", "ada"],
      ["tag", "a"],
      ["tag", "b"],
    ]);
    const res = await handler(request("/x", { method: "POST", body: form }));
    expect(await res.json()).toEqual({ name: "ada", tag: ["a", "b"] });
  });

  test("an empty body validates as undefined", async () => {
    const handler = route(
      { body: z.object({ name: z.string() }).optional() },
      ({ body }) => ({ present: body !== undefined }),
    );
    const res = await handler(request("/x", { method: "POST" }));
    expect(await res.json()).toEqual({ present: false });
  });
});
