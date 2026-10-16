import { FUNNEL_FAR, FUNNEL_NEAR, PADS } from "./basePads";
export const CHUNK = 1600;
export const SEED = 7319;
export function hash(x: number, z: number) {
  let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ SEED;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp = (t: number) => Math.min(1, Math.max(0, t));
function ellipse(
  x: number,
  z: number,
  cx: number,
  cz: number,
  rx: number,
  rz: number,
) {
  return smooth(clamp(1 - Math.hypot((x - cx) / rx, (z - cz) / rz)));
}
/** 1 on an air-base pad, fading over its blend skirt: keeps trees and scenery off it. */
function padMask(x: number, z: number) {
  let m = 0;
  for (const pad of PADS) {
    const qx = Math.max(Math.abs(x - pad.x) - pad.hx, 0);
    const qz = Math.max(Math.abs(z - pad.z) - pad.hz, 0);
    m = Math.max(m, 1 - smooth(clamp(Math.hypot(qx, qz) / pad.blend)));
  }
  return m;
}
/** Geographical masks shared by materials, prop placement and terrain shaping. */
export function regionMasks(x: number, z: number) {
  const valleyCenter = 180 + Math.sin((z + 900) / 1100) * 370;
  const drainage =
    Math.exp(-(((x - valleyCenter) / 380) ** 2)) *
    ellipse(x, z, 250, -1200, 1700, 2700);
  const infrastructure = Math.max(
    padMask(x, z),
    ellipse(x, z, 1850, -1050, 500, 650),
  );
  const moisture = clamp(
    0.35 + noise(x / 2200 + 61, z / 2200) * 0.5 + drainage * 0.25,
  );
  return { drainage, infrastructure, moisture };
}
export function noise(x: number, z: number) {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    u = smooth(x - ix),
    v = smooth(z - iz);
  const a = hash(ix, iz),
    b = hash(ix + 1, iz),
    c = hash(ix, iz + 1),
    d = hash(ix + 1, iz + 1);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
export function heightAt(x: number, z: number): number {
  // Domain warp shared by every island: irregular coasts, bays and capes.
  const wx =
    x +
    (noise(x / 2400 + 3, z / 2400) - 0.5) * 1700 +
    (noise(x / 760, z / 760 + 11) - 0.5) * 520;
  const wz =
    z +
    (noise(x / 2400, z / 2400 + 7) - 0.5) * 1700 +
    (noise(x / 760 + 5, z / 760) - 0.5) * 520;
  const cell = 6200,
    cx = Math.round(x / cell),
    cz = Math.round(z / cell);
  let island = 0,
    shelf = 0;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const ix = cx + dx,
        iz = cz + dz;
      const home = ix === 0 && iz === 0;
      const landmark = home || (ix === 0 && iz === -1) || (ix === -1 && iz === 0);
      if (!landmark && hash(ix + 71, iz - 5) < 0.2) continue;
      const px = ix * cell + (hash(ix + 11, iz) - 0.5) * 1800;
      const pz = iz * cell + (hash(ix, iz + 53) - 0.5) * 1800;
      let size = 0.5 + 1.3 * hash(ix + 29, iz + 3) ** 2,
        elongation = 0.6 + 0.9 * hash(ix + 13, iz + 29),
        angle = hash(ix + 5, iz + 41) * Math.PI;
      if (home) {
        size = 1.25;
        elongation = 1;
        angle = 0;
      } else if (landmark) size = Math.max(size, 0.95);
      // Radii stay inside the 3×3 cell search window, avoiding straight cut-offs.
      const rx = Math.min(5000, (2200 + hash(ix + 3, iz) * 900) * size * elongation);
      const rz = Math.min(5000, ((1800 + hash(ix, iz + 8) * 1000) * size) / elongation);
      const c = Math.cos(angle),
        s = Math.sin(angle);
      const qx = ((wx - px) * c - (wz - pz) * s) / rx,
        qz = ((wx - px) * s + (wz - pz) * c) / rz;
      const r = qx * qx + qz * qz;
      const peak = home ? 1 : 0.4 + 0.6 * hash(ix - 7, iz + 13);
      island = Math.max(island, Math.max(0, 1 - r) ** 1.5 * peak);
      // Shallow lagoon shelf around the coast, of varying width.
      const width = 1.6 * (0.4 + 0.6 * hash(ix + 37, iz - 11));
      shelf = Math.max(shelf, smooth(clamp((1 + width - r) / width)));
    }
  // Islets and reef shoals on a finer lattice.
  const cell2 = 2300,
    ix2 = Math.round(x / cell2),
    iz2 = Math.round(z / cell2);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const ix = ix2 + dx,
        iz = iz2 + dz;
      if (hash(ix + 201, iz + 17) >= 0.22) continue;
      const px = ix * cell2 + (hash(ix + 19, iz) - 0.5) * 1300;
      const pz = iz * cell2 + (hash(ix, iz + 23) - 0.5) * 1300;
      const radius = 220 + hash(ix + 9, iz + 2) * 480;
      const r = ((wx - px) ** 2 + (wz - pz) ** 2) / (radius * radius);
      island = Math.max(island, Math.max(0, 1 - r) ** 1.2 * 0.2);
      shelf = Math.max(shelf, smooth(clamp((3.2 - r) / 2.2)) * 0.9);
    }
  const large = noise(x / 1600, z / 1600),
    ridge = 1 - Math.abs(noise(x / 630 + 17, z / 630) * 2 - 1);
  const reef = (noise(x / 140 + 2, z / 140) - 0.5) * 10;
  let h =
    -95 +
    shelf * (84 + reef) +
    island * (440 + large * 900 + ridge ** 3 * 380) +
    island * (noise(x / 180, z / 180) - 0.5) * 80;
  // Authored Haven basin: winding mountain corridor opening onto an eastern shelf.
  // The influence fades smoothly, retaining seeded islands outside the sortie region.
  const influence = ellipse(x, z, 0, -700, 4800, 4400);
  const spine =
    Math.exp(-(((x + 250) / 1050) ** 2)) *
    Math.exp(-(((z + 1750) / 1900) ** 2));
  const masks = regionMasks(x, z);
  h += influence * (spine * 510 - masks.drainage * 250);
  const portShelf = ellipse(x, z, 1870, -1050, 900, 1150);
  h = h * (1 - portShelf) + (26 + noise(x / 350, z / 350) * 20) * portShelf;
  const port = ellipse(x, z, 1850, -1050, 390, 500);
  h = h * (1 - port) + 22 * port;
  // Keep the bridge spanning a channel rather than buried inside a ridge.
  const channel = ellipse(x, z, 2500, -500, 240, 850);
  h = h * (1 - channel) - 14 * channel;
  return applyPads(x, z, h);
}
/**
 * Air-base ground: flat core, blend skirt and a clearance funnel that lowers
 * terrain climbing off the runway ends. The GLSL twin is `applyPads` in
 * terrainGlsl.ts (tests/bases.test.ts checks they agree).
 */
export function applyPads(x: number, z: number, h: number): number {
  for (const pad of PADS) {
    const qx = Math.max(Math.abs(x - pad.x) - pad.hx, 0);
    const qz = Math.max(Math.abs(z - pad.z) - pad.hz, 0);
    const outside = Math.sqrt(qx * qx + qz * qz);
    // Rugged, noisy ceiling rising off the pad; the soft minimum only ever cuts.
    const rise = qx * pad.slopeX + qz * pad.slopeZ;
    const cap = pad.height + rise * (1 + (noise(x / 260, z / 260) - 0.5) * 0.5);
    const k = 40;
    const d = Math.max(k - Math.abs(h - cap), 0);
    const smin = Math.min(h, cap) - (d * d) / (4 * k);
    const reach = 1 - smooth(clamp((outside - FUNNEL_NEAR) / (FUNNEL_FAR - FUNNEL_NEAR)));
    const carved = h + reach * (smin - h);
    const t = clamp(outside / pad.blend);
    const flat = 1 - t * t * (3 - 2 * t);
    h = carved + flat * (pad.height - carved);
  }
  return h;
}
/**
 * Forest density shared by tree placement and the GPU canopy shading
 * (`terrainForest` in terrainGlsl.ts mirrors this exactly).
 */
export function forestMask(
  x: number,
  z: number,
  h: number,
  slope: number,
  moisture: number,
) {
  const macro = noise(x / 1400 + 31, z / 1400);
  const mid = noise(x / 260 + 9, z / 260);
  const smooth01 = (e0: number, e1: number, v: number) => {
    const t = clamp((v - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };
  return (
    smooth01(0.42, 0.62, moisture + (macro - 0.5) * 0.55 + (mid - 0.5) * 0.25) *
    (1 - smooth01(0.32, 0.55, slope)) *
    smooth01(14, 45, h) *
    (1 - smooth01(780, 1050, h))
  );
}
/** Clipmap texel spacing of the finest GPU terrain level (metres). */
const DRAWN_GRID = 8;
/**
 * The surface the GPU terrain actually draws near the camera: heightAt()
 * sampled on the 8 m clipmap grid and interpolated bilinearly. Collision and
 * line-of-sight queries use it so they match what the player sees.
 */
export function renderedHeightAt(x: number, z: number) {
  const gx = x / DRAWN_GRID,
    gz = z / DRAWN_GRID;
  const ix = Math.floor(gx),
    iz = Math.floor(gz);
  const u = gx - ix,
    v = gz - iz;
  if (u === 0 && v === 0) return heightAt(x, z);
  const x0 = ix * DRAWN_GRID,
    z0 = iz * DRAWN_GRID;
  const a = heightAt(x0, z0),
    b = heightAt(x0 + DRAWN_GRID, z0),
    c = heightAt(x0, z0 + DRAWN_GRID),
    d = heightAt(x0 + DRAWN_GRID, z0 + DRAWN_GRID);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
