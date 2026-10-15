"""
Builds the replay's runner model with MPFB (MakeHuman for Blender) and exports
it as one glTF binary for three.js: a lean runner's build, plus one morph
target ("heavy") towards a heavier build, so the view can shape the body from
the athlete's weight and height (Garmin profile) without a model per build.

    /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \\
        --python scripts/runner-model/build_runner.py -- female src/replay/assets/runner-female.glb

Needs the MPFB extension and these CC0 asset packs loaded into it (see README.md):
makehuman_system_assets, shirts01, pants01, shoes01.

Every asset used is CC0 (MakeHuman system assets and CC0 community packs), so
the exported model can ship inside the app.
"""
import os
import sys

import bpy
import addon_utils

addon_utils.enable("bl_ext.blender_org.mpfb", default_set=True)
from bl_ext.blender_org.mpfb.services.humanservice import HumanService  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
variant = argv[0] if argv else "female"
out = os.path.abspath(argv[1] if len(argv) > 1 else f"runner-{variant}.glb")

VARIANTS = {
    "female": {
        "phenotype": {
            "gender": 0.0,
            "age": 0.5,  # ~25 years
            "muscle": 0.62,
            "weight": 0.22,
            "proportions": 0.85,
            "height": 0.55,
            "cupsize": 0.3,
            "firmness": 0.6,
            "race": {"asian": 0.34, "caucasian": 0.33, "african": 0.33},
        },
        "skin": "young_caucasian_female/young_caucasian_female.mhmat",
        "hair": "ponytail01/ponytail01.mhclo",
        "eyebrows": "eyebrow001/eyebrow001.mhclo",
        "clothes": [
            "female_sportsuit01/female_sportsuit01.mhclo",
            "shoes05/shoes05.mhclo",
        ],
    },
    "male": {
        "phenotype": {
            "gender": 1.0,
            "age": 0.5,
            "muscle": 0.62,
            "weight": 0.22,
            "proportions": 0.85,
            "height": 0.55,
            "cupsize": 0.5,
            "firmness": 0.5,
            "race": {"asian": 0.34, "caucasian": 0.33, "african": 0.33},
        },
        "skin": "young_caucasian_male/young_caucasian_male.mhmat",
        "hair": "short02/short02.mhclo",
        "eyebrows": "eyebrow001/eyebrow001.mhclo",
        "clothes": [
            "elvs_crude_t-shirt_male/elvs_crude_t-shirt_male.mhclo",
            "cortu_jeans_shorts/cortu_jeans_shorts.mhclo",
            "shoes06/shoes06.mhclo",
        ],
    },
}
v = VARIANTS[variant]

# The morph target's build: what a heavier athlete (BMI ~30) looks like
HEAVY = {"weight": 1.0, "muscle": 0.45, "proportions": 0.5}


def build(phenotype):
    """A fresh scene with the character; mesh objects keyed by asset (name without suffixes)."""
    bpy.ops.wm.read_homefile(use_empty=True)
    info = HumanService._create_default_human_info_dict()
    info["phenotype"] = phenotype
    info["rig"] = "game_engine"
    info["eyes"] = "low-poly/low-poly.mhclo"
    info["eyebrows"] = v["eyebrows"]
    info["eyelashes"] = "eyelashes01/eyelashes01.mhclo"
    info["hair"] = v["hair"]
    info["clothes"] = v["clothes"]
    info["skin_mhmat"] = v["skin"]
    info["skin_material_type"] = "MAKESKIN"
    info["alternative_materials"] = {}
    settings = HumanService.get_default_deserialization_settings()
    settings["subdiv_levels"] = 0
    settings["material_instances"] = "NEVER"
    HumanService.deserialize_from_dict(info, settings)

    meshes = {}
    for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
        bpy.context.view_layer.objects.active = obj
        # Bake the body shape (MakeHuman targets are shape keys) into the mesh
        if obj.data.shape_keys:
            obj.shape_key_add(name="baked", from_mix=True)
            for k in [k for k in obj.data.shape_keys.key_blocks if k.name != "baked"]:
                obj.shape_key_remove(k)
            obj.shape_key_remove(obj.data.shape_keys.key_blocks["baked"])
        # No subdivision (triangles); masks (body hidden under clothes) applied
        # now, since the exporter can't apply modifiers to meshes with morphs
        for m in list(obj.modifiers):
            if m.type == "SUBSURF":
                obj.modifiers.remove(m)
            elif m.type == "MASK":
                bpy.ops.object.modifier_apply(modifier=m.name)
        meshes[obj.name.split(".")[-1] if "." in obj.name else "body"] = obj
    return meshes


heavy_pheno = dict(v["phenotype"], **HEAVY)
heavy = {k: [vtx.co.copy() for vtx in o.data.vertices] for k, o in build(heavy_pheno).items()}
lean = build(v["phenotype"])
for key, obj in lean.items():
    co = heavy.get(key)
    if not co or len(co) != len(obj.data.vertices):
        print("NO MORPH", key, len(co or []), len(obj.data.vertices))
        continue
    obj.shape_key_add(name="Basis", from_mix=False)
    sk = obj.shape_key_add(name="heavy", from_mix=False)
    for i, c in enumerate(co):
        sk.data[i].co = c


def simple_material(mat):
    """MPFB's node materials → one Principled BSDF with the diffuse (and normal) image, for glTF."""
    if not mat or not mat.use_nodes:
        return
    images = [n.image for n in mat.node_tree.nodes if n.type == "TEX_IMAGE" and n.image]
    diffuse = next((i for i in images if "normal" not in i.name.lower() and "_ao" not in i.name.lower()
                    and "bump" not in i.name.lower() and "spec" not in i.name.lower()), None)
    normal = next((i for i in images if "normal" in i.name.lower()), None)
    nt = mat.node_tree
    nt.nodes.clear()
    outn = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], outn.inputs["Surface"])
    bsdf.inputs["Roughness"].default_value = 0.6
    if diffuse:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = diffuse
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
        if diffuse.depth == 32 or diffuse.alpha_mode != "NONE":
            nt.links.new(t.outputs["Alpha"], bsdf.inputs["Alpha"])
    if normal:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = normal
        t.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])


for mat in bpy.data.materials:
    simple_material(mat)

# Textures at most 1024 px (skin) / 512 px (the rest): the runner is a few hundred pixels tall
for img in bpy.data.images:
    cap = 1024 if "skin" in img.name or "female_diffuse" in img.name or "male_diffuse" in img.name else 512
    if img.size[0] > cap or img.size[1] > cap:
        s = cap / max(img.size[0], img.size[1])
        img.scale(max(1, int(img.size[0] * s)), max(1, int(img.size[1] * s)))

for obj in bpy.data.objects:
    print("OBJECT", obj.type, obj.name, len(obj.data.vertices) if obj.type == "MESH" else "")

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=True,
    export_skins=True,
    export_morph=True,
    export_morph_normal=False,
    export_animations=False,
    export_image_format="WEBP",
    export_image_quality=82,
    export_texcoords=True,
    export_normals=True,
    export_yup=True,
)
print("WROTE", out, os.path.getsize(out))
