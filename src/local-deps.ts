/**
 * The stdio server's dependencies: tokens and settings in ~/.garminconnect
 * (or GARMIN_TOKEN_PATH), caches in ~/.cache/run-coach, sign-in through the
 * app with a key held in memory.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerDeps } from "./deps.js";
import { getClient } from "./garmin.js";
import { readSettings, updateSettings } from "./settings.js";
import { cachedFetch } from "./geo/fetch.js";
import { readAsset } from "./asset-store.js";
import { notifyAuth, waitForAuth } from "./auth-gate.js";
import { decryptWithLoginKey, issueLoginKey } from "./login-key.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function localDeps(): ServerDeps {
  return {
    getClient,
    settings: { read: readSettings, update: updateSettings },
    geoFetch: cachedFetch,
    readAsset,
    loadAppHtml: () => readFile(resolve(__dirname, "app.html"), "utf-8"),
    auth: {
      issueLoginKey: async () => issueLoginKey(),
      login: async (email, encryptedPassword) => {
        const result = await getClient().login(email, decryptWithLoginKey(encryptedPassword));
        if (result.status === "needs_mfa") return { status: "needs_mfa" };
        notifyAuth();
        return { status: "success" };
      },
      submitMfa: async (code) => {
        await getClient().submitMfa(code);
        notifyAuth();
      },
      waitForSignIn: () => waitForAuth(),
    },
  };
}
