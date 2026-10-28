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
  /** Decrypt a password encrypted with the last issued key; the key is then gone. */
  decryptPassword(ciphertext: string): Promise<string>;
  /** A Garmin call needs a sign-in: resolves once the user signed in through the app. */
  waitForSignIn(): Promise<void>;
  /** The user signed in through the app. */
  signedIn(): void;
}

export interface ServerDeps {
  mode: "local" | "remote";
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
  /** Extra `_meta` for the UI resource. */
  resourceMeta?: Record<string, unknown>;
}
