import test from "node:test";
import assert from "node:assert/strict";
import { Euler, Vector3 } from "three";
import { Flight, neutral, runwayAt, sweptCollision } from "../src/flight.ts";
import { FLEET, airframe, type Airframe } from "../src/aircraft.ts";
import { BLACKRIDGE, HAVEN, runwayThreshold } from "../src/world/bases.ts";

const DEG = Math.PI / 180;
const step = 1 / 60;
function jet(id: string, overrides: Partial<Airframe> = {}) {
  const f = new Flight();
  f.configure({ ...airframe(id), ...overrides });
  return f;
}
/** Level flight at `speed`, settled for half a second. */
function cruising(f: Flight, speed: number, throttle = 0.63) {
  f.reset();
  f.position.y = 3000;
  f.previous.copy(f.position);
  f.speed = speed;
  f.velocity.set(0, 0, -speed);
  f.throttle = throttle;
  for (let i = 0; i < 30; i++) f.step(step, { ...neutral, throttleTarget: throttle });
}

test("a runway start is parked on the threshold with engines at idle", () => {
  const f = jet("sf35");
  f.gearHeight = 1.9;
  f.resetOnRunway(HAVEN.runway);
  const t = runwayThreshold(HAVEN.runway);
  assert.equal(f.onGround, true);
  assert.equal(f.speed, 0);
  assert.equal(f.throttle, 0.08);
  assert.ok(Math.abs(f.position.x - t.x) < 1e-9 && Math.abs(f.position.z - t.z) < 1e-9);
  assert.ok(Math.abs(f.position.y - (HAVEN.runway.elevation + 1.9)) < 1e-9);
  assert.ok(f.engines.every((e) => !e.failed && Math.abs(e.output - 0.08) < 1e-9));
  // Idle thrust does not creep, brakes or not; the jet stays put.
  for (let i = 0; i < 120; i++) f.step(step, neutral);
  assert.equal(f.speed, 0);
  assert.equal(f.crashed, false);
  assert.equal(f.onGround, true);
});

test("takeoff roll reaches Vr, the nose only rotates from Vr, and the jet lifts off", () => {
  for (const { id } of FLEET) {
    const f = jet(id);
    f.resetOnRunway(HAVEN.runway);
    const start = f.position.clone();
    const vr = f.rotateSpeed;
    assert.ok(vr >= 74 && vr <= 86);
    let time = 0,
      liftoff = -1;
    while (time < 40 && !f.crashed) {
      // Pilot holds full back stick from brake release.
      f.step(step, { ...neutral, throttle: 1, pitch: 1 });
      time += step;
      if (f.onGround && f.speed < 0.85 * vr) assert.equal(f.pitch, 0, `${id} rotated early`);
      if (!f.onGround && liftoff < 0) {
        liftoff = time;
        assert.ok(f.speed >= 0.95 * vr && f.speed < vr * 1.3, `${id} lifted off at ${f.speed}`);
        assert.ok(start.distanceTo(f.position) < HAVEN.runway.length - 200);
      }
      if (liftoff > 0 && time > liftoff + 4) break;
    }
    assert.ok(liftoff > 4 && liftoff < 20, `${id} liftoff at ${liftoff}s`);
    assert.equal(f.crashed, false);
    assert.equal(f.onGround, false);
    assert.ok(f.position.y > HAVEN.runway.elevation + 20);
  }
});

test("without rotation the jet stays glued to the runway; wheel brakes stop it", () => {
  const f = jet("su57");
  f.resetOnRunway(HAVEN.runway);
  for (let i = 0; i < 60 * 10; i++) f.step(step, { ...neutral, throttle: 1 });
  assert.equal(f.onGround, true);
  assert.ok(f.speed > 40, `${f.speed}`);
  assert.ok(Math.abs(f.position.y - (HAVEN.runway.elevation + f.gearHeight)) < 1e-9);
  let time = 0;
  while (f.speed > 0 && time < 30) {
    f.step(step, { ...neutral, throttle: -1, airbrake: true });
    time += step;
  }
  assert.equal(f.speed, 0);
  assert.ok(time < 15);
  assert.equal(f.crashed, false);
});

/** Airbrake and a hard pull at 160 m/s, the pull held for `hold` s, then hands off until normal flight resumes. */
function cobra(id: string, hold: number, mode: Flight["controlMode"]) {
  const f = jet(id);
  f.controlMode = mode;
  cruising(f, 160, 0.3);
  const y0 = f.position.y,
    v0 = f.speed;
  f.step(step, { ...neutral, airbrake: true, pitch: 1 });
  assert.equal(f.cobraActive, true, id);
  let peak = 0,
    time = 0;
  while (f.cobraActive && time < 10) {
    f.step(step, { ...neutral, pitch: time < hold ? 1 : 0 });
    time += step;
    peak = Math.max(peak, f.cobraAlpha);
    if (f.aoa > 34 * DEG) assert.equal(f.postStall, true);
  }
  const result = { peak: peak / DEG, dAlt: f.position.y - y0, bleed: 1 - f.speed / v0, time, active: f.cobraActive };
  // Normal flight resumes on the flight path.
  for (let i = 0; i < 60; i++) f.step(step, neutral);
  assert.equal(f.crashed, false, id);
  assert.equal(f.postStall, false, id);
  return result;
}

test("airbrake + hard pull: a cobra, a 360° kulbit with thrust vectoring, a shallow pitch-up without", () => {
  for (const mode of ["assisted", "advanced"] as const) {
    // A one-second pull: the classic cobra, nose past the vertical and back.
    const tap = cobra("su57", 1, mode);
    assert.ok(tap.peak > 80 && tap.peak < 130, `cobra peak ${tap.peak}`);
    assert.ok(Math.abs(tap.dAlt) < 50, `cobra altitude change ${tap.dAlt}`);
    assert.ok(tap.bleed > 0.3 && tap.bleed < 0.6, `cobra bleed ${tap.bleed}`);
    assert.ok(tap.time < 3.5, `cobra duration ${tap.time}`);
    // Held: vectored nozzles keep the nose turning past 180° and stability carries it round.
    for (const id of ["su57", "f22", "su30"]) {
      const kulbit = cobra(id, 10, mode);
      assert.equal(kulbit.active, false, `${id} kulbit ends`);
      assert.ok(kulbit.peak > 340, `${id} kulbit ${kulbit.peak}`);
      assert.ok(kulbit.time < 5, `${id} kulbit duration ${kulbit.time}`);
      assert.ok(kulbit.dAlt > -100, `${id} kulbit altitude change ${kulbit.dAlt}`);
    }
    // Without vectoring the tail runs out of authority well short of a loop.
    const rafale = cobra("rafale", 3, mode);
    assert.ok(rafale.peak > 40 && rafale.peak < 80, `rafale peak ${rafale.peak}`);
    const mig21 = cobra("mig21", 1.5, mode);
    assert.ok(mig21.peak > 15 && mig21.peak < 40, `mig21 peak ${mig21.peak}`);
  }
});

test("the cobra needs the airbrake and the pull together", () => {
  const f = jet("su57");
  cruising(f, 160);
  for (let i = 0; i < 30; i++) f.step(step, { ...neutral, airbrake: true });
  assert.equal(f.cobraActive, false);
  cruising(f, 160);
  for (let i = 0; i < 30; i++) f.step(step, { ...neutral, pitch: 1 });
  assert.equal(f.cobraActive, false);
  f.step(step, { ...neutral, pitch: 1, airbrake: true });
  assert.equal(f.cobraActive, true);
});

test("the cobra is refused outside its speed window with a pilot hint", () => {
  const f = jet("su57");
  cruising(f, 260);
  assert.equal(f.startCobra(), false);
  assert.match(f.hint, /TOO FAST/);
  cruising(f, 80);
  assert.equal(f.startCobra(), false);
  assert.match(f.hint, /TOO SLOW/);
  f.resetOnRunway(HAVEN.runway);
  assert.equal(f.startCobra(), false);
});

test("angle of attack is tracked in normal flight", () => {
  const f = jet("sf35");
  f.controlMode = "advanced";
  cruising(f, 200);
  assert.ok(f.aoa < 3 * DEG);
  for (let i = 0; i < 60; i++) f.step(step, { ...neutral, pitch: 1 });
  assert.ok(f.aoa > 5 * DEG && f.aoa < 34 * DEG);
  assert.equal(f.postStall, false);
});

test("losing one engine of a twin halves thrust and yaws toward the dead side", () => {
  const f = jet("su57");
  f.controlMode = "advanced";
  cruising(f, 200, 1);
  for (let i = 0; i < 120; i++) f.step(step, { ...neutral, throttle: 1 });
  const healthy = f.thrust;
  const yaw = f.yaw;
  assert.equal(f.damageEngine(0), 1);
  f.step(step, { ...neutral, throttle: 1 });
  assert.ok(Math.abs(f.thrust / healthy - 0.5) < 0.02, `ratio ${f.thrust / healthy}`);
  assert.equal(f.engines[0].output, 0);
  assert.ok(f.engineFire(0) > 0.5 && f.engineFire(1) === 0);
  // Left engine dead: the live right engine swings the nose left (+yaw).
  for (let i = 0; i < 120; i++) f.step(step, { ...neutral, throttle: 1 });
  assert.ok(f.yaw - yaw > 0.05);
  // No afterburner from the dead side.
  f.step(step, { ...neutral, throttle: 1, boost: true });
  assert.deepEqual(f.afterburners, [false, true]);
  assert.equal(f.damageEngine(), 0);
  f.step(step, neutral);
  assert.equal(f.thrust, 0);
  f.reset();
  assert.ok(f.engines.every((e) => !e.failed));
});

test("a single-engine jet glides after its engine fails", () => {
  const f = jet("sf35");
  cruising(f, 200);
  assert.equal(f.damageEngine(), 0);
  f.step(step, neutral);
  assert.equal(f.thrust, 0);
});

test("differential thrust gives a healthy twin faster rudder yaw", () => {
  const yawIn = (engines: 1 | 2) => {
    const f = jet("su57", { engines });
    f.controlMode = "advanced";
    cruising(f, 200);
    const start = f.yaw;
    for (let i = 0; i < 60; i++) f.step(step, { ...neutral, yaw: 1 });
    if (engines === 2) assert.ok(f.engines[0].output < f.engines[1].output);
    return f.yaw - start;
  };
  const ratio = yawIn(2) / yawIn(1);
  assert.ok(ratio > 1.25 && ratio < 1.45, `ratio ${ratio}`);
});

test("engine master switch spools down to nothing and relights over about three seconds", () => {
  const f = jet("su57");
  cruising(f, 200);
  const running = f.thrust;
  f.step(step, { ...neutral, engineToggle: true });
  assert.equal(f.engineStatus, "ENG OFF");
  for (let i = 0; i < 300; i++) f.step(step, { ...neutral, boost: true });
  assert.ok(f.thrust < running * 0.05);
  assert.equal(f.boost, false);
  f.step(step, { ...neutral, engineToggle: true });
  assert.equal(f.engineStatus, "SPOOLING");
  for (let i = 0; i < 60; i++) f.step(step, neutral);
  const early = f.thrust;
  for (let i = 0; i < 150; i++) f.step(step, neutral);
  assert.equal(f.engineStatus, "");
  assert.ok(early < f.thrust * 0.5);
});

const touchdowns: number[] = [];
function approach(sink: number, roll = 0, pitch = 4 * DEG) {
  const f = jet("sf35");
  f.reset();
  f.onTouchdown = (s) => touchdowns.push(s);
  const r = HAVEN.runway;
  f.position.set(r.x, r.elevation + f.gearHeight + 0.3, r.z + 200);
  f.previous.copy(f.position);
  f.speed = 75;
  f.velocity.set(0, -sink, -75);
  f.quaternion.setFromEuler(new Euler(pitch, 0, roll, "YXZ"));
  for (let i = 0; i < 30 && !f.onGround && !f.crashed; i++) {
    f.velocity.y = -sink;
    f.step(step, neutral);
  }
  return f;
}

test("gentle touchdowns roll out on the runway; hard or banked ones crash", () => {
  const f = approach(2);
  assert.equal(f.crashed, false);
  assert.equal(f.onGround, true);
  assert.equal(touchdowns.length, 1);
  assert.ok(touchdowns[0] > 1.9 && touchdowns[0] < 2.5);
  let time = 0;
  while (f.speed > 0 && time < 40) {
    f.step(step, { ...neutral, airbrake: true, throttle: -1 });
    time += step;
  }
  assert.equal(f.speed, 0);
  assert.equal(f.crashed, false);
  // The rollout never bounces back into the air.
  assert.equal(touchdowns.length, 1);
  assert.equal(f.onGround, true);
  assert.equal(approach(8).crashed, true);
  assert.equal(approach(2, 30 * DEG).crashed, true);
  assert.equal(approach(2, 0, -8 * DEG).crashed, true);
});

test("the runway surface is not a collision; terrain elsewhere still is", () => {
  for (const { runway: r } of [HAVEN, BLACKRIDGE]) {
    const t = runwayThreshold(r);
    const wheels = new Vector3(t.x, r.elevation + 1.8, t.z);
    assert.ok(runwayAt(t.x, t.z));
    assert.equal(sweptCollision(wheels, wheels.clone().setY(r.elevation + 2.5)), false);
    // Through the pavement is still a crash.
    assert.equal(sweptCollision(wheels, wheels.clone().setY(r.elevation - 1)), true);
  }
  // Same height over the hills beside Haven's runway: terrain impact.
  assert.equal(sweptCollision(new Vector3(-600, 31, 0), new Vector3(-600, 31, -50)), true);
});

test("afterburner builds speed over seconds, not a catapult, and keeps the sea-level top speed", () => {
  const f = jet("sf35");
  f.reset();
  f.position.y = 1500;
  f.previous.copy(f.position);
  f.speed = 105;
  f.velocity.set(0, 0, -105);
  f.throttle = 1;
  let reached = -1;
  for (let i = 1; i <= 60 * 90; i++) {
    f.step(step, { ...neutral, throttle: 1, boost: true });
    if (reached < 0 && f.speed >= 300) reached = i * step;
  }
  assert.ok(reached > 4, `105→300 m/s in ${reached.toFixed(1)} s`);
  // Low down, dynamic pressure keeps even a Mach-2 jet near Mach 1.1-1.4.
  assert.ok(f.mach > 1 && f.mach < 1.45, `top speed Mach ${f.mach.toFixed(2)}`);
});

test("a simulated pilot lands every jet on Haven in both control modes and stops on the runway", () => {
  const E = HAVEN.runway.elevation;
  for (const mode of ["assisted", "advanced"] as const)
    for (const a of FLEET) {
      const f = jet(a.id);
      f.controlMode = mode;
      f.gearHeight = 2;
      f.reset();
      // Lined up on runway 36 above the hills south of Haven, 2 km out, gear speed.
      f.position.set(HAVEN.runway.x, E + f.gearHeight + 125, 2000);
      f.previous.copy(f.position);
      f.velocity.set(0, 0, -90);
      f.speed = 90;
      f.throttle = 0.35;
      let sink = -1;
      f.onTouchdown = (s) => (sink = s);
      for (let t = 0; t < 60 && !f.onGround && !f.crashed; t += step) {
        const height = f.position.y - f.gearHeight - E;
        // Steep over the ridge, then a shallow 2° final at idle: the flight path follows
        // the nose, so a nose-up flare would climb away rather than cushion the landing.
        const final = height < 25;
        const target = (final ? -2 : -5.5) * DEG;
        f.step(step, {
          ...neutral,
          pitch: Math.max(-1, Math.min(1, (target - f.pitch) * 4)),
          throttle: final || f.speed > 88 ? -1 : f.speed < 78 ? 1 : 0,
          airbrake: !final && f.speed > 95,
        });
      }
      assert.ok(f.onGround && !f.crashed, `${a.id} ${mode}: touchdown failed (sink ${sink.toFixed(1)})`);
      for (let t = 0; t < 60 && f.speed > 0; t += step) f.step(step, { ...neutral, airbrake: true, throttle: -1 });
      assert.equal(f.speed, 0, `${a.id} ${mode} did not stop`);
      assert.ok(f.position.z > HAVEN.runway.z - HAVEN.runway.length / 2, `${a.id} ${mode} overran the runway`);
    }
});

test("each jet tops out at its published Mach number at 12 km", () => {
  for (const a of FLEET) {
    const f = jet(a.id);
    f.reset();
    f.position.set(0, 12000, 0);
    f.previous.copy(f.position);
    // Start near the limit (speed of sound at 12 km is about 295 m/s) so the test stays quick.
    f.speed = 0.9 * a.maxMach * 295;
    f.velocity.set(0, 0, -f.speed);
    f.throttle = 1;
    for (let i = 0; i < 60 * 150; i++) {
      f.step(step, { ...neutral, throttle: 1, boost: true });
      f.position.set(0, 12000, -1e4);
    }
    assert.ok(Math.abs(f.mach - a.maxMach) < 0.08, `${a.id}: Mach ${f.mach.toFixed(2)} vs ${a.maxMach}`);
  }
});
