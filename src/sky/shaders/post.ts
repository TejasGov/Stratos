/** Post-processing shaders: dual-filter bloom, crepuscular rays, eye adaptation, lens flare and grade. */

export const BLOOM_DOWN = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uTexel;
uniform float uFirst;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 karis(vec3 c) { return c / (1.0 + luma(c) * 0.25); }
void main() {
  vec2 t = uTexel;
  vec3 a = texture(tInput, vUv + t * vec2(-2, 2)).rgb;
  vec3 b = texture(tInput, vUv + t * vec2(0, 2)).rgb;
  vec3 c = texture(tInput, vUv + t * vec2(2, 2)).rgb;
  vec3 d = texture(tInput, vUv + t * vec2(-2, 0)).rgb;
  vec3 e = texture(tInput, vUv).rgb;
  vec3 f = texture(tInput, vUv + t * vec2(2, 0)).rgb;
  vec3 g = texture(tInput, vUv + t * vec2(-2, -2)).rgb;
  vec3 h = texture(tInput, vUv + t * vec2(0, -2)).rgb;
  vec3 i = texture(tInput, vUv + t * vec2(2, -2)).rgb;
  vec3 j = texture(tInput, vUv + t * vec2(-1, 1)).rgb;
  vec3 k = texture(tInput, vUv + t * vec2(1, 1)).rgb;
  vec3 l = texture(tInput, vUv + t * vec2(-1, -1)).rgb;
  vec3 m = texture(tInput, vUv + t * vec2(1, -1)).rgb;
  vec3 result;
  if (uFirst > 0.5) {
    // Karis average on the first mip suppresses sun-glitter fireflies.
    result = karis((j + k + l + m) * 0.25) * 0.5 +
      karis((a + b + d + e) * 0.25) * 0.125 + karis((b + c + e + f) * 0.25) * 0.125 +
      karis((d + e + g + h) * 0.25) * 0.125 + karis((e + f + h + i) * 0.25) * 0.125;
    result = min(result, vec3(4000.0));
  } else {
    result = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  outColor = vec4(result, 1.0);
}`;

export const BLOOM_UP = /* glsl */ `
uniform sampler2D tInput;
uniform sampler2D tBase;
uniform vec2 uTexel;
uniform float uRadius;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture(tInput, vUv + vec2(-t.x, t.y)).rgb + texture(tInput, vUv + vec2(t.x, t.y)).rgb +
    texture(tInput, vUv + vec2(-t.x, -t.y)).rgb + texture(tInput, vUv + vec2(t.x, -t.y)).rgb;
  s += 2.0 * (texture(tInput, vUv + vec2(0.0, t.y)).rgb + texture(tInput, vUv + vec2(0.0, -t.y)).rgb +
    texture(tInput, vUv + vec2(t.x, 0.0)).rgb + texture(tInput, vUv + vec2(-t.x, 0.0)).rgb);
  s += 4.0 * texture(tInput, vUv).rgb;
  outColor = vec4(texture(tBase, vUv).rgb + s / 16.0, 1.0);
}`;

/** Sky-only bright mask for crepuscular rays; clouds and terrain occlude it. */
export const RAY_MASK = /* glsl */ `
uniform sampler2D tInput;
uniform sampler2D tDepth;
uniform vec2 uSun;
uniform float uAspect;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  float depth = texture(tDepth, vUv).x;
  vec3 c = texture(tInput, vUv).rgb;
  float sky = step(0.99999, depth);
  vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
  float near = exp(-dot(d, d) * 9.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 bright = c * smoothstep(0.0, 1.0, l * 0.02) / (1.0 + l * 0.004);
  outColor = vec4(bright * sky * near, 1.0);
}`;

export const RAY_BLUR = /* glsl */ `
uniform sampler2D tInput;
uniform vec2 uSun;
uniform float uDensity;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 delta = (vUv - uSun) * uDensity / 40.0;
  vec2 uv = vUv - delta * ign(gl_FragCoord.xy);
  vec3 sum = vec3(0.0);
  float decay = 1.0, total = 0.0;
  for (int i = 0; i < 40; i++) {
    uv -= delta;
    sum += texture(tInput, clamp(uv, 0.0, 1.0)).rgb * decay;
    total += decay;
    decay *= 0.965;
  }
  outColor = vec4(sum / total, 1.0);
}`;

/** Average log luminance of the smallest bloom mip, temporally adapted (eye adaptation). */
export const ADAPT = /* glsl */ `
uniform sampler2D tInput;
uniform sampler2D tPrevious;
uniform float uDelta;
uniform float uReset;
layout(location = 0) out vec4 outColor;
void main() {
  float sum = 0.0, weight = 0.0;
  for (int y = 0; y < 8; y++)
  for (int x = 0; x < 8; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / 8.0;
    float centre = 1.0 - 0.6 * length(uv - 0.5);
    float l = dot(texture(tInput, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
    sum += log(max(l, 1e-4)) * centre;
    weight += centre;
  }
  float target = exp(sum / weight);
  float previous = texture(tPrevious, vec2(0.5)).r;
  float rate = target > previous ? 2.2 : 1.1;
  float value = uReset > 0.5 ? target : previous + (target - previous) * (1.0 - exp(-uDelta * rate));
  outColor = vec4(max(value, 1e-4), 0.0, 0.0, 1.0);
}`;

export const FINAL = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tRays;
uniform sampler2D tExposure;
uniform sampler2D tDepth;
uniform sampler2D tCloudsLow;
uniform vec2 uResolution;
uniform vec2 uSun;
uniform sampler2D tSunVisible;
uniform vec3 uSunColor;
uniform float uBloom;
uniform float uRays;
uniform float uFlare;
uniform float uExposureBias;
uniform float uMinExposure;
uniform float uMaxExposure;
uniform float uTime;
uniform float uSpeedBlur;
uniform float uFlash;
uniform float uShock;
uniform vec2 uShockCenter;
uniform float uVignette;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// AgX (Troy Sobotka), minimal fit by Benjamin Wrensch, with a "punchy" look.
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 c) {
  const mat3 inset = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 outset = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  c = inset * c;
  c = clamp(log2(max(c, 1e-10)), -12.47393, 4.026069);
  c = (c + 12.47393) / 16.5;
  c = agxContrast(c);
  // Look: a little extra punch and saturation for cinematic skies.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = pow(max(c, 0.0), vec3(1.12));
  c = l + (c - l) * 1.18;
  c = outset * c;
  return clamp(c, 0.0, 1.0);
}
vec3 srgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

vec3 sampleScene(vec2 uv) {
  return texture(tScene, uv).rgb;
}

/** Procedural anamorphic-free flare: ghosts along the sun-centre axis, halo and glare. */
vec3 lensFlare(vec2 uv, float aspect) {
  float uSunVisible = texture(tSunVisible, vec2(0.5)).r;
  if (uSunVisible <= 0.001) return vec3(0.0);
  vec2 sun = uSun;
  vec2 axis = vec2(0.5) - sun;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float pos = -0.35 + fi * 0.38 + sin(fi * 3.7) * 0.12;
    vec2 center = sun + axis * pos * 2.0;
    vec2 d = (uv - center) * vec2(aspect, 1.0);
    float size = 0.018 + 0.05 * fract(sin(fi * 12.9) * 43758.5);
    float ring = smoothstep(size, size * 0.82, length(d)) * (0.35 + 0.65 * smoothstep(size * 0.3, size, length(d)));
    vec3 tint = mix(vec3(0.35, 0.65, 1.0), vec3(1.0, 0.55, 0.25), fract(fi * 0.37));
    col += tint * ring * 0.035;
  }
  vec2 hd = (uv - (sun + axis * 2.0 * 0.5)) * vec2(aspect, 1.0);
  float halo = smoothstep(0.03, 0.0, abs(length(hd) - 0.42)) * 0.025;
  col += vec3(0.6, 0.8, 1.0) * halo;
  vec2 sd = (uv - sun) * vec2(aspect, 1.0);
  float r = length(sd);
  float a = atan(sd.y, sd.x);
  float streak = pow(max(cos(a * 3.0 + 0.4), 0.0), 120.0) + pow(max(cos(a * 4.0 + 1.3), 0.0), 140.0) * 0.6;
  col += vec3(1.0, 0.9, 0.75) * (exp(-r * 22.0) * 0.4 + streak * exp(-r * 9.0) * 0.18);
  return col * uSunColor * uSunVisible;
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  // Shockwave ripple from a sonic boom, refracting the frame around its centre.
  if (uShock > 0.0) {
    vec2 sd = (uv - uShockCenter) * vec2(aspect, 1.0);
    float r = length(sd);
    float front = (1.0 - uShock) * 1.4;
    float ring = exp(-pow((r - front) * 18.0, 2.0)) * uShock;
    uv -= normalize(sd + 1e-5) / vec2(aspect, 1.0) * ring * 0.035;
  }
  vec2 fromCentre = uv - 0.5;
  float edge = dot(fromCentre, fromCentre);
  // Chromatic aberration grows toward the edges and with speed.
  float ca = (0.0012 + uSpeedBlur * 0.004) * edge * 4.0;
  vec3 color;
  color.r = sampleScene(uv - fromCentre * ca).r;
  color.g = sampleScene(uv).g;
  color.b = sampleScene(uv + fromCentre * ca).b;
  if (uSpeedBlur > 0.01) {
    vec3 blur = vec3(0.0);
    float jitter = hash12(gl_FragCoord.xy + uTime);
    for (int i = 1; i <= 6; i++) {
      float s = (float(i) + jitter) / 6.0;
      blur += sampleScene(uv - fromCentre * s * 0.045 * uSpeedBlur);
    }
    color = mix(color, blur / 6.0, clamp(edge * 3.5, 0.0, 1.0) * clamp(uSpeedBlur, 0.0, 1.0));
  }
  vec3 bloom = texture(tBloom, uv).rgb;
  color = mix(color, bloom, uBloom);
  color += texture(tRays, uv).rgb * uRays * uSunColor;
  float avg = texture(tExposure, vec2(0.5)).r;
  float exposure = clamp(0.16 / avg, uMinExposure, uMaxExposure) * exp2(uExposureBias);
  color *= exposure;
  color += lensFlare(uv, aspect) * uFlare;
  color += vec3(1.0) * uFlash;
  vec3 mapped = agx(color);
  float vig = 1.0 - uVignette * smoothstep(0.15, 0.85, length(fromCentre * vec2(aspect * 0.75, 1.0)));
  mapped *= vig;
  vec3 outSrgb = srgb(mapped);
  float grain = hash12(gl_FragCoord.xy * 1.37 + fract(uTime * 7.31) * 91.0) - 0.5;
  outSrgb += grain * (1.6 / 255.0 + 0.012 * (1.0 - dot(mapped, vec3(0.33))));
  outColor = vec4(clamp(outSrgb, 0.0, 1.0), 1.0);
}`;
