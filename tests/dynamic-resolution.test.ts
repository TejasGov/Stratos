import test from "node:test";
import assert from "node:assert/strict";
import { DynamicResolution } from "../src/render/DynamicResolution.ts";

const run = (d: DynamicResolution, ms: number, seconds: number) => {
  let changes = 0;
  for (let t = 0; t < seconds; t += ms / 1000) if (d.update(ms, ms / 1000)) changes++;
  return changes;
};

test("holds full resolution at a steady 60 fps", () => {
  const d = new DynamicResolution();
  assert.equal(run(d, 16.7, 30), 0);
  assert.equal(d.scale, 1);
});

test("steps down under sustained load, never below the floor", () => {
  const d = new DynamicResolution();
  run(d, 33, 60);
  assert.equal(d.scale, d.min);
});

test("ignores brief hitches", () => {
  const d = new DynamicResolution();
  run(d, 16.7, 5);
  run(d, 40, 0.3);
  run(d, 16.7, 5);
  assert.equal(d.scale, 1);
});

test("recovers slowly once frames are comfortable again", () => {
  const d = new DynamicResolution();
  run(d, 33, 10);
  const low = d.scale;
  assert.ok(low < 1);
  run(d, 12, 8);
  assert.ok(d.scale > low && d.scale <= low + 0.05 + 1e-9);
  run(d, 12, 120);
  assert.equal(d.scale, 1);
});
