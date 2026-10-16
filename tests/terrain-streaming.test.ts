import test from "node:test";
import assert from "node:assert/strict";
import {
  heightAt,
  renderedHeightAt,
  regionMasks,
} from "../src/world/terrain";
import { RequestLedger, terrainTargets } from "../src/world/StreamingScheduler";

test("collision surface is the drawn 8 m clipmap grid, bilinearly interpolated", () => {
  for (const [x, z] of [
    [-1269, 2],
    [1, 314],
    [-632 * 1600 + 37, -813 * 1600 + 5],
  ]) {
    const gx = Math.floor(x / 8) * 8,
      gz = Math.floor(z / 8) * 8;
    // Exact at grid points…
    assert.equal(renderedHeightAt(gx, gz), heightAt(gx, gz));
    // …and bounded by the four surrounding samples in between.
    const corners = [
      heightAt(gx, gz),
      heightAt(gx + 8, gz),
      heightAt(gx, gz + 8),
      heightAt(gx + 8, gz + 8),
    ];
    const h = renderedHeightAt(x, z);
    assert.ok(h >= Math.min(...corners) - 1e-9 && h <= Math.max(...corners) + 1e-9);
  }
});

test("authored region retains runway level and infrastructure/drainage masks", () => {
  assert.equal(heightAt(-900, 0), 28);
  assert.ok(regionMasks(-900, 0).infrastructure > 0.9);
  assert.ok(regionMasks(180, -900).drainage > 0.2);
  assert.ok(heightAt(2500, -500) < 0);
  assert.ok(Number.isFinite(heightAt(-1000000, 1300000)));
});

test("velocity reprioritizes streaming without changing residency or negative-coordinate center", () => {
  const position = { x: -100, z: -100 };
  const east = terrainTargets(position, { x: 340, z: 0 }),
    west = terrainTargets(position, { x: -340, z: 0 });
  assert.equal(east.length, 81);
  assert.equal(east[0].x, west[0].x);
  assert.equal(east[0].z, west[0].z);
  assert.equal(east[0].x, -1);
  const index = (list: typeof east, x: number, z: number) =>
    list.findIndex((t) => t.x === x && t.z === z);
  assert.ok(index(east, 1, -1) < index(west, 1, -1));
  assert.deepEqual(
    east.map((t) => `${t.x},${t.z},${t.segments}`).sort(),
    west.map((t) => `${t.x},${t.z},${t.segments}`).sort(),
  );
});

test("stale worker replies cannot complete replacement requests after worker recovery", () => {
  const ledger = new RequestLedger();
  const old = ledger.begin("-1,2,48", 0);
  ledger.clear();
  const replacement = ledger.begin("-1,2,48", 3);
  assert.equal(ledger.finish("-1,2,48", old), false);
  assert.equal(ledger.size, 1);
  assert.equal(ledger.oldestAge(12), 9);
  assert.equal(ledger.finish("-1,2,48", replacement), true);
  assert.equal(ledger.size, 0);
});
