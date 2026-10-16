# Stratos: rendering research notes (sky, clouds, ocean, supersonic FX, HUD, post)

Target: three.js r186, WebGL2 / GLSL ES 3.0, HDR. Units: **km for atmosphere LUTs, m for clouds/ocean**.

Verification legend:
- **[V]** means I checked it against source code I cloned (the file is named).
- **[R]** means a secondary source or my own recall that I could not re-verify (some primary PDFs and Shadertoy were unreachable from this sandbox). Check these before relying on them.
- Anything else is a derived formula or a recommendation.

---------------------------------------------------------------------------------------------------
## 0. Cross-cutting gotchas (read first)

- **FP16 overflow.** The sun disk is about 1.6–1.9e9 cd/m². RGBA16F tops out at 65504. Pre-expose before writing HDR targets: `L *= exposure`, where `exposure = 1/(1.2*2^EV100)`. At EV100 15 the sun becomes about 4.7e4, which is borderline. Clamp the sun disk and bloom inputs to about 6e4 after pre-exposure, and especially when auto-exposure brightens at altitude where the sky is dark.
- **Planet-scale precision.** float32 at r = 6.36e6 m has a ULP of about 0.5 m.
  - Keep everything camera-relative. Never compute `(R+h)^2 - R^2` in float; use `h*(2R+h)` instead.
  - Use the stable quadratic root `t = c/(-b + sqrt(b²-c))` for the near root.
  - Pass the per-frame camera delta (double on the CPU) for reprojection.
- **Reprojection at jet speeds.** At 300–600 m/s, a 16-frame cloud history (0.27 s at 60 fps) covers 80–160 m of travel. That is fine for distant clouds but ghosts badly inside or near them. See §2.8.
- **Shared log depth.** If you use three.js `logarithmicDepthBuffer`, fullscreen passes that write depth (ocean) must use the same encoding: `gl_FragDepth = log2(1.0 + w) * logDepthBufFC * 0.5` with `logDepthBufFC = 2/log2(far+1)` **[R, three.js logdepthbuf chunk]**. Alternatively, composite against linear view-z that you store yourself.

---------------------------------------------------------------------------------------------------
## 1. Hillaire 2020 sky: brief, since the LUTs are already implemented

**Earth constants** **[V `Application/SkyAtmosphereCommon.cpp`]** (all km⁻¹ or km):

| Quantity | Value |
|---|---|
| Bottom radius Rb | 6360 |
| Top radius Rt | 6460 |
| Rayleigh σs | (5.802, 13.558, 33.100)e-3, H_R = 8 |
| Mie σs / σt | 3.996e-3 / 4.440e-3 (σa = 0.444e-3), H_M = 1.2, g = 0.8 |
| Ozone σa | (0.650, 1.881, 0.085)e-3 |
| Ozone density | `max(0, 1 - abs(h-25)/15)` (tent from 10 to 40 km, peak at 25) |
| Sun angular radius | 0.004675 rad |
| LUT format | demo uses R16G16B16A16F (32F if `SKYHIGHQUALITY`) |

Phase functions **[V]**:
- Rayleigh: `3/(16π)(1+μ²)`.
- Mie (Cornette–Shanks): `3/(8π)·(1-g²)/(2+g²)·(1+μ²)/(1+g²-2gμ)^1.5`, with μ = dot(viewDir, sunDir).
  - The demo passes `-cosTheta` into a function that negates it again, so the net result is the standard form above.

**LUT sizes and sample counts** **[V]**:
- Transmittance: 256×64, 40 steps.
- Multiple scattering: 32×32, 8×8 = 64 directions, 20 steps per direction, ground bounce included.
- Sky-view: 192×108. The march uses a variable 4→14 samples (lerp by `saturate(tMax/100km)`), quadratic t distribution, and samples at 0.3 of each segment.
- Aerial-perspective volume: 32×32×32. Slice i is marched with `max(1,(i+1)*2)` samples.

**Ψms usage inside the march** **[V]**:
`S = E_sun * (earthShadow*shadow*T_sun*(σsR*P_R + σsM*P_M) + Ψms(r, μs)*σs_total)`.
- MS LUT lookup: `uv = (μs*0.5+0.5, (r-Rb)/(Rt-Rb))`.
- MS LUT construction: `Ψms = L2nd / (1 - f_ms)`, where both sums are averaged over the 64 directions (that is, `Σ/64`).

**Sky-view mapping** **[V `RenderSkyCommon.hlsl`]**:
- β = acos(sqrt(r²-Rb²)/r) and ZH = π-β.
- Above the horizon: `v = 0.5*(1 - sqrt(1 - θ/ZH))`.
- Below the horizon: `v = 0.5 + 0.5*sqrt((θ-ZH)/β)`.
- Azimuth: `u = sqrt(0.5 - 0.5*cosφ_sun)`.
- Gotcha: the demo's `fromUnitToSubUvs` is not the exact inverse of `fromSubUvsToUnit`. Use the exact form `0.5/res + u*(1-1/res)`.

**Aerial perspective in the demo** **[V]**: `AP_KM_PER_SLICE = 4` with quadratic slices.
- Slice depth = `((i+0.5)/32)²·32·4` km, which reaches about 124 km at i = 31.
- Lookup: `w = sqrt(slice/32)`. Fade by `saturate(2*slice)` for slice < 0.5.
- Composite: `col*(1-AP.a) + AP.rgb`. Transmittance is grey (the mean of RGB).
- The paper text describes 32 slices over 32 km **[R, could not open the PDF]**. FlightGear's port uses 32 slices over 128 km **[R]**.

**High-altitude gotchas (20–50 km)** (derived numbers):
- Horizon geometry:

  | Altitude | Horizon dip | Distance to horizon |
  |---|---|---|
  | 10 km | 3.21° | 357 km |
  | 20 km | 4.54° | 505 km |
  | 30 km | 5.55° | 618 km |
  | 50 km | 7.16° | 799 km |

- The LUT's v = 0.5 sits on the true geometric horizon, so it handles the dip. However, bilinear filtering bleeds across it. Clamp sky lookups to v ≤ 0.5 - 0.5/H and ground lookups to v ≥ 0.5 + 0.5/H.
- Below-horizon sky-view texels integrate in-scatter up to the sea-level sphere. They are an excellent **far-field AP for the ocean or terrain beyond the froxel range**. Pair them with colored transmittance (Bruneton):
  `T(x→y) = T_top(r_d, μ_d)/T_top(r, μ)`, or for ground-hitting rays `T_top(r_d,-μ_d)/T_top(r,-μ)`, where `r_d = sqrt(d²+2rμd+r²)` and `μ_d = (rμ+d)/r_d`.
- The froxel range of 32–128 km is far shorter than the distance to the ground at grazing angles from altitude. Extend to about 128–256 km with quadratic slices, and fall back to the trick above beyond that.
  - Grey AP transmittance loses the reddening of distant terrain, which matters at 100+ km.
- Above 10 km, Mie density is below 2.4e-4 and Rayleigh density below 29% of sea level. Near-camera slices are nearly empty when looking down, so distributing slices relative to the ground distance is better.
- Keep the earth-shadow test (ray from the sample to the sun against Rb) everywhere. The transmittance LUT does not include planet occlusion.

**Sun disk**:
- Disk luminance `L = E_sun/Ω · T_cam(r, μ_sun) · limb(μ)`, with Ω = 6.87e-5 sr and E_sun at the top of the atmosphere ≈ 127–128 klx (1361 W/m² × ~93 lm/W).
- Limb darkening **[R, Hillaire 2016 notes]**:
  `mu = sqrt(1-x²)` (x = normalized distance from disk center), `f = 1 - u*(1 - pow(mu, a))`, u = 1, a = (0.397, 0.503, 0.652) for RGB.

Sources:
- https://github.com/sebh/UnrealEngineSkyAtmosphere (files cited above)
- Paper (DOI 10.1111/cgf.14050): https://sebh.github.io/publications/egsr2020.pdf
- Production Sky Rendering Shadertoy: https://www.shadertoy.com/view/slSXRW
- Bruneton parametrization: https://github.com/ebruneton/precomputed_atmospheric_scattering
- FlightGear port (flight-sim usage): `fgdata/Shaders/HDR/atmos-*.frag` on git.nayala.duckdns.org (search result only)

---------------------------------------------------------------------------------------------------
## 2. Real-time volumetric clouds

### 2.1 Layer geometry and weather map

**Real-world altitudes** (meteorology):

| Cloud type | Altitude |
|---|---|
| Stratus | base 0–2 km, thin (0.2–1 km) |
| Cumulus | base 0.6–2 km, tops 2–6 km |
| Cumulonimbus | base about 1 km, tops 10–15 km (tropopause anvil) |
| Altostratus/altocumulus | 2–7 km |
| Cirrus | 6–12 km, usually a 2D layer |

**Reference layer setups** **[V]**:
- takram defaults (`CloudLayers.ts`):
  - Layer r: altitude 750, height 650, densityScale 0.2
  - Layer g: altitude 1000, height 1200, densityScale 0.2
  - Layer b: altitude 7500, height 500, densityScale 0.003 (cirrus-like, shapeAmount 0.4, no detail)
  - shapeAlteringBias 0.35, coverageFilterWidth 0.6, coverage 0.3
  - Density profile `0.75*hf + 0.25` (linear in height fraction)
- Skybolt (`VolumeClouds.frag`):
  - Shell 1000–7000 m
  - Per-type zero-density bottoms (1000, 4100, 6700) and tops (2000, 5000, 7000)
  - Density multipliers (0.03, 0.02, 0.0002) m⁻¹

**Weather-map channels, Schneider 2015 / GPU Pro 7** **[R]**:
- R = coverage, G = precipitation (darkens and absorbs), B = cloud type (0 stratus, 0.5 stratocumulus, 1 cumulus).
- Nubis 2017 changed the layout; I could not verify it, so don't depend on it.
- takram packs **one coverage channel per layer** (RGBA = 4 layers). This scales better for a flight sim with multiple decks.

**Height gradient per type** (community constants, used as `smoothstep(g.x,g.y,hf) - smoothstep(g.z,g.w,hf)`) **[V TerrainEngine-OpenGL `volumetric_clouds.comp`]**:
```glsl
#define STRATUS_GRADIENT       vec4(0.0,  0.1,    0.2,  0.3)
#define STRATOCUMULUS_GRADIENT vec4(0.02, 0.2,    0.48, 0.625)
#define CUMULUS_GRADIENT       vec4(0.0,  0.1625, 0.88, 0.98)
float densityHeightGradient(float hf, float type) {        // type in [0,1]
  float st = 1.0 - clamp(type * 2.0, 0.0, 1.0);
  float sc = 1.0 - abs(type - 0.5) * 2.0;
  float cu = clamp(type - 0.5, 0.0, 1.0) * 2.0;
  vec4 g = st * STRATUS_GRADIENT + sc * STRATOCUMULUS_GRADIENT + cu * CUMULUS_GRADIENT;
  return smoothstep(g.x, g.y, hf) - smoothstep(g.z, g.w, hf);
}
```
- Meteoros's version (remap products) **[V]**:
  - cumulus `remap(h,.01,.3,0,1)*remap(h,.6,.95,1,0)`
  - stratocumulus `remap(h,0,.25,0,1)*remap(h,.3,.65,1,0)`
  - stratus `remap(h,0,.1,0,1)*remap(h,.2,.3,1,0)`
- For **cumulonimbus**, use a separate deep layer (for example 1–12 km) with a cumulus gradient plus an anvil term. An example (my suggestion): `+ 0.6*smoothstep(0.75,0.85,hf)*coverageWide`, using a wider coverage sample for the top 15%.
- A rounded alternative (takram / Skybolt) **[V]**: `shape(hf) = 1 - (clamp(2*pow(hf, bias) - 1, -1, 1))²` with bias 0.35–0.5. This is a "semi-circle" that rounds tops and flattens bases.

**Coverage modulation, takram/Skybolt style** **[V]**:
`density = remapClamped(mix(weather, 1, fw), 1 - coverage*shape(hf), 1 - coverage*shape(hf) + fw)` with fw = 0.6.
- Global `coverage` slides smoothly from clear to overcast without editing the map.

### 2.2 Noise and the density function (Schneider GPU Pro 7, as widely reproduced)

**Noise textures**:
- Base shape: 128³ RGBA8. R = Perlin-Worley; G, B, A = Worley FBM at increasing frequency.
- Detail: 32³ RGB8 Worley FBM.
- Optional curl: 128² RG.
- takram generator **[V `cloudShape.frag`, after sebh/TileableVolumeNoise]**:
  - `perlinWorley = remap(perlin(f=8, 3 oct), 0,1, worleyFbm, 1)`
  - Worley cell counts 8/32/56 with weights 0.625/0.25/0.125
  - Final: `remap(perlinWorley, worleyFbm-1, 1)`
  - Detail: cell counts 2/4/8/16 (`CLOUD_SHAPE_TEXTURE_SIZE = 128`, `DETAIL = 32`)
- Bake offline or once at startup into a `Data3DTexture` (128³×1 byte = 2 MB).

**Density function**:
```glsl
float remap(float v, float l0, float h0, float l1, float h1){ return l1 + (v-l0)*(h1-l1)/(h0-l0); }
float cloudDensity(vec3 p, float hf, vec3 weather, float lod, bool cheap) {
  vec4 n = textureLod(uShape, p * uShapeScale, lod);                    // uShapeScale ~ 1/3–1/10 km⁻¹ (takram: 3e-4 m⁻¹)
  float fbm = dot(n.gba, vec3(0.625, 0.25, 0.125));
  float base = remap(n.r, -(1.0 - fbm), 1.0, 0.0, 1.0);                 // dilate PW by Worley FBM
  base *= densityHeightGradient(hf, weather.b);
  float cov = weather.r * uCoverageMul;
  float c = clamp(remap(base, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;   // GPU Pro 7 writes remap(base, cov, 1,0,1)*cov [R]; (1-cov) form is the common fix
  if (cheap || c <= 0.0) return c;
  vec3 q = p * uDetailScale;                                           // takram: 6e-3 m⁻¹ (~20x base)
  q.xz += texture(uCurl, p.xz * uCurlScale).xy * (1.0 - hf) * uCurlAmt; // whispy bottoms
  vec3 d = textureLod(uDetail, q, lod).rgb;
  float hfFbm = dot(d, vec3(0.625, 0.25, 0.125));
  float mod_ = mix(hfFbm, 1.0 - hfFbm, clamp(hf * 10.0, 0.0, 1.0));    // wispy low -> billowy high
  return clamp(remap(c, mod_ * 0.2, 1.0, 0.0, 1.0), 0.0, 1.0);          // erosion keeps cores intact
}
// extinction σt [m⁻¹] = density * uDensityScale (cumulus ~0.02–0.1 m⁻¹; takram densityScale 0.2 × scatteringCoef 1)
```
- takram detail erosion variant **[V `clouds.glsl`]**:
  - `modifier = mix(pow(detail,6), 1-detail, remap(hf,.2,.4))`
  - `density = remapClamped(density*2, modifier*0.5, 1)`
  - Detail is skipped when `mipLevel*0.5 + (jitter-0.5)*0.5 >= 0.5`, which gives stochastic LOD.
- Albedo: keep σa ≈ 0 (cloud albedo ≈ 0.99–1). takram uses scattering 1 and absorption 0. Add absorption only for rain clouds (weather.g).

### 2.3 Phase functions

The values below are sorted from cheapest to most accurate. Use μ = dot(viewDir, sunDir).
```glsl
float HG(float mu, float g){ float g2=g*g; return (1.0-g2)/(4.0*PI*pow(1.0+g2-2.0*g*mu,1.5)); }
```
- **takram** **[V `CloudsMaterial.ts`]**: dual lobe `0.5*HG(0.7) + 0.5*HG(-0.2)`.
- **Skybolt ("Watoo" fit to Bouthors)** **[V `Brdfs/HenyeyGreenstein.h`]**: `dot(HG(μ, (-0.2,0.3,0.96)), (0.5,0.5,0.03))`. This gives a strong forward glow near the sun.
- **Nubis-style silver lining** **[V Meteoros `cloudRayMarch.comp`]**: `max(HG(μ,0.6), 0.7*HG(μ, 0.99-0.1))`, with silver_intensity 0.7 and silver_spread 0.1.
  - clayjohn **[V]**: `max(max(HG(.6), HG(.99-1.3*sunDir.y)), HG(-.3))`.
- **Accurate option** (NVIDIA "Approximate Mie", d = 10 µm) **[V takram `clouds.frag`]**: `mix(HG(0.9882), Draine(gD=0.5557, α=21.9955), w=0.4820)`.
  - `Draine(u,g,a) = (1-g²)(1+a u²)/(4(1+a(1+2g²)/3)π(1+g²-2gu)^1.5)`.
  - It only looks right with good multiple scattering.

### 2.4 Light transport per sample

**Multiple-scattering octaves** (Wrenninge et al. 2013 "Oz", used by Frostbite 2016):
`L_ms = Σ_{i=0}^{N-1} b^i · E_sun · exp(-a^i·τ_sun) · p(μ, c^i·g)`, which requires `a ≤ b`.
- takram **[V]**: a = b = c = 0.5, 8 octaves (6–12 range). Fewer octaves makes clouds darker, so add a fudge gain if you cut them.
- Skybolt **[V]**: 2 octaves with a = b = c = 0.5, then `1.1*L + 0.01*E_sun*occlusion + ambient` as tail compensation. Its phase lerps to isotropic per octave: `mix(1/4π, hg, c^i)`.
```glsl
float msPhaseBeer(float tau, float mu) {          // tau = optical depth to sun
  float s = 0.0, a = 1.0, b = 1.0, c = 1.0;
  for (int i = 0; i < 8; ++i) { s += b * exp(-tau * a) * cloudPhase(mu, c); a *= 0.5; b *= 0.5; c *= 0.5; }
  return s;                                       // cloudPhase(mu, k): dual-lobe HG with g*k
}
```

**Beer-Powder** (dark edges facing the sun; not energy-conserving, so use sparingly):
- HZD 2015 form **[R]**: `E = 2·exp(-τ)·(1 - exp(-2τ))`. Here τ is the sun optical depth; some implementations use the local density.
- takram **[V]**: `radiance *= 1 - 0.8*exp(-σt*150)` (powderScale 0.8, powderExponent 150 with σt in m⁻¹), applied per sample on local extinction.
- Skybolt **[V]**: `min(1, pow(density*300, 0.2))`.

**Nubis "push light deeper" Beer** **[V clayjohn / Meteoros]**: `T = max(exp(-τ), 0.7*exp(-0.25τ))`. This is a cheap stand-in for multiple scattering.

**Ambient (sky) term** **[V takram]**:
`L += E_sky/(4π) · (hf*0.5+0.5) · skyLightScale`.
- Takes E_sky from the atmosphere (sky irradiance at the cloud altitude, interpolated between layer bottom and top).
- Ground bounce (takram, optional): `0.3/π·(E_sky + (1-coverage)E_sun)·exp(-τ_down)/(4π)`.

**Energy-conserving step integration** (Frostbite 2016 §5.6.3) **[V takram, Skybolt]**:
```glsl
vec3 S = (E_sun * msPhaseBeer(tauSun, mu) + Lamb) * sigmaS;   // per unit length
float Ts = exp(-sigmaT * dt);
L   += T * (S - S * Ts) / max(sigmaT, 1e-7);
T   *= Ts;
```

### 2.5 Light march (secondary rays)

**Steps toward the sun**:
- **GPU Pro 7 / HZD** **[R]**: 6 samples. Five sit inside a cone of increasing radius; the 6th is placed at about 3× the cone length to catch distant shadowing.
  - Once the accumulated cone density exceeds 0.3, switch to cheap (base-shape-only) samples.
  - Meteoros cone kernel **[V]**: (0.1,.25,-.15), (.2,.5,.2), (-.2,.1,-.1), (-.05,.75,.05), (-.1,1,0), (0,3,0), in a sun-aligned frame, scaled by the step size.
- **Skybolt** **[V]**: 6 samples at distances (1,2,4,8,16,32)×200 m. Each is offset by `RANDOM_VECTORS[i]*0.3` (cone) with segment lengths (1,1,2,4,8,16)×200 m, and τ is scaled ×0.5 to fake multiple scattering.
- **takram** **[V]**: only 1–2 steps (min step 100 m, ×2 growth). Long-range shadowing comes from a **Beer Shadow Map (BSM)**, sampled at the same point for the remainder of the path (§2.10).
  - Its comment notes that "only 1 march makes a big difference".

Recommendation for integrated GPUs: 4–6 exponentially spaced light samples using the base shape only, plus one far sample. Or use 2 samples plus a BSM if you also want terrain shadows from it.

### 2.6 Primary march, adaptive steps and ray–shell setup

```glsl
// Stable ray vs sphere of radius R+hs; camera at altitude hc, mu = dot(rayDir, up). Returns t0<=t1 (t0>t1 => miss).
vec2 shell(float hc, float mu, float hs){
  float r = R + hc, b = r * mu, c = (hc - hs) * (2.0*R + hc + hs);
  float disc = b*b - c; if (disc < 0.0) return vec2(1e30, -1e30);
  float q = -b - (b >= 0.0 ? 1.0 : -1.0) * sqrt(disc);     // no cancellation; roots are q and c/q
  float r0 = q, r1 = c / q;
  return vec2(min(r0, r1), max(r0, r1));
}
// Range through layer [Hb,Ht] (takram getRayNearFar / Skybolt main) [V]
vec2 cloudRange(float hc, float mu, float tScene){
  vec2 ib = shell(hc, mu, Hb), it = shell(hc, mu, Ht);
  bool hitBase = ib.x <= ib.y && ib.x > 0.0;
  vec2 r;
  if (hc < Hb)      { if (shell(hc,mu,0.0).x > 0.0 && mu < 0.0) return vec2(-1.0); r = vec2(ib.y, it.y); }       // below
  else if (hc < Ht) { r = vec2(0.0, hitBase ? ib.x : it.y); }                                                    // inside
  else              { if (it.x > it.y || it.y < 0.0) return vec2(-1.0); r = vec2(it.x, hitBase ? ib.x : it.y); } // above
  r.y = min(r.y, min(tScene, uMaxRayDist));  // takram 2e5 m (low 1e5); Skybolt 3e5 m
  return r;
}
```

**Step-size schedules** **[V]**:
- takram:
  - start `step = minStep + (1.01-1)*tNear`, minStep = 50 m (low preset 100, ultra 10)
  - grow ×1.01 every step (`perspectiveStepScale`), up to 1000 m in empty space
  - maxIterationCount 500 (low 200)
  - early out when T < 0.01 (low 0.1)
  - `minDensity` 1e-5
- Skybolt: 100 m initial, ×1.002 per step, 500 m maximum, 1000 iterations, T < 0.01.
- GPU Pro 7 / HZD **[R]**: 64–128 steps depending on view elevation (more toward the horizon). clayjohn **[V]** uses `mix(96, 54, dir.y)` steps.

**Adaptive / empty-space skipping**:
- Sample the **weather/coverage only** (cheap). If it is below a threshold, take a big step (takram: `mix(step, maxStep, min(1,mip))`).
- On a hit, take one step back and switch to full sampling.
- Return to cheap mode after N (about 6) consecutive zero-density samples **[R GPU Pro 7]**.
- Known artifact: banding. Fix with jitter, or binary-search refinement at the entry point.

**Jitter**:
- Offset t0 by `step * blueNoise`. takram uses ×2 to kill spatial aliasing **[V]**.
- Blue noise options: STBN 128×128×64 (layer = frame % 64) **[V takram]**, or a 64² blue-noise texture with `fract(bn + frame*0.61803398875)`.
- Use the same jitter for light samples.

**Camera INSIDE the layer**:
- tNear = 0 (or the camera near plane).
- Fade density near the eye: `*= smoothstep(0.0, 30.0, t)` m. This avoids full-screen pops from noise blobs.
- Use a smaller first step (about 10–20 m).
- Disable or shorten temporal accumulation (§2.8).
- Add cheap "cloud fog" for whiteout: once T accumulates above 0.9 within 200 m, lerp the screen to the in-cloud radiance.

**Camera ABOVE the layer** (looking down, 20–50 km):
- tNear = the first intersection with the top shell. tFar = the base shell if hit (looking down), otherwise the second top intersection (grazing).
- Grazing rays can traverse hundreds of km, so cap the distance and rely on LOD.
- Mip and LOD bias grow with distance: takram `mip = log2(max(1, startTexelsPerPixel + t*1e-5))` **[V]**.
- Skybolt **[V]**:
  - Blends to a **2D coverage-map impostor** when the LOD exceeds 2 (`lowResBlend = (lod-2)*0.25`).
  - Antialiases the planet limb of the cloud shell with `smoothstep(0, fwidth(signal)*5, signal)`, where `signal = R+Ht - |midpoint|`.
- takram fades its mip scale near the ground: `mip *= min(1, 0.2*camHeight/maxHeight)`.
- From high altitude, a cheap 2D layer (coverage × `irradiance/4π`, desaturated 15%) is visually adequate beyond about 50–100 km and far cheaper.

### 2.7 Resolution and temporal scheme (HZD-style 1/16)

**Low-res pass**:
- Render at ¼×¼ resolution. Each low-res pixel marches the ray of **one** full-res pixel inside its 4×4 block, chosen by a Bayer index == frame % 16.
- Every full-res pixel is therefore refreshed every 16 frames.
- HZD reports a 2 ms GPU target on PS4 and marches about 1/16 of the rays per frame **[R: the 2 ms is from the talk abstract; 1/16 from the gamedev.net thread]**.
- takram (TAAU variant) **[V `CloudsMaterial.ts`]**: offsets the **projection matrix** by `((bayer-0.5)/res)*4`, so the low-res target sees sub-pixel-jittered rays and gets `mipLevelScale = 0.25`.

```glsl
const ivec4 BAYER[4] = ivec4[4](ivec4(0,12,3,15), ivec4(8,4,11,7), ivec4(2,14,1,13), ivec4(10,6,9,5)); // [V takram/Skybolt]
// Low-res pass: which full-res sub-pixel does this low-res texel trace this frame?
ivec2 sub = BAYER_POS[frame % 16];           // inverse table of BAYER
vec2 fullResPix = vec2(ivec2(gl_FragCoord.xy) * 4 + sub) + 0.5;
```

**Resolve at full or half resolution** **[V Skybolt `CloudsTemporalUpscaling.frag`, takram `cloudsResolve.frag`]**:
```glsl
ivec2 p = ivec2(gl_FragCoord.xy), lo = p / 4;
vec4 cur = texelFetch(uLow, lo, 0);
if (BAYER[p.x & 3][p.y & 3] == frame % 16) { out = cur; return; }       // fresh texel
// Reproject with a REPRESENTATIVE depth (transmittance-weighted mean cloud depth, else far/ layer distance):
float d = texelFetch(uLowDepth, lo, 0).r;                               // takram: pick closest of 3x3 ("closest fragment")
vec3 Pw = camRel + rayDir * d;                                          // camera-relative world pos
vec4 pc = uPrevViewProjRel * vec4(Pw + uCamDelta, 1.0);                 // uCamDelta = camPosCur - camPosPrev (double on CPU)
vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
if (any(lessThan(puv, vec2(0))) || any(greaterThan(puv, vec2(1)))) { out = textureLod(uLow, vUv, 0.0); return; }
vec4 hist = textureCatmullRom(uHist, puv);                              // Skybolt Catmull-Rom; takram bilinear
// Neighborhood clamp on the LOW-RES 3x3 around lo:
vec4 m1 = cur, m2 = cur*cur, mn = cur, mx = cur;
for (int i=0;i<8;i++){ vec4 c = texelFetch(uLow, lo + OFF[i], 0); m1+=c; m2+=c*c; mn=min(mn,c); mx=max(mx,c); }
vec4 mu = m1/9.0, sd = sqrt(max(m2/9.0 - mu*mu, 0.0));
vec4 clipped = clipAABB(hist, mu - sd*2.0, mu + sd*2.0);                // takram: variance clip, gamma = 2 for upscaling
// Skybolt alternative: min/max clamp, blended by motion to avoid stationary buzzing:
//   out = mix(hist, clamp(hist, mn, mx), min(1.0, length(puv - vUv) * 200.0));
out = clipped;
```

**Representative depth** (Frostbite 2016 §5.9.1) **[V takram, Skybolt]**:
`dRep = Σ(t_i·T_i)/Σ T_i` over samples that hit cloud, or -1 / far if none.
- Store dRep in the low-res target (R16F/R32F). Use it for reprojection **and** aerial perspective.
- Skybolt stores `sqrt(color)` in the low-res target to reduce banding in 8-bit.

**Half-res option**:
- Full-update half-res plus TAA: takram `temporalAlpha = 0.1` with 3×3 closest-depth velocity and variance clipping (γ = 1).
- Costs about 4× more rays than 1/16 but is far more robust at speed.
- **Recommended for a jet game:**
  - Use 1/16 when the camera is ≥ 1–2 km from the nearest cloud.
  - Switch to a 2×2 checkerboard (¼ of pixels per frame, 4-frame cycle) or half-res + TAA when inside or within about 1 km of clouds, or when angular velocity is high.
  - Reset history on teleport, or when the camera has moved more than about 0.5 × the layer thickness since the history was written.

### 2.8 Aerial perspective on clouds

Sample AP at the cloud's dRep, not per march step:
```glsl
vec4 ap = sampleAP(screenUv, dRepKm);          // froxel; beyond range: far-field (§1)
cloud.rgb = cloud.rgb * (1.0 - ap.a) + ap.rgb * cloud.a;   // premultiplied cloud; takram: color*T + inscatter*alpha [V]
final = sky * (1.0 - cloud.a) + cloud.rgb;     // cloud.a = 1 - T_cloud
```
- Skybolt **[V]** also:
  - Weights AP by `min(1, alpha³)` (fudge to avoid haloing at thin edges).
  - Reduces in-scatter under overcast by `mix(1, 0.3, coverage)` ("cloud sky occlusion").
- Known limitation **[V takram README]**: a mean depth is wrong where sparse distant clouds overlap. It is acceptable in practice.

### 2.9 Cloud shadows on terrain and ocean

**Cheap (Skybolt)** **[V `CloudShadows.h`]**: project the receiver along the sun to the mid-layer altitude and sample coverage.
`uv += (L.xz / max(0.05, L.y)) * (cloudAlt - h)` converted to weather-map units, then `shadow = 1 - 0.95 * density(uv)`.
- Fade the shadow out as the receiver altitude approaches the cloud base.
- Sky occlusion: `mix(1, 0.3, coverage_lod4)`.

**Beer Shadow Map (Hillaire 2020 slides; takram)** **[V `shadow.frag` usage]**:
- Ortho sun camera with 3 cascades of 512² (low preset 2 × 256²). Each cascade marches about 50 steps (100–1000 m).
- Each texel stores `frontDepth`, `meanExtinction`, `maxOpticalDepth`, `maxOpticalDepthTail`.
- Lookup: `τ = min(maxOD + tail, meanExt * max(0, dToTop - frontDepth))`, then `T = exp(-τ)`.
- TAA the BSM (takram temporalAlpha 0.01).
- Gives soft, correct terrain shadows plus long-range in-cloud self-shadowing.

### 2.10 Performance data and budgets

**takram, measured on its Tokyo scene, all with temporal upscaling unless noted** **[V README]**:

| Device | Preset | Resolution | FPS |
|---|---|---|---|
| iPhone 13 | Low | 780×1326 | 36–53 |
| iPad Pro M4 | Medium | — | 60 |
| iPad Pro M4 | High | — | 43–55 |
| M3 Max | High | 4K | 92–95 |
| M3 Max | High, **no** temporal upscaling | 4K | 31 |
| M2 Ultra | High/Ultra | 4K | 60 |

- Temporal upscaling is roughly a **3×** win.

**Other data points**:
- Meteoros: under 3 ms at 1080p on a GTX 1070 laptop; reprojection gave a 5.97× speedup in their test **[V README]**.
- HZD: 2 ms target on PS4 (1.84 TFLOPS) **[R]**.

**Suggested budget at 1080p, 60 fps, on an integrated GPU** (Iris Xe / Apple M1 class, about 2–2.6 TFLOPS; my estimate):

| Pass | Budget |
|---|---|
| Sky LUTs + AP volume | ≤ 0.5 ms |
| Clouds, 1/16 march + resolve | 2.5–4 ms (64–128 steps, 2–6 light samples, detail noise only within ~20–30 km) |
| Ocean | ~1 ms |
| Post | ~1.5 ms |

- On weak iGPUs (UHD 620, about 0.4 TFLOPS), drop to:
  - no detail noise
  - 1 light sample plus an ambient fudge
  - transmittance cutoff 0.1
  - a 2D cloud layer beyond 30 km
- takram's "Low" preset is a good template: no detail, 1 sun sample, 200 iterations, 100 m minimum step, 100 km maximum distance, T cutoff 0.1, BSM 2 × 256².

Sources:
- HZD 2015 slides: https://www.advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf
- Nubis 2017: https://www.guerrilla-games.com/read/nubis-authoring-real-time-volumetric-cloudscapes-with-the-decima-engine
- Nubis Evolved 2022: https://advances.realtimerendering.com/s2022/SIGGRAPH2022-Advances-NubisEvolved-NoVideos.pdf
- Nubis Cubed 2023: https://advances.realtimerendering.com/s2023/Nubis%20Cubed%20(Advances%202023).pdf
- Hillaire 2016 Frostbite notes: https://media.contentapi.ea.com/content/dam/eacom/frostbite/files/s2016-pbs-frostbite-sky-clouds-new.pdf
- Wrenninge "Oz": https://fpsunflower.github.io/ckulla/data/oz_volumes.pdf
- takram three-clouds (three.js, the best WebGL reference): https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds (`shaders/clouds.frag`, `clouds.glsl`, `cloudsResolve.frag`, `varianceClipping.glsl`, `qualityPresets.ts`, `CloudLayers.ts`)
- Skybolt (flight-sim engine): https://github.com/Prograda/Skybolt (`Assets/Core/Shaders/VolumeClouds.frag`, `Clouds.h`, `CloudShadows.h`, `CloudsTemporalUpscaling.frag`)
- Meteoros (Nubis-style, Vulkan): https://github.com/AmanSachan1/Meteoros
- TerrainEngine-OpenGL: https://github.com/fede-vaccaro/TerrainEngine-OpenGL
- clayjohn realtime_clouds: https://github.com/clayjohn/realtime_clouds
- Tileable noise: https://github.com/sebh/TileableVolumeNoise
- STBN: https://research.nvidia.com/publication/2022-07_spatiotemporal-blue-noise-masks
- Approximate Mie: https://research.nvidia.com/labs/rtr/approximate-mie/
- gamedev.net HZD thread: https://gamedev.net/forums/topic/680832-horizonzero-dawn-cloud-system/

---------------------------------------------------------------------------------------------------
## 3. Analytic ocean (fullscreen pass)

### 3.1 Hit point

Planet sphere at sea level. Camera altitude hc in meters, μ = dot(rayDir, up).
- `c = hc*(2R + hc)` and `b = (R+hc)*μ`.
- Hit when `disc = b² - c ≥ 0` and μ < 0. The near root is `t = c / (-b + sqrt(disc))`, which is stable.
- Ocean is visible where `t < tSceneDepth` (terrain depth). Write `gl_FragDepth` using the engine's depth encoding (see §0).
- Surface position for waves: use tangent-plane coordinates around the camera, `xz = camXZ_wrapped + (rayDir*t).xz`. Wrap camXZ on the CPU modulo the longest wave period to keep float precision.
  - Beyond about 20 km, curvature makes the tangent-plane mapping drift. It doesn't matter there because waves are fully filtered to roughness at that range.

### 3.2 Waves and normals

**Analytic sum with exact derivatives** (no finite differences):
```glsl
// N waves, geometric spectrum around wind dir. Deep-water dispersion ω = sqrt(g k).
vec2 sig2 = vec2(0.0); vec2 dh = vec2(0.0); float h = 0.0;
float k = 2.0*PI/uLambda0, A = uA0;                       // e.g. λ0 = 60–120 m, A0 = 0.5–1.5 m for moderate sea
for (int i = 0; i < NW; ++i) {                            // NW = 12–24
  float ang = uWindAng + uSpread * (hash1(float(i)) - 0.5);   // spread ~ ±60°
  vec2 d = vec2(cos(ang), sin(ang));
  float ph = k * dot(d, xz) - sqrt(9.81 * k) * uTime + 6.2831 * hash1(float(i) + 7.1);
  float fp = uFootprint * k / PI;                         // footprint = meters/pixel at hit (dist*pixelAngle/max(|μ|,0.05))
  float w = 1.0 - smoothstep(0.5, 1.0, fp);               // fade wave when λ < ~2 px (Nyquist)
  h  += w * A * sin(ph);
  dh += w * A * k * cos(ph) * d;
  vec2 s = A * k * d;  sig2 += (1.0 - w*w) * 0.5 * s * s; // filtered slope variance -> roughness (LEAN-style)
  k *= 1.25; A *= 0.70;                                   // keep steepness A*k well < 0.3
}
vec3 N = normalize(vec3(-dh.x, 1.0, -dh.y));
```
- Add residual unresolved roughness from Cox–Munk (below).
- **Option: afl_ext "Very fast procedural ocean" style** **[R, Shadertoy MdXyzX; DRAG_MULT 0.38 confirmed via forum quote]**:
  - Each wave is `exp(sin(x)-1)`, with derivative `dx = wave*cos(x)`.
  - Position is "dragged" by `-dir*dx*weight*DRAG_MULT` per octave.
  - Per octave: frequency ×1.18, time multiplier ×1.07, weight ← mix(weight, 0, 0.2), direction from iteration seed += 1232.399963.
  - Gives sharp crests cheaply. Normals use finite differences there, so prefer analytic derivatives as above.
- **Seascape (TDM)** **[R, Ms2SD1]**:
  - `sea_octave: uv += noise(uv); wv = 1-abs(sin(uv)); swv = abs(cos(uv)); wv = mix(wv,swv,wv); pow(1-pow(wv.x*wv.y,0.65), choppy)`.
  - SEA_HEIGHT 0.6, CHOPPY 4, FREQ 0.16, octave matrix ((1.6,1.2),(-1.2,1.6)), 3 geometry / 5 fragment octaves.
  - Finite-difference normal eps = `dist² * 0.1/resX`.
  - Not physically scaled; better suited to low-altitude stylized views.
- **Displacement / heightfield tracing** is only needed below about 100–200 m altitude at grazing angles (Seascape uses 8 bisection steps). From cruise altitude, shading-only (normal + roughness) is indistinguishable.

### 3.3 Roughness (sun glitter), Cox–Munk

Wind speed U in m/s at 12.5 m **[V via oceanopticsbook summary]**:
- `σ²_up = 3.16e-3·U`
- `σ²_cross = 0.003 + 1.92e-3·U`
- `σ²_total = 0.003 + 5.12e-3·U` (U = 7 m/s gives σ² ≈ 0.039)
- Later work suggests multiplying by about 1.45 **[R]**.

Effective slope variance in the wind frame: `σ² = max(CoxMunk - Σ resolved 0.5(A k d)², 2e-5) + sig2_filtered`.
- Near the camera, the waves carry most of the slope.
- At distance, everything becomes roughness, so the glitter widens into a smooth elongated highlight.

### 3.4 Lighting (Bruneton, Neyret, Holzschuch 2010) **[V Skybolt `ThirdParty/BruentonOcean.h`, `Ocean.frag`]**
```glsl
float erfc_(float x){ return 2.0*exp(-x*x)/(2.319*x + sqrt(4.0 + 1.52*x*x)); }
float Lambda(float cosT, float s2){ float v = cosT/sqrt((1.0-cosT*cosT)*2.0*s2);
  return max(0.0, (exp(-v*v) - v*sqrt(PI)*erfc_(v)) / (2.0*v*sqrt(PI))); }
// L,V,N world; Tx = wind dir, Ty = cross-wind (both ⟂ N); s2 = (σx², σy²) in wind frame
float reflectedSunRadiance(vec3 L, vec3 V, vec3 N, vec3 Tx, vec3 Ty, vec2 s2){
  vec3 H = normalize(L + V);
  float zx = dot(H,Tx)/dot(H,N), zy = dot(H,Ty)/dot(H,N);
  float zL = max(dot(L,N),0.01), zV = max(dot(V,N),0.01), zH = dot(H,N), zH2 = zH*zH;
  float p = exp(-0.5*(zx*zx/s2.x + zy*zy/s2.y)) / (2.0*PI*sqrt(s2.x*s2.y));
  float tV = atan(dot(V,Ty), dot(V,Tx)), cV2 = 1.0/(1.0+tV*tV), sV2 = s2.x*cV2 + s2.y*(1.0-cV2);
  float tL = atan(dot(L,Ty), dot(L,Tx)), cL2 = 1.0/(1.0+tL*tL), sL2 = s2.x*cL2 + s2.y*(1.0-cL2);
  float F = 0.02 + 0.98*pow(1.0 - dot(V,H), 5.0);
  return F * p / ((1.0 + Lambda(zL,sL2) + Lambda(zV,sV2)) * zV * zH2*zH2 * 4.0);
}
float meanFresnel(float cosV, float sigV){ return pow(1.0-cosV, 5.0*exp(-2.69*sigV)) / (1.0 + 22.7*pow(sigV,1.5)); }
float meanFresnel(vec3 Vw /*wind frame, z=N*/, vec2 s2){ vec2 t = Vw.xy*Vw.xy/(1.0-Vw.z*Vw.z); return meanFresnel(Vw.z, sqrt(dot(t,s2))); }
```

**Compose** (Skybolt's order):
```glsl
float F  = 0.02 + 0.98 * meanFresnel(Vw, s2);
vec3 R   = reflect(-V, N); R.y = abs(R.y);                    // never sample below horizon
vec3 col = reflectedSunRadiance(L, V, N, Tx, Ty, s2) * E_sun * T_sun_at_surface;  // glitter
col     += F * skyRadiance(R);                                // sky-view LUT lookup (+ clouds' sky occlusion)
col     += (1.0 - F) * seaColor * E_sky / PI;                 // upwelling, Bruneton seaColor
col      = col * T_ap + inscatter_ap;                         // aerial perspective (§1 far-field trick for far ocean)
```
- `seaColor = vec3(10,40,120)/255 * 0.1`; Skybolt uses `(0.04,0.15,0.47)*0.098` **[V `Ocean.h`]**.
- E_sky (sky irradiance at sea level): compute once per frame as a cosine-weighted average of the sky-view LUT upper hemisphere into a 1×1 target, times π.
- Skybolt widens the sun to an area light for glitter: `L' = normalize(L + c*min(1, 0.005/|c|))`, with `c = dot(L,R)R - L` **[V]**.
- Skybolt uses a fixed σ² = 0.001 (TODO in their code). Use Cox–Munk instead.
- From orbit-like altitudes the Bruneton glitter gives the correct elongated sunglint. Specular-color calibration from Earth photos in Skybolt: shininess 150 / specular 0.02 **[V]**.

### 3.5 Shallow tropical water

Needs water depth `d = seaLevel - terrainHeight`, from the terrain heightmap or a bathymetry texture.
```glsl
// Approx. clear tropical water extinction [1/m] (absorption-dominated; red from pure water ~0.34–0.45 @650 nm,
// green ~0.06 @550, blue ~0.01–0.02 @450 per Pope & Fry 1997 [R]; add scattering/CDOM for realism)
const vec3 SIGMA_T = vec3(0.45, 0.07, 0.03);
float n = 1.333;
float cv = sqrt(1.0 - (1.0 - NdotV*NdotV)/(n*n));          // refracted view cosine
float cs = sqrt(1.0 - (1.0 - NdotL*NdotL)/(n*n));          // refracted sun cosine
vec3 Td = exp(-SIGMA_T * d / max(cs,0.1)), Tu = exp(-SIGMA_T * d / max(cv,0.1));
vec3 bottom = SAND_ALBEDO / PI * (E_sun*T_sun*cs*Td + E_sky*exp(-SIGMA_T*d*1.2)) * Tu;  // sand albedo ~0.4–0.6
vec3 Lw = bottom + seaColor * E_sky / PI * (1.0 - Tu);     // deep-water term takes over with depth
col = glitter + F * sky + (1.0 - F) * Lw;
```
- Sanity check: at d = 2 m the round-trip transmittance is about (0.17, 0.76, 0.89), which reads turquoise. At 10 m it is about (0, 0.25, 0.55), which reads blue. Tune SIGMA_T per region (murky coastal is roughly (0.6, 0.25, 0.3)).
- Optional caustics: animated Voronoi/sine pattern on the bottom term, scaled by Td.

### 3.6 Foam

**Coastline foam**:
```glsl
float shore = 1.0 - smoothstep(0.0, 1.5, d);                                         // contact foam within ~1.5 m depth
float bands = smoothstep(0.75, 1.0, 0.5 + 0.5*sin(6.2831*(d/uShoreLambda - uTime*0.15) + 2.0*noise(xz*0.05)))
            * smoothstep(5.0, 0.5, d);                                               // waves breaking toward shore
float foam  = clamp(shore + bands, 0.0, 1.0) * foamTex(xz * 0.5 + uTime*0.02);
col = mix(col, 0.8 * (E_sun*max(NdotL,0.0)*T_sun + E_sky) / PI, foam);
```
- A distance-to-coast field is better than depth for band spacing on steep shores.

**Open-sea whitecaps** (Monahan & O'Muircheartaigh 1980) **[R]**:
- Coverage `W = 3.84e-6 · U^3.41`, so about 1% at 10 m/s and about 4% at 15 m/s.
- Mask whitecaps where crest slope is high: `foam = smoothstep(thr, thr+0.1, h_norm) * W-scaled noise`.
- Skybolt's foam blend **[V]**: `pow(foamTex, 2/(mask+1e-4))*smoothstep(0, 0.1, mask) + 0.15*foamTex*mask`, with foam radiance `(E_sun+E_sky)/(1.5π)`.

Sources:
- Bruneton et al. 2010, "Real-time Realistic Ocean Lighting using Seamless Transitions from Geometry to BRDF" (Eurographics). Code as vendored in https://github.com/Prograda/Skybolt (`Assets/Core/Shaders/ThirdParty/BruentonOcean.h`, `Ocean.frag`, `Ocean.h`)
- Cox–Munk: https://oceanopticsbook.info/view/surfaces/cox-munk-sea-surface-slope-statistics and https://data-ww3.ifremer.fr/BIB/Cox_Munk_JOSA1954.pdf
- Pope & Fry water absorption: https://omlc.org/spectra/water/abs/pope97.html
- Seascape: https://www.shadertoy.com/view/Ms2SD1
- afl_ext ocean: https://www.shadertoy.com/view/MdXyzX (code excerpt: https://www.leadwerks.com/community/topic/70709-interesting-water-shader/)

---------------------------------------------------------------------------------------------------
## 4. Supersonic and high-G visual effects

### 4.1 Useful atmosphere helpers

- **ISA temperature**: `T = 288.15 - 0.0065h` (h ≤ 11 km); 216.65 K (11–20 km); `216.65 + 0.001(h-20000)` (20–32 km).
- **Speed of sound**: `a = 20.047·sqrt(T)` m/s. Mach = TAS / a.
- **Dew point (Magnus)**: `γ = ln(RH) + 17.62·Tc/(243.12+Tc)`, then `Td = 243.12·γ/(17.62-γ)` in °C, with RH as a fraction.
- **Isentropic local temperature**: `T_local = T∞·(1+0.2M∞²)/(1+0.2M_local²)`. Condensation happens where `T_local < Td`.
  - Example: M∞ = 0.95 with a local supersonic pocket at M = 1.3 gives T_local/T∞ = 0.88, which is about 34 K colder at 290 K. Any humid day condenses.
- **Vortex-core pressure drop needed to condense**: `p_core/p∞ = (Td/T∞)^3.5`. Example: T = 293 K with a 3 K dew-point depression needs only about a 3.5% pressure drop.

### 4.2 Vapor cone ("Prandtl–Glauert" condensation cloud)

**Physics** **[R Wikipedia "Vapor cone", "Prandtl–Glauert singularity"]**:
- The singularity is a theoretical artifact. The real cause is expansion over the canopy and wings, where local flow is supersonic. That drops T and p below the dew point.
- The terminating shock recompresses and warms the air, so the condensate evaporates. This gives the **sharp aft edge**, located at the shock.
- It is not tied exactly to M = 1. Condensation can occur in purely subsonic flow when humidity is high.
- Typical conditions:
  - Transonic, about M 0.85–1.05, most dramatic at M 0.95–1.0.
  - Low altitude, warm, high humidity (RH ≳ 70–90%). Classic photos are near sea level over water.
  - It fades as the shocks move aft to the trailing edges once M is about 1.05–1.1.

**Shape**:
- A bell- or disc-shaped shell around the fuselage. It starts around the canopy or wing root, with the widest radius about 0.6–1.0× wingspan.
- Feathery front, crisp flat rear face, ragged with turbulence. Partial shells cover only the wing upper surfaces and the canopy hump.
- Strongly forward-scattering: very bright when backlit by the sun.

**How games do it** (recommendation):
- Use an animated mesh shell: a paraboloid or open cone, about 64 segments.
- Anchor it at the CG, aligned to the **velocity** vector.
- Alpha shader:
  ```glsl
  float machW = smoothstep(0.88, 0.96, M) * (1.0 - smoothstep(1.02, 1.10, M));
  float wet   = smoothstep(0.55, 0.85, RH) * (1.0 - smoothstep(1500.0, 4000.0, altitude_m));
  float a     = machW * wet * fresnelEdgeFade * scrollingNoise(uv*vec2(8,2) + vec2(0, t*3.0));
  // aft edge: hard cutoff at shellParam > shockPos(M) (moves aft with Mach), soft fade forward
  ```
- Lighting: `E_sun·HG(μ, 0.6)·T + E_sky/4π`, with soft particles (depth fade) and a slight flicker.
- Alternatively, use a burst of 20–40 camera-facing soft particles spawned on a ring and moved with the jet. They look good in third person and are cheaper to author.
- Also do **transient onset**: spike alpha for 0.2–0.5 s when crossing M ≈ 0.98 upward.

### 4.3 Shock diamonds (Mach diamonds) in an afterburner plume

**Spacing**:
- Distance to the first Mach disk: `x₁ ≈ 0.67·D₀·sqrt(P₀/P_amb)` **[R Wikipedia/PhysicsForums]**.
- Shock-cell spacing (Prandtl–Pack vortex-sheet model): `L ≈ π·D_j·sqrt(M_j²-1)/2.405 = 1.306·D_j·sqrt(M_j²-1)` (derived from the first zero of J0, consistent with Tam's model **[R]**).
  - M_j = 1.2, 1.4, 1.6 gives L ≈ 0.87, 1.28, 1.63 × D_j.
- Fighter afterburner nozzle exit is about 0.9–1.2 m **[R, approximate]**, so diamonds are spaced about 1–2 m apart.
- Visible count is about 4–8, decaying downstream as the shear layer mixes them out.
- Diamonds are faint in daylight. They are vivid at night or dusk, and in head-on or side views.

**Colors**:
- Afterburner core: blue/violet near the nozzle.
- Diamonds: yellow-orange to pinkish with a hot white center.
- Outer plume: orange, fading into heat haze.

**Shader** for an additive HDR cone/cylinder mesh (x = distance from nozzle in diameters, r = normalized radius):
```glsl
float L = 1.306 * sqrt(max(Mj*Mj - 1.0, 0.04));               // in D_j units; Mj ~ 1.2–1.5 with AB
float cell = pow(0.5 + 0.5*cos(6.2831 * (x - x1) / L), 6.0);  // bright nodes
float env  = exp(-x / (3.5 * L)) * smoothstep(0.0, 0.3, x);   // decay downstream
float rad  = exp(-pow(r / (0.35 + 0.05*x), 2.0));             // core
vec3  E = mix(vec3(0.5,0.6,1.0), vec3(1.0,0.55,0.2), smoothstep(0.0, 2.0, x)) * (0.3 + 2.5*cell) * env * rad;
E *= uThrottleAB * uPlumeLuminance;                           // HDR, e.g. 1e3–1e4 cd/m² pre-exposure-scaled
```
- Add a screen-space heat-haze distortion pass: sample the scene with UV offset `noise(uv*20 + t*5)*0.003`, masked by the plume.
- Scale plume length with afterburner stage and altitude: longer, wider diamonds at altitude because P_amb is lower.

### 4.4 Wingtip and LEX vortex condensation under G

**Physics** **[R atoptics, Wikipedia contrail]**:
- The vortex-core pressure drop causes adiabatic cooling below the dew point.
- It strengthens with lift, so with **load factor and AoA**.
- Most common at low altitude in humid air.
- Fighters also show **LEX vortex vapor** (F-16, F/A-18) as large swirling sheets over the wing roots at high AoA, plus whole-upper-wing condensation "sheets" in hard pulls.

**Rendering**:
- **Wingtip trails**: a ribbon (triangle strip) per tip, emitting points every frame.
  - Width 0.1–0.3 m, growing to about 1 m. Lifetime 0.5–2 s. Twist the UV with time (helical texture). Soft alpha.
  - Visibility: `a = smoothstep(nT, nT+2, n) * wet`, where `nT = mix(2.0, 6.0, clamp(dewDepression/6K, 0, 1))` (artistic, monotonic in humidity).
- **LEX vapor**: a cone-like mesh along each LEX, alpha `smoothstep(15°, 22°, AoA) * smoothstep(3, 5, n) * wet`, with flickering noise and length about 0.5–0.8× the root chord.
- **Upper-wing flash**: a decal or thin mesh over the wing with `smoothstep(6, 8, n)·wet`, fading quickly. Also spike it on rapid G onset.
- All three use the same lighting as the vapor cone, with forward-scattering HG g ≈ 0.6–0.8.

Sources:
- https://en.wikipedia.org/wiki/Vapor_cone
- https://en.wikipedia.org/wiki/Prandtl%E2%80%93Glauert_singularity
- https://en.wikipedia.org/wiki/Shock_diamond
- Tam & Tanna / Pack shock-cell model (via the search result https://ntrs.nasa.gov/api/citations/19920005579/downloads/19920005579.pdf)
- https://atoptics.co.uk/fz1135.htm (tip vortices)

---------------------------------------------------------------------------------------------------
## 5. Fighter HUD symbology (F-16 style; F-35 equivalents are helmet-mounted)

### 5.1 Layout (F-16 conventions **[R F-16 sim docs; MIL-STD-1787 not accessible]**)

**Pitch ladder**:
- Conformal 1:1: 1° on the ladder equals 1° of real angle. Rungs every **5°**.
- Above the horizon: **solid** rungs, end tabs pointing **down** (toward the horizon).
- Below the horizon: **dashed** rungs, tabs pointing **up**.
- Numbers at both rung ends.
- The horizon line is longer (about 1.5× rung width) with a center gap.
- Ladder is centered laterally on the **FPM** and rotates with roll.
- Ghost horizon: a dashed line at the HUD edge when the true horizon is off-HUD.
- Zenith star at +90°, nadir circle with a cross at -90°.
- F/A-18 style "articulated" rungs (each bent toward the horizon by half its pitch angle) is an optional variant **[R]**. A DTIC study found lower-hemisphere articulation helps unusual-attitude recovery.

**Flight path marker (velocity vector)**:
- A circle with two wings and a tail fin, drawn at the projection of the velocity direction.
- Clamp it to the HUD field of view (FOV). Real units cage or flash it when limited; when it is limited, the ladder must not be used.

**Gun cross / boresight**: a fixed cross for the aircraft waterline. FPM-to-cross vertical offset ≈ AoA.

**Readouts**:
- **Heading tape**: 5° ticks, labels every 10° as 2–3 digits ("09" = 090), caret at the current heading. F-16 places it at the bottom of the HUD with gear up and at the top with gear down **[R]**.
- **Airspeed** (left) and **altitude** (right): boxed digital readouts, optionally with scrolling vertical tapes.
  - Altitude format: thousands in a larger font, e.g. "12,5" with "00" small.
  - Radar altitude gets an "R" suffix below about 5,000 ft.
- **Upper left**: G ("1.0"), Mach ("0.85") under airspeed, max G (reset on demand).
- **AoA**: F/A-18-style "α 4.5" numeric, plus an AoA bracket/staple near the FPM with gear down (on-speed band about 11–15° AoA for F-16 approach **[R]**).
- Optional: bullseye bearing/range on the left, and a DLZ scale left of the altitude scale (Rmax / Rne / Rmin carets plus a closure readout).

**Targeting**:
- **TD box**: a square around the locked target, constant angular size, about 2–3° wide.
- If off-HUD: a **target locator line** from the gun cross toward the target, with the angle-off in degrees next to it.
- Text block: range (nm), closure (kt), target aspect.

**Missiles**:
- **AIM-9 (IR)**: a small **diamond** marks the seeker line of sight, caged on the boresight. On lock it slaves to the target and an audible tone rises.
  - An optional **missile reticle** circle around the boresight. A forum-sourced F-16 reference says "small circle = missile reticle, diamond = seeker" **[R]**.
- **AIM-120**: an **ASE circle** whose radius shrinks with range, plus a steering dot. Time to impact / active (A-pole/F-pole) after launch.

**Games (Ace Combat style)**:
- Target diamond/box per contact, with name and distance.
- A seeker circle that shrinks toward the target as lock builds over about 0.5–1.5 s, turns red on lock, and shows "LOCK"; plus an incoming-missile warning.
- Arcade games skip ASE/DLZ.

### 5.2 Conformal math (render the ladder/FPM by projecting real world directions, not by 2D offsets)

```js
// THREE.js, per frame. fwdH = horizontal component of velocity (FPM-centered ladder) or of nose.
const up = localUp;                                    // planet-normal at aircraft
const v = velocity.clone().normalize();
const fwdH = v.clone().addScaledVector(up, -v.dot(up)).normalize();
for (let p = -90; p <= 90; p += 5) {
  const dir = fwdH.clone().multiplyScalar(Math.cos(p*D2R)).addScaledVector(up, Math.sin(p*D2R));
  const s = dir.clone().add(camPos).project(camera);  // NDC; skip if behind (dot(dir, camFwd) <= 0)
  // rung center = s; rung axis = screen-projected 'right' (cross(fwdH, up)) -> encodes roll automatically
}
// Pixels per degree at screen center (useful for fixed-size symbols): ppd = (H/2)/tan(fovY/2) * PI/180
// e.g. fovY=60°, H=1080 -> 16.3 px/deg -> 5° rung spacing ~ 82 px.
```
- **AoA**: `α = atan2(-dot(v_rel, up_b), dot(v_rel, fwd_b))` (positive when the velocity is below the nose).
- **Sideslip**: `β = asin(dot(v_rel, right_b)/|v|)`.
- **G**: `n = dot(a_body - g_vec, up_b) / 9.80665`, where a_body is the inertial acceleration. Shows 1.0 in level flight.
- **Heading**: `atan2(dot(fwd, east), dot(fwd, north))`.

### 5.3 Lead-computing gun pipper (director / "predicted impact" style)

Shooter at Ps with velocity Vs. Muzzle speed Vm (M61A1 is about 1,030–1,050 m/s **[R]**). Target state Pt, Vt, and optionally At.

Solve for the time of flight t (3 fixed-point iterations suffice) and the aim point A:
```js
let t = Pt.distanceTo(Ps) / Vm;
for (let i = 0; i < 3; i++) {
  // A = Pt + (Vt - Vs) t + 0.5 At t^2 - 0.5 g t^2   (g vector points down, so -0.5 g t^2 raises the aim)
  A = Pt + (Vt - Vs)*t + 0.5*At*t*t - 0.5*gVec*t*t;
  t = A.distanceTo(Ps) / Vm;
}
// Draw pipper at project(A). Bullets fired along dir = normalize(A - Ps) hit; pilot puts the GUN CROSS on the pipper.
```
- No drag is modeled. Add a fudge such as `t *= 1 + k*range` with k ≈ 1e-4 /m for 20 mm.
- **EEGS funnel** (no lock): simulate the bullet stream fired at times τ_k = 0.25…1.5 s in the past from the *current* attitude history. Positions are `Ps(τ) + (Vs(τ)+Vm·bore(τ))·τ + ½gτ²`, rendered as a funnel whose half-width at range R_k is `atan((wingspan/2)/R_k)`. The target fits the funnel when it is in range.
- Classic LCOS reticle: a ring of about 50 mils with a 2 mil central pipper; a range arc unwinds counter-clockwise from 12 o'clock **[R]**.

### 5.4 Color, line weight and readability (games)

**Color**:
- Real HUD symbology is monochrome green (P43 phosphor peak about 545 nm; modern LED/LCD about 520–530 nm) **[R]**.
- Game-friendly green: `#3CFF6E` / linear (0.05, 1.0, 0.16).
- Locked/hostile highlights in games: red/orange.
- Ace Combat and DCS both let users pick color and brightness. DCS mimics the HUD brightness knob.

**Line weight**:
- 2 px at 1080p, scaled by `H/1080` (minimum 1.5 px). Text 16–20 px at 1080p.
- Use a monospaced cockpit font. **B612** (open-source, designed by Airbus for cockpit displays): https://github.com/polarsys/b612
- Draw lines with SDF/AA quads (a smoothstep edge of 1 px), not GL lines, since WebGL caps lineWidth at 1.

**Compositing**:
- Draw after tonemapping, in display space.
- Blend: additive for an authentic collimated look, plus a **soft dark halo** (1–2 px, 25–40% black) for readability against white clouds or the sun. Real HUDs can't do this; games do.
- Optional 3–4 px glow at 30% alpha.
- **Auto-brightness**: `hudGain = clamp(mix(0.6, 1.4, smoothstep(0.2, 0.9, sceneLumaBehindHUD)), …)`, like a real HUD's auto-brightness. Exclude the HUD from bloom.

**Scope**:
- Real HUD FOV is about 20–30° (F-16 wide-angle HUD about 25–30° total **[R]**), so keep conformal symbols inside a "HUD glass" rectangle when in cockpit view.
- In chase cam, draw the HUD screen-centered and still conformal (Ace Combat style).

Sources:
- Skybolt HUD code (pitch ladder: solid above / dashed below, 4-dash rungs, horizon 1.5× width, winglets toward horizon) **[V]**: https://github.com/Prograda/Skybolt (`src/Skybolt/AircraftHud/PitchLadderModel.cpp`, `HeadingRibbonModel.cpp`, `AltitudeBarModel.cpp`)
- F-16 sim HUD notes: https://github.com/NikolaiVChr/f16/wiki/HUD
- F-16 pitch-ladder study (DTIC): https://apps.dtic.mil/sti/pdfs/ADA268666.pdf
- DCS F-16 guide: https://chucksguides.com/aircraft/dcs/f-16cm/
- Missile and EEGS symbology discussion: https://forum.dcs.world/topic/232528-aim-9-doubts/ and https://forum.falcon-bms.com/post/21035

---------------------------------------------------------------------------------------------------
## 6. Bloom, lens flare, god rays

### 6.1 Bloom: Jimenez 2014 (CoD:AW) pyramid **[V LearnOpenGL `6.new_downsample.fs`, `6.new_upsample.fs`]**

**Downsample**:
- Run from full resolution down to 6–8 mips (pmndrs default `levels = 8`).
- Each step uses a 13-tap filter on the source: 4 overlapping 2×2 boxes (weight 0.125 each) plus a center box (0.5). The equivalent per-tap weights:
  `e·0.125 + (a+c+g+i)·0.03125 + (b+d+f+h)·0.0625 + (j+k+l+m)·0.125`
  - Taps a…i are at ±2 texels; taps j…m are at ±1 texel diagonals.
- **Karis average on the first downsample only**: weight each of the 5 groups by `1/(1+luma/4)` (luma of the sRGB-ish value) to kill fireflies. The sun and specular glitter make this mandatory here.

**Upsample**:
- 3×3 tent `[1 2 1; 2 4 2; 1 2 1]/16` with radius in UV (LearnOpenGL 0.005), progressively accumulated: `up_i = tent(up_{i+1}) + down_i`.
  - pmndrs: `mix(base, tent, radius)` with `radius = 0.85` **[V]**.
- **Composite in HDR before tonemapping**: `hdr = mix(hdr, bloom, 0.04)` (LearnOpenGL strength 0.04 **[V]**). Use no threshold, so it stays physically plausible.
  - pmndrs BloomEffect defaults: `luminanceThreshold 1.0`, `smoothing 0.03`, `intensity 1`, mipmapBlur. **Set the threshold to 0** for HDR-correct bloom **[V]**.
- Targets: RGBA16F (HalfFloatType). Rendering to them needs `EXT_color_buffer_float`; linear filtering of half floats is core in WebGL2.

**Cheaper "dual filter"** (Bjørge, ARM, SIGGRAPH 2015) **[R]**:
- Downsample: `(4·c + Σ 4 diagonal taps at ±halfpixel)/8`.
- Upsample: `(Σ 4 axis taps at ±2·halfpixel + 2·Σ 4 diagonal taps at ±halfpixel)/12`.
- About half the taps of the Jimenez filter; slightly less stable.

### 6.2 Lens flare: Chapman pseudo lens flare (Kawase 2003 lineage) **[V `john-chapman.github.io` 2017-11-05 post]**

1. Reuse a ¼–⅛-resolution bloom mip.
2. Feature pass:
   - Flip the UV: `uv = 1 - vUv`. For each ghost i, sample at `fract(uv + (0.5-uv)*spacing*i)`.
   - Weight each sample by `1 - smoothstep(0, 0.75, dist to center)`.
   - Threshold: `max(c - thr, 0)`.
   - Tint by a radial gradient LUT.
3. Halo: sample at `uv + normalize(0.5-uv)*haloRadius`, aspect-corrected, weighted by a cubic window around the halo radius.
4. Chromatic aberration: offset the R/G/B samples during feature generation.
5. Apply a separable Gaussian blur at low resolution.
6. Composite additively. Multiply by a lens-dirt texture and a starburst: a 1D texture sampled by the angle `acos(dir.x/len)`, rotated by `uStarburstOffset` derived from the camera orientation.

**Suggested starting values** (mine; tune):

| Parameter | Value |
|---|---|
| ghosts | 5–6 |
| spacing | 0.3–0.4 |
| ghost threshold | about 2–5× mid-grey after pre-exposure |
| halo radius / thickness | 0.55–0.65 / 0.08–0.12 |
| CA offset | 0.002–0.005 UV |
| composite gain | 0.002–0.02 |

- Chapman's own advice: apply it *very* judiciously, and prefer a sprite "hero" flare for the sun.
- For a flight game, drive a sprite flare from the sun's screen position. Get occlusion from a small sample of the cloud-transmittance and depth buffers around the sun (for example 4×4 taps), which also gives a correct fade behind clouds.

### 6.3 Screen-space god rays (GPU Gems 3 ch.13, Mitchell)

```glsl
vec2 dUV = (uv - sunUV) * (1.0 / float(NUM_SAMPLES)) * uDensity;
vec3 c = texture(uOccl, uv).rgb; float decay = 1.0;
for (int i = 0; i < NUM_SAMPLES; ++i) {           // occlusion buffer: sky/sun radiance where unoccluded, 0 elsewhere
  uv -= dUV; c += texture(uOccl, uv).rgb * decay * uWeight; decay *= uDecay;
}
out = c * uExposure;
```
**Parameter references**:
- pmndrs GodRaysEffect defaults **[V `GodRaysEffect.js`]**: samples 60, density 0.96, decay 0.9, weight 0.4, exposure 0.6, clampMax 1.0, resolutionScale 0.5, blur on.
- Classic port values **[R, Sanglard]**: 100 samples, density 0.84, decay 1.0, weight 5.65, exposure 0.0034.
- three.js `GodRaysShader` **[V r170]**: 3 passes × 6 taps at ¼ resolution, step `filterLen·6^-pass`, intensity 0.75.

**Recommendations**:
- Run at ½–¼ resolution with 32–64 samples. Start with blue-noise jitter (`uv -= dUV*bn`), then blur.
- Fade by `smoothstep(0.0, 0.3, dot(viewDir, sunDir))` and by the sun being on-screen (with a margin).
- Mask the occlusion input by cloud transmittance so rays emerge through cloud gaps.
- Physically better alternative for clouds: takram's "shadow length" (march the BSM along the view ray and feed it into AP in-scatter) **[V]**. Costs more, but it is correct and needs no screen-space sun.

Sources:
- Jimenez 2014: https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare
- LearnOpenGL Phys. Based Bloom: https://learnopengl.com/Guest-Articles/2022/Phys.-Based-Bloom (code: https://github.com/JoeyDeVries/LearnOpenGL/tree/master/src/8.guest/2022/6.physically_based_bloom)
- pmndrs postprocessing (`BloomEffect`, `MipmapBlurPass`, `GodRaysEffect`): https://github.com/pmndrs/postprocessing
- Chapman: https://john-chapman.github.io/2017/11/05/pseudo-lens-flare.html (source: https://github.com/john-chapman/john-chapman.github.io)
- GPU Gems 3 ch.13: https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process
- three.js GodRays: https://github.com/mrdoob/three.js/blob/r170/examples/jsm/shaders/GodRaysShader.js
