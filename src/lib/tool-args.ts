import { parseDate } from "./dates.ts";

/**
 * Arguments of the tool call that opened the app, echoed by the server in
 * `structuredContent.args`, so a chart shows what Claude asked for (a date or
 * an activity) instead of today/latest.
 */
export interface ToolArgs {
  date?: string;
  endDate?: string;
  activityId?: string | number;
  workoutId?: string | number;
  limit?: number;
  action?: "created" | "updated" | "deleted" | "scheduled";
}

/** Last day a date-range chart should show: the requested date, else today. */
export function anchorDate(args?: ToolArgs): Date {
  const s = args?.endDate ?? args?.date;
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? parseDate(s) : new Date();
}

/** True when the chart is anchored on a past day rather than today. */
export function isPastAnchor(args?: ToolArgs): boolean {
  const end = anchorDate(args);
  const today = new Date();
  return end.toDateString() !== today.toDateString() && end < today;
}

/**
 * Title suffix naming the requested day when it isn't today, e.g.
 * " · to Sun, Sep 20" for a range or " · Sun, Sep 20" for a single day.
 */
export function anchorSuffix(args: ToolArgs | undefined, kind: "range" | "day"): string {
  if (!isPastAnchor(args)) return "";
  const label = anchorDate(args).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return kind === "range" ? ` · to ${label}` : ` · ${label}`;
}

/** "Last 7 days" only makes sense when the range ends today. */
export function rangeLabel(label: string, args: ToolArgs | undefined): string {
  return isPastAnchor(args) ? label.replace(/^Last /, "") : label;
}
