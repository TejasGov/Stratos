import { SEED } from "./terrain";

/**
 * GLSL port of `heightAt` and `regionMasks` from terrain.ts. The integer hash
 * reproduces the CPU bit pattern exactly, so GPU heights match the gameplay
 * (collision, scenery) heights to float32 precision.
 */
export const TERRAIN_HEIGHT_GLSL = /* glsl */ `
float tHash(int x, int z) {
  uint n = (uint(x) * 374761393u) ^ (uint(z) * 668265263u) ^ ${SEED}u;
  n = (n ^ (n >> 13u)) * 1274126177u;
  return float(n ^ (n >> 16u)) / 4294967295.0;
}
float tSmooth(float t) { return t * t * (3.0 - 2.0 * t); }
float tNoise(float x, float z) {
  float fx = floor(x), fz = floor(z);
  int ix = int(fx), iz = int(fz);
  float u = tSmooth(x - fx), v = tSmooth(z - fz);
  float a = tHash(ix, iz), b = tHash(ix + 1, iz), c = tHash(ix, iz + 1), d = tHash(ix + 1, iz + 1);
  return (a + (b - a) * u) * (1.0 - v) + (c + (d - c) * u) * v;
}
float tEllipse(float x, float z, float cx, float cz, float rx, float rz) {
  return tSmooth(clamp(1.0 - length(vec2((x - cx) / rx, (z - cz) / rz)), 0.0, 1.0));
}
float tDrainage(float x, float z) {
  float valley = 180.0 + sin((z + 900.0) / 1100.0) * 370.0;
  float d = (x - valley) / 380.0;
  return exp(-d * d) * tEllipse(x, z, 250.0, -1200.0, 1700.0, 2700.0);
}
float terrainMoisture(float x, float z) {
  return clamp(0.35 + tNoise(x / 2200.0 + 61.0, z / 2200.0) * 0.5 + tDrainage(x, z) * 0.25, 0.0, 1.0);
}
/** Mirrors forestMask() in terrain.ts. */
float terrainForest(float x, float z, float h, float slope, float moisture) {
  float macro = tNoise(x / 1400.0 + 31.0, z / 1400.0);
  float mid = tNoise(x / 260.0 + 9.0, z / 260.0);
  return smoothstep(0.42, 0.62, moisture + (macro - 0.5) * 0.55 + (mid - 0.5) * 0.25) *
    (1.0 - smoothstep(0.32, 0.55, slope)) * smoothstep(14.0, 45.0, h) *
    (1.0 - smoothstep(780.0, 1050.0, h));
}
float terrainHeight(float x, float z) {
  float wx = x + (tNoise(x / 2400.0 + 3.0, z / 2400.0) - 0.5) * 1700.0 +
    (tNoise(x / 760.0, z / 760.0 + 11.0) - 0.5) * 520.0;
  float wz = z + (tNoise(x / 2400.0, z / 2400.0 + 7.0) - 0.5) * 1700.0 +
    (tNoise(x / 760.0 + 5.0, z / 760.0) - 0.5) * 520.0;
  const float cell = 6200.0;
  int cx = int(floor(x / cell + 0.5)), cz = int(floor(z / cell + 0.5));
  float island = 0.0, shelf = 0.0;
  for (int dz = -1; dz <= 1; dz++)
  for (int dx = -1; dx <= 1; dx++) {
    int ix = cx + dx, iz = cz + dz;
    bool home = ix == 0 && iz == 0;
    bool landmark = home || (ix == 0 && iz == -1) || (ix == -1 && iz == 0);
    if (!landmark && tHash(ix + 71, iz - 5) < 0.2) continue;
    float px = float(ix) * cell + (tHash(ix + 11, iz) - 0.5) * 1800.0;
    float pz = float(iz) * cell + (tHash(ix, iz + 53) - 0.5) * 1800.0;
    float sizeH = tHash(ix + 29, iz + 3);
    float size = 0.5 + 1.3 * sizeH * sizeH;
    float elongation = 0.6 + 0.9 * tHash(ix + 13, iz + 29);
    float angle = tHash(ix + 5, iz + 41) * 3.14159265358979;
    if (home) { size = 1.25; elongation = 1.0; angle = 0.0; }
    else if (landmark) size = max(size, 0.95);
    float rx = min(5000.0, (2200.0 + tHash(ix + 3, iz) * 900.0) * size * elongation);
    float rz = min(5000.0, (1800.0 + tHash(ix, iz + 8) * 1000.0) * size / elongation);
    float c = cos(angle), s = sin(angle);
    float qx = ((wx - px) * c - (wz - pz) * s) / rx, qz = ((wx - px) * s + (wz - pz) * c) / rz;
    float r = qx * qx + qz * qz;
    float peak = home ? 1.0 : 0.4 + 0.6 * tHash(ix - 7, iz + 13);
    island = max(island, pow(max(0.0, 1.0 - r), 1.5) * peak);
    float width = 1.6 * (0.4 + 0.6 * tHash(ix + 37, iz - 11));
    shelf = max(shelf, tSmooth(clamp((1.0 + width - r) / width, 0.0, 1.0)));
  }
  const float cell2 = 2300.0;
  int cx2 = int(floor(x / cell2 + 0.5)), cz2 = int(floor(z / cell2 + 0.5));
  for (int dz = -1; dz <= 1; dz++)
  for (int dx = -1; dx <= 1; dx++) {
    int ix = cx2 + dx, iz = cz2 + dz;
    if (tHash(ix + 201, iz + 17) >= 0.22) continue;
    float px = float(ix) * cell2 + (tHash(ix + 19, iz) - 0.5) * 1300.0;
    float pz = float(iz) * cell2 + (tHash(ix, iz + 23) - 0.5) * 1300.0;
    float radius = 220.0 + tHash(ix + 9, iz + 2) * 480.0;
    float r = ((wx - px) * (wx - px) + (wz - pz) * (wz - pz)) / (radius * radius);
    island = max(island, pow(max(0.0, 1.0 - r), 1.2) * 0.2);
    shelf = max(shelf, tSmooth(clamp((3.2 - r) / 2.2, 0.0, 1.0)) * 0.9);
  }
  float large = tNoise(x / 1600.0, z / 1600.0);
  float ridge = 1.0 - abs(tNoise(x / 630.0 + 17.0, z / 630.0) * 2.0 - 1.0);
  float reef = (tNoise(x / 140.0 + 2.0, z / 140.0) - 0.5) * 10.0;
  float h = -95.0 + shelf * (84.0 + reef) +
    island * (440.0 + large * 900.0 + ridge * ridge * ridge * 380.0) +
    island * (tNoise(x / 180.0, z / 180.0) - 0.5) * 80.0;
  float influence = tEllipse(x, z, 0.0, -700.0, 4800.0, 4400.0);
  float sx = (x + 250.0) / 1050.0, sz = (z + 1750.0) / 1900.0;
  float spine = exp(-sx * sx) * exp(-sz * sz);
  h += influence * (spine * 510.0 - tDrainage(x, z) * 250.0);
  float portShelf = tEllipse(x, z, 1870.0, -1050.0, 900.0, 1150.0);
  h = h * (1.0 - portShelf) + (26.0 + tNoise(x / 350.0, z / 350.0) * 20.0) * portShelf;
  float port = tEllipse(x, z, 1850.0, -1050.0, 390.0, 500.0);
  h = h * (1.0 - port) + 22.0 * port;
  float channel = tEllipse(x, z, 2500.0, -500.0, 240.0, 850.0);
  h = h * (1.0 - channel) - 14.0 * channel;
  float airfield = length(vec2((x + 900.0) / 400.0, z / 900.0));
  float flatten = clamp((1.25 - airfield) * 3.0, 0.0, 1.0);
  return h * (1.0 - flatten) + 28.0 * flatten;
}
`;
