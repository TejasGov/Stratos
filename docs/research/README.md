# Stratos: world, effects, combat and terrain research

**Research date: October 5, 2026.** Three research subagents investigated world quality, smoke/fire, and terrain independently; the lead researched fighter-game competition and combat design, inspected the current project, and synthesized the results. The linked reports contain detailed reasoning and primary-source citations.

## Read the research

| Area                              | Detailed report                                               | Central recommendation                                                                                     |
| --------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| AAA-looking Three.js/Rapier world | [World quality](./world-quality.md)                           | Establish coherent lighting, geography and atmosphere; use Rapier for collision infrastructure             |
| Smoke and fire                    | [Effects production and rendering](./smoke-fire.md)           | Pooled instanced flipbooks, world-space ribbons, soft particles and screen-coverage budgets                |
| Fighter combat                    | [Competitive research and combat design](./fighter-combat.md) | Accessible flight, readable targeting, purposeful encounters and a small polished combat slice             |
| Terrain generation                | [Terrain architecture and tools](./terrain.md)                | Authored regional geography plus deterministic procedural expansion, stitched LOD and predictive streaming |

This is a technical and competitive desk-research study. It compares advertised product capabilities and documented techniques. It is not a statistically representative player survey, a revenue estimate, or a claim that Stratos can reproduce native AAA production scope. Performance budgets below are proposed experiments, not measured achievements.

## Decision

Build **a polished coastal combat region inside the existing explorable world**. The player should launch quickly, recognize a runway/port/mountain corridor, understand flight and targeting, encounter two to four enemies, and receive clear feedback from smoke, weapons and audio. Extend the world and mission variety from that benchmark.

The first work should improve the existing WebGL2 path. Three.js explicitly identifies migration work for custom GLSL materials, `onBeforeCompile` and postprocessing when moving to WebGPURenderer/TSL. Stratos uses these shader patterns today, so renderer replacement is a separate project with compatibility and testing costs. [Three.js migration guide](https://threejs.org/manual/pages/webgpurenderer).

## Market references and proposed differentiation

| Reference          | Relevant evidence                                                          | Proposed lesson                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ace Combat 8       | Publisher emphasizes arcade combat and dynamic layered skies               | Prioritize composition, aircraft silhouettes and spectacular but legible combat. [Official site](https://www.bandainamcoent.com/games/ace-combat-8)          |
| Project Wingman    | Developer presents accessible flight action and a replayable Conquest mode | Reusable encounter/progression structures can complement authored missions. [Developer listing](https://store.steampowered.com/app/895870/Project_Wingman/)  |
| Nuclear Option     | Developer describes a dynamic combined battlefield and component damage    | Use a bounded living battle and selective damage consequences. [Developer listing](https://store.steampowered.com/app/2168680/Nuclear_Option/)               |
| DCS Flaming Cliffs | Simplified controls coexist with professional flight models                | Choose input complexity and physics fidelity independently. [Eagle Dynamics](https://www.digitalcombatsimulator.com/en/products/planes/flaming_cliffs_2024/) |
| GeoFS              | Browser access, geographic scenery and simplified flight interface         | Browser launch convenience is established; memorable combat is Stratos's proposed focus. [Official site](https://www.geo-fs.com/)                            |

**Positioning hypothesis:** a browser-first cinematic combat sandbox can appeal through immediate access, short sorties and an attractive explorable world. These references do not prove unmet demand or willingness to pay. Validate the hypothesis through first-sortie completion, control comprehension, voluntary replay and interviews before choosing a monetization model.

## 1. AAA-looking world building

The most valuable visual upgrades are shared sun/sky/exposure parameters, an outdoor reflection environment, physically consistent materials, atmospheric depth, recognizable regional geography, convincing coastlines, and layered clouds. Add detail in the order the flight camera sees it: sky and silhouettes, broad land/water structure, midrange materials, then close props.

Use one directional sun with a measured nearby shadow policy; consider cascades only when low-altitude views justify them. Keep postprocessing restrained so targets and HUD remain readable. Group instanced buildings and vegetation spatially, use asset LODs, and track shared resource lifetimes. GPU texture memory is distinct from compressed download size. [Three.js color management](https://threejs.org/manual/pages/color-management.html), [shadows](https://threejs.org/manual/pages/shadows.html), [resource cleanup](https://threejs.org/manual/pages/cleanup.html).

Clouds need their own quality ladder: distant layers/impostors, convincing nearby billboards, then optional bounded volumetrics. Fast banks, flying inside clouds and temporal history artifacts are important validation cases. Guerrilla's cloud research is a high-end reference, but its console timings cannot be transferred to a browser. [Nubis, Evolved](https://www.guerrilla-games.com/read/nubis-evolved).

Rapier should initially cover local terrain/building colliders, moving proxies, scene queries and limited debris. Preserve the custom flight controller as the explicit source of aircraft handling. Synchronize floating-origin changes across physics, render transforms, interpolation history, projectiles and trails. Pin the physics version and test swept collision against thin obstacles and moving targets; current CCD behavior is version-sensitive. [Rapier scene queries](https://rapier.rs/docs/user_guides/javascript/scene_queries/), [current CCD guide](https://rapier.rs/docs/user_guides/javascript/rigid_body_ccd/).

## 2. Smoke and fire

Use a reusable effects manager with typed-array pools and instanced billboard quads. Author a few good flipbooks; interpolate frames, vary size/rotation/lifetime, and layer flash, flame, soot, dust and sparks. Alpha smoke and additive flame have different composition needs. Keep depth testing enabled, disable translucent depth writes, and use correctly reconstructed scene depth for soft intersections. [Three.js transparency](https://threejs.org/manual/pages/transparency.html), [NVIDIA soft particles](https://developer.download.nvidia.com/SDK/10/direct3d/Source/SoftParticles/doc/SoftParticles_hi.pdf).

Keep the hot nozzle effect attached to the aircraft; deposit contrails, missile trails and damage smoke into world space. Use ribbons for long continuous paths and distance-based sampling so fast motion does not leave gaps. Shared wind, buoyancy and turbulence help smoke look coherent. Cap catch-up emissions after hitches and explicitly handle origin rebasing.

Budget projected pixels as well as particles. Large overlapping smoke cards can dominate GPU cost. Add screen-size LOD and priority caps, then evaluate half-resolution smoke with depth-aware composition. Sorting or approximate order-independent transparency needs a representative overlapping-plume test. Full fluid simulation and GPU compute should follow measured need. [GPU Gems off-screen particles](https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-23-high-speed-screen-particles).

## 3. Fighter combat

The first loop should include assisted/direct input choices, a stable chase camera, target acquisition, a cannon, one guided missile, incoming warnings, one countermeasure, and enemy attack/extend/evade behavior. Weapons and targets should expose state clearly: selected, acquiring, locked, out of range, occluded, cooling down or damaged.

Keep tactical decisions separate from steering and aircraft movement. AI should issue bounded flight commands and obey terrain clearance and aircraft limits. Use seeded scenarios and staged activation for distant entities. Reynolds's action-selection/steering/locomotion hierarchy provides a useful primary design foundation. [Original steering research](https://www.red3d.com/cwr/steer/gdc99/).

Anchor intercept, escort and ground-strike activities to actual geography. Combine authored missions with bounded procedural encounters. Build health and a few readable damage states before elaborate component simulation. Keep multiplayer as a separate architecture decision after the single-player loop is validated. Add remapping, adjustable shake/HUD scale, captions and redundant warning cues from the start. [Accessibility guidelines](https://gameaccessibilityguidelines.com/full-list/).

## 4. Terrain generation

Create a regional generation graph: landmass/ridges, controlled noise, erosion/drainage, coast/infrastructure, biome/material/scatter masks. Bake expensive erosion for important regions; retain deterministic procedural expansion outside them. Regional context matters for connected rivers and tile boundaries. [Houdini erosion](https://www.sidefx.com/docs/houdini/nodes/sop/heightfield_erode), [Gaea tiled generation](https://docs.gaea.app/using/using-gaea/build-and-export/tiled-builds.html).

Improve the existing patch system before rewriting it: projected-error LOD, compatible sample grids, stitched edges, smooth morphing and parent coverage while detail loads. Skirts can cover temporary cracks but should not be the primary long-term seam strategy. Geometry clipmaps/CDLOD are alternatives to benchmark, each requiring a deliberate renderer architecture. [Geomipmapping paper](https://www.flipcode.com/archives/article_geomipmaps.pdf), [geometry clipmaps](https://hhoppe.com/proj/gpugcm/), [CDLOD reference](https://github.com/fstrugar/CDLOD).

Stream ahead using velocity and measured data-ready latency, retain sideways/rear coverage for turns, discard obsolete worker results and bound installation by time/bytes. Maintain common authoritative terrain data and interpolation rules for close rendering and collision. Heightfields need verified axis/storage conventions; overhangs and bridges need separate colliders. Negative coordinates, steep terrain and maximum-speed reversals are essential tests.

## Tool shortlist

| Need                       | Candidate                                                                                                                                                                     | Decision criterion                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Outdoor HDR/PBR kit        | [Poly Haven](https://polyhaven.com/license), [ambientCG](https://ambientcg.com/)                                                                                              | Small coherent CC0 set; verify scale, maps and delivery sizes                        |
| Runtime asset optimization | [glTF Transform](https://gltf-transform.dev/), [KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html)                                                                   | Reproducible exports, decoder setup, measured transfer and memory gains              |
| Particle runtime           | [three.quarks](https://github.com/Alchemist0823/three.quarks) or focused custom pool                                                                                          | Benchmark required features and maintenance; verify current renderer support         |
| Flipbook authoring         | [EmberGen](https://docs.jangafx.com/embergen/), [Houdini Labs](https://www.sidefx.com/docs/houdini/nodes/out/labs--flipbook_textures-1.0.html)                                | Output quality, relighting needs, appropriate commercial license                     |
| Authored terrain           | [Gaea](https://docs.gaea.app/using/using-gaea/build-and-export/), [World Machine](https://help.world-machine.com/topic/world-machine-professional-edition-addendum/), Houdini | Height/mask/tile export, contextual erosion, license eligibility and artist workflow |
| Geographic references      | [USGS 3DEP](https://www.usgs.gov/3d-elevation-program), [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS)                                                  | Data rights, coordinate/datum conversion, network cost and collider responsibilities |

No paid assets or software were purchased. Tool prices and edition features change; the detailed reports identify licensing checks rather than inventing a universal cost.

## Implementation priority and validation

| Priority | Deliverable                                                                   | Gate                                                                              |
| -------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| P0       | Benchmark routes, telemetry, quality controls; streaming/origin correctness   | Named devices, repeatable tail frame times, bounded memory and no missing terrain |
| P1       | One composed coastal region; outdoor lighting, PBR terrain and shoreline      | Recognizable geography and consistent materials from altitude and low passes      |
| P1       | Full attitude/control foundation, targeting, two weapons, two to four enemies | Understandable first combat encounter; swept collisions and AI recovery pass      |
| P1       | Pooled explosions, damage smoke and rebased world-space trails                | No terrain clipping, emission gaps, unbounded allocation or trail jumps           |
| P2       | Three mission templates, richer water/cloud layers, refined shadows           | Readable complete sortie under representative combat load                         |
| P3       | Renderer/volumetric/clipmap experiments; broader progression                  | Measured benefit justifies rewrite and ongoing maintenance                        |

Select actual integrated/discrete reference GPUs before adopting numeric targets. A starting desktop experiment is a 16.7 ms frame budget, with terrain installation under roughly 2 ms and effects around 1–2 ms GPU; these are allocations to revise against the full scene, not promises. Record median/p95 frame times, draw calls, uploaded bytes, active effects, queue latency and memory plateau. Keep a lower-quality fallback.

The benchmark suite should include a low coastline pass, high mountain view, maximum-speed reversal, overlapping explosions, camera-inside-smoke, moving projectile/target crossings, origin shift during combat, pause/focus loss, worker failure, controller disconnect and a long out-and-back flight. Product validation should separately measure first-sortie completion, explanation of missed shots, repeated ground crashes and voluntary replay.

The result to pursue is one attractive, understandable and repeatable combat sortie. That is the evidence needed to justify a larger world, heavier effects, more aircraft or a new renderer.
