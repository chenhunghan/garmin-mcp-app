/**
 * Scrubs personal data from captured Garmin responses before they are written
 * as test fixtures. Fixtures are committed to a public repo, so this errs on
 * the side of removing too much, and `assertClean` fails if any identifying
 * value from the capture survives.
 */

export interface Exchange {
  method: string;
  url: string;
  status: number;
  body: unknown;
}

const FAKE_PROFILE_ID = 10000001;
const FAKE_DISPLAY_NAME = "test-user";
const FAKE_UUID = "00000000-0000-4000-8000-000000000000";
const MAX_ARRAY = 20;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID_RE = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;
// IDs shorter than this are too likely to collide with ordinary numbers
const MIN_ID = 100_000;

/** Keys whose values are replaced outright, wherever they appear. */
const REDACT: Record<string, unknown> = {
  fullName: "Test User",
  firstName: "Test",
  lastName: "User",
  userName: "user@example.com",
  emailAddress: "user@example.com",
  email: "user@example.com",
  location: null,
  locationName: null,
  city: null,
  address: null,
  phoneNumber: null,
  birthDate: "1990-01-01",
  weight: 70000,
  height: 175,
  bio: null,
  motivation: null,
  personalWebsite: null,
  facebookUrl: null,
  twitterUrl: null,
  profileImageUrlLarge: null,
  profileImageUrlMedium: null,
  profileImageUrlSmall: null,
  imageUrl: null,
  ownerProfileImageUrlLarge: null,
  ownerProfileImageUrlMedium: null,
  ownerProfileImageUrlSmall: null,
  workoutThumbnailUrl: null,
  deviceSettingsFile: null,
  // Garmin auto-names activities after the place, e.g. "<District> Running"
  activityName: "Activity",
  title: "Activity",
  uuid: FAKE_UUID,
  serialNumber: "0000000000",
  unitId: 1000000001,
  deviceId: 1000000001,
  userDeviceId: 1000000001,
  deviceApplicationInstallationId: 1000000001,
  macAddress: null,
  bluetoothAddress: null,
  timeZone: "UTC",
  timezone: "UTC",
  timeZoneId: null,
  timeZoneUnitDTO: null,
  geoPolylineDTO: null,
  weatherStationDTO: null,
};

const isCoordinateKey = (k: string) => /lat(itude)?$|lon(gitude)?$|^lat|^lon/i.test(k);
const isDeviceIdKey = (k: string) => /(deviceId|unitId|InstallationId)$/i.test(k);

interface MetricDescriptor {
  metricsIndex: number;
  key: string;
}

/**
 * Activity chart details store samples as positional arrays
 * (`activityDetailMetrics[].metrics[i]`) named by `metricDescriptors`, so GPS
 * columns can't be found by key. Returns the indexes of coordinate columns.
 */
function coordinateColumns(o: Record<string, unknown>): number[] {
  if (!Array.isArray(o.metricDescriptors) || !Array.isArray(o.activityDetailMetrics)) return [];
  return (o.metricDescriptors as MetricDescriptor[])
    .filter((d) => /latitude|longitude/i.test(d.key))
    .map((d) => d.metricsIndex);
}
const isProfileIdKey = (k: string) =>
  /^(userProfilePK|userProfilePk|userProfileId|userProfileNumber|profileId|userId|ownerId|ownerProfilePk|ownerProfilePK|userPk|profilePk)$/.test(
    k,
  );

/** Identifying values found in the capture, mapped to stable fakes. */
export function collectIdentity(exchanges: Record<string, Exchange[]>): Map<string, string> {
  const map = new Map<string, string>();
  const profile = exchanges.userProfile?.at(-1)?.body as Record<string, unknown> | undefined;
  if (!profile) throw new Error("userProfile capture is required to sanitize");
  const add = (real: unknown, fake: string | number) => {
    if (real !== null && real !== undefined && String(real).length >= 4) {
      map.set(String(real), String(fake));
    }
  };
  add(profile.id, FAKE_PROFILE_ID);
  add(profile.profileId, FAKE_PROFILE_ID);
  add(profile.garminGUID, FAKE_UUID);
  add(profile.displayName, FAKE_DISPLAY_NAME);
  add(profile.fullName, "Test User");
  add(profile.userName, "user@example.com");
  add(profile.location, "");

  // Activity, workout and device IDs get sequential fakes so fixtures stay consistent
  let nextActivity = 1000000001;
  let nextWorkout = 2000000001;
  let nextDevice = 3000000001;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "activityId" && typeof x === "number" && x >= MIN_ID && !map.has(String(x))) {
          map.set(String(x), String(nextActivity++));
        }
        if (k === "workoutId" && typeof x === "number" && x >= MIN_ID && !map.has(String(x))) {
          map.set(String(x), String(nextWorkout++));
        }
        // Device IDs also appear as JSON object keys (e.g. trainingStatus maps)
        if (isDeviceIdKey(k) && (typeof x === "number" || typeof x === "string")) {
          if (/^\d+$/.test(String(x)) && Number(x) >= MIN_ID && !map.has(String(x))) {
            map.set(String(x), String(nextDevice++));
          }
        }
        walk(x);
      }
    }
  };
  for (const list of Object.values(exchanges)) for (const e of list) walk(e.body);
  return map;
}

function replaceInString(s: string, identity: Map<string, string>): string {
  let out = s;
  for (const [real, fake] of identity) {
    if (!out.includes(real)) continue;
    // Numeric IDs only match as whole numbers, never inside a longer number
    out = /^\d+$/.test(real)
      ? out.replace(new RegExp(`(?<!\\d)${real}(?!\\d)`, "g"), fake)
      : out.split(real).join(fake);
  }
  return out.replace(EMAIL_RE, "user@example.com").replace(UUID_RE, FAKE_UUID);
}

function scrub(v: unknown, identity: Map<string, string>, key = ""): unknown {
  if (key in REDACT) {
    const r = REDACT[key];
    // Keep Garmin's type: some IDs are strings in one endpoint, numbers in another
    if (typeof v === "string" && typeof r === "number") return String(r);
    return r;
  }
  if (isCoordinateKey(key) && typeof v === "number") return 0;
  if (isProfileIdKey(key) && typeof v === "number") return FAKE_PROFILE_ID;
  if (typeof v === "number") {
    const fake = identity.get(String(v));
    return fake !== undefined && /^\d+$/.test(fake) ? Number(fake) : v;
  }
  if (typeof v === "string") return replaceInString(v, identity);
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((x) => scrub(x, identity));
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const coords = coordinateColumns(obj);
    const out = Object.fromEntries(
      // Keys too: some maps are keyed by device ID
      Object.entries(obj).map(([k, x]) => [replaceInString(k, identity), scrub(x, identity, k)]),
    );
    if (coords.length) {
      out.activityDetailMetrics = (out.activityDetailMetrics as { metrics: unknown[] }[]).map(
        (row) => ({
          ...row,
          metrics: row.metrics?.map((m, i) => (coords.includes(i) && m !== null ? 0 : m)),
        }),
      );
    }
    return out;
  }
  return v;
}

export function sanitizeExchange(e: Exchange, identity: Map<string, string>): Exchange {
  return {
    method: e.method,
    url: replaceInString(e.url, identity),
    status: e.status,
    body: scrub(e.body, identity),
  };
}

/** Throws if any identifying value or coordinate survived sanitizing. */
export function assertClean(name: string, sanitized: unknown, identity: Map<string, string>) {
  const text = JSON.stringify(sanitized);
  for (const real of identity.keys()) {
    if (real.length >= 4 && text.includes(real)) {
      throw new Error(`${name}: identifying value survived sanitizing`);
    }
  }
  const emails = (text.match(EMAIL_RE) ?? []).filter((m) => m !== "user@example.com");
  if (emails.length) throw new Error(`${name}: email address survived sanitizing`);
  const coords = text.match(/"[a-zA-Z]*(Latitude|Longitude|lat|lon)":\s*-?[1-9]/);
  if (coords)
    throw new Error(`${name}: coordinate survived sanitizing (${coords[0].split(":")[0]})`);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const obj = v as Record<string, unknown>;
    for (const i of coordinateColumns(obj)) {
      for (const row of obj.activityDetailMetrics as { metrics?: unknown[] }[]) {
        const m = row.metrics?.[i];
        if (m !== null && m !== undefined && m !== 0) {
          throw new Error(`${name}: GPS sample survived sanitizing`);
        }
      }
    }
    Object.values(obj).forEach(walk);
  };
  walk(sanitized);
}
