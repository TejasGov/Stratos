import * as T from "three";
import { ParticleBatch } from "./batch";
import {
  DistanceSampler,
  flareBurn,
  planSalvo,
  stepBallistic,
  type Ballistic,
  type FlarePlan,
  type Particle,
  type ParticlePool,
  type Point3,
} from "./particle-core";

export type EffectsQuality = "low" | "medium" | "high";
/** Visible-instance caps per batch [alpha smoke, additive fire]; pools are sized for the high tier. */
const LIMITS = {
  low: [650, 420],
  medium: [1500, 900],
  high: [2400, 1400],
} as const;
const DENSITY = { low: 0.55, medium: 1, high: 1.35 } as const;
const WIND = { x: 2.4, y: 0, z: 0.7 },
  STILL = { x: 0, y: 0, z: 0 };
/** Fire-atlas cells. */
const GLOW = 0,
  HALO = 1,
  CORE = 2,
  STAR = 3,
  SPARK = 4,
  RING = 5,
  RING_SOFT = 6,
  FLAME = 8;
/** Smoke-atlas cells: 0-11 puffs, 12-13 dust, 14-15 chunks. */
const FIREBALL = 8,
  DUST = 12,
  CHUNK = 14;

interface Cartridge extends Ballistic {
  active: boolean;
  wait: number;
  age: number;
  life: number;
  seed: number;
  puffs: number;
  sparks: number;
  embers: number;
  burn: number;
}
interface Chunk extends Ballistic {
  active: boolean;
  age: number;
  life: number;
  size: number;
  hot: number;
  seed: number;
  spin: number;
  puffs: number;
}
interface Pending {
  active: boolean;
  wait: number;
  x: number;
  y: number;
  z: number;
  scale: number;
  ground: boolean;
}
/** A lingering fire at the foot of a ground explosion, feeding a smoke column. */
interface Site {
  active: boolean;
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
  scale: number;
  smoke: number;
  fire: number;
}
interface BlastLight {
  active: boolean;
  x: number;
  y: number;
  z: number;
  peak: number;
  age: number;
  range: number;
}
interface MissileTrail {
  sampler: DistanceSampler;
  age: number;
  x: number;
  y: number;
  z: number;
  seen: boolean;
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** World positions are authoritative doubles. Conversion to origin-relative floats occurs only at upload. */
export class Effects {
  readonly group = new T.Group();
  /** Optional terrain query so debris lands on the ground. */
  groundHeight?: (x: number, z: number) => number;
  /** Point lights that let flares and blasts light the jet and terrain; kept in the scene (layer 0). */
  private readonly lights = [0, 1].map(() => {
    const light = new T.PointLight(0xffd7a0, 0, 150, 2);
    light.name = "effects-light";
    return light;
  });
  private smoke = new ParticleBatch(2400, false);
  private flame = new ParticleBatch(1400, true);
  private quality: EffectsQuality = "medium";
  private missiles = new Map<string | number, MissileTrail>();
  private damage = new Map<
    string | number,
    { sampler: DistanceSampler; time: number }
  >();
  private cartridges: Cartridge[] = Array.from({ length: 24 }, () => ({
    active: false,
    wait: 0,
    age: 0,
    life: 1,
    seed: 0,
    puffs: 0,
    sparks: 0,
    embers: 0,
    burn: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
  }));
  private chunks: Chunk[] = Array.from({ length: 40 }, () => ({
    active: false,
    age: 0,
    life: 1,
    size: 1,
    hot: 0,
    seed: 0,
    spin: 0,
    puffs: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
  }));
  private pending: Pending[] = Array.from({ length: 16 }, () => ({
    active: false,
    wait: 0,
    x: 0,
    y: 0,
    z: 0,
    scale: 0,
    ground: false,
  }));
  private sites: Site[] = Array.from({ length: 6 }, () => ({
    active: false,
    x: 0,
    y: 0,
    z: 0,
    age: 0,
    life: 1,
    scale: 1,
    smoke: 0,
    fire: 0,
  }));
  private blasts: BlastLight[] = Array.from({ length: 4 }, () => ({
    active: false,
    x: 0,
    y: 0,
    z: 0,
    peak: 0,
    age: 0,
    range: 100,
  }));
  private plan: FlarePlan[] = [];
  private dir = { x: 0, y: 0, z: 0 };
  private viewer = { x: 0, y: 0, z: 0 };
  private viewerKnown = false;
  private lightDir = new T.Vector3(0.4, 0.8, 0.4);
  private lightView = new T.Vector3();
  private sunColor = new T.Color(1, 0.95, 0.85);
  private sunIntensity = 3;
  private daylight = 1;
  private seed = 7297;
  private disposed = false;
  constructor(scene?: T.Scene, quality: EffectsQuality = "medium") {
    this.quality = quality;
    this.group.name = "combat-effects";
    this.group.add(this.smoke.mesh, this.flame.mesh);
    scene?.add(this.group);
    // Always present (intensity 0 when idle) so lit materials never recompile when a flare fires.
    for (const light of this.lights) scene?.add(light);
  }
  private random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  private between(a: number, b: number) {
    return a + (b - a) * this.random();
  }
  /** Uniform random unit vector into `this.dir`. */
  private sphere() {
    const z = this.random() * 2 - 1,
      angle = this.random() * Math.PI * 2,
      ring = Math.sqrt(1 - z * z);
    this.dir.x = ring * Math.cos(angle);
    this.dir.y = z;
    this.dir.z = ring * Math.sin(angle);
    return this.dir;
  }
  private get density() {
    return DENSITY[this.quality];
  }
  /** 1 near the player, thinning to 0.4 for blasts kilometres away. */
  private lod(x: number, y: number, z: number) {
    if (!this.viewerKnown) return 1;
    const distance = Math.hypot(
      x - this.viewer.x,
      y - this.viewer.y,
      z - this.viewer.z,
    );
    return 1 - 0.6 * smoothstep(3000, 14000, distance);
  }
  /** Keeps distant point-like sources visible: never smaller than a few pixels. */
  private apparent(size: number, x: number, y: number, z: number) {
    if (!this.viewerKnown) return size;
    return Math.max(
      size,
      Math.hypot(x - this.viewer.x, y - this.viewer.y, z - this.viewer.z) *
        0.0038,
    );
  }
  private room(pool: ParticlePool, fraction: number) {
    return pool.count < pool.capacity * fraction;
  }
  /** Lit alpha puff (smoke, dust, soot, fireball body). */
  private puff(
    x: number,
    y: number,
    z: number,
    life: number,
    size: number,
    growth: number,
    opacity: number,
    r: number,
    g: number,
    b: number,
    cell = -1,
  ): Particle | undefined {
    const p = this.smoke.pool.acquire();
    if (!p) return;
    p.x = x;
    p.y = y;
    p.z = z;
    p.life = life;
    p.size = size;
    p.growth = growth;
    p.opacity = opacity;
    p.r = r;
    p.g = g;
    p.b = b;
    p.rotation = this.random() * Math.PI * 2;
    p.frame = cell >= 0 ? cell : Math.floor(this.random() * 12);
    return p;
  }
  /** Additive glow, flame, spark or ring. */
  private glow(
    x: number,
    y: number,
    z: number,
    life: number,
    size: number,
    growth: number,
    opacity: number,
    r: number,
    g: number,
    b: number,
    cell: number,
  ): Particle | undefined {
    const p = this.flame.pool.acquire();
    if (!p) return;
    p.x = x;
    p.y = y;
    p.z = z;
    p.life = life;
    p.size = size;
    p.growth = growth;
    p.opacity = opacity;
    p.r = r;
    p.g = g;
    p.b = b;
    p.rotation = this.random() * Math.PI * 2;
    p.frame = cell;
    return p;
  }
  /** A glow that exists for exactly one rendered frame (born after the step, killed by the next). */
  private blink(
    x: number,
    y: number,
    z: number,
    size: number,
    r: number,
    g: number,
    b: number,
    cell: number,
    opacity = 1,
  ) {
    const p = this.glow(x, y, z, 0.0005, size, 0, opacity, r, g, b, cell);
    if (p) {
      p.attack = 0;
      p.decay = 0;
    }
    return p;
  }
  setQuality(quality: EffectsQuality) {
    this.quality = quality;
  }
  /** Sun/moon light for shading smoke: direction toward the light, its colour and illuminance (3 = full sun). */
  setLighting(direction: Point3, color: T.Color, intensity: number) {
    this.lightDir.set(direction.x, direction.y, direction.z).normalize();
    this.sunColor.copy(color);
    this.sunIntensity = intensity;
    this.daylight =
      smoothstep(0.4, 2, intensity) * smoothstep(-0.12, 0.3, this.lightDir.y);
  }
  get stats() {
    return {
      smoke: this.smoke.pool.count,
      flame: this.flame.pool.count,
      rendered:
        this.smoke.geometry.instanceCount + this.flame.geometry.instanceCount,
    };
  }
  /** Active simulated sources, for diagnostics. */
  get sources() {
    const live = (list: { active: boolean }[]) =>
      list.filter((e) => e.active).length;
    return {
      cartridges: live(this.cartridges),
      chunks: live(this.chunks),
      sites: live(this.sites),
      pending: live(this.pending),
      missiles: this.missiles.size,
    };
  }

  // ---- Explosions -------------------------------------------------------------------------

  /**
   * Scale ~0.3 missile proximity burst, 1 aircraft, 3-6 fuel depot. `ground` adds a dust
   * ring and column, dirt clods, debris and a smoke column that burns for tens of seconds.
   */
  emitExplosion(position: Point3, scale = 1, kind: "air" | "ground" = "air") {
    scale = T.MathUtils.clamp(scale, 0.2, 8);
    const d = this.density * this.lod(position.x, position.y, position.z);
    this.burst(
      position.x,
      position.y,
      position.z,
      scale,
      d,
      kind === "ground",
      true,
    );
  }
  private burst(
    x: number,
    y: number,
    z: number,
    S: number,
    d: number,
    ground: boolean,
    primary: boolean,
  ) {
    const R = 16 * Math.pow(S, 0.85),
      sqrtS = Math.sqrt(S);
    // Ground blasts are centred above the impact so the fireball sits on the terrain, not in it.
    const ground0 = y,
      cy = y + (ground ? R * 0.45 : 0);
    // Flash: an instant HDR whiteout, a glare cross and an orange scatter halo.
    const scatter = this.glow(
      x,
      cy,
      z,
      0.5,
      9 * R,
      2 * R,
      0.5,
      3.2,
      1.4,
      0.45,
      HALO,
    );
    if (scatter) scatter.decay = 1.6;
    const flash = this.glow(
      x,
      cy,
      z,
      0.15 + 0.05 * sqrtS,
      4.5 * R,
      0,
      1,
      50,
      42,
      28,
      CORE,
    );
    if (flash) {
      flash.attack = 0;
      flash.decay = 2;
    }
    const glare = this.glow(
      x,
      cy,
      z,
      0.22,
      6 * R,
      R,
      0.75,
      9,
      7.5,
      4,
      STAR,
    );
    if (glare) {
      glare.attack = 0;
      glare.decay = 1.6;
    }
    // The pressure front: a bright pale sphere that races out and a thin ring on its limb.
    const sphere = this.glow(
      x,
      cy,
      z,
      0.24,
      1.5 * R,
      12 * R,
      0.4,
      2.2,
      1.9,
      1.4,
      HALO,
    );
    if (sphere) {
      sphere.attack = 0;
      sphere.ease = 6;
      sphere.decay = 1.5;
    }
    const ringStrength = T.MathUtils.clamp(S / 0.8, 0.35, 1);
    const ring = this.glow(
      x,
      cy,
      z,
      0.45,
      0.5 * R,
      38 * R,
      0.3 * ringStrength,
      2.4,
      2.2,
      1.9,
      RING,
    );
    if (ring) {
      ring.attack = 0;
      ring.ease = 5;
      ring.decay = 1.3;
    }
    if (ground) {
      const flat = this.glow(
        x,
        ground0 + 0.6,
        z,
        0.75,
        0.5 * R,
        60 * R,
        0.4 * ringStrength,
        1.7,
        1.45,
        1.1,
        RING_SOFT,
      );
      if (flat) {
        flat.mode = 1;
        flat.attack = 0;
        flat.ease = 4.2;
        flat.decay = 1.2;
      }
    }
    // Fireball body: lit turbulent billows, white-hot at birth, cooling through orange to soot.
    const body = Math.round((10 + 8 * sqrtS) * d);
    for (let i = 0; i < body; i++) {
      const u = this.sphere();
      if (ground) u.y = Math.abs(u.y) * 0.85 + 0.1;
      const reach = R * 0.3 * Math.sqrt(this.random()),
        speed = R * this.between(0.8, 1.8);
      const p = this.puff(
        x + u.x * reach,
        cy + u.y * reach,
        z + u.z * reach,
        this.between(2.4, 4.2) + 0.4 * sqrtS,
        R * this.between(0.3, 0.6),
        R * this.between(0.6, 1.0) * 2,
        0.9,
        0.045,
        0.04,
        0.04,
        FIREBALL + Math.floor(this.random() * 4),
      );
      if (!p) break;
      p.vx = u.x * speed;
      p.vy = u.y * speed;
      p.vz = u.z * speed;
      p.drag = 2.1;
      p.lift = 5 + 1.2 * sqrtS;
      p.ease = 2;
      p.heat = 1;
      p.cool = this.between(0.7, 1.3);
      p.erode = 0.6;
      p.attack = 0.02;
      p.decay = 1.5;
      p.spin = this.between(-0.6, 0.6);
      p.wind = 0.3;
    }
    // Incandescent core: additive flame blobs that give the first half-second its blinding punch.
    const core = Math.round((4 + 3 * sqrtS) * d);
    for (let i = 0; i < core; i++) {
      const u = this.sphere();
      if (ground) u.y = Math.abs(u.y) * 0.85 + 0.1;
      const reach = R * 0.22 * Math.sqrt(this.random());
      const p = this.glow(
        x + u.x * reach,
        cy + u.y * reach,
        z + u.z * reach,
        this.between(0.35, 0.85),
        R * this.between(0.7, 1.3),
        R * 1.2,
        0.9,
        1.3,
        1.3,
        1.3,
        FLAME + Math.floor(this.random() * 8),
      );
      if (!p) break;
      const speed = R * this.between(0.3, 1.1);
      p.vx = u.x * speed;
      p.vy = u.y * speed;
      p.vz = u.z * speed;
      p.drag = 2;
      p.ease = 3;
      p.heat = 1;
      p.cool = 1.4;
      p.attack = 0.04;
      p.decay = 1.6;
      p.spin = this.between(-1, 1);
    }
    // Sparks: fast stretched streaks that arc under gravity.
    const sparks = Math.round((10 + 14 * sqrtS) * d);
    for (let i = 0; i < sparks; i++) {
      const u = this.sphere();
      if (ground) u.y = Math.abs(u.y) * 0.9 + 0.1;
      const speed = this.between(25, 110) * Math.pow(S, 0.25);
      const p = this.glow(
        x,
        cy,
        z,
        this.between(0.6, 1.7),
        (0.22 + 0.12 * Math.pow(S, 0.3)) * this.between(0.7, 1.3),
        0,
        1,
        1,
        1,
        1,
        SPARK,
      );
      if (!p) break;
      p.vx = u.x * speed;
      p.vy = u.y * speed;
      p.vz = u.z * speed;
      p.drag = 0.5;
      p.gravity = 9.8;
      p.stretch = 7;
      p.heat = 1;
      p.cool = 0.95;
      p.flicker = 0.4;
      p.attack = 0;
      p.decay = 0.8;
      p.gain = 1.2;
      p.wind = 0;
    }
    // Black smoke: billows outward, then rises on its own heat and lingers for 10-16 s.
    const soot = Math.round((12 + 9 * sqrtS) * d);
    for (let i = 0; i < soot; i++) {
      const u = this.sphere();
      if (ground) u.y = Math.abs(u.y) * 0.8 + 0.2;
      const reach = R * 0.55 * Math.sqrt(this.random()),
        speed = R * this.between(0.25, 0.7),
        shade = this.between(0.035, 0.09);
      const p = this.puff(
        x + u.x * reach,
        cy + u.y * reach * 0.8,
        z + u.z * reach,
        Math.min(16, this.between(9, 14) + 1.2 * sqrtS),
        R * this.between(0.5, 0.9),
        R * this.between(0.7, 1.2) * 0.6,
        this.between(0.75, 0.9),
        shade * 1.05,
        shade,
        shade * 0.95,
        Math.floor(this.random() * 12),
      );
      if (!p) break;
      p.vx = u.x * speed;
      p.vy = u.y * speed;
      p.vz = u.z * speed;
      p.drag = 1;
      p.lift = 2.4 + 0.5 * sqrtS;
      p.ease = 0.6;
      p.erode = 0.45;
      p.attack = 0.12;
      p.decay = 1.3;
      p.spin = this.between(-0.18, 0.18);
    }
    this.blastLight(x, cy, z, S, R);
    if (!primary) return;
    if (S >= 0.8) this.throwDebris(x, cy, z, S, d, ground);
    // Secondary pops: fuel and ordnance cooking off a moment after the main blast.
    if (S >= 0.45) {
      const pops = S < 1.5 ? 1 : S < 3.5 ? 2 : 4;
      for (let i = 0; i < pops; i++) {
        const slot = this.pending.find((e) => !e.active);
        if (!slot) break;
        const u = this.sphere();
        const reach = R * this.between(0.3, 0.9);
        slot.active = true;
        slot.wait = this.between(0.14, 0.9);
        slot.x = x + u.x * reach;
        slot.y = Math.max(
          ground ? ground0 : -1e9,
          cy + Math.abs(u.y) * reach * 0.6,
        );
        slot.z = z + u.z * reach;
        slot.scale = S * this.between(0.22, 0.4);
        slot.ground = ground;
      }
    }
    if (ground) this.groundExtras(x, ground0, z, S, R, d);
  }
  /** Dust ring, dirt column and clods thrown by a blast at the terrain, plus the burning site. */
  private groundExtras(
    x: number,
    y: number,
    z: number,
    S: number,
    R: number,
    d: number,
  ) {
    const sqrtS = Math.sqrt(S);
    // Low dust ring racing outward along the ground.
    const ring = Math.round(18 * d * Math.pow(S, 0.35));
    for (let i = 0; i < ring; i++) {
      const angle = (i / Math.max(1, ring)) * Math.PI * 2 + this.random() * 0.4,
        speed = R * this.between(2.6, 4.4);
      const p = this.puff(
        x + Math.cos(angle) * R * 0.3,
        y + this.between(0.5, 3),
        z + Math.sin(angle) * R * 0.3,
        this.between(4, 7),
        R * this.between(0.3, 0.5),
        R * this.between(0.5, 0.9),
        this.between(0.45, 0.65),
        0.46,
        0.37,
        0.28,
        DUST + Math.floor(this.random() * 2),
      );
      if (!p) break;
      p.vx = Math.cos(angle) * speed;
      p.vz = Math.sin(angle) * speed;
      p.vy = this.between(0.5, 3);
      p.drag = 2.4;
      p.lift = 0.5;
      p.ease = 1.2;
      p.erode = 0.5;
      p.spin = this.between(-0.3, 0.3);
      p.attack = 0.04;
    }
    // Dirt column: dark earth and smoke punched straight up.
    const column = Math.round(11 * d * sqrtS);
    for (let i = 0; i < column; i++) {
      const spread = R * 0.28,
        up = R * this.between(0.9, 2.4);
      const shade = this.between(0.1, 0.17);
      const p = this.puff(
        x + (this.random() - 0.5) * spread,
        y + this.random() * R * 0.4,
        z + (this.random() - 0.5) * spread,
        this.between(3.5, 6),
        R * this.between(0.35, 0.6),
        R * this.between(0.4, 0.8),
        0.85,
        shade * 1.3,
        shade,
        shade * 0.75,
        DUST + Math.floor(this.random() * 2),
      );
      if (!p) break;
      p.vx = (this.random() - 0.5) * R * 0.7;
      p.vz = (this.random() - 0.5) * R * 0.7;
      p.vy = up;
      p.drag = 0.9;
      p.gravity = 1.5;
      p.ease = 0.9;
      p.erode = 0.5;
      p.attack = 0.06;
      p.spin = this.between(-0.3, 0.3);
    }
    // Clods: dark chunks flung out and falling back.
    const clods = Math.round(22 * d * Math.pow(S, 0.3));
    for (let i = 0; i < clods; i++) {
      const u = this.sphere();
      const speed = this.between(15, 62) * Math.pow(S, 0.35);
      const p = this.puff(
        x,
        y + 1,
        z,
        this.between(2, 3.8),
        this.between(0.4, 1.0) * Math.pow(S, 0.35),
        0,
        1,
        0.1,
        0.075,
        0.055,
        CHUNK + (i & 1),
      );
      if (!p) break;
      p.vx = u.x * speed;
      p.vy = Math.abs(u.y) * speed * 0.9 + 6;
      p.vz = u.z * speed;
      p.gravity = 9.8;
      p.drag = 0.15;
      p.spin = this.between(-5, 5);
      p.attack = 0;
      p.decay = 0.5;
      p.wind = 0;
    }
    // The burning site: a smoke column and small fires that persist.
    const site =
      this.sites.find((e) => !e.active) ??
      this.sites.reduce((a, b) => (a.age > b.age ? a : b));
    site.active = true;
    site.x = x;
    site.y = y;
    site.z = z;
    site.age = 0;
    site.life = Math.min(36, 16 + 9 * sqrtS);
    site.scale = S;
    site.smoke = 0;
    site.fire = 0;
  }
  private throwDebris(
    x: number,
    y: number,
    z: number,
    S: number,
    d: number,
    ground: boolean,
  ) {
    const count = Math.round(Math.min(10, 3 + 1.6 * S) * d);
    for (let i = 0; i < count; i++) {
      const c = this.chunks.find((e) => !e.active);
      if (!c) return;
      const u = this.sphere();
      const speed = this.between(18, 62) * Math.pow(S, 0.35);
      c.active = true;
      c.age = 0;
      c.life = this.between(3.4, 5);
      c.size = this.between(0.45, 1.2) * Math.pow(S, 0.4);
      c.hot = this.between(0.7, 1);
      c.seed = this.random();
      c.spin = this.between(-4, 4);
      c.puffs = 0;
      c.x = x;
      c.y = y;
      c.z = z;
      c.vx = u.x * speed;
      c.vy = (ground ? Math.abs(u.y) * 0.8 + 0.25 : u.y * 0.6 + 0.25) * speed;
      c.vz = u.z * speed;
    }
  }
  private blastLight(x: number, y: number, z: number, S: number, R: number) {
    const slot =
      this.blasts.find((e) => !e.active) ??
      this.blasts.reduce((a, b) => (a.age > b.age ? a : b));
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.age = 0;
    slot.peak = 70000 * Math.pow(S, 1.3);
    slot.range = 45 * R;
  }

  // ---- Flares -----------------------------------------------------------------------------

  /**
   * Countermeasure salvo from the rear fuselage: `count` cartridges (2-8) in left/right pairs a
   * tenth of a second apart, thrown 25-35 m/s down and out on top of the jet's velocity. Drag
   * stops them within a couple of seconds and gravity pulls the burning magnesium into arcs.
   * `up` is the jet's body up (for banked flight); omitted, it is derived from world up.
   */
  emitFlares(
    position: Point3,
    velocity: Point3,
    forward: Point3,
    up?: Point3,
    count = 6,
  ) {
    const f = this.dir;
    const length = Math.hypot(forward.x, forward.y, forward.z) || 1;
    f.x = forward.x / length;
    f.y = forward.y / length;
    f.z = forward.z / length;
    const body = { x: 0, y: 1, z: 0 };
    if (up) {
      body.x = up.x;
      body.y = up.y;
      body.z = up.z;
    } else {
      body.x = -f.x * f.y;
      body.y = 1 - f.y * f.y;
      body.z = -f.z * f.y;
      if (Math.hypot(body.x, body.y, body.z) < 0.2) {
        body.x = 0;
        body.y = 0;
        body.z = -1;
      }
    }
    const bl = Math.hypot(body.x, body.y, body.z) || 1;
    body.x /= bl;
    body.y /= bl;
    body.z /= bl;
    planSalvo(
      position,
      velocity,
      f,
      body,
      T.MathUtils.clamp(Math.round(count), 2, 8),
      () => this.random(),
      this.plan,
    );
    for (const shot of this.plan) {
      const c = this.cartridges.find((e) => !e.active);
      if (!c) break;
      c.active = true;
      c.wait = Math.max(0.0001, shot.delay);
      c.age = 0;
      c.life = this.between(3.1, 4);
      c.seed = this.random() * 100;
      c.puffs = c.sparks = c.embers = c.burn = 0;
      c.x = shot.position.x;
      c.y = shot.position.y;
      c.z = shot.position.z;
      c.vx = shot.velocity.x;
      c.vy = shot.velocity.y;
      c.vz = shot.velocity.z;
    }
  }
  private stepCartridges(dt: number) {
    const q = this.density;
    for (const c of this.cartridges) {
      if (!c.active) continue;
      let h = dt;
      if (c.wait > 0) {
        c.wait -= dt;
        if (c.wait > 0) continue;
        h = -c.wait;
        c.wait = 0;
        this.eject(c);
      }
      const steps = Math.max(1, Math.ceil(h / (1 / 60))),
        sub = h / steps;
      for (let i = 0; i < steps; i++) {
        const px = c.x,
          py = c.y,
          pz = c.z;
        stepBallistic(c, sub, 0.55, 0.007, 9.8, WIND);
        c.age += sub;
        const burn = flareBurn(c.age, c.life);
        if (burn <= 0) break;
        const travelled = Math.hypot(c.x - px, c.y - py, c.z - pz);
        // Smoke trail: a puff per ~3 m of flight plus a steady drip once it hangs in the air.
        c.puffs = Math.min(c.puffs + sub * 15 * q + travelled / 3.2, 10);
        while (c.puffs >= 1) {
          c.puffs -= 1;
          const t = this.random();
          const p = this.puff(
            px + (c.x - px) * t,
            py + (c.y - py) * t,
            pz + (c.z - pz) * t,
            this.between(5, 7.5),
            this.between(0.7, 1.1),
            this.between(2, 3),
            this.between(0.55, 0.75),
            0.93,
            0.93,
            0.92,
          );
          if (!p) break;
          p.vx = this.between(-0.5, 0.5);
          p.vy = this.between(-0.2, 0.6);
          p.vz = this.between(-0.5, 0.5);
          p.drag = 0.4;
          p.ease = 0.55;
          p.heat = 0.32;
          p.cool = 3.2;
          p.gain = 0.7;
          p.erode = 0.35;
          p.attack = 0.06;
          p.spin = this.between(-0.3, 0.3);
        }
        // Sparks shed from the burning grain, and slower embers that glow as they fall.
        c.sparks += sub * 42 * q * burn;
        while (c.sparks >= 1 && this.room(this.flame.pool, 0.9)) {
          c.sparks -= 1;
          const u = this.sphere();
          const speed = this.between(3, 14);
          const p = this.glow(
            c.x,
            c.y,
            c.z,
            this.between(0.25, 0.75),
            this.between(0.22, 0.4),
            0,
            1,
            1,
            1,
            1,
            SPARK,
          );
          if (!p) break;
          p.vx = c.vx * 0.12 + u.x * speed;
          p.vy = c.vy * 0.12 + u.y * speed;
          p.vz = c.vz * 0.12 + u.z * speed;
          p.drag = 0.7;
          p.gravity = 9.8;
          p.stretch = 5;
          p.heat = 1;
          p.cool = 1.5;
          p.attack = 0;
          p.decay = 0.7;
          p.wind = 0;
          p.flicker = 0.5;
        }
        c.embers += sub * 8 * q * burn;
        while (c.embers >= 1 && this.room(this.flame.pool, 0.85)) {
          c.embers -= 1;
          const u = this.sphere();
          const speed = this.between(1, 5);
          const p = this.glow(
            c.x,
            c.y,
            c.z,
            this.between(1, 2.1),
            this.between(0.5, 0.9),
            0,
            0.9,
            1,
            1,
            1,
            GLOW,
          );
          if (!p) break;
          p.vx = c.vx * 0.05 + u.x * speed;
          p.vy = c.vy * 0.05 + u.y * speed;
          p.vz = c.vz * 0.05 + u.z * speed;
          p.drag = 0.5;
          p.gravity = 5;
          p.heat = 0.78;
          p.cool = 0.9;
          p.flicker = 0.6;
          p.attack = 0;
          p.decay = 1.2;
          p.wind = 0;
        }
      }
      if (c.age >= c.life) {
        c.active = false;
        c.burn = 0;
        continue;
      }
      // The blinding part: re-created every frame so the flicker is violent and never stale.
      const burn = flareBurn(c.age, c.life);
      c.burn = burn;
      if (burn <= 0) continue;
      // Magnesium sputters: a hard random flutter with the occasional near-dropout.
      const dropout = this.random() < 0.06 ? 0.45 : 1;
      const flick = (0.72 + 0.56 * this.random()) * dropout;
      const b = burn * flick;
      const core = this.apparent(
        1.15 * (0.85 + 0.3 * this.random()),
        c.x,
        c.y,
        c.z,
      );
      this.blink(c.x, c.y, c.z, core, 26 * b, 22 * b, 13 * b, CORE);
      this.blink(
        c.x,
        c.y,
        c.z,
        core * 5.5,
        2.8 * b,
        2.0 * b,
        0.95 * b,
        HALO,
        0.9,
      );
      const star = this.blink(
        c.x,
        c.y,
        c.z,
        core * (5 + 3 * this.random()),
        8 * b,
        6.5 * b,
        3.5 * b,
        STAR,
        0.8,
      );
      if (star) star.rotation = this.random() * 6.283;
    }
  }
  /** The cartridge leaves its dispenser: a puff of propellant smoke and a burst of sparks. */
  private eject(c: Cartridge) {
    this.blink(c.x, c.y, c.z, 3.5, 12, 9, 4, CORE);
    for (let i = 0; i < 4; i++) {
      const p = this.puff(
        c.x,
        c.y,
        c.z,
        this.between(2.5, 4),
        this.between(0.8, 1.4),
        3,
        0.7,
        0.9,
        0.9,
        0.9,
      );
      if (!p) break;
      p.vx = c.vx * 0.2 + this.between(-2, 2);
      p.vy = c.vy * 0.2 + this.between(-2, 2);
      p.vz = c.vz * 0.2 + this.between(-2, 2);
      p.drag = 1.5;
      p.ease = 1;
      p.erode = 0.4;
    }
    for (let i = 0; i < Math.round(8 * this.density); i++) {
      const u = this.sphere();
      const p = this.glow(
        c.x,
        c.y,
        c.z,
        this.between(0.2, 0.5),
        0.3,
        0,
        1,
        1,
        1,
        1,
        SPARK,
      );
      if (!p) break;
      const speed = this.between(8, 24);
      p.vx = c.vx * 0.3 + u.x * speed;
      p.vy = c.vy * 0.3 + u.y * speed;
      p.vz = c.vz * 0.3 + u.z * speed;
      p.drag = 1.2;
      p.gravity = 9.8;
      p.stretch = 5;
      p.heat = 1;
      p.cool = 2;
      p.attack = 0;
      p.decay = 0.7;
      p.wind = 0;
    }
  }

  // ---- Missiles and launchers -------------------------------------------------------------

  /** A SAM leaving its launcher: ignition flash, backblast fire, ground dust ring and a dense boost-smoke plume. */
  emitLaunch(position: Point3, direction: Point3) {
    const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
    const nx = direction.x / length,
      ny = direction.y / length,
      nz = direction.z / length;
    const d = this.density * this.lod(position.x, position.y, position.z);
    const { x, y, z } = position;
    // Ignition: a hot flash at the rail and a jet of fire thrown backwards.
    this.blink(x, y, z, 9, 45, 32, 14, CORE);
    const halo = this.glow(x, y, z, 0.7, 14, 4, 0.5, 3.2, 1.5, 0.5, HALO);
    if (halo) halo.decay = 1.5;
    for (let i = 0; i < Math.round(6 * d); i++) {
      const speed = this.between(25, 70);
      const p = this.glow(
        x - nx * 3,
        y - ny * 3,
        z - nz * 3,
        this.between(0.3, 0.7),
        this.between(2.5, 5),
        4,
        0.9,
        1,
        1,
        1,
        FLAME + Math.floor(this.random() * 8),
      );
      if (!p) break;
      p.vx = -nx * speed + this.between(-4, 4);
      p.vy = -ny * speed + this.between(-4, 4);
      p.vz = -nz * speed + this.between(-4, 4);
      p.drag = 2.6;
      p.heat = 0.95;
      p.cool = 1.8;
      p.attack = 0.03;
      p.decay = 1.4;
      p.gain = 1.1;
      p.spin = this.between(-2, 2);
    }
    // Backblast pushes dust outward along the ground and up in a pillar under the launcher.
    const ring = Math.round(22 * d);
    for (let i = 0; i < ring; i++) {
      const angle = (i / Math.max(1, ring)) * Math.PI * 2 + this.random() * 0.3,
        speed = this.between(9, 26);
      const p = this.puff(
        x,
        y + this.between(0.4, 1.6),
        z,
        this.between(4, 7.5),
        this.between(1.5, 3),
        this.between(3, 6),
        this.between(0.35, 0.55),
        0.5,
        0.41,
        0.31,
        DUST + (i & 1),
      );
      if (!p) break;
      p.vx = Math.cos(angle) * speed;
      p.vz = Math.sin(angle) * speed;
      p.vy = this.between(0.3, 2.5);
      p.drag = 1.9;
      p.lift = 0.5;
      p.ease = 0.9;
      p.erode = 0.5;
      p.spin = this.between(-0.4, 0.4);
    }
    for (let i = 0; i < Math.round(8 * d); i++) {
      const p = this.puff(
        x + this.between(-1.5, 1.5),
        y + 1,
        z + this.between(-1.5, 1.5),
        this.between(4, 7),
        this.between(2, 3.5),
        this.between(3, 5),
        0.5,
        0.5,
        0.42,
        0.33,
        DUST,
      );
      if (!p) break;
      p.vx = this.between(-3, 3) - nx * 4;
      p.vz = this.between(-3, 3) - nz * 4;
      p.vy = this.between(4, 13);
      p.drag = 1.1;
      p.ease = 0.8;
      p.erode = 0.5;
    }
    // Boost smoke: white, dense and glowing near the rail, thrown ahead along the flight path.
    const plume = Math.round(30 * d);
    for (let i = 0; i < plume; i++) {
      const t = i / Math.max(1, plume - 1),
        along = t * 52 + this.between(-1, 1);
      const size = (1 - 0.55 * t) * this.between(4, 7);
      const p = this.puff(
        x + nx * along + this.between(-0.8, 0.8),
        y + ny * along + this.between(-0.8, 0.8),
        z + nz * along + this.between(-0.8, 0.8),
        this.between(8, 13),
        size,
        this.between(2.5, 4.5),
        this.between(0.7, 0.9),
        0.94,
        0.94,
        0.93,
      );
      if (!p) break;
      const speed = (1 - t) * this.between(4, 14);
      p.vx = nx * speed + this.between(-1.5, 1.5);
      p.vy = ny * speed + this.between(-1, 1.5);
      p.vz = nz * speed + this.between(-1.5, 1.5);
      p.drag = 0.45;
      p.ease = 0.45;
      p.heat = 0.5 * (1 - t);
      p.cool = 2.5;
      p.gain = 0.8;
      p.erode = 0.3;
      p.attack = 0.04;
      p.spin = this.between(-0.2, 0.2);
    }
    this.blastLight(x, y + 1, z, 0.35, 8);
  }
  /**
   * Per-frame smoke and fire from a failed engine at a nozzle; intensity 0..1. Stateless and
   * allocation free: emission is a Poisson-like draw over `dt`, jittered back along the path.
   */
  emitEngineFire(
    position: Point3,
    velocity: Point3,
    intensity: number,
    dt: number,
  ) {
    if (!(dt > 0) || !(intensity > 0.02)) return;
    const i = Math.min(1, intensity),
      q =
        this.density *
        (this.lod(position.x, position.y, position.z) > 0.5 ? 1 : 0.5);
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    const ux = speed > 0.1 ? velocity.x / speed : 0,
      uy = speed > 0.1 ? velocity.y / speed : 0,
      uz = speed > 0.1 ? velocity.z / speed : -1;
    // Flame: a stretched tongue streaming aft and a bright, flickering core at the nozzle.
    const length = (1.4 + 3.2 * i) * (0.7 + 0.6 * this.random());
    const tongue = this.glow(
      position.x - ux * length * 0.5,
      position.y - uy * length * 0.5,
      position.z - uz * length * 0.5,
      this.between(0.1, 0.2),
      (0.55 + 0.75 * i) * this.between(0.8, 1.2),
      0,
      0.9,
      1,
      1,
      1,
      FLAME + Math.floor(this.random() * 8),
    );
    if (tongue) {
      tongue.vx = velocity.x * 0.93;
      tongue.vy = velocity.y * 0.93;
      tongue.vz = velocity.z * 0.93;
      tongue.dx = -ux;
      tongue.dy = -uy;
      tongue.dz = -uz;
      tongue.stretch = 1 + length / ((0.55 + 0.75 * i) * 1.2);
      tongue.heat = 0.55 + 0.4 * i;
      tongue.cool = 4;
      tongue.flicker = 0.5;
      tongue.attack = 0.05;
      tongue.decay = 1.1;
    }
    this.blink(
      position.x,
      position.y,
      position.z,
      this.apparent(
        (0.7 + 0.8 * i) * (0.8 + 0.4 * this.random()),
        position.x,
        position.y,
        position.z,
      ),
      9 * i,
      4.2 * i,
      1.2 * i,
      CORE,
      0.9,
    );
    // Dark smoke left hanging in the air where the jet has been.
    let want = dt * (26 * i + 4) * q;
    while (want > 0 && this.room(this.smoke.pool, 0.88)) {
      if (want < 1 && this.random() > want) break;
      want -= 1;
      const back = this.random() * dt;
      const shade = this.between(0.05, 0.11);
      const p = this.puff(
        position.x - velocity.x * back + this.between(-0.3, 0.3),
        position.y - velocity.y * back + this.between(-0.3, 0.3),
        position.z - velocity.z * back + this.between(-0.3, 0.3),
        this.between(4, 7.5),
        (1 + 1.3 * i) * this.between(0.8, 1.2),
        this.between(1.4, 2.4),
        0.4 + 0.4 * i,
        shade * 1.1,
        shade,
        shade,
      );
      if (!p) break;
      p.vx = this.between(-0.6, 0.6);
      p.vy = this.between(0.2, 1.2);
      p.vz = this.between(-0.6, 0.6);
      p.drag = 0.3;
      p.lift = 0.35;
      p.ease = 0.5;
      p.heat = 0.45 * i;
      p.cool = 4.5;
      p.gain = 0.8;
      p.erode = 0.35;
      p.attack = 0.05;
      p.spin = this.between(-0.25, 0.25);
    }
  }

  /** Call once per simulation step for each damaged entity; stopEmitter(id) on removal. */
  emitDamageSmoke(
    id: string | number,
    position: Point3,
    dt: number,
    severity = 1,
  ) {
    if (!(dt > 0)) return;
    let emitter = this.damage.get(id);
    if (!emitter) {
      if (this.damage.size >= 32) return;
      emitter = { sampler: new DistanceSampler(5, 12), time: 0 };
      this.damage.set(id, emitter);
    }
    severity = T.MathUtils.clamp(severity, 0.1, 1);
    const emit = (point: Point3) => {
      const shade = this.between(0.07, 0.14);
      const p = this.puff(
        point.x,
        point.y,
        point.z,
        this.between(4, 7),
        1.8 + severity * 2.6,
        2.2 + severity,
        severity * 0.75,
        shade * 1.1,
        shade,
        shade,
      );
      if (!p) return;
      p.vy = 0.8 + this.random() * 1.5;
      p.drag = 0.3;
      p.ease = 0.6;
      p.heat = severity > 0.5 ? 0.4 * severity : -1;
      p.cool = 5;
      p.erode = 0.35;
      p.spin = this.between(-0.25, 0.25);
    };
    const count = emitter.sampler.emit(position, emit);
    emitter.time += dt;
    if (emitter.time >= 0.12) {
      if (!count) emit(position);
      emitter.time %= 0.12;
    }
  }
  updateMissile(id: string | number, position: Point3, dt: number) {
    if (!(dt > 0)) return;
    let trail = this.missiles.get(id);
    if (!trail) {
      if (this.missiles.size >= 64) return;
      trail = {
        sampler: new DistanceSampler(2.4, 24),
        age: 0,
        x: 0,
        y: 0,
        z: 0,
        seen: false,
      };
      this.missiles.set(id, trail);
    }
    trail.age += dt;
    const boost = (this.boosting = trail.age < 1.8);
    // Boost phase leaves a thick bright-white trail, the sustain phase a thinner grey one.
    trail.sampler.spacing = boost ? 2 : 3.2;
    trail.sampler.emit(position, this.trailPuff);
    // The motor: a flame streaming from the nozzle, re-spawned each step so it flickers.
    this.motorFlame(trail, position);
    trail.x = position.x;
    trail.y = position.y;
    trail.z = position.z;
    trail.seen = true;
  }
  private boosting = false;
  private readonly trailPuff = (point: Point3) => {
    const boost = this.boosting;
    {
      const p = this.puff(
        point.x + this.between(-0.25, 0.25),
        point.y + this.between(-0.25, 0.25),
        point.z + this.between(-0.25, 0.25),
        boost ? this.between(5, 7) : this.between(3.5, 5),
        boost ? this.between(1.3, 1.8) : this.between(0.8, 1.1),
        boost ? 1.2 : 0.55,
        boost ? 0.82 : 0.42,
        boost ? 0.95 : 0.78,
        boost ? 0.95 : 0.8,
        boost ? 0.94 : 0.82,
      );
      if (!p) return;
      p.vx = this.between(-0.4, 0.4);
      p.vy = this.between(-0.2, 0.5);
      p.vz = this.between(-0.4, 0.4);
      p.drag = 0.35;
      p.ease = 0.5;
      p.erode = 0.35;
      p.attack = 0.04;
      p.spin = this.between(-0.3, 0.3);
      if (boost) {
        p.heat = 0.4;
        p.cool = 4;
        p.gain = 0.7;
      }
    }
  };
  private motorFlame(trail: MissileTrail, position: Point3) {
    {
      if (trail.seen) {
        const dx = position.x - trail.x,
          dy = position.y - trail.y,
          dz = position.z - trail.z,
          travelled = Math.hypot(dx, dy, dz);
        if (travelled > 1e-3 && travelled < 400) {
          const nx = dx / travelled,
            ny = dy / travelled,
            nz = dz / travelled;
          const flare = this.between(0.85, 1.25);
          const size = this.apparent(
            1.0 * flare,
            position.x,
            position.y,
            position.z,
          );
          const plume = this.glow(
            position.x - nx * (1.8 + 2 * flare),
            position.y - ny * (1.8 + 2 * flare),
            position.z - nz * (1.8 + 2 * flare),
            0.07,
            size,
            0,
            0.95,
            1,
            1,
            1,
            FLAME + Math.floor(this.random() * 8),
          );
          if (plume) {
            plume.dx = nx;
            plume.dy = ny;
            plume.dz = nz;
            plume.stretch = 6;
            plume.heat = 0.82;
            plume.attack = 0;
            plume.decay = 0.6;
            plume.flicker = 0.35;
            plume.gain = 1.1;
          }
          const glare = this.glow(
            position.x - nx * 1.6,
            position.y - ny * 1.6,
            position.z - nz * 1.6,
            0.07,
            this.apparent(2.2 * flare, position.x, position.y, position.z),
            0,
            1,
            15,
            9,
            3.5,
            CORE,
          );
          if (glare) {
            glare.attack = 0;
            glare.decay = 0.5;
          }
        }
      }
    }
  }
  stopEmitter(id: string | number) {
    this.missiles.delete(id);
    this.damage.delete(id);
  }

  // ---- Simulation -------------------------------------------------------------------------

  private stepChunks(dt: number) {
    for (const c of this.chunks) {
      if (!c.active) continue;
      let h = dt;
      const steps = Math.max(1, Math.ceil(h / (1 / 60)));
      h /= steps;
      for (let i = 0; i < steps && c.active; i++) {
        const px = c.x,
          py = c.y,
          pz = c.z;
        stepBallistic(c, h, 0.03, 0.0006, 9.8, STILL);
        c.age += h;
        // A puff per ~3 m of flight keeps the trail continuous without flooding the pool.
        c.puffs = Math.min(c.puffs + h * 3 + Math.hypot(c.x - px, c.y - py, c.z - pz) / 3, 6);
        while (c.puffs >= 1) {
          c.puffs -= 1;
          const t = this.random();
          const shade = this.between(0.1, 0.2);
          const p = this.puff(
            px + (c.x - px) * t,
            py + (c.y - py) * t,
            pz + (c.z - pz) * t,
            this.between(1.8, 2.8),
            0.9 + c.size * 0.5,
            2,
            0.62,
            shade,
            shade,
            shade,
          );
          if (!p) break;
          p.drag = 0.4;
          p.lift = 0.4;
          p.ease = 0.7;
          p.heat = 0.45 * c.hot;
          p.cool = 3;
          p.gain = 0.7;
          p.erode = 0.4;
        }
        const ground = this.groundHeight
          ? this.groundHeight(c.x, c.z)
          : -Infinity;
        if (c.y < ground || c.age >= c.life) {
          if (c.y < ground && c.vy < 0) this.land(c, ground);
          c.active = false;
        }
      }
      if (!c.active) continue;
      // The chunk itself: a tumbling dark lump glowing while it is still hot.
      const heat = c.hot * Math.exp(-c.age * 0.8);
      const lump = this.puff(
        c.x,
        c.y,
        c.z,
        0.0005,
        c.size,
        0,
        1,
        0.07,
        0.065,
        0.06,
        CHUNK + (c.seed > 0.5 ? 1 : 0),
      );
      if (lump) {
        lump.rotation = c.seed * 6.28 + c.age * c.spin;
        lump.attack = 0;
        lump.decay = 0;
        lump.wind = 0;
        if (heat > 0.08) {
          lump.heat = heat * 0.7;
          lump.gain = 0.9;
        }
      }
      if (heat > 0.12)
        this.blink(
          c.x,
          c.y,
          c.z,
          c.size * 3.6,
          4.4 * heat,
          1.5 * heat,
          0.35 * heat,
          GLOW,
          0.9,
        );
    }
  }
  private land(c: Chunk, ground: number) {
    for (let i = 0; i < 4; i++) {
      const p = this.puff(
        c.x + this.between(-1, 1),
        ground + 0.5,
        c.z + this.between(-1, 1),
        this.between(2, 3.5),
        0.8 + c.size * 0.6,
        2.4,
        0.5,
        0.42,
        0.34,
        0.26,
        DUST,
      );
      if (!p) break;
      p.vx = this.between(-2, 2);
      p.vz = this.between(-2, 2);
      p.vy = this.between(1, 4);
      p.drag = 1;
      p.erode = 0.5;
    }
    for (let i = 0; i < 5; i++) {
      const p = this.glow(
        c.x,
        ground + 0.4,
        c.z,
        this.between(0.3, 0.7),
        0.25,
        0,
        1,
        1,
        1,
        1,
        SPARK,
      );
      if (!p) break;
      p.vx = this.between(-6, 6);
      p.vy = this.between(3, 11);
      p.vz = this.between(-6, 6);
      p.gravity = 9.8;
      p.stretch = 4;
      p.heat = 0.9 * c.hot;
      p.cool = 2;
      p.attack = 0;
      p.decay = 0.8;
      p.wind = 0;
    }
  }
  private stepPending(dt: number) {
    for (const e of this.pending) {
      if (!e.active) continue;
      e.wait -= dt;
      if (e.wait > 0) continue;
      e.active = false;
      const d = this.density * this.lod(e.x, e.y, e.z) * 0.7;
      this.burst(e.x, e.y, e.z, e.scale, d, e.ground, false);
    }
  }
  private stepSites(dt: number) {
    const q = this.density;
    for (const s of this.sites) {
      if (!s.active) continue;
      s.age += dt;
      if (s.age >= s.life) {
        s.active = false;
        continue;
      }
      const fade = 1 - s.age / s.life,
        R = 16 * Math.pow(s.scale, 0.85),
        lod = this.lod(s.x, s.y, s.z);
      s.smoke += dt * (3 + 1.1 * s.scale) * q * lod * (0.35 + 0.65 * fade);
      while (s.smoke >= 1 && this.room(this.smoke.pool, 0.85)) {
        s.smoke -= 1;
        const shade = this.between(0.05, 0.11);
        const p = this.puff(
          s.x + this.between(-0.2, 0.2) * R,
          s.y + 1,
          s.z + this.between(-0.2, 0.2) * R,
          this.between(11, 17),
          R * this.between(0.14, 0.24),
          R * 0.35,
          this.between(0.6, 0.85) * (0.5 + 0.5 * fade),
          shade * 1.05,
          shade,
          shade * 0.95,
        );
        if (!p) break;
        p.vx = this.between(-1, 1);
        p.vz = this.between(-1, 1);
        p.vy = this.between(4, 9) * Math.pow(s.scale, 0.2);
        p.drag = 0.22;
        p.lift = 0.3;
        p.ease = 0.28;
        p.heat = 0.3;
        p.cool = 1.8;
        p.gain = 0.8;
        p.erode = 0.4;
        p.attack = 0.1;
        p.spin = this.between(-0.1, 0.1);
      }
      s.fire += dt * (4 + 1.6 * s.scale) * q * lod * (0.3 + 0.7 * fade);
      while (s.fire >= 1 && this.room(this.flame.pool, 0.85)) {
        s.fire -= 1;
        const angle = this.random() * Math.PI * 2,
          reach = R * 0.4 * Math.sqrt(this.random());
        const p = this.glow(
          s.x + Math.cos(angle) * reach,
          s.y + 0.8,
          s.z + Math.sin(angle) * reach,
          this.between(0.4, 1),
          R * this.between(0.07, 0.17) * (0.6 + 0.4 * fade),
          0,
          0.9,
          1,
          1,
          1,
          FLAME + Math.floor(this.random() * 8),
        );
        if (!p) break;
        p.vy = this.between(2, 6);
        p.vx = this.between(-0.5, 0.5) + WIND.x * 0.3;
        p.drag = 0.8;
        p.heat = this.between(0.5, 0.85);
        p.cool = 1.2;
        p.flicker = 0.45;
        p.attack = 0.12;
        p.decay = 1;
        p.spin = this.between(-1, 1);
        p.wind = 0;
      }
    }
  }
  private lightCount = 0;
  private pushLight(
    x: number,
    y: number,
    z: number,
    intensity: number,
    range: number,
  ) {
    const slot = this.lightSlots[this.lightCount++];
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.i = intensity;
    slot.range = range;
  }
  private readonly chosen = [-1, -1];
  /** Chooses the two strongest sources near the camera to drive the shared point lights. */
  private updateLights(dt: number, origin: Point3) {
    const slots = this.lightSlots;
    this.lightCount = 0;
    // Daylight washes out small lights: flares matter at dusk and night, blasts always.
    const dim = 1 - 0.7 * this.daylight;
    for (const c of this.cartridges)
      if (c.active && c.burn > 0 && this.lightCount < slots.length)
        this.pushLight(
          c.x,
          c.y,
          c.z,
          2600 * c.burn * dim * (0.8 + 0.4 * this.random()),
          130,
        );
    for (const e of this.blasts) {
      if (!e.active) continue;
      e.age += dt;
      const level =
        0.65 * Math.exp(-e.age / 0.12) + 0.35 * Math.exp(-e.age / 1.1);
      if (e.age > 4.5 || level < 0.01) e.active = false;
      else if (this.lightCount < slots.length)
        this.pushLight(e.x, e.y, e.z, e.peak * level, e.range);
    }
    let a = -1,
      b = -1,
      scoreA = 0,
      scoreB = 0;
    for (let i = 0; i < this.lightCount; i++) {
      const s = slots[i];
      // Brightest as seen from the camera, softened so a distant glare cannot starve a close one.
      const dx = s.x - this.viewer.x,
        dy = s.y - this.viewer.y,
        dz = s.z - this.viewer.z;
      const score = s.i / (dx * dx + dy * dy + dz * dz + 400);
      if (score > scoreA) {
        b = a;
        scoreB = scoreA;
        a = i;
        scoreA = score;
      } else if (score > scoreB) {
        b = i;
        scoreB = score;
      }
    }
    this.chosen[0] = a;
    this.chosen[1] = b;
    for (let k = 0; k < 2; k++) {
      const light = this.lights[k],
        s = this.chosen[k] >= 0 ? slots[this.chosen[k]] : undefined;
      if (!s) {
        light.intensity = 0;
        continue;
      }
      light.position.set(s.x - origin.x, s.y - origin.y, s.z - origin.z);
      light.intensity = s.i;
      light.distance = s.range;
      light.color.setRGB(1, 0.8, 0.52);
    }
  }
  private lightSlots = Array.from({ length: 40 }, () => ({
    x: 0,
    y: 0,
    z: 0,
    i: 0,
    range: 0,
  }));

  /** Smoke shading inputs: sun/moon direction (view space) and colour, and a sky-ambient estimate. */
  private shade(batch: ParticleBatch) {
    const u = batch.material.uniforms,
      day = this.daylight;
    (u.uLightDir.value as T.Vector3).copy(this.lightView);
    // Sunlit white scatters back about 1.0; scale by the actual illuminance so dusk and night go dark.
    (u.uSunColor.value as T.Color)
      .copy(this.sunColor)
      .multiplyScalar((this.sunIntensity / 3) * 0.95);
    (u.uAmbient.value as T.Color).setRGB(
      0.165 * day + 0.012,
      0.195 * day + 0.014,
      0.272 * day + 0.022,
    );
  }
  /** dt=0 rebases and uploads without aging effects (pause-safe). Update camera matrix first. */
  update(dt: number, camera: T.Camera, origin: Point3) {
    if (this.disposed) return;
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    this.viewer.x = camera.position.x + origin.x;
    this.viewer.y = camera.position.y + origin.y;
    this.viewer.z = camera.position.z + origin.z;
    this.viewerKnown = true;
    this.smoke.pool.step(step, WIND, 0);
    this.flame.pool.step(step, STILL, 0);
    if (step > 0) {
      // Sources spawn after the particles have aged, so one-frame sprites are seen exactly once.
      this.stepPending(step);
      this.stepSites(step);
      this.stepChunks(step);
      this.stepCartridges(step);
    }
    this.updateLights(step, origin);
    this.lightView
      .copy(this.lightDir)
      .transformDirection(camera.matrixWorldInverse);
    this.shade(this.smoke);
    const limits = LIMITS[this.quality];
    this.smoke.upload(camera, origin, limits[0]);
    this.flame.upload(camera, origin, limits[1]);
  }
  /** Optional ordinary perspective WebGL depth hook; caller renders opaque depth first.
   * Unsupported with logarithmic/reversed depth. Size is draw framebuffer pixels, not CSS pixels. */
  setSoftDepth(
    texture: T.DepthTexture | null,
    camera: T.PerspectiveCamera,
    width: number,
    height: number,
    fadeMeters = 6,
  ) {
    for (const batch of [this.smoke, this.flame]) {
      const u = batch.material.uniforms;
      u.sceneDepth.value = texture;
      u.useSoftDepth.value = texture !== null;
      u.clipRange.value.set(camera.near, camera.far);
      u.viewport.value.set(width, height);
      u.softRange.value = Math.max(0.01, fadeMeters);
    }
  }
  clear() {
    this.smoke.pool.clear();
    this.flame.pool.clear();
    this.smoke.geometry.instanceCount = this.flame.geometry.instanceCount = 0;
    this.missiles.clear();
    this.damage.clear();
    for (const list of [
      this.cartridges,
      this.chunks,
      this.pending,
      this.sites,
      this.blasts,
    ])
      for (const e of list) e.active = false;
    for (const light of this.lights) light.intensity = 0;
    this.seed = 7297;
  }
  reset() {
    this.clear();
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.group.removeFromParent();
    for (const light of this.lights) {
      light.removeFromParent();
      light.dispose();
    }
    this.smoke.dispose();
    this.flame.dispose();
    this.disposed = true;
  }
}
