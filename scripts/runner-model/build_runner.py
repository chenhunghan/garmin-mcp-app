"""
Builds the replay's runner model with MPFB (MakeHuman for Blender) and exports
it as one glTF binary for three.js.

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
            "muscle": 0.68,
            "weight": 0.42,
            "proportions": 0.75,
            "height": 0.55,
            "cupsize": 0.4,
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
            "muscle": 0.68,
            "weight": 0.42,
            "proportions": 0.75,
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

# Empty scene
bpy.ops.wm.read_homefile(use_empty=True)

info = HumanService._create_default_human_info_dict()
info["phenotype"] = v["phenotype"]
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
basemesh = HumanService.deserialize_from_dict(info, settings)

# Bake the body shape (targets are shape keys) into plain geometry
for obj in [o for o in bpy.data.objects if o.type == "MESH" and o.data.shape_keys]:
    bpy.context.view_layer.objects.active = obj
    obj.shape_key_add(name="baked", from_mix=True)
    keys = obj.data.shape_keys.key_blocks
    for k in [k for k in keys if k.name != "baked"]:
        obj.shape_key_remove(k)
    obj.shape_key_remove(obj.data.shape_keys.key_blocks["baked"])

# Subdivision would multiply the triangles: drop it; masks (body hidden under
# clothes) stay and are applied by the exporter
for obj in [o for o in bpy.data.objects if o.type == "MESH"]:
    for m in list(obj.modifiers):
        if m.type == "SUBSURF":
            obj.modifiers.remove(m)


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

# Textures at most 1024 px: the runner is a few hundred pixels tall on screen
for img in bpy.data.images:
    if img.size[0] > 1024 or img.size[1] > 1024:
        s = 1024 / max(img.size[0], img.size[1])
        img.scale(max(1, int(img.size[0] * s)), max(1, int(img.size[1] * s)))

for obj in bpy.data.objects:
    print("OBJECT", obj.type, obj.name, len(obj.data.vertices) if obj.type == "MESH" else "")

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=True,
    export_skins=True,
    export_morph=False,
    export_animations=False,
    export_image_format="WEBP",
    export_image_quality=82,
    export_texcoords=True,
    export_normals=True,
    export_yup=True,
)
print("WROTE", out, os.path.getsize(out))
