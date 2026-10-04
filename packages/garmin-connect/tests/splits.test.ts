import { describe, expect, it } from "vitest";
import { computeKmSplits } from "../src/splits.ts";

const descriptors = [
  { metricsIndex: 0, key: "sumDistance" },
  { metricsIndex: 1, key: "sumDuration" },
  { metricsIndex: 2, key: "directHeartRate" },
];

/** Samples every 100 m: first km at 6:00/km and HR 140, then 5:00/km and HR 160. */
function run(totalMeters: number) {
  const rows: { metrics: (number | null)[] }[] = [];
  let t = 0;
  for (let d = 0; d <= totalMeters; d += 100) {
    rows.push({ metrics: [d, t, d <= 1000 ? 140 : 160] });
    t += d < 1000 ? 36 : 30;
  }
  return { metricDescriptors: descriptors, activityDetailMetrics: rows };
}

describe("computeKmSplits", () => {
  it("splits a single-lap run into whole kilometres with pace and HR", () => {
    const splits = computeKmSplits(run(3000));
    expect(splits.map((s) => s.lapIndex)).toEqual([1, 2, 3]);
    expect(splits[0]!.duration).toBeCloseTo(360);
    expect(1000 / splits[0]!.averageSpeed).toBeCloseTo(360); // 6:00 /km
    expect(1000 / splits[1]!.averageSpeed).toBeCloseTo(300); // 5:00 /km
    expect(splits[0]!.averageHR).toBe(140);
    expect(splits[1]!.averageHR).toBe(160);
  });

  it("keeps a partial last km and drops a tiny GPS tail", () => {
    expect(computeKmSplits(run(2500)).at(-1)!.distance).toBe(500);
    const withTail = run(2000);
    withTail.activityDetailMetrics.push({ metrics: [2030, 609, 160] }); // 30 m GPS tail
    expect(computeKmSplits(withTail).map((s) => s.lapIndex)).toEqual([1, 2]);
  });

  it("interpolates boundaries between samples and ignores null HR", () => {
    const details = {
      metricDescriptors: descriptors,
      activityDetailMetrics: [
        { metrics: [0, 0, null] },
        { metrics: [600, 180, 150] },
        { metrics: [1400, 420, null] },
        { metrics: [2000, 600, 150] },
      ],
    };
    const [first] = computeKmSplits(details);
    expect(first!.duration).toBeCloseTo(300); // 1000 m reached at t=300 s
    expect(first!.averageHR).toBe(150);
  });

  it("returns nothing without distance/duration columns", () => {
    expect(computeKmSplits({ metricDescriptors: [], activityDetailMetrics: [] })).toEqual([]);
  });
});
