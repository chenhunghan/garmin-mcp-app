import { EventEmitter } from "node:events";

const emitter = new EventEmitter();

/**
 * Wait for the user to authenticate through the MCP App UI.
 * Resolves when `notifyAuth()` is called (after successful login/MFA).
 * Rejects after timeout if the user doesn't complete login.
 */
export function waitForAuth(timeoutMs = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener("authenticated", onAuth);
      reject(new Error("Authentication timed out"));
    }, timeoutMs);

    function onAuth() {
      clearTimeout(timer);
      resolve();
    }

    emitter.once("authenticated", onAuth);
  });
}

/**
 * Signal that authentication completed successfully.
 * Called by the login/MFA tool handlers after a successful auth flow.
 */
export function notifyAuth(): void {
  emitter.emit("authenticated");
}
