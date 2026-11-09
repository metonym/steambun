// Named HTTP-method exports map to a per-method Bun.serve route.
export function GET() {
  return Response.json({ status: "ok", time: new Date().toISOString() });
}
