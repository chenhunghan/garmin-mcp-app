import { useState, useEffect, useCallback } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, ReferenceLine } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Button } from "@/components/ui/button.tsx";

type RangeKey = "7d" | "14d" | "30d";

interface StepDay {
  label: string;
  date: string;
  steps: number;
  avg: number | null;
}

const RANGES: Record<RangeKey, { days: number; label: string }> = {
  "7d": { days: 7, label: "7d" },
  "14d": { days: 14, label: "14d" },
  "30d": { days: 30, label: "30d" },
};

const chartConfig = {
  steps: {
    label: "Steps",
    color: "var(--chart-1)",
  },
  avg: {
    label: "7-day avg",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function labelInterval(range: RangeKey): number {
  if (range === "7d") return 0;
  if (range === "14d") return 1;
  return 3;
}

function transformStepsData(raw: unknown): StepDay[] {
  if (!Array.isArray(raw)) return [];

  const sorted = [...raw].sort((a, b) => {
    const da = a?.calendarDate ?? a?.date ?? "";
    const db = b?.calendarDate ?? b?.date ?? "";
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const days: StepDay[] = sorted.map((entry) => {
    const dateStr: string = entry?.calendarDate ?? entry?.date ?? "";
    const steps = Number(entry?.totalSteps ?? entry?.steps ?? 0);
    const parts = dateStr.split("-");
    const label =
      parts.length === 3 ? `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}` : dateStr;
    return { label, date: dateStr, steps, avg: null };
  });

  for (let i = 0; i < days.length; i++) {
    const window = days.slice(Math.max(0, i - 6), i + 1);
    if (window.length >= 3) {
      const sum = window.reduce((s, d) => s + d.steps, 0);
      days[i].avg = Math.round(sum / window.length);
    }
  }

  return days;
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
    <div>
      <div className="flex items-center justify-between pb-2">
        <div className="text-sm font-semibold">Daily Steps</div>
        <div className="flex gap-1">
          {(Object.keys(RANGES) as RangeKey[]).map((key) => (
            <Button
              key={key}
              variant={range === key ? "default" : "secondary"}
              size="sm"
              onClick={() => setRange(key)}
            >
              {RANGES[key].label}
            </Button>
          ))}
        </div>
      </div>
      <div>
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
            <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                interval={labelInterval(range)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <ReferenceLine
                y={10000}
                stroke="var(--color-chart-3)"
                strokeDasharray="4 4"
                strokeWidth={1.5}
                label={{
                  value: "10k goal",
                  position: "right",
                  fontSize: 10,
                  fill: "var(--color-muted-foreground)",
                }}
              />
              <Bar
                dataKey="steps"
                name="Steps"
                fill="var(--color-steps)"
                radius={[3, 3, 0, 0]}
                barSize={range === "30d" ? 8 : 16}
              />
              <Line
                dataKey="avg"
                name="7-day avg"
                stroke="var(--color-avg)"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </ComposedChart>
          </ChartContainer>
        )}
      </div>
    </div>
  );
}
