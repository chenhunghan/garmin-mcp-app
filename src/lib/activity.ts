import { parseDate } from "./dates.ts";
import type { ToolArgs } from "./tool-args.ts";

type CallTool = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<Record<string, unknown> | null>;

/**
 * The activity a chart should show: the one the tool call asked for, else the
 * most recent. Returns null when there are no activities.
 */
export async function resolveActivity(
  callTool: CallTool,
  args?: ToolArgs,
): Promise<ResolvedActivity | null> {
  if (args?.activityId !== undefined && args.activityId !== "") {
    const details = await callTool("get-activity-details", { activityId: args.activityId });
    const summary = details?.summaryDTO as { startTimeLocal?: string } | undefined;
    return {
      id: String(args.activityId),
      name: (details?.activityName as string) ?? null,
      date: formatActivityDate(summary?.startTimeLocal),
    };
  }
  const latest = await callTool("get-activities", { start: 0, limit: 1 });
  const first = Array.isArray(latest)
    ? (latest[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!first?.activityId) return null;
  return {
    id: String(first.activityId),
    name: (first.activityName as string) ?? null,
    date: formatActivityDate(first.startTimeLocal as string | undefined),
  };
}

export interface ResolvedActivity {
  id: string;
  name: string | null;
  /** e.g. "Wed, Oct 1" — activities are often auto-named the same, so the date tells them apart */
  date: string | null;
}

/** Garmin local start time ("YYYY-MM-DD HH:mm:ss" or ISO) → "Wed, Oct 1". */
function formatActivityDate(startTimeLocal: string | undefined): string | null {
  const day = startTimeLocal?.slice(0, 10);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return parseDate(day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
