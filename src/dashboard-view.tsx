import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { AskAssistant } from "@/components/ask-assistant.tsx";
import { useAppActions, type CallTool } from "@/lib/app-actions.tsx";
import { formatDate, parseDate } from "@/lib/dates.ts";
import type { ToolArgs } from "@/lib/tool-args.ts";

// ── Types (mirror garmin-connect's MetricSeries; the UI can't import the library) ──

type RangeKey = "4w" | "12w" | "26w" | "52w";
type Granularity = "daily" | "weekly";

interface SeriesPoint {
  date: string;
  value: number;
  low?: number;
  high?: number;
}

interface Summary {
  points: number;
  latest?: SeriesPoint;
  start?: number;
  end?: number;
  min?: { date: string; value: number };
  max?: { date: string; value: number };
  mean?: number;
  vsMean?: number;
  vsMeanPct?: number | null;
  trend: "up" | "down" | "flat" | "not enough data";
}

interface MetricSeries {
  metric: string;
  label: string;
  unit: string;
  granularity: Granularity;
  band?: string;
  points: SeriesPoint[];
  summary: Summary;
  error?: string;
}

interface DashboardData {
  range: RangeKey;
  startDate: string;
  endDate: string;
  granularity: Granularity;
  metrics: MetricSeries[];
  availableMetrics: { key: string; label: string; unit: string }[];
}

type DashboardArgs = ToolArgs & { metrics?: string[]; range?: RangeKey };

const RANGES: { key: RangeKey; label: string; weeks: number; long: string; adj: string }[] = [
  { key: "4w", label: "4w", weeks: 4, long: "4 weeks", adj: "4-week" },
  { key: "12w", label: "12w", weeks: 12, long: "12 weeks", adj: "12-week" },
  { key: "26w", label: "6m", weeks: 26, long: "6 months", adj: "6-month" },
  { key: "52w", label: "1y", weeks: 52, long: "year", adj: "1-year" },
];
const rangeAdj = (range: RangeKey) => RANGES.find((r) => r.key === range)!.adj;
const DEFAULT_METRICS = ["restingHR", "hrv", "vo2max", "sleepScore"];
const MAX_METRICS = 4;

/** Metric names inside a sentence ("my resting HR went…"). */
const PHRASE: Record<string, string> = {
  restingHR: "resting HR",
  hrv: "HRV",
  vo2max: "VO₂ max",
  sleepScore: "sleep score",
  sleepDuration: "sleep duration",
  steps: "daily steps",
  stress: "average stress",
  bodyBattery: "Body Battery high",
  intensityMinutes: "weekly intensity minutes",
  trainingLoad: "acute training load",
  weight: "weight",
};
const DECIMALS: Record<string, number> = { vo2max: 1, sleepDuration: 1, weight: 1 };

const chartConfig = { value: { label: "Value", color: "var(--chart-3)" } } satisfies ChartConfig;

// ── Formatting ────────────────────────────────────────────────────────────

const MINUS = "−";
function fmt(v: number, decimals = 0): string {
  const s = v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return s.replace(/^-/, MINUS);
}
/** Signed change; a small change gets an extra decimal rather than reading as "−0". */
function signed(v: number, decimals = 0): string {
  const d = v !== 0 && Math.abs(v) < 0.5 * 10 ** -decimals ? decimals + 1 : decimals;
  return (v > 0 ? "+" : "") + fmt(v, d);
}
const withUnit = (v: string, unit: string) => (unit ? `${v} ${unit}` : v);
const shortDate = (d: string) =>
  parseDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const longDate = (d: string) =>
  parseDate(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const DAY = 86_400_000;
const ms = (d: string) => parseDate(d).getTime();

/** "the last 12 weeks" when the range ends today, else "the 12 weeks to Oct 3". */
function periodPhrase(range: RangeKey, endDate: string): string {
  const r = RANGES.find((x) => x.key === range)!;
  const isToday = endDate === formatDate(new Date());
  if (r.key === "52w") return isToday ? "the last year" : `the year to ${longDate(endDate)}`;
  return isToday ? `the last ${r.long}` : `the ${r.long} to ${longDate(endDate)}`;
}

/** Shared x ticks: ~4 per panel, weekly-ish for short ranges, month starts for long. */
function xTicks(start: string, end: string, range: RangeKey): number[] {
  const t0 = ms(start);
  const t1 = ms(end);
  if (range === "4w" || range === "12w") {
    const step = range === "4w" ? 7 : 21;
    const ticks: number[] = [];
    for (let t = t0; t <= t1; t += step * DAY) ticks.push(t);
    return ticks;
  }
  const months: number[] = [];
  const d = parseDate(start);
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  while (d.getTime() <= t1) {
    months.push(d.getTime());
    d.setMonth(d.getMonth() + 1);
  }
  const every = range === "26w" ? 2 : 3;
  return months.filter((_, i) => i % every === 0);
}

function tickLabel(t: number, range: RangeKey): string {
  const d = new Date(t);
  if (range === "4w" || range === "12w") {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const m = d.toLocaleDateString(undefined, { month: "short" });
  return d.getMonth() === 0 ? `${m} ’${String(d.getFullYear()).slice(2)}` : m;
}

/** 3-4 round y ticks (step 1/2/2.5/5 × 10ⁿ) covering [min, max]. */
function niceTicks(min: number, max: number): number[] {
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

// ── Chart rows ────────────────────────────────────────────────────────────

interface Row {
  t: number;
  date: string;
  value: number;
  /** Trailing 7-day mean (daily series only) */
  avg?: number;
  band?: [number, number];
}

/** Daily series dense enough to smooth: raw days as faint dots, 7-day mean as the line. */
function isSmoothed(s: MetricSeries, startDate: string, endDate: string): boolean {
  // VO₂ max and weight are already smooth or sparse: plot them as they are
  if (s.granularity !== "daily" || s.metric === "vo2max" || s.metric === "weight") return false;
  const days = (ms(endDate) - ms(startDate)) / DAY + 1;
  return s.points.length >= 14 && s.points.length >= days * 0.5;
}

function toRows(s: MetricSeries, smoothed: boolean): Row[] {
  return s.points.map((p, i) => {
    const row: Row = { t: ms(p.date), date: p.date, value: p.value };
    if (smoothed) {
      const t = ms(p.date);
      const win = s.points.slice(Math.max(0, i - 6), i + 1).filter((q) => t - ms(q.date) < 7 * DAY);
      row.avg = win.reduce((a, q) => a + q.value, 0) / win.length;
    }
    if (p.low !== undefined && p.high !== undefined) row.band = [p.low, p.high];
    return row;
  });
}

// ── Panel ─────────────────────────────────────────────────────────────────

function PanelTooltip({
  active,
  payload,
  series,
}: {
  active?: boolean;
  payload?: Array<{ payload: Row }>;
  series: MetricSeries;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload;
  const d = DECIMALS[series.metric] ?? 0;
  const when =
    series.granularity === "weekly" ? `Week of ${longDate(row.date)}` : longDate(row.date);
  return (
    <div className="min-w-[140px] rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block h-0.5 w-3 rounded-full"
          style={{ backgroundColor: "var(--chart-3)" }}
        />
        <span className="font-semibold text-foreground tabular-nums">
          {withUnit(fmt(row.value, d), series.unit)}
        </span>
      </div>
      <div className="text-muted-foreground">{when}</div>
      {row.avg !== undefined && (
        <div className="text-muted-foreground tabular-nums">
          7-day avg {withUnit(fmt(row.avg, d), series.unit)}
        </div>
      )}
      {row.band && (
        <div className="text-muted-foreground tabular-nums">
          {series.metric === "hrv" ? "Baseline" : "Optimal"} {fmt(row.band[0], d)}–
          {fmt(row.band[1], d)}
        </div>
      )}
    </div>
  );
}

function Panel({
  series,
  startDate,
  endDate,
  range,
}: {
  series: MetricSeries;
  startDate: string;
  endDate: string;
  range: RangeKey;
}) {
  const d = DECIMALS[series.metric] ?? 0;
  const smoothed = isSmoothed(series, startDate, endDate);
  const rows = useMemo(() => toRows(series, smoothed), [series, smoothed]);
  const ticks = useMemo(() => xTicks(startDate, endDate, range), [startDate, endDate, range]);
  const { summary: s } = series;
  const hasBand = rows.some((r) => r.band);
  const yTicks = useMemo(() => {
    const vals = rows.flatMap((r) => [r.value, ...(r.band ?? [])]);
    return vals.length ? niceTicks(Math.min(...vals), Math.max(...vals)) : [];
  }, [rows]);
  const tickDecimals = yTicks.some((t) => !Number.isInteger(t)) ? Math.max(d, 1) : 0;
  const yWidth = Math.max(
    28,
    8 + 6.5 * Math.max(...yTicks.map((t) => fmt(t, tickDecimals).length)),
  );
  const title = series.unit ? `${series.label} · ${series.unit}` : series.label;

  return (
    <section className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/50 p-3">
      <h3 className="text-xs text-muted-foreground">{title}</h3>
      {series.error || s.points === 0 ? (
        <>
          <div className="text-2xl font-semibold leading-none text-muted-foreground">–</div>
          <div className="flex h-[132px] items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {series.error
              ? `Couldn't load ${PHRASE[series.metric] ?? series.label}: ${series.error}`
              : `No ${PHRASE[series.metric] ?? series.label} data in this period`}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-2xl font-semibold leading-none">
              {fmt(s.end!, d)}
              {series.unit && (
                <span className="ml-1 text-sm font-normal text-muted-foreground">
                  {series.unit}
                </span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {series.granularity === "weekly"
                ? `week of ${shortDate(s.latest!.date)}`
                : `last 7 days to ${shortDate(s.latest!.date)}`}
            </span>
          </div>
          {s.vsMean !== undefined && s.mean !== undefined && s.points > 1 && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {withUnit(signed(s.vsMean, d), series.unit)}
                {s.vsMeanPct != null && ` (${signed(s.vsMeanPct)}%)`}
              </span>{" "}
              vs {rangeAdj(range)} avg {fmt(s.mean, d)}
            </div>
          )}
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-[132px] w-full"
            role="img"
            aria-label={`${series.label} from ${longDate(startDate)} to ${longDate(endDate)}: ${
              s.start !== undefined && s.end !== undefined
                ? `now ${fmt(s.end, d)} ${series.unit} vs average ${fmt(s.mean ?? s.end, d)}, range ${fmt(s.min!.value, d)} to ${fmt(s.max!.value, d)}, trend ${s.trend}`
                : "not enough data"
            }`}
          >
            <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={[ms(startDate), ms(endDate)]}
                ticks={ticks}
                tickFormatter={(t: number) => tickLabel(t, range)}
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                minTickGap={8}
              />
              <YAxis
                width={yWidth}
                tickLine={false}
                axisLine={false}
                ticks={yTicks}
                domain={[yTicks[0]!, yTicks.at(-1)!]}
                tickFormatter={(v: number) => fmt(v, tickDecimals)}
              />
              <ChartTooltip
                cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.5, strokeWidth: 1 }}
                content={<PanelTooltip series={series} />}
              />
              {hasBand && (
                <Area
                  dataKey="band"
                  stroke="none"
                  fill="var(--chart-3)"
                  fillOpacity={0.1}
                  isAnimationActive={false}
                  activeDot={false}
                  connectNulls
                  type="monotone"
                />
              )}
              {smoothed ? (
                <>
                  <Line
                    dataKey="value"
                    stroke="none"
                    dot={{
                      r: 1.5,
                      fill: "var(--muted-foreground)",
                      fillOpacity: 0.45,
                      stroke: "none",
                    }}
                    activeDot={{
                      r: 3,
                      fill: "var(--muted-foreground)",
                      stroke: "var(--background)",
                    }}
                    isAnimationActive={false}
                  />
                  <Line
                    dataKey="avg"
                    stroke="var(--color-value, var(--chart-3))"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    dot={false}
                    activeDot={{
                      r: 4,
                      fill: "var(--color-value, var(--chart-3))",
                      stroke: "var(--background)",
                      strokeWidth: 2,
                    }}
                    type="monotone"
                    isAnimationActive={false}
                  />
                </>
              ) : (
                <Line
                  dataKey="value"
                  stroke="var(--color-value, var(--chart-3))"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={
                    rows.length <= 30
                      ? {
                          r: 2.5,
                          fill: "var(--color-value, var(--chart-3))",
                          stroke: "var(--background)",
                          strokeWidth: 1,
                        }
                      : false
                  }
                  activeDot={{
                    r: 4,
                    fill: "var(--color-value, var(--chart-3))",
                    stroke: "var(--background)",
                    strokeWidth: 2,
                  }}
                  type="monotone"
                  connectNulls
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ChartContainer>
          {hasBand && series.band && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                aria-hidden
                className="inline-block h-2.5 w-3 rounded-[2px]"
                style={{ backgroundColor: "var(--chart-3)", opacity: 0.18 }}
              />
              {series.band}
              {smoothed && " · line = 7-day average, dots = days"}
            </div>
          )}
          {!hasBand && smoothed && (
            <div className="text-[11px] text-muted-foreground">
              Line = 7-day average, dots = days
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Table fallback ────────────────────────────────────────────────────────

function DashboardTable({ data }: { data: DashboardData }) {
  const shown = data.metrics.filter((m) => m.points.length);
  const dates = [...new Set(shown.flatMap((m) => m.points.map((p) => p.date)))].sort().reverse();
  const lookup = shown.map((m) => new Map(m.points.map((p) => [p.date, p.value])));
  if (!shown.length) return null;
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-border/50">
      <table className="w-full whitespace-nowrap text-sm tabular-nums">
        <thead className="sticky top-0 bg-background">
          <tr className="text-xs text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-normal">
              {data.granularity === "weekly" ? "Week of" : "Date"}
            </th>
            {shown.map((m) => (
              <th key={m.metric} className="px-3 py-1.5 text-right font-normal">
                {m.label}
                {m.unit && ` (${m.unit})`}
                {m.granularity === "weekly" && data.granularity === "daily" && " · weekly"}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((date) => (
            <tr key={date} className="border-t border-border/50">
              <td className="px-3 py-1 text-muted-foreground">{longDate(date)}</td>
              {shown.map((m, i) => {
                const v = lookup[i]!.get(date);
                return (
                  <td key={m.metric} className="px-3 py-1 text-right">
                    {v === undefined ? "–" : fmt(v, DECIMALS[m.metric] ?? 0)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Text for Claude ───────────────────────────────────────────────────────

const ready = (m: MetricSeries) =>
  !m.error && m.summary.points > 0 && m.summary.end !== undefined && m.summary.mean !== undefined;

/** "last 7 days to Oct 4" / "week of Sep 28": what the current value covers. */
function currentSpan(m: MetricSeries): string {
  const d = shortDate(m.summary.latest!.date);
  return m.granularity === "weekly" ? `week of ${d}` : `last 7 days to ${d}`;
}

function metricSentence(m: MetricSeries, range: RangeKey): string {
  const d = DECIMALS[m.metric] ?? 0;
  const s = m.summary;
  if (m.error) return `${m.label}: couldn't load`;
  if (!ready(m)) return `${m.label}: no data`;
  const pct = s.vsMeanPct != null ? `, ${signed(s.vsMeanPct)}%` : "";
  const firstSpan = m.granularity === "weekly" ? "first week" : "first 7 days";
  return (
    `${m.label} now ${withUnit(fmt(s.end!, d), m.unit)} (${currentSpan(m)}) vs ` +
    `${rangeAdj(range)} avg ${fmt(s.mean!, d)} (${signed(s.vsMean!, d)}${pct}); ` +
    `range ${fmt(s.min!.value, d)}–${fmt(s.max!.value, d)}; ${firstSpan} ${fmt(s.start!, d)}; ` +
    `fitted trend ${s.trend}`
  );
}

function dashboardContext(data: DashboardData): string {
  const head =
    `Performance dashboard, ${periodPhrase(data.range, data.endDate)} ` +
    `(${longDate(data.startDate)} – ${longDate(data.endDate)}, ${data.granularity} points). ` +
    "Per metric: current level vs the period's average, min–max, the level at the start " +
    "(often unrepresentative, e.g. a new watch), fitted trend.";
  return `${head} ${data.metrics.map((m) => metricSentence(m, data.range)).join("; ")}.`;
}

function questions(data: DashboardData): string[] {
  const period = periodPhrase(data.range, data.endDate);
  const adj = rangeAdj(data.range);
  const ok = data.metrics.filter(ready);
  const name = (m: MetricSeries) => PHRASE[m.metric] ?? m.label;
  const now = (m: MetricSeries) => withUnit(fmt(m.summary.end!, DECIMALS[m.metric] ?? 0), m.unit);
  const avg = (m: MetricSeries) => fmt(m.summary.mean!, DECIMALS[m.metric] ?? 0);
  const out: string[] = [];
  if (ok.length >= 2) {
    const [a, b] = ok as [MetricSeries, MetricSeries];
    out.push(
      `Over ${period} my ${name(a)} averaged ${avg(a)} and is now ${now(a)}, while my ` +
        `${name(b)} averaged ${avg(b)} and is now ${now(b)} — what does that say about my fitness?`,
    );
  }
  const biggest = [...ok]
    .filter((m) => m.summary.vsMeanPct != null)
    .sort((x, y) => Math.abs(y.summary.vsMeanPct!) - Math.abs(x.summary.vsMeanPct!))[0];
  if (biggest && Math.abs(biggest.summary.vsMeanPct!) >= 5) {
    const pct = Math.round(Math.abs(biggest.summary.vsMeanPct!));
    const dir = biggest.summary.vsMeanPct! > 0 ? "above" : "below";
    out.push(
      `Why is my ${name(biggest)} ${pct}% ${dir} my ${adj} average ` +
        `(${now(biggest)} in the ${currentSpan(biggest)}, vs ${avg(biggest)})?`,
    );
  } else if (ok.length === 1) {
    const m = ok[0]!;
    out.push(
      `My ${name(m)} is ${now(m)} (${currentSpan(m)}), close to my ${adj} average of ` +
        `${avg(m)} — how should I read that?`,
    );
  }
  return out.slice(0, 2);
}

// ── View ──────────────────────────────────────────────────────────────────

const cacheKey = (range: RangeKey, end: string, metric: string) => `${range}|${end}|${metric}`;

function isDashboardData(v: unknown): v is DashboardData {
  return !!v && typeof v === "object" && Array.isArray((v as DashboardData).metrics);
}

export function DashboardView({
  callTool,
  args,
  data: initial,
}: {
  callTool: CallTool;
  /** The tool call's echoed arguments (metrics, range, endDate) */
  args?: ToolArgs;
  /** The tool result itself, so the first render needs no second fetch */
  data?: unknown;
}) {
  const a = args as DashboardArgs | undefined;
  const endDate = a?.endDate ?? formatDate(new Date());
  const [range, setRange] = useState<RangeKey>(
    a?.range && RANGES.some((r) => r.key === a.range) ? a.range : "12w",
  );
  const [selected, setSelected] = useState<string[]>(
    a?.metrics?.length ? a.metrics.slice(0, MAX_METRICS) : DEFAULT_METRICS,
  );
  const [showTable, setShowTable] = useState(false);
  const [shown, setShown] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { shareContext, canShareContext } = useAppActions();

  // Series already loaded, per range/end/metric, so toggling a metric only fetches that one
  const cache = useRef(new Map<string, MetricSeries>());
  const meta = useRef(
    new Map<RangeKey, Omit<DashboardData, "metrics" | "range" | "endDate" | "availableMetrics">>(),
  );
  const available = useRef<DashboardData["availableMetrics"]>([]);

  const remember = useCallback((d: DashboardData) => {
    for (const m of d.metrics) cache.current.set(cacheKey(d.range, d.endDate, m.metric), m);
    meta.current.set(d.range, { startDate: d.startDate, granularity: d.granularity });
    if (d.availableMetrics?.length) available.current = d.availableMetrics;
  }, []);

  // Seed with the result of the call that opened the view
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    if (isDashboardData(initial)) remember(initial);
  }

  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    const missing = selected.filter((m) => !cache.current.has(cacheKey(range, endDate, m)));
    const assemble = () => {
      const m = meta.current.get(range)!;
      setShown({
        range,
        endDate,
        ...m,
        metrics: selected
          .map((k) => cache.current.get(cacheKey(range, endDate, k)))
          .filter((s): s is MetricSeries => !!s),
        availableMetrics: available.current,
      });
    };
    if (!missing.length && meta.current.has(range)) {
      assemble();
      return;
    }
    setLoading(true);
    setError(null);
    callTool("show-performance-dashboard", { metrics: missing, range, endDate })
      .then((res) => {
        if (id !== request.current) return;
        if (!isDashboardData(res)) throw new Error("Unexpected dashboard response");
        remember(res);
        assemble();
      })
      .catch((err) => {
        if (id === request.current) {
          setError(err instanceof Error ? err.message : "Failed to load the dashboard");
        }
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
  }, [range, selected, endDate, callTool, remember]);

  // Tell Claude what's on screen whenever the selection changes
  useEffect(() => {
    if (!shown || !canShareContext) return;
    void shareContext(dashboardContext(shown), {
      view: "dashboard",
      range: shown.range,
      startDate: shown.startDate,
      endDate: shown.endDate,
      metrics: shown.metrics.map((m) => ({
        metric: m.metric,
        unit: m.unit,
        summary: m.summary,
      })),
    }).catch(() => {});
  }, [shown, canShareContext, shareContext]);

  const toggle = (key: string) =>
    setSelected((cur) =>
      cur.includes(key)
        ? cur.length > 1
          ? cur.filter((k) => k !== key)
          : cur
        : cur.length < MAX_METRICS
          ? [...cur, key]
          : cur,
    );

  const options = available.current.length
    ? available.current
    : DEFAULT_METRICS.map((k) => ({ key: k, label: PHRASE[k] ?? k, unit: "" }));
  const qs = useMemo(() => (shown ? questions(shown) : []), [shown]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Performance dashboard
          {shown && (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {longDate(shown.startDate)} – {longDate(shown.endDate)}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* One filter row scoping every panel below */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label="Time range"
            className="inline-flex rounded-md border border-border/50 p-0.5"
          >
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                role="radio"
                aria-checked={range === r.key}
                aria-label={r.long === "year" ? "1 year" : r.long}
                onClick={() => setRange(r.key)}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${
                  range === r.key
                    ? "bg-muted font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Metrics (up to 4)" className="flex flex-wrap gap-1">
            {options.map((o) => {
              const on = selected.includes(o.key);
              const full = !on && selected.length >= MAX_METRICS;
              return (
                <button
                  key={o.key}
                  type="button"
                  aria-pressed={on}
                  disabled={full}
                  title={full ? "Up to 4 metrics — deselect one first" : undefined}
                  onClick={() => toggle(o.key)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    on
                      ? "border-foreground/40 bg-muted font-medium text-foreground"
                      : "border-border/50 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
                  }`}
                >
                  {on && <span aria-hidden>✓ </span>}
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>

        {error && <div className="text-sm text-destructive">{error}</div>}

        {!shown && !error && (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            Loading dashboard...
          </div>
        )}

        {shown && (
          <div
            aria-busy={loading}
            className={`flex flex-col gap-3 transition-opacity ${loading ? "opacity-50" : ""}`}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {shown.metrics.map((m) => (
                <Panel
                  key={m.metric}
                  series={m}
                  startDate={shown.startDate}
                  endDate={shown.endDate}
                  range={shown.range}
                />
              ))}
            </div>
            <div>
              <button
                type="button"
                aria-pressed={showTable}
                aria-expanded={showTable}
                onClick={() => setShowTable((v) => !v)}
                className="rounded-md text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {showTable ? "Hide table" : "Show table"}
              </button>
            </div>
            {showTable && <DashboardTable data={shown} />}
            <AskAssistant questions={qs} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
