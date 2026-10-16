import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  FLEET,
  airframe,
  airframePoint,
  airframeRatings,
  airframeScale,
} from "../src/aircraft.ts";

test("fleet ids are unique and every model file is bundled", () => {
  assert.equal(new Set(FLEET.map((a) => a.id)).size, FLEET.length);
  for (const a of FLEET) assert.ok(existsSync(`public${a.file}`), a.file);
});

test("unknown airframe ids fall back to the first aircraft", () => {
  assert.equal(airframe("nope"), FLEET[0]);
});

test("model space (nose −X) maps into the aircraft frame (nose −Z)", () => {
  const sf35 = airframe("sf35");
  // The original single nozzle sat 8 m aft on the centreline.
  const nozzle = airframePoint(sf35, sf35.nozzles[0]);
  assert.ok(Math.abs(nozzle.z - 8) < 0.1);
  assert.ok(Math.abs(nozzle.x) < 0.01);
  const tip = airframePoint(sf35, sf35.tip);
  assert.ok(Math.abs(Math.abs(tip.x) - 5.3) < 0.05);
  assert.ok(Math.abs(airframeScale(sf35) - 16 / 1.9) < 1e-6);
});

test("nozzles are aft, symmetric and inside the airframe", () => {
  for (const a of FLEET) {
    const span = a.nozzles.reduce((s, n) => s + n[2], 0);
    assert.ok(Math.abs(span) < 1e-6, a.id);
    for (const n of a.nozzles) {
      const p = airframePoint(a, n);
      assert.ok(p.z > a.length * 0.35 && p.z < a.length * 0.52, `${a.id} z=${p.z}`);
    }
  }
});

test("ratings run 1–10 and tell the airframes apart", () => {
  const ratings = FLEET.map(airframeRatings);
  for (const r of ratings)
    for (const v of Object.values(r)) assert.ok(v >= 1 && v <= 10);
  assert.ok(new Set(ratings.map((r) => r.agility)).size > 4);
  assert.ok(new Set(ratings.map((r) => r.climb)).size > 3);
});
