import { describe, expect, it } from "vitest";
import { buildTrainingWeek, mondayOf, monthsOfWeek } from "../src/tools/week.ts";

describe("mondayOf", () => {
  it("returns the Monday of the week (weeks run Monday-Sunday)", () => {
    expect(mondayOf("2026-10-05")).toBe("2026-10-05"); // Monday
    expect(mondayOf("2026-10-07")).toBe("2026-10-05");
    expect(mondayOf("2026-10-11")).toBe("2026-10-05"); // Sunday
    expect(mondayOf("2026-10-03")).toBe("2026-09-28"); // across a month
    expect(mondayOf("2027-01-01")).toBe("2026-12-28"); // across a year
  });

  it("defaults to the current week", () => {
    expect(mondayOf(undefined, new Date(2026, 9, 4, 23, 30))).toBe("2026-09-28");
  });
});

describe("monthsOfWeek", () => {
  it("fetches one month, or two when the week crosses a month", () => {
    expect(monthsOfWeek("2026-10-05")).toEqual([{ year: 2026, month: 10 }]);
    expect(monthsOfWeek("2026-09-28")).toEqual([
      { year: 2026, month: 9 },
      { year: 2026, month: 10 },
    ]);
    expect(monthsOfWeek("2026-12-28")).toEqual([
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
    ]);
  });
});

describe("buildTrainingWeek", () => {
  it("sums planned estimates and completed volume, pairing activities with plans", () => {
    const week = buildTrainingWeek(
      "2026-10-05",
      [
        { id: 1, itemType: "workout", date: "2026-10-05", title: "Easy", workoutId: 11 },
        { id: 2, itemType: "workout", date: "2026-10-07", title: "Intervals", workoutId: 12 },
        { id: 3, itemType: "workout", date: "2026-10-09", title: "Lap run", workoutId: 13 },
        {
          id: 4,
          itemType: "activity",
          date: "2026-10-05",
          title: "Run",
          duration: 1_800_000,
          distance: 500_000,
        },
        { id: 5, itemType: "activity", date: "2026-10-12", title: "Next week", duration: 1000 },
      ],
      {
        11: { workoutName: "Easy 30", estimatedDurationInSecs: 1800 },
        12: { workoutName: "6x800", estimatedDurationInSecs: 3000, estimatedDistanceInMeters: 9000 },
        13: { workoutName: "Lap run", estimatedDurationInSecs: null },
      },
    );
    expect(week.days.map((d) => d.planned.map((p) => p.name))).toEqual([
      ["Easy 30"],
      [],
      ["6x800"],
      [],
      ["Lap run"],
      [],
      [],
    ]);
    expect(week.days[0]!.planned[0]!.completed).toBe(true);
    expect(week.days[2]!.planned[0]!.completed).toBe(false);
    expect(week.summary).toEqual({
      plannedCount: 3,
      plannedCompletedCount: 1,
      activityCount: 1,
      plannedDurationSecs: 4800,
      plannedDistanceMeters: 9000,
      plannedWithoutEstimate: 1,
      completedDurationSecs: 1800,
      completedDistanceMeters: 5000,
    });
  });

  it("falls back to the calendar title when the workout can't be fetched", () => {
    const week = buildTrainingWeek(
      "2026-10-05",
      [{ id: 1, itemType: "workout", date: "2026-10-06", title: "Old plan", workoutId: 99 }],
      { 99: null },
    );
    expect(week.days[1]!.planned[0]).toMatchObject({ name: "Old plan", steps: [] });
  });
});
