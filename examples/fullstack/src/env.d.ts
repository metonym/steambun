/// <reference types="steambun/client" />

export {};

declare global {
  interface ImportMetaEnv {
    readonly PUBLIC_GREETING: string;
    readonly PUBLIC_TITLE: string;
  }
}
