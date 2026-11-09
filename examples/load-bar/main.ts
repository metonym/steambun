// The panel: the last five minutes of load, read from the core each time
// the panel opens, and every few seconds while it shows.
import { native } from "steambun/ui";

const $ = (id: string) => document.getElementById(id)!;

async function refresh() {
  const { history, cpus } = (await (await fetch("/api/load")).json()) as {
    history: number[];
    cpus: number;
  };
  $("now").textContent = history.at(-1)?.toFixed(2) ?? "…";
  $("cpus").textContent = `1-minute load average · ${cpus} cores`;
  const top = Math.max(cpus, ...history);
  $("line").setAttribute(
    "points",
    history
      .map((v, i) => `${i + 60 - history.length},${1 - v / top}`)
      .join(" "),
  );
}

let timer: Timer | undefined;
function watch(open: boolean) {
  clearInterval(timer);
  if (!open) return;
  void refresh();
  timer = setInterval(refresh, 2000);
}
native.on("menuBar.open", (e) => watch(e.open));
watch(true);
