import * as T from "three";
import type { WorldQuality } from "./quality";
import { TERRAIN_HEIGHT_GLSL } from "../world/terrainGlsl";
import {
  TERRAIN_DISPLACE_GLSL,
  TERRAIN_VERTEX_GLSL,
  TERRAIN_SAMPLE_GLSL,
  TERRAIN_LEVELS,
} from "../world/GpuTerrain";

const root = `${import.meta.env.BASE_URL}assets/polyhaven/`;
const sources = [
  "aerial_grass_rock",
  "aerial_rocks_02",
  "aerial_sand",
] as const;

const FRAGMENT_HEADER = /* glsl */ `
varying vec3 vTerrainLocal;
varying float vTerrainHeight;
varying float vTerrainLod;
uniform vec3 uRenderOrigin;
uniform vec3 uTerrainCamera;
uniform vec3 uLightDirection;
uniform float terrainDetail;
uniform float uTerrainShadows;
uniform sampler2D grassColor, grassNormal, grassArm, rockColor, rockNormal, rockArm, sandColor, sandNormal, sandArm;
${TERRAIN_SAMPLE_GLSL}
${TERRAIN_HEIGHT_GLSL}
float tfHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float tfNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tfHash(i), tfHash(i + vec2(1, 0)), f.x), mix(tfHash(i + vec2(0, 1)), tfHash(i + 1.0), f.x), f.y);
}
float tfFbm(vec2 p) {
  return tfNoise(p) * 0.5 + tfNoise(p * 2.03 + 7.1) * 0.25 + tfNoise(p * 4.1 + 3.7) * 0.125 + tfNoise(p * 8.3 + 1.3) * 0.0625;
}
/** Tree-crown cells: distance to the nearest crown centre and a per-crown random value. */
vec2 crowns(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float best = 9.0, id = 0.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(float(x), float(y));
    vec2 c = o + vec2(tfHash(i + o), tfHash(i + o + 17.3)) * 0.8 + 0.1 - f;
    float d = dot(c, c);
    if (d < best) { best = d; id = tfHash(i + o + 5.1); }
  }
  return vec2(sqrt(best), id);
}
vec3 texBlend(sampler2D map, vec2 uv) {
  // Two rotated scales hide the 1K texture's tiling from altitude.
  vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.147 + vec2(0.37, 0.71);
  return mix(texture(map, uv).rgb, texture(map, uv2).rgb, 0.45);
}
vec3 terrainTri(sampler2D image, vec3 p, vec3 n, vec3 w) {
  // Two scales per axis break up the rock texture's tiling on long cliffs.
  vec3 a = texture(image, p.zy).rgb * w.x + texture(image, p.xz).rgb * w.y + texture(image, p.xy).rgb * w.z;
  vec3 q = p * 0.23 + 0.31;
  vec3 b = texture(image, q.zy).rgb * w.x + texture(image, q.xz).rgb * w.y + texture(image, q.xy).rgb * w.z;
  return mix(a, b, 0.5);
}
/** Soft heightfield shadow toward the light: long mountain shadows at low sun. */
float terrainShadow(vec3 local, float dist) {
  vec3 L = uLightDirection;
  float flatLen = length(L.xz);
  if (L.y <= 0.0) return 0.0;
  if (flatLen < 1e-3) return 1.0;
  vec2 dir = L.xz / flatLen;
  float slope = L.y / flatLen;
  float shade = 1.0;
  float s = 12.0 + dist * 0.004;
  int startLevel = int(vTerrainLod + 0.5);
  for (int i = 0; i < 10; i++) {
    vec2 p = local.xz + dir * s;
    int lvl = terrainLevelFor(p, startLevel + int(log2(max(s / 96.0, 1.0))));
    float ground = terrainSample(lvl, p).r;
    float ray = local.y + slope * s + 2.0 + s * 0.002;
    shade = min(shade, clamp((ray - ground) / (s * 0.06) + 0.5, 0.0, 1.0));
    s *= 1.75;
  }
  return shade;
}
`;

/** Terrain shading: biomes, forest canopy, beaches, seabed, and the underwater alpha flag. */
const COLOR_FRAGMENT = /* glsl */ `
  vec3 tLocal = vTerrainLocal;
  vec3 tWorld = tLocal + uRenderOrigin;
  float tDist = length(tLocal - uTerrainCamera);
  int fineLevel = terrainLevelFor(tLocal.xz, max(int(vTerrainLod + 0.5) - 1, 0));
  vec4 tS = terrainSample(fineLevel, tLocal.xz);
  vec3 tN = normalize(vec3(-tS.g, 1.0, -tS.b));
  float tH = tS.r;
  float moisture = tS.a;
  float slope = 1.0 - tN.y;
  vec2 g = tWorld.xz;
  float macro = tfFbm(g / 1400.0);
  float mid = tfFbm(g / 260.0 + 9.0);
  float footprint = tDist * 0.0012;
  float detailFade = 1.0 - smoothstep(600.0, 4500.0, tDist);
  // Biome masks.
  float rock = smoothstep(0.33, 0.55, slope + (mid - 0.5) * 0.18) ;
  rock = max(rock, smoothstep(1050.0, 1450.0, tH + mid * 140.0) * 0.75);
  float beach = (1.0 - smoothstep(4.0, 11.0 + mid * 8.0, tH)) * (1.0 - smoothstep(0.18, 0.3, slope));
  float wet = 1.0 - smoothstep(0.4, 2.2, tH);
  float forest = terrainForest(tWorld.x, tWorld.z, tH, slope, moisture);
  // Ground: photographed grass/rock/sand with broad hue variation.
  vec2 uv = vec2(g.x, -g.y) / 17.0;
  vec3 grass = texBlend(grassColor, uv);
  grass *= mix(vec3(0.42, 0.78, 0.32), vec3(0.66, 0.86, 0.38), macro) * 1.5;
  grass = mix(grass, vec3(0.07, 0.12, 0.035) * (0.85 + macro * 0.4), smoothstep(0.0, 1.0, footprint * 0.04) * 0.6);
  vec3 tWeights = pow(abs(tN), vec3(4.0));
  tWeights /= dot(tWeights, vec3(1.0));
  vec3 stone = terrainTri(rockColor, tWorld / 55.0, tN, tWeights) * vec3(1.05, 0.98, 0.9) * 1.3;
  stone = mix(stone, vec3(0.22, 0.2, 0.18) * (0.8 + mid * 0.4), smoothstep(800.0, 6000.0, tDist) * 0.7);
  vec3 sand = texBlend(sandColor, uv * 1.4) * vec3(1.18, 1.08, 0.92);
  sand = mix(sand, sand * vec3(0.55, 0.52, 0.5), wet);
  // Forest canopy: crowns read as a textured green carpet from altitude.
  vec2 cr = crowns(g / 7.5);
  float crownShape = 1.0 - smoothstep(0.25, 0.62, cr.x);
  vec3 canopy = mix(vec3(0.028, 0.065, 0.022), vec3(0.075, 0.13, 0.035), cr.y) * (0.55 + 0.75 * crownShape);
  canopy = mix(canopy, vec3(0.04, 0.085, 0.028) * (0.8 + macro * 0.5), smoothstep(0.6, 2.2, footprint / 7.5));
  canopy *= mix(vec3(1.0), vec3(1.15, 1.05, 0.75), smoothstep(0.55, 0.9, macro));
  vec3 ground = mix(grass, canopy, forest);
  ground = mix(ground, stone, rock);
  ground = mix(ground, sand, beach);
  // Seabed below the waterline: pale sand reefs, darkening offshore (seen through the ocean).
  float seabed = 1.0 - smoothstep(-0.5, 0.5, tH);
  vec3 bed = mix(vec3(0.55, 0.5, 0.38), vec3(0.18, 0.2, 0.16), smoothstep(-25.0, -80.0, tH) * 0.7 + mid * 0.3);
  ground = mix(ground, bed, seabed);
  diffuseColor.rgb = ground;
  float terrainAlpha = tH < 0.0 ? 0.0 : 1.0;
  float terrainRough = mix(0.92, 0.75, rock) - wet * beach * 0.45;
  float terrainAo = mix(1.0, 0.55 + 0.45 * crownShape, forest * detailFade);
`;

const NORMAL_FRAGMENT = /* glsl */ `
  {
    vec3 nWorld = tN;
    if (terrainDetail > 0.01 && detailFade > 0.0) {
      vec3 gn = texture(grassNormal, uv).xyz * 2.0 - 1.0;
      vec3 sn = texture(sandNormal, uv * 1.4).xyz * 2.0 - 1.0;
      vec3 rn = texture(rockNormal, (tWorld / 55.0).xz).xyz * 2.0 - 1.0;
      vec3 dn = mix(mix(gn, rn, rock), sn, beach);
      vec3 perturbed = normalize(tN + vec3(dn.x, 0.0, -dn.y) * 0.55 * terrainDetail);
      nWorld = normalize(mix(tN, perturbed, detailFade * (1.0 - forest * 0.6)));
    }
    normal = normalize(mat3(viewMatrix) * nWorld);
  }
`;

/** CDLOD heightfield terrain material (MeshStandardMaterial + injected terrain stages). */
export class TerrainMaterials {
  readonly material = new T.MeshStandardMaterial({
    roughness: 1,
    metalness: 0,
  });
  readonly ready: Promise<void>;
  private textures: T.Texture[] = [];
  private disposed = false;
  private uniforms: Record<string, T.IUniform>;
  private anisotropy = 1;
  loadError: string | null = null;
  constructor(
    renderOrigin: T.Vector3,
    terrainUniforms: Record<string, T.IUniform>,
    lightDirection: T.Vector3,
  ) {
    const placeholder = (rgb: number[]) => {
      const texture = new T.DataTexture(new Uint8Array([...rgb, 255]), 1, 1);
      texture.needsUpdate = true;
      this.textures.push(texture);
      return texture;
    };
    const color = placeholder([96, 112, 74]),
      normal = placeholder([128, 128, 255]),
      arm = placeholder([255, 230, 0]);
    this.uniforms = {
      ...terrainUniforms,
      uRenderOrigin: { value: renderOrigin },
      uLightDirection: { value: lightDirection },
      terrainDetail: { value: 0.6 },
      uTerrainShadows: { value: 1 },
    };
    for (const prefix of ["grass", "rock", "sand"]) {
      this.uniforms[`${prefix}Color`] = { value: color };
      this.uniforms[`${prefix}Normal`] = { value: normal };
      this.uniforms[`${prefix}Arm`] = { value: arm };
    }
    this.material.customProgramCacheKey = () => "stratos-gpu-terrain-v1";
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = TERRAIN_VERTEX_GLSL + shader.vertexShader;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <beginnormal_vertex>",
          `${TERRAIN_DISPLACE_GLSL}\n  vec3 objectNormal = terrainNormal;`,
        )
        .replace(
          "#include <begin_vertex>",
          "vec3 transformed = terrainPosition;",
        );
      shader.fragmentShader = FRAGMENT_HEADER + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>\n${COLOR_FRAGMENT}`,
        )
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\n  roughnessFactor = terrainRough;",
        )
        .replace(
          "#include <normal_fragment_maps>",
          `#include <normal_fragment_maps>\n${NORMAL_FRAGMENT}`,
        )
        .replace(
          "#include <aomap_fragment>",
          `#include <aomap_fragment>
  reflectedLight.indirectDiffuse *= terrainAo;`,
        )
        .replace(
          "#include <lights_fragment_end>",
          `#include <lights_fragment_end>
  if (uTerrainShadows > 0.5) {
    float hs = terrainShadow(vec3(tLocal.x, tH, tLocal.z), tDist);
    reflectedLight.directDiffuse *= hs;
    reflectedLight.directSpecular *= hs;
  }`,
        )
        .replace(
          "#include <opaque_fragment>",
          "gl_FragColor = vec4(outgoingLight, terrainAlpha);",
        );
    };
    this.ready = this.load();
  }
  private async load() {
    const loader = new T.TextureLoader();
    const prefixes = ["grass", "rock", "sand"];
    const suffixes = [
      ["diff", "Color"],
      ["nor_gl", "Normal"],
      ["arm", "Arm"],
    ];
    try {
      await Promise.all(
        sources.flatMap((asset, i) =>
          suffixes.map(async ([suffix, kind]) => {
            const texture = await loader.loadAsync(
              `${root}${asset}_${suffix}_1k.jpg`,
            );
            if (this.disposed) {
              texture.dispose();
              return;
            }
            texture.colorSpace =
              kind === "Color" ? T.SRGBColorSpace : T.NoColorSpace;
            texture.wrapS = texture.wrapT = T.RepeatWrapping;
            texture.anisotropy = this.anisotropy;
            texture.needsUpdate = true;
            this.textures.push(texture);
            this.uniforms[`${prefixes[i]}${kind}`].value = texture;
          }),
        ),
      );
    } catch (error) {
      this.loadError = String(error);
    }
  }
  configure(renderer: T.WebGLRenderer) {
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.textures.forEach((texture) => {
      texture.anisotropy = this.anisotropy;
      texture.needsUpdate = true;
    });
  }
  setQuality(quality: WorldQuality) {
    this.uniforms.terrainDetail.value =
      quality === "low" ? 0 : quality === "high" ? 0.85 : 0.6;
    this.uniforms.uTerrainShadows.value = quality === "low" ? 0 : 1;
  }
  dispose() {
    this.disposed = true;
    this.textures.forEach((texture) => texture.dispose());
    this.textures.length = 0;
    this.material.dispose();
  }
}

export { TERRAIN_LEVELS };
