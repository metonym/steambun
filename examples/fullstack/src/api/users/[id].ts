import { route } from "steambun/runtime";

// route() turns a plain return value into Response.json(...) and carries
// the value's real type through to steambun/client's api() (see main.ts).
export const GET = route(({ params }: { params: { id: string } }) => ({
  id: params.id,
}));
