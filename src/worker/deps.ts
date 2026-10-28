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
import { WrongAccountError, garminLogin, garminMfa } from "./signin.js";
import { createSignInLink } from "./signin-link.js";
import { LIMITS } from "./vault.js";

/** Garmin requests per tool call: the Workers free plan allows 50 subrequests. */
const GARMIN_REQUEST_BUDGET = 40;

/**
 * app.html (~6.5 MB) decoded once per isolate: it only changes with a deploy,
 * and decoding it on every `resources/read` costs CPU time the free plan
 * hardly has.
 */
let appHtml: Promise<string> | undefined;

function loadAppHtml(env: Env, origin: string): Promise<string> {
  appHtml ??= (async () => {
    const res = await env.ASSETS.fetch(new URL("/app.html", origin));
    if (!res.ok) throw new Error(`app.html is missing from the static assets (${res.status})`);
    return res.text();
  })().catch((err: unknown) => {
    appHtml = undefined;
    throw err;
  });
  return appHtml;
}

export async function remoteDeps(env: Env, origin: string): Promise<ServerDeps> {
  const vault = vaultOf(env);
  const timeZone = await vault.getTimeZone();
  let client: GarminClient | undefined;
  const signInRequired = async () =>
    new SignInRequiredError(
      await createSignInLink(vault, new Sealer(env.TOKEN_ENCRYPTION_KEY), origin),
      LIMITS.signInMs / 60_000,
    );

  return {
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
    loadAppHtml: () => loadAppHtml(env, origin),
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
        const state = await vault.getAppMfa();
        if (!state) throw new Error("The sign-in expired, please start again");
        try {
          await garminMfa(vault, code, state);
        } catch (err) {
          // A mistyped code can be entered again; another account can't
          if (err instanceof WrongAccountError) await vault.clearAppMfa();
          throw err;
        }
        await vault.clearAppMfa();
      },
      // A request can't wait for the user: hand the app's form and a link back instead
      waitForSignIn: async () => {
        throw await signInRequired();
      },
      signInRequired,
    },
    garminRequestBudget: GARMIN_REQUEST_BUDGET,
    timeZone,
    realMapUnavailable:
      "The real map isn't available on the self-hosted server yet: it needs more requests per call than the Workers free plan allows.",
  };
}
