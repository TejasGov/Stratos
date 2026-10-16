import * as T from "three";
import { ParticlePool, localPosition, type Point3 } from "./particle-core";
import {
  CELLS,
  GRADIENT_RANGE,
  TILE,
  makeFireAtlasData,
  makeSmokeAtlasData,
} from "./sprites";

function atlasTexture(data: Uint8Array) {
  const texture = new T.DataTexture(
    data,
    TILE * CELLS,
    TILE * CELLS,
    T.RGBAFormat,
  );
  texture.magFilter = texture.minFilter = T.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const COMMON_VERTEX = /* glsl */ `
  attribute vec3 center; attribute vec4 params; attribute vec4 tint; attribute vec4 axis; attribute vec4 extra;
  varying vec2 vUv; varying vec4 vTint; varying vec4 vExtra; varying vec2 vRot;
  varying float vDistance; varying float vSize; varying float vErode;
  #include <fog_pars_vertex>
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(center, 1.0);
    float size = params.x;
    vec2 offset = position.xy * size;
    float rotation = params.w;
    if (extra.z > 0.5) {
      // Flat on the ground plane (dust rings, ground shockwave).
      mat2 turn = mat2(cos(rotation), sin(rotation), -sin(rotation), cos(rotation));
      offset = turn * offset;
      mvPosition.xyz += mat3(viewMatrix) * vec3(offset.x, 0.0, -offset.y);
    } else {
      vec3 viewAxis = mat3(viewMatrix) * axis.xyz;
      if (axis.w > 1.01 && length(viewAxis.xy) > 0.01) rotation = atan(viewAxis.y, viewAxis.x);
      offset.x *= axis.w;
      offset = mat2(cos(rotation), sin(rotation), -sin(rotation), cos(rotation)) * offset;
      mvPosition.xy += offset;
    }
    gl_Position = projectionMatrix * mvPosition;
    vUv = uv; vTint = vec4(tint.rgb, tint.a * params.y); vExtra = extra;
    vRot = vec2(cos(rotation), sin(rotation));
    vDistance = -mvPosition.z; vSize = size * max(1.0, axis.w * 0.5); vErode = params.z;
    #include <fog_vertex>
  }`;

const COMMON_FRAGMENT_HEAD = /* glsl */ `
  uniform sampler2D atlas; uniform sampler2D sceneDepth; uniform bool useSoftDepth;
  uniform vec2 clipRange; uniform vec2 viewport; uniform float softRange;
  varying vec2 vUv; varying vec4 vTint; varying vec4 vExtra; varying vec2 vRot;
  varying float vDistance; varying float vSize; varying float vErode;
  #include <packing>
  #include <fog_pars_fragment>
  vec4 sampleFrame(float frame, vec2 uv) {
    vec2 cell = vec2(mod(frame, 4.0), floor(frame / 4.0));
    // Sample inside the padded cell, avoiding atlas-neighbor bleeding.
    return texture2D(atlas, (cell + mix(vec2(0.015625), vec2(0.984375), uv)) / 4.0);
  }
  vec4 sampleAtlas() {
    float frame = clamp(vExtra.y, 0.0, 15.0);
    float base = floor(frame);
    vec4 a = sampleFrame(base, vUv);
    return fract(frame) > 0.001 ? mix(a, sampleFrame(min(15.0, base + 1.0), vUv), fract(frame)) : a;
  }
  // Black body, roughly: dull red, orange, yellow, then HDR white-yellow. Values exceed 1 so bloom catches them.
  vec3 fireRamp(float h) {
    vec3 c = mix(vec3(0.0), vec3(0.62, 0.15, 0.03), smoothstep(0.0, 0.22, h));
    c = mix(c, vec3(3.0, 1.05, 0.2), smoothstep(0.2, 0.52, h));
    c = mix(c, vec3(7.5, 4.6, 1.6), smoothstep(0.5, 0.82, h));
    return mix(c, vec3(14.0, 11.5, 8.5), smoothstep(0.82, 1.0, h));
  }
  float edgeFade() {
    float fade = smoothstep(1.5, 6.0, vDistance);
    // Big sprites dissolve as the camera enters them instead of showing a flat disc.
    fade *= smoothstep(0.08 * vSize, 0.55 * vSize + 1.0, vDistance);
    if (useSoftDepth) {
      float depth = texture2D(sceneDepth, gl_FragCoord.xy / viewport).x;
      float distanceToSurface = -perspectiveDepthToViewZ(depth, clipRange.x, clipRange.y);
      fade *= clamp((distanceToSurface - vDistance) / softRange, 0.0, 1.0);
    }
    return fade;
  }`;

/** Smoke, dust, soot and fireballs: alpha blended, sun-lit through a baked height field, emissive when hot. */
const SMOKE_FRAGMENT = /* glsl */ `
  ${COMMON_FRAGMENT_HEAD}
  uniform vec3 uLightDir; uniform vec3 uSunColor; uniform vec3 uAmbient;
  void main() {
    vec4 texel = sampleAtlas();
    float cover = clamp((texel.a - vErode * 0.9) / (1.0 - vErode * 0.9), 0.0, 1.0);
    cover = smoothstep(0.0, 0.55, cover);
    vec2 g = (texel.gb - 0.5) * ${GRADIENT_RANGE.toFixed(1)};
    vec2 gradient = vec2(vRot.x * g.x - vRot.y * g.y, vRot.y * g.x + vRot.x * g.y);
    vec3 normal = normalize(vec3(-gradient * 0.55, 1.0));
    float wrap = clamp(dot(normal, uLightDir) * 0.5 + 0.5, 0.0, 1.0);
    // Thin edges scatter more light than the thick core.
    vec3 lit = uAmbient * (0.75 + 0.25 * normal.z) + uSunColor * (wrap * wrap * (1.15 - 0.45 * texel.r));
    vec3 color = vTint.rgb * lit;
    if (vExtra.x > 0.0) {
      // A second, rotated tap breaks the glow into churning hot and cooler pockets.
      vec4 other = sampleFrame(mod(vExtra.y + 5.0, 16.0), vec2(1.0 - vUv.y, vUv.x));
      float pockets = clamp(0.25 + 0.9 * texel.r + 0.7 * other.r, 0.0, 1.6);
      color += fireRamp(vExtra.x * pockets) * vExtra.w;
    }
    float alpha = cover * vTint.a * edgeFade();
    gl_FragColor = vec4(color, alpha);
    if (gl_FragColor.a < 0.003) discard;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

/** Glows, sparks, rings and flames: additive, colour comes from the particle (or the heat ramp). */
const FIRE_FRAGMENT = /* glsl */ `
  ${COMMON_FRAGMENT_HEAD}
  void main() {
    vec4 texel = sampleAtlas();
    vec3 color = (vExtra.x >= 0.0 ? fireRamp(vExtra.x) * vTint.rgb : vTint.rgb) * vExtra.w;
    float alpha = clamp(texel.a * vTint.a * edgeFade(), 0.0, 1.0);
    gl_FragColor = vec4(color * texel.r, alpha);
    if (gl_FragColor.a < 0.003) discard;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

export class ParticleBatch {
  readonly pool: ParticlePool;
  readonly geometry: T.InstancedBufferGeometry;
  readonly material: T.ShaderMaterial;
  readonly mesh: T.Mesh;
  private readonly order: number[] = [];
  private readonly depths: Float64Array;
  private readonly attributes: T.InstancedBufferAttribute[];
  private readonly center: T.InstancedBufferAttribute;
  private readonly params: T.InstancedBufferAttribute;
  private readonly color: T.InstancedBufferAttribute;
  private readonly axis: T.InstancedBufferAttribute;
  private readonly extra: T.InstancedBufferAttribute;
  private readonly local = new T.Vector3();
  private readonly byDepth = (a: number, b: number) =>
    this.depths[a] - this.depths[b];
  constructor(
    capacity: number,
    readonly additive: boolean,
  ) {
    this.pool = new ParticlePool(capacity);
    this.depths = new Float64Array(capacity);
    this.geometry = new T.InstancedBufferGeometry();
    const quad = new T.PlaneGeometry(1, 1);
    this.geometry.index = quad.index!.clone();
    this.geometry.setAttribute("position", quad.attributes.position.clone());
    this.geometry.setAttribute("uv", quad.attributes.uv.clone());
    quad.dispose();
    const make = (size: number) =>
      new T.InstancedBufferAttribute(new Float32Array(capacity * size), size);
    this.center = make(3);
    this.params = make(4);
    this.color = make(4);
    this.axis = make(4);
    this.extra = make(4);
    this.attributes = [
      this.center,
      this.params,
      this.color,
      this.axis,
      this.extra,
    ];
    for (const attribute of this.attributes)
      attribute.setUsage(T.DynamicDrawUsage);
    this.geometry.setAttribute("center", this.center);
    this.geometry.setAttribute("params", this.params);
    this.geometry.setAttribute("tint", this.color);
    this.geometry.setAttribute("axis", this.axis);
    this.geometry.setAttribute("extra", this.extra);
    this.geometry.instanceCount = 0;
    this.material = new T.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: additive ? T.AdditiveBlending : T.NormalBlending,
      fog: true,
      uniforms: {
        atlas: {
          value: atlasTexture(
            additive ? makeFireAtlasData() : makeSmokeAtlasData(),
          ),
        },
        sceneDepth: { value: null },
        useSoftDepth: { value: false },
        softRange: { value: 6 },
        clipRange: { value: new T.Vector2(1, 22000) },
        viewport: { value: new T.Vector2(1, 1) },
        uLightDir: { value: new T.Vector3(0.4, 0.8, 0.4) },
        uSunColor: { value: new T.Color(0.9, 0.85, 0.75) },
        uAmbient: { value: new T.Color(0.25, 0.3, 0.38) },
        ...T.UniformsLib.fog,
      },
      vertexShader: COMMON_VERTEX,
      fragmentShader: additive ? FIRE_FRAGMENT : SMOKE_FRAGMENT,
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
    // Under quality pressure keep the closest effects; alpha smoke then sorts back to front.
    if (this.order.length > limit) {
      this.order.sort(this.byDepth);
      this.order.length = limit;
    } else if (!this.additive) this.order.sort(this.byDepth);
    if (!this.additive) this.order.reverse();
    for (let index = 0; index < this.order.length; index++) {
      const p = this.pool.particles[this.order[index]],
        age = p.age,
        progress = age / p.life;
      localPosition(p, origin, this.local);
      this.center.setXYZ(index, this.local.x, this.local.y, this.local.z);
      const size =
        p.ease > 0
          ? p.size + (p.growth * (1 - Math.exp(-p.ease * age))) / p.ease
          : p.size + p.growth * age;
      let alpha = p.attack > 0 ? Math.min(1, progress / p.attack) : 1;
      if (alpha < 1) alpha = alpha * alpha * (3 - 2 * alpha);
      if (p.decay > 0) alpha *= Math.pow(1 - progress, p.decay);
      if (p.flicker > 0) {
        // Two incommensurate sines per particle read as irregular crackle without any state.
        const seed = p.rotation;
        alpha *= Math.max(
          0,
          1 +
            p.flicker *
              (0.55 * Math.sin(age * (41 + seed * 7) + seed * 40) +
                0.45 * Math.sin(age * 97.3 + seed * 91)),
        );
      }
      this.params.setXYZW(
        index,
        size,
        alpha,
        p.erode * progress,
        p.rotation + p.spin * age,
      );
      this.color.setXYZW(index, p.r, p.g, p.b, p.opacity);
      let dx = p.dx,
        dy = p.dy,
        dz = p.dz,
        stretch = p.stretch;
      if (stretch > 1.01) {
        // Streaks follow the current velocity and lengthen with speed.
        const speed = Math.hypot(p.vx, p.vy, p.vz);
        if (speed > 0.5) {
          dx = p.vx / speed;
          dy = p.vy / speed;
          dz = p.vz / speed;
          stretch = 1 + (stretch - 1) * Math.min(1, speed / 30);
        }
      }
      this.axis.setXYZW(index, dx, dy, dz, stretch);
      this.extra.setXYZW(
        index,
        p.heat < 0 ? -1 : p.heat * Math.exp(-p.cool * age),
        p.frame + p.frames * progress,
        p.mode,
        p.gain,
      );
    }
    const count = this.order.length;
    this.geometry.instanceCount = count;
    for (const attribute of this.attributes) {
      // Upload only the live prefix, not the whole pool.
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }
  dispose() {
    this.geometry.dispose();
    (this.material.uniforms.atlas.value as T.Texture).dispose();
    this.material.dispose();
  }
}
