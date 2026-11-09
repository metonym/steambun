// The core: a Bun process next to the page. Its presence turns the core on.
// It serves the page and an API, and keeps a count in SQLite.
import { Database } from "bun:sqlite";
import { home, serve } from "steambun/core";
import page from "./index.html";

const db = new Database(home("app.db"));
db.run("CREATE TABLE IF NOT EXISTS hits (n INTEGER NOT NULL)");
db.run("INSERT INTO hits SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM hits)");
const count = () => db.query<{ n: number }, []>("SELECT n FROM hits").get()!.n;

serve({
  routes: {
    "/": page,
    "/api/hits": {
      GET: () => Response.json(count()),
      POST: () => (db.run("UPDATE hits SET n = n + 1"), Response.json(count())),
    },
  },
});
