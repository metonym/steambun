import { route } from "steambun/runtime";

export const GET = route(({ params }: { params: { id: string } }) => ({
  id: params.id,
  name: "ada",
}));
