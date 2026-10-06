# World quality, Three.js and Rapier: research for Stratos

Research date and source access date: **5 October 2026**. This section distinguishes **evidence** (documented behavior or a publisher's stated feature) from **recommendation** (a proposed Stratos design). Living documentation generally has no publication date; those entries are marked undated in the source register. No market-share, audience-size, or unmeasured performance claims are inferred from attractive demos.

## Decision

**Recommendation:** Build a coherent aerial landscape around the existing WebGL2 renderer first: outdoor image-based lighting, atmospheric depth, believable terrain materials, geographically purposeful landmarks, convincing water, and scalable cloud layers. Keep the arcade flight model under explicit game control; add Rapier for collision queries, moving obstacles and bounded debris. Prototype WebGPU separately before committing the game to a renderer migration.

“AAA-looking” is a perceptual goal, not an engine feature. Stratos can pursue silhouette, lighting consistency, geographic scale and cinematic weather without matching a native game's asset volume or hardware requirements. The visual priority should follow the flight camera: the sky and terrain occupy much more of the image than individual ground props.

## Existing foundation: inspected project evidence

The current `package.json` uses Three.js `^0.186.1` and anime.js `^4.5.0`; Rapier is absent. `src/main.ts` already configures sRGB output, ACES tone mapping, a capped pixel ratio, PMREM environment lighting, shader precompilation and renderer statistics. `src/world/World.ts` already has worker-generated chunks, instanced scenery, a render-origin offset, moving sun shadows, fog, procedural water and clouds. `src/flight.ts` owns the arcade motion and samples swept terrain/obstacle collision.

The immediate gaps are qualitative: room-like environment lighting for an outdoor aircraft; vertex-colored terrain rather than a convincing material hierarchy; a simple water shader; visibly geometric clouds; isolated landmark props rather than a authored regional geography. Rapier adoption would add collision capabilities, not resolve those appearance gaps.

## Reference and market landscape

| Reference                  | Verified evidence                                                                                                                | Lesson for Stratos                                                                                | Comparison limit                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Ace Combat 8               | Publisher promotes dynamic multilayer clouds and arcade aerial action; official page lists an October 2, 2026 worldwide release. | Make sky composition and combat visibility central to the art direction.                          | Native PC/console production; its recommended PC specification lists 32 GB RAM and a discrete GPU, so it is not a browser budget. |
| Horizon / Nubis            | Guerrilla's 2015 cloud publication targeted 2 ms; the 2022 follow-up discusses flying through clouds and temporal artifacts.     | Separate distant sky appearance from expensive nearby cloud interaction; account for fast motion. | Reported console renderer results do not predict Three.js browser timing.                                                         |
| Bruno Simon's portfolio    | Creator identifies Three.js and TSL supporting WebGL/WebGPU for the interactive world.                                           | Coherent art direction and carefully composed interaction can make a browser world compelling.    | A portfolio is not evidence of fighter-scale streaming, many combatants or flight physics.                                        |
| Three.js official examples | Maintainers provide sky, ocean, shadows, volume and compute examples.                                                            | Use runnable isolated references to validate individual rendering techniques.                     | An isolated demo is not a production stack or a guaranteed combined frame rate.                                                   |

Sources: [Bandai Namco](https://www.bandainamcoent.com/games/ace-combat-8), [Guerrilla 2015](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn), [Guerrilla 2022](https://www.guerrilla-games.com/read/nubis-evolved), [Bruno Simon](https://bruno-simon.com/?lang=en), [Three.js examples](https://threejs.org/examples/).

**Inference:** The most useful competitive position is immediate browser access to visually attractive, readable free flight and combat. Matching console simulation breadth is a much larger product commitment. Validate this position with user sessions; the cited product pages establish features, not demand or willingness to pay.

## Art direction, lighting and materials

**Evidence:** Three.js performs lighting in Linear-sRGB; color textures and display output require appropriate color-space handling. Postprocessing requires an output conversion stage. PMREM prefilters an environment for roughness-dependent image-based lighting. [Color management](https://threejs.org/manual/pages/color-management.html), [PMREM](https://threejs.org/docs/pages/PMREMGenerator.html).

**Recommendation:** Establish one lighting reference before adding effects: a sun direction and angular appearance, sky hue, haze, water color, ground palette and outdoor HDR environment that agree. Replace `RoomEnvironment` with a matching outdoor environment or sky-derived PMREM. Keep PMREM relatively small and regenerate only when the lighting state changes materially. A decorative high-resolution sky background and the reflection environment can have different resolutions.

Audit custom water and terrain shaders for tone mapping and output conversion. Avoid correcting washed-out materials by multiplying arbitrary light intensities; first verify albedo/emissive textures use sRGB and normal/roughness/metalness data remain linear. Use the same exposure when comparing assets. Otherwise texture sourcing and lighting tuning become unstable.

Build three material scales: broad biome/color variation visible from altitude, midrange rock/soil/vegetation transitions, and local detail normal/roughness visible in low passes. Favor restrained roughness variation, normal detail and physically consistent metallic surfaces. Weathering should support scale: oversized grime or excessively strong normals make a fighter look like a toy.

Start postprocessing with antialiasing and consistent output; add restrained emissive bloom and optional color grading. Treat ambient occlusion as local grounding for buildings/cockpit details. Full-screen GI, depth of field and heavy motion blur should be optional experiments because the cockpit HUD, target recognition and horizon must remain clear. Keep UI outside world grading when it needs stable legibility.

## Shadows and atmospheric scale

**Evidence:** Each shadow-casting light requires additional scene rendering. Larger shadow-map coverage decreases spatial detail at a fixed resolution; increasing resolution costs computation and memory. [Three.js shadows](https://threejs.org/manual/pages/shadows.html).

**Recommendation:** Use one directional sun, a nearby shadow region, and conservative caster lists. Evaluate cascaded shadows for low-altitude flight, with a few near-biased cascades and a measured maximum distance; do not expect one giant shadow map to cover an archipelago crisply. Distant forests and mountains can rely more heavily on material shading, baked macro occlusion and atmospheric separation. Snap the moving shadow region to texel-scale increments to reduce crawling. Tune bias against both acne and detached shadows on runway passes.

Fog should express aerial perspective rather than hide every streaming limitation. Blend distant terrain toward the same horizon light used by the sky; consider altitude-dependent haze and weather. Use mountains, cloud gaps, coastline outlines and urban patches as composition anchors. Make mission-critical targets distinguishable against both haze and terrain through silhouette, value contrast and HUD cues.

**Recommendation:** Start cloud improvement with distant layered impostors plus nearby instanced billboards with convincing lighting. Upgrade high quality to a bounded, reduced-resolution volume pass after motion tests. Test climbing through the layer, rapid banking, rebasing, sun-facing silhouettes and temporal history rejection. Guerrilla identifies fly-through cloud cost and fast-motion temporal artifacts explicitly; its 2 ms historical console result is a reference, not a promised budget. [Nubis, Evolved](https://www.guerrilla-games.com/read/nubis-evolved).

For water, prioritize Fresnel response, sun glint, a credible sky reflection, animated normal detail, shoreline depth coloration and restrained foam. Use simple displaced waves near the player only if visible. Planar reflection redraws and full spectral oceans should compete against clouds for the quality budget, rather than becoming mandatory first steps. Official [Three.js ocean/water examples](https://threejs.org/examples/?q=water) provide prototypes to inspect.

## Asset sourcing and delivery

| Option                 | Evidence                                                                                                                  | Recommended use / cost                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Poly Haven             | HDRIs, PBR textures and models; its assets are CC0.                                                                       | Source a small consistent outdoor material kit; downscale and simplify before shipping. Artist/source selection remains work. |
| ambientCG              | Official site offers CC0 textures, HDRIs and models.                                                                      | Fill material gaps; normalize texture scale and conventions to match the rest of the kit.                                     |
| glTF Transform         | Meshopt compresses numeric geometry/animation data; documentation distinguishes compression from geometry simplification. | Produce reproducible optimized runtime artifacts and preserve masters. Encoding is an offline task.                           |
| Three.js KTX2Loader    | Transcodes Basis Universal KTX2 textures to supported GPU formats and requires renderer support detection.                | Reduce runtime texture pressure; own decoder deployment and loading failures.                                                 |
| Three.js InstancedMesh | Repeated geometry/material can share draw calls; bounds may need recomputation after transforms.                          | Trees, buildings, buoys and distant ships, grouped spatially to preserve culling.                                             |

Sources: [Poly Haven license](https://polyhaven.com/license), [ambientCG](https://ambientcg.com/), [glTF Transform Meshopt](https://gltf-transform.dev/modules/extensions/classes/EXTMeshoptCompression), [KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html), [InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html).

**Evidence:** Meshopt reduces transfer size, but decoding precedes GPU upload; compression alone does not improve frame rate. JPEG/PNG transfer size also does not represent decoded GPU texture memory. Three.js requires explicit disposal of geometry, materials and textures. [Meshopt](https://gltf-transform.dev/modules/extensions/classes/EXTMeshoptCompression), [cleanup](https://threejs.org/manual/pages/cleanup.html).

**Recommendation:** Give each asset a manifest containing bounds, LODs, material count, textures, collider description, byte size and provenance. Cache shared resources by identifier and reference count; removing a terrain chunk must not dispose a material still used elsewhere. Set bounded queues for fetch, decode, CPU generation and GPU upload. Cancel obsolete requests after sharp turns. Prefetch by velocity and mission destination, retain a small backward cache and use hysteresis so a bank does not thrash chunk residency.

Group repeated assets by chunk and material. One world-sized instance batch saves draw calls but produces poor coarse culling; thousands of tiny batches undo instancing gains. Validate batch bounds after origin shifts. Provide low-detail representations while high-detail assets stream and prevent a first encounter from triggering a large shader compile stall.

## Renderer choice and browser constraints

**Evidence:** Three.js describes `WebGPURenderer` as an experimental next-generation renderer with a WebGL2 fallback and TSL materials. Existing `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile` modifications and `EffectComposer` pipelines require migration. The guide continues to recommend `WebGLRenderer` for pure WebGL2 applications. MDN marks WebGPU availability as limited and requires a secure context. [Three.js migration guide](https://threejs.org/manual/pages/webgpurenderer), [MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API).

**Recommendation:** Keep the shipping path WebGL2 while building a single representative WebGPU/TSL scene: terrain shader, water, clouds, shadows and postprocessing together. Test native WebGPU and forced WebGL2 fallback, device loss and recovery, Windows integrated graphics, discrete GPUs and actual Safari/Firefox/Chrome targets. A renderer fallback does not make WebGPU-only compute features available on WebGL2.

Pin tested versions and make upgrades deliberate. Stratos currently modifies standard materials with `onBeforeCompile` and uses a `ShaderMaterial` ocean, so migration has real code cost. Abstract environment parameters and material creation first; do not dual-maintain two elaborate visual stacks without a demonstrated benefit.

**Proposed validation budget, not measured performance:** Target 16.7 ms total frame time for desktop 60 FPS, leaving headroom rather than assigning the whole budget to graphics. Track median and p95 CPU/GPU timings, upload stalls, draw calls, triangles, active chunks, memory estimates and visible texture quality. Sweep resolution scale before cutting world detail; full-screen effects and transparencies often need separate quality controls. Define reference hardware before declaring success. Recover from context/device loss and stop unnecessary work while hidden.

## Rapier: collision infrastructure, not aircraft aerodynamics

**Evidence:** Rapier simulates rigid-body forces/contacts and exposes dynamic, fixed and kinematic bodies. Scene queries include rays, swept shapes, intersections and filters. Heightfields are memory-efficient ground representations with restricted topology. [Rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/), [scene queries](https://rapier.rs/docs/user_guides/javascript/scene_queries/), [colliders](https://rapier.rs/docs/user_guides/javascript/colliders/).

**Recommendation:** Preserve custom flight integration and use an explicitly controlled collision representation for the player. Sweep a compact convex or capsule-like aircraft proxy over each fixed step; use extra wing probes or a compound proxy where gameplay needs them. A center-point altitude test misses wing strikes. Collision fidelity should match the game's forgiveness, not the GLB triangle count.

Use Rapier for local static heightfields, primitive buildings, moving ships/aircraft proxies, line-of-sight checks, blast overlap queries and short-lived dynamic debris. Keep cloud shapes, vegetation decoration and most distant props out of physics. Use simple convex dynamic proxies instead of visual triangle meshes; terrain overhangs and bridges require explicit colliders beyond a heightfield.

**Version-sensitive evidence:** Current JavaScript documentation identifies version 0.21. Its CCD page says fast dynamic bodies are automatically swept against fixed/soft bodies; enabling body CCD adds moving dynamic/kinematic sweeps. It also documents remaining limitations for two CCD-enabled moving objects. Older Rapier advice may describe different behavior. [Current CCD documentation](https://rapier.rs/docs/user_guides/javascript/rigid_body_ccd/).

**Recommendation:** Pin the chosen Rapier version, inspect its declarations and test thin bridge, crossing aircraft and fast missile cases. For custom motion, explicit sweeps are essential: enabling CCD is not a blanket substitute. Bound fixed-step catch-up after tab suspension. Update collision/query acceleration structures through the pinned API before querying newly inserted or repositioned colliders; do not query a stale world after streaming or rebasing.

Stream collision independently from visual LOD, with a safety radius based on speed and measured generation latency. Keep detailed colliders near participants and mission encounters. Global logical coordinates should remain stable; render and Rapier positions should share a nearby local frame. Rebase at a fixed-step boundary and translate every local participant consistently, including previous/interpolated transforms, collider bodies, camera histories, particle anchors and query origins. Preserve velocities and global chunk keys. Use rebase regression tests for collisions and long-lived trails.

## Prioritized implementation proposals

| Priority / proposed module                                  | Scope                                                                               | Acceptance evidence                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| P0 `render/EnvironmentController.ts`                        | Shared sun/sky/haze/exposure, outdoor PMREM, shader color audit.                    | Aircraft and terrain remain consistent across three lighting presets.          |
| P0 `render/PerformanceBudget.ts`                            | CPU/GPU telemetry, resolution/quality controls, deterministic benchmark routes.     | Repeatable p95 results and no unexplained streaming spikes on named hardware.  |
| P1 `world/RegionDirector.ts`                                | Biome palette, coastline/urban/airfield composition, authored landmark seeds.       | Recognizable regions from altitude and useful landmarks during combat.         |
| P1 `assets/AssetRegistry.ts`, `world/StreamingScheduler.ts` | LOD manifests, KTX2, shared lifetime, bounded upload queues and predictive loading. | Memory plateaus on a long flight; turns do not create empty foreground chunks. |
| P1 `physics/CollisionWorld.ts`                              | Rapier initialization, nearby proxies, filtered sweeps and origin protocol.         | Thin obstacle, wing strike, moving target and rebase tests pass.               |
| P2 `render/Ocean.ts`, `render/CloudLayers.ts`               | Better reflectance/shoreline and layered clouds with independent quality tiers.     | Low passes and fast banks remain readable; measured effect cost fits budget.   |
| P3 renderer experiment                                      | TSL materials and combined WebGPU scene; compare fallback behavior.                 | Demonstrated quality or timing gain justifies migration and maintenance.       |

Avoid buying or generating a large prop library before these gates: additional assets cannot fix inconsistent lighting, repetitious geography or streaming stalls. One polished coastal sortie with a runway, port, mountain corridor and two weather presets is the most useful first quality benchmark.

## Source register

All sources accessed **2026-10-05**. Living pages are undated unless a visible publication date is listed. Source facts are paraphrased; proposed modules and budgets are author recommendations.

1. [Three.js color management](https://threejs.org/manual/pages/color-management.html) — undated living manual.
2. [Three.js PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html) — undated API reference.
3. [Three.js shadows](https://threejs.org/manual/pages/shadows.html) — undated living manual.
4. [Three.js examples](https://threejs.org/examples/) — undated maintained example collection; includes water/sky.
5. [Guerrilla, Real-Time Volumetric Cloudscapes](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn) — 2015-05-13.
6. [Guerrilla, Nubis, Evolved](https://www.guerrilla-games.com/read/nubis-evolved) — 2022-08-05.
7. [Bandai Namco, Ace Combat 8 official page](https://www.bandainamcoent.com/games/ace-combat-8) — undated product page; linked release news dated 2026-09-29 / release 2026-10-02.
8. [Bruno Simon portfolio / creator's stack description](https://bruno-simon.com/?lang=en) — undated.
9. [Poly Haven asset license](https://polyhaven.com/license) — undated.
10. [ambientCG official catalog](https://ambientcg.com/) — undated.
11. [glTF Transform Meshopt documentation](https://gltf-transform.dev/modules/extensions/classes/EXTMeshoptCompression) — undated.
12. [Three.js KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html) — undated.
13. [Three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html) — undated.
14. [Three.js cleanup](https://threejs.org/manual/pages/cleanup.html) — undated.
15. [Three.js WebGPURenderer guide](https://threejs.org/manual/pages/webgpurenderer) — undated living guide.
16. [MDN WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) — living API reference; publication date not used.
17. [Rapier rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/) — undated, JavaScript guide identifies 0.21.
18. [Rapier scene queries](https://rapier.rs/docs/user_guides/javascript/scene_queries/) — undated, JavaScript guide identifies 0.21.
19. [Rapier colliders](https://rapier.rs/docs/user_guides/javascript/colliders/) — undated, JavaScript guide identifies 0.21.
20. [Rapier CCD](https://rapier.rs/docs/user_guides/javascript/rigid_body_ccd/) — undated; behavior must be checked against installed version.
