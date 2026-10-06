import * as T from "three";
import { CHUNK, hash, heightAt } from "./terrain";
interface TerrainResult {
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
  private pending = new Set<string>();
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
  private clouds: T.InstancedMesh;
  private sun = new T.DirectionalLight("#fff2d1", 2.0);
  private matrix = new T.Object3D();
  private worldTime = 0;
  workerError = false;
  constructor(private scene: T.Scene) {
    scene.fog = new T.FogExp2("#b1ced0", 0.000075);
    scene.add(new T.HemisphereLight("#d3efff", "#556e54", 1.15));
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
        "#include <color_fragment>\nfloat detail=terrainNoise(vTerrainPoint.xz*.013)*.7+terrainNoise(vTerrainPoint.xz*.08)*.3;diffuseColor.rgb*=.7+detail*.5;",
      );
    };
    this.sky = new T.Mesh(
      new T.SphereGeometry(17000, 32, 20),
      new T.ShaderMaterial({
        side: T.BackSide,
        depthWrite: false,
        uniforms: {},
        vertexShader: `varying vec3 vDirection; void main(){ vDirection=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
        fragmentShader: `varying vec3 vDirection; void main(){vec3 d=normalize(vDirection); float h=max(d.y,0.); vec3 c=mix(vec3(.72,.83,.82),vec3(.17,.42,.56),pow(h,.48)); float s=max(dot(d,normalize(vec3(-.65,.28,-.6))),0.); c+=vec3(1.,.7,.34)*pow(s,140.)*.3+vec3(1.,.92,.72)*smoothstep(.9995,.9999,s); gl_FragColor=vec4(c,1.);}`,
      }),
    );
    scene.add(this.sky);
    const waterMaterial = new T.ShaderMaterial({
      uniforms: { time: { value: 0 }, offset: { value: new T.Vector2() } },
      vertexShader: `varying vec3 vWorld; varying float vDepth; void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;vec4 p=viewMatrix*w;vDepth=-p.z;gl_Position=projectionMatrix*p;}`,
      fragmentShader: `uniform float time; uniform vec2 offset; varying vec3 vWorld; varying float vDepth; void main(){vec2 p=vWorld.xz+offset; float a=sin(p.x*.018+p.y*.012+time*.7); float b=sin(p.x*.041-p.y*.025-time*.9); float ripple=a*b; vec3 c=vec3(.055,.30,.36)+ripple*.014; float streak=pow(max(0.,sin(p.x*.025+p.y*.02+time)),24.)*.025;c+=vec3(streak); float fog=1.-exp(-max(vDepth,0.)*.000095);c=mix(c,vec3(.69,.81,.82),fog);gl_FragColor=vec4(c,1.);}`,
    });
    this.water = new T.Mesh(new T.PlaneGeometry(150000, 150000), waterMaterial);
    this.water.rotation.x = -Math.PI / 2;
    scene.add(this.water);
    this.clouds = new T.InstancedMesh(
      new T.SphereGeometry(1, 7, 5),
      new T.MeshStandardMaterial({
        color: "#e6eee9",
        roughness: 1,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      }),
      48,
    );
    for (let i = 0; i < 48; i++) {
      this.matrix.position.set(
        (hash(i, 3) - 0.5) * 22000,
        2400 + hash(i, 4) * 1300,
        (hash(i, 5) - 0.5) * 22000,
      );
      this.matrix.scale.set(
        300 + hash(i, 6) * 500,
        55 + hash(i, 7) * 100,
        180 + hash(i, 8) * 400,
      );
      this.matrix.updateMatrix();
      this.clouds.setMatrixAt(i, this.matrix.matrix);
    }
    scene.add(this.clouds);
    this.createAirfield();
    this.createBridge();
    this.worker.onmessage = (e) => {
      this.pending.delete(e.data.key);
      if (this.desired.has(e.data.key)) this.results.push(e.data);
      this.dispatch();
    };
    this.worker.onerror = () => {
      this.workerError = true;
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
    if (this.workerError) return;
    for (const [key, data] of this.desired) {
      if (this.pending.size >= 4) break;
      if (
        !this.chunks.has(key) &&
        !this.pending.has(key) &&
        !this.results.some((r) => r.key === key)
      ) {
        this.pending.add(key);
        this.worker.postMessage({ key, ...data });
      }
    }
  }
  update(position: T.Vector3, dt: number) {
    this.worldTime += dt;
    const cx = Math.floor(position.x / CHUNK),
      cz = Math.floor(position.z / CHUNK),
      cell = `${cx},${cz}`;
    if (cell !== this.lastCell) {
      this.lastCell = cell;
      this.desired.clear();
      const targets = [];
      for (let z = -4; z <= 4; z++)
        for (let x = -4; x <= 4; x++)
          targets.push({
            x: cx + x,
            z: cz + z,
            segments:
              Math.max(Math.abs(x), Math.abs(z)) <= 1
                ? 48
                : Math.max(Math.abs(x), Math.abs(z)) <= 2
                  ? 24
                  : 12,
            d: x * x + z * z,
          });
      targets.sort((a, b) => a.d - b.d);
      for (const t of targets)
        this.desired.set(`${t.x},${t.z},${t.segments}`, t);
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
    for (let i = 0; i < 2 && this.results.length; i++)
      this.addChunk(this.results.shift()!);
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
    this.clouds.position.set(
      Math.floor(position.x / 12000) * 12000 - this.origin.x,
      0,
      Math.floor(position.z / 12000) * 12000 - this.origin.z,
    );
    this.airfield.position.set(-900 - this.origin.x, 0, -this.origin.z);
    this.bridge.position.set(2500 - this.origin.x, 0, -500 - this.origin.z);
    this.sun.target.position.set(
      position.x - this.origin.x,
      0,
      position.z - this.origin.z,
    );
    this.sun.position
      .copy(this.sun.target.position)
      .add(new T.Vector3(-2500, 4500, 1800));
  }
  private addChunk(data: TerrainResult) {
    if (!this.desired.has(data.key)) return;
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
    for (let i = 0; i < 90; i++) {
      const x = hash(cx * 97 + i, cz * 31) * CHUNK,
        z = hash(cx * 17, cz * 53 + i) * CHUNK,
        wx = cx * CHUNK + x,
        wz = cz * CHUNK + z,
        h = heightAt(wx, wz);
      if (h < 48 || h > 650 || Math.abs(heightAt(wx + 15, wz) - h) > 10)
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
  dispose() {
    this.worker.terminate();
    for (const [key, g] of this.chunks) this.removeChunk(key, g);
    this.mat.dispose();
    this.treeGeometry.dispose();
    this.treeMaterial.dispose();
    this.buildingGeometry.dispose();
    this.buildingMaterial.dispose();
  }
}
