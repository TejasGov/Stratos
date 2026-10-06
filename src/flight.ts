import { Euler, Quaternion, Vector3, MathUtils } from "three";
import { heightAt, renderedHeightAt } from "./world/terrain";
export interface Controls {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  boost: boolean;
}
export const neutral: Controls = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  boost: false,
};
export class Flight {
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
  private forward = new Vector3();
  private target = new Vector3();
  private angles = new Euler(0, 0, 0, "YXZ");
  private angularVelocity = new Vector3();
  private rotationStep = new Quaternion();
  private axis = new Vector3();
  private right = new Vector3();
  private up = new Vector3();
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
    this.boost = control.boost && this.throttle > 0.15;
    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const bank = Math.atan2(this.right.y, this.up.y);
    const authority = MathUtils.clamp(this.speed / 160, 0.45, 1.2);
    // Local angular rates allow complete loops/rolls without Euler-angle limits.
    const pitchRate =
      control.pitch * 0.85 * authority +
      (!control.pitch && this.up.y > 0 ? -Math.asin(this.forward.y) * 0.12 : 0);
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
    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.angles.setFromQuaternion(this.quaternion, "YXZ");
    this.pitch = this.angles.x;
    this.yaw = this.angles.y;
    this.roll = this.angles.z;
    const thrust = 9 + this.throttle * 33 + (this.boost ? 27 : 0);
    const drag = 0.00125 * this.speed ** 2;
    this.speed = MathUtils.clamp(
      this.speed +
        (thrust - drag - this.forward.y * 12 - Math.abs(control.pitch) * 2) *
          dt,
      45,
      340,
    );
    this.target.copy(this.forward).multiplyScalar(this.speed);
    this.target.y -= Math.max(0, 95 - this.speed) * 0.7;
    this.velocity.lerp(this.target, 1 - Math.exp(-3 * dt));
    this.position.addScaledVector(this.velocity, dt);
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
