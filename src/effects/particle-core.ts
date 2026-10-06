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
    }));
    this.free = Array.from({ length: capacity }, (_, i) => capacity - i - 1);
  }
  acquire(): Particle | undefined {
    const index = this.free.pop();
    if (index === undefined) return undefined;
    const p = this.particles[index];
    p.active = true;
    p.age = 0;
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
      p.x += (p.vx + wind.x) * dt;
      p.y += (p.vy + wind.y + buoyancy) * dt;
      p.z += (p.vz + wind.z) * dt;
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
