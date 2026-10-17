# Defense vehicles

Ground-defence vehicles generated for Stratos with **Meshy** (text-to-3D, `meshy-cli` 0.4.0): a preview mesh,
then a PBR refine pass (2k textures), one take each. The raw downloads are 3.3 M and 2.6 M triangles, so they
were decimated and repacked for the browser.

| File | Prompt | Meshy tasks (text-to-3d) | Size | Triangles |
| --- | --- | --- | --- | --- |
| `sam-launcher.glb` | self-propelled short-range surface-to-air missile launcher, six-wheeled military truck with a rotating launcher turret carrying four missile canisters, olive drab and sand camouflage, realistic military vehicle | preview `01a145eb-e113-751a-a951-e1686c61bdb7`, refine `01a145ed-8b94-7394-b704-59f82c0781cc` | 1.27 MB | 21 970 |
| `sam-radar.glb` | mobile air-search radar vehicle, six-wheeled military truck carrying a large flat rectangular phased-array radar antenna on a raised mast, olive drab camouflage, realistic military vehicle | preview `01a145ec-22b7-73ab-8e04-4d5522cd1dff`, refine `01a145ed-9281-7154-afaa-35e7b06d10e4` | 1.27 MB | 21 996 |

## Conventions

- Metres, **+Y up**, **front of the vehicle faces -Z**, origin at the ground centre (bounding box minimum Y is 0,
  X and Z centred on the box).
- `sam-launcher.glb`: 7.5 m long (Z), 2.75 m wide, 4.0 m tall (turret and canisters raised).
- `sam-radar.glb`: 9.0 m long (Z), 3.5 m wide, 5.7 m tall (antenna on its mast).
- One mesh, one PBR material (base colour, normal, metallic-roughness), all 1024 x 1024 WebP. No Draco or meshopt
  compression, no extensions beyond what `GLTFLoader` supports out of the box.
- Static meshes: the launcher turret and the radar antenna are not separate nodes, so they do not rotate.

## Processing

1. `meshy text-to-3d` preview, then refine (`--enable-pbr true --texture-resolution 2k`), GLB download.
2. `@gltf-transform` + `meshoptimizer`: weld, simplify to 22 000 triangles (error 0.05, borders unlocked), prune,
   resize every texture to 1024 px and re-encode as WebP (quality 85).
3. Rotate -90 degrees about Y (Meshy puts the cab at -X), scale uniformly so the longest horizontal extent equals the
   real length, move the bounding box so min Y = 0 and X/Z are centred. Positions and normals are baked, the node
   transforms stay identity.
4. Checked in a three.js viewer (front, side, back and three-quarter views, grid at y = 0): textures present, cab
   towards -Z, wheels on the ground.

Known flaws of the single take: simplification leaves slightly soft, pillowy surfaces, and the radar antenna is a
thick box rather than a thin flat panel. Both read correctly at game distances.
