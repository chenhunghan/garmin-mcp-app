import { useState, useEffect, useCallback, useMemo } from "react";
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

type CallToolFn = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

// --- Data types for the training context response ---

interface RawRunActivity {
  activityId: number;
  activityName: string;
  activityType: { typeKey: string };
  startTimeLocal: string;
  distance: number;
  duration: number;
  movingDuration: number;
  averageSpeed: number;
  averageHR: number;
  maxHR: number;
}

interface WeeklyVolume {
  distanceKm: number;
  durationHours: number;
  count: number;
}

interface HrvEntry {
  calendarDate?: string;
  date?: string;
  lastNightAvg?: number;
  hrvValue?: number;
  nightlyAvg?: number;
  weeklyAvg?: number;
}

interface BodyBatteryEntry {
  calendarDate?: string;
  date?: string;
  charged?: number;
  drained?: number;
  startTimestampLocal?: string;
  endTimestampLocal?: string;
  [key: string]: unknown;
}

interface TrainingContext {
  recentRuns: RawRunActivity[];
  daysSinceLastRun: number | null;
  weeklyVolume: WeeklyVolume | null;
  sleep: unknown;
  hrv: HrvEntry[] | { hrvSummaries?: HrvEntry[]; entries?: HrvEntry[] } | null;
  trainingReadiness: { score?: number; trainingReadinessScore?: number; level?: number } | null;
  bodyBattery:
    | BodyBatteryEntry[]
    | { entries?: BodyBatteryEntry[]; days?: BodyBatteryEntry[] }
    | null;
  vo2Max: unknown;
  trainingStatus: { trainingStatus?: string; status?: string } | null;
}

// --- Chart configs ---

const hrvChartConfig = {
  hrv: { label: "HRV", color: "var(--chart-2)" },
} satisfies ChartConfig;

const bodyBatteryChartConfig = {
  bodyBattery: { label: "Body Battery", color: "var(--chart-1)" },
} satisfies ChartConfig;

// --- Utility functions ---

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateLabel(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length === 3) return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
  return dateStr;
}

function formatDistance(meters: number): string {
  if (!meters || meters <= 0) return "N/A";
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatPace(averageSpeed: number): string {
  if (!averageSpeed || averageSpeed <= 0) return "-";
  const paceMin = 1000 / averageSpeed / 60;
  const mins = Math.floor(paceMin);
  const secs = Math.round((paceMin - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, "0")} /km`;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "-";
  const totalSec = Math.round(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatShortDate(dateStr: string): string {
  if (!dateStr) return "-";
  const d = dateStr.slice(0, 10);
  const parts = d.split("-");
  if (parts.length === 3) {
    return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
  }
  return d;
}

function getReadinessColor(score: number | null): string {
  if (score == null) return "var(--chart-1)";
  if (score > 60) return "var(--chart-2)";
  if (score >= 40) return "var(--chart-1)";
  return "var(--chart-5)";
}

function getReadinessLabel(score: number | null): string {
  if (score == null) return "N/A";
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  return "Poor";
}

// --- Metric Card subcomponent ---

function MetricCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-xs text-muted-foreground font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-0">{children}</CardContent>
    </Card>
  );
}

// --- Main component ---

export function RunPlanner({ callTool }: { callTool: CallToolFn }) {
  const [data, setData] = useState<TrainingContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const today = formatDate(new Date());
      const result = await callTool("get-training-context", { date: today });
      if (result) {
        setData(result as unknown as TrainingContext);
      } else {
        setError("No data returned");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load training context");
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Parse training readiness score
  const readinessScore = useMemo(() => {
    if (!data?.trainingReadiness) return null;
    const tr = data.trainingReadiness;
    const score = tr.score ?? tr.trainingReadinessScore ?? tr.level;
    if (score != null && score > 0) return Math.round(score);
    return null;
  }, [data]);

  // Parse training status string
  const trainingStatus = useMemo(() => {
    if (!data?.trainingStatus) return "N/A";
    const ts = data.trainingStatus;
    return ts.trainingStatus ?? ts.status ?? "N/A";
  }, [data]);

  // Parse HRV data for chart
  const hrvData = useMemo(() => {
    if (!data?.hrv) return [];
    let entries: HrvEntry[] = [];
    if (Array.isArray(data.hrv)) {
      entries = data.hrv;
    } else if (data.hrv && typeof data.hrv === "object") {
      const obj = data.hrv as { hrvSummaries?: HrvEntry[]; entries?: HrvEntry[] };
      entries = obj.hrvSummaries ?? obj.entries ?? [];
    }
    return entries
      .map((e) => {
        const dateStr = e.calendarDate ?? e.date ?? "";
        const value = e.lastNightAvg ?? e.hrvValue ?? e.nightlyAvg ?? e.weeklyAvg;
        if (!dateStr || value == null || value <= 0) return null;
        return {
          label: dateLabel(dateStr),
          date: dateStr,
          hrv: Math.round(value),
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a!.date < b!.date ? -1 : a!.date > b!.date ? 1 : 0)) as Array<{
      label: string;
      date: string;
      hrv: number;
    }>;
  }, [data]);

  // Parse body battery data for chart
  const bodyBatteryData = useMemo(() => {
    if (!data?.bodyBattery) return [];
    let entries: BodyBatteryEntry[] = [];
    if (Array.isArray(data.bodyBattery)) {
      entries = data.bodyBattery;
    } else if (data.bodyBattery && typeof data.bodyBattery === "object") {
      const obj = data.bodyBattery as { entries?: BodyBatteryEntry[]; days?: BodyBatteryEntry[] };
      entries = obj.entries ?? obj.days ?? [];
    }
    return entries
      .map((e) => {
        const dateStr = e.calendarDate ?? e.date ?? "";
        // Body battery "charged" is typically the max value for the day
        const value = e.charged;
        if (!dateStr || value == null || value <= 0) return null;
        return {
          label: dateLabel(dateStr),
          date: dateStr,
          bodyBattery: Math.round(value),
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a!.date < b!.date ? -1 : a!.date > b!.date ? 1 : 0)) as Array<{
      label: string;
      date: string;
      bodyBattery: number;
    }>;
  }, [data]);

  // Parse recent runs
  const recentRuns = useMemo(() => {
    if (!data?.recentRuns || !Array.isArray(data.recentRuns)) return [];
    return data.recentRuns.slice(0, 10);
  }, [data]);

  // --- Loading state ---
  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Loading training context...
          </div>
        </CardContent>
      </Card>
    );
  }

  // --- Error state ---
  if (error) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Run Planner</CardTitle>
        </CardHeader>
      </Card>

      {/* Top row — 4 metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Training Readiness */}
        <MetricCard title="Training Readiness">
          <div className="flex items-baseline gap-2">
            <span
              className="text-2xl font-bold font-mono tabular-nums"
              style={{ color: getReadinessColor(readinessScore) }}
            >
              {readinessScore ?? "N/A"}
            </span>
            {readinessScore != null && (
              <span className="text-xs text-muted-foreground">
                {getReadinessLabel(readinessScore)}
              </span>
            )}
          </div>
        </MetricCard>

        {/* Days Since Last Run */}
        <MetricCard title="Days Since Last Run">
          <div className="flex items-baseline gap-1">
            <span className="text-2xl font-bold font-mono tabular-nums text-foreground">
              {data?.daysSinceLastRun != null ? data.daysSinceLastRun : "N/A"}
            </span>
            {data?.daysSinceLastRun != null && (
              <span className="text-xs text-muted-foreground">
                {data.daysSinceLastRun === 1 ? "day" : "days"}
              </span>
            )}
          </div>
        </MetricCard>

        {/* Weekly Volume */}
        <MetricCard title="Weekly Volume">
          <div className="flex flex-col">
            <span className="text-2xl font-bold font-mono tabular-nums text-foreground">
              {data?.weeklyVolume?.distanceKm != null
                ? `${data.weeklyVolume.distanceKm.toFixed(1)} km`
                : "N/A"}
            </span>
            {data?.weeklyVolume?.count != null && (
              <span className="text-xs text-muted-foreground">
                {data.weeklyVolume.count} {data.weeklyVolume.count === 1 ? "run" : "runs"}
              </span>
            )}
          </div>
        </MetricCard>

        {/* Training Status */}
        <MetricCard title="Training Status">
          <span className="text-2xl font-bold text-foreground">{trainingStatus}</span>
        </MetricCard>
      </div>

      {/* Middle section — Recent Runs table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent Runs</CardTitle>
        </CardHeader>
        <CardContent>
          {recentRuns.length === 0 ? (
            <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
              No recent runs
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="text-left py-2 pr-3 font-medium text-muted-foreground">Date</th>
                    <th className="text-left py-2 pr-3 font-medium text-muted-foreground">Name</th>
                    <th className="text-right py-2 pr-3 font-medium text-muted-foreground">
                      Distance
                    </th>
                    <th className="text-right py-2 pr-3 font-medium text-muted-foreground">Pace</th>
                    <th className="text-right py-2 pr-3 font-medium text-muted-foreground">
                      Duration
                    </th>
                    <th className="text-right py-2 font-medium text-muted-foreground">Avg HR</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => (
                    <tr key={run.activityId} className="border-b border-border/50 last:border-0">
                      <td className="py-2 pr-3 text-muted-foreground">
                        {formatShortDate(run.startTimeLocal)}
                      </td>
                      <td className="py-2 pr-3 text-foreground font-medium max-w-[140px] truncate">
                        {run.activityName ?? "Run"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums text-foreground">
                        {formatDistance(run.distance)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums text-foreground">
                        {formatPace(run.averageSpeed)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums text-foreground">
                        {formatDuration(run.duration)}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums text-foreground">
                        {run.averageHR > 0 ? `${Math.round(run.averageHR)} bpm` : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bottom section — two charts side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* HRV Trend */}
        <Card>
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">HRV Trend</CardTitle>
            <span className="text-[11px] text-muted-foreground">Last 14 days</span>
          </CardHeader>
          <CardContent>
            {hrvData.length === 0 ? (
              <div className="flex items-center justify-center h-[160px] text-sm text-muted-foreground">
                No HRV data available
              </div>
            ) : (
              <ChartContainer config={hrvChartConfig} className="aspect-auto h-[160px] w-full">
                <LineChart data={hrvData} margin={{ top: 4, right: 16, bottom: 0, left: -12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={40}
                    tickMargin={4}
                    padding={{ left: 8, right: 8 }}
                  />
                  <YAxis tickLine={false} axisLine={false} tickFormatter={(v) => `${v}ms`} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                  <Line
                    dataKey="hrv"
                    stroke="var(--color-hrv, var(--chart-2))"
                    strokeWidth={2}
                    dot={{ r: 2.5 }}
                    type="monotone"
                    connectNulls
                  />
                </LineChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Body Battery Trend */}
        <Card>
          <CardHeader className="flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm">Body Battery Trend</CardTitle>
            <span className="text-[11px] text-muted-foreground">Last 7 days</span>
          </CardHeader>
          <CardContent>
            {bodyBatteryData.length === 0 ? (
              <div className="flex items-center justify-center h-[160px] text-sm text-muted-foreground">
                No body battery data available
              </div>
            ) : (
              <ChartContainer
                config={bodyBatteryChartConfig}
                className="aspect-auto h-[160px] w-full"
              >
                <AreaChart
                  data={bodyBatteryData}
                  margin={{ top: 4, right: 16, bottom: 0, left: -12 }}
                >
                  <defs>
                    <linearGradient id="fillBodyBattery" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="5%"
                        stopColor="var(--color-bodyBattery, var(--chart-1))"
                        stopOpacity={0.8}
                      />
                      <stop
                        offset="95%"
                        stopColor="var(--color-bodyBattery, var(--chart-1))"
                        stopOpacity={0.1}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={40}
                    tickMargin={4}
                    padding={{ left: 8, right: 8 }}
                  />
                  <YAxis tickLine={false} axisLine={false} domain={[0, 100]} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                  <Area
                    dataKey="bodyBattery"
                    name="Body Battery"
                    type="monotone"
                    fill="url(#fillBodyBattery)"
                    stroke="var(--color-bodyBattery, var(--chart-1))"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
