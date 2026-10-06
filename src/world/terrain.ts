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
/** Geographical masks shared by materials, prop placement and terrain shaping. */
export function regionMasks(x: number, z: number) {
  const valleyCenter = 180 + Math.sin((z + 900) / 1100) * 370;
  const drainage =
    Math.exp(-(((x - valleyCenter) / 240) ** 2)) *
    ellipse(x, z, 250, -1200, 1700, 2700);
  const infrastructure = Math.max(
    ellipse(x, z, -900, 0, 650, 1250),
    ellipse(x, z, 1850, -1050, 500, 650),
  );
  const moisture = clamp(
    0.35 + noise(x / 2200 + 61, z / 2200) * 0.5 + drainage * 0.25,
  );
  return { drainage, infrastructure, moisture };
}
function noise(x: number, z: number) {
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
  const cell = 6200,
    cx = Math.round(x / cell),
    cz = Math.round(z / cell);
  let island = 0;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const ix = cx + dx,
        iz = cz + dz;
      const px = ix * cell + (hash(ix + 11, iz) - 0.5) * 1800;
      const pz = iz * cell + (hash(ix, iz + 53) - 0.5) * 1800;
      const rx = 2200 + hash(ix + 3, iz) * 900,
        rz = 1800 + hash(ix, iz + 8) * 1000;
      const r = ((x - px) / rx) ** 2 + ((z - pz) / rz) ** 2;
      island = Math.max(island, Math.max(0, 1 - r) ** 1.5);
    }
  const large = noise(x / 1600, z / 1600),
    ridge = 1 - Math.abs(noise(x / 630 + 17, z / 630) * 2 - 1);
  let h =
    -95 +
    island * (440 + large * 900 + ridge ** 3 * 380) +
    island * (noise(x / 180, z / 180) - 0.5) * 80;
  // Authored Haven basin: winding mountain corridor opening onto an eastern shelf.
  // The influence fades smoothly, retaining seeded islands outside the sortie region.
  const influence = ellipse(x, z, 0, -700, 4800, 4400);
  const spine =
    Math.exp(-(((x + 250) / 1050) ** 2)) *
    Math.exp(-(((z + 1750) / 1900) ** 2));
  const masks = regionMasks(x, z);
  h += influence * (spine * 510 - masks.drainage * 330);
  const shelf = ellipse(x, z, 1870, -1050, 900, 1150);
  h = h * (1 - shelf) + (26 + noise(x / 350, z / 350) * 20) * shelf;
  const port = ellipse(x, z, 1850, -1050, 390, 500);
  h = h * (1 - port) + 22 * port;
  // Keep the bridge spanning a channel rather than buried inside a ridge.
  const channel = ellipse(x, z, 2500, -500, 240, 850);
  h = h * (1 - channel) - 14 * channel;
  const airfieldDistance = Math.hypot((x + 900) / 400, z / 900);
  const flatten = Math.max(0, Math.min(1, (1.25 - airfieldDistance) * 3));
  h = h * (1 - flatten) + 28 * flatten;
  return h;
}
export function surfaceColor(
  h: number,
  slope: number,
  x = 0,
  z = 0,
): [number, number, number] {
  if (h < 9) return [0.66, 0.63, 0.43];
  if (h < 45) return [0.44, 0.5, 0.29];
  const masks = regionMasks(x, z);
  const rock = clamp((h - 680) / 520 + slope * 0.55);
  const dry = 1 - masks.moisture;
  return [
    0.065 + dry * 0.065 + rock * 0.16,
    0.145 + dry * 0.01 + rock * 0.065,
    0.07 + dry * 0.025 + rock * 0.13,
  ];
}
/** All LOD boundaries share a 12-segment polyline, preventing mixed-LOD cracks. */
export function meshHeightAt(cx: number, cz: number, lx: number, lz: number) {
  if (Math.abs(lx) < 1e-6) lx = 0;
  if (Math.abs(lz) < 1e-6) lz = 0;
  if (Math.abs(lx - CHUNK) < 1e-6) lx = CHUNK;
  if (Math.abs(lz - CHUNK) < 1e-6) lz = CHUNK;
  const wx = cx * CHUNK + lx,
    wz = cz * CHUNK + lz;
  const edgeX = lx === 0 || lx === CHUNK,
    edgeZ = lz === 0 || lz === CHUNK;
  if (!edgeX && !edgeZ) return heightAt(wx, wz);
  const step = CHUNK / 12,
    axis = edgeX ? lz : lx;
  const low = Math.min(11, Math.floor(axis / step)),
    t = clamp(axis / step - low);
  const a = edgeX
    ? heightAt(wx, cz * CHUNK + low * step)
    : heightAt(cx * CHUNK + low * step, wz);
  const b = edgeX
    ? heightAt(wx, cz * CHUNK + (low + 1) * step)
    : heightAt(cx * CHUNK + (low + 1) * step, wz);
  return a + (b - a) * t;
}
/** Surface of the authoritative near (48-segment) triangles, including edge constraints. */
export function renderedHeightAt(x: number, z: number, segments = 48) {
  const cx = Math.floor(x / CHUNK),
    cz = Math.floor(z / CHUNK),
    step = CHUNK / segments;
  const gx = (x - cx * CHUNK) / step,
    gz = (z - cz * CHUNK) / step;
  const ix = Math.min(segments - 1, Math.floor(gx)),
    iz = Math.min(segments - 1, Math.floor(gz));
  const u = gx - ix,
    v = gz - iz;
  const a = meshHeightAt(cx, cz, ix * step, iz * step);
  const b = meshHeightAt(cx, cz, (ix + 1) * step, iz * step);
  const c = meshHeightAt(cx, cz, ix * step, (iz + 1) * step);
  const d = meshHeightAt(cx, cz, (ix + 1) * step, (iz + 1) * step);
  return u + v <= 1
    ? a + (b - a) * u + (c - a) * v
    : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}
export function buildTerrain(cx: number, cz: number, segments: number) {
  const side = segments + 1,
    points: number[] = [],
    normals: number[] = [],
    colors: number[] = [],
    indices: number[] = [];
  for (let z = 0; z <= segments; z++)
    for (let x = 0; x <= segments; x++) {
      const lx = (x / segments) * CHUNK,
        lz = (z / segments) * CHUNK;
      const wx = cx * CHUNK + lx,
        wz = cz * CHUNK + lz,
        h = meshHeightAt(cx, cz, lx, lz);
      const nx = (heightAt(wx - 4, wz) - heightAt(wx + 4, wz)) / 8;
      const nz = (heightAt(wx, wz - 4) - heightAt(wx, wz + 4)) / 8;
      const len = Math.hypot(nx, 1, nz);
      points.push(lx, h, lz);
      normals.push(nx / len, 1 / len, nz / len);
      colors.push(...surfaceColor(h, Math.hypot(nx, nz), wx, wz));
    }
  for (let z = 0; z < segments; z++)
    for (let x = 0; x < segments; x++) {
      const a = z * side + x,
        b = a + 1,
        c = a + side,
        d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  const edges = [
    Array.from({ length: side }, (_, i) => i),
    Array.from({ length: side }, (_, i) => i * side + segments),
    Array.from({ length: side }, (_, i) => segments * side + segments - i),
    Array.from({ length: side }, (_, i) => (segments - i) * side),
  ];
  for (const edge of edges) {
    const first = points.length / 3;
    edge.forEach((i) => {
      points.push(points[i * 3], points[i * 3 + 1] - 95, points[i * 3 + 2]);
      normals.push(...normals.slice(i * 3, i * 3 + 3));
      colors.push(...colors.slice(i * 3, i * 3 + 3));
    });
    for (let i = 0; i < segments; i++)
      indices.push(
        edge[i],
        first + i,
        edge[i + 1],
        edge[i + 1],
        first + i,
        first + i + 1,
      );
  }
  return {
    positions: new Float32Array(points),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
