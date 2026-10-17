import * as T from "three";

/**
 * The hangar. Every model is a Meshy text-to-3D generation normalised to a
 * 1.9-unit length with the nose toward −X, wings along Z and +Y up. Nozzle
 * exits and wingtips were measured from the meshes in those model units.
 */
export interface Airframe {
  id: string;
  name: string;
  generation: string;
  /** The real aircraft the design takes its cues from. */
  inspiredBy: string;
  role: string;
  file: string;
  /** Overall length in metres. */
  length: number;
  /** Nozzle exit centres [x, y, z] in model units. */
  nozzles: [number, number, number][];
  nozzleRadius: number;
  /** Starboard wingtip [x, y, z] in model units (mirrored for port). */
  tip: [number, number, number];
  performance: { thrust: number; afterburner: number; drag: number; agility: number };
  /** Twin-engine jets steer with differential thrust and can fly home on one engine. */
  engines: 1 | 2;
  /** Radar cross-section relative to a 4th-generation fighter (1); stealth shapes are far smaller. */
  rcs: number;
  /** 0..1 post-stall authority: 1 flies a full Pugachev's cobra, low values only a shallow pitch-up. */
  supermanoeuvre: number;
  thrustVectoring: boolean;
}

const MODEL_LENGTH = 1.9;

export const FLEET: Airframe[] = [
  {
    id: "sf35",
    name: "SF-35 Wraith",
    generation: "GEN 5",
    inspiredBy: "F-35 Lightning II",
    role: "Stealth multirole",
    file: "/assets/aircraft/stealth-fighter.glb",
    length: 16,
    nozzles: [[0.95, 0.012, 0]],
    nozzleRadius: 0.071,
    tip: [0.43, 0.006, 0.63],
    performance: { thrust: 1, afterburner: 1, drag: 1, agility: 1 },
    engines: 1,
    rcs: 0.15,
    supermanoeuvre: 0.45,
    thrustVectoring: false,
  },
  {
    id: "su57",
    name: "S-57 Vortex",
    generation: "GEN 5",
    inspiredBy: "Sukhoi Su-57",
    role: "Supermanoeuvrable air superiority",
    file: "/assets/aircraft/fleet/su57.glb",
    length: 20,
    nozzles: [
      [0.915, -0.074, 0.145],
      [0.915, -0.074, -0.145],
    ],
    nozzleRadius: 0.052,
    tip: [0.515, -0.154, 0.715],
    performance: { thrust: 1.1, afterburner: 1.1, drag: 1, agility: 1.2 },
    engines: 2,
    rcs: 0.35,
    supermanoeuvre: 1.0,
    thrustVectoring: true,
  },
  {
    id: "f22",
    name: "AF-22 Talon",
    generation: "GEN 5",
    inspiredBy: "Lockheed Martin F-22 Raptor",
    role: "Stealth air dominance · supercruise",
    file: "/assets/aircraft/fleet/f22.glb",
    length: 19,
    nozzles: [
      [0.885, -0.1, 0.077],
      [0.885, -0.1, -0.077],
    ],
    nozzleRadius: 0.05,
    tip: [0.42, -0.14, 0.67],
    performance: { thrust: 1.15, afterburner: 1.08, drag: 0.95, agility: 1.1 },
    engines: 2,
    rcs: 0.1,
    supermanoeuvre: 0.9,
    thrustVectoring: true,
  },
  {
    id: "j20",
    name: "J-20X Dragon",
    generation: "GEN 5",
    inspiredBy: "Chengdu J-20",
    role: "Long-range stealth interceptor",
    file: "/assets/aircraft/fleet/j20.glb",
    length: 21,
    nozzles: [
      [0.92, -0.072, 0.113],
      [0.92, -0.072, -0.113],
    ],
    nozzleRadius: 0.045,
    tip: [0.54, -0.074, 0.676],
    performance: { thrust: 1.05, afterburner: 1.12, drag: 0.92, agility: 0.9 },
    engines: 2,
    rcs: 0.3,
    supermanoeuvre: 0.55,
    thrustVectoring: false,
  },
  {
    id: "su30",
    name: "S-30 Monarch",
    generation: "GEN 4++",
    inspiredBy: "Sukhoi Su-30MKI",
    role: "Heavy twin-seat multirole · thrust vectoring",
    file: "/assets/aircraft/fleet/su30.glb",
    length: 22,
    nozzles: [
      [0.928, -0.104, 0.121],
      [0.928, -0.104, -0.121],
    ],
    nozzleRadius: 0.043,
    tip: [0.32, -0.094, 0.638],
    performance: { thrust: 1, afterburner: 1.05, drag: 1.08, agility: 1.25 },
    engines: 2,
    rcs: 1.0,
    supermanoeuvre: 1.0,
    thrustVectoring: true,
  },
  {
    id: "rafale",
    name: "R-4 Mistral",
    generation: "GEN 4.5",
    inspiredBy: "Dassault Rafale",
    role: "Canard-delta omnirole",
    file: "/assets/aircraft/fleet/rafale.glb",
    length: 15.3,
    nozzles: [[0.919, -0.066, 0]],
    nozzleRadius: 0.046,
    tip: [0.22, -0.08, 0.547],
    performance: { thrust: 0.98, afterburner: 1, drag: 0.98, agility: 1.12 },
    engines: 2,
    rcs: 0.55,
    supermanoeuvre: 0.6,
    thrustVectoring: false,
  },
  {
    id: "typhoon",
    name: "EF-2 Cyclone",
    generation: "GEN 4.5",
    inspiredBy: "Eurofighter Typhoon",
    role: "Canard-delta air superiority",
    file: "/assets/aircraft/fleet/typhoon.glb",
    length: 16,
    nozzles: [
      [0.802, -0.097, 0.051],
      [0.802, -0.097, -0.051],
    ],
    nozzleRadius: 0.044,
    tip: [0.325, -0.08, 0.682],
    performance: { thrust: 1.12, afterburner: 1.08, drag: 0.97, agility: 1.08 },
    engines: 2,
    rcs: 0.65,
    supermanoeuvre: 0.55,
    thrustVectoring: false,
  },
  {
    id: "tejas",
    name: "LC-1 Surya",
    generation: "GEN 4.5",
    inspiredBy: "HAL Tejas",
    role: "Light tailless-delta multirole",
    file: "/assets/aircraft/fleet/tejas.glb",
    length: 13.2,
    nozzles: [[0.806, -0.062, 0]],
    nozzleRadius: 0.065,
    tip: [0.47, -0.07, 0.556],
    performance: { thrust: 0.92, afterburner: 0.98, drag: 0.88, agility: 1.18 },
    engines: 1,
    rcs: 0.6,
    supermanoeuvre: 0.5,
    thrustVectoring: false,
  },
  {
    id: "mig21",
    name: "M-21 Arrow",
    generation: "GEN 3",
    inspiredBy: "Mikoyan-Gurevich MiG-21",
    role: "Cold War point-defence interceptor",
    file: "/assets/aircraft/fleet/mig21.glb",
    length: 14.7,
    nozzles: [[0.872, -0.122, 0]],
    nozzleRadius: 0.055,
    tip: [0.18, -0.13, 0.624],
    performance: { thrust: 0.9, afterburner: 1.06, drag: 0.86, agility: 0.82 },
    engines: 1,
    rcs: 1.0,
    supermanoeuvre: 0.3,
    thrustVectoring: false,
  },
];

export function airframe(id: string) {
  return FLEET.find((a) => a.id === id) ?? FLEET[0];
}

/** Model-to-aircraft-frame scale (metres per model unit). */
export function airframeScale(a: Airframe) {
  return a.length / MODEL_LENGTH;
}

/** Converts a model-space point to the aircraft frame (−Z forward, metres). */
export function airframePoint(a: Airframe, [x, y, z]: [number, number, number], out = new T.Vector3()) {
  const s = airframeScale(a);
  return out.set(-z * s, y * s, x * s);
}

/** Relative 1–10 ratings for the hangar card, spread across the fleet's range. */
export function airframeRatings(a: Airframe) {
  const p = a.performance;
  const rate = (v: number, lo: number, hi: number, min: number) =>
    Math.round(T.MathUtils.clamp(min + ((v - lo) / (hi - lo)) * (10 - min), 1, 10));
  return {
    speed: rate((p.afterburner * 0.6 + p.thrust * 0.4) / p.drag, 0.95, 1.19, 4),
    agility: rate(p.agility, 0.82, 1.25, 3),
    climb: rate((p.thrust + p.afterburner) / 2, 0.95, 1.12, 4),
  };
}
