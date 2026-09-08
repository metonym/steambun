import { describe, expect, test } from "bun:test";
import { squarify } from "../src/build/treemap";

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
