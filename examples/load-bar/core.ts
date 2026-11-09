// A menu bar app with a core. The core reads the load average every few
// seconds and puts it in the menu bar. That runs with the panel closed and
// no web view loaded: the page loads only when the icon is clicked.
import { loadavg } from "node:os";
import { serve, setMenuBar } from "steambun/core";
import page from "./index.html";

const history: number[] = [];

function sample() {
  const l = loadavg()[0]!;
  history.push(l);
  if (history.length > 60) history.shift();
  void setMenuBar({ title: l.toFixed(1) });
}

serve({
  routes: {
    "/": page,
    "/api/load": () =>
      Response.json({ history, cpus: navigator.hardwareConcurrency }),
  },
});
sample();
setInterval(sample, 5000);
