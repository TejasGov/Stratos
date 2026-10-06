/** A bounded rolling sample; values are measurements, never hardware guarantees. */
export class FrameTelemetry {
  private samples = new Float32Array(240);
  private count = 0;
  private cursor = 0;
  private lastSummary = 0;
  median = 0;
  p95 = 0;
  record(milliseconds: number, elapsed: number) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
    this.samples[this.cursor] = milliseconds;
    this.cursor = (this.cursor + 1) % this.samples.length;
    this.count = Math.min(this.count + 1, this.samples.length);
    if (elapsed - this.lastSummary < 0.5) return;
    this.lastSummary = elapsed;
    const sorted = Array.from(this.samples.subarray(0, this.count)).sort(
      (a, b) => a - b,
    );
    this.median = sorted[Math.floor((this.count - 1) * 0.5)];
    this.p95 = sorted[Math.floor((this.count - 1) * 0.95)];
  }
  reset() {
    this.count = this.cursor = 0;
    this.median = this.p95 = this.lastSummary = 0;
  }
}
