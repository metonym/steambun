// A default export handles every HTTP method, unlike health.ts's per-method exports.
export default async function (req: Request) {
  const body = req.method === "GET" ? null : await req.json().catch(() => null);
  return Response.json({ method: req.method, body });
}
