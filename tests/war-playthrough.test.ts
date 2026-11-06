import test from "node:test";
import assert from "node:assert/strict";
import { Vector3 } from "three";
import { Flight, type Controls } from "../src/flight.ts";
import { CombatSystem, WAR_WAYPOINTS, combatNeutral, type CombatInput } from "../src/combat/CombatSystem.ts";
import { airframe } from "../src/aircraft.ts";
import { HAVEN } from "../src/world/bases.ts";
import { renderedHeightAt } from "../src/world/terrain.ts";

const ground = (x: number, z: number) => Math.max(0, renderedHeightAt(x, z));
const query = { groundHeight: ground, blocked: () => false };

/**
 * Flies the whole War the way a reasonable human would with the Easy-mode
 * assists: target-follow steering, a missile when the lock tone is solid, the
 * cannon when the pipper is on, flares a beat after the missile warning, a
 * low run through the valley markers and guided bombs on Blackridge.
 */
function flyWar(id: string, reaction: number) {
  const a = airframe(id);
  const f = new Flight();
  f.controlMode = "assisted";
  f.configure(a);
  f.resetOnRunway(HAVEN.runway);
  const c = new CombatSystem();
  c.rcs = a.rcs;
  c.start("war", f);
  const dt = 1 / 60;
  const dir = new Vector3(),
    lead = new Vector3(),
    nose = new Vector3();
  let t = 0,
    threatSince = -1,
    lastFlare = -10,
    wingKills = 0;
  while (t < 900 && !c.completed && !c.failed) {
    const ctl: Controls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, boost: false, throttleTarget: 0.95 };
    const input: CombatInput = { ...combatNeutral };
    const p = f.position;
    const target = c.target;
    if (f.onGround) {
      ctl.throttle = 1;
      ctl.throttleTarget = 1;
      ctl.boost = true;
      if (f.speed > f.rotateSpeed) ctl.pitch = 1;
    } else {
      if (c.warPhase === 1) {
        const wp = WAR_WAYPOINTS[c.waypoint];
        dir.set(wp.x, ground(wp.x, wp.z) + 220, wp.z);
      } else if (target?.kind === "air") {
        if (!c.getAimDirection(f, dir, query, 0.35)) dir.copy(target.position).addScaledVector(target.velocity, 1);
        if (p.y < ground(p.x, p.z) + 250) dir.y = Math.max(dir.y, p.y + 300);
        lead.copy(target.position).sub(p).normalize();
        nose.set(0, 0, -1).applyQuaternion(f.quaternion);
        input.gun = target.position.distanceTo(p) < 1500 && nose.dot(lead) > 0.98;
      } else if (target) {
        dir.copy(target.position).setY(ground(target.position.x, target.position.z) + 600);
        input.bomb = Math.hypot(target.position.x - p.x, target.position.z - p.z) < 2200 && t % 1.2 < dt;
      } else dir.set(p.x, p.y, p.z - 1000);
      dir.sub(p).normalize();
      // Terrain warning: pull up enough to clear what lies ahead on the flight path.
      let urgent = false;
      for (let k = 1; k <= 8; k++) {
        const s = k * 0.5,
          x = p.x + f.velocity.x * s,
          z = p.z + f.velocity.z * s,
          floor = ground(x, z) + (c.warPhase === 1 ? 90 : 160);
        if (p.y + f.velocity.y * s < floor) {
          const climb = (floor - p.y) / (Math.hypot(f.velocity.x, f.velocity.z) * s + 1);
          dir.set(f.velocity.x, 0, f.velocity.z).normalize().setY(Math.max(0.15, climb)).normalize();
          urgent = k <= 3;
          break;
        }
      }
      // Watch the speed tape: no hanging the jet on its tail.
      const maxClimb = urgent ? 0.7 : Math.sin(Math.min(0.6, Math.max(0.1, (f.speed - 80) / 250)));
      if (dir.y > maxClimb) {
        const h = Math.hypot(dir.x, dir.z) || 1,
          k = Math.sqrt(1 - maxClimb ** 2) / h;
        dir.set(dir.x * k, maxClimb, dir.z * k);
      }
      ctl.aimDirection = dir;
      ctl.boost = f.speed < 200;
      input.missile = c.status.canFire;
      if (c.status.threat) threatSince = threatSince < 0 ? t : threatSince;
      else threatSince = -1;
      if (threatSince >= 0 && t - threatSince >= reaction && t - lastFlare > 1.6) {
        input.flare = true;
        lastFlare = t;
      }
    }
    const before = c.kills;
    const playerShots = c.missiles.filter((m) => m.active && m.owner === 0).length;
    f.step(dt, ctl);
    c.step(dt, f, input, query);
    // A bandit that dies with no player missile expiring and no bomb or cannon of ours near is Viper flight's.
    if (c.kills > before && c.warPhase !== 2 && c.missiles.filter((m) => m.active && m.owner === 0).length === playerShots && !input.gun)
      wingKills += c.kills - before;
    t += dt;
  }
  return { c, wingKills };
}

for (const id of ["sf35", "su30"]) {
  test(`war: a human-paced pilot can win it in the ${id}, with Viper flight pulling its weight`, () => {
    const { c, wingKills } = flyWar(id, 1);
    assert.equal(c.failed, false, c.status.result);
    assert.equal(c.completed, true, `still at phase ${c.warPhase} after ${c.elapsed.toFixed(0)} s`);
    assert.match(c.status.result, /Blackridge destroyed/);
    assert.ok(wingKills >= 1, "Viper flight scores at least one kill");
  });
}
