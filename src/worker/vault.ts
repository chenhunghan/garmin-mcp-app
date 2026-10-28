/**
 * The self-hosted server's state, kept in one Durable Object (vault-do.ts):
 * Garmin tokens, the owner's Garmin account, settings, sign-ins in progress,
 * one-time sign-in links, the in-app login key, passphrase lockout and rate
 * limits.
 * Everything secret is sealed with AES-GCM (TOKEN_ENCRYPTION_KEY) before it
 * is stored. A plain class over a storage interface, so it's testable in Node.
 */
import {
  GarminClient,
  type MfaState,
  type OAuth1Token,
  type OAuth2Token,
  type TokenStorage,
} from "garmin-connect";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Settings } from "../deps.js";
import { Sealer, UnsealError, constantTimeEqual, randomId } from "./crypto.js";

/** The subset of DurableObjectStorage the vault uses. */
export interface VaultStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}

export interface Tokens {
  oauth1: OAuth1Token;
  oauth2: OAuth2Token;
}

/** A sign-in in progress on the authorize page or a one-time sign-in page. */
export interface SignInTransaction {
  kind: "authorize" | "signin";
  /** authorize: the parsed OAuth request to complete */
  authRequest?: AuthRequest;
  /**
   * authorize: who's asking, shown on every step. `verified`: the name is a
   * CIMD domain; `known`: the redirect goes to Claude or ChatGPT.
   */
  client?: { name: string; verified: boolean; host: string; known: boolean };
  /** SHA-256 of the cookie that binds the sign-in to one browser */
  browser: string;
  stage: "passphrase" | "garmin" | "mfa" | "switch";
  mfaState?: MfaState;
  /** signin: the one-time link's nonce, used up when the sign-in succeeds */
  linkNonce?: string;
  /** authorize: the time zone of the browser, kept once the passphrase is right */
  timeZone?: string;
  /** authorize, stage "switch": another Garmin account signed in, waiting for confirmation */
  switchTo?: { garminId: string; tokens: Tokens };
  /** Garmin password attempts so far */
  attempts: number;
}

export const LIMITS = {
  /** Wrong passphrases from one client (IP) before it's locked out */
  maxFailures: 5,
  lockoutMs: 15 * 60_000,
  /** Sign-ins in progress, MFA states and one-time links */
  signInMs: 10 * 60_000,
  loginKeyMs: 5 * 60_000,
  /** Garmin password attempts per sign-in */
  maxAttempts: 5,
} as const;

const DEFAULT_SETTINGS: Settings = { realMap: false };

type Expiring = { exp: number; sealed: string };

export type PassphraseResult = { ok: true } | { ok: false; retryAfterMs?: number };

export type RateResult = { ok: true } | { ok: false; retryAfterMs: number };

export class Vault {
  private sealer: Sealer;
  private refreshing: Promise<Tokens | null> | undefined;
  /** Bumped when tokens are saved or cleared, so a slow refresh can't overwrite that */
  private tokenGeneration = 0;

  constructor(
    private storage: VaultStorage,
    private secrets: { passphrase?: string; encryptionKey?: string },
    private now: () => number = Date.now,
    /** Refreshes the OAuth2 token when it's about to expire (GarminClient.resume) */
    private refresh: (tokens: Tokens) => Promise<Tokens> = refreshWithClient,
  ) {
    this.sealer = new Sealer(secrets.encryptionKey);
  }

  // ── Owner passphrase ──────────────────────────────

  /**
   * Constant-time check; 5 failures lock that client out for 15 minutes.
   * Per client (a hash of the IP), so nobody can lock the owner out.
   */
  async checkPassphrase(input: string, client = ""): Promise<PassphraseResult> {
    const passphrase = this.secrets.passphrase;
    if (!passphrase) return { ok: false };
    const key = `passphrase:${client}`;
    const state = (await this.storage.get<{ failures: number; lockedUntil?: number }>(key)) ?? {
      failures: 0,
    };
    const now = this.now();
    if (state.lockedUntil && state.lockedUntil > now) {
      return { ok: false, retryAfterMs: state.lockedUntil - now };
    }
    if (await constantTimeEqual(input, passphrase)) {
      await this.storage.delete(key);
      return { ok: true };
    }
    const failures = (state.lockedUntil ? 0 : state.failures) + 1;
    await this.sweep("passphrase:");
    if (failures >= LIMITS.maxFailures) {
      const lockedUntil = now + LIMITS.lockoutMs;
      await this.storage.put(key, { failures: 0, lockedUntil, exp: lockedUntil });
      return { ok: false, retryAfterMs: LIMITS.lockoutMs };
    }
    await this.storage.put(key, { failures, exp: now + LIMITS.lockoutMs });
    return { ok: false };
  }

  // ── Rate limits ───────────────────────────────────

  /** Counts one event in `bucket`; refused once `limit` is reached within the window. */
  async rateLimit(bucket: string, limit: number, windowMs: number): Promise<RateResult> {
    const key = `rate:${bucket}`;
    const now = this.now();
    const rec = await this.storage.get<{ count: number; exp: number }>(key);
    const current = rec && rec.exp > now ? rec : { count: 0, exp: now + windowMs };
    if (current.count >= limit) return { ok: false, retryAfterMs: current.exp - now };
    await this.sweep("rate:");
    await this.storage.put(key, { count: current.count + 1, exp: current.exp });
    return { ok: true };
  }

  // ── Garmin tokens and owner ───────────────────────

  /** The tokens; null when there are none or they can't be opened (the key changed). */
  async loadTokens(): Promise<Tokens | null> {
    const sealed = await this.storage.get<string>("tokens");
    if (!sealed) return null;
    try {
      return await this.sealer.open<Tokens>("tokens", sealed);
    } catch (err) {
      if (!(err instanceof UnsealError)) throw err;
      // Sealed under another TOKEN_ENCRYPTION_KEY: useless now, sign in again
      await this.storage.delete("tokens");
      return null;
    }
  }

  async saveTokens(tokens: Tokens): Promise<void> {
    this.tokenGeneration++;
    await this.storage.put("tokens", await this.sealer.seal("tokens", tokens));
  }

  async clearTokens(): Promise<void> {
    this.tokenGeneration++;
    await this.storage.delete("tokens");
  }

  /**
   * The tokens, refreshed first when the OAuth2 token is about to expire.
   * Requests running at the same time share one refresh.
   */
  freshTokens(): Promise<Tokens | null> {
    this.refreshing ??= (async () => {
      const tokens = await this.loadTokens();
      if (!tokens || tokens.oauth2.expires_at - 60 > this.now() / 1000) return tokens;
      const generation = this.tokenGeneration;
      try {
        const fresh = await this.refresh(tokens);
        // Signed out or in again meanwhile: that wins over this refresh
        if (generation !== this.tokenGeneration) return this.loadTokens();
        await this.saveTokens(fresh);
        return fresh;
      } catch {
        // The request's own client retries, and asks for a sign-in if that fails too
        return tokens;
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /**
   * Records the Garmin account on the first sign-in; afterwards only that
   * account may sign in. False when `garminId` is another account.
   */
  async bindOwner(garminId: string): Promise<boolean> {
    const owner = await this.storage.get<string>("owner");
    if (owner === undefined) {
      await this.storage.put("owner", garminId);
      return true;
    }
    return owner === garminId;
  }

  /** Links this server to another Garmin account (the owner confirmed it with the passphrase). */
  async setOwner(garminId: string): Promise<void> {
    await this.storage.put("owner", garminId);
  }

  // ── Settings ──────────────────────────────────────

  async getSettings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...(await this.storage.get<Partial<Settings>>("settings")) };
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.getSettings()), ...patch };
    await this.storage.put("settings", next);
    return next;
  }

  /** The owner's time zone, from where their browser last signed in. */
  async getTimeZone(): Promise<string | undefined> {
    return this.storage.get<string>("time-zone");
  }

  async setTimeZone(timeZone: string): Promise<void> {
    await this.storage.put("time-zone", timeZone);
  }

  // ── Sign-ins in progress ──────────────────────────

  async putSignIn(id: string, tx: SignInTransaction): Promise<void> {
    await this.putExpiring(`tx:${id}`, tx, LIMITS.signInMs);
  }

  getSignIn(id: string): Promise<SignInTransaction | null> {
    return this.getExpiring<SignInTransaction>(`tx:${id}`);
  }

  async deleteSignIn(id: string): Promise<void> {
    await this.storage.delete(`tx:${id}`);
  }

  /** The in-app sign-in's MFA state (one at a time), until a code is accepted. */
  async putAppMfa(state: MfaState): Promise<void> {
    await this.putExpiring("app-mfa", state, LIMITS.signInMs);
  }

  getAppMfa(): Promise<MfaState | null> {
    return this.getExpiring<MfaState>("app-mfa");
  }

  async clearAppMfa(): Promise<void> {
    await this.storage.delete("app-mfa");
  }

  // ── One-time sign-in links ────────────────────────

  /** A single-use nonce for a sign-in link, valid for 10 minutes. */
  async issueLinkNonce(): Promise<{ nonce: string; exp: number }> {
    const nonce = randomId();
    const exp = this.now() + LIMITS.signInMs;
    await this.sweep("link:");
    await this.storage.put(`link:${nonce}`, { exp });
    return { nonce, exp };
  }

  /** True while the nonce is unexpired and unused. */
  async peekLinkNonce(nonce: string): Promise<boolean> {
    const rec = await this.storage.get<{ exp: number }>(`link:${nonce}`);
    return !!rec && rec.exp > this.now();
  }

  /** True once per unexpired nonce. */
  async consumeLinkNonce(nonce: string): Promise<boolean> {
    const rec = await this.storage.get<{ exp: number }>(`link:${nonce}`);
    if (!rec) return false;
    await this.storage.delete(`link:${nonce}`);
    return rec.exp > this.now();
  }

  // ── In-app login key ──────────────────────────────

  /**
   * A fresh RSA-OAEP (SHA-256) key pair; returns the public key as base64
   * SPKI DER. The private key is kept sealed for 5 minutes and used once.
   */
  async issueLoginKey(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    )) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    );
    await this.putExpiring("login-key", toBase64(pkcs8), LIMITS.loginKeyMs);
    const spki = (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer;
    return toBase64(new Uint8Array(spki));
  }

  /** Decrypt a base64 RSA-OAEP ciphertext with the login key, which is then gone. */
  async decryptWithLoginKey(ciphertext: string): Promise<string> {
    const pkcs8 = await this.getExpiring<string>("login-key");
    await this.storage.delete("login-key");
    if (!pkcs8) throw new Error("Login key expired, please try again");
    const key = await crypto.subtle.importKey(
      "pkcs8",
      fromBase64(pkcs8),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    const pt = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, fromBase64(ciphertext));
    return new TextDecoder().decode(pt);
  }

  // ── Expiring sealed records ───────────────────────

  private async putExpiring(key: string, value: unknown, ttlMs: number): Promise<void> {
    await this.sweep(key.startsWith("tx:") ? "tx:" : key);
    const rec: Expiring = { exp: this.now() + ttlMs, sealed: await this.sealer.seal(key, value) };
    await this.storage.put(key, rec);
  }

  private async getExpiring<T>(key: string): Promise<T | null> {
    const rec = await this.storage.get<Expiring>(key);
    if (!rec) return null;
    if (rec.exp <= this.now()) {
      await this.storage.delete(key);
      return null;
    }
    try {
      return await this.sealer.open<T>(key, rec.sealed);
    } catch (err) {
      if (!(err instanceof UnsealError)) throw err;
      await this.storage.delete(key);
      return null;
    }
  }

  /** Deletes expired records under a prefix, so abandoned sign-ins don't pile up. */
  private async sweep(prefix: string): Promise<void> {
    const now = this.now();
    for (const [key, rec] of await this.storage.list<{ exp?: number }>({ prefix })) {
      if (typeof rec?.exp === "number" && rec.exp <= now) await this.storage.delete(key);
    }
  }
}

/** Token storage held in memory: sign-ins happen here before the vault keeps them. */
export function memoryTokenStorage(initial?: Tokens): TokenStorage & { current(): Tokens | null } {
  let tokens: Tokens | null = initial ?? null;
  return {
    save: async (oauth1, oauth2) => {
      tokens = { oauth1, oauth2 };
    },
    load: async () => tokens,
    clear: async () => {
      tokens = null;
    },
    current: () => tokens,
  };
}

async function refreshWithClient(tokens: Tokens): Promise<Tokens> {
  const storage = memoryTokenStorage(tokens);
  await new GarminClient({ storage }).resume();
  return storage.current() ?? tokens;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
