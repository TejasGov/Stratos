import test from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3, Quaternion } from "three";
import {
  DistanceSampler,
  ParticlePool,
  localPosition,
} from "../src/effects/particle-core.ts";
import { Effects } from "../src/effects/Effects.ts";

test("distance emission is continuous across variable-length segments", () => {
  const sampler = new DistanceSampler(5),
    positions: number[] = [];
  const emit = (x: number) =>
    sampler.emit({ x, y: 0, z: 0 }, (p) => positions.push(p.x));
  emit(0);
  emit(3);
  emit(7);
  emit(12);
  emit(23);
  assert.deepEqual(positions, [5, 10, 15, 20]);
  const whole = new DistanceSampler(5),
    other: number[] = [];
  whole.emit({ x: 0, y: 0, z: 0 }, () => {});
  whole.emit({ x: 23, y: 0, z: 0 }, (p) => other.push(p.x));
  assert.deepEqual(other, positions);
});
test("hitches are bounded and teleports do not leave connecting trails", () => {
  const sampler = new DistanceSampler(2, 4, 100);
  const emit = (x: number) => sampler.emit({ x, y: 0, z: 0 }, () => {});
  assert.equal(emit(0), 0);
  assert.equal(emit(50), 4);
  assert.equal(emit(51), 0);
  assert.equal(emit(52), 1);
  assert.equal(emit(1000), 0);
  assert.equal(emit(1002), 1);
  sampler.reset();
  assert.equal(emit(-1000), 0);
});
test("pool capacity, recycling and zero-delta pause remain bounded", () => {
  const pool = new ParticlePool(3),
    still = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 3; i++) {
    const p = pool.acquire()!;
    p.life = 0.1;
    p.vx = 10;
  }
  assert.equal(pool.acquire(), undefined);
  assert.equal(pool.count, 3);
  pool.step(0, still, 0);
  assert.equal(pool.particles[0].x, 0);
  pool.step(0.05, still, 0);
  assert.equal(pool.particles[0].x, 0.5);
  pool.step(0.05, still, 0);
  assert.equal(pool.count, 0);
  assert.ok(pool.acquire());
  pool.clear();
  assert.equal(pool.count, 0);
  for (let i = 0; i < 3; i++) assert.ok(pool.acquire());
  assert.equal(pool.acquire(), undefined);
});
test("origin-relative uploads retain exact authoritative world anchors", () => {
  const world = { x: 123456789, y: 17, z: -98765432 },
    target = new Vector3();
  const a = new Vector3(123456000, 0, -98765000),
    b = a.clone().add(new Vector3(3200, 0, -3200));
  const first = localPosition(world, a, target).clone();
  const second = localPosition(world, b, target).clone();
  assert.ok(second.clone().add(b).equals(first.clone().add(a)));
  assert.equal(world.x, 123456789);
});
test("effects upload rebase and reset work without a WebGL context", () => {
  const effects = new Effects(undefined, "low"),
    camera = new PerspectiveCamera(60, 1, 1, 22000);
  const origin = new Vector3(10000000, 0, -10000000);
  const impact = origin.clone().add(new Vector3(0, 50, -100));
  camera.updateMatrixWorld();
  effects.emitExplosion(impact);
  effects.update(0.05, camera, origin);
  assert.ok(effects.stats.smoke > 0);
  assert.ok(effects.stats.rendered > 0);
  const attributes = effects.group.children[0] as import("three").Mesh;
  const centers = attributes.geometry.getAttribute("center");
  const before = centers.getX(0);
  const count = effects.stats.smoke;
  effects.update(0, camera, origin.clone().add(new Vector3(3200, 0, 0)));
  // GPU attributes are origin-relative Float32, with a submillimeter rounding allowance.
  assert.ok(Math.abs(centers.getX(0) - (before - 3200)) < 0.001);
  assert.equal(effects.stats.smoke, count);
  effects.updateJet(impact, new Quaternion(), true, 1 / 60);
  effects.reset();
  assert.deepEqual(effects.stats, { smoke: 0, flame: 0, rendered: 0 });
  effects.dispose();
  effects.dispose();
});
