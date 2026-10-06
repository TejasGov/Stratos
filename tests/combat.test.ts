import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3, Group } from "three";
import { Flight, neutral } from "../src/flight.ts";
import {
  CombatSystem,
  combatNeutral,
  sweptMovingHit,
  type CombatPlayer,
} from "../src/combat/CombatSystem.ts";
import { CombatView } from "../src/combat/CombatView.ts";

const emptyWorld = { groundHeight: () => 0, blocked: () => false };
const player = (): CombatPlayer => ({
  position: new Vector3(0, 5000, 0),
  previous: new Vector3(0, 5000, 0),
  velocity: new Vector3(),
  quaternion: new Quaternion(),
  speed: 155,
  crashed: false,
});
const aimAt = (p: CombatPlayer, position: Vector3) =>
  p.quaternion.setFromUnitVectors(
    new Vector3(0, 0, -1),
    position.clone().sub(p.position).normalize(),
  );

test("relative-motion sweep catches crossing objects missed by frozen endpoints", () => {
  const a = new Vector3(-100, 0, 0),
    b = new Vector3(100, 0, 0);
  const c = new Vector3(0, 0, -100),
    d = new Vector3(0, 0, 100);
  assert.equal(sweptMovingHit(a, b, c, d, 3), true);
  assert.equal(sweptMovingHit(a, b, d, d, 3), false);
  assert.equal(
    sweptMovingHit(a, b, c.clone().setY(10), d.clone().setY(10), 3),
    false,
  );
});
test("flight quaternion completes inverted loops and unrestricted rolls", () => {
  const f = new Flight();
  f.position.y = 12000;
  f.previous.copy(f.position);
  let inverted = false,
    forwardAgain = false;
  for (let i = 0; i < 800; i++) {
    f.step(1 / 60, { ...neutral, pitch: 1, throttle: 1, boost: true });
    const up = new Vector3(0, 1, 0).applyQuaternion(f.quaternion);
    const forward = new Vector3(0, 0, -1).applyQuaternion(f.quaternion);
    if (up.y < -0.9) inverted = true;
    if (inverted && up.y > 0.9 && forward.z < -0.9) forwardAgain = true;
    assert.ok(Math.abs(f.quaternion.length() - 1) < 1e-10);
  }
  assert.ok(inverted);
  assert.ok(forwardAgain);
  assert.equal(f.crashed, false);
  f.reset();
  f.position.y = 12000;
  for (let i = 0; i < 130; i++) f.step(1 / 60, { ...neutral, roll: 1 });
  assert.ok(new Vector3(0, 1, 0).applyQuaternion(f.quaternion).y < -0.8);
});
test("lock requires alignment, range and line of sight; unavailable shots explain why", () => {
  const p = player(),
    system = new CombatSystem();
  system.start("intercept", p);
  aimAt(p, system.target!.position);
  for (let i = 0; i < 90; i++)
    system.step(1 / 60, p, combatNeutral, {
      ...emptyWorld,
      blocked: () => true,
    });
  assert.equal(system.status.lock, 0);
  assert.equal(system.status.lockReason, "Occluded");
  for (let i = 0; i < 90; i++) {
    aimAt(p, system.target!.position);
    system.step(1 / 60, p, combatNeutral, emptyWorld);
  }
  assert.equal(system.status.lock, 1);
  assert.equal(system.status.canFire, true);
  p.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  system.step(1 / 60, p, combatNeutral, emptyWorld);
  assert.equal(system.status.lockReason, "Align target");
  system.cycleTarget();
  assert.equal(system.status.lock, 0);
  assert.equal(system.target!.id, 2);
});
test("missile launches are edge-triggered, finite-rate guided and ammunition bounded", () => {
  const p = player(),
    system = new CombatSystem();
  system.start("intercept", p);
  for (let i = 0; i < 80; i++) {
    aimAt(p, system.target!.position);
    system.step(1 / 60, p, combatNeutral, emptyWorld);
  }
  system.step(1 / 60, p, { ...combatNeutral, missile: true }, emptyWorld);
  assert.equal(system.status.missiles, 11);
  for (let i = 0; i < 130; i++) {
    if (system.target) aimAt(p, system.target.position);
    system.step(1 / 60, p, { ...combatNeutral, missile: true }, emptyWorld);
  }
  assert.equal(system.status.missiles, 11);
  const missile = system.missiles[0];
  missile.active = true;
  missile.hostile = false;
  missile.position.copy(p.position);
  missile.previous.copy(p.position);
  missile.direction.set(0, 0, 1);
  missile.targetId = 1;
  missile.life = 0;
  const direction = missile.direction.clone();
  system.step(1 / 60, p, combatNeutral, emptyWorld);
  assert.ok(direction.angleTo(missile.direction) <= 1.7 / 60 + 1e-7);
  assert.ok(direction.angleTo(missile.direction) > 0);
  assert.ok(
    missile.position.distanceTo(missile.previous) <= missile.speed / 60 + 1e-7,
  );
});
test("countermeasures break nearby guidance once per press and expose incoming threat", () => {
  const p = player(),
    system = new CombatSystem();
  system.start("intercept", p);
  const missile = system.missiles[0];
  missile.active = true;
  missile.hostile = true;
  missile.targetId = 0;
  missile.position.copy(p.position).add(new Vector3(0, 0, 1000));
  missile.direction.set(0, 0, -1);
  system.step(1 / 60, p, combatNeutral, emptyWorld);
  assert.equal(system.status.threat, true);
  system.step(1 / 60, p, { ...combatNeutral, flare: true }, emptyWorld);
  assert.equal(missile.guided, false);
  assert.equal(system.status.flares, 11);
  for (let i = 0; i < 100; i++)
    system.step(1 / 60, p, { ...combatNeutral, flare: true }, emptyWorld);
  assert.equal(system.status.flares, 11);
  assert.ok(system.drainEvents().some((e) => e.type === "flare"));
});
test("cannon swept hits produce centralized damage and kill feedback", () => {
  const p = player(),
    system = new CombatSystem();
  system.start("intercept", p);
  const target = system.enemies[0];
  target.position.set(0, 5000, -180);
  target.previous.copy(target.position);
  target.speed = 0;
  target.velocity.set(0, 0, 0);
  target.health = 9;
  system.step(1 / 60, p, { ...combatNeutral, gun: true }, emptyWorld);
  for (let i = 0; i < 15; i++)
    system.step(1 / 60, p, combatNeutral, emptyWorld);
  assert.equal(target.active, false);
  assert.equal(system.status.kills, 1);
  const events = system.drainEvents();
  assert.ok(
    events.some(
      (e) => e.type === "hit" && e.entityId === target.id && !e.player,
    ),
  );
  assert.ok(
    events.some((e) => e.type === "explosion" && e.entityId === target.id),
  );
});
test("guided missiles catch a moving target and resolve damage through combat events", () => {
  const p = player(),
    system = new CombatSystem();
  system.start("intercept", p);
  const target = system.enemies[0];
  target.speed = 90;
  let fired = 0;
  for (let i = 0; i < 900 && target.active; i++) {
    aimAt(p, target.position);
    const shouldFire =
      system.status.canFire &&
      (fired === 0 || (target.health < 90 && fired === 1));
    system.step(
      1 / 60,
      p,
      { ...combatNeutral, missile: shouldFire },
      emptyWorld,
    );
    if (shouldFire) fired++;
  }
  assert.equal(fired, 2);
  assert.equal(target.active, false);
  assert.equal(system.status.missiles, 10);
  assert.ok(
    system
      .drainEvents()
      .filter((e) => e.type === "hit" && e.entityId === target.id).length >= 2,
  );
});
test("terrain recovery precedes attacks and bounds enemy angular motion", () => {
  const p = player(),
    system = new CombatSystem();
  system.start("intercept", p);
  const target = system.enemies[0];
  target.position.set(0, 1100, -600);
  target.previous.copy(target.position);
  target.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  target.velocity.set(0, 0, target.speed);
  const before = target.quaternion.clone();
  system.step(1 / 60, p, combatNeutral, {
    ...emptyWorld,
    groundHeight: (_x, z) => (z > -400 && z < -100 ? 1000 : 0),
  });
  assert.equal(target.state, "recover");
  assert.ok(target.position.y > 1100);
  assert.ok(before.angleTo(target.quaternion) <= 0.8 / 60 + 1e-7);
});
test("combat fixed-step outcomes match 30, 60 and 144 render rates", () => {
  const run = (fps: number) => {
    const p = player(),
      system = new CombatSystem();
    system.start("intercept", p);
    let accumulator = 0;
    for (let frame = 0; frame < fps * 8; frame++) {
      accumulator += 1 / fps;
      while (accumulator + 1e-10 >= 1 / 60) {
        system.step(1 / 60, p, combatNeutral, emptyWorld);
        accumulator -= 1 / 60;
      }
    }
    return system;
  };
  const reference = run(60);
  for (const fps of [30, 144]) {
    const other = run(fps);
    assert.ok(
      other.enemies[0].position.distanceTo(reference.enemies[0].position) <
        1e-8,
    );
    assert.equal(other.status.health, reference.status.health);
    assert.equal(other.status.elapsed, reference.status.elapsed);
  }
});
test("mission outcomes reset cleanly and projectiles/events stay bounded", () => {
  const p = player(),
    system = new CombatSystem();
  system.start("strike", p);
  system.enemies.find((e) => e.kind === "ground")!.active = false;
  system.step(1 / 60, p, combatNeutral, emptyWorld);
  assert.equal(system.completed, true);
  system.start("escort", p);
  assert.equal(system.completed, false);
  assert.equal(system.playerHealth, 100);
  assert.ok(system.ally);
  system.ally!.active = false;
  system.step(1 / 60, p, combatNeutral, emptyWorld);
  assert.equal(system.failed, true);
  system.start("intercept", p);
  for (let i = 0; i < 1200; i++)
    system.step(1 / 60, p, { ...combatNeutral, gun: true }, emptyWorld);
  assert.equal(system.tracers.length, 96);
  assert.equal(system.missiles.length, 16);
  assert.ok(system.drainEvents().length <= 128);
  system.stop();
  assert.equal(system.active, null);
  assert.equal(system.status.gunAmmo, 600);
  assert.ok(system.missiles.every((m) => !m.active));
  assert.ok(system.tracers.every((t) => !t.active));
});
test("combat view rebases globals and preserves normalized aircraft transform once", () => {
  const p = player(),
    system = new CombatSystem();
  system.start("intercept", p);
  const view = new CombatView(),
    template = new Group();
  template.scale.setScalar(8);
  template.rotation.y = -Math.PI / 2;
  view.setAircraftTemplate(template);
  view.update(system, new Vector3());
  const jet = view.group.children.find((e) => e.name === "combat-1")!;
  const before = jet.position.clone();
  view.update(system, new Vector3(3200, 0, -3200));
  assert.ok(
    jet.position
      .clone()
      .add(new Vector3(3200, 0, -3200))
      .equals(before),
  );
  assert.equal(jet.children[0].scale.x, 8);
  assert.equal(jet.children[0].rotation.y, -Math.PI / 2);
  view.dispose();
  view.dispose();
});
