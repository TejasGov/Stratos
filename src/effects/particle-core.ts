export interface Point3 {
  x: number;
  y: number;
  z: number;
}
export interface Particle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
  growth: number;
  opacity: number;
  rotation: number;
  r: number;
  g: number;
  b: number;
  stretch: number;
  dx: number;
  dy: number;
  dz: number;
  /** Velocity damping per second (exponential), applied to the particle's own motion only. */
  drag: number;
  /** Downward acceleration, m/s². */
  gravity: number;
  /** Upward (buoyant) acceleration, m/s². */
  lift: number;
  /** How strongly the ambient wind carries it, 0..1. */
  wind: number;
  /** Rotation rate, rad/s. */
  spin: number;
  /** Emissive temperature 0..1 (colour ramp white-yellow, orange, red); negative = use `r,g,b` directly. */
  heat: number;
  /** Heat decay rate per second. */
  cool: number;
  /** First atlas cell, and how many cells the flipbook advances through over the lifetime. */
  frame: number;
  frames: number;
  /** 0 camera-facing billboard, 1 flat on the ground plane. */
  mode: number;
  /** Fade-in fraction of the life (0 = instantly opaque) and fade-out exponent (0 = hold until death). */
  attack: number;
  decay: number;
  /** Noise erosion threshold reached at the end of life (0..1); ragged dissolve instead of a plain fade. */
  erode: number;
  /** Brightness flicker amplitude 0..1. */
  flicker: number;
  /** Size growth eases out with this rate (1/s); 0 = linear. */
  ease: number;
  /** Multiplies the emissive colour. */
  gain: number;
}
/** Fixed allocation; exhausted pools reject new particles instead of growing. */
export class ParticlePool {
  readonly particles: Particle[];
  private free: number[];
  count = 0;
  constructor(readonly capacity: number) {
    this.particles = Array.from({ length: capacity }, () => ({
      active: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      age: 0,
      life: 1,
      size: 1,
      growth: 0,
      opacity: 1,
      rotation: 0,
      r: 1,
      g: 1,
      b: 1,
      stretch: 1,
      dx: 0,
      dy: 0,
      dz: 0,
      drag: 0,
      gravity: 0,
      lift: 0,
      wind: 1,
      spin: 0,
      heat: -1,
      cool: 0,
      frame: 0,
      frames: 0,
      mode: 0,
      attack: 0.11,
      decay: 1.2,
      erode: 0,
      flicker: 0,
      ease: 0,
      gain: 1,
    }));
    this.free = Array.from({ length: capacity }, (_, i) => capacity - i - 1);
  }
  acquire(): Particle | undefined {
    const index = this.free.pop();
    if (index === undefined) return undefined;
    const p = this.particles[index];
    p.active = true;
    p.age = 0;
    // Recycled records start from neutral physics and look; callers override what they need.
    p.vx = p.vy = p.vz = 0;
    p.dx = p.dy = p.dz = 0;
    p.drag =
      p.gravity =
      p.lift =
      p.spin =
      p.cool =
      p.erode =
      p.flicker =
      p.ease =
        0;
    p.wind = p.gain = 1;
    p.heat = -1;
    p.frame = p.frames = p.mode = 0;
    p.attack = 0.11;
    p.decay = 1.2;
    p.stretch = 1;
    this.count++;
    return p;
  }
  step(dt: number, wind: Point3, buoyancy: number) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.active = false;
        this.count--;
        this.free.push(i);
        continue;
      }
      if (p.drag > 0) {
        const keep = Math.exp(-p.drag * dt);
        p.vx *= keep;
        p.vy *= keep;
        p.vz *= keep;
      }
      p.vy += (p.lift - p.gravity) * dt;
      p.x += (p.vx + wind.x * p.wind) * dt;
      p.y += (p.vy + wind.y * p.wind + buoyancy) * dt;
      p.z += (p.vz + wind.z * p.wind) * dt;
    }
  }
  clear() {
    this.count = 0;
    this.free.length = 0;
    for (let i = this.capacity - 1; i >= 0; i--) {
      this.particles[i].active = false;
      this.free.push(i);
    }
  }
}

/** Carries fractional travel between calls; caps catch-up and resets on teleport. */
export class DistanceSampler {
  private previous = { x: 0, y: 0, z: 0 };
  private initialized = false;
  private carry = 0;
  readonly sample = { x: 0, y: 0, z: 0 };
  constructor(
    public spacing: number,
    readonly maxSamples = 32,
    readonly teleportDistance = 2000,
  ) {}
  reset() {
    this.initialized = false;
    this.carry = 0;
  }
  emit(position: Point3, callback: (point: Point3) => void): number {
    const last = this.previous;
    if (!this.initialized) {
      last.x = position.x;
      last.y = position.y;
      last.z = position.z;
      this.initialized = true;
      return 0;
    }
    const dx = position.x - last.x,
      dy = position.y - last.y,
      dz = position.z - last.z;
    const distance = Math.hypot(dx, dy, dz);
    let count = 0;
    if (distance <= this.teleportDistance && distance > 1e-8) {
      let along = this.spacing - this.carry;
      while (along <= distance && count < this.maxSamples) {
        const t = along / distance;
        this.sample.x = last.x + dx * t;
        this.sample.y = last.y + dy * t;
        this.sample.z = last.z + dz * t;
        callback(this.sample);
        count++;
        along += this.spacing;
      }
      // Dropped hitch emissions are discarded, never queued into a future burst.
      this.carry = (this.carry + distance) % this.spacing;
    } else if (distance > this.teleportDistance) this.carry = 0;
    last.x = position.x;
    last.y = position.y;
    last.z = position.z;
    return count;
  }
}

export function localPosition(p: Point3, origin: Point3, target: Point3) {
  target.x = p.x - origin.x;
  target.y = p.y - origin.y;
  target.z = p.z - origin.z;
  return target;
}

export interface Ballistic extends Point3 {
  vx: number;
  vy: number;
  vz: number;
}
/**
 * Falling body in moving air: linear + quadratic drag on the velocity relative to
 * the wind, then gravity. The drag decays exactly (no stiffness at large dt).
 */
export function stepBallistic(
  b: Ballistic,
  dt: number,
  linear: number,
  quadratic: number,
  gravity: number,
  wind: Point3,
) {
  const rx = b.vx - wind.x,
    ry = b.vy - wind.y,
    rz = b.vz - wind.z;
  const keep = Math.exp(-(linear + quadratic * Math.hypot(rx, ry, rz)) * dt);
  b.vx = rx * keep + wind.x;
  b.vy = ry * keep + wind.y - gravity * dt;
  b.vz = rz * keep + wind.z;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
}

/** Magnesium-flare brightness 0..~1.4 over a burn of `life` seconds: ignition spike, steady burn, sputtering end. */
export function flareBurn(age: number, life: number) {
  if (age < 0 || age >= life) return 0;
  const ignite = Math.min(1, age / 0.06);
  const spike = 1 + 0.45 * Math.exp(-age / 0.18);
  const tail = Math.min(1, (life - age) / 0.55);
  return ignite * spike * (0.55 + 0.45 * tail) * tail;
}

export interface FlarePlan {
  /** Seconds after the call at which the cartridge leaves the dispenser. */
  delay: number;
  position: Point3;
  velocity: Point3;
}
/**
 * Cartridge schedule for a salvo: left/right pairs every `interval` seconds, ejected
 * downward and outward from the rear fuselage on top of the jet's own velocity.
 * `forward`/`up` are the jet's body axes; `random` yields [0,1).
 */
export function planSalvo(
  position: Point3,
  velocity: Point3,
  forward: Point3,
  up: Point3,
  count: number,
  random: () => number,
  out: FlarePlan[],
  interval = 0.1,
  ejection = 30,
) {
  // right = forward × up
  let rx = forward.y * up.z - forward.z * up.y,
    ry = forward.z * up.x - forward.x * up.z,
    rz = forward.x * up.y - forward.y * up.x;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  out.length = 0;
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1,
      delay = Math.floor(i / 2) * interval + random() * 0.012;
    // Down and out, slightly aft: dispensers sit under and behind the wing roots.
    const speed = ejection * (0.85 + random() * 0.3),
      outward = side * (0.55 + random() * 0.25),
      down = -(0.8 + random() * 0.2),
      aft = -(0.1 + random() * 0.15);
    let dx = up.x * down + rx * outward + forward.x * aft,
      dy = up.y * down + ry * outward + forward.y * aft,
      dz = up.z * down + rz * outward + forward.z * aft;
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx = (dx / dl) * speed;
    dy = (dy / dl) * speed;
    dz = (dz / dl) * speed;
    // Rear fuselage, a little off the centreline on the dispenser's side.
    const back = -4.5,
      lateral = side * 1.1,
      below = -0.7;
    out.push({
      delay,
      position: {
        x:
          position.x +
          velocity.x * delay +
          forward.x * back +
          rx * lateral +
          up.x * below,
        y:
          position.y +
          velocity.y * delay +
          forward.y * back +
          ry * lateral +
          up.y * below,
        z:
          position.z +
          velocity.z * delay +
          forward.z * back +
          rz * lateral +
          up.z * below,
      },
      velocity: { x: velocity.x + dx, y: velocity.y + dy, z: velocity.z + dz },
    });
  }
  return out;
}
