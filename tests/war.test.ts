import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import {
  BOMB,
  CombatSystem,
  WAR_WAYPOINTS,
  WINGMAN_IDS,
  combatNeutral,
  type CombatPlayer,
} from "../src/combat/CombatSystem.ts";
import { MISSILES, launchMissile } from "../src/combat/Missiles.ts";
import { BLACKRIDGE_TARGETS, HAVEN, runwayThreshold } from "../src/world/bases.ts";

const flat = () => 0;
const flatWorld = { groundHeight: flat, blocked: () => false };
// Strike installations stand on the real terrain, so the sortie runs over it too.
const world = { blocked: () => false };
const player = (x = 0, y = 2500, z = 0, onGround = false): CombatPlayer => ({
  position: new Vector3(x, y, z),
  previous: new Vector3(x, y, z),
  velocity: new Vector3(0, 0, -200),
  quaternion: new Quaternion(),
  speed: 200,
  crashed: false,
  onGround,
  engines: [{ output: 0.8, failed: false }],
  boost: false,
  throttle: 0.8,
});
const run = (system: CombatSystem, p: CombatPlayer, seconds: number, input = combatNeutral, query: object = world) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    p.previous.copy(p.position);
    system.step(1 / 60, p, input, query);
  }
};
const clearAir = (system: CombatSystem) => {
  for (const e of system.enemies) if (e.kind === "air") e.active = false;
};
/** Puts the jet 120 m over (x, z) with SAM sites silenced, so only the mission logic runs. */
const hover = (system: CombatSystem, p: CombatPlayer, x: number, z: number) => {
  for (const e of system.enemies) if (e.role.startsWith("sam")) e.active = false;
  p.position.set(x, 120, z);
  p.previous.copy(p.position);
  p.velocity.set(0, 0, 0);
};

test("war: Viper flight joins after takeoff and every phase unlocks the next", () => {
  const start = runwayThreshold(HAVEN.runway);
  const p = player(start.x, start.elevation + 2, start.z, true);
  const system = new CombatSystem();
  system.start("war", p);
  assert.equal(system.wingmen.length, 2);
  assert.ok(system.wingmen.every((w) => !w.active), "wingmen wait for the leader");
  assert.equal(system.bombAmmo, BOMB.ammo.war);
  run(system, p, 2);
  assert.ok(system.wingmen.every((w) => !w.active));
  // Wheels up: Viper flight forms on the leader three seconds later.
  p.onGround = false;
  p.position.y = 600;
  run(system, p, 4);
  assert.ok(system.wingmen.every((w) => w.active && w.position.distanceTo(p.position) < 400));
  assert.equal(system.warPhase, 0);
  // Phase 1 → 2: the first wave is down once weapons are free.
  run(system, p, 4);
  clearAir(system);
  run(system, p, 0.2);
  assert.equal(system.warPhase, 1);
  assert.ok(system.warMarker);
  // A marker passed too high does not count; low ones do.
  p.position.set(WAR_WAYPOINTS[0].x, 900, WAR_WAYPOINTS[0].z);
  run(system, p, 0.2);
  assert.equal(system.waypoint, 0);
  for (const wp of WAR_WAYPOINTS) {
    hover(system, p, wp.x, wp.z);
    run(system, p, 0.2);
  }
  assert.equal(system.warPhase, 2);
  assert.equal(system.warMarker, null);
  // Phase 3: bombs released over each target destroy the installations.
  for (const t of BLACKRIDGE_TARGETS) {
    const target = system.enemies.find((e) => e.tag === t.id)!;
    (system as unknown as { selected: number }).selected = target.id;
    for (let drop = 0; drop < 2 && target.active; drop++) {
      hover(system, p, t.x, t.z);
      p.position.y = 300;
      run(system, p, 0.1, { ...combatNeutral, bomb: true });
      run(system, p, 9);
    }
    assert.equal(target.active, false, `${t.id} destroyed`);
  }
  assert.equal(system.warPhase, 3);
  // Phase 4: the counterattack comes from far north; clearing it wins the war.
  const wave = system.enemies.filter((e) => e.kind === "air" && e.active);
  assert.equal(wave.length, 4);
  assert.ok(wave.every((e) => e.position.z < -14000));
  clearAir(system);
  run(system, p, 0.2);
  assert.equal(system.completed, true);
  assert.match(system.status.result, /Blackridge destroyed/);
});

test("war: the guided bomb dives onto the pipper point, faster than free fall", () => {
  const p = player(0, 1000, 0);
  p.velocity.set(0, 0, -200);
  const system = new CombatSystem();
  system.start("war", p);
  const predicted = new Vector3();
  assert.ok(system.bombImpact(p, predicted, flatWorld));
  // Free fall from 1 km takes about 14 s; at 200 m/s with light drag that is about 2.6 km ahead.
  assert.ok(predicted.z < -2450 && predicted.z > -2900, `${predicted.z}`);
  run(system, p, 0.05, { ...combatNeutral, bomb: true }, flatWorld);
  const bomb = system.bombs.find((b) => b.active)!;
  p.velocity.set(0, 0, 0);
  // A powered dive: it gets there far sooner than free fall, never climbing on the way.
  let seconds = 0,
    climbed = false;
  for (; seconds < 20 && bomb.active; seconds += 1 / 60) {
    climbed ||= bomb.velocity.y > 0;
    system.step(1 / 60, p, combatNeutral, flatWorld);
  }
  assert.equal(bomb.active, false);
  assert.equal(climbed, false);
  assert.ok(seconds < 12, `${seconds} s`);
  // With no ground target selected it lands where the pipper showed at release.
  assert.ok(predicted.distanceTo(bomb.position) < 15, `${predicted.distanceTo(bomb.position)}`);
});

test("war: wingmen fight bandits and can be shot down", () => {
  const p = player(0, 3000, 0);
  const system = new CombatSystem();
  system.start("war", p);
  run(system, p, 4);
  const [viper] = system.wingmen;
  assert.ok(viper.active);
  // A released bandit 2 km ahead of Viper 2 draws its fire.
  const bandit = system.enemies.find((e) => e.kind === "air")!;
  bandit.releaseAt = 0;
  run(system, p, 4);
  bandit.position.copy(viper.position).add(new Vector3(0, 0, -1800));
  viper.quaternion.identity();
  viper.cooldown = 0;
  const before = system.missiles.filter((m) => m.active && m.owner === viper.id).length;
  run(system, p, 1);
  const shots = system.missiles.filter((m) => m.owner === viper.id).length;
  assert.ok(shots > before || system.tracers.some((t) => t.owner === viper.id), "Viper 2 engages");
  // A hostile missile aimed at Viper 3 can kill it.
  const viper3 = system.wingmen[1];
  viper3.health = 10;
  const from = viper3.position.clone().add(new Vector3(0, 0, 150));
  const missile = launchMissile(
    system.missiles[20],
    MISSILES.aam,
    from,
    viper3.position.clone().sub(from).normalize(),
    true,
    1,
    WINGMAN_IDS[1],
    600,
  );
  assert.ok(missile.active);
  run(system, p, 1);
  assert.equal(viper3.active, false);
  assert.equal(system.status.wingmen, 1);
});

test("mid-air collisions destroy both aircraft; a near miss does not", () => {
  // Player into a bandit: both go down and the sortie fails as a collision.
  let system = new CombatSystem();
  let p = player();
  system.start("intercept", p);
  const first = system.enemies.find((e) => e.kind === "air")!;
  first.position.copy(p.position).add(new Vector3(0, 1, -4));
  first.previous.copy(first.position);
  run(system, p, 1 / 60, combatNeutral, flatWorld);
  assert.equal(first.active, false);
  assert.equal(system.playerHealth, 0);
  assert.equal(system.midair, true);
  assert.ok(system.drainEvents().some((e) => e.type === "explosion"));

  // Two AI jets into each other, well away from the player.
  system = new CombatSystem();
  p = player();
  system.start("intercept", p);
  const [a, b] = system.enemies.filter((e) => e.kind === "air");
  a.position.set(3000, 2500, -3000);
  a.previous.copy(a.position);
  b.position.copy(a.position).add(new Vector3(3, 0, 0));
  b.previous.copy(b.position);
  run(system, p, 1 / 60, combatNeutral, flatWorld);
  assert.equal(a.active, false);
  assert.equal(b.active, false);
  assert.equal(system.playerHealth, 100);
  assert.equal(system.midair, false);

  // Forty metres apart is a pass, not a collision.
  system = new CombatSystem();
  p = player();
  system.start("intercept", p);
  const passing = system.enemies.find((e) => e.kind === "air")!;
  passing.position.copy(p.position).add(new Vector3(40, 0, 0));
  passing.previous.copy(passing.position);
  run(system, p, 1 / 60, combatNeutral, flatWorld);
  assert.equal(passing.active, true);
  assert.equal(system.playerHealth, 100);
});

test("war: in the bombing phase Viper flight bombs the SAM sites and targets", () => {
  // The player orbits high over the sea, out of the fight; only the wingmen strike.
  const p = player(0, 4000, 0);
  const system = new CombatSystem();
  system.start("war", p);
  run(system, p, 4);
  clearAir(system);
  (system as unknown as { warPhase: number }).warPhase = 2;
  const standing = () =>
    system.enemies.filter((e) => e.active && e.kind === "ground" && (e.role.startsWith("sam") || e.role === "target")).length;
  const before = standing();
  run(system, p, 90);
  assert.ok(system.wingBombs[0] < BOMB.ammo.wingman && system.wingBombs[1] < BOMB.ammo.wingman, `bombs ${system.wingBombs}`);
  assert.ok(standing() <= before - 2, `ground targets ${before} -> ${standing()}`);
});

test("war checkpoints: each phase saves progress and a fresh sortie resumes from it", () => {
  const p = player(0, 600, 0);
  const system = new CombatSystem();
  system.start("war", p);
  assert.equal(system.checkpoint, null);
  run(system, p, 8);
  clearAir(system);
  run(system, p, 0.2);
  assert.equal(system.checkpoint?.phase, 1);
  // Lose Viper 3 and a SAM site, spend a bomb, then finish the valley run.
  system.wingmen[1].active = false;
  system.bombAmmo--;
  for (const wp of WAR_WAYPOINTS) {
    hover(system, p, wp.x, wp.z);
    run(system, p, 0.2);
  }
  const checkpoint = system.checkpoint!;
  assert.equal(checkpoint.phase, 2);
  assert.deepEqual(checkpoint.wingmen, [true, false]);
  assert.equal(checkpoint.bombs, BOMB.ammo.war - 1);
  const sams = system.enemies.filter((e) => e.role.startsWith("sam")).map((e) => e.id);
  assert.ok(sams.length && sams.every((id) => checkpoint.destroyed.includes(id)));

  // Shot down; the retry starts a fresh sortie and resumes at the bombing phase.
  const q = player(checkpoint.x, 600, checkpoint.z);
  const retry = new CombatSystem();
  retry.start("war", q);
  retry.resumeWar(q, checkpoint);
  assert.equal(retry.warPhase, 2);
  assert.equal(retry.waypoint, WAR_WAYPOINTS.length);
  assert.equal(retry.bombAmmo, BOMB.ammo.war - 1);
  assert.equal(retry.weaponsFree, false, "a short grace after the resume");
  run(retry, q, 6.2);
  assert.ok(retry.weaponsFree);
  assert.equal(retry.warPhase, 2);
  assert.deepEqual(retry.wingmen.map((w) => w.active), [true, false]);
  assert.ok(retry.enemies.every((e) => !(e.kind === "air" && e.active)), "first wave already cleared");
  assert.ok(retry.enemies.filter((e) => sams.includes(e.id)).every((e) => !e.active));
  assert.ok(retry.enemies.some((e) => e.role === "target" && e.active));

  // A phase-3 checkpoint brings the counterattack straight back.
  const late = new CombatSystem();
  late.start("war", q);
  late.resumeWar(q, { ...checkpoint, phase: 3 });
  assert.equal(late.warPhase, 3);
  assert.equal(late.enemies.filter((e) => e.kind === "air" && e.active).length, 4);
});

test("war: a bomb on the selected target takes out SAMs within its blast", () => {
  const system = new CombatSystem();
  const p = player(0, 600, 0);
  system.start("war", p);
  const sam = system.enemies.find((e) => e.role.startsWith("sam"))!;
  const near = system.enemies.find((e) => e !== sam && e.kind === "ground" && e.position.distanceTo(sam.position) < BOMB.radius * 0.5);
  // Select the SAM, then release 800 m short of it and 500 m up.
  (system as unknown as { selected: number }).selected = sam.id;
  p.position.copy(sam.position).add(new Vector3(0, 500, 800));
  p.previous.copy(p.position);
  p.velocity.set(0, 0, -200);
  run(system, p, 0.05, { ...combatNeutral, bomb: true }, flatWorld);
  p.velocity.set(0, 0, 0);
  run(system, p, 10, combatNeutral, flatWorld);
  assert.equal(sam.active, false);
  if (near) assert.equal(near.active, false, "neighbour inside the blast");
});

test("war: after the radar, the target box moves to the next installation on its own", () => {
  const p = player(0, 600, -7000);
  const system = new CombatSystem();
  system.start("war", p);
  run(system, p, 8);
  clearAir(system);
  (system as unknown as { warPhase: number }).warPhase = 2;
  run(system, p, 0.1);
  assert.equal(system.target?.tag, "radar");
  assert.match(system.objective, /3 of 3 installations left/);
  system.enemies.find((e) => e.tag === "radar")!.active = false;
  run(system, p, 0.1);
  assert.ok(system.target && system.target.role === "target" && system.target.tag !== "radar", `selected ${system.target?.tag}`);
  assert.match(system.objective, /2 of 3 installations left/);
});
