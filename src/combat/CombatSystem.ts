import { MathUtils, Quaternion, Vector3 } from "three";
import { heightAt, renderedHeightAt } from "../world/terrain";
import { landmarks } from "../missions";

export type CombatMission = "intercept" | "escort" | "strike";
export type AIState =
  "patrol" | "approach" | "attack" | "extend" | "evade" | "recover";
export interface CombatPlayer {
  position: Vector3;
  previous: Vector3;
  velocity: Vector3;
  quaternion: Quaternion;
  speed: number;
  crashed: boolean;
}
export interface CombatInput {
  gun: boolean;
  missile: boolean;
  target: boolean;
  flare: boolean;
}
export const combatNeutral: CombatInput = {
  gun: false,
  missile: false,
  target: false,
  flare: false,
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
}
export interface Missile {
  id: number;
  active: boolean;
  hostile: boolean;
  owner: number;
  targetId: number;
  position: Vector3;
  previous: Vector3;
  direction: Vector3;
  speed: number;
  life: number;
  guided: boolean;
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
export interface CombatEvent {
  type:
    "gun" | "missile" | "hit" | "explosion" | "flare" | "complete" | "failed";
  position: Vector3;
  entityId?: number;
  player?: boolean;
  scale?: number;
}
export const PLAYER_ID = 0,
  ALLY_ID = -1;

/** Relative motion gives the closest approach of two swept objects in one step. */
export function sweptMovingHit(
  from: Vector3,
  to: Vector3,
  targetFrom: Vector3,
  targetTo: Vector3,
  radius: number,
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
  return (
    (rx + dx * t) ** 2 + (ry + dy * t) ** 2 + (rz + dz * t) ** 2 <=
    radius * radius
  );
}

/** Bounded single-player combat. All entities remain in global space until CombatView upload. */
export class CombatSystem {
  active: CombatMission | null = null;
  completed = false;
  failed = false;
  playerHealth = 100;
  enemies: CombatEntity[] = [];
  ally: CombatEntity | null = null;
  readonly missiles: Missile[] = Array.from({ length: 16 }, (_, i) => ({
    id: 100 + i,
    active: false,
    hostile: false,
    owner: 0,
    targetId: 0,
    position: new Vector3(),
    previous: new Vector3(),
    direction: new Vector3(0, 0, -1),
    speed: 430,
    life: 0,
    guided: true,
  }));
  readonly tracers: Tracer[] = Array.from({ length: 96 }, () => ({
    active: false,
    hostile: false,
    owner: 0,
    age: 0,
    position: new Vector3(),
    previous: new Vector3(),
    velocity: new Vector3(),
  }));
  private selected = 0;
  private lockProgress = 0;
  private elapsed = 0;
  private missileAmmo = 12;
  private gunAmmo = 600;
  private flares = 12;
  private kills = 0;
  private gunCooldown = 0;
  private missileCooldown = 0;
  private flareCooldown = 0;
  private previousInput = { ...combatNeutral };
  private events: CombatEvent[] = [];
  private range = 0;
  private threatening = false;
  private result = "";
  private objective = "";
  private lockReason = "No target";
  private escortGoal = new Vector3();
  private desired = new Vector3();
  private direction = new Vector3();
  private forward = new Vector3();
  private point = new Vector3();
  private aim = new Vector3();
  private targetQuaternion = new Quaternion();
  private readonly identityQuaternion = new Quaternion();
  private readonly localForward = new Vector3(0, 0, -1);
  private seed = 8391;

  get target() {
    return this.enemies.find((e) => e.id === this.selected && e.active) ?? null;
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
      missiles: this.missileAmmo,
      gunAmmo: this.gunAmmo,
      flares: this.flares,
      health: this.playerHealth,
      kills: this.kills,
      elapsed: this.elapsed,
      result: this.result,
      targetHealth: target ? target.health / target.maxHealth : 0,
      allyHealth: this.ally?.health ?? null,
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
  ) {
    if (this.events.length < 128)
      this.events.push({
        type,
        position: position.clone(),
        entityId,
        player,
        scale,
      });
  }
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }
  private ground(x: number, z: number, query?: CombatQuery) {
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
  private entity(
    id: number,
    name: string,
    kind: CombatEntity["kind"],
    position: Vector3,
  ): CombatEntity {
    const health = kind === "ground" ? 160 : kind === "ally" ? 120 : 90;
    return {
      id,
      name,
      kind,
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
    };
  }
  start(type: CombatMission, player: CombatPlayer) {
    this.reset();
    this.active = type;
    this.forward.copy(this.localForward).applyQuaternion(player.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 0.01) this.forward.set(0, 0, -1);
    this.forward.normalize();
    const right = new Vector3(-this.forward.z, 0, this.forward.x);
    for (let i = 0; i < (type === "strike" ? 2 : 3); i++) {
      const position = player.position
        .clone()
        .addScaledVector(this.forward, 1600 + i * 650)
        .addScaledVector(right, i % 2 ? 430 : -260);
      position.y = Math.max(
        player.position.y + 80 + i * 60,
        this.ground(position.x, position.z) + 650,
      );
      const e = this.entity(
        i + 1,
        `BANDIT ${String(i + 1).padStart(2, "0")}`,
        "air",
        position,
      );
      e.quaternion.setFromUnitVectors(
        this.localForward,
        this.direction.copy(player.position).sub(position).normalize(),
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
      this.escortGoal
        .copy(this.ally.position)
        .addScaledVector(this.forward, 5400);
      this.escortGoal.y = Math.max(
        this.escortGoal.y,
        this.ground(this.escortGoal.x, this.escortGoal.z) + 650,
      );
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
      this.objective = `STRIKE · Destroy radar at ${coast.name}`;
    }
    this.selected = type === "strike" ? 4 : 1;
  }
  reset() {
    this.active = null;
    this.completed = this.failed = false;
    this.playerHealth = 100;
    this.enemies.length = 0;
    this.ally = null;
    this.selected = 0;
    this.lockProgress = this.elapsed = this.kills = this.range = 0;
    this.missileAmmo = this.flares = 12;
    this.gunAmmo = 600;
    this.gunCooldown = this.missileCooldown = this.flareCooldown = 0;
    this.previousInput = { ...combatNeutral };
    this.events.length = 0;
    this.objective = this.result = "";
    this.lockReason = "No target";
    this.threatening = false;
    this.seed = 8391;
    for (const m of this.missiles) m.active = false;
    for (const t of this.tracers) t.active = false;
  }
  stop() {
    this.reset();
  }
  cycleTarget() {
    const available = this.enemies.filter((e) => e.active);
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
    this.elapsed += dt;
    this.gunCooldown -= dt;
    this.missileCooldown -= dt;
    this.flareCooldown -= dt;
    if (player.crashed) {
      this.playerHealth = 0;
      this.finish(false, player.position, "Aircraft lost");
      return;
    }
    if (input.target && !this.previousInput.target) this.cycleTarget();
    if (!this.target) {
      this.selected = this.enemies.find((e) => e.active)?.id ?? 0;
      this.lockProgress = 0;
    }
    for (const e of this.enemies)
      if (e.active && e.kind === "air") this.updateEnemy(e, dt, player, query);
    if (this.ally?.active) this.updateAlly(dt, query);
    this.updateLock(dt, player, query);
    if (input.gun && this.gunCooldown <= 0 && this.gunAmmo > 0) {
      this.forward.copy(this.localForward).applyQuaternion(player.quaternion);
      this.aim.copy(player.position).addScaledVector(this.forward, 12);
      if (this.fireGun(this.aim, this.forward, false, PLAYER_ID)) {
        this.gunAmmo--;
        this.gunCooldown = 1 / 13;
      }
    }
    if (
      input.missile &&
      !this.previousInput.missile &&
      this.status.canFire &&
      this.target
    ) {
      this.forward.copy(this.localForward).applyQuaternion(player.quaternion);
      if (
        this.fireMissile(
          player.position,
          this.forward,
          false,
          PLAYER_ID,
          this.target.id,
        )
      ) {
        this.missileAmmo--;
        this.missileCooldown = 1.1;
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
      this.event("flare", player.position, PLAYER_ID, true);
      // Explicit forgiving arcade window: nearby player-seeking missiles lose guidance.
      for (const m of this.missiles)
        if (
          m.active &&
          m.hostile &&
          m.targetId === PLAYER_ID &&
          m.position.distanceTo(player.position) < 1400
        ) {
          m.guided = false;
          m.direction.y -= 0.2;
          m.direction.normalize();
        }
    }
    this.updateProjectiles(dt, player, query);
    this.previousInput.gun = input.gun;
    this.previousInput.missile = input.missile;
    this.previousInput.target = input.target;
    this.previousInput.flare = input.flare;
    this.threatening = this.missiles.some(
      (m) =>
        m.active &&
        m.hostile &&
        m.targetId === PLAYER_ID &&
        m.position.distanceTo(player.position) < 2300,
    );
    if (this.playerHealth <= 0)
      this.finish(false, player.position, "Aircraft destroyed");
    else if (this.active === "escort" && this.ally && !this.ally.active)
      this.finish(false, this.ally.position, "Transport lost");
    else if (
      this.active === "escort" &&
      this.ally &&
      this.ally.position.distanceTo(this.escortGoal) < 180
    )
      this.finish(true, player.position, "Transport reached the safe corridor");
    else if (
      this.active === "strike" &&
      !this.enemies.some((e) => e.kind === "ground" && e.active)
    )
      this.finish(true, player.position, "Radar destroyed");
    else if (this.active === "intercept" && !this.enemies.some((e) => e.active))
      this.finish(true, player.position, "Airspace clear");
    else if (this.elapsed > 240)
      this.finish(false, player.position, "Sortie time expired");
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
      this.direction.multiplyScalar(1 / this.range).dot(this.forward) > 0.927;
    const occluded =
      this.range < 4200 &&
      inCone &&
      this.blocked(player.position, target.position, query);
    const visible = this.range < 4200 && inCone && !occluded;
    this.lockProgress = MathUtils.clamp(
      this.lockProgress + dt * (visible ? 1 / 1.15 : -2.5),
      0,
      1,
    );
    this.lockReason =
      this.range >= 4200
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
    const victim =
      this.active === "escort" && e.id % 2 && this.ally?.active
        ? this.ally
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
      e.state = "approach";
      e.stateTime = 0;
    } else if (e.state === "patrol" && e.stateTime > 2) {
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
      (e.state === "evade" && e.stateTime > 3)
    ) {
      e.state = "approach";
      e.stateTime = 0;
    }
    if (e.state === "recover")
      this.desired.copy(this.forward).setY(1.4).normalize();
    else if (e.state === "extend")
      this.desired.copy(this.forward).setY(0.15).normalize();
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
      dt * (e.state === "recover" ? 0.8 : 0.58),
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
          victim === this.ally ? ALLY_ID : PLAYER_ID,
        );
        e.cooldown = 10 + this.random() * 4;
      }
    }
    if (
      e.state === "attack" &&
      range < 850 &&
      e.cooldown < 8 &&
      e.stateTime % 0.7 < dt
    ) {
      this.desired.copy(victim.position).sub(e.position).normalize();
      if (this.desired.dot(this.direction) > 0.98)
        this.fireGun(e.position, this.direction, true, e.id);
    }
  }
  private updateAlly(dt: number, query?: CombatQuery) {
    const e = this.ally!;
    e.previous.copy(e.position);
    this.desired.copy(this.escortGoal).sub(e.position).normalize();
    const ahead = this.aim.copy(e.position).addScaledVector(this.desired, 500);
    const clearance = this.ground(ahead.x, ahead.z, query) + 450;
    if (e.position.y < clearance)
      this.desired.y = Math.max(0.35, this.desired.y);
    this.desired.normalize();
    this.targetQuaternion.setFromUnitVectors(this.localForward, this.desired);
    e.quaternion.rotateTowards(this.targetQuaternion, 0.5 * dt);
    e.velocity
      .copy(this.localForward)
      .applyQuaternion(e.quaternion)
      .multiplyScalar(e.speed);
    e.position.addScaledVector(e.velocity, dt);
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
    bullet.velocity.copy(direction).multiplyScalar(1400);
    this.event("gun", position, owner, !hostile);
    return true;
  }
  private fireMissile(
    position: Vector3,
    direction: Vector3,
    hostile: boolean,
    owner: number,
    targetId: number,
  ) {
    const missile = this.missiles.find((m) => !m.active);
    if (!missile) return false;
    missile.active = true;
    missile.hostile = hostile;
    missile.owner = owner;
    missile.targetId = targetId;
    missile.guided = true;
    missile.direction.copy(direction);
    missile.position.copy(position).addScaledVector(direction, 15);
    missile.previous.copy(missile.position);
    missile.life = 0;
    missile.speed = hostile ? 380 : 440;
    this.event("missile", missile.position, missile.id, !hostile);
    return true;
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
        : this.enemies.find(
            (e) =>
              e.active &&
              sweptMovingHit(
                t.previous,
                t.position,
                e.previous,
                e.position,
                e.kind === "ground" ? 25 : 12,
              ),
          );
      if (hit && !this.blocked(t.previous, t.position, query)) {
        this.damageEntity(hit, 9, player);
        t.active = false;
      } else if (this.blocked(t.previous, t.position, query)) t.active = false;
    }
    for (const m of this.missiles) {
      if (!m.active) continue;
      const target =
        m.targetId === PLAYER_ID
          ? player
          : m.targetId === ALLY_ID
            ? this.ally
            : this.enemies.find((e) => e.id === m.targetId && e.active);
      if (target && m.guided) {
        this.desired
          .copy(target.position)
          .addScaledVector(
            target.velocity,
            Math.min(
              1.2,
              (m.position.distanceTo(target.position) / m.speed) * 0.55,
            ),
          )
          .sub(m.position)
          .normalize();
        const angle = m.direction.angleTo(this.desired);
        if (angle > 1e-5) {
          // Slerp on unit directions through a quaternion: finite turn rate even behind target.
          this.targetQuaternion.setFromUnitVectors(m.direction, this.desired);
          this.targetQuaternion.slerp(
            this.identityQuaternion,
            1 - Math.min(1, (dt * 1.7) / angle),
          );
          m.direction.applyQuaternion(this.targetQuaternion).normalize();
        }
      }
      m.previous.copy(m.position);
      m.position.addScaledVector(m.direction, m.speed * dt);
      m.life += dt;
      if (m.life > 10) {
        m.active = false;
        continue;
      }
      const hit = m.hostile
        ? this.hitFriendly(m.previous, m.position, player, 17)
        : this.enemies.find(
            (e) =>
              e.active &&
              sweptMovingHit(
                m.previous,
                m.position,
                e.previous,
                e.position,
                e.kind === "ground" ? 29 : 18,
              ),
          );
      if (hit && !this.blocked(m.previous, m.position, query)) {
        this.damageEntity(hit, m.hostile ? 28 : 65, player);
        this.event("explosion", m.position, m.id, !m.hostile, 0.6);
        m.active = false;
      } else if (this.blocked(m.previous, m.position, query)) {
        this.event("explosion", m.position, m.id, false, 0.4);
        m.active = false;
      }
    }
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
  }
  private damageEntity(
    target: CombatEntity | CombatPlayer,
    damage: number,
    player: CombatPlayer,
  ) {
    if (target === player) {
      this.playerHealth = Math.max(0, this.playerHealth - damage);
      this.event("hit", player.position, PLAYER_ID, true);
      return;
    }
    const e = target as CombatEntity;
    e.health = Math.max(0, e.health - damage);
    this.event("hit", e.position, e.id);
    if (e.kind === "air") {
      e.state = "evade";
      e.stateTime = 0;
    }
    if (e.health <= 0) {
      e.active = false;
      if (e.kind !== "ally") this.kills++;
      this.event(
        "explosion",
        e.position,
        e.id,
        false,
        e.kind === "ground" ? 2 : 1.2,
      );
    }
  }
  private finish(success: boolean, position: Vector3, message: string) {
    this.completed = success;
    this.failed = !success;
    this.result = message;
    this.threatening = false;
    for (const m of this.missiles) m.active = false;
    for (const t of this.tracers) t.active = false;
    this.event(success ? "complete" : "failed", position, undefined, true);
  }
}
