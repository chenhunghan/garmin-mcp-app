/**
 * ServerDeps for the self-hosted Worker, built per request: Garmin tokens in
 * the vault Durable Object, sign-in through the app or a one-time link, the
 * app from static assets, caches in the Cache API.
 */
import { GarminClient } from "garmin-connect";
import { SignInRequiredError, type ServerDeps } from "../deps.js";
import { cacheGeoFetch, cacheReadAsset } from "./cache.js";
import { Sealer } from "./crypto.js";
import { vaultOf, type Env } from "./env.js";
import { garminLogin, garminMfa } from "./signin.js";
import { createSignInLink } from "./signin-link.js";

/** Garmin requests per tool call: the Workers free plan allows 50 subrequests. */
const GARMIN_REQUEST_BUDGET = 40;

export async function remoteDeps(env: Env, origin: string): Promise<ServerDeps> {
  const vault = vaultOf(env);
  const timeZone = await vault.getTimeZone();
  let client: GarminClient | undefined;
  const signInLink = () => createSignInLink(vault, new Sealer(env.TOKEN_ENCRYPTION_KEY), origin);

  return {
    mode: "remote",
    getClient: () =>
      (client ??= new GarminClient({
        storage: {
          load: () => vault.freshTokens(),
          save: (oauth1, oauth2) => vault.saveTokens({ oauth1, oauth2 }),
          clear: () => vault.clearTokens(),
        },
      })),
    settings: {
      read: () => vault.getSettings(),
      update: (patch) => vault.updateSettings(patch),
    },
    geoFetch: cacheGeoFetch,
    readAsset: cacheReadAsset,
    loadAppHtml: async () => {
      const res = await env.ASSETS.fetch(new URL("/app.html", origin));
      if (!res.ok) throw new Error(`app.html is missing from the static assets (${res.status})`);
      return res.text();
    },
    auth: {
      issueLoginKey: () => vault.issueLoginKey(),
      login: async (email, encryptedPassword) => {
        const password = await vault.decryptWithLoginKey(encryptedPassword);
        const result = await garminLogin(vault, email, password);
        if (result.status === "needs_mfa") {
          await vault.putAppMfa(result.mfaState);
          return { status: "needs_mfa" };
        }
        return { status: "success" };
      },
      submitMfa: async (code) => {
        const state = await vault.takeAppMfa();
        if (!state) throw new Error("The sign-in expired, please start again");
        await garminMfa(vault, code, state);
      },
      // A request can't wait for the user: hand the app's form and a link back instead
      waitForSignIn: async () => {
        throw new SignInRequiredError(await signInLink());
      },
      signInLink,
    },
    garminRequestBudget: GARMIN_REQUEST_BUDGET,
    timeZone,
    realMapUnavailable:
      "The real map isn't available on the self-hosted server yet: it needs more requests per call than the Workers free plan allows.",
  };
}
