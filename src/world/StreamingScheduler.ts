import { CHUNK } from "./terrain";
type XZ = { x: number; z: number };
export function terrainTargets(position: XZ, velocity: XZ = { x: 0, z: 0 }) {
  const cx = Math.floor(position.x / CHUNK),
    cz = Math.floor(position.z / CHUNK);
  const aheadX = position.x + velocity.x * 3,
    aheadZ = position.z + velocity.z * 3;
  const targets = [];
  for (let z = -4; z <= 4; z++)
    for (let x = -4; x <= 4; x++) {
      const tx = cx + x,
        tz = cz + z,
        ring = Math.max(Math.abs(x), Math.abs(z));
      const distance = Math.hypot(
        (tx + 0.5) * CHUNK - position.x,
        (tz + 0.5) * CHUNK - position.z,
      );
      const lookahead = Math.hypot(
        (tx + 0.5) * CHUNK - aheadX,
        (tz + 0.5) * CHUNK - aheadZ,
      );
      targets.push({
        x: tx,
        z: tz,
        segments: ring <= 1 ? 48 : ring <= 2 ? 24 : 12,
        priority:
          (ring === 0 ? -100000 : 0) + distance * 0.55 + lookahead * 0.45,
      });
    }
  return targets.sort((a, b) => a.priority - b.priority);
}

/** Tokens disambiguate replacement/retry replies with identical world chunk keys. */
export class RequestLedger {
  private next = 0;
  private entries = new Map<string, { id: number; started: number }>();
  get size() {
    return this.entries.size;
  }
  has(key: string) {
    return this.entries.has(key);
  }
  begin(key: string, now: number) {
    const id = ++this.next;
    this.entries.set(key, { id, started: now });
    return id;
  }
  finish(key: string, id: number) {
    if (this.entries.get(key)?.id !== id) return false;
    this.entries.delete(key);
    return true;
  }
  oldestAge(now: number) {
    let oldest = 0;
    for (const entry of this.entries.values())
      oldest = Math.max(oldest, now - entry.started);
    return oldest;
  }
  clear() {
    this.entries.clear();
  }
}
