/**
 * Stat tile, per the dataviz contract: label (sentence case) · value
 * (semibold, proportional figures) · optional delta vs a named baseline ·
 * optional status (icon + label + colored dot, never color alone) · optional
 * sparkline (de-emphasis line, latest point in the accent).
 */

export type StatusLevel = "good" | "warning" | "critical";

const STATUS_ICON: Record<StatusLevel, string> = { good: "✓", warning: "!", critical: "✕" };

export interface StatDelta {
  /** e.g. "+4 bpm", "−12%" */
  text: string;
  /** vs what, e.g. "vs 7-day avg" */
  baseline: string;
  /** Whether this change is good news; drives the status color, not the arrow */
  tone?: StatusLevel | "neutral";
}

export function StatusBadge({ level, label }: { level: StatusLevel; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span
        aria-hidden
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] font-bold text-white"
        style={{ backgroundColor: `var(--status-${level})` }}
      >
        {STATUS_ICON[level]}
      </span>
      {label}
    </span>
  );
}

export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const pts = values
    .map((v, i) => (v == null ? null : { i, v }))
    .filter((p): p is { i: number; v: number } => p !== null);
  if (pts.length < 2) return null;
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const W = 96;
  const H = 24;
  const x = (i: number) => 2 + (i / (values.length - 1)) * (W - 4);
  const y = (v: number) => (max === min ? H / 2 : H - 3 - ((v - min) / (max - min)) * (H - 6));
  const last = pts.at(-1)!;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <polyline
        points={pts.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeOpacity={0.5}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={x(last.i)}
        cy={y(last.v)}
        r={3}
        fill="var(--chart-3)"
        stroke="var(--card, var(--background))"
        strokeWidth={2}
      />
    </svg>
  );
}

export function StatTile({
  label,
  value,
  unit,
  delta,
  status,
  trend,
  footnote,
}: {
  label: string;
  value: string | number | null | undefined;
  unit?: string;
  delta?: StatDelta;
  status?: { level: StatusLevel; label: string };
  trend?: { values: (number | null)[]; label: string };
  footnote?: string;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-end justify-between gap-2">
        <div className="text-2xl font-semibold leading-none">
          {empty ? "–" : value}
          {!empty && unit && (
            <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>
          )}
        </div>
        {trend && <Sparkline values={trend.values} label={trend.label} />}
      </div>
      {delta && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {delta.tone && delta.tone !== "neutral" && (
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: `var(--status-${delta.tone})` }}
            />
          )}
          <span className="font-medium text-foreground">{delta.text}</span>
          <span>{delta.baseline}</span>
        </div>
      )}
      {status && <StatusBadge level={status.level} label={status.label} />}
      {footnote && <div className="text-xs text-muted-foreground">{footnote}</div>}
    </div>
  );
}
