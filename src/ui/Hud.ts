import * as T from "three";

export interface HudTarget {
  position: T.Vector3;
  name: string;
  range: number;
  lock: number;
  canFire: boolean;
  health: number;
}

/** Engines, brakes and angle of attack for the systems readout. */
export interface HudSystems {
  engines: readonly { output: number; failed: boolean }[];
  /** "ENG OFF", "SPOOLING" or "". */
  status: string;
  airbrake: boolean;
  onGround: boolean;
  aoa: number;
  postStall: boolean;
  /** Short pilot hint, shown under the mode line while set. */
  hint: string;
}

export interface HudFrame {
  camera: T.PerspectiveCamera;
  plane: T.Vector3;
  quaternion: T.Quaternion;
  velocity: T.Vector3;
  speed: number;
  mach: number;
  g: number;
  altitude: number;
  agl: number;
  throttle: number;
  boost: boolean;
  systems?: HudSystems;
  time: number;
  mode: string;
  warning: string;
  threat: boolean;
  target?: HudTarget;
  lead?: T.Vector3;
  waypoint?: { position: T.Vector3; label: string; distance: number };
  /** Radar/threat warning receiver (combat only). */
  rwr?: HudRwr;
}

/** Threats around the jet; bearings are clockwise from the nose (rad). */
export interface HudRwr {
  contacts: readonly {
    bearing: number;
    range: number;
    /** 1 search, 2 track, 3 launch. */
    level: 1 | 2 | 3;
    source: "shorad" | "mrsam" | "fighter";
  }[];
  count: number;
  samLaunch: boolean;
  missile: boolean;
  missileBearing: number;
  missileRange: number;
}

const GREEN = "#a6ffc8";
const AMBER = "#ffd27a";
const RED = "#ff6a5c";
const FONT = '"B612 Mono", "SFMono-Regular", Menlo, monospace';
const DEG = Math.PI / 180;

/**
 * Conformal fighter HUD drawn on a 2D canvas over the frame: pitch ladder and
 * flight-path marker are projected from real world directions, so they stay
 * locked to the horizon in any camera.
 */
export class Hud {
  readonly canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private s = 1;
  private scale = 1;
  private v = new T.Vector3();
  private dir = new T.Vector3();
  private up = new T.Vector3(0, 1, 0);
  private right = new T.Vector3();
  private fwd = new T.Vector3();
  private announcement?: { title: string; sub: string; start: number };
  private milestones = new Set<number>();
  private lastAltitude = 0;
  constructor(parent: HTMLElement) {
    this.canvas.id = "hud-canvas";
    parent.prepend(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
  }
  setScale(scale: number) {
    this.scale = scale;
  }
  /** Big centred call-out (milestones, sonic boom). */
  announce(title: string, sub: string, time: number) {
    this.announcement = { title, sub, start: time };
  }
  reset() {
    this.milestones.clear();
    this.announcement = undefined;
  }
  private resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(innerWidth * dpr),
      h = Math.round(innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.w = w;
    this.h = h;
    this.s = (h / 1080) * this.scale;
  }
  /** Screen position (device pixels) of a world direction seen from the camera, or null behind it. */
  private projectDirection(camera: T.Camera, direction: T.Vector3, out: T.Vector2) {
    this.v.copy(direction).applyQuaternion(this.inverseCamera);
    if (this.v.z > -1e-4) return null;
    this.v.copy(camera.position).addScaledVector(direction, 10000).project(camera);
    return out.set((this.v.x * 0.5 + 0.5) * this.w, (-this.v.y * 0.5 + 0.5) * this.h);
  }
  private projectPoint(camera: T.Camera, point: T.Vector3, out: T.Vector2) {
    this.dir.copy(point).sub(camera.position);
    return this.projectDirection(camera, this.dir.normalize(), out);
  }
  private inverseCamera = new T.Quaternion();
  private a = new T.Vector2();
  private b = new T.Vector2();
  private c = new T.Vector2();
  private line(points: number[], color: string, width = 2) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < points.length; i += 2)
      i ? ctx.lineTo(points[i], points[i + 1]) : ctx.moveTo(points[i], points[i + 1]);
    ctx.lineWidth = (width + 2.2) * this.s;
    ctx.strokeStyle = "rgba(0,18,10,0.38)";
    ctx.stroke();
    ctx.lineWidth = width * this.s;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
  private text(
    value: string,
    x: number,
    y: number,
    size: number,
    color = GREEN,
    align: CanvasTextAlign = "center",
  ) {
    const ctx = this.ctx;
    ctx.font = `${Math.round(size * this.s)}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3 * this.s;
    ctx.strokeStyle = "rgba(0,18,10,0.45)";
    ctx.strokeText(value, x, y);
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  }
  draw(frame: HudFrame) {
    this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const s = this.s;
    const cam = frame.camera;
    this.inverseCamera.copy(cam.quaternion).invert();
    ctx.save();
    ctx.shadowColor = "rgba(120,255,170,0.55)";
    ctx.shadowBlur = 6 * s;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Boresight: where the nose points; the HUD is laid out around it.
    this.fwd.set(0, 0, -1).applyQuaternion(frame.quaternion);
    const bore = this.projectDirection(cam, this.fwd, this.a)?.clone() ??
      new T.Vector2(this.w / 2, this.h / 2);
    bore.x = T.MathUtils.clamp(bore.x, this.w * 0.3, this.w * 0.7);
    bore.y = T.MathUtils.clamp(bore.y, this.h * 0.3, this.h * 0.7);
    const radius = this.h * 0.3;

    // Flight path marker.
    const speed = frame.velocity.length();
    const vdir = speed > 1 ? this.dir.copy(frame.velocity).normalize().clone() : this.fwd.clone();
    const fpm = this.projectDirection(cam, vdir, this.b)?.clone();

    // Pitch ladder, clipped to the HUD glass.
    ctx.save();
    ctx.beginPath();
    ctx.arc(bore.x, bore.y, radius, 0, Math.PI * 2);
    ctx.clip();
    const fwdH = new T.Vector3(vdir.x, 0, vdir.z);
    if (fwdH.lengthSq() < 1e-6) fwdH.set(this.fwd.x, 0, this.fwd.z);
    fwdH.normalize();
    this.right.crossVectors(fwdH, this.up).normalize();
    for (let p = -85; p <= 85; p += 5) {
      const d = fwdH.clone().multiplyScalar(Math.cos(p * DEG)).addScaledVector(this.up, Math.sin(p * DEG));
      const center = this.projectDirection(cam, d, this.a);
      if (!center) continue;
      const cx = center.x,
        cy = center.y;
      const side = this.projectDirection(cam, d.clone().addScaledVector(this.right, 0.02), this.c);
      if (!side) continue;
      let ax = side.x - cx,
        ay = side.y - cy;
      const len = Math.hypot(ax, ay) || 1;
      ax /= len;
      ay /= len;
      const nx = -ay,
        ny = ax;
      const horizon = p === 0;
      const half = (horizon ? 210 : 120) * s,
        gap = (horizon ? 34 : 40) * s;
      // Tabs point toward the horizon; rungs below it are dashed.
      const tab = (p > 0 ? 1 : -1) * 12 * s;
      for (const dirSign of [-1, 1]) {
        const x0 = cx + ax * gap * dirSign,
          y0 = cy + ay * gap * dirSign,
          x1 = cx + ax * half * dirSign,
          y1 = cy + ay * half * dirSign;
        if (p < 0) ctx.setLineDash([10 * s, 7 * s]);
        if (horizon) this.line([x0, y0, x1, y1], GREEN, 2.2);
        else this.line([x0, y0, x1, y1, x1 + nx * tab, y1 + ny * tab], GREEN, 1.6);
        ctx.setLineDash([]);
        if (!horizon && p % 10 === 0)
          this.text(String(Math.abs(p)), x1 + ax * dirSign * 24 * s, y1 + ay * dirSign * 24 * s + ny * 0, 15);
      }
    }
    ctx.restore();

    // Boresight cross.
    this.line([bore.x - 16 * s, bore.y, bore.x - 6 * s, bore.y], GREEN, 2);
    this.line([bore.x + 6 * s, bore.y, bore.x + 16 * s, bore.y], GREEN, 2);
    this.line([bore.x, bore.y - 10 * s, bore.x, bore.y - 4 * s], GREEN, 2);

    if (fpm && Math.hypot(fpm.x - bore.x, fpm.y - bore.y) < radius) {
      ctx.beginPath();
      ctx.arc(fpm.x, fpm.y, 8 * s, 0, Math.PI * 2);
      ctx.lineWidth = 4.2 * s;
      ctx.strokeStyle = "rgba(0,18,10,0.38)";
      ctx.stroke();
      ctx.lineWidth = 2 * s;
      ctx.strokeStyle = GREEN;
      ctx.stroke();
      this.line([fpm.x - 22 * s, fpm.y, fpm.x - 8 * s, fpm.y], GREEN, 2);
      this.line([fpm.x + 8 * s, fpm.y, fpm.x + 22 * s, fpm.y], GREEN, 2);
      this.line([fpm.x, fpm.y - 8 * s, fpm.x, fpm.y - 18 * s], GREEN, 2);
    }

    this.drawHeading(frame);
    this.drawTapes(frame, bore);
    this.drawCombat(frame, bore, radius);
    if (frame.rwr) this.drawRwr(frame, frame.rwr, bore, radius);
    this.drawMilestones(frame);

    // Mode line and warnings.
    this.text(frame.mode, bore.x, bore.y + radius + 36 * s, 16, GREEN);
    if (frame.systems?.hint) this.text(frame.systems.hint, bore.x, bore.y + radius + 62 * s, 15, AMBER);
    if (frame.warning) {
      const blink = Math.sin(frame.time * 10) > -0.2;
      const red = frame.threat || frame.warning.startsWith("ENGINE");
      if (blink) this.text(frame.warning, this.w / 2, this.h * 0.23, 24, red ? RED : AMBER);
    }
    ctx.restore();
  }
  private drawHeading(frame: HudFrame) {
    const s = this.s;
    const yaw = Math.atan2(-this.fwd.x, -this.fwd.z);
    const heading = ((((-yaw * 180) / Math.PI) % 360) + 360) % 360;
    const cx = this.w / 2,
      y = this.h * 0.15,
      span = 50,
      width = 520 * s;
    const ppd = width / span;
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - width / 2, y - 40 * s, width, 80 * s);
    ctx.clip();
    for (let d = Math.floor((heading - span / 2) / 5) * 5; d <= heading + span / 2; d += 5) {
      const x = cx + (d - heading) * ppd;
      const major = ((d % 10) + 10) % 10 === 0;
      this.line([x, y, x, y + (major ? 14 : 8) * s], GREEN, 1.6);
      if (major) {
        const deg = ((d % 360) + 360) % 360;
        const label = deg === 0 ? "N" : deg === 90 ? "E" : deg === 180 ? "S" : deg === 270 ? "W" : String(deg / 10).padStart(2, "0");
        this.text(label, x, y - 12 * s, 15);
      }
    }
    ctx.restore();
    this.line([cx, y + 20 * s, cx - 7 * s, y + 31 * s, cx + 7 * s, y + 31 * s, cx, y + 20 * s], GREEN, 1.8);
    this.text(String(Math.round(heading) % 360).padStart(3, "0"), cx, y + 46 * s, 17);
  }
  private drawTapes(frame: HudFrame, bore: T.Vector2) {
    const s = this.s;
    const knots = frame.speed * 1.94384;
    const ax = bore.x - 330 * s,
      bx = bore.x + 330 * s,
      y = bore.y;
    const tape = (x: number, value: number, step: number, labelEvery: number, align: number, unitsPerPx: number) => {
      const ctx = this.ctx;
      const half = 150 * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 80 * s, y - half, 160 * s, half * 2);
      ctx.clip();
      const start = Math.floor((value - half * unitsPerPx) / step) * step;
      for (let v = start; v <= value + half * unitsPerPx; v += step) {
        const py = y - (v - value) / unitsPerPx;
        const major = Math.round(v / step) % (labelEvery / step) === 0;
        this.line([x, py, x + align * (major ? 14 : 7) * s, py], GREEN, 1.4);
        if (major && Math.abs(py - y) > 22 * s)
          this.text(String(Math.round(v)), x + align * 40 * s, py, 13, GREEN, "center");
      }
      ctx.restore();
    };
    tape(ax, knots, 10, 50, -1, 0.6);
    tape(bx, frame.altitude, 50, 500, 1, 6);
    // Boxed readouts.
    const box = (x: number, label: string, align: number) => {
      const w = 96 * s,
        h = 34 * s;
      const x0 = align < 0 ? x - w - 6 * s : x + 6 * s;
      this.line([x0, y - h / 2, x0 + w, y - h / 2, x0 + w, y + h / 2, x0, y + h / 2, x0, y - h / 2], GREEN, 1.8);
      this.text(label, x0 + w / 2, y, 21);
    };
    box(ax, String(Math.round(knots)), -1);
    box(bx, Math.round(frame.altitude).toLocaleString("en-US"), 1);
    this.text(`M ${frame.mach.toFixed(2)}`, ax - 54 * s, y + 46 * s, 17);
    this.text(`G ${frame.g.toFixed(1)}`, ax - 54 * s, y + 70 * s, 17, frame.g > 7 ? AMBER : GREEN);
    this.text(`${Math.round(frame.throttle * 100)}%${frame.boost ? " AB" : ""}`, ax - 54 * s, y + 94 * s, 15, frame.boost ? AMBER : GREEN);
    if (frame.systems) this.drawSystems(frame.systems, ax - 54 * s, y + 120 * s);
    this.text("KT", ax - 54 * s, y - 42 * s, 13);
    this.text("M ASL", bx + 54 * s, y - 42 * s, 13);
    if (frame.agl < 1500) this.text(`R ${Math.max(0, Math.round(frame.agl))}`, bx + 54 * s, y + 46 * s, 17, frame.agl < 120 ? AMBER : GREEN);
  }
  /** Engine spool bars (red when failed), engine/brake state and post-stall AoA under the throttle. */
  private drawSystems(sys: HudSystems, x: number, y: number) {
    const s = this.s;
    const n = sys.engines.length;
    const w = 26 * s,
      h = 9 * s,
      gap = 8 * s;
    const ctx = this.ctx;
    for (let i = 0; i < n; i++) {
      const e = sys.engines[i];
      const x0 = x - (n * w + (n - 1) * gap) / 2 + i * (w + gap);
      const color = e.failed ? RED : sys.status ? AMBER : GREEN;
      this.line([x0, y - h / 2, x0 + w, y - h / 2, x0 + w, y + h / 2, x0, y + h / 2, x0, y - h / 2], color, 1.4);
      ctx.fillStyle = color;
      if (e.failed) {
        this.line([x0, y - h / 2, x0 + w, y + h / 2], RED, 1.4);
        this.line([x0, y + h / 2, x0 + w, y - h / 2], RED, 1.4);
      } else ctx.fillRect(x0 + 2 * s, y - h / 2 + 2 * s, Math.max(0, (w - 4 * s) * Math.min(1, e.output)), h - 4 * s);
    }
    const label = n === 2 ? ["L", "R"] : ["ENG"];
    for (let i = 0; i < n; i++) {
      const x0 = x - (n * w + (n - 1) * gap) / 2 + i * (w + gap);
      this.text(sys.engines[i].failed ? "FIRE" : label[i], x0 + w / 2, y + 16 * s, 11, sys.engines[i].failed ? RED : GREEN);
    }
    let line = y + 38 * s;
    if (sys.status) {
      this.text(sys.status, x, line, 14, AMBER);
      line += 22 * s;
    }
    if (sys.airbrake) {
      this.text(sys.onGround ? "BRAKES" : "SPD BRK", x, line, 14, AMBER);
      line += 22 * s;
    }
    const aoa = (sys.aoa * 180) / Math.PI;
    if (aoa > 12 && !sys.onGround) this.text(`α ${Math.round(aoa)}°`, x, line, 17, sys.postStall ? AMBER : GREEN);
  }
  private drawCombat(frame: HudFrame, bore: T.Vector2, radius: number) {
    const s = this.s;
    const cam = frame.camera;
    if (frame.waypoint) {
      const p = this.projectPoint(cam, frame.waypoint.position, this.a);
      if (p) {
        const d = 12 * s;
        this.line([p.x, p.y - d, p.x + d, p.y, p.x, p.y + d, p.x - d, p.y, p.x, p.y - d], GREEN, 2);
        this.text(`${frame.waypoint.label} ${(frame.waypoint.distance / 1000).toFixed(1)}`, p.x, p.y + 26 * s, 13);
      }
    }
    const target = frame.target;
    if (!target) return;
    const color = target.canFire ? RED : AMBER;
    const p = this.projectPoint(cam, target.position, this.a);
    const onScreen = p && p.x > 0 && p.x < this.w && p.y > 0 && p.y < this.h;
    if (p && onScreen) {
      const half = 15 * s;
      this.line([p.x - half, p.y - half, p.x + half, p.y - half, p.x + half, p.y + half, p.x - half, p.y + half, p.x - half, p.y - half], color, 2);
      this.text(target.name, p.x, p.y - half - 14 * s, 13, color);
      this.text(`${(target.range / 1000).toFixed(1)} KM`, p.x, p.y + half + 14 * s, 13, color);
      // Seeker ring tightens onto the box as the lock builds.
      if (target.lock > 0.01) {
        const r = T.MathUtils.lerp(70, 22, target.lock) * s;
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, target.lock));
        ctx.lineWidth = 2 * s;
        ctx.strokeStyle = color;
        ctx.stroke();
        if (target.canFire && Math.sin(frame.time * 14) > 0) this.text("LOCK", p.x, p.y + half + 34 * s, 15, RED);
      }
    } else {
      // Off-screen cue: an arrow on the HUD circle pointing toward the target.
      this.dir.copy(target.position).sub(cam.position).applyQuaternion(this.inverseCamera);
      const angle = Math.atan2(-this.dir.y, this.dir.x);
      const x = bore.x + Math.cos(angle) * radius * 0.92,
        y = bore.y + Math.sin(angle) * radius * 0.92;
      const tip = 16 * s,
        back = 10 * s;
      const ca = Math.cos(angle),
        sa = Math.sin(angle);
      this.line([x - ca * back - sa * back, y - sa * back + ca * back, x + ca * tip, y + sa * tip, x - ca * back + sa * back, y - sa * back - ca * back], color, 2.2);
      this.text(`${(target.range / 1000).toFixed(1)}`, x - ca * 30 * s, y - sa * 30 * s, 13, color);
    }
    if (frame.lead) {
      const q = this.projectPoint(cam, frame.lead, this.b);
      if (q && Math.hypot(q.x - bore.x, q.y - bore.y) < radius) {
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 11 * s, 0, Math.PI * 2);
        ctx.lineWidth = 1.8 * s;
        ctx.strokeStyle = GREEN;
        ctx.stroke();
        ctx.fillStyle = GREEN;
        ctx.fillRect(q.x - 1.5 * s, q.y - 1.5 * s, 3 * s, 3 * s);
      }
    }
  }
  /**
   * Warning-receiver scope beside the speed tape: search emitters on the outer
   * ring, trackers in the middle, launches inside; the nearest inbound missile
   * is also cued on the HUD circle.
   */
  private drawRwr(frame: HudFrame, rwr: HudRwr, bore: T.Vector2, radius: number) {
    const s = this.s;
    const ctx = this.ctx;
    const r = 66 * s;
    const cx = bore.x - radius - 120 * s,
      cy = bore.y + radius * 0.62;
    const blink = Math.sin(frame.time * 14) > -0.3;
    ctx.save();
    ctx.globalAlpha = 0.85;
    for (const ring of [1, 0.55]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * ring, 0, Math.PI * 2);
      ctx.lineWidth = (ring === 1 ? 1.6 : 1) * s;
      ctx.strokeStyle = "rgba(166,255,200,0.55)";
      ctx.stroke();
    }
    // Nose tick and own-ship cross.
    this.line([cx, cy - r - 6 * s, cx, cy - r + 4 * s], GREEN, 1.6);
    this.line([cx - 5 * s, cy, cx + 5 * s, cy], GREEN, 1.2);
    this.line([cx, cy - 5 * s, cx, cy + 5 * s], GREEN, 1.2);
    ctx.restore();
    let level = 0;
    for (let i = 0; i < rwr.count; i++) {
      const c = rwr.contacts[i];
      level = Math.max(level, c.level);
      const rr = r * (c.level === 1 ? 0.84 : c.level === 2 ? 0.6 : 0.34);
      const x = cx + Math.sin(c.bearing) * rr,
        y = cy - Math.cos(c.bearing) * rr;
      const color = c.level === 1 ? GREEN : c.level === 2 ? AMBER : RED;
      if (c.level === 3 && !blink) continue;
      this.text(c.source === "mrsam" ? "M" : c.source === "shorad" ? "S" : "F", x, y, c.level === 1 ? 13 : 16, color);
      if (c.level >= 2) {
        ctx.beginPath();
        if (c.level === 3) ctx.arc(x, y, 11 * s, 0, Math.PI * 2);
        else {
          ctx.moveTo(x, y - 12 * s);
          ctx.lineTo(x + 11 * s, y + 8 * s);
          ctx.lineTo(x - 11 * s, y + 8 * s);
          ctx.closePath();
        }
        ctx.lineWidth = 1.6 * s;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    }
    if (rwr.missile) {
      // Arrowhead on the scope rim pointing in at the jet, with range in km.
      const b = rwr.missileBearing;
      const sx = Math.sin(b),
        cy2 = -Math.cos(b);
      const tipX = cx + sx * (r - 2 * s),
        tipY = cy + cy2 * (r - 2 * s);
      const baseX = cx + sx * (r + 14 * s),
        baseY = cy + cy2 * (r + 14 * s);
      const px = -cy2 * 7 * s,
        py = sx * 7 * s;
      this.line([baseX + px, baseY + py, tipX, tipY, baseX - px, baseY - py], RED, 2.4);
      this.text((rwr.missileRange / 1000).toFixed(1), cx + sx * (r + 30 * s), cy + cy2 * (r + 30 * s), 13, RED);
      // Same cue on the HUD circle, where the eyes are.
      const hx = bore.x + sx * radius * 0.97,
        hy = bore.y + cy2 * radius * 0.97;
      if (blink) {
        this.line([hx - sx * 18 * s + px, hy - cy2 * 18 * s + py, hx, hy, hx - sx * 18 * s - px, hy - cy2 * 18 * s - py], RED, 2.6);
        this.text("MSL", hx - sx * 34 * s, hy - cy2 * 34 * s, 13, RED);
      }
    }
    const alert = rwr.samLaunch
      ? "SAM LAUNCH"
      : rwr.missile
        ? "MISSILE"
        : level >= 2
          ? "TRACK"
          : level === 1
            ? "SEARCH"
            : "RWR";
    const urgent = rwr.samLaunch || rwr.missile;
    if (!urgent || blink)
      this.text(alert, cx, cy - r - 22 * s, urgent ? 18 : 13, urgent ? RED : level >= 2 ? AMBER : GREEN);
  }
  private drawMilestones(frame: HudFrame) {
    for (const [altitude, title, sub] of [
      [11000, "TROPOPAUSE", "11 000 M · THE WEATHER IS BELOW YOU"],
      [20000, "STRATOSPHERE", "20 000 M · THE SKY TURNS DARK"],
      [30000, "EDGE OF SPACE", "30 000 M · THE CURVE OF THE WORLD"],
    ] as const) {
      if (this.lastAltitude < altitude && frame.altitude >= altitude && !this.milestones.has(altitude)) {
        this.milestones.add(altitude);
        this.announce(title, sub, frame.time);
      }
    }
    this.lastAltitude = frame.altitude;
    const a = this.announcement;
    if (!a) return;
    const t = frame.time - a.start;
    if (t > 4.5) {
      this.announcement = undefined;
      return;
    }
    const alpha = Math.min(1, t * 3) * Math.min(1, (4.5 - t) * 1.5);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    const spacing = 0.35 + Math.min(1, t * 0.6) * 0.05;
    ctx.letterSpacing = `${Math.round(18 * spacing * this.s)}px`;
    this.text(a.title, this.w / 2, this.h * 0.36, 54, GREEN);
    ctx.letterSpacing = `${Math.round(4 * this.s)}px`;
    this.text(a.sub, this.w / 2, this.h * 0.36 + 52 * this.s, 16, GREEN);
    ctx.restore();
  }
}
