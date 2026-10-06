import { Vector3 } from "three";
import { heightAt } from "./world/terrain";
export const landmarks = [
  {
    id: "haven",
    name: "Haven airfield",
    x: -900,
    z: 0,
    detail: "The beginning of every expedition",
  },
  {
    id: "crown",
    name: "The Crown",
    x: 300,
    z: -1100,
    detail: "Above the island spine",
  },
  {
    id: "east",
    name: "Azure coast",
    x: 2100,
    z: -500,
    detail: "Where the mountains meet the sea",
  },
  {
    id: "north",
    name: "Northwatch",
    x: 600,
    z: -6200,
    detail: "A new horizon beyond the strait",
  },
  {
    id: "west",
    name: "Solstice island",
    x: -6100,
    z: 300,
    detail: "A quiet outpost in open water",
  },
];
export const routes = {
  skyline: {
    name: "Skyline circuit",
    description: "Six gates. One perfect line.",
    limit: 150,
    low: false,
    points: [
      [0, 2200],
      [0, 1200],
      [-700, 400],
      [-1800, -300],
      [-2700, 700],
      [-1700, 1800],
    ],
  },
  coast: {
    name: "Coastal run",
    description: "Stay below 350 m above the terrain.",
    limit: 180,
    low: true,
    points: [
      [2200, 2200],
      [2600, 1300],
      [2900, 200],
      [2800, -900],
      [2200, -1800],
      [1300, -2400],
    ],
  },
};
export type RouteId = keyof typeof routes;
export class Mission {
  active: RouteId | null = null;
  index = 0;
  time = 0;
  penalty = 0;
  completed = false;
  discovered = new Set<string>();
  best: Partial<Record<RouteId, number>> = {};
  start(id: RouteId) {
    this.active = id;
    this.index = 0;
    this.time = 0;
    this.penalty = 0;
    this.completed = false;
  }
  stop() {
    this.active = null;
    this.completed = false;
  }
  gate(index = this.index) {
    if (!this.active) return null;
    const route = routes[this.active],
      p = route.points[index];
    return p
      ? new Vector3(
          p[0],
          Math.max(0, heightAt(p[0], p[1])) + (route.low ? 220 : 600),
          p[1],
        )
      : null;
  }
  update(dt: number, from: Vector3, position: Vector3): string | null {
    if (!this.active || this.completed) return null;
    this.time += dt;
    const route = routes[this.active];
    if (
      route.low &&
      position.y - Math.max(0, heightAt(position.x, position.z)) > 350
    )
      this.penalty += dt;
    if (this.time > route.limit) {
      this.active = null;
      return "Time expired · Try the route again";
    }
    const gate = this.gate()!;
    const delta = position.clone().sub(from),
      lengthSq = delta.lengthSq();
    const t = lengthSq
      ? Math.max(0, Math.min(1, gate.clone().sub(from).dot(delta) / lengthSq))
      : 0;
    const nearest = from.clone().addScaledVector(delta, t);
    if (nearest.distanceTo(gate) < 135) {
      this.index++;
      if (this.index === route.points.length) {
        this.completed = true;
        const score = this.time + this.penalty;
        this.best[this.active] = Math.min(
          this.best[this.active] ?? Infinity,
          score,
        );
        return `Route complete · ${score.toFixed(1)}s${this.penalty > 1 ? " including altitude penalty" : ""}`;
      }
      return `Gate ${this.index} / ${route.points.length} · Keep your line`;
    }
    return null;
  }
}
