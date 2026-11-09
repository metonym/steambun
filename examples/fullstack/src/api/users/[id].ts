// A bare handler, not route(): a `compile: true` binary imports api routes from
// its embedded assets and can't resolve "steambun/runtime" there.
export function GET(req: Request & { params: { id: string } }) {
  return Response.json({ id: req.params.id });
}
