# AirGame implementation plan

Prepared September 30, 2026 as the original implementation plan. The application and subsequent combat/world upgrades are now implemented; see [current implementation status](docs/IMPLEMENTATION_STATUS.md) for delivered features, validation and remaining work.

## Game direction and initial scope

Build a single-player browser flight game in which the player freely explores a procedural archipelago using the existing stealth fighter. Combine realistic aircraft materials with a cinematic, colorful world: mountainous islands, coastlines, towns, bridges, an airfield, and recognizable landmarks. Anime.js is the animation library; it does not imply an anime art style.

Assumptions: desktop keyboard controls first, an accessible arcade flight model, a chase camera, and optional exploration challenges. Target a continuous open world with no loading screens during flight. Begin airborne because the current aircraft has retracted gear. Walking, multiplayer, combat, and a detailed cockpit are later expansions. The first finished release includes free flight, discoverable landmarks, checkpoint challenges, crash/restart, sound, settings, and saved progress.

## Stack and responsibilities

Use Vite and TypeScript with `three`, `animejs`, and a seeded noise library. Pin compatible stable versions and commit the lockfile when scaffolding. Use native DOM/CSS for the menu and HUD; introduce a UI framework only if later interface complexity warrants it.

- **Three.js:** scene, aircraft import, terrain, ocean, lighting, shadows, particles, cameras, and rendering. Start with `WebGLRenderer`, which requires WebGL 2; show a useful compatibility screen if unavailable. [Renderer documentation](https://threejs.org/docs/pages/WebGLRenderer.html).
- **Anime.js:** loading and menu transitions, mission banners, waypoint pulses, camera-mode blends through dedicated blend parameters, and crash/respawn fades. Use `animate()` and `createTimeline()`. [Timeline documentation](https://animejs.com/documentation/timeline/).
- **Flight simulation:** fixed-step position, velocity, attitude, and control integration. Animation timelines must not write directly to simulation-owned aircraft state.
- **World streaming:** deterministic worker-generated terrain and spatially grouped scenery; GPU uploads and resource ownership stay on the main thread.

Own one frame loop with `renderer.setAnimationLoop()`. Disable Anime.js's default loop and call `engine.update()` from it, following its documented Three.js integration. Physics receives a separate fixed-step clock. Simulation can pause while menu animation continues. [Anime.js engine integration](https://animejs.com/documentation/engine/engine-methods/update/).

## Reuse the existing aircraft

Source: `meshy_output/20260930_232125_stealth-fighter_01a0f579/stealth-fighter-browser.glb`.

Verified source characteristics: 11,316 triangles; one mesh and one material; embedded 2K PBR maps; 5.93 MiB. It is a rigid model with an opaque canopy and no separately movable flight surfaces. Meshy generation already cost 35 credits; the planned game does not require another paid generation.

At scaffold time, copy it to `public/assets/aircraft/stealth-fighter.glb` while preserving the original. Load it once using `GLTFLoader`, which imports glTF into Three.js. [Loader documentation](https://threejs.org/docs/pages/GLTFLoader.html).

Put the loaded model inside an aircraft visual wrapper. Inspect it from several angles in the actual renderer, then set a fixed local rotation and scale to match the game convention (Y up, local -Z forward). Use a fictional 16-meter length as a starting art scale; the generated mesh is not calibrated to real aircraft dimensions. Keep those corrections separate from the simulation quaternion. Add a lightweight collision shape, exhaust attachment, and camera anchors to the wrapper. Verify PBR lighting and normals before building scenery around it.

## Flight, controls, camera, and collisions

Maintain `FlightState`: global position in meters, velocity in meters/second, orientation quaternion, angular velocity, throttle, and flight status. Run simulation at 60 Hz with an accumulator and interpolated rendering. Clamp long frame gaps, cap catch-up steps, and clear stale input when the window loses focus.

Begin with thrust, gravity, speed-dependent drag, tunable lift, roll/pitch/yaw response, and angular damping. Add banked turning and a gentle stall response with explicit recovery assistance. Tune for enjoyable control instead of claiming aircraft-accurate aerodynamics. Keep inputs and tuning in configuration so keyboard, mouse, and gamepad can share the same control interface.

Initial bindings: W/S pitch, A/D roll, Q/E yaw, Shift/Ctrl increase/decrease throttle, Space afterburner, C camera mode, R restart, Escape pause. Offer invert-pitch and sensitivity settings. Display these before first flight; suppress browser defaults only while gameplay owns focus.

Start with a spring-damped chase camera, modest bank following, adjustable distance, and speed-driven FOV. Add a forward/nose camera after the chase camera passes usability checks. A true cockpit requires a separate interior asset. Camera collision sampling prevents mountain clipping. Test steep turns and rapid altitude changes for jitter.

Use terrain height sampling as the first collision layer. Sweep a small aircraft capsule or a set of fuselage/wing sample points from previous to current position so fast flight cannot pass through terrain. Check sea level and nearby landmark bounds. A crash stops the flight state, displays a short fade, and respawns at a safe altitude. Collision height queries must not depend on a visible chunk already being loaded.

## Continuous world

Use a fixed world seed and integer chunk coordinates. Start with 1 km terrain chunks, a 5-by-5 nearby chunk set, and a separate coarse distant terrain ring. Adjust these starting values after measuring high-speed flight and high-altitude visibility. Use hierarchical LOD rings for the horizon rather than extending detailed terrain everywhere.

Generate terrain from consistent world-space height functions: ocean basins, island masks, mountains, valleys, and coastlines. Use matching border samples and edge skirts/stitching to hide LOD cracks. Terrain generation runs in a Web Worker and returns typed arrays. Create GPU resources incrementally with a per-frame upload budget.

Prioritize chunks ahead of the aircraft using velocity and a look-ahead horizon. Deduplicate requests, discard stale results after teleport/respawn, and impose a hard cap on resident chunks. Keep coarse terrain visible until detailed replacements are ready. Unload chunks behind the aircraft with hysteresis; dispose owned geometries and materials without disposing shared textures.

Use a floating origin: retain logical global coordinates, but subtract a nearby origin before sending transforms to Three.js. Shift the origin by whole chunk increments when the aircraft travels roughly 2 km from it. Apply the same shift to cameras, particles, lights, scenery, and collision visuals. Keep landmark IDs, terrain sampling, navigation, and saves in global coordinates.

Add a simplified shaded ocean, sky gradient, sun, atmosphere/fog, and inexpensive distant clouds. Place towns, forest patches, bridges, and airfield structures using deterministic rules and authored landmarks. Group repeated scenery into per-chunk `InstancedMesh` objects, allowing whole chunks to be culled and unloaded. Instancing reduces draw calls for repeated geometry/material combinations. [InstancedMesh documentation](https://threejs.org/docs/pages/InstancedMesh.html).

The MVP can stream outward indefinitely with recognizable authored locations near the starting region. Revisit the same chunk with the same seed and get the same terrain and landmarks. No network backend is needed for this single-player procedural world.

## Game systems and presentation

The HUD shows speed, altitude above sea and terrain, heading, throttle, artificial horizon, and selected waypoint distance. Generate a lightweight navigation map from the same world seed and known landmark data. Keep flight telemetry authoritative in simulation; update text at a bounded rate and visual instruments without creating a new anime.js timeline every frame.

Add three small objective types: ordered checkpoint races, low-altitude routes, and landmark discovery. Implement them as data-driven definitions with explicit start/active/completed states. Start with one of each near the airfield. HUD markers use projected global positions and clearly distinguish behind-camera waypoints.

Use Anime.js timelines for introduction, mission activation/completion, objective banners, and respawn. Cancel stale timelines on state changes and honor reduced-motion preferences. Keep camera transitions attached to blend weights or offsets that compose with the chase-camera calculation.

Initialize audio on the player's Start gesture. Mix engine pitch/volume from throttle and speed, wind, and optional brief alerts. Placeholder sound can be synthesized locally; additional purchased/generated assets require a separate decision. Save versioned settings, world seed, discovered landmarks, challenge results, and a safe spawn position to local storage. Resume in a safe airborne state rather than restoring a potentially invalid collision state.

## Proposed project structure

```text
public/assets/aircraft/stealth-fighter.glb
src/main.ts
src/game/Game.ts                 lifecycle and frame loop
src/game/GameState.ts            loading/menu/flight/pause/crash
src/input/InputManager.ts
src/flight/FlightModel.ts
src/flight/FlightConfig.ts
src/aircraft/Aircraft.ts
src/camera/CameraRig.ts
src/world/WorldManager.ts
src/world/TerrainGenerator.ts
src/world/Terrain.worker.ts
src/world/Chunk.ts
src/world/FloatingOrigin.ts
src/world/Scenery.ts
src/world/Environment.ts
src/collision/CollisionSystem.ts
src/missions/MissionManager.ts
src/ui/Hud.ts
src/ui/Menu.ts
src/ui/Transitions.ts
src/audio/AudioManager.ts
src/storage/SaveManager.ts
src/debug/PerformanceOverlay.ts
```

Keep the architecture small and explicit. Introduce additional modules only when their responsibility exists.

## Implementation order and completion gates

| Milestone                  | Work                                                                                                                     | Completion gate                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Aircraft on screen      | Scaffold Vite/TypeScript; import jet; correct orientation/scale; sky/light/test terrain; loading screen; error handling. | Jet renders in browser with correct textures and orientation; resize and asset failures handled; production build passes.                                                                        |
| 2. Playable flight         | Fixed-step flight, keyboard controls, chase camera, telemetry, pause, swept terrain collision, crash/restart.            | Player can fly freely for 10 minutes; pitch/roll/yaw and throttle are responsive; no NaNs, camera jitter, stuck keys, or terrain tunneling; restarting works.                                    |
| 3. Open world              | Seeded terrain workers, chunk queues, LOD rings, floating origin, ocean, scenery, landmarks, navigation.                 | Continuous flight crosses at least 50 chunk boundaries and multiple origin shifts without loading screens or world gaps; returning restores the same terrain; resident resources remain bounded. |
| 4. Complete game loop      | Discovery and two flight challenges; anime.js menus/banners/transitions; audio; settings; saved progress.                | Starting, completing, failing, retrying, pausing, reloading, and resuming all work; free flight remains available.                                                                               |
| 5. Performance and release | Profile; adjust LOD/resolution/scenery; browser compatibility; accessibility; asset caching; release build.              | Meets the agreed reference-device budget, passes cross-browser smoke tests, and survives a 30-minute traversal without steadily increasing memory or resource counts.                            |

Build milestone 2 before expanding world complexity: flight feel determines the camera, speeds, view distance, and terrain streaming requirements.

## Performance targets and validation

These are initial budgets, not measured guarantees. Record an actual reference laptop and browser during implementation.

- Aim for a 60 FPS medium preset at a 1920-by-1080 render resolution on the reference desktop; provide a lower-resolution 30 FPS preset for weaker hardware.
- Use a pixel-ratio cap and adjustable render scale, bounded shadow distance, one sun shadow map, and optional post-processing.
- Start with fewer than roughly 150 draw calls and 500,000 visible triangles in the medium preset; measure all passes and adjust from profiling.
- A 5.93 MiB compressed GLB still expands on the GPU. Three uncompressed 2K RGBA textures with mipmaps are roughly 64 MiB; file-size optimization does not replace GPU memory budgeting.
- Bound chunk caches and particle pools; prioritize flight and rendering over background generation and uploads.

Add meaningful automated tests for fixed-step behavior across render rates, deterministic chunk borders, origin-shift invariance, swept collision, and mission state transitions. Use browser smoke tests for start/flight/pause/restart/save/load and screenshots for jet orientation, HUD, and terrain seams. Monitor frame-time percentiles and Three.js renderer statistics during rapid low-level flight, high-altitude flight, respawn, and extended streaming. Test current Chrome, Firefox, and Edge first; include Safari where test hardware is available. Test focus loss, resize, slow asset loading, and WebGL context loss.

## Decisions deliberately deferred

Mobile controls and device-specific optimization, realistic takeoff/landing, transparent/separate canopy, movable surfaces, cockpit interior, combat, multiplayer, and volumetric clouds can follow a stable exploration release. New generated aircraft assets are optional. The existing aircraft is sufficient for the first flight game.
