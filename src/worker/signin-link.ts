/**
 * One-time Garmin sign-in links, for clients that can't show the app's form
 * (or when Garmin's sign-in expired): `/signin?t=…`, HMAC-signed, valid for
 * 10 minutes, usable once. Connecting the client again is never needed.
 */
import type { Sealer } from "./crypto.js";

export interface LinkVault {
  issueLinkNonce(): Promise<{ nonce: string; exp: number }>;
  consumeLinkNonce(nonce: string): Promise<boolean>;
}

export async function createSignInLink(
  vault: LinkVault,
  sealer: Sealer,
  origin: string,
): Promise<string> {
  const { nonce, exp } = await vault.issueLinkNonce();
  const token = await sealer.sign(JSON.stringify({ n: nonce, exp }));
  return `${origin}/signin?t=${encodeURIComponent(token)}`;
}

/** True once for a valid, unexpired link token. */
export async function redeemSignInLink(
  vault: LinkVault,
  sealer: Sealer,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const payload = await sealer.verify(token);
  if (!payload) return false;
  let claim: { n?: unknown; exp?: unknown };
  try {
    claim = JSON.parse(payload) as typeof claim;
  } catch {
    return false;
  }
  if (typeof claim.n !== "string" || typeof claim.exp !== "number" || claim.exp <= now) {
    return false;
  }
  return vault.consumeLinkNonce(claim.n);
}
