import { describe, expect, it } from "vitest";
import {
  parseAthlete,
  buildReplay,
  clockLabel,
  hrZone,
  locate,
  paceLabel,
  parseChartDetails,
  parseHrZones,
  parseWeather,
  sunPosition,
  timeAtDistance,
  valueAt,
} from "../src/replay-model.ts";

const descriptors = [
  ["directTimestamp", "gmt"],
  ["sumDistance", "meter"],
  ["sumDuration", "second"],
  ["directHeartRate", "bpm"],
  ["directSpeed", "mps"],
  ["directRunCadence", "stepsPerMinute"],
  ["directElevation", "meter"],
  ["directLatitude", "dd"],
  ["directLongitude", "dd"],
  ["directStrideLength", "centimeter"],
  ["directAirTemperature", "celcius"],
].map(([key, unit], metricsIndex) => ({ metricsIndex, key, unit: { key: unit } }));

const t0 = Date.UTC(2026, 9, 3, 6, 0, 0);
const row = (t: number, d: number, extra: Partial<Record<string, number | null>> = {}) => ({
  metrics: [
    t0 + t * 1000,
    d,
    t,
    extra.hr ?? 140,
    extra.speed ?? 3,
    extra.cad ?? 85,
    extra.elev ?? 50,
    extra.lat === undefined ? 46.2 + d / 111_320 : extra.lat,
    extra.lon === undefined ? 8.5 : extra.lon,
    120,
    18,
  ],
});

const chart = {
  metricDescriptors: descriptors,
  // Out of order and with a duplicate timestamp, like auto-lap marks
  activityDetailMetrics: [row(10, 30), row(0, 0, { lat: 0, lon: 0 }), row(20, 60), row(20, 60), row(30, 90)],
};

describe("parseChartDetails", () => {
  const { channels, n, firstTimestamp } = parseChartDetails(chart);

  it("sorts by time and drops duplicate timestamps", () => {
    expect(n).toBe(4);
    expect(channels.t).toEqual([0, 10, 20, 30]);
    expect(channels.d).toEqual([0, 30, 60, 90]);
    expect(firstTimestamp).toBe(t0);
  });

  it("converts units: run cadence ×2, stride cm → m", () => {
    expect(channels.cad?.[0]).toBe(170);
    expect(channels.stride?.[0]).toBe(1.2);
    expect(channels.temp?.[0]).toBe(18);
  });

  it("treats (0, 0) GPS fixes as missing", () => {
    expect(channels.lat?.[0]).toBeNull();
    expect(channels.lon?.[0]).toBeNull();
  });

  it("returns empty channels for an empty response", () => {
    expect(parseChartDetails(null).n).toBe(0);
  });
});

describe("buildReplay", () => {
  it("maps laps onto the time axis by distance", () => {
    const replay = buildReplay({
      activityId: 1,
      details: { activityName: "Run", summaryDTO: { startTimeLocal: "2026-10-03T08:00:00.0", startTimeGMT: "2026-10-03T06:00:00.0" } },
      chart,
      splits: { lapDTOs: [{ distance: 45, averageSpeed: 3 }, { distance: 45, averageSpeed: 3 }] },
    });
    expect(replay.laps.map((l) => [l.startT, l.endT])).toEqual([
      [0, 15],
      [15, 30],
    ]);
    expect(replay.activity.utcOffsetMin).toBe(120);
    // Three fixes aren't a track
    expect(replay.hasGps).toBe(false);
    const long = {
      ...chart,
      activityDetailMetrics: Array.from({ length: 30 }, (_, k) => row(k * 10, k * 30)),
    };
    expect(buildReplay({ activityId: 1, details: null, chart: long }).hasGps).toBe(true);
  });

  it("has no GPS track when every fix is missing", () => {
    const indoor = {
      ...chart,
      activityDetailMetrics: chart.activityDetailMetrics.map((r) => ({
        metrics: r.metrics.map((v, i) => (i === 7 || i === 8 ? null : v)),
      })),
    };
    expect(buildReplay({ activityId: 1, details: null, chart: indoor }).hasGps).toBe(false);
  });
});

describe("weather and zones", () => {
  it("converts °F and mph", () => {
    const w = parseWeather({ temp: 50, apparentTemp: 46, relativeHumidity: 70, windSpeed: 10, windDirection: 180, weatherTypeDTO: { desc: "Light Rain" } });
    expect(w).toMatchObject({ tempC: 10, windKph: 16.1, windFromDeg: 180, condition: "rain" });
  });

  it("reads zone floors in order", () => {
    const zones = [5, 3, 1, 2, 4].map((n) => ({ zoneNumber: n, zoneLowBoundary: 100 + n * 10 }));
    expect(parseHrZones(zones)).toEqual([110, 120, 130, 140, 150]);
    expect(hrZone(135, [110, 120, 130, 140, 150])).toBe(3);
    expect(hrZone(90, [110, 120, 130, 140, 150])).toBe(0);
  });
});

describe("playback helpers", () => {
  it("interpolates between samples", () => {
    const at = locate([0, 10, 20], 15);
    expect(at).toEqual({ i: 1, f: 0.5 });
    expect(valueAt([100, 120, 140], at)).toBe(130);
    expect(valueAt([100, null, 140], at)).toBe(140);
    expect(timeAtDistance({ t: [0, 10, 20], d: [0, 30, 60] }, 45)).toBe(15);
  });

  it("formats pace and clock", () => {
    expect(paceLabel(1000 / 330)).toBe("5:30");
    expect(paceLabel(0)).toBeNull();
    expect(clockLabel(3725)).toBe("1:02:05");
    expect(clockLabel(65)).toBe("1:05");
  });

  it("puts the sun high at noon and below the horizon at midnight", () => {
    // Zürich, summer solstice
    const noon = sunPosition(Date.UTC(2026, 5, 21, 11, 30), 47.37, 8.54);
    expect(noon.elevation).toBeGreaterThan(60);
    expect(noon.azimuth).toBeGreaterThan(150);
    expect(noon.azimuth).toBeLessThan(210);
    expect(sunPosition(Date.UTC(2026, 5, 21, 23, 30), 47.37, 8.54).elevation).toBeLessThan(0);
  });
});

describe("parseAthlete", () => {
  it("reads sex, height and weight (grams → kg) from user settings", () => {
    expect(parseAthlete({ userData: { gender: "FEMALE", height: 165.1, weight: 54300 } })).toEqual({
      sex: "female",
      heightCm: 165.1,
      weightKg: 54.3,
    });
  });
  it("drops implausible values and returns null when nothing is known", () => {
    expect(parseAthlete({ userData: { gender: "MALE", height: 3, weight: null } })).toEqual({
      sex: "male",
      heightCm: null,
      weightKg: null,
    });
    expect(parseAthlete({ userData: {} })).toBeNull();
    expect(parseAthlete(null)).toBeNull();
  });
});
