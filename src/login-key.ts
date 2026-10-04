import { constants, generateKeyPairSync, privateDecrypt, type KeyObject } from "node:crypto";

/**
 * Single-use RSA-OAEP key for transporting the Garmin password from the app
 * iframe to the server. Tool call arguments pass through the host, which may
 * log them verbatim, so the app encrypts the password with this public key.
 * The private key never leaves memory and is discarded after one use, so a
 * logged ciphertext cannot be decrypted or replayed.
 */
let privateKey: KeyObject | null = null;

/** Create a fresh key pair and return the public key as base64 SPKI DER. */
export function issueLoginKey(): string {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  return pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

/** Decrypt a base64 RSA-OAEP (SHA-256) ciphertext and invalidate the key. */
export function decryptWithLoginKey(ciphertext: string): string {
  const key = privateKey;
  privateKey = null;
  if (!key) {
    throw new Error("Login key expired, please try again");
  }
  return privateDecrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(ciphertext, "base64"),
  ).toString("utf-8");
}
