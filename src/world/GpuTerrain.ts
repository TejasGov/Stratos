import * as T from "three";
import { TERRAIN_HEIGHT_GLSL } from "./terrainGlsl";
import { FullscreenPass, passMaterial } from "../sky/FullscreenPass";

/** Heightfield levels: level k stores a 512² grid with 8·2^k m spacing. */
export const TERRAIN_LEVELS = 11;
export const TERRAIN_TEXELS = 512;
export const BASE_SPACING = 8;
/** Quads per patch edge; patches are CDLOD node quadrants. */
const PATCH = 16;
/** CDLOD LOD ranges: a node of LOD k is used up to rangeK·2^k metres (3D distance). */
const BASE_RANGE = 640;

const GENERATE = /* glsl */ `
${TERRAIN_HEIGHT_GLSL}
uniform vec2 uOrigin;
uniform float uSpacing;
uniform float uSamples;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 world = uOrigin + cell * uSpacing;
  float h = 0.0;
  if (uSamples < 1.5) h = terrainHeight(world.x, world.y);
  else {
    // Box-prefilter coarse levels so small islands do not alias away.
    for (float j = 0.0; j < 4.0; j += 1.0)
    for (float i = 0.0; i < 4.0; i += 1.0) {
      if (i >= uSamples || j >= uSamples) continue;
      vec2 o = ((vec2(i, j) + 0.5) / uSamples - 0.5) * uSpacing;
      h += terrainHeight(world.x + o.x, world.y + o.y);
    }
    h /= uSamples * uSamples;
  }
  outColor = vec4(h, 0.0, 0.0, terrainMoisture(world.x, world.y));
}`;

const GRADIENT = /* glsl */ `
uniform sampler2D tSource;
uniform float uSpacing;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 m = ivec2(${TERRAIN_TEXELS - 1});
  vec4 c = texelFetch(tSource, p, 0);
  float l = texelFetch(tSource, clamp(p - ivec2(1, 0), ivec2(0), m), 0).r;
  float r = texelFetch(tSource, clamp(p + ivec2(1, 0), ivec2(0), m), 0).r;
  float d = texelFetch(tSource, clamp(p - ivec2(0, 1), ivec2(0), m), 0).r;
  float u = texelFetch(tSource, clamp(p + ivec2(0, 1), ivec2(0), m), 0).r;
  outColor = vec4(c.r, (r - l) / (2.0 * uSpacing), (u - d) / (2.0 * uSpacing), c.a);
}`;

/** Shared sampling helpers for terrain vertex and fragment shaders. */
export const TERRAIN_SAMPLE_GLSL = /* glsl */ `
uniform highp sampler2DArray tHeights;
uniform vec2 uLevelOrigin[${TERRAIN_LEVELS}];
float levelSpacing(int level) { return ${BASE_SPACING.toFixed(1)} * exp2(float(level)); }
/** Bilinear (height, dh/dx, dh/dz, moisture) at a render-local position. */
vec4 terrainSample(int level, vec2 local) {
  vec2 t = (local - uLevelOrigin[level]) / levelSpacing(level);
  t = clamp(t, vec2(0.0), vec2(${TERRAIN_TEXELS - 2}.0));
  vec2 i = floor(t), f = t - i;
  ivec2 p = ivec2(i);
  vec4 a = texelFetch(tHeights, ivec3(p, level), 0);
  vec4 b = texelFetch(tHeights, ivec3(p + ivec2(1, 0), level), 0);
  vec4 c = texelFetch(tHeights, ivec3(p + ivec2(0, 1), level), 0);
  vec4 d = texelFetch(tHeights, ivec3(p + ivec2(1, 1), level), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
/** Finest level whose grid still covers the point with a safety margin. */
int terrainLevelFor(vec2 local, int preferred) {
  for (int k = 0; k < ${TERRAIN_LEVELS}; k++) {
    if (k < preferred) continue;
    vec2 t = (local - uLevelOrigin[k]) / levelSpacing(k);
    if (all(greaterThan(t, vec2(2.0))) && all(lessThan(t, vec2(${TERRAIN_TEXELS - 3}.0)))) return k;
  }
  return ${TERRAIN_LEVELS - 1};
}
`;

interface Level {
  /** Global texel index of texel (0,0). */
  originX: number;
  originZ: number;
  valid: boolean;
}

/**
 * GPU terrain: the gameplay height function baked into a float heightfield
 * clipmap, drawn as a CDLOD quadtree of instanced, morphing, skirted patches
 * reaching the horizon (~650 km) with Earth curvature applied per vertex.
 */
export class GpuTerrain {
  readonly heights = new T.WebGLArrayRenderTarget(
    TERRAIN_TEXELS,
    TERRAIN_TEXELS,
    TERRAIN_LEVELS,
    {
      type: T.FloatType,
      format: T.RGBAFormat,
      minFilter: T.NearestFilter,
      magFilter: T.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    },
  );
  readonly mesh: T.Mesh<T.InstancedBufferGeometry, T.Material>;
  readonly levelOrigins = Array.from(
    { length: TERRAIN_LEVELS },
    () => new T.Vector2(),
  );
  readonly cameraLocal = new T.Vector3();
  readonly morph = Array.from({ length: TERRAIN_LEVELS }, () => new T.Vector2());
  private levels: Level[] = Array.from({ length: TERRAIN_LEVELS }, () => ({
    originX: 0,
    originZ: 0,
    valid: false,
  }));
  private scratch = new T.WebGLRenderTarget(TERRAIN_TEXELS, TERRAIN_TEXELS, {
    type: T.FloatType,
    format: T.RGBAFormat,
    minFilter: T.NearestFilter,
    magFilter: T.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  private generate = new FullscreenPass(
    passMaterial({
      fragmentShader: GENERATE,
      uniforms: {
        uOrigin: { value: new T.Vector2() },
        uSpacing: { value: 1 },
        uSamples: { value: 1 },
      },
    }),
  );
  private gradient = new FullscreenPass(
    passMaterial({
      fragmentShader: GRADIENT,
      uniforms: { tSource: { value: this.scratch.texture }, uSpacing: { value: 1 } },
    }),
  );
  private patches: T.InstancedBufferAttribute;
  private patchData: Float32Array;
  private maxPatches = 1600;
  private ranges: number[] = [];
  detail = 1;
  stats = { patches: 0, regenerated: 0 };
  constructor(material: T.Material) {
    for (let k = 0; k < TERRAIN_LEVELS; k++)
      this.ranges.push(BASE_RANGE * 2 ** k);
    const geometry = new T.InstancedBufferGeometry();
    const positions: number[] = [];
    const indices: number[] = [];
    // Interior grid, then a skirt ring flagged with y = -1 that hangs below the edge.
    for (let j = 0; j <= PATCH; j++)
      for (let i = 0; i <= PATCH; i++) positions.push(i / PATCH, 0, j / PATCH);
    const grid = (i: number, j: number) => j * (PATCH + 1) + i;
    for (let j = 0; j < PATCH; j++)
      for (let i = 0; i < PATCH; i++) {
        const a = grid(i, j),
          b = grid(i + 1, j),
          c = grid(i, j + 1),
          d = grid(i + 1, j + 1);
        indices.push(a, c, b, b, c, d);
      }
    const edge: [number, number][] = [];
    for (let i = 0; i < PATCH; i++) edge.push([i, 0]);
    for (let j = 0; j < PATCH; j++) edge.push([PATCH, j]);
    for (let i = PATCH; i > 0; i--) edge.push([i, PATCH]);
    for (let j = PATCH; j > 0; j--) edge.push([0, j]);
    const skirtStart = positions.length / 3;
    for (const [i, j] of edge) positions.push(i / PATCH, -1, j / PATCH);
    for (let e = 0; e < edge.length; e++) {
      const n = (e + 1) % edge.length;
      const top0 = grid(...edge[e]),
        top1 = grid(...edge[n]);
      const bottom0 = skirtStart + e,
        bottom1 = skirtStart + n;
      indices.push(top0, bottom0, top1, top1, bottom0, bottom1);
    }
    geometry.setAttribute(
      "position",
      new T.Float32BufferAttribute(positions, 3),
    );
    geometry.setIndex(indices);
    this.patchData = new Float32Array(this.maxPatches * 4);
    this.patches = new T.InstancedBufferAttribute(this.patchData, 4);
    this.patches.setUsage(T.DynamicDrawUsage);
    geometry.setAttribute("aPatch", this.patches);
    geometry.instanceCount = 0;
    this.mesh = new T.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }
  /** Uniforms for the terrain material's shaders. */
  get uniforms() {
    return {
      tHeights: { value: this.heights.texture },
      uLevelOrigin: { value: this.levelOrigins },
      uTerrainCamera: { value: this.cameraLocal },
      uMorph: { value: this.morph },
    };
  }
  /** Rebuilds heightfield levels that drifted too far from the camera (at most `budget` per call). */
  private updateLevels(
    renderer: T.WebGLRenderer,
    camera: T.Vector3,
    origin: T.Vector3,
    budget: number,
  ) {
    const previous = renderer.getRenderTarget();
    let used = 0;
    for (let k = 0; k < TERRAIN_LEVELS && used < budget; k++) {
      const spacing = BASE_SPACING * 2 ** k;
      const level = this.levels[k];
      const cx = Math.round(camera.x / spacing) - TERRAIN_TEXELS / 2;
      const cz = Math.round(camera.z / spacing) - TERRAIN_TEXELS / 2;
      if (
        level.valid &&
        Math.abs(cx - level.originX) < 64 &&
        Math.abs(cz - level.originZ) < 64
      )
        continue;
      level.originX = cx;
      level.originZ = cz;
      level.valid = true;
      const g = this.generate.material.uniforms;
      g.uOrigin.value.set(cx * spacing, cz * spacing);
      g.uSpacing.value = spacing;
      // Near levels stay exact (crack-free morphs); coarse levels are box-prefiltered.
      g.uSamples.value = k < 4 ? 1 : k < 6 ? 2 : k < 8 ? 3 : 4;
      this.generate.render(renderer, this.scratch);
      this.gradient.material.uniforms.uSpacing.value = spacing;
      this.gradient.render(renderer, this.heights, k);
      used++;
      this.stats.regenerated++;
    }
    renderer.setRenderTarget(previous);
    for (let k = 0; k < TERRAIN_LEVELS; k++) {
      const spacing = BASE_SPACING * 2 ** k;
      this.levelOrigins[k].set(
        this.levels[k].originX * spacing - origin.x,
        this.levels[k].originZ * spacing - origin.z,
      );
    }
  }
  /** Is the axis-aligned node within `range` (3D) of the camera? */
  private near(x: number, z: number, size: number, cam: T.Vector3, range: number) {
    const dx = Math.max(x - cam.x, 0, cam.x - (x + size));
    const dz = Math.max(z - cam.z, 0, cam.z - (z + size));
    const dy = Math.max(-100 - cam.y, 0, cam.y - 1700);
    return dx * dx + dy * dy + dz * dz < range * range;
  }
  private count = 0;
  private emit(x: number, z: number, size: number, lod: number, origin: T.Vector3) {
    if (this.count >= this.maxPatches) return;
    const o = this.count++ * 4;
    this.patchData[o] = x - origin.x;
    this.patchData[o + 1] = z - origin.z;
    this.patchData[o + 2] = size;
    this.patchData[o + 3] = lod;
  }
  /** CDLOD selection: nodes split while the camera is within the finer range. */
  private select(
    x: number,
    z: number,
    lod: number,
    cam: T.Vector3,
    origin: T.Vector3,
  ): boolean {
    const size = BASE_SPACING * PATCH * 2 * 2 ** lod;
    const ranges = this.ranges;
    if (!this.near(x, z, size, cam, ranges[lod] * this.detail)) return false;
    const half = size / 2;
    if (lod === 0 || !this.near(x, z, size, cam, ranges[lod - 1] * this.detail)) {
      for (let q = 0; q < 4; q++)
        this.emit(x + (q & 1) * half, z + (q >> 1) * half, half, lod, origin);
      return true;
    }
    for (let q = 0; q < 4; q++) {
      const qx = x + (q & 1) * half,
        qz = z + (q >> 1) * half;
      if (!this.select(qx, qz, lod - 1, cam, origin))
        this.emit(qx, qz, half, lod, origin);
    }
    return true;
  }
  update(
    renderer: T.WebGLRenderer,
    cameraGlobal: T.Vector3,
    origin: T.Vector3,
    firstFrame = false,
  ) {
    this.updateLevels(renderer, cameraGlobal, origin, firstFrame ? TERRAIN_LEVELS : 2);
    this.cameraLocal.copy(cameraGlobal).sub(origin);
    for (let k = 0; k < TERRAIN_LEVELS; k++) {
      const end = this.ranges[k] * this.detail;
      this.morph[k].set(end * 0.72, end * 0.97);
    }
    this.count = 0;
    const top = TERRAIN_LEVELS - 1;
    const rootSize = BASE_SPACING * PATCH * 2 * 2 ** top;
    const rx = Math.floor(cameraGlobal.x / rootSize),
      rz = Math.floor(cameraGlobal.z / rootSize);
    for (let j = -2; j <= 2; j++)
      for (let i = -2; i <= 2; i++)
        this.select((rx + i) * rootSize, (rz + j) * rootSize, top, cameraGlobal, origin);
    this.mesh.geometry.instanceCount = this.count;
    this.patches.needsUpdate = true;
    this.patches.clearUpdateRanges();
    this.patches.addUpdateRange(0, this.count * 4);
    this.stats.patches = this.count;
  }
  /** Development check: max |GPU − reference| height over a block of level texels. */
  parity(
    renderer: T.WebGLRenderer,
    level: number,
    reference: (x: number, z: number) => number,
  ) {
    const out = new Float32Array(64 * 64 * 4);
    // Binding the target selects which array layer the framebuffer reads.
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.heights, level);
    renderer.readRenderTargetPixels(this.heights, 224, 224, 64, 64, out);
    renderer.setRenderTarget(previous);
    const spacing = BASE_SPACING * 2 ** level;
    let worst = 0;
    for (let j = 0; j < 64; j++)
      for (let i = 0; i < 64; i++) {
        const x = (this.levels[level].originX + 224 + i) * spacing,
          z = (this.levels[level].originZ + 224 + j) * spacing;
        worst = Math.max(worst, Math.abs(out[(j * 64 + i) * 4] - reference(x, z)));
      }
    return worst;
  }
  dispose() {
    this.heights.dispose();
    this.scratch.dispose();
    this.generate.dispose();
    this.gradient.dispose();
    this.mesh.geometry.dispose();
  }
}

/** Vertex stage injected into the terrain's MeshStandardMaterial. */
export const TERRAIN_VERTEX_GLSL = /* glsl */ `
attribute vec4 aPatch;
uniform vec3 uTerrainCamera;
uniform vec2 uMorph[${TERRAIN_LEVELS}];
varying vec3 vTerrainLocal;
varying float vTerrainHeight;
varying float vTerrainLod;
${TERRAIN_SAMPLE_GLSL}
`;

export const TERRAIN_DISPLACE_GLSL = /* glsl */ `
  int lod = int(aPatch.w + 0.5);
  float spacing = aPatch.z / ${PATCH}.0;
  vec2 gridPos = position.xz * ${PATCH}.0;
  vec2 local = aPatch.xy + gridPos * spacing;
  vec4 s0 = terrainSample(lod, local);
  float dist = distance(vec3(local.x, s0.r, local.y), uTerrainCamera);
  float morphK = clamp((dist - uMorph[lod].x) / (uMorph[lod].y - uMorph[lod].x), 0.0, 1.0);
  // CDLOD: odd vertices slide onto the next coarser grid as distance grows.
  vec2 frac = fract(gridPos * 0.5) * 2.0;
  local -= frac * spacing * morphK;
  vec4 s = terrainSample(lod, local);
  // Geomorph heights toward the next (prefiltered) level so neighbours meet exactly.
  if (morphK > 0.0 && lod < ${TERRAIN_LEVELS - 1}) s = mix(s, terrainSample(lod + 1, local), morphK);
  float h = s.r;
  if (position.y < -0.5) h -= spacing * 2.5 + 6.0;
  vec2 rel = local - uTerrainCamera.xz;
  // Earth curvature around the camera, matching the analytic ocean sphere.
  float drop = dot(rel, rel) / (2.0 * 6360000.0);
  vec3 terrainPosition = vec3(local.x, h - drop, local.y);
  vec3 terrainNormal = normalize(vec3(-s.g, 1.0, -s.b));
  vTerrainLocal = vec3(local.x, h, local.y);
  vTerrainHeight = h;
  vTerrainLod = float(lod);
`;
