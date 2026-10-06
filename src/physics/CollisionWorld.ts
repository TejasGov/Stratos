import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3 } from "three";
import { heightAt } from "../world/terrain";

const TILE = 400,
  SEGMENTS = 16,
  RADIUS = 2;
type Point = { x: number; y: number; z: number };
let initialization: Promise<void> | undefined;

/** Rapier 0.21 collision/query bubble; flight integration stays owned by Flight. */
export class CollisionWorld {
  readonly origin = new Vector3();
  private world: RAPIER.World;
  private terrain = new Map<string, RAPIER.Collider>();
  private obstacles: RAPIER.Collider[] = [];
  private queued: { key: string; x: number; z: number; d: number }[] = [];
  private cell = "";
  private shape = new RAPIER.Cuboid(5.4, 1.3, 7.2);
  private dirty = false;
  private disposed = false;
  private from = new Vector3();
  private displacement = new Vector3();

  static async create(
    sampleHeight: (x: number, z: number) => number = heightAt,
  ) {
    initialization ??= RAPIER.init();
    await initialization;
    return new CollisionWorld(sampleHeight);
  }
  private constructor(private sampleHeight: (x: number, z: number) => number) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    // Fixed authored obstacles are small in number; broad phase culls distant queries.
    this.addObstacle(new Vector3(2500, 65, -500), new Vector3(340, 5, 14));
    for (let i = -3; i <= 3; i++)
      this.addObstacle(
        new Vector3(2500 + i * 95, 15, -500),
        new Vector3(6, 50, 9),
      );
    for (let i = 0; i < 6; i++)
      this.addObstacle(
        new Vector3(-795, 38, -300 + i * 115),
        new Vector3(22.5, 10, 32.5),
      );
  }
  get status() {
    return {
      terrainTiles: this.terrain.size,
      pendingTiles: this.queued.length,
      colliders: this.terrain.size + this.obstacles.length,
      ready: this.terrain.size > 0,
    };
  }
  addObstacle(globalPosition: Point, halfExtents: Point) {
    const p = this.from.copy(globalPosition).sub(this.origin);
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
        .setTranslation(p.x, p.y, p.z)
        .setCollisionGroups(0x00010001),
    );
    this.obstacles.push(collider);
    this.dirty = true;
    return collider;
  }
  /** Call before flight sweeps at fixed-step boundaries. At most two tiles per call. */
  update(globalPosition: Point, renderOrigin: Point, dt = 1 / 60) {
    if (this.disposed) return;
    this.rebase(renderOrigin);
    const cx = Math.floor(globalPosition.x / TILE),
      cz = Math.floor(globalPosition.z / TILE);
    const cell = `${cx},${cz}`;
    if (cell !== this.cell) {
      this.cell = cell;
      const desired = new Set<string>();
      this.queued = [];
      for (let z = -RADIUS; z <= RADIUS; z++)
        for (let x = -RADIUS; x <= RADIUS; x++) {
          const key = `${cx + x},${cz + z}`;
          desired.add(key);
          if (!this.terrain.has(key))
            this.queued.push({ key, x: cx + x, z: cz + z, d: x * x + z * z });
        }
      this.queued.sort((a, b) => a.d - b.d);
      for (const [key, collider] of this.terrain)
        if (!desired.has(key)) {
          this.world.removeCollider(collider, false);
          this.terrain.delete(key);
          this.dirty = true;
        }
    }
    for (let i = 0; i < 2 && this.queued.length; i++) {
      const tile = this.queued.shift()!;
      const heights = new Float32Array((SEGMENTS + 1) ** 2);
      // Rapier's rows follow Z, columns follow X; storage is column-major.
      for (let x = 0; x <= SEGMENTS; x++)
        for (let z = 0; z <= SEGMENTS; z++)
          heights[x * (SEGMENTS + 1) + z] = Math.max(
            0,
            this.sampleHeight(
              tile.x * TILE + (x * TILE) / SEGMENTS,
              tile.z * TILE + (z * TILE) / SEGMENTS,
            ),
          );
      const collider = this.world.createCollider(
        RAPIER.ColliderDesc.heightfield(SEGMENTS, SEGMENTS, heights, {
          x: TILE,
          y: 1,
          z: TILE,
        })
          .setTranslation(
            (tile.x + 0.5) * TILE - this.origin.x,
            -this.origin.y,
            (tile.z + 0.5) * TILE - this.origin.z,
          )
          .setCollisionGroups(0x00010001),
      );
      this.terrain.set(tile.key, collider);
      this.dirty = true;
    }
    if (this.dirty) {
      this.world.timestep = Math.min(Math.max(dt, 1 / 240), 1 / 30);
      this.world.step(); // 0.21 updates broad phase through simulation, including static mutations.
      this.dirty = false;
    }
  }
  rebase(nextOrigin: Point) {
    const dx = this.origin.x - nextOrigin.x,
      dy = this.origin.y - nextOrigin.y,
      dz = this.origin.z - nextOrigin.z;
    if (!dx && !dy && !dz) return;
    for (const collider of [...this.terrain.values(), ...this.obstacles]) {
      const p = collider.translation();
      collider.setTranslation({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
    }
    this.origin.copy(nextOrigin);
    this.dirty = true;
  }
  /** Global endpoints, aircraft orientation; normalized impact fraction [0,1]. */
  sweep(
    from: Point,
    to: Point,
    rotation: Quaternion = new Quaternion(),
    radius?: number,
  ) {
    if (this.disposed) return null;
    if (this.dirty) {
      this.world.step();
      this.dirty = false;
    }
    this.from.copy(from).sub(this.origin);
    this.displacement.copy(to).sub(from);
    const hit = this.world.castShape(
      this.from,
      rotation,
      this.displacement,
      radius === undefined ? this.shape : new RAPIER.Ball(radius),
      0.1,
      1,
      true,
      RAPIER.QueryFilterFlags.ONLY_FIXED,
      0x00010001,
    );
    return hit
      ? {
          fraction: hit.time_of_impact,
          collider: hit.collider.handle,
          point: new Vector3(
            hit.witness1.x,
            hit.witness1.y,
            hit.witness1.z,
          ).add(this.origin),
        }
      : null;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.terrain.clear();
    this.obstacles.length = 0;
    this.queued.length = 0;
    this.world.free();
  }
}
