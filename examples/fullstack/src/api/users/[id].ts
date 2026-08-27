export function GET(req: Request & { params: { id: string } }) {
  return Response.json({ id: req.params.id });
}
