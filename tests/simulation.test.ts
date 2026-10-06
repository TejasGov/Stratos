import test from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import { Flight, neutral, sweptCollision } from "../src/flight.ts";
import { buildTerrain, CHUNK, heightAt } from "../src/world/terrain.ts";
import { Mission, routes } from "../src/missions.ts";

test("fixed-step flight gives the same result at 30, 60 and 144 render FPS", () => {
  const run = (fps: number) => {
    const f = new Flight();
    f.position.y = 5000;
    f.previous.copy(f.position);
    let accumulator = 0;
    for (let frame = 0; frame < fps * 30; frame++) {
      accumulator += 1 / fps;
      while (accumulator + 1e-10 >= 1 / 60) {
        f.step(1 / 60, { ...neutral, roll: 0.3, pitch: 0.08 });
        accumulator -= 1 / 60;
      }
    }
    return f;
  };
  const a = run(30);
  for (const fps of [60, 144]) {
    const b = run(fps);
    assert.ok(a.position.distanceTo(b.position) < 1e-6);
    assert.ok(Math.abs(a.speed - b.speed) < 1e-8);
  }
});
test("30 simulated minutes remain finite and cross more than 50 world chunks", () => {
  const f = new Flight();
  f.position.y = 5000;
  f.previous.copy(f.position);
  const chunks = new Set<string>();
  for (let i = 0; i < 60 * 60 * 30; i++) {
    f.step(1 / 60, neutral);
    if (i % 600 === 0)
      chunks.add(
        `${Math.floor(f.position.x / CHUNK)},${Math.floor(f.position.z / CHUNK)}`,
      );
  }
  assert.equal(f.crashed, false);
  assert.ok(chunks.size > 50);
  assert.ok(Number.isFinite(f.position.z));
  assert.ok(f.speed > 100 && f.speed < 340);
  assert.ok(Math.abs(f.quaternion.length() - 1) < 1e-8);
});
test("pitch, bank and throttle affect the aircraft in the expected direction", () => {
  const f = new Flight();
  f.position.y = 5000;
  for (let i = 0; i < 180; i++)
    f.step(1 / 60, { pitch: 0.5, roll: 0.5, yaw: 0, throttle: 1, boost: true });
  assert.ok(f.position.y > 5000);
  assert.ok(f.position.x < 0);
  assert.ok(f.speed > 155);
  assert.equal(f.throttle, 1);
});
test("neighboring terrain chunks have identical shared-edge heights and normals", () => {
  const a = buildTerrain(-1, 2, 24),
    b = buildTerrain(0, 2, 24);
  for (let i = 0; i <= 24; i++) {
    const ai = (i * 25 + 24) * 3,
      bi = i * 25 * 3;
    assert.equal(a.positions[ai + 1], b.positions[bi + 1]);
    for (let j = 0; j < 3; j++)
      assert.equal(a.normals[ai + j], b.normals[bi + j]);
  }
});
test("terrain is deterministic at negative and far world coordinates", () => {
  for (const [x, z] of [
    [-3500, -4500],
    [1000000, -1300000],
    [0, 0],
  ]) {
    assert.equal(heightAt(x, z), heightAt(x, z));
    assert.ok(Number.isFinite(heightAt(x, z)));
  }
  assert.deepEqual(buildTerrain(2, -3, 12), buildTerrain(2, -3, 12));
});
test("swept collision catches crossing sea level between frames", () => {
  assert.equal(
    sweptCollision(new Vector3(3100, 50, 3100), new Vector3(3200, -30, 3100)),
    true,
  );
  assert.equal(
    sweptCollision(
      new Vector3(3100, 5000, 3100),
      new Vector3(3200, 5000, 3100),
    ),
    false,
  );
});
test("checkpoint route only completes in order and records best time", () => {
  const m = new Mission();
  m.start("skyline");
  const last = m.gate(routes.skyline.points.length - 1)!;
  m.update(1, last, last);
  assert.equal(m.index, 0);
  for (let i = 0; i < routes.skyline.points.length; i++) {
    const gate = m.gate()!;
    m.update(
      1,
      gate.clone().add(new Vector3(0, 0, 200)),
      gate.clone().add(new Vector3(0, 0, -200)),
    );
  }
  assert.equal(m.completed, true);
  assert.equal(m.index, 6);
  assert.equal(m.best.skyline, 7);
});
test("large scenery collision catches the bridge deck and airfield hangars", () => {
  assert.equal(
    sweptCollision(new Vector3(2500, 70, -600), new Vector3(2500, 70, -400)),
    true,
  );
  assert.equal(
    sweptCollision(new Vector3(-795, 50, -350), new Vector3(-795, 50, -250)),
    true,
  );
});
test("low-altitude challenge applies penalties and times out", () => {
  const m = new Mission();
  m.start("coast");
  const high = new Vector3(8000, 5000, 8000);
  m.update(10, high, high);
  assert.equal(m.penalty, 10);
  const result = m.update(181, high, high);
  assert.equal(m.active, null);
  assert.match(result!, /expired/);
});
