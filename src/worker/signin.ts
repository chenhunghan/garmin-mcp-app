/**
 * Garmin sign-in for the self-hosted server: signs in with tokens held in
 * memory and reads which Garmin account it is. Only then does the caller pick
 * the vault (the owner's, a member's) and `keep()` the tokens there, which
 * checks the account is that vault's. The password is used for the one login
 * request and never stored or logged.
 */
import { GarminClient, type MfaState } from "garmin-connect";
import { memoryTokenStorage, type Tokens } from "./vault.js";

export interface SignInVault {
  bindOwner(garminId: string): Promise<boolean>;
  saveTokens(tokens: Tokens): Promise<void>;
  setName(name: string): Promise<void>;
}

/** A Garmin account that just signed in, not kept anywhere yet. */
export interface SignedIn {
  garminId: string;
  /** From the Garmin profile, for the owner page */
  name?: string;
  tokens: Tokens;
}

export class WrongAccountError extends Error {
  /** The account that signed in and its tokens: the owner may switch to it (authorize page) */
  constructor(
    readonly garminId: string,
    readonly tokens: Tokens,
  ) {
    super("This Run Coach is linked to another Garmin account. Sign in with that account.");
    this.name = "WrongAccountError";
  }
}

export type GarminSignIn =
  | { status: "success"; account: SignedIn }
  | { status: "needs_mfa"; mfaState: MfaState };

export async function garminLogin(email: string, password: string): Promise<GarminSignIn> {
  const storage = memoryTokenStorage();
  const client = new GarminClient({ storage });
  const result = await client.login(email, password);
  if (result.status === "needs_mfa") return { status: "needs_mfa", mfaState: result.mfaState };
  return { status: "success", account: await account(client, storage.current()) };
}

export async function garminMfa(code: string, mfaState: MfaState): Promise<SignedIn> {
  const storage = memoryTokenStorage();
  const client = new GarminClient({ storage });
  await client.submitMfa(code, mfaState);
  return account(client, storage.current());
}

/** Keeps the tokens in `vault`; WrongAccountError if the vault belongs to another account. */
export async function keep(vault: SignInVault, signedIn: SignedIn): Promise<void> {
  if (!(await vault.bindOwner(signedIn.garminId))) {
    throw new WrongAccountError(signedIn.garminId, signedIn.tokens);
  }
  await vault.saveTokens(signedIn.tokens);
  if (signedIn.name) await vault.setName(signedIn.name);
}

async function account(client: GarminClient, tokens: Tokens | null): Promise<SignedIn> {
  const profile = (await client.getUserProfile()) as {
    profileId?: unknown;
    fullName?: unknown;
    displayName?: unknown;
  } | null;
  if (!tokens || profile?.profileId == null) throw new Error("Couldn't read the Garmin account");
  const name = [profile.fullName, profile.displayName].find(
    (n): n is string => typeof n === "string" && n.trim() !== "",
  );
  return { garminId: String(profile.profileId), ...(name && { name: name.trim() }), tokens };
}
