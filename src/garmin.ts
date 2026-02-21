import { GarminClient } from "garmin-connect";

let client: GarminClient | null = null;

export function getClient(): GarminClient {
  if (!client) {
    client = new GarminClient({
      storagePath: process.env.GARMIN_TOKEN_PATH ?? "~/.garminconnect",
    });
  }
  return client;
}
