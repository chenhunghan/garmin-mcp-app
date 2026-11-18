/**
 * The self-hosted server's vault and crypto, in Node with a Map standing in
 * for Durable Object storage.
 */
import { constants, publicEncrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Sealer,
  UnsealError,
  constantTimeEqual,
  ipNetwork,
  keyBytes,
} from "../src/worker/crypto.ts";
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

function setup(
  opts: {
    refresh?: (t: Tokens) => Promise<Tokens>;
    key?: string;
    storage?: ReturnType<typeof mapStorage>;
  } = {},
) {
  let now = 1_700_000_000_000;
  const storage = opts.storage ?? mapStorage();
  const vault = new Vault(
    storage,
    { passphrase: "correct horse battery staple", encryptionKey: opts.key ?? KEY },
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

  it("rejects a short encryption key when it's first used", async () => {
    await expect(keyBytes("too short")).rejects.toThrow(/openssl rand -hex 32/);
    // Nothing is derived (or rejected unhandled) until a call needs the key
    const s = new Sealer("too short");
    await expect(s.seal("x", 1)).rejects.toThrow(/at least 32 characters/);
    await expect(s.open("x", "a.b")).rejects.not.toBeInstanceOf(UnsealError);
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

  it("counts wrong passphrases sent at the same time", async () => {
    const { vault } = setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => vault.checkPassphrase("wrong", "attacker")),
    );
    // 4 plain refusals, then the lockout and refusals while locked
    expect(results.filter((r) => !r.ok && r.retryAfterMs === undefined)).toHaveLength(
      LIMITS.maxFailures - 1,
    );
    expect((await vault.checkPassphrase("correct horse battery staple", "attacker")).ok).toBe(
      false,
    );
  });

  it("forgets wrong passphrases older than the lockout window", async () => {
    const { vault, advance } = setup();
    for (let i = 1; i < LIMITS.maxFailures; i++) await vault.checkPassphrase("wrong");
    advance(LIMITS.lockoutMs + 1);
    expect(await vault.checkPassphrase("wrong")).toEqual({ ok: false });
  });

  it("counts an IPv6 connection's /64 as one client", () => {
    expect(ipNetwork("203.0.113.7")).toBe("203.0.113.7");
    expect(ipNetwork("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipNetwork("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2");
    expect(ipNetwork("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2");
    expect(ipNetwork("2001:db8::1")).toBe("2001:db8:0:0");
    expect(ipNetwork("::1")).toBe("0:0:0:0");
  });

  it("locks out only the client that failed", async () => {
    const { vault } = setup();
    for (let i = 0; i < LIMITS.maxFailures; i++) await vault.checkPassphrase("wrong", "attacker");
    expect((await vault.checkPassphrase("correct horse battery staple", "attacker")).ok).toBe(
      false,
    );
    expect(await vault.checkPassphrase("correct horse battery staple", "owner")).toEqual({
      ok: true,
    });
  });

  it("rate-limits per bucket within a window", async () => {
    const { vault, advance } = setup();
    expect(await vault.rateLimit("a", 2, 60_000)).toEqual({ ok: true });
    expect(await vault.rateLimit("a", 2, 60_000)).toEqual({ ok: true });
    advance(10_000);
    expect(await vault.rateLimit("a", 2, 60_000)).toEqual({ ok: false, retryAfterMs: 50_000 });
    expect(await vault.rateLimit("b", 2, 60_000)).toEqual({ ok: true });
    advance(50_000);
    expect(await vault.rateLimit("a", 2, 60_000)).toEqual({ ok: true });
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

  it("drops tokens sealed under a previous key instead of failing", async () => {
    const { vault, storage } = setup();
    await vault.saveTokens(tokens(2e9));
    const rotated = setup({ storage, key: "b".repeat(64) }).vault;
    expect(await rotated.loadTokens()).toBeNull();
    expect(storage.map.has("tokens")).toBe(false);
  });

  it("keeps tokens when the key is missing (a configuration error, not a rotation)", async () => {
    const { vault, storage } = setup();
    await vault.saveTokens(tokens(2e9));
    const unset = new Vault(storage, { passphrase: "p" });
    await expect(unset.loadTokens()).rejects.toThrow(/TOKEN_ENCRYPTION_KEY/);
    expect(storage.map.has("tokens")).toBe(true);
  });

  it("binds the first Garmin account and rejects others until the owner switches", async () => {
    const { vault } = setup();
    expect(await vault.bindOwner("123")).toBe(true);
    expect(await vault.bindOwner("123")).toBe(true);
    expect(await vault.bindOwner("456")).toBe(false);
    await vault.setOwner("456");
    expect(await vault.bindOwner("456")).toBe(true);
    expect(await vault.bindOwner("123")).toBe(false);
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

  it("a refresh finishing after a logout doesn't sign back in", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((r) => (markStarted = r));
    const { vault, now } = setup({
      refresh: async (t) => {
        await new Promise<void>((r) => {
          release = r;
          markStarted();
        });
        return { ...t, oauth2: { ...t.oauth2, access_token: "new", expires_at: 2e9 } };
      },
    });
    await vault.saveTokens(tokens(now() / 1000 + 30));
    const refreshing = vault.freshTokens();
    // Unsealing the tokens takes WebCrypto a while: wait until the refresh is running
    await started;
    await vault.clearTokens();
    release();
    expect(await refreshing).toBeNull();
    expect(await vault.loadTokens()).toBeNull();
  });

  it("keeps sign-ins for 10 minutes, sealed", async () => {
    const { vault, storage, advance } = setup();
    const mfaState = { signinParams: {}, cookies: "SESSION=secret-cookie", csrfToken: "c" };
    await vault.putSignIn("t1", {
      kind: "signin",
      browser: "h",
      stage: "mfa",
      mfaState,
      attempts: 0,
    });
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

  it("keeps the in-app MFA state until it's cleared or expires", async () => {
    const { vault, advance } = setup();
    const state = { signinParams: {}, cookies: "{}", csrfToken: "c" };
    await vault.putAppMfa(state);
    expect(await vault.getAppMfa()).toEqual(state);
    expect(await vault.getAppMfa()).toEqual(state);
    await vault.clearAppMfa();
    expect(await vault.getAppMfa()).toBeNull();
    await vault.putAppMfa(state);
    advance(LIMITS.signInMs);
    expect(await vault.getAppMfa()).toBeNull();
  });

  it("link nonces work once and expire after 10 minutes; looking doesn't use them", async () => {
    const { vault, advance } = setup();
    const a = await vault.issueLinkNonce();
    expect(await vault.peekLinkNonce(a.nonce)).toBe(true);
    expect(await vault.peekLinkNonce(a.nonce)).toBe(true);
    expect(await vault.consumeLinkNonce(a.nonce)).toBe(true);
    expect(await vault.peekLinkNonce(a.nonce)).toBe(false);
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

describe("household", () => {
  it("invite codes are readable, work once and expire after a week", async () => {
    const { vault, advance } = setup();
    const invite = (await vault.createInvite())!;
    expect(invite.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(await vault.listInvites()).toEqual([invite]);
    // Typed in lower case, with or without the dash
    const typed = `${invite.code.slice(0, 4).toLowerCase()}-${invite.code.slice(4)}`;
    expect((await vault.findInvite(typed))?.id).toBe(invite.id);
    expect(await vault.consumeInvite(typed)).toBe(true);
    expect(await vault.consumeInvite(typed)).toBe(false);

    const later = (await vault.createInvite())!;
    advance(LIMITS.inviteMs + 1);
    expect(await vault.findInvite(later.code)).toBeNull();
    expect(await vault.listInvites()).toEqual([]);
  });

  it("caps open invites, and the owner can cancel one", async () => {
    const { vault } = setup();
    const invites = [];
    for (let i = 0; i < LIMITS.maxInvites; i++) invites.push(await vault.createInvite());
    expect(await vault.createInvite()).toBeNull();
    await vault.cancelInvite(invites[0]!.id);
    expect(await vault.findInvite(invites[0]!.code)).toBeNull();
    expect(await vault.createInvite()).not.toBeNull();
  });

  it("keeps invite codes sealed at rest", async () => {
    const { vault, storage } = setup();
    const invite = (await vault.createInvite())!;
    expect(JSON.stringify([...storage.map])).not.toContain(invite.code);
  });

  it("wrong invite codes count toward the passphrase lockout", async () => {
    const { vault } = setup();
    const invite = (await vault.createInvite())!;
    for (let i = 0; i < LIMITS.maxFailures - 1; i++) {
      expect((await vault.checkInvite("AAAA-AAAA", "ip")).ok).toBe(false);
    }
    expect((await vault.checkPassphrase("wrong", "ip")).ok).toBe(false);
    // Locked out now, even with the right code
    const locked = await vault.checkInvite(invite.code, "ip");
    expect(locked.ok).toBe(false);
    expect(locked.ok === false && locked.retryAfterMs).toBeGreaterThan(0);
    expect((await vault.checkInvite(invite.code, "other-ip")).ok).toBe(true);
  });

  it("adds members once per Garmin account, up to the limit", async () => {
    const { vault } = setup();
    const a = (await vault.addMember("g1", "Alex"))!;
    expect(await vault.addMember("g1")).toEqual(a);
    expect(await vault.findMemberByGarmin("g1")).toEqual(a);
    for (let i = 2; i <= LIMITS.maxMembers; i++) await vault.addMember(`g${i}`);
    expect(await vault.addMember("one-too-many")).toBeNull();
    await vault.removeMember(a.id);
    expect(await vault.getMember(a.id)).toBeNull();
    expect(await vault.addMember("one-too-many")).not.toBeNull();
  });

  it("owner-page sessions last 30 minutes and can end early", async () => {
    const { vault, advance } = setup();
    const s = await vault.createSession();
    expect(await vault.checkSession(s)).toBe(true);
    expect(await vault.checkSession("guess")).toBe(false);
    expect(await vault.checkSession("")).toBe(false);
    await vault.endSession(s);
    expect(await vault.checkSession(s)).toBe(false);
    const t = await vault.createSession();
    advance(LIMITS.sessionMs + 1);
    expect(await vault.checkSession(t)).toBe(false);
  });

  it("wipe deletes everything in a member's vault", async () => {
    const { vault, storage } = setup();
    await vault.saveTokens(tokens(2_000_000_000));
    await vault.bindOwner("g1");
    await vault.setName("Alex");
    await vault.wipe();
    expect(storage.map.size).toBe(0);
    expect(await vault.loadTokens()).toBeNull();
  });

  it("seals with a key loaded on first use (the generated key)", async () => {
    let loads = 0;
    const loader = async () => {
      loads++;
      return KEY;
    };
    const storage = mapStorage();
    const lazy = new Vault(storage, { encryptionKey: loader });
    await lazy.saveTokens(tokens(2_000_000_000));
    // Same key as a string: the records open
    const { vault } = setup({ storage });
    expect(await vault.loadTokens()).not.toBeNull();
    expect(loads).toBe(1);
    expect(await new Sealer(loader).open("x", await new Sealer(KEY).seal("x", 1))).toBe(1);
  });
});
