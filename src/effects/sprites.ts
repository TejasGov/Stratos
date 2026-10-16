/**
 * Procedural sprite atlases for the particle batches: pure maths, no DOM, no assets.
 * Both are 4x4 grids of TILE-pixel cells, bottom row first (texture v grows upward).
 *
 * Smoke atlas (alpha blended, lit in the shader): R = puff height, G/B = height gradient
 * (encoded around 0.5, ±GRADIENT_RANGE), A = coverage. Cells 0-11 billowy puffs, 12-13
 * soft dust, 14-15 faceted rock/debris chunks.
 * Fire atlas (additive): RGB = intensity, A = coverage. Cells 0-3 glows and glare,
 * 4 spark, 5-6 shockwave rings, 7 soft streak, 8-15 turbulent fireball blobs.
 */
export const TILE = 96;
export const CELLS = 4;
export const GRADIENT_RANGE = 4;

function hash(x: number, y: number, seed: number) {
  let h =
    (Math.imul(x | 0, 374761393) +
      Math.imul(y | 0, 668265263) +
      Math.imul(seed | 0, 1274126177)) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(t: number) {
  return t * t * (3 - 2 * t);
}
function valueNoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    fx = smooth(x - xi),
    fy = smooth(y - yi);
  const a = hash(xi, yi, seed),
    b = hash(xi + 1, yi, seed),
    c = hash(xi, yi + 1, seed),
    d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(x: number, y: number, seed: number, octaves: number) {
  let sum = 0,
    amplitude = 0.5,
    total = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x, y, seed + i * 31) * amplitude;
    total += amplitude;
    x = x * 2.03 + 11.7;
    y = y * 2.03 + 3.1;
    amplitude *= 0.5;
  }
  return sum / total;
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) =>
  smooth(clamp01((v - a) / (b - a)));

/**
 * Turbulent cloud density: a radial mask eroded by domain-warped fractal noise. `ridge`
 * blends in billow (1 - |2n - 1|) detail for sharper creases. The result is feathered at
 * the rim, so overlapping sprites read as one volume instead of stacked discs.
 */
function cloudDensity(
  u: number,
  v: number,
  seed: number,
  freq: number,
  warp: number,
  ridge: number,
  octaves: number,
) {
  const wx = u + warp * (fbm(u * 1.4 + seed, v * 1.4, seed, 3) - 0.5),
    wy =
      v + warp * (fbm(u * 1.4 + 5.2, v * 1.4 + 1.3 + seed, seed + 1, 3) - 0.5);
  const mask = Math.pow(clamp01(1 - Math.hypot(wx, wy) / 0.96), 1.1);
  const n = fbm(wx * freq + seed * 0.7, wy * freq, seed + 2, octaves);
  const crease = 1 - Math.abs(2 * n - 1);
  return mask * (0.15 + 1.25 * (n * (1 - ridge) + crease * ridge));
}

type Writer = (
  cell: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
) => void;
function atlas(fill: (write: Writer) => void) {
  const width = TILE * CELLS,
    data = new Uint8Array(width * width * 4);
  fill((cell, x, y, r, g, b, a) => {
    const offset =
      ((Math.floor(cell / CELLS) * TILE + y) * width +
        (cell % CELLS) * TILE +
        x) *
      4;
    data[offset] = clamp01(r) * 255;
    data[offset + 1] = clamp01(g) * 255;
    data[offset + 2] = clamp01(b) * 255;
    data[offset + 3] = clamp01(a) * 255;
  });
  return data;
}
/** Pixel centres mapped to -1..1 with v up. */
const coord = (i: number) => ((i + 0.5) / TILE) * 2 - 1;

/** Lumpy rock silhouette radius at (u, v), and its crinkled height field. */
function rockEdge(u: number, v: number, seed: number) {
  const angle = Math.atan2(v, u);
  return (
    0.52 +
    0.3 * fbm(Math.cos(angle) * 1.7 + seed, Math.sin(angle) * 1.7, seed, 3)
  );
}
function rockHeight(u: number, v: number, seed: number) {
  const body = clamp01(1 - Math.hypot(u, v) / rockEdge(u, v, seed));
  return (
    Math.pow(body, 0.5) * (0.55 + 0.7 * fbm(u * 5 + seed, v * 5, seed + 3, 3))
  );
}

export function makeSmokeAtlasData() {
  const e = 2 / TILE,
    grid = new Float32Array((TILE + 2) * (TILE + 2));
  return atlas((write) => {
    for (let cell = 0; cell < 16; cell++) {
      const seed = cell * 19 + 5;
      // Density field with a one-pixel apron, so gradients are central differences of one evaluation each.
      if (cell >= 14)
        for (let y = -1; y <= TILE; y++)
          for (let x = -1; x <= TILE; x++)
            grid[(y + 1) * (TILE + 2) + x + 1] = rockHeight(
              coord(x),
              coord(y),
              seed,
            );
      else {
        // Billowy puffs, wispier turbulent clouds, then soft dust.
        const [freq, warp, ridge, octaves] =
          cell < 8
            ? [2.1, 0.5, 0, 3]
            : cell < 12
              ? [3.2, 0.7, 0.3, 4]
              : [1.8, 0.6, 0, 2];
        for (let y = -1; y <= TILE; y++)
          for (let x = -1; x <= TILE; x++)
            grid[(y + 1) * (TILE + 2) + x + 1] = cloudDensity(
              coord(x),
              coord(y),
              seed,
              freq,
              warp,
              ridge,
              octaves,
            );
      }
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const u = coord(x),
            v = coord(y);
          if (cell >= 14) {
            const body = clamp01(1 - Math.hypot(u, v) / rockEdge(u, v, seed));
            const i = (y + 1) * (TILE + 2) + x + 1;
            const gx = (grid[i + 1] - grid[i - 1]) / (2 * e),
              gy = (grid[i + TILE + 2] - grid[i - TILE - 2]) / (2 * e);
            write(
              cell,
              x,
              y,
              grid[i],
              0.5 + Math.max(-0.5, Math.min(0.5, gx / GRADIENT_RANGE)),
              0.5 + Math.max(-0.5, Math.min(0.5, gy / GRADIENT_RANGE)),
              smoothstep(0, 0.07, body),
            );
            continue;
          }
          const dust = cell >= 12;
          const h = grid[(y + 1) * (TILE + 2) + x + 1];
          const gx =
            (grid[(y + 1) * (TILE + 2) + x + 2] -
              grid[(y + 1) * (TILE + 2) + x]) /
            (2 * e);
          const gy =
            (grid[(y + 2) * (TILE + 2) + x + 1] -
              grid[y * (TILE + 2) + x + 1]) /
            (2 * e);
          // Coverage stays soft at the rim and solid inside, so erosion has texture to chew on.
          const cover = smoothstep(0.06, dust ? 0.6 : 0.5, h);
          write(
            cell,
            x,
            y,
            h,
            0.5 + Math.max(-0.5, Math.min(0.5, gx / GRADIENT_RANGE)),
            0.5 + Math.max(-0.5, Math.min(0.5, gy / GRADIENT_RANGE)),
            cover,
          );
        }
    }
  });
}

export function makeFireAtlasData() {
  return atlas((write) => {
    for (let cell = 0; cell < 16; cell++) {
      const seed = cell * 23 + 101;
      for (let y = 0; y < TILE; y++)
        for (let x = 0; x < TILE; x++) {
          const u = coord(x),
            v = coord(y),
            r = Math.hypot(u, v),
            fade = 1 - smoothstep(0.92, 1, r);
          let a = 0,
            i = 1;
          switch (cell) {
            case 0:
              a = Math.pow(Math.max(0, 1 - r), 2.2);
              break;
            case 1:
              a = Math.pow(Math.max(0, 1 - r), 1.25);
              break;
            case 2:
              // Hot pin-point core inside a soft halo.
              a = Math.exp(-r * r * 22) + 0.4 * Math.pow(Math.max(0, 1 - r), 3);
              break;
            case 3: {
              // Four-point glare: thin streaks along the axes plus a faint diagonal pair.
              const au = Math.abs(u),
                av = Math.abs(v),
                d1 = Math.abs(u - v) * 0.7071,
                d2 = Math.abs(u + v) * 0.7071;
              a =
                Math.exp(-r * r * 30) +
                0.8 *
                  (Math.exp(-av * 34) * Math.pow(Math.max(0, 1 - au), 2.2) +
                    Math.exp(-au * 34) * Math.pow(Math.max(0, 1 - av), 2.2)) +
                0.22 *
                  (Math.exp(-d1 * 40) + Math.exp(-d2 * 40)) *
                  Math.pow(Math.max(0, 1 - r), 2);
              break;
            }
            case 4:
              a = Math.exp(-r * r * 38) + 0.22 * Math.exp(-r * r * 6);
              break;
            case 5:
            case 6: {
              // Shock ring: crisp bright front, soft glow trailing inward, uneven around the rim.
              const front = cell === 5 ? 0.82 : 0.74,
                width = cell === 5 ? 0.075 : 0.17,
                angle = Math.atan2(v, u),
                rr =
                  r +
                  0.035 *
                    (fbm(
                      Math.cos(angle) * 2.5 + 4,
                      Math.sin(angle) * 2.5,
                      seed,
                      3,
                    ) -
                      0.5);
              const t = (rr - front) / width;
              a =
                Math.exp(-t * t) +
                0.16 *
                  smoothstep(0, front, rr) *
                  (1 - smoothstep(front - 0.02, front + 0.04, rr));
              a *= 1 - smoothstep(0.93, 1, r);
              break;
            }
            case 7:
              a =
                Math.exp(-v * v * 90) *
                Math.pow(Math.max(0, 1 - Math.abs(u)), 1.4);
              break;
            default: {
              // Fireball blob: bright where the field is thick, ragged flame-lick edges.
              const h = cloudDensity(
                u,
                v * 0.92 + 0.06,
                seed,
                4,
                0.55,
                0.55,
                5,
              );
              a = smoothstep(0.04, 0.42, h);
              i = 0.28 + 0.9 * Math.pow(h, 0.8);
            }
          }
          const alpha = clamp01(a) * (cell < 8 ? fade : 1);
          write(cell, x, y, i, i, i, alpha);
        }
    }
  });
}
