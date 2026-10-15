/**
 * User preferences kept next to the sign-in tokens (run-coach-settings.json).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Settings {
  /**
   * Fetch real elevation (AWS Terrain Tiles) and map data (OpenStreetMap) for
   * the area around a run in the replay. Off by default: it sends the run's
   * area to those services.
   */
  realMap: boolean;
}

const DEFAULTS: Settings = { realMap: false };

function settingsPath() {
  const dir = (process.env.GARMIN_TOKEN_PATH ?? "~/.garminconnect").replace(
    /^~(?=$|\/)/,
    homedir(),
  );
  return join(dir, "run-coach-settings.json");
}

export async function readSettings(): Promise<Settings> {
  try {
    return {
      ...DEFAULTS,
      ...(JSON.parse(await readFile(settingsPath(), "utf-8")) as Partial<Settings>),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings()), ...patch };
  const file = settingsPath();
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2));
  return next;
}
