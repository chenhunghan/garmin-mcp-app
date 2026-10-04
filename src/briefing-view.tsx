import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { StatTile, StatusBadge, type StatDelta } from "@/components/stat-tile.tsx";
import { AskAssistant } from "@/components/ask-assistant.tsx";
import { useAppActions, type CallTool } from "@/lib/app-actions.tsx";
import { formatDate, parseDate } from "@/lib/dates.ts";
import type { ToolArgs } from "@/lib/tool-args.ts";
import {
  briefingQuestions,
  briefingSummary,
  formatHours,
  humanize,
  type Briefing,
  type Metric,
} from "./briefing-model.ts";

const fmtNum = (n: number) => n.toLocaleString();

/** "+4", "−12", "±0" — a real minus sign, not a hyphen. */
function signed(n: number, format: (abs: number) => string = fmtNum): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
  return `${sign}${format(Math.abs(n))}`;
}

function statusOf(m: Metric) {
  return m.status?.level ? { level: m.status.level, label: m.status.label } : undefined;
}

function bandText(low: number, high: number, format: (n: number) => string): string {
  return low === high ? format(low) : `${format(low)}–${format(high)}`;
}

function dateHeading(b: Briefing): string {
  const label = parseDate(b.date).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return b.isToday ? `Today · ${label}` : label;
}

function ReadinessHero({ m }: { m: Metric }) {
  if (m.value === null) {
    return (
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground">Training readiness</div>
        <div className="text-2xl font-semibold leading-none">–</div>
        <div className="text-xs text-muted-foreground">{m.missing}</div>
      </div>
    );
  }
  const details = m.details as {
    garminFeedback: string | null;
    recoveryHours: number | null;
    factorsWeakestFirst: {
      name: string;
      feedback: string | null;
      level: "good" | "warning" | "critical" | null;
    }[];
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div>
          <div className="text-xs text-muted-foreground">Training readiness</div>
          <div className="flex items-baseline gap-1">
            <span className="text-[56px] font-semibold leading-none tracking-tight">{m.value}</span>
            <span className="text-sm text-muted-foreground">/100</span>
          </div>
        </div>
        <div className="flex flex-col gap-1 pb-1">
          {m.status && (
            <StatusBadge level={m.status.level ?? "good"} label={`${m.status.label} readiness`} />
          )}
          {details.garminFeedback && (
            <span className="text-xs text-muted-foreground">Garmin: {details.garminFeedback}</span>
          )}
          {details.recoveryHours !== null && details.recoveryHours > 0 && (
            <span className="text-xs text-muted-foreground">
              Recovery time {formatHours(details.recoveryHours)}
            </span>
          )}
        </div>
      </div>
      {details.factorsWeakestFirst.length > 0 && (
        <div>
          <div className="mb-1 text-xs text-muted-foreground">Readiness factors, weakest first</div>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {details.factorsWeakestFirst.map((f) => (
              <li key={f.name}>
                {f.level ? (
                  <StatusBadge
                    level={f.level}
                    label={`${f.name} · ${f.feedback ? humanize(f.feedback).toLowerCase() : "–"}`}
                  />
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {f.name} · {f.feedback ? humanize(f.feedback).toLowerCase() : "–"}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MetricTiles({ b }: { b: Briefing }) {
  const m = b.metrics;
  const soFar = b.isToday ? " so far" : "";

  // Sleep: score as the value, duration vs Garmin's optimal as the delta
  const dur = m.sleepDuration;
  const stages = (m.sleepScore.details ?? dur.details)?.stages as
    | Record<string, { hours: number }>
    | undefined;
  const sleepDelta: StatDelta | undefined =
    dur.value !== null && dur.baseline?.low !== undefined && dur.delta !== null
      ? {
          text: dur.delta === 0 ? "In range" : signed(dur.delta, formatHours),
          baseline: `vs optimal ${bandText(dur.baseline.low, dur.baseline.high!, formatHours)}`,
        }
      : undefined;
  const sleepFoot =
    dur.value !== null
      ? [
          `${formatHours(dur.value)} asleep`,
          stages && `deep ${formatHours(stages.deep!.hours)}`,
          stages && `REM ${formatHours(stages.rem!.hours)}`,
        ]
          .filter(Boolean)
          .join(" · ")
      : undefined;

  const hrv = m.hrv;
  const hrvRange = (hrv.details?.balancedRange ?? null) as { low: number; high: number } | null;

  const bb = m.bodyBattery;
  const bbd = (bb.details ?? {}) as Record<string, number | null>;

  const rhr = m.restingHeartRate;
  const stress = m.stress;
  const steps = m.steps;

  return (
    <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:grid-cols-3">
      <StatTile
        label="Sleep score"
        value={m.sleepScore.value}
        delta={sleepDelta}
        status={statusOf(m.sleepScore)}
        footnote={m.sleepScore.value === null && dur.value === null ? dur.missing : sleepFoot}
      />
      <StatTile
        label="HRV last night"
        value={hrv.value}
        unit="ms"
        delta={
          hrv.delta !== null && hrv.baseline?.value !== undefined
            ? { text: signed(hrv.delta), baseline: `vs 7-night avg ${hrv.baseline.value}` }
            : undefined
        }
        status={statusOf(hrv)}
        trend={
          hrv.value !== null && hrv.trend && hrv.trend.length >= 2
            ? {
                values: hrv.trend.map((t) => t.value),
                label: `Nightly HRV, last ${hrv.trend.length} nights`,
              }
            : undefined
        }
        footnote={
          hrv.value === null
            ? hrv.missing
            : hrvRange
              ? `Balanced range ${hrvRange.low}–${hrvRange.high} ms`
              : undefined
        }
      />
      <StatTile
        label="Body battery"
        value={bb.value}
        delta={
          bb.delta !== null && bb.baseline?.value !== undefined
            ? { text: signed(bb.delta), baseline: `since wake (${bb.baseline.value})` }
            : undefined
        }
        footnote={
          bb.value === null
            ? bb.missing
            : [
                bbd.high != null && bbd.low != null ? `High ${bbd.high} · low ${bbd.low}` : null,
                bbd.charged != null ? `+${bbd.charged} charged` : null,
                bbd.drained != null ? `−${bbd.drained} drained` : null,
              ]
                .filter(Boolean)
                .join(" · ")
        }
      />
      <StatTile
        label="Resting HR"
        value={rhr.value}
        unit="bpm"
        delta={
          rhr.delta !== null && rhr.baseline?.value !== undefined
            ? { text: signed(rhr.delta), baseline: `vs 7-day avg ${rhr.baseline.value}` }
            : undefined
        }
        status={statusOf(rhr)}
        footnote={rhr.value === null ? rhr.missing : undefined}
      />
      <StatTile
        label={`Avg stress${soFar}`}
        value={stress.value}
        status={statusOf(stress)}
        footnote={
          stress.value === null
            ? stress.missing
            : stress.baseline
              ? `${stress.baseline.name.replace("Garmin ", "In ")} ${stress.baseline.low}–${stress.baseline.high} of 100`
              : undefined
        }
      />
      <StatTile
        label={`Steps${soFar}`}
        value={steps.value === null ? null : fmtNum(steps.value)}
        delta={
          steps.delta !== null && steps.baseline?.value !== undefined
            ? { text: signed(steps.delta), baseline: `vs goal ${fmtNum(steps.baseline.value)}` }
            : undefined
        }
        status={statusOf(steps)}
        footnote={
          steps.value === null
            ? steps.missing
            : steps.details?.percentOfGoal != null
              ? `${steps.details.percentOfGoal as number}% of daily goal`
              : undefined
        }
      />
    </div>
  );
}

function ActivityRow({ b }: { b: Briefing }) {
  const a = b.lastActivity;
  const w = b.last7Days;
  if (!a && !w) return null;
  const when = a
    ? a.daysAgo === 0
      ? "today"
      : a.daysAgo === 1
        ? "yesterday"
        : `${a.daysAgo} days ago`
    : "";
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/50 p-3 text-sm">
      <div className="text-xs text-muted-foreground">Last activity</div>
      {a ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="font-medium">{a.name ?? (a.type ? humanize(a.type) : "Activity")}</span>
          <span className="text-xs text-muted-foreground">
            {[
              a.type && a.name ? humanize(a.type) : null,
              `${parseDate(a.startTimeLocal.slice(0, 10)).toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })} (${when})`,
              a.distanceKm ? `${a.distanceKm.toFixed(2)} km` : null,
              a.durationMin ? formatHours(a.durationMin / 60) : null,
              a.aerobicTrainingEffect !== null ? `aerobic TE ${a.aerobicTrainingEffect}` : null,
              a.anaerobicTrainingEffect !== null
                ? `anaerobic TE ${a.anaerobicTrainingEffect}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No recent activities</div>
      )}
      {w && (
        <div className="text-xs text-muted-foreground">
          Past 7 days: {w.activities} {w.activities === 1 ? "activity" : "activities"}
          {w.distanceKm > 0 && ` · ${w.distanceKm} km`}
          {w.durationMin > 0 && ` · ${formatHours(w.durationMin / 60)}`}
        </div>
      )}
    </div>
  );
}

export function BriefingView({ callTool, args }: { callTool: CallTool; args?: ToolArgs }) {
  const { canShareContext, shareContext } = useAppActions();
  const date = args?.date ?? formatDate(new Date());
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    callTool("get-daily-briefing", { date })
      .then((data) => {
        if (!cancelled) setBriefing(data as unknown as Briefing);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load briefing");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [callTool, date]);

  // Tell Claude what's on screen, once per loaded briefing
  useEffect(() => {
    if (briefing && canShareContext) {
      void shareContext(briefingSummary(briefing), { view: "briefing", date: briefing.date }).catch(
        () => {},
      );
    }
  }, [briefing, canShareContext, shareContext]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">
          Daily briefing
          {briefing && (
            <span className="font-normal text-muted-foreground"> · {dateHeading(briefing)}</span>
          )}
        </CardTitle>
        {briefing?.trainingStatus && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>Training status</span>
            {briefing.trainingStatus.level ? (
              <StatusBadge
                level={briefing.trainingStatus.level}
                label={briefing.trainingStatus.label}
              />
            ) : (
              <span>{briefing.trainingStatus.label}</span>
            )}
            {briefing.trainingStatus.acwrStatus && (
              <span>Acute load: {briefing.trainingStatus.acwrStatus.toLowerCase()}</span>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading && !briefing && (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            Loading briefing...
          </div>
        )}
        {error && (
          <div className="flex h-48 items-center justify-center text-sm text-destructive">
            {error}
          </div>
        )}
        {briefing && !error && (
          <div className={`flex flex-col gap-4 ${loading ? "opacity-60" : ""}`}>
            <ReadinessHero m={briefing.metrics.trainingReadiness} />
            <MetricTiles b={briefing} />
            <ActivityRow b={briefing} />
            {briefing.failed.length > 0 && (
              <div className="text-xs text-muted-foreground">
                Couldn't load: {briefing.failed.join(", ")}.
              </div>
            )}
            <AskAssistant questions={briefingQuestions(briefing)} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
