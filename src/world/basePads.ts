import { BLACKRIDGE, HAVEN, type Base } from "./bases";

/**
 * Graded ground under an air base: a flat rounded rectangle at the runway
 * elevation, a blend skirt that merges it into the natural relief, and a
 * clearance funnel that lowers terrain rising too steeply off the runway ends
 * (and the flanks), so every sortie can really take off and land.
 *
 * terrain.ts (CPU) and terrainGlsl.ts (GPU) both evaluate these same numbers.
 */
export interface Pad {
  x: number;
  z: number;
  /** Half extents of the flat core along world x and z. */
  hx: number;
  hz: number;
  /** Ground height. Paving sits just above it, so no z-fighting at range. */
  height: number;
  /** Width of the skirt that blends the pad into the surrounding relief. */
  blend: number;
  /** Maximum rise per metre moving off the core along x and along z. */
  slopeX: number;
  slopeZ: number;
}

/** Ground is a hair under the paved surface; polygon offset hides the gap. */
export const GROUND_DROP = 0.25;

/** Distance outside the clearance funnel's influence is faded to nothing. */
export const FUNNEL_NEAR = 2600;
export const FUNNEL_FAR = 4200;

function padFor(base: Base, pad: Omit<Pad, "x" | "z" | "height">): Pad {
  return {
    x: base.runway.x,
    z: base.runway.z,
    height: base.runway.elevation - GROUND_DROP,
    ...pad,
  };
}

export const PADS: Pad[] = [
  // Runway runs north–south; hangars and apron on the east, barracks west.
  {
    ...padFor(HAVEN, { hx: 365, hz: 900, blend: 220, slopeX: 0.5, slopeZ: 0.065 }),
    x: HAVEN.runway.x + 35,
  },
  // Runway runs east–west on a coastal bluff; the base spreads inland (south).
  {
    ...padFor(BLACKRIDGE, { hx: 950, hz: 240, blend: 260, slopeX: 0.065, slopeZ: 0.6 }),
    z: BLACKRIDGE.runway.z + 150,
  },
];
