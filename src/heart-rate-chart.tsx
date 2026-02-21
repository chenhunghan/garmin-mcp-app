import { useState, useEffect, useCallback, useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

type RangeKey = "7d" | "14d" | "30d";

const RANGES: Record<RangeKey, { days: number; label: string }> = {
  "7d": { days: 7, label: "Last 7 days" },
  "14d": { days: 14, label: "Last 14 days" },
  "30d": { days: 30, label: "Last 30 days" },
};

const chartConfig = {
  restingHR: { label: "Resting HR", color: "var(--chart-3)" },
  bodyBattery: { label: "Body Battery", color: "var(--chart-2)" },
} satisfies ChartConfig;

interface DayData {
  label: string;
  date: string;
  restingHR: number | null;
  minHR: number | null;
  maxHR: number | null;
  bbCharged: number | null;
  bbDrained: number | null;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dateLabel(dateStr: string): string {
  const parts = dateStr.split("-");
  return parts.length === 3 ? `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}` : dateStr;
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
  payload?: Array<{ payload: DayData }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;

  return (
    <div className="min-w-[150px] rounded-lg border border-border/50 bg-background px-2 py-1.5 text-[10px] leading-tight shadow-xl">
      <div className="font-medium text-[11px]">{p.date}</div>
      <div className="mt-1 grid gap-px">
        {p.restingHR != null && <TooltipRow label="Resting HR" value={`${p.restingHR} bpm`} />}
        {p.minHR != null && p.maxHR != null && (
          <TooltipRow label="Min / Max HR" value={`${p.minHR} / ${p.maxHR} bpm`} />
        )}
        {p.bbCharged != null && <TooltipRow label="BB Charged" value={`${p.bbCharged}`} />}
        {p.bbDrained != null && <TooltipRow label="BB Drained" value={`${p.bbDrained}`} />}
      </div>
    </div>
  );
}

export function HeartRateChart({
  callTool,
}: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [range, setRange] = useState<RangeKey>("30d");
  const [hrRaw, setHrRaw] = useState<Record<string, unknown>[]>([]);
  const [bbRaw, setBbRaw] = useState<Record<string, unknown>[]>([]);
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

        // Build individual date strings for heart rate fetches
        const dates: string[] = [];
        const cur = new Date(start);
        while (cur <= end) {
          dates.push(formatDate(cur));
          cur.setDate(cur.getDate() + 1);
        }

        // Fetch heart rate per day + body battery for full range in parallel
        const [hrResults, bbResult] = await Promise.all([
          Promise.all(dates.map((d) => callTool("get-heart-rates", { date: d }))),
          callTool("get-body-battery", {
            startDate: formatDate(start),
            endDate: formatDate(end),
          }),
        ]);

        // Heart rate: each result is a single day object
        const hrArr = hrResults.map((r) =>
          r && typeof r === "object" && !Array.isArray(r) ? r : {},
        ) as Record<string, unknown>[];
        setHrRaw(hrArr);

        // Body battery: array of day entries
        setBbRaw(Array.isArray(bbResult) ? (bbResult as Record<string, unknown>[]) : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    },
    [callTool],
  );

  useEffect(() => {
    fetchData(range);
  }, [range, fetchData]);

  const data: DayData[] = useMemo(() => {
    // Index body battery by date
    const bbByDate = new Map<string, Record<string, unknown>>();
    for (const entry of bbRaw) {
      const d = String(entry?.date ?? entry?.calendarDate ?? "");
      if (d) bbByDate.set(d, entry);
    }

    // Build merged array — hrRaw is ordered by date (one entry per day)
    const totalDays = RANGES[range].days;
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - totalDays + 1);

    const result: DayData[] = [];
    const cur = new Date(start);
    let hrIdx = 0;
    while (cur <= end) {
      const dateStr = formatDate(cur);
      const hr = hrRaw[hrIdx] ?? {};
      const bb = bbByDate.get(dateStr);

      const restingHR = hr.restingHeartRate != null ? Number(hr.restingHeartRate) : null;
      const minHR = hr.minHeartRate != null ? Number(hr.minHeartRate) : null;
      const maxHR = hr.maxHeartRate != null ? Number(hr.maxHeartRate) : null;
      const bbCharged = bb?.charged != null ? Number(bb.charged) : null;
      const bbDrained = bb?.drained != null ? Number(bb.drained) : null;

      result.push({
        label: dateLabel(dateStr),
        date: dateStr,
        restingHR,
        minHR,
        maxHR,
        bbCharged,
        bbDrained,
      });

      cur.setDate(cur.getDate() + 1);
      hrIdx++;
    }

    return result;
  }, [hrRaw, bbRaw, range]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Heart Rate & Body Battery</CardTitle>
        <div className="flex items-center gap-3">
          {/* Legend */}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: "var(--color-restingHR, var(--chart-3))" }}
              />
              Resting HR
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: "var(--color-bodyBattery, var(--chart-2))" }}
              />
              Body Battery
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
            Loading heart rate & body battery...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No data available
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
            <AreaChart data={data} margin={{ top: 4, right: 16, bottom: 0, left: -12 }}>
              <defs>
                <linearGradient id="fill-restingHR" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-restingHR)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-restingHR)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fill-bodyBattery" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-bodyBattery)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-bodyBattery)" stopOpacity={0.1} />
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
              <YAxis yAxisId="hr" tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} />
              <YAxis
                yAxisId="bb"
                orientation="right"
                tickLine={false}
                axisLine={false}
                domain={[0, 100]}
                tickFormatter={(v) => `${v}`}
              />
              <ChartTooltip cursor={false} content={<CustomTooltip />} />
              <Area
                yAxisId="hr"
                dataKey="restingHR"
                name="Resting HR"
                type="basis"
                fill="url(#fill-restingHR)"
                stroke="var(--color-restingHR)"
                strokeWidth={2}
                connectNulls
              />
              <Area
                yAxisId="bb"
                dataKey="bbCharged"
                name="Body Battery"
                type="basis"
                fill="url(#fill-bodyBattery)"
                stroke="var(--color-bodyBattery)"
                strokeWidth={2}
                connectNulls
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
