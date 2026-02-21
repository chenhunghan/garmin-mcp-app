import { useState, useEffect, useCallback, useMemo } from "react";
import { Bar, XAxis, YAxis, CartesianGrid, Line, ComposedChart } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

interface RawLap {
  lapIndex: number;
  distance: number;
  duration: number;
  movingDuration?: number;
  averageSpeed: number;
  averageMovingSpeed?: number;
  maxSpeed?: number;
  calories?: number;
  averageHR?: number;
  maxHR?: number;
  averageRunCadence?: number;
  maxRunCadence?: number;
  averagePower?: number;
  maxPower?: number;
  intensityType?: string;
}

interface SplitPoint {
  label: string;
  /** Pace in total seconds per km (for Y-axis scaling) */
  paceSeconds: number | null;
  /** Formatted pace string like "5:30" */
  paceFormatted: string;
  /** Average HR in bpm */
  avgHR: number | null;
  /** Raw lap data for tooltip */
  raw: RawLap;
}

const chartConfig = {
  pace: { label: "Pace", color: "var(--chart-1)" },
  avgHR: { label: "Avg HR", color: "var(--chart-3)" },
} satisfies ChartConfig;

/** Convert speed in m/s to pace in total seconds per km */
function speedToPaceSeconds(speedMs: number): number {
  if (!speedMs || speedMs <= 0) return 0;
  return 1000 / speedMs;
}

/** Format pace seconds into MM:SS string */
function formatPace(totalSeconds: number): string {
  if (!totalSeconds || totalSeconds <= 0) return "-";
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.round(totalSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatIntensity(type: string | undefined): string {
  if (!type) return "-";
  const map: Record<string, string> = {
    WARMUP: "Warm Up",
    ACTIVE: "Active",
    RECOVERY: "Recovery",
    REST: "Rest",
    COOLDOWN: "Cool Down",
    INTERVAL: "Interval",
    OTHER: "Other",
  };
  return map[type] ?? type.charAt(0) + type.slice(1).toLowerCase();
}

function TooltipRow({ label, value }: { label: string; value: string }) {
  if (!value || value === "-") return null;
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-medium tabular-nums">{value}</span>
    </div>
  );
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: SplitPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const lap = p.raw;

  return (
    <div className="min-w-[160px] rounded-lg border border-border/50 bg-background px-2 py-1.5 text-[10px] leading-tight shadow-xl">
      <div className="font-medium text-[11px]">Lap {lap.lapIndex}</div>
      <div className="text-muted-foreground">{formatIntensity(lap.intensityType)}</div>

      <div className="mt-1 grid gap-px">
        <TooltipRow label="Distance" value={`${Math.round(lap.distance)} m`} />
        <TooltipRow label="Pace" value={p.paceFormatted !== "-" ? `${p.paceFormatted} /km` : "-"} />
        {lap.averageHR != null && lap.averageHR > 0 && (
          <TooltipRow
            label="HR"
            value={`${Math.round(lap.averageHR)}${lap.maxHR ? ` / ${Math.round(lap.maxHR)}` : ""} bpm`}
          />
        )}
        {lap.averageRunCadence != null && lap.averageRunCadence > 0 && (
          <TooltipRow label="Cadence" value={`${Math.round(lap.averageRunCadence)} spm`} />
        )}
        {lap.averagePower != null && lap.averagePower > 0 && (
          <TooltipRow label="Power" value={`${Math.round(lap.averagePower)} W`} />
        )}
        {lap.calories != null && lap.calories > 0 && (
          <TooltipRow label="Calories" value={`${Math.round(lap.calories)} kcal`} />
        )}
      </div>
    </div>
  );
}

export function SplitsChart({
  callTool,
}: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [laps, setLaps] = useState<RawLap[]>([]);
  const [activityName, setActivityName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Step 1: Get the most recent activity to find its ID
      const activitiesResult = await callTool("get-activities", { start: 0, limit: 1 });
      if (!Array.isArray(activitiesResult) || activitiesResult.length === 0) {
        setError("No activities found");
        return;
      }

      const activity = activitiesResult[0] as Record<string, unknown>;
      const activityId = String(activity.activityId ?? "");
      if (!activityId) {
        setError("Activity has no ID");
        return;
      }

      setActivityName((activity.activityName as string) ?? null);

      // Step 2: Fetch splits for that activity
      const splitsResult = await callTool("get-activity-splits", { activityId });
      if (!splitsResult || typeof splitsResult !== "object") {
        setError("No splits data available");
        return;
      }

      const lapDTOs = (splitsResult as Record<string, unknown>).lapDTOs;
      if (!Array.isArray(lapDTOs) || lapDTOs.length === 0) {
        setLaps([]);
        return;
      }

      setLaps(lapDTOs as unknown as RawLap[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load splits");
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const data: SplitPoint[] = useMemo(() => {
    return laps.map((lap) => {
      const paceSeconds = lap.averageSpeed > 0 ? speedToPaceSeconds(lap.averageSpeed) : null;
      const paceFormatted = paceSeconds != null ? formatPace(paceSeconds) : "-";
      const avgHR = lap.averageHR != null && lap.averageHR > 0 ? lap.averageHR : null;

      return {
        label: String(lap.lapIndex),
        paceSeconds,
        paceFormatted,
        avgHR,
        raw: lap,
      };
    });
  }, [laps]);

  // Compute Y-axis domain for pace (reversed: lower = faster = top)
  const paceDomain = useMemo(() => {
    const paces = data.map((d) => d.paceSeconds).filter((p): p is number => p != null && p > 0);
    if (paces.length === 0) return [0, 600];
    const min = Math.min(...paces);
    const max = Math.max(...paces);
    // Add 10% padding on each side
    const padding = (max - min) * 0.15 || 30;
    return [Math.max(0, Math.floor(min - padding)), Math.ceil(max + padding)];
  }, [data]);

  const hrDomain = useMemo(() => {
    const hrs = data.map((d) => d.avgHR).filter((h): h is number => h != null && h > 0);
    if (hrs.length === 0) return [60, 200];
    const min = Math.min(...hrs);
    const max = Math.max(...hrs);
    const padding = (max - min) * 0.15 || 10;
    return [Math.max(0, Math.floor(min - padding)), Math.ceil(max + padding)];
  }, [data]);

  const title = activityName ? `Splits — ${activityName}` : "Activity Splits";

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ backgroundColor: "var(--color-pace, var(--chart-1))" }}
            />
            Pace
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-[2px]"
              style={{ backgroundColor: "var(--color-avgHR, var(--chart-3))" }}
            />
            Avg HR
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Loading splits...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No splits data available
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
            <ComposedChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="fill-pace" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-pace, var(--chart-1))"
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-pace, var(--chart-1))"
                    stopOpacity={0.3}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                padding={{ left: 8, right: 8 }}
              />
              <YAxis
                yAxisId="pace"
                tickLine={false}
                axisLine={false}
                reversed
                domain={paceDomain}
                tickFormatter={(v: number) => formatPace(v)}
              />
              <YAxis
                yAxisId="hr"
                orientation="right"
                tickLine={false}
                axisLine={false}
                domain={hrDomain}
                tickFormatter={(v: number) => `${v}`}
              />
              <ChartTooltip cursor={false} content={<CustomTooltip />} />
              <Bar
                yAxisId="pace"
                dataKey="paceSeconds"
                name="Pace"
                fill="url(#fill-pace)"
                stroke="var(--color-pace, var(--chart-1))"
                strokeOpacity={0.3}
                strokeWidth={1}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
              <Line
                yAxisId="hr"
                dataKey="avgHR"
                name="Avg HR"
                stroke="var(--color-avgHR, var(--chart-3))"
                strokeWidth={2}
                dot={{ r: 2.5 }}
                type="monotone"
                connectNulls
              />
            </ComposedChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
