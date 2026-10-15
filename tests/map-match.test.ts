import { describe, expect, it } from "vitest";
import {
  buildingsOnPath,
  insidePolygon,
  mapMatch,
  treesOffPath,
  groundBlocker,
} from "../src/replay/map-match.ts";
import type { Road } from "../src/geo/types.ts";

/** A straight GPS line along z, `offset` m east of x = 0. */
function line(offset: number, n = 200) {
  const x = Float32Array.from({ length: n }, () => offset);
  const z = Float32Array.from({ length: n }, (_, i) => i * 1.5);
  const s = Float32Array.from({ length: n }, (_, i) => i * 1.5);
  return { x, z, s };
}

const street = (x: number, cls: Road["cls"]): Road => ({
  cls,
  paved: true,
  width: 3,
  pts: [x, -50, x, 400],
});

describe("mapMatch", () => {
  it("pulls drifted GPS onto the nearby path", () => {
    const g = line(6);
    const out = mapMatch(g.x, g.z, g.s, [street(0, "path")]);
    expect(out.matched).toBe(200);
    expect(Math.abs(out.x[100]!)).toBeLessThan(0.01);
  });

  it("prefers a foot path to an equally close road", () => {
    const g = line(5);
    const out = mapMatch(g.x, g.z, g.s, [street(0, "path"), street(9, "minor")]);
    expect(out.x[100]).toBeCloseTo(0, 1);
  });

  it("leaves points with no way nearby where GPS put them", () => {
    const g = line(40);
    const out = mapMatch(g.x, g.z, g.s, [street(0, "path")]);
    expect(out.matched).toBe(0);
    expect(out.x[100]).toBe(40);
  });
});

describe("buildings on the path", () => {
  const square = (x: number, z: number, d: number) => [x, z, x + d, z, x + d, z + d, x, z + d];

  it("finds footprints the path crosses or brushes", () => {
    expect(insidePolygon(5, 5, square(0, 0, 10))).toBe(true);
    expect(insidePolygon(15, 5, square(0, 0, 10))).toBe(false);
    const g = line(0);
    const hit = buildingsOnPath(g.x, g.z, [
      { pts: square(-5, 50, 10) }, // the path runs through it
      { pts: square(0.8, 120, 10) }, // edge 0.8 m away
      { pts: square(20, 100, 10) }, // well clear
    ]);
    expect([...hit].sort()).toEqual([0, 1]);
  });
});

describe("treesOffPath", () => {
  it("drops trees standing on the path and keeps the rest", () => {
    const x = [0, 10, 20, 30];
    const z = [0, 0, 0, 0];
    const trees = [15, 0.5, 8, 1, 15, 4, 9, 0];
    expect(treesOffPath(x, z, trees)).toEqual([15, 4, 9, 0]);
  });
});

describe("groundBlocker", () => {
  it("blocks the path, roads (by half width) and building footprints", () => {
    const blocked = groundBlocker({
      path: { x: [0, 50], z: [0, 0], halfWidth: 1 },
      lines: [{ pts: [0, 20, 50, 20], halfWidth: 3 }],
      footprints: [{ pts: [30, 30, 40, 30, 40, 40, 30, 40] }],
    });
    expect(blocked(10, 0.5)).toBe(true);
    expect(blocked(10, 1.5)).toBe(false);
    expect(blocked(10, 22.5)).toBe(true);
    expect(blocked(10, 23.5)).toBe(false);
    expect(blocked(35, 35)).toBe(true);
    expect(blocked(45, 35)).toBe(false);
  });
});
