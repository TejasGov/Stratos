import * as T from "three";
import {
  DistanceSampler,
  ParticlePool,
  localPosition,
  type Particle,
  type Point3,
} from "./particle-core";

export type EffectsQuality = "low" | "medium" | "high";
const LIMITS = {
  low: [160, 100],
  medium: [480, 240],
  high: [900, 420],
} as const;
const WIND = { x: 2.4, y: 0, z: 0.7 },
  STILL = { x: 0, y: 0, z: 0 };
const TILE = 32,
  CELLS = 4,
  FRAMES = CELLS * CELLS;

/** Small deterministic, padded flipbook. No DOM, network requests or asset license needed. */
function makeAtlas(flame: boolean) {
  const width = TILE * CELLS,
    data = new Uint8Array(width * width * 4);
  for (let frame = 0; frame < FRAMES; frame++) {
    const evolution = frame / (FRAMES - 1);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const u = ((x + 0.5) / TILE) * 2 - 1,
          v = ((y + 0.5) / TILE) * 2 - 1;
        const angle = Math.atan2(v, u);
        const radius = Math.hypot(u, v);
        const distortion =
          0.055 * Math.sin(angle * 5 + evolution * 6) +
          0.035 * Math.sin(u * 17 + v * 11 + evolution * 9);
        const density = Math.max(0, 1 - radius / (0.79 + distortion));
        const noise =
          0.8 + 0.2 * Math.sin(u * 14 + Math.sin(v * 9) + evolution * 7);
        const alpha = Math.pow(density, flame ? 1.6 : 1.25) * noise;
        const offset =
          ((Math.floor(frame / CELLS) * TILE + y) * width +
            (frame % CELLS) * TILE +
            x) *
          4;
        const intensity = flame
          ? Math.min(1, 0.62 + density * 0.38)
          : 0.68 + density * 0.32;
        data[offset] = data[offset + 1] = data[offset + 2] = intensity * 255;
        data[offset + 3] = alpha * 255;
      }
  }
  const texture = new T.DataTexture(data, width, width, T.RGBAFormat);
  texture.magFilter = texture.minFilter = T.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

class ParticleBatch {
  readonly pool: ParticlePool;
  readonly geometry: T.InstancedBufferGeometry;
  readonly material: T.ShaderMaterial;
  readonly mesh: T.Mesh;
  private readonly order: number[] = [];
  private readonly depths: Float64Array;
  private readonly center: T.InstancedBufferAttribute;
  private readonly params: T.InstancedBufferAttribute;
  private readonly color: T.InstancedBufferAttribute;
  private readonly axis: T.InstancedBufferAttribute;
  private readonly local = new T.Vector3();
  constructor(capacity: number, additive: boolean) {
    this.pool = new ParticlePool(capacity);
    this.depths = new Float64Array(capacity);
    this.geometry = new T.InstancedBufferGeometry();
    const quad = new T.PlaneGeometry(1, 1);
    this.geometry.index = quad.index!.clone();
    this.geometry.setAttribute("position", quad.attributes.position.clone());
    this.geometry.setAttribute("uv", quad.attributes.uv.clone());
    quad.dispose();
    this.center = new T.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    this.params = new T.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    );
    this.color = new T.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    );
    this.axis = new T.InstancedBufferAttribute(
      new Float32Array(capacity * 4),
      4,
    );
    for (const attribute of [this.center, this.params, this.color, this.axis])
      attribute.setUsage(T.DynamicDrawUsage);
    this.geometry.setAttribute("center", this.center);
    this.geometry.setAttribute("params", this.params);
    this.geometry.setAttribute("tint", this.color);
    this.geometry.setAttribute("axis", this.axis);
    this.geometry.instanceCount = 0;
    this.material = new T.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: additive ? T.AdditiveBlending : T.NormalBlending,
      fog: true,
      uniforms: {
        atlas: { value: makeAtlas(additive) },
        sceneDepth: { value: null },
        useSoftDepth: { value: false },
        softRange: { value: 6 },
        clipRange: { value: new T.Vector2(1, 22000) },
        viewport: { value: new T.Vector2(1, 1) },
        ...T.UniformsLib.fog,
      },
      vertexShader: `
        attribute vec3 center; attribute vec4 params; attribute vec4 tint; attribute vec4 axis;
        varying vec2 vUv; varying vec4 vTint; varying float vFrame; varying float vDistance;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(center, 1.0);
          vec2 offset = position.xy * params.x;
          float rotation = params.w;
          vec3 viewAxis = mat3(viewMatrix) * axis.xyz;
          if (axis.w > 1.01 && length(viewAxis.xy) > 0.01) rotation = atan(viewAxis.y, viewAxis.x);
          offset.x *= axis.w;
          offset = mat2(cos(rotation), sin(rotation), -sin(rotation), cos(rotation)) * offset;
          mvPosition.xy += offset;
          gl_Position = projectionMatrix * mvPosition;
          vUv = uv; vTint = vec4(tint.rgb, tint.a * params.y); vFrame = params.z;
          vDistance = -mvPosition.z;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D atlas; uniform sampler2D sceneDepth; uniform bool useSoftDepth;
        uniform vec2 clipRange; uniform vec2 viewport; uniform float softRange;
        varying vec2 vUv; varying vec4 vTint; varying float vFrame; varying float vDistance;
        #include <packing>
        #include <fog_pars_fragment>
        vec4 sampleFrame(float frame) {
          vec2 cell = vec2(mod(frame, 4.0), floor(frame / 4.0));
          // Sample inside the padded cell, avoiding atlas-neighbor bleeding.
          return texture2D(atlas, (cell + mix(vec2(0.015625), vec2(0.984375), vUv)) / 4.0);
        }
        void main() {
          float frame = clamp(vFrame, 0.0, 15.0);
          vec4 texel = mix(sampleFrame(floor(frame)), sampleFrame(min(15.0, floor(frame) + 1.0)), fract(frame));
          float fade = smoothstep(1.5, 6.0, vDistance);
          if (useSoftDepth) {
            float depth = texture2D(sceneDepth, gl_FragCoord.xy / viewport).x;
            float distanceToSurface = -perspectiveDepthToViewZ(depth, clipRange.x, clipRange.y);
            fade *= clamp((distanceToSurface - vDistance) / softRange, 0.0, 1.0);
          }
          gl_FragColor = vec4(texel.rgb * vTint.rgb, texel.a * vTint.a * fade);
          if (gl_FragColor.a < 0.003) discard;
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = new T.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false; // Individual global particles are culled in upload().
    this.mesh.renderOrder = additive ? 5 : 4;
  }
  upload(camera: T.Camera, origin: Point3, limit: number) {
    this.order.length = 0;
    const view = camera.matrixWorldInverse.elements;
    for (let i = 0; i < this.pool.capacity; i++) {
      const p = this.pool.particles[i];
      if (!p.active) continue;
      localPosition(p, origin, this.local);
      const depth = -(
        view[2] * this.local.x +
        view[6] * this.local.y +
        view[10] * this.local.z +
        view[14]
      );
      if (depth < -p.size || depth > 18000) continue;
      this.depths[i] = depth;
      this.order.push(i);
    }
    // Select the closest effects under quality pressure, then sort alpha back-to-front.
    this.order.sort((a, b) => this.depths[a] - this.depths[b]);
    this.order.length = Math.min(limit, this.order.length);
    this.order.reverse();
    for (let index = 0; index < this.order.length; index++) {
      const p = this.pool.particles[this.order[index]],
        progress = p.age / p.life;
      localPosition(p, origin, this.local);
      this.center.setXYZ(index, this.local.x, this.local.y, this.local.z);
      const fade = Math.min(1, progress * 9) * Math.pow(1 - progress, 1.2);
      this.params.setXYZW(
        index,
        p.size + p.growth * p.age,
        fade,
        progress * 15,
        p.rotation,
      );
      this.color.setXYZW(index, p.r, p.g, p.b, p.opacity);
      this.axis.setXYZW(index, p.dx, p.dy, p.dz, p.stretch);
    }
    this.geometry.instanceCount = this.order.length;
    for (const attribute of [this.center, this.params, this.color, this.axis])
      attribute.needsUpdate = true;
  }
  dispose() {
    this.geometry.dispose();
    (this.material.uniforms.atlas.value as T.Texture).dispose();
    this.material.dispose();
  }
}

/** World positions are authoritative doubles. Conversion to origin-relative floats occurs only at upload. */
export class Effects {
  readonly group = new T.Group();
  private smoke = new ParticleBatch(900, false);
  private flame = new ParticleBatch(420, true);
  private quality: EffectsQuality = "medium";
  private jetSampler = new DistanceSampler(5, 16);
  private missiles = new Map<string | number, DistanceSampler>();
  private damage = new Map<
    string | number,
    { sampler: DistanceSampler; time: number }
  >();
  private nozzle = new T.Vector3();
  private direction = new T.Vector3();
  private local = new T.Vector3();
  private jetTime = 0;
  private seed = 7297;
  private disposed = false;
  constructor(scene?: T.Scene, quality: EffectsQuality = "medium") {
    this.quality = quality;
    this.group.name = "combat-effects";
    this.group.add(this.smoke.mesh, this.flame.mesh);
    scene?.add(this.group);
  }
  private random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  private spawn(
    pool: ParticlePool,
    position: Point3,
    life: number,
    size: number,
    growth: number,
    opacity: number,
    r: number,
    g: number,
    b: number,
  ): Particle | undefined {
    const p = pool.acquire();
    if (!p) return;
    p.x = position.x;
    p.y = position.y;
    p.z = position.z;
    p.life = life;
    p.size = size;
    p.growth = growth;
    p.opacity = opacity;
    p.r = r;
    p.g = g;
    p.b = b;
    p.rotation = this.random() * Math.PI * 2;
    p.vx = p.vy = p.vz = 0;
    p.dx = p.dy = p.dz = 0;
    p.stretch = 1;
    return p;
  }
  setQuality(quality: EffectsQuality) {
    this.quality = quality;
  }
  get stats() {
    return {
      smoke: this.smoke.pool.count,
      flame: this.flame.pool.count,
      rendered:
        this.smoke.geometry.instanceCount + this.flame.geometry.instanceCount,
    };
  }
  emitExplosion(position: Point3, scale = 1) {
    scale = T.MathUtils.clamp(scale, 0.2, 8);
    const density =
      this.quality === "low" ? 0.5 : this.quality === "high" ? 1.3 : 1;
    for (let i = 0; i < Math.ceil(14 * density); i++) {
      const p = this.spawn(
        this.smoke.pool,
        position,
        5 + this.random() * 5,
        (7 + this.random() * 7) * scale,
        4 * scale,
        0.8,
        0.23,
        0.25,
        0.27,
      );
      if (p) {
        p.vx = (this.random() - 0.5) * 13 * scale;
        p.vy = this.random() * 9 * scale;
        p.vz = (this.random() - 0.5) * 13 * scale;
      }
    }
    for (let i = 0; i < Math.ceil(9 * density); i++) {
      const p = this.spawn(
        this.flame.pool,
        position,
        0.45 + this.random() * 0.8,
        (8 + this.random() * 10) * scale,
        10 * scale,
        1,
        5.2,
        1.7,
        0.25,
      );
      if (p) {
        p.vx = (this.random() - 0.5) * 22 * scale;
        p.vy = this.random() * 14 * scale;
        p.vz = (this.random() - 0.5) * 22 * scale;
      }
    }
    for (let i = 0; i < Math.ceil(18 * density); i++) {
      const p = this.spawn(
        this.flame.pool,
        position,
        0.4 + this.random(),
        0.25 * scale,
        0.12,
        0.95,
        5,
        2.8,
        0.5,
      );
      if (p) {
        p.vx = (this.random() - 0.5) * 70 * scale;
        p.vy = this.random() * 40 * scale;
        p.vz = (this.random() - 0.5) * 70 * scale;
        p.stretch = 4;
        p.dx = p.vx;
        p.dy = p.vy;
        p.dz = p.vz;
      }
    }
  }
  /** Call once per simulation step for each damaged entity; stopEmitter(id) on removal. */
  emitDamageSmoke(
    id: string | number,
    position: Point3,
    dt: number,
    severity = 1,
  ) {
    if (!(dt > 0)) return;
    let emitter = this.damage.get(id);
    if (!emitter) {
      if (this.damage.size >= 32) return;
      emitter = { sampler: new DistanceSampler(5, 12), time: 0 };
      this.damage.set(id, emitter);
    }
    severity = T.MathUtils.clamp(severity, 0.1, 1);
    const emit = (point: Point3) => {
      const p = this.spawn(
        this.smoke.pool,
        point,
        4 + this.random() * 3,
        2.5 + severity * 3,
        2,
        severity * 0.7,
        0.2,
        0.22,
        0.24,
      );
      if (p) p.vy = 1 + this.random() * 2;
    };
    const count = emitter.sampler.emit(position, emit);
    emitter.time += dt;
    if (emitter.time >= 0.12) {
      if (!count) emit(position);
      emitter.time %= 0.12;
    }
  }
  /** Aircraft faces local -Z; nozzle offset +8m matches the current jet normalization. */
  updateJet(
    position: Point3,
    quaternion: T.Quaternion,
    boost: boolean,
    dt: number,
    contrails = position.y > 2200,
  ) {
    if (!(dt > 0)) return;
    this.nozzle.set(0, 0.1, 8).applyQuaternion(quaternion);
    this.nozzle.x += position.x;
    this.nozzle.y += position.y;
    this.nozzle.z += position.z;
    this.direction.set(0, 0, 1).applyQuaternion(quaternion);
    this.jetTime += dt;
    if (this.jetTime >= 1 / 30) {
      const p = this.spawn(
        this.flame.pool,
        this.nozzle,
        boost ? 0.16 : 0.1,
        boost ? 1.4 : 0.9,
        0.8,
        0.8,
        boost ? 2.8 : 1.4,
        boost ? 1 : 0.8,
        boost ? 0.35 : 2,
      );
      if (p) {
        p.vx = this.direction.x * 15;
        p.vy = this.direction.y * 15;
        p.vz = this.direction.z * 15;
        p.stretch = boost ? 4.5 : 2.5;
        p.dx = this.direction.x;
        p.dy = this.direction.y;
        p.dz = this.direction.z;
      }
      this.jetTime %= 1 / 30;
    }
    if (contrails)
      this.jetSampler.emit(position, (point) => {
        for (const side of [-1, 1]) {
          this.local.set(side * 4.2, 0, 1).applyQuaternion(quaternion);
          this.local.x += point.x;
          this.local.y += point.y;
          this.local.z += point.z;
          const p = this.spawn(
            this.smoke.pool,
            this.local,
            4.5,
            0.8,
            0.5,
            0.26,
            0.72,
            0.78,
            0.83,
          );
          if (p) {
            p.stretch = 6;
            p.dx = this.direction.x;
            p.dy = this.direction.y;
            p.dz = this.direction.z;
          }
        }
      });
    else this.jetSampler.reset();
  }
  updateMissile(id: string | number, position: Point3, dt: number) {
    if (!(dt > 0)) return;
    let sampler = this.missiles.get(id);
    if (!sampler) {
      if (this.missiles.size >= 64) return;
      sampler = new DistanceSampler(3, 24);
      this.missiles.set(id, sampler);
    }
    sampler.emit(position, (point) => {
      this.spawn(this.smoke.pool, point, 3, 1.1, 0.45, 0.45, 0.72, 0.75, 0.77);
    });
  }
  stopEmitter(id: string | number) {
    this.missiles.delete(id);
    this.damage.delete(id);
  }
  /** dt=0 rebases and uploads without aging effects (pause-safe). Update camera matrix first. */
  update(dt: number, camera: T.Camera, origin: Point3) {
    if (this.disposed) return;
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
    this.smoke.pool.step(step, WIND, 1.4);
    this.flame.pool.step(step, STILL, -2);
    const limits = LIMITS[this.quality];
    this.smoke.upload(camera, origin, limits[0]);
    this.flame.upload(camera, origin, limits[1]);
  }
  /** Optional ordinary perspective WebGL depth hook; caller renders opaque depth first.
   * Unsupported with logarithmic/reversed depth. Size is draw framebuffer pixels, not CSS pixels. */
  setSoftDepth(
    texture: T.DepthTexture | null,
    camera: T.PerspectiveCamera,
    width: number,
    height: number,
    fadeMeters = 6,
  ) {
    for (const batch of [this.smoke, this.flame]) {
      const u = batch.material.uniforms;
      u.sceneDepth.value = texture;
      u.useSoftDepth.value = texture !== null;
      u.clipRange.value.set(camera.near, camera.far);
      u.viewport.value.set(width, height);
      u.softRange.value = Math.max(0.01, fadeMeters);
    }
  }
  clear() {
    this.smoke.pool.clear();
    this.flame.pool.clear();
    this.smoke.geometry.instanceCount = this.flame.geometry.instanceCount = 0;
    this.jetSampler.reset();
    this.jetTime = 0;
    this.missiles.clear();
    this.damage.clear();
    this.seed = 7297;
  }
  reset() {
    this.clear();
  }
  dispose() {
    if (this.disposed) return;
    this.clear();
    this.group.removeFromParent();
    this.smoke.dispose();
    this.flame.dispose();
    this.disposed = true;
  }
}
