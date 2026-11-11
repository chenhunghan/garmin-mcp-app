import type { OAuth1Token, OAuth2Token } from "./types.ts";

/** Interface for token storage — implement for custom backends (DB, Redis, etc.) */
export interface TokenStorage {
  save(oauth1: OAuth1Token, oauth2: OAuth2Token): Promise<void>;
  load(): Promise<{ oauth1: OAuth1Token; oauth2: OAuth2Token } | null>;
  clear(): Promise<void>;
}

/**
 * File storage, loaded on first use: the client's import graph stays free of
 * Node built-ins, so it also runs where a custom `storage` is always passed
 * (Cloudflare Workers).
 */
export function lazyFileTokenStorage(dirPath: string): TokenStorage {
  let storage: Promise<TokenStorage> | undefined;
  const get = () =>
    (storage ??= import("./file-storage.ts").then((m) => new m.FileTokenStorage(dirPath)));
  return {
    save: async (oauth1, oauth2) => (await get()).save(oauth1, oauth2),
    load: async () => (await get()).load(),
    clear: async () => (await get()).clear(),
  };
}
