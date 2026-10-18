import { Euler, Quaternion, Vector3, MathUtils } from "three";
import { heightAt, renderedHeightAt } from "./world/terrain";
import { insideStructure } from "./world/baseLayout";
import { BASES, runwayThreshold, type Runway } from "./world/bases";
import type { Airframe } from "./aircraft";
export interface Controls {
  pitch: number;
  roll: number;
  yaw: number;
  throttle: number;
  boost: boolean;
  /** World-space steering cue for mouse aim or the optional target-follow assist. */
  aimDirection?: Vector3;
  throttleTarget?: number;
  /** Held: speed brake in the air, wheel brakes on the ground. */
  airbrake?: boolean;
  /** Edge-triggered: engine master switch (shut down / relight). */
  engineToggle?: boolean;
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
/** One engine's state; single-engine jets have one entry. */
export interface EngineState {
  /** 0..1 spool (thrust share actually delivered). */
  output: number;
  failed: boolean;
}
export const neutral: Controls = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  boost: false,
};
/**
 * Runway whose paved strip, grown by `across` metres either side and `along`
 * metres past each end, contains (x, z).
 */
export function runwayAt(x: number, z: number, across = 0, along = across): Runway | undefined {
  for (const { runway: r } of BASES) {
    const dx = x - r.x,
      dz = z - r.z,
      s = Math.sin(r.heading),
      c = Math.cos(r.heading);
    if (
      Math.abs(dx * s + dz * c) <= r.length / 2 + along &&
      Math.abs(dx * c - dz * s) <= r.width / 2 + across
    )
      return r;
  }
}
/** Close to a runway surface, where the terrain colliders must not count as a crash. */
export function overRunway(p: Vector3) {
  const r = runwayAt(p.x, p.z, 40, 300);
  return !!r && p.y < r.elevation + 30;
}
const IDLE = 0.08;
const DEG = Math.PI / 180;
/** Angle of attack beyond which the wing is stalled and the jet is post-stall. */
const POST_STALL = 34 * DEG;
const RELIGHT_SECONDS = 3;
/** Wheel brakes and rolling resistance (m/s²). */
const BRAKES = 6;
const ROLLING = 0.25;
/** Tail-strike limit while the main gear is on the runway. */
const MAX_GROUND_PITCH = 14 * DEG;
/** Nose attitude the assists hold after liftoff until clear of the hills around the field. */
const CLIMB_OUT = 15 * DEG;
/**
 * The arcade thrust/drag balance is tuned for cruise; at low speed both are
 * scaled down so takeoff, slow flight and the cobra recovery accelerate like
 * a jet rather than a rocket.
 */
const lowSpeed = (speed: number) => MathUtils.lerp(0.25, 1, MathUtils.smoothstep(speed, 50, 150));
/**
 * Afterburner share by airspeed. Its thrust is sized to balance drag (∝ v²) near
 * Mach 1, so it ramps in steeply up to 300 m/s: a runway kick, then a
 * strong but believable shove instead of 12 g from a slow climb-out.
 */
/** Afterburner ram-pressure gain with Mach (capped at the airframe's limit). */
export const ramGain = (mach: number, maxMach: number) => 1 + RAM * Math.min(mach, maxMach) ** 2;
/** Drag rise past the airframe's published top speed: inlets and structure are not built for more. */
export const machLimit = (mach: number, maxMach: number) => {
  const over = Math.max(0, mach - maxMach);
  return 1 + 6 * over + 80 * over * over;
};
const RAM = 0.22;
/**
 * Thrust and drag share this scale. Top speeds depend only on their ratio;
 * the scale sets how hard the jet accelerates and decelerates (about 1-3 g
 * rather than the 6-12 g an unscaled arcade model gave).
 */
export const FORCE = 0.3;
/** Cobra pitch dynamics: torques in rad/s² per unit dynamic pressure (150 m/s at sea level). */
const COBRA = {
  /** Stick pull that, with the airbrake, starts the manoeuvre. */
  pull: 0.45,
  control: 7,
  vectoring: 6,
  stability: 5,
  damping: 3,
  closing: 330 * DEG,
  settle: 3 * DEG,
};
export const burnerShare = (speed: number) => MathUtils.lerp(0.06, 1, (Math.min(speed, 300) / 300) ** 3);
interface CobraState {
  active: boolean;
  /** Nose angle above the flight path (rad, 0..2π) and its pitch rate. */
  alpha: number;
  rate: number;
  /** Past 330°: the loop finishes on its own whatever the stick does. */
  closing: boolean;
  /** Flight path: heading and climb angle, held while the nose rotates. */
  heading: number;
  path: number;
  bank: number;
}
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
  /** Post-stall authority, thrust vectoring and size of the current airframe. */
  traits = { supermanoeuvre: 0.45, thrustVectoring: false, length: 16, maxMach: 2 };
  /** Per-engine state, one entry per engine of the current airframe. */
  engines: EngineState[] = [{ output: 0.63, failed: false }];
  /** Afterburner lit, per engine. */
  afterburners: boolean[] = [false];
  /** Engine master switch: off spools every engine down to zero thrust. */
  engineMaster = true;
  /** Seconds of relight spool-up remaining after the master switch comes back on. */
  spooling = 0;
  /** Wheels on a runway (takeoff roll, landing rollout). */
  onGround = false;
  /** The runway under the wheels while on the ground. */
  runway: Runway | null = null;
  /** Origin height above the wheels' contact patch (set from the model). */
  gearHeight = 2.1;
  airbrake = false;
  /** Angle of attack (rad) between nose and flight path; post-stall while it is very high. */
  aoa = 0;
  postStall = false;
  /** Short pilot hint (e.g. why a cobra was refused) and how long to show it. */
  hint = "";
  hintTime = 0;
  /** Called on an accepted touchdown with the sink rate (m/s). */
  onTouchdown?: (sink: number) => void;
  /** Mach number, ambient density ratio and smoothed load factor (G) for HUD and effects. */
  mach = 0.46;
  density = 1;
  gLoad = 1;
  /** Thrust acceleration (m/s²) delivered on the last step. */
  thrust = 0;
  private cobraState: CobraState = { active: false, alpha: 0, rate: 0, closing: false, heading: 0, path: 0, bank: 0 };
  /** Airbrake and a hard pull held together last step (the cobra starts on the press). */
  private cobraInput = false;
  /** Core spool per engine (output before the differential-thrust split). */
  private spool: number[] = [0.63];
  private failedAt: number[] = [0];
  /** Holds the nose in a gentle climb after liftoff in assisted mode. */
  private climbOut = false;
  private climbOutUntil = 0;
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
  /** Applies an airframe's performance, engine count and post-stall traits. */
  configure(
    a: Pick<Airframe, "performance" | "engines" | "supermanoeuvre" | "thrustVectoring" | "length" | "maxMach">,
  ) {
    Object.assign(this.performance, a.performance);
    this.traits.supermanoeuvre = a.supermanoeuvre;
    this.traits.thrustVectoring = a.thrustVectoring;
    this.traits.length = a.length;
    this.traits.maxMach = a.maxMach;
    if (this.engines.length !== a.engines) {
      this.engines = Array.from({ length: a.engines }, () => ({ output: 0, failed: false }));
      this.afterburners = this.engines.map(() => false);
      this.spool = this.engines.map(() => 0);
      this.failedAt = this.engines.map(() => 0);
    }
    this.resetEngines(this.onGround ? IDLE : this.throttle);
  }
  /** Rotation speed: lighter, more agile jets fly off sooner. */
  get rotateSpeed() {
    const p = this.performance;
    return MathUtils.clamp(80 + (1 - p.agility) * 25 + (this.traits.length - 16) * 0.6, 74, 86);
  }
  get cobraActive() {
    return this.cobraState.active;
  }
  /** Nose angle above the flight path during a cobra (rad, up to 2π for a full kulbit). */
  get cobraAlpha() {
    return this.cobraState.active ? this.cobraState.alpha : 0;
  }
  /** "ENG OFF", "SPOOLING" or "" for the HUD. */
  get engineStatus() {
    if (!this.engineMaster) return "ENG OFF";
    if (this.spooling > 0) return "SPOOLING";
    return "";
  }
  /** Fire intensity 0..1 at a failed engine: fierce at first, then a steady burn. */
  engineFire(index: number) {
    const engine = this.engines[index];
    if (!engine?.failed) return 0;
    return 0.55 + 0.45 * Math.exp(-(this.elapsed - this.failedAt[index]) / 5);
  }
  private resetEngines(output: number) {
    for (let i = 0; i < this.engines.length; i++) {
      this.engines[i].failed = false;
      this.engines[i].output = output;
      this.spool[i] = output;
      this.afterburners[i] = false;
    }
    this.engineMaster = true;
    this.spooling = 0;
  }
  private clearState() {
    this.previous.copy(this.position);
    this.yaw = this.pitch = this.roll = 0;
    this.quaternion.identity();
    this.angularVelocity.set(0, 0, 0);
    this.previousQuaternion.identity();
    this.crashed = false;
    this.boost = false;
    this.airbrake = false;
    this.gLoad = 1;
    this.aoa = 0;
    this.postStall = false;
    this.hint = "";
    this.hintTime = 0;
    this.climbOut = false;
    this.cobraState.active = false;
    this.onGround = false;
    this.runway = null;
  }
  /** Airborne start (tests and tools); every sortie starts with resetOnRunway. */
  reset(position?: { x: number; z: number }) {
    this.position.set(position?.x ?? 0, 1250, position?.z ?? 2800);
    this.position.y = Math.max(
      1250,
      heightAt(this.position.x, this.position.z) + 450,
    );
    this.clearState();
    this.speed = 155;
    this.throttle = 0.63;
    this.velocity.set(0, 0, -155);
    this.resetEngines(this.throttle);
    this.lastVelocity.copy(this.velocity);
    this.updateAtmosphere();
  }
  /** Parked at the runway threshold: wheels on the surface, engines at idle. */
  resetOnRunway(runway: Runway) {
    const t = runwayThreshold(runway);
    this.position.set(t.x, t.elevation + this.gearHeight, t.z);
    this.clearState();
    this.yaw = t.heading;
    this.quaternion.setFromEuler(this.angles.set(0, t.heading, 0, "YXZ"));
    this.previousQuaternion.copy(this.quaternion);
    this.speed = 0;
    this.throttle = IDLE;
    this.velocity.set(0, 0, 0);
    this.lastVelocity.set(0, 0, 0);
    this.resetEngines(IDLE);
    this.onGround = true;
    this.runway = runway;
    this.updateAtmosphere();
  }
  /** Fails one running engine (missile hit); returns how many still run. */
  damageEngine(index?: number) {
    let i = index ?? -1;
    if (i < 0 || this.engines[i]?.failed !== false) {
      // A random running engine takes the hit.
      const running = this.engines.filter((e) => !e.failed);
      const pick = running[Math.floor(Math.random() * running.length)];
      i = pick ? this.engines.indexOf(pick) : -1;
    }
    if (i >= 0) {
      this.engines[i].failed = true;
      this.engines[i].output = 0;
      this.spool[i] = 0;
      this.afterburners[i] = false;
      this.failedAt[i] = this.elapsed;
    }
    return this.engines.filter((e) => !e.failed).length;
  }
  private notify(text: string) {
    this.hint = text;
    this.hintTime = 2.5;
  }
  /**
   * Pugachev's cobra, flown with the airbrake and a hard pull: the nose rears
   * up while the flight path barely moves and the jet bleeds speed like a
   * parachute. Refused (with a hint) outside its speed window or when banked.
   */
  startCobra() {
    const c = this.cobraState;
    if (this.onGround || c.active || this.crashed) return false;
    // Heavier, less agile airframes need more speed for the same control power.
    const scale = 1 + 0.15 * (1 - this.performance.agility);
    const low = 110 * scale,
      high = 190 * scale;
    const knots = (v: number) => Math.round(v * 1.94384 / 5) * 5;
    if (this.speed > high) {
      this.notify(`COBRA · TOO FAST · BELOW ${knots(high)} KT`);
      return false;
    }
    if (this.speed < low) {
      this.notify(`COBRA · TOO SLOW · ABOVE ${knots(low)} KT`);
      return false;
    }
    const bank = Math.atan2(this.right.set(1, 0, 0).applyQuaternion(this.quaternion).y, this.up.set(0, 1, 0).applyQuaternion(this.quaternion).y);
    const path = Math.asin(MathUtils.clamp(this.velocity.y / Math.max(1, this.velocity.length()), -1, 1));
    if (Math.abs(bank) > 0.6 || Math.abs(path) > 0.5) {
      this.notify("COBRA · LEVEL THE WINGS AND FLIGHT PATH");
      return false;
    }
    c.alpha = Math.max(0, this.aoa);
    c.rate = 0;
    c.closing = false;
    c.heading = Math.atan2(-this.velocity.x, -this.velocity.z);
    c.path = path;
    c.bank = bank;
    c.active = true;
    this.angularVelocity.set(0, 0, 0);
    this.climbOut = false;
    return true;
  }
  private toggleEngines() {
    if (this.engines.every((e) => e.failed)) return;
    this.engineMaster = !this.engineMaster;
    this.spooling = this.engineMaster ? RELIGHT_SECONDS : 0;
    this.notify(this.engineMaster ? "ENGINE RELIGHT" : "ENGINES SHUT DOWN");
  }
  private updateAtmosphere() {
    this.density = airDensityRatio(this.position.y);
    this.mach = this.speed / speedOfSound(this.position.y);
  }
  /**
   * Spools each engine toward the throttle. Twins split thrust left/right for
   * rudder and hard rolling turns; returns the asymmetric-thrust yaw rate
   * (rad/s, + = left) from a dead or shut-down engine.
   */
  private updateEngines(dt: number, control: Controls) {
    const n = this.engines.length;
    this.spooling = Math.max(0, this.spooling - dt);
    const relight = this.spooling > 0 ? MathUtils.smoothstep(1 - this.spooling / RELIGHT_SECONDS, 0, 1) : 1;
    const hardRoll = Math.sign(control.roll) * MathUtils.clamp((Math.abs(control.roll) - 0.6) / 0.4, 0, 1);
    const split = n === 2 ? MathUtils.clamp(control.yaw + hardRoll * 0.6, -1, 1) * 0.22 : 0;
    let burning = false;
    for (let i = 0; i < n; i++) {
      const e = this.engines[i];
      if (e.failed) {
        this.spool[i] = e.output = 0;
        this.afterburners[i] = false;
        continue;
      }
      const target = this.engineMaster ? Math.min(this.throttle, relight) : 0;
      // Running engines answer the throttle briskly; a shut-down core winds down slowly.
      this.spool[i] = MathUtils.damp(this.spool[i], target, this.engineMaster ? 3 : 0.9, dt);
      // Engine 0 is the left (port) engine: left rudder throttles it back.
      const side = n === 2 ? (i === 0 ? -1 : 1) : 0;
      e.output = MathUtils.clamp(this.spool[i] * (1 + side * split), 0, 1);
      this.afterburners[i] =
        control.boost && this.engineMaster && this.spooling === 0 && this.throttle > 0.15 && this.spool[i] > 0.4;
      burning ||= this.afterburners[i];
    }
    this.boost = burning;
    if (n !== 2) return 0;
    const t0 = this.engineThrust(0, this.spool[0]),
      t1 = this.engineThrust(1, this.spool[1]);
    const max = 2 * (42 + 130) * this.performance.thrust;
    // The live engine pushes the nose toward the dead one.
    return ((t1 - t0) / max) * 0.7;
  }
  /** One engine's dry airborne thrust (m/s², before the engine-count share and low-speed scaling). */
  private dryThrust(output: number) {
    const k = 33 * this.performance.thrust;
    return output < IDLE ? (output / IDLE) * (9 + k * IDLE) : 9 + k * output;
  }
  private engineThrust(i: number, output: number) {
    return this.dryThrust(output) + (this.afterburners[i] ? 130 * this.performance.afterburner : 0);
  }
  /** Total thrust (m/s²) along the nose, airborne or on the wheels, already scaled for low speed. */
  private totalThrust(ground: boolean) {
    const p = this.performance,
      f = lowSpeed(this.speed);
    let thrust = 0;
    if (ground) {
      // On the wheels: about 0.6 g at full military power, 0.35 g more in reheat;
      // idle only balances rolling resistance.
      for (let i = 0; i < this.engines.length; i++) {
        const o = this.engines[i].output;
        thrust += (Math.max(0, o - IDLE) / (1 - IDLE)) * 6 * p.thrust + (this.afterburners[i] ? 3.5 * p.afterburner : 0);
      }
      return (this.thrust = thrust / this.engines.length);
    }
    for (let i = 0; i < this.engines.length; i++) {
      const o = this.engines[i].output;
      thrust += this.dryThrust(o) * f + (this.afterburners[i] ? 130 * p.afterburner * burnerShare(this.speed) * ramGain(this.mach, this.traits.maxMach) : 0);
    }
    return (this.thrust = FORCE * (thrust / this.engines.length) * this.density ** 0.7);
  }
  step(dt: number, control: Controls) {
    if (this.crashed || !(dt > 0) || !Number.isFinite(dt)) return;
    this.previous.copy(this.position);
    this.previousQuaternion.copy(this.quaternion);
    this.throttle = MathUtils.clamp(
      this.throttle + control.throttle * dt * 0.32,
      IDLE,
      1,
    );
    if (
      control.throttleTarget !== undefined &&
      !control.throttle &&
      !control.boost &&
      !this.onGround
    )
      this.throttle = MathUtils.damp(
        this.throttle,
        MathUtils.clamp(control.throttleTarget, IDLE, 1),
        2,
        dt,
      );
    this.hintTime = Math.max(0, this.hintTime - dt);
    if (control.engineToggle) this.toggleEngines();
    this.airbrake = !!control.airbrake;
    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const cobraInput = this.airbrake && control.pitch >= COBRA.pull && !this.onGround;
    if (cobraInput && !this.cobraInput) this.startCobra();
    this.cobraInput = cobraInput;
    const asymmetry = this.updateEngines(dt, control);
    // Differential thrust adds yaw authority while both engines of a twin run.
    const differential =
      this.engines.length === 2 && this.engineMaster && !this.engines[0].failed && !this.engines[1].failed
        ? MathUtils.smoothstep(this.spool[0] + this.spool[1], 0.1, 0.8)
        : 0;
    if (this.onGround) this.stepGround(dt, control, differential);
    else if (this.cobraState.active) this.stepCobra(dt, control);
    else this.stepAir(dt, control, asymmetry, differential);
    if (!this.onGround && !this.crashed && this.velocity.y < 0) this.checkTouchdown();
    // Load factor: acceleration plus gravity, projected on the aircraft's up axis.
    this.acceleration
      .copy(this.velocity)
      .sub(this.lastVelocity)
      .multiplyScalar(1 / dt);
    this.lastVelocity.copy(this.velocity);
    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const g = (this.acceleration.dot(this.up) + 9.81 * this.up.y) / 9.81;
    this.gLoad = MathUtils.damp(this.gLoad, MathUtils.clamp(g, -4, 11), 6, dt);
    this.aoa = this.velocity.lengthSq() > 1 ? this.forward.angleTo(this.velocity) : 0;
    this.postStall = this.aoa > POST_STALL;
    this.updateAtmosphere();
    this.elapsed += dt;
    this.distance += this.velocity.length() * dt;
    if (!this.crashed) this.crashed = sweptCollision(this.previous, this.position);
  }
  /** Takeoff roll and landing rollout: wheels glued to the runway until lift beats weight. */
  private stepGround(dt: number, control: Controls, differential: number) {
    const runway = this.runway!;
    const vr = this.rotateSpeed;
    const p = this.performance;
    let v = this.speed;
    const drag = FORCE * 0.00125 * p.drag * lowSpeed(v) * v * v * (this.airbrake ? 1.8 : 1);
    const thrust = this.totalThrust(true);
    const resist = ROLLING + (this.airbrake ? BRAKES : 0) + drag;
    // Friction and brakes stop the jet but never push it backwards.
    if (v < 0.05 && thrust <= resist) v = 0;
    else v = Math.max(0, v + (thrust - resist) * dt);
    this.speed = v;
    // Nosewheel steering (rudder, plus A/D in easy mode): tight when slow, gentle at speed.
    const steer = MathUtils.clamp(
      control.yaw + (this.controlMode === "assisted" ? control.roll : 0),
      -1,
      1,
    );
    this.yaw += ((steer * v) / (25 + v * v * 0.15)) * (1 + 0.3 * differential) * dt;
    // Rotation: the elevator only lifts the nosewheel from Vr; steering assists rotate on their own.
    const elevator = MathUtils.smoothstep(v, 0.88 * vr, vr);
    const aim = control.aimDirection && control.aimDirection.lengthSq() > 0.5 ? 1 : 0;
    const pull = Math.max(control.pitch, aim * (this.pitch < 10 * DEG ? 1 : 0));
    if (pull > 0 && elevator > 0) this.pitch += pull * 0.17 * elevator * dt;
    else this.pitch -= (control.pitch < 0 ? 0.25 : 0.1) * dt;
    this.pitch = MathUtils.clamp(this.pitch, 0, MAX_GROUND_PITCH);
    this.roll = 0;
    this.quaternion.setFromEuler(this.angles.set(this.pitch, this.yaw, 0, "YXZ"));
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.velocity.copy(this.forward).multiplyScalar(v);
    this.position.addScaledVector(this.velocity, dt);
    // Lift grows with speed² and with the wing's angle to the runway.
    const lift = (v / vr) ** 2 * ((this.pitch + 2 * DEG) / (11 * DEG));
    if (lift >= 1 && v > 0.9 * vr) {
      this.onGround = false;
      this.runway = null;
      this.climbOut = true;
      this.climbOutUntil = runway.elevation + 600;
      this.angularVelocity.set(0, 0, 0);
      return;
    }
    this.position.y = runway.elevation + this.gearHeight;
    // Leaving the paved strip at speed puts the gear into the dirt.
    if (!runwayAt(this.position.x, this.position.z, 3, 60)) this.crashed = true;
  }
  /** Touchdown on a runway: gentle, wings level and nose sensible rolls out; anything else crashes. */
  private checkTouchdown() {
    const p = this.position;
    const runway = runwayAt(p.x, p.z);
    if (!runway || p.y - this.gearHeight > runway.elevation) return;
    const sink = -this.velocity.y;
    if (
      !this.cobraState.active &&
      sink < 5 &&
      Math.abs(this.roll) < 15 * DEG &&
      this.pitch > -3 * DEG &&
      this.pitch < 15 * DEG
    ) {
      this.onGround = true;
      this.runway = runway;
      this.climbOut = false;
      p.y = runway.elevation + this.gearHeight;
      this.velocity.y = 0;
      this.speed = Math.hypot(this.velocity.x, this.velocity.z);
      this.pitch = Math.max(0, this.pitch);
      this.roll = 0;
      this.angularVelocity.set(0, 0, 0);
      this.quaternion.setFromEuler(this.angles.set(this.pitch, this.yaw, 0, "YXZ"));
      this.onTouchdown?.(sink);
    } else this.crashed = true;
  }
  private stepCobra(dt: number, control: Controls) {
    const c = this.cobraState;
    let v = this.speed;
    // Pitch torque balance (rad/s²). The tail's control power and the airframe's
    // weathervane stability both scale with dynamic pressure; vectored nozzles
    // add power that does not, so they keep rotating the nose once the jet has
    // slowed. Stability pulls the nose toward the airflow: back down below 180°,
    // on round to 360° above it, which is what completes a kulbit.
    const q = Math.max(0.15, this.density * (v / 150) ** 2);
    const output = this.engines.reduce((sum, e) => sum + e.output, 0) / this.engines.length;
    const authority =
      COBRA.control * this.traits.supermanoeuvre * q +
      (this.traits.thrustVectoring ? COBRA.vectoring * (0.4 + 0.6 * output) : 0);
    if (c.alpha > COBRA.closing) c.closing = true;
    // Full authority from half stick, so the lowest sensitivity setting still flies it.
    const pull = c.closing ? 0 : MathUtils.clamp(control.pitch / 0.5, 0, 1);
    // Released, the pilot (or fly-by-wire) flies the nose onto the nearer alignment: 0° or 360°.
    const target = c.alpha < Math.PI ? 0 : 2 * Math.PI;
    const command =
      pull > 0 ? pull * authority : MathUtils.clamp(3 * (target - c.alpha) - 1.2 * c.rate, -1, 1) * authority;
    c.rate += (command - COBRA.stability * q * Math.sin(c.alpha) - COBRA.damping * c.rate) * dt;
    c.alpha = Math.max(0, c.alpha + c.rate * dt);
    const sinA = Math.sin(c.alpha),
      cosA = Math.cos(c.alpha);
    const f = lowSpeed(v);
    const thrust = this.totalThrust(false);
    // The fuselage and wing broadside-on to the airflow: an enormous airbrake.
    const drag = 0.00125 * this.performance.drag * this.density * v * v;
    const form = 0.0042 * this.density * v * v * sinA * sinA;
    v += (thrust * cosA - f * drag - form - 9.81 * Math.sin(c.path)) * dt;
    v = MathUtils.clamp(v, 45, 720);
    // Lift peaks near 45° and collapses post-stall; thrust holds the nose-high jet up.
    const load = c.alpha < Math.PI / 2 ? (v / 150) ** 2 * 1.1 * Math.sin(2 * c.alpha) * this.density : 0;
    c.path += ((9.81 * (load - Math.cos(c.path)) + thrust * sinA * 0.35) / v) * dt;
    c.bank = MathUtils.damp(c.bank, 0, 3, dt);
    this.speed = v;
    const cp = Math.cos(c.path);
    this.velocity.set(-Math.sin(c.heading) * cp * v, Math.sin(c.path) * v, -Math.cos(c.heading) * cp * v);
    this.position.addScaledVector(this.velocity, dt);
    this.pitch = c.path + c.alpha;
    this.yaw = c.heading;
    this.roll = c.bank;
    this.quaternion.setFromEuler(this.angles.set(this.pitch, this.yaw, this.roll, "YXZ"));
    // Back on the flight path, nose forward or a full turn round: normal flight resumes.
    const off = Math.min(c.alpha, Math.abs(2 * Math.PI - c.alpha));
    if (!pull && off < COBRA.settle && Math.abs(c.rate) < 0.6) {
      c.active = false;
      this.pitch = c.path;
      this.quaternion.setFromEuler(this.angles.set(this.pitch, this.yaw, this.roll, "YXZ"));
    }
  }
  /** Easy-mode departure: a steady climb, steeper when a ridge lies ahead of the field. */
  private climbOutPitch() {
    let pitch = CLIMB_OUT;
    const dx = -Math.sin(this.yaw),
      dz = -Math.cos(this.yaw);
    for (let d = 300; d <= 2400; d += 300) {
      const floor = Math.max(0, heightAt(this.position.x + dx * d, this.position.z + dz * d)) + 90;
      pitch = Math.max(pitch, Math.atan2(floor - this.position.y, d));
    }
    return Math.min(pitch, 24 * DEG);
  }
  private stepAir(dt: number, control: Controls, asymmetry: number, differential: number) {
    const bank = Math.atan2(this.right.y, this.up.y);
    const equivalentSpeed = this.speed * Math.sqrt(this.density);
    // Arcade authority follows true airspeed; only the thin stratosphere softens it.
    const thinAir = 1 - 0.5 * MathUtils.smoothstep(this.position.y, 15000, 30000);
    const authority =
      MathUtils.clamp(this.speed / 160, 0.45, 1.2) * thinAir * this.performance.agility;
    const rudder = 1 + 0.35 * differential;
    const hardTurn = 1 + 0.08 * differential * MathUtils.clamp((Math.abs(control.roll) - 0.6) / 0.4, 0, 1);
    // The climb-out hold ends once well clear of the hills around the field, or when the pilot pushes over.
    if (control.pitch < 0 || this.position.y > this.climbOutUntil) this.climbOut = false;
    if (this.controlMode === "assisted") {
      this.angles.setFromQuaternion(this.quaternion, "YXZ");
      // After liftoff the auto-level holds a gentle climb instead of the horizon.
      const level = this.climbOut ? this.climbOutPitch() : 0;
      let desiredPitch = control.pitch
        ? this.angles.x + control.pitch * 0.65 * dt
        : MathUtils.damp(this.angles.x, level, 1.8, dt);
      let turn =
        (control.roll * 0.9 * hardTurn + control.yaw * 0.55 * rudder) * authority + asymmetry;
      if (control.aimDirection && control.aimDirection.lengthSq() > 0.5) {
        const direction = control.aimDirection;
        const desiredYaw = Math.atan2(-direction.x, -direction.z);
        const error = Math.atan2(
          Math.sin(desiredYaw - this.angles.y),
          Math.cos(desiredYaw - this.angles.y),
        );
        turn = MathUtils.clamp(error * 3.5, -0.95, 0.95) + asymmetry;
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
      // Past the airframe's AoA limit the stalled wing pitches the nose back
      // toward the flight path; supermanoeuvrable jets hold far higher angles.
      const limit = (22 + 50 * this.traits.supermanoeuvre) * DEG;
      const stall = this.aoa > limit ? -(this.aoa - limit) * 3 : 0;
      // Vectored nozzles keep pitch authority when the airflow runs out, so a
      // hard pull at low speed drags the nose deep past the stall.
      const pitchAuthority = this.traits.thrustVectoring
        ? Math.max(authority, 0.95 * thinAir * this.performance.agility * this.traits.supermanoeuvre)
        : authority;
      // Local angular rates allow complete loops/rolls without Euler-angle limits.
      const pitchRate =
        control.pitch * 0.85 * pitchAuthority +
        stall +
        (!control.pitch && this.up.y > 0
          ? -(Math.asin(this.forward.y) - (this.climbOut ? CLIMB_OUT : 0)) * 0.12
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
        control.yaw * 0.35 * rudder + asymmetry,
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
        Math.sin(bank) * 0.32 * hardTurn * dt,
      );
      this.quaternion.premultiply(this.rotationStep).normalize();
    }
    this.forward.set(0, 0, -1).applyQuaternion(this.quaternion);
    this.angles.setFromQuaternion(this.quaternion, "YXZ");
    this.pitch = this.angles.x;
    this.yaw = this.angles.y;
    this.roll = this.angles.z;
    // Thrust lapses with altitude more slowly than density falls and the
    // afterburner gains ram pressure with Mach, so jets reach their published
    // top speed around 11-15 km and stay near Mach 1.2 down low.
    const thrust = this.totalThrust(false);
    const perf = this.performance;
    // Transonic wave-drag rise, peaking just past Mach 1.
    const wave = 1 + 0.35 * Math.exp(-(((this.mach - 1.02) / 0.15) ** 2));
    const drag =
      FORCE * 0.00125 * perf.drag * this.density * this.speed ** 2 * wave * machLimit(this.mach, this.traits.maxMach) * (this.airbrake ? 1.9 : 1);
    // Induced and form drag climb steeply once the wing is pulled hard or stalled.
    const stalled = Math.sin(Math.max(0, this.aoa - 8 * DEG)) ** 2;
    const form = 0.0042 * this.density * this.speed ** 2 * stalled;
    this.speed = MathUtils.clamp(
      this.speed +
        (thrust -
          lowSpeed(this.speed) * drag -
          form -
          this.forward.y * 12 -
          Math.abs(control.pitch) * 2) *
          dt,
      45,
      720,
    );
    this.target.copy(this.forward).multiplyScalar(this.speed);
    this.target.y -= Math.max(0, 95 - equivalentSpeed) * 0.7;
    // A slow wing has less lift to bend the flight path toward the nose.
    const turnRate = 3 * MathUtils.clamp((this.speed / 135) ** 2, 0.2, 1);
    this.velocity.lerp(this.target, 1 - Math.exp(-turnRate * dt));
    this.position.addScaledVector(this.velocity, dt);
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
    if (insideStructure(x, y, z)) return true;
    // Over a runway and its shoulders the paved surface is the floor: wheels
    // on it are not a crash (Flight.checkTouchdown judges the landing).
    const runway = runwayAt(x, z, 25, 150);
    if (runway) {
      if (y < runway.elevation + 0.5) return true;
      continue;
    }
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
