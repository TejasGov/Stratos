# Convert Mixamo FBX exports to game-ready GLB.
#   blender -b --factory-startup --python scripts/mixamo-to-glb.py -- character in.fbx out.glb
#   blender -b --factory-startup --python scripts/mixamo-to-glb.py -- clip in.fbx out.glb name
# Characters keep mesh + skin with textures shrunk to 1024 px JPEG; clips keep
# only the armature and one action named after the clip.
import sys, json
import bpy

args = sys.argv[sys.argv.index("--") + 1 :]
kind, src, dst = args[0], args[1], args[2]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, automatic_bone_orientation=False)

info = {}
# Some Mixamo characters export as mixamorig1:/mixamorig10:; clips bind by name.
for o in bpy.data.objects:
    if o.type == "ARMATURE":
        for b in o.data.bones:
            b.name = "mixamorig:" + b.name.split(":", 1)[-1]
if kind == "character":
    for a in bpy.data.actions:
        bpy.data.actions.remove(a)
    for img in bpy.data.images:
        if img.size[0] > 1024:
            img.scale(1024, max(1, round(img.size[1] * 1024 / img.size[0])))
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    # One skinned mesh per character keeps crowds to a draw call per material.
    if len(meshes) > 1:
        with bpy.context.temp_override(
            active_object=meshes[0], selected_editable_objects=meshes, selected_objects=meshes
        ):
            bpy.ops.object.join()
        meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    info["meshes"] = len(meshes)
    for ob in meshes:
        ob.data.calc_loop_triangles()
    tris = sum(len(o.data.loop_triangles) for o in meshes)
    info["tris_source"] = tris
    # Crowds show ~40 of these at once: cap each character near 15k triangles.
    if tris > 15000:
        for ob in meshes:
            ob.modifiers.new("decimate", "DECIMATE").ratio = 15000 / tris
    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_apply=True,
        export_animations=False,
        export_image_format="JPEG",
        export_jpeg_quality=82,
        export_yup=True,
    )
else:
    name = args[3]
    for ob in list(bpy.data.objects):
        if ob.type != "ARMATURE":
            bpy.data.objects.remove(ob)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    act = arm.animation_data.action
    act.name = name
    info["frames"] = list(act.frame_range)
    bpy.ops.export_scene.gltf(
        filepath=dst,
        export_format="GLB",
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_optimize_animation_size=True,
        export_yup=True,
    )

ob = next(o for o in bpy.data.objects if o.type == "ARMATURE")
info["bones"] = len(ob.data.bones)
info["root"] = ob.data.bones[0].name
info["armature_scale"] = list(ob.scale)
print("MIXAMO_INFO " + json.dumps(info))
