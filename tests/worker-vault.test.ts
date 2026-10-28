/**
 * The self-hosted server's vault and crypto, in Node with a Map standing in
 * for Durable Object storage.
 */
import { constants, publicEncrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Sealer, constantTimeEqual, keyBytes } from "../src/worker/crypto.ts";
import { LIMITS, Vault, type Tokens, type VaultStorage } from "../src/worker/vault.ts";

const KEY = "a".repeat(64);

function mapStorage(): VaultStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(k: string) => map.get(k) as T | undefined,
    put: async (k, v) => {
      map.set(k, structuredClone(v));
    },
    delete: async (k) => map.delete(k),
    list: async <T>({ prefix }: { prefix: string }) =>
      new Map([...map].filter(([k]) => k.startsWith(prefix))) as Map<string, T>,
  };
}

function setup(opts: { refresh?: (t: Tokens) => Promise<Tokens> } = {}) {
  let now = 1_700_000_000_000;
  const storage = mapStorage();
  const vault = new Vault(
    storage,
    { passphrase: "correct horse battery staple", encryptionKey: KEY },
    () => now,
    opts.refresh,
  );
  return { vault, storage, advance: (ms: number) => (now += ms), now: () => now };
}

const tokens = (expiresAt: number): Tokens => ({
  oauth1: { oauth_token: "t1", oauth_token_secret: "s1", domain: "garmin.com" },
  oauth2: {
    access_token: "access",
    token_type: "Bearer",
    refresh_token: "refresh",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token_expires_in: 7200,
    refresh_token_expires_at: expiresAt + 3600,
  },
});

describe("crypto", () => {
  it("seals and opens a value; tampering or another name fails", async () => {
    const s = new Sealer(KEY);
    const sealed = await s.seal("tokens", { a: 1 });
    expect(await s.open("tokens", sealed)).toEqual({ a: 1 });
    await expect(s.open("other", sealed)).rejects.toThrow();
    const [iv, ct] = sealed.split(".");
    const flipped = `${iv}.${ct!.slice(0, -2)}${ct!.endsWith("A") ? "B" : "A"}${ct!.slice(-1)}`;
    await expect(s.open("tokens", flipped)).rejects.toThrow();
    // A fresh IV each time
    expect(await s.seal("tokens", { a: 1 })).not.toBe(sealed);
  });

  it("can't open values sealed under another key", async () => {
    const sealed = await new Sealer(KEY).seal("tokens", 1);
    await expect(new Sealer("b".repeat(64)).open("tokens", sealed)).rejects.toThrow();
  });

  it("signs and verifies; a changed payload or signature fails", async () => {
    const s = new Sealer(KEY);
    const signed = await s.sign("hello");
    expect(await s.verify(signed)).toBe("hello");
    const [, sig] = signed.split(".");
    expect(await s.verify(`${Buffer.from("hellp").toString("base64url")}.${sig}`)).toBeNull();
    expect(await new Sealer("b".repeat(64)).verify(signed)).toBeNull();
    expect(await s.verify("garbage")).toBeNull();
  });

  it("rejects a short encryption key", async () => {
    await expect(keyBytes("too short")).rejects.toThrow(/openssl rand -hex 32/);
    expect(await keyBytes("f".repeat(64))).toHaveLength(32);
    expect(await keyBytes("x".repeat(40))).toHaveLength(32);
  });

  it("compares strings", async () => {
    expect(await constantTimeEqual("abc", "abc")).toBe(true);
    expect(await constantTimeEqual("abc", "abd")).toBe(false);
    expect(await constantTimeEqual("abc", "abcd")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
  });
});

describe("Vault", () => {
  it("accepts the passphrase and locks out after 5 failures for 15 minutes", async () => {
    const { vault, advance } = setup();
    expect(await vault.checkPassphrase("correct horse battery staple")).toEqual({ ok: true });
    for (let i = 1; i < LIMITS.maxFailures; i++) {
      expect(await vault.checkPassphrase("wrong")).toEqual({ ok: false });
    }
    expect(await vault.checkPassphrase("wrong")).toEqual({
      ok: false,
      retryAfterMs: LIMITS.lockoutMs,
    });
    // Even the right passphrase is refused while locked
    advance(60_000);
    expect(await vault.checkPassphrase("correct horse battery staple")).toEqual({
      ok: false,
      retryAfterMs: LIMITS.lockoutMs - 60_000,
    });
    advance(LIMITS.lockoutMs);
    expect(await vault.checkPassphrase("correct horse battery staple")).toEqual({ ok: true });
  });

  it("a success resets the failure count", async () => {
    const { vault } = setup();
    for (let i = 1; i < LIMITS.maxFailures; i++) await vault.checkPassphrase("wrong");
    await vault.checkPassphrase("correct horse battery staple");
    expect(await vault.checkPassphrase("wrong")).toEqual({ ok: false });
  });

  it("refuses every passphrase when none is configured", async () => {
    const vault = new Vault(mapStorage(), { encryptionKey: KEY });
    expect(await vault.checkPassphrase("")).toEqual({ ok: false });
  });

  it("stores tokens sealed, never in plain text", async () => {
    const { vault, storage } = setup();
    await vault.saveTokens(tokens(2e9));
    expect(JSON.stringify([...storage.map])).not.toContain("access");
    expect(await vault.loadTokens()).toEqual(tokens(2e9));
    await vault.clearTokens();
    expect(await vault.loadTokens()).toBeNull();
  });

  it("binds the first Garmin account and rejects others", async () => {
    const { vault } = setup();
    expect(await vault.bindOwner("123")).toBe(true);
    expect(await vault.bindOwner("123")).toBe(true);
    expect(await vault.bindOwner("456")).toBe(false);
  });

  it("refreshes expiring tokens once for concurrent requests", async () => {
    let calls = 0;
    const { vault, now } = setup({
      refresh: async (t) => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { ...t, oauth2: { ...t.oauth2, access_token: "new", expires_at: 2e9 } };
      },
    });
    await vault.saveTokens(tokens(now() / 1000 + 30));
    const [a, b] = await Promise.all([vault.freshTokens(), vault.freshTokens()]);
    expect(calls).toBe(1);
    expect(a?.oauth2.access_token).toBe("new");
    expect(b?.oauth2.access_token).toBe("new");
    expect((await vault.loadTokens())?.oauth2.access_token).toBe("new");
    // Fresh tokens aren't refreshed again
    await vault.freshTokens();
    expect(calls).toBe(1);
  });

  it("keeps sign-ins for 10 minutes, sealed", async () => {
    const { vault, storage, advance } = setup();
    const mfaState = { signinParams: {}, cookies: "SESSION=secret-cookie", csrfToken: "c" };
    await vault.putSignIn("t1", { kind: "signin", browser: "h", stage: "mfa", mfaState, attempts: 0 });
    expect(JSON.stringify([...storage.map])).not.toContain("secret-cookie");
    expect((await vault.getSignIn("t1"))?.mfaState).toEqual(mfaState);
    advance(LIMITS.signInMs);
    expect(await vault.getSignIn("t1")).toBeNull();
  });

  it("sweeps expired sign-ins", async () => {
    const { vault, storage, advance } = setup();
    await vault.putSignIn("old", { kind: "signin", browser: "h", stage: "garmin", attempts: 0 });
    advance(LIMITS.signInMs + 1);
    await vault.putSignIn("new", { kind: "signin", browser: "h", stage: "garmin", attempts: 0 });
    expect([...storage.map.keys()].filter((k) => k.startsWith("tx:"))).toEqual(["tx:new"]);
  });

  it("uses the in-app MFA state once", async () => {
    const { vault } = setup();
    const state = { signinParams: {}, cookies: "{}", csrfToken: "c" };
    await vault.putAppMfa(state);
    expect(await vault.takeAppMfa()).toEqual(state);
    expect(await vault.takeAppMfa()).toBeNull();
  });

  it("link nonces work once and expire after 10 minutes", async () => {
    const { vault, advance } = setup();
    const a = await vault.issueLinkNonce();
    expect(await vault.consumeLinkNonce(a.nonce)).toBe(true);
    expect(await vault.consumeLinkNonce(a.nonce)).toBe(false);
    const b = await vault.issueLinkNonce();
    advance(LIMITS.signInMs);
    expect(await vault.consumeLinkNonce(b.nonce)).toBe(false);
    expect(await vault.consumeLinkNonce("made-up")).toBe(false);
  });

  it("decrypts the app's RSA-OAEP ciphertext once, within 5 minutes", async () => {
    const { vault, advance } = setup();
    const encrypt = (pub: string, text: string) =>
      publicEncrypt(
        {
          key: Buffer.from(pub, "base64"),
          format: "der",
          type: "spki",
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        Buffer.from(text),
      ).toString("base64");
    const ct = encrypt(await vault.issueLoginKey(), "hunter2");
    expect(await vault.decryptWithLoginKey(ct)).toBe("hunter2");
    await expect(vault.decryptWithLoginKey(ct)).rejects.toThrow(/expired/);

    const late = encrypt(await vault.issueLoginKey(), "hunter2");
    advance(LIMITS.loginKeyMs);
    await expect(vault.decryptWithLoginKey(late)).rejects.toThrow(/expired/);
  });
});

describe("today", () => {
  it("is the calendar day in the given time zone", async () => {
    const { today } = await import("../src/today.ts");
    const now = new Date("2026-10-27T23:30:00Z");
    expect(today("Asia/Taipei", now)).toBe("2026-10-28");
    expect(today("America/Los_Angeles", now)).toBe("2026-10-27");
    // Unknown zones fall back to the server's own
    expect(today("Not/AZone", now)).toBe(today(undefined, now));
  });
});
