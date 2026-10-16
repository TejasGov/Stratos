import * as T from "three";
import { TRANSPARENT_LAYER } from "../sky/SkyEngine";

/** Shared lighting for translucent vapour (sun phase + sky ambient), premultiplied output. */
const VAPOUR_LIGHT = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
/** Normalised forward-scattering phase (sr⁻¹) plus a small isotropic floor. */
float vapourPhase(vec3 viewDir) {
  float c = dot(viewDir, uSunDir);
  float g = 0.6, g2 = g * g;
  return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-3), 1.5)) * 1.3 + 0.07;
}
float vHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vHash(i), vHash(i + vec2(1, 0)), f.x), mix(vHash(i + vec2(0, 1)), vHash(i + 1.0), f.x), f.y);
}
`;

function vapourMaterial(fragment: string, uniforms: Record<string, T.IUniform>) {
  return new T.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: T.DoubleSide,
    blending: T.CustomBlending,
    blendSrc: T.OneFactor,
    blendDst: T.OneMinusSrcAlphaFactor,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewW = normalize(world.xyz - cameraPosition);
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: VAPOUR_LIGHT + fragment,
  });
}

/** Ring buffer of world points rendered as a camera-facing, ageing ribbon. */
class Ribbon {
  readonly mesh: T.Mesh;
  private points: Float64Array;
  private times: Float32Array;
  private strengths: Float32Array;
  private head = 0;
  private count = 0;
  private lastX = NaN;
  private lastY = 0;
  private lastZ = 0;
  private positions: Float32Array;
  private tangents: Float32Array;
  private ages: Float32Array;
  private geometry = new T.BufferGeometry();
  constructor(
    private capacity: number,
    private spacing: number,
    readonly life: number,
    material: T.ShaderMaterial,
  ) {
    this.points = new Float64Array(capacity * 3);
    this.times = new Float32Array(capacity);
    this.strengths = new Float32Array(capacity);
    this.positions = new Float32Array(capacity * 2 * 3);
    this.tangents = new Float32Array(capacity * 2 * 3);
    this.ages = new Float32Array(capacity * 2 * 2);
    const sides = new Float32Array(capacity * 2);
    for (let i = 0; i < capacity; i++) {
      sides[i * 2] = -1;
      sides[i * 2 + 1] = 1;
    }
    const index: number[] = [];
    for (let i = 0; i < capacity - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry.setIndex(index);
    this.geometry.setAttribute(
      "position",
      new T.BufferAttribute(this.positions, 3).setUsage(T.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "aTangent",
      new T.BufferAttribute(this.tangents, 3).setUsage(T.DynamicDrawUsage),
    );
    this.geometry.setAttribute(
      "aAge",
      new T.BufferAttribute(this.ages, 2).setUsage(T.DynamicDrawUsage),
    );
    this.geometry.setAttribute("aSide", new T.BufferAttribute(sides, 1));
    this.geometry.setDrawRange(0, 0);
    this.mesh = new T.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(TRANSPARENT_LAYER);
  }
  /** Adds a point when the emitter has moved far enough; `strength` 0 breaks the trail. */
  emit(x: number, y: number, z: number, time: number, strength: number) {
    if (strength <= 0.01) {
      this.lastX = NaN;
      return;
    }
    if (
      Number.isFinite(this.lastX) &&
      Math.hypot(x - this.lastX, y - this.lastY, z - this.lastZ) < this.spacing
    )
      return;
    const gap = !Number.isFinite(this.lastX);
    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
    const i = this.head;
    this.points[i * 3] = x;
    this.points[i * 3 + 1] = y;
    this.points[i * 3 + 2] = z;
    // Negative time marks the first point after a gap (no segment joins it).
    this.times[i] = gap ? -time - 1 : time;
    this.strengths[i] = strength;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  /** Rebuilds origin-relative vertices, newest first; the live head is the emitter itself. */
  upload(
    origin: T.Vector3,
    now: number,
    headX: number,
    headY: number,
    headZ: number,
    headStrength: number,
  ) {
    const live = headStrength > 0.01;
    let written = 0;
    let px = headX,
      py = headY,
      pz = headZ;
    const write = (x: number, y: number, z: number, age: number, strength: number) => {
      const tx = px - x,
        ty = py - y,
        tz = pz - z;
      for (let s = 0; s < 2; s++) {
        const v = written * 2 + s;
        this.positions[v * 3] = x - origin.x;
        this.positions[v * 3 + 1] = y - origin.y;
        this.positions[v * 3 + 2] = z - origin.z;
        this.tangents[v * 3] = tx;
        this.tangents[v * 3 + 1] = ty;
        this.tangents[v * 3 + 2] = tz;
        this.ages[v * 2] = age;
        this.ages[v * 2 + 1] = strength;
      }
      written++;
      px = x;
      py = y;
      pz = z;
    };
    if (live && this.count > 0) write(headX, headY, headZ, 0, headStrength);
    for (let k = 0; k < this.count && written < this.capacity; k++) {
      const i = (this.head - 1 - k + this.capacity) % this.capacity;
      const stamp = this.times[i];
      const age = now - (stamp < 0 ? -stamp - 1 : stamp);
      if (age > this.life) break;
      write(this.points[i * 3], this.points[i * 3 + 1], this.points[i * 3 + 2], age, this.strengths[i]);
      if (stamp < 0) {
        // The segment beyond a gap must not connect: end this strip here.
        break;
      }
    }
    if (written > 0) {
      // First segment's tangent: reuse the second vertex's direction.
      for (let s = 0; s < 2; s++) {
        this.tangents[s * 3] = this.tangents[6 + s * 3] || 0;
        this.tangents[s * 3 + 1] = this.tangents[6 + s * 3 + 1] || 0;
        this.tangents[s * 3 + 2] = this.tangents[6 + s * 3 + 2] || 1;
      }
    }
    this.geometry.setDrawRange(0, Math.max(0, written - 1) * 6);
    for (const name of ["position", "aTangent", "aAge"])
      (this.geometry.getAttribute(name) as T.BufferAttribute).needsUpdate = true;
  }
  clear() {
    this.count = 0;
    this.head = 0;
    this.lastX = NaN;
    this.geometry.setDrawRange(0, 0);
  }
  dispose() {
    this.geometry.dispose();
  }
}

function ribbonMaterial(
  width: number,
  growth: number,
  life: number,
  opacity: number,
  lighting: Record<string, T.IUniform>,
) {
  return new T.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: T.CustomBlending,
    blendSrc: T.OneFactor,
    blendDst: T.OneMinusSrcAlphaFactor,
    uniforms: {
      ...lighting,
      uWidth: { value: width },
      uGrowth: { value: growth },
      uLife: { value: life },
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aTangent;
      attribute vec2 aAge;
      attribute float aSide;
      uniform float uWidth, uGrowth;
      varying float vSide;
      varying float vAge;
      varying float vStrength;
      varying vec3 vView;
      void main() {
        vStrength = aAge.y;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vec3 view = normalize(world.xyz - cameraPosition);
        vec3 t = normalize(aTangent + vec3(0.0, 1e-5, 0.0));
        vec3 side = normalize(cross(t, view) + vec3(1e-6));
        float w = uWidth + uGrowth * sqrt(aAge.x);
        world.xyz += side * aSide * w * 0.5;
        vSide = aSide;
        vAge = aAge.x;
        vView = view;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader:
      VAPOUR_LIGHT +
      /* glsl */ `
      uniform float uLife, uOpacity;
      varying float vSide;
      varying float vAge;
      varying float vStrength;
      varying vec3 vView;
      void main() {
        float t = clamp(vAge / uLife, 0.0, 1.0);
        float edge = 1.0 - smoothstep(0.35, 1.0, abs(vSide));
        float a = uOpacity * vStrength * edge * pow(1.0 - t, 1.6) * smoothstep(0.0, 0.25, vAge);
        if (a < 0.002) discard;
        vec3 light = uSunColor * vapourPhase(vView) + uAmbient;
        gl_FragColor = vec4(light * a * 0.9, a);
      }`,
  });
}

interface Boom {
  mesh: T.Mesh;
  age: number;
  global: T.Vector3;
}

/**
 * Transonic and high-performance spectacle around the player's jet: vapour
 * cone, afterburner shock diamonds, sonic-boom shock collar, stratospheric
 * contrails and high-G wingtip vortices.
 */
export class Supersonic {
  readonly group = new T.Group();
  private lighting: Record<string, T.IUniform> = {
    uSunDir: { value: new T.Vector3(0, 1, 0) },
    uSunColor: { value: new T.Color() },
    uAmbient: { value: new T.Color() },
  };
  private cone: T.Mesh<T.LatheGeometry, T.ShaderMaterial>;
  private plumeMaterial: T.ShaderMaterial;
  private coreMaterial: T.ShaderMaterial;
  private plumeGeometry: T.CylinderGeometry;
  private coreGeometry: T.CylinderGeometry;
  /** One outer plume and hot core per engine nozzle. */
  private engines: { plume: T.Mesh; core: T.Mesh; nozzle: T.Vector3 }[] = [];
  private contrailMaterial: T.ShaderMaterial;
  private contrails: Ribbon[] = [];
  private tips: Ribbon[];
  /** Airframe geometry in the aircraft's local frame (metres, +Z aft). */
  private nozzleRadius = 0.6;
  private tipPosition = new T.Vector3(5.3, 0.05, 3.6);
  private size = 1;
  private booms: Boom[] = [];
  private boomGeometry = new T.SphereGeometry(1, 48, 24);
  private boomMaterial: T.ShaderMaterial;
  private wasSupersonic = false;
  private onset = 0;
  private time = 0;
  private local = new T.Vector3();
  private nozzle = new T.Vector3();
  /** Fired once each time the jet goes supersonic (for audio, shake and post FX). */
  onBoom?: (position: T.Vector3) => void;
  constructor(
    scene: T.Scene,
    private plane: T.Object3D,
  ) {
    // Bell-shaped condensation shell: feathery front at the canopy, crisp aft shock edge.
    const profile = [
      [0.6, -5.2],
      [2.2, -3.8],
      [3.8, -2.3],
      [5.0, -0.8],
      [5.9, 0.6],
      [6.5, 1.7],
      [6.8, 2.4],
    ].map(([r, y]) => new T.Vector2(r, y));
    const lathe = new T.LatheGeometry(profile, 64);
    lathe.rotateX(Math.PI / 2);
    this.cone = new T.Mesh(
      lathe,
      vapourMaterial(
        /* glsl */ `
        uniform float uIntensity, uTime;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          float around = vUv.x, along = vUv.y;
          // Streaks flow aft; gaps between them keep the shell wispy and see-through.
          float streak = vNoise(vec2(around * 34.0, along * 2.2 - uTime * 7.0));
          float fine = vNoise(vec2(around * 110.0 + streak * 4.0, along * 10.0 - uTime * 13.0));
          float wisps = smoothstep(0.35, 0.85, streak * 0.7 + fine * 0.45);
          float front = smoothstep(0.05, 0.75, along);
          float rear = 1.0 - smoothstep(0.92, 1.0, along);
          float facing = abs(dot(normalize(vNormalW), vViewW));
          float thickness = mix(1.0, 0.18, facing);
          float a = uIntensity * front * rear * thickness * wisps * 0.62;
          a = clamp(a, 0.0, 0.6);
          if (a < 0.003) discard;
          vec3 light = uSunColor * vapourPhase(vViewW) * 2.2 + uAmbient;
          gl_FragColor = vec4(light * a, a);
        }`,
        { ...this.lighting, uIntensity: { value: 0 }, uTime: { value: 0 } },
      ),
    );
    this.cone.layers.set(TRANSPARENT_LAYER);
    this.cone.frustumCulled = false;
    this.cone.visible = false;
    plane.add(this.cone);

    // Afterburner: an outer plume with shock diamonds and a hot inner core.
    const plumeMaterial = (core: boolean) =>
      new T.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
        side: T.DoubleSide,
        uniforms: {
          uBoost: { value: 0 },
          uThrottle: { value: 0.6 },
          uTime: { value: 0 },
          uLength: { value: 8 },
          uMach: { value: 1.3 },
          uExposureHint: { value: 1 },
        },
        vertexShader: /* glsl */ `
          varying float vX;
          varying float vFacing;
          varying float vAround;
          void main() {
            vX = position.z + 0.5;
            vec4 world = modelMatrix * vec4(position, 1.0);
            vec3 n = normalize(mat3(modelMatrix) * normal);
            vFacing = abs(dot(n, normalize(cameraPosition - world.xyz)));
            vAround = atan(position.x, position.y);
            gl_Position = projectionMatrix * viewMatrix * world;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uBoost, uThrottle, uTime, uLength, uMach;
          varying float vX;
          varying float vFacing;
          varying float vAround;
          float h1(float p) { return fract(sin(p * 127.1) * 43758.5453); }
          void main() {
            float x = vX * uLength / 1.1;               // distance from nozzle in diameters
            float spacing = 1.306 * sqrt(max(uMach * uMach - 1.0, 0.25));
            float cells = pow(0.5 + 0.5 * cos(6.2831 * (x - 0.67) / spacing), 6.0);
            float envelope = exp(-x / (3.2 * spacing)) * smoothstep(0.0, 0.25, x);
            float body = pow(vFacing, ${core ? "3.0" : "1.6"});
            float flicker = 0.82 + 0.18 * h1(floor(uTime * 40.0) + vAround * 3.0);
            vec3 hot = mix(vec3(0.45, 0.6, 1.0), vec3(1.0, 0.62, 0.28), smoothstep(0.0, 2.5, x));
            vec3 e = hot * ((0.25 + ${core ? "1.5" : "3.2"} * cells * uBoost) * envelope * body * flicker);
            float tail = 1.0 - smoothstep(0.75, 1.0, vX);
            float strength = mix(0.12 * uThrottle, 1.0, uBoost) * ${core ? "5.0" : "2.6"};
            gl_FragColor = vec4(e * tail * strength, 1.0);
          }`,
      });
    const cylinder = (top: number, bottom: number) => {
      const g = new T.CylinderGeometry(top, bottom, 1, 28, 24, true);
      // Axis along +Z (aft); y=+0.5 sits at the nozzle.
      g.rotateX(-Math.PI / 2);
      return g;
    };
    this.plumeGeometry = cylinder(0.6, 0.18);
    this.coreGeometry = cylinder(0.32, 0.05);
    this.plumeMaterial = plumeMaterial(false);
    this.coreMaterial = plumeMaterial(true);

    this.boomMaterial = vapourMaterial(
      /* glsl */ `
      uniform float uFade;
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewW;
      void main() {
        float facing = abs(dot(normalize(vNormalW), vViewW));
        float rim = pow(1.0 - facing, 3.0);
        float n = vNoise(vUv * vec2(40.0, 20.0));
        float a = rim * uFade * (0.5 + 0.5 * n) * 0.55;
        if (a < 0.003) discard;
        vec3 light = uSunColor * vapourPhase(vViewW) + uAmbient;
        gl_FragColor = vec4(light * a, a);
      }`,
      { ...this.lighting, uFade: { value: 1 } },
    );

    this.contrailMaterial = ribbonMaterial(1.6, 3.2, 55, 0.55, this.lighting);
    this.tips = [0, 1].map(
      () => new Ribbon(220, 2.5, 1.6, ribbonMaterial(0.35, 1.4, 1.6, 0.5, this.lighting)),
    );
    for (const ribbon of this.tips) this.group.add(ribbon.mesh);
    scene.add(this.group);
    this.setAirframe([new T.Vector3(0, 0.1, 8)], 0.6, new T.Vector3(5.3, 0.05, 3.6), 16);
  }
  /**
   * Places afterburner plumes and contrails at each nozzle exit and the
   * vortex trails at the wingtips (aircraft frame, metres, +Z aft).
   */
  setAirframe(nozzles: T.Vector3[], nozzleRadius: number, tip: T.Vector3, length: number) {
    for (const e of this.engines) {
      e.plume.removeFromParent();
      e.core.removeFromParent();
    }
    this.engines = nozzles.map((nozzle) => {
      const plume = new T.Mesh(this.plumeGeometry, this.plumeMaterial);
      const core = new T.Mesh(this.coreGeometry, this.coreMaterial);
      for (const m of [plume, core]) {
        m.layers.set(TRANSPARENT_LAYER);
        m.frustumCulled = false;
        this.plane.add(m);
      }
      return { plume, core, nozzle: nozzle.clone() };
    });
    for (const r of this.contrails) {
      this.group.remove(r.mesh);
      r.dispose();
    }
    this.contrails = nozzles.slice(0, 2).map(() => {
      const ribbon = new Ribbon(700, 35, 55, this.contrailMaterial);
      this.group.add(ribbon.mesh);
      return ribbon;
    });
    this.nozzleRadius = nozzleRadius;
    this.tipPosition.copy(tip);
    this.size = length / 16;
    for (const r of this.tips) r.clear();
  }
  /** Lighting from the sky engine: sun direction/colour (pre-multiplied by illuminance) and ambient. */
  setLighting(sun: T.Vector3, sunColor: T.Color, ambient: T.Color) {
    this.lighting.uSunDir.value.copy(sun);
    this.lighting.uSunColor.value.copy(sunColor);
    this.lighting.uAmbient.value.copy(ambient);
  }
  update(
    dt: number,
    state: {
      position: T.Vector3;
      quaternion: T.Quaternion;
      mach: number;
      gLoad: number;
      boost: boolean;
      throttle: number;
      altitude: number;
      active: boolean;
    },
    origin: T.Vector3,
  ) {
    this.time += dt;
    const { mach, altitude } = state;
    // Humid low air condenses; above ~5 km the transonic cloud no longer forms.
    const humid = 1 - T.MathUtils.smoothstep(altitude, 1500, 5500);
    const supersonic = mach >= 1;
    // Only a running simulation can cross the barrier: pause and photo mode
    // (dt = 0) leave the latch alone so resuming does not boom again.
    const live = state.active && dt > 0;
    if (live && supersonic && !this.wasSupersonic) {
      this.onset = 1;
      this.spawnBoom(state.position, state.quaternion);
      this.onBoom?.(state.position);
    }
    if (live) this.wasSupersonic = supersonic || (this.wasSupersonic && mach > 0.985);
    this.onset = Math.max(0, this.onset - dt * 1.6);
    const window =
      T.MathUtils.smoothstep(mach, 0.9, 0.975) *
      (1 - T.MathUtils.smoothstep(mach, 1.04, 1.12));
    const intensity = state.active ? (window * 0.75 + this.onset * 0.9) * (0.25 + 0.75 * humid) : 0;
    const cone = this.cone.material.uniforms;
    cone.uIntensity.value = T.MathUtils.damp(cone.uIntensity.value, intensity, 10, dt);
    cone.uTime.value = this.time;
    this.cone.visible = cone.uIntensity.value > 0.01;
    // The shock (aft edge) moves aft as Mach rises.
    const size = this.size;
    this.cone.position.set(
      0,
      0.4 * size,
      T.MathUtils.lerp(-0.5, 2.5, T.MathUtils.clamp((mach - 0.92) / 0.18, 0, 1)) * size,
    );
    const breathe = (1 + 0.04 * Math.sin(this.time * 23) + this.onset * 0.15) * size;
    this.cone.scale.set(breathe, breathe, size);

    const boost = state.active && state.boost ? 1 : 0;
    const length = boost ? 9 + Math.sin(this.time * 31) * 0.4 : 2.6 + state.throttle * 1.8;
    // Plume length scales with the nozzle: diamonds stay a fixed number of diameters apart.
    const width = this.nozzleRadius / 0.6;
    for (const [material, scale] of [
      [this.plumeMaterial, 1],
      [this.coreMaterial, 0.62],
    ] as const) {
      const u = material.uniforms;
      u.uBoost.value = T.MathUtils.damp(u.uBoost.value, boost, 8, dt);
      u.uThrottle.value = state.throttle;
      u.uTime.value = this.time;
      u.uLength.value = length * scale;
      u.uMach.value = 1.15 + 0.35 * u.uBoost.value;
    }
    for (const e of this.engines) {
      for (const [mesh, scale] of [
        [e.plume, 1],
        [e.core, 0.62],
      ] as const) {
        const l = length * scale * width;
        mesh.scale.set(width, width, l);
        mesh.position.set(e.nozzle.x, e.nozzle.y, e.nozzle.z + l / 2);
        mesh.visible = state.active;
      }
    }

    // Persistent contrails above ~8.5 km, from each engine.
    const contrailStrength = state.active ? T.MathUtils.smoothstep(altitude, 8000, 9500) : 0;
    this.contrails.forEach((ribbon, i) => {
      const n = this.engines[i].nozzle;
      this.nozzle.set(n.x, n.y, n.z + 1.5).applyQuaternion(state.quaternion).add(state.position);
      ribbon.emit(this.nozzle.x, this.nozzle.y, this.nozzle.z, this.time, contrailStrength);
      ribbon.upload(origin, this.time, this.nozzle.x, this.nozzle.y, this.nozzle.z, contrailStrength);
    });

    // Wingtip vortices in hard pulls, strongest in humid low air.
    const vortex = state.active
      ? T.MathUtils.smoothstep(state.gLoad, 3.2, 6) * (0.35 + 0.65 * humid)
      : 0;
    this.tips.forEach((ribbon, i) => {
      const tip = this.tipPosition;
      this.local.set(i === 0 ? -tip.x : tip.x, tip.y, tip.z).applyQuaternion(state.quaternion).add(state.position);
      ribbon.emit(this.local.x, this.local.y, this.local.z, this.time, vortex);
      ribbon.upload(origin, this.time, this.local.x, this.local.y, this.local.z, vortex);
    });

    for (let i = this.booms.length - 1; i >= 0; i--) {
      const b = this.booms[i];
      b.age += dt;
      const radius = 6 + b.age * 340;
      b.mesh.scale.set(radius, radius * 0.92, radius);
      b.mesh.position.copy(b.global).sub(origin);
      (b.mesh.material as T.ShaderMaterial).uniforms.uFade.value = Math.max(0, 1 - b.age / 1.1);
      if (b.age > 1.1) {
        b.mesh.removeFromParent();
        (b.mesh.material as T.Material).dispose();
        this.booms.splice(i, 1);
      }
    }
  }
  private spawnBoom(position: T.Vector3, quaternion: T.Quaternion) {
    const mesh = new T.Mesh(this.boomGeometry, this.boomMaterial.clone());
    (mesh.material as T.ShaderMaterial).uniforms = {
      ...this.lighting,
      uFade: { value: 1 },
    };
    mesh.quaternion.copy(quaternion);
    mesh.layers.set(TRANSPARENT_LAYER);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this.booms.push({ mesh, age: 0, global: position.clone() });
  }
  clear() {
    for (const r of this.contrails) r.clear();
    for (const r of this.tips) r.clear();
    for (const b of this.booms) {
      b.mesh.removeFromParent();
      (b.mesh.material as T.Material).dispose();
    }
    this.booms.length = 0;
    this.wasSupersonic = false;
    this.onset = 0;
    this.cone.material.uniforms.uIntensity.value = 0;
  }
  dispose() {
    this.clear();
    this.group.removeFromParent();
    this.cone.removeFromParent();
    this.cone.geometry.dispose();
    this.cone.material.dispose();
    for (const e of this.engines) {
      e.plume.removeFromParent();
      e.core.removeFromParent();
    }
    for (const m of [this.plumeGeometry, this.coreGeometry, this.plumeMaterial, this.coreMaterial])
      m.dispose();
    for (const r of this.contrails) r.dispose();
    this.contrailMaterial.dispose();
    for (const r of this.tips) {
      r.dispose();
      (r.mesh.material as T.Material).dispose();
    }
    this.boomGeometry.dispose();
    this.boomMaterial.dispose();
  }
}
