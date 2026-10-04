/**
 * Local calendar dates. Garmin dates (YYYY-MM-DD) are the user's local days;
 * toISOString() would print UTC and land on the previous day east of UTC.
 */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD as local midnight (new Date("YYYY-MM-DD") would be UTC). */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}
