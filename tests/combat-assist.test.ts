import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import { Flight, neutral } from "../src/flight.ts";
import {
  CombatSystem,
  AIM_ASSIST,
  combatNeutral,
  predictInterceptPosition,
  type CombatPlayer,
} from "../src/combat/CombatSystem.ts";

const clear = { groundHeight: () => 0, blocked: () => false };
const player = (): CombatPlayer => ({
  position: new Vector3(0, 5000, 0),
  previous: new Vector3(0, 5000, 0),
  velocity: new Vector3(0, 0, -155),
  quaternion: new Quaternion(),
  speed: 155,
  crashed: false,
});

test("held launch during the initial approach locks quickly and damages without manual steering", () => {
  const p = player(),
    combat = new CombatSystem();
  combat.start("intercept", p);
  const target = combat.target!;
  const startHealth = target.health;
  let lockAt = 0;
  for (let i = 0; i < 420 && target.health === startHealth; i++) {
    p.previous.copy(p.position);
    p.position.addScaledVector(p.velocity, 1 / 60);
    combat.step(1 / 60, p, { ...combatNeutral, missile: true }, clear);
    if (combat.status.lock === 1 && lockAt === 0) lockAt = (i + 1) / 60;
  }
  assert.ok(lockAt > 0 && lockAt <= 0.6);
  assert.equal(combat.status.missiles, 11);
  assert.ok(target.health < startHealth);
  assert.equal(combat.playerHealth, 100);
});
test("default centered intercept can be hit by holding the cannon without precision steering", () => {
  const p = player(),
    combat = new CombatSystem();
  combat.start("intercept", p);
  const target = combat.target!;
  for (let i = 0; i < 300 && target.active; i++) {
    p.previous.copy(p.position);
    p.position.addScaledVector(p.velocity, 1 / 60);
    combat.step(1 / 60, p, { ...combatNeutral, gun: true }, clear);
  }
  assert.equal(target.active, false);
  assert.ok(combat.status.kills >= 1);
  assert.ok(combat.status.gunAmmo > 500);
});
test("default Haven flight with target follow gets the first cannon kill over actual terrain", () => {
  const flight = new Flight(),
    combat = new CombatSystem(),
    steering = new Vector3();
  flight.reset();
  combat.start("intercept", flight);
  const first = combat.target!;
  for (let i = 0; i < 600 && first.active; i++) {
    const aimDirection = combat.getAimDirection(flight, steering) ?? undefined;
    flight.step(1 / 60, { ...neutral, aimDirection });
    combat.step(1 / 60, flight, { ...combatNeutral, gun: true });
  }
  assert.equal(flight.crashed, false);
  assert.equal(first.active, false);
  assert.equal(combat.playerHealth, 100);
});
test("a quick missile tap buffers acquisition once, while occluded requests expire", () => {
  const p = player(),
    combat = new CombatSystem();
  combat.start("intercept", p);
  combat.step(1 / 60, p, { ...combatNeutral, missile: true }, clear);
  for (let i = 0; i < 120; i++) combat.step(1 / 60, p, combatNeutral, clear);
  assert.equal(combat.status.missiles, 11);
  combat.start("intercept", p);
  combat.step(
    1 / 60,
    p,
    { ...combatNeutral, missile: true },
    { ...clear, blocked: () => true },
  );
  for (let i = 0; i < 90; i++)
    combat.step(1 / 60, p, combatNeutral, { ...clear, blocked: () => true });
  for (let i = 0; i < 40; i++) combat.step(1 / 60, p, combatNeutral, clear);
  assert.equal(combat.status.lock, 1);
  assert.equal(combat.status.missiles, 12);
});
test("predictive lead meets a moving target at a constant-speed intercept and stays bounded", () => {
  const origin = new Vector3(),
    target = new Vector3(0, 0, -1000),
    velocity = new Vector3(100, 0, 0),
    lead = new Vector3();
  predictInterceptPosition(origin, target, velocity, 1400, lead);
  const time = lead.distanceTo(origin) / 1400;
  assert.ok(
    lead.distanceTo(target.clone().addScaledVector(velocity, time)) < 1e-6,
  );
  predictInterceptPosition(
    origin,
    target,
    new Vector3(100000, 0, 0),
    100,
    lead,
    0.5,
  );
  assert.ok(lead.x <= 50000 && Number.isFinite(lead.length()));
});
test("cannon assist respects angular/range limits and occlusion rather than granting remote damage", () => {
  const p = player(),
    combat = new CombatSystem();
  combat.start("intercept", p);
  const target = combat.target!,
    aim = new Vector3();
  target.position.set(100, 5000, -1000);
  target.velocity.set(80, 0, 0);
  assert.ok(combat.getGunAimPoint(p, aim, clear));
  assert.ok(
    new Vector3(0, 0, -1).angleTo(aim.clone().sub(p.position)) <=
      (AIM_ASSIST.cannonConeDegrees * Math.PI) / 180,
  );
  assert.equal(
    combat.getGunAimPoint(p, aim, { ...clear, blocked: () => true }),
    null,
  );
  assert.equal(
    combat.getAimDirection(p, aim, { ...clear, blocked: () => true }),
    null,
  );
  target.position.set(600, 5000, -1000);
  assert.equal(combat.getGunAimPoint(p, aim, clear), null);
  target.position.set(0, 5000, -2000);
  assert.equal(combat.getGunAimPoint(p, aim, clear), null);
  target.position.set(0, 5000, 100);
  assert.equal(combat.getGunAimPoint(p, aim, clear), null);
  const health = target.health;
  for (let i = 0; i < 120; i++)
    combat.step(
      1 / 60,
      p,
      { ...combatNeutral, gun: true },
      { ...clear, blocked: () => true },
    );
  assert.equal(target.health, health);
});
test("wider lock remains unavailable behind the player or through terrain", () => {
  const p = player(),
    combat = new CombatSystem();
  combat.start("intercept", p);
  const target = combat.target!;
  target.speed = 0;
  target.velocity.set(0, 0, 0);
  target.position.set(650, 5000, -1000);
  for (let i = 0; i < 40; i++) combat.step(1 / 60, p, combatNeutral, clear);
  assert.equal(combat.status.lock, 1);
  target.position.set(650, 5000, 1000);
  combat.step(1 / 60, p, combatNeutral, clear);
  assert.equal(combat.status.canFire, false);
  assert.equal(combat.status.lockReason, "Align target");
  target.position.set(0, 5000, -1000);
  for (let i = 0; i < 40; i++)
    combat.step(1 / 60, p, combatNeutral, { ...clear, blocked: () => true });
  assert.equal(combat.status.lock, 0);
  assert.equal(combat.status.lockReason, "Occluded");
});
