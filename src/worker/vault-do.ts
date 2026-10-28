/** The vault as a Durable Object (SQLite storage), one instance named "owner". */
import { DurableObject } from "cloudflare:workers";
import type { MfaState } from "garmin-connect";
import type { Settings } from "../deps.js";
import type { Env } from "./env.js";
import { Vault, type SignInTransaction, type Tokens } from "./vault.js";

export class GarminVault extends DurableObject<Env> {
  private vault: Vault;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.vault = new Vault(ctx.storage, {
      passphrase: env.OWNER_PASSPHRASE,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    });
  }

  checkPassphrase(input: string) {
    return this.vault.checkPassphrase(input);
  }
  loadTokens() {
    return this.vault.loadTokens();
  }
  freshTokens() {
    return this.vault.freshTokens();
  }
  saveTokens(tokens: Tokens) {
    return this.vault.saveTokens(tokens);
  }
  clearTokens() {
    return this.vault.clearTokens();
  }
  bindOwner(garminId: string) {
    return this.vault.bindOwner(garminId);
  }
  getSettings() {
    return this.vault.getSettings();
  }
  updateSettings(patch: Partial<Settings>) {
    return this.vault.updateSettings(patch);
  }
  getTimeZone() {
    return this.vault.getTimeZone();
  }
  setTimeZone(timeZone: string) {
    return this.vault.setTimeZone(timeZone);
  }
  putSignIn(id: string, tx: SignInTransaction) {
    return this.vault.putSignIn(id, tx);
  }
  getSignIn(id: string) {
    return this.vault.getSignIn(id);
  }
  deleteSignIn(id: string) {
    return this.vault.deleteSignIn(id);
  }
  putAppMfa(state: MfaState) {
    return this.vault.putAppMfa(state);
  }
  takeAppMfa() {
    return this.vault.takeAppMfa();
  }
  issueLinkNonce() {
    return this.vault.issueLinkNonce();
  }
  consumeLinkNonce(nonce: string) {
    return this.vault.consumeLinkNonce(nonce);
  }
  issueLoginKey() {
    return this.vault.issueLoginKey();
  }
  decryptWithLoginKey(ciphertext: string) {
    return this.vault.decryptWithLoginKey(ciphertext);
  }
}
