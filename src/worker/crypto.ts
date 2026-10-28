/**
 * WebCrypto helpers for the Worker: AES-GCM records, HMAC-signed values,
 * constant-time comparison.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A random id with 128 bits of entropy, URL-safe. */
export function randomId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The 32-byte key from TOKEN_ENCRYPTION_KEY: 64 hex characters as generated
 * by `openssl rand -hex 32`, else the SHA-256 of a string of at least 32
 * characters.
 */
export async function keyBytes(secret: string | undefined): Promise<Uint8Array> {
  const s = (secret ?? "").trim();
  if (/^[0-9a-f]{64}$/i.test(s)) {
    return Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
  }
  if (s.length < 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32) or at least 32 characters",
    );
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** A sealed value that can't be opened: tampered with, or sealed under another key. */
export class UnsealError extends Error {
  constructor(name: string) {
    super(`Can't open the sealed "${name}" (was TOKEN_ENCRYPTION_KEY changed?)`);
    this.name = "UnsealError";
  }
}

/** Encrypts JSON values with AES-256-GCM; each record is bound to its name. */
export class Sealer {
  private keys: Promise<{ aes: CryptoKey; hmac: CryptoKey }> | undefined;

  constructor(private secret: string | undefined) {}

  /** Derived on first use, so a missing or short key fails the call that needs it. */
  private derive(): Promise<{ aes: CryptoKey; hmac: CryptoKey }> {
    this.keys ??= (async () => {
      const base = await crypto.subtle.importKey(
        "raw",
        await keyBytes(this.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      // Separate keys per purpose, derived from the one secret
      const sub = async (label: string) =>
        new Uint8Array(await crypto.subtle.sign("HMAC", base, enc.encode(label)));
      const [aes, hmac] = await Promise.all([
        sub("run-coach:aes-gcm").then((k) =>
          crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]),
        ),
        sub("run-coach:hmac").then((k) =>
          crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, [
            "sign",
            "verify",
          ]),
        ),
      ]);
      return { aes, hmac };
    })();
    return this.keys;
  }

  /** `iv.ciphertext`, base64url; a fresh random 96-bit IV per call. */
  async seal(name: string, value: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(name) },
      (await this.derive()).aes,
      enc.encode(JSON.stringify(value)),
    );
    return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
  }

  /**
   * The sealed value. Throws UnsealError if it was tampered with or sealed
   * under another name or key; a missing or short key throws as usual.
   */
  async open<T>(name: string, sealed: string): Promise<T> {
    const { aes } = await this.derive();
    const [iv, ct] = sealed.split(".");
    try {
      if (!iv || !ct) throw new Error("Malformed sealed value");
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: enc.encode(name) },
        aes,
        fromBase64Url(ct),
      );
      return JSON.parse(dec.decode(pt)) as T;
    } catch {
      throw new UnsealError(name);
    }
  }

  /** `payload.signature`, base64url. */
  async sign(payload: string): Promise<string> {
    const sig = await crypto.subtle.sign("HMAC", (await this.derive()).hmac, enc.encode(payload));
    return `${toBase64Url(enc.encode(payload))}.${toBase64Url(new Uint8Array(sig))}`;
  }

  /** The payload of a value from `sign()`, or null if the signature doesn't match. */
  async verify(signed: string): Promise<string | null> {
    const [payload, sig] = signed.split(".");
    if (!payload || !sig) return null;
    const { hmac } = await this.derive();
    try {
      const bytes = fromBase64Url(payload);
      const ok = await crypto.subtle.verify("HMAC", hmac, fromBase64Url(sig), bytes);
      return ok ? dec.decode(bytes) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Compares two strings in time independent of where they differ (and of
 * their lengths): both are hashed under a random key first.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
