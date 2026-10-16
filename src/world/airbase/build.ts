import * as T from "three";
import { MeshBuilder, rgb, scale, rng, type RGB, type Vec3 } from "./MeshBuilder";
import type { Glow } from "./lights";
import { toWorld, type BaseLayout, type Rect, type Structure } from "../baseLayout";
import { heightAt } from "../terrain";

/** Visual identity of a base. */
export interface Style {
  wall: RGB;
  wallB: RGB;
  roof: RGB;
  hangarRoof: RGB;
  accent: RGB;
  door: RGB;
  trim: RGB;
  earth: RGB;
  hardened: RGB;
  tank: RGB;
  tankTop: RGB;
  asphalt: RGB;
  road: RGB;
  concrete: RGB;
  checker: [RGB, RGB] | null;
  barbed: boolean;
  /** Probability a window is lit at night. */
  lit: number;
  /** Master gain for runway lighting. */
  lightGain: number;
  taxi: [number, number, number];
}

export const HAVEN_STYLE: Style = {
  wall: rgb("#dde2e5"),
  wallB: rgb("#bcc6cd"),
  roof: rgb("#a5afb6"),
  hangarRoof: rgb("#c0cad1"),
  accent: rgb("#2c66a8"),
  door: rgb("#3e4a55"),
  trim: rgb("#8a959d"),
  earth: rgb("#56693f"),
  hardened: rgb("#a4acb1"),
  tank: rgb("#e6eaed"),
  tankTop: rgb("#9aa5ad"),
  asphalt: [0.2, 0.205, 0.21],
  road: [0.13, 0.135, 0.14],
  concrete: [1.05, 1.04, 1.02],
  checker: null,
  barbed: false,
  lit: 0.55,
  lightGain: 1,
  taxi: [0.5, 1.4, 10],
};

export const BLACKRIDGE_STYLE: Style = {
  wall: rgb("#5a6444"),
  wallB: rgb("#74684a"),
  roof: rgb("#454838"),
  hangarRoof: rgb("#4d5240"),
  accent: rgb("#8c2a22"),
  door: rgb("#2c3027"),
  trim: rgb("#3e4034"),
  earth: rgb("#5d5238"),
  hardened: rgb("#6c6f60"),
  tank: rgb("#69704f"),
  tankTop: rgb("#474b38"),
  asphalt: [0.15, 0.15, 0.145],
  road: [0.11, 0.105, 0.1],
  concrete: [0.8, 0.78, 0.72],
  checker: [rgb("#b02a20"), rgb("#e8e4da")],
  barbed: true,
  lit: 0.25,
  lightGain: 0.75,
  taxi: [10, 4.2, 0.5],
};

export interface PapiUnit {
  glow: number;
  x: number;
  y: number;
  z: number;
  /** Direction an approaching aircraft flies, base-local (+1 along +s, −1 along −s). */
  dir: 1 | -1;
  threshold: number;
}

export interface TargetGeometry {
  intact: T.BufferGeometry;
  intactGlows: Glow[];
  antenna?: { dish: T.BufferGeometry; frame: T.BufferGeometry; x: number; y: number; z: number };
  wreck: T.BufferGeometry;
  wreckGlows: Glow[];
  scorch: { x: number; z: number; r: number }[];
}

export interface BuiltGeometry {
  runway: T.BufferGeometry;
  asphalt: T.BufferGeometry;
  concrete: T.BufferGeometry;
  markings: T.BufferGeometry;
  numerals: T.BufferGeometry;
  solid: T.BufferGeometry;
  windows: T.BufferGeometry;
  fence: T.BufferGeometry;
  glows: Glow[];
  papi: Glow[];
  papiUnits: PapiUnit[];
  pools: { x: number; y: number; z: number; color: [number, number, number]; radius: number }[];
  parking: { x: number; z: number; yaw: number }[];
  targets: Record<string, TargetGeometry>;
  /** Highest point, for culling margins. */
  extent: number;
}

const WHITE = rgb("#e9e9e1");
const YELLOW = rgb("#e4b11e");
const GLOW_WHITE: [number, number, number] = [9, 8.4, 7.4];
const GLOW_AMBER: [number, number, number] = [10, 5.2, 1.0];
const GLOW_GREEN: [number, number, number] = [0.5, 9, 2.2];
const GLOW_RED: [number, number, number] = [10, 0.7, 0.4];
const FLOOD: [number, number, number] = [16, 13, 9];

type P2 = [number, number];

export function buildBase(layout: BaseLayout, style: Style): BuiltGeometry {
  const { base } = layout;
  const E = base.runway.elevation;
  const L = base.runway.length;
  const W = base.runway.width;
  const rand = rng(base.id === "haven" ? 4242 : 9157);
  const lit = style.lit;
  /** Runway frame (lat, s) to builder-local ground coordinates (x = lat, z = −s). */
  const P = (lat: number, s: number): P2 => [lat, -s];

  const asphalt = new MeshBuilder();
  const concrete = new MeshBuilder();
  const markings = new MeshBuilder();
  const solid = new MeshBuilder();
  const windows = new MeshBuilder();
  const glows: Glow[] = [];
  const pools: BuiltGeometry["pools"] = [];
  const targetBuilders: Record<string, { intact: MeshBuilder; wreck: MeshBuilder; glows: Glow[]; wglows: Glow[]; scorch: TargetGeometry["scorch"]; antenna?: TargetGeometry["antenna"] }> = {};
  const targetOf = (id: string) =>
    (targetBuilders[id] ??= { intact: new MeshBuilder(), wreck: new MeshBuilder(), glows: [], wglows: [], scorch: [] });

  // ----- windows -------------------------------------------------------
  const winQuad = (axis: "x" | "z", sign: 1 | -1, c: number, a0: number, a1: number, y0: number, y1: number, level: number) => {
    const o = c + sign * 0.05;
    const col: RGB = [level, level, level];
    if (axis === "x")
      windows.quadFacing([o, y0, a0], [o, y0, a1], [o, y1, a1], [o, y1, a0], [sign, 0, 0], col);
    else windows.quadFacing([a0, y0, o], [a1, y0, o], [a1, y1, o], [a0, y1, o], [0, 0, sign], col);
  };
  const windowRow = (axis: "x" | "z", sign: 1 | -1, c: number, a0: number, a1: number, y0: number, h: number, pitch: number, w: number, prob = lit) => {
    for (let a = a0 + pitch / 2; a < a1; a += pitch)
      winQuad(axis, sign, c, a - w / 2, a + w / 2, y0, y0 + h, rand() < prob ? 0.55 + rand() * 0.45 : 0.04);
  };
  const lampGlow = (lat: number, y: number, s: number, color: [number, number, number], size: number, extra: Partial<Glow> = {}) =>
    glows.push({ x: lat, y, z: -s, color, size, ...extra });

  // ----- runway --------------------------------------------------------
  const runway = new MeshBuilder();
  runway.quad([-W / 2, E, L / 2], [W / 2, E, L / 2], [W / 2, E, -L / 2], [-W / 2, E, -L / 2], [1, 1, 1]);

  // Blast pads and a graded shoulder strip beyond each end.
  for (const e of [-1, 1]) {
    const a = e * (L / 2), b = e * (L / 2 + 60);
    asphalt.flat([[-W / 2, -a], [W / 2, -a], [W / 2, -b], [-W / 2, -b]], E, scale(style.asphalt, 0.85), 8);
  }

  // ----- taxiways, connectors, aprons ---------------------------------
  const lead = (r: Rect) => [r.lat0, r.lat1, r.s0, r.s1] as const;
  for (const t of layout.taxiways) {
    const [l0, l1, s0, s1] = lead(t);
    asphalt.flat([[l0, -s0], [l1, -s0], [l1, -s1], [l0, -s1]], E, style.asphalt, 8);
  }
  for (const c of layout.connectors) {
    const hw = c.width / 2;
    if (c.flare) {
      // Runway-end flare widens the mouth so jets can turn off at speed.
      const f = 14;
      asphalt.flat(
        [[c.lat0, -(c.s - hw - f)], [c.lat0 + 20, -(c.s - hw)], [c.lat1, -(c.s - hw)], [c.lat1, -(c.s + hw)], [c.lat0 + 20, -(c.s + hw)], [c.lat0, -(c.s + hw + f)]],
        E, style.asphalt, 8,
      );
    } else {
      asphalt.flat([[c.lat0, -(c.s - hw)], [c.lat1, -(c.s - hw)], [c.lat1, -(c.s + hw)], [c.lat0, -(c.s + hw)]], E, style.asphalt, 8);
    }
  }
  for (const r of layout.aprons) {
    const [l0, l1, s0, s1] = lead(r);
    concrete.flat([[l0, -s0], [l1, -s0], [l1, -s1], [l0, -s1]], E, style.concrete, 12);
  }
  for (const r of layout.roads) {
    const [l0, l1, s0, s1] = lead(r);
    asphalt.flat([[l0, -s0], [l1, -s0], [l1, -s1], [l0, -s1]], E, style.road, 8);
  }

  // ----- runway markings ----------------------------------------------
  const my = E + 0.03;
  const bar = (s0: number, s1: number, lat0: number, lat1: number, color: RGB = WHITE) =>
    markings.rect(lat0, -s0, lat1, -s1, my, color);
  // Edge lines.
  for (const side of [-1, 1]) bar(-L / 2, L / 2, side * (W / 2 - 1.1), side * (W / 2 - 0.65));
  const keys = W >= 45 ? 6 : 5;
  const pitch = (W / 2 - 1.2 - 0.9 - 2.7) / (keys - 1);
  for (const e of [-1, 1]) {
    // Threshold piano keys, 6 m inboard of the end.
    const sa = e * (L / 2 - 6), sb = e * (L / 2 - 36);
    for (let i = 0; i < keys; i++)
      for (const side of [-1, 1]) {
        const c = side * (2.7 + i * pitch);
        bar(sa, sb, c - 0.9, c + 0.9);
      }
    // Aiming-point block and touchdown-zone bar groups, measured from this threshold.
    const from = (d: number) => e * (L / 2 - d);
    for (const side of [-1, 1]) bar(from(310), from(350), side * 7.2, side * 13.2);
    const groups: [number, number][] = [[150, 3], [450, 2], [600, 2], [750, 1]];
    for (const [d, n] of groups)
      for (let i = 0; i < n; i++)
        for (const side of [-1, 1]) {
          const c = side * (5.6 + i * 3.2);
          bar(from(d), from(d + 22), c - 0.9, c + 0.9);
        }
    // Taxi hold-short / runway-end hatch is left plain: keeps the numerals crisp.
  }
  // Centreline dashes, 30 m with 20 m gaps, centred between the numeral zones.
  {
    const span = L - 2 * 105;
    const n = Math.floor((span + 20) / 50);
    const start = -((n * 50 - 20) / 2);
    for (let i = 0; i < n; i++) bar(start + i * 50, start + i * 50 + 30, -0.45, 0.45);
  }
  // Taxiway centrelines, hold-short bars and apron stand lines (yellow).
  for (const t of layout.taxiways) {
    const c = (t.lat0 + t.lat1) / 2;
    bar(t.s0, t.s1, c - 0.15, c + 0.15, YELLOW);
  }
  for (const c of layout.connectors) {
    const mid = c.s;
    bar(mid - 0.15, mid + 0.15, c.lat0 + (c.flare ? 10 : 0), c.lat1 + 0.3, YELLOW);
    if (c.flare) {
      for (let k = 0; k < 4; k++) {
        const lat = W / 2 + 12 + k * 0.7;
        const h = c.width / 2;
        if (k < 2) bar(c.s - h, c.s + h, lat - 0.15, lat + 0.15, YELLOW);
        else for (let s = c.s - h; s < c.s + h - 1; s += 3) bar(s, s + 1.5, lat - 0.15, lat + 0.15, YELLOW);
      }
    }
  }
  for (const p of layout.parking) {
    bar(p.s - 0.15, p.s + 0.15, 94, p.lat - 9, YELLOW);
    bar(p.s - 4, p.s + 4, p.lat - 9.3, p.lat - 8.7, YELLOW);
    for (const side of [-1, 1]) bar(p.s + side * 9.3, p.s + side * 9.9, p.lat - 9, p.lat + 10, rgb("#c8c8c0"));
  }

  // Runway designators.
  const numerals = new MeshBuilder();
  {
    const h = 7.5;
    const sN = -(L / 2 - 55.5), sF = L / 2 - 55.5;
    // Near end: glyph top toward +s. Far end: rotated half a turn. Atlas v: top cell [0.5,1].
    const [lo0, hi0] = [0.5, 1], [lo1, hi1] = [0, 0.5];
    numerals.quad([-h, my, -(sN - h)], [h, my, -(sN - h)], [h, my, -(sN + h)], [-h, my, -(sN + h)], [1, 1, 1], undefined, undefined, undefined, [0, lo0, 1, lo0, 1, hi0, 0, hi0]);
    numerals.quad([h, my, -(sF + h)], [-h, my, -(sF + h)], [-h, my, -(sF - h)], [h, my, -(sF - h)], [1, 1, 1], undefined, undefined, undefined, [0, lo1, 1, lo1, 1, hi1, 0, hi1]);
  }

  // ----- structures ----------------------------------------------------
  let towerTop = 0;
  const trimBand = (cx: number, y: number, cz: number, sx: number, sy: number, sz: number, c: RGB, b = solid) => b.box(cx, y, cz, sx, sy, sz, c, c, 0, 1);

  const hangar = (st: Structure, b: MeshBuilder, wall: RGB, roof: RGB) => {
    const [cx, cz] = P(st.lat, st.s);
    const rise = Math.min(7, st.h * 0.4), wallH = st.h - rise;
    b.arch(cx, E, cz, st.w, st.d, wallH, rise, wall, roof, 14, true, 0.66);
    // Roof ribs.
    const ribs = Math.floor(st.w / 7);
    for (let i = 0; i <= ribs; i++)
      b.arch(cx - st.w / 2 + 0.3 + (i * (st.w - 0.6)) / ribs, E, cz, 0.6, st.d + 0.4, wallH, rise + 0.3, scale(roof, 0.8), scale(roof, 0.8), 14, false, 1);
    // Doors on the gable end, with a frame and bold stripe.
    const sgn = (st.face ?? -1) as 1 | -1;
    const x = cx + sgn * (st.w / 2 + 0.1);
    const dw = st.d - 6, dh = wallH - 0.4;
    const n = 3;
    for (let i = 0; i < n; i++) {
      const a0 = cz - dw / 2 + (i * dw) / n + 0.1, a1 = cz - dw / 2 + ((i + 1) * dw) / n - 0.1;
      const shade = 0.88 + 0.12 * ((i + 1) % 2);
      b.quadFacing([x, E, a0], [x, E, a1], [x, E + dh, a1], [x, E + dh, a0], [sgn, 0, 0], scale(style.door, shade));
    }
    trimBand(x + sgn * 0.05, E + dh, cz, 0.4, 0.5, dw + 1.2, style.accent, b);
    for (const side of [-1, 1]) trimBand(x + sgn * 0.05, E, cz + side * (dw / 2 + 0.3), 0.4, dh, 0.6, style.accent, b);
    // High side windows.
    for (const side of [-1, 1] as const) {
      windowRow("z", side, cz + side * (st.d / 2), cx - st.w / 2 + 3, cx + st.w / 2 - 3, E + wallH - 3, 1.1, 4.2, 2.4, lit * 0.7);
    }
  };

  const shelter = (st: Structure, b: MeshBuilder, concreteCol: RGB, earth: RGB) => {
    const [cx, cz] = P(st.lat, st.s);
    const wallH = 3.2, rise = st.h - wallH;
    b.arch(cx, E, cz, st.w, st.d, wallH, rise, concreteCol, earth, 14, true, 0.6);
    const sgn = (st.face ?? -1) as 1 | -1;
    const x = cx + sgn * (st.w / 2 + 0.12);
    const dw = st.d - 8;
    const dh = wallH + rise * 0.55;
    b.quadFacing([x, E, cz - dw / 2], [x, E, cz + dw / 2], [x, E + dh, cz + dw / 2], [x, E + dh, cz - dw / 2], [sgn, 0, 0], style.door);
    // Blast-door seam and concrete portal lip.
    b.quadFacing([x + sgn * 0.02, E, cz - 0.15], [x + sgn * 0.02, E, cz + 0.15], [x + sgn * 0.02, E + dh, cz + 0.15], [x + sgn * 0.02, E + dh, cz - 0.15], [sgn, 0, 0], scale(style.door, 0.4));
    b.box(x + sgn * 0.6, E + dh, cz, 1.6, 0.8, dw + 3, scale(concreteCol, 1.1), scale(concreteCol, 1.1), 0, 1);
    for (const side of [-1, 1]) b.box(x + sgn * 0.6, E, cz + side * (dw / 2 + 0.9), 1.6, dh, 1.8, scale(concreteCol, 1.05), scale(concreteCol, 1.05), 0, 0.8);
    // Earth flanks banked up the sides.
    for (const side of [-1, 1]) {
      const z0 = cz + side * (st.d / 2);
      b.flat([[cx - st.w / 2, z0], [cx + st.w / 2, z0], [cx + st.w / 2, z0 + side * 5], [cx - st.w / 2, z0 + side * 5]], E + 0.05, scale(earth, 0.8), 0);
    }
  };

  const tower = (st: Structure) => {
    const [cx, cz] = P(st.lat, st.s);
    const c = style.checker;
    solid.box(cx, E, cz, st.w, 5, st.w, style.wall, style.roof, 0, 0.7);
    windowRow("x", -1, cx - st.w / 2, cz - st.w / 2 + 1, cz + st.w / 2 - 1, E + 1.9, 1.5, 2.4, 1.6, lit);
    windowRow("x", 1, cx + st.w / 2, cz - st.w / 2 + 1, cz + st.w / 2 - 1, E + 1.9, 1.5, 2.4, 1.6, lit);
    const shaft = st.w * 0.62;
    if (c) {
      checkerBox(solid, cx, E + 5, cz, shaft, 17, shaft, 2.2, c[0], c[1]);
    } else {
      solid.box(cx, E + 5, cz, shaft, 17, shaft, style.wall, style.roof, 0, 0.8);
      trimBand(cx, E + 12, cz, shaft + 0.3, 1.2, shaft + 0.3, style.accent);
    }
    const yc = E + 22;
    solid.box(cx, yc, cz, shaft + 5, 0.9, shaft + 5, scale(style.roof, 0.8), scale(style.roof, 0.8), 0, 1);
    // Glass cab: eight flared panes.
    const r0 = (shaft + 3) * 0.6, r1 = r0 + 1.6, y0 = yc + 0.9, y1 = y0 + 3.6;
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2 + Math.PI / 8, a1 = ((i + 1) / 8) * Math.PI * 2 + Math.PI / 8;
      const mid = (a0 + a1) / 2;
      windows.quadFacing(
        [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0], [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0],
        [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1], [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1],
        [Math.cos(mid), 0.3, Math.sin(mid)], [1, 1, 1],
      );
    }
    solid.cylinder(cx, y1, cz, r1 + 1.1, 0.7, 8, scale(style.roof, 0.7), scale(style.roof, 0.6), r1 + 0.9, 1);
    solid.cylinder(cx, y1 + 0.7, cz, 1.4, 0.8, 8, style.trim);
    solid.cylinder(cx, y1 + 1.5, cz, 0.16, 7, 5, style.trim);
    solid.box(cx, y1 + 4.5, cz, 3.6, 0.35, 0.5, style.trim, style.trim, 0, 1);
    towerTop = y1 + 8.5;
    glows.push({ x: cx, y: y1 + 8.8, z: cz, color: GLOW_RED, size: 1.1 });
    // Rotating aerodrome beacon: alternating white and green flashes.
    glows.push({ x: cx, y: y1 + 1.7, z: cz, color: GLOW_WHITE, size: 3, strobe: 0, gain: 1.6 });
    glows.push({ x: cx, y: y1 + 1.7, z: cz, color: GLOW_GREEN, size: 3, strobe: 0.5, gain: 1.6 });
    // Warm interior glow of the cab at night.
    glows.push({ x: cx, y: y0 + 1.6, z: cz, color: [5, 3.8, 2.2], size: 6, gain: 0.5 });
  };

  const terminal = (st: Structure) => {
    const [cx, cz] = P(st.lat, st.s);
    solid.box(cx, E, cz, st.w, st.h, st.d, style.wall, style.roof, 0, 0.7);
    trimBand(cx, E + st.h - 1.2, cz, st.w + 0.4, 1.2, st.d + 0.4, style.wallB);
    // Continuous glazing on the apron side, two storeys.
    const fx = cx - st.w / 2;
    windowRow("x", -1, fx, cz - st.d / 2 + 2, cz + st.d / 2 - 2, E + 1.0, 2.6, 4.6, 4.0, 0.85);
    windowRow("x", -1, fx, cz - st.d / 2 + 2, cz + st.d / 2 - 2, E + 4.8, 2.6, 4.6, 4.0, 0.75);
    windowRow("x", 1, cx + st.w / 2, cz - st.d / 2 + 2, cz + st.d / 2 - 2, E + 3.2, 1.8, 4, 2.6, lit);
    // Canopy over the main entrance.
    solid.box(fx - 3.5, E + 4.4, cz, 7, 0.45, st.d * 0.6, style.accent, style.accent, 0, 1);
    for (const side of [-1, 1]) solid.cylinder(fx - 6, E, cz + side * st.d * 0.28, 0.3, 4.4, 6, style.trim);
    // Rooftop plant.
    solid.box(cx + 4, E + st.h, cz + 6, 8, 2, 6, style.wallB, style.wallB, 0, 0.8);
    solid.box(cx - 6, E + st.h, cz - 8, 4, 1.6, 4, style.wallB, style.wallB, 0, 0.8);
  };

  const barracks = (st: Structure) => {
    const [cx, cz] = P(st.lat, st.s);
    const wallH = st.h - 2.6;
    solid.arch(cx, E, cz, st.d, st.w, wallH, 2.6, style.wall, style.roof, 2, true, 0.62, Math.PI / 2);
    for (const side of [-1, 1] as const) {
      windowRow("x", side, cx + side * (st.w / 2), cz - st.d / 2 + 3, cz + st.d / 2 - 3, E + 2.2, 1.3, 3.4, 1.5, lit + 0.1);
    }
    solid.box(cx - st.w / 2 - 0.5, E, cz, 1, 0.3, 3, style.wallB, style.wallB, 0, 1);
  };

  const shed = (st: Structure) => {
    const [cx, cz] = P(st.lat, st.s);
    solid.box(cx, E, cz, st.w, st.h, st.d, style.wallB, style.roof, 0, 0.7);
    for (let i = 0; i < 4; i++) {
      const z = cz - st.d / 2 + 8 + (i * (st.d - 16)) / 3;
      windows.quadFacing([cx + st.w / 2 + 0.05, E, z - 2], [cx + st.w / 2 + 0.05, E, z + 2], [cx + st.w / 2 + 0.05, E + st.h - 1.2, z + 2], [cx + st.w / 2 + 0.05, E + st.h - 1.2, z - 2], [1, 0, 0], [0.03, 0.03, 0.03]);
    }
  };

  const tank = (st: Structure, b: MeshBuilder) => {
    const [cx, cz] = P(st.lat, st.s);
    const r = st.w / 2 - 1;
    b.cylinder(cx, E, cz, r, st.h, 20, style.tank, style.tankTop, r, 0.62);
    b.cylinder(cx, E + st.h, cz, r, 1.3, 20, style.tankTop, style.tankTop, r * 0.12, 1);
    for (const y of [0.3, 0.6]) b.cylinder(cx, E + st.h * y, cz, r + 0.12, 0.35, 20, scale(style.tank, 0.8), scale(style.tank, 0.8), r + 0.12, 1);
    // Access stair running up the side.
    b.box(cx + r + 0.4, E, cz, 0.8, st.h + 0.5, 1.4, style.trim, style.trim, 0, 1);
  };

  const dome = (st: Structure) => {
    const [cx, cz] = P(st.lat, st.s);
    solid.box(cx, E, cz, 9, 11, 9, style.wall, style.roof, 0, 0.66);
    solid.cylinder(cx, E + 11, cz, 4.4, 1.2, 12, style.trim, style.trim, 4.8, 1);
    solid.geodesic(cx, E + 11 + 5.4, cz, 6, 1, [0.92, 0.94, 0.95], 0.1, 3, 0.95);
    glows.push({ x: cx, y: E + 11 + 11.8, z: cz, color: GLOW_RED, size: 1.1 });
    windowRow("x", -1, cx - 4.5, cz - 3, cz + 3, E + 3, 1.6, 3, 1.4, lit);
  };

  const gate = (st: Structure) => {
    const [cx, cz] = P(st.lat, st.s);
    solid.box(cx, E, cz, st.w, st.h, st.d, style.wallB, style.roof, 0, 0.7);
    solid.box(cx - 8, E + 1.0, cz, 0.35, 0.35, 7, YELLOW, YELLOW, 0, 1);
    for (const side of [-1, 1]) solid.box(cx - 8, E, cz + side * 3.6, 0.5, 1.4, 0.5, style.trim, style.trim, 0, 1);
    glows.push({ x: cx, y: E + st.h + 0.4, z: cz, color: GLOW_AMBER, size: 1.4 });
  };

  // Floodlight masts around the aprons, with a pool of light under each.
  const floodlights = () => {
    for (const f of layout.floodlights) {
      const [x, z] = P(f.lat, f.s);
      solid.cylinder(x, E, z, 0.32, f.h, 6, style.trim, style.trim, 0.2, 1);
      solid.box(x, E + f.h, z, 3.4, 0.5, 1.5, style.roof, style.roof, 0, 1);
      for (let k = -1; k <= 1; k += 2) {
        glows.push({ x: x + k * 1.0, y: E + f.h - 0.1, z: z + 0.4, color: FLOOD, size: 2.2, gain: 1 });
        glows.push({ x: x + k * 1.0, y: E + f.h - 0.1, z: z - 0.4, color: FLOOD, size: 2.2, gain: 1 });
      }
      pools.push({ x, y: E + 0.12, z, color: [0.9, 0.76, 0.5], radius: 36 });
    }
  };

  // ----- place every layout structure ---------------------------------
  const strikeBuilder = (st: Structure) => (st.target ? targetOf(st.target).intact : solid);
  for (const st of layout.structures) {
    switch (st.kind) {
      case "hangar":
        hangar(st, solid, style.wall, style.hangarRoof);
        break;
      case "shelter":
        shelter(st, strikeBuilder(st), style.hardened, style.earth);
        break;
      case "tower":
        tower(st);
        break;
      case "terminal":
        terminal(st);
        break;
      case "barracks":
        barracks(st);
        break;
      case "shed":
        shed(st);
        break;
      case "tank":
        tank(st, strikeBuilder(st));
        break;
      case "dome":
        dome(st);
        break;
      case "gate":
        gate(st);
        break;
      case "bunker": {
        const [cx, cz] = P(st.lat, st.s);
        solid.box(cx, E, cz, st.w, st.h, st.d, style.hardened, style.earth, 0, 0.6);
        solid.box(cx - st.w / 2 - 2.2, E, cz, 4.4, 4.4, 7, style.hardened, style.hardened, 0, 0.7);
        solid.quadFacing([cx - st.w / 2 - 4.35, E, cz - 2.2], [cx - st.w / 2 - 4.35, E, cz + 2.2], [cx - st.w / 2 - 4.35, E + 3.2, cz + 2.2], [cx - st.w / 2 - 4.35, E + 3.2, cz - 2.2], [-1, 0, 0], style.door);
        break;
      }
      case "radar":
        break;
    }
  }
  floodlights();

  // Windsock beside the runway.
  {
    const [x, z] = P(layout.windsock.lat, layout.windsock.s);
    solid.cylinder(x, E, z, 0.12, 7, 5, style.trim);
    for (let k = 0; k < 5; k++) {
      const m = new T.Matrix4().makeRotationZ(-Math.PI / 2 + 0.1 * k).setPosition(x + 0.6 + k * 0.82, 7 - 0.08 * k * k * 0.6, z);
      solid.add(new T.CylinderGeometry(0.46 - k * 0.05, 0.5 - k * 0.05, 0.82, 8), m, k % 2 ? [0.9, 0.9, 0.88] : [0.9, 0.34, 0.06]);
    }
  }

  // ----- extra scenery per base ---------------------------------------
  if (base.id === "haven") {
    // Fuel-farm berm and pipe runs.
    const tanks = layout.structures.filter((s) => s.kind === "tank");
    const xs = tanks.map((t) => t.lat), ss = tanks.map((t) => t.s);
    const lo = P(Math.min(...xs) - 16, Math.min(...ss) - 16), hi = P(Math.max(...xs) + 16, Math.max(...ss) + 16);
    berm(solid, lo, hi, style.earth, 1.6, E);
    groundSupport(solid, layout, style, rand, E);
  } else {
    blackridgeExtras();
  }

  function blackridgeExtras() {
    const earth = style.earth;
    // Dispersal bays with earth revetments along the taxiway.
    const bays: [number, number][] = [[-640, 118], [-580, 118], [-520, 118], [150, 118], [210, 118]];
    for (const [s, lat] of bays) {
      const [x, z] = P(lat, s);
      asphalt.flat([[lat - 14, -(s - 11)], [lat + 14, -(s - 11)], [lat + 14, -(s + 11)], [lat - 14, -(s + 11)]], E, style.asphalt, 8);
      asphalt.flat([[81, -(s - 6)], [lat - 14, -(s - 6)], [lat - 14, -(s + 6)], [81, -(s + 6)]], E, style.asphalt, 8);
      solid.box(x + 15, E, z, 3, 3.6, 28, earth, scale(earth, 1.1), 0, 0.6);
      for (const side of [-1, 1]) solid.box(x, E, z + side * 12.5, 30, 3.2, 3, earth, scale(earth, 1.1), 0, 0.6);
    }
    // Anti-aircraft gun pits ringed with sandbags.
    for (const [lat, s] of [[-30, -400], [-30, 400], [350, -200], [350, 250]] as [number, number][]) {
      const [x, z] = P(lat, s);
      solid.cylinder(x, E, z, 4.6, 1.3, 12, scale(earth, 1.15), scale(earth, 0.5), 4.6, 0.8);
      solid.cylinder(x, E + 1.3, z, 3.4, 0.2, 12, scale(earth, 0.4));
      solid.box(x, E + 1.2, z, 1.2, 1.1, 1.6, style.trim, style.trim, 0, 1);
      const m = new T.Matrix4().makeRotationZ(-0.9).premultiply(new T.Matrix4().makeRotationY(rand() * 6)).setPosition(x, E + 2.2, z);
      solid.add(new T.CylinderGeometry(0.12, 0.12, 4.6, 6), m, style.trim);
    }
    // Guard towers on the perimeter.
    for (const g of layout.guardTowers) {
      const [x, z] = P(g.lat, g.s);
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) solid.box(x + dx * 1.4, E, z + dz * 1.4, 0.35, 6, 0.35, style.trim, style.trim, 0, 1);
      solid.box(x, E + 6, z, 4.2, 2.2, 4.2, style.wall, style.roof, 0, 0.9);
      windowRow("x", -1, x - 2.1, z - 1.6, z + 1.6, E + 6.7, 1.0, 1.6, 1.2, lit);
      glows.push({ x, y: E + 8.6, z, color: GLOW_RED, size: 0.9, gain: 0.8 });
    }
    // Camouflage netting over the flight line equipment, in drab sheets.
    for (const [lat, s, w, d] of [[118, -360, 18, 30], [260, -250, 24, 16]] as number[][]) {
      const [x, z] = P(lat, s);
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) solid.box(x + (dx * w) / 2.2, E, z + (dz * d) / 2.2, 0.25, 3.2, 0.25, style.trim, style.trim, 0, 1);
      solid.box(x, E + 3.2, z, w, 0.12, d, scale(style.wall, 0.9), scale(style.wall, 0.95), 0.1, 1);
    }
    groundSupport(solid, layout, style, rand, E);
    // Target: fuel depot dressing (berm, cross-pipes, pump house).
    {
      const t = targetOf("fuel").intact;
      berm(t, P(186, -512), P(258, -388), earth, 1.6, E);
      for (const z of [414, 450, 486]) t.box(222, E + 0.8, z, 36, 0.5, 0.5, style.trim, style.trim, 0, 1);
      t.box(222, E, 450, 4.5, 3.4, 4.5, style.wallB, style.roof, 0, 0.7);
      t.box(222, E, 396, 3, 2.4, 3, style.wallB, style.roof, 0, 0.7);
    }
    // Target: radar installation.
    radarCompound();
  }

  function radarCompound() {
    const st = layout.structures.find((s) => s.id === "radar-base")!;
    const t = targetOf("radar");
    const b = t.intact;
    const [cx, cz] = P(st.lat, st.s);
    // Sandbagged perimeter.
    const R = 40;
    for (const [dx, dz, sx, sz] of [[0, -R, 2 * R, 2.4], [0, R, 2 * R, 2.4], [-R, 0, 2.4, 2 * R], [R, 0, 2.4, 2 * R]] as number[][])
      b.box(cx + dx, E, cz + dz, sx, 1.7, sz, scale(style.earth, 1.1), scale(style.earth, 0.8), 0, 0.6);
    // Equipment building, tapering mast and turntable.
    b.box(cx, E, cz, st.w, st.h, st.w, style.hardened, scale(style.hardened, 0.8), 0, 0.6);
    windowRow("x", -1, cx - st.w / 2, cz - 10, cz + 10, E + 4.5, 1.1, 4, 2, lit);
    b.cylinder(cx, E + st.h, cz, 5.2, 24, 8, style.wall, style.wall, 3.4, 0.7);
    b.cylinder(cx, E + st.h + 24, cz, 4.4, 1.6, 12, style.trim, style.trim, 4.4, 1);
    t.antenna = { ...radarAntennaGeometry(style), x: cx, y: E + st.h + 25.6, z: cz };
    // Generator sheds, containers, two radomes on pedestals, aerials.
    for (const [dx, dz, w, d] of [[-24, -22, 8, 14], [-24, 0, 8, 14], [-24, 22, 8, 10]] as number[][])
      b.box(cx + dx, E, cz + dz, w, 3.4, d, style.wallB, style.roof, 0, 0.6);
    const box = [rgb("#566046"), rgb("#6e5f43"), rgb("#4b5360")];
    for (let i = 0; i < 6; i++) b.box(cx + 24 + (i % 2) * 3, E + (i >> 2) * 2.7, cz - 28 + (i >> 1) * 9, 2.5, 2.6, 11.5, box[i % 3], scale(box[i % 3], 0.8), 0, 0.7);
    for (const dz of [-24, 24]) {
      b.cylinder(cx + 5, E, cz + dz, 1.6, 6, 8, style.trim, style.trim, 1.6, 0.7);
      b.geodesic(cx + 5, E + 9, cz + dz, 4, 1, [0.82, 0.84, 0.8], 0.14, 17 + dz, 0.95);
    }
    for (const [dx, dz] of [[-34, 30], [30, 34], [34, -32]] as number[][]) {
      b.cylinder(cx + dx, E, cz + dz, 0.25, 22, 6, style.trim, style.trim, 0.12, 1);
      t.glows.push({ x: cx + dx, y: E + 22.4, z: cz + dz, color: GLOW_RED, size: 1.0 });
    }
    t.glows.push({ x: cx, y: E + st.h + 28.4, z: cz, color: GLOW_RED, size: 1.4 });
    t.glows.push({ x: cx + 5, y: E + 14.4, z: cz - 24, color: GLOW_RED, size: 1.0 });
    t.glows.push({ x: cx + 5, y: E + 14.4, z: cz + 24, color: GLOW_RED, size: 1.0 });
    // Antenna: a lattice reflector on a yoke, built facing +x and spun about y.
    // Wreck: collapsed structure, fallen antenna, scattered debris.
    const w = t.wreck;
    const char = rgb("#1b1a18"), ash = rgb("#34312c"), rust = rgb("#4d3524");
    w.box(cx, E, cz, st.w, 3.2, st.w, char, scale(ash, 0.8), 0, 0.5);
    w.box(cx - 6, E + 3, cz + 4, 14, 2.4, 9, ash, char, 0.25, 0.5);
    w.box(cx + 7, E, cz - 6, 10, 1.7, 8, char, ash, -0.3, 0.5);
    const mast = new T.Matrix4().makeRotationZ(1.2).premultiply(new T.Matrix4().makeRotationY(0.4)).setPosition(cx + 6, E + 2.2, cz + 7);
    w.add(new T.CylinderGeometry(3.2, 4.4, 15, 8, 1, true), mast, ash);
    const dish = new T.Matrix4().makeRotationZ(-0.25).premultiply(new T.Matrix4().makeRotationY(-0.8)).setPosition(cx + 20, E + 1.8, cz + 14);
    w.add(new T.CylinderGeometry(12, 12, 7, 10, 1, true, 0, 0.7), dish, rust);
    w.box(cx - 24, E, cz - 22, 8, 1.6, 14, char, ash, 0.2, 0.5);
    w.box(cx - 24, E, cz + 1, 8, 1.0, 13, ash, char, -0.1, 0.5);
    for (let i = 0; i < 6; i++) w.box(cx + 24 + (i % 2) * 3.5, E, cz - 28 + (i >> 1) * 9, 2.5, 1 + rand() * 1.6, 11.5, i % 2 ? char : rust, char, rand() * 0.6 - 0.3, 0.5);
    debris(w, cx, cz, 34, 40, E, rand, [char, ash, rust]);
    t.wglows.push({ x: cx - 4, y: E + 3.4, z: cz + 2, color: [9, 3.6, 0.8], size: 5, strobe: 0.15 }, { x: cx + 8, y: E + 1.2, z: cz - 6, color: [9, 3.2, 0.7], size: 4, strobe: 0.6 });
    t.scorch.push({ x: cx, z: cz, r: 48 });
  }

  // Fuel depot and shelter wrecks.
  if (base.id === "blackridge") {
    const char = rgb("#1b1a18"), ash = rgb("#33302b"), rust = rgb("#4d3524");
    {
      const t = targetOf("fuel");
      for (const st of layout.structures.filter((s) => s.target === "fuel")) {
        const [cx, cz] = P(st.lat, st.s);
        const r = st.w / 2 - 1;
        const open = new T.Matrix4().setPosition(cx, E + 2.2, cz);
        t.wreck.add(new T.CylinderGeometry(r, r + 0.4, 4.4, 14, 1, true, rand() * 6, 3.8 + rand() * 1.2), open, rust);
        t.wreck.cylinder(cx, E, cz, r - 0.3, 0.5, 14, char, char, r - 0.3, 1);
        t.wreck.box(cx + (rand() - 0.5) * 8, E, cz + (rand() - 0.5) * 8, 5, 0.9 + rand(), 4, ash, char, rand() * 3, 0.6);
        t.wglows.push({ x: cx, y: E + 1.6, z: cz, color: [10, 4, 0.8], size: 6 + rand() * 3, strobe: rand() });
      }
      berm(t.wreck, P(186, -512), P(258, -388), rgb("#2a2620"), 1.4, E);
      debris(t.wreck, P(222, -450)[0], P(222, -450)[1], 56, 22, E, rand, [char, ash, rust]);
      t.scorch.push({ x: P(222, -450)[0], z: P(222, -450)[1], r: 64 });
    }
    {
      const t = targetOf("shelters");
      for (const st of layout.structures.filter((s) => s.target === "shelters")) {
        const [cx, cz] = P(st.lat, st.s);
        t.wreck.arch(cx, E, cz, st.w, st.d, 3.2, 2.2 + rand() * 2.2, ash, char, 8, true, 0.5);
        for (let k = 0; k < 5; k++) t.wreck.box(cx + (rand() - 0.5) * 30, E, cz + (rand() - 0.5) * 22, 2 + rand() * 4, 0.8 + rand() * 1.8, 2 + rand() * 4, ash, char, rand() * 3, 0.6);
        t.wglows.push({ x: cx - 6, y: E + 1.4, z: cz, color: [10, 3.8, 0.7], size: 5, strobe: rand() });
      }
      debris(t.wreck, P(180, 0)[0], P(180, 0)[1], 40, 36, E, rand, [char, ash, rust]);
      t.scorch.push({ x: P(180, 0)[0], z: P(180, 0)[1], r: 58 });
    }
  }

  // ----- parked aircraft slots ---------------------------------------
  const parking = layout.parking.map((p) => {
    const [x, z] = P(p.lat, p.s);
    return { x, z, yaw: p.yaw };
  });

  // ----- fence ---------------------------------------------------------
  const fence = new MeshBuilder();
  {
    const f = layout.fence;
    const fh = 3, y0 = E - 0.1;
    const side = (a: P2, b: P2) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      fence.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y0 + fh, b[1]], [a[0], y0 + fh, a[1]], [1, 1, 1], undefined, undefined, undefined, [0, 0, len / 6, 0, len / 6, 1, 0, 1]);
    };
    const c = [P(f.lat0, f.s0), P(f.lat1, f.s0), P(f.lat1, f.s1), P(f.lat0, f.s1)];
    for (let i = 0; i < 4; i++) side(c[i], c[(i + 1) % 4]);
  }

  // ----- lights --------------------------------------------------------
  const G = style.lightGain;
  const gl = (c: [number, number, number]): [number, number, number] => [c[0] * G, c[1] * G, c[2] * G];
  const groundY = (lat: number, s: number) => {
    const w = toWorld(base, lat, s);
    return Math.max(heightAt(w.x, w.z), E - 6);
  };
  // Runway edge lights: white, amber over the last 600 m.
  {
    const n = Math.round(L / 50);
    for (let i = 0; i <= n; i++) {
      const s = -L / 2 + (i * L) / n;
      const fromEnd = Math.min(s + L / 2, L / 2 - s);
      const c = fromEnd < 400 ? GLOW_AMBER : GLOW_WHITE;
      for (const side of [-1, 1]) lampGlow(side * (W / 2 + 1.0), E + 0.5, s, gl(c), 0.9);
    }
  }
  for (const e of [-1, 1]) {
    // Threshold (green, facing the approach) and end lights (red, facing the runway).
    const outward: 1 | 2 = e < 0 ? 1 : 2, inward: 1 | 2 = e < 0 ? 2 : 1;
    const nL = 14;
    for (let i = 0; i < nL; i++) {
      const lat = -W / 2 + 1.4 + (i * (W - 2.8)) / (nL - 1);
      lampGlow(lat, E + 0.3, e * (L / 2 - 0.6), gl(GLOW_GREEN), 0.8, { dir: outward });
      lampGlow(lat, E + 0.3, e * (L / 2 + 1.4), gl(GLOW_RED), 0.8, { dir: inward });
    }
    for (const side of [-1, 1]) for (let k = 0; k < 4; k++) lampGlow(side * (W / 2 + 2.6 + k * 1.6), E + 0.4, e * (L / 2 - 0.6), gl(GLOW_GREEN), 0.8, { dir: outward });
    // Approach system: centreline stations every 30 m with crossbars and sequenced flashers.
    for (let k = 1; k <= 10; k++) {
      const s = e * (L / 2 + 30 * k);
      const y = groundY(0, s) + 1.1;
      for (const lat of [-1.5, 0, 1.5]) glows.push({ x: lat, y, z: -s, color: gl(GLOW_WHITE), size: 0.9, dir: outward });
      if (k >= 3) glows.push({ x: 0, y: y + 0.6, z: -s, color: gl(GLOW_WHITE), size: 2.6, strobe: ((10 - k) * 0.07) % 1, dir: outward, gain: 1.5 });
      const bar = k === 1 ? 4 : k === 5 ? 6 : 0;
      for (let b = 1; b <= bar; b++) for (const side of [-1, 1]) glows.push({ x: side * (1.5 + b * (k === 1 ? 1.5 : 2.4)), y, z: -s, color: gl(k === 1 ? GLOW_RED : GLOW_WHITE), size: 0.9, dir: outward });
    }
  }
  // PAPI: four units on the left of each approach.
  const papi: Glow[] = [];
  const papiUnits: PapiUnit[] = [];
  const thresholds = [3.5, 3.17, 2.83, 2.5];
  for (const e of [-1, 1] as const) {
    const s = e * (L / 2 - 300);
    for (let i = 0; i < 4; i++) {
      const lat = -e * (W / 2 + 14 + i * 9);
      papiUnits.push({ glow: papi.length, x: lat, y: E + 0.7, z: -s, dir: -e as 1 | -1, threshold: thresholds[i] });
      papi.push({ x: lat, y: E + 0.7, z: -s, color: [8, 8, 8], size: 1.9, dir: e < 0 ? 1 : 2 });
    }
  }
  // Taxiway lights: blue edges (amber over there), every 30 m.
  {
    const c = gl(style.taxi);
    for (const t of layout.taxiways)
      for (let s = t.s0; s <= t.s1; s += 30) {
        glows.push({ x: t.lat0 - 0.8, y: E + 0.3, z: -s, color: c, size: 0.7 });
        glows.push({ x: t.lat1 + 0.8, y: E + 0.3, z: -s, color: c, size: 0.7 });
      }
    for (const k of layout.connectors)
      for (let lat = k.lat0 + 6; lat < k.lat1 - 3; lat += 14)
        for (const side of [-1, 1]) glows.push({ x: lat, y: E + 0.3, z: -(k.s + side * (k.width / 2 + (k.flare ? 12 : 1))), color: c, size: 0.7 });
  }
  // Building lights along the road and hangar frontage.
  for (const st of layout.structures.filter((s) => s.kind === "hangar" || s.kind === "terminal"))
    for (let i = 0; i < 3; i++) {
      const [x, z] = P(st.lat, st.s);
      glows.push({ x: x - st.w / 2 - 0.6, y: E + 6.5, z: z + (i - 1) * (st.d * 0.3), color: [11, 9, 6], size: 1.5, gain: 0.8 });
    }

  return {
    runway: runway.build(),
    asphalt: asphalt.build(),
    concrete: concrete.build(),
    markings: markings.build(),
    numerals: numerals.build(),
    solid: solid.build(),
    windows: windows.build(),
    fence: fence.build(),
    glows,
    papi,
    papiUnits,
    pools,
    parking,
    extent: Math.max(towerTop, 40),
    targets: Object.fromEntries(
      Object.entries(targetBuilders).map(([id, t]) => [
        id,
        {
          intact: t.intact.build(),
          intactGlows: t.glows,
          antenna: t.antenna,
          wreck: t.wreck.build(),
          wreckGlows: t.wglows,
          scorch: t.scorch,
        } satisfies TargetGeometry,
      ]),
    ),
  };
}

// ---- helpers --------------------------------------------------------------

function checkerBox(b: MeshBuilder, cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, cell: number, A: RGB, B: RGB) {
  const nx = Math.max(1, Math.round(sx / cell)), nz = Math.max(1, Math.round(sz / cell)), ny = Math.max(1, Math.round(sy / cell));
  const dx = sx / nx, dz = sz / nz, dy = sy / ny;
  const face = (axis: "x" | "z", sign: 1 | -1, n: number, du: number) => {
    for (let i = 0; i < n; i++)
      for (let j = 0; j < ny; j++) {
        const c = (i + j) % 2 ? A : B;
        const ya = y0 + j * dy, yb = ya + dy;
        if (axis === "x") {
          const x = cx + (sign * sx) / 2, za = cz - sz / 2 + i * du, zb = za + du;
          b.quadFacing([x, ya, za], [x, ya, zb], [x, yb, zb], [x, yb, za], [sign, 0, 0], scale(c, 0.8 + 0.2 * (j / ny)));
        } else {
          const z = cz + (sign * sz) / 2, xa = cx - sx / 2 + i * du, xb = xa + du;
          b.quadFacing([xa, ya, z], [xb, ya, z], [xb, yb, z], [xa, yb, z], [0, 0, sign], scale(c, 0.8 + 0.2 * (j / ny)));
        }
      }
  };
  face("x", 1, nz, dz);
  face("x", -1, nz, dz);
  face("z", 1, nx, dx);
  face("z", -1, nx, dx);
  b.rect(cx - sx / 2, cz - sz / 2, cx + sx / 2, cz + sz / 2, y0 + sy, scale(B, 0.9));
  void dy;
}

/** Low earth wall around a compound, given two ground corners. */
function berm(b: MeshBuilder, a: P2, c: P2, color: RGB, h: number, E: number) {
  const x0 = Math.min(a[0], c[0]), x1 = Math.max(a[0], c[0]), z0 = Math.min(a[1], c[1]), z1 = Math.max(a[1], c[1]);
  const t = 2.6;
  b.box((x0 + x1) / 2, E, z0, x1 - x0, h, t, color, scale(color, 1.1), 0, 0.7);
  b.box((x0 + x1) / 2, E, z1, x1 - x0, h, t, color, scale(color, 1.1), 0, 0.7);
  b.box(x0, E, (z0 + z1) / 2, t, h, z1 - z0, color, scale(color, 1.1), 0, 0.7);
  b.box(x1, E, (z0 + z1) / 2, t, h, z1 - z0, color, scale(color, 1.1), 0, 0.7);
}

/** Scattered wreckage chunks, deterministic from the caller's generator. */
function debris(b: MeshBuilder, cx: number, cz: number, rx: number, rz: number, E: number, rand: () => number, colors: RGB[]) {
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2, d = Math.sqrt(rand());
    const c = colors[(rand() * colors.length) | 0];
    b.box(cx + Math.cos(a) * rx * d, E, cz + Math.sin(a) * rz * d, 0.8 + rand() * 3, 0.3 + rand() * 1.4, 0.8 + rand() * 3, c, scale(c, 1.2), rand() * 6, 0.6);
  }
}

/** Ground-support vehicles parked around the aprons. */
function groundSupport(b: MeshBuilder, layout: BaseLayout, style: Style, rand: () => number, E: number) {
  const haven = layout.base.id === "haven";
  const bodies = haven ? [rgb("#e8e6df"), rgb("#d6a521"), rgb("#2c66a8")] : [rgb("#5a6444"), rgb("#74684a"), rgb("#4a4f3c")];
  const spots: [number, number, number][] = haven
    ? [[250, -220, 0], [248, -175, 0], [240, 110, 0], [118, -215, 1], [118, 120, 2], [255, -20, 0]]
    : [[100, -330, 0], [100, -310, 1], [118, 100, 2], [170, 440, 0], [165, 600, 1]];
  for (const [lat, s, k] of spots) {
    const x = lat, z = -s;
    const body = bodies[k % bodies.length];
    // Chassis, cab and tank.
    b.box(x, E + 0.5, z, 2.5, 0.7, 7.5, scale(style.trim, 0.7), scale(style.trim, 0.7), 0, 1);
    b.box(x, E + 1.2, z + 2.6, 2.4, 2.1, 2.3, body, scale(body, 1.1), 0, 0.8);
    const m = new T.Matrix4().makeRotationX(Math.PI / 2).setPosition(x, E + 2.0, z - 1.2);
    b.add(new T.CylinderGeometry(1.15, 1.15, 5, 12), m, body);
    for (const wz of [-2.6, 2.2]) for (const wx of [-1.1, 1.1]) {
      const wm = new T.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x + wx, E + 0.5, z + wz);
      b.add(new T.CylinderGeometry(0.5, 0.5, 0.4, 8), wm, [0.04, 0.04, 0.04]);
    }
    void rand;
  }
}

/**
 * Rotating radar reflector built facing +x about the origin: a concave lattice
 * dish (own material, alpha-tested) and the frame/yoke that carries it.
 */
export function radarAntennaGeometry(style: Style) {
  const frame = new MeshBuilder();
  const dish = new MeshBuilder();
  const steel = style.trim, paint = scale(style.wall, 1.1);
  const R = 34, arc = 0.74, h = 12, vx = 1.5;
  const t0 = (3 * Math.PI) / 2 - arc / 2;
  const refl = new T.CylinderGeometry(R, R, h, 24, 1, true, t0, arc);
  const uv = refl.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 12, uv.getY(i) * 6);
  dish.add(refl, new T.Matrix4().makeTranslation(R + vx, h / 2 + 1, 0), [1, 1, 1]);
  // Curved rails hugging the back of the reflector.
  for (const y of [1.25, h * 0.5 + 1, h + 0.75]) {
    const rail = new T.CylinderGeometry(R - 0.35, R - 0.35, 0.5, 24, 1, true, t0, arc);
    frame.add(rail, new T.Matrix4().makeTranslation(R + vx, y, 0), steel);
  }
  frame.box(vx - 0.9, 0.6, 0, 1.4, h + 1.6, 1.4, steel, steel, 0, 1);
  frame.cylinder(0, 0, 0, 3.4, 1.2, 12, steel, steel, 3.4, 1);
  frame.box(-2.4, 1.2, 0, 3.6, 4, 3.6, paint, paint, 0, 1); // counterweight
  // Feed horn on booms from the reflector's top and bottom edges.
  frame.box(vx + 8.5, 1, 0, 17, 0.35, 0.35, steel, steel, 0, 1);
  frame.box(vx + 8.5, h + 0.8, 0, 17, 0.35, 0.35, steel, steel, 0, 1);
  frame.box(vx + 17, h * 0.5 + 0.5, 0, 1.4, 3, 1.4, paint, paint, 0, 1);
  return { dish: dish.build(), frame: frame.build() };
}
