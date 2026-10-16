/**
 * Physically based atmosphere (Hillaire 2020, "A Scalable and Production Ready
 * Sky and Atmosphere Rendering Technique"), using Bruneton's transmittance
 * parametrization. Distances inside these functions are kilometres and every
 * position lives in a camera-centred planet frame: the planet centre is
 * directly below the camera, so (0, Rg + altitude, 0) is the viewer.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
#ifndef STRATOS_ATMOSPHERE
#define STRATOS_ATMOSPHERE
#define PI 3.14159265358979
const float Rg = 6360.0;
const float Rt = 6460.0;
const vec3 RAYLEIGH_SCATTER = vec3(5.802, 13.558, 33.1) * 1e-3;
const float RAYLEIGH_H = 8.0;
const float MIE_SCATTER = 3.996e-3;
const float MIE_EXTINCT = 4.440e-3;
const float MIE_H = 1.2;
const vec3 OZONE_ABSORB = vec3(0.650, 1.881, 0.085) * 1e-3;
const float MIE_G = 0.8;
const float GROUND_ALBEDO = 0.12;

void atmosphereAt(float h, out vec3 rayleigh, out float mie, out vec3 extinction) {
  h = max(h, 0.0);
  float rd = exp(-h / RAYLEIGH_H);
  float md = exp(-h / MIE_H);
  float od = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  rayleigh = RAYLEIGH_SCATTER * rd;
  mie = MIE_SCATTER * md;
  extinction = rayleigh + MIE_EXTINCT * md + OZONE_ABSORB * od;
}

/** Nearest non-negative hit of a ray starting at ro, or -1. */
float raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  if (c > 0.0 && b > 0.0) return -1.0;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d;
  return t0 >= 0.0 ? t0 : -b + d;
}

float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float hgPhase(float g, float c) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float miePhase(float c) {
  // Cornette-Shanks keeps a small backscatter lobe compared with pure HG.
  float g = MIE_G, g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) /
    ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

vec2 transmittanceUv(float r, float mu) {
  float H = sqrt(Rt * Rt - Rg * Rg);
  float rho = sqrt(max(0.0, r * r - Rg * Rg));
  float disc = r * r * (mu * mu - 1.0) + Rt * Rt;
  float d = max(0.0, -r * mu + sqrt(max(0.0, disc)));
  float dmin = Rt - r, dmax = rho + H;
  return vec2((d - dmin) / max(dmax - dmin, 1e-4), rho / H);
}

vec3 transmittanceLut(sampler2D lut, float r, float mu) {
  return texture(lut, transmittanceUv(clamp(r, Rg, Rt), mu)).rgb;
}

/** Sun transmittance including a soft Earth-shadow terminator. */
vec3 sunTransmittance(sampler2D lut, vec3 p, vec3 sunDir) {
  float r = length(p);
  float mu = dot(p / r, sunDir);
  float horizon = -sqrt(max(0.0, 1.0 - (Rg * Rg) / (r * r)));
  float visible = smoothstep(-0.006, 0.006, mu - horizon);
  return transmittanceLut(lut, r, mu) * visible;
}

vec3 multiScatterLut(sampler2D lut, vec3 p, vec3 sunDir) {
  float r = length(p);
  float mu = dot(p / r, sunDir);
  vec2 uv = vec2(mu * 0.5 + 0.5, clamp((r - Rg) / (Rt - Rg), 0.0, 1.0));
  uv = (uv * 31.0 + 0.5) / 32.0;
  return texture(lut, uv).rgb;
}

/** Inscattered luminance (sun illuminance = 1) and transmittance along a ray segment. */
vec3 integrateScattering(sampler2D tLut, sampler2D msLut, vec3 ro, vec3 rd, vec3 sunDir,
                         float tMax, float steps, out vec3 transmittance) {
  float c = dot(rd, sunDir);
  float pr = rayleighPhase(c), pm = miePhase(c);
  vec3 lum = vec3(0.0);
  transmittance = vec3(1.0);
  float t = 0.0;
  for (float i = 0.0; i < 64.0; i += 1.0) {
    if (i >= steps) break;
    float nt = ((i + 0.3) / steps) * tMax;
    float dt = nt - t;
    t = nt;
    vec3 p = ro + rd * t;
    vec3 rs, ext; float ms;
    atmosphereAt(length(p) - Rg, rs, ms, ext);
    vec3 sampleT = exp(-dt * ext);
    vec3 sunT = sunTransmittance(tLut, p, sunDir);
    vec3 psi = multiScatterLut(msLut, p, sunDir);
    vec3 inScatter = rs * (pr * sunT + psi) + ms * (pm * sunT + psi);
    lum += transmittance * (inScatter - inScatter * sampleT) / max(ext, vec3(1e-7));
    transmittance *= sampleT;
  }
  return lum;
}

/** Horizon dip below the local horizontal for a viewer at radius r. */
float horizonDip(float r) { return acos(clamp(Rg / r, -1.0, 1.0)); }

/** Sky-view LUT lookup: v = 0.5 is the true (dipped) horizon, with quadratic
 * latitude spacing concentrating texels there; azimuth is relative to the sun. */
vec2 skyViewUv(vec3 rd, vec3 sunDir, float r) {
  vec3 up = vec3(0.0, 1.0, 0.0);
  float dip = horizonDip(r);
  float rel = asin(clamp(rd.y, -1.0, 1.0)) + dip;
  float side = rel >= 0.0 ? 0.5 * PI + dip : 0.5 * PI - dip;
  float azimuth = 0.0;
  vec3 flatSun = vec3(sunDir.x, 0.0, sunDir.z);
  if (dot(flatSun, flatSun) < 1e-8) flatSun = vec3(0.0, 0.0, -1.0);
  vec3 forward = normalize(flatSun);
  vec3 right = cross(forward, up);
  vec3 flatDir = vec3(rd.x, 0.0, rd.z);
  if (dot(flatDir, flatDir) > 1e-10) {
    flatDir = normalize(flatDir);
    azimuth = atan(dot(flatDir, right), dot(flatDir, forward));
  }
  float v = 0.5 + 0.5 * sign(rel) * sqrt(min(abs(rel) / side, 1.0));
  // Half-texel inset keeps bilinear lookups away from the clamped borders.
  return vec2(azimuth / (2.0 * PI) + 0.5, (v * 107.0 + 0.5) / 108.0);
}
#endif
`;
