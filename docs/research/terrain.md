# Terrain generation for Stratos: research and implementation recommendations

Research date: October 5, 2026. Sources were accessed on this date. This report uses original papers, official documentation, and maintainers' repositories. Recommendations and proposed budgets are engineering judgments for Stratos, not measured performance claims. No game code was changed.

## Recommended direction

Build an authored/procedural hybrid archipelago with a coherent heightfield data layer, error-driven terrain LOD, stable collision samples, and velocity-aware streaming. Author a small number of memorable regions—an island airbase, coastal city, volcanic ridge, river valley, and mountain pass—then extend them with deterministic procedural geography. The objective is recognizable silhouettes and believable landscape relationships at flight speed. More noise octaves alone will not produce those qualities.

Retain Three.js and the existing worker pipeline. First improve terrain content and streaming reliability; then replace abrupt grid-resolution changes with stitched, morphing patches. Consider geometry clipmaps only if measurements show that patch generation, upload traffic, or draw-call overhead remains a bottleneck. These are different rendering architectures, not libraries that can simply be enabled.

## What Stratos already has

Inspection of `src/world/terrain.ts`, `terrain.worker.ts`, `World.ts`, and `src/flight.ts` shows useful foundations: a fixed seed, globally sampled height function, 1,600-meter chunks, transferable worker buffers, instanced scenery, and a floating render origin. The world requests a 9×9 chunk neighborhood with 48/24/12 subdivisions according to horizontal chunk distance. A single worker accepts up to four outstanding requests; this is a queue, not four simultaneous worker computations. Up to two completed chunks are added per frame.

The nearest grid spacing is approximately 33.3 meters, with 66.7- and 133.3-meter spacing farther out. That explains why fine landforms cannot be represented geometrically even when shading adds detail. Each edge has a 95-meter skirt. Terrain color depends mainly on elevation and slope, with shader noise adding variation. The height function creates repeated elliptical island envelopes, ridge noise, and one airfield flattening area. Collision samples the continuous height function independently from the rendered triangles. Rapier is not currently a dependency in `package.json`.

These are code observations. They imply specific improvement opportunities: stronger regional composition, camera-aware LOD, collision/render agreement, richer materials, and measured time budgets for chunk installation. Avoid replacing the functional seed/origin system merely to add terrain detail.

## Geography and generation

Use a staged terrain graph: regional landmass mask → mountain/valley structure → controlled noise → erosion/hydrology → coastal and infrastructure adjustments → material/scatter masks. Keep each stage versioned so a seed and generator version fully identify a world.

Fractal Brownian motion combines noise octaves using increasing frequency and decreasing amplitude. Domain warping distorts sampling coordinates before evaluating another noise field; ridged fractals help create sharper forms. FastNoiseLite documents these operations, including seed, frequency, octave gain/lacunarity, and separate domain-warp controls. It is a reference implementation rather than a guarantee that any particular JavaScript port has identical behavior or licensing. [FastNoiseLite maintainer documentation](https://github.com/Auburn/FastNoiseLite/wiki/Documentation).

For Stratos, apply low-frequency warping to shorelines and ridge locations, with bounded amplitudes so authored passes and runways survive. Use medium-scale detail to reinforce the region's identity. Exclude geometric frequencies that the selected mesh cannot resolve; move fine rock and soil variation into normals and roughness. Keep the full authoritative height data available to collision even when distant rendering omits detail.

Hydraulic erosion, thermal erosion, sediment, and drainage masks contribute relationships that independent noise lacks. Houdini's HeightField Erode produces height, sediment, debris, flow, and flow-direction layers and supports different erosion feature scales. [SideFX HeightField Erode](https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_erode).

Recommendation: run expensive erosion during content preparation for important regions, not during a dogfight. Independent per-chunk erosion can produce incompatible boundaries because water and sediment require neighboring context. Generate larger regions with overlap, crop consistently, and retain a common regional base. Gaea explicitly documents baking tile-unfriendly operations and using larger hybrid build buckets to preserve context. [Gaea tiled-build guidance](https://docs.gaea.app/using/using-gaea/build-and-export/tiled-builds.html).

Rivers should follow a regional drainage plan with connected outlets and descending profiles. A river texture painted across arbitrary noise is insufficient: carve banks, create floodplain masks, and use water surfaces that match the river profile. For the first release, authored river splines and catchment masks are a practical approximation. Procedural drainage networks can follow after regional connectivity is validated.

Biome placement should combine moisture, altitude, slope, drainage, distance to coast, and authored exclusion masks. Reuse these masks for materials, vegetation, and settlement eligibility. Houdini treats masks as named heightfield layers and can derive them from geometry, features, or painted input. [SideFX terrain masking](https://www.sidefx.com/docs/houdini/heightfields/masking.html). Recommendation: one region manifest should define height units, bounds, masks, water level, and protected infrastructure so visual and gameplay systems share the same geography.

## LOD architecture choices

| Method                           | Relevant strengths                                                      | Cost or limitation                                                    | Stratos recommendation                                     |
| -------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| Geomipmapped patches             | Regular grids, reusable index buffers, clear incremental upgrade        | Requires edge connectivity and smooth transitions                     | Best first implementation                                  |
| Quadtree plus screen-space error | Refines rugged/near terrain according to visible error                  | Requires error metadata, conservative bounds, and fallback parents    | Add once terrain data has an explicit hierarchy            |
| CDLOD                            | Quadtree-selected regular grids with continuous distance-based morphing | Selection/morph constraints must be reproduced correctly              | Strong alternative for a dedicated height-texture renderer |
| Geometry clipmaps                | Nested camera-centered grids updated incrementally                      | Height-texture cache, ring stitching, and update logic need a rewrite | Investigate after profiling patch approach                 |

The original geomipmapping paper describes regular height grids, block culling, maximum geometric-error-based selection, modified edge connectivity, and transitions between levels. Its historical hardware numbers and original image precision are not browser recommendations. [Willem de Boer, Fast Terrain Rendering Using Geometrical MipMapping](https://www.flipcode.com/archives/article_geomipmaps.pdf).

CDLOD's author describes a quadtree of regular grids and a consistent 3D-distance LOD function with smooth transitions, avoiding separate stitching meshes within the algorithm's rules. The reference implementation is old DirectX code; study its algorithm rather than treating it as a Three.js package. [Filip Strugar's CDLOD repository and paper abstract](https://github.com/fstrugar/CDLOD).

Geometry clipmaps maintain nested regular grids that shift incrementally with the viewer; the GPU implementation uses vertex texture sampling. Their attraction here is predictable geometry and incremental height updates over long flights. They do not eliminate data streaming, texture residency, or collision work. [Asirvatham and Hoppe, GPU geometry clipmaps](https://hhoppe.com/proj/gpugcm/).

For error selection, use an approximate projected error `SSE ≈ geometricError × viewportHeight / (2 × distance × tan(verticalFOV/2))`. Distance should conservatively account for the tile bounds; a center-distance shortcut can under-refine a large tile near the camera. 3D Tiles likewise uses geometric error to determine runtime refinement. [3D Tiles geometric-error reference](https://raw.githubusercontent.com/CesiumGS/3d-tiles/main/3d-tiles-reference-card.pdf).

Proposed starting point: 64- or 128-cell patches, a 2–4 pixel quality target, and hysteresis. These are experiments, not standards. Re-evaluate at different display resolutions, high altitude, low flight, zoomed views, and mountain silhouettes. Preserve parent coverage until all required replacement patches are ready.

## Seams, transitions, and precision

Matching heights at shared world coordinates is necessary but insufficient when neighboring edges have different vertex counts. Use compatible nested sample grids, limit adjacent LOD differences, and stitch edge indices or implement the chosen algorithm's morph rules. Interpolate fine geometry toward its parent surface during transitions; derive shading normals from stable height samples or normal textures to prevent lighting pops. Parent filtering must preserve shared boundary samples.

Skirts remain useful as a secondary fallback at temporary streaming boundaries. They can hide a crack from some angles but can become visible cliffs near a coastline, fail when the height difference exceeds their depth, and cannot fix inconsistent collision surfaces or missing tiles. Stratos's fixed 95-meter skirt should therefore be tested at low grazing angles and replaced as the primary seam solution.

Retain global coordinates for terrain generation, world identity, and saves. Render in coordinates relative to a nearby origin. Preserve continuity when rebasing camera history, particles, trails, lights, decals, and physics bodies. Texture coordinates also need precision care: adding a very large global origin back inside a float shader can reintroduce precision problems. Use stable tile-local coordinates and bounded texture-phase offsets. Rebasing position alone does not repair depth-buffer precision; near/far plane selection remains a separate rendering concern.

## Streaming and worker design

Use `floor(globalCoordinate / tileSize)` for negative coordinates, not truncation toward zero. Integer tile indices and shared sample formulas make equal boundaries reproducible. Add independent seed streams for geography, foliage, and structures so adding a tree species does not relocate mountains. Do not reseed or normalize each tile independently.

The current worker already transfers `ArrayBuffer` ownership, which avoids copying its underlying buffers. The sender cannot continue using a transferred buffer; pools must respect that ownership change. [MDN transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects).

Upgrade each request to include tile ID, LOD, seed, generator version, and request generation. Maintain a priority queue based on current coverage, projected visibility, and flight direction. Discard stale results, cancel queued work, and stop obsolete processing at cooperative boundaries where practical. Define worker failure recovery and keep a coarse fallback instead of rendering a hole. Use byte/time caps for generation results, CPU caches, GPU residency, uploads, and collider creation. Count-based caps alone cannot control a frame containing two unusually expensive chunks.

Prefetch from velocity and measured latency: `lookaheadDistance = speed × (p95 dataReadyTime + safetyMargin)`. At the code's maximum 340 m/s, two seconds represent 680 meters; this is an arithmetic example, not a latency measurement. Predict a swept corridor and expand sideways for turns. Reprioritize regularly rather than only when crossing a chunk boundary. Keep nearby rear coverage for sudden reversals and retain a coarse distant horizon layer.

## Collision and Rapier integration

Maintain collision resolution independent of visual LOD. Otherwise changing camera quality could change impact behavior. The current continuous `heightAt` collision can disagree with a coarse triangle surface, causing apparently early impacts or visual penetration. Establish a common authoritative height grid and interpolation/triangle convention for close render patches and collision.

Rapier heightfields represent regular local X–Z terrain with Y heights and a scale vector; its API specifies column-major height storage. General heightfields cannot represent caves or overhangs, so bridges, tunnels, and rock arches need separate geometry/colliders. [Rapier Heightfield API](https://rapier.rs/javascript3d/classes/Heightfield.html), [Rapier collider guide](https://rapier.rs/docs/user_guides/javascript/colliders/).

Integration caution: confirm sample counts versus subdivision counts against the pinned package declarations and constructor behavior; do not infer the buffer length from an ambiguous example. Record row→Z and column→X mapping, axis direction, center/origin translation, height units, and scale exactly once in an adapter. Test a non-square asymmetric ramp with raycasts at known positions to catch transposes and flips. Do not include visual skirts in colliders.

Stream collision ahead of the aircraft and missiles, and retire it with a safety margin. Use swept shape queries for aircraft volume; rays can suit narrow projectiles. Rapier documents raycasting, shape casting, maximum travel/time parameters, and query filters. [Rapier scene queries](https://rapier.rs/docs/user_guides/javascript/scene_queries/). Fixed stepping and continuous collision detection need a separate physics design; a terrain collider alone does not prevent tunneling.

## Surface, ocean, and vegetation

Replace color-only terrain with a small material palette: rock, sand, soil, and vegetation, weighted by biome/slope/drainage masks. Combine macro variation visible from altitude with fine albedo, roughness, and normals visible near the ground. Triplanar projection reduces planar stretching on cliffs but adds texture fetches and requires correctly oriented normal blending. NVIDIA demonstrates the projection and tangent-basis issue; its geometry-shader generation pipeline is not directly portable to browser WebGL. [GPU Gems 3 procedural-terrain shading](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-1-generating-complex-procedural-terrains-using-gpu).

Use texture repetition breaking selectively. Texture bombing is a documented technique, but extra sampling and math have costs; compare it with simple macro color fields and authored masks before implementing a complicated shader. [GPU Gems texture bombing](https://developer.nvidia.com/gpugems/gpugems/part-iii-materials/chapter-20-texture-bombing).

For coastlines, keep terrain below sea level, blend wet sand and shallow-water coloration using signed shore distance or bathymetry, and add bounded shoreline foam. Use cheap normal-driven ocean detail first; avoid allocating expensive reflection work to every tile. Specify whether wave crests affect gameplay, because flat water collision and a moving wave surface otherwise disagree. These are proposed visual/gameplay choices.

Scatter by deterministic ecological masks and minimum spacing; exclude runways, roads, rivers, and settlements. Group vegetation into spatial cells with near meshes, distant impostors, and a ground-color approximation beyond their useful screen size. Three.js `InstancedMesh` reduces draw calls for shared geometry/materials and documents bounding-volume updates after transform changes. [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html). One enormous instance group can undermine culling; alpha overdraw and shadow passes still need measurement.

## Tool and data market comparison

| Option           | Appropriate use                                                                      | Tradeoff and licensing action                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Gaea             | Artist-directed island regions; export heights, masks, color/splat maps and tiles    | Verify the edition's required export capabilities and output rights; do not assume all editions support every workflow   |
| World Machine    | Graph-based terrain and high-precision tiled heightfields                            | Tiled workflow is documented for Professional; retain masks separately from height; verify the current purchased license |
| Houdini          | Terrain, erosion layers, roads/infrastructure and scatter in one procedural pipeline | More technical setup; check Apprentice/Indie/commercial restrictions before adopting production exports                  |
| USGS 3DEP        | Realistic elevation references or a US-based terrain                                 | Free, unrestricted 3DEP products; still inspect dataset metadata, projection, resolution and vertical datum              |
| 3D Tiles tooling | Streaming authored/geospatial meshes and urban content                               | Runtime licenses do not grant rights to imagery or hosted datasets; budget service/network costs separately              |

Gaea's official export documentation lists heightfields, masks, splat maps, meshes, point clouds, and tiled worlds. World Machine documents tiled naming/import/export and separate height versus color output, including higher-precision formats. Houdini documents the heightfield/mask workflow. No unverified prices are quoted. [Gaea export](https://docs.gaea.app/using/using-gaea/build-and-export/), [World Machine tiled workflow](https://help.world-machine.com/topic/world-machine-professional-edition-addendum/), [World Machine file output](https://help.world-machine.com/topic/device-fileoutput/), [SideFX heightfields](https://www.sidefx.com/docs/houdini/heightfields/index.html).

USGS explicitly says all 3DEP products are free and without use restrictions. Convert DEMs to local metric coordinates and a consistent vertical reference before tiling; do not assume photographic terrain or buildings come with bare-earth elevation. [USGS 3DEP](https://www.usgs.gov/3d-elevation-program).

NASA-AMMOS maintains a 3D Tiles renderer for Three.js under Apache-2.0. It is worth evaluating for streamed authored city/landmark assets, with collider generation kept as a separate responsibility. It is not an erosion generator. [3DTilesRendererJS repository](https://github.com/NASA-AMMOS/3DTilesRendererJS).

## Prioritized plan and acceptance gates

1. **Reliability:** instrument worker latency, installation time, CPU/GPU bytes, resident tiles, queue depth and cache churn. Add velocity prefetch, stale-request generations, time budgets, and coarse fallback coverage.
2. **Terrain identity:** author three regions; introduce hydrology, biome and infrastructure masks; export a canonical regional dataset with a stable version/seed manifest.
3. **LOD:** add nested grid levels, conservative bounds and error metadata, edge stitching and morphs. Preserve parent coverage during refinement and test opposite LOD combinations.
4. **Materials and ecology:** add rock/sand/soil/vegetation PBR blends, shoreline transitions, spatially culled instancing, and a measured shadow policy.
5. **Physics:** introduce the Rapier adapter only with asymmetric-grid tests, stable collider resolution, swept-volume checks and synchronized origin rebasing.
6. **Alternative renderer:** benchmark CDLOD or geometry clipmaps against the patch renderer using the same data, route, resolution and hardware before committing to a rewrite.

Validation should include negative coordinates, every shared edge and corner, deterministic regeneration, seed/version changes, low-altitude coastline passes, steep ravines, high-altitude views, a 180-degree reversal at maximum speed, teleport/respawn, worker failure, and a 30-minute out-and-back flight. Verify collision versus visible surface, no missing-parent gaps, no rebase trail jumps, bounded memory after warmup, and identical saved geography.

Provisional desktop acceptance targets are p95 frame time below 16.7 ms on a named reference machine and p95 terrain-install work below 2 ms, with a lower quality preset tested separately. These targets need calibration against the complete scene and measured GPU time. Record upload bytes and collider-build stalls, not just FPS: a visually convincing world must also stream consistently during combat.
