import { ATMOSPHERE_GLSL } from "./atmosphere";

/**
 * Cloud density model (after Schneider's Nubis and Hillaire's Frostbite
 * clouds). Positions are world metres; altitude is the curved-planet height.
 */
export const CLOUD_DENSITY_GLSL = /* glsl */ `
uniform sampler2D tWeather;
uniform highp sampler3D tShape;
uniform highp sampler3D tDetail;
uniform float uCoverage;
uniform float uStorm;
uniform float uDensity;
uniform vec2 uWeatherOffset;
uniform vec3 uShapeOffset;
uniform vec3 uCameraWorld;

const float CLOUD_BOTTOM = 1300.0;
const float CLOUD_TOP = 9500.0;
const float CLOUD_EXTINCTION = 0.055;

float remapc(float v, float a, float b, float c, float d) {
  return clamp(c + (v - a) / (b - a) * (d - c), min(c, d), max(c, d));
}

struct CloudWeather { float coverage; float type; float top; float base; };

CloudWeather cloudWeather(vec2 xz) {
  vec4 big = texture(tWeather, (xz + uWeatherOffset) / 72000.0);
  vec4 local = texture(tWeather, (xz + uWeatherOffset * 1.15) / 14000.0 + vec2(0.31, 0.77));
  float systems = big.r;
  float storm = big.b * uStorm;
  float cells = local.g;
  float c = cells * 0.75 + systems * 0.55 + local.a * 0.12 - 0.42;
  CloudWeather w;
  w.coverage = clamp(remapc(c, 1.0 - uCoverage * 1.25, 1.05, 0.0, 1.0) + storm * 0.9, 0.0, 1.0);
  w.type = clamp(systems * 0.55 * (0.4 + uCoverage) + storm + cells * 0.15 - 0.12, 0.0, 1.0);
  w.base = mix(CLOUD_BOTTOM + 250.0, CLOUD_BOTTOM, w.type);
  w.top = w.base + mix(900.0, CLOUD_TOP - CLOUD_BOTTOM, pow(w.type, 1.6));
  return w;
}

float heightFraction(float h, CloudWeather w) {
  return (h - w.base) / max(w.top - w.base, 1.0);
}

/** Rounded cumulus bottoms, billowing tops, anvils for towering storm cells. */
float heightProfile(float hf, float type) {
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  float bottom = smoothstep(0.0, mix(0.12, 0.05, type), hf);
  float top = 1.0 - smoothstep(mix(0.3, 0.75, type), 1.0, hf);
  float anvil = smoothstep(0.78, 0.92, hf) * (1.0 - smoothstep(0.96, 1.0, hf)) * smoothstep(0.7, 1.0, type);
  return max(bottom * top, anvil * 1.1);
}

float cloudDensity(vec3 p, float h, CloudWeather w, bool detail) {
  float hf = heightFraction(h, w);
  float profile = heightProfile(hf, w.type);
  if (profile <= 0.0 || w.coverage <= 0.01) return 0.0;
  // Anvils shear downwind and widen with height.
  vec3 sp = vec3(p.x, h, p.z) + uShapeOffset + vec3(hf * hf * 900.0, 0.0, hf * 300.0);
  vec4 n = texture(tShape, sp / 5200.0);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float base = remapc(n.r, -(1.0 - fbm), 1.0, 0.0, 1.0);
  float coverage = clamp(w.coverage + smoothstep(0.75, 1.0, hf) * w.type * 0.25, 0.0, 1.0);
  base = remapc(base * profile, 1.0 - coverage, 1.0, 0.0, 1.0) * coverage;
  if (base <= 0.0) return 0.0;
  if (detail) {
    vec3 dn = texture(tDetail, (sp + uShapeOffset * 0.6) / 780.0).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    float erosion = mix(dfbm, 1.0 - dfbm, clamp(hf * 6.0, 0.0, 1.0));
    base = remapc(base, erosion * 0.38, 1.0, 0.0, 1.0);
  }
  return base * uDensity * mix(1.0, 1.6, w.type);
}

/** Height of a ray sample over the curved planet (t << planet radius). */
float curvedAltitude(float camAlt, float dy, float t) {
  return camAlt + dy * t + t * t * (1.0 - dy * dy) / (2.0 * 6360000.0);
}

/** Stable ray/sphere roots for a sphere of planet radius + hs seen from altitude hc (km). */
bool shellRoots(float hcKm, float hsKm, float dy, out float t0, out float t1) {
  float rc = 6360.0 + hcKm;
  float b = rc * dy;
  float c = (hcKm - hsKm) * (2.0 * 6360.0 + hcKm + hsKm);
  float d = b * b - c;
  if (d < 0.0) return false;
  float q = -(b + (b >= 0.0 ? 1.0 : -1.0) * sqrt(d));
  float ra = q, rb = abs(q) > 1e-9 ? c / q : 0.0;
  t0 = min(ra, rb);
  t1 = max(ra, rb);
  return true;
}
`;

/** Half/third resolution raymarch, writing scattered light + transmittance and a mean depth. */
export const CLOUD_MARCH = /* glsl */ `
${ATMOSPHERE_GLSL}
${CLOUD_DENSITY_GLSL}
uniform sampler2D tTransmittance;
uniform sampler2D tSkyView;
uniform sampler2D tDepth;
uniform mat4 uRayMatrix;
uniform vec2 uResolution;
uniform vec2 uClip;
uniform mat4 uProjectionInverse;
uniform vec3 uSunDir;
uniform float uSunIlluminance;
uniform float uFrame;
uniform float uMaxSteps;
uniform float uMaxDistance;
uniform float uLightning;
uniform vec3 uLightningPos;
uniform float uSunScale;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

float sceneDistance(vec2 uv, vec3 rayView) {
  float d = texture(tDepth, uv).x;
  if (d >= 1.0) return 1e9;
  float z = d * 2.0 - 1.0;
  vec4 v = uProjectionInverse * vec4(uv * 2.0 - 1.0, z, 1.0);
  return length(v.xyz / v.w);
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

float phaseDual(float c, float k) {
  return mix(hgPhase(0.8 * k, c), hgPhase(-0.3 * k, c), 0.3);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 ray = uRayMatrix * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(ray.xyz / ray.w);
  vec4 rv = uProjectionInverse * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  float limit = min(sceneDistance(uv, normalize(rv.xyz / rv.w)), uMaxDistance);
  float camAlt = uCameraWorld.y;
  float hc = camAlt * 0.001, hb = CLOUD_BOTTOM * 0.001, ht = CLOUD_TOP * 0.001;
  float tStart = 0.0, tEnd = -1.0;
  float b0, b1, u0, u1;
  bool hitBottom = shellRoots(hc, hb, rd.y, b0, b1);
  bool hitTop = shellRoots(hc, ht, rd.y, u0, u1);
  float ground0, ground1;
  bool hitGround = shellRoots(hc, 0.0, rd.y, ground0, ground1) && ground0 > 0.0;
  if (hc < hb) {
    if (!hitGround && hitTop) { tStart = b1 * 1000.0; tEnd = u1 * 1000.0; }
  } else if (hc <= ht) {
    tStart = 0.0;
    tEnd = hitTop ? u1 * 1000.0 : 0.0;
    if (hitBottom && b0 > 0.0) tEnd = b0 * 1000.0;
  } else if (hitTop && u0 > 0.0) {
    tStart = u0 * 1000.0;
    tEnd = (hitBottom && b0 > 0.0) ? b0 * 1000.0 : u1 * 1000.0;
  }
  tEnd = min(tEnd, limit);
  vec3 scattered = vec3(0.0);
  float transmittance = 1.0;
  float depthSum = 0.0, depthWeight = 0.0;
  if (tEnd > tStart) {
    float cosSun = dot(rd, uSunDir);
    vec3 skyTop = texture(tSkyView, vec2(0.5, 1.0)).rgb * uSunIlluminance;
    vec3 skyHorizon = texture(tSkyView, vec2(0.25, 0.55)).rgb * uSunIlluminance;
    float sunUp = clamp(uSunDir.y * 4.0 + 0.2, 0.0, 1.0);
    vec3 groundBounce = vec3(0.05, 0.07, 0.08) * uSunIlluminance * max(uSunDir.y, 0.0) * 0.35;
    float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.61803398875);
    float t = tStart;
    float baseStep = clamp((tEnd - tStart) / uMaxSteps, 30.0, 600.0);
    t += baseStep * jitter;
    float empty = 0.0;
    for (int i = 0; i < 200; i++) {
      if (float(i) >= uMaxSteps || t >= tEnd || transmittance < 0.015) break;
      float step = clamp(max(baseStep, t * 0.006), 30.0, 900.0);
      vec3 p = uCameraWorld + rd * t;
      float h = curvedAltitude(camAlt, rd.y, t);
      CloudWeather w = cloudWeather(p.xz);
      float d = cloudDensity(p, h, w, true);
      if (d <= 0.0) {
        empty += 1.0;
        t += step * (empty > 3.0 ? 2.2 : 1.0);
        continue;
      }
      empty = 0.0;
      // Light march toward the sun with geometrically growing steps.
      float od = 0.0;
      float ls = 45.0, lt = ls * 0.5;
      for (int j = 0; j < 6; j++) {
        vec3 lp = p + uSunDir * lt;
        float lh = h + uSunDir.y * lt;
        od += cloudDensity(lp, lh, cloudWeather(lp.xz), j < 2) * ls;
        lt += ls * 1.5;
        ls *= 2.0;
      }
      od *= CLOUD_EXTINCTION;
      float sigmaT = d * CLOUD_EXTINCTION;
      // Planet-frame position keeps the Earth-shadow terminator correct for distant cells.
      vec3 planetP = vec3(0.0, 6360.0 + hc, 0.0) + rd * (t * 0.001);
      vec3 sunColor = sunTransmittance(tTransmittance, planetP, uSunDir) * uSunIlluminance;
      float hf = clamp(heightFraction(h, w), 0.0, 1.0);
      float ms = 0.0, a = 1.0, bb = 1.0, cc = 1.0;
      for (int o = 0; o < 4; o++) {
        ms += bb * phaseDual(cosSun, cc) * exp(-od * a);
        a *= 0.42; bb *= 0.55; cc *= 0.6;
      }
      // Powder: thin edges facing away from the sun lose in-scattered light.
      float powder = mix(1.0, 1.0 - exp(-sigmaT * 140.0), clamp(0.5 - 0.5 * cosSun, 0.0, 1.0) * 0.85);
      vec3 ambient = mix(groundBounce + skyHorizon * 0.2, skyTop * 1.1 + skyHorizon * 0.25, hf);
      ambient *= mix(0.35, 1.0, sunUp * 0.5 + 0.5) * (1.0 - 0.45 * exp(-hf * 3.0) * d);
      vec3 S = sunColor * ms * powder * uSunScale + ambient;
      if (uLightning > 0.0) {
        float ld = distance(p, uLightningPos);
        S += vec3(0.75, 0.82, 1.0) * uLightning * 2.2e7 / (ld * ld + 2e5) * exp(-ld * 0.0006);
      }
      S *= sigmaT;
      float sampleT = exp(-sigmaT * step);
      vec3 integral = (S - S * sampleT) / max(sigmaT, 1e-6);
      scattered += transmittance * integral;
      float before = transmittance;
      transmittance *= sampleT;
      depthSum += t * (before - transmittance);
      depthWeight += before - transmittance;
      t += step;
    }
  }
  float depth = depthWeight > 1e-4 ? depthSum / depthWeight : (tEnd > tStart ? tEnd : uMaxDistance);
  outColor = vec4(scattered, transmittance);
  outDepth = vec4(depth, limit, 0.0, 1.0);
}`;

/** Temporal accumulation: reproject history with the mean cloud depth, clamp to neighbours. */
export const CLOUD_RESOLVE = /* glsl */ `
uniform sampler2D tCurrent;
uniform sampler2D tCurrentDepth;
uniform sampler2D tHistory;
uniform sampler2D tHistoryDepth;
uniform mat4 uRayMatrix;
uniform mat4 uPreviousViewProjection;
uniform vec3 uCameraDelta;
uniform vec2 uResolution;
uniform float uReset;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec4 current = texture(tCurrent, uv);
  vec4 depthInfo = texture(tCurrentDepth, uv);
  vec4 ray = uRayMatrix * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(ray.xyz / ray.w);
  // Position relative to the previous camera, then previous clip space.
  vec3 rel = rd * min(depthInfo.x, 2e6) + uCameraDelta;
  vec4 clip = uPreviousViewProjection * vec4(rel, 1.0);
  vec2 previous = clip.xy / clip.w * 0.5 + 0.5;
  vec4 minC = current, maxC = current;
  vec2 texel = 1.0 / uResolution;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec4 s = texture(tCurrent, uv + vec2(float(x), float(y)) * texel);
    minC = min(minC, s);
    maxC = max(maxC, s);
  }
  bool valid = uReset < 0.5 && clip.w > 0.0 && all(greaterThanEqual(previous, vec2(0.0))) &&
    all(lessThanEqual(previous, vec2(1.0)));
  vec4 history = valid ? texture(tHistory, previous) : current;
  // Loosen the clamp slightly so temporal noise can still converge.
  vec4 pad = (maxC - minC) * 0.25;
  history = clamp(history, minC - pad, maxC + pad);
  float limitPrev = valid ? texture(tHistoryDepth, previous).y : depthInfo.y;
  float occlusionChange = abs(limitPrev - depthInfo.y) / max(depthInfo.y, 1.0);
  float blend = valid ? mix(0.1, 0.6, clamp(occlusionChange * 4.0, 0.0, 1.0)) : 1.0;
  outColor = mix(history, current, blend);
  outDepth = depthInfo;
}`;

/** Top-down sun transmittance through the cloud deck, sampled by ground and ocean. */
export const CLOUD_SHADOW = /* glsl */ `
${CLOUD_DENSITY_GLSL}
uniform vec2 uShadowCenter;
uniform float uShadowExtent;
uniform vec3 uSunDir;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / 256.0;
  vec2 xz = uShadowCenter + (uv - 0.5) * uShadowExtent;
  vec3 sun = normalize(vec3(uSunDir.x, max(uSunDir.y, 0.06), uSunDir.z));
  float od = 0.0;
  float t0 = CLOUD_BOTTOM / sun.y, t1 = (CLOUD_BOTTOM + 6500.0) / sun.y;
  float dt = (t1 - t0) / 18.0;
  for (int i = 0; i < 18; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 p = vec3(xz.x, 0.0, xz.y) + sun * t;
    od += cloudDensity(p, p.y, cloudWeather(p.xz), false) * dt;
  }
  outColor = vec4(exp(-od * CLOUD_EXTINCTION * 0.6), 0.0, 0.0, 1.0);
}`;
