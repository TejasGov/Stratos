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
uniform vec4 uFlash; // lightning point light: position relative to the camera (m), intensity (cd)
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
      // Chord length: acos() near 1.0 quantizes to whole-pixel blocks in float32.
      float ang = length(dir - rd);
      // Few bright stars, many faint ones (tuned for the night exposure ceiling).
      float brightness = pow(h, layer == 0 ? 40.0 : 70.0) * (layer == 0 ? 0.07 : 0.03);
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
  col += vec3(0.55, 0.6, 0.75) * band * (0.25 + dust * 0.75) * 0.006 * smoothstep(0.15, 0.6, dust + band * 0.3);
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

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float erfcApprox(float x) { return 2.0 * exp(-x * x) / (2.319 * x + sqrt(4.0 + 1.52 * x * x)); }
float smithLambda(float cosT, float s2) {
  float v = cosT / sqrt(max((1.0 - cosT * cosT) * 2.0 * s2, 1e-6));
  return max(0.0, (exp(-v * v) - v * sqrt(PI) * erfcApprox(v)) / (2.0 * v * sqrt(PI)));
}
/** Bruneton et al. 2010 sun glitter for an anisotropic Gaussian slope distribution. */
float glitter(vec3 L, vec3 V, vec3 N, vec3 Tx, vec3 Ty, vec2 s2) {
  vec3 H = normalize(L + V);
  float zH = max(dot(H, N), 1e-3);
  float zx = dot(H, Tx) / zH, zy = dot(H, Ty) / zH;
  float zL = max(dot(L, N), 0.01), zV = max(dot(V, N), 0.01);
  float p = exp(-0.5 * (zx * zx / s2.x + zy * zy / s2.y)) / (2.0 * PI * sqrt(s2.x * s2.y));
  float tV = atan(dot(V, Ty), dot(V, Tx)), cV2 = 1.0 / (1.0 + tV * tV), sV2 = s2.x * cV2 + s2.y * (1.0 - cV2);
  float tL = atan(dot(L, Ty), dot(L, Tx)), cL2 = 1.0 / (1.0 + tL * tL), sL2 = s2.x * cL2 + s2.y * (1.0 - cL2);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  return F * p / ((1.0 + smithLambda(zL, sL2) + smithLambda(zV, sV2)) * zV * zH * zH * zH * zH * 4.0);
}
float meanFresnel(float cosV, float sigV) {
  return pow(1.0 - cosV, 5.0 * exp(-2.69 * sigV)) / (1.0 + 22.7 * pow(sigV, 1.5));
}

vec3 oceanShade(vec3 rd, float tOcean, vec3 sceneColor, float sceneDist, float r, out bool seabed) {
  vec2 xz = uCameraGlobal.xz + rd.xz * tOcean;
  float mu = max(-rd.y, 0.05);
  float footprint = tOcean * uPixelAngle / mu;
  float wind = 0.42;
  vec2 dh = vec2(0.0), sig2 = vec2(0.0);
  float k = 2.0 * PI / 70.0, A = 0.55;
  for (int i = 0; i < 18; i++) {
    float fi = float(i);
    float ang = wind + 2.4 * (hash11(fi * 3.17 + 0.5) - 0.5);
    vec2 d = vec2(cos(ang), sin(ang));
    float ph = k * dot(d, xz) - sqrt(9.81 * k) * uTime + 6.2831 * hash11(fi + 7.1);
    float fp = footprint * k / PI;
    float w = (1.0 - smoothstep(0.5, 1.0, fp)) * uOceanDetail;
    dh += w * A * k * cos(ph) * d;
    vec2 s = A * k * vec2(cos(ang - wind), sin(ang - wind));
    sig2 += (1.0 - w * w) * 0.5 * s * s;
    k *= 1.21;
    A *= 0.72 + 0.12 * hash11(fi + 3.3);
  }
  // Unresolved capillary roughness (Cox-Munk, ~7 m/s wind) on top of filtered waves.
  sig2 += vec2(0.0045, 0.0032);
  vec3 N = normalize(vec3(-dh.x, 1.0, -dh.y));
  vec3 V = -rd;
  vec3 L = uSunDir;
  vec3 Tx = vec3(cos(wind), 0.0, sin(wind));
  vec3 Ty = vec3(-Tx.z, 0.0, Tx.x);
  vec3 sunT = transmittanceLut(tTransmittance, Rg + 0.001, max(L.y, 0.0)) * smoothstep(-0.01, 0.02, L.y);
  vec3 sunE = sunT * uSunIlluminance;
  vec3 skyE = texture(tSkyView, vec2(0.5, 1.0)).rgb * uSunIlluminance * PI * 1.25;
  vec3 irradiance = sunE * max(L.y, 0.0) + skyE;
  float nv = max(dot(N, V), 1e-3);
  vec3 Vw = vec3(dot(V, Tx), dot(V, Ty), dot(V, N));
  vec2 tv = Vw.xy * Vw.xy / max(1.0 - Vw.z * Vw.z, 1e-4);
  float F = 0.02 + 0.98 * meanFresnel(Vw.z, sqrt(dot(tv, sig2)));
  vec3 R = reflect(rd, N);
  R.y = abs(R.y) + 0.001;
  vec3 sky = texture(tSkyView, skyViewUv(normalize(R), uSunDir, r)).rgb * uSunIlluminance;
  vec3 spec = sunE * min(glitter(L, V, N, Tx, Ty, sig2), 2000.0);
  vec3 seaColor = vec3(10.0, 40.0, 120.0) / 255.0 * 0.1;
  vec3 deep = seaColor * irradiance / PI;
  vec3 Lw = deep;
  seabed = false;
  if (sceneDist < 1e8 && sceneDist > tOcean) {
    float depth = max(0.0, -(uCameraGlobal.y + rd.y * sceneDist));
    const vec3 SIGMA = vec3(0.45, 0.075, 0.035);
    float cv = sqrt(max(0.0, 1.0 - (1.0 - nv * nv) / 1.777));
    float cs = sqrt(max(0.0, 1.0 - (1.0 - L.y * L.y) / 1.777));
    vec3 Td = exp(-SIGMA * depth / max(cs, 0.15));
    vec3 Tu = exp(-SIGMA * depth / max(cv, 0.15));
    // The seabed was lit in air; attenuate the down and up paths through the water.
    Lw = sceneColor * Td * Tu * 1.1 + deep * (1.0 - Tu);
    // Shore foam: contact foam plus bands of surf rolling toward the beach.
    float foamNoise = valueNoise(xz * 0.18 + uTime * 0.15) * 0.65 + valueNoise(xz * 0.9 - uTime * 0.1) * 0.35;
    float shore = 1.0 - smoothstep(0.0, 0.7, depth);
    float bands = smoothstep(0.75, 1.0, 0.5 + 0.5 * sin(6.2831 * (depth / 1.4 - uTime * 0.15) + 2.5 * foamNoise)) *
      (1.0 - smoothstep(0.3, 2.2, depth)) * 0.65;
    float foam = clamp(shore * 0.85 + bands, 0.0, 1.0) * smoothstep(0.3, 0.7, foamNoise) * 0.8;
    Lw = mix(Lw, 0.8 * irradiance / PI, foam);
    F *= 1.0 - foam;
    spec *= 1.0 - foam;
    seabed = true;
  }
  return spec + F * sky + (1.0 - F) * Lw;
}

void main() {
  vec2 uv = vUv;
  vec4 sceneSample = texture(tScene, uv);
  vec3 scene = sceneSample.rgb;
  float depth = texture(tDepth, uv).x;
  vec4 ray = uRayMatrix * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(ray.xyz / ray.w);
  vec4 view = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec3 viewPos = view.xyz / view.w;
  bool geometry = depth < 1.0;
  float sceneDist = geometry ? length(viewPos) : 1e9;
  // Terrain flags its below-sea-level fragments with alpha 0: robust at any range,
  // unlike comparing reconstructed depth with the ocean distance.
  bool underwater = geometry && sceneSample.a < 0.5;
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
  if (tOcean > 0.0 && (tOcean < sceneDist || underwater)) {
    bool seabed;
    vec3 water = oceanShade(rd, tOcean, scene, max(sceneDist, tOcean + 0.5), r, seabed);
    vec3 hit = vec3(uCameraGlobal.x, 0.0, uCameraGlobal.z) + rd * tOcean;
    vec2 suv = (hit.xz - uShadowCenter) / uShadowExtent + 0.5;
    float shade = texture(tCloudShadow, clamp(suv, 0.0, 1.0)).r;
    float inside = 1.0 - smoothstep(0.38, 0.5, max(abs(suv.x - 0.5), abs(suv.y - 0.5)));
    water *= mix(1.0, 0.35 + 0.65 * shade, inside);
    if (uFlash.w > 0.0) {
      // Lightning over the sea: diffuse sheen from the flash above the cloud base.
      vec3 toFlash = uFlash.xyz - rd * tOcean;
      float d2 = dot(toFlash, toFlash);
      water += vec3(0.75, 0.82, 1.0) * uFlash.w / d2 * max(toFlash.y, 0.0) * inversesqrt(d2) * 0.012;
    }
    surfacePerspective(uv, rd, tOcean, true, inscatter, trans);
    color = water * trans + inscatter * uSunIlluminance;
    vec4 clip = uProjection * vec4((uViewRotation * vec4(rd * min(tOcean, 1e7), 0.0)).xyz, 1.0);
    outDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 0.9999999);
  } else if (geometry) {
    vec3 world = uCameraGlobal + rd * sceneDist;
    vec2 suv = (world.xz - uSunDir.xz / max(uSunDir.y, 0.06) * world.y - uShadowCenter) / uShadowExtent + 0.5;
    float shade = texture(tCloudShadow, clamp(suv, 0.0, 1.0)).r;
    float inside = (1.0 - smoothstep(0.38, 0.5, max(abs(suv.x - 0.5), abs(suv.y - 0.5)))) * step(world.y, 1300.0);
    scene *= mix(1.0, 0.3 + 0.7 * shade, inside);
    surfacePerspective(uv, rd, sceneDist, true, inscatter, trans);
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
    float lim = dinfo.y * 1000.0;
    // Depth similarity only matters where geometry cuts the cloud: clamping both
    // distances by the cloud's own depth ignores backgrounds hidden behind it.
    float cloudAt = c.a < 0.98 ? dinfo.x * 1000.0 * 1.15 : 1.6e5;
    float a = min(min(refDist, 1.6e5), cloudAt), b = min(min(lim, 1.6e5), cloudAt);
    float similarity = exp(-abs(a - b) / max(a, 1.0) * 6.0);
    float w = bil * similarity + 1e-5;
    cloud += c * w;
    cloudDepth += dinfo.x * 1000.0 * w;
    weight += w;
  }
  cloud /= weight;
  cloudDepth /= weight;
  // Geometry nearer than the layer's mean depth only receives the part in front
  // of it; this removes low-resolution halos around the jet and near terrain.
  if (refDist < 1.6e5) {
    float front = clamp(refDist / max(cloudDepth, 1.0), 0.0, 1.0);
    front = front * front * (3.0 - 2.0 * front);
    cloud = vec4(cloud.rgb * front, mix(1.0, cloud.a, front));
  }
  if (cloud.a < 0.999) {
    vec3 ci, ct;
    surfacePerspective(uv, rd, cloudDepth, false, ci, ct);
    vec3 cloudLight = cloud.rgb * ct + ci * uSunIlluminance * (1.0 - cloud.a);
    color = color * cloud.a + cloudLight;
  }
  outColor = vec4(max(color, 0.0), 1.0);
  gl_FragDepth = outDepth;
}`;
