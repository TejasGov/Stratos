# Paused mid-task: four `wip/iter6-*` branches

Four features were being built in parallel, each in its own worktree branched from `c3582a0`. They were stopped
mid-task and committed as-is. **None was reviewed or verified in the browser yet.** Each one typechecks; test status is noted below.

```bash
git fetch origin 'refs/heads/wip/*:refs/remotes/origin/wip/*'
git diff --stat c3582a0 origin/wip/iter6-<name>
```

| Branch | Commit | Size | Tests | Where it stopped |
| --- | --- | --- | --- | --- |
| `wip/iter6-bases` | `40f6bf1` | 14 files, +2507 | 61 pass / **1 fail** | Building the Airbase module and verifying screenshots |
| `wip/iter6-flight` | `ff0c871` | 8 files, +1102 | 74 pass | Rewriting the per-nozzle flame sections in `Supersonic.ts` |
| `wip/iter6-effects` | `b3ddd63` | 8 files, +3064 | 79 pass | Refining explosion debris ("noisy rock" chunks) |
| `wip/iter6-airdefense` | `a68b167` | 11 files, +2577 | 77 pass | About to start browser verification of HUD and SAMs |

## Per branch

### bases: `src/world/Airbase.ts`, `src/world/airbase/{build,lights,textures,MeshBuilder}.ts`, `baseLayout.ts`, `basePads.ts`
- **Has:** new Airbase module, flattening of the terrain for Blackridge (TS and GLSL), runway textures, markings and lights, data-driven structure colliders (touches `sweptCollision` in `src/flight.ts` and `src/physics/CollisionWorld.ts`).
- **Failing test:** `tests/terrain-streaming.test.ts` "authored region retains runway level…" expects 28 m but gets 28.75. Either the Haven flatten level changed or the test needs the new runway elevation of 29 from `bases.ts`. Pick one and make them consistent.
- **Still to check:** `setParkedAircraft(models)`, `destroy(targetId)` and `reset()` APIs and their wiring in `main.ts`; map markers for both bases; draw-call count; floating-origin shift for both bases; dusk/night screenshots.

### flight: `src/flight.ts`, `src/input/FlightInput.ts`, `src/effects/Supersonic.ts`, `src/main.ts`, `src/ui.ts`, `src/ui/Hud.ts`
- **Has:** runway start and ground handling, airbrake (Z), engine master (I), cobra (M), differential thrust, engine failure, HUD indicators, tests in `tests/flight-dynamics.test.ts`.
- **Stopped mid-edit** in `Supersonic.ts`, which renders one flame per nozzle driven by `flight.engines[i]`. Check this compiles **and renders**; flames were not yet seen in the browser.
- `tests/sim-scratch.ts` is a scratch file that was committed by accident. Delete it.
- **Still to check:** `main.start()` puts every sortie on Haven's runway; low ground-roll chase camera; flight-path-following camera during the cobra; landing acceptance; `effects.emitEngineFire` calls; the missile hit → `flight.damageEngine()` hook in `processCombatEvents`.

### effects: `src/effects/{Effects,particle-core,batch,sprites}.ts`, `src/audio.ts` (flares() and explosion layers), `src/main.ts`
- **Has:** realistic flare salvos (ejection, drag, sparks, smoke arcs), layered explosions (flash, fireball, smoke, shockwave, debris; ground variant with dust and a lingering column), SAM launch plume, engine fire and smoke, flare and explosion synthesis, tests in `tests/effects-pyro.test.ts`.
- **Still to check:** capture each effect at t ≈ 0.05/0.3/1/3/8 s by day and at dusk and judge it; particle budgets per quality level; no clipping in audio; the flare event in `main.ts` uses `effects.emitFlares(...)`.

### airdefense: `src/combat/{AirDefense,DefenseModels,Missiles}.ts`, `CombatSystem.ts`, `CombatView.ts`, `src/ui/Hud.ts`, `src/audio.ts`, `src/main.ts`
- **Has:** SAM network (radar detection scaled by rcs^¼, terrain line of sight, low-altitude clutter, doppler notch and cobra), IR shorad, heat-seeking proportional-navigation missiles with flare decoys, restructured spawning (enemies from the north once the player is airborne; escort departs after takeoff; strike targets the Blackridge radar), warning-receiver HUD, warning tones, GLB loader with procedural fallback. Tests in `tests/air-defense.test.ts`.
- **Still to check:** browser verification (it stopped at the page-load step; the harness needs a longer navigation timeout under load); balance (a stealth jet low in the valleys gets through; a high, afterburning MiG-21 does not); map range rings; that the `weapon: "missile"` field on hit events matches the flight branch's `damageEngine` hook.

## Merge plan (recommended order)

Merge into `stratos/iteration-6-theatre`, run `npx tsc --noEmit -p .`, `npm test` and `npm run build` after each step, then play it.

1. **bases**: mostly new files. It conflicts with flight only in `sweptCollision` (`src/flight.ts`): keep the bases agent's data-driven colliders and the flight agent's runway exemption.
2. **flight**: `src/main.ts`, `src/ui/Hud.ts`, `src/flight.ts`.
3. **airdefense**: overlaps flight in `src/main.ts` (start, `processCombatEvents`) and `src/ui/Hud.ts`, and effects in `src/audio.ts` (separate methods, so it should be easy).
4. **effects**: overlaps in `src/main.ts` (the flare event) and `src/audio.ts`.

Overlap map: `src/main.ts` (flight, effects, airdefense), `src/flight.ts` (bases, flight), `src/audio.ts` (effects, airdefense), `src/ui/Hud.ts` (flight, airdefense).

Once merged, check these by playing:
- Takeoff from Haven in all nine jets.
- A cobra in the Su-30, and in the MiG-21 (which should only manage a shallow pitch-up).
- A flare salvo at dusk.
- A strike run on Blackridge: SAM launch, flares beat the missile, the radar is destroyed (ground explosion).
- One engine lost, then the second.
- Landing back at Haven.
