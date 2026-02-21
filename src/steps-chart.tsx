import { useState, useEffect, useCallback } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import type { Payload } from "recharts/types/component/DefaultTooltipContent";

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

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Payload<number, string>[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm px-3 py-2 text-xs">
      <p className="font-medium text-gray-700 mb-1">{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey as string} style={{ color: entry.color }}>
          {entry.name}: {(entry.value ?? 0).toLocaleString()}
        </p>
      ))}
    </div>
  );
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

        // Garmin API caps at 28-day ranges — split into chunks if needed
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
    <div className="w-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-700">Daily Steps</h3>
        <div className="flex gap-1">
          {(Object.keys(RANGES) as RangeKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={`px-2.5 py-1 text-xs rounded-md font-medium cursor-pointer transition-colors ${
                range === key
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {RANGES[key].label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center h-48 text-sm text-gray-500">
          Loading steps...
        </div>
      )}

      {error && (
        <div className="flex items-center justify-center h-48 text-sm text-red-600">{error}</div>
      )}

      {!loading && !error && data.length === 0 && (
        <div className="flex items-center justify-center h-48 text-sm text-gray-400">
          No step data available
        </div>
      )}

      {!loading && !error && data.length > 0 && (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "#9ca3af" }}
              tickLine={false}
              axisLine={false}
              interval={labelInterval(range)}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#9ca3af" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine
              y={10000}
              stroke="#22c55e"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              label={{ value: "10k goal", position: "right", fontSize: 10, fill: "#22c55e" }}
            />
            <Bar
              dataKey="steps"
              name="Steps"
              fill="#3b82f6"
              radius={[3, 3, 0, 0]}
              barSize={range === "30d" ? 8 : 16}
            />
            <Line
              dataKey="avg"
              name="7-day avg"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
