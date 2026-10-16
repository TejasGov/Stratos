/**
 * Holds the frame rate by trading resolution: drops the render scale quickly
 * when frames run sustainedly over budget, and creeps back up only after a
 * long run of comfortable frames. Changes are rate-limited because each one
 * reallocates the HDR targets.
 */
export class DynamicResolution {
  scale = 1;
  private slow = 0;
  private fast = 0;
  private cooldown = 3;
  constructor(
    readonly min = 0.55,
    readonly max = 1,
    /** Frame budget in milliseconds (just under 60 Hz). */
    readonly budget = 1000 / 58,
  ) {}
  /** Feeds one frame interval; returns true when the scale changed. */
  update(frameMs: number, dt: number) {
    if (!(frameMs > 0) || !(dt > 0)) return false;
    this.cooldown -= dt;
    if (frameMs > this.budget * 1.25) {
      this.slow += dt;
      this.fast = Math.max(0, this.fast - dt * 4);
    } else if (frameMs < this.budget * 1.05) {
      this.fast += dt;
      this.slow = Math.max(0, this.slow - dt);
    }
    if (this.cooldown > 0) return false;
    if (this.slow > 0.75 && this.scale > this.min) {
      this.scale = Math.max(this.min, Math.round((this.scale - 0.1) * 100) / 100);
      this.slow = this.fast = 0;
      this.cooldown = 2;
      return true;
    }
    if (this.fast > 6 && this.scale < this.max) {
      this.scale = Math.min(this.max, Math.round((this.scale + 0.05) * 100) / 100);
      this.slow = this.fast = 0;
      this.cooldown = 4;
      return true;
    }
    return false;
  }
  reset() {
    this.scale = this.max;
    this.slow = this.fast = 0;
    this.cooldown = 3;
  }
}
