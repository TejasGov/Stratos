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

Production build passed and all 47 automated tests passed. Tests cover flight stability, collision sweeps and rebasing, bounded effects, rapid input taps, combat guidance and damage, mission lifecycle, mixed terrain LOD boundaries, and streaming request accounting.

Production-browser checks verified aircraft loading, all three sortie launches, target cycling, cannon ammunition, countermeasures, missile acquisition/launch/cooldown, incoming warnings, pause/retry/menu transitions, keyboard remapping and persistence, and high-quality particle depth rendering. No browser errors were recorded. Escort and strike completion were not manually played through; gamepad input was tested with simulated controls rather than physical hardware. Cross-browser/mobile testing and sustained performance measurements on named hardware remain outstanding.

## Poly Haven and accessibility update

The terrain now uses nine verified local Poly Haven CC0 1K maps for grass, rocks and sand (5.06 MiB download), with color/normal/packed AO-roughness data, world-space mapping, triplanar cliffs, rotated anti-tiling samples and distance-limited normal detail. [Asset provenance and checksums](../public/assets/polyhaven/manifest.json) record the original source files. Aircraft materials retain the generated jet's embedded PBR maps.

Easy flight is now the default: A/D directly turns, releasing the controls levels the aircraft, and pitch stays bounded. Optional Advanced mode retains aerobatics. Mouse steering and left/right-click weapons are available. Combat starts with target follow enabled; manual steering takes control and G or the HUD button restores follow. Following also adjusts thrust to reduce overshooting. Target follow samples terrain ahead but is not a collision-proof autopilot.

Missile acquisition now takes 0.55s within a 40-degree cone, and taps queue for 0.9s. Cannon assistance predicts movement within a 10-degree/1800m window, still requiring line of sight and real swept-projectile hits. A HUD lead point, slower centered opening opponent and less aggressive enemies make first engagements approachable.

Browser validation completed an entire intercept with three kills using target follow and weapons, without manual steering; two kills were from the cannon and right-click launched a missile. The current terrain shader rendered without errors after fixing a vertex-color type mismatch. Automated tests additionally verify easy steering, recovery, bounded follow, acquisition buffering, aim-assist limits/occlusion, real first kills and asset integrity. Desktop browser checks do not replace physical-controller or broad device testing.

## Remaining limits

This is a practical first implementation of the research priorities. Cloud volumetrics, GPU-compute effects, erosion simulation, CDLOD/clipmap rewrites, geomorphing, continuous trail ribbons, advanced postprocessing and multiplayer remain later upgrades. Player flight is arcade; enemy steering is finite-rate but does not run the same aircraft model. The Rapier bubble is sampled/coarse and remains backed by analytical close terrain collision. Physics meshes do not model every decorative prop or dynamic fragmentation.

The rigid fighter has no cockpit interior, animated surfaces or landing gear. Flight starts airborne. The Rapier compat package includes a large WASM payload; dynamic import separates it from the main bundle but does not remove download/decode cost. No claim of AAA parity or a universal 60 FPS result is made.
