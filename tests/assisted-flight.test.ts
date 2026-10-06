import test from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import { Flight, neutral } from "../src/flight.ts";

test("easy controls turn immediately and stop turning after release", () => {
  const flight = new Flight();
  flight.position.y = 6000;
  for (let i = 0; i < 60; i++) flight.step(1 / 60, { ...neutral, roll: 1 });
  assert.ok(flight.position.x < -20);
  assert.ok(Math.abs(flight.roll) <= 0.5);
  const heading = flight.yaw;
  for (let i = 0; i < 120; i++) flight.step(1 / 60, neutral);
  assert.ok(Math.abs(flight.yaw - heading) < 1e-6);
  assert.ok(Math.abs(flight.roll) < 0.001);
});
test("easy mode recovers to level flight and caps prolonged pitch input", () => {
  const flight = new Flight();
  flight.position.y = 6000;
  for (let i = 0; i < 360; i++) flight.step(1 / 60, { ...neutral, pitch: 1 });
  assert.ok(flight.pitch <= 1.151);
  assert.ok(flight.position.y > 6000);
  for (let i = 0; i < 180; i++) flight.step(1 / 60, neutral);
  assert.ok(Math.abs(flight.pitch) < 0.01);
});
test("target steering converges smoothly and terrain follow preserves clearance", () => {
  const flight = new Flight();
  flight.position.y = 6000;
  const aimDirection = new Vector3(1, 0.1, -1).normalize();
  let previous = flight.quaternion.clone();
  for (let i = 0; i < 180; i++) {
    flight.step(1 / 60, { ...neutral, aimDirection });
    assert.ok(previous.angleTo(flight.quaternion) < 0.03);
    previous.copy(flight.quaternion);
  }
  const forward = new Vector3(0, 0, -1).applyQuaternion(flight.quaternion);
  assert.ok(forward.angleTo(aimDirection) < 0.01);
  flight.reset({ x: 3100, z: 3100 });
  flight.position.y = 150;
  const down = new Vector3(0, -0.5, -1).normalize();
  for (let i = 0; i < 120; i++)
    flight.step(1 / 60, { ...neutral, aimDirection: down });
  assert.equal(flight.crashed, false);
  assert.ok(flight.position.y > 100);
});
test("follow throttle settles gradually and manual thrust always takes priority", () => {
  const flight = new Flight();
  flight.position.y = 6000;
  flight.step(1 / 60, { ...neutral, throttleTarget: 0.2 });
  assert.ok(flight.throttle > 0.6 && flight.throttle < 0.63);
  for (let i = 0; i < 300; i++)
    flight.step(1 / 60, { ...neutral, throttleTarget: 0.2 });
  assert.ok(Math.abs(flight.throttle - 0.2) < 0.001);
  const before = flight.throttle;
  flight.step(1 / 60, { ...neutral, throttle: 1, throttleTarget: 0.1 });
  assert.ok(flight.throttle > before);
});
