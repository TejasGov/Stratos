# Combat slice

`CombatSystem` is renderer-independent and runs on the game's fixed clock. `CombatView` presents aircraft/radar/missile/tracer objects relative to the floating origin. No external assets or additional dependencies are required; the actual normalized player GLTF can be reused with `setAircraftTemplate(model)`.

```ts
const combat = new CombatSystem();
const view = new CombatView(scene);
combat.start("intercept", flight); // also "escort" or "strike"
combat.step(
  1 / 60,
  flight,
  { gun, missile, target, flare },
  {
    groundHeight: (x, z) => Math.max(0, renderedHeightAt(x, z)),
    blocked: (from, to) => worldQueryBlocked(from, to),
  },
);
for (const event of combat.drainEvents()) {
  /* FX, audio, HUD */
}
view.update(combat, world.origin);
```

The optional query accepts **global coordinates**, excludes combat entities/shooter, and returns whether static opaque world geometry blocks a segment. Default queries sample conservative terrain + sea; supply Rapier/static-building queries for geometry beyond terrain. Lock requires target selection, 5000m range, a 40° forward cone, line of sight, and 0.55s acquisition. `status.lockReason` explains unavailable shots. Cannon is held; missile taps queue for 0.9s and launch once when acquisition finishes. Target-cycle and flare are rising-edge actions. State resets on a new sortie, including held-action latches and ammunition. Cannon prediction assists within 10° and 1800m, with line-of-sight checks and actual swept projectiles; it does not grant instant damage.

Mission templates:

- Intercept: three approaching hostile aircraft, cleared when all are destroyed.
- Escort: transport starts 400m ahead and flies 5400m to a safe corridor; transport destruction fails the mission. Enemies split their attack focus between player and transport.
- Strike: destroy a radar at the nearest named region landmark, with two airborne guards. Guard destruction is optional.

Each mission has a four-minute limit. Player loss fails it. Success/failure freezes combat and clears projectiles until reset/stop/new start. `active` retains the mission ID for outcome presentation, with `completed` or `failed` exposing the result. Player health is separate from `Flight.crashed`; parent sets crash state/presentation on zero combat health. Difficulty/weapon values are fictional game tuning, not real aircraft specifications.

Enemy state progression uses patrol/approach/attack/extend/evade/recover, finite angular turn rates and damped velocity. Terrain lookahead/recovery supersedes attack, with a conservative minimum altitude fallback for invalid terrain placements. Enemy aircraft use bounded quaternion steering rather than the player's full `Flight` instance: this is an arcade AI approximation, not equivalent aerodynamics or a comprehensive stall/formation system.

There are 16 missile records and 96 tracer records, allocated once and carrying stable pooled IDs. Entity arrays are at most four hostile targets and one ally. Filter `active` when processing missiles/tracers/enemies. Call `effects.stopEmitter(id)` when missiles disappear; reused pool IDs need a fresh trail sampler after removal. `drainEvents()` consumes at most 128 queued events; consume once each fixed step to preserve feedback during bursts. All events own cloned global positions.

Event semantics: `gun.player`/`missile.player` mean the player fired, `hit.player` means the player took damage; entity IDs identify the damaged target/shooter as appropriate. Missile event IDs identify the missile pool record, explosion IDs identify the destroyed entity or impacting missile. Explosion and hit events derive from authoritative damage, not visual contacts. `complete`/`failed` carry the player outcome flag.

Cannon and missiles test relative swept motion against moving aircraft, with shooter/faction exclusion. Missile guidance has finite speed, finite 1.7rad/s turn rate, and ten-second lifetime; lost/dead targets leave projectiles coasting. Flares provide an explicit forgiving arcade window: nearby (1400m) hostile player-seeking missiles lose guidance and deflect downward, while already distant weapons continue tracking. No friendly fire, rearming, component physics, radar simulation, multiplayer, terrain-destructive decals, or progression economy is included.

`Flight` defaults to Easy controls with direct heading changes, bounded pitch and automatic leveling. Optional `controlMode="advanced"` integrates quaternion angular rates for unrestricted loops and rolls. `getAimDirection(player,out,query)` supplies a world-space pursuit cue, and `getGunAimPoint(player,out,query)` supplies the global predictive HUD lead point. Parent integration toggles target follow, cancels it on manual steering, and samples terrain ahead while following. Collision samples the near terrain's authoritative rendered triangle surface.

Acceptance tests cover moving-object crossings, loops/rolls, lock range/cone/occlusion, missile turn/speed/ammo bounds, actual guided hits, countermeasure latching, cannon kills/events, terrain recovery, mission outcomes, bounded pools, fixed-step consistency and view rebasing/template transforms. Browser visual quality, practical enemy difficulty and weapon balance still require playtests.
