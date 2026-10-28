/**
 * Garmin sign-in for the self-hosted server: signs in with tokens held in
 * memory, checks the account is the owner's, and only then keeps the tokens
 * in the vault. The password is used for the one login request and never
 * stored or logged.
 */
import { GarminClient, type MfaState } from "garmin-connect";
import { memoryTokenStorage, type Tokens } from "./vault.js";

export interface SignInVault {
  bindOwner(garminId: string): Promise<boolean>;
  saveTokens(tokens: Tokens): Promise<void>;
}

export class WrongAccountError extends Error {
  constructor() {
    super("This Run Coach is linked to another Garmin account. Sign in with that account.");
    this.name = "WrongAccountError";
  }
}

export type GarminSignIn = { status: "success" } | { status: "needs_mfa"; mfaState: MfaState };

export async function garminLogin(
  vault: SignInVault,
  email: string,
  password: string,
): Promise<GarminSignIn> {
  const storage = memoryTokenStorage();
  const client = new GarminClient({ storage });
  const result = await client.login(email, password);
  if (result.status === "needs_mfa") return { status: "needs_mfa", mfaState: result.mfaState };
  await keep(vault, client, storage.current());
  return { status: "success" };
}

export async function garminMfa(vault: SignInVault, code: string, mfaState: MfaState) {
  const storage = memoryTokenStorage();
  const client = new GarminClient({ storage });
  await client.submitMfa(code, mfaState);
  await keep(vault, client, storage.current());
}

async function keep(vault: SignInVault, client: GarminClient, tokens: Tokens | null) {
  const profile = (await client.getUserProfile()) as { profileId?: unknown } | null;
  if (!tokens || profile?.profileId == null) throw new Error("Couldn't read the Garmin account");
  if (!(await vault.bindOwner(String(profile.profileId)))) throw new WrongAccountError();
  await vault.saveTokens(tokens);
}
