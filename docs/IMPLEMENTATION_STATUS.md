# Stratos research implementation

Implemented October 5, 2026 using **two subagents at a time in two waves**, with parent integration, controls, HUD, audio, telemetry and validation.

## Wave one: world quality and effects

- Matching outdoor procedural sky, sun and PMREM environment; Fresnel ocean with sun glint and distance-limited wave detail.
- Quality-scaled cloud impostors and terrain slope/shore material detail.
- Rapier 0.21.0 async collision/query bubble, static heightfield tiles and authored obstacle proxies; swept aircraft volume and origin updates.
- Pooled instanced smoke/fire, procedural padded/interpolated flipbooks, layered explosions and sparks, damage smoke, distance-sampled exhaust/contrails/missile trails.
- Origin-relative particle uploads, sorted smoke, fixed game-clock emission, pause-safe aging and bounded capacities.
- High-quality opaque depth prepass for soft particles; balanced/performance presets avoid the extra render.

## Wave two: combat and terrain

- Full quaternion loops/rolls and speed-dependent player control authority with assisted neutral handling.
- Intercept, escort and ground-strike mission templates; target cycling, timed acquisition, range/cone/occlusion/cooldown explanations.
- Cannon, finite-rate missiles, relative-motion swept hits, centralized damage, health, countermeasures, warnings and bounded event/projectile pools.
- Enemy approach/attack/extend/evade/recovery steering; origin-aware visuals sharing the fighter model; procedural radar, missiles and tracers.
- Authored regional mountain/drainage/coast/infrastructure shaping and shared geographic masks.
- Velocity-based loading priorities, request tokens, retained old LOD coverage, bounded upload work, worker timeout/restart and coarse coverage.
- Shared coarse boundary polylines for mixed LOD seams; near-rendered triangle surface query for collision and clearance.

## Integration

Menu launches all three sorties; keyboard B enters/leaves a patrol while exploring. Combat HUD shows selected target, lock reason/progress, ammo, flares, hull and threat; navigation includes hostile contacts. Combat keys are remappable, with quick taps buffered across simulation steps. Standard gamepad controls feed the same actions. Settings include reduced camera shake and HUD text scale. Procedural sound cues reinforce visual feedback.

The debug readout records rolling median/p95 frame intervals, draw calls, triangles, terrain queue/install work, effects, local collider counts and origin. Frame intervals are not GPU timings. Numeric budgets from research remain targets until tested on named hardware.

## Validation

Production build passed and all 35 automated tests passed. Tests cover flight stability, collision sweeps and rebasing, bounded effects, rapid input taps, combat guidance and damage, mission lifecycle, mixed terrain LOD boundaries, and streaming request accounting.

Production-browser checks verified aircraft loading, all three sortie launches, target cycling, cannon ammunition, countermeasures, missile acquisition/launch/cooldown, incoming warnings, pause/retry/menu transitions, keyboard remapping and persistence, and high-quality particle depth rendering. No browser errors were recorded. Escort and strike completion were not manually played through; gamepad input was tested with simulated controls rather than physical hardware. Cross-browser/mobile testing and sustained performance measurements on named hardware remain outstanding.

## Deliberate limits

This is a practical first implementation of the research priorities. Cloud volumetrics, GPU-compute effects, erosion simulation, CDLOD/clipmap rewrites, geomorphing, continuous trail ribbons, advanced postprocessing and multiplayer remain later upgrades. Terrain uses procedural standard-material shading rather than a downloaded PBR texture library. Player flight is arcade; enemy steering is finite-rate but does not run the same aircraft model. The Rapier bubble is sampled/coarse and remains backed by analytical close terrain collision. Physics meshes do not model every decorative prop or dynamic fragmentation.

The rigid fighter has no cockpit interior, animated surfaces or landing gear. Flight starts airborne. The Rapier compat package includes a large WASM payload; dynamic import separates it from the main bundle but does not remove download/decode cost. No claim of AAA parity or a universal 60 FPS result is made.
