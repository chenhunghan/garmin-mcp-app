import { useState, useEffect, useCallback, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart.tsx";
import type { ChartConfig } from "@/components/ui/chart.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

type LimitKey = "10" | "20" | "50";

interface RawActivity {
  activityId: number;
  activityName: string;
  activityType: { typeKey: string; parentTypeId: number };
  startTimeLocal: string;
  distance: number;
  duration: number;
  movingDuration: number;
  averageSpeed: number;
  averageHR: number;
  maxHR: number;
  calories: number;
  activityTrainingLoad: number;
  averageRunningCadenceInStepsPerMinute: number;
  avgPower: number;
  aerobicTrainingEffect: number;
  anaerobicTrainingEffect: number;
  trainingEffectLabel: string;
  moderateIntensityMinutes: number;
  vigorousIntensityMinutes: number;
}

interface ActivityPoint {
  label: string;
  aerobic: number;
  anaerobic: number;
  activityName: string;
  typeLabel: string;
  date: string;
  raw: RawActivity;
}

const LIMITS: Record<LimitKey, string> = {
  "10": "Last 10",
  "20": "Last 20",
  "50": "Last 50",
};

// Aerobic = blue-violet, Anaerobic = warm coral
const COLOR_AEROBIC = "oklch(0.58 0.20 265)";
const COLOR_ANAEROBIC = "oklch(0.65 0.20 25)";

const chartConfig = {
  aerobic: { label: "Aerobic", color: COLOR_AEROBIC },
  anaerobic: { label: "Anaerobic", color: COLOR_ANAEROBIC },
} satisfies ChartConfig;

function typeLabelStr(typeKey: string): string {
  const map: Record<string, string> = {
    running: "Run",
    treadmill_running: "Treadmill",
    cycling: "Ride",
    fitness_equipment: "Fitness",
    walking: "Walk",
    hiking: "Hike",
    swimming: "Swim",
    strength_training: "Strength",
    trail_running: "Trail Run",
  };
  return map[typeKey] ?? typeKey.replace(/_/g, " ");
}

function formatDuration(seconds: number): string {
  if (!seconds) return "-";
  const m = Math.floor(seconds / 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
  }
  return `${m} min`;
}

function formatPace(averageSpeed: number): string {
  if (!averageSpeed || averageSpeed <= 0) return "-";
  const paceMin = 1000 / averageSpeed / 60;
  const mins = Math.floor(paceMin);
  const secs = Math.round((paceMin - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, "0")} /km`;
}

function teDesc(value: number): string {
  if (value >= 5.0) return "Overreaching";
  if (value >= 4.0) return "Highly Impacting";
  if (value >= 3.0) return "Impacting";
  if (value >= 2.0) return "Maintaining";
  if (value >= 1.0) return "Minor";
  return "None";
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
  payload?: Array<{ payload: ActivityPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const a = p.raw;
  const aeTE = a.aerobicTrainingEffect ?? 0;
  const anTE = a.anaerobicTrainingEffect ?? 0;

  return (
    <div className="min-w-[185px] rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{p.activityName}</div>
      <div className="text-muted-foreground">
        {p.typeLabel} &middot; {p.date}
      </div>

      <div className="mt-1.5 grid gap-0.5">
        <TooltipRow label="Duration" value={formatDuration(a.duration)} />
        {a.distance > 0 && (
          <TooltipRow label="Distance" value={`${(a.distance / 1000).toFixed(2)} km`} />
        )}
        {a.averageSpeed > 0 && <TooltipRow label="Avg Pace" value={formatPace(a.averageSpeed)} />}
        {a.averageHR > 0 && (
          <TooltipRow
            label="HR"
            value={`${Math.round(a.averageHR)} / ${Math.round(a.maxHR ?? 0)} bpm`}
          />
        )}
        {a.averageRunningCadenceInStepsPerMinute > 0 && (
          <TooltipRow
            label="Cadence"
            value={`${Math.round(a.averageRunningCadenceInStepsPerMinute)} spm`}
          />
        )}
        {a.avgPower > 0 && <TooltipRow label="Power" value={`${Math.round(a.avgPower)} W`} />}
        {a.calories > 0 && <TooltipRow label="Calories" value={`${Math.round(a.calories)} kcal`} />}
        {a.activityTrainingLoad > 0 && (
          <TooltipRow label="Load" value={a.activityTrainingLoad.toFixed(1)} />
        )}
      </div>

      {/* Training effect */}
      {(aeTE > 0 || anTE > 0) && (
        <div className="mt-1.5 border-t border-border/50 pt-1.5 grid gap-0.5">
          {a.trainingEffectLabel && (
            <div className="text-muted-foreground capitalize">
              {a.trainingEffectLabel.toLowerCase().replace(/_/g, " ")}
            </div>
          )}
          {aeTE > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: COLOR_AEROBIC }}
                />
                Aerobic
              </span>
              <span className="font-mono font-medium tabular-nums">
                {aeTE.toFixed(1)} — {teDesc(aeTE)}
              </span>
            </div>
          )}
          {anTE > 0 && (
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: COLOR_ANAEROBIC }}
                />
                Anaerobic
              </span>
              <span className="font-mono font-medium tabular-nums">
                {anTE.toFixed(1)} — {teDesc(anTE)}
              </span>
            </div>
          )}
          {(a.moderateIntensityMinutes > 0 || a.vigorousIntensityMinutes > 0) && (
            <TooltipRow
              label="Intensity"
              value={`${a.moderateIntensityMinutes ?? 0}m mod · ${a.vigorousIntensityMinutes ?? 0}m vig`}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function ActivitiesChart({
  callTool,
}: {
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [limit, setLimit] = useState<LimitKey>("10");
  const [raw, setRaw] = useState<RawActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchActivities = useCallback(
    async (lim: LimitKey) => {
      setLoading(true);
      setError(null);
      try {
        const result = await callTool("get-activities", { start: 0, limit: Number(lim) });
        if (Array.isArray(result)) {
          setRaw(result as unknown as RawActivity[]);
        } else {
          setRaw([]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load activities");
      } finally {
        setLoading(false);
      }
    },
    [callTool],
  );

  useEffect(() => {
    fetchActivities(limit);
  }, [limit, fetchActivities]);

  const data: ActivityPoint[] = useMemo(() => {
    const reversed = [...raw].reverse();

    // Disambiguate same-date labels
    const dateCounts = new Map<string, number>();
    for (const a of reversed) {
      const d = a.startTimeLocal?.slice(0, 10) ?? "";
      dateCounts.set(d, (dateCounts.get(d) ?? 0) + 1);
    }

    return reversed.map((a) => {
      const dateStr = a.startTimeLocal?.slice(0, 10) ?? "";
      const parts = dateStr.split("-");
      const shortDate =
        parts.length === 3 ? `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}` : dateStr;
      const tLabel = typeLabelStr(a.activityType?.typeKey ?? "other");
      const label = (dateCounts.get(dateStr) ?? 0) > 1 ? `${shortDate} ${tLabel}` : shortDate;

      const durationMin = (a.duration ?? 0) / 60;
      const aeTE = a.aerobicTrainingEffect ?? 0;
      const anTE = a.anaerobicTrainingEffect ?? 0;
      const total = aeTE + anTE;

      // Split the duration bar by TE ratio
      let aerobic: number;
      let anaerobic: number;
      if (total > 0) {
        aerobic = durationMin * (aeTE / total);
        anaerobic = durationMin * (anTE / total);
      } else {
        // No TE data — show full bar as aerobic (neutral)
        aerobic = durationMin;
        anaerobic = 0;
      }

      return {
        label,
        aerobic,
        anaerobic,
        activityName: a.activityName ?? "Activity",
        typeLabel: tLabel,
        date: dateStr,
        raw: a,
      };
    });
  }, [raw]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm">Activities</CardTitle>
        <div className="flex items-center gap-3">
          {/* Legend */}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: COLOR_AEROBIC }}
              />
              Aerobic
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ backgroundColor: COLOR_ANAEROBIC }}
              />
              Anaerobic
            </span>
          </div>
          <Select value={limit} onValueChange={(v) => setLimit(v as LimitKey)}>
            {(Object.keys(LIMITS) as LimitKey[]).map((key) => (
              <option key={key} value={key}>
                {LIMITS[key]}
              </option>
            ))}
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Loading activities...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No activities found
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <ChartContainer config={chartConfig} className="aspect-auto h-[220px] w-full">
            <BarChart
              data={data}
              margin={{ top: 4, right: 16, bottom: 0, left: -12 }}
              barCategoryGap="20%"
            >
              <defs>
                <linearGradient id="fill-aerobic" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLOR_AEROBIC} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={COLOR_AEROBIC} stopOpacity={0.3} />
                </linearGradient>
                <linearGradient id="fill-anaerobic" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={COLOR_ANAEROBIC} stopOpacity={0.8} />
                  <stop offset="95%" stopColor={COLOR_ANAEROBIC} stopOpacity={0.3} />
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
                tickFormatter={(v: number) => `${Math.round(v)}m`}
              />
              <ChartTooltip cursor={false} content={<CustomTooltip />} />
              <Bar
                dataKey="aerobic"
                stackId="te"
                fill="url(#fill-aerobic)"
                stroke={COLOR_AEROBIC}
                strokeOpacity={0.3}
                strokeWidth={1}
                radius={[0, 0, 0, 0]}
                isAnimationActive={false}
              />
              <Bar
                dataKey="anaerobic"
                stackId="te"
                fill="url(#fill-anaerobic)"
                stroke={COLOR_ANAEROBIC}
                strokeOpacity={0.3}
                strokeWidth={1}
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
