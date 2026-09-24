import { route } from "steambun/runtime";
import { z } from "zod";

export const GET = route(({ params }: { params: { id: string } }) => ({
  id: params.id,
  name: "ada",
}));

export const PATCH = route(
  {
    query: z.object({ notify: z.coerce.boolean().optional() }),
    body: z.object({ name: z.string().min(1) }),
  },
  ({ params, body }) => ({ id: params.id, name: body.name }),
);
