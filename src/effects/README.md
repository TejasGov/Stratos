# Effects integration

`Effects` owns two instanced billboard batches that share one vertex pipeline and each carry a small procedural 4×4 atlas (64 px cells, generated in `sprites.ts` — no DOM, network or asset licence):

- **smoke batch** (alpha blended, 2400 records): cauliflower puffs with a baked height field, so every billow is lit by the real sun/moon direction and an ambient estimate (`setLighting`). A particle can be *hot*: its emission follows a black-body ramp (white-yellow → orange → deep red → nothing) that cools with age, so one sprite is a fireball that turns into soot. Edges dissolve by noise erosion.
- **fire batch** (additive, 1400 records): glows, 4-point glare, sparks, shock rings and turbulent flame blobs. Values are HDR (>1) so the sky bloom catches them.

Both batches take their per-particle physics from the `Particle` record: `drag`, `gravity`, `lift`, `wind`, `spin`, eased growth, `attack`/`decay` fades, `erode`, `flicker`, `heat`/`cool`, flipbook `frame`/`frames`, `mode` (1 = flat on the ground plane) and velocity-aligned `stretch`. Pools are fixed; exhausted pools reject new particles (explosions may use all of a pool, trails and fire sites stop at 85–90 %). Quality (`setQuality`) scales emission density (×0.55 / ×1 / ×1.35) and caps the uploaded instances (650+420 / 1500+900 / 2400+1400); the closest instances win under pressure. Only the live prefix of each GPU buffer is uploaded.

```ts
const effects = new Effects(scene, "medium");
effects.groundHeight = (x, z) => terrainHeight(x, z); // optional: debris lands on the terrain
// Once per frame, game clock (0 while paused), after the camera matrix is current:
effects.setLighting(sky.lightDirection, sun.color, sun.intensity);
effects.update(gameDt, camera, world.origin);

effects.emitExplosion(pos, scale, "air" | "ground"); // scale 0.3 missile burst … 1 jet … 3-6 fuel depot
effects.emitFlares(jetPos, jetVelocity, jetForward, jetUp?, count = 6);
effects.emitLaunch(launcherPos, direction);
effects.emitEngineFire(nozzlePos, jetVelocity, intensity01, dt); // every frame per failed engine
effects.updateMissile(id, pos, dt); // trail + motor flame; stopEmitter(id) on removal
effects.emitDamageSmoke(id, pos, dt, severity);
```

All position arguments are **global world coordinates**. CPU anchors stay in double precision; upload converts every surviving particle to the current render origin. Do not rebase `group` or particles manually. `dt` must follow the game clock, not wall time. `update(0)` still uploads and sorts while paused and spawns nothing.

## What each effect is made of

| Effect | Composition (medium quality) |
| --- | --- |
| Flares | 2–8 cartridges (default 6) in left/right pairs at 0.1 s from the rear fuselage, 25–35 m/s down/out on top of the jet velocity; quadratic+linear drag, gravity; 3.1–4 s burn. Per cartridge: one-frame HDR core, halo and glare each frame (violent flicker), a smoke puff per ~3 m, ~40 sparks/s, ~8 embers/s. ≈ 60–110 live particles per cartridge, ≤ 24 cartridges. Up to two `PointLight`s light the jet at dusk and night. |
| Explosion | HDR flash + glare + scatter halo, pressure sphere, billboard shock ring, 13–20 lit fireball billows, 7–11 additive core blobs, 20–40 stretched sparks, 11–17 soot puffs living 9–17 s, at scale ≥ 0.8 tumbling hot debris (each trailing smoke), 1–4 delayed secondary pops. `ground` adds a flat shock ring, a dust ring, a dirt column, clods and a burning site (smoke column + small fires, 16–36 s). |
| Launch | ignition flash, backblast fire, ground dust ring and pillar, a ~50 m dense boost-smoke plume, a short light flash. |
| Missile | boost-phase white trail then a thinner sustain trail, plus a stretched motor flame and glare each step. |
| Engine fire | stateless: a stretched flame tongue and a nozzle glare each call, plus dark smoke puffs drawn Poisson-like over `dt` and jittered back along the flight path. |

`clear()`/`reset()` removes particles, source lists, lights and sampling history (sortie restart/menu). `stats` exposes `{ smoke, flame, rendered }`; `sources` exposes live cartridges, debris, burning sites, pending pops and missile emitters.

Optional `setSoftDepth(depthTexture, perspectiveCamera, framebufferWidth, framebufferHeight, fadeMeters=6)` enables depth intersection fading (ordinary perspective WebGL depth only).

Limitations: sprites are procedural flipbooks, not fluid simulation; smoke is lit by one directional light and a flat ambient (no shadowing from the world or clouds, no aerial perspective on distant plumes). Fire is additive and drawn after all alpha smoke, so a glow behind a thick smoke sheet still shows through. Debris and clods only collide when `groundHeight` is supplied. The two scene point lights are always present at intensity 0 so lit materials never recompile.
