import test from "node:test";
import assert from "node:assert/strict";
import { Quaternion, Vector3 } from "three";
import {
  CombatSystem,
  PLAYER_ID,
  combatNeutral,
  sweptClosest,
  type CombatEvent,
  type CombatPlayer,
} from "../src/combat/CombatSystem.ts";
import {
  HOME_UMBRELLA,
  SAM_RULES,
  irDetectionRange,
  radarDetectionRange,
  samDetection,
  type SensorTarget,
} from "../src/combat/AirDefense.ts";
import {
  MISSILES,
  advanceMissile,
  createMissile,
  engineHeat,
  flareDecoyChance,
  launchMissile,
  maxTurnRate,
  missileSpent,
  type MissileProfile,
} from "../src/combat/Missiles.ts";
import { HAVEN, runwayThreshold } from "../src/world/bases.ts";

const flat = () => 0;
const emptyWorld = { groundHeight: flat, blocked: () => false };
const sensor = new Vector3(0, 10, 0);
const jet = (
  position: Vector3,
  velocity = new Vector3(0, 0, 200),
  extra: Partial<SensorTarget> = {},
): SensorTarget => ({ position, velocity, rcs: 1, ...extra });
const player = (x = 0, y = 2500, z = 0, onGround = false): CombatPlayer => ({
  position: new Vector3(x, y, z),
  previous: new Vector3(x, y, z),
  velocity: new Vector3(),
  quaternion: new Quaternion(),
  speed: 200,
  crashed: false,
  onGround,
  engines: [{ output: 0.8, failed: false }],
  boost: false,
  throttle: 0.8,
});

test("radar detection range shrinks with radar cross-section (fourth-root law)", () => {
  assert.equal(radarDetectionRange(1), SAM_RULES.mrsam.detectRange);
  assert.ok(Math.abs(radarDetectionRange(0.1) - 12000 * 0.1 ** 0.25) < 1e-6);
  assert.ok(radarDetectionRange(0.1) < radarDetectionRange(0.35));
  assert.ok(radarDetectionRange(0.35) < radarDetectionRange(1));
  // Closing head-on at 9 km and 3 km up: the old fighter is seen, the stealth jet is not.
  const at = new Vector3(0, 3000, -9000);
  const inbound = new Vector3(0, 0, 220);
  assert.equal(samDetection("mrsam", sensor, jet(at, inbound), flat), "detected");
  assert.equal(
    samDetection("mrsam", sensor, jet(at, inbound, { rcs: 0.1 }), flat),
    "range",
  );
  at.set(0, 3000, -5000);
  assert.equal(
    samDetection("mrsam", sensor, jet(at, inbound, { rcs: 0.1 }), flat),
    "detected",
  );
});

test("terrain masks both radar and infrared sensors", () => {
  const ridge = (_x: number, z: number) => (z < -2000 && z > -3000 ? 1500 : 0);
  const behind = new Vector3(0, 1000, -5000);
  assert.equal(samDetection("mrsam", sensor, jet(behind), ridge), "terrain");
  assert.equal(samDetection("mrsam", sensor, jet(behind), flat), "detected");
  const near = new Vector3(0, 400, -3500);
  assert.equal(samDetection("shorad", sensor, jet(near), ridge), "terrain");
  assert.equal(samDetection("shorad", sensor, jet(near), flat), "detected");
  // Climbing above the ridge line re-exposes the jet.
  behind.y = 4000;
  assert.equal(samDetection("mrsam", sensor, jet(behind), ridge), "detected");
});

test("a jet hugging the ground is lost in clutter beyond a few kilometres", () => {
  const low = new Vector3(0, 60, -6000);
  assert.equal(samDetection("mrsam", sensor, jet(low), flat), "low");
  low.z = -2500;
  assert.equal(samDetection("mrsam", sensor, jet(low), flat), "detected");
  const high = new Vector3(0, 400, -6000);
  assert.equal(samDetection("mrsam", sensor, jet(high), flat), "detected");
  // Height is above the local ground, not sea level.
  const hill = () => 900;
  const valley = new Vector3(0, 960, -6000);
  assert.equal(
    samDetection("mrsam", new Vector3(0, 910, 0), jet(valley), hill),
    "low",
  );
});

test("beaming the radar or a post-stall cobra breaks its track", () => {
  const at = new Vector3(0, 2000, -6000);
  const beam = new Vector3(240, 0, 0);
  assert.equal(samDetection("mrsam", sensor, jet(at, beam), flat), "notch");
  const oblique = new Vector3(240, 0, 120);
  assert.equal(samDetection("mrsam", sensor, jet(at, oblique), flat), "detected");
  assert.equal(
    samDetection("mrsam", sensor, jet(at, new Vector3(0, 0, 200), { postStall: true }), flat),
    "poststall",
  );
  // Too close to hide in the notch.
  at.set(0, 500, -1500);
  assert.equal(samDetection("mrsam", sensor, jet(at, beam), flat), "detected");
  // Infrared sensors do not care about Doppler.
  at.set(0, 1500, -4000);
  assert.equal(samDetection("shorad", sensor, jet(at, beam), flat), "detected");
});

test("short-range launchers see heat: proximity, afterburner reach, cold engines", () => {
  const dry = { engines: [{ output: 1, failed: false }], boost: false };
  const lit = { ...dry, boost: true };
  const dead = { engines: [{ output: 0, failed: true }], boost: false };
  assert.equal(irDetectionRange(dry), SAM_RULES.shorad.detectRange);
  assert.equal(irDetectionRange(lit), SAM_RULES.shorad.detectRange * 1.5);
  assert.ok(irDetectionRange(dead) < SAM_RULES.shorad.detectRange * 0.35);
  // Twin engines with one out run cooler than both turning.
  assert.ok(
    irDetectionRange({ engines: [{ output: 1, failed: false }, { output: 0, failed: true }] }) <
      irDetectionRange({ engines: [{ output: 1, failed: false }, { output: 1, failed: false }] }),
  );
  const at = new Vector3(0, 1500, -6000);
  assert.equal(samDetection("shorad", sensor, jet(at, undefined, lit), flat), "detected");
  assert.equal(samDetection("shorad", sensor, jet(at, undefined, dry), flat), "range");
  at.z = -2000;
  assert.equal(samDetection("shorad", sensor, jet(at, undefined, dead), flat), "range");
  // Stealth shaping is no help against a heat sensor.
  at.z = -4000;
  assert.equal(
    samDetection("shorad", sensor, jet(at, undefined, { ...dry, rcs: 0.1 }), flat),
    "detected",
  );
});

test("flare decoy chances: short-range seekers are easiest, battery missiles hardest; heat matters", () => {
  const dry = engineHeat({ engines: [{ output: 0.8, failed: false }] });
  const lit = engineHeat({ engines: [{ output: 1, failed: false }], boost: true });
  const idle = engineHeat({ engines: [{ output: 0.1, failed: false }] });
  assert.ok(lit > dry && dry > idle);
  const chance = (p: MissileProfile, heat: number) => flareDecoyChance(p, heat);
  assert.ok(chance(MISSILES.shorad, dry) > chance(MISSILES.aam, dry));
  assert.ok(chance(MISSILES.aam, dry) > chance(MISSILES.mrsam, dry));
  for (const p of [MISSILES.shorad, MISSILES.aam, MISSILES.mrsam]) {
    assert.ok(chance(p, lit) < chance(p, dry), `${p.id} afterburner`);
    assert.ok(chance(p, idle) > chance(p, dry), `${p.id} idle`);
    assert.ok(chance(p, idle) <= 0.97);
  }
  // Monte Carlo through the real seeker: one flare per missile, many independent sorties.
  const trial = (profile: MissileProfile, boost: boolean, seed: number) => {
    const p = player();
    p.boost = boost;
    const system = new CombatSystem();
    system.start("intercept", p, { patrol: true });
    system.seed = seed;
    const missile = launchMissile(
      system.missiles[0],
      profile,
      p.position.clone().add(new Vector3(0, 0, 1200)),
      new Vector3(0, 0, -1),
      true,
      99,
      PLAYER_ID,
      500,
    );
    system.step(1 / 60, p, { ...combatNeutral, flare: true }, emptyWorld);
    return missile.guided ? 0 : 1;
  };
  const rate = (profile: MissileProfile, boost: boolean) => {
    let decoyed = 0;
    for (let i = 0; i < 400; i++) decoyed += trial(profile, boost, 12345 + i * 7919);
    return decoyed / 400;
  };
  const heat = engineHeat(player());
  for (const profile of [MISSILES.shorad, MISSILES.mrsam]) {
    const measured = rate(profile, false);
    assert.ok(
      Math.abs(measured - flareDecoyChance(profile, heat)) < 0.08,
      `${profile.id}: ${measured}`,
    );
  }
  assert.ok(rate(MISSILES.shorad, true) < rate(MISSILES.shorad, false));
});

/** Scripted target: straight, or a sustained hard break once the missile is within `breakAt`. */
function engagement(
  profile: MissileProfile,
  range: number,
  aspect: number,
  breakAt: number,
  turnRate = 0.9,
  speed = 240,
) {
  const m = createMissile(1);
  const target = new Vector3(0, 1500, -range),
    previous = new Vector3(),
    velocity = new Vector3();
  let heading = aspect,
    breaking = false;
  launchMissile(m, profile, new Vector3(0, 5, 0), new Vector3(0, 0.45, -1), true, 1, 0);
  for (let i = 0; i < 60 * 40; i++) {
    if (m.position.distanceTo(target) < breakAt) breaking = true;
    if (breaking) heading += turnRate / 60;
    velocity.set(-Math.sin(heading) * speed, 0, -Math.cos(heading) * speed);
    previous.copy(target);
    target.addScaledVector(velocity, 1 / 60);
    advanceMissile(m, target, 0, 1 / 60);
    if (sweptClosest(m.previous, m.position, previous, target) <= profile.fuze) return true;
    if (missileSpent(m)) return false;
  }
  return false;
}

test("a seeker catches a straight-flying jet but a hard break defeats it at the edge of its envelope", () => {
  const crossing = Math.PI / 2;
  // Fighter missile at 2.5 km: straight and level is a kill, a 0.9 rad/s break is a miss.
  assert.equal(engagement(MISSILES.aam, 2500, crossing, 0), true);
  assert.equal(engagement(MISSILES.aam, 2500, crossing, 1500), false);
  assert.equal(engagement(MISSILES.aam, 2500, crossing, 800), false);
  // Battery missile near its range limit: same story.
  assert.equal(engagement(MISSILES.mrsam, 10000, crossing, 0), true);
  assert.equal(engagement(MISSILES.mrsam, 10000, crossing, 1500), false);
  // Close in, a fresh short-range missile still has the energy: breaking alone is not enough.
  assert.equal(engagement(MISSILES.shorad, 1500, crossing, 800), true);
  // Running away outranges it.
  assert.equal(engagement(MISSILES.shorad, 4500, 0, 0), false);
});

test("missile speed and turn rate stay within their limits; turning ability falls with speed", () => {
  for (const profile of [MISSILES.aam, MISSILES.shorad, MISSILES.mrsam]) {
    assert.ok(maxTurnRate(profile, 200) < maxTurnRate(profile, profile.refSpeed));
    const m = launchMissile(
      createMissile(1),
      profile,
      new Vector3(),
      new Vector3(0, 0, -1),
      true,
      1,
      0,
    );
    // Aim far off boresight so the seeker always demands more than the airframe gives.
    const aim = new Vector3(3000, 0, 0);
    let previousSpeed = m.speed;
    for (let i = 0; i < 60 * profile.life + 60 && m.active; i++) {
      const before = m.direction.clone();
      const speed = m.speed;
      aim.set(m.position.x + 3000, m.position.y, m.position.z + 3000);
      advanceMissile(m, aim, 0, 1 / 60);
      assert.ok(m.speed <= profile.boostSpeed + 1e-9, `${profile.id} overspeed`);
      assert.ok(
        before.angleTo(m.direction) <= maxTurnRate(profile, speed) / 60 + 1e-6,
        `${profile.id} turn ${i}`,
      );
      if (m.life > profile.boostTime + 1 / 60)
        assert.ok(m.speed < previousSpeed, `${profile.id} coasts down`);
      previousSpeed = m.speed;
      if (missileSpent(m)) m.active = false;
    }
    assert.equal(m.active, false, `${profile.id} self-destructs`);
  }
});

/** Steps a combat sortie, collecting events. */
function run(
  system: CombatSystem,
  p: CombatPlayer,
  seconds: number,
  events: CombatEvent[] = [],
  query: typeof emptyWorld = emptyWorld,
) {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    system.step(1 / 60, p, combatNeutral, query);
    events.push(...system.drainEvents());
  }
  return events;
}

test("batteries search, build a track over seconds, then launch only once weapons are free", () => {
  // Hovering 3 km east of the spine battery at 2.5 km: in reach of nothing else that launches first.
  const p = player(3000, 2500, -6500, true);
  const system = new CombatSystem();
  system.start("strike", p);
  for (const e of system.enemies) if (e.kind === "air") e.active = false;
  const spine = system.airDefense.units.find((u) => u.site.id === "spine")!;
  assert.equal(spine.state, "search");
  let trackedAt = -1;
  for (let i = 0; i < 7 * 60; i++) {
    system.step(1 / 60, p, combatNeutral, emptyWorld);
    if (trackedAt < 0 && spine.track >= 1) trackedAt = system.elapsed;
  }
  assert.ok(trackedAt >= 4 && trackedAt <= 6, `track built in ${trackedAt}s`);
  assert.equal(spine.state, "track");
  assert.ok(system.warning.count > 0 && system.warning.level === 2);
  // Clockwise bearing: the battery is due west of a north-facing jet.
  const contact = system.warning.contacts.find(
    (c) => c.source === "mrsam" && Math.abs(c.range - spine.range) < 1,
  )!;
  assert.ok(Math.abs(contact.bearing + Math.PI / 2) < 0.05, `bearing ${contact.bearing}`);
  // Still on the runway: nothing launches.
  assert.equal(system.samsInFlight(), 0);
  p.onGround = false;
  const events = run(system, p, 9);
  const launches = events.filter((e) => e.type === "samLaunch");
  assert.ok(launches.length >= 1);
  assert.ok(launches[0].direction && launches[0].direction.y > 0.2);
  assert.ok(system.inFlight(spine.launcher.id) <= SAM_RULES.mrsam.maxInFlight);
  assert.ok(system.warning.samLaunch || system.status.threat);
  assert.ok(
    system.warning.contacts.slice(0, system.warning.count).some((c) => c.level === 3),
  );
});

test("destroying a battery's radar vehicle blinds it", () => {
  const p = player(3000, 2500, -6500);
  const system = new CombatSystem();
  system.start("strike", p);
  for (const e of system.enemies) if (e.kind === "air") e.active = false;
  const spine = system.airDefense.units.find((u) => u.site.id === "spine")!;
  run(system, p, 1);
  assert.equal(spine.sees, true);
  spine.radar!.active = false;
  const events = run(system, p, 12);
  assert.equal(spine.sees, false);
  assert.equal(spine.detection, "blind");
  assert.equal(system.airDefense.commandLink(spine.launcher.id), false);
  assert.ok(!events.some((e) => e.type === "samLaunch" && system.missiles.find((m) => m.id === e.entityId)?.owner === spine.launcher.id));
});

test("batteries neither track nor fire inside Haven's umbrella", () => {
  const p = player(HAVEN.runway.x, 1500, HAVEN.runway.z - 1500);
  assert.ok(Math.hypot(p.position.x - HOME_UMBRELLA.x, p.position.z - HOME_UMBRELLA.z) < HOME_UMBRELLA.radius);
  const system = new CombatSystem();
  system.start("intercept", p);
  for (const e of system.enemies) e.releaseAt = Infinity;
  const events = run(system, p, 20);
  assert.ok(system.airDefense.units.every((u) => u.track === 0 && !u.painting));
  assert.equal(events.filter((e) => e.type === "samLaunch").length, 0);
});

test("sorties start parked: enemies hold until the jet is airborne, then come from the north", () => {
  const start = runwayThreshold(HAVEN.runway);
  const p = player(start.x, start.elevation + 2, start.z, true);
  const system = new CombatSystem();
  system.start("intercept", p);
  const bandits = system.enemies.filter((e) => e.kind === "air");
  assert.equal(bandits.length, 3);
  for (const e of bandits) assert.ok(e.position.z < -7000, "spawned at Blackridge");
  const events = run(system, p, 25);
  for (const e of bandits) {
    assert.equal(e.releaseAt, Infinity);
    assert.ok(e.position.distanceTo(e.home) < 3500, "holding station");
  }
  assert.ok(!events.some((e) => e.type === "missile" || e.type === "samLaunch"));
  p.onGround = false;
  const before = bandits[0].position.distanceTo(p.position);
  run(system, p, 20);
  assert.ok(bandits.every((e) => Number.isFinite(e.releaseAt)));
  assert.ok(bandits[0].position.distanceTo(p.position) < before - 1500, "inbound");
});

test("escort transport waits for the runway, then takes off up the corridor", () => {
  const start = runwayThreshold(HAVEN.runway);
  const p = player(start.x, start.elevation + 2, start.z, true);
  const system = new CombatSystem();
  system.start("escort", p);
  const ally = system.ally!;
  const parked = ally.position.clone();
  run(system, p, 10);
  assert.ok(ally.position.distanceTo(parked) < 1e-6);
  p.onGround = false;
  p.position.y = 800;
  run(system, p, 45);
  assert.ok(ally.position.y > start.elevation + 150, `climbing ${ally.position.y}`);
  assert.ok(ally.position.z < start.z - 2500, "heading north up the corridor");
  assert.ok(ally.active);
});

test("strike targets Blackridge's radar; destroying it informs the world and completes the sortie", () => {
  const p = player(0, 1500, -2000);
  const system = new CombatSystem();
  const destroyed: string[] = [];
  system.onTargetDestroyed = (id) => destroyed.push(id);
  system.start("strike", p);
  const radar = system.target!;
  assert.equal(radar.tag, "radar");
  assert.equal(radar.role, "target");
  // A player missile arriving at the installation.
  radar.health = 30;
  const from = radar.position.clone().add(new Vector3(0, 200, 400));
  launchMissile(
    system.missiles[0],
    MISSILES.player,
    from,
    radar.position.clone().sub(from).normalize(),
    false,
    PLAYER_ID,
    radar.id,
  );
  const events = run(system, p, 3);
  assert.deepEqual(destroyed, ["radar"]);
  assert.equal(system.completed, true);
  assert.match(system.status.result, /Radar destroyed/);
  assert.ok(events.some((e) => e.type === "explosion" && e.kind === "ground" && e.entityId === radar.id));
});

test("SAM vehicles are targetable ground entities that cannon fire destroys", () => {
  const p = player(0, 1500, -2000);
  const system = new CombatSystem();
  system.start("strike", p);
  const launcher = system.enemies.find((e) => e.role === "sam-launcher" && e.tag === "strait")!;
  // Dive at it from 600 m with the gun.
  p.position.copy(launcher.position).add(new Vector3(0, 300, 500));
  p.previous.copy(p.position);
  p.quaternion.setFromUnitVectors(
    new Vector3(0, 0, -1),
    launcher.position.clone().sub(p.position).normalize(),
  );
  for (let i = 0; i < 40 && launcher.active; i++) {
    system.step(1 / 60, p, { ...combatNeutral, gun: true }, emptyWorld);
  }
  for (let i = 0; i < 60 && launcher.active; i++)
    system.step(1 / 60, p, { ...combatNeutral, gun: true }, emptyWorld);
  assert.equal(launcher.active, false);
  const strait = system.airDefense.units.find((u) => u.site.id === "strait")!;
  run(system, p, 0.5);
  assert.equal(strait.state, "destroyed");
});
