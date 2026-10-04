/**
 * Encrypt the password with the server's single-use RSA-OAEP public key
 * (base64 SPKI DER) so only ciphertext passes through the host.
 */
export async function encryptPassword(password: string, publicKey: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure login is unavailable in this environment (WebCrypto missing)");
  }
  const der = Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    new TextEncoder().encode(password),
  );
  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
}
