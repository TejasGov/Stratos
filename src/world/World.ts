import * as T from "three";
import { CHUNK, hash, heightAt, buildTerrain, regionMasks } from "./terrain";
import {
  createOutdoorSky,
  createOutdoorEnvironment,
  createOcean,
  SUN_DIRECTION,
  WorldQuality,
} from "../render/OutdoorEnvironment";
import { CloudLayers } from "../render/CloudLayers";
import { RequestLedger, terrainTargets } from "./StreamingScheduler";
interface TerrainResult {
  requestId?: number;
  key: string;
  x: number;
  z: number;
  segments: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}
export class World {
  origin = new T.Vector3();
  chunks = new Map<string, T.Group>();
  private desired = new Map<
    string,
    { x: number; z: number; segments: number }
  >();
  private pending = new RequestLedger();
  private restartAt = 0;
  private restartAttempts = 0;
  private fallbackAt = 0;
  private droppedResults = 0;
  private uploads = 0;
  private uploadMilliseconds = 0;
  private results: TerrainResult[] = [];
  private worker = new Worker(new URL("./terrain.worker.ts", import.meta.url), {
    type: "module",
  });
  private lastCell = "";
  private mat = new T.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
  });
  private treeGeometry = new T.ConeGeometry(9, 34, 5);
  private treeMaterial = new T.MeshStandardMaterial({
    color: "#284a36",
    roughness: 1,
  });
  private buildingGeometry = new T.BoxGeometry(1, 1, 1);
  private buildingMaterial = new T.MeshStandardMaterial({
    color: "#c7c5ae",
    roughness: 0.9,
  });
  private airfield = new T.Group();
  private bridge = new T.Group();
  private water: T.Mesh;
  private sky: T.Mesh;
  private clouds = new CloudLayers();
  private environment?: T.WebGLRenderTarget;
  private hemisphere = new T.HemisphereLight("#c6ddf2", "#545544", 0.75);
  private sun = new T.DirectionalLight("#fff1d9", 2.5);
  private matrix = new T.Object3D();
  private worldTime = 0;
  workerError = false;
  constructor(private scene: T.Scene) {
    scene.fog = new T.FogExp2("#91b2bf", 0.000075);
    scene.add(this.hemisphere);
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
    this.mat.onBeforeCompile = (shader) => {
      shader.uniforms.terrainOrigin = { value: this.origin };
      shader.vertexShader =
        "uniform vec3 terrainOrigin; varying vec3 vTerrainPoint;\n" +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvTerrainPoint=(modelMatrix*vec4(position,1.)).xyz+terrainOrigin;",
      );
      shader.fragmentShader =
        "varying vec3 vTerrainPoint;\nfloat terrainHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}\nfloat terrainNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(terrainHash(i),terrainHash(i+vec2(1.,0.)),f.x),mix(terrainHash(i+vec2(0.,1.)),terrainHash(i+vec2(1.,1.)),f.x),f.y);}\n" +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        `#include <color_fragment>\nfloat detail=terrainNoise(vTerrainPoint.xz*.013)*.7+terrainNoise(vTerrainPoint.xz*.08)*.3;
float slope=1.-abs(normalize(cross(dFdx(vTerrainPoint),dFdy(vTerrainPoint))).y);
float shore=1.-smoothstep(5.,45.,vTerrainPoint.y);
vec3 rock=vec3(.16,.15,.13)*(0.8+detail*.3);
vec3 sand=vec3(.40,.34,.23)*(0.9+detail*.15);
diffuseColor.rgb*=.82+detail*.32;
diffuseColor.rgb=mix(diffuseColor.rgb,rock,smoothstep(.23,.62,slope)*.72);
diffuseColor.rgb=mix(diffuseColor.rgb,sand,shore*.62);`,
      );
    };
    this.sky = createOutdoorSky();
    scene.add(this.sky);
    this.water = createOcean();
    this.water.rotation.x = -Math.PI / 2;
    scene.add(this.water, this.clouds.mesh);
    this.createAirfield();
    this.createBridge();
    this.bindWorker();
  }
  private bindWorker() {
    const worker = this.worker;
    worker.onmessage = (e: MessageEvent<TerrainResult>) => {
      const data = e.data;
      if (
        worker !== this.worker ||
        !this.pending.finish(data.key, data.requestId ?? -1)
      )
        return;
      if (this.desired.has(data.key) && this.queuedBytes < 4 * 1024 * 1024)
        this.results.push(data);
      else this.droppedResults++;
      this.dispatch();
    };
    worker.onerror = () => this.failWorker();
    worker.onmessageerror = () => this.failWorker();
  }
  private failWorker() {
    this.worker.terminate();
    this.workerError = true;
    this.pending.clear();
    this.restartAt = this.worldTime + 3;
  }
  private get queuedBytes() {
    return this.results.reduce(
      (bytes, data) =>
        bytes +
        data.positions.byteLength +
        data.normals.byteLength +
        data.colors.byteLength +
        data.indices.byteLength,
      0,
    );
  }
  get stats() {
    return {
      chunks: this.chunks.size,
      pending: this.pending.size,
      queued: this.results.length,
      queuedBytes: this.queuedBytes,
      uploaded: this.uploads,
      staleDropped: this.droppedResults,
      workerFallback: this.workerError,
      restartAttempts: this.restartAttempts,
      uploadMilliseconds: this.uploadMilliseconds,
    };
  }

  private createAirfield() {
    const runway = new T.Mesh(
      new T.BoxGeometry(65, 1, 1050),
      new T.MeshStandardMaterial({ color: "#3c4c4b", roughness: 1 }),
    );
    runway.position.y = 29;
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
  private dispatch() {
    // Reserve headroom for the four already-running worker replies.
    if (this.workerError || this.queuedBytes >= 3 * 1024 * 1024) return;
    for (const [key, data] of this.desired) {
      if (this.pending.size >= 4) break;
      if (
        !this.chunks.has(key) &&
        !this.pending.has(key) &&
        !this.results.some((r) => r.key === key)
      ) {
        const requestId = this.pending.begin(key, this.worldTime);
        this.worker.postMessage({ key, ...data, requestId });
      }
    }
  }
  update(position: T.Vector3, dt: number, velocity?: T.Vector3) {
    this.worldTime += dt;
    const cx = Math.floor(position.x / CHUNK),
      cz = Math.floor(position.z / CHUNK),
      cell = `${cx},${cz}`;
    this.desired.clear();
    for (const t of terrainTargets(position, velocity))
      this.desired.set(`${t.x},${t.z},${t.segments}`, t);
    if (!this.workerError && this.pending.oldestAge(this.worldTime) > 8)
      this.failWorker();
    if (
      this.workerError &&
      this.restartAttempts < 2 &&
      this.worldTime >= this.restartAt
    ) {
      this.restartAttempts++;
      this.worker = new Worker(
        new URL("./terrain.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.workerError = false;
      this.bindWorker();
    }
    if (cell !== this.lastCell) {
      this.lastCell = cell;
      for (const [key, group] of this.chunks) {
        const parts = key.split(",").map(Number),
          replacement = [...this.desired.keys()].find((k) =>
            k.startsWith(`${parts[0]},${parts[1]},`),
          );
        if (
          !replacement ||
          (replacement !== key && this.chunks.has(replacement))
        )
          this.removeChunk(key, group);
      }
      this.results = this.results.filter((r) => this.desired.has(r.key));
      this.dispatch();
    }
    this.dispatch();
    if (this.workerError && this.worldTime >= this.fallbackAt) {
      const target = [...this.desired.values()].find(
        (t) =>
          ![...this.chunks.keys()].some((key) =>
            key.startsWith(`${t.x},${t.z},`),
          ),
      );
      if (target) {
        const key = `${target.x},${target.z},12`;
        this.addChunk(
          {
            key,
            x: target.x,
            z: target.z,
            segments: 12,
            ...buildTerrain(target.x, target.z, 12),
          },
          true,
        );
      }
      this.fallbackAt = this.worldTime + 0.25;
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
    // Keep one upload possible, then stop at 2 meshes, 2 MiB or 3 ms CPU installation.
    this.results.sort(
      (a, b) =>
        [...this.desired.keys()].indexOf(a.key) -
        [...this.desired.keys()].indexOf(b.key),
    );
    const uploadStart = performance.now();
    let uploadBytes = 0;
    for (let i = 0; i < 2 && this.results.length; i++) {
      if (
        i > 0 &&
        (performance.now() - uploadStart > 3 || uploadBytes >= 2 * 1024 * 1024)
      )
        break;
      const data = this.results.shift()!;
      uploadBytes +=
        data.positions.byteLength +
        data.normals.byteLength +
        data.colors.byteLength +
        data.indices.byteLength;
      this.addChunk(data);
    }
    this.uploadMilliseconds = performance.now() - uploadStart;
    this.water.position.set(
      position.x - this.origin.x,
      0,
      position.z - this.origin.z,
    );
    (this.water.material as T.ShaderMaterial).uniforms.time.value =
      this.worldTime;
    (this.water.material as T.ShaderMaterial).uniforms.offset.value.set(
      this.origin.x,
      this.origin.z,
    );
    this.sky.position.set(
      position.x - this.origin.x,
      position.y,
      position.z - this.origin.z,
    );
    this.clouds.update(position, this.origin, this.worldTime);
    this.airfield.position.set(-900 - this.origin.x, 0, -this.origin.z);
    this.bridge.position.set(2500 - this.origin.x, 0, -500 - this.origin.z);
    this.sun.target.position.set(
      Math.round(
        (position.x - this.origin.x) / (1800 / this.sun.shadow.mapSize.x),
      ) *
        (1800 / this.sun.shadow.mapSize.x),
      0,
      Math.round(
        (position.z - this.origin.z) / (1800 / this.sun.shadow.mapSize.x),
      ) *
        (1800 / this.sun.shadow.mapSize.x),
    );
    this.sun.position
      .copy(this.sun.target.position)
      .addScaledVector(SUN_DIRECTION, 6500);
  }
  private addChunk(data: TerrainResult, fallback = false) {
    if (!this.desired.has(data.key) && !fallback) return;
    this.uploads++;
    const group = new T.Group(),
      geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.BufferAttribute(data.positions, 3));
    geometry.setAttribute("normal", new T.BufferAttribute(data.normals, 3));
    geometry.setAttribute("color", new T.BufferAttribute(data.colors, 3));
    geometry.setIndex(new T.BufferAttribute(data.indices, 1));
    geometry.computeBoundingSphere();
    const terrain = new T.Mesh(geometry, this.mat);
    terrain.receiveShadow = true;
    group.add(terrain);
    if (data.segments >= 24) this.addScenery(group, data.x, data.z);
    group.position.set(
      data.x * CHUNK - this.origin.x,
      0,
      data.z * CHUNK - this.origin.z,
    );
    this.scene.add(group);
    this.chunks.set(data.key, group);
    for (const [key, other] of this.chunks)
      if (key !== data.key && key.startsWith(`${data.x},${data.z},`))
        this.removeChunk(key, other);
  }
  private addScenery(group: T.Group, cx: number, cz: number) {
    const trees: T.Matrix4[] = [],
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
    for (let i = 0; i < 90; i++) {
      const x = hash(cx * 97 + i, cz * 31) * CHUNK,
        z = hash(cx * 17, cz * 53 + i) * CHUNK,
        wx = cx * CHUNK + x,
        wz = cz * CHUNK + z,
        h = heightAt(wx, wz);
      if (
        h < 48 ||
        h > 650 ||
        regionMasks(wx, wz).infrastructure > 0.2 ||
        regionMasks(wx, wz).drainage > 0.65 ||
        Math.abs(heightAt(wx + 15, wz) - h) > 10
      )
        continue;
      const town = Math.hypot(wx + 900, wz) < 1800 && h < 330;
      const s = 0.7 + hash(i + 3, cx + cz) * 1.5;
      this.matrix.position.set(x, h + (town ? 10 * s : 16 * s), z);
      this.matrix.rotation.set(0, hash(i, cz) * Math.PI, 0);
      this.matrix.scale.set(
        town ? 18 * s : s,
        town ? 20 * s : s,
        town ? 28 * s : s,
      );
      this.matrix.updateMatrix();
      (town ? buildings : trees).push(this.matrix.matrix.clone());
    }
    for (const [list, geo, mat] of [
      [trees, this.treeGeometry, this.treeMaterial],
      [buildings, this.buildingGeometry, this.buildingMaterial],
    ] as const) {
      if (!list.length) continue;
      const mesh = new T.InstancedMesh(geo, mat, list.length);
      mesh.castShadow = true;
      list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
  private removeChunk(key: string, group: T.Group) {
    this.scene.remove(group);
    group.children.forEach((child) => {
      if (child instanceof T.InstancedMesh) child.dispose();
      else if (child instanceof T.Mesh) child.geometry.dispose();
    });
    this.chunks.delete(key);
  }
  createEnvironment(renderer: T.WebGLRenderer) {
    const previous = this.environment;
    this.environment = createOutdoorEnvironment(renderer);
    this.scene.environment = this.environment.texture;
    previous?.dispose();
    return this.environment.texture;
  }
  setQuality(quality: WorldQuality) {
    this.clouds.setQuality(quality);
    this.sun.castShadow = quality !== "low";
    const size = quality === "high" ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(size, size);
    }
    (this.water.material as T.ShaderMaterial).uniforms.detail.value =
      quality === "low" ? 0 : 1;
  }
  dispose() {
    this.worker.terminate();
    this.clouds.dispose();
    if (this.scene.environment === this.environment?.texture)
      this.scene.environment = null;
    this.environment?.dispose();
    const sharedMaterials = new Set<T.Material>([
      this.mat,
      this.treeMaterial,
      this.buildingMaterial,
    ]);
    const geometries = new Set<T.BufferGeometry>();
    const materials = new Set<T.Material>();
    for (const root of [this.airfield, this.bridge, this.water, this.sky]) {
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
    this.hemisphere.removeFromParent();
    for (const [key, g] of this.chunks) this.removeChunk(key, g);
    this.mat.dispose();
    this.treeGeometry.dispose();
    this.treeMaterial.dispose();
    this.buildingGeometry.dispose();
    this.buildingMaterial.dispose();
  }
}
