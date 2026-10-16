import { Flight, neutral } from "../src/flight.ts";
import { FLEET } from "../src/aircraft.ts";
import { HAVEN } from "../src/world/bases.ts";
import { heightAt } from "../src/world/terrain.ts";

const DEG = 180 / Math.PI;
for (const a of FLEET) {
  const f = new Flight();
  f.configure(a);
  f.resetOnRunway(HAVEN.runway);
  let t = 0, vrT = -1, liftT = -1, roll0 = f.position.clone();
  const boost = process.argv.includes("ab");
  if (process.argv.includes("adv")) f.controlMode = "advanced";
  let minClear = 1e9;
  while (t < 40 && !f.crashed) {
    if (!f.onGround) minClear = Math.min(minClear, f.position.y - Math.max(0, heightAt(f.position.x, f.position.z)));
    const pull = f.speed >= f.rotateSpeed ? 1 : 0;
    f.step(1 / 60, { ...neutral, throttle: 1, boost, pitch: f.onGround ? pull : 0 });
    t += 1 / 60;
    if (vrT < 0 && f.speed >= f.rotateSpeed) vrT = t;
    if (liftT < 0 && !f.onGround) { liftT = t; console.log(`${a.id} Vr ${f.rotateSpeed.toFixed(0)} at ${vrT.toFixed(1)}s, liftoff ${t.toFixed(1)}s v=${f.speed.toFixed(0)} roll ${roll0.distanceTo(f.position).toFixed(0)}m`); }
    if (liftT > 0 && t > liftT + 10) break;
  }
  console.log(`  +10s: crashed=${f.crashed} z=${f.position.z.toFixed(0)} minClear=${minClear.toFixed(0)} alt=${(f.position.y - 29).toFixed(0)} v=${f.speed.toFixed(0)} pitch=${(f.pitch * DEG).toFixed(1)}`);
}
for (const a of FLEET) {
  for (const throttle of [0.08, 0.63]) {
    const f = new Flight();
    f.configure(a);
    f.reset();
    f.position.y = 3000;
    f.speed = 160;
    f.velocity.set(0, 0, -160);
    f.throttle = throttle;
    for (const e of f.engines) e.output = throttle;
    for (let i = 0; i < 30; i++) f.step(1 / 60, { ...neutral, throttleTarget: throttle });
    const y0 = f.position.y, v0 = f.speed;
    f.step(1 / 60, { ...neutral, cobra: true, throttleTarget: throttle });
    let peak = 0, t = 0, maxRate = 0, lastAoa = f.aoa;
    while (f.cobraActive && t < 6) {
      f.step(1 / 60, { ...neutral, throttleTarget: throttle });
      t += 1 / 60;
      peak = Math.max(peak, f.aoa);
      maxRate = Math.max(maxRate, Math.abs(f.aoa - lastAoa) * 60);
      lastAoa = f.aoa;
    }
    console.log(`${a.id} thr ${throttle} sm ${a.supermanoeuvre}: peak ${(peak * DEG).toFixed(0)}° rate ${(maxRate * DEG).toFixed(0)}°/s t ${t.toFixed(2)}s dAlt ${(f.position.y - y0).toFixed(0)} speed ${v0.toFixed(0)}→${f.speed.toFixed(0)} (${((1 - f.speed / v0) * 100).toFixed(0)}%) hint ${f.hint}`);
  }
}
