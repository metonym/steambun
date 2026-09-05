// Plain handler, not route() — see .context/followups.md: `--compile`
// dynamically imports api route files from its embedded $bunfs assets,
// which can't resolve an external package ("steambun/runtime") at runtime.
// This example enables `compile: true`, so it stays on a bare handler.
export function GET(req: Request & { params: { id: string } }) {
  return Response.json({ id: req.params.id });
}
