// Fixture standing in for a generated `.steambun/routes.d.ts`.

import type * as R1 from "./chat-room";
import type * as R0 from "./users-id";

declare module "steambun/client" {
  interface SteambunRoutes {
    "/api/users/:id": {
      params: { id: string };
      module: typeof R0;
      websocket: false;
    };
    "/api/chat/:room": {
      params: { room: string };
      module: typeof R1;
      websocket: true;
    };
  }
  interface SteambunPages {
    // biome-ignore lint/complexity/noBannedTypes: matches steambun's generated routes.d.ts output
    "/": {};
    // biome-ignore lint/complexity/noBannedTypes: matches steambun's generated routes.d.ts output
    "/about": {};
  }
}
