import * as T from "three";
import { ATMOSPHERE_GLSL } from "./shaders/atmosphere";
import { FullscreenPass, hdrTarget, passMaterial } from "./FullscreenPass";

/** Aerial-perspective froxel depth. Beyond it, the sky-view LUT covers ground hits. */
export const AERIAL_RANGE_KM = 96;
export const AERIAL_SLICES = 32;

const TRANSMITTANCE = /* glsl */ `
${ATMOSPHERE_GLSL}
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(256.0, 64.0);
  float H = sqrt(Rt * Rt - Rg * Rg);
  float rho = H * uv.y;
  float r = sqrt(rho * rho + Rg * Rg);
  float dmin = Rt - r, dmax = rho + H;
  float d = dmin + uv.x * (dmax - dmin);
  float mu = d == 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  float tMax = raySphere(ro, rd, Rt);
  vec3 depth = vec3(0.0);
  float dt = tMax / 48.0;
  for (int i = 0; i < 48; i++) {
    vec3 p = ro + rd * ((float(i) + 0.5) * dt);
    vec3 rs, ext; float ms;
    atmosphereAt(length(p) - Rg, rs, ms, ext);
    depth += ext * dt;
  }
  outColor = vec4(exp(-depth), 1.0);
}`;

const MULTI_SCATTER = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D tTransmittance;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5) / 31.0;
  float sunMu = uv.x * 2.0 - 1.0;
  float r = mix(Rg + 0.01, Rt - 0.01, uv.y);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 sunDir = normalize(vec3(0.0, sunMu, -sqrt(max(0.0, 1.0 - sunMu * sunMu))));
  vec3 lumTotal = vec3(0.0), fms = vec3(0.0);
  const float SQRT_SAMPLES = 8.0;
  const float STEPS = 20.0;
  float inv = 1.0 / (SQRT_SAMPLES * SQRT_SAMPLES);
  for (float i = 0.0; i < SQRT_SAMPLES; i += 1.0)
  for (float j = 0.0; j < SQRT_SAMPLES; j += 1.0) {
    float theta = PI * (i + 0.5) / SQRT_SAMPLES;
    float phi = acos(clamp(1.0 - 2.0 * (j + 0.5) / SQRT_SAMPLES, -1.0, 1.0));
    vec3 rd = vec3(cos(theta) * sin(phi), cos(phi), sin(theta) * sin(phi));
    float atmo = raySphere(ro, rd, Rt);
    float ground = raySphere(ro, rd, Rg);
    float tMax = ground > 0.0 ? ground : atmo;
    float c = dot(rd, sunDir);
    float pr = rayleighPhase(-c), pm = miePhase(c);
    vec3 lum = vec3(0.0), factor = vec3(0.0), trans = vec3(1.0);
    float t = 0.0;
    for (float s = 0.0; s < STEPS; s += 1.0) {
      float nt = ((s + 0.3) / STEPS) * tMax;
      float dt = nt - t;
      t = nt;
      vec3 p = ro + rd * t;
      vec3 rs, ext; float ms;
      atmosphereAt(length(p) - Rg, rs, ms, ext);
      vec3 sampleT = exp(-dt * ext);
      vec3 scatterNoPhase = rs + ms;
      factor += trans * (scatterNoPhase - scatterNoPhase * sampleT) / max(ext, vec3(1e-7));
      vec3 sunT = sunTransmittance(tTransmittance, p, sunDir);
      vec3 inScatter = (rs * pr + ms * pm) * sunT;
      lum += trans * (inScatter - inScatter * sampleT) / max(ext, vec3(1e-7));
      trans *= sampleT;
    }
    if (ground > 0.0) {
      vec3 hit = normalize(ro + rd * ground) * Rg;
      lum += trans * GROUND_ALBEDO / PI * max(dot(normalize(hit), sunDir), 0.0) *
        sunTransmittance(tTransmittance, hit + normalize(hit) * 0.01, sunDir);
    }
    fms += factor * inv;
    lumTotal += lum * inv;
  }
  outColor = vec4(lumTotal / max(vec3(1.0) - fms, vec3(1e-3)), 1.0);
}`;

const SKY_VIEW = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D tTransmittance, tMultiScatter;
uniform float uCameraR;
uniform vec3 uSunDir;
layout(location = 0) out vec4 outColor;
void main() {
  float u = gl_FragCoord.x / 192.0;
  float v = (gl_FragCoord.y - 0.5) / 107.0;
  float r = uCameraR;
  float dip = horizonDip(r);
  float side = v >= 0.5 ? 0.5 * PI + dip : 0.5 * PI - dip;
  float c = 2.0 * v - 1.0;
  float rel = sign(c) * c * c * side;
  float elevation = rel - dip;
  float azimuth = (u - 0.5) * 2.0 * PI;
  vec3 rd = vec3(cos(elevation) * sin(azimuth), sin(elevation), -cos(elevation) * cos(azimuth));
  float sunMu = uSunDir.y;
  vec3 sunDir = vec3(0.0, sunMu, -sqrt(max(0.0, 1.0 - sunMu * sunMu)));
  vec3 ro = vec3(0.0, r, 0.0);
  float atmo = raySphere(ro, rd, Rt);
  float ground = raySphere(ro, rd, Rg);
  float tMax = ground > 0.0 ? ground : atmo;
  vec3 trans;
  vec3 lum = integrateScattering(tTransmittance, tMultiScatter, ro, rd, sunDir, max(tMax, 0.0), 40.0, trans);
  outColor = vec4(lum, 1.0);
}`;

const AERIAL = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D tTransmittance, tMultiScatter;
uniform float uCameraR, uRangeKm;
uniform vec3 uSunDir;
uniform mat4 uRayMatrix;
layout(location = 0) out vec4 outInscatter;
layout(location = 1) out vec4 outTransmittance;
void main() {
  float slice = floor(gl_FragCoord.x / 32.0);
  vec2 cell = vec2(mod(gl_FragCoord.x, 32.0), gl_FragCoord.y) / 32.0;
  vec4 ray = uRayMatrix * vec4(cell * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(ray.xyz / ray.w);
  float depth = uRangeKm * pow((slice + 1.0) / 32.0, 2.0);
  vec3 ro = vec3(0.0, uCameraR, 0.0);
  float ground = raySphere(ro, rd, Rg);
  float tMax = ground > 0.0 ? min(depth, ground) : depth;
  vec3 trans;
  vec3 lum = integrateScattering(tTransmittance, tMultiScatter, ro, rd, uSunDir, tMax,
    clamp(6.0 + slice * 0.6, 6.0, 24.0), trans);
  outInscatter = vec4(lum, 1.0);
  outTransmittance = vec4(trans, 1.0);
}`;

const RAYLEIGH = [5.802e-3, 13.558e-3, 33.1e-3];
const OZONE = [0.65e-3, 1.881e-3, 0.085e-3];

/**
 * GPU look-up tables for the sky. Transmittance and multiple scattering are
 * static; the sky-view and aerial-perspective tables follow the camera.
 */
export class Atmosphere {
  readonly transmittance = hdrTarget(256, 64);
  readonly multiScatter = hdrTarget(32, 32);
  readonly skyView = hdrTarget(192, 108, { wrapS: T.RepeatWrapping });
  readonly aerial = hdrTarget(32 * AERIAL_SLICES, 32, { count: 2 });
  readonly sunDirection = new T.Vector3(0, 1, 0);
  private ready = false;
  private passes: {
    transmittance: FullscreenPass;
    multiScatter: FullscreenPass;
    skyView: FullscreenPass;
    aerial: FullscreenPass;
  };
  private rayMatrix = new T.Matrix4();
  private rotation = new T.Matrix4();
  constructor() {
    this.passes = {
      transmittance: new FullscreenPass(
        passMaterial({ fragmentShader: TRANSMITTANCE }),
      ),
      multiScatter: new FullscreenPass(
        passMaterial({
          fragmentShader: MULTI_SCATTER,
          uniforms: { tTransmittance: { value: this.transmittance.texture } },
        }),
      ),
      skyView: new FullscreenPass(
        passMaterial({
          fragmentShader: SKY_VIEW,
          uniforms: {
            tTransmittance: { value: this.transmittance.texture },
            tMultiScatter: { value: this.multiScatter.texture },
            uCameraR: { value: 6360.1 },
            uSunDir: { value: this.sunDirection },
          },
        }),
      ),
      aerial: new FullscreenPass(
        passMaterial({
          fragmentShader: AERIAL,
          uniforms: {
            tTransmittance: { value: this.transmittance.texture },
            tMultiScatter: { value: this.multiScatter.texture },
            uCameraR: { value: 6360.1 },
            uRangeKm: { value: AERIAL_RANGE_KM },
            uSunDir: { value: this.sunDirection },
            uRayMatrix: { value: this.rayMatrix },
          },
        }),
      ),
    };
  }
  /** Uniform references for any shader that samples the tables. */
  get uniforms() {
    return {
      tTransmittance: { value: this.transmittance.texture },
      tMultiScatter: { value: this.multiScatter.texture },
      tSkyView: { value: this.skyView.texture },
      tAerialInscatter: { value: this.aerial.textures[0] },
      tAerialTransmittance: { value: this.aerial.textures[1] },
    };
  }
  update(
    renderer: T.WebGLRenderer,
    camera: T.PerspectiveCamera,
    altitude: number,
    sun: T.Vector3,
  ) {
    const previous = renderer.getRenderTarget();
    if (!this.ready) {
      this.passes.transmittance.render(renderer, this.transmittance);
      this.passes.multiScatter.render(renderer, this.multiScatter);
      this.ready = true;
    }
    this.sunDirection.copy(sun);
    const radius = 6360 + Math.max(0.002, altitude / 1000);
    this.passes.skyView.material.uniforms.uCameraR.value = radius;
    this.passes.aerial.material.uniforms.uCameraR.value = radius;
    // Clip-space to world-direction matrix, ignoring camera translation.
    this.rotation.extractRotation(camera.matrixWorld);
    this.rayMatrix
      .copy(this.rotation)
      .multiply(camera.projectionMatrixInverse);
    this.passes.skyView.render(renderer, this.skyView);
    this.passes.aerial.render(renderer, this.aerial);
    renderer.setRenderTarget(previous);
  }
  dispose() {
    for (const target of [
      this.transmittance,
      this.multiScatter,
      this.skyView,
      this.aerial,
    ])
      target.dispose();
    for (const pass of Object.values(this.passes)) pass.dispose();
  }
}

/**
 * CPU estimate of sunlight reaching a point at `altitude` metres, used to colour
 * the scene's directional light. Mirrors the shader's optical-depth integral.
 */
export function sunlightTransmittance(
  altitude: number,
  sun: T.Vector3,
  out = new T.Color(),
) {
  const Rg = 6360,
    Rt = 6460;
  const r = Rg + Math.max(0, altitude) / 1000;
  const mu = sun.y;
  const horizon = -Math.sqrt(Math.max(0, 1 - (Rg * Rg) / (r * r)));
  const visible = T.MathUtils.smoothstep(mu - horizon, -0.006, 0.006);
  if (visible <= 0) return out.setRGB(0, 0, 0);
  // Distance to the top of the atmosphere along the sun direction.
  const b = r * mu,
    c = r * r - Rt * Rt;
  const tMax = -b + Math.sqrt(Math.max(0, b * b - c));
  const steps = 32,
    dt = tMax / steps;
  const depth = [0, 0, 0];
  const sinT = Math.sqrt(Math.max(0, 1 - mu * mu));
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const px = sinT * t,
      py = r + mu * t;
    const h = Math.max(0, Math.hypot(px, py) - Rg);
    const rd = Math.exp(-h / 8),
      md = Math.exp(-h / 1.2),
      od = Math.max(0, 1 - Math.abs(h - 25) / 15);
    for (let k = 0; k < 3; k++)
      depth[k] += (RAYLEIGH[k] * rd + 4.44e-3 * md + OZONE[k] * od) * dt;
  }
  return out.setRGB(
    Math.exp(-depth[0]) * visible,
    Math.exp(-depth[1]) * visible,
    Math.exp(-depth[2]) * visible,
  );
}
