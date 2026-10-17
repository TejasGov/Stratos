import { MathUtils, Quaternion, Vector3 } from "three";
import { heightAt, renderedHeightAt } from "../world/terrain";
import { landmarks } from "../missions";
import {
  BLACKRIDGE,
  BLACKRIDGE_TARGETS,
  HAVEN,
  runwayThreshold,
} from "../world/bases";
import {
  FLARE_BURN,
  FLARE_HEAT,
  MISSILES,
  NO_SOURCE,
  advanceMissile,
  createMissile,
  engineHeat,
  flareDecoyChance,
  launchMissile,
  missileSpent,
  seekerRange,
  type EngineHeat,
  type Missile,
  type MissileProfile,
} from "./Missiles";
import {
  AirDefense,
  type DefenseHost,
  type SamUnit,
  type SensorTarget,
} from "./AirDefense";

export type { Missile, MissileProfile } from "./Missiles";
export type CombatMission = "intercept" | "escort" | "strike" | "war";
export type AIState =
  "patrol" | "approach" | "attack" | "extend" | "evade" | "recover";
export interface CombatPlayer extends EngineHeat {
  position: Vector3;
  previous: Vector3;
  velocity: Vector3;
  quaternion: Quaternion;
  speed: number;
  crashed: boolean;
  /** Wheels on the runway: enemies hold until the jet is airborne. */
  onGround?: boolean;
  /** Post-stall manoeuvre (cobra): radar Doppler loses the jet. */
  postStall?: boolean;
}
export interface CombatInput {
  gun: boolean;
  missile: boolean;
  target: boolean;
  flare: boolean;
  bomb?: boolean;
}
export const combatNeutral: CombatInput = {
  gun: false,
  missile: false,
  target: false,
  flare: false,
  bomb: false,
};
export interface CombatQuery {
  /** True if opaque world geometry blocks the segment, in global coordinates. */
  blocked?(from: Vector3, to: Vector3): boolean;
  groundHeight?(x: number, z: number): number;
}
export interface CombatEntity {
  id: number;
  name: string;
  kind: "air" | "ground" | "ally";
  /** What the entity is, for presentation and objectives. */
  role:
    | "fighter"
    | "transport"
    | "target"
    | "radar"
    | "sam-launcher"
    | "sam-radar";
  /** Strike target id or SAM site id; empty otherwise. */
  tag: string;
  /** Hit radius for cannon and missiles (m). */
  radius: number;
  position: Vector3;
  previous: Vector3;
  velocity: Vector3;
  quaternion: Quaternion;
  health: number;
  maxHealth: number;
  active: boolean;
  state: AIState;
  stateTime: number;
  cooldown: number;
  speed: number;
  phase: number;
  /** Holding station before release (fighters). */
  home: Vector3;
  /** Combat time at which a holding fighter is released to engage (Infinity: not yet). */
  releaseAt: number;
}
export interface Tracer {
  active: boolean;
  hostile: boolean;
  owner: number;
  age: number;
  position: Vector3;
  previous: Vector3;
  velocity: Vector3;
}
/** Free-fall bomb: ballistic from the jet's velocity, bursting on the ground. */
export interface Bomb {
  active: boolean;
  position: Vector3;
  previous: Vector3;
  velocity: Vector3;
}
/** Countermeasure flare: falls behind the jet and burns hot for a few seconds. */
export interface Flare {
  active: boolean;
  age: number;
  position: Vector3;
  velocity: Vector3;
}
export interface CombatEvent {
  type:
    | "gun"
    | "missile"
    | "samLaunch"
    | "hit"
    | "explosion"
    | "flare"
    | "complete"
    | "failed";
  position: Vector3;
  entityId?: number;
  player?: boolean;
  scale?: number;
  /** On hits: what struck (the player's jet loses an engine to missiles). */
  weapon?: "gun" | "missile";
  /** On explosions: an airburst or a ground impact/destroyed installation. */
  kind?: "air" | "ground";
  /** On launches: initial flight direction (unit). */
  direction?: Vector3;
}
/** One threat on the warning receiver. Bearing is clockwise from the nose (rad). */
export interface RwrContact {
  bearing: number;
  range: number;
  /** 1 search, 2 track, 3 launch. */
  level: 1 | 2 | 3;
  source: "shorad" | "mrsam" | "fighter";
}
export interface CombatWarning {
  contacts: RwrContact[];
  count: number;
  /** Highest level present (0 none). */
  level: 0 | 1 | 2 | 3;
  /** A ground site launched at the player within the last few seconds. */
  samLaunch: boolean;
  /** Guided missile inbound: nearest one's bearing (clockwise from nose) and range. */
  missile: boolean;
  missileBearing: number;
  missileRange: number;
  missileSam: boolean;
}
export interface StartOptions {
  /** B-key patrol: an intercept around the current airborne position, as before. */
  patrol?: boolean;
}
export const PLAYER_ID = 0,
  ALLY_ID = -1;
const FLARE_KEY = 1000;
const MAX_RWR = 12;

export const AIM_ASSIST = {
  missileConeDegrees: 40,
  missileRange: 5000,
  acquireSeconds: 0.55,
  cannonConeDegrees: 10,
  cannonRange: 1800,
  cannonSpeed: 1400,
} as const;

/** Sortie pacing: takeoff grace, release delays and time limits (game tuning). */
export const SORTIE = {
  /** Seconds after the wheels leave the runway before anyone shoots. */
  grace: 6,
  limits: { intercept: 300, escort: 360, strike: 420, war: 900, patrol: 240 },
  /** Transport rolls this long after the player is airborne. */
  transportDelay: 4,
  /** Strike guards scramble when the player is this close to Blackridge, or tracked. */
  strikeAlert: 9000,
} as const;

/** War: low-level ingress up the eastern channel, under the spine battery's radar. */
export const WAR_WAYPOINTS = [
  { x: 1200, z: -4000 },
  { x: 1400, z: -5600 },
  { x: 1300, z: -7100 },
] as const;
/** An ingress marker counts when passed this close and this low (m above ground). */
export const WAR_GATE = { radius: 500, ceiling: 450 };
/** Viper flight: the player's two AI wingmen. */
export const WINGMAN_IDS = [-2, -3] as const;
/** Bomb burst: full damage at the centre, nothing beyond the radius. */
export const BOMB = { damage: 190, radius: 110, ammo: { war: 8, strike: 6 } };

/** Escort corridor: up the west coast, brushing the edge of the northern defences. */
export const ESCORT_ROUTE = [
  { x: -1000, z: -1500, altitude: 420 },
  { x: -2900, z: -3300, altitude: 750 },
  { x: -5600, z: -5600, altitude: 850 },
  { x: -7800, z: -9400, altitude: 850 },
] as const;

/** Constant-speed projectile interception with a bounded fallback for unreachable targets. */
export function predictInterceptPosition(
  origin: Vector3,
  targetPosition: Vector3,
  targetVelocity: Vector3,
  projectileSpeed: number,
  out: Vector3,
  maxTime = 2,
) {
  const x = targetPosition.x - origin.x,
    y = targetPosition.y - origin.y,
    z = targetPosition.z - origin.z;
  const a = targetVelocity.lengthSq() - projectileSpeed ** 2;
  const b =
    2 * (x * targetVelocity.x + y * targetVelocity.y + z * targetVelocity.z);
  const c = x * x + y * y + z * z;
  let time = Math.sqrt(c) / Math.max(1, projectileSpeed);
  if (Math.abs(a) < 1e-8) {
    if (Math.abs(b) > 1e-8 && -c / b >= 0) time = -c / b;
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      const t1 = (-b - root) / (2 * a),
        t2 = (-b + root) / (2 * a);
      if (t1 >= 0 && t2 >= 0) time = Math.min(t1, t2);
      else if (t1 >= 0) time = t1;
      else if (t2 >= 0) time = t2;
    }
  }
  return out
    .copy(targetPosition)
    .addScaledVector(
      targetVelocity,
      MathUtils.clamp(time, 0, Math.max(0, maxTime)),
    );
}

/** Closest approach of two objects swept linearly over one step. */
export function sweptClosest(
  from: Vector3,
  to: Vector3,
  targetFrom: Vector3,
  targetTo: Vector3,
) {
  const rx = from.x - targetFrom.x,
    ry = from.y - targetFrom.y,
    rz = from.z - targetFrom.z;
  const dx = to.x - from.x - (targetTo.x - targetFrom.x);
  const dy = to.y - from.y - (targetTo.y - targetFrom.y);
  const dz = to.z - from.z - (targetTo.z - targetFrom.z);
  const length = dx * dx + dy * dy + dz * dz;
  const t = length
    ? MathUtils.clamp(-(rx * dx + ry * dy + rz * dz) / length, 0, 1)
    : 0;
  return Math.sqrt((rx + dx * t) ** 2 + (ry + dy * t) ** 2 + (rz + dz * t) ** 2);
}

/** Relative motion gives the closest approach of two swept objects in one step. */
export function sweptMovingHit(
  from: Vector3,
  to: Vector3,
  targetFrom: Vector3,
  targetTo: Vector3,
  radius: number,
) {
  return sweptClosest(from, to, targetFrom, targetTo) <= radius;
}

/** Bounded single-player combat. All entities remain in global space until CombatView upload. */
export class CombatSystem implements DefenseHost {
  active: CombatMission | null = null;
  /** Current sortie is the free-flight B-key patrol rather than a briefed mission. */
  patrol = false;
  completed = false;
  failed = false;
  playerHealth = 100;
  enemies: CombatEntity[] = [];
  ally: CombatEntity | null = null;
  /** Radar cross-section of the player's airframe (set by the parent). */
  rcs = 1;
  /** World hook: a strike installation was destroyed (BLACKRIDGE_TARGETS id). */
  onTargetDestroyed?: (id: string) => void;
  readonly airDefense = new AirDefense(this);
  readonly missiles: Missile[] = Array.from({ length: 24 }, (_, i) =>
    createMissile(100 + i),
  );
  readonly tracers: Tracer[] = Array.from({ length: 96 }, () => ({
    active: false,
    hostile: false,
    owner: 0,
    age: 0,
    position: new Vector3(),
    previous: new Vector3(),
    velocity: new Vector3(),
  }));
  readonly flareDecoys: Flare[] = Array.from({ length: 8 }, () => ({
    active: false,
    age: 0,
    position: new Vector3(),
    velocity: new Vector3(),
  }));
  readonly warning: CombatWarning = {
    contacts: Array.from({ length: MAX_RWR }, () => ({
      bearing: 0,
      range: 0,
      level: 1,
      source: "shorad",
    })),
    count: 0,
    level: 0,
    samLaunch: false,
    missile: false,
    missileBearing: 0,
    missileRange: 0,
    missileSam: false,
  };
  /** Time the player first left the ground this sortie (-1: still on it). */
  takeoffAt = -1;
  elapsed = 0;
  private selected = 0;
  private lockProgress = 0;
  private missileAmmo = 12;
  private gunAmmo = 600;
  private flares = 12;
  /** War: Viper flight, ingress progress and the counterattack. */
  wingmen: CombatEntity[] = [];
  warPhase = 0;
  waypoint = 0;
  private wingJoinAt = Infinity;
  private wingJoined = false;
  readonly bombs: Bomb[] = Array.from({ length: 8 }, () => ({
    active: false,
    position: new Vector3(),
    previous: new Vector3(),
    velocity: new Vector3(),
  }));
  bombAmmo = 0;
  private bombCooldown = 0;
  private marker = new Vector3();
  /** War: the ingress marker to fly through next (global, 160 m above the ground), or null. */
  get warMarker() {
    if (this.active !== "war" || this.warPhase !== 1) return null;
    const wp = WAR_WAYPOINTS[this.waypoint];
    return this.marker.set(wp.x, this.ground(wp.x, wp.z, this.query) + 160, wp.z);
  }
  private kills = 0;
  private bonus = 0;
  private gunCooldown = 0;
  private missileCooldown = 0;
  private missileRequest = false;
  private missileRequestUntil = 0;
  private flareCooldown = 0;
  private flareIndex = 0;
  private previousInput = { ...combatNeutral };
  private events: CombatEvent[] = [];
  private range = 0;
  private threatening = false;
  private threatUntil = 0;
  private samLaunchAt = -Infinity;
  private result = "";
  private objective = "";
  private lockReason = "No target";
  private escortGoal = new Vector3();
  private escortLeg = 0;
  private allyReleaseAt = Infinity;
  private grace: number = SORTIE.grace;
  private limit: number = SORTIE.limits.intercept;
  private desired = new Vector3();
  private direction = new Vector3();
  private forward = new Vector3();
  private point = new Vector3();
  private sightPoint = new Vector3();
  private aim = new Vector3();
  private assistDirection = new Vector3();
  private assistForward = new Vector3();
  private targetQuaternion = new Quaternion();
  private readonly localForward = new Vector3(0, 0, -1);
  /** Deterministic RNG state; reset per sortie (tests may vary it). */
  seed = 8391;
  private query?: CombatQuery;
  private player?: CombatPlayer;
  private readonly sensed: SensorTarget = {
    position: new Vector3(),
    velocity: new Vector3(),
  };
  private readonly groundAt = (x: number, z: number) =>
    this.ground(x, z, this.query);

  get target() {
    return this.enemies.find((e) => e.id === this.selected && e.active) ?? null;
  }
  /** Airborne and past the takeoff grace: enemies may shoot. */
  get weaponsFree() {
    return this.takeoffAt >= 0 && this.elapsed >= this.takeoffAt + this.grace;
  }
  /** Selected target lead for optional bounded flight pursuit. No orientation mutation. */
  getAimDirection(
    player: CombatPlayer,
    out: Vector3,
    query?: CombatQuery,
    leadSeconds = 0.35,
  ): Vector3 | null {
    const target = this.target;
    if (
      !target ||
      !this.active ||
      this.completed ||
      this.failed ||
      this.sightBlocked(player.position, target, query)
    )
      return null;
    out
      .copy(target.position)
      .addScaledVector(target.velocity, MathUtils.clamp(leadSeconds, 0, 1))
      .sub(player.position);
    return out.lengthSq() > 1e-6 ? out.normalize() : null;
  }
  /** Gun/HUD helper returns a global intercept point only inside the assisted cone and range. */
  getGunAimPoint(
    player: CombatPlayer,
    out: Vector3,
    query?: CombatQuery,
  ): Vector3 | null {
    const target = this.target;
    if (!target || !this.active || this.completed || this.failed) return null;
    this.assistDirection.copy(target.position).sub(player.position);
    const range = this.assistDirection.length();
    if (range > AIM_ASSIST.cannonRange || range < 1) return null;
    this.assistForward
      .copy(this.localForward)
      .applyQuaternion(player.quaternion);
    const cone = Math.cos(MathUtils.degToRad(AIM_ASSIST.cannonConeDegrees));
    if (
      this.assistDirection.multiplyScalar(1 / range).dot(this.assistForward) <
        cone ||
      this.sightBlocked(player.position, target, query)
    )
      return null;
    predictInterceptPosition(
      player.position,
      target.position,
      target.velocity,
      AIM_ASSIST.cannonSpeed,
      out,
      1.25,
    );
    this.assistDirection.copy(out).sub(player.position).normalize();
    // Leading cannot steer the bullet farther than the documented cone.
    return this.assistDirection.dot(this.assistForward) >= cone ? out : null;
  }
  get status() {
    const target = this.target;
    return {
      objective: this.objective,
      targetId: target?.id ?? null,
      targetName: target?.name ?? "NO TARGET",
      lockReason: this.lockReason,
      range: this.range,
      lock: this.lockProgress,
      canFire:
        !!target &&
        !!this.active &&
        !this.completed &&
        !this.failed &&
        this.lockProgress >= 1 &&
        this.missileCooldown <= 0 &&
        this.missileAmmo > 0,
      threat: this.threatening,
      samLaunch: this.warning.samLaunch,
      missiles: this.missileAmmo,
      gunAmmo: this.gunAmmo,
      flares: this.flares,
      health: this.playerHealth,
      kills: this.kills,
      elapsed: this.elapsed,
      result: this.result,
      targetHealth: target ? target.health / target.maxHealth : 0,
      allyHealth: this.ally?.health ?? null,
      bombs: this.bombAmmo,
      wingmen: this.wingmen.filter((w) => w.active).length,
    };
  }
  private random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  private event(
    type: CombatEvent["type"],
    position: Vector3,
    entityId?: number,
    player = false,
    scale = 1,
    extra?: Pick<CombatEvent, "weapon" | "kind" | "direction">,
  ) {
    if (this.events.length < 128)
      this.events.push({
        type,
        position: position.clone(),
        entityId,
        player,
        scale,
        ...(extra?.weapon && { weapon: extra.weapon }),
        ...(extra?.kind && { kind: extra.kind }),
        ...(extra?.direction && { direction: extra.direction.clone() }),
      });
  }
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }
  ground(x: number, z: number, query?: CombatQuery) {
    return (
      query?.groundHeight?.(x, z) ??
      Math.max(0, heightAt(x, z), renderedHeightAt(x, z))
    );
  }
  private blocked(from: Vector3, to: Vector3, query?: CombatQuery) {
    if (query?.blocked) return query.blocked(from, to);
    const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 70));
    for (let i = 1; i <= steps; i++) {
      this.point.lerpVectors(from, to, i / steps);
      if (this.point.y < this.ground(this.point.x, this.point.z, query) + 2)
        return true;
    }
    return false;
  }
  /** Line of sight to an entity; ground installations count as seen up to their own structure. */
  private sightBlocked(from: Vector3, e: CombatEntity, query?: CombatQuery) {
    if (e.kind !== "ground") return this.blocked(from, e.position, query);
    this.sightPoint.copy(from).sub(e.position);
    const d = this.sightPoint.length();
    this.sightPoint
      .multiplyScalar(Math.min(e.radius, d * 0.5) / Math.max(d, 1))
      .add(e.position);
    // The aim point sits on the installation's near face, above its foundations.
    this.sightPoint.y = Math.max(
      this.sightPoint.y,
      this.ground(this.sightPoint.x, this.sightPoint.z, query) + 3,
    );
    return this.blocked(from, this.sightPoint, query);
  }
  private entity(
    id: number,
    name: string,
    kind: CombatEntity["kind"],
    position: Vector3,
    role: CombatEntity["role"] = kind === "ally"
      ? "transport"
      : kind === "ground"
        ? "radar"
        : "fighter",
  ): CombatEntity {
    const health = kind === "ground" ? 160 : kind === "ally" ? 120 : 90;
    return {
      id,
      name,
      kind,
      role,
      tag: "",
      radius: kind === "ground" ? 25 : kind === "ally" ? 16 : 12,
      position: position.clone(),
      previous: position.clone(),
      velocity: new Vector3(),
      quaternion: new Quaternion(),
      health,
      maxHealth: health,
      active: true,
      state: "patrol",
      stateTime: 0,
      cooldown: 9 + id * 1.4,
      speed: kind === "ally" ? 125 : 155,
      phase: id * 1.73,
      home: position.clone(),
      releaseAt: 0,
    };
  }
  addGroundEntity(
    name: string,
    role: CombatEntity["role"],
    tag: string,
    position: Vector3,
    health: number,
    radius: number,
  ) {
    const id = 10 + this.enemies.filter((e) => e.id >= 10).length;
    const e = this.entity(id, name, "ground", position, role);
    e.tag = tag;
    e.health = e.maxHealth = health;
    e.radius = radius;
    this.enemies.push(e);
    return e;
  }
  start(type: CombatMission, player: CombatPlayer, options: StartOptions = {}) {
    this.reset();
    this.active = type;
    this.patrol = !!options.patrol;
    this.player = player;
    this.grace = this.patrol ? 0 : SORTIE.grace;
    this.limit = this.patrol ? SORTIE.limits.patrol : SORTIE.limits[type];
    if (!player.onGround) this.takeoffAt = 0;
    if (this.patrol) this.startPatrol(type, player);
    else if (type === "intercept") this.startIntercept();
    else if (type === "escort") this.startEscort();
    else if (type === "war") this.startWar();
    else this.startStrike();
    this.airDefense.start();
    this.selected = this.defaultTarget();
  }
  /** Fighters at Blackridge, holding until the player is airborne. */
  private fighter(id: number, x: number, y: number, z: number, heading: number, home: Vector3) {
    const e = this.entity(
      id,
      `BANDIT ${String(id).padStart(2, "0")}`,
      "air",
      new Vector3(x, Math.max(y, this.ground(x, z) + 450), z),
    );
    e.home.copy(home);
    e.releaseAt = Infinity;
    e.speed = 140 + id * 6;
    e.cooldown = 6 + id * 2;
    e.quaternion.setFromAxisAngle(this.forward.set(0, 1, 0), heading);
    e.velocity
      .copy(this.localForward)
      .applyQuaternion(e.quaternion)
      .multiplyScalar(e.speed);
    this.enemies.push(e);
    return e;
  }
  private startIntercept() {
    const home = new Vector3(BLACKRIDGE.runway.x, 2800, BLACKRIDGE.runway.z + 900);
    // Inbound toward Haven from the north once released.
    this.fighter(1, -600, 2600, -9000, Math.PI, home);
    this.fighter(2, 0, 2900, -9500, Math.PI, home);
    this.fighter(3, 650, 3200, -9100, Math.PI, home);
    this.objective = "INTERCEPT · Bandits inbound from Blackridge · clear the skies";
  }
  private startEscort() {
    const start = runwayThreshold(HAVEN.runway);
    // Parked on the apron beside the threshold until the runway is clear.
    const parked = new Vector3(
      start.x + 110,
      this.ground(start.x + 110, start.z) + 4,
      start.z,
    );
    this.ally = this.entity(ALLY_ID, "HAVEN TRANSPORT", "ally", parked);
    this.ally.quaternion.setFromAxisAngle(this.forward.set(0, 1, 0), start.heading);
    this.ally.speed = 0;
    this.ally.state = "patrol";
    this.escortLeg = 0;
    const goal = ESCORT_ROUTE[ESCORT_ROUTE.length - 1];
    this.escortGoal.set(goal.x, goal.altitude, goal.z);
    const home = new Vector3(BLACKRIDGE.runway.x - 1500, 2400, BLACKRIDGE.runway.z + 1500);
    this.fighter(1, -1200, 2300, -8600, Math.PI * 0.75, home);
    this.fighter(2, -500, 2600, -9200, Math.PI * 0.75, home);
    this.fighter(3, 200, 2900, -8800, Math.PI * 0.75, home);
    this.objective = "ESCORT · Cover the transport up the west corridor";
  }
  private startStrike() {
    this.addStrikeTargets();
    this.bombAmmo = BOMB.ammo.strike;
    const home = new Vector3(BLACKRIDGE.runway.x, 1900, BLACKRIDGE.runway.z + 600);
    this.fighter(1, -900, 1900, -7800, -Math.PI / 2, home);
    this.fighter(2, 900, 2100, -8900, Math.PI / 2, home);
    this.objective = "STRIKE · Destroy the Blackridge radar · fuel and shelters are bonus";
  }
  /** Operation Iron Dawn: intercept, low ingress, bombing, then hold the counterattack. */
  private startWar() {
    const home = new Vector3(BLACKRIDGE.runway.x, 2600, BLACKRIDGE.runway.z + 900);
    this.fighter(1, -700, 2600, -9200, Math.PI, home);
    this.fighter(2, 0, 2900, -9600, Math.PI, home);
    this.fighter(3, 700, 3100, -9300, Math.PI, home);
    this.addStrikeTargets();
    this.bombAmmo = BOMB.ammo.war;
    WINGMAN_IDS.forEach((id, i) => {
      const w = this.entity(id, `VIPER ${i + 2}`, "ally", new Vector3(), "fighter");
      w.active = false;
      w.health = w.maxHealth = 110;
      w.radius = 12;
      w.speed = 170;
      w.cooldown = 8 + i * 4;
      this.wingmen.push(w);
    });
    this.objective = "WAR · 1/4 · Clear the bandits with Viper flight";
  }
  private addStrikeTargets() {
    for (const t of BLACKRIDGE_TARGETS) {
      const radar = t.kind === "radar";
      const e = this.entity(
        radar ? 4 : t.kind === "fuel" ? 5 : 6,
        t.name.toUpperCase(),
        "ground",
        new Vector3(t.x, this.ground(t.x, t.z) + 12, t.z),
        "target",
      );
      e.tag = t.id;
      e.health = e.maxHealth = radar ? 150 : t.kind === "fuel" ? 90 : 140;
      e.radius = radar ? 30 : 38;
      this.enemies.push(e);
    }
  }
  /** B-key patrol: the original intercept laid out ahead of the airborne jet. */
  private startPatrol(type: CombatMission, player: CombatPlayer) {
    this.forward.copy(this.localForward).applyQuaternion(player.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 0.01) this.forward.set(0, 0, -1);
    this.forward.normalize();
    const right = new Vector3(-this.forward.z, 0, this.forward.x);
    for (let i = 0; i < (type === "strike" ? 2 : 3); i++) {
      const openingIntercept = type === "intercept";
      const position = player.position
        .clone()
        .addScaledVector(
          this.forward,
          (openingIntercept ? 1100 : 1600) + i * 650,
        )
        .addScaledVector(
          right,
          openingIntercept
            ? i === 0
              ? 50
              : i % 2
                ? 260
                : -260
            : i % 2
              ? 430
              : -260,
        );
      position.y = Math.max(
        player.position.y + (openingIntercept ? 15 : 80) + i * 60,
        this.ground(position.x, position.z) + 450,
      );
      const e = this.entity(
        i + 1,
        `BANDIT ${String(i + 1).padStart(2, "0")}`,
        "air",
        position,
      );
      e.speed = openingIntercept ? 105 + i * 10 : 130;
      e.cooldown = openingIntercept ? 20 + i * 3 : 15 + i * 2;
      e.quaternion.setFromUnitVectors(
        this.localForward,
        openingIntercept
          ? this.forward
          : this.direction.copy(player.position).sub(position).normalize(),
      );
      e.velocity
        .copy(this.localForward)
        .applyQuaternion(e.quaternion)
        .multiplyScalar(e.speed);
      this.enemies.push(e);
    }
    if (type === "intercept")
      this.objective = "INTERCEPT · Clear three hostile aircraft";
    if (type === "escort") {
      this.ally = this.entity(
        ALLY_ID,
        "HAVEN TRANSPORT",
        "ally",
        player.position.clone().addScaledVector(this.forward, 400),
      );
      this.ally.quaternion.copy(player.quaternion);
      this.ally.state = "approach";
      this.escortGoal
        .copy(this.ally.position)
        .addScaledVector(this.forward, 5400);
      this.escortGoal.y = Math.max(
        this.escortGoal.y,
        this.ground(this.escortGoal.x, this.escortGoal.z) + 650,
      );
      this.escortLeg = ESCORT_ROUTE.length;
      this.allyReleaseAt = 0;
      this.objective = "ESCORT · Protect Haven transport to the safe corridor";
    }
    if (type === "strike") {
      const coast = [...landmarks]
        .filter((l) => l.id !== "haven")
        .sort(
          (a, b) =>
            Math.hypot(a.x - player.position.x, a.z - player.position.z) -
            Math.hypot(b.x - player.position.x, b.z - player.position.z),
        )[0];
      const position = new Vector3(
        coast.x,
        this.ground(coast.x, coast.z) + 18,
        coast.z,
      );
      this.enemies.push(
        this.entity(4, `${coast.name.toUpperCase()} RADAR`, "ground", position),
      );
      this.enemies[this.enemies.length - 1].tag = "radar";
      this.objective = `STRIKE · Destroy radar at ${coast.name}`;
    }
  }
  /** Fighters first; the strike radar when that is the objective. */
  private defaultTarget() {
    if (this.active === "strike" || (this.active === "war" && this.warPhase >= 2)) {
      const radar = this.enemies.find(
        (e) => e.active && e.kind === "ground" && e.tag === "radar",
      );
      if (radar) return radar.id;
    }
    return this.enemies.find((e) => e.active && e.kind === "air")?.id ?? 0;
  }
  reset() {
    this.active = null;
    this.patrol = false;
    this.completed = this.failed = false;
    this.playerHealth = 100;
    this.enemies.length = 0;
    this.ally = null;
    this.selected = 0;
    this.lockProgress = this.elapsed = this.kills = this.bonus = this.range = 0;
    this.missileAmmo = this.flares = 12;
    this.gunAmmo = 600;
    this.gunCooldown = this.missileCooldown = this.flareCooldown = 0;
    this.missileRequest = false;
    this.missileRequestUntil = 0;
    this.previousInput = { ...combatNeutral };
    this.events.length = 0;
    this.objective = this.result = "";
    this.lockReason = "No target";
    this.threatening = false;
    this.threatUntil = 0;
    this.samLaunchAt = -Infinity;
    this.takeoffAt = -1;
    this.allyReleaseAt = Infinity;
    this.escortLeg = 0;
    this.seed = 8391;
    this.airDefense.clear();
    this.warning.count = this.warning.level = 0;
    this.warning.samLaunch = this.warning.missile = false;
    for (const m of this.missiles) m.active = false;
    for (const t of this.tracers) t.active = false;
    for (const f of this.flareDecoys) f.active = false;
    for (const b of this.bombs) b.active = false;
    this.wingmen.length = 0;
    this.warPhase = this.waypoint = this.bombAmmo = this.bombCooldown = 0;
    this.wingJoinAt = Infinity;
    this.wingJoined = false;
  }
  stop() {
    this.reset();
  }
  cycleTarget() {
    // Air threats first, then ground installations within reach of the jet.
    const p = this.player?.position;
    const available = this.enemies.filter(
      (e) =>
        e.active &&
        (e.kind === "air" || !p || e.position.distanceTo(p) < 15000),
    );
    if (!available.length) {
      this.selected = 0;
      this.lockProgress = 0;
      return;
    }
    const index = available.findIndex((e) => e.id === this.selected);
    this.selected = available[(index + 1) % available.length].id;
    this.lockProgress = 0;
  }
  step(
    dt: number,
    player: CombatPlayer,
    input: CombatInput = combatNeutral,
    query?: CombatQuery,
  ) {
    if (
      !this.active ||
      this.completed ||
      this.failed ||
      !(dt > 0) ||
      !Number.isFinite(dt)
    )
      return;
    dt = Math.min(dt, 0.1);
    this.query = query;
    this.player = player;
    this.elapsed += dt;
    this.gunCooldown -= dt;
    this.missileCooldown -= dt;
    this.flareCooldown -= dt;
    this.bombCooldown -= dt;
    if (player.crashed) {
      this.playerHealth = 0;
      this.finish(false, player.position, "Aircraft lost");
      return;
    }
    if (this.takeoffAt < 0 && !player.onGround) this.takeoffAt = this.elapsed;
    this.updateReleases(player);
    if (input.target && !this.previousInput.target) this.cycleTarget();
    if (input.missile && !this.previousInput.missile) {
      this.missileRequest = true;
      this.missileRequestUntil = this.elapsed + 0.9;
    }
    if (this.elapsed > this.missileRequestUntil) this.missileRequest = false;
    if (!this.target) {
      this.selected = this.defaultTarget();
      this.lockProgress = 0;
    }
    for (const e of this.enemies)
      if (e.active && e.kind === "air") this.updateEnemy(e, dt, player, query);
    if (this.ally?.active) this.updateAlly(dt, query);
    for (let i = 0; i < this.wingmen.length; i++)
      if (this.wingmen[i].active) this.updateWingman(this.wingmen[i], i, dt, player, query);
    const sensed = this.sensed;
    sensed.position = player.position;
    sensed.velocity = player.velocity;
    sensed.rcs = this.rcs;
    sensed.postStall = player.postStall;
    sensed.engines = player.engines;
    sensed.boost = player.boost;
    sensed.throttle = player.throttle;
    this.airDefense.step(dt, sensed, this.groundAt);
    this.updateLock(dt, player, query);
    if (input.gun && this.gunCooldown <= 0 && this.gunAmmo > 0) {
      this.forward.copy(this.localForward).applyQuaternion(player.quaternion);
      this.aim.copy(player.position).addScaledVector(this.forward, 12);
      if (this.getGunAimPoint(player, this.desired, query))
        this.forward.copy(this.desired).sub(this.aim).normalize();
      if (this.fireGun(this.aim, this.forward, false, PLAYER_ID)) {
        this.gunAmmo--;
        this.gunCooldown = 1 / 13;
      }
    }
    if (this.missileRequest && this.status.canFire && this.target) {
      this.forward.copy(this.localForward).applyQuaternion(player.quaternion);
      if (
        this.fireMissile(
          player.position,
          this.forward,
          false,
          PLAYER_ID,
          this.target.id,
          MISSILES.player,
        )
      ) {
        this.missileAmmo--;
        this.missileCooldown = 1.1;
        this.missileRequest = false;
      }
    }
    if (
      input.flare &&
      !this.previousInput.flare &&
      this.flares > 0 &&
      this.flareCooldown <= 0
    ) {
      this.flares--;
      this.flareCooldown = 1.5;
      this.releaseFlare(player);
      this.event("flare", player.position, PLAYER_ID, true);
    }
    if (
      input.bomb &&
      !this.previousInput.bomb &&
      this.bombAmmo > 0 &&
      this.bombCooldown <= 0 &&
      !player.onGround
    ) {
      const b = this.bombs.find((x) => !x.active);
      if (b) {
        b.active = true;
        b.position.copy(player.position).y -= 2.5;
        b.previous.copy(b.position);
        b.velocity.copy(player.velocity);
        this.bombAmmo--;
        this.bombCooldown = 0.35;
      }
    }
    this.updateFlares(dt);
    this.updateBombs(dt, player, query);
    this.updateProjectiles(dt, player, query);
    if (this.active === "war") this.updateWar(player, query);
    this.previousInput.gun = input.gun;
    this.previousInput.missile = input.missile;
    this.previousInput.target = input.target;
    this.previousInput.flare = input.flare;
    this.previousInput.bomb = !!input.bomb;
    this.updateWarning(player);
    if (this.playerHealth <= 0)
      this.finish(false, player.position, "Aircraft destroyed");
    else if (this.active === "escort" && this.ally && !this.ally.active)
      this.finish(false, this.ally.position, "Transport lost");
    else if (
      this.active === "escort" &&
      this.ally &&
      this.escortLeg >= ESCORT_ROUTE.length &&
      this.ally.position.distanceTo(this.escortGoal) < 180
    )
      this.finish(true, player.position, "Transport reached the safe corridor");
    else if (
      this.active === "strike" &&
      !this.enemies.some((e) => e.kind === "ground" && e.tag === "radar" && e.active)
    )
      this.finish(
        true,
        player.position,
        this.patrol
          ? "Radar destroyed"
          : `Radar destroyed · bonus targets ${this.bonus} / ${BLACKRIDGE_TARGETS.length - 1}`,
      );
    else if (
      this.active === "intercept" &&
      !this.enemies.some((e) => e.active && e.kind === "air")
    )
      this.finish(true, player.position, "Airspace clear");
    else if (
      this.active === "war" &&
      this.warPhase === 3 &&
      !this.enemies.some((e) => e.active && e.kind === "air")
    )
      this.finish(
        true,
        player.position,
        `Blackridge destroyed · Viper flight ${this.wingmen.filter((w) => w.active).length} / 2 home`,
      );
    else if (this.elapsed > this.limit)
      this.finish(false, player.position, "Sortie time expired");
  }
  /** Who may engage, and when: nothing shoots at a jet still on the runway. */
  private updateReleases(player: CombatPlayer) {
    if (this.patrol || this.takeoffAt < 0) return;
    const free = this.takeoffAt + this.grace;
    if (this.active === "escort" && this.allyReleaseAt === Infinity)
      this.allyReleaseAt = this.takeoffAt + SORTIE.transportDelay;
    for (const e of this.enemies) {
      if (e.kind !== "air" || e.releaseAt !== Infinity) continue;
      if (this.active === "intercept" || this.active === "war") e.releaseAt = free + (e.id - 1) * 2;
      else if (this.active === "escort") {
        // Scramble once the transport is on its way up the corridor.
        if (this.escortLeg >= 2) e.releaseAt = this.elapsed + (e.id - 1) * 3;
      } else if (
        this.elapsed >= free &&
        (this.airDefense.tracking ||
          Math.hypot(
            player.position.x - BLACKRIDGE.runway.x,
            player.position.z - BLACKRIDGE.runway.z,
          ) < SORTIE.strikeAlert)
      )
        e.releaseAt = this.elapsed + (e.id - 1) * 2;
    }
  }
  private updateLock(dt: number, player: CombatPlayer, query?: CombatQuery) {
    const target = this.target;
    if (!target) {
      this.range = 0;
      this.lockProgress = 0;
      this.lockReason = "No target";
      return;
    }
    this.direction.copy(target.position).sub(player.position);
    this.range = this.direction.length();
    this.forward.copy(this.localForward).applyQuaternion(player.quaternion);
    const inCone =
      this.range > 0 &&
      this.direction.multiplyScalar(1 / this.range).dot(this.forward) >
        Math.cos(MathUtils.degToRad(AIM_ASSIST.missileConeDegrees));
    const occluded =
      this.range < AIM_ASSIST.missileRange &&
      inCone &&
      this.sightBlocked(player.position, target, query);
    const visible = this.range < AIM_ASSIST.missileRange && inCone && !occluded;
    this.lockProgress = MathUtils.clamp(
      this.lockProgress + dt * (visible ? 1 / AIM_ASSIST.acquireSeconds : -1.5),
      0,
      1,
    );
    this.lockReason =
      this.range >= AIM_ASSIST.missileRange
        ? "Out of range"
        : !inCone
          ? "Align target"
          : occluded
            ? "Occluded"
            : this.lockProgress < 1
              ? "Acquiring"
              : this.missileAmmo <= 0
                ? "No missiles"
                : this.missileCooldown > 0
                  ? "Cooldown"
                  : "Locked";
  }
  private updateEnemy(
    e: CombatEntity,
    dt: number,
    player: CombatPlayer,
    query?: CombatQuery,
  ) {
    e.previous.copy(e.position);
    e.stateTime += dt;
    e.cooldown -= dt;
    const holding = this.elapsed < e.releaseAt;
    const victim =
      this.active === "escort" && e.id % 2 && this.ally?.active
        ? this.ally
        : this.active === "war"
          ? this.warVictim(e, player)
          : player;
    const range = e.position.distanceTo(victim.position);
    this.forward.copy(this.localForward).applyQuaternion(e.quaternion);
    const ahead = this.aim
      .copy(e.position)
      .addScaledVector(this.forward, e.speed * 2.5);
    const clearance =
      Math.max(
        this.ground(e.position.x, e.position.z, query),
        this.ground(ahead.x, ahead.z, query),
      ) + 280;
    if (e.position.y < clearance) {
      e.state = "recover";
      e.stateTime = 0;
    } else if (e.state === "recover" && e.position.y > clearance + 150) {
      e.state = holding ? "patrol" : "approach";
      e.stateTime = 0;
    } else if (
      e.state === "patrol" &&
      !holding &&
      (!this.patrol ||
        e.stateTime > (this.active === "intercept" ? 12 : 4))
    ) {
      e.state = "approach";
      e.stateTime = 0;
    } else if (e.state === "approach" && range < 1300) {
      e.state = "attack";
      e.stateTime = 0;
    } else if (e.state === "attack" && (range < 260 || e.stateTime > 5)) {
      e.state = "extend";
      e.stateTime = 0;
    } else if (
      (e.state === "extend" && e.stateTime > 5) ||
      (e.state === "evade" && e.stateTime > 1.5)
    ) {
      e.state = "approach";
      e.stateTime = 0;
    }
    if (e.state === "recover")
      this.desired.copy(this.forward).setY(1.4).normalize();
    else if (e.state === "extend")
      this.desired.copy(this.forward).setY(0.15).normalize();
    else if (e.state === "patrol" && holding) {
      // Racetrack-like orbit around the holding station.
      this.desired.copy(e.position).sub(e.home).setY(0);
      const d = Math.max(1, this.desired.length());
      this.desired.multiplyScalar(1 / d);
      this.desired
        .set(-this.desired.z, 0, this.desired.x)
        .addScaledVector(this.desired, MathUtils.clamp((1600 - d) / 800, -1.5, 1.5));
      this.desired.y = MathUtils.clamp((e.home.y - e.position.y) / 900, -0.3, 0.3);
      this.desired.normalize();
    } else if (e.state === "patrol" && this.active === "intercept")
      this.desired.copy(this.forward);
    else if (e.state === "evade")
      this.desired
        .set(
          Math.cos(e.phase + this.elapsed),
          0.35,
          Math.sin(e.phase + this.elapsed),
        )
        .normalize();
    else {
      this.desired
        .copy(victim.position)
        .addScaledVector(victim.velocity, Math.min(2, range / 650))
        .sub(e.position);
      if (e.state === "patrol") this.desired.y += 180;
      this.desired.normalize();
    }
    this.targetQuaternion.setFromUnitVectors(this.localForward, this.desired);
    e.quaternion.rotateTowards(
      this.targetQuaternion,
      dt * (e.state === "recover" ? 0.8 : 0.38),
    );
    this.direction.copy(this.localForward).applyQuaternion(e.quaternion);
    e.velocity.lerp(
      this.aim.copy(this.direction).multiplyScalar(e.speed),
      1 - Math.exp(-3 * dt),
    );
    e.position.addScaledVector(e.velocity, dt);
    const floor = this.ground(e.position.x, e.position.z, query) + 25;
    if (e.position.y < floor) {
      e.position.y = floor;
      e.velocity.y = Math.max(0, e.velocity.y);
      e.state = "recover";
    }
    if (holding || !this.weaponsFree) return;
    if (e.state === "attack" && e.cooldown <= 0 && range < 1900) {
      this.desired.copy(victim.position).sub(e.position).normalize();
      if (
        this.desired.dot(this.direction) > 0.91 &&
        !this.blocked(e.position, victim.position, query)
      ) {
        this.fireMissile(
          e.position,
          this.direction,
          true,
          e.id,
          victim === this.ally ? ALLY_ID : victim === player ? PLAYER_ID : (victim as CombatEntity).id,
          MISSILES.aam,
          e.speed + MISSILES.aam.launchSpeed * 0.5,
        );
        e.cooldown = 14 + this.random() * 5;
      }
    }
    if (
      e.state === "attack" &&
      range < 850 &&
      e.cooldown < 8 &&
      e.stateTime % 1.1 < dt
    ) {
      this.desired.copy(victim.position).sub(e.position).normalize();
      if (this.desired.dot(this.direction) > 0.98)
        this.fireGun(e.position, this.direction, true, e.id);
    }
  }
  /** War: bandits split their attention between the leader and Viper flight. */
  private warVictim(e: CombatEntity, player: CombatPlayer): CombatEntity | CombatPlayer {
    const w = this.wingmen[e.id % 3 === 1 ? 0 : 1];
    return e.id % 3 !== 0 && w?.active ? w : player;
  }
  /** Viper flight: formation on the leader, breaking off to chase the nearest bandit. */
  private updateWingman(
    w: CombatEntity,
    slot: number,
    dt: number,
    player: CombatPlayer,
    query?: CombatQuery,
  ) {
    w.previous.copy(w.position);
    w.stateTime += dt;
    w.cooldown -= dt;
    this.forward.copy(this.localForward).applyQuaternion(w.quaternion);
    let target: CombatEntity | null = null,
      best = 9000;
    for (const e of this.enemies)
      if (e.active && e.kind === "air" && this.elapsed >= e.releaseAt) {
        const d = e.position.distanceTo(w.position);
        if (d < best) {
          best = d;
          target = e;
        }
      }
    let speed: number;
    if (target) {
      this.desired
        .copy(target.position)
        .addScaledVector(target.velocity, Math.min(2, best / 650))
        .sub(w.position)
        .normalize();
      speed = 185;
    } else {
      // Echelon slot 70 m behind and 60 m out to either side of the leader.
      this.direction.copy(this.localForward).applyQuaternion(player.quaternion);
      this.aim.set(-this.direction.z, 0, this.direction.x).normalize();
      this.desired
        .copy(player.position)
        .addScaledVector(this.aim, slot ? 60 : -60)
        .addScaledVector(this.direction, -70 - slot * 40)
        .sub(w.position);
      const gap = this.desired.length();
      this.desired.normalize();
      speed = MathUtils.clamp(player.speed + (gap - 30) * 0.4, 110, 320);
    }
    const ahead = this.aim.copy(w.position).addScaledVector(this.forward, w.speed * 2.5);
    const clearance =
      Math.max(this.ground(w.position.x, w.position.z, query), this.ground(ahead.x, ahead.z, query)) +
      (target ? 220 : 90);
    if (w.position.y < clearance) this.desired.setY(Math.max(this.desired.y, 0.6)).normalize();
    w.speed = MathUtils.damp(w.speed, speed, 1.2, dt);
    this.targetQuaternion.setFromUnitVectors(this.localForward, this.desired);
    w.quaternion.rotateTowards(this.targetQuaternion, dt * 0.7);
    this.direction.copy(this.localForward).applyQuaternion(w.quaternion);
    w.velocity.lerp(this.aim.copy(this.direction).multiplyScalar(w.speed), 1 - Math.exp(-3 * dt));
    w.position.addScaledVector(w.velocity, dt);
    const floor = this.ground(w.position.x, w.position.z, query) + 25;
    if (w.position.y < floor) w.position.y = floor;
    if (!target || !this.weaponsFree) return;
    this.desired.copy(target.position).sub(w.position).normalize();
    const aligned = this.desired.dot(this.direction);
    if (w.cooldown <= 0 && best < 2600 && aligned > 0.93 && !this.blocked(w.position, target.position, query)) {
      this.fireMissile(w.position, this.direction, false, w.id, target.id, MISSILES.aam, w.speed + 120);
      w.cooldown = 16 + this.random() * 8;
    } else if (best < 800 && aligned > 0.985 && w.stateTime % 0.9 < dt)
      this.fireGun(w.position, this.direction, false, w.id);
  }
  /** War phases: wingmen join after takeoff; each phase unlocks the next. */
  private updateWar(player: CombatPlayer, query?: CombatQuery) {
    if (this.takeoffAt >= 0 && this.wingJoinAt === Infinity) this.wingJoinAt = this.elapsed + 3;
    if (!this.wingJoined && this.elapsed >= this.wingJoinAt) {
      this.wingJoined = true;
      this.direction.copy(this.localForward).applyQuaternion(player.quaternion);
      this.aim.set(-this.direction.z, 0, this.direction.x).normalize();
      this.wingmen.forEach((w, i) => {
        w.active = true;
        w.position
          .copy(player.position)
          .addScaledVector(this.aim, i ? 60 : -60)
          .addScaledVector(this.direction, -120 - i * 40);
        w.previous.copy(w.position);
        w.quaternion.copy(player.quaternion);
        w.velocity.copy(player.velocity);
        w.speed = Math.max(140, player.speed);
      });
    }
    const bandits = this.enemies.some((e) => e.active && e.kind === "air");
    if (this.warPhase === 0 && this.weaponsFree && !bandits) {
      this.warPhase = 1;
      this.objective = `WAR · 2/4 · Fly low through the valley markers (0/${WAR_WAYPOINTS.length}) · under ${WAR_GATE.ceiling} m`;
    } else if (this.warPhase === 1) {
      const wp = WAR_WAYPOINTS[this.waypoint];
      const agl = player.position.y - this.ground(wp.x, wp.z, query);
      if (Math.hypot(player.position.x - wp.x, player.position.z - wp.z) < WAR_GATE.radius && agl < WAR_GATE.ceiling) {
        this.waypoint++;
        this.objective = `WAR · 2/4 · Fly low through the valley markers (${this.waypoint}/${WAR_WAYPOINTS.length}) · under ${WAR_GATE.ceiling} m`;
        if (this.waypoint >= WAR_WAYPOINTS.length) {
          this.warPhase = 2;
          this.objective = "WAR · 3/4 · Bomb the Blackridge radar, fuel farm and shelters";
          this.selected = this.enemies.find((e) => e.active && e.tag === "radar")?.id ?? this.selected;
        }
      }
    } else if (this.warPhase === 2 && !this.enemies.some((e) => e.active && e.role === "target")) {
      this.warPhase = 3;
      this.objective = "WAR · 4/4 · Hold the line against the counterattack";
      // The counterattack comes from far beyond Blackridge, out over the northern sea.
      const home = new Vector3(BLACKRIDGE.runway.x, 2800, BLACKRIDGE.runway.z);
      for (let i = 0; i < 4; i++) {
        const e = this.fighter(7 + i, -1500 + i * 1000, 3000 + i * 150, -15500 - (i % 2) * 600, Math.PI, home);
        e.releaseAt = this.elapsed + i * 1.5;
      }
    }
  }
  /** Where a bomb released now would land (ground point); false when no ballistic solution. */
  bombImpact(player: CombatPlayer, out: Vector3, query?: CombatQuery) {
    out.copy(player.position);
    this.desired.copy(player.velocity);
    for (let t = 0; t < 40; t += 0.05) {
      this.desired.y -= 9.81 * 0.05;
      this.desired.multiplyScalar(1 - 0.02 * 0.05);
      out.addScaledVector(this.desired, 0.05);
      const g = this.ground(out.x, out.z, query);
      if (out.y <= g) {
        out.y = g;
        return true;
      }
    }
    return false;
  }
  private updateBombs(dt: number, player: CombatPlayer, query?: CombatQuery) {
    for (const b of this.bombs) {
      if (!b.active) continue;
      b.previous.copy(b.position);
      b.velocity.y -= 9.81 * dt;
      b.velocity.multiplyScalar(1 - 0.02 * dt);
      b.position.addScaledVector(b.velocity, dt);
      const g = this.ground(b.position.x, b.position.z, query);
      if (b.position.y > g) continue;
      b.position.y = g;
      b.active = false;
      this.event("explosion", b.position, PLAYER_ID, true, 2.2, { kind: "ground" });
      for (const e of this.enemies) {
        if (!e.active || e.kind !== "ground") continue;
        const d = e.position.distanceTo(b.position);
        if (d < BOMB.radius) this.damageEntity(e, BOMB.damage * (1 - d / BOMB.radius), player, "missile");
      }
    }
  }
  private updateAlly(dt: number, query?: CombatQuery) {
    const e = this.ally!;
    e.previous.copy(e.position);
    if (this.elapsed < this.allyReleaseAt) {
      e.velocity.set(0, 0, 0);
      return;
    }
    if (e.state === "patrol") {
      // Runway clear: line up on the threshold and roll.
      const start = runwayThreshold(HAVEN.runway);
      e.position.set(start.x, this.ground(start.x, start.z, query) + 4, start.z);
      e.previous.copy(e.position);
      e.quaternion.setFromAxisAngle(this.forward.set(0, 1, 0), start.heading);
      e.state = "approach";
    }
    e.speed = Math.min(125, e.speed + dt * 6);
    const leg = ESCORT_ROUTE[Math.min(this.escortLeg, ESCORT_ROUTE.length - 1)];
    if (this.escortLeg < ESCORT_ROUTE.length)
      this.desired.set(leg.x, leg.altitude, leg.z);
    else this.desired.copy(this.escortGoal);
    if (
      this.escortLeg < ESCORT_ROUTE.length - 1 &&
      Math.hypot(e.position.x - leg.x, e.position.z - leg.z) < 450
    )
      this.escortLeg++;
    else if (
      this.escortLeg === ESCORT_ROUTE.length - 1 &&
      Math.hypot(e.position.x - leg.x, e.position.z - leg.z) < 450
    )
      this.escortLeg = ESCORT_ROUTE.length;
    const targetY = this.desired.y;
    this.desired.sub(e.position).setY(0).normalize();
    // Climb at a transport's gentle angle, only once flying speed is reached.
    const ahead = this.aim.copy(e.position).addScaledVector(this.desired, 500);
    const floor = this.ground(ahead.x, ahead.z, query) + 300;
    const wanted = Math.max(targetY, floor);
    this.desired.y =
      e.speed < 70 ? 0 : MathUtils.clamp((wanted - e.position.y) / 600, -0.15, 0.22);
    if (e.position.y < floor) this.desired.y = Math.max(0.22, this.desired.y);
    this.desired.normalize();
    this.targetQuaternion.setFromUnitVectors(this.localForward, this.desired);
    // No turning on the takeoff roll.
    if (e.speed > 80) e.quaternion.rotateTowards(this.targetQuaternion, 0.35 * dt);
    else if (e.speed >= 70)
      e.quaternion.rotateTowards(this.targetQuaternion, 0.1 * dt);
    e.velocity
      .copy(this.localForward)
      .applyQuaternion(e.quaternion)
      .multiplyScalar(e.speed);
    e.position.addScaledVector(e.velocity, dt);
    const runway = this.ground(e.position.x, e.position.z, query) + 4;
    if (e.position.y < runway) e.position.y = runway;
  }
  private fireGun(
    position: Vector3,
    direction: Vector3,
    hostile: boolean,
    owner: number,
  ) {
    const bullet = this.tracers.find((t) => !t.active);
    if (!bullet) return false;
    bullet.active = true;
    bullet.hostile = hostile;
    bullet.owner = owner;
    bullet.age = 0;
    bullet.position.copy(position);
    bullet.previous.copy(position);
    bullet.velocity.copy(direction).multiplyScalar(AIM_ASSIST.cannonSpeed);
    this.event("gun", position, owner, !hostile);
    return true;
  }
  private fireMissile(
    position: Vector3,
    direction: Vector3,
    hostile: boolean,
    owner: number,
    targetId: number,
    profile: MissileProfile,
    launchSpeed = profile.launchSpeed,
  ) {
    const missile = this.missiles.find((m) => !m.active);
    if (!missile) return null;
    this.point.copy(position).addScaledVector(direction, 15);
    launchMissile(
      missile,
      profile,
      this.point,
      direction,
      hostile,
      owner,
      targetId,
      launchSpeed,
    );
    this.event("missile", missile.position, missile.id, !hostile);
    return missile;
  }
  launchSam(unit: SamUnit, position: Vector3, direction: Vector3) {
    const missile = this.missiles.find((m) => !m.active);
    if (!missile) return false;
    launchMissile(
      missile,
      unit.rules.missile,
      position,
      direction,
      true,
      unit.launcher.id,
      PLAYER_ID,
    );
    this.samLaunchAt = this.elapsed;
    this.event("samLaunch", position, missile.id, false, 1, { direction });
    return true;
  }
  inFlight(owner: number) {
    let n = 0;
    for (const m of this.missiles) if (m.active && m.owner === owner) n++;
    return n;
  }
  samsInFlight() {
    let n = 0;
    for (const m of this.missiles)
      if (
        m.active &&
        m.hostile &&
        m.targetId === PLAYER_ID &&
        (m.profile.id === "shorad" || m.profile.id === "mrsam")
      )
        n++;
    return n;
  }
  /** Ejected below and behind the jet; seekers judge it when it enters their view. */
  private releaseFlare(player: CombatPlayer) {
    const i = this.flareIndex;
    this.flareIndex = (i + 1) % this.flareDecoys.length;
    const f = this.flareDecoys[i];
    f.active = true;
    f.age = 0;
    f.position.copy(player.position);
    f.velocity.copy(player.velocity).multiplyScalar(0.55);
    f.velocity.y -= 25;
    const bit = ~(1 << i);
    for (const m of this.missiles) {
      m.flaresSeen &= bit;
      m.flaresDecoyed &= bit;
    }
  }
  private updateFlares(dt: number) {
    for (const f of this.flareDecoys) {
      if (!f.active) continue;
      f.age += dt;
      if (f.age > FLARE_BURN) {
        f.active = false;
        continue;
      }
      f.velocity.multiplyScalar(Math.exp(-1.6 * dt));
      f.velocity.y -= 9.81 * dt;
      f.position.addScaledVector(f.velocity, dt);
    }
  }
  /**
   * Heat seeker: the hottest source inside the forward cone and within reach.
   * Returns the source key and writes its position, or NO_SOURCE for nothing seen.
   */
  private seek(m: Missile, victim: CombatPlayer | CombatEntity, heat: number, out: Vector3) {
    const p = m.profile;
    const cos = Math.cos(p.cone);
    let best = NO_SOURCE,
      bestHeat = 0;
    this.direction.copy(victim.position).sub(m.position);
    let d = this.direction.length();
    if (
      d <= seekerRange(p, heat) &&
      (d < 1 || this.direction.dot(m.direction) >= cos * d)
    ) {
      best = m.targetId;
      bestHeat = heat;
      out.copy(victim.position);
    }
    for (let i = 0; i < this.flareDecoys.length; i++) {
      const f = this.flareDecoys[i];
      if (!f.active) continue;
      this.direction.copy(f.position).sub(m.position);
      d = this.direction.length();
      if (d > p.seekerRange || this.direction.dot(m.direction) < cos * d) continue;
      const bit = 1 << i;
      if (!(m.flaresSeen & bit)) {
        m.flaresSeen |= bit;
        if (this.random() < flareDecoyChance(p, heat)) m.flaresDecoyed |= bit;
      }
      if (m.flaresDecoyed & bit && FLARE_HEAT > bestHeat) {
        best = FLARE_KEY + i;
        bestHeat = FLARE_HEAT;
        out.copy(f.position);
      }
    }
    return best;
  }
  private updateProjectiles(
    dt: number,
    player: CombatPlayer,
    query?: CombatQuery,
  ) {
    for (const t of this.tracers) {
      if (!t.active) continue;
      t.previous.copy(t.position);
      t.position.addScaledVector(t.velocity, dt);
      t.age += dt;
      if (t.age > 1.3) {
        t.active = false;
        continue;
      }
      const hit = t.hostile
        ? this.hitFriendly(t.previous, t.position, player, 9)
        : this.hitEnemy(t.previous, t.position, 0);
      const blocked = this.blocked(t.previous, t.position, query);
      if (hit && (!blocked || this.isGround(hit))) {
        this.damageEntity(hit, 9, player, "gun");
        t.active = false;
      } else if (blocked) {
        // Rounds striking an installation's own structure still count.
        const structure = t.hostile ? undefined : this.groundNear(t.position, 12);
        if (structure) this.damageEntity(structure, 9, player, "gun");
        t.active = false;
      }
    }
    const heat = engineHeat(player);
    for (const m of this.missiles) {
      if (!m.active) continue;
      const victim =
        m.targetId === PLAYER_ID
          ? player
          : m.targetId === ALLY_ID
            ? this.ally
            : (this.enemies.find((e) => e.id === m.targetId && e.active) ??
              this.wingmen.find((w) => w.id === m.targetId && w.active));
      let source = NO_SOURCE;
      if (victim && victim !== player && !m.hostile && (victim as CombatEntity).active) {
        // The player's missiles fly the datalink onto the locked target.
        source = m.targetId;
        this.desired.copy(victim.position);
      } else if (victim && (victim === player || (victim as CombatEntity).active)) {
        const victimHeat = victim === player ? heat : 1.2;
        source = this.seek(m, victim, victimHeat, this.desired);
        if (
          source === NO_SOURCE &&
          victim === player &&
          this.airDefense.commandLink(m.owner)
        ) {
          // Midcourse: the battery radar steers the missile until its seeker sees the jet.
          source = PLAYER_ID;
          this.desired.copy(player.position);
        }
      }
      m.guided = source === m.targetId;
      advanceMissile(m, source !== NO_SOURCE ? this.desired : null, source, dt);
      if (missileSpent(m)) {
        if (m.hostile) this.event("explosion", m.position, m.id, false, 0.35, { kind: "air" });
        m.active = false;
        continue;
      }
      let hit: CombatEntity | CombatPlayer | undefined;
      let miss = 0;
      if (m.hostile) {
        const fuze = m.profile.fuze;
        miss = sweptClosest(m.previous, m.position, player.previous, player.position);
        if (miss <= fuze) hit = player;
        else if (
          this.ally?.active &&
          (miss = sweptClosest(
            m.previous,
            m.position,
            this.ally.previous,
            this.ally.position,
          )) <= fuze + 4
        )
          hit = this.ally;
        else
          for (const w of this.wingmen)
            if (w.active && (miss = sweptClosest(m.previous, m.position, w.previous, w.position)) <= fuze + 2) {
              hit = w;
              break;
            }
      } else hit = this.hitEnemy(m.previous, m.position, 6);
      const blocked = this.blocked(m.previous, m.position, query);
      if (hit && (!blocked || this.isGround(hit))) {
        // Proximity burst: a near miss does about half the damage of a direct hit.
        const damage = m.hostile
          ? m.profile.damage * (1 - 0.5 * MathUtils.clamp(miss / m.profile.fuze, 0, 1))
          : m.profile.damage;
        this.damageEntity(hit, damage, player, "missile");
        this.event("explosion", m.position, m.id, !m.hostile, 0.6, {
          kind: this.isGround(hit) ? "ground" : "air",
        });
        m.active = false;
      } else if (blocked) {
        const structure = m.hostile ? undefined : this.groundNear(m.position, 20);
        if (structure) this.damageEntity(structure, m.profile.damage, player, "missile");
        this.event("explosion", m.position, m.id, !m.hostile, 0.4, { kind: "ground" });
        m.active = false;
      }
    }
  }
  private isGround(hit: CombatEntity | CombatPlayer) {
    return (hit as CombatEntity).kind === "ground";
  }
  private hitEnemy(from: Vector3, to: Vector3, margin: number) {
    for (const e of this.enemies)
      if (
        e.active &&
        sweptMovingHit(from, to, e.previous, e.position, e.radius + margin)
      )
        return e;
  }
  private groundNear(point: Vector3, margin: number) {
    for (const e of this.enemies)
      if (
        e.active &&
        e.kind === "ground" &&
        e.position.distanceTo(point) < e.radius + margin
      )
        return e;
  }
  private hitFriendly(
    from: Vector3,
    to: Vector3,
    player: CombatPlayer,
    radius: number,
  ): CombatEntity | CombatPlayer | undefined {
    if (sweptMovingHit(from, to, player.previous, player.position, radius))
      return player;
    const ally = this.ally;
    if (
      ally?.active &&
      sweptMovingHit(from, to, ally.previous, ally.position, radius + 4)
    )
      return ally;
    for (const w of this.wingmen)
      if (w.active && sweptMovingHit(from, to, w.previous, w.position, radius + 2)) return w;
  }
  private damageEntity(
    target: CombatEntity | CombatPlayer,
    damage: number,
    player: CombatPlayer,
    weapon: "gun" | "missile",
  ) {
    if (target === player) {
      this.playerHealth = Math.max(0, this.playerHealth - damage);
      this.event("hit", player.position, PLAYER_ID, true, 1, { weapon });
      return;
    }
    const e = target as CombatEntity;
    e.health = Math.max(0, e.health - damage);
    this.event("hit", e.position, e.id, false, 1, { weapon });
    if (
      e.kind === "air" &&
      !(this.patrol && this.active === "intercept" && this.elapsed < 12)
    ) {
      e.state = "evade";
      e.stateTime = 0;
    }
    if (e.health <= 0) {
      e.active = false;
      if (e.kind !== "ally") this.kills++;
      if (e.role === "target") {
        if (e.tag !== "radar") this.bonus++;
        this.onTargetDestroyed?.(e.tag);
      }
      this.event(
        "explosion",
        e.position,
        e.id,
        false,
        e.kind === "ground" ? (e.role === "target" ? 3 : 1.6) : 1.2,
        { kind: e.kind === "ground" ? "ground" : "air" },
      );
    }
  }
  /** Clockwise bearing from the nose (rad); yaw grows to the left (west of north). */
  private bearing(player: CombatPlayer, yaw: number, at: Vector3) {
    const b =
      yaw - Math.atan2(-(at.x - player.position.x), -(at.z - player.position.z));
    return Math.atan2(Math.sin(b), Math.cos(b));
  }
  private readonly addContact = (
    player: CombatPlayer,
    yaw: number,
    at: Vector3,
    range: number,
    level: 1 | 2 | 3,
    source: RwrContact["source"],
  ) => {
    const w = this.warning;
    if (w.count >= MAX_RWR) return;
    const c = w.contacts[w.count++];
    c.bearing = this.bearing(player, yaw, at);
    c.range = range;
    c.level = level;
    c.source = source;
    if (level > w.level) w.level = level;
  };
  /** Warning receiver: emitters, trackers and the nearest guided missile. */
  private updateWarning(player: CombatPlayer) {
    const w = this.warning;
    w.count = 0;
    w.level = 0;
    this.forward.copy(this.localForward).applyQuaternion(player.quaternion);
    const yaw = Math.atan2(-this.forward.x, -this.forward.z);
    const add = this.addContact;
    for (const u of this.airDefense.units)
      if (u.rwr > 0)
        add(player, yaw, u.sensor, u.range, u.rwr as 1 | 2 | 3, u.rules.type);
    for (const e of this.enemies) {
      if (!e.active || e.kind !== "air" || this.elapsed < e.releaseAt) continue;
      const range = e.position.distanceTo(player.position);
      const firing = this.inFlight(e.id) > 0;
      if (firing || ((e.state === "attack" || e.state === "approach") && range < 6000))
        add(player, yaw, e.position, range, firing ? 3 : 2, "fighter");
    }
    let nearest = Infinity,
      threat = false;
    w.missile = false;
    for (const m of this.missiles) {
      if (!m.active || !m.hostile || m.targetId !== PLAYER_ID || !m.guided) continue;
      const d = m.position.distanceTo(player.position);
      this.direction.copy(player.position).sub(m.position);
      const closing = (this.direction.dot(m.direction) * m.speed) / Math.max(d, 1);
      if (d < 2300 || d < closing * 6) threat = true;
      if (d < nearest) {
        nearest = d;
        w.missile = true;
        w.missileRange = d;
        w.missileSam = m.profile.id === "shorad" || m.profile.id === "mrsam";
        w.missileBearing = this.bearing(player, yaw, m.position);
      }
    }
    // Brief hold so a decoyed seeker flickering back does not re-trigger every call.
    if (threat) this.threatUntil = this.elapsed + 0.6;
    this.threatening = threat || this.elapsed < this.threatUntil;
    w.samLaunch = this.elapsed - this.samLaunchAt < 3;
  }
  private finish(success: boolean, position: Vector3, message: string) {
    this.completed = success;
    this.failed = !success;
    this.result = message;
    this.threatening = false;
    this.warning.count = this.warning.level = 0;
    this.warning.samLaunch = this.warning.missile = false;
    for (const m of this.missiles) m.active = false;
    for (const t of this.tracers) t.active = false;
    this.event(success ? "complete" : "failed", position, undefined, true);
  }
}
