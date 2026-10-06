export const CHUNK = 1600;
export const SEED = 7319;
export function hash(x: number, z: number) {
  let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ SEED;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
const smooth = (t: number) => t * t * (3 - 2 * t);
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
  const airfieldDistance = Math.hypot((x + 900) / 400, z / 900);
  const flatten = Math.max(0, Math.min(1, (1.25 - airfieldDistance) * 3));
  h = h * (1 - flatten) + 28 * flatten;
  return h;
}
export function surfaceColor(
  h: number,
  slope: number,
): [number, number, number] {
  if (h < 9) return [0.66, 0.63, 0.43];
  if (h < 45) return [0.44, 0.5, 0.29];
  const rock = Math.min(1, Math.max(0, (h - 630) / 430 + slope * 0.38));
  return [0.045 + rock * 0.15, 0.12 + rock * 0.095, 0.055 + rock * 0.13];
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
        h = heightAt(wx, wz);
      const nx = (heightAt(wx - 4, wz) - heightAt(wx + 4, wz)) / 8;
      const nz = (heightAt(wx, wz - 4) - heightAt(wx, wz + 4)) / 8;
      const len = Math.hypot(nx, 1, nz);
      points.push(lx, h, lz);
      normals.push(nx / len, 1 / len, nz / len);
      colors.push(...surfaceColor(h, Math.hypot(nx, nz)));
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
