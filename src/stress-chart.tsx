import { useState, useEffect, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

interface StressPoint {
  time: string;
  timestamp: number;
  stress: number;
}

const chartConfig = {
  stress: {
    label: "Stress",
    color: "var(--chart-5)",
  },
} satisfies ChartConfig;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getStressCategory(level: number): string {
  if (level <= 25) return "Rest";
  if (level <= 50) return "Low";
  if (level <= 75) return "Medium";
  return "High";
}

function transformStressData(raw: unknown): StressPoint[] {
  if (!raw || typeof raw !== "object") return [];

  const obj = raw as Record<string, unknown>;
  const values = obj.stressValuesArray;
  if (!Array.isArray(values)) return [];

  const points: StressPoint[] = [];
  for (const entry of values) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [timestampMs, level] = entry;
    // Filter out negative values (rest/sleep markers)
    if (typeof level !== "number" || level < 0) continue;
    if (typeof timestampMs !== "number") continue;

    const date = new Date(timestampMs);
    const hours = date.getHours().toString().padStart(2, "0");
    const minutes = date.getMinutes().toString().padStart(2, "0");

    points.push({
      time: `${hours}:${minutes}`,
      timestamp: timestampMs,
      stress: level,
    });
  }

  // Sort by timestamp
  points.sort((a, b) => a.timestamp - b.timestamp);
  return points;
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: StressPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <div className="min-w-[140px] rounded-lg border border-border/50 bg-background px-2 py-1.5 text-[10px] leading-tight shadow-xl">
      <div className="font-medium text-[11px]">{p.time}</div>
      <div className="mt-1 grid gap-px">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: "var(--color-stress, var(--chart-5))" }}
            />
            Stress
          </span>
          <span className="font-mono font-medium tabular-nums">{p.stress}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Category</span>
          <span className="font-medium">{getStressCategory(p.stress)}</span>
        </div>
      </div>
    </div>
  );
}

export function StressChart({
  callTool,
}: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [data, setData] = useState<StressPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ avg: number; max: number } | null>(null);

  const fetchStress = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const today = formatDate(new Date());
      const result = await callTool("get-stress", { date: today });

      const transformed = transformStressData(result);
      setData(transformed);

      // Extract summary stats from raw response
      if (result && typeof result === "object") {
        const obj = result as Record<string, unknown>;
        const avg = Number(obj.avgStressLevel ?? 0);
        const max = Number(obj.maxStressLevel ?? 0);
        if (avg > 0 || max > 0) {
          setSummary({ avg, max });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stress data");
    } finally {
      setLoading(false);
    }
  }, [callTool]);

  useEffect(() => {
    fetchStress();
  }, [fetchStress]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Stress</CardTitle>
        {summary && (
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>Avg: {summary.avg}</span>
            <span>Max: {summary.max}</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Loading stress data...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No stress data available
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
            <AreaChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="fillStress" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor="var(--color-stress, var(--chart-5))"
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor="var(--color-stress, var(--chart-5))"
                    stopOpacity={0.1}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="time"
                tickLine={false}
                axisLine={false}
                minTickGap={40}
                tickMargin={4}
                padding={{ left: 8, right: 8 }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
              />
              <ChartTooltip cursor={false} content={<CustomTooltip />} />
              <ReferenceLine
                y={25}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
                strokeWidth={1}
                strokeOpacity={0.3}
              />
              <ReferenceLine
                y={50}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
                strokeWidth={1}
                strokeOpacity={0.3}
              />
              <ReferenceLine
                y={75}
                stroke="var(--color-muted-foreground)"
                strokeDasharray="4 4"
                strokeWidth={1}
                strokeOpacity={0.3}
              />
              <Area
                dataKey="stress"
                name="Stress"
                type="basis"
                fill="url(#fillStress)"
                stroke="var(--color-stress, var(--chart-5))"
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
