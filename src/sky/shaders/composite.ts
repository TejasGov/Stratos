import { ATMOSPHERE_GLSL } from "./atmosphere";

/**
 * Full-screen composite: analytic curved ocean, sky, sun, moon and stars,
 * aerial perspective for geometry, cloud shadows, and the upsampled clouds.
 */
export const COMPOSITE = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tTransmittance, tMultiScatter, tSkyView, tAerialInscatter, tAerialTransmittance;
uniform sampler2D tClouds, tCloudDepth, tCloudShadow;
uniform vec2 uCloudResolution;
uniform vec2 uShadowCenter;
uniform float uShadowExtent;
uniform mat4 uRayMatrix;
uniform mat4 uProjectionInverse;
uniform mat4 uProjection;
uniform mat4 uViewRotation;
uniform vec3 uCameraGlobal;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunIlluminance;
uniform float uSunDisk;
uniform float uStars;
uniform float uTime;
uniform float uAerialRange;
uniform float uOceanDetail;
uniform float uPixelAngle;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
vec2 noiseGrad(vec2 p) {
  float e = 0.05;
  return vec2(valueNoise(p + vec2(e, 0)) - valueNoise(p - vec2(e, 0)),
              valueNoise(p + vec2(0, e)) - valueNoise(p - vec2(0, e))) / (2.0 * e);
}

void sampleAerial(vec2 uv, float km, out vec3 inscatter, out vec3 trans) {
  float s = sqrt(clamp(km / uAerialRange, 0.0, 1.0)) * 32.0 - 1.0;
  float x = clamp(uv.x * 32.0, 0.5, 31.5);
  float y = clamp(uv.y, 0.5 / 32.0, 31.5 / 32.0);
  float s0 = clamp(floor(s), 0.0, 31.0), s1 = min(s0 + 1.0, 31.0);
  float f = clamp(s - s0, 0.0, 1.0);
  vec2 a = vec2((s0 * 32.0 + x) / 1024.0, y), b = vec2((s1 * 32.0 + x) / 1024.0, y);
  vec3 i0 = texture(tAerialInscatter, a).rgb, i1 = texture(tAerialInscatter, b).rgb;
  vec3 t0 = texture(tAerialTransmittance, a).rgb, t1 = texture(tAerialTransmittance, b).rgb;
  if (s < 0.0) {
    float w = clamp(s + 1.0, 0.0, 1.0);
    inscatter = i0 * w;
    trans = mix(vec3(1.0), t0, w);
  } else {
    inscatter = mix(i0, i1, f);
    trans = mix(t0, t1, f);
  }
}

/** Aerial perspective toward a surface, switching to LUT ray integrals past the froxel range. */
void surfacePerspective(vec2 uv, vec3 rd, float dist, bool ground, out vec3 inscatter, out vec3 trans) {
  float km = dist * 0.001;
  sampleAerial(uv, km, inscatter, trans);
  float r = 6360.0 + max(uCameraGlobal.y, 1.0) * 0.001;
  if (ground && km > uAerialRange * 0.8) {
    vec3 skyIn = texture(tSkyView, skyViewUv(rd, uSunDir, r)).rgb;
    // T(camera -> ground) from the reversed (upward) rays at both ends.
    float muGround = sqrt(max(0.0, 1.0 - (r * r) / (Rg * Rg) * (1.0 - rd.y * rd.y)));
    vec3 tg = transmittanceLut(tTransmittance, Rg, muGround);
    vec3 tc = transmittanceLut(tTransmittance, r, clamp(-rd.y, 0.0, 1.0));
    vec3 farT = clamp(tg / max(tc, vec3(1e-4)), 0.0, 1.0);
    float w = smoothstep(uAerialRange * 0.8, uAerialRange, km);
    inscatter = mix(inscatter, skyIn, w);
    trans = mix(trans, farT, w);
  }
}

vec3 starField(vec3 rd) {
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float n = layer == 0 ? 180.0 : 420.0;
    vec2 sp = vec2(atan(rd.z, rd.x) / (2.0 * PI) + 0.5, rd.y * 0.5 + 0.5) * vec2(2.0 * n, n);
    vec2 cell = floor(sp);
    for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      c.x = mod(c.x, 2.0 * n);
      float h = hash12(c + float(layer) * 91.7);
      vec2 offset = vec2(hash12(c * 1.7 + 3.1), hash12(c * 2.3 + 7.7));
      vec2 center = (c + offset) / vec2(2.0 * n, n);
      float phi = (center.x - 0.5) * 2.0 * PI;
      float y = center.y * 2.0 - 1.0;
      vec3 dir = vec3(cos(phi) * sqrt(1.0 - y * y), y, sin(phi) * sqrt(1.0 - y * y));
      float ang = acos(clamp(dot(dir, rd), -1.0, 1.0));
      float brightness = pow(h, layer == 0 ? 18.0 : 40.0) * (layer == 0 ? 6.0 : 2.5);
      float spread = uPixelAngle * 0.9;
      float glow = exp(-ang * ang / (spread * spread));
      float twinkle = 0.75 + 0.25 * sin(uTime * (2.0 + h * 9.0) + h * 40.0);
      vec3 tint = mix(vec3(1.0, 0.72, 0.5), vec3(0.65, 0.78, 1.0), hash12(c + 11.0));
      col += tint * brightness * glow * twinkle;
    }
  }
  // Milky Way: a soft, mottled band along a tilted great circle.
  vec3 galactic = normalize(vec3(0.35, 0.62, -0.7));
  float band = exp(-pow(dot(rd, galactic), 2.0) * 14.0);
  vec2 g = vec2(atan(rd.z, rd.x), asin(clamp(rd.y, -1.0, 1.0))) * 6.0;
  float dust = valueNoise(g * 2.0) * 0.6 + valueNoise(g * 5.0) * 0.4;
  col += vec3(0.55, 0.6, 0.75) * band * (0.25 + dust * 0.75) * 0.06 * smoothstep(0.15, 0.6, dust + band * 0.3);
  return col;
}

vec3 moonDisk(vec3 rd) {
  float radius = 0.0095;
  vec3 m = uMoonDir;
  float c = dot(rd, m);
  if (c < cos(radius * 1.4)) return vec3(0.0);
  vec3 right = normalize(cross(m, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, m);
  vec2 q = vec2(dot(rd, right), dot(rd, up)) / radius;
  float rr = dot(q, q);
  float edge = 1.0 - smoothstep(0.92, 1.0, sqrt(rr));
  if (rr >= 1.0) return vec3(0.0);
  vec3 normal = normalize(right * q.x + up * q.y - m * sqrt(max(0.0, 1.0 - rr)));
  float lit = max(dot(normal, uSunDir), 0.0);
  float maria = 0.75 + 0.25 * valueNoise(q * 3.0 + 7.0) - 0.15 * valueNoise(q * 9.0);
  return vec3(1.0, 0.97, 0.92) * (lit * 0.9 + 0.012) * maria * edge * 2.2;
}

vec3 oceanShade(vec3 rd, float tOcean, vec3 sceneColor, float sceneDist, float r, out bool seabed) {
  vec2 xz = uCameraGlobal.xz + rd.xz * tOcean;
  float footprint = tOcean * uPixelAngle;
  vec2 slope = vec2(0.0);
  float lostVariance = 0.0;
  float wind = 0.35;
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float angle = wind + sin(fi * 2.4) * 1.1;
    vec2 dir = vec2(cos(angle), sin(angle));
    float wl = 210.0 * pow(0.6, fi);
    float k = 2.0 * PI / wl;
    float amp = wl * 0.009;
    float omega = sqrt(9.81 * k);
    float phase = k * dot(dir, xz) - omega * uTime + fi * 1.7;
    float fade = smoothstep(2.0, 6.0, wl / max(footprint, 1e-3));
    vec2 g = dir * amp * k * cos(phase);
    slope += g * fade;
    lostVariance += (1.0 - fade) * 0.5 * (amp * k) * (amp * k);
  }
  float near = (1.0 - smoothstep(60.0, 900.0, tOcean)) * uOceanDetail;
  if (near > 0.0) {
    slope += noiseGrad(xz * 0.35 + uTime * vec2(0.25, 0.1)) * 0.035 * near;
    slope += noiseGrad(xz * 1.3 - uTime * vec2(0.1, 0.35)) * 0.018 * near;
  }
  lostVariance += (1.0 - near) * 0.0012;
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 v = -rd;
  float nv = max(dot(n, v), 1e-3);
  float fresnel = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  vec3 rr = reflect(rd, n);
  rr.y = abs(rr.y) + 0.002;
  rr = normalize(rr);
  vec3 sky = texture(tSkyView, skyViewUv(rr, uSunDir, r)).rgb * uSunIlluminance;
  vec3 sunT = transmittanceLut(tTransmittance, r, uSunDir.y) * smoothstep(-0.02, 0.02, uSunDir.y);
  vec3 sun = sunT * uSunIlluminance;
  // GGX sun glitter with roughness widened by the slope variance lost to filtering.
  float alpha2 = clamp(0.0045 + lostVariance * 2.0, 0.0045, 0.4);
  vec3 h = normalize(v + uSunDir);
  float nh = max(dot(n, h), 0.0);
  float nl = max(dot(n, uSunDir), 0.0);
  float dd = nh * nh * (alpha2 - 1.0) + 1.0;
  float D = alpha2 / (PI * dd * dd);
  float k2 = sqrt(alpha2) * 0.5;
  float G = nl / (nl * (1.0 - k2) + k2) * nv / (nv * (1.0 - k2) + k2);
  float Fs = 0.02 + 0.98 * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  vec3 spec = sun * min(D * G * Fs / (4.0 * nv * max(nl, 1e-3)) * nl, 600.0);
  vec3 skyIrr = texture(tSkyView, vec2(0.5, 1.0)).rgb * uSunIlluminance * PI;
  vec3 irr = sun * max(uSunDir.y, 0.0) + skyIrr;
  vec3 deep = vec3(0.012, 0.05, 0.085) / PI * irr;
  // Thin wave crests pick up light scattered through the water (subsurface tint).
  deep += vec3(0.02, 0.12, 0.11) / PI * sun * pow(max(dot(rd, uSunDir) * 0.5 + 0.5, 0.0), 3.0) *
    clamp(slope.x * 3.0 + 0.3, 0.0, 1.0) * 0.6;
  vec3 body = deep;
  seabed = false;
  if (sceneDist < 1e8 && sceneDist > tOcean) {
    float path = sceneDist - tOcean;
    float vertical = max(0.0, -(uCameraGlobal.y + rd.y * sceneDist));
    vec3 absorb = exp(-vec3(0.42, 0.075, 0.05) * path);
    float scatter = 1.0 - exp(-0.09 * path);
    body = sceneColor * absorb + deep * scatter;
    // Shore foam: breaking bands near the waterline, broken up by noise.
    float foamNoise = valueNoise(xz * 0.22 + uTime * 0.2) * 0.6 + valueNoise(xz * 0.9) * 0.4;
    float bands = 0.5 + 0.5 * sin(vertical * 4.5 - uTime * 1.6 + foamNoise * 3.0);
    float foam = (1.0 - smoothstep(0.0, 2.2, vertical)) * smoothstep(0.35, 0.8, foamNoise * bands + (1.0 - smoothstep(0.0, 0.6, vertical)) * 0.6);
    body = mix(body, vec3(0.85) / PI * irr, foam * 0.85);
    seabed = true;
  }
  return mix(body, sky, fresnel) + spec;
}

void main() {
  vec2 uv = vUv;
  vec3 scene = texture(tScene, uv).rgb;
  float depth = texture(tDepth, uv).x;
  vec4 ray = uRayMatrix * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(ray.xyz / ray.w);
  vec4 view = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 viewPos = view.xyz / view.w;
  bool geometry = depth < 1.0;
  float sceneDist = geometry ? length(viewPos) : 1e9;
  float alt = max(uCameraGlobal.y, 0.5);
  float r = 6360.0 + alt * 0.001;
  // Curved sea surface: stable near root of the sphere at planet radius.
  float tOcean = -1.0;
  {
    float rc = 6360000.0 + alt;
    float b = rc * rd.y;
    float c = alt * (2.0 * 6360000.0 + alt);
    float d = b * b - c;
    if (rd.y < 0.0 && d >= 0.0) tOcean = c / (-b + sqrt(d));
  }
  vec3 color;
  float outDepth = depth;
  vec3 inscatter, trans;
  if (tOcean > 0.0 && tOcean < sceneDist) {
    bool seabed;
    vec3 water = oceanShade(rd, tOcean, scene, sceneDist, r, seabed);
    vec3 hit = vec3(uCameraGlobal.x, 0.0, uCameraGlobal.z) + rd * tOcean;
    vec2 suv = (hit.xz - uShadowCenter) / uShadowExtent + 0.5;
    float shade = texture(tCloudShadow, clamp(suv, 0.0, 1.0)).r;
    float inside = step(abs(suv.x - 0.5), 0.5) * step(abs(suv.y - 0.5), 0.5);
    water *= mix(1.0, 0.35 + 0.65 * shade, inside);
    surfacePerspective(uv, rd, tOcean, true, inscatter, trans);
    color = water * trans + inscatter * uSunIlluminance;
    vec4 clip = uProjection * vec4((uViewRotation * vec4(rd * min(tOcean, 1e7), 0.0)).xyz, 1.0);
    outDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 0.9999999);
  } else if (geometry) {
    vec3 world = uCameraGlobal + rd * sceneDist;
    vec2 suv = (world.xz - uSunDir.xz / max(uSunDir.y, 0.06) * world.y - uShadowCenter) / uShadowExtent + 0.5;
    float shade = texture(tCloudShadow, clamp(suv, 0.0, 1.0)).r;
    float inside = step(abs(suv.x - 0.5), 0.5) * step(abs(suv.y - 0.5), 0.5) * step(world.y, 1300.0);
    scene *= mix(1.0, 0.3 + 0.7 * shade, inside);
    surfacePerspective(uv, rd, sceneDist, false, inscatter, trans);
    color = scene * trans + inscatter * uSunIlluminance;
  } else {
    color = texture(tSkyView, skyViewUv(rd, uSunDir, r)).rgb * uSunIlluminance;
    vec3 sunT = transmittanceLut(tTransmittance, r, rd.y);
    float c = dot(rd, uSunDir);
    float sunRadius = 0.0047 * uSunDisk;
    if (c > cos(sunRadius * 1.2)) {
      float x = acos(clamp(c, -1.0, 1.0)) / sunRadius;
      float limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - min(x * x, 1.0))));
      float disk = 1.0 - smoothstep(0.92, 1.08, x);
      color += sunT * uSunIlluminance * 2400.0 / (uSunDisk * uSunDisk) * limb * disk;
    }
    float night = uStars;
    if (night > 0.0) color += (starField(rd) * night + moonDisk(rd) * uSunIlluminance * 0.012) * sunT;
    else color += moonDisk(rd) * uSunIlluminance * 0.012 * sunT;
    outDepth = 1.0;
  }

  // Clouds: depth-aware bilateral upsample of the reduced-resolution layer.
  vec2 cp = uv * uCloudResolution - 0.5;
  vec2 base = floor(cp);
  vec2 f = cp - base;
  vec4 cloud = vec4(0.0);
  float cloudDepth = 0.0, weight = 0.0;
  float refDist = tOcean > 0.0 ? min(sceneDist, tOcean) : sceneDist;
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    ivec2 p = ivec2(clamp(base + vec2(float(i), float(j)), vec2(0.0), uCloudResolution - 1.0));
    vec4 c = texelFetch(tClouds, p, 0);
    vec2 dinfo = texelFetch(tCloudDepth, p, 0).xy;
    float bil = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    float lim = min(dinfo.y, 1e9);
    float similarity = 1.0 / (1e-3 + abs(min(refDist, 1.6e5) - min(lim, 1.6e5)) / max(min(refDist, 1.6e5), 1.0));
    float w = bil * similarity + 1e-5;
    cloud += c * w;
    cloudDepth += dinfo.x * w;
    weight += w;
  }
  cloud /= weight;
  cloudDepth /= weight;
  if (cloud.a < 0.999) {
    vec3 ci, ct;
    surfacePerspective(uv, rd, cloudDepth, false, ci, ct);
    vec3 cloudLight = cloud.rgb * ct + ci * uSunIlluminance * (1.0 - cloud.a);
    color = color * cloud.a + cloudLight;
  }
  outColor = vec4(max(color, 0.0), 1.0);
  gl_FragDepth = outDepth;
}`;
