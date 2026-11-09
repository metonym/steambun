import { escapeHtml, formatSize } from "../util/format";
import type { AnalyzeReport } from "./analyze";

export interface TreemapNode {
  id: string;
  value: number;
}

export interface TreemapRect extends TreemapNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap layout (Bruls/Huizing/van Wijk), computed once so the page needs no layout code. */
export function squarify(
  nodesIn: TreemapNode[],
  x: number,
  y: number,
  w: number,
  h: number,
): TreemapRect[] {
  const nodes = [...nodesIn]
    .filter((n) => n.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = nodes.reduce((s, n) => s + n.value, 0);
  if (total === 0) return [];
  const scale = (w * h) / total;
  const rects: TreemapRect[] = [];
  let rx = x,
    ry = y,
    rw = w,
    rh = h,
    rest = nodes;

  const worst = (row: TreemapNode[], length: number) => {
    const areas = row.map((n) => n.value * scale);
    const sum = areas.reduce((a, b) => a + b, 0);
    const max = Math.max(...areas),
      min = Math.min(...areas);
    return Math.max(
      (length * length * max) / (sum * sum),
      (sum * sum) / (length * length * min),
    );
  };

  while (rest.length > 0) {
    const horizontal = rw >= rh;
    const length = horizontal ? rh : rw;
    const row = [rest[0]!];
    let i = 0;
    while (
      i + 1 < rest.length &&
      worst(row, length) >= worst([...row, rest[i + 1]!], length)
    ) {
      row.push(rest[++i]!);
    }
    const sum = row.reduce((s, n) => s + n.value * scale, 0);
    const thickness = sum / length;
    let offset = 0;
    for (const n of row) {
      const size = (n.value * scale) / thickness;
      rects.push(
        horizontal
          ? { ...n, x: rx, y: ry + offset, w: thickness, h: size }
          : { ...n, x: rx + offset, y: ry, w: size, h: thickness },
      );
      offset += size;
    }
    if (horizontal) {
      rx += thickness;
      rw -= thickness;
    } else {
      ry += thickness;
      rh -= thickness;
    }
    rest = rest.slice(row.length);
  }
  return rects;
}

const WIDTH = 960;
const HEIGHT = 600;
const MAX_INPUTS_PER_LEVEL = 30;
const OTHER_ID = "(other)";

function renderLevel(
  id: string,
  rects: TreemapRect[],
  hidden: boolean,
): string {
  const boxes = rects
    .map((r) => {
      const label = `${escapeHtml(r.id)} — ${formatSize(r.value)}`;
      return `<g class="cell" tabindex="0" role="button" aria-label="${label}" data-id="${escapeHtml(r.id)}"><title>${label}</title><rect x="${r.x.toFixed(2)}" y="${r.y.toFixed(2)}" width="${Math.max(r.w, 0).toFixed(2)}" height="${Math.max(r.h, 0).toFixed(2)}"></rect><text x="${(r.x + 4).toFixed(2)}" y="${(r.y + 14).toFixed(2)}">${escapeHtml(r.id)}</text></g>`;
    })
    .join("");
  return `<g data-level="${escapeHtml(id)}"${hidden ? ' style="display:none"' : ""}>${boxes}</g>`;
}

/** An output's largest inputs plus an "other" cell, so the cells sum to the output's size. */
export function outputNodes(
  output: AnalyzeReport["outputs"][number],
): TreemapNode[] {
  const shown = output.inputs
    .slice(0, MAX_INPUTS_PER_LEVEL)
    .map((i) => ({ id: i.path, value: i.bytes }));
  const other = output.bytes - shown.reduce((sum, n) => sum + n.value, 0);
  return other > 0 ? [...shown, { id: OTHER_ID, value: other }] : shown;
}

/** A self-contained HTML treemap over outputs, drilling into each output's largest inputs. */
export function renderTreemapHtml(report: AnalyzeReport): string {
  const layout = (nodes: TreemapNode[]) => squarify(nodes, 0, 0, WIDTH, HEIGHT);

  const levels = [
    renderLevel(
      "root",
      layout(report.outputs.map((o) => ({ id: o.path, value: o.bytes }))),
      false,
    ),
    ...report.outputs.map((output) =>
      renderLevel(output.path, layout(outputNodes(output)), true),
    ),
  ];

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>steambun analyze</title>
<style>
  body { margin: 0; font: 13px system-ui, sans-serif; background: #0b0b0f; color: #eee; }
  #toolbar { padding: 8px 12px; display: flex; align-items: center; gap: 8px; }
  #back { display: none; cursor: pointer; background: #222; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 4px 10px; }
  svg { display: block; width: 100%; height: ${HEIGHT}px; }
  .cell rect { stroke: #0b0b0f; stroke-width: 1; fill: hsl(210 60% 45%); cursor: pointer; }
  .cell:focus rect, .cell:hover rect { fill: hsl(210 80% 60%); outline: none; }
  .cell text { fill: #fff; font-size: 11px; pointer-events: none; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="back">&larr; back</button>
  <span id="crumb">root</span>
</div>
<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
${levels.join("\n")}
</svg>
<script>
(function () {
  var svg = document.querySelector("svg");
  var back = document.getElementById("back");
  var crumb = document.getElementById("crumb");
  var current = "root";

  function show(level) {
    var groups = svg.querySelectorAll("g[data-level]");
    for (var i = 0; i < groups.length; i++) {
      groups[i].style.display = groups[i].getAttribute("data-level") === level ? "" : "none";
    }
    current = level;
    crumb.textContent = level;
    back.style.display = level === "root" ? "none" : "";
  }

  function zoomIn(id) {
    var target = svg.querySelector('g[data-level="' + CSS.escape(id) + '"]');
    if (target) show(id);
  }

  svg.addEventListener("click", function (e) {
    var cell = e.target.closest(".cell");
    if (!cell || current !== "root") return;
    zoomIn(cell.getAttribute("data-id"));
  });

  svg.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var cell = e.target.closest(".cell");
    if (!cell || current !== "root") return;
    e.preventDefault();
    zoomIn(cell.getAttribute("data-id"));
  });

  back.addEventListener("click", function () { show("root"); });
})();
</script>
</body>
</html>
`;
}
