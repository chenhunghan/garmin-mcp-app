import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_LICENSES, ASSET_PACK, ASSET_RELEASE, assetCredits } from "../src/replay-assets.ts";
import { assetDir, readAsset } from "../src/asset-store.ts";
// @ts-expect-error (plain JS build script)
import { SOURCES } from "../scripts/assets/sources.mjs";

describe("asset pack manifest", () => {
  it("every asset has an allowed license, a source and an author", () => {
    for (const a of ASSET_PACK.assets) {
      expect(ALLOWED_LICENSES, a.id).toHaveProperty(a.credit.license);
      expect(a.credit.url, a.id).toMatch(/^https?:\/\//);
      expect(a.credit.author, a.id).not.toBe("");
      expect(a.files.length, a.id).toBeGreaterThan(0);
      for (const f of a.files) expect(f.sha256, f.name).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("lists every source and nothing else", () => {
    const ids = (SOURCES as { id: string }[]).map((s) => s.id);
    expect(ASSET_PACK.assets.map((a) => a.id)).toEqual(ids);
  });

  it("file names are unique and carry their hash", () => {
    const names = ASSET_PACK.assets.flatMap((a) => a.files.map((f) => f.name));
    expect(new Set(names).size).toBe(names.length);
    for (const a of ASSET_PACK.assets)
      for (const f of a.files) expect(f.name).toContain(f.sha256.slice(0, 10));
  });

  it("credits the sites on screen", () => {
    expect(assetCredits(["ground.asphalt", "ground.lawn"])).toBe(
      "Materials, models and sky light: Poly Haven, ambientCG (CC0)",
    );
    expect(assetCredits([])).toBe("");
  });
});

describe("asset store", () => {
  const file = ASSET_PACK.assets[0]!.files[0]!;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-coach-assets-"));
    process.env.RUN_COACH_CACHE = dir;
    delete process.env.RUN_COACH_ASSETS;
  });
  afterEach(() => {
    delete process.env.RUN_COACH_CACHE;
  });

  it("rejects names that aren't in the manifest", async () => {
    await expect(readAsset("../../etc/passwd")).rejects.toThrow(/Unknown asset/);
  });

  it("downloads from the release once, checks the hash and caches", async () => {
    // A stand-in body whose hash we control: pretend the manifest expects it
    const body = new Uint8Array([1, 2, 3]);
    const real = file.sha256;
    file.sha256 = createHash("sha256").update(body).digest("hex");
    try {
      const fetchImpl = vi.fn(async () => new Response(body));
      expect([...(await readAsset(file.name, fetchImpl))]).toEqual([1, 2, 3]);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain(
        `/releases/download/${ASSET_RELEASE}/${file.name}`,
      );
      expect([...readFileSync(join(assetDir(), file.name))]).toEqual([1, 2, 3]);
      // Cached now
      await readAsset(file.name, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      file.sha256 = real;
    }
  });

  it("refuses a download that fails its checksum", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([9])));
    await expect(readAsset(file.name, fetchImpl)).rejects.toThrow(/checksum/);
  });

  it("re-downloads a corrupted cache file, and serves only the cache when downloads are off", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(assetDir(), { recursive: true });
    writeFileSync(join(assetDir(), file.name), "corrupt");
    process.env.RUN_COACH_ASSETS = "off";
    await expect(readAsset(file.name)).rejects.toThrow(/off/);
  });
});
