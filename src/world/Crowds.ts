import * as T from "three";
import type { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { BLACKRIDGE, BLACKRIDGE_TARGETS, HAVEN, type Base } from "./bases";
import { baseFrame, insideStructure, toWorld } from "./baseLayout";
import { GROUND_DROP } from "./basePads";

/** Mixamo cast and clips (public/assets/characters/mixamo/manifest.json). */
const DIR = "/assets/characters/mixamo/";
const CHARACTERS = ["swat", "steve", "david", "pete", "alex", "gasmask"] as const;
const CLIPS = [
  "walk", "jog", "idle", "idle-look", "talk", "talk-funny", "agree", "salute", "wave",
  "pushup", "jumping-jacks", "situps", "backflip", "dying-backwards",
] as const;
type CharId = (typeof CHARACTERS)[number];
export type ClipName = (typeof CLIPS)[number];

/** People are sub-pixel well before this; mixers stop and the crowd hides. */
const VISIBLE_RANGE = 2000;
/** Blackridge troops this close to a destroyed target go down with it. */
const STRIKE_RADIUS = 80;
const DRILL: ClipName[] = ["jumping-jacks", "pushup", "situps", "backflip"];
const DRILL_PERIOD = 9;

interface Loop {
  xs: number[];
  zs: number[];
  cum: number[];
  length: number;
}
interface Spec {
  base: Base;
  char: CharId;
  clip: ClipName;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Follows a closed route: distance offset along it and sideways from it. */
  path?: { loop: Loop; speed: number; along: number; side: number };
  drill?: boolean;
  /** Can die in a strike (Blackridge troops). */
  enemy?: boolean;
}
interface Actor {
  spec: Spec;
  root: T.Object3D;
  mixer: T.AnimationMixer;
  current?: T.AnimationAction;
  alive: boolean;
  dieAt: number;
}

function loop(points: { x: number; z: number }[]): Loop {
  const xs = points.map((p) => p.x),
    zs = points.map((p) => p.z),
    cum = [0];
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    cum.push(cum[i] + Math.hypot(xs[j] - xs[i], zs[j] - zs[i]));
  }
  return { xs, zs, cum, length: cum[points.length] };
}
/** Point and unit heading at distance `d` around a closed route, written into `out`. */
export function sampleLoop(l: Loop, d: number, out: { x: number; z: number; dx: number; dz: number }) {
  d = ((d % l.length) + l.length) % l.length;
  let i = 0;
  while (i < l.xs.length - 1 && d > l.cum[i + 1]) i++;
  const j = (i + 1) % l.xs.length,
    seg = l.cum[i + 1] - l.cum[i],
    t = seg > 0 ? (d - l.cum[i]) / seg : 0;
  out.dx = (l.xs[j] - l.xs[i]) / (seg || 1);
  out.dz = (l.zs[j] - l.zs[i]) / (seg || 1);
  out.x = l.xs[i] + (l.xs[j] - l.xs[i]) * t;
  out.z = l.zs[i] + (l.zs[j] - l.zs[i]) * t;
  return out;
}

/** World yaw for a figure (which faces +Z) looking along base-frame (lat, s). */
function yawAlong(base: Base, dl: number, ds: number) {
  const { f, r } = baseFrame(base);
  return Math.atan2(r.x * dl + f.x * ds, r.z * dl + f.z * ds);
}
function place(base: Base, lat: number, s: number, paved: boolean) {
  const p = toWorld(base, lat, s);
  return { x: p.x, z: p.z, y: base.runway.elevation - (paved ? 0 : GROUND_DROP) };
}
function rectLoop(base: Base, lat0: number, lat1: number, s0: number, s1: number) {
  return loop([[lat0, s0], [lat0, s1], [lat1, s1], [lat1, s0]].map(([l, s]) => toWorld(base, l, s)));
}
/** A ring of people facing each other. */
function huddle(base: Base, lat: number, s: number, chars: CharId[], clips: ClipName[], paved: boolean, extra: Partial<Spec> = {}): Spec[] {
  return chars.map((char, i) => {
    const a = (i / chars.length) * Math.PI * 2 + 0.4;
    const dl = Math.cos(a), ds = Math.sin(a);
    return { base, char, clip: clips[i % clips.length], ...place(base, lat + dl * 1.3, s + ds * 1.3, paved), yaw: yawAlong(base, -dl, -ds), ...extra };
  });
}

/** Everyone at both bases, in world coordinates. */
export function crowdSpecs(): Spec[] {
  const specs: Spec[] = [];
  const H = HAVEN, B = BLACKRIDGE;
  // Haven PT drill on the grass in front of the barracks, instructor out front.
  const pt: CharId[] = ["steve", "david", "pete", "alex", "gasmask"];
  for (let i = 0; i < 9; i++)
    specs.push({ base: H, char: pt[i % pt.length], clip: DRILL[0], ...place(H, -170 + (i % 3) * 3, -150 + Math.floor(i / 3) * 3, false), yaw: yawAlong(H, 0, 1), drill: true });
  specs.push({ base: H, char: "swat", clip: "talk", ...place(H, -167, -140, false), yaw: yawAlong(H, 0, -1) });
  // Crews chatting on the apron between the parked jets.
  specs.push(...huddle(H, 190, -95, ["david", "alex", "steve"], ["talk", "agree", "talk-funny"], true));
  specs.push(...huddle(H, 115, 60, ["pete", "gasmask", "swat"], ["idle", "talk", "idle-look"], true));
  // A squad walking the apron perimeter in single file.
  const apron = rectLoop(H, 100, 270, -240, 150);
  ["swat", "gasmask", "swat", "gasmask"].forEach((char, i) =>
    specs.push({ base: H, char: char as CharId, clip: "walk", x: 0, y: H.runway.elevation, z: 0, yaw: 0, path: { loop: apron, speed: 1.4, along: -i * 2.2, side: 0 } }),
  );
  // A jogging column around the barracks, two abreast, instructor alongside.
  const track = rectLoop(H, -245, -185, -340, 270);
  for (let i = 0; i < 6; i++)
    specs.push({ base: H, char: pt[(i + 2) % pt.length], clip: "jog", x: 0, y: H.runway.elevation - GROUND_DROP, z: 0, yaw: 0, path: { loop: track, speed: 2.8, along: -Math.floor(i / 2) * 1.8, side: i % 2 ? 0.9 : -0.9 } });
  specs.push({ base: H, char: "swat", clip: "jog", x: 0, y: H.runway.elevation - GROUND_DROP, z: 0, yaw: 0, path: { loop: track, speed: 2.8, along: -1.8, side: 2.6 } });
  // Ground crew by the threshold seeing every sortie off.
  specs.push({ base: H, char: "david", clip: "salute", ...place(H, 42, -700, false), yaw: yawAlong(H, -1, 0) });
  specs.push({ base: H, char: "pete", clip: "wave", ...place(H, 42, -712, false), yaw: yawAlong(H, -1, 0) });

  // Blackridge guards around each strike target, facing out.
  const y = B.runway.elevation - GROUND_DROP;
  for (const t of BLACKRIDGE_TARGETS)
    for (let i = 0; i < 3; i++) {
      // Step round the target until the post is clear of buildings and crates.
      let a = (i / 3) * Math.PI * 2 + 0.5;
      for (let k = 0; k < 12 && insideStructure(t.x + Math.sin(a) * 34, y + 1, t.z + Math.cos(a) * 34); k++) a += 0.2;
      specs.push({ base: B, char: i % 2 ? "swat" : "gasmask", clip: "idle-look", x: t.x + Math.sin(a) * 34, y, z: t.z + Math.cos(a) * 34, yaw: a, enemy: true });
    }
  const road = rectLoop(B, 330, 352, -300, 300);
  for (let i = 0; i < 4; i++)
    specs.push({ base: B, char: "gasmask", clip: "walk", x: 0, y: B.runway.elevation, z: 0, yaw: 0, enemy: true, path: { loop: road, speed: 1.4, along: -i * 2.2, side: 0 } });
  specs.push(...huddle(B, 270, 700, ["gasmask", "swat", "gasmask"], ["talk", "idle", "agree"], false, { enemy: true }));
  return specs;
}

/**
 * Soldiers and ground crew at the two bases: Mixamo characters sharing one
 * skeleton, one AnimationMixer each, paused and hidden beyond VISIBLE_RANGE.
 */
export class Crowds {
  readonly group = new T.Group();
  private actors: Actor[] = [];
  private clips = new Map<ClipName, T.AnimationClip>();
  private baseGroups = new Map<Base, T.Group>();
  private time = 0;
  private drillIndex = 0;
  private sample = { x: 0, z: 0, dx: 0, dz: 1 };

  constructor(scene: T.Scene) {
    this.group.name = "crowds";
    scene.add(this.group);
  }

  get count() {
    return this.actors.length;
  }

  /** Loads the cast and clips, then populates both bases. Failure leaves the bases empty. */
  async load(loader: GLTFLoader) {
    const [chars, clips] = await Promise.all([
      Promise.all(CHARACTERS.map((id) => loader.loadAsync(`${DIR}${id}.glb`))),
      Promise.all(CLIPS.map((id) => loader.loadAsync(`${DIR}clips/${id}.glb`))),
    ]);
    CLIPS.forEach((name, i) => {
      const clip = clips[i].animations[0];
      clip.name = name;
      this.clips.set(name, clip);
    });
    const templates = new Map<CharId, T.Object3D>();
    CHARACTERS.forEach((id, i) => {
      const root = chars[i].scene;
      root.traverse((o) => {
        if (!(o instanceof T.Mesh)) return;
        o.castShadow = true;
        // Skinned bounds are the bind pose; drills and falls leave it.
        o.frustumCulled = false;
        // Mixamo ships non-PBR maps; the FBX importer turns their specular into
        // metalness 0.5 and glossy roughness, so keep only colour and normals.
        const matte = (m: T.Material) =>
          m instanceof T.MeshStandardMaterial
            ? new T.MeshStandardMaterial({
                name: m.name,
                map: m.map,
                normalMap: m.normalMap,
                // Mixamo diffuse maps are authored dark; lift them to read in daylight.
                color: new T.Color().setScalar(1.4),
                roughness: 0.85,
                metalness: 0,
                envMapIntensity: 0.8,
              })
            : m;
        o.material = Array.isArray(o.material) ? o.material.map(matte) : matte(o.material);
      });
      templates.set(id, root);
    });
    for (const spec of crowdSpecs()) {
      let parent = this.baseGroups.get(spec.base);
      if (!parent) {
        parent = new T.Group();
        this.baseGroups.set(spec.base, parent);
        this.group.add(parent);
      }
      const root = cloneSkinned(templates.get(spec.char)!);
      root.position.set(spec.x, spec.y, spec.z);
      root.rotation.y = spec.yaw;
      parent.add(root);
      const actor: Actor = { spec, root, mixer: new T.AnimationMixer(root), alive: true, dieAt: Infinity };
      this.actors.push(actor);
      this.play(actor, spec.clip, 0);
      // Out of step with each other, except the drill, which moves as one.
      if (!spec.drill && actor.current) actor.current.time = Math.random() * actor.current.getClip().duration;
    }
  }

  private play(a: Actor, name: ClipName, fade = 0.35) {
    const clip = this.clips.get(name);
    if (!clip) return;
    const next = a.mixer.clipAction(clip);
    if (next === a.current) return;
    next.reset();
    if (name === "dying-backwards") {
      next.setLoop(T.LoopOnce, 1);
      next.clampWhenFinished = true;
    }
    next.play();
    if (a.current && fade > 0) a.current.crossFadeTo(next, fade, false);
    else a.current?.stop();
    a.current = next;
  }

  /** Blackridge troops near a destroyed target fall, the farthest a beat later. */
  strike(targetId: string) {
    const t = BLACKRIDGE_TARGETS.find((x) => x.id === targetId);
    if (!t) return;
    for (const a of this.actors) {
      if (!a.spec.enemy || !a.alive) continue;
      const d = Math.hypot(a.root.position.x - t.x, a.root.position.z - t.z);
      if (d > STRIKE_RADIUS) continue;
      a.alive = false;
      a.dieAt = this.time + d / 340 + Math.random() * 0.3;
    }
  }

  /** Everyone back on their feet and at their start positions for a new sortie. */
  reset() {
    this.time = 0;
    this.drillIndex = 0;
    for (const a of this.actors) {
      a.alive = true;
      a.dieAt = Infinity;
      a.root.position.set(a.spec.x, a.spec.y, a.spec.z);
      a.root.rotation.y = a.spec.yaw;
      a.mixer.stopAllAction();
      a.current = undefined;
      this.play(a, a.spec.clip, 0);
    }
  }

  update(dt: number, origin: T.Vector3, viewer: T.Vector3) {
    this.time += dt;
    this.group.position.set(-origin.x, -origin.y, -origin.z);
    for (const [base, g] of this.baseGroups) {
      const dx = viewer.x - base.runway.x, dz = viewer.z - base.runway.z;
      g.visible = dx * dx + dz * dz < VISIBLE_RANGE * VISIBLE_RANGE;
    }
    const drill = Math.floor(this.time / DRILL_PERIOD) % DRILL.length;
    const drillChanged = drill !== this.drillIndex;
    this.drillIndex = drill;
    const s = this.sample;
    for (const a of this.actors) {
      if (!a.root.parent?.visible) continue;
      const { spec } = a;
      if (a.dieAt <= this.time) {
        a.dieAt = Infinity;
        this.play(a, "dying-backwards", 0.15);
      }
      if (a.alive && spec.drill && drillChanged) this.play(a, DRILL[drill]);
      if (a.alive && spec.path) {
        const p = spec.path;
        sampleLoop(p.loop, p.along + this.time * p.speed, s);
        a.root.position.set(s.x - s.dz * p.side, spec.y, s.z + s.dx * p.side);
        // Ease round corners instead of snapping.
        const target = Math.atan2(s.dx, s.dz);
        const diff = ((target - a.root.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        a.root.rotation.y += diff * (1 - Math.exp(-6 * dt));
      }
      a.mixer.update(dt);
    }
  }

  dispose() {
    for (const a of this.actors) a.mixer.stopAllAction();
    this.group.removeFromParent();
  }
}
