/// <reference types="steambun/client" />

export {};

// PUBLIC_GREETING comes from .env and is typed in the generated .steambun/env.d.ts;
// PUBLIC_TITLE is set through `define`, so it needs this declaration.
declare global {
  interface ImportMetaEnv {
    readonly PUBLIC_TITLE: string;
  }
}
