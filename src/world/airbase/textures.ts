import * as T from "three";
import { rng } from "./MeshBuilder";

/** Procedural canvas textures for the air bases (browser only). */

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function finish(c: HTMLCanvasElement, srgb: boolean, repeat: boolean, aniso = 8) {
  const t = new T.CanvasTexture(c);
  t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = T.RepeatWrapping;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = T.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Tileable value noise on a size×size lattice with the given cell size (px). */
function tileNoise(size: number, cell: number, seed: number) {
  const n = Math.max(1, Math.round(size / cell));
  const rand = rng(seed);
  const lattice = new Float32Array(n * n);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const out = new Float32Array(size * size);
  const step = n / size;
  for (let y = 0; y < size; y++) {
    const fy = y * step, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < size; x++) {
      const fx = x * step, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
      const a = lattice[(iy % n) * n + (ix % n)], b = lattice[(iy % n) * n + ((ix + 1) % n)];
      const c = lattice[((iy + 1) % n) * n + (ix % n)], d = lattice[((iy + 1) % n) * n + ((ix + 1) % n)];
      out[y * size + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    }
  }
  return out;
}

function fbm(size: number, cells: number[], weights: number[], seed: number) {
  const out = new Float32Array(size * size);
  let total = 0;
  cells.forEach((cell, i) => {
    const n = tileNoise(size, cell, seed + i * 31);
    for (let k = 0; k < out.length; k++) out[k] += n[k] * weights[i];
    total += weights[i];
  });
  for (let k = 0; k < out.length; k++) out[k] /= total;
  return out;
}

/** Fine asphalt aggregate (greyscale detail, tiles every 8 m). */
export function asphaltDetail(seed = 11) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const low = fbm(S, [128, 64, 24], [1, 0.7, 0.5], seed);
  const rand = rng(seed + 99);
  for (let i = 0; i < S * S; i++) {
    const grain = rand();
    let v = 0.46 + (low[i] - 0.5) * 0.35 + (grain - 0.5) * 0.28;
    // Pale aggregate stones and dark binder pits.
    if (grain > 0.965) v += 0.2;
    else if (grain < 0.03) v -= 0.14;
    v = Math.min(1, Math.max(0, v)) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // A few hairline cracks that wrap cleanly across the tile edge.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  const r2 = rng(seed + 5);
  for (let k = 0; k < 9; k++) {
    let x = r2() * S, y = r2() * S, a = r2() * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let j = 0; j < 14; j++) {
      a += (r2() - 0.5) * 0.9;
      x += Math.cos(a) * 14;
      y += Math.sin(a) * 14;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return finish(c, false, true, 16);
}

/** Concrete slabs, 6 m each, 12 m tile: joints, stains and per-slab tone. */
export function concreteTile(seed = 21, dirt = 0) {
  const S = 512;
  const c = canvas(S, S);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const low = fbm(S, [256, 96, 32], [1, 0.8, 0.5], seed);
  const rand = rng(seed + 3);
  const slabTone = [0, 1, 2, 3].map(() => 0.93 + rand() * 0.14);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const slab = slabTone[(y >> 8) * 2 + (x >> 8)];
      const stain = (low[i] - 0.5) * (0.22 + dirt);
      let v = (0.74 + stain) * slab + (rand() - 0.5) * 0.05;
      // Joints: dark groove with a lighter lip.
      const jx = x & 255, jy = y & 255;
      if (jx < 2 || jy < 2) v *= 0.55;
      else if (jx === 2 || jy === 2) v *= 1.05;
      v = Math.min(1, Math.max(0, v));
      img.data[i * 4] = v * 255;
      img.data[i * 4 + 1] = v * 250;
      img.data[i * 4 + 2] = v * 242;
      img.data[i * 4 + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  // Oil drips and tyre scuffs.
  const r2 = rng(seed + 9);
  for (let k = 0; k < 14 + dirt * 40; k++) {
    const x = r2() * S, y = r2() * S, r = 4 + r2() * 18;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(20,18,16,${0.12 + r2() * 0.2})`);
    g.addColorStop(1, "rgba(20,18,16,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return finish(c, true, true, 16);
}

export interface WearOptions {
  seed: number;
  length: number;
  width: number;
  /** 0..1 how heavily the touchdown zones are scorched with tyre rubber. */
  rubber: number;
  /** Count of repair patches. */
  patches: number;
}

/**
 * Whole-runway wear map (multiplies the asphalt colour): repair patches,
 * joints, a centreline oil trail and dark tyre-rubber deposits in the two
 * touchdown zones. u spans the width, v the length.
 */
export function runwayWear(o: WearOptions) {
  const W = 256, H = 2048;
  const c = canvas(W, H);
  const ctx = c.getContext("2d")!;
  const mPerPxX = o.width / W, mPerPxY = o.length / H;
  const rand = rng(o.seed);
  // Base: big soft blotches plus streaks stretched along the runway.
  const blotch = fbm(256, [128, 48, 16], [1, 0.6, 0.4], o.seed);
  const streakN = tileNoise(256, 8, o.seed + 7);
  const streakN2 = tileNoise(256, 32, o.seed + 8);
  const img = ctx.createImageData(W, H);
  const gauss = (x: number, m: number, s: number) => Math.exp(-(((x - m) / s) ** 2));
  for (let y = 0; y < H; y++) {
    const s = y * mPerPxY; // distance from the s=-L/2 end
    const fromEnd = Math.min(s, o.length - s);
    // Rubber builds up 150–700 m from each threshold, heaviest near 350 m.
    const zone = gauss(fromEnd, 330, 140) * (fromEnd > 60 ? 1 : fromEnd / 60) + gauss(fromEnd, 60, 40) * 0.35;
    for (let x = 0; x < W; x++) {
      const lat = (x - W / 2 + 0.5) * mPerPxX;
      const a = Math.abs(lat);
      let v = 1 - (blotch[(y & 255) * 256 + (x & 255)] - 0.5) * 0.16;
      // Streaks: sampled along the length (low frequency in y) so they run lengthwise.
      const st = streakN[((y >> 3) & 255) * 256 + ((x >> 0) & 255)];
      const st2 = streakN2[((y >> 5) & 255) * 256 + ((x * 3) & 255)];
      const tracks = 0.55 * gauss(a, 3.3, 1.2) + 0.45 * gauss(a, 8.8, 2.2) + 0.18 * gauss(a, 15, 5);
      const rubber = o.rubber * zone * Math.min(1.2, tracks * (0.55 + 0.9 * st) * (0.7 + 0.6 * st2));
      v *= 1 - 0.62 * Math.min(1, rubber);
      // Oil and heat staining along the centreline, strongest at the roll-out ends.
      v *= 1 - 0.14 * gauss(a, 0.5, 0.9) * (0.4 + 0.6 * st2);
      v *= 1 - 0.1 * gauss(fromEnd, 40, 70) * gauss(a, 6, 7);
      // Slightly sun-bleached outer edges.
      v *= 1 + 0.05 * Math.min(1, Math.max(0, (a - o.width * 0.38) / (o.width * 0.12)));
      const i = (y * W + x) * 4;
      const g = Math.min(1, Math.max(0, v * 0.92)) * 255;
      img.data[i] = g;
      img.data[i + 1] = g * 0.99;
      img.data[i + 2] = g * 0.98;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Repair patches: slightly darker (newer) asphalt with a hairline seam.
  for (let k = 0; k < o.patches; k++) {
    const pw = (2 + rand() * 7) / mPerPxX, ph = (3 + rand() * 14) / mPerPxY;
    const px = rand() * (W - pw), py = rand() * (H - ph);
    const tone = 0.62 + rand() * 0.2;
    ctx.fillStyle = `rgba(${tone * 255},${tone * 255},${tone * 252},0.8)`;
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = "rgba(20,20,20,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw, ph);
  }
  // Transverse joints every 25 m, longitudinal joints at the lane edges.
  ctx.strokeStyle = "rgba(15,15,15,0.22)";
  ctx.lineWidth = 1;
  for (let s = 25; s < o.length; s += 25) {
    const y = s / mPerPxY;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (const lat of [-o.width / 4, o.width / 4]) {
    const x = lat / mPerPxX + W / 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  // Skid arcs near touchdown: dark curved smears where tyres bit in.
  for (let end = 0; end < 2; end++)
    for (let k = 0; k < 7; k++) {
      const s = 220 + rand() * 340, lat = (rand() < 0.5 ? -1 : 1) * (2 + rand() * 9);
      const y0 = (end ? o.length - s : s) / mPerPxY, x0 = lat / mPerPxX + W / 2;
      ctx.strokeStyle = `rgba(8,8,8,${0.18 * o.rubber + rand() * 0.12})`;
      ctx.lineWidth = 2 + rand() * 2;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(x0 + (rand() - 0.5) * 10, y0 + (end ? -1 : 1) * 30, x0 + (rand() - 0.5) * 6, y0 + (end ? -1 : 1) * (40 + rand() * 30));
      ctx.stroke();
    }
  return finish(c, true, false, 16);
}

/** Runway designator atlas: two numerals stacked, white on transparent. */
export function numeralAtlas(top: string, bottom: string) {
  const c = canvas(512, 1024);
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 512, 1024);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  [top, bottom].forEach((text, i) => {
    ctx.save();
    ctx.translate(256, 256 + i * 512);
    // Condense horizontally and stretch to the tall, blocky runway-numeral proportion.
    ctx.scale(0.74, 1);
    ctx.font = "900 430px 'DejaVu Sans', 'Arial Black', Arial, Helvetica, sans-serif";
    ctx.fillText(text, 0, 14);
    ctx.fillText(text, 3, 14);
    ctx.restore();
  });
  return finish(c, true, false, 8);
}

/** Chain-link fence panel: 6 m wide, post at the left edge. Height ratio 2:1. */
export function fenceTexture(barbed: boolean) {
  const W = 256, H = 128;
  const c = canvas(W, H);
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  const top = barbed ? 26 : 8;
  ctx.strokeStyle = "rgba(190,196,200,0.8)";
  ctx.lineWidth = 1.1;
  for (let k = -H; k < W + H; k += 11) {
    ctx.beginPath();
    ctx.moveTo(k, top);
    ctx.lineTo(k + (H - top), H);
    ctx.moveTo(k + (H - top), top);
    ctx.lineTo(k, H);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(150,156,160,1)";
  ctx.fillRect(0, 0, 6, H);
  ctx.fillRect(0, top - 2, W, 4);
  ctx.fillRect(0, H - 4, W, 3);
  if (barbed) {
    ctx.strokeStyle = "rgba(120,124,128,0.95)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 2);
    ctx.lineTo(8, 24);
    ctx.moveTo(0, 24);
    ctx.lineTo(8, 2);
    ctx.stroke();
    for (const y of [4, 12, 20]) {
      ctx.beginPath();
      for (let x = 0; x <= W; x += 6) ctx.lineTo(x, y + ((x / 6) % 2 ? 2 : -2));
      ctx.stroke();
    }
  }
  const t = finish(c, true, true, 8);
  return t;
}

/** Open lattice for radar reflectors: alpha grid. */
export function latticeTexture() {
  const S = 128;
  const c = canvas(S, S);
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = "rgba(205,210,214,1)";
  ctx.lineWidth = 5;
  for (let k = 0; k <= S; k += 32) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k, S);
    ctx.moveTo(0, k);
    ctx.lineTo(S, k);
    ctx.stroke();
  }
  return finish(c, true, true, 8);
}

/** Soft, ragged dark disc for scorched earth under wrecks. */
export function scorchTexture() {
  const S = 256;
  const c = canvas(S, S);
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, S, S);
  const rand = rng(77);
  for (let k = 0; k < 26; k++) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * S * 0.28;
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d, r = S * (0.1 + rand() * 0.16);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(8,7,6,${0.35 + rand() * 0.25})`);
    g.addColorStop(1, "rgba(8,7,6,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  return finish(c, true, false, 4);
}
