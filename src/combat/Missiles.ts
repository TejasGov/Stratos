import { MathUtils, Quaternion, Vector3 } from "three";

/**
 * One projectile model for every guided weapon in the game: fighter missiles,
 * the player's missiles and both kinds of surface-to-air missile. Profiles are
 * arcade tuning for fun, not the specification of any real weapon.
 */
export interface MissileProfile {
  id: "player" | "aam" | "shorad" | "mrsam";
  /** Speed leaving the rail or tube (m/s). */
  launchSpeed: number;
  /** Speed at motor burnout; the missile never flies faster than this. */
  boostSpeed: number;
  boostTime: number;
  /** Coast speed loss per second as a fraction of speed. */
  drag: number;
  /** Speed lost per second per m/s² of lateral acceleration: hard turns bleed energy. */
  induced: number;
  /** Below this, after burnout, the missile has no energy left and self-destructs. */
  minSpeed: number;
  /** Lateral g available at or above `refSpeed`; falls with dynamic pressure below it. */
  gMax: number;
  refSpeed: number;
  /** Structural turn-rate cap (rad/s). */
  maxRate: number;
  /** Proportional-navigation constant. */
  nav: number;
  /** Seeker half-angle (rad); sources outside the cone are invisible. */
  cone: number;
  /** Acquisition range of a heat-1 source (a jet at full dry power). */
  seekerRange: number;
  /** Base chance that a flare entering the seeker's view seduces it. */
  decoy: number;
  /** Proximity-fuze radius (m). */
  fuze: number;
  damage: number;
  life: number;
  /** Visual size multiplier for CombatView. */
  scale: number;
}

const DEG = Math.PI / 180;

export const MISSILES: Record<MissileProfile["id"], MissileProfile> = {
  // Datalink-guided onto the locked target, as before: constant speed, 1.7 rad/s.
  player: {
    id: "player",
    launchSpeed: 440,
    boostSpeed: 440,
    boostTime: 0,
    drag: 0,
    induced: 0,
    minSpeed: 0,
    gMax: 1000,
    refSpeed: 1,
    maxRate: 1.7,
    nav: 4,
    cone: Math.PI,
    seekerRange: Infinity,
    decoy: 0,
    fuze: 18,
    damage: 65,
    life: 10,
    scale: 2.2,
  },
  // Enemy fighters' short-range heat-seeker.
  aam: {
    id: "aam",
    launchSpeed: 260,
    boostSpeed: 580,
    boostTime: 2.2,
    drag: 0.09,
    induced: 0.05,
    minSpeed: 170,
    gMax: 46,
    refSpeed: 480,
    maxRate: 1.6,
    nav: 4,
    cone: 32 * DEG,
    seekerRange: 4500,
    decoy: 0.75,
    fuze: 15,
    damage: 30,
    life: 11,
    scale: 2.2,
  },
  // Shoulder/vehicle IR missile: quick, short-legged and easily decoyed.
  shorad: {
    id: "shorad",
    launchSpeed: 45,
    boostSpeed: 700,
    boostTime: 2.1,
    drag: 0.085,
    induced: 0.045,
    minSpeed: 190,
    gMax: 48,
    refSpeed: 500,
    maxRate: 1.5,
    nav: 4,
    cone: 28 * DEG,
    seekerRange: 6000,
    decoy: 0.85,
    fuze: 15,
    damage: 40,
    life: 13,
    scale: 2.6,
  },
  // Battery missile: command-guided by the battery radar, terminal heat seeker.
  mrsam: {
    id: "mrsam",
    launchSpeed: 70,
    boostSpeed: 950,
    boostTime: 3.4,
    drag: 0.045,
    induced: 0.035,
    minSpeed: 230,
    gMax: 30,
    refSpeed: 600,
    maxRate: 1.2,
    nav: 4,
    cone: 22 * DEG,
    seekerRange: 4000,
    decoy: 0.45,
    fuze: 18,
    damage: 55,
    life: 24,
    scale: 4,
  },
};

/** Beyond this off-boresight angle guidance flies pure pursuit at the turn limit. */
export const PURSUIT_ANGLE = 50 * DEG;
/** A decoyed flare outshines any jet while it burns. */
export const FLARE_HEAT = 3;
export const FLARE_BURN = 3;
/** Skin friction keeps a jet with every engine dead faintly visible. */
export const COLD_AIRFRAME_HEAT = 0.08;
/** Source key meaning "nothing tracked" (entity ids, including the ally's -1, are valid keys). */
export const NO_SOURCE = -99999;

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
  /** Seeker (or command link) is on the intended target, not a flare or nothing. */
  guided: boolean;
  profile: MissileProfile;
  /** Last line of sight to the tracked source, for proportional navigation. */
  los: Vector3;
  losRange: number;
  /** Key of the tracked source (NO_SOURCE: none); a change restarts the LOS-rate estimate. */
  source: number;
  /** Bitmasks over the flare pool: flares this seeker has judged / been seduced by. */
  flaresSeen: number;
  flaresDecoyed: number;
  /** Last lateral acceleration (m/s²). */
  lateral: number;
}

export function createMissile(id: number): Missile {
  return {
    id,
    active: false,
    hostile: false,
    owner: 0,
    targetId: 0,
    position: new Vector3(),
    previous: new Vector3(),
    direction: new Vector3(0, 0, -1),
    speed: MISSILES.player.launchSpeed,
    life: 0,
    guided: true,
    profile: MISSILES.player,
    los: new Vector3(),
    losRange: 0,
    source: NO_SOURCE,
    flaresSeen: 0,
    flaresDecoyed: 0,
    lateral: 0,
  };
}

/** Arms a pooled record: launch state, empty seeker memory. */
export function launchMissile(
  m: Missile,
  profile: MissileProfile,
  position: Vector3,
  direction: Vector3,
  hostile: boolean,
  owner: number,
  targetId: number,
  launchSpeed = profile.launchSpeed,
) {
  m.active = true;
  m.hostile = hostile;
  m.owner = owner;
  m.targetId = targetId;
  m.profile = profile;
  m.guided = true;
  m.direction.copy(direction).normalize();
  m.position.copy(position);
  m.previous.copy(position);
  m.speed = Math.min(launchSpeed, profile.boostSpeed);
  m.life = 0;
  m.source = NO_SOURCE;
  m.losRange = 0;
  m.flaresSeen = m.flaresDecoyed = 0;
  m.lateral = 0;
  return m;
}

export interface EngineHeat {
  engines?: readonly { output: number; failed: boolean }[];
  boost?: boolean;
  throttle?: number;
}

/** Infrared brightness relative to one jet at full dry power (1); afterburner ≈ 1.6. */
export function engineHeat(p: EngineHeat) {
  const engines = p.engines;
  let running = 1,
    output = p.throttle ?? 0.8;
  if (engines?.length) {
    running = output = 0;
    for (const e of engines)
      if (!e.failed) {
        running++;
        output += MathUtils.clamp(e.output, 0, 1);
      }
    if (!running) return COLD_AIRFRAME_HEAT;
    running /= engines.length;
    output /= engines.length;
  }
  // Hot metal glows even at idle; afterburner plumes dwarf everything.
  return (0.35 * running + 0.65 * output) * (p.boost ? 1.6 : 1);
}

/** Chance a flare seduces this seeker: hot (afterburning) jets are harder to hide. */
export function flareDecoyChance(profile: MissileProfile, heat: number) {
  return MathUtils.clamp(
    profile.decoy * MathUtils.clamp(1.25 - 0.35 * heat, 0.55, 1.2),
    0,
    0.95,
  );
}

/** Seeker acquisition range for a source of this heat. */
export function seekerRange(profile: MissileProfile, heat: number) {
  return profile.seekerRange * Math.sqrt(Math.max(0, heat));
}

/** Turn rate available at this speed: lift (and so g) falls with dynamic pressure. */
export function maxTurnRate(profile: MissileProfile, speed: number) {
  const v = Math.max(speed, 1);
  const q = Math.min(1, (v / profile.refSpeed) ** 2);
  return Math.min(profile.maxRate, (profile.gMax * 9.81 * q) / v);
}

const r = new Vector3(),
  omega = new Vector3(),
  axis = new Vector3(),
  turn = new Quaternion();

/**
 * Advances one missile by dt: boost then coast, steering toward `aim` (null
 * flies straight). Proportional navigation turns the velocity at N·Vc/Vm
 * times the line-of-sight rate; far off boresight it flies pure pursuit.
 */
export function advanceMissile(
  m: Missile,
  aim: Vector3 | null,
  source: number,
  dt: number,
) {
  const p = m.profile;
  m.lateral = 0;
  if (aim) {
    r.copy(aim).sub(m.position);
    const range = r.length();
    if (range > 1e-3) {
      r.multiplyScalar(1 / range);
      if (m.source !== source || m.losRange <= 0) {
        m.source = source;
        m.los.copy(r);
        m.losRange = range;
      }
      const cap = maxTurnRate(p, m.speed);
      const off = m.direction.angleTo(r);
      let rate = 0;
      if (off > PURSUIT_ANGLE) {
        axis.crossVectors(m.direction, r);
        if (axis.lengthSq() < 1e-10)
          axis.set(0, 1, 0).cross(m.direction).normalize();
        rate = cap;
      } else {
        omega.crossVectors(m.los, r).multiplyScalar(1 / dt);
        const closing = Math.max((m.losRange - range) / dt, 0.3 * m.speed);
        rate = (p.nav * closing * omega.length()) / Math.max(m.speed, 1);
        axis.copy(omega);
        // Terminal fuze range: never overshoot the line of sight itself.
        rate = Math.min(rate, off / dt + omega.length());
      }
      rate = Math.min(rate, cap);
      if (rate > 1e-9 && axis.lengthSq() > 1e-12) {
        axis.normalize();
        turn.setFromAxisAngle(axis, rate * dt);
        m.direction.applyQuaternion(turn).normalize();
        m.lateral = rate * m.speed;
      }
      m.los.copy(r);
      m.losRange = range;
    }
  } else m.source = NO_SOURCE;
  const accel =
    m.life < p.boostTime
      ? (p.boostSpeed - p.launchSpeed) / p.boostTime
      : -p.drag * m.speed;
  m.speed = MathUtils.clamp(
    m.speed + (accel - p.induced * m.lateral) * dt,
    0,
    p.boostSpeed,
  );
  m.previous.copy(m.position);
  m.position.addScaledVector(m.direction, m.speed * dt);
  m.life += dt;
}

/** Out of time, or burnt out with too little speed left to manoeuvre. */
export function missileSpent(m: Missile) {
  const p = m.profile;
  return m.life > p.life || (m.life > p.boostTime && m.speed < p.minSpeed);
}
