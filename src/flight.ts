import { Euler, Quaternion, Vector3, MathUtils } from "three";
import { heightAt, renderedHeightAt } from "./world/terrain";
export interface Controls {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  boost: boolean;
  /** World-space steering cue for mouse aim or the optional target-follow assist. */
  aimDirection?: Vector3;
  throttleTarget?: number;
}
/** International Standard Atmosphere helpers (altitude in metres). */
export function airDensityRatio(altitude: number) {
  return Math.exp(-Math.max(0, altitude) / 8500);
}
export function speedOfSound(altitude: number) {
  const h = Math.max(0, altitude);
  const temperature =
    h <= 11000 ? 288.15 - 0.0065 * h : h <= 20000 ? 216.65 : 216.65 + 0.001 * (h - 20000);
  return 20.047 * Math.sqrt(temperature);
}
export const neutral: Controls = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  boost: false,
};
export class Flight {
  controlMode: "assisted" | "advanced" = "assisted";
  position = new Vector3(0, 1250, 2800);
  previous = this.position.clone();
  velocity = new Vector3(0, 0, -155);
  quaternion = new Quaternion();
  previousQuaternion = new Quaternion();
  yaw = 0;
  pitch = 0;
  roll = 0;
  speed = 155;
  throttle = 0.63;
  distance = 0;
  elapsed = 0;
  crashed = false;
  boost = false;
  /** Airframe multipliers: dry thrust, afterburner, drag and control authority. */
  performance = { thrust: 1, afterburner: 1, drag: 1, agility: 1 };
  /** Mach number, ambient density ratio and smoothed load factor (G) for HUD and effects. */
  mach = 0.46;
  density = 1;
  gLoad = 1;
  private forward = new Vector3();
  private lastVelocity = new Vector3();
  private acceleration = new Vector3();
  private target = new Vector3();
  private angles = new Euler(0, 0, 0, "YXZ");
  private angularVelocity = new Vector3();
  private rotationStep = new Quaternion();
  private axis = new Vector3();
  private right = new Vector3();
  private up = new Vector3();
  private assistedRotation = new Quaternion();
  reset(position?: { x: number; z: number }) {
    this.position.set(position?.x ?? 0, 1250, position?.z ?? 2800);
    this.position.y = Math.max(
      1250,
      heightAt(this.position.x, this.position.z) + 450,
    );
    this.previous.copy(this.position);
    this.yaw = this.pitch = this.roll = 0;
    this.quaternion.identity();
    this.angularVelocity.set(0, 0, 0);
    this.previousQuaternion.identity();
    this.speed = 155;
    this.throttle = 0.63;
    this.velocity.set(0, 0, -155);
    this.crashed = false;
    this.boost = false;
    this.gLoad = 1;
    this.lastVelocity.copy(this.velocity);
    this.updateAtmosphere();
  }
  private updateAtmosphere() {
    this.density = airDensityRatio(this.position.y);
    this.mach = this.speed / speedOfSound(this.position.y);
  }
  step(dt: number, control: Controls) {
    if (this.crashed || !(dt > 0) || !Number.isFinite(dt)) return;
    this.previous.copy(this.position);
    this.previousQuaternion.copy(this.quaternion);
    this.throttle = MathUtils.clamp(
      this.throttle + control.throttle * dt * 0.32,
      0.08,
      1,
    );
    if (
      control.throttleTarget !== undefined &&
      !control.throttle &&
      !control.boost
    )
      this.throttle = MathUtils.damp(
        this.throttle,
        MathUtils.clamp(control.throttleTarget, 0.08, 1),
        2,
        dt,
      );
    this.boost = control.boost && this.throttle > 0.15;
    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const bank = Math.atan2(this.right.y, this.up.y);
    const equivalentSpeed = this.speed * Math.sqrt(this.density);
    // Arcade authority follows true airspeed; only the thin stratosphere softens it.
    const thinAir = 1 - 0.5 * MathUtils.smoothstep(this.position.y, 15000, 30000);
    const authority =
      MathUtils.clamp(this.speed / 160, 0.45, 1.2) * thinAir * this.performance.agility;
    if (this.controlMode === "assisted") {
      this.angles.setFromQuaternion(this.quaternion, "YXZ");
      let desiredPitch = control.pitch
        ? this.angles.x + control.pitch * 0.65 * dt
        : MathUtils.damp(this.angles.x, 0, 1.8, dt);
      let turn = (control.roll * 0.9 + control.yaw * 0.55) * authority;
      if (control.aimDirection && control.aimDirection.lengthSq() > 0.5) {
        const direction = control.aimDirection;
        const desiredYaw = Math.atan2(-direction.x, -direction.z);
        const error = Math.atan2(
          Math.sin(desiredYaw - this.angles.y),
          Math.cos(desiredYaw - this.angles.y),
        );
        turn = MathUtils.clamp(error * 3.5, -0.95, 0.95);
        const targetPitch = Math.asin(MathUtils.clamp(direction.y, -1, 1));
        desiredPitch =
          this.angles.x +
          MathUtils.clamp(targetPitch - this.angles.x, -0.7 * dt, 0.7 * dt);
        // Target follow cannot steer the aircraft into the next terrain ridge.
        const ahead = this.speed * 2;
        const floor =
          Math.max(
            0,
            heightAt(
              this.position.x + direction.x * ahead,
              this.position.z + direction.z * ahead,
            ),
          ) + 120;
        if (this.position.y + direction.y * ahead < floor)
          desiredPitch = Math.max(
            desiredPitch,
            Math.atan2(floor - this.position.y, ahead),
          );
      }
      const desiredBank = MathUtils.clamp(turn * 0.48, -0.5, 0.5);
      this.angles.set(
        MathUtils.clamp(desiredPitch, -1.15, 1.15),
        this.angles.y + turn * dt,
        this.angles.z +
          MathUtils.clamp(
            MathUtils.damp(this.angles.z, desiredBank, 8, dt) - this.angles.z,
            -1.1 * dt,
            1.1 * dt,
          ),
        "YXZ",
      );
      this.assistedRotation.setFromEuler(this.angles);
      this.quaternion.copy(this.assistedRotation).normalize();
      this.angularVelocity.set(0, 0, 0);
    } else {
      // Local angular rates allow complete loops/rolls without Euler-angle limits.
      const pitchRate =
        control.pitch * 0.85 * authority +
        (!control.pitch && this.up.y > 0
          ? -Math.asin(this.forward.y) * 0.12
          : 0);
      const rollRate =
        control.roll * 1.55 * authority +
        (!control.roll && !control.pitch && Math.abs(this.forward.y) < 0.9
          ? -bank * 1.7
          : 0);
      this.angularVelocity.x = MathUtils.damp(
        this.angularVelocity.x,
        pitchRate,
        5,
        dt,
      );
      this.angularVelocity.y = MathUtils.damp(
        this.angularVelocity.y,
        control.yaw * 0.35,
        5,
        dt,
      );
      this.angularVelocity.z = MathUtils.damp(
        this.angularVelocity.z,
        rollRate,
        5,
        dt,
      );
      const angularSpeed = this.angularVelocity.length();
      if (angularSpeed > 1e-8) {
        this.axis.copy(this.angularVelocity).multiplyScalar(1 / angularSpeed);
        this.rotationStep.setFromAxisAngle(this.axis, angularSpeed * dt);
        this.quaternion.multiply(this.rotationStep);
      }
      // Assisted coordinated turns apply about world up, reducing unintentional sideslip.
      this.rotationStep.setFromAxisAngle(
        this.axis.set(0, 1, 0),
        Math.sin(bank) * 0.32 * dt,
      );
      this.quaternion.premultiply(this.rotationStep).normalize();
    }
    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.angles.setFromQuaternion(this.quaternion, "YXZ");
    this.pitch = this.angles.x;
    this.yaw = this.angles.y;
    this.roll = this.angles.z;
    // Thrust lapses with altitude more slowly than density falls, so the jet
    // goes faster up high: Mach ~0.95 level at sea level (dive to go supersonic), ~1.15 at 6 km, ~1.8 at 20 km.
    const lapse = this.density ** 0.7;
    const perf = this.performance;
    const thrust =
      (9 + this.throttle * 33 * perf.thrust + (this.boost ? 130 * perf.afterburner : 0)) * lapse;
    // Transonic wave-drag rise, peaking just past Mach 1.
    const wave = 1 + 0.35 * Math.exp(-(((this.mach - 1.02) / 0.15) ** 2));
    const drag = 0.00125 * perf.drag * this.density * this.speed ** 2 * wave;
    this.speed = MathUtils.clamp(
      this.speed +
        (thrust - drag - this.forward.y * 12 - Math.abs(control.pitch) * 2) *
          dt,
      45,
      720,
    );
    this.target.copy(this.forward).multiplyScalar(this.speed);
    this.target.y -= Math.max(0, 95 - equivalentSpeed) * 0.7;
    this.velocity.lerp(this.target, 1 - Math.exp(-3 * dt));
    this.position.addScaledVector(this.velocity, dt);
    // Load factor: acceleration plus gravity, projected on the aircraft's up axis.
    this.acceleration
      .copy(this.velocity)
      .sub(this.lastVelocity)
      .multiplyScalar(1 / dt);
    this.lastVelocity.copy(this.velocity);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const g = (this.acceleration.dot(this.up) + 9.81 * this.up.y) / 9.81;
    this.gLoad = MathUtils.damp(this.gLoad, MathUtils.clamp(g, -4, 11), 6, dt);
    this.updateAtmosphere();
    this.elapsed += dt;
    this.distance += this.velocity.length() * dt;
    this.crashed = sweptCollision(this.previous, this.position);
  }
}
export function sweptCollision(from: Vector3, to: Vector3) {
  const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 8));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps,
      x = MathUtils.lerp(from.x, to.x, t),
      y = MathUtils.lerp(from.y, to.y, t),
      z = MathUtils.lerp(from.z, to.z, t);
    if (Math.abs(x - 2500) < 347 && Math.abs(z + 500) < 23 && y > 53 && y < 82)
      return true;
    for (let hangar = 0; hangar < 6; hangar++)
      if (
        Math.abs(x + 795) < 30 &&
        Math.abs(z - (-300 + hangar * 115)) < 40 &&
        y < 55
      )
        return true;
    for (const [dx, dz] of [
      [0, 0],
      [-6, 0],
      [6, 0],
      [0, -7],
      [0, 7],
    ]) {
      if (y < Math.max(0, renderedHeightAt(x + dx, z + dz)) + 7) return true;
    }
  }
  return false;
}
