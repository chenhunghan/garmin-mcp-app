import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import type { ToolArgs } from "@/lib/tool-args.ts";
import { resolveActivity } from "@/lib/activity.ts";
import { AskClaude } from "@/components/ask-claude.tsx";

/** A recorded lap (lapDTOs) or a computed per-km split (kmSplits). */
interface RawSplit {
  lapIndex: number;
  /** Metres */
  distance: number;
  /** Seconds */
  duration: number;
  /** m/s */
  averageSpeed: number;
  averageHR?: number;
  maxHR?: number;
  averageRunCadence?: number;
  intensityType?: string;
}

interface SplitRow {
  label: string;
  distance: number;
  duration: number;
  paceSeconds: number | null;
  avgHR: number | null;
  cadence: number | null;
  intensity?: string;
}

/** Format seconds as M:SS (or H:MM:SS). */
function formatTime(totalSeconds: number): string {
  if (!totalSeconds || totalSeconds <= 0) return "–";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.round(totalSeconds % 60);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function formatIntensity(type: string | undefined): string | undefined {
  if (!type || type === "ACTIVE") return undefined;
  const map: Record<string, string> = {
    WARMUP: "Warm up",
    RECOVERY: "Recovery",
    REST: "Rest",
    COOLDOWN: "Cool down",
    INTERVAL: "Interval",
  };
  return map[type] ?? type.charAt(0) + type.slice(1).toLowerCase();
}

function toRows(splits: RawSplit[], perKm: boolean): SplitRow[] {
  return splits.map((s) => ({
    // A partial last km shows its distance ("0.10"), whole kms their number
    label: perKm && s.distance < 990 ? (s.distance / 1000).toFixed(2) : String(s.lapIndex),
    distance: s.distance,
    duration: s.duration,
    paceSeconds: s.averageSpeed > 0 ? 1000 / s.averageSpeed : null,
    avgHR: s.averageHR && s.averageHR > 0 ? Math.round(s.averageHR) : null,
    cadence:
      s.averageRunCadence && s.averageRunCadence > 0 ? Math.round(s.averageRunCadence) : null,
    intensity: formatIntensity(s.intensityType),
  }));
}

export function SplitsChart({
  callTool,
  args,
}: {
  /** What the tool call asked for (date / activity); defaults to today/latest */
  args?: ToolArgs;
  callTool: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
}) {
  const [splits, setSplits] = useState<RawSplit[]>([]);
  const [perKm, setPerKm] = useState(false);
  const [activityName, setActivityName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The requested activity, else the most recent
      const activity = await resolveActivity(callTool, args);
      if (!activity) {
        setError("No activities found");
        return;
      }
      setActivityName([activity.name, activity.date].filter(Boolean).join(" · ") || null);

      const result = await callTool("get-activity-splits", { activityId: activity.id });
      // Single-lap activities come with per-km splits computed by the server
      const km = result?.kmSplits;
      const laps = result?.lapDTOs;
      if (Array.isArray(km) && km.length > 1) {
        setPerKm(true);
        setSplits(km as RawSplit[]);
      } else {
        setPerKm(false);
        setSplits(Array.isArray(laps) ? (laps as RawSplit[]) : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load splits");
    } finally {
      setLoading(false);
    }
  }, [callTool, args]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const rows = useMemo(() => toRows(splits, perKm), [splits, perKm]);

  // Bar length ∝ speed (longer = faster), scaled between the slowest and
  // fastest split so differences are visible; ignore short partial splits
  const { fastest, slowest } = useMemo(() => {
    const paces = rows.filter((r) => r.distance >= 500 && r.paceSeconds).map((r) => r.paceSeconds!);
    return { fastest: Math.min(...paces), slowest: Math.max(...paces) };
  }, [rows]);
  const barWidth = (pace: number | null) => {
    if (!pace || !Number.isFinite(fastest)) return 0;
    if (slowest === fastest) return 100;
    const t = (slowest - Math.min(Math.max(pace, fastest), slowest)) / (slowest - fastest);
    return 35 + t * 65; // 35% (slowest) … 100% (fastest)
  };

  const total = useMemo(() => {
    const distance = rows.reduce((a, r) => a + r.distance, 0);
    const duration = rows.reduce((a, r) => a + r.duration, 0);
    const hrs = rows.filter((r) => r.avgHR);
    const avgHR = hrs.length
      ? Math.round(
          hrs.reduce((a, r) => a + r.avgHR! * r.duration, 0) /
            hrs.reduce((a, r) => a + r.duration, 0),
        )
      : null;
    return { distance, duration, pace: distance > 0 ? (duration / distance) * 1000 : null, avgHR };
  }, [rows]);

  const unit = perKm ? "Km" : "Lap";
  const description = perKm
    ? "Per-km splits, computed from GPS (your watch recorded this run as one lap). Longer bar = faster."
    : rows.length === 1
      ? "Your watch recorded this activity as a single lap. Turn on auto-lap for per-km splits."
      : "Laps recorded by your watch. Longer bar = faster.";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          {activityName ? `Splits — ${activityName}` : "Activity Splits"}
        </CardTitle>
        {!loading && !error && rows.length > 0 && (
          <CardDescription className="text-xs">{description}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        {loading && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            Loading splits...
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-48 text-sm text-destructive">
            {error}
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
            No splits data available
          </div>
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-sm tabular-nums">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="py-1 pr-3 text-left font-normal">{unit}</th>
                  <th className="py-1 pr-3 text-left font-normal">Pace /km</th>
                  <th className="w-full py-1 pr-3 font-normal" aria-label="Pace bar" />
                  <th className="py-1 pr-3 text-right font-normal">Time</th>
                  <th className="py-1 pr-3 text-right font-normal">Avg HR</th>
                  <th className="py-1 text-right font-normal">Cadence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isFastest = r.paceSeconds === fastest && rows.length > 1;
                  return (
                    <tr key={r.label} className="border-t border-border/50">
                      <td className="py-1.5 pr-3 text-muted-foreground">
                        {r.label}
                        {r.intensity && <div className="text-[10px]">{r.intensity}</div>}
                      </td>
                      <td className={`py-1.5 pr-3 ${isFastest ? "font-semibold" : ""}`}>
                        {r.paceSeconds ? formatTime(r.paceSeconds) : "–"}
                      </td>
                      <td className="py-1.5 pr-3">
                        <div
                          className="h-2.5 rounded-full"
                          style={{
                            width: `${barWidth(r.paceSeconds)}%`,
                            backgroundColor: "var(--chart-1)",
                            opacity: isFastest ? 1 : 0.6,
                          }}
                        />
                      </td>
                      <td className="py-1.5 pr-3 text-right">{formatTime(r.duration)}</td>
                      <td className="py-1.5 pr-3 text-right">{r.avgHR ?? "–"}</td>
                      <td className="py-1.5 text-right">{r.cadence ?? "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
              {rows.length > 1 && (
                <tfoot>
                  <tr className="border-t border-border font-medium">
                    <td className="py-1.5 pr-3">{(total.distance / 1000).toFixed(2)} km</td>
                    <td className="py-1.5 pr-3">{total.pace ? formatTime(total.pace) : "–"}</td>
                    <td />
                    <td className="py-1.5 pr-3 text-right">{formatTime(total.duration)}</td>
                    <td className="py-1.5 pr-3 text-right">{total.avgHR ?? "–"}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}

        {!loading && !error && rows.length > 1 && (
          <div className="mt-3">
            <AskClaude
              questions={[
                // Name the run: the question lands in the chat, away from this view
                `Analyze my pacing in my run "${activityName ?? "latest run"}"`,
                `How does "${activityName ?? "my latest run"}" compare to my recent runs?`,
              ]}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
