"""
Simplifies a Poly Haven glTF model for the replay and exports it as GLB:
meshes joined, decimated to about the target triangle count, standing on the
origin (base center at 0,0,0, +Y up, meters), textures at most 512 px WebP.

    Blender --background --factory-startup --python model.py -- in.gltf out.glb TRIS [KEEP] [split]

KEEP: a regex; only top-level objects whose name matches are kept (one
variant of a model that ships several side by side). "split": each
top-level object is a variant of its own, exported as a separate node
("v0", "v1", …), each on its own origin; TRIS is shared among them.

Prints one line "MODEL {json}" with the size of each variant.
"""
import json
import re
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
src, out, target = argv[0], argv[1], int(argv[2])
keep = re.compile(argv[3]) if len(argv) > 3 and argv[3] else None
split = len(argv) > 4 and argv[4] == "split"

bpy.ops.wm.read_homefile(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

roots = [o for o in bpy.context.scene.objects if o.parent is None]
if keep:
    for r in [r for r in roots if not keep.search(r.name)]:
        for o in [r] + list(r.children_recursive):
            bpy.data.objects.remove(o)
    roots = [o for o in bpy.context.scene.objects if o.parent is None]

groups = [[r] + list(r.children_recursive) for r in roots] if split else [list(bpy.context.scene.objects)]


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def join(objs):
    """All meshes of a group, transforms baked, as one object."""
    names = [o.name for o in objs]
    meshes = [o for o in objs if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    for n in names:
        o = bpy.data.objects.get(n)
        if o is not None and o != obj:
            bpy.data.objects.remove(o)
    return obj


variants = []
objs = [join(g) for g in groups]
total = sum(tris(o) for o in objs)
for i, obj in enumerate(objs):
    before = tris(obj)
    share = max(200, target * before // max(1, total))
    if before > share:
        # Collapse keeps the silhouette; UVs and seams are kept by default
        m = obj.modifiers.new("decimate", "DECIMATE")
        m.decimate_type = "COLLAPSE"
        m.ratio = max(0.002, share / before)
        m.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=m.name)
    # Stand on the origin: base center at 0,0,0
    vs = [v.co for v in obj.data.vertices]
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    obj.data.transform(Matrix.Translation(-Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))))
    obj.location = (0, 0, 0)
    obj.name = f"v{i}"
    size = hi - lo
    # Blender is Z-up; the GLB is Y-up
    variants.append(
        {"width": round(size.x, 3), "depth": round(size.y, 3), "height": round(size.z, 3), "tris": tris(obj)}
    )

for img in bpy.data.images:
    if img.size[0] > 512 or img.size[1] > 512:
        s = 512 / max(img.size[0], img.size[1])
        img.scale(max(1, int(img.size[0] * s)), max(1, int(img.size[1] * s)))

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_image_format="WEBP",
    export_image_quality=85,
    export_apply=True,
    export_yup=True,
    export_animations=False,
)
print("MODEL " + json.dumps({"variants": variants, "sourceTris": total}))
