// Durable UI settings: string values by key, kept by the core so every
// origin shares them and a port change keeps them. The page reads and
// writes them through steambun/ui/settings.ts at /_steambun/settings.
//
// The default store is a JSON file in the app's home. An app with its own
// database passes a store of its own to `serve({ settings })`.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { home } from "./home.ts";

export interface SettingsStore {
  all(): Record<string, string>;
  /** Set each key; null removes it. Other values are ignored. */
  put(changes: Record<string, unknown>): void;
}

export const MAX_KEY = 200;

/** Keep only the changes a store may apply. */
export function cleanChanges(changes: Record<string, unknown>) {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(changes))
    if (k && k.length <= MAX_KEY && (v === null || typeof v === "string"))
      out[k] = v;
  return out;
}

/** Settings in a JSON file, written atomically on each change. */
export function jsonSettings(path = home("settings.json")): SettingsStore {
  let data: Record<string, string> = {};
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // None yet, or unreadable: start empty.
  }
  return {
    all: () => ({ ...data }),
    put(changes) {
      for (const [k, v] of Object.entries(cleanChanges(changes))) {
        if (v === null) delete data[k];
        else data[k] = v;
      }
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, path);
    },
  };
}

/** GET and PUT /_steambun/settings. */
export function settingsRoute(store: SettingsStore) {
  const json = (d: unknown, status = 200) =>
    Response.json(d, { status, headers: { "cache-control": "no-store" } });
  return {
    GET: () => json(store.all()),
    PUT: async (req: Request) => {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body))
        return json({ error: "expected an object" }, 400);
      store.put(body as Record<string, unknown>);
      return json({ ok: true });
    },
  };
}
