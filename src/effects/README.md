# Effects integration

`Effects` owns two instanced billboard batches, each with a local deterministic 4×4 procedural flipbook: sorted alpha smoke and additive fire/sparks. It creates no network requests or canvas dependency. Pools allocate 900 smoke and 420 flame records once; quality controls emission density and visible instance caps (low 160/100, medium 480/240, high 900/420). Saturated pools reject emissions. Call `dispose()` when destroying the game.

```ts
const effects = new Effects(scene, "medium");
// During running simulation, once per fixed step or frame with game-clock delta:
effects.updateJet(flight.position, flight.quaternion, flight.boost, gameDt);
effects.updateMissile(missile.id, missile.position, gameDt);
effects.emitDamageSmoke(aircraft.id, aircraft.position, gameDt, damageFraction);
effects.emitExplosion(hit.globalPosition, 1.5);
// After camera movement, before rendering; zero gameDt while paused:
camera.updateMatrixWorld();
effects.update(gameDt, camera, world.origin);
```

All position arguments are **global world coordinates**. CPU anchors stay in double precision; upload converts every surviving particle to the current render origin. Do not rebase `group`, emitters, or particles manually. `dt` must follow the game clock, not wall time. `update()` advances particle age once; avoid calling it with a full frame delta after separately advancing particles. If emission follows fixed steps and rendering follows frames, particles can advance by the total game delta once per rendered frame. `update(0)` still uploads and sorts while paused.

The jet faces local -Z and its nozzle offset is local `(0, 0.1, 8)` meters, matching Stratos's normalized aircraft. Ordinary exhaust is blue; boost exhaust is warm. Contrails default to altitude >2200 meters, with an explicit final boolean argument for the game's eventual weather rules. Two wing trails use distance sampling; they are stretched billboards, **not continuous ribbon geometry**. Missile trails currently use circular distance-sampled puffs. Trail samplers preserve fractional travel, cap hitch catch-up, and break segments at 2000-meter teleports. Stationary damage sources retain a time-based minimum emission. Call `stopEmitter(id)` when an aircraft/missile is removed; emitter maps are bounded at 32 damage and 64 missile sources.

`clear()`/`reset()` removes particles and sampling history, so use it on sortie restart/menu return. `stats` exposes active smoke, active flame, and uploaded visible instance counts. `setQuality()` accepts `low`, `medium`, `high`.

Optional `setSoftDepth(depthTexture, perspectiveCamera, framebufferWidth, framebufferHeight, fadeMeters=6)` enables depth intersection fading. The caller must render **opaque geometry only** to that depth texture before drawing effects, keep near/far and framebuffer dimensions current, and disable it with `null` if the depth pass is unavailable. The hook supports ordinary perspective WebGL depth only; logarithmic and reversed depth need different reconstruction. Baseline integration leaves this disabled: normal depth testing and near-camera alpha fading mitigate intersections but do not produce soft terrain contacts.

Limitations: the procedural atlas provides changing silhouettes rather than fluid simulation; smoke tint has a fixed approximate daylight color rather than full relighting. No heat distortion, bloom, impact lights, fluid volumes, OIT, reduced-resolution compositing, ground dust/skirt, or debris physics. Sorting is per batch, not across other transparent scene objects. Stretched trail cards can become narrower when viewed end-on. Wind is constant plus buoyancy. Pool bounds are verified; CPU/GPU timing and overlapping-impact visual quality still need representative runtime benchmarks.
