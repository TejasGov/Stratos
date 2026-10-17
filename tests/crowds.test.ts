import test from "node:test";
import assert from "node:assert/strict";
import { crowdSpecs, sampleLoop } from "../src/world/Crowds.ts";
import { insideStructure } from "../src/world/baseLayout.ts";
import { BLACKRIDGE, HAVEN } from "../src/world/bases.ts";

test("route sampling wraps around a closed loop with unit headings", () => {
  const loop = { xs: [0, 10, 10, 0], zs: [0, 0, 10, 10], cum: [0, 10, 20, 30, 40], length: 40 };
  const s = { x: 0, z: 0, dx: 0, dz: 0 };
  sampleLoop(loop, 15, s);
  assert.deepEqual([s.x, s.z, s.dx, s.dz], [10, 5, 0, 1]);
  sampleLoop(loop, -5, s); // behind the start: on the closing leg
  assert.deepEqual([s.x, s.z, s.dx, s.dz], [0, 5, 0, -1]);
  sampleLoop(loop, 85, s);
  assert.deepEqual([s.x, s.z], [5, 0]);
});

test("crowds stay within budget and nobody stands inside a building", () => {
  const specs = crowdSpecs();
  const haven = specs.filter((s) => s.base === HAVEN).length;
  const blackridge = specs.filter((s) => s.base === BLACKRIDGE).length;
  assert.ok(haven <= 40 && blackridge <= 40, `${haven} / ${blackridge}`);
  for (const s of specs.filter((s) => !s.path))
    assert.equal(insideStructure(s.x, s.y + 1, s.z), false, `${s.char} at ${s.x.toFixed(0)},${s.z.toFixed(0)}`);
  // Only Blackridge troops can be killed by a strike.
  assert.ok(specs.every((s) => !s.enemy || s.base === BLACKRIDGE));
});
