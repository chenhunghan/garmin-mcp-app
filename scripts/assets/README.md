# Replay asset pack

Scanned materials, sky photos, models and running motion for the 3D run replay. Not
bundled into `dist/app.html`: the MCP server serves each file to the view through the
app-only `garmin-get-replay-asset` tool, from `~/.cache/run-coach/replay-assets`
(`RUN_COACH_CACHE`), downloading a missing file once from this repo's GitHub release
`replay-assets-v<version>` and checking it against `src/replay-assets.json` (SHA-256).
Everything has a generated fallback, so a missing file only means the plainer look.
`RUN_COACH_ASSETS=off` stops downloads; `RUN_COACH_ASSETS_URL` points elsewhere.

```bash
npm run assets:build              # all, or: node scripts/assets/build.mjs ground. sky.
npm run assets:publish            # upload new files to the release (asks gh; --dry-run)
```

`build.mjs` downloads each source once (`~/.cache/run-coach/asset-sources`), processes
it into `build/replay-assets/` (names carry a hash of the content), rewrites the
manifest, and installs the files into the local cache, so a local build works before
anything is published. Needs ImageMagick 7 (`magick`), `unzip` and Blender
(`BLENDER=…`) for models.

| Kind | Source | Processing |
| --- | --- | --- |
| surface | Poly Haven / ambientCG 2K maps | 1K (ground) or 512 (walls, bark) WebP: `a` = color + height, `b` = normal X/Y + roughness + AO; plain wall colors made gray detail around 0.5 linear, tinted per building |
| atlas | ambientCG leaf and grass atlases | color + opacity, normal + roughness, and the pieces' rectangles |
| sky | Poly Haven 1K HDRIs | 512×256, the sun clipped out, gzipped RGBE; the sun's position and mean sky/ground light in the manifest |
| model | Poly Haven glTF | `model.py` in Blender: one variant or each top-level object as one (`split`), decimated, base on the origin, 512 px WebP |
| motion | CMU ASF/AMC takes | `motion.mjs`: per-phase upper-body curves from left touchdown, averaged over every stride |

## Licenses

Every asset must have an allowed license (a test checks `src/replay-assets.json`):

- Poly Haven (https://polyhaven.com) and ambientCG (https://ambientcg.com): **CC0**.
- CMU Graphics Lab Motion Capture Database (http://mocap.cs.cmu.edu): "may be copied,
  modified, or redistributed without permission"; credited under the replay as asked
  ("The data used in this project was obtained from mocap.cs.cmu.edu. The database was
  created with funding from NSF EIA-0196217.").
- EZ-Tree (https://github.com/dgreenheck/ez-tree, MIT) is code, vendored in
  `src/replay/vendor/ez-tree` with its license; its own textures are not used.

Never add non-commercial (NC) or no-derivatives (ND) assets: the app is published on npm.
