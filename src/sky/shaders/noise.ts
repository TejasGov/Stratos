/** Tileable lattice noises shared by the cloud volume generators. */
export const NOISE_GLSL = /* glsl */ `
vec3 hash33(vec3 p) {
  uvec3 q = uvec3(ivec3(p) + 4096) * uvec3(1597334673u, 3812015801u, 2798796415u);
  q = (q.x ^ q.y ^ q.z) * uvec3(1597334673u, 3812015801u, 2798796415u);
  return vec3(q) * (1.0 / 4294967295.0);
}
float worley(vec3 x, float period) {
  vec3 id = floor(x), f = fract(x);
  float best = 1e9;
  for (int k = -1; k <= 1; k++)
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec3 o = vec3(float(i), float(j), float(k));
    vec3 d = o + hash33(mod(id + o, period)) - f;
    best = min(best, dot(d, d));
  }
  return 1.0 - clamp(sqrt(best), 0.0, 1.0);
}
float worleyFbm(vec3 p, float freq) {
  return worley(p * freq, freq) * 0.625 +
    worley(p * freq * 2.0, freq * 2.0) * 0.25 +
    worley(p * freq * 4.0, freq * 4.0) * 0.125;
}
vec3 gradient(vec3 c) { return normalize(hash33(c) * 2.0 - 1.0 + 1e-4); }
float perlin(vec3 x, float period) {
  vec3 i = floor(x), f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(gradient(mod(i, period)), f);
  float n100 = dot(gradient(mod(i + vec3(1, 0, 0), period)), f - vec3(1, 0, 0));
  float n010 = dot(gradient(mod(i + vec3(0, 1, 0), period)), f - vec3(0, 1, 0));
  float n110 = dot(gradient(mod(i + vec3(1, 1, 0), period)), f - vec3(1, 1, 0));
  float n001 = dot(gradient(mod(i + vec3(0, 0, 1), period)), f - vec3(0, 0, 1));
  float n101 = dot(gradient(mod(i + vec3(1, 0, 1), period)), f - vec3(1, 0, 1));
  float n011 = dot(gradient(mod(i + vec3(0, 1, 1), period)), f - vec3(0, 1, 1));
  float n111 = dot(gradient(mod(i + vec3(1, 1, 1), period)), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float perlinFbm(vec3 p, float freq, int octaves) {
  float sum = 0.0, amp = 1.0, norm = 0.0;
  for (int o = 0; o < 8; o++) {
    if (o >= octaves) break;
    sum += perlin(p * freq, freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum / norm;
}
float remap(float v, float a, float b, float c, float d) {
  return c + (v - a) / (b - a) * (d - c);
}
`;

/** 128³ RGBA: R Perlin-Worley, GBA Worley FBM at increasing frequencies. */
export const SHAPE_NOISE = /* glsl */ `
${NOISE_GLSL}
uniform float uLayer;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 p = vec3(gl_FragCoord.xy, uLayer + 0.5) / 128.0;
  float pfbm = mix(1.0, perlinFbm(p, 4.0, 7), 0.5);
  pfbm = abs(pfbm * 2.0 - 1.0);
  float g = worleyFbm(p, 4.0);
  float b = worleyFbm(p, 8.0);
  float a = worleyFbm(p, 16.0);
  float r = remap(pfbm, 0.0, 1.0, g, 1.0);
  outColor = vec4(clamp(r, 0.0, 1.0), g, b, a);
}`;

/** 32³ RGB Worley FBM erosion detail. */
export const DETAIL_NOISE = /* glsl */ `
${NOISE_GLSL}
uniform float uLayer;
layout(location = 0) out vec4 outColor;
void main() {
  vec3 p = vec3(gl_FragCoord.xy, uLayer + 0.5) / 32.0;
  outColor = vec4(worleyFbm(p, 2.0), worleyFbm(p, 4.0), worleyFbm(p, 8.0), 1.0);
}`;

/**
 * 512² tileable weather fields, contrast-stretched to roughly 0..1.
 * Sampled twice at different scales: R systems and B storm cores over 96 km,
 * G cumulus cells and A fine break-up over 34 km.
 */
export const WEATHER_NOISE = /* glsl */ `
${NOISE_GLSL}
layout(location = 0) out vec4 outColor;
void main() {
  vec3 p = vec3(gl_FragCoord.xy / 512.0, 0.37);
  float systems = clamp(perlinFbm(p, 3.0, 4) * 2.6 + 0.5, 0.0, 1.0);
  float cells = worley(p * 10.0, 10.0) * 0.55 + worley(p * 20.0, 20.0) * 0.3 +
    (perlinFbm(p + 3.1, 8.0, 3) * 0.5 + 0.5) * 0.35;
  cells = clamp((cells - 0.367) * 2.29, 0.0, 1.0);
  float storm = clamp(perlinFbm(p + 9.7, 2.0, 3) * 1.5 + 0.5, 0.0, 1.0);
  float fine = clamp(perlinFbm(p + 5.3, 24.0, 2) * 1.8 + 0.5, 0.0, 1.0);
  outColor = vec4(systems, cells, storm, fine);
}`;
