import * as T from "three";
import type { Clouds } from "./Clouds";

/** One discharge: a tortuous channel with branches and several return strokes. */
interface Strike {
  /** Global position of the in-cloud flash (lights the cloud from inside). */
  flash: T.Vector3;
  /** Global position of the channel's top; the mesh is built relative to it. */
  anchor: T.Vector3;
  mesh?: T.Mesh;
  pulses: number[];
  age: number;
  life: number;
  power: number;
}

const BOLT_VERTEX = /* glsl */ `
attribute vec3 aOther;
attribute float aSide;
attribute float aSign;
attribute float aWidth;
attribute float aBright;
uniform float uPixel;
varying float vSide;
varying float vBright;
varying float vDistance;
void main() {
  vec4 a = modelViewMatrix * vec4(position, 1.0);
  vec4 b = modelViewMatrix * vec4(aOther, 1.0);
  vec3 dir = normalize(b.xyz - a.xyz) * aSign;
  vec3 side = normalize(cross(dir, normalize(-a.xyz)));
  float dist = length(a.xyz);
  // Never thinner than ~1.5 px, conserving the line's integrated brightness.
  float width = max(aWidth, dist * uPixel * 1.5);
  a.xyz += side * aSide * width;
  vSide = aSide;
  vBright = aBright * sqrt(aWidth / width);
  vDistance = dist;
  gl_Position = projectionMatrix * a;
}`;

const BOLT_FRAGMENT = /* glsl */ `
uniform float uIntensity;
uniform sampler2D tClouds;
uniform sampler2D tCloudDepth;
uniform vec2 uResolution;
varying float vSide;
varying float vBright;
varying float vDistance;
void main() {
  float core = exp(-vSide * vSide * 5.0);
  // Hidden by any cloud between the camera and the channel; dimmed by haze.
  vec2 uv = gl_FragCoord.xy / uResolution;
  float cloudT = texture(tClouds, uv).a;
  float cloudDepth = texture(tCloudDepth, uv).x * 1000.0;
  float visible = vDistance > cloudDepth ? cloudT : 1.0;
  float haze = exp(-vDistance / 45000.0);
  gl_FragColor = vec4(vec3(0.78, 0.84, 1.0) * uIntensity * vBright * core * visible * haze, 1.0);
}`;

/**
 * Cloud-to-ground and intra-cloud lightning for storm cells. Strikes are placed
 * under cumulonimbus cores found in the CPU weather map; each one lights its
 * cloud from inside, flashes a point light over the ground and sea, and reports
 * its distance so thunder can follow at the speed of sound.
 */
export class Lightning {
  readonly group = new T.Group();
  readonly light = new T.PointLight(0xc8d6ff, 0, 0, 2);
  /** Global flash position and strength (the brightest live strike). */
  readonly flash = new T.Vector4();
  /** Called when a strike begins: distance to the camera (m) and relative power. */
  onStrike?: (distance: number, power: number) => void;
  /** Envelope of the brightest strike this frame, 0..~1. */
  level = 0;
  /** 0 freezes strikes in place (pause, photo mode). */
  timeScale = 1;
  private strikes: Strike[] = [];
  private timer = 2;
  private material: T.ShaderMaterial;
  private scratch = new T.Vector3();
  /** Ground (or sea) height under a strike point, in metres. */
  groundHeight: (x: number, z: number) => number = () => 0;
  constructor(
    private clouds: Clouds,
    private layer: number,
  ) {
    this.material = new T.ShaderMaterial({
      vertexShader: BOLT_VERTEX,
      fragmentShader: BOLT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      // Quads are expanded toward the viewer, so their winding is arbitrary.
      side: T.DoubleSide,
      toneMapped: false,
      uniforms: {
        uIntensity: { value: 0 },
        uPixel: { value: 0.001 },
        tClouds: { value: null },
        tCloudDepth: { value: null },
        uResolution: { value: new T.Vector2(1, 1) },
      },
    });
    this.group.layers.set(layer);
    this.light.layers.enableAll();
  }
  /** Schedules the next natural strike within `seconds`. */
  soon(seconds: number) {
    this.timer = Math.min(this.timer, seconds);
  }
  /** Forces a strike near a global position (photo mode, testing). */
  strike(x: number, z: number, camera: T.Vector3) {
    this.spawn(x, z, true, camera);
  }
  update(
    dt: number,
    cameraGlobal: T.Vector3,
    origin: T.Vector3,
    camera: T.PerspectiveCamera,
    resolution: T.Vector2,
  ) {
    dt *= this.timeScale;
    const storm = this.clouds.weatherState.storm;
    if (storm > 0.2 && dt > 0) {
      this.timer -= dt;
      if (this.timer <= 0) {
        // Poisson process: a strike every few seconds somewhere in a heavy storm.
        this.timer = -Math.log(1 - Math.random()) * T.MathUtils.lerp(16, 3.2, storm);
        this.trySpawn(cameraGlobal);
      }
    }
    let best = 0;
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.age += dt;
      if (s.age > s.life) {
        if (s.mesh) {
          this.group.remove(s.mesh);
          s.mesh.geometry.dispose();
        }
        this.strikes.splice(i, 1);
        continue;
      }
      let envelope = 0;
      for (const t of s.pulses)
        if (s.age >= t) envelope = Math.max(envelope, Math.exp(-(s.age - t) / 0.045));
      // Continuing current: a faint glow between strokes.
      envelope = Math.max(envelope, 0.06 * (1 - s.age / s.life));
      const level = envelope * s.power;
      if (s.mesh) {
        s.mesh.position.copy(s.anchor).sub(origin);
        s.mesh.visible = level > 0.02;
      }
      if (level > best) {
        best = level;
        this.flash.set(s.flash.x, s.flash.y, s.flash.z, level);
      }
    }
    this.level = best;
    if (best === 0) this.flash.w = 0;
    const u = this.material.uniforms;
    u.uIntensity.value = 350 * best;
    u.uPixel.value = (2 * Math.tan(T.MathUtils.degToRad(camera.fov) / 2)) / resolution.y;
    u.uResolution.value.copy(resolution);
    // Ground and sea below the flash: a point light at the cloud base.
    this.light.position.set(this.flash.x - origin.x, 1100, this.flash.z - origin.z);
    this.light.intensity = 1.5e6 * best;
    this.clouds.lightning.intensity = best;
    this.clouds.lightning.position.set(this.flash.x, this.flash.y, this.flash.z);
  }
  /** Binds this frame's resolved cloud layer for occluding the channel. */
  bindClouds() {
    const [cloudColor, cloudDepth] = this.clouds.textures;
    this.material.uniforms.tClouds.value = cloudColor;
    this.material.uniforms.tCloudDepth.value = cloudDepth;
  }
  clear() {
    for (const s of this.strikes) if (s.mesh) {
      this.group.remove(s.mesh);
      s.mesh.geometry.dispose();
    }
    this.strikes = [];
    this.level = 0;
    this.flash.w = 0;
    this.light.intensity = 0;
    this.clouds.lightning.intensity = 0;
  }
  /** Looks for a cumulonimbus core around the camera and discharges it. */
  private trySpawn(camera: T.Vector3) {
    let bestScore = 0,
      bx = 0,
      bz = 0;
    for (let i = 0; i < 28; i++) {
      // Area-uniform out to 36 km, but not right on top of the camera.
      const r = 2500 + Math.sqrt(Math.random()) * 33500;
      const a = Math.random() * Math.PI * 2;
      const x = camera.x + Math.cos(a) * r,
        z = camera.z + Math.sin(a) * r;
      const w = this.clouds.weatherAt(x, z);
      const score = T.MathUtils.smoothstep(w.type, 0.45, 0.8) * T.MathUtils.smoothstep(w.coverage, 0.25, 0.5);
      if (score > bestScore) {
        bestScore = score;
        bx = x;
        bz = z;
      }
    }
    if (bestScore < 0.3) return;
    this.spawn(bx, bz, Math.random() < 0.55, camera);
  }
  private spawn(x: number, z: number, toGround: boolean, camera: T.Vector3) {
    const base = 1250;
    const flash = new T.Vector3(x, toGround ? base + 900 : base + 2500 + Math.random() * 3500, z);
    const strike: Strike = {
      flash,
      anchor: new T.Vector3(),
      pulses: [0],
      age: 0,
      life: 0,
      power: toGround ? 1 : 0.55,
    };
    // Two to five return strokes 40–130 ms apart.
    const strokes = toGround ? 2 + Math.floor(Math.random() * 4) : 1 + Math.floor(Math.random() * 3);
    for (let i = 1; i < strokes; i++)
      strike.pulses.push(strike.pulses[i - 1] + 0.04 + Math.random() * 0.09);
    strike.life = strike.pulses[strike.pulses.length - 1] + 0.35;
    if (toGround) {
      const top = new T.Vector3(x, base + 500 + Math.random() * 700, z);
      const gx = x + (Math.random() - 0.5) * 2200,
        gz = z + (Math.random() - 0.5) * 2200;
      const bottom = new T.Vector3(gx, Math.max(0, this.groundHeight(gx, gz)), gz);
      strike.anchor.copy(top);
      strike.mesh = this.buildBolt(top, bottom);
      this.group.add(strike.mesh);
    }
    this.strikes.push(strike);
    this.onStrike?.(this.scratch.copy(flash).setY(Math.min(flash.y, 600)).distanceTo(camera), strike.power);
  }
  /** Midpoint-displaced main channel plus downward-forking branches, as view-facing quads. */
  private buildBolt(top: T.Vector3, bottom: T.Vector3) {
    const positions: number[] = [],
      others: number[] = [],
      sides: number[] = [],
      signs: number[] = [],
      widths: number[] = [],
      brights: number[] = [];
    const indices: number[] = [];
    const addLine = (points: T.Vector3[], width: number, bright: number) => {
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i].clone().sub(top),
          b = points[i + 1].clone().sub(top);
        const taper = 1 - (i / points.length) * 0.4;
        const v = positions.length / 3;
        // Corners a+, a−, b−, b+; the far end flips its direction so both
        // ends agree on which side is which.
        for (const [p, o, s, sign] of [
          [a, b, 1, 1],
          [a, b, -1, 1],
          [b, a, -1, -1],
          [b, a, 1, -1],
        ] as const) {
          positions.push(p.x, p.y, p.z);
          others.push(o.x, o.y, o.z);
          sides.push(s);
          signs.push(sign);
          widths.push(width * taper);
          brights.push(bright);
        }
        indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
      }
    };
    const main = this.channel(top, bottom, 7, 0.16);
    addLine(main, 3.2, 1);
    const branches = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < branches; i++) {
      const at = Math.floor(main.length * (0.08 + Math.random() * 0.6));
      const start = main[at];
      const remaining = start.y - bottom.y;
      const length = remaining * (0.15 + Math.random() * 0.35);
      const angle = Math.random() * Math.PI * 2;
      const end = start
        .clone()
        .add(new T.Vector3(Math.cos(angle) * length * 0.7, -length, Math.sin(angle) * length * 0.7));
      const branch = this.channel(start, end, 5, 0.22);
      addLine(branch, 1.6, 0.35);
      if (Math.random() < 0.5) {
        const sub = branch[Math.floor(branch.length * (0.3 + Math.random() * 0.4))];
        const a2 = angle + (Math.random() - 0.5) * 1.6;
        const l2 = length * 0.4;
        addLine(
          this.channel(sub, sub.clone().add(new T.Vector3(Math.cos(a2) * l2 * 0.8, -l2, Math.sin(a2) * l2 * 0.8)), 4, 0.25),
          1.1,
          0.2,
        );
      }
    }
    const geometry = new T.BufferGeometry();
    geometry.setAttribute("position", new T.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("aOther", new T.Float32BufferAttribute(others, 3));
    geometry.setAttribute("aSide", new T.Float32BufferAttribute(sides, 1));
    geometry.setAttribute("aSign", new T.Float32BufferAttribute(signs, 1));
    geometry.setAttribute("aWidth", new T.Float32BufferAttribute(widths, 1));
    geometry.setAttribute("aBright", new T.Float32BufferAttribute(brights, 1));
    geometry.setIndex(indices);
    const mesh = new T.Mesh(geometry, this.material);
    mesh.frustumCulled = false;
    mesh.layers.set(this.layer);
    return mesh;
  }
  /** Recursive midpoint displacement between two points (2^depth segments). */
  private channel(a: T.Vector3, b: T.Vector3, depth: number, roughness: number) {
    let points = [a.clone(), b.clone()];
    let scale = a.distanceTo(b) * roughness;
    for (let level = 0; level < depth; level++) {
      const next: T.Vector3[] = [points[0]];
      for (let i = 0; i < points.length - 1; i++) {
        const p = points[i],
          q = points[i + 1];
        const mid = p.clone().add(q).multiplyScalar(0.5);
        mid.x += (Math.random() - 0.5) * scale;
        mid.z += (Math.random() - 0.5) * scale;
        mid.y += (Math.random() - 0.5) * scale * 0.35;
        next.push(mid, q);
      }
      points = next;
      scale *= 0.55;
    }
    return points;
  }
}
