/**
 * The self-hosted server's state, in Durable Objects (vault-do.ts). Each person
 * has their own vault: the owner's is named "owner", a household member's
 * "member:<id>". A person's vault holds their Garmin tokens and account,
 * name, settings, time zone, the in-app login key and MFA state.
 * The owner's vault also keeps what the whole server shares: sign-ins in
 * progress, one-time sign-in links, invites, the member list, owner-page
 * sessions, passphrase lockout and rate limits.
 * Everything secret is sealed with AES-GCM (TOKEN_ENCRYPTION_KEY, else the
 * generated key) before it is stored. A plain class over a storage interface,
 * so it's testable in Node.
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
  /**
   * authorize: who is connecting. "owner" asks for the passphrase; "member"
   * signs in to Garmin (with an invite code the first time).
   */
  role?: "owner" | "member";
  /** member: a checked invite code, used up when the Garmin sign-in succeeds */
  invite?: string;
  /** signin: whose sign-in the one-time link renews ("owner" or a member id) */
  person?: string;
  /** authorize: the parsed OAuth request to complete */
  authRequest?: AuthRequest;
  /**
   * authorize: who's asking, shown on every step. `verified`: the name is a
   * CIMD domain; `known`: the redirect goes to Claude or ChatGPT.
   */
  client?: { name: string; verified: boolean; host: string; known: boolean };
  /** SHA-256 of the cookie that binds the sign-in to one browser */
  browser: string;
  stage: "passphrase" | "invite" | "garmin" | "mfa" | "switch";
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
  /** Invites are good for a week, and used once */
  inviteMs: 7 * 86_400_000,
  /** Household members besides the owner (each a Durable Object and Garmin's requests) */
  maxMembers: 8,
  /** Open invites at a time */
  maxInvites: 5,
  /** Owner page: signed in for 30 minutes */
  sessionMs: 30 * 60_000,
} as const;

/** A household member: one Garmin account with its own vault. */
export interface Member {
  id: string;
  garminId: string;
  /** From the Garmin profile, shown on the owner page */
  name?: string;
  joinedAt: number;
}

export interface Invite {
  /** Short id for the owner page's buttons (not the code) */
  id: string;
  code: string;
  exp: number;
  createdAt: number;
}

/** Invite codes: 8 letters/digits without look-alikes, shown as XXXX-XXXX (40 bits). */
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function newInviteCode(): string {
  // 256 % 31 isn't 0: rejection sampling keeps every letter equally likely
  let code = "";
  while (code.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && code.length < 8) code += INVITE_ALPHABET[b % 31];
    }
  }
  return code;
}

const DEFAULT_SETTINGS: Settings = { realMap: false };

type Expiring = { exp: number; sealed: string };

export type PassphraseResult = { ok: true } | { ok: false; retryAfterMs?: number };

export type RateResult = { ok: true } | { ok: false; retryAfterMs: number };

export class Vault {
  private sealer: Sealer;
  private refreshing: Promise<Tokens | null> | undefined;
  /** Bumped when tokens are saved or cleared, so a slow refresh can't overwrite that */
  private tokenGeneration = 0;
  /** Passphrase checks run one at a time: parallel wrong guesses must each count */
  private passphraseQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private storage: VaultStorage,
    private secrets: {
      passphrase?: string;
      /** The key, or a loader for the generated one */
      encryptionKey?: string | (() => Promise<string | undefined>);
    },
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
  checkPassphrase(input: string, client = ""): Promise<PassphraseResult> {
    return this.guarded(client, async () => {
      const passphrase = this.secrets.passphrase;
      return !!passphrase && (await constantTimeEqual(input, passphrase));
    });
  }

  /**
   * Whether `code` is an open invite. Wrong codes count toward the same
   * lockout as wrong passphrases, so guesses can't alternate between them.
   */
  checkInvite(code: string, client = ""): Promise<PassphraseResult> {
    return this.guarded(client, async () => (await this.findInvite(code)) !== null);
  }

  /** Runs `test` under the per-client failure count and lockout. */
  private guarded(client: string, test: () => Promise<boolean>): Promise<PassphraseResult> {
    // The comparison awaits WebCrypto, which lets other requests in between
    // reading the failure count and writing it back.
    const run = this.passphraseQueue.then(() => this.guardedNow(client, test));
    this.passphraseQueue = run.catch(() => undefined);
    return run;
  }

  private async guardedNow(
    client: string,
    test: () => Promise<boolean>,
  ): Promise<PassphraseResult> {
    const key = `passphrase:${client}`;
    const now = this.now();
    const saved = await this.storage.get<{ failures: number; lockedUntil?: number; exp: number }>(
      key,
    );
    // Failures older than the lockout window don't count any more
    const state = saved && saved.exp > now ? saved : { failures: 0, lockedUntil: undefined };
    if (state.lockedUntil && state.lockedUntil > now) {
      return { ok: false, retryAfterMs: state.lockedUntil - now };
    }
    if (await test()) {
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
      // Sealed under another key: useless now, sign in again
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

  /** The Garmin account this vault belongs to, once someone signed in. */
  async getOwner(): Promise<string | undefined> {
    return this.storage.get<string>("owner");
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

  /** The account's name from its Garmin profile, for the owner page. */
  async getName(): Promise<string | undefined> {
    return this.storage.get<string>("name");
  }

  async setName(name: string): Promise<void> {
    await this.storage.put("name", name);
  }

  /** Deletes everything in this vault (a member who was removed). */
  async wipe(): Promise<void> {
    this.tokenGeneration++;
    for (const key of (await this.storage.list({ prefix: "" })).keys()) {
      await this.storage.delete(key);
    }
  }

  // ── Household (owner's vault) ─────────────────────

  /** A new invite code, good for a week and used once. Null when too many are open. */
  async createInvite(): Promise<Invite | null> {
    const open = await this.listInvites();
    if (open.length >= LIMITS.maxInvites) return null;
    const code = newInviteCode();
    const id = (await sha256Hex(code)).slice(0, 16);
    const createdAt = this.now();
    const exp = createdAt + LIMITS.inviteMs;
    await this.storage.put(`invite:${id}`, {
      exp,
      createdAt,
      sealed: await this.sealer.seal(`invite:${id}`, code),
    });
    return { id, code, exp, createdAt };
  }

  /** Open invites, newest first. */
  async listInvites(): Promise<Invite[]> {
    await this.sweep("invite:");
    const invites: Invite[] = [];
    const recs = await this.storage.list<{ exp: number; createdAt: number; sealed: string }>({
      prefix: "invite:",
    });
    for (const [key, rec] of recs) {
      const id = key.slice("invite:".length);
      try {
        const code = await this.sealer.open<string>(key, rec.sealed);
        invites.push({ id, code, exp: rec.exp, createdAt: rec.createdAt });
      } catch (err) {
        if (!(err instanceof UnsealError)) throw err;
        await this.storage.delete(key);
      }
    }
    return invites.sort((a, b) => b.createdAt - a.createdAt);
  }

  async cancelInvite(id: string): Promise<void> {
    await this.storage.delete(`invite:${id}`);
  }

  /** The open invite with this code, else null. */
  async findInvite(input: string): Promise<Invite | null> {
    const code = normalizeInviteCode(input);
    if (code.length !== 8) return null;
    const id = (await sha256Hex(code)).slice(0, 16);
    const rec = await this.storage.get<{ exp: number; createdAt: number }>(`invite:${id}`);
    if (!rec || rec.exp <= this.now()) return null;
    return { id, code, exp: rec.exp, createdAt: rec.createdAt };
  }

  /** True once per open invite. */
  async consumeInvite(input: string): Promise<boolean> {
    const invite = await this.findInvite(input);
    if (!invite) return false;
    await this.storage.delete(`invite:${invite.id}`);
    return true;
  }

  async listMembers(): Promise<Member[]> {
    const recs = await this.storage.list<Member>({ prefix: "member:" });
    return [...recs.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  async getMember(id: string): Promise<Member | null> {
    return (await this.storage.get<Member>(`member:${id}`)) ?? null;
  }

  async findMemberByGarmin(garminId: string): Promise<Member | null> {
    return (await this.listMembers()).find((m) => m.garminId === garminId) ?? null;
  }

  /** Adds a member for a Garmin account; null when the household is full. */
  async addMember(garminId: string, name?: string): Promise<Member | null> {
    const existing = await this.findMemberByGarmin(garminId);
    if (existing) return existing;
    if ((await this.listMembers()).length >= LIMITS.maxMembers) return null;
    const member: Member = {
      id: randomId(),
      garminId,
      joinedAt: this.now(),
      ...(name && { name }),
    };
    await this.storage.put(`member:${member.id}`, member);
    return member;
  }

  async renameMember(id: string, name: string): Promise<void> {
    const member = await this.getMember(id);
    if (member) await this.storage.put(`member:${id}`, { ...member, name });
  }

  async removeMember(id: string): Promise<void> {
    await this.storage.delete(`member:${id}`);
  }

  // ── Owner page sessions ───────────────────────────

  /** A new owner-page session; the browser keeps the returned secret in a cookie. */
  async createSession(): Promise<string> {
    const secret = randomId();
    await this.sweep("session:");
    await this.storage.put(`session:${await sha256Hex(secret)}`, {
      exp: this.now() + LIMITS.sessionMs,
    });
    return secret;
  }

  async checkSession(secret: string): Promise<boolean> {
    if (!secret) return false;
    const rec = await this.storage.get<{ exp: number }>(`session:${await sha256Hex(secret)}`);
    return !!rec && rec.exp > this.now();
  }

  async endSession(secret: string): Promise<void> {
    await this.storage.delete(`session:${await sha256Hex(secret)}`);
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

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
