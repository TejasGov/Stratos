/**
 * Deterministic trailer capture. Load in the dev build (?debug) with
 *   const { capture, SHOTS } = await import("/tools/trailer/capture.ts");
 *   await capture(window.stratos, SHOTS);
 * The game's own loop is stopped; each shot is set up, then stepped at exactly
 * 30 fps and every 1920x1080 frame is POSTed to tools/trailer/receiver.mjs.
 */
import * as T from "three";
import { FLEET } from "../../src/aircraft";
import { BLACKRIDGE_TARGETS } from "../../src/world/bases";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Game = any;
type Vec = T.Vector3;
export interface Shot {
  name: string;
  seconds: number;
  /** Frames stepped before recording (terrain streams in); the sim is frozen unless `liveRoll`. */
  preroll?: number;
  liveRoll?: boolean;
  setup(g: Game): void | Promise<void>;
  /** Per-frame scripting: keys, effects. `t` is seconds into the shot. */
  update?(g: Game, t: number): void;
  /** Global-space camera; omit to keep the game's own camera. */
  camera?(g: Game, t: number): { p: Vec; look: Vec; fov?: number } | null;
}

const FPS = 30;
const v = (x: number, y: number, z: number) => new T.Vector3(x, y, z);
const tmp = { f: new T.Vector3(), r: new T.Vector3(), u: new T.Vector3() };
/** The jet's forward / right / up axes (world). */
function axes(g: Game) {
  const q = g.flight.quaternion;
  tmp.f.set(0, 0, -1).applyQuaternion(q);
  tmp.r.set(1, 0, 0).applyQuaternion(q);
  tmp.u.set(0, 1, 0).applyQuaternion(q);
  return tmp;
}
/** Camera rig in the jet's frame: metres back (+) or ahead (-), up, and right. */
function rig(back: number, up: number, side: number, lookAhead = 120, lookUp = 0) {
  return (g: Game) => {
    const { f, r } = axes(g);
    const p = g.flight.position;
    return {
      p: p.clone().addScaledVector(f, -back).addScaledVector(r, side).add(v(0, up, 0)),
      look: p.clone().addScaledVector(f, lookAhead).add(v(0, lookUp, 0)),
    };
  };
}
/** Puts the jet in flight at a global position, heading (rad, 0 = north) and speed. */
function fly(g: Game, x: number, y: number, z: number, heading: number, speed: number, pitch = 0) {
  const f = g.flight;
  f.onGround = false;
  f.crashed = false;
  f.position.set(x, y, z);
  f.previous.copy(f.position);
  f.quaternion.setFromEuler(new T.Euler(pitch, heading, 0, "YXZ"));
  f.previousQuaternion.copy(f.quaternion);
  f.pitch = pitch;
  f.yaw = heading;
  f.roll = 0;
  f.velocity.set(0, 0, -1).applyQuaternion(f.quaternion).multiplyScalar(speed);
  f.speed = speed;
  f.throttle = 0.8;
  g.cameraReady = false;
}
const keys = (g: Game, ...codes: string[]) => {
  g.keys.clear();
  for (const c of codes) g.keys.add(c);
};
/** Fresh sortie: free flight (or a combat mission) with the intro skipped. */
function begin(g: Game, hours: number, weather = "fair", mission?: string) {
  g.start(undefined, mission);
  g.intro = 0;
  g.sky.time.hours = hours;
  if (g.sky.weather !== weather) g.sky.setWeather(weather);
  keys(g);
}
const airframes = new Map<string, T.Object3D>();
async function useAirframe(g: Game, id: string) {
  const a = FLEET.find((x) => x.id === id)!;
  let model = airframes.get(id);
  if (!model) airframes.set(id, (model = await g.loadModel(a)));
  g.applyAirframe(a, model);
}

export const SHOTS: Shot[] = [
  {
    name: "01-dawn",
    seconds: 5,
    preroll: 40,
    async setup(g) {
      await useAirframe(g, "f22");
      begin(g, 5.95);
      fly(g, -2600, 700, -400, -Math.PI / 2 + 0.3, 210);
    },
    camera: (g, t) => {
      const c = rig(110 - t * 8, 26, -70 + t * 6, 260, -30)(g);
      return { ...c, fov: 48 };
    },
  },
  {
    name: "02-soldiers",
    seconds: 4,
    preroll: 20,
    setup(g) {
      begin(g, 8.5);
      g.intro = 9.2; // the opening sequence: PT drill
    },
  },
  {
    name: "03-crew",
    seconds: 3,
    preroll: 20,
    setup(g) {
      begin(g, 8.5);
      g.intro = 3; // last shot: ground crew and the jet
    },
  },
  {
    name: "04-takeoff",
    seconds: 4,
    preroll: 30,
    setup(g) {
      begin(g, 9);
      g.flight.speed = 72;
      g.flight.throttle = 1;
      keys(g, "ShiftLeft", "Space");
    },
    update(g) {
      if (g.flight.speed > g.flight.rotateSpeed) g.keys.add("KeyW");
    },
    camera: (g) => ({ p: v(-878, 30.4, 560), look: g.flight.position.clone().add(v(0, 1.5, 0)), fov: 50 }),
  },
  {
    name: "05-valley",
    seconds: 4,
    preroll: 60,
    setup(g) {
      begin(g, 16.5);
      fly(g, 1250, 70, -3200, 0, 260);
      keys(g, "ShiftLeft");
    },
    camera: rig(34, 7, 9, 160),
  },
  {
    name: "06-clouds",
    seconds: 3,
    preroll: 60,
    setup(g) {
      begin(g, 15.5, "towering");
      fly(g, -900, 2300, -2500, 0.4, 240);
    },
    camera: rig(42, 9, -14, 200, 10),
  },
  {
    name: "07-storm",
    seconds: 3,
    preroll: 60,
    setup(g) {
      begin(g, 17.2, "storm");
      fly(g, -1200, 1300, -1800, -0.3, 230);
    },
    update(g, t) {
      if (Math.abs(t - 0.5) < 0.017 || Math.abs(t - 1.9) < 0.017) {
        const { f } = axes(g);
        const p = g.flight.position;
        g.sky.lightning.strike(p.x + f.x * 1800 + (t > 1 ? 600 : -500), p.z + f.z * 1800, g.cameraGlobal);
      }
    },
    camera: rig(36, 6, 12, 300, 40),
  },
  {
    name: "08-sam",
    seconds: 4,
    preroll: 60,
    setup(g) {
      begin(g, 16.8, "fair", "strike");
      fly(g, -700, 1100, -5600, 0, 210);
      const c = g.combat;
      c.takeoffAt = 0;
      c.grace = 0;
    },
    update(g, t) {
      const c = g.combat;
      if (Math.abs(t - 0.1) < 0.017) {
        // Fired from 1.6 km ahead and below so the climb toward the jet is in frame.
        const unit = c.airDefense.units.find((u: any) => u.site.id === "br-west");
        const { f } = axes(g);
        const from = g.flight.position.clone().addScaledVector(f, 1600).add(v(0, -550, 0));
        c.launchSam(unit, from, g.flight.position.clone().sub(from).normalize());
      }
      // Flare salvos, then a hard break.
      if ([1.3, 2.0, 2.7].some((s) => Math.abs(t - s) < 0.017)) g.keys.add("KeyV");
      else g.keys.delete("KeyV");
      if (t > 1.6) g.keys.add("KeyD");
    },
    camera: rig(46, 14, -16, 320, -140),
  },
  {
    name: "09-supersonic",
    seconds: 4,
    preroll: 60,
    setup(g) {
      begin(g, 17.6);
      fly(g, 1450, 90, -2400, 0, 333);
      keys(g, "ShiftLeft", "Space");
    },
    camera: (g, t) => {
      const c = rig(-30 + t * 18, 4, 38, 0)(g);
      return { ...c, fov: 52 };
    },
  },
  ...FLEET.map((a, i): Shot => ({
    name: `10-fleet-${i + 1}`,
    seconds: 1,
    preroll: i ? 8 : 60,
    async setup(g) {
      await useAirframe(g, a.id);
      begin(g, 17.8);
      fly(g, -600 + i * 40, 1600, -3000, 0.25 * Math.sin(i * 2.3), 220);
    },
    camera: (g, t) => {
      const angle = [0.5, 2.6, -0.6, 3.6, 1.2, -2.2, 0.2, 2.0, -1.4][i] + t * 0.25;
      const { f, r } = axes(g);
      const p = g.flight.position;
      const d = 26 + (i % 3) * 6;
      return {
        p: p.clone().addScaledVector(f, Math.cos(angle) * d).addScaledVector(r, Math.sin(angle) * d).add(v(0, [3, -4, 6][i % 3], 0)),
        look: p.clone(),
        fov: 42,
      };
    },
  })),
  {
    name: "11-cobra",
    seconds: 3,
    preroll: 40,
    async setup(g) {
      await useAirframe(g, "su30");
      begin(g, 17.4);
      fly(g, -900, 1600, -2500, 0, 150);
    },
    update(g, t) {
      if (Math.abs(t - 0.35) < 0.017) g.keys.add("KeyM");
      else g.keys.delete("KeyM");
    },
    camera: (g) => {
      const p = g.flight.position;
      const dir = g.flight.velocity.clone().setY(0).normalize();
      const side = v(-dir.z, 0, dir.x);
      return { p: p.clone().addScaledVector(side, 55).addScaledVector(dir, 6).add(v(0, 3, 0)), look: p.clone(), fov: 44 };
    },
  },
  {
    name: "12-wingmen",
    seconds: 4,
    preroll: 150,
    liveRoll: true,
    async setup(g) {
      await useAirframe(g, "f22");
      begin(g, 17.6, "fair", "war");
      fly(g, -900, 1400, -1200, 0, 200);
      g.combat.takeoffAt = 0;
    },
    camera: (g, t) => {
      const c = rig(-55 + t * 5, 7, -32, -40)(g);
      return { ...c, fov: 50 };
    },
  },
  {
    name: "13-blackridge",
    seconds: 3,
    preroll: 60,
    setup(g) {
      begin(g, 18.2);
      fly(g, 1300, 260, -8050, Math.PI / 2, 230);
      keys(g, "ShiftLeft");
    },
    update(g, t) {
      if (Math.abs(t - 1.1) < 0.017) {
        const radar = BLACKRIDGE_TARGETS.find((x) => x.id === "radar")!;
        g.combat.onTargetDestroyed?.("radar");
        g.effects.emitExplosion(v(radar.x, 75, radar.z), 5, "ground");
      }
    },
    camera: (g) => ({ p: v(900, 340, -7350), look: v(300, 75, -8080).lerp(g.flight.position, 0.2), fov: 44 }),
  },
  {
    name: "14-airkill",
    seconds: 2,
    preroll: 40,
    setup(g) {
      begin(g, 17.9, "fair", "intercept");
      fly(g, -900, 2200, -2500, 0, 230);
      const c = g.combat;
      c.takeoffAt = 0;
      c.grace = 0;
      const bandit = c.enemies.find((e: any) => e.kind === "air");
      bandit.position.copy(g.flight.position).add(v(0, 2, -260));
      bandit.previous.copy(bandit.position);
      bandit.quaternion.identity();
      bandit.velocity.set(0, 0, -180);
      bandit.releaseAt = Infinity;
      bandit.health = 12;
      keys(g, "KeyF");
    },
    camera: rig(30, 5, 6, 300),
  },
  {
    name: "15-space",
    seconds: 4,
    preroll: 80,
    setup(g) {
      begin(g, 12.5);
      fly(g, -900, 29000, -3000, 0.3, 560, 0.12);
      keys(g, "Space", "ShiftLeft");
    },
    camera: (g, t) => {
      // Looking down past the jet at the curved horizon.
      const c = rig(55 - t * 4, 14, -20, 600, -260)(g);
      return { ...c, fov: 62 };
    },
  },
];

/** Steps the game at 30 fps and posts each 1080p frame; returns frames written per shot. */
export async function capture(g: Game, shots: Shot[] = SHOTS, receiver = "http://127.0.0.1:8788", every = 1) {
  g.renderer.setAnimationLoop(null);
  g.pause = () => {};
  g.settings.dynamicResolution = false;
  g.renderer.setPixelRatio(1);
  g.renderer.setSize(1920, 1080, false);
  g.camera.aspect = 16 / 9;
  g.camera.updateProjectionMatrix();
  document.getElementById("hud")!.style.visibility = "hidden";
  let shotCamera: Shot["camera"] | undefined;
  let shotTime = 0;
  const updateCamera = g.updateCamera.bind(g);
  g.updateCamera = (dt: number) => {
    updateCamera(dt);
    const c = shotCamera?.(g, shotTime);
    if (!c) return;
    g.camera.position.copy(c.p).sub(g.world.origin);
    g.camera.up.set(0, 1, 0);
    g.camera.lookAt(c.look.clone().sub(g.world.origin));
    if (c.fov) {
      g.camera.fov = c.fov;
      g.camera.updateProjectionMatrix();
    }
  };
  let clock = (g.last || performance.now()) + 1000;
  const step = () => g.frame((clock += 1000 / FPS));
  const written: Record<string, number> = {};
  for (const shot of shots) {
    shotCamera = shot.camera;
    shotTime = 0;
    await shot.setup(g);
    for (let i = 0; i < (shot.preroll ?? 30); i++) {
      if (!shot.liveRoll) g.state = "paused";
      step();
    }
    g.state = "flight";
    const frames = Math.round(shot.seconds * FPS);
    written[shot.name] = 0;
    for (let i = 0; i < frames; i++) {
      shotTime = i / FPS;
      shot.update?.(g, shotTime);
      step();
      if (i % every) continue;
      const blob: Blob = await new Promise((r) => g.renderer.domElement.toBlob(r, "image/jpeg", 0.92));
      await fetch(`${receiver}/${shot.name}/${i}`, { method: "POST", body: blob });
      written[shot.name]++;
    }
  }
  shotCamera = undefined;
  return written;
}
