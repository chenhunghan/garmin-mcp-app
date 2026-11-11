import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { GarminVault } from "./vault-do.js";

export interface Env {
  /** Asked once when connecting a client (Worker secret) */
  OWNER_PASSPHRASE?: string;
  /** Seals tokens at rest: `openssl rand -hex 32` (Worker secret) */
  TOKEN_ENCRYPTION_KEY?: string;
  VAULT: DurableObjectNamespace<GarminVault>;
  /** The OAuth provider's clients and grants */
  OAUTH_KV: KVNamespace;
  /** build/worker-assets: app.html */
  ASSETS: Fetcher;
  /** Set by OAuthProvider for the default handler */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** The one vault: this Worker serves one owner. */
export function vaultOf(env: Env) {
  return env.VAULT.get(env.VAULT.idFromName("owner"));
}

export type VaultStub = ReturnType<typeof vaultOf>;
