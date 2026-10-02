import { describe, expect, test } from "bun:test";
import type { AnalyzeReport } from "../src/build/analyze";
import { outputNodes, renderTreemapHtml, squarify } from "../src/build/treemap";

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  const EPS = 1e-6;
  return (
    a.x + a.w > b.x + EPS &&
    b.x + b.w > a.x + EPS &&
    a.y + a.h > b.y + EPS &&
    b.y + b.h > a.y + EPS
  );
}

describe("squarify", () => {
  test("rects' total area equals the box area", () => {
    const rects = squarify(
      [
        { id: "a", value: 3 },
        { id: "b", value: 1 },
      ],
      0,
      0,
      100,
      100,
    );
    const totalArea = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(totalArea).toBeCloseTo(10000, 5);
  });

  test("no two rects overlap", () => {
    const rects = squarify(
      [
        { id: "a", value: 3 },
        { id: "b", value: 1 },
        { id: "c", value: 5 },
        { id: "d", value: 2 },
      ],
      0,
      0,
      100,
      100,
    );
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  test("a single node fills the whole box", () => {
    const rects = squarify([{ id: "only", value: 42 }], 0, 0, 100, 50);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 50 });
  });

  test("empty or all-zero input returns []", () => {
    expect(squarify([], 0, 0, 100, 100)).toEqual([]);
    expect(
      squarify(
        [
          { id: "a", value: 0 },
          { id: "b", value: 0 },
        ],
        0,
        0,
        100,
        100,
      ),
    ).toEqual([]);
  });
});

function output(
  bytes: number,
  inputBytes: number[],
): AnalyzeReport["outputs"][number] {
  return {
    path: "assets/app.js",
    bytes,
    inputs: inputBytes.map((b, i) => ({ path: `src/f${i}.ts`, bytes: b })),
  };
}

describe("outputNodes", () => {
  test("adds an other cell so the cells sum to the output size", () => {
    const nodes = outputNodes(output(100, [40, 30]));
    expect(nodes.at(-1)).toEqual({ id: "(other)", value: 30 });
    expect(nodes.reduce((sum, n) => sum + n.value, 0)).toBe(100);
  });

  test("folds inputs beyond the per-level cap into other", () => {
    const nodes = outputNodes(output(200, Array(40).fill(5)));
    expect(nodes).toHaveLength(31);
    expect(nodes.reduce((sum, n) => sum + n.value, 0)).toBe(200);
  });

  test("adds nothing when the inputs already account for every byte", () => {
    expect(outputNodes(output(70, [40, 30]))).toHaveLength(2);
  });
});

describe("renderTreemapHtml", () => {
  test("escapes paths in attributes and text", () => {
    const html = renderTreemapHtml({
      outputs: [output(10, [10])].map((o) => ({ ...o, path: `a"<b>&'.js` })),
      packages: [],
      duplicates: [],
      total: 10,
    });
    expect(html).toContain("a&quot;&lt;b&gt;&amp;&#39;.js");
    expect(html).not.toContain(`a"<b>`);
  });
});
