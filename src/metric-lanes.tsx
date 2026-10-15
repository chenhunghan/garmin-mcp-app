/**
 * Every metric of the run at once, in heads-up-display panels by group (run,
 * terrain, form, body): the value at the playhead (or under the pointer) and
 * a sparkline of the whole run on the metric's own scale. Hovering any
 * sparkline or the timeline shows every metric at that moment; clicking or
 * dragging a sparkline seeks; a colorable metric's name colors the route by
 * it, and its sparkline then turns the accent color over the route's strip.
 */
import { useId, useMemo } from "react";
import { hrZone, locate, paceLabel, valueAt, type ReplayData } from "./replay-model.ts";
import {
  COLOR_BY_LABEL,
  ZONE_COLORS,
  cssColor,
  sampleColors,
  type ColorBy,
} from "./replay/colors.ts";
import type { Track } from "./replay/track.ts";
import { HUD_ACCENT, HudPanel, hudLabel } from "./replay-hud.tsx";

type Channel = keyof ReplayData["channels"];

interface Lane {
  key: string;
  label: string;
  unit?: string;
  group: string;
  /** Value at a sample position */
  at: (p: { i: number; f: number }) => number | null;
  format: (v: number) => string;
  /** Short note next to the value (HR zone) */
  note?: (v: number) => string | null;
  /** Colors the route */
  colorBy?: ColorBy;
}

function lanesFor(data: ReplayData, track: Track, zones: number[] | null): Lane[] {
  const c = data.channels;
  const out: Lane[] = [];
  const ch = (
    k: Channel,
    label: string,
    group: string,
    unit: string | undefined,
    format: (v: number) => string,
    extra: Partial<Lane> = {},
  ) => {
    if (!c[k]) return;
    out.push({
      key: k,
      label,
      group,
      unit,
      at: (p) => valueAt(c[k] as never, p),
      format,
      ...extra,
    });
  };
  const round = (v: number) => String(Math.round(v));
  ch("speed", "Pace", "Run", "/km", (v) => paceLabel(v) ?? "–", { colorBy: "pace" });
  ch("gap", "Grade-adj. pace", "Run", "/km", (v) => paceLabel(v) ?? "–");
  ch("hr", "Heart rate", "Run", "bpm", round, {
    colorBy: "hr",
    note: (v) => {
      const z = hrZone(v, zones);
      return z ? `Z${z}` : null;
    },
  });
  ch("cad", "Cadence", "Run", "spm", round, { colorBy: "cadence" });
  ch("power", "Power", "Run", "W", round, { colorBy: "power" });
  ch("elev", "Elevation", "Terrain", "m", round, { colorBy: "elevation" });
  if (c.elev)
    out.push({
      key: "grade",
      label: "Grade",
      group: "Terrain",
      unit: "%",
      at: (p) => {
        const a = track.grade[p.i] ?? 0;
        const b = track.grade[p.i + 1] ?? a;
        return (a + (b - a) * p.f) * 100;
      },
      format: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}`,
      colorBy: "grade",
    });
  ch("stride", "Stride", "Form", "m", (v) => v.toFixed(2));
  ch("gct", "Ground contact", "Form", "ms", round);
  ch("vo", "Vert. oscillation", "Form", "cm", (v) => v.toFixed(1));
  ch("vr", "Vert. ratio", "Form", "%", (v) => v.toFixed(1));
  ch("perf", "Perf. condition", "Body", undefined, (v) => `${v >= 0 ? "+" : ""}${Math.round(v)}`);
  ch("stamina", "Stamina", "Body", "%", round);
  ch("resp", "Breathing", "Body", "brpm", round);
  ch("temp", "Watch temp", "Body", "°C", round);
  return out;
}

const W = 1000;
const H = 20;
const BUCKETS = 200;
const LETTERS = "ABCDEFGH";

export function MetricPanels({
  data,
  track,
  zones,
  t,
  duration,
  hover,
  onHover,
  colorBy,
  onColorBy,
  onSeek,
  groups,
  firstLetter = 0,
  className = "",
}: {
  data: ReplayData;
  track: Track;
  zones: number[] | null;
  t: number;
  duration: number;
  hover: number | null;
  onHover: (t: number | null) => void;
  colorBy: ColorBy;
  onColorBy: (c: ColorBy) => void;
  onSeek: (t: number) => void;
  /** Which groups this column shows (all when omitted) */
  groups?: string[];
  /** Index letter of the first panel (panels are lettered across columns) */
  firstLetter?: number;
  className?: string;
}) {
  const all = useMemo(() => lanesFor(data, track, zones), [data, track, zones]);
  const lanes = useMemo(
    () => (groups ? all.filter((l) => groups.includes(l.group)) : all),
    [all, groups],
  );
  const gradientId = `hud${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  // One path per metric, each on its own robust range (2nd–98th percentile)
  const paths = useMemo(() => {
    const ts = data.channels.t;
    const pos = Array.from({ length: BUCKETS + 1 }, (_, b) => locate(ts, (b / BUCKETS) * duration));
    return lanes.map((lane) => {
      const vals = pos.map((p) => lane.at(p));
      const sorted = vals
        .filter((v): v is number => v !== null && Number.isFinite(v))
        .sort((a, b) => a - b);
      if (sorted.length < 2) return "";
      let lo = sorted[Math.floor(sorted.length * 0.02)]!;
      let hi = sorted[Math.ceil(sorted.length * 0.98) - 1]!;
      if (hi - lo < 1e-6) {
        lo -= 1;
        hi += 1;
      }
      let d = "";
      let pen = false;
      vals.forEach((v, b) => {
        if (v === null || !Number.isFinite(v)) {
          pen = false;
          return;
        }
        const y = 1.5 + (1 - Math.max(0, Math.min(1, (v - lo) / (hi - lo)))) * (H - 5);
        d += `${pen ? "L" : "M"}${((b / BUCKETS) * W).toFixed(1)},${y.toFixed(1)}`;
        pen = true;
      });
      return d;
    });
  }, [lanes, data, duration]);

  const strip = useMemo(() => {
    const colors = sampleColors(data, colorBy, track.grade, track.y);
    const ts = data.channels.t;
    return Array.from({ length: 121 }, (_, b) => {
      const { i } = locate(ts, (b / 120) * duration);
      return { offset: b / 120, color: cssColor(colors, i) };
    });
  }, [data, colorBy, track, duration]);

  const at = locate(data.channels.t, hover ?? t);
  const px = (time: number) => `${duration > 0 ? (time / duration) * 100 : 0}%`;
  const timeAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
  };

  const byGroup = new Map<string, number[]>();
  lanes.forEach((l, k) => {
    const list = byGroup.get(l.group) ?? [];
    list.push(k);
    byGroup.set(l.group, list);
  });

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <svg width="0" height="0" className="absolute" aria-hidden>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
            {strip.map((s) => (
              <stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
        </defs>
      </svg>
      {[...byGroup.entries()].map(([group, idx], g) => (
        <HudPanel
          key={group}
          letter={LETTERS[firstLetter + g]}
          title={group}
          aside={hover !== null ? "at cursor" : "live"}
        >
          <div className="flex flex-col gap-1.5">
            {idx.map((k) => {
              const lane = lanes[k]!;
              const v = lane.at(at);
              const active = lane.colorBy === colorBy;
              const label = (
                <>
                  {lane.label}
                  {lane.key === "hr" && v !== null && (
                    <span
                      className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                      style={{ backgroundColor: ZONE_COLORS[hrZone(v, zones)] }}
                    />
                  )}
                </>
              );
              return (
                <div key={lane.key}>
                  <div className="flex items-baseline gap-2">
                    {lane.colorBy ? (
                      <button
                        type="button"
                        onClick={() => onColorBy(lane.colorBy!)}
                        title={`Color the route by ${COLOR_BY_LABEL[lane.colorBy].toLowerCase()}`}
                        aria-pressed={active}
                        className={`${hudLabel} truncate text-left hover:text-white`}
                        style={active ? { color: HUD_ACCENT } : undefined}
                      >
                        {label}
                      </button>
                    ) : (
                      <span className={`${hudLabel} truncate`}>{label}</span>
                    )}
                    <span className="ml-auto whitespace-nowrap font-mono tabular-nums">
                      <span className="text-[15px] font-light tracking-wide text-white">
                        {v !== null ? lane.format(v) : "–"}
                      </span>
                      {lane.unit && (
                        <span className="ml-1 text-[9.5px] uppercase tracking-wider text-white/45">
                          {lane.unit}
                        </span>
                      )}
                      {v !== null && lane.note?.(v) && (
                        <span className="ml-1 text-[9.5px] text-white/45">{lane.note(v)}</span>
                      )}
                    </span>
                  </div>
                  <div
                    className="relative h-5 cursor-pointer touch-none select-none"
                    onPointerDown={(e) => {
                      (e.target as Element).setPointerCapture(e.pointerId);
                      onSeek(timeAt(e));
                    }}
                    onPointerMove={(e) => {
                      onHover(timeAt(e));
                      if (e.buttons & 1) onSeek(timeAt(e));
                    }}
                    onPointerLeave={() => onHover(null)}
                  >
                    <svg
                      viewBox={`0 0 ${W} ${H}`}
                      preserveAspectRatio="none"
                      className="absolute inset-0 h-full w-full"
                      aria-hidden
                    >
                      <line
                        x1={0}
                        x2={W}
                        y1={H - 0.5}
                        y2={H - 0.5}
                        stroke="white"
                        strokeOpacity={0.12}
                        vectorEffect="non-scaling-stroke"
                      />
                      {active && (
                        <rect x={0} y={H - 2} width={W} height={2} fill={`url(#${gradientId})`} />
                      )}
                      <path
                        d={paths[k]!}
                        fill="none"
                        stroke={active ? HUD_ACCENT : "white"}
                        strokeOpacity={active ? 1 : 0.75}
                        strokeWidth={1}
                        strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                    <div
                      className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2"
                      style={{ left: px(t), backgroundColor: HUD_ACCENT }}
                    />
                    {hover !== null && (
                      <div
                        className="pointer-events-none absolute inset-y-0 w-px -translate-x-1/2 bg-white/60"
                        style={{ left: px(hover) }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </HudPanel>
      ))}
    </div>
  );
}
