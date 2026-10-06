import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTerrain,
  CHUNK,
  heightAt,
  renderedHeightAt,
  regionMasks,
} from "../src/world/terrain";
import { RequestLedger, terrainTargets } from "../src/world/StreamingScheduler";

test("mixed terrain LOD boundaries are the same continuous polyline, including far negative tiles", () => {
  for (const [cx, cz] of [
    [0, -1],
    [-632, -813],
  ]) {
    const fine = buildTerrain(cx, cz, 48),
      coarse = buildTerrain(cx + 1, cz, 12);
    for (let i = 0; i <= 48; i++) {
      const fineHeight = fine.positions[(i * 49 + 48) * 3 + 1];
      const low = Math.min(11, Math.floor(i / 4)),
        t = i / 4 - low;
      const a = coarse.positions[low * 13 * 3 + 1],
        b = coarse.positions[(low + 1) * 13 * 3 + 1];
      assert.ok(Math.abs(fineHeight - (a + (b - a) * t)) < 0.0002);
    }
  }
});

test("authoritative near query follows actual mesh triangles rather than bilinear interpolation", () => {
  const cx = -1,
    cz = 0,
    mesh = buildTerrain(cx, cz, 48),
    step = CHUNK / 48;
  for (const [ix, iz, u, v] of [
    [15, 18, 0.2, 0.3],
    [40, 21, 0.8, 0.7],
    [47, 12, 0.85, 0.33],
  ]) {
    const a = mesh.positions[(iz * 49 + ix) * 3 + 1],
      b = mesh.positions[(iz * 49 + ix + 1) * 3 + 1];
    const c = mesh.positions[((iz + 1) * 49 + ix) * 3 + 1],
      d = mesh.positions[((iz + 1) * 49 + ix + 1) * 3 + 1];
    const expected =
      u + v <= 1
        ? a + (b - a) * u + (c - a) * v
        : d + (c - d) * (1 - u) + (b - d) * (1 - v);
    assert.ok(
      Math.abs(
        renderedHeightAt(
          cx * CHUNK + (ix + u) * step,
          cz * CHUNK + (iz + v) * step,
        ) - expected,
      ) < 0.0002,
    );
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
