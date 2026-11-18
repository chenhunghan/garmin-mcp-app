/**
 * The vault as a Durable Object (SQLite storage): "owner" (the owner, and what
 * the server shares), "member:<id>" (a household member) and "keyring" (the
 * generated encryption key). One class, so wrangler.jsonc never changes.
 */
import { DurableObject } from "cloudflare:workers";
import type { MfaState } from "garmin-connect";
import type { Settings } from "../deps.js";
import { randomKeyHex } from "./crypto.js";
import { encryptionKey, type Env } from "./env.js";
import { Vault, type SignInTransaction, type Tokens } from "./vault.js";

export class GarminVault extends DurableObject<Env> {
  private vault: Vault;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.vault = new Vault(ctx.storage, {
      passphrase: env.OWNER_PASSPHRASE,
      encryptionKey: () => encryptionKey(env),
    });
  }

  /** "keyring" only: the generated encryption key, created on first use. */
  async generatedKey(): Promise<string> {
    // Storage calls hold other events back (input gate): two first requests get one key
    let key = await this.ctx.storage.get<string>("generated-key");
    if (!key) {
      key = randomKeyHex();
      await this.ctx.storage.put("generated-key", key);
    }
    return key;
  }

  checkInvite(code: string, client: string) {
    return this.vault.checkInvite(code, client);
  }
  getOwner() {
    return this.vault.getOwner();
  }
  getName() {
    return this.vault.getName();
  }
  setName(name: string) {
    return this.vault.setName(name);
  }
  wipe() {
    return this.vault.wipe();
  }
  createInvite() {
    return this.vault.createInvite();
  }
  listInvites() {
    return this.vault.listInvites();
  }
  cancelInvite(id: string) {
    return this.vault.cancelInvite(id);
  }
  findInvite(code: string) {
    return this.vault.findInvite(code);
  }
  consumeInvite(code: string) {
    return this.vault.consumeInvite(code);
  }
  listMembers() {
    return this.vault.listMembers();
  }
  getMember(id: string) {
    return this.vault.getMember(id);
  }
  findMemberByGarmin(garminId: string) {
    return this.vault.findMemberByGarmin(garminId);
  }
  addMember(garminId: string, name?: string) {
    return this.vault.addMember(garminId, name);
  }
  renameMember(id: string, name: string) {
    return this.vault.renameMember(id, name);
  }
  removeMember(id: string) {
    return this.vault.removeMember(id);
  }
  createSession() {
    return this.vault.createSession();
  }
  checkSession(secret: string) {
    return this.vault.checkSession(secret);
  }
  endSession(secret: string) {
    return this.vault.endSession(secret);
  }

  checkPassphrase(input: string, client: string) {
    return this.vault.checkPassphrase(input, client);
  }
  rateLimit(bucket: string, limit: number, windowMs: number) {
    return this.vault.rateLimit(bucket, limit, windowMs);
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
  setOwner(garminId: string) {
    return this.vault.setOwner(garminId);
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
  getAppMfa() {
    return this.vault.getAppMfa();
  }
  clearAppMfa() {
    return this.vault.clearAppMfa();
  }
  issueLinkNonce() {
    return this.vault.issueLinkNonce();
  }
  peekLinkNonce(nonce: string) {
    return this.vault.peekLinkNonce(nonce);
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
