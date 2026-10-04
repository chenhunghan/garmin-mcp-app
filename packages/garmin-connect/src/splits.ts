/**
 * Per-km splits computed from an activity's time series, for activities
 * recorded as a single lap (auto-lap off). Garmin Connect shows these too, but
 * the splits endpoint only returns recorded laps.
 */

export interface KmSplit {
  /** 1-based kilometre number (last one may be partial) */
  lapIndex: number;
  /** Metres covered in this split */
  distance: number;
  /** Seconds (timer time) for this split */
  duration: number;
  /** Metres per second */
  averageSpeed: number;
  averageHR?: number;
  maxHR?: number;
  /** Steps per minute */
  averageRunCadence?: number;
}

interface ChartDetails {
  metricDescriptors?: { metricsIndex: number; key: string }[];
  activityDetailMetrics?: { metrics?: (number | null)[] }[];
}

/** Ignore a trailing partial km shorter than this (GPS noise at the end). */
const MIN_PARTIAL_METERS = 50;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

/**
 * Split the activity into whole kilometres (plus a partial last one) using the
 * cumulative distance and duration samples. Returns [] when the time series
 * lacks distance or duration.
 */
export function computeKmSplits(details: ChartDetails): KmSplit[] {
  const col = (key: string) => details.metricDescriptors?.find((d) => d.key === key)?.metricsIndex;
  const iDist = col("sumDistance");
  const iDur = col("sumDuration") ?? col("sumElapsedDuration");
  const iHr = col("directHeartRate");
  const iCad = col("directDoubleCadence") ?? col("directRunCadence");
  if (iDist === undefined || iDur === undefined) return [];

  const samples = (details.activityDetailMetrics ?? [])
    .map((row) => row.metrics ?? [])
    .map((m) => ({
      dist: m[iDist],
      dur: m[iDur],
      hr: iHr === undefined ? null : m[iHr],
      cad: iCad === undefined ? null : m[iCad],
    }))
    .filter(
      (s): s is { dist: number; dur: number; hr: number | null; cad: number | null } =>
        typeof s.dist === "number" && typeof s.dur === "number",
    )
    .sort((a, b) => a.dur - b.dur);
  if (samples.length < 2) return [];

  /** Timer seconds at a given cumulative distance, linearly interpolated. */
  const timeAt = (meters: number): number => {
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      if (b.dist >= meters) {
        const span = b.dist - a.dist;
        return span > 0 ? a.dur + ((meters - a.dist) / span) * (b.dur - a.dur) : b.dur;
      }
    }
    return samples.at(-1)!.dur;
  };

  const total = samples.at(-1)!.dist;
  const splits: KmSplit[] = [];
  for (let k = 1, start = 0; start < total; k++, start += 1000) {
    const end = Math.min(start + 1000, total);
    const distance = end - start;
    if (distance < 1000 && distance < MIN_PARTIAL_METERS) break;
    const duration = timeAt(end) - timeAt(start);
    if (duration <= 0) continue;
    const inSplit = samples.filter((s) => s.dist > start && s.dist <= end);
    const hrs = inSplit.map((s) => s.hr).filter((v): v is number => typeof v === "number" && v > 0);
    const cads = inSplit
      .map((s) => s.cad)
      .filter((v): v is number => typeof v === "number" && v > 0);
    splits.push({
      lapIndex: k,
      distance,
      duration,
      averageSpeed: distance / duration,
      averageHR: mean(hrs) && Math.round(mean(hrs)!),
      maxHR: hrs.length ? Math.max(...hrs) : undefined,
      averageRunCadence: mean(cads) && Math.round(mean(cads)!),
    });
  }
  return splits;
}
