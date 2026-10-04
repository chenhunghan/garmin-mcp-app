/** Local calendar days (YYYY-MM-DD) and Garmin's timestamp formats. */

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addDays(date: string, n: number): string {
  const d = parseYmd(date);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** Whole days from a to b (b − a). */
export function dayDiff(a: string, b: string): number {
  return Math.round(
    (Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) -
      Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) /
      86_400_000,
  );
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: string): number {
  return parseYmd(date).getDay();
}

export function mondayOf(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** Epoch ms of a local wall-clock time `secs` seconds after midnight of `date`. */
export function localMs(date: string, secs: number): number {
  return parseYmd(date).getTime() + secs * 1000;
}

function parts(ms: number) {
  const d = new Date(ms);
  return {
    date: ymd(d),
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  };
}

/** "2026-10-03T06:51:05.0" (local wall clock) */
export function localIso(ms: number): string {
  const p = parts(ms);
  return `${p.date}T${p.time}.0`;
}

/** "2026-10-03 06:51:05" (local wall clock, activity list format) */
export function localSpace(ms: number): string {
  const p = parts(ms);
  return `${p.date} ${p.time}`;
}

/** "2026-10-03T04:51:05.0" (GMT) */
export function gmtIso(ms: number): string {
  return new Date(Math.round(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, ".0");
}

/** "2026-10-03 04:51:05" (GMT, activity list format) */
export function gmtSpace(ms: number): string {
  return gmtIso(ms).replace("T", " ").replace(/\.0$/, "");
}
