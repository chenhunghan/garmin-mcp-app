/**
 * Today's calendar day (YYYY-MM-DD) in `timeZone` (IANA), else in the
 * server's own time zone — which is the user's for the stdio build, UTC on
 * Workers.
 */
export function today(timeZone?: string, now = new Date()): string {
  if (timeZone) {
    try {
      // en-CA formats dates as YYYY-MM-DD
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now);
    } catch {
      // Unknown time zone: fall back to the server's
    }
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
