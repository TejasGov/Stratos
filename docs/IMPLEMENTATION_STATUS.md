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

## Visual overhaul (October 16, 2026)

Five iterations replaced the outdoor renderer and much of the "Remaining limits" above. Each is on its own branch (`stratos/iteration-1-skyforge` → `stratos/iteration-5-haven-control`).

1. **Skyforge.** HDR frame graph with Hillaire-style atmosphere LUTs, volumetric clouds (GPU noise volumes, checkerboard temporal reconstruction), an analytic Bruneton-style ocean, cloud shadows, bloom, crepuscular rays, lens flare, eye adaptation and ACES. The procedural sky, cloud impostors and Fresnel ocean were removed.
2. **Ascent.** GPU CDLOD terrain from an 11-level clipmap with a GLSL port of the height function (matches the CPU to ~1e-4 m), geomorphing, curvature and heightfield shadows to a 650 km horizon; a new archipelago generator; a Mach-aware flight model; vapour cone, sonic boom, per-engine afterburner diamonds, ribbon contrails and vortices; a canvas conformal HUD; the Ascent challenge.
3. **Tempest.** Lightning, thunder and rain shafts; storm-aware title cinematic; a nine-aircraft hangar generated with Meshy (measured nozzles and wingtips, per-airframe performance, enemy roster).
4. **Darkroom.** Photo mode with full-resolution capture, dynamic resolution, ElevenLabs sound design with a master bus, and the fixes from a full-branch review — most importantly, collision now follows the drawn clipmap surface instead of the removed chunk meshes.
5. **Haven Control.** A voiced radio controller: 19 lines written for the game and performed with ElevenLabs v4 audio tags, each take checked with speech-to-text against its script, loudness-matched and played through a band-limited radio chain with squelch, ducking and subtitles. Calls are prioritised (missile and crash cut in, chatter queues) with per-line cooldowns, and a forward-looking ground-proximity alarm replaces a voiced pull-up call. Two scripted lines (a voiced pull-up and a storm advisory) were dropped when the ElevenLabs account ran out of credits.

**Validation.** Type-check, production build and 58 automated tests pass. Visual work was checked frame by frame in headless Chromium with SwiftShader (software WebGL 2), with read-back probes for terrain parity, cloud layers and exposure; the flight envelope (Mach 0.97 level near sea level, about 1.3 at 6 km, about 2.0 at 28 km, 30 km zoom climb in roughly 100 s) was verified in Node simulations. Frame rates on real GPUs were not measured in this environment; dynamic resolution and the three presets exist for that reason.

## Iteration 6: Theatre (October 17, 2026)

Branch `local/iter6-integration` merges the four parallel feature branches (`wip/iter6-bases`, `-flight`, `-airdefense`, `-effects`) onto the shared contracts in `src/world/bases.ts`, then adds soldiers and camera work.

- **Bases.** Haven (home) and Blackridge (enemy) are built from data in `src/world/baseLayout.ts`: runways with markings, edge/approach lights and PAPI, hangars, shelters, tower, fence, floodlights, and destroyable strike targets. Terrain is flattened identically in `terrain.ts` and `terrainGlsl.ts`, and structures are data-driven colliders. Fleet jets park on Haven's apron.
- **Flight.** Every sortie starts on Haven's runway: ground roll, rotation at Vr, wheel brakes, landing acceptance (under 5 m/s sink, under 15° bank). Airbrake (Z), engine master with a 3 s relight (I), Pugachev's cobra (M) scaled by `supermanoeuvre`, differential thrust on twins, and missile hits that fail one engine and then the other, with fire trails and HUD warnings.
- **Air defence.** Radar and IR SAM sites with search → track → launch → reload, radar range scaled by rcs^¼, terrain masking, low-level clutter and the Doppler notch; heat-seeking proportional-navigation missiles decoyed by flares; warning receiver and tones.
- **Effects.** Magnesium flare salvos, layered air and ground explosions with debris and a lingering smoke column, SAM launch plumes, engine fire.
- **Crowds.** `src/world/Crowds.ts` places 45 Mixamo characters (six characters, sixteen clips, one shared 65-bone rig): a PT drill, a jogging column, a walking squad, apron chatter and saluting ground crew at Haven; guards, a patrol and a huddle at Blackridge, who fall when a nearby target is destroyed. Mixers pause and crowds hide beyond 2 km.
- **Cameras.** Each sortie opens with a five-second shot over Haven's apron that settles behind the ground crew. The cobra camera now holds the flight path (an aliased `slerpQuaternions` call had made it follow the nose).
- **Radio.** The takeoff line and mission briefs play at wheels-up rather than at spawn.

**Validation.** Type-check, production build and 108 tests pass. In the browser (stepped frame by frame with `stratos.frame()` because the page was often in the background): a Su-30 cobra peaks at 110° AoA, bleeds 45% of its speed and recovers in about 2.3 s; one engine then both fail with fire trails and a glide; a high, afterburning Su-30 run into Blackridge is shot down without flares and survives five inbound missiles with them; the radar SAM tracks a Su-30 at 9 km but an F-22 only at 5.6 km; destroying the radar raises a ground explosion, swaps in the wreck and kills its guards. With the whole Haven crowd in view the soldiers add about 126 draw calls and 0.9 M triangles (shadows included).

**Follow-up (October 17).**
- **Audio.** An original theme song (ElevenLabs Music v2.5, custom lyrics) plays on the title screen. Five new Haven Control calls were added: cleared for takeoff, SAM launch, radar lock, engine fire and welcome home. Every take was checked with speech-to-text.
- **Afterburner.** Afterburner thrust now ramps in with airspeed (cubic up to 300 m/s). Top speeds are unchanged, but 105 → 300 m/s now takes about 5.5 s instead of 1.8 s; a regression test guards this.
- **Landing and takeoff tests.** A simulated pilot now lands every jet on Haven in both control modes. Haven sits in a valley, so the approach is steep over the ridge, followed by a shallow 2° final at idle. The takeoff test now covers all nine jets.
- **Crowds.** Each soldier gets a slight tint, only soldiers within 300 m cast shadows, and Haven cheers or stands alert when a sortie succeeds or fails.

**Not yet verified.** Performance at dusk on a real GPU with explosions and flares on screen, and physical gamepads. The landing is checked with a scripted pilot, not by hand. The cinematic trailer is not started.
