/**
 * Shared layout for the two air bases and the air-defence network. World
 * code builds the bases from this, flight code starts every sortie on the
 * home runway, and combat code places SAM sites and enemy launches here.
 *
 * Headings follow Flight.yaw: 0 faces −Z (north), +π/2 faces −X (west).
 */
export type Side = "home" | "enemy";

export interface Runway {
  /** Centre of the runway surface. */
  x: number;
  z: number;
  /** Takeoff direction (yaw, radians). */
  heading: number;
  length: number;
  width: number;
  /** Height of the paved surface above sea level (terrain is flattened to it). */
  elevation: number;
}

export interface Base {
  id: string;
  name: string;
  side: Side;
  runway: Runway;
}

export const HAVEN: Base = {
  id: "haven",
  name: "Haven Air Base",
  side: "home",
  runway: { x: -900, z: 0, heading: 0, length: 1600, width: 45, elevation: 29 },
};

/** Across the strait, on the north coast behind the mountains. */
export const BLACKRIDGE: Base = {
  id: "blackridge",
  name: "Blackridge Air Base",
  side: "enemy",
  runway: { x: 0, z: -8350, heading: -Math.PI / 2, length: 1500, width: 40, elevation: 60 },
};

export const BASES = [HAVEN, BLACKRIDGE];

export interface StrikeTarget {
  id: string;
  name: string;
  kind: "radar" | "fuel" | "shelters";
  x: number;
  z: number;
}

/** Destroyable installations at Blackridge; the radar is the strike objective. */
export const BLACKRIDGE_TARGETS: StrikeTarget[] = [
  { id: "radar", name: "Blackridge radar", kind: "radar", x: 300, z: -8080 },
  { id: "fuel", name: "Fuel depot", kind: "fuel", x: -450, z: -8130 },
  { id: "shelters", name: "Aircraft shelters", kind: "shelters", x: 0, z: -8170 },
];

export type SamType = "shorad" | "mrsam";

export interface SamSite {
  id: string;
  type: SamType;
  x: number;
  z: number;
}

/**
 * Short-range IR launchers ring the enemy base; a medium-range radar-cued
 * battery sits on high ground. Forward sites cover the approach over the
 * northern island, so the low valleys are the way in.
 */
export const SAM_SITES: SamSite[] = [
  { id: "br-west", type: "shorad", x: -700, z: -8150 },
  { id: "br-east", type: "shorad", x: 700, z: -8550 },
  { id: "br-ridge", type: "mrsam", x: 0, z: -7900 },
  { id: "strait", type: "shorad", x: -1300, z: -3500 },
  { id: "spine", type: "mrsam", x: 0, z: -5000 },
  { id: "west-valley", type: "shorad", x: -1500, z: -6000 },
];

/** Start of the takeoff roll: the threshold end of a runway, pointing down it. */
export function runwayThreshold(runway: Runway, inset = 60) {
  const half = runway.length / 2 - inset;
  return {
    x: runway.x + Math.sin(runway.heading) * half,
    z: runway.z + Math.cos(runway.heading) * half,
    heading: runway.heading,
    elevation: runway.elevation,
  };
}
