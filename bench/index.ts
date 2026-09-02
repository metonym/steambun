import { run } from "mitata";

import "./proxy.bench";
import "./middleware.bench";
import "./config.bench";
import "./env.bench";
import "./static.bench";

await run();
