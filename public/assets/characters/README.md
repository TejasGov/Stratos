# Characters

Humanoids for base cinematics (never playable), generated with **Meshy** (`meshy-cli` 0.4.0). Each character went
through text-to-3D preview (A-pose), PBR refine (2k textures), a local decimation to about 14 000 triangles, and
Meshy auto-rigging at 1.78 m. Clips were made on the soldier rig only and are shared by all three characters.

| File | Prompt (all prefixed "full-body character in A-pose, ..." and suffixed ", no weapon, empty hands") | Meshy tasks | Size | Triangles |
| --- | --- | --- | --- | --- |
| `soldier.glb` | modern infantry soldier in olive green combat fatigues, plate carrier vest, combat helmet, gloves and boots, realistic proportions | preview `01a145ed-b1a4-7546-8e69-83bf0fe7f7c5`, refine `01a145f0-4d31-76cd-9427-417c8c66cd41`, rigging `01a145f3-43ab-7746-aa05-8eb206f64962` | 1.37 MB | 13 995 |
| `trooper.glb` | special forces operator in black tactical gear with a full-face gas mask, ballistic helmet, tactical vest, gloves and boots, realistic proportions | preview `01a145ed-beec-71aa-8dff-67177bde8911`, refine `01a145f0-53f8-72b1-b54a-75ec253a768c`, rigging `01a145f3-9af9-7679-af2e-e6aee0613191` | 1.61 MB | 13 992 |
| `instructor.glb` | military drill instructor wearing an olive t-shirt, camouflage trousers, combat boots and a campaign hat, athletic build, realistic proportions | preview `01a145ed-cbcf-73bf-bc13-79c55f9175de`, refine `01a145f0-5b08-72db-827d-beee10355e14`, rigging `01a145f3-afea-7530-b500-7ea5b2dc6e2c` | 1.36 MB | 13 999 |

Honest notes on the single takes: the soldier came out without a helmet (short hair, goggles), and the instructor
has a beret and a short-sleeved shirt rather than a campaign hat and t-shirt. Poses are an open-armed A-pose.

`manifest.json` lists the characters, bones and clips for the game to load.

## Conventions

- Metres, **+Y up**, characters **face +Z**, origin at the centre of the feet (min Y = 0), 1.78 m tall.
- One `SkinnedMesh` (`char1`) and one PBR material per character, textures 1024 x 1024 JPEG (base colour, normal,
  metallic-roughness). The rig keeps no stray animation; load clips separately.
- Skeleton: 24 joints with identical names and hierarchy on all three characters (`Hips`, `Spine02`, `Spine01`,
  `Spine`, `neck`, `Head`, `head_end`, `headfront`, `Left/RightShoulder`, `Arm`, `ForeArm`, `Hand`, `UpLeg`, `Leg`,
  `Foot`, `ToeBase`). Bones are authored in centimetres under an `Armature` node scaled 0.01, so the mesh ends up in
  metres.
- Rest poses differ slightly between characters (bone offsets are per character).

## Clips (`clips/<name>.glb`)

Skeleton nodes plus one animation per file, no mesh, no textures (16 to 165 KB each). Tracks target bones by name:
rotations for the 22 animated bones, plus a translation track for `Hips` only (the soldier's other bone offsets are
dropped so each character keeps its own proportions). The `Hips` translation is in rig units (centimetres, hip height
about 100), as the character's `Armature` scale expects. Frame rate is 30 fps; keyframes were resampled with a 1e-4
tolerance.

Use them with a mixer on the character root: `new AnimationMixer(character).clipAction(clipGltf.animations[0])`.
The animation name inside each file is the clip name.

| Clip | Loop | Duration | Meshy action | Credits |
| --- | --- | --- | --- | --- |
| `idle` | yes | 4.03 s | Idle (id 0), task `01a145f3-e939-7264-b335-49186d7103b3` | 3 |
| `alert` | yes | 4.03 s | Alert (2), `01a145f4-36f7-72b7-bc12-a01c75011b96` | 3 |
| `dead` | no | 3.00 s | Dead (8), `01a145f4-43ef-76a5-8f3d-44d969e435ee` | 3 |
| `agree-gesture` | no | 13.03 s | Agree Gesture (25), `01a145f4-5133-7760-9d59-4a5f947336cc` | 3 |
| `boxing-practice` | yes | 6.87 s | Boxing Practice (87), `01a145f4-5deb-76fc-8868-cf4a43ac2e61` | 3 |
| `jumping-jacks` | yes | 1.13 s | Jumping Jacks (326), `01a145f6-322f-7641-841f-4a88a5191417` | 3 |
| `dying-backwards` | no | 2.23 s | Dying Backwards (189), `01a145f6-4a20-76f1-a3a2-842cb2306ef4` | 3 |
| `talk-passionately` | yes | 10.30 s | Talk Passionately (308), `01a145f6-586b-7214-980e-320f18b9c4ee` | 3 |
| `walk` | yes | 1.07 s | Walking, bundled with the soldier rigging task | 0 |
| `run` | yes | 0.67 s | Running, bundled with the soldier rigging task | 0 |

Not obtained (credit budget): Casual Walk, Backflip, Situps, Air Squat. The catalogue's "free" flag does not mean
zero credits via the API: every `animate` task cost 3 credits.

## Processing

1. `meshy text-to-3d` preview with `--pose-mode a-pose`, then refine (`--enable-pbr true --texture-resolution 2k`).
   The refined meshes have 0.4 to 1.1 M triangles, above the rigging limit of 300 000 faces.
2. Decimated locally (`@gltf-transform` + `meshoptimizer`, weld, simplify to 14 000 triangles) with textures resized
   to 1024 px JPEG, and that GLB was passed to `meshy rigging create --model-url ... --height-meters 1.78`. Rigging
   therefore skinned the final mesh, so skinning stays intact and no post-rig decimation was needed.
3. Rigged GLBs downloaded as they came (feet already at the origin, 1.78 m, facing +Z); only the single-frame rest
   animation was removed.
4. Animations: `meshy animate create --rig-task-id <soldier rig> --action-id N`, then stripped to skeleton + clip
   (scale tracks and non-Hips translation tracks dropped, resampled).
5. Verified: the joint list of the three rigs and of every clip is identical (same names, same order); clips of the
   soldier rig play on the trooper and instructor with sane deformation (checked in a three.js viewer with clips
   run, walk, boxing, talk, dead, alert, jumping jacks and dying backwards).
