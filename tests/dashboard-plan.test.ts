import { describe, expect, it } from "vitest";
import { seriesRange } from "garmin-connect";
import { planDashboard } from "../src/tools/dashboard.ts";

describe("planDashboard", () => {
  const year = seriesRange("2026-10-28", 52);

  it("fetches everything without a budget", () => {
    expect(planDashboard(["restingHR", "hrv", "vo2max", "sleepScore"], year)).toEqual({
      now: ["restingHR", "hrv", "vo2max", "sleepScore"],
      deferred: [],
    });
  });

  it("counts each metric's own requests: a year of the defaults fits in 40", () => {
    // restingHR 2 (+ profile), hrv 1, vo2max 1, sleep 14 pages
    expect(planDashboard(["restingHR", "hrv", "vo2max", "sleepScore"], year, 40)).toEqual({
      now: ["restingHR", "hrv", "vo2max", "sleepScore"],
      deferred: [],
    });
  });

  it("counts shared sleep pages once and defers what doesn't fit", () => {
    expect(planDashboard(["sleepScore", "sleepDuration", "bodyBattery", "hrv"], year, 20)).toEqual({
      now: ["sleepScore", "sleepDuration", "hrv"],
      deferred: ["bodyBattery"],
    });
  });

  it("always fetches the first metric", () => {
    expect(planDashboard(["bodyBattery"], year, 5)).toEqual({ now: ["bodyBattery"], deferred: [] });
  });
});
