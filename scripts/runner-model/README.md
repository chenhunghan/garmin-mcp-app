# Runner model

`src/replay/assets/runner-female.glb` and `runner-male.glb` are the replay's runners:
MakeHuman characters built with MPFB (MakeHuman for Blender) by `build_runner.py`, then
inlined into `dist/app.html` at build time (no runtime download). Each is a lean
runner's build with one `heavy` morph target (MakeHuman's heaviest build); the view
sets it from the athlete's BMI and scales the runner to their height.

## License

The models ship inside this MIT app. Most assets are **CC0 1.0**; the running clothes
from the MakeHuman community are **CC BY** and are credited under the replay ("Runner
clothes: Mindfront, punkduck"):

- Male tank top `mindfront_tank_top_01` and shorts `mindfront_male_swimming_trunks_02`
  (repainted plain navy): Mindfront, CC BY (shirts03, pants03 packs).
- Running shoes `punkduck_running_shoes_01` (both): punkduck, CC BY (shoes02 pack).
- Low socks `joepal_crude_low_socks` (both): joepal, CC0 (underwear04 pack).

The rest is CC0:

- Base mesh, rig (game_engine), skin `young_caucasian_female`, eyes, eyebrows,
  eyelashes, hair `ponytail01`, clothes `female_sportsuit01`:
  MakeHuman system assets — https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html
  (CC0 since MakeHuman 1.2.0, see https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md)
- Male: skin `young_caucasian_male`, hair `short02` (system assets), CC0.

Never use non-commercial (NC) assets; a CC-BY asset needs its author added to the
credit line (`RUNNER_CREDIT` in `src/replay-assets.ts`) and here.

## Rebuild

1. Install Blender 4.2+ and the MPFB extension:
   `Blender --online-mode -c extension install --enable mpfb`
2. Download the packs (`makehuman_system_assets_cc0.zip`, `underwear04_cc0.zip`,
   `shirts03_ccby.zip`, `pants03_ccby.zip`, `shoes02_ccby.zip`) from
   https://static.makehumancommunity.org/assets/assetpacks.html and load them in MPFB
   (Apply assets → Library settings → Load pack from zip file).
3. For `female` and `male`:
   `Blender --background --factory-startup --python scripts/runner-model/build_runner.py -- female src/replay/assets/runner-female.glb`
