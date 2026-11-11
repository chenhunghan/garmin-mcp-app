/**
 * One-time Garmin sign-in links, for clients that can't show the app's form
 * (or when Garmin's sign-in expired): `/signin?t=…`, HMAC-signed, valid for
 * 10 minutes, used up by the first sign-in it completes (opening it doesn't:
 * link previews and reloads would spend it). Connecting the client again is
 * never needed.
 */
import type { Sealer } from "./crypto.js";

export interface LinkVault {
  issueLinkNonce(): Promise<{ nonce: string; exp: number }>;
  peekLinkNonce(nonce: string): Promise<boolean>;
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

/** The link's nonce while the link is valid, unexpired and unused; else null. */
export async function checkSignInLink(
  vault: LinkVault,
  sealer: Sealer,
  token: string,
  now = Date.now(),
): Promise<string | null> {
  const payload = await sealer.verify(token);
  if (!payload) return null;
  let claim: { n?: unknown; exp?: unknown };
  try {
    claim = JSON.parse(payload) as typeof claim;
  } catch {
    return null;
  }
  if (typeof claim.n !== "string" || typeof claim.exp !== "number" || claim.exp <= now) {
    return null;
  }
  return (await vault.peekLinkNonce(claim.n)) ? claim.n : null;
}
