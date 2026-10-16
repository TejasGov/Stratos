import { BASES, BLACKRIDGE, HAVEN, type Base } from "./bases";

/**
 * Where everything stands on the two air bases, in each runway's own frame:
 * `lat` runs to the right of the takeoff direction, `s` along it, both from
 * the runway centre. Pure data (no three.js) so flight and physics can read
 * the same footprints the renderer builds from.
 */
export type StructureKind =
  | "hangar"
  | "shelter"
  | "tower"
  | "terminal"
  | "barracks"
  | "shed"
  | "tank"
  | "dome"
  | "radar"
  | "bunker"
  | "gate";

export interface Structure {
  id: string;
  kind: StructureKind;
  /** Footprint centre. */
  lat: number;
  s: number;
  /** Footprint extent across (lat) and along (s) the runway, and height. */
  w: number;
  d: number;
  h: number;
  /** Strike target this structure belongs to (combat destroys the whole group). */
  target?: string;
  /** Door/open side for hangars and shelters: -1 faces the runway (lat−). */
  face?: -1 | 1;
  /** False for scenery too low or thin to hit (still drawn). */
  collide?: boolean;
}

export interface Rect {
  lat0: number;
  lat1: number;
  s0: number;
  s1: number;
}

export interface Slot {
  lat: number;
  s: number;
  /** Rotation about up relative to the runway frame (π/2 noses toward the runway). */
  yaw: number;
}

export interface BaseLayout {
  base: Base;
  structures: Structure[];
  /** Asphalt taxiways (connectors are flared at the runway edge when drawn). */
  taxiways: Rect[];
  /** Taxi links: from the runway edge (flared) or off a taxiway, between lat0 and lat1. */
  connectors: { s: number; lat0: number; lat1: number; width: number; flare?: boolean }[];
  /** Concrete aprons and hardstands. */
  aprons: Rect[];
  /** Access roads. */
  roads: Rect[];
  parking: Slot[];
  /** Floodlight poles. */
  floodlights: { lat: number; s: number; h: number }[];
  /** Perimeter fence. */
  fence: Rect;
  /** Corner guard towers (enemy base). */
  guardTowers: { lat: number; s: number }[];
  windsock: { lat: number; s: number };
}

const HAVEN_LAYOUT: BaseLayout = (() => {
  const structures: Structure[] = [];
  // Arched hangars, doors toward the apron and runway.
  [-210, -125, -40].forEach((s, i) =>
    structures.push({ id: `hangar-${i}`, kind: "hangar", lat: 310, s, w: 72, d: 48, h: 15, face: -1 }),
  );
  structures.push({ id: "terminal", kind: "terminal", lat: 292, s: 62, w: 36, d: 64, h: 9 });
  structures.push({ id: "tower", kind: "tower", lat: 292, s: 136, w: 13, d: 13, h: 36 });
  // Hardened aircraft shelters in a row off the parallel taxiway.
  [330, 395, 460, 525, 590].forEach((s, i) =>
    structures.push({ id: `shelter-${i}`, kind: "shelter", lat: 196, s, w: 40, d: 30, h: 12, face: -1 }),
  );
  // Fuel farm.
  [
    [306, -440],
    [340, -440],
    [306, -405],
    [340, -405],
  ].forEach(([lat, s], i) =>
    structures.push({ id: `tank-${i}`, kind: "tank", lat, s, w: 22, d: 22, h: 12 }),
  );
  structures.push({ id: "radar-dome", kind: "dome", lat: 345, s: 430, w: 12, d: 12, h: 22 });
  // Barracks block west of the runway, with vehicle sheds.
  [-300, -230, -160, -90, -20].forEach((s, i) =>
    structures.push({ id: `barracks-${i}`, kind: "barracks", lat: -215, s, w: 15, d: 52, h: 8 }),
  );
  [120, 215].forEach((s, i) =>
    structures.push({ id: `shed-${i}`, kind: "shed", lat: -215, s, w: 22, d: 70, h: 6 }),
  );
  structures.push({ id: "gate", kind: "gate", lat: 355, s: -846, w: 9, d: 9, h: 4 });
  return {
    base: HAVEN,
    structures,
    taxiways: [{ lat0: 69, lat1: 91, s0: -760, s1: 760 }],
    connectors: [
      ...[-740, -360, 40, 740].map((s) => ({ s, lat0: 22.5, lat1: 69, width: 24, flare: true })),
      // Spurs to the hardened shelters.
      ...[330, 395, 460, 525, 590].map((s) => ({ s, lat0: 91, lat1: 164, width: 18 })),
    ],
    aprons: [
      { lat0: 91, lat1: 274, s0: -250, s1: 160 },
      // Shelter forecourts.
      { lat0: 164, lat1: 176, s0: 305, s1: 615 },
    ],
    roads: [
      { lat0: 366, lat1: 376, s0: -850, s1: 170 },
      { lat0: 328, lat1: 376, s0: -860, s1: -850 },
    ],
    parking: [
      ...[-195, -128, -61, 6, 73].map((s) => ({ lat: 150, s, yaw: Math.PI / 2 })),
      ...[-150, -62, 26].map((s) => ({ lat: 228, s, yaw: Math.PI / 2 })),
    ],
    floodlights: [
      { lat: 100, s: -245, h: 24 },
      { lat: 100, s: -80, h: 24 },
      { lat: 100, s: 100, h: 24 },
      { lat: 188, s: -245, h: 24 },
      { lat: 188, s: -40, h: 24 },
      { lat: 188, s: 150, h: 24 },
      { lat: 268, s: -245, h: 24 },
      { lat: 268, s: 155, h: 24 },
    ],
    fence: { lat0: -300, lat1: 380, s0: -860, s1: 860 },
    guardTowers: [],
    windsock: { lat: 40, s: -640 },
  };
})();

const BLACKRIDGE_LAYOUT: BaseLayout = (() => {
  const structures: Structure[] = [];
  structures.push({ id: "tower", kind: "tower", lat: 128, s: -250, w: 13, d: 13, h: 32 });
  [470, 545].forEach((s, i) =>
    structures.push({ id: `hangar-${i}`, kind: "hangar", lat: 200, s, w: 58, d: 46, h: 13, face: -1 }),
  );
  // Strike target: aircraft shelters.
  [-69, -23, 23, 69].forEach((s, i) =>
    structures.push({
      id: `shelter-${i}`, kind: "shelter", lat: 180, s, w: 40, d: 32, h: 12, face: -1, target: "shelters",
    }),
  );
  // Strike target: fuel depot.
  [204, 240].forEach((lat) =>
    [-486, -450, -414].forEach((s, j) =>
      structures.push({
        id: `tank-${lat}-${j}`, kind: "tank", lat, s, w: 24, d: 24, h: 13, target: "fuel",
      }),
    ),
  );
  // Strike target: radar installation.
  structures.push({ id: "radar-base", kind: "radar", lat: 270, s: 300, w: 34, d: 34, h: 10, target: "radar" });
  structures.push({ id: "radar-mast", kind: "radar", lat: 270, s: 300, w: 9, d: 9, h: 34, target: "radar" });
  structures.push({ id: "bunker-hq", kind: "bunker", lat: 150, s: -390, w: 30, d: 20, h: 6 });
  [-740, -680, -620].forEach((s, i) =>
    structures.push({ id: `barracks-w${i}`, kind: "barracks", lat: 300, s, w: 16, d: 42, h: 7 }),
  );
  [640, 700, 760].forEach((s, i) =>
    structures.push({ id: `barracks-e${i}`, kind: "barracks", lat: 300, s, w: 16, d: 42, h: 7 }),
  );
  [-250, -190].forEach((s, i) =>
    structures.push({ id: `shed-${i}`, kind: "shed", lat: 290, s, w: 22, d: 46, h: 6 }),
  );
  return {
    base: BLACKRIDGE,
    structures,
    taxiways: [{ lat0: 59, lat1: 81, s0: -700, s1: 700 }],
    connectors: [
      ...[-690, -250, 300, 690].map((s) => ({ s, lat0: 20, lat1: 59, width: 24, flare: true })),
      ...[-69, -23, 23, 69].map((s) => ({ s, lat0: 81, lat1: 150, width: 16 })),
    ],
    aprons: [
      { lat0: 81, lat1: 171, s0: 430, s1: 590 },
      { lat0: 150, lat1: 160, s0: -90, s1: 90 },
    ],
    roads: [
      { lat0: 336, lat1: 346, s0: -800, s1: 800 },
      { lat0: 252, lat1: 336, s0: 296, s1: 304 },
      { lat0: 220, lat1: 336, s0: -454, s1: -446 },
    ],
    parking: [],
    floodlights: [
      { lat: 95, s: -255, h: 18 },
      { lat: 200, s: 440, h: 18 },
      { lat: 200, s: 580, h: 18 },
      { lat: 150, s: -110, h: 18 },
      { lat: 150, s: 110, h: 18 },
      { lat: 255, s: 262, h: 18 },
      { lat: 285, s: 338, h: 18 },
    ],
    fence: { lat0: -74, lat1: 378, s0: -915, s1: 915 },
    guardTowers: [
      { lat: -74, s: -915 },
      { lat: -74, s: 915 },
      { lat: 378, s: -915 },
      { lat: 378, s: 915 },
      { lat: 378, s: 0 },
    ],
    windsock: { lat: 40, s: 600 },
  };
})();

export const LAYOUTS: Record<string, BaseLayout> = {
  haven: HAVEN_LAYOUT,
  blackridge: BLACKRIDGE_LAYOUT,
};

/** Unit vectors of a runway frame in world x/z: forward is along takeoff, right is lat+. */
export function baseFrame(base: Base) {
  const f = { x: -Math.sin(base.runway.heading), z: -Math.cos(base.runway.heading) };
  return { f, r: { x: -f.z, z: f.x } };
}

/** Runway-frame (lat, s) to world x/z. */
export function toWorld(base: Base, lat: number, s: number) {
  const { f, r } = baseFrame(base);
  return { x: base.runway.x + r.x * lat + f.x * s, z: base.runway.z + r.z * lat + f.z * s };
}

/** Compass runway number (heading in tens of degrees) for the end at `reverse` ? far : near. */
export function runwayDesignator(base: Base, reverse = false) {
  const deg = ((((-base.runway.heading * 180) / Math.PI + (reverse ? 180 : 0)) % 360) + 360) % 360;
  const n = Math.round(deg / 10) || 36;
  return String(n > 36 ? n - 36 : n).padStart(2, "0");
}

export interface Collider {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

function buildColliders() {
  const out: Collider[] = [];
  for (const layout of Object.values(LAYOUTS)) {
    const { base } = layout;
    for (const st of layout.structures) {
      if (st.collide === false) continue;
      // Axis-aligned runways make these exact; other headings get a conservative box.
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const a of [-1, 1])
        for (const b of [-1, 1]) {
          const p = toWorld(base, st.lat + (a * st.w) / 2, st.s + (b * st.d) / 2);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
        }
      out.push({
        minX, maxX, minZ, maxZ,
        minY: base.runway.elevation - 1,
        maxY: base.runway.elevation + st.h,
      });
    }
  }
  return out;
}

/** Solid footprints of every base structure (world axes). Built once. */
const COLLIDERS = buildColliders();
export function structureColliders(): readonly Collider[] {
  return COLLIDERS;
}

// Whole-base bounds so a flight sweep far from either base costs one comparison.
const BOUNDS = BASES.map((b) => {
  const items = COLLIDERS.filter(
    (c) => Math.hypot((c.minX + c.maxX) / 2 - b.runway.x, (c.minZ + c.maxZ) / 2 - b.runway.z) < 1200,
  );
  return {
    minX: Math.min(...items.map((c) => c.minX)),
    maxX: Math.max(...items.map((c) => c.maxX)),
    minZ: Math.min(...items.map((c) => c.minZ)),
    maxZ: Math.max(...items.map((c) => c.maxZ)),
    items,
  };
});

/** True when a point is inside any base structure. */
export function insideStructure(x: number, y: number, z: number) {
  for (const b of BOUNDS) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    for (const c of b.items)
      if (x > c.minX && x < c.maxX && z > c.minZ && z < c.maxZ && y > c.minY && y < c.maxY)
        return true;
  }
  return false;
}
