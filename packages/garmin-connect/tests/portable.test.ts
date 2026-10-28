/**
 * The client must run outside Node (Cloudflare Workers): bundle it for a
 * neutral platform and check that only the lazily loaded file storage, which
 * isn't used when a `storage` is passed, needs a Node built-in.
 */
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("runtime-agnostic client", () => {
  it("imports no Node built-in outside the file storage chunk", async () => {
    const result = await build({
      entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "neutral",
      external: ["node:*"],
      mainFields: ["module", "main"],
      outdir: "out",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    // Output file → the source files it was built from, for each Node import
    const nodeImports = Object.values(result.metafile.outputs).flatMap((out) =>
      out.imports
        .filter((i) => i.path.startsWith("node:"))
        .map(() => Object.keys(out.inputs).map((f) => f.replace(/^.*\//, ""))),
    );
    expect(nodeImports.length).toBeGreaterThan(0);
    for (const inputs of nodeImports) expect(inputs).toEqual(["file-storage.ts"]);
  });
});
