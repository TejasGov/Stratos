import * as T from "three";

/** One glowing lamp: position in base-local space, linear HDR colour, size in metres. */
export interface Glow {
  x: number;
  y: number;
  z: number;
  color: [number, number, number];
  size: number;
  /** Sequenced-flasher phase in seconds (0..1); omit for steady lights. */
  strobe?: number;
  /** Beam direction: 0 all-round, 1 +z, 2 −z, 3 +x, 4 −x (base-local axes). */
  dir?: 0 | 1 | 2 | 3 | 4;
  gain?: number;
}

const GLOW_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute vec3 aColor;
attribute vec4 aParams;
uniform float uTime;
uniform float uLevel;
uniform float uMinAngle;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
  float dist = max(-mv.z, 1.0);
  float size = aParams.x;
  float big = max(size, dist * uMinAngle);
  // A lamp stretched to a minimum pixel footprint keeps most of its brightness.
  float energy = clamp(sqrt(size / big), 0.16, 1.0);
  float facing = 1.0;
  int d = int(aParams.z + 0.5);
  if (d > 0) {
    vec3 world = (modelMatrix * vec4(aOffset, 1.0)).xyz;
    vec3 toCam = normalize(cameraPosition - world);
    vec3 axis = d == 1 ? vec3(0.0, 0.0, 1.0) : d == 2 ? vec3(0.0, 0.0, -1.0) : d == 3 ? vec3(1.0, 0.0, 0.0) : vec3(-1.0, 0.0, 0.0);
    facing = smoothstep(-0.15, 0.5, dot(toCam, normalize(mat3(modelMatrix) * axis)));
  }
  float flash = 1.0;
  if (aParams.y >= 0.0) flash = 0.04 + exp(-fract(uTime * 1.2 - aParams.y) * 18.0) * 1.8;
  vColor = aColor * aParams.w * energy * facing * flash * uLevel;
  vUv = position.xy * 2.0;
  mv.xy += position.xy * big;
  gl_Position = projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 9.0);
  float halo = 0.28 / (1.0 + r2 * 22.0) * (1.0 - r2);
  gl_FragColor = vec4(vColor * (core + halo), 1.0);
}
`;

/** Additive without touching the target's alpha (the sky composite reads it). */
function additive(m: T.ShaderMaterial) {
  m.transparent = true;
  m.depthWrite = false;
  m.blending = T.CustomBlending;
  m.blendEquation = T.AddEquation;
  m.blendSrc = T.OneFactor;
  m.blendDst = T.OneFactor;
  m.blendSrcAlpha = T.ZeroFactor;
  m.blendDstAlpha = T.OneFactor;
}

export interface LightUniforms {
  uTime: { value: number };
  uLevel: { value: number };
}

/** Instanced billboard lamps: one draw call for every light on a base. */
export class GlowLights {
  readonly mesh: T.Mesh;
  readonly material: T.ShaderMaterial;
  private colors: T.InstancedBufferAttribute;
  private base: Float32Array;
  constructor(specs: Glow[], uniforms: LightUniforms) {
    const quad = new T.PlaneGeometry(1, 1);
    const geo = new T.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute("position", quad.attributes.position);
    const n = specs.length;
    const offset = new Float32Array(n * 3), color = new Float32Array(n * 3), params = new Float32Array(n * 4);
    specs.forEach((s, i) => {
      offset.set([s.x, s.y, s.z], i * 3);
      color.set(s.color, i * 3);
      params.set([s.size, s.strobe ?? -1, s.dir ?? 0, s.gain ?? 1], i * 4);
    });
    this.base = color.slice();
    this.colors = new T.InstancedBufferAttribute(color, 3);
    this.colors.setUsage(T.DynamicDrawUsage);
    geo.setAttribute("aOffset", new T.InstancedBufferAttribute(offset, 3));
    geo.setAttribute("aColor", this.colors);
    geo.setAttribute("aParams", new T.InstancedBufferAttribute(params, 4));
    geo.instanceCount = n;
    const box = new T.Box3();
    specs.forEach((s) => box.expandByPoint(new T.Vector3(s.x, s.y, s.z)));
    geo.boundingSphere = box.getBoundingSphere(new T.Sphere());
    geo.boundingSphere.radius += 10;
    geo.boundingBox = box;
    this.material = new T.ShaderMaterial({
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      uniforms: { ...uniforms, uMinAngle: { value: 0.0022 } },
    });
    additive(this.material);
    this.mesh = new T.Mesh(geo, this.material);
    this.mesh.renderOrder = 5;
  }
  /** Recolours one lamp (PAPI units track the viewer's glidepath). */
  setColor(i: number, r: number, g: number, b: number) {
    this.colors.setXYZ(i, r, g, b);
    this.colors.needsUpdate = true;
  }
  restoreColors() {
    (this.colors.array as Float32Array).set(this.base);
    this.colors.needsUpdate = true;
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

const POOL_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute vec4 aColor;
uniform float uLevel;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vUv = position.xz * 2.0;
  vColor = aColor.rgb * uLevel;
  vec3 p = vec3(aOffset.x + position.x * aColor.a, aOffset.y, aOffset.z + position.z * aColor.a);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const POOL_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float r = length(vUv);
  float a = max(1.0 - r, 0.0);
  a = a * a * (0.6 + 0.4 * a);
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

/** Pools of floodlight on the ground, flat additive discs. */
export class LightPools {
  readonly mesh: T.Mesh;
  readonly material: T.ShaderMaterial;
  constructor(pools: { x: number; y: number; z: number; color: [number, number, number]; radius: number }[], uniforms: { uLevel: { value: number } }) {
    const plane = new T.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    const geo = new T.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.setAttribute("position", plane.attributes.position);
    const n = pools.length;
    const offset = new Float32Array(n * 3), color = new Float32Array(n * 4);
    pools.forEach((p, i) => {
      offset.set([p.x, p.y, p.z], i * 3);
      color.set([...p.color, p.radius * 2], i * 4);
    });
    geo.setAttribute("aOffset", new T.InstancedBufferAttribute(offset, 3));
    geo.setAttribute("aColor", new T.InstancedBufferAttribute(color, 4));
    geo.instanceCount = n;
    const box = new T.Box3();
    pools.forEach((p) => box.expandByPoint(new T.Vector3(p.x, p.y, p.z)));
    geo.boundingSphere = box.getBoundingSphere(new T.Sphere());
    geo.boundingSphere.radius += 60;
    this.material = new T.ShaderMaterial({
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      uniforms: { uLevel: uniforms.uLevel },
    });
    additive(this.material);
    this.material.polygonOffset = true;
    this.material.polygonOffsetFactor = this.material.polygonOffsetUnits = -6;
    this.mesh = new T.Mesh(geo, this.material);
    this.mesh.renderOrder = 4;
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
