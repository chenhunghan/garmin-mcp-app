import { useState, useEffect, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

type RangeKey = "7d" | "14d" | "30d";

interface StepDay {
  label: string;
  date: string;
  steps: number;
}

const RANGES: Record<RangeKey, { days: number; label: string }> = {
  "7d": { days: 7, label: "Last 7 days" },
  "14d": { days: 14, label: "Last 14 days" },
  "30d": { days: 30, label: "Last 30 days" },
};

const chartConfig = {
  steps: {
    label: "Steps",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function transformStepsData(raw: unknown): StepDay[] {
  if (!Array.isArray(raw)) return [];

  const sorted = [...raw].sort((a, b) => {
    const da = a?.calendarDate ?? a?.date ?? "";
    const db = b?.calendarDate ?? b?.date ?? "";
    return da < db ? -1 : da > db ? 1 : 0;
  });

  return sorted.map((entry) => {
    const dateStr: string = entry?.calendarDate ?? entry?.date ?? "";
    const steps = Number(entry?.totalSteps ?? entry?.steps ?? 0);
    const parts = dateStr.split("-");
    const label =
      parts.length === 3 ? `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}` : dateStr;
    return { label, date: dateStr, steps };
  });
}

export function StepsChart({
  callTool,
}: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [range, setRange] = useState<RangeKey>("7d");
  const [data, setData] = useState<StepDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSteps = useCallback(
    async (r: RangeKey) => {
      setLoading(true);
      setError(null);
      try {
        const totalDays = RANGES[r].days;
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - totalDays + 1);

        const MAX_RANGE = 28;
        const chunks: { start: Date; end: Date }[] = [];
        const cur = new Date(start);
        while (cur <= end) {
          const chunkEnd = new Date(cur);
          chunkEnd.setDate(cur.getDate() + MAX_RANGE - 1);
          if (chunkEnd > end) chunkEnd.setTime(end.getTime());
          chunks.push({ start: new Date(cur), end: new Date(chunkEnd) });
          cur.setDate(chunkEnd.getDate() + 1);
        }

        const results = await Promise.all(
          chunks.map((c) =>
            callTool("get-steps", { date: formatDate(c.start), endDate: formatDate(c.end) }),
          ),
        );

        const merged = results.flatMap((r) => (Array.isArray(r) ? r : []));
        const transformed = transformStepsData(merged);
        setData(transformed);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load steps");
      } finally {
        setLoading(false);
      }
    },
    [callTool],
  );

  useEffect(() => {
    fetchSteps(range);
  }, [range, fetchSteps]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Daily Steps</CardTitle>
        <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
          {(Object.keys(RANGES) as RangeKey[]).map((key) => (
            <option key={key} value={key}>
              {RANGES[key].label}
            </option>
          ))}
        </Select>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Loading steps...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No step data available
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
            <AreaChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="fillSteps" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-steps)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-steps)" stopOpacity={0.1} />
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
              <YAxis
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <ReferenceLine
                y={10000}
                stroke="var(--color-chart-3)"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                label={{
                  value: "10k goal",
                  position: "insideTopRight",
                  fontSize: 10,
                  fill: "var(--color-muted-foreground)",
                }}
              />
              <Area
                dataKey="steps"
                name="Steps"
                type="basis"
                fill="url(#fillSteps)"
                stroke="var(--color-steps)"
                strokeWidth={2}
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
