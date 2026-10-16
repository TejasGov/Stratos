import * as T from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Air-defence vehicles. Normalized like the shipped GLBs: front −Z, +Y up,
 * origin at ground centre, metres. Animated parts are found by name:
 * launcher "turret" (yaw) and "canisters" (elevation); radar "antenna" (yaw).
 */
export interface DefenseTemplates {
  launcher: T.Object3D;
  radar: T.Object3D;
}

export const DEFENSE_MODEL_URLS = {
  launcher: "/assets/defense/sam-launcher.glb",
  radar: "/assets/defense/sam-radar.glb",
} as const;

const OLIVE = new T.Color(0x5d6444),
  DARK = new T.Color(0x24261f),
  CANISTER = new T.Color(0x6e7453),
  PANEL = new T.Color(0x8b917a),
  EARTH = new T.Color(0x6f5f45);

const m = new T.Matrix4(),
  q = new T.Quaternion(),
  e = new T.Euler(),
  s = new T.Vector3(1, 1, 1),
  p = new T.Vector3();

/** One vertex-coloured mesh per moving part keeps each vehicle to a few draw calls. */
function build(parts: [T.BufferGeometry, T.Color, number, number, number, number?, number?][]) {
  const geometries = parts.map(([g, color, x, y, z, rx = 0, ry = 0]) => {
    const geometry = g.index ? g.toNonIndexed() : g;
    if (geometry !== g) g.dispose();
    geometry.applyMatrix4(m.compose(p.set(x, y, z), q.setFromEuler(e.set(rx, ry, 0)), s));
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set([color.r, color.g, color.b], i);
    geometry.setAttribute("color", new T.BufferAttribute(colors, 3));
    return geometry;
  });
  const merged = mergeGeometries(geometries)!;
  for (const g of geometries) g.dispose();
  return merged;
}

function chassis(): [T.BufferGeometry, T.Color, number, number, number, number?, number?][] {
  const wheels: [T.BufferGeometry, T.Color, number, number, number, number?, number?][] = [];
  for (const z of [-3, -0.6, 2.4])
    for (const x of [-1.25, 1.25])
      wheels.push([new T.CylinderGeometry(0.62, 0.62, 0.5, 10), DARK, x, 0.62, z, 0, 0]);
  for (const w of wheels) w[0].rotateZ(Math.PI / 2);
  return [
    [new T.BoxGeometry(2.6, 1, 8.6), OLIVE, 0, 1.45, 0],
    [new T.BoxGeometry(2.5, 1.7, 2), OLIVE, 0, 2.6, -3.3],
    [new T.BoxGeometry(2.3, 0.6, 0.1), DARK, 0, 2.95, -4.31],
    // Revetment berm: reads as a dug-in site from altitude.
    [new T.TorusGeometry(7.5, 1.3, 5, 18), EARTH, 0, 0.1, 0, Math.PI / 2],
    ...wheels,
  ];
}

/** Procedural placeholders used until the GLB models are present. */
export function createDefenseTemplates(): DefenseTemplates {
  const material = new T.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.2,
  });
  const launcher = new T.Group();
  launcher.name = "sam-launcher";
  launcher.add(new T.Mesh(build(chassis()), material));
  const turret = new T.Group();
  turret.name = "turret";
  turret.position.set(0, 2, 1.9);
  turret.add(
    new T.Mesh(
      build([
        [new T.CylinderGeometry(1.1, 1.2, 0.5, 12), DARK, 0, 0.25, 0],
        [new T.BoxGeometry(0.3, 1.1, 0.8), OLIVE, -1.05, 0.9, 1],
        [new T.BoxGeometry(0.3, 1.1, 0.8), OLIVE, 1.05, 0.9, 1],
      ]),
      material,
    ),
  );
  // Pivot at the rear of the canisters; they extend forward (−Z) and pitch up.
  const canisters = new T.Group();
  canisters.name = "canisters";
  canisters.position.set(0, 1.2, 1.4);
  const tubes: [T.BufferGeometry, T.Color, number, number, number, number?, number?][] = [];
  for (const x of [-0.33, 0.33])
    for (const y of [0.05, 0.71])
      tubes.push([new T.BoxGeometry(0.6, 0.6, 5.2), CANISTER, x, y, -2.6]);
  tubes.push([new T.BoxGeometry(1.4, 1.4, 0.15), DARK, 0, 0.38, -5.2]);
  canisters.add(new T.Mesh(build(tubes), material));
  turret.add(canisters);
  launcher.add(turret);
  const radar = new T.Group();
  radar.name = "sam-radar";
  radar.add(
    new T.Mesh(
      build([
        ...chassis(),
        [new T.CylinderGeometry(0.22, 0.32, 8.4, 8), DARK, 0, 6.1, 1.6],
        [new T.BoxGeometry(1.8, 1.2, 1.6), OLIVE, 0, 2.5, 1.6],
      ]),
      material,
    ),
  );
  const antenna = new T.Group();
  antenna.name = "antenna";
  antenna.position.set(0, 10.4, 1.6);
  antenna.add(
    new T.Mesh(
      build([
        [new T.BoxGeometry(4.4, 2.6, 0.22), PANEL, 0, 0.6, -0.1, -0.26],
        [new T.BoxGeometry(4.6, 0.18, 0.4), DARK, 0, -0.75, 0.25, -0.26],
        [new T.BoxGeometry(0.6, 0.6, 0.6), DARK, 0, 0, 0.35],
      ]),
      material,
    ),
  );
  radar.add(antenna);
  for (const root of [launcher, radar])
    root.traverse((o) => {
      if (o instanceof T.Mesh) o.castShadow = o.receiveShadow = true;
    });
  return { launcher, radar };
}

interface GltfLoaderLike {
  loadAsync(url: string): Promise<{ scene: T.Object3D }>;
}

/** Loads whichever GLBs exist; missing ones keep the procedural placeholder. */
export async function loadDefenseTemplates(
  loader: GltfLoaderLike,
  fallback: DefenseTemplates,
): Promise<DefenseTemplates> {
  const load = async (url: string, placeholder: T.Object3D) => {
    try {
      // A dev server answers missing files with index.html; check before parsing.
      const head = await fetch(url, { method: "HEAD" });
      if (!head.ok || (head.headers.get("content-type") ?? "").includes("text/html"))
        return placeholder;
      const gltf = await loader.loadAsync(url);
      gltf.scene.traverse((o) => {
        if (o instanceof T.Mesh) o.castShadow = o.receiveShadow = true;
      });
      return gltf.scene;
    } catch {
      return placeholder;
    }
  };
  const [launcher, radar] = await Promise.all([
    load(DEFENSE_MODEL_URLS.launcher, fallback.launcher),
    load(DEFENSE_MODEL_URLS.radar, fallback.radar),
  ]);
  return { launcher, radar };
}
