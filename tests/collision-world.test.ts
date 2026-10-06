import test from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import { CollisionWorld } from "../src/physics/CollisionWorld";

test("Rapier swept proxy catches thin structures and is invariant under rebase", async () => {
  const collision = await CollisionWorld.create(() => 0);
  try {
    collision.addObstacle(new Vector3(7000, 200, 7000), new Vector3(1, 40, 30));
    const from = new Vector3(6900, 200, 7000),
      to = new Vector3(7100, 200, 7000);
    collision.update(from, new Vector3());
    const first = collision.sweep(from, to, undefined, 2);
    assert.ok(first && first.fraction > 0.45 && first.fraction < 0.51);
    collision.update(from, new Vector3(6400, 0, 6400));
    const rebased = collision.sweep(from, to, undefined, 2);
    assert.ok(rebased);
    assert.ok(Math.abs(first.fraction - rebased.fraction) < 0.001);
    assert.equal(
      collision.sweep(
        new Vector3(6900, 300, 7000),
        new Vector3(7100, 300, 7000),
        undefined,
        2,
      ),
      null,
    );
  } finally {
    collision.dispose();
  }
});

test("Heightfield axes follow asymmetric world terrain and streaming stays bounded", async () => {
  const sample = (x: number, z: number) => 40 + 0.035 * x + 0.012 * z;
  const collision = await CollisionWorld.create(sample);
  try {
    const point = new Vector3(185, 0, 315);
    for (let i = 0; i < 14; i++) collision.update(point, new Vector3());
    assert.equal(collision.status.terrainTiles, 25);
    const hit = collision.sweep(
      new Vector3(point.x, 150, point.z),
      new Vector3(point.x, 0, point.z),
      undefined,
      0.25,
    );
    assert.ok(hit);
    assert.ok(Math.abs(hit.point.y - sample(point.x, point.z)) < 1);
    for (let i = 0; i < 100; i++)
      collision.update(
        new Vector3(i * 800, 200, -i * 400),
        new Vector3(i * 800, 0, -i * 400),
      );
    assert.ok(collision.status.terrainTiles <= 25);
    assert.ok(collision.status.colliders <= 39);
  } finally {
    collision.dispose();
  }
});
