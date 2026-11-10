// Types native.call for this app's ops.
import type bridge from "./bridge.ts";

declare module "steambun/ui" {
  interface Register {
    bridge: typeof bridge;
  }
}
