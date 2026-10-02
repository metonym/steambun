import type { BunPlugin, Plugin, SteambunHooks } from "../config/types";

// A Record over the hook names, so adding a hook to SteambunHooks without listing it here is a type error.
const HOOKS: Record<Exclude<keyof SteambunHooks, "name">, true> = {
  configResolved: true,
  configureApp: true,
  buildStart: true,
  transformHtml: true,
  closeBundle: true,
};

export const HOOK_KEYS = Object.keys(HOOKS) as Array<keyof typeof HOOKS>;

export function isBunPlugin(plugin: unknown): plugin is BunPlugin {
  return !!plugin && typeof (plugin as BunPlugin).setup === "function";
}

export function isSteambunHooks(plugin: unknown): plugin is SteambunHooks {
  if (!plugin || isBunPlugin(plugin)) return false;
  const candidate = plugin as Record<string, unknown>;
  return HOOK_KEYS.some((key) => typeof candidate[key] === "function");
}

export function splitPlugins(plugins: Plugin[] = []): {
  bunPlugins: BunPlugin[];
  hooks: SteambunHooks[];
} {
  const bunPlugins: BunPlugin[] = [];
  const hooks: SteambunHooks[] = [];
  plugins.forEach((plugin, index) => {
    if (isBunPlugin(plugin)) {
      bunPlugins.push(plugin);
    } else if (isSteambunHooks(plugin)) {
      hooks.push(plugin);
    } else {
      throw new Error(`[steambun] Unrecognized plugin at index ${index}`);
    }
  });
  return { bunPlugins, hooks };
}
