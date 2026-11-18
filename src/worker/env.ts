import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { GarminVault } from "./vault-do.js";

export interface Env {
  /** Asked when the owner connects a client or opens the owner page (Worker secret) */
  OWNER_PASSPHRASE?: string;
  /**
   * Optional: seals tokens at rest (`openssl rand -hex 32`, Worker secret).
   * Without it the Worker generates a key once and keeps it (keyring).
   */
  TOKEN_ENCRYPTION_KEY?: string;
  VAULT: DurableObjectNamespace<GarminVault>;
  /** The OAuth provider's clients and grants */
  OAUTH_KV: KVNamespace;
  /** build/worker-assets: app.html */
  ASSETS: Fetcher;
  /** Set by OAuthProvider for the default handler */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Whose data: the owner, or a household member's id. */
export type Person = "owner" | (string & {});

/**
 * The owner's vault, which also keeps what the whole server shares (sign-ins,
 * links, invites, members, rate limits).
 */
export function vaultOf(env: Env) {
  return env.VAULT.get(env.VAULT.idFromName("owner"));
}

/** One person's vault: their Garmin tokens, settings and time zone. */
export function personVault(env: Env, person: Person) {
  return person === "owner"
    ? vaultOf(env)
    : env.VAULT.get(env.VAULT.idFromName(`member:${person}`));
}

export type VaultStub = ReturnType<typeof vaultOf>;

let generatedKey: Promise<string> | undefined;

/**
 * The key that seals the vaults: TOKEN_ENCRYPTION_KEY when it's set, else one
 * generated on first use and kept in its own Durable Object ("keyring"), so
 * deploying asks for nothing but the passphrase.
 */
export function encryptionKey(env: Env): Promise<string> {
  const secret = env.TOKEN_ENCRYPTION_KEY?.trim();
  if (secret) return Promise.resolve(secret);
  generatedKey ??= env.VAULT.get(env.VAULT.idFromName("keyring"))
    .generatedKey()
    .catch((err: unknown) => {
      generatedKey = undefined;
      throw err;
    });
  return generatedKey;
}
