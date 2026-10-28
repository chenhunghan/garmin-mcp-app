/**
 * What the MCP server needs from where it runs. The stdio build (Claude
 * Desktop, ChatGPT desktop, npx) passes `localDeps()` from local-deps.ts;
 * tools take these instead of importing Node modules or a global client.
 */
import type { GarminClient } from "garmin-connect";

export interface Settings {
  /**
   * Fetch real elevation (AWS Terrain Tiles) and map data (OpenStreetMap) for
   * the area around a run in the replay. Off by default: it sends the run's
   * area to those services.
   */
  realMap: boolean;
}

export interface GeoFetchOptions {
  /** POST body (form-encoded); GET when absent. */
  body?: string;
  /** Refetch after this many days; cached forever when absent. */
  maxAgeDays?: number;
  timeoutMs?: number;
}

/** HTTP for public map services, cached so an area is fetched once. */
export type GeoFetch = (url: string, opts?: GeoFetchOptions) => Promise<Uint8Array>;

/** Garmin sign-in through the app's form. */
export interface AuthAdapter {
  /** A single-use RSA-OAEP public key (base64 SPKI DER) the app encrypts the password with. */
  issueLoginKey(): Promise<string>;
  /** Sign in with a password encrypted with the last issued key (the key is then gone). */
  login(email: string, encryptedPassword: string): Promise<{ status: "success" | "needs_mfa" }>;
  /** Finish a sign-in that needed a verification code. */
  submitMfa(code: string): Promise<void>;
  /**
   * A Garmin call needs a sign-in. Local: resolves once the user signed in
   * through the app. Remote: throws SignInRequiredError (requests can't wait).
   */
  waitForSignIn(): Promise<void>;
  /** Remote: the error with a one-time sign-in page, for clients that can't show the app. */
  signInRequired?(): Promise<SignInRequiredError>;
}

/** Garmin isn't signed in and the request can't wait for it. */
export class SignInRequiredError extends Error {
  readonly signInUrl: string;
  constructor(signInUrl: string, validMinutes: number) {
    super(
      `Not signed in to Garmin Connect. Sign in with the form in the app, or open ${signInUrl} (valid for ${validMinutes} minutes), then try again.`,
    );
    this.name = "SignInRequiredError";
    this.signInUrl = signInUrl;
  }
}

export interface ServerDeps {
  /** Garmin client bound to this server's token storage. */
  getClient(): GarminClient;
  settings: {
    read(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
  };
  geoFetch: GeoFetch;
  /** One file of the replay's asset pack. */
  readAsset(file: string): Promise<Uint8Array>;
  /** The bundled app (dist/app.html). */
  loadAppHtml(): Promise<string>;
  auth: AuthAdapter;
  /**
   * Most Garmin requests one tool call may make (Workers free plan: 50
   * subrequests per request). Unlimited when absent.
   */
  garminRequestBudget?: number;
  /**
   * The user's time zone (IANA) for "today", when the server runs elsewhere.
   * Absent: the server's own time zone.
   */
  timeZone?: string;
  /** Why the replay's real map (elevation + OpenStreetMap) can't be turned on here. */
  realMapUnavailable?: string;
}
