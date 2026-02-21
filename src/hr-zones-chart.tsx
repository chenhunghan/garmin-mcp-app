import { useState, useEffect, useCallback } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Cell } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

interface RawHrZone {
  zoneNumber: number;
  secsInZone: number;
  zoneLowBoundary: number;
}

interface HrZonePoint {
  zone: string;
  zoneNumber: number;
  seconds: number;
  minutes: number;
  zoneLowBoundary: number;
  formatted: string;
  percentage: number;
}

const ZONE_COLORS = [
  "var(--chart-2)", // Zone 1 — teal/green
  "var(--chart-1)", // Zone 2 — orange/blue
  "var(--chart-3)", // Zone 3 — blue
  "var(--chart-4)", // Zone 4 — purple
  "var(--chart-5)", // Zone 5 — red-orange
];

const chartConfig = {
  minutes: { label: "Time", color: "var(--chart-1)" },
} satisfies ChartConfig;

function formatSecsToMMSS(secs: number): string {
  const totalSecs = Math.round(secs);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0:00";
  const totalSecs = Math.round(seconds);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: HrZonePoint }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <div className="min-w-[160px] rounded-lg border border-border/50 bg-background px-2 py-1.5 text-[10px] leading-tight shadow-xl">
      <div className="font-medium text-[11px]">Zone {p.zoneNumber}</div>
      <div className="text-muted-foreground">{p.zoneLowBoundary}+ bpm</div>

      <div className="mt-1 grid gap-px">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: ZONE_COLORS[p.zoneNumber - 1] ?? ZONE_COLORS[0] }}
            />
            Time
          </span>
          <span className="font-mono font-medium tabular-nums">{formatDuration(p.seconds)}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">% of total</span>
          <span className="font-mono font-medium tabular-nums">{p.percentage.toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}

export function HrZonesChart({
  callTool,
}: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [data, setData] = useState<HrZonePoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activityName, setActivityName] = useState<string | null>(null);
  const [totalSeconds, setTotalSeconds] = useState(0);

  const fetchHrZones = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch most recent activity
      const activitiesResult = await callTool("get-activities", { start: 0, limit: 1 });
      if (!Array.isArray(activitiesResult) || activitiesResult.length === 0) {
        setError("No activities found");
        return;
      }

      const activity = activitiesResult[0] as Record<string, unknown>;
      const activityId = String(activity.activityId ?? "");
      const name = (activity.activityName as string) ?? "Activity";
      setActivityName(name);

      if (!activityId) {
        setError("No activity ID found");
        return;
      }

      // Fetch HR zones for that activity
      const zonesResult = await callTool("get-activity-hr-zones", { activityId });
      if (!Array.isArray(zonesResult) || zonesResult.length === 0) {
        setError("No HR zone data available for this activity");
        return;
      }

      const zones = zonesResult as unknown as RawHrZone[];
      const total = zones.reduce((sum, z) => sum + (z.secsInZone ?? 0), 0);
      setTotalSeconds(total);

      const points: HrZonePoint[] = zones.map((z) => ({
        zone: `Zone ${z.zoneNumber} (${z.zoneLowBoundary}+ bpm)`,
        zoneNumber: z.zoneNumber,
        seconds: z.secsInZone,
        minutes: z.secsInZone / 60,
        zoneLowBoundary: z.zoneLowBoundary,
        formatted: formatSecsToMMSS(z.secsInZone),
        percentage: total > 0 ? (z.secsInZone / total) * 100 : 0,
      }));

      setData(points);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load HR zone data");
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  useEffect(() => {
    fetchHrZones();
  }, [fetchHrZones]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">
          HR Zones{activityName ? ` — ${activityName}` : ""}
        </CardTitle>
        {totalSeconds > 0 && (
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>Total: {formatDuration(totalSeconds)}</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Loading HR zone data...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No HR zone data available
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: 48, bottom: 0, left: 0 }}
              barCategoryGap="20%"
            >
              <CartesianGrid horizontal={false} />
              <YAxis
                dataKey="zone"
                type="category"
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                width={140}
                tick={{ fontSize: 11 }}
              />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `${Math.round(v)}m`}
              />
              <ChartTooltip cursor={false} content={<CustomTooltip />} />
              <Bar
                dataKey="minutes"
                radius={[0, 4, 4, 0]}
                fillOpacity={0.7}
                isAnimationActive={false}
                label={{
                  position: "right" as const,
                  fontSize: 11,
                  fill: "var(--foreground)",
                  formatter: (value) => {
                    const mins = Number(value ?? 0);
                    const totalSecs = Math.round(mins * 60);
                    const m = Math.floor(totalSecs / 60);
                    const s = totalSecs % 60;
                    return `${m}:${s.toString().padStart(2, "0")}`;
                  },
                }}
              >
                {data.map((entry) => (
                  <Cell
                    key={entry.zoneNumber}
                    fill={ZONE_COLORS[entry.zoneNumber - 1] ?? ZONE_COLORS[0]}
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
