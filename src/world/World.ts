import * as T from "three";
import { CHUNK, forestMask, hash, heightAt, regionMasks } from "./terrain";
import type { WorldQuality } from "../render/quality";
import { terrainTargets } from "./StreamingScheduler";
import { TerrainMaterials } from "../render/TerrainMaterials";
import { GpuTerrain } from "./GpuTerrain";

const TREE_CANDIDATES: Record<WorldQuality, number> = {
  low: 500,
  medium: 1800,
  high: 3200,
};

/** A broadleaf tropical tree: trunk plus three lumpy crown masses, vertex-coloured. */
function treeGeometry() {
  const parts: T.BufferGeometry[] = [];
  const trunk = new T.CylinderGeometry(0.35, 0.6, 7, 5, 1, true);
  trunk.translate(0, 3.5, 0);
  parts.push(trunk);
  const crowns: [number, number, number, number][] = [
    [0, 9.2, 0, 4.4],
    [1.9, 8.1, 1.1, 3.2],
    [-1.6, 8.4, -1.3, 3.4],
  ];
  for (const [x, y, z, r] of crowns) {
    const crown = new T.IcosahedronGeometry(r, 1);
    const p = crown.attributes.position;
    for (let i = 0; i < p.count; i++) {
      // Squash and roughen the sphere so crowns read as foliage clumps.
      const n = 0.85 + 0.3 * hash(i * 13 + Math.round(r * 10), Math.round(x * 7));
      p.setXYZ(i, p.getX(i) * n, p.getY(i) * n * 0.78, p.getZ(i) * n);
    }
    crown.translate(x, y, z);
    parts.push(crown);
  }
  const merged = new T.BufferGeometry();
  const flats = parts.map((g) => {
    if (!g.index) return g;
    const flat = g.toNonIndexed();
    g.dispose();
    return flat;
  });
  const vertices = flats.reduce((n, g) => n + g.attributes.position.count, 0);
  const positions = new Float32Array(vertices * 3),
    colors = new Float32Array(vertices * 3);
  let offset = 0;
  flats.forEach((flat, index) => {
    const p = flat.attributes.position;
    for (let i = 0; i < p.count; i++, offset++) {
      positions.set([p.getX(i), p.getY(i), p.getZ(i)], offset * 3);
      const shade = index === 0 ? [0.16, 0.11, 0.07] : [0.045, 0.1, 0.03];
      // Lower crown faces are darker: cheap self-occlusion.
      const ao = index === 0 ? 1 : 0.65 + 0.35 * T.MathUtils.clamp((p.getY(i) - 6) / 6, 0, 1);
      colors.set(shade.map((c) => c * ao), offset * 3);
    }
    flat.dispose();
  });
  merged.setAttribute("position", new T.BufferAttribute(positions, 3));
  merged.setAttribute("color", new T.BufferAttribute(colors, 3));
  merged.computeVertexNormals();
  return merged;
}

/**
 * The world: GPU heightfield terrain to the horizon, plus streamed scenery
 * chunks (trees, buildings) near the aircraft and authored landmarks.
 */
export class World {
  origin = new T.Vector3();
  chunks = new Map<string, T.Group>();
  private desired = new Map<string, { x: number; z: number }>();
  private lastCell = "";
  private terrainMaterials: TerrainMaterials;
  readonly terrain: GpuTerrain;
  private treeGeometry = treeGeometry();
  private treeMaterial = new T.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
  });
  private buildingGeometry = new T.BoxGeometry(1, 1, 1);
  private buildingMaterial = new T.MeshStandardMaterial({
    color: "#d8d2bd",
    roughness: 0.85,
  });
  private airfield = new T.Group();
  private bridge = new T.Group();
  /** Shadow-casting sun/moon light; the sky engine owns its colour and intensity. */
  readonly sun = new T.DirectionalLight("#fff1d9", 2.5);
  /** Direction toward the light, updated by the sky engine's time of day. */
  readonly lightDirection = new T.Vector3(-0.55, 0.68, 0.48).normalize();
  private matrix = new T.Object3D();
  private color = new T.Color();
  private quality: WorldQuality = "medium";
  private terrainPrimed = false;
  constructor(private scene: T.Scene) {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.left = -900;
    this.sun.shadow.camera.right = 900;
    this.sun.shadow.camera.top = 900;
    this.sun.shadow.camera.bottom = -900;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 8000;
    this.sun.shadow.normalBias = 2;
    this.sun.shadow.bias = -0.0002;
    scene.add(this.sun, this.sun.target);
    const material = new T.MeshStandardMaterial();
    this.terrain = new GpuTerrain(material);
    this.terrainMaterials = new TerrainMaterials(
      this.origin,
      this.terrain.uniforms,
      this.lightDirection,
    );
    this.terrain.mesh.material = this.terrainMaterials.material;
    material.dispose();
    scene.add(this.terrain.mesh);
    this.createAirfield();
    this.createBridge();
  }
  get stats() {
    return {
      chunks: this.chunks.size,
      patches: this.terrain.stats.patches,
      regenerated: this.terrain.stats.regenerated,
    };
  }
  private createAirfield() {
    const runway = new T.Mesh(
      new T.BoxGeometry(65, 1, 1050),
      new T.MeshStandardMaterial({ color: "#3c4c4b", roughness: 1 }),
    );
    runway.position.y = 29;
    runway.receiveShadow = true;
    this.airfield.add(runway);
    const markings = new T.InstancedMesh(
      new T.BoxGeometry(3, 0.1, 23),
      new T.MeshBasicMaterial({ color: "#ebe9cc" }),
      22,
    );
    for (let i = 0; i < 22; i++) {
      this.matrix.position.set(0, 29.6, -480 + i * 45);
      this.matrix.scale.set(1, 1, 1);
      this.matrix.updateMatrix();
      markings.setMatrixAt(i, this.matrix.matrix);
    }
    this.airfield.add(markings);
    for (let i = 0; i < 6; i++) {
      const hangar = new T.Mesh(
        new T.BoxGeometry(45, 20, 65),
        this.buildingMaterial,
      );
      hangar.position.set(105, 38, -300 + i * 115);
      hangar.castShadow = hangar.receiveShadow = true;
      this.airfield.add(hangar);
    }
    this.airfield.position.set(-900, 0, 0);
    this.scene.add(this.airfield);
  }
  private createBridge() {
    const material = new T.MeshStandardMaterial({
      color: "#abbaa8",
      roughness: 0.8,
    });
    const deck = new T.Mesh(new T.BoxGeometry(680, 10, 28), material);
    deck.position.y = 65;
    deck.castShadow = true;
    this.bridge.add(deck);
    for (let i = -3; i <= 3; i++) {
      const support = new T.Mesh(new T.BoxGeometry(12, 100, 18), material);
      support.position.set(i * 95, 15, 0);
      support.castShadow = true;
      this.bridge.add(support);
    }
    for (const z of [-15, 15]) {
      const rail = new T.Mesh(new T.BoxGeometry(680, 3, 2), material);
      rail.position.set(0, 74, z);
      this.bridge.add(rail);
    }
    this.bridge.position.set(2500, 0, -500);
    this.scene.add(this.bridge);
  }
  /** Streams scenery around the aircraft and keeps the floating origin near it. */
  update(position: T.Vector3, _dt: number, velocity?: T.Vector3) {
    const cx = Math.floor(position.x / CHUNK),
      cz = Math.floor(position.z / CHUNK),
      cell = `${cx},${cz}`;
    if (cell !== this.lastCell) {
      this.lastCell = cell;
      this.desired.clear();
      // Scenery only within the two nearest chunk rings; terrain itself is GPU-driven.
      for (const t of terrainTargets(position, velocity))
        if (t.segments >= 24) this.desired.set(`${t.x},${t.z}`, t);
      for (const [key, group] of this.chunks)
        if (!this.desired.has(key)) this.removeChunk(key, group);
    }
    // Build at most two chunks per frame, nearest first.
    let built = 0;
    for (const [key, target] of this.desired) {
      if (built >= 2) break;
      if (this.chunks.has(key)) continue;
      this.addChunk(key, target.x, target.z);
      built++;
    }
    const old = this.origin.clone();
    if (
      Math.abs(position.x - this.origin.x) > CHUNK * 2 ||
      Math.abs(position.z - this.origin.z) > CHUNK * 2
    )
      this.origin.set(cx * CHUNK, 0, cz * CHUNK);
    if (!old.equals(this.origin))
      for (const [key, group] of this.chunks) {
        const [x, z] = key.split(",").map(Number);
        group.position.set(
          x * CHUNK - this.origin.x,
          0,
          z * CHUNK - this.origin.z,
        );
      }
    this.airfield.position.set(-900 - this.origin.x, 0, -this.origin.z);
    this.bridge.position.set(2500 - this.origin.x, 0, -500 - this.origin.z);
    const texel = 1800 / this.sun.shadow.mapSize.x;
    this.sun.target.position.set(
      Math.round((position.x - this.origin.x) / texel) * texel,
      0,
      Math.round((position.z - this.origin.z) / texel) * texel,
    );
    this.sun.position
      .copy(this.sun.target.position)
      .addScaledVector(this.lightDirection, 6500);
  }
  /** Terrain LOD follows the camera (which may be detached from the aircraft). */
  updateTerrain(renderer: T.WebGLRenderer, cameraGlobal: T.Vector3) {
    this.terrain.update(renderer, cameraGlobal, this.origin, !this.terrainPrimed);
    this.terrainPrimed = true;
  }
  private addChunk(key: string, cx: number, cz: number) {
    const group = new T.Group();
    const trees: { m: T.Matrix4; tint: number }[] = [],
      buildings: T.Matrix4[] = [];
    // Authored port storage yard: aligned rows make regional infrastructure readable from flight.
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 6; col++) {
        const wx = 1780 + col * 24,
          wz = -1110 + row * 30;
        if (Math.floor(wx / CHUNK) !== cx || Math.floor(wz / CHUNK) !== cz)
          continue;
        this.matrix.position.set(
          wx - cx * CHUNK,
          heightAt(wx, wz) + 2.5,
          wz - cz * CHUNK,
        );
        this.matrix.rotation.set(0, 0, 0);
        this.matrix.scale.set(8, 5, 16);
        this.matrix.updateMatrix();
        buildings.push(this.matrix.matrix.clone());
      }
    const candidates = TREE_CANDIDATES[this.quality];
    for (let i = 0; i < candidates; i++) {
      const x = hash(cx * 97 + i, cz * 31) * CHUNK,
        z = hash(cx * 17, cz * 53 + i) * CHUNK,
        wx = cx * CHUNK + x,
        wz = cz * CHUNK + z,
        h = heightAt(wx, wz);
      if (h < 12 || h > 1050) continue;
      const masks = regionMasks(wx, wz);
      if (masks.infrastructure > 0.2) continue;
      const town = Math.hypot(wx + 900, wz) < 1800 && h < 330;
      if (town && i % 6 === 0) {
        const s = 0.7 + hash(i + 3, cx + cz) * 1.5;
        this.matrix.position.set(x, h + 10 * s, z);
        this.matrix.rotation.set(0, hash(i, cz) * Math.PI, 0);
        this.matrix.scale.set(18 * s, 20 * s, 28 * s);
        this.matrix.updateMatrix();
        buildings.push(this.matrix.matrix.clone());
        continue;
      }
      const nx = (heightAt(wx - 4, wz) - heightAt(wx + 4, wz)) / 8,
        nz = (heightAt(wx, wz - 4) - heightAt(wx, wz + 4)) / 8;
      const slope = 1 - 1 / Math.hypot(nx, 1, nz);
      const density = forestMask(wx, wz, h, slope, masks.moisture);
      if (density < 0.15 + hash(i + 91, cz - cx) * 0.7) continue;
      const s = 0.75 + hash(i + 3, cx + cz) * 0.7;
      this.matrix.position.set(x, h - 0.6, z);
      this.matrix.rotation.set(
        (hash(i, 7) - 0.5) * 0.12,
        hash(i, cz) * Math.PI * 2,
        (hash(i, 9) - 0.5) * 0.12,
      );
      this.matrix.scale.set(s, s * (0.85 + hash(i, 4) * 0.4), s);
      this.matrix.updateMatrix();
      trees.push({ m: this.matrix.matrix.clone(), tint: hash(i, 11) });
    }
    if (trees.length) {
      const mesh = new T.InstancedMesh(
        this.treeGeometry,
        this.treeMaterial,
        trees.length,
      );
      trees.forEach((t, i) => {
        mesh.setMatrixAt(i, t.m);
        // Per-tree hue and brightness variation.
        this.color.setRGB(
          0.75 + t.tint * 0.45,
          0.8 + t.tint * 0.3,
          0.7 + (1 - t.tint) * 0.35,
        );
        mesh.setColorAt(i, this.color);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    if (buildings.length) {
      const mesh = new T.InstancedMesh(
        this.buildingGeometry,
        this.buildingMaterial,
        buildings.length,
      );
      buildings.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
    group.position.set(
      cx * CHUNK - this.origin.x,
      0,
      cz * CHUNK - this.origin.z,
    );
    this.scene.add(group);
    this.chunks.set(key, group);
  }
  private removeChunk(key: string, group: T.Group) {
    this.scene.remove(group);
    group.children.forEach((child) => {
      if (child instanceof T.InstancedMesh) child.dispose();
    });
    this.chunks.delete(key);
  }
  get materialsReady() {
    return this.terrainMaterials.ready;
  }
  get materialError() {
    return this.terrainMaterials.loadError;
  }
  configure(renderer: T.WebGLRenderer) {
    this.terrainMaterials.configure(renderer);
  }
  setQuality(quality: WorldQuality) {
    const changed = quality !== this.quality;
    this.quality = quality;
    this.terrainMaterials.setQuality(quality);
    this.terrain.detail = quality === "low" ? 0.8 : quality === "high" ? 1.35 : 1;
    this.sun.castShadow = quality !== "low";
    const size = quality === "high" ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(size, size);
    }
    if (changed) {
      // Rebuild scenery at the new density.
      for (const [key, group] of this.chunks) this.removeChunk(key, group);
      this.lastCell = "";
    }
  }
  dispose() {
    const sharedMaterials = new Set<T.Material>([
      this.treeMaterial,
      this.buildingMaterial,
    ]);
    const geometries = new Set<T.BufferGeometry>();
    const materials = new Set<T.Material>();
    for (const root of [this.airfield, this.bridge]) {
      root.traverse((object) => {
        if (object instanceof T.Mesh) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            if (!sharedMaterials.has(material)) materials.add(material);
          if (object instanceof T.InstancedMesh) object.dispose();
        }
      });
      root.removeFromParent();
    }
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    this.sun.removeFromParent();
    this.sun.target.removeFromParent();
    this.sun.shadow.dispose();
    for (const [key, g] of this.chunks) this.removeChunk(key, g);
    this.terrain.mesh.removeFromParent();
    this.terrain.dispose();
    this.terrainMaterials.dispose();
    this.treeGeometry.dispose();
    this.treeMaterial.dispose();
    this.buildingGeometry.dispose();
    this.buildingMaterial.dispose();
  }
}
