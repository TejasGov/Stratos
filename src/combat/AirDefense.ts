import { MathUtils, Vector3 } from "three";
import { HAVEN, SAM_SITES, type SamSite, type SamType } from "../world/bases";
import {
  MISSILES,
  engineHeat,
  type EngineHeat,
  type MissileProfile,
} from "./Missiles";
import type { CombatEntity } from "./CombatSystem";

/**
 * Enemy ground-based air defence built from SAM_SITES. Game rules, tuned for
 * fun: radar batteries see far but stealth, terrain, low flying, notching and
 * post-stall manoeuvres all beat them; short-range launchers see heat.
 */
export interface SamRules {
  type: SamType;
  /** Radar search range for rcs 1 (mrsam) or IR detection range at dry power (shorad). */
  detectRange: number;
  /** Seconds of continuous detection to build a firing solution. */
  trackTime: number;
  /** Track lost per second while the target is unseen (memory bridges short gaps). */
  trackDecay: number;
  launchRange: number;
  minLaunchRange: number;
  /** Missiles from this unit allowed in the air at once. */
  maxInFlight: number;
  /** Seconds between launches. */
  reload: number;
  /** Sensor height above the site (mast or turret). */
  sensorHeight: number;
  missile: MissileProfile;
  /** Separate radar vehicle: destroying it blinds the battery. */
  radarVehicle: boolean;
}

export const SAM_RULES: Record<SamType, SamRules> = {
  shorad: {
    type: "shorad",
    detectRange: 5500,
    trackTime: 2,
    trackDecay: 0.6,
    launchRange: 4200,
    minLaunchRange: 250,
    maxInFlight: 1,
    reload: 6,
    sensorHeight: 4,
    missile: MISSILES.shorad,
    radarVehicle: false,
  },
  mrsam: {
    type: "mrsam",
    detectRange: 12000,
    trackTime: 3.2,
    trackDecay: 0.35,
    launchRange: 9000,
    minLaunchRange: 900,
    maxInFlight: 2,
    reload: 5,
    sensorHeight: 12,
    missile: MISSILES.mrsam,
    radarVehicle: true,
  },
};

/** Radar rules shared by the battery search sensors. */
export const RADAR = {
  /** Below this height above ground the jet hides in ground clutter… */
  lowAltitude: 100,
  /** …unless closer than this. Fully visible again by lowAltitude + lowBlend. */
  lowRange: 3000,
  lowBlend: 120,
  /** Radial speed below this fraction of speed is lost in the Doppler notch… */
  notch: 0.2,
  /** …beyond this range. */
  notchRange: 2200,
  /** Emitters are heard on the warning receiver this far beyond their own detection range. */
  rwrMargin: 1.35,
};

/** Weapons hold on ground-launched missiles beyond this many in flight at the player. */
export const MAX_SAMS_IN_FLIGHT = 3;
/**
 * Arcade rule: batteries search and track over Haven's island but hold fire
 * inside this radius of its runway, so takeoffs and home-field fights are
 * not under the forward sites' umbrella.
 */
export const HOME_UMBRELLA = { x: HAVEN.runway.x, z: HAVEN.runway.z, radius: 3000 };
export function underHomeUmbrella(position: Vector3) {
  return (
    Math.hypot(position.x - HOME_UMBRELLA.x, position.z - HOME_UMBRELLA.z) <
    HOME_UMBRELLA.radius
  );
}
const SENSOR_PERIOD = 0.1;
const UP = new Vector3(0, 1, 0);

export type Detection =
  | "detected"
  | "range"
  | "terrain"
  | "low"
  | "notch"
  | "poststall"
  | "blind";

export interface SensorTarget extends EngineHeat {
  position: Vector3;
  velocity: Vector3;
  /** Airframe radar cross-section (1 = older fighter). */
  rcs?: number;
  postStall?: boolean;
}

/** Radar search range against a jet: the fourth-root law makes stealth count, but not absolutely. */
export function radarDetectionRange(rcs = 1) {
  return SAM_RULES.mrsam.detectRange * Math.max(0.01, rcs) ** 0.25;
}

/** IR/optical detection by proximity: afterburner doubles down, cold engines hide. */
export function irDetectionRange(target: EngineHeat) {
  const heat = engineHeat({ ...target, boost: false });
  // Dead engines leave only the airframe's glint and skin heat.
  if (heat <= 0.1) return SAM_RULES.shorad.detectRange * 0.3;
  return (
    SAM_RULES.shorad.detectRange *
    (0.7 + 0.3 * Math.min(1, heat)) *
    (target.boost ? 1.5 : 1)
  );
}

const sample = new Vector3();
/** Terrain line of sight, sampling the ground every ~`step` metres. */
export function terrainClear(
  from: Vector3,
  to: Vector3,
  ground: (x: number, z: number) => number,
  step = 90,
) {
  const steps = Math.max(1, Math.ceil(from.distanceTo(to) / step));
  for (let i = 1; i < steps; i++) {
    sample.lerpVectors(from, to, i / steps);
    if (sample.y < ground(sample.x, sample.z)) return false;
  }
  return true;
}

const los = new Vector3();
/**
 * Whether a sensor of `type` at `sensor` can see the target this instant. Cheap
 * geometric rules run before the terrain sample.
 */
export function samDetection(
  type: SamType,
  sensor: Vector3,
  target: SensorTarget,
  ground: (x: number, z: number) => number,
): Detection {
  los.copy(target.position).sub(sensor);
  const range = los.length();
  if (type === "mrsam") {
    let reach = radarDetectionRange(target.rcs ?? 1);
    const agl =
      target.position.y - ground(target.position.x, target.position.z);
    if (agl < RADAR.lowAltitude + RADAR.lowBlend)
      reach = Math.min(
        reach,
        MathUtils.lerp(
          RADAR.lowRange,
          reach,
          MathUtils.clamp((agl - RADAR.lowAltitude) / RADAR.lowBlend, 0, 1),
        ),
      );
    if (range > reach) return agl < RADAR.lowAltitude && range <= radarDetectionRange(target.rcs ?? 1) ? "low" : "range";
    if (target.postStall) return "poststall";
    const speed = target.velocity.length();
    if (
      range > RADAR.notchRange &&
      speed > 40 &&
      Math.abs(target.velocity.dot(los)) / range < RADAR.notch * speed
    )
      return "notch";
  } else if (range > irDetectionRange(target)) return "range";
  return terrainClear(sensor, target.position, ground) ? "detected" : "terrain";
}

export type SamState = "search" | "track" | "launch" | "reload" | "destroyed";

export interface SamUnit {
  site: SamSite;
  rules: SamRules;
  launcher: CombatEntity;
  radar: CombatEntity | null;
  /** Global sensor position (radar mast or launcher turret). */
  sensor: Vector3;
  state: SamState;
  stateTime: number;
  /** 0..1 firing solution. */
  track: number;
  sees: boolean;
  detection: Detection;
  /** Player inside this unit's radar emission with line of sight (warning receiver "search"). */
  painting: boolean;
  cooldown: number;
  range: number;
  /** Warning-receiver level: 0 silent, 1 search, 2 track, 3 launch. */
  rwr: 0 | 1 | 2 | 3;
  sensorClock: number;
  /** Presentation: launcher slew (yaw, world), canister elevation, antenna spin. */
  turretYaw: number;
  elevation: number;
  antenna: number;
}

/** CombatSystem services the network needs, without importing world code. */
export interface DefenseHost {
  readonly elapsed: number;
  /** Player airborne and past the takeoff grace. */
  readonly weaponsFree: boolean;
  ground(x: number, z: number): number;
  addGroundEntity(
    name: string,
    role: CombatEntity["role"],
    tag: string,
    position: Vector3,
    health: number,
    radius: number,
  ): CombatEntity;
  /** Launches a SAM at the player; false when the pool is exhausted. */
  launchSam(
    unit: SamUnit,
    position: Vector3,
    direction: Vector3,
  ): boolean;
  /** Hostile missiles from `owner` still in the air (any target). */
  inFlight(owner: number): number;
  /** Ground-launched missiles in the air at the player. */
  samsInFlight(): number;
}

export class AirDefense {
  readonly units: SamUnit[] = [];
  /** Any battery has a firing solution building on the player. */
  tracking = false;
  private toTarget = new Vector3();
  private origin = new Vector3();
  private aim = new Vector3();
  constructor(private host: DefenseHost) {}

  start(sites: readonly SamSite[] = SAM_SITES) {
    this.units.length = 0;
    this.tracking = false;
    sites.forEach((site, i) => {
      const rules = SAM_RULES[site.type];
      const label = site.id.toUpperCase();
      const ground = this.host.ground(site.x, site.z);
      // Launcher beside the site centre; the battery radar 40 m away on its mast.
      const launcher = this.host.addGroundEntity(
        rules.radarVehicle ? `${label} SAM LAUNCHER` : `${label} SHORAD`,
        "sam-launcher",
        site.id,
        new Vector3(site.x, ground + 3, site.z),
        60,
        9,
      );
      let radar: CombatEntity | null = null;
      const sensor = new Vector3(site.x, ground + rules.sensorHeight, site.z);
      if (rules.radarVehicle) {
        const rx = site.x + 40,
          rz = site.z + 12;
        const rg = this.host.ground(rx, rz);
        radar = this.host.addGroundEntity(
          `${label} SAM RADAR`,
          "sam-radar",
          site.id,
          new Vector3(rx, rg + 3, rz),
          60,
          9,
        );
        sensor.set(rx, rg + rules.sensorHeight, rz);
      }
      // Hulls parked at assorted headings; launchers slew independently.
      const hull = (i * 2.4 + 0.6) % (Math.PI * 2);
      launcher.quaternion.setFromAxisAngle(UP, hull);
      radar?.quaternion.setFromAxisAngle(UP, hull + 0.9);
      this.units.push({
        site,
        rules,
        launcher,
        radar,
        sensor,
        state: "search",
        stateTime: 0,
        track: 0,
        sees: false,
        detection: "range",
        painting: false,
        cooldown: 2 + i * 0.7,
        range: Infinity,
        rwr: 0,
        sensorClock: (i * SENSOR_PERIOD) / sites.length,
        turretYaw: hull,
        elevation: 0.12,
        antenna: i * 1.3,
      });
    });
  }
  clear() {
    this.units.length = 0;
    this.tracking = false;
  }
  /** The battery that fired `owner`'s missile still holds the target: midcourse command guidance. */
  commandLink(owner: number) {
    for (const u of this.units)
      if (u.launcher.id === owner)
        return u.state !== "destroyed" && u.sees && !!u.radar?.active;
    return false;
  }
  unitFor(entityId: number) {
    for (const u of this.units)
      if (u.launcher.id === entityId || u.radar?.id === entityId) return u;
    return null;
  }
  step(dt: number, target: SensorTarget, ground: (x: number, z: number) => number) {
    this.tracking = false;
    for (const u of this.units) {
      u.stateTime += dt;
      u.cooldown -= dt;
      const launcherAlive = u.launcher.active;
      const sensorAlive = u.radar ? u.radar.active : launcherAlive;
      if (!launcherAlive && !sensorAlive) {
        if (u.state !== "destroyed") this.setState(u, "destroyed");
        u.sees = u.painting = false;
        u.track = 0;
        u.rwr = 0;
        continue;
      }
      this.toTarget.copy(target.position).sub(u.sensor);
      u.range = this.toTarget.length();
      u.sensorClock -= dt;
      if (u.sensorClock <= 0) {
        u.sensorClock += SENSOR_PERIOD;
        if (!sensorAlive) {
          u.detection = "blind";
          u.sees = u.painting = false;
        } else {
          u.detection = samDetection(u.rules.type, u.sensor, target, ground);
          u.sees = u.detection === "detected";
          // The radar's own emission reaches the jet before its echo comes back strong enough.
          u.painting =
            !!u.radar &&
            (u.sees ||
              (u.detection !== "terrain" &&
                u.range < radarDetectionRange(1) * RADAR.rwrMargin &&
                terrainClear(u.sensor, target.position, ground, 200)));
        }
      }
      u.track = MathUtils.clamp(
        u.track + (u.sees ? dt / u.rules.trackTime : -dt * u.rules.trackDecay),
        0,
        1,
      );
      if (u.track > 0) this.tracking = true;
      switch (u.state) {
        case "search":
          if (u.track > 0) this.setState(u, "track");
          break;
        case "track":
          if (u.track <= 0) this.setState(u, "search");
          else if (
            launcherAlive &&
            u.sees &&
            u.track >= 1 &&
            this.host.weaponsFree &&
            !underHomeUmbrella(target.position) &&
            u.cooldown <= 0 &&
            u.range < u.rules.launchRange &&
            u.range > u.rules.minLaunchRange &&
            this.host.inFlight(u.launcher.id) < u.rules.maxInFlight &&
            this.host.samsInFlight() < MAX_SAMS_IN_FLIGHT &&
            this.launch(u, target)
          )
            this.setState(u, "launch");
          break;
        case "launch":
          if (u.stateTime > 0.8) {
            u.cooldown = u.rules.reload;
            this.setState(u, "reload");
          }
          break;
        case "reload":
          if (u.cooldown <= 0)
            this.setState(u, u.track > 0 ? "track" : "search");
          break;
      }
      u.rwr =
        u.state === "launch" || this.host.inFlight(u.launcher.id) > 0
          ? 3
          : u.track > 0
            ? 2
            : u.painting
              ? 1
              : 0;
      this.animate(u, dt, target.position);
    }
  }
  private setState(u: SamUnit, state: SamState) {
    u.state = state;
    u.stateTime = 0;
  }
  private launch(u: SamUnit, target: SensorTarget) {
    const p = u.launcher.position;
    this.toTarget.copy(target.position).sub(p);
    const horizontal = Math.hypot(this.toTarget.x, this.toTarget.z);
    // Loft above the line of sight: the boost phase climbs out before turning over.
    const elevation = MathUtils.clamp(
      Math.atan2(this.toTarget.y, horizontal) + 0.2,
      0.3,
      u.rules.type === "mrsam" ? 1.1 : 0.9,
    );
    const yaw = Math.atan2(this.toTarget.x, this.toTarget.z);
    this.aim.set(
      Math.sin(yaw) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(yaw) * Math.cos(elevation),
    );
    this.origin.copy(p).addScaledVector(this.aim, 6);
    this.origin.y += 3;
    return this.host.launchSam(u, this.origin, this.aim);
  }
  private animate(u: SamUnit, dt: number, target: Vector3) {
    const p = u.launcher.position;
    const engaged = u.track > 0 || u.state === "launch" || u.state === "reload";
    if (u.state === "destroyed") return;
    if (engaged) {
      const yaw = Math.atan2(-(target.x - p.x), -(target.z - p.z));
      const error = Math.atan2(
        Math.sin(yaw - u.turretYaw),
        Math.cos(yaw - u.turretYaw),
      );
      u.turretYaw += MathUtils.clamp(error, -0.9 * dt, 0.9 * dt);
      const horizontal = Math.hypot(target.x - p.x, target.z - p.z);
      const want = MathUtils.clamp(Math.atan2(target.y - p.y, horizontal) + 0.2, 0.15, 1.1);
      u.elevation += MathUtils.clamp(want - u.elevation, -0.5 * dt, 0.5 * dt);
    } else u.elevation += MathUtils.clamp(0.12 - u.elevation, -0.3 * dt, 0.3 * dt);
    // Search antennas sweep; tracking ones hold on the target.
    if (u.track > 0.05 && u.sees) {
      const yaw = Math.atan2(-(target.x - u.sensor.x), -(target.z - u.sensor.z));
      const error = Math.atan2(Math.sin(yaw - u.antenna), Math.cos(yaw - u.antenna));
      u.antenna += MathUtils.clamp(error, -3 * dt, 3 * dt);
    } else if (u.radar?.active || (!u.radar && u.launcher.active))
      u.antenna = (u.antenna + dt * 1.6) % (Math.PI * 2);
  }
}
