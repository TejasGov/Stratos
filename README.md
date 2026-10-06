# Stratos

A single-player open-world flight game built with Three.js, anime.js, TypeScript, and Vite. Fly a textured stealth fighter across a procedural archipelago, discover landmarks, and try checkpoint and low-altitude challenges.

## Run locally

Requires Node.js 22.12 or newer.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. The game requires WebGL 2 and is designed for desktop keyboard controls.

```sh
npm test          # Simulation, collision, terrain, and challenge tests
npm run build    # Type-check and create the production build in dist/
npm run preview  # Serve the production build locally
```

## Controls

| Key | Action |
| --- | --- |
| W / S or Up / Down | Pitch up / down |
| A / D or Left / Right | Bank left / right |
| Q / E | Rudder left / right |
| Shift / Ctrl | Increase / decrease thrust |
| Space | Afterburner |
| C | Switch chase / forward camera |
| R | Restart flight or challenge |
| Escape | Pause / resume |

Choose free flight or a challenge from the flight deck. Settings include graphics quality, pitch inversion, sensitivity, audio, and a performance readout. Preferences, discovered landmarks, challenge records, and a safe flight location are saved in this browser.

## Implementation

- Fixed-step arcade flight with interpolated rendering and swept terrain collision.
- Seeded terrain generated in a Web Worker, streamed with multiple detail levels and a floating origin.
- Ocean, sky, clouds, instanced scenery, an airfield, a bridge, and five discoverable landmarks.
- Two ordered checkpoint challenges, including a low-altitude route with altitude penalties.
- Anime.js menus, notifications, and camera transitions sharing the Three.js render loop.
- Synthesized engine and wind audio, a navigation map, telemetry, pause, crash, and restart flows.

The runtime aircraft is included at `public/assets/aircraft/stealth-fighter.glb`: 11,316 triangles, one material, embedded 2K PBR maps, and approximately 5.93 MiB. It is a rigid model with retracted gear and no cockpit interior or animated control surfaces. Flight starts airborne. Small procedural scenery is decorative; collisions cover terrain, sea level, the bridge deck, and airfield hangars.

The design and implementation sequence is documented in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Local Meshy generation files, dependency directories, and build output are excluded from Git; the runtime jet asset is included.

## Validation

Nine automated tests cover frame-rate independence, 30 simulated minutes of continuous flight, control response, deterministic terrain and shared borders, swept collisions, and challenge progression, scoring, and timeout. The production build passes. Browser smoke checks verified aircraft loading, free flight, streamed terrain, pause/resume, settings, checkpoint progression, and camera switching. Cross-browser and extended GPU-memory benchmarks remain to be completed.
