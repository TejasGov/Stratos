import * as T from "three";

const DEG = Math.PI / 180;

/**
 * Sun and moon over a tropical archipelago (latitude 19°N, late summer).
 * World axes: +x east, -z north, +y up.
 */
export class TimeOfDay {
  hours = 17.55;
  /** Simulated hours per real second while flying; 0 freezes the clock. */
  rate = 0;
  readonly sun = new T.Vector3();
  readonly moon = new T.Vector3();
  private latitude = 19 * DEG;
  private declination = 8 * DEG;
  constructor() {
    this.update(0);
  }
  update(dt: number) {
    this.hours = (((this.hours + dt * this.rate) % 24) + 24) % 24;
    this.direction((this.hours - 12) * 15 * DEG, this.declination, this.sun);
    // A waning gibbous moon trails the sun by roughly 9.5 hours.
    this.direction(
      (this.hours - 12 - 9.5) * 15 * DEG,
      -this.declination * 0.6,
      this.moon,
    );
    return this;
  }
  private direction(hourAngle: number, declination: number, out: T.Vector3) {
    const lat = this.latitude;
    const sinEl =
      Math.sin(lat) * Math.sin(declination) +
      Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
    const el = Math.asin(T.MathUtils.clamp(sinEl, -1, 1));
    const cosAz =
      (Math.sin(declination) - Math.sin(el) * Math.sin(lat)) /
      Math.max(1e-6, Math.cos(el) * Math.cos(lat));
    let az = Math.acos(T.MathUtils.clamp(cosAz, -1, 1));
    if (Math.sin(hourAngle) > 0) az = 2 * Math.PI - az;
    // Azimuth from north, clockwise toward east.
    out.set(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      -Math.cos(az) * Math.cos(el),
    );
    return out.normalize();
  }
  /** 0 by day, 1 in full night: drives stars and night exposure. */
  get night() {
    return T.MathUtils.smoothstep(-this.sun.y, -0.02, 0.18);
  }
}
