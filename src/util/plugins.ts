import type { BunPlugin, Plugin, SteambunHooks } from "../config/types";

export function isBunPlugin(plugin: unknown): plugin is BunPlugin {
  return !!plugin && typeof (plugin as BunPlugin).setup === "function";
}

export function isSteambunHooks(plugin: unknown): plugin is SteambunHooks {
  return !!plugin && !isBunPlugin(plugin);
}

export function splitPlugins(plugins: Plugin[] = []): {
  bunPlugins: BunPlugin[];
  hooks: SteambunHooks[];
} {
  return {
    bunPlugins: plugins.filter(isBunPlugin),
    hooks: plugins.filter(isSteambunHooks),
  };
}
