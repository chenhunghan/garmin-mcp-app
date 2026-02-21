import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { OAuth1Token, OAuth2Token } from "./types.ts";

/** Interface for token storage — implement for custom backends (DB, Redis, etc.) */
export interface TokenStorage {
  save(oauth1: OAuth1Token, oauth2: OAuth2Token): Promise<void>;
  load(): Promise<{ oauth1: OAuth1Token; oauth2: OAuth2Token } | null>;
  clear(): Promise<void>;
}

/** File-system storage compatible with Garth/python-garminconnect format */
export class FileTokenStorage implements TokenStorage {
  private dirPath: string;

  constructor(dirPath: string) {
    this.dirPath = dirPath.replace(/^~/, process.env.HOME || "");
  }

  async save(oauth1: OAuth1Token, oauth2: OAuth2Token): Promise<void> {
    await mkdir(this.dirPath, { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.dirPath, "oauth1_token.json"),
      JSON.stringify(oauth1, null, 2) + "\n",
      { mode: 0o600 },
    );
    await writeFile(
      join(this.dirPath, "oauth2_token.json"),
      JSON.stringify(oauth2, null, 2) + "\n",
      { mode: 0o600 },
    );
  }

  async load(): Promise<{ oauth1: OAuth1Token; oauth2: OAuth2Token } | null> {
    try {
      const [raw1, raw2] = await Promise.all([
        readFile(join(this.dirPath, "oauth1_token.json"), "utf-8"),
        readFile(join(this.dirPath, "oauth2_token.json"), "utf-8"),
      ]);
      return {
        oauth1: JSON.parse(raw1) as OAuth1Token,
        oauth2: JSON.parse(raw2) as OAuth2Token,
      };
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    const files = ["oauth1_token.json", "oauth2_token.json"];
    await Promise.all(
      files.map((f) => rm(join(this.dirPath, f), { force: true })),
    );
  }
}
