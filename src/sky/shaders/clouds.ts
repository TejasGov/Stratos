import { ATMOSPHERE_GLSL } from "./atmosphere";

/**
 * Cloud density model (after Schneider's Nubis, Hillaire's Frostbite clouds
 * and takram's three-clouds). Positions are world metres; altitude is the
 * curved-planet height.
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

const float CLOUD_BOTTOM = 1250.0;
const float CLOUD_TOP = 10500.0;
const float CLOUD_EXTINCTION = 0.13;

float remapc(float v, float a, float b, float c, float d) {
  return clamp(c + (v - a) / (b - a) * (d - c), min(c, d), max(c, d));
}

struct CloudWeather { float coverage; float type; float base; float top; };

CloudWeather cloudWeather(vec2 xz) {
  vec4 big = texture(tWeather, (xz + uWeatherOffset) / 96000.0);
  vec4 local = texture(tWeather, (xz + uWeatherOffset * 1.15) / 34000.0 + vec2(0.31, 0.77));
  float systems = big.r;
  // Stormier presets widen the storm systems as well as strengthening them.
  float storm = smoothstep(0.8 - 0.4 * uStorm, 0.95 - 0.35 * uStorm, big.b) * uStorm;
  // Weather systems shift the local threshold, clustering cells into fields and clear lanes.
  float threshold = 0.92 - uCoverage * 0.62 + (0.5 - systems) * 0.38 - storm * 0.3;
  float x = local.g * 0.85 + local.a * 0.15;
  CloudWeather w;
  // Coverage stays below 1 inside cells so the shape noise can carve cauliflower edges.
  w.coverage = clamp(smoothstep(threshold, threshold + 0.22, x) * 0.56 + storm * 0.2, 0.0, 1.0);
  float core = smoothstep(threshold + 0.1, threshold + 0.35, x);
  w.type = clamp(core * (0.2 + 0.5 * uCoverage) * smoothstep(0.4, 0.8, systems) +
    storm * 0.95 * smoothstep(threshold, threshold + 0.3, x), 0.0, 1.0);
  w.base = mix(CLOUD_BOTTOM + 200.0, CLOUD_BOTTOM, w.type);
  w.top = w.base + mix(1100.0, CLOUD_TOP - CLOUD_BOTTOM, pow(w.type, 1.4));
  return w;
}

float heightFraction(float h, CloudWeather w) {
  return (h - w.base) / max(w.top - w.base, 1.0);
}

/** Flat bases, rounded domes; storm cells keep their width up to a sheared anvil. */
float heightProfile(float hf, float type) {
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  float bias = mix(0.45, 0.9, type);
  float dome = 1.0 - pow(clamp(2.0 * pow(hf, bias) - 1.0, -1.0, 1.0), 2.0);
  float bottom = smoothstep(0.0, 0.06, hf);
  float anvil = smoothstep(0.8, 0.9, hf) * (1.0 - smoothstep(0.95, 1.0, hf)) * smoothstep(0.75, 1.0, type);
  return max(dome * bottom, anvil);
}

float cloudDensity(vec3 p, float h, CloudWeather w, bool detail) {
  float hf = heightFraction(h, w);
  float profile = heightProfile(hf, w.type);
  if (profile <= 0.0 || w.coverage <= 0.01) return 0.0;
  // Anvils shear downwind and spread with height.
  vec3 sp = vec3(p.x, h, p.z) + uShapeOffset + vec3(hf * hf * 1400.0, 0.0, hf * 400.0);
  vec4 n = texture(tShape, sp / 4600.0);
  float fbm = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float base = remapc(n.r, -(1.0 - fbm), 1.0, 0.0, 1.0);
  float coverage = clamp(w.coverage * profile + smoothstep(0.8, 0.95, hf) * w.type * 0.2, 0.0, 1.0);
  float d = remapc(base, 1.0 - coverage, 1.0, 0.0, 1.0) * coverage;
  if (d <= 0.0) return 0.0;
  if (detail) {
    vec3 dn = texture(tDetail, (sp + uShapeOffset * 0.5) / 520.0).rgb;
    float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    // Wispy bottoms, billowing tops.
    float erosion = mix(dfbm, 1.0 - dfbm, clamp(hf * 5.0, 0.0, 1.0));
    d = remapc(d, erosion * 0.36, 1.0, 0.0, 1.0);
  }
  return d * uDensity * mix(1.0, 1.5, w.type);
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

/**
 * Checkerboard raymarch: each texel traces one of the four pixels of its 2×2
 * block in the resolve target (HZD-style), writing scattered light,
 * transmittance and the transmittance-weighted cloud depth in kilometres.
 */
export const CLOUD_MARCH = /* glsl */ `
${ATMOSPHERE_GLSL}
${CLOUD_DENSITY_GLSL}
uniform sampler2D tTransmittance;
uniform sampler2D tSkyView;
uniform sampler2D tDepth;
uniform mat4 uRayMatrix;
uniform vec2 uResolveSize;
uniform vec2 uOffset;
uniform mat4 uProjectionInverse;
uniform vec3 uSunDir;
uniform float uSunIlluminance;
uniform float uFrame;
uniform float uMaxSteps;
uniform float uMaxDistance;
uniform float uLightning;
uniform vec3 uLightningPos;
uniform float uRain;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

float sceneDistance(vec2 uv) {
  float d = texture(tDepth, uv).x;
  if (d >= 1.0) return 1e9;
  vec4 v = uProjectionInverse * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return length(v.xyz / v.w);
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/** Three-lobe Henyey-Greenstein (Skybolt's fit to Bouthors), eccentricity scaled per octave. */
float cloudPhase(float c, float k) {
  // A stronger forward lobe than the fit gives backlit edges their silver lining.
  return 0.5 * hgPhase(-0.2 * k, c) + 0.5 * hgPhase(0.3 * k, c) + 0.22 * hgPhase(0.86 * k, c);
}

void main() {
  vec2 pixel = floor(gl_FragCoord.xy) * 2.0 + uOffset + 0.5;
  vec2 uv = pixel / uResolveSize;
  vec4 ray = uRayMatrix * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(ray.xyz / ray.w);
  float limit = min(sceneDistance(uv), uMaxDistance);
  float camAlt = uCameraWorld.y;
  float hc = camAlt * 0.001, hb = CLOUD_BOTTOM * 0.001, ht = CLOUD_TOP * 0.001;
  float tStart = 0.0, tEnd = -1.0;
  float b0, b1, u0, u1, g0, g1;
  bool hitBottom = shellRoots(hc, hb, rd.y, b0, b1);
  bool hitTop = shellRoots(hc, ht, rd.y, u0, u1);
  bool hitGround = shellRoots(hc, 0.0, rd.y, g0, g1) && g0 > 0.0;
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
  vec3 skyTop = texture(tSkyView, vec2(0.5, 1.0)).rgb * uSunIlluminance;
  vec3 skyHorizon = (texture(tSkyView, vec2(0.25, 0.53)).rgb + texture(tSkyView, vec2(0.75, 0.53)).rgb) * 0.5 * uSunIlluminance;
  vec3 skyAmbient = (skyTop * 0.6 + skyHorizon * 0.4) * 1.25;
  float jitter = fract(ign(gl_FragCoord.xy + uOffset * 17.0) + uFrame * 0.61803398875);
  if (tEnd > tStart) {
    float cosSun = dot(rd, uSunDir);
    vec3 sea = vec3(0.04, 0.07, 0.09) * uSunIlluminance * max(uSunDir.y, 0.0) * 0.12 + skyTop * 0.08;
    float t = tStart + clamp(40.0 + tStart * 0.006, 40.0, 500.0) * jitter;
    bool coarse = true;
    int zero = 0;
    for (int i = 0; i < 256; i++) {
      if (float(i) >= uMaxSteps || t >= tEnd || transmittance < 0.01) break;
      float dt = clamp(40.0 + t * 0.006, 40.0, 500.0);
      vec3 p = uCameraWorld + rd * t;
      float h = curvedAltitude(camAlt, rd.y, t);
      CloudWeather w = cloudWeather(p.xz);
      if (coarse) {
        if (cloudDensity(p, h, w, false) > 0.0) {
          coarse = false;
          zero = 0;
          t = max(tStart, t - dt * 1.5);
          continue;
        }
        t += dt * 3.0;
        continue;
      }
      float d = cloudDensity(p, h, w, t < 30000.0) * smoothstep(0.0, 80.0, t);
      if (d <= 0.0) {
        zero++;
        if (zero > 6) coarse = true;
        t += dt;
        continue;
      }
      zero = 0;
      // Secondary march toward the sun: geometric segments, detail only near the sample.
      float tau = 0.0, ls = 50.0, lt = 25.0;
      for (int j = 0; j < 6; j++) {
        vec3 lp = p + uSunDir * lt;
        float lh = h + uSunDir.y * lt;
        tau += cloudDensity(lp, lh, cloudWeather(lp.xz), j < 2) * ls;
        lt += ls * 1.5;
        ls *= 2.0;
      }
      tau *= CLOUD_EXTINCTION;
      float sigmaT = d * CLOUD_EXTINCTION;
      // Planet-frame position keeps the Earth-shadow terminator right for distant cells.
      vec3 planetP = vec3(0.0, 6360.0 + hc, 0.0) + rd * (t * 0.001);
      vec3 sun = sunTransmittance(tTransmittance, planetP, uSunDir) * uSunIlluminance;
      float hf = clamp(heightFraction(h, w), 0.0, 1.0);
      float ms = 0.0, a = 1.0, bb = 1.0, cc = 1.0;
      for (int o = 0; o < 6; o++) {
        ms += bb * exp(-tau * a) * cloudPhase(cosSun, cc);
        a *= 0.5; bb *= 0.5; cc *= 0.5;
      }
      float powder = 1.0 - 0.75 * exp(-sigmaT * 150.0);
      vec3 ambient = mix(sea, skyAmbient, hf * 0.65 + 0.35) * (0.55 + 0.45 * hf);
      // 1.5× compensates for the octaves truncated from the multiple-scattering series.
      vec3 S = (sun * ms * powder * 1.5 + ambient) * sigmaT;
      if (uLightning > 0.0) {
        // The discharge lights the cell from inside: inverse-square with a soft
        // core, attenuated by the cloud it has to scatter through.
        float ld = distance(p, uLightningPos);
        S += vec3(0.75, 0.82, 1.0) * uLightning * sigmaT * 5e6 / (ld * ld + 1e6) * exp(-ld * 0.00025);
      }
      float sampleT = exp(-sigmaT * dt);
      scattered += transmittance * (S - S * sampleT) / max(sigmaT, 1e-7);
      float before = transmittance;
      transmittance *= sampleT;
      depthSum += t * (before - transmittance);
      depthWeight += before - transmittance;
      t += dt;
    }
  }
  // Rain shafts hanging from cumulonimbus bases: a short march through the
  // sub-cloud layer, composited in front of or behind the deck.
  if (uRain > 0.0) {
    float r0 = 0.0, r1 = 0.0;
    if (hc < hb) r1 = hitBottom ? b1 * 1000.0 : 0.0;
    else if (hitBottom && b0 > 0.0) { r0 = b0 * 1000.0; r1 = b1 * 1000.0; }
    if (hitGround) r1 = min(r1, g0 * 1000.0);
    r1 = min(min(r1, limit), r0 + 45000.0);
    if (r1 > r0) {
      const int RAIN_STEPS = 12;
      float seg = (r1 - r0) / float(RAIN_STEPS);
      float rainT = 1.0, rainDepth = 0.0, rainWeight = 0.0;
      vec3 rainS = vec3(0.0);
      vec3 planetC = vec3(0.0, 6360.0 + hc, 0.0);
      for (int i = 0; i < RAIN_STEPS; i++) {
        float t = r0 + (float(i) + jitter) * seg;
        vec3 p = uCameraWorld + rd * t;
        float h = curvedAltitude(camAlt, rd.y, t);
        if (h > CLOUD_BOTTOM || h < 0.0) continue;
        // Drops fall on a slant downwind of their cell.
        vec2 q = p.xz - vec2(1.0, 0.3) * (CLOUD_BOTTOM - h) * 0.35;
        CloudWeather w = cloudWeather(q);
        float rain = smoothstep(0.5, 0.85, w.type) * smoothstep(0.3, 0.5, w.coverage);
        if (rain <= 0.0) continue;
        float curtain = texture(tShape, vec3(q.x, h * 0.3, q.y) / 2600.0 + uShapeOffset / 4600.0).g;
        float sigma = rain * uRain * 0.9e-3 * smoothstep(0.4, 0.8, curtain);
        float stepT = exp(-sigma * seg);
        vec3 sun = sunTransmittance(tTransmittance, planetC + rd * (t * 0.001), uSunDir) * uSunIlluminance;
        vec3 L = skyAmbient * 0.3 + sun * 0.025;
        if (uLightning > 0.0) {
          float ld = distance(p, uLightningPos);
          L += vec3(0.75, 0.82, 1.0) * uLightning * 5e6 / (ld * ld + 1e6) * exp(-ld * 0.00025) * 0.08;
        }
        rainS += rainT * L * (1.0 - stepT);
        rainDepth += t * rainT * (1.0 - stepT);
        rainWeight += rainT * (1.0 - stepT);
        rainT *= stepT;
      }
      // Below the deck the rain is in front of the clouds; from above it is behind them.
      if (hc < hb) scattered = rainS + rainT * scattered;
      else scattered += transmittance * rainS;
      transmittance *= rainT;
      // Rain only defines the layer's depth where there is no cloud: mixing it
      // into cloud depth would break the depth-aware upsample at cloud edges.
      if (depthWeight <= 1e-4 && rainWeight > 1e-4) {
        depthSum = rainDepth;
        depthWeight = rainWeight;
      }
    }
  }
  float depth = depthWeight > 1e-4 ? depthSum / depthWeight : (tEnd > tStart ? tEnd : uMaxDistance);
  outColor = vec4(scattered, transmittance);
  // Kilometres: metre distances overflow half-float storage.
  outDepth = vec4(depth * 0.001, limit * 0.001, 0.0, 1.0);
}`;

/**
 * Temporal resolve at the cloud output resolution. One pixel of every 2×2 block
 * is freshly traced each frame; the rest reproject history with the block's
 * mean cloud depth, clipped to the statistics of the fresh neighbourhood.
 */
export const CLOUD_RESOLVE = /* glsl */ `
uniform sampler2D tCurrent;
uniform sampler2D tCurrentDepth;
uniform sampler2D tHistory;
uniform sampler2D tHistoryDepth;
uniform mat4 uRayMatrix;
uniform mat4 uPreviousViewProjection;
uniform vec3 uCameraDelta;
uniform vec2 uResolution;
uniform vec2 uOffset;
uniform float uReset;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outDepth;

vec4 clipAabb(vec4 h, vec4 mn, vec4 mx) {
  vec4 c = 0.5 * (mx + mn), e = 0.5 * (mx - mn) + 1e-4;
  vec4 v = h - c;
  vec4 u = abs(v / e);
  float m = max(max(u.x, u.y), max(u.z, u.w));
  return m > 1.0 ? c + v / m : h;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 lowSize = textureSize(tCurrent, 0);
  // March texel i traced resolve pixel 2i + offset: map this pixel into march space.
  vec2 marchCoord = (vec2(p) - uOffset) * 0.5;
  ivec2 lo = clamp(ivec2(floor(marchCoord + 0.5)), ivec2(0), lowSize - 1);
  bool fresh = all(equal(p, lo * 2 + ivec2(uOffset)));
  vec4 exact = texelFetch(tCurrent, lo, 0);
  vec4 smoothCurrent = texture(tCurrent, (marchCoord + 0.5) / vec2(lowSize));
  vec4 current = fresh ? exact : smoothCurrent;
  vec4 depthInfo = texelFetch(tCurrentDepth, lo, 0);
  vec2 uv = (vec2(p) + 0.5) / uResolution;
  vec4 ray = uRayMatrix * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(ray.xyz / ray.w);
  vec3 rel = rd * depthInfo.x * 1000.0 + uCameraDelta;
  vec4 clip = uPreviousViewProjection * vec4(rel, 1.0);
  vec2 previous = clip.xy / clip.w * 0.5 + 0.5;
  vec4 m1 = vec4(0.0), m2 = vec4(0.0);
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec4 s = texelFetch(tCurrent, clamp(lo + ivec2(x, y), ivec2(0), lowSize - 1), 0);
    m1 += s;
    m2 += s * s;
  }
  vec4 mean = m1 / 9.0;
  vec4 sd = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
  bool valid = uReset < 0.5 && clip.w > 0.0 && all(greaterThanEqual(previous, vec2(0.0))) &&
    all(lessThanEqual(previous, vec2(1.0)));
  if (!valid) {
    outColor = smoothCurrent;
    outDepth = depthInfo;
    return;
  }
  vec4 history = texture(tHistory, previous);
  float limitPrev = texture(tHistoryDepth, previous).y;
  float occlusionChange = abs(limitPrev - depthInfo.y) / max(min(limitPrev, depthInfo.y), 0.01);
  history = clipAabb(history, mean - sd * 1.8, mean + sd * 1.8);
  float blend = fresh ? 0.3 : 0.06;
  blend = max(blend, clamp(occlusionChange * 2.0, 0.0, 1.0) * 0.8);
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
  float dt = (t1 - t0) / 20.0;
  for (int i = 0; i < 20; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 p = vec3(xz.x, 0.0, xz.y) + sun * t;
    od += cloudDensity(p, p.y, cloudWeather(p.xz), false) * dt;
  }
  outColor = vec4(exp(-od * CLOUD_EXTINCTION * 0.5), 0.0, 0.0, 1.0);
}`;
