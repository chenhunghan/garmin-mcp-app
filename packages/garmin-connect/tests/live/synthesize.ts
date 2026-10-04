/**
 * Replace the values in sanitized captures with synthetic ones, so fixtures
 * keep Garmin's structure and types but contain nobody's data. Randomness is
 * unseeded on purpose: originals can't be recovered from the code.
 *
 * - Metrics: a random factor per field (and per column of positional arrays),
 *   forced away from 1 (0.6–0.85x or 1.15–1.4x), plus ±10% noise per value.
 *   Small integer codes (e.g. sleep stage levels) are replaced outright.
 * - Timestamps: every value is replaced by a uniformly random instant in the
 *   capture's date window, independent of the real value. Anything derived
 *   from the real time (shared or per-value shifts) leaked: Garmin repeats the
 *   same instant across many fields, and intersecting them recovered the time
 *   zone and narrowed activity/sleep times. Series are therefore unordered and
 *   timestamps don't line up with plain dates, which are kept (URLs need them).
 * - Body weight/height are fixed placeholders, not random draws.
 * - IDs: kept only if they are the sanitizer's fakes (used in URLs); any other
 *   ID becomes a random fake. Structural keys (indexes, order, versions,
 *   years/months, zone numbers) are kept.
 * - Device and settings responses: every string becomes generic (model, SKU,
 *   firmware, gender, preferences). Health status labels and workout names
 *   become placeholders.
 */

const STRUCTURAL =
  /(index|order|version|sequence|^year|^month|dayofmonth|daysinmonth|daysinprevmonth|zonenumber|iterations)$/i;
const ID_KEY = /(id|pk|number)$/i;
// Health categories (sleep qualifiers, readiness feedback, heat trend, ...)
const LABEL_KEY =
  /status|feedback|qualifier|insight|trend|phrase|message|level|label|rating|type|key|group/i;
const ENUM_VALUE = /^[A-Z][A-Z0-9_]+$/;

/** Responses that describe the device or the person rather than activity data. */
const GENERIC_STRINGS = new Set([
  "devices",
  "primaryTrainingDevice",
  "deviceLastUsed",
  "userSettings",
]);

/** Device model details can appear in any response (e.g. trainingStatus). */
const DEVICE_KEY =
  /^(deviceName|productDisplayName|deviceTypeSimpleName|applicationKey|partNumber|productSku|actualProductSku|currentFirmwareVersion|lastUsedDeviceName|lastUsedDeviceApplicationKey|imageURL|imageUrl)$/;

const REPLACE: Record<string, string> = {
  workoutName: "Sample workout",
  description: "Sample workout",
  customMakeModel: "Running Shoes",
};

const WEIGHT_GRAMS = 55_000;
const HEIGHT_CM = 160;
const EPOCH_MS_MIN = 1e11; // ~1973; smaller numbers aren't timestamps
const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

const randomFactor = () =>
  Math.random() < 0.5 ? 0.6 + Math.random() * 0.25 : 1.15 + Math.random() * 0.25;

/**
 * @param keepIds fake IDs from the sanitizer, which request URLs depend on
 * @param window epoch-ms range that synthetic timestamps are drawn from
 */
export function makeSynthesizer(keepIds: Set<number>, window: { from: number; to: number }) {
  const randomInstant = () => Math.round(window.from + Math.random() * (window.to - window.from));
  const factors = new Map<string, number>();
  const ids = new Map<number, number>();
  let gear = 0;

  const factorFor = (key: string) => {
    if (!factors.has(key)) factors.set(key, randomFactor());
    return factors.get(key)!;
  };
  const fakeId = (real: number) => {
    if (!ids.has(real)) {
      const digits = String(Math.trunc(Math.abs(real))).length;
      ids.set(real, Math.floor(10 ** (digits - 1) * (1 + Math.random() * 8)));
    }
    return ids.get(real)!;
  };
  /** Random instant in the same string format (separator, fraction, zone suffix). */
  const randomDateTime = (s: string): string => {
    const m = DATE_TIME_RE.exec(s)!;
    const t = new Date(randomInstant()).toISOString();
    return `${t.slice(0, 10)}${s[10]}${t.slice(11, 19)}${m[3] ?? ""}${m[4] ?? ""}`;
  };

  function synth(v: unknown, key: string, fixture: string): unknown {
    if (typeof v === "number") {
      if (v >= EPOCH_MS_MIN) return randomInstant();
      if (v === 0 || STRUCTURAL.test(key) || keepIds.has(v)) return v;
      // Independent of the real value, so no scale factor can land near it
      // Fixed placeholders: random draws landed near the real weight in 3 runs
      if (key === "weight") return v > 1000 ? WEIGHT_GRAMS : WEIGHT_GRAMS / 1000;
      if (key === "height") return HEIGHT_CM;
      if (ID_KEY.test(key) && Number.isInteger(v) && (v >= 100 || GENERIC_STRINGS.has(fixture))) {
        return fakeId(v);
      }
      if (Number.isInteger(v) && Math.abs(v) <= 5) return Math.floor(Math.random() * 5);
      const out = v * factorFor(key) * (0.9 + Math.random() * 0.2);
      return Number.isInteger(v) ? Math.round(out) : Number(out.toFixed(4));
    }
    if (typeof v === "string") {
      if (DATE_TIME_RE.test(v)) return randomDateTime(v);
      if (key in REPLACE) return REPLACE[key];
      if (DEVICE_KEY.test(key)) return "Garmin Watch";
      if (GENERIC_STRINGS.has(fixture)) return "sample";
      // Gear entries carry their model in displayName (the profile one is "test-user")
      if (key === "displayName" && v !== "test-user") return `Gear ${++gear}`;
      if (LABEL_KEY.test(key) && ENUM_VALUE.test(v)) return "SAMPLE";
      return v;
    }
    if (Array.isArray(v)) {
      // Tuple columns (e.g. [timestamp, heartRate]) each get their own factor
      return v.map((x) =>
        Array.isArray(x) && x.every((n) => typeof n === "number" || n === null)
          ? x.map((n, i) => synth(n, `${key}#${i}`, fixture))
          : synth(x, key, fixture),
      );
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => {
          // Positional metrics (activity chart data): one factor per column
          if (k === "metrics" && Array.isArray(x)) {
            return [k, x.map((n, i) => synth(n, `metrics#${i}`, fixture))];
          }
          return [k, synth(x, k, fixture)];
        }),
      );
    }
    return v;
  }

  return (body: unknown, fixture: string) => synth(body, "", fixture);
}
