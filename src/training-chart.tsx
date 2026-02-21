import { useState, useEffect, useCallback, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

type RangeKey = "7d" | "14d" | "30d";

interface TrainingDataPoint {
  label: string;
  date: string;
  readiness: number | null;
  hrv: number | null;
  hrvStatus: string | null;
}

const RANGES: Record<RangeKey, { days: number; label: string }> = {
  "7d": { days: 7, label: "Last 7 days" },
  "14d": { days: 14, label: "Last 14 days" },
  "30d": { days: 30, label: "Last 30 days" },
};

const chartConfig = {
  readiness: { label: "Readiness", color: "var(--chart-1)" },
  hrv: { label: "HRV", color: "var(--chart-2)" },
} satisfies ChartConfig;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateLabel(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length === 3) return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
  return dateStr;
}

function readinessDescriptor(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  return "Poor";
}

function CustomTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: TrainingDataPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <div className="min-w-[150px] rounded-lg border border-border/50 bg-background px-2 py-1.5 text-[10px] leading-tight shadow-xl">
      <div className="font-medium text-[11px]">{p.date}</div>

      <div className="mt-1 grid gap-px">
        {p.readiness != null && (
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: "var(--color-readiness, var(--chart-1))" }}
              />
              Readiness
            </span>
            <span className="font-mono font-medium tabular-nums">
              {p.readiness} — {readinessDescriptor(p.readiness)}
            </span>
          </div>
        )}
        {p.hrv != null && (
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: "var(--color-hrv, var(--chart-2))" }}
              />
              HRV
            </span>
            <span className="font-mono font-medium tabular-nums">{p.hrv} ms</span>
          </div>
        )}
        {p.hrvStatus && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">HRV Status</span>
            <span className="font-medium capitalize">{p.hrvStatus.toLowerCase()}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function TrainingChart({
  callTool,
}: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [range, setRange] = useState<RangeKey>("14d");
  const [readinessRaw, setReadinessRaw] = useState<Record<string, unknown>[]>([]);
  const [hrvRaw, setHrvRaw] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (r: RangeKey) => {
      setLoading(true);
      setError(null);
      try {
        const totalDays = RANGES[r].days;
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - totalDays + 1);

        const startStr = formatDate(start);
        const endStr = formatDate(end);

        // Build date list for individual training readiness calls
        const dates: string[] = [];
        const cur = new Date(start);
        while (cur <= end) {
          dates.push(formatDate(cur));
          cur.setDate(cur.getDate() + 1);
        }

        // Fetch training readiness for each day individually
        const readinessPromises = dates.map((date) =>
          callTool("get-training-readiness", { date }).catch(() => null),
        );

        // Fetch HRV for the entire range in one call
        const hrvPromise = callTool("get-hrv", { startDate: startStr, endDate: endStr }).catch(
          () => null,
        );

        const [readinessResults, hrvResult] = await Promise.all([
          Promise.all(readinessPromises),
          hrvPromise,
        ]);

        // Collect readiness entries (each call returns an array or single object)
        const readinessEntries: Record<string, unknown>[] = [];
        for (const result of readinessResults) {
          if (Array.isArray(result)) {
            for (const item of result) {
              if (item && typeof item === "object") {
                readinessEntries.push(item as Record<string, unknown>);
              }
            }
          } else if (result && typeof result === "object") {
            readinessEntries.push(result);
          }
        }
        setReadinessRaw(readinessEntries);

        // HRV returns an array (or object with hrvSummaries/entries)
        let hrvEntries: Record<string, unknown>[] = [];
        if (Array.isArray(hrvResult)) {
          hrvEntries = hrvResult as Record<string, unknown>[];
        } else if (hrvResult && typeof hrvResult === "object") {
          const arr =
            (hrvResult as Record<string, unknown>).hrvSummaries ??
            (hrvResult as Record<string, unknown>).entries;
          if (Array.isArray(arr)) {
            hrvEntries = arr as Record<string, unknown>[];
          }
        }
        setHrvRaw(hrvEntries);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load training data");
      } finally {
        setLoading(false);
      }
    },
    [callTool],
  );

  useEffect(() => {
    fetchData(range);
  }, [range, fetchData]);

  const data: TrainingDataPoint[] = useMemo(() => {
    // Build lookup maps by date
    const readinessMap = new Map<string, Record<string, unknown>>();
    for (const entry of readinessRaw) {
      const d =
        (entry.calendarDate as string) ?? (entry.date as string) ?? (entry.startDate as string);
      if (d) readinessMap.set(d, entry);
    }

    const hrvMap = new Map<string, Record<string, unknown>>();
    for (const entry of hrvRaw) {
      const d = (entry.calendarDate as string) ?? (entry.date as string);
      if (d) hrvMap.set(d, entry);
    }

    // Collect all dates
    const allDates = new Set<string>([...readinessMap.keys(), ...hrvMap.keys()]);
    const sorted = [...allDates].sort();

    return sorted.map((dateStr) => {
      const rEntry = readinessMap.get(dateStr);
      const hEntry = hrvMap.get(dateStr);

      // Training readiness score
      let readiness: number | null = null;
      if (rEntry) {
        const score =
          (rEntry.score as number) ??
          (rEntry.trainingReadinessScore as number) ??
          (rEntry.level as number);
        if (score != null && score > 0) readiness = Math.round(score);
      }

      // HRV nightly value
      let hrv: number | null = null;
      let hrvStatus: string | null = null;
      if (hEntry) {
        const val =
          (hEntry.lastNightAvg as number) ??
          (hEntry.hrvValue as number) ??
          (hEntry.nightlyAvg as number) ??
          (hEntry.weeklyAvg as number);
        if (val != null && val > 0) hrv = Math.round(val);
        if (hEntry.status) hrvStatus = hEntry.status as string;
      }

      return {
        label: dateLabel(dateStr),
        date: dateStr,
        readiness,
        hrv,
        hrvStatus,
      };
    });
  }, [readinessRaw, hrvRaw]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Training Readiness & HRV</CardTitle>
        <div className="flex items-center gap-3">
          {/* Legend */}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: "var(--color-readiness, var(--chart-1))" }}
              />
              Readiness
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: "var(--color-hrv, var(--chart-2))" }}
              />
              HRV
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
            Loading training data...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No training data available
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
            <LineChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: -12 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                minTickGap={40}
                tickMargin={4}
                padding={{ left: 8, right: 8 }}
              />
              <YAxis yAxisId="readiness" tickLine={false} axisLine={false} domain={[0, 100]} />
              <YAxis
                yAxisId="hrv"
                orientation="right"
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `${v}ms`}
              />
              <ChartTooltip cursor={false} content={<CustomTooltip />} />
              <Line
                yAxisId="readiness"
                dataKey="readiness"
                stroke="var(--color-readiness)"
                strokeWidth={2}
                dot={{ r: 2.5 }}
                type="monotone"
                connectNulls
              />
              <Line
                yAxisId="hrv"
                dataKey="hrv"
                stroke="var(--color-hrv)"
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
  );
}
