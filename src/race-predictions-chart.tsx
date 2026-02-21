import { useState, useEffect, useCallback } from "react";
import { AreaChart, Area } from "recharts";
import { ChartContainer } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

interface RacePrediction {
  label: string;
  shortLabel: string;
  seconds: number | null;
  isLong: boolean;
}

interface Vo2Point {
  date: string;
  label: string;
  vo2: number;
}

const chartConfig = {
  vo2: { label: "VO2 Max", color: "var(--chart-2)" },
} satisfies ChartConfig;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Format seconds into a readable race time.
 * For shorter races (5K/10K): MM:SS
 * For longer races (half/marathon): H:MM:SS
 */
function formatRaceTime(seconds: number, isLong: boolean): string {
  if (!seconds || seconds <= 0) return "-";
  const totalSecs = Math.round(seconds);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;

  if (isLong || h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Extract race prediction times from the API response.
 * The Garmin race predictions API response format can vary, so we
 * try multiple known shapes and use optional chaining throughout.
 */
function extractPredictions(raw: unknown): RacePrediction[] {
  const distances = [
    { key: "5K", label: "5K", shortLabel: "5K", isLong: false },
    { key: "10K", label: "10K", shortLabel: "10K", isLong: false },
    { key: "halfMarathon", label: "Half Marathon", shortLabel: "Half", isLong: true },
    { key: "marathon", label: "Marathon", shortLabel: "Marathon", isLong: true },
  ];

  if (!raw || typeof raw !== "object") {
    return distances.map((d) => ({
      label: d.label,
      shortLabel: d.shortLabel,
      seconds: null,
      isLong: d.isLong,
    }));
  }

  const obj = raw as Record<string, unknown>;

  // Shape 1: flat object with keys like "5K", "10K", "halfMarathon", "marathon"
  // Each value is a number (seconds) or an object with predictedTime/time
  function extractTime(val: unknown): number | null {
    if (typeof val === "number" && val > 0) return val;
    if (val && typeof val === "object") {
      const v = val as Record<string, unknown>;
      const t = v.predictedTime ?? v.time ?? v.predictedTimeInSeconds ?? v.seconds;
      if (typeof t === "number" && t > 0) return t;
    }
    return null;
  }

  // Shape 2: array of predictions with raceDistance / distance fields
  const predictionsArray = Array.isArray(obj.racePredictions)
    ? obj.racePredictions
    : Array.isArray(obj.predictions)
      ? obj.predictions
      : Array.isArray(raw)
        ? (raw as unknown[])
        : null;

  if (predictionsArray) {
    const distanceMap: Record<string, { seconds: number | null }> = {};
    for (const item of predictionsArray) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const distKey =
        (entry.raceDistance as string) ??
        (entry.distance as string) ??
        (entry.name as string) ??
        "";
      const normalized = distKey
        .toLowerCase()
        .replace(/[\s_-]/g, "")
        .replace("halfmarathon", "halfMarathon")
        .replace("half", "halfMarathon");

      const time = extractTime(entry.predictedTime ?? entry.time ?? entry);
      // Map known distance names
      if (normalized.includes("5k")) distanceMap["5K"] = { seconds: time };
      else if (normalized.includes("10k")) distanceMap["10K"] = { seconds: time };
      else if (normalized.includes("halfmarathon") || normalized.includes("half"))
        distanceMap["halfMarathon"] = { seconds: time };
      else if (normalized.includes("marathon") && !normalized.includes("half"))
        distanceMap["marathon"] = { seconds: time };
    }

    return distances.map((d) => ({
      label: d.label,
      shortLabel: d.shortLabel,
      seconds: distanceMap[d.key]?.seconds ?? null,
      isLong: d.isLong,
    }));
  }

  // Shape 1 (flat keys) or nested under a single object
  // API may use "time5K", "time10K", "timeHalfMarathon", "timeMarathon"
  return distances.map((d) => {
    const timeKey = `time${d.key.charAt(0).toUpperCase()}${d.key.slice(1)}`;
    const val =
      obj[d.key] ??
      obj[d.key.toLowerCase()] ??
      obj[timeKey] ??
      obj[d.label.toLowerCase().replace(/ /g, "")];
    return {
      label: d.label,
      shortLabel: d.shortLabel,
      seconds: extractTime(val),
      isLong: d.isLong,
    };
  });
}

/**
 * Transform VO2 Max API response into chart-ready data.
 * The API returns an array where each entry has a nested `generic` object:
 * { generic: { calendarDate, vo2MaxPreciseValue, vo2MaxValue } }
 */
function transformVo2Data(raw: unknown): Vo2Point[] {
  if (!Array.isArray(raw)) return [];

  const points: Vo2Point[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    // VO2 data may be at top level or nested under `generic`
    const generic = e.generic as Record<string, unknown> | undefined;
    const vo2 =
      (generic?.vo2MaxPreciseValue as number) ??
      (generic?.vo2MaxValue as number) ??
      (e.vo2MaxPreciseValue as number) ??
      0;
    const dateStr = (generic?.calendarDate as string) ?? (e.calendarDate as string) ?? "";

    if (!dateStr || vo2 <= 0) continue;

    const parts = dateStr.split("-");
    const label =
      parts.length === 3 ? `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}` : dateStr;
    points.push({ date: dateStr, label, vo2 });
  }

  return points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function RacePredictionsChart({
  callTool,
}: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [predictions, setPredictions] = useState<RacePrediction[]>([]);
  const [vo2Data, setVo2Data] = useState<Vo2Point[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 29);

      const [racePredResult, vo2Result] = await Promise.all([
        callTool("get-race-predictions", {}),
        callTool("get-vo2-max", { startDate: formatDate(start), endDate: formatDate(end) }),
      ]);

      setPredictions(extractPredictions(racePredResult));
      setVo2Data(transformVo2Data(vo2Result));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const latestVo2 = vo2Data.length > 0 ? vo2Data[vo2Data.length - 1].vo2 : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Race Predictions</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Loading race predictions...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="grid grid-cols-2 gap-3">
              {predictions.map((p) => (
                <div key={p.shortLabel}>
                  <div className="text-[10px] text-muted-foreground">{p.label}</div>
                  <div className="text-base font-semibold font-mono tabular-nums">
                    {p.seconds != null ? formatRaceTime(p.seconds, p.isLong) : "-"}
                  </div>
                </div>
              ))}
            </div>

            {vo2Data.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border/50">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-muted-foreground">VO2 Max (30d)</span>
                  {latestVo2 != null && (
                    <span className="text-sm font-semibold tabular-nums">
                      {latestVo2.toFixed(1)}
                    </span>
                  )}
                </div>
                <ChartContainer config={chartConfig} className="aspect-auto h-[80px] w-full">
                  <AreaChart data={vo2Data} margin={{ top: 2, right: 4, bottom: 0, left: 4 }}>
                    <defs>
                      <linearGradient id="fill-vo2" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-vo2)" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="var(--color-vo2)" stopOpacity={0.1} />
                      </linearGradient>
                    </defs>
                    <Area
                      dataKey="vo2"
                      stroke="var(--color-vo2)"
                      fill="url(#fill-vo2)"
                      strokeWidth={1.5}
                      type="monotone"
                      dot={false}
                    />
                  </AreaChart>
                </ChartContainer>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
