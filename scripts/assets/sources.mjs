/**
 * Every file in the replay's asset pack, where it comes from and how it's
 * processed. All sources are CC0 (Poly Haven, ambientCG) or allow
 * redistribution (CMU motion capture), so the processed files may be shipped.
 *
 * Kinds:
 * - "surface": a tileable PBR material, packed into two images:
 *   `<id>.a.webp` = color (sRGB) + height (alpha),
 *   `<id>.b.webp` = normal X/Y (OpenGL) + roughness + ambient occlusion (alpha)
 * - "atlas": a cut-out image (leaves, grass blades): color + opacity (alpha), plus normal
 * - "sky": an HDR photo, sun clipped out, as a small RGBE file
 * - "model": a glTF model, simplified in Blender, exported as GLB with WebP textures
 * - "motion": a motion capture take (CMU ASF/AMC), reduced to one running cycle
 */

/** Real-world size of one tile of a Poly Haven texture: its `dimensions` (mm) */
const PH = "polyhaven";
const ACG = "ambientcg";

export const SOURCES = [
  // ── Ground (layers of one texture array, in this order) ──
  { id: "ground.lawn", kind: "surface", from: ACG, asset: "Grass004", size: 1024, tile: 1.4 },
  { id: "ground.meadow", kind: "surface", from: PH, asset: "leafy_grass", size: 1024 },
  { id: "ground.forest", kind: "surface", from: PH, asset: "forest_leaves_02", size: 1024 },
  { id: "ground.dirt", kind: "surface", from: PH, asset: "rocky_trail_02", size: 1024 },
  { id: "ground.gravel", kind: "surface", from: PH, asset: "gravel_floor_02", size: 1024 },
  { id: "ground.asphalt", kind: "surface", from: PH, asset: "asphalt_02", size: 1024 },
  { id: "ground.paving", kind: "surface", from: PH, asset: "pavement_04", size: 1024 },
  { id: "ground.concrete", kind: "surface", from: PH, asset: "concrete_pavement", size: 1024 },
  { id: "ground.sand", kind: "surface", from: PH, asset: "sand_01", size: 1024 },
  { id: "ground.rock", kind: "surface", from: PH, asset: "rocks_ground_05", size: 1024 },
  { id: "ground.soil", kind: "surface", from: PH, asset: "brown_mud_02", size: 1024 },
  { id: "ground.worn", kind: "surface", from: ACG, asset: "Ground037", size: 1024, tile: 2 },

  // ── Walls and roofs (one texture array; plain colors are tinted per building) ──
  {
    id: "wall.plaster",
    kind: "surface",
    from: PH,
    asset: "beige_wall_001",
    size: 512,
    neutral: true,
  },
  { id: "wall.render", kind: "surface", from: PH, asset: "grey_plaster", size: 512, neutral: true },
  {
    id: "wall.concrete",
    kind: "surface",
    from: PH,
    asset: "concrete_wall_007",
    size: 512,
    neutral: true,
  },
  { id: "wall.brick", kind: "surface", from: PH, asset: "red_brick", size: 512 },
  {
    id: "wall.lightbrick",
    kind: "surface",
    from: PH,
    asset: "white_sandstone_bricks_03",
    size: 512,
  },
  {
    id: "wall.tiles",
    kind: "surface",
    from: PH,
    asset: "rectangular_facade_tiles",
    size: 512,
    neutral: true,
  },
  {
    id: "wall.metal",
    kind: "surface",
    from: PH,
    asset: "corrugated_iron_02",
    size: 512,
    neutral: true,
  },
  { id: "wall.wood", kind: "surface", from: PH, asset: "wood_planks_dirt", size: 512 },
  { id: "roof.tiles", kind: "surface", from: PH, asset: "roof_09", size: 512 },
  { id: "roof.slate", kind: "surface", from: PH, asset: "grey_roof_01", size: 512 },
  {
    id: "roof.concrete",
    kind: "surface",
    from: PH,
    asset: "concrete_floor_worn_001",
    size: 512,
    neutral: true,
  },

  // ── Trees ──
  { id: "bark.zelkova", kind: "surface", from: PH, asset: "japanese_zelkova_bark", size: 512 },
  { id: "bark.camphor", kind: "surface", from: PH, asset: "japanese_camphor_bark", size: 512 },
  { id: "bark.brown", kind: "surface", from: PH, asset: "bark_brown_02", size: 512 },
  { id: "bark.pine", kind: "surface", from: PH, asset: "pine_bark", size: 512 },
  { id: "bark.palm", kind: "surface", from: PH, asset: "palm_tree_bark", size: 512 },
  { id: "leaves.broad", kind: "atlas", from: ACG, asset: "LeafSet024", size: 1024 },
  { id: "leaves.heart", kind: "atlas", from: ACG, asset: "LeafSet004", size: 1024 },
  { id: "leaves.maple", kind: "atlas", from: ACG, asset: "LeafSet010", size: 1024 },
  { id: "leaves.needles", kind: "atlas", from: ACG, asset: "PineNeedles001", size: 1024 },

  // ── Grass and flowers ──
  { id: "grass.blades", kind: "atlas", from: ACG, asset: "Foliage001", size: 1024 },
  {
    id: "plant.flowers",
    kind: "model",
    from: PH,
    asset: "flower_gazania",
    tris: 2000,
    split: true,
  },
  { id: "plant.sorrel", kind: "model", from: PH, asset: "shrub_sorrel_01", tris: 2400, split: true },
  { id: "plant.periwinkle", kind: "model", from: PH, asset: "periwinkle_plant", tris: 3000, split: true },
  {
    id: "plant.dandelion",
    kind: "model",
    from: PH,
    asset: "dandelion_01",
    tris: 3000,
    split: true,
  },

  // ── Sky light (environment), by condition ──
  { id: "sky.clear", kind: "sky", from: PH, asset: "noon_grass", tags: { sunUp: true, cover: 0 } },
  {
    id: "sky.cloudy",
    kind: "sky",
    from: PH,
    asset: "buikslotermeerplein",
    tags: { sunUp: true, cover: 0.5 },
  },
  {
    id: "sky.overcast",
    kind: "sky",
    from: PH,
    asset: "overcast_soil_puresky",
    tags: { sunUp: true, cover: 1 },
  },
  {
    id: "sky.golden",
    kind: "sky",
    from: PH,
    asset: "spruit_sunrise",
    tags: { low: true, cover: 0 },
  },
  {
    id: "sky.dusk",
    kind: "sky",
    from: PH,
    asset: "kloppenheim_06_puresky",
    tags: { low: true, cover: 0.6 },
  },
  {
    id: "sky.night",
    kind: "sky",
    from: PH,
    asset: "shanghai_bund",
    tags: { night: true, urban: true },
  },
  {
    id: "sky.night-open",
    kind: "sky",
    from: PH,
    asset: "rogland_clear_night",
    tags: { night: true },
  },

  // ── Street furniture (placed only where OpenStreetMap maps it) ──
  { id: "street.lamp", kind: "model", from: PH, asset: "street_lamp_01", tris: 3000 },
  { id: "street.lamp2", kind: "model", from: PH, asset: "street_lamp_02", tris: 3000 },
  { id: "street.bench", kind: "model", from: PH, asset: "painted_wooden_bench", tris: 1200 },
  {
    id: "street.bin",
    kind: "model",
    from: PH,
    asset: "metal_trash_can",
    tris: 1500,
    keep: "^metal_trash_can(_handle_left|_handle_right)?$",
  },
  {
    id: "street.hydrant",
    kind: "model",
    from: PH,
    asset: "fire_hydrant",
    tris: 1500,
    keep: "^fire_hydrant(_cap_0[1-3]|_chain)?$",
  },
  // ── Runner motion: CMU running takes (upper-body curves per stride phase),
  // at two cadences (~161 and ~192 steps/min), blended by the run's cadence ──
  {
    id: "motion.jog",
    kind: "motion",
    from: "cmu",
    asset: "35/35_17+35_18+35_19+35_20+35_21+35_22+35_23+35_24+35_25+35_26",
  },
  {
    id: "motion.fast",
    kind: "motion",
    from: "cmu",
    asset: "16/16_48+16_55+16_08+16_35+16_36+16_45+16_46+16_56",
  },
];

export const LICENSES = {
  polyhaven: {
    license: "CC0-1.0",
    site: "https://polyhaven.com",
    page: (a) => `https://polyhaven.com/a/${a}`,
  },
  ambientcg: {
    license: "CC0-1.0",
    site: "https://ambientcg.com",
    page: (a) => `https://ambientcg.com/a/${a}`,
    author: "ambientCG (Lennart Demes)",
  },
  cmu: {
    license: "CMU-Mocap",
    site: "http://mocap.cs.cmu.edu",
    page: (a) => `http://mocap.cs.cmu.edu/search.php?subjectnumber=${a.split("/")[0]}`,
    author: "CMU Graphics Lab Motion Capture Database (NSF EIA-0196217)",
  },
};
