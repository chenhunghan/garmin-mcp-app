import { describe, expect, it } from "vitest";
import {
  buildWorkout,
  estimateSteps,
  paceToSpeed,
  parsePace,
  type GarminExecutableStep,
  type GarminRepeatGroup,
  type WorkoutSpec,
} from "../src/workout-builder.ts";

const intervals: WorkoutSpec = {
  name: "5x1km",
  sport: "running",
  description: "VO2 session",
  steps: [
    { type: "warmup", duration: { seconds: 600 }, target: { hrZone: 2 } },
    {
      repeat: 5,
      steps: [
        {
          type: "run",
          duration: { meters: 1000 },
          target: { pace: { fast: "4:00", slow: "4:10" } },
        },
        { type: "recovery", duration: { seconds: 90 } },
      ],
    },
    { type: "cooldown", duration: "lap.button" },
  ],
};

describe("parsePace / paceToSpeed", () => {
  it("parses min:sec per km", () => {
    expect(parsePace("4:30")).toBe(270);
    expect(parsePace("10:05")).toBe(605);
    expect(paceToSpeed("5:00")).toBeCloseTo(1000 / 300);
  });

  it("rejects malformed paces", () => {
    for (const bad of ["4.30", "4:3", "4:60", "abc", "", "0:00"]) {
      expect(() => parsePace(bad), bad).toThrow();
    }
  });
});

describe("buildWorkout", () => {
  it("builds the top-level workout and one segment", () => {
    const w = buildWorkout(intervals);
    expect(w.workoutName).toBe("5x1km");
    expect(w.description).toBe("VO2 session");
    expect(w.sportType).toEqual({ sportTypeId: 1, sportTypeKey: "running", displayOrder: 1 });
    expect(w.author).toEqual({});
    expect(w.workoutSegments).toHaveLength(1);
    expect(w.workoutSegments[0]!.segmentOrder).toBe(1);
    expect(w.workoutSegments[0]!.sportType).toEqual(w.sportType);
  });

  it("maps step types, end conditions and targets", () => {
    const [warmup, repeat, cooldown] = buildWorkout(intervals).workoutSegments[0]!.workoutSteps as [
      GarminExecutableStep,
      GarminRepeatGroup,
      GarminExecutableStep,
    ];

    expect(warmup).toEqual({
      type: "ExecutableStepDTO",
      stepOrder: 1,
      stepType: { stepTypeId: 1, stepTypeKey: "warmup", displayOrder: 1 },
      childStepId: null,
      description: null,
      endCondition: {
        conditionTypeId: 2,
        conditionTypeKey: "time",
        displayOrder: 2,
        displayable: true,
      },
      endConditionValue: 600,
      targetType: {
        workoutTargetTypeId: 4,
        workoutTargetTypeKey: "heart.rate.zone",
        displayOrder: 4,
      },
      targetValueOne: null,
      targetValueTwo: null,
      zoneNumber: 2,
    });

    expect(repeat).toMatchObject({
      type: "RepeatGroupDTO",
      stepOrder: 2,
      stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
      childStepId: 1,
      numberOfIterations: 5,
      smartRepeat: false,
      endCondition: {
        conditionTypeId: 7,
        conditionTypeKey: "iterations",
        displayOrder: 7,
        displayable: false,
      },
      endConditionValue: 5,
    });

    const [run, recovery] = repeat.workoutSteps as GarminExecutableStep[];
    expect(run!.stepType).toEqual({ stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 });
    expect(run!.endCondition.conditionTypeKey).toBe("distance");
    expect(run!.endCondition.conditionTypeId).toBe(3);
    expect(run!.endConditionValue).toBe(1000);
    expect(run!.targetType).toEqual({
      workoutTargetTypeId: 6,
      workoutTargetTypeKey: "pace.zone",
      displayOrder: 6,
    });
    expect(run!.zoneNumber).toBeNull();
    expect(recovery!.stepType.stepTypeKey).toBe("recovery");
    expect(recovery!.stepType.stepTypeId).toBe(4);
    expect(recovery!.targetType.workoutTargetTypeKey).toBe("no.target");
    expect(recovery!.targetType.workoutTargetTypeId).toBe(1);

    expect(cooldown.stepType).toEqual({ stepTypeId: 2, stepTypeKey: "cooldown", displayOrder: 2 });
    expect(cooldown.endCondition).toEqual({
      conditionTypeId: 1,
      conditionTypeKey: "lap.button",
      displayOrder: 1,
      displayable: true,
    });
    expect(cooldown.endConditionValue).toBeNull();
  });

  it("stores pace targets as m/s with the slower pace first", () => {
    const repeat = buildWorkout(intervals).workoutSegments[0]!.workoutSteps[1] as GarminRepeatGroup;
    const run = repeat.workoutSteps[0] as GarminExecutableStep;
    expect(run.targetValueOne).toBeCloseTo(1000 / 250); // 4:10/km (slower)
    expect(run.targetValueTwo).toBeCloseTo(1000 / 240); // 4:00/km (faster)
    expect(run.targetValueOne!).toBeLessThan(run.targetValueTwo!);
  });

  it("accepts a pace range given the wrong way round", () => {
    const w = buildWorkout({
      name: "Tempo",
      sport: "running",
      steps: [
        {
          type: "run",
          duration: { seconds: 1200 },
          target: { pace: { fast: "5:00", slow: "4:40" } },
        },
      ],
    });
    const step = w.workoutSegments[0]!.workoutSteps[0] as GarminExecutableStep;
    expect(step.targetValueOne).toBeCloseTo(1000 / 300);
    expect(step.targetValueTwo).toBeCloseTo(1000 / 280);
  });

  it("numbers steps depth-first and gives each repeat its own childStepId", () => {
    const w = buildWorkout({
      name: "Ladder",
      sport: "running",
      steps: [
        { type: "warmup", duration: { seconds: 600 } },
        {
          repeat: 2,
          steps: [
            { type: "run", duration: { seconds: 60 } },
            { type: "recovery", duration: { seconds: 60 } },
          ],
        },
        {
          repeat: 3,
          steps: [
            { type: "run", duration: { seconds: 120 } },
            {
              repeat: 2,
              steps: [
                { type: "run", duration: { seconds: 30 } },
                { type: "rest", duration: { seconds: 30 } },
              ],
            },
          ],
        },
        { type: "cooldown", duration: { seconds: 300 } },
      ],
    });
    const flat: { order: number; type: string; child: number | null }[] = [];
    const walk = (steps: (GarminExecutableStep | GarminRepeatGroup)[]) => {
      for (const s of steps) {
        flat.push({ order: s.stepOrder, type: s.stepType.stepTypeKey, child: s.childStepId });
        if (s.type === "RepeatGroupDTO") walk(s.workoutSteps);
      }
    };
    walk(w.workoutSegments[0]!.workoutSteps);
    expect(flat).toEqual([
      { order: 1, type: "warmup", child: null },
      { order: 2, type: "repeat", child: 1 },
      { order: 3, type: "interval", child: 1 },
      { order: 4, type: "recovery", child: 1 },
      { order: 5, type: "repeat", child: 2 },
      { order: 6, type: "interval", child: 2 },
      { order: 7, type: "repeat", child: 3 },
      { order: 8, type: "interval", child: 3 },
      { order: 9, type: "rest", child: 3 },
      { order: 10, type: "cooldown", child: null },
    ]);
    // 600 + 2×120 + 3×(120 + 2×60) + 300
    expect(w.estimatedDurationInSecs).toBe(600 + 240 + 720 + 300);
  });

  it("defaults a step without a duration to the lap button", () => {
    const w = buildWorkout({ name: "Easy", sport: "running", steps: [{ type: "run" }] });
    const step = w.workoutSegments[0]!.workoutSteps[0] as GarminExecutableStep;
    expect(step.endCondition.conditionTypeKey).toBe("lap.button");
    expect(w.estimatedDurationInSecs).toBeUndefined();
  });

  it("maps other sports and step types", () => {
    const w = buildWorkout({
      name: "Spin",
      sport: "cycling",
      steps: [{ type: "other", duration: { seconds: 1800 }, description: "steady" }],
    });
    expect(w.sportType).toEqual({ sportTypeId: 2, sportTypeKey: "cycling", displayOrder: 2 });
    const step = w.workoutSegments[0]!.workoutSteps[0] as GarminExecutableStep;
    expect(step.stepType).toEqual({ stepTypeId: 7, stepTypeKey: "other", displayOrder: 7 });
    expect(step.description).toBe("steady");
  });

  it("rejects invalid specs", () => {
    const base = { name: "X", sport: "running" as const };
    expect(() => buildWorkout({ ...base, steps: [] })).toThrow(/at least one step/);
    expect(() => buildWorkout({ ...base, name: " ", steps: [{ type: "run" }] })).toThrow(/name/);
    expect(() =>
      buildWorkout({ ...base, steps: [{ type: "run", target: { hrZone: 6 } }] }),
    ).toThrow(/zone/);
    expect(() =>
      buildWorkout({ ...base, steps: [{ repeat: 0, steps: [{ type: "run" }] }] }),
    ).toThrow(/Repeat/);
    expect(() => buildWorkout({ ...base, steps: [{ repeat: 2, steps: [] }] })).toThrow(/repeat/);
    expect(() =>
      buildWorkout({ ...base, steps: [{ type: "run", duration: { seconds: 0 } }] }),
    ).toThrow(/seconds/);
    expect(() =>
      buildWorkout({ ...base, sport: "curling" as never, steps: [{ type: "run" }] }),
    ).toThrow(/sport/);
  });
});

describe("estimateSteps", () => {
  it("estimates duration and distance when every step is known", () => {
    // 10 min warmup at no pace → distance unknown, duration known
    expect(estimateSteps(intervals.steps.slice(0, 1))).toEqual({ seconds: 600, meters: null });
    const est = estimateSteps([
      { type: "run", duration: { meters: 1000 }, target: { pace: { fast: "4:50", slow: "5:10" } } },
      { type: "run", duration: { seconds: 300 }, target: { pace: { fast: "5:00", slow: "5:00" } } },
    ]);
    // 1000 m at ~5:00/km ≈ 300 s; 300 s at 5:00/km = 1000 m
    expect(est.seconds).toBeCloseTo(600, 0);
    expect(est.meters).toBeCloseTo(2000, 0);
  });

  it("multiplies repeats and gives up on lap-button steps", () => {
    expect(
      estimateSteps([{ repeat: 4, steps: [{ type: "run", duration: { seconds: 60 } }] }]).seconds,
    ).toBe(240);
    expect(estimateSteps(intervals.steps).seconds).toBeNull();
  });

  it("sets estimatedDistanceInMeters on the workout only when known", () => {
    const w = buildWorkout({
      name: "Pace run",
      sport: "running",
      steps: [
        {
          type: "run",
          duration: { meters: 5000 },
          target: { pace: { fast: "5:00", slow: "5:00" } },
        },
      ],
    });
    expect(w.estimatedDistanceInMeters).toBe(5000);
    expect(w.estimatedDurationInSecs).toBe(1500);
    expect(buildWorkout(intervals).estimatedDistanceInMeters).toBeUndefined();
  });
});
