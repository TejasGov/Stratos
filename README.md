# Stratos

A single-player open-world flight and combat game built with Three.js, anime.js, Rapier, TypeScript, and Vite. Fly a textured stealth fighter across Haven, discover landmarks, complete races, and fly intercept, escort, and ground-strike sorties.

## Run locally

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. The game requires WebGL 2 and supports desktop keyboard controls and standard-mapping gamepads.

```sh
npm test          # Simulation, collision, terrain, and challenge tests
npm run build    # Type-check and create the production build in dist/
npm run preview  # Serve the production build locally
```

## Controls

| Key                   | Action                                               |
| --------------------- | ---------------------------------------------------- |
| W / S or Up / Down    | Pitch up / down                                      |
| A / D or Left / Right | Bank left / right                                    |
| Q / E                 | Rudder left / right                                  |
| Shift / Ctrl          | Increase / decrease thrust                           |
| Space                 | Afterburner                                          |
| C                     | Switch chase / forward camera                        |
| R                     | Restart flight or challenge                          |
| Escape                | Pause / resume                                       |
| B                     | Start / leave an intercept patrol during free flight |
| F (hold)              | Cannon                                               |
| X                     | Guided missile, when locked                          |
| T                     | Cycle targets                                        |
| V                     | Countermeasure                                       |

Choose free flight, a race, or one of three combat sorties from the flight deck. Combat keys are remappable in Settings. Standard gamepad: left stick flies, right-stick X controls rudder, triggers change thrust, A fires the cannon, B launches a missile, X deploys countermeasures, Y cycles targets, and LB boosts. Keyboard B starts a patrol; gamepad B is a weapon action. Gamepad support is tested with synthetic standard mappings; individual devices/HOTAS require hardware verification.

Settings include graphics/effects quality, pitch inversion, sensitivity, audio, camera shake, HUD text scale, bindings, and a performance readout. Preferences, discovered landmarks, race records, and a safe flight location are saved in this browser. Combat sortie state is reset on restart and is not persisted.

## Implementation

- Fixed-step quaternion arcade flight with full loops/rolls, assisted neutral handling, interpolated rendering and swept collision.
- A local Rapier heightfield/obstacle bubble with aircraft-volume queries and synchronized rebasing; analytical near-surface/sea collision remains a safety fallback.
- Seeded worker terrain with an authored Haven mountain/drainage corridor, coastal shelf, infrastructure/biome masks, multiple detail levels and a floating origin.
- Velocity-aware request priorities, stale response tokens, bounded installation queues, retained previous LOD coverage, and coarse fallback with worker recovery.
- Outdoor sky/PMREM, matching sun, Fresnel ocean, quality-scaled cloud impostors, terrain material detail, instanced scenery, an airfield, a bridge, and five landmarks.
- Two ordered checkpoint challenges, including a low-altitude route with altitude penalties.
- Intercept, escort and radar-strike missions; bounded enemy AI, cannon/missile pools, moving-target sweeps, lock/range/occlusion feedback, health, flares and threat warnings.
- Two pooled instanced smoke/fire batches, procedural interpolated flipbooks, damage smoke, explosions, and distance-sampled world-space trails. High quality adds an opaque depth prepass for soft intersections.
- Anime.js menus, notifications, and camera transitions sharing the Three.js render loop.
- Synthesized engine/wind and combat cues, radar contacts and selected-target markers, median/p95 frame-interval telemetry, pause, crash, and restart flows.

The runtime aircraft is included at `public/assets/aircraft/stealth-fighter.glb`: 11,316 triangles, one material, embedded 2K PBR maps, and approximately 5.93 MiB. It is a rigid model with retracted gear and no cockpit interior or animated control surfaces. Flight starts airborne. Enemy fighters reuse the model resources. Small procedural scenery is decorative; large collision proxies cover terrain, sea level, the bridge and airfield hangars.

The initial plan is preserved in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The [research](docs/research/README.md) and [implementation status](docs/IMPLEMENTATION_STATUS.md) document the subsequent two-agent waves and remaining upgrades. Local Meshy generation files, dependencies, and build output are excluded from Git; the runtime jet asset is included.

## Validation

Automated tests cover frame-rate independence, 30 simulated minutes, loops/rolls, mixed-LOD seams, deterministic geography, near-surface interpolation, stale request recovery, Rapier rebasing/heightfield axes, targeting, projectile collisions and kills, countermeasures, mission outcomes, bounded effects, input buffering and gamepad mappings. Run `npm test` for current results. The production build also runs TypeScript checks.

Browser validation and remaining limits are recorded in [implementation status](docs/IMPLEMENTATION_STATUS.md). Terrain transitions constrain edges to a common coarse polyline rather than geomorphing; drainage is authored shaping rather than simulated erosion. Clouds and trails use impostors/particles rather than volumetric clouds or continuous ribbons. Enemy flight uses bounded steering, not the full player flight model. Rapier's compat WASM bundle is loaded as a separate sizeable chunk. Cross-browser, device-specific controls, extended GPU-memory and named-hardware performance benchmarks remain outstanding.
