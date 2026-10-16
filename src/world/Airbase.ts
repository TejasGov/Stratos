import * as T from "three";
import { BASES } from "./bases";
import { LAYOUTS, runwayDesignator, toWorld, baseFrame, type BaseLayout } from "./baseLayout";
import { BLACKRIDGE_STYLE, HAVEN_STYLE, buildBase, type BuiltGeometry, type PapiUnit, type Style } from "./airbase/build";
import { GlowLights, LightPools, type LightUniforms } from "./airbase/lights";
import {
  asphaltDetail,
  concreteTile,
  fenceTexture,
  latticeTexture,
  numeralAtlas,
  runwayWear,
  scorchTexture,
} from "./airbase/textures";

/** Beyond this the whole base is hidden (the bases are 8 km apart). */
const CULL_DISTANCE = 12000;
/** PAPI units only retune while the viewer is somewhere on a plausible approach. */
const PAPI_RANGE = 9000;

const WALL_GLSL_DECL = /* glsl */ `
varying vec3 vBasePos;
varying vec3 vBaseNrm;
`;

const WALL_GLSL_FRAG = /* glsl */ `
float bHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float bNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(bHash(i), bHash(i + vec3(1, 0, 0)), f.x), mix(bHash(i + vec3(0, 1, 0)), bHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(bHash(i + vec3(0, 0, 1)), bHash(i + vec3(1, 0, 1)), f.x), mix(bHash(i + vec3(0, 1, 1)), bHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
`;

const WALL_GLSL_BODY = /* glsl */ `
{
  vec3 n = normalize(vBaseNrm);
  float wall = 1.0 - smoothstep(0.4, 0.85, abs(n.y));
  float n1 = bNoise(vBasePos * 0.6) * 0.5 + bNoise(vBasePos * 2.3) * 0.3 + bNoise(vBasePos * 9.0) * 0.2;
  float grime = mix(0.84, 1.12, n1);
  float streak = bNoise(vec3((vBasePos.x + vBasePos.z) * 1.7, vBasePos.y * 0.07, 3.1));
  grime *= mix(1.0, 0.84 + 0.24 * streak, wall);
  float along = abs(n.x) > abs(n.z) ? vBasePos.z : vBasePos.x;
  vec2 fr = fract(vec2(along / 3.0, vBasePos.y / 2.4));
  vec2 seam = smoothstep(0.0, 0.03, fr) * (1.0 - smoothstep(0.97, 1.0, fr));
  grime *= mix(1.0, 0.8 + 0.2 * seam.x * seam.y, wall * 0.9);
  #ifdef CAMO
  float c1 = smoothstep(0.46, 0.54, bNoise(vBasePos * 0.045 + vec3(3.0)));
  float c2 = smoothstep(0.5, 0.58, bNoise(vBasePos * 0.07 + vec3(9.0, 1.0, 4.0)));
  diffuseColor.rgb *= mix(vec3(0.9, 0.92, 0.82), vec3(1.15, 1.06, 0.9), c1) * mix(1.0, 0.72, c2);
  #endif
  diffuseColor.rgb *= grime;
}
`;

/** Vertex-coloured structure material with procedural weathering and panel seams. */
function solidMaterial(camo: boolean) {
  const m = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02 });
  if (camo) m.defines = { CAMO: "" };
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${WALL_GLSL_DECL}`)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBasePos = position;\nvBaseNrm = normal;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${WALL_GLSL_DECL}\n${WALL_GLSL_FRAG}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${WALL_GLSL_BODY}`);
  };
  m.customProgramCacheKey = () => (camo ? "airbase-solid-camo" : "airbase-solid");
  return m;
}

/** Multiplies a fine tiled aggregate over the base map (runway wear texture). */
function withDetail(m: T.MeshStandardMaterial, detail: T.Texture, repeat: T.Vector2) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.tDetail = { value: detail };
    shader.uniforms.uDetailRepeat = { value: repeat };
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D tDetail;\nuniform vec2 uDetailRepeat;")
      .replace("#include <map_fragment>", "#include <map_fragment>\n#ifdef USE_MAP\ndiffuseColor.rgb *= 0.5 + 1.1 * texture2D(tDetail, vMapUv * uDetailRepeat).r;\n#endif");
  };
  m.customProgramCacheKey = () => "airbase-runway";
}

function windowMaterial() {
  const uniforms = {
    uDay: { value: new T.Color(0.035, 0.06, 0.085) },
    uNight: { value: new T.Color(3.4, 2.5, 1.3) },
    uMix: { value: 0 },
  };
  const m = new T.MeshBasicMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uDay;\nuniform vec3 uNight;\nuniform float uMix;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = mix(uDay, uNight * vColor.r, uMix);");
  };
  m.customProgramCacheKey = () => "airbase-windows";
  return { material: m, uniforms };
}

interface TargetView {
  intact: T.Object3D[];
  wreck: T.Object3D[];
  destroyed: boolean;
}

interface BaseView {
  id: string;
  group: T.Group;
  cx: number;
  cz: number;
  layout: BaseLayout;
  targets: Map<string, TargetView>;
  papi: GlowLights;
  papiUnits: (PapiUnit & { wx: number; wy: number; wz: number; fx: number; fz: number })[];
  papiState: number;
  windows: ReturnType<typeof windowMaterial>["uniforms"];
  pools: LightPools;
  parked: T.Group;
  parking: BuiltGeometry["parking"];
  pivot?: { group: T.Group; target: string };
  geometries: T.BufferGeometry[];
}

/**
 * Both air bases: Haven (home) and Blackridge (enemy). Static geometry is
 * merged per material, lights are instanced, and a whole base is hidden when
 * far away. Positions are shifted by the world's floating origin each frame.
 */
export class Airbase {
  readonly root = new T.Group();
  private views = new Map<string, BaseView>();
  private time = 0;
  private lamp: LightUniforms = { uTime: { value: 0 }, uLevel: { value: 1 } };
  private poolLevel = { uLevel: { value: 0 } };
  private disposables: { dispose(): void }[] = [];
  private lastNight = -1;

  constructor(scene: T.Scene) {
    const detail = asphaltDetail();
    this.disposables.push(detail);
    const scorch = scorchTexture();
    this.disposables.push(scorch);
    const lattice = latticeTexture();
    this.disposables.push(lattice);
    for (const base of BASES) {
      const layout = LAYOUTS[base.id];
      const style = base.id === "haven" ? HAVEN_STYLE : BLACKRIDGE_STYLE;
      this.views.set(base.id, this.createBase(layout, style, detail, scorch, lattice));
    }
    scene.add(this.root);
  }

  private createBase(layout: BaseLayout, style: Style, detail: T.Texture, scorch: T.Texture, lattice: T.Texture): BaseView {
    const { base } = layout;
    const enemy = base.side === "enemy";
    const geo = buildBase(layout, style);
    const group = new T.Group();
    const geometries: T.BufferGeometry[] = [];
    const track = <G extends T.BufferGeometry>(g: G) => (geometries.push(g), g);
    const own = <D extends { dispose(): void }>(d: D) => (this.disposables.push(d), d);
    group.rotation.y = base.runway.heading;

    const polygonOffset = (m: T.Material, f: number) => {
      m.polygonOffset = true;
      m.polygonOffsetFactor = f;
      m.polygonOffsetUnits = f;
    };
    const add = (g: T.BufferGeometry, m: T.Material, opts: { cast?: boolean; receive?: boolean; order?: number } = {}) => {
      const mesh = new T.Mesh(track(g), m);
      mesh.castShadow = !!opts.cast;
      mesh.receiveShadow = opts.receive ?? true;
      if (opts.order) mesh.renderOrder = opts.order;
      group.add(mesh);
      return mesh;
    };

    // Pavement: runway with its wear map, asphalt/concrete tiles, then paint on top.
    const wear = own(runwayWear({ seed: enemy ? 91 : 17, length: base.runway.length, width: base.runway.width, rubber: enemy ? 0.7 : 1, patches: enemy ? 70 : 38 }));
    const runwayMat = own(new T.MeshStandardMaterial({ map: wear, roughness: 0.93, metalness: 0 }));
    runwayMat.color.setRGB(enemy ? 0.15 : 0.19, enemy ? 0.15 : 0.195, enemy ? 0.145 : 0.2);
    withDetail(runwayMat, detail, new T.Vector2(base.runway.width / 6, base.runway.length / 6));
    polygonOffset(runwayMat, -2);
    add(geo.runway, runwayMat);

    const asphaltMat = own(new T.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.94 }));
    polygonOffset(asphaltMat, -2);
    add(geo.asphalt, asphaltMat);
    const concreteMat = own(new T.MeshStandardMaterial({ vertexColors: true, map: own(concreteTile(enemy ? 33 : 21, enemy ? 0.25 : 0)), roughness: 0.85 }));
    polygonOffset(concreteMat, -2);
    add(geo.concrete, concreteMat);

    const paint = own(new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }));
    polygonOffset(paint, -5);
    add(geo.markings, paint);
    const numeralMat = own(
      new T.MeshStandardMaterial({
        map: own(numeralAtlas(runwayDesignator(base, false), runwayDesignator(base, true))),
        color: 0xe9e9e1,
        roughness: 0.78,
        transparent: false,
        alphaToCoverage: true,
        alphaTest: 0,
      }),
    );
    polygonOffset(numeralMat, -6);
    numeralMat.side = T.DoubleSide;
    add(geo.numerals, numeralMat);

    // Structures and glass.
    const solidMat = own(solidMaterial(enemy));
    add(geo.solid, solidMat, { cast: true });
    const win = windowMaterial();
    own(win.material);
    add(geo.windows, win.material, { receive: false });
    const fenceMat = own(
      new T.MeshStandardMaterial({
        map: own(fenceTexture(style.barbed)),
        side: T.DoubleSide,
        alphaToCoverage: true,
        roughness: 0.6,
        metalness: 0.4,
      }),
    );
    fenceMat.color.setRGB(0.9, 0.92, 0.95);
    add(geo.fence, fenceMat, { receive: false });

    // Lights.
    const lamps = new GlowLights(geo.glows, this.lamp);
    own(lamps);
    group.add(lamps.mesh);
    const papi = new GlowLights(geo.papi, this.lamp);
    own(papi);
    group.add(papi.mesh);
    const pools = new LightPools(geo.pools, this.poolLevel);
    own(pools);
    group.add(pools.mesh);

    // Strike targets: intact and wrecked variants side by side.
    const targets = new Map<string, TargetView>();
    let pivot: BaseView["pivot"];
    const wreckMat = own(solidMaterial(true));
    const scorchMat = own(new T.MeshBasicMaterial({ map: scorch, color: 0x000000, transparent: true, depthWrite: false }));
    polygonOffset(scorchMat, -4);
    for (const [id, t] of Object.entries(geo.targets)) {
      const view: TargetView = { intact: [], wreck: [], destroyed: false };
      const intact = add(t.intact, solidMat, { cast: true });
      view.intact.push(intact);
      if (t.intactGlows.length) {
        const g = new GlowLights(t.intactGlows, this.lamp);
        own(g);
        group.add(g.mesh);
        view.intact.push(g.mesh);
      }
      if (t.antenna) {
        const holder = new T.Group();
        holder.position.set(t.antenna.x, t.antenna.y, t.antenna.z);
        const dishMat = own(
          new T.MeshStandardMaterial({ map: lattice, side: T.DoubleSide, alphaToCoverage: true, roughness: 0.6, metalness: 0.3 }),
        );
        dishMat.color.copy(new T.Color(style.wall[0], style.wall[1], style.wall[2]).multiplyScalar(1.4));
        const dish = new T.Mesh(track(t.antenna.dish), dishMat);
        dish.castShadow = true;
        const arm = new T.Mesh(track(t.antenna.frame), solidMat);
        arm.castShadow = true;
        holder.add(dish, arm);
        group.add(holder);
        view.intact.push(holder);
        pivot = { group: holder, target: id };
      }
      const wreck = add(t.wreck, wreckMat, { cast: true });
      wreck.visible = false;
      view.wreck.push(wreck);
      if (t.wreckGlows.length) {
        const g = new GlowLights(t.wreckGlows, this.lamp);
        own(g);
        g.mesh.visible = false;
        group.add(g.mesh);
        view.wreck.push(g.mesh);
      }
      for (const sc of t.scorch) {
        const plane = new T.Mesh(track(new T.PlaneGeometry(sc.r * 2, sc.r * 2).rotateX(-Math.PI / 2)), scorchMat);
        plane.position.set(sc.x, base.runway.elevation + 0.1, sc.z);
        plane.visible = false;
        plane.renderOrder = 2;
        group.add(plane);
        view.wreck.push(plane);
      }
      targets.set(id, view);
    }

    const parked = new T.Group();
    group.add(parked);
    this.root.add(group);

    const unitView = geo.papiUnits.map((u) => {
      const lat = u.x, s = -u.z;
      const w = toWorld(base, lat, s);
      const f = baseFrame(base).f;
      return { ...u, wx: w.x, wy: u.y, wz: w.z, fx: f.x * u.dir, fz: f.z * u.dir };
    });

    return {
      id: base.id,
      group,
      cx: base.runway.x,
      cz: base.runway.z,
      layout,
      targets,
      papi,
      papiUnits: unitView,
      papiState: -1,
      windows: win.uniforms,
      pools,
      parked,
      parking: geo.parking,
      pivot,
      geometries,
    };
  }

  /**
   * Parks cloned fleet models on Haven's apron (one per stand, cycling through
   * `models`). Models are expected in aircraft frame, nose toward −Z.
   */
  setParkedAircraft(models: T.Object3D[], baseId = "haven") {
    const view = this.views.get(baseId);
    if (!view) return;
    view.parked.clear();
    if (!models.length) return;
    const E = LAYOUTS[baseId].base.runway.elevation;
    const box = new T.Box3();
    view.parking.forEach((slot, i) => {
      const clone = models[i % models.length].clone(true);
      const pivot = new T.Group();
      pivot.add(clone);
      box.setFromObject(pivot);
      pivot.position.set(slot.x, E - box.min.y + 0.55, slot.z);
      pivot.rotation.y = slot.yaw + ((i * 0.37) % 0.12) - 0.06;
      view.parked.add(pivot);
    });
  }

  /** Swaps a strike target (radar, fuel, shelters) for its burnt-out wreck. */
  destroy(targetId: string) {
    for (const view of this.views.values()) {
      const t = view.targets.get(targetId);
      if (!t) continue;
      t.destroyed = true;
      t.intact.forEach((o) => (o.visible = false));
      t.wreck.forEach((o) => (o.visible = true));
    }
  }

  isDestroyed(targetId: string) {
    for (const view of this.views.values()) {
      const t = view.targets.get(targetId);
      if (t) return t.destroyed;
    }
    return false;
  }

  /** Restores every target for a new sortie. */
  reset() {
    for (const view of this.views.values())
      for (const t of view.targets.values()) {
        t.destroyed = false;
        t.intact.forEach((o) => (o.visible = true));
        t.wreck.forEach((o) => (o.visible = false));
      }
  }

  /**
   * Per-frame update. `position` is the aircraft/camera in global metres,
   * `origin` the world's floating origin, `night` 0 (day) to 1 (dark).
   */
  update(dt: number, origin: T.Vector3, position: T.Vector3, night: number) {
    this.time += dt;
    this.lamp.uTime.value = this.time;
    if (Math.abs(night - this.lastNight) > 0.004) {
      this.lastNight = night;
      // Lamps stay faintly visible by day; floodlight pools and windows come up at dusk.
      this.lamp.uLevel.value = 0.12 + 0.88 * night;
      this.poolLevel.uLevel.value = Math.max(0, (night - 0.25) / 0.75) ** 1.2;
      for (const view of this.views.values()) view.windows.uMix.value = Math.max(0, (night - 0.2) / 0.8);
    }
    for (const view of this.views.values()) {
      const dx = position.x - view.cx, dz = position.z - view.cz;
      const near = dx * dx + dz * dz < CULL_DISTANCE * CULL_DISTANCE;
      view.group.visible = near;
      if (!near) continue;
      view.group.position.set(view.cx - origin.x, -origin.y, view.cz - origin.z);
      if (view.pivot && !view.targets.get(view.pivot.target)?.destroyed) view.pivot.group.rotation.y += dt * 1.05;
      if (dx * dx + dz * dz < PAPI_RANGE * PAPI_RANGE) this.updatePapi(view, position);
    }
  }

  /** PAPI lamps turn red as the viewer sinks below the 3° glidepath. */
  private updatePapi(view: BaseView, p: T.Vector3) {
    let state = 0;
    for (let i = 0; i < view.papiUnits.length; i++) {
      const u = view.papiUnits[i];
      // Distance back along the approach (positive when the viewer is on the approach side).
      const back = -((p.x - u.wx) * u.fx + (p.z - u.wz) * u.fz);
      const angle = back > 150 ? (Math.atan2(p.y - u.wy, back) * 180) / Math.PI : 90;
      const white = angle > u.threshold;
      state |= (white ? 1 : 0) << i;
    }
    if (state === view.papiState) return;
    view.papiState = state;
    view.papiUnits.forEach((u, i) => {
      if ((state >> i) & 1) view.papi.setColor(u.glow, 9, 8.6, 7.8);
      else view.papi.setColor(u.glow, 10, 0.6, 0.35);
    });
  }

  dispose() {
    for (const view of this.views.values()) {
      view.group.removeFromParent();
      view.geometries.forEach((g) => g.dispose());
    }
    this.root.removeFromParent();
    this.disposables.forEach((d) => d.dispose());
    this.views.clear();
  }
}
