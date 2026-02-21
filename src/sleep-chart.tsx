import { useState, useEffect, useCallback, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

type RangeKey = "7d" | "14d";

interface SleepDay {
  label: string;
  date: string;
  deep: number;
  light: number;
  rem: number;
  awake: number;
  totalSeconds: number;
  sleepScore: number | null;
}

const RANGES: Record<RangeKey, { days: number; label: string }> = {
  "7d": { days: 7, label: "Last 7 days" },
  "14d": { days: 14, label: "Last 14 days" },
};

const chartConfig = {
  deep: { label: "Deep", color: "var(--chart-4)" },
  light: { label: "Light", color: "var(--chart-2)" },
  rem: { label: "REM", color: "var(--chart-3)" },
  awake: { label: "Awake", color: "var(--chart-5)" },
} satisfies ChartConfig;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function secondsToHours(s: number): number {
  return s / 3600;
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "0h 0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function parseSleepData(raw: unknown): SleepDay | null {
  if (!raw || typeof raw !== "object") return null;

  const dto = (raw as Record<string, unknown>).dailySleepDTO as Record<string, unknown> | undefined;
  if (!dto) return null;

  const dateStr = (dto.calendarDate as string) ?? "";
  const parts = dateStr.split("-");
  const label =
    parts.length === 3 ? `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}` : dateStr;

  const deepSeconds = Number(dto.deepSleepSeconds ?? 0);
  const lightSeconds = Number(dto.lightSleepSeconds ?? 0);
  const remSeconds = Number(dto.remSleepSeconds ?? 0);
  const awakeSeconds = Number(dto.awakeSleepSeconds ?? 0);
  const totalSeconds = Number(dto.sleepTimeSeconds ?? 0);

  // Extract sleep score
  let sleepScore: number | null = null;
  const scores = dto.sleepScores as Record<string, unknown> | undefined;
  if (scores) {
    const overall = scores.overall as Record<string, unknown> | undefined;
    if (overall && overall.value != null) {
      sleepScore = Number(overall.value);
    }
  }

  // Skip days with no sleep data
  if (totalSeconds === 0 && deepSeconds === 0 && lightSeconds === 0 && remSeconds === 0) {
    return null;
  }

  return {
    label,
    date: dateStr,
    deep: secondsToHours(deepSeconds),
    light: secondsToHours(lightSeconds),
    rem: secondsToHours(remSeconds),
    awake: secondsToHours(awakeSeconds),
    totalSeconds,
    sleepScore,
  };
}

function TooltipRow({
  label,
  value,
  colorVar,
}: {
  label: string;
  value: string;
  colorVar?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {colorVar && (
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
            style={{ backgroundColor: colorVar }}
          />
        )}
        {label}
      </span>
      <span className="font-mono font-medium tabular-nums">{value}</span>
    </div>
  );
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: SleepDay }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <div className="min-w-[160px] rounded-lg border border-border/50 bg-background px-2 py-1.5 text-[10px] leading-tight shadow-xl">
      <div className="font-medium text-[11px]">
        {p.date}
        {p.sleepScore != null && (
          <span className="ml-1.5 text-muted-foreground font-normal">Score: {p.sleepScore}</span>
        )}
      </div>

      <div className="mt-1 grid gap-px">
        <TooltipRow
          label="Deep"
          value={formatDuration(p.deep * 3600)}
          colorVar="var(--color-deep, var(--chart-4))"
        />
        <TooltipRow
          label="Light"
          value={formatDuration(p.light * 3600)}
          colorVar="var(--color-light, var(--chart-2))"
        />
        <TooltipRow
          label="REM"
          value={formatDuration(p.rem * 3600)}
          colorVar="var(--color-rem, var(--chart-3))"
        />
        <TooltipRow
          label="Awake"
          value={formatDuration(p.awake * 3600)}
          colorVar="var(--color-awake, var(--chart-5))"
        />
      </div>

      <div className="mt-1 border-t border-border/50 pt-1">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Total</span>
          <span className="font-mono font-medium tabular-nums">
            {formatDuration(p.totalSeconds)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function SleepChart({
  callTool,
}: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [range, setRange] = useState<RangeKey>("7d");
  const [data, setData] = useState<SleepDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSleep = useCallback(
    async (r: RangeKey) => {
      setLoading(true);
      setError(null);
      try {
        const totalDays = RANGES[r].days;
        const dates: string[] = [];
        for (let i = totalDays - 1; i >= 0; i--) {
          const d = new Date();
          d.setDate(d.getDate() - i);
          dates.push(formatDate(d));
        }

        const results = await Promise.all(dates.map((date) => callTool("get-sleep", { date })));

        const parsed: SleepDay[] = [];
        for (const result of results) {
          const day = parseSleepData(result);
          if (day) parsed.push(day);
        }

        // Sort chronologically
        parsed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        setData(parsed);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load sleep data");
      } finally {
        setLoading(false);
      }
    },
    [callTool],
  );

  useEffect(() => {
    fetchSleep(range);
  }, [range, fetchSleep]);

  // Reverse data for vertical layout (newest at top)
  const chartData = useMemo(() => [...data].reverse(), [data]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Sleep</CardTitle>
        <div className="flex items-center gap-3">
          {/* Legend */}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: "var(--color-deep, var(--chart-4))" }}
              />
              Deep
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: "var(--color-light, var(--chart-2))" }}
              />
              Light
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: "var(--color-rem, var(--chart-3))" }}
              />
              REM
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: "var(--color-awake, var(--chart-5))" }}
              />
              Awake
            </span>
          </div>
          <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
            {(Object.keys(RANGES) as RangeKey[]).map((key) => (
              <option key={key} value={key}>
                {RANGES[key].label}
              </option>
            ))}
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Loading sleep data...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No sleep data available
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
              barCategoryGap="20%"
            >
              <CartesianGrid horizontal={false} />
              <YAxis
                dataKey="label"
                type="category"
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                width={36}
              />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => `${Math.round(v)}h`}
              />
              <ChartTooltip cursor={false} content={<CustomTooltip />} />
              <Bar
                dataKey="deep"
                stackId="sleep"
                fill="var(--color-deep, var(--chart-4))"
                fillOpacity={0.6}
                radius={[0, 0, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                dataKey="light"
                stackId="sleep"
                fill="var(--color-light, var(--chart-2))"
                fillOpacity={0.6}
                radius={[0, 0, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                dataKey="rem"
                stackId="sleep"
                fill="var(--color-rem, var(--chart-3))"
                fillOpacity={0.6}
                radius={[0, 0, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                dataKey="awake"
                stackId="sleep"
                fill="var(--color-awake, var(--chart-5))"
                fillOpacity={0.6}
                radius={[0, 0, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
