import test from "node:test";
import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3 } from "three";
import {
  ParticlePool,
  flareBurn,
  planSalvo,
  stepBallistic,
  type FlarePlan,
} from "../src/effects/particle-core.ts";
import { Effects } from "../src/effects/Effects.ts";
import { makeFireAtlasData, makeSmokeAtlasData, TILE, CELLS } from "../src/effects/sprites.ts";

const WIND = { x: 0, y: 0, z: 0 };
function rng(seed = 1) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
function camera() {
  const c = new PerspectiveCamera(60, 16 / 9, 1, 22000);
  c.updateMatrixWorld();
  return c;
}

test("flare ballistics: drag stops the cartridge within seconds and gravity arcs it down", () => {
  const flare = { x: 0, y: 1000, z: 0, vx: 0, vy: -20, vz: -170 };
  const speeds: number[] = [];
  for (let i = 0; i < 240; i++) {
    stepBallistic(flare, 1 / 60, 0.55, 0.007, 9.8, WIND);
    if (i % 60 === 59) speeds.push(Math.hypot(flare.vx, flare.vy, flare.vz));
  }
  // Monotonic slowdown, settling near terminal fall speed (g / linear drag).
  for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i] < speeds[i - 1]);
  assert.ok(speeds[0] < 60, `1 s speed ${speeds[0]}`);
  assert.ok(speeds[3] < 25, `4 s speed ${speeds[3]}`);
  assert.ok(flare.y < 1000 - 20, "falls");
  assert.ok(flare.z < -60 && flare.z > -260, `drifts aft of the jet: ${flare.z}`);
});

test("ballistic drag is exact across step sizes (no stiffness at large dt)", () => {
  const a = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: -200 },
    b = { ...a };
  for (let i = 0; i < 60; i++) stepBallistic(a, 1 / 60, 1.2, 0, 0, WIND);
  stepBallistic(b, 1, 1.2, 0, 0, WIND);
  assert.ok(Math.abs(a.vz - b.vz) < 1e-6);
  assert.ok(Number.isFinite(b.z));
});

test("flare burn envelope ignites, holds, sputters out and is zero outside the burn", () => {
  assert.equal(flareBurn(-0.1, 3.5), 0);
  assert.equal(flareBurn(3.5, 3.5), 0);
  assert.ok(flareBurn(0.2, 3.5) > flareBurn(1.5, 3.5), "ignition spike exceeds the plateau");
  assert.ok(flareBurn(1.5, 3.5) > 0.4);
  assert.ok(flareBurn(3.45, 3.5) < 0.1);
  let peak = 0;
  for (let t = 0; t < 3.5; t += 0.01) peak = Math.max(peak, flareBurn(t, 3.5));
  assert.ok(peak < 1.5);
});

test("salvo plan: left/right pairs at 0.1 s, down and out at 25-35 m/s relative to the jet", () => {
  const jet = { x: 100, y: 500, z: 0 },
    velocity = { x: 0, y: 0, z: -155 },
    plan: FlarePlan[] = [];
  planSalvo(jet, velocity, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, 6, rng(3), plan);
  assert.equal(plan.length, 6);
  plan.forEach((shot, i) => {
    const rx = shot.velocity.x - velocity.x,
      ry = shot.velocity.y - velocity.y,
      rz = shot.velocity.z - velocity.z;
    const speed = Math.hypot(rx, ry, rz);
    assert.ok(speed > 24 && speed < 36, `ejection speed ${speed}`);
    assert.ok(ry < -10, "ejected downward");
    // Forward is -Z and up is +Y, so right is +X: even cartridges go left, odd go right.
    assert.ok(i % 2 === 0 ? rx < -8 : rx > 8, `side ${i}: ${rx}`);
    assert.ok(Math.abs(shot.delay - Math.floor(i / 2) * 0.1) < 0.02);
    // Leaves from the rear fuselage, carried along by the jet until its delay.
    assert.ok(shot.position.z > jet.z + velocity.z * shot.delay);
    assert.ok(shot.position.y < jet.y);
  });
  // A pair leaves from opposite sides of the centreline.
  assert.ok(plan[0].position.x < jet.x && plan[1].position.x > jet.x);
});

test("a banked jet ejects relative to its own body axes", () => {
  const plan: FlarePlan[] = [];
  // 90 degree roll to the right: body up points along +X (world), so 'down' is -X.
  planSalvo({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -100 }, { x: 0, y: 0, z: -1 }, { x: 1, y: 0, z: 0 }, 2, rng(5), plan);
  for (const shot of plan) assert.ok(shot.velocity.x < -15);
});

test("pool records recycle to neutral defaults so effects never inherit stale physics", () => {
  const pool = new ParticlePool(1);
  const p = pool.acquire()!;
  p.gravity = 9.8;
  p.drag = 3;
  p.heat = 0.8;
  p.stretch = 6;
  p.vx = 50;
  p.life = 0.01;
  pool.step(0.1, WIND, 0);
  assert.equal(pool.count, 0);
  const q = pool.acquire()!;
  assert.equal(q, p);
  assert.equal(q.gravity, 0);
  assert.equal(q.drag, 0);
  assert.equal(q.heat, -1);
  assert.equal(q.stretch, 1);
  assert.equal(q.vx, 0);
});

test("per-particle drag, gravity and lift integrate as expected", () => {
  const pool = new ParticlePool(2);
  const falling = pool.acquire()!;
  falling.life = 10;
  falling.gravity = 10;
  const damped = pool.acquire()!;
  damped.life = 10;
  damped.vx = 100;
  damped.drag = 2;
  for (let i = 0; i < 60; i++) pool.step(1 / 60, WIND, 0);
  assert.ok(Math.abs(falling.vy + 10) < 0.2, `v ${falling.vy}`);
  assert.ok(Math.abs(damped.vx - 100 * Math.exp(-2)) < 0.1, `v ${damped.vx}`);
});

test("sprite atlases are the right size and carry real coverage", () => {
  const bytes = TILE * CELLS * TILE * CELLS * 4;
  for (const data of [makeSmokeAtlasData(), makeFireAtlasData()]) {
    assert.equal(data.length, bytes);
    let covered = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 128) covered++;
    assert.ok(covered > bytes / 4 / 8, "atlas has opaque texels");
  }
});

test("flares: a salvo spawns delayed cartridges, light, smoke and sparks within budget", () => {
  const effects = new Effects(undefined, "medium"),
    cam = camera(),
    origin = new Vector3(5e6, 0, -5e6);
  const jet = origin.clone().add(new Vector3(0, 1000, -300));
  effects.emitFlares(jet, { x: 0, y: 0, z: -155 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 }, 6);
  assert.equal(effects.sources.cartridges, 6);
  let peakLive = 0;
  for (let i = 0; i < 60 * 5; i++) {
    effects.update(1 / 60, cam, origin);
    const { smoke, flame } = effects.stats;
    peakLive = Math.max(peakLive, smoke + flame);
    assert.ok(smoke <= 2400 && flame <= 1400);
  }
  assert.ok(peakLive > 100, `salvo is visible: ${peakLive}`);
  // After the 3-4 s burn the cartridges are spent.
  assert.equal(effects.sources.cartridges, 0);
  effects.dispose();
});

test("flares fired back to back cannot overrun the cartridge pool", () => {
  const effects = new Effects(undefined, "low"),
    cam = camera(),
    origin = new Vector3();
  for (let i = 0; i < 20; i++) effects.emitFlares({ x: 0, y: 800, z: -200 }, { x: 0, y: 0, z: -150 }, { x: 0, y: 0, z: -1 });
  assert.ok(effects.sources.cartridges <= 24);
  for (let i = 0; i < 120; i++) effects.update(1 / 60, cam, origin);
  effects.dispose();
});

test("explosions scale gracefully and never exceed the pools", () => {
  const origin = new Vector3(),
    cam = camera();
  for (const quality of ["low", "medium", "high"] as const) {
    const effects = new Effects(undefined, quality);
    const counts: number[] = [];
    for (const scale of [0.3, 1, 5]) {
      effects.clear();
      effects.emitExplosion({ x: 0, y: 100, z: -300 }, scale, scale > 2 ? "ground" : "air");
      effects.update(1 / 60, cam, origin);
      const { smoke, flame } = effects.stats;
      counts.push(smoke + flame);
      assert.ok(smoke <= 2400 && flame <= 1400);
    }
    assert.ok(counts[0] < counts[1] && counts[1] <= counts[2], `${quality}: ${counts}`);
    effects.dispose();
  }
});

test("stacked blasts saturate gracefully: no growth beyond capacity, recovery afterwards", () => {
  const effects = new Effects(undefined, "high"),
    cam = camera(),
    origin = new Vector3();
  for (let i = 0; i < 40; i++) effects.emitExplosion({ x: i * 5, y: 0, z: -400 }, 6, "ground");
  effects.update(1 / 60, cam, origin);
  assert.ok(effects.stats.smoke <= 2400 && effects.stats.flame <= 1400);
  for (let i = 0; i < 60 * 45; i++) effects.update(1 / 30, cam, origin);
  assert.equal(effects.stats.smoke + effects.stats.flame, 0, "everything burns out");
  assert.equal(effects.sources.sites + effects.sources.chunks + effects.sources.pending, 0);
  effects.dispose();
});

test("ground blasts leave a smoke column that lingers for tens of seconds", () => {
  const effects = new Effects(undefined, "medium"),
    cam = camera(),
    origin = new Vector3();
  effects.emitExplosion({ x: 0, y: 0, z: -500 }, 4, "ground");
  for (let i = 0; i < 20 * 20; i++) effects.update(1 / 20, cam, origin);
  assert.ok(effects.stats.smoke > 5, "smoke after 20 s");
  assert.equal(effects.sources.sites, 1);
  for (let i = 0; i < 20 * 30; i++) effects.update(1 / 20, cam, origin);
  assert.equal(effects.sources.sites, 0, "site burns out");
  effects.dispose();
});

test("debris lands on supplied terrain and stops", () => {
  const effects = new Effects(undefined, "medium"),
    cam = camera(),
    origin = new Vector3();
  effects.groundHeight = () => 0;
  effects.emitExplosion({ x: 0, y: 30, z: -200 }, 2, "air");
  assert.ok(effects.sources.chunks > 0);
  for (let i = 0; i < 60 * 6; i++) effects.update(1 / 60, cam, origin);
  assert.equal(effects.sources.chunks, 0);
  effects.dispose();
});

test("engine fire is allocation-light, bounded and scales with intensity", () => {
  const effects = new Effects(undefined, "medium"),
    cam = camera(),
    origin = new Vector3();
  const nozzle = { x: 0, y: 500, z: 0 },
    velocity = { x: 0, y: 0, z: -140 };
  const run = (intensity: number) => {
    effects.clear();
    for (let i = 0; i < 60 * 5; i++) {
      nozzle.z = -140 * (i / 60);
      effects.emitEngineFire(nozzle, velocity, intensity, 1 / 60);
      effects.update(1 / 60, cam, origin);
    }
    return effects.stats.smoke;
  };
  const light = run(0.2),
    heavy = run(1);
  assert.ok(heavy > light, `${heavy} > ${light}`);
  assert.ok(heavy < 2400 * 0.9);
  // Zero intensity or dt emits nothing.
  effects.clear();
  effects.emitEngineFire(nozzle, velocity, 0, 1 / 60);
  effects.emitEngineFire(nozzle, velocity, 1, 0);
  assert.equal(effects.stats.smoke + effects.stats.flame, 0);
  effects.dispose();
});

test("launch backblast and missile motor produce effects and clean up", () => {
  const effects = new Effects(undefined, "medium"),
    cam = camera(),
    origin = new Vector3();
  effects.emitLaunch({ x: 0, y: 5, z: -600 }, { x: 0, y: 0.6, z: -0.8 });
  effects.update(1 / 60, cam, origin);
  assert.ok(effects.stats.smoke > 20 && effects.stats.flame > 3);
  const m = { x: 0, y: 5, z: -600 };
  for (let i = 0; i < 120; i++) {
    m.y += 8;
    m.z -= 10;
    effects.updateMissile("m1", m, 1 / 60);
    effects.update(1 / 60, cam, origin);
  }
  assert.ok(effects.stats.smoke > 40);
  effects.stopEmitter("m1");
  assert.equal(effects.sources.missiles, 0);
  effects.dispose();
});

test("dormant source lists release everything on clear", () => {
  const effects = new Effects(undefined, "medium");
  effects.emitFlares({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -100 }, { x: 0, y: 0, z: -1 });
  effects.emitExplosion({ x: 0, y: 0, z: -100 }, 3, "ground");
  effects.clear();
  assert.deepEqual(effects.sources, { cartridges: 0, chunks: 0, sites: 0, pending: 0, missiles: 0 });
  assert.deepEqual(effects.stats, { smoke: 0, flame: 0, rendered: 0 });
  effects.dispose();
});
