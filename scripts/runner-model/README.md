# Runner model

`src/replay/assets/runner-female.glb` is the replay's runner: a MakeHuman character
built with MPFB (MakeHuman for Blender) by `build_runner.py`, then inlined into
`dist/app.html` at build time (no runtime download).

## License

Every asset in the model is **CC0 1.0** (public domain dedication), so it can ship
inside this MIT app without attribution requirements:

- Base mesh, rig (game_engine), skin `young_caucasian_female`, eyes, eyebrows,
  eyelashes, hair `ponytail01`, clothes `female_sportsuit01` and `shoes05`:
  MakeHuman system assets — https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html
  (CC0 since MakeHuman 1.2.0, see https://github.com/makehumancommunity/makehuman/blob/master/LICENSE.md)
- `build_runner.py` also defines a male variant using `elvs_crude_t-shirt_male`
  (shirts01), `cortu_jeans_shorts` (pants01) and `shoes06`; those packs are CC0 too.

Only use CC0 packs here (`*_cc0.zip`); community CC-BY assets would need credits.

## Rebuild

1. Install Blender 4.2+ and the MPFB extension:
   `Blender --online-mode -c extension install --enable mpfb`
2. Download the CC0 packs (`makehuman_system_assets_cc0.zip`, `shirts01_cc0.zip`,
   `pants01_cc0.zip`, `shoes01_cc0.zip`) from
   https://static.makehumancommunity.org/assets/assetpacks.html and load them in MPFB
   (Apply assets → Library settings → Load pack from zip file).
3. `Blender --background --factory-startup --python scripts/runner-model/build_runner.py -- female src/replay/assets/runner-female.glb`
