export class FlightAudio {
  private context?: AudioContext;
  private oscillator?: OscillatorNode;
  private gain?: GainNode;
  private wind?: GainNode;
  private roar?: GainNode;
  private roarFilter?: BiquadFilterNode;
  private noise?: AudioBuffer;
  enabled = true;
  /** Sonic boom: a sharp double crack followed by a long rolling rumble. */
  boom() {
    if (!this.context || !this.enabled || !this.noise || this.context.state !== "running")
      return;
    const now = this.context.currentTime;
    for (const [delay, level] of [
      [0, 0.55],
      [0.11, 0.42],
    ]) {
      const source = this.context.createBufferSource();
      source.buffer = this.noise;
      const filter = this.context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(900, now + delay);
      filter.frequency.exponentialRampToValueAtTime(60, now + delay + 2.2);
      const gain = this.context.createGain();
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(level, now + delay + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 2.4);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.context.destination);
      source.start(now + delay, Math.random());
      source.stop(now + delay + 2.5);
      source.onended = () => {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    }
    const thump = this.context.createOscillator();
    const gain = this.context.createGain();
    thump.frequency.setValueAtTime(70, now);
    thump.frequency.exponentialRampToValueAtTime(28, now + 1.2);
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
    thump.connect(gain);
    gain.connect(this.context.destination);
    thump.start(now);
    thump.stop(now + 1.5);
    thump.onended = () => {
      thump.disconnect();
      gain.disconnect();
    };
  }
  cue(kind: "gun" | "missile" | "lock" | "warning" | "explosion") {
    if (!this.context || !this.enabled || this.context.state !== "running")
      return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const now = this.context.currentTime;
    const duration =
      kind === "explosion" ? 0.55 : kind === "missile" ? 0.22 : 0.09;
    oscillator.type =
      kind === "gun" || kind === "explosion" ? "sawtooth" : "sine";
    const frequency =
      kind === "lock"
        ? 900
        : kind === "warning"
          ? 550
          : kind === "missile"
            ? 350
            : 100;
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(
      kind === "explosion" ? 25 : frequency * 0.7,
      now + duration,
    );
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(
      kind === "explosion" ? 0.07 : 0.035,
      now + 0.01,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(this.context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }
  async start() {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.context.destination);
      this.oscillator = this.context.createOscillator();
      this.oscillator.type = "sawtooth";
      const filter = this.context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 180;
      this.oscillator.connect(filter);
      filter.connect(this.gain);
      this.oscillator.start();
      const buffer = this.context.createBuffer(
          1,
          this.context.sampleRate * 2,
          this.context.sampleRate,
        ),
        data = buffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < data.length; i++) {
        last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        data[i] = last * 3;
      }
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      this.wind = this.context.createGain();
      this.wind.gain.value = 0;
      source.connect(this.wind);
      this.wind.connect(this.context.destination);
      source.start();
      // White noise shared by the afterburner roar and the sonic boom.
      this.noise = this.context.createBuffer(1, this.context.sampleRate * 3, this.context.sampleRate);
      const white = this.noise.getChannelData(0);
      for (let i = 0; i < white.length; i++) white[i] = Math.random() * 2 - 1;
      const roarSource = this.context.createBufferSource();
      roarSource.buffer = this.noise;
      roarSource.loop = true;
      this.roarFilter = this.context.createBiquadFilter();
      this.roarFilter.type = "lowpass";
      this.roarFilter.frequency.value = 400;
      this.roar = this.context.createGain();
      this.roar.gain.value = 0;
      roarSource.connect(this.roarFilter);
      this.roarFilter.connect(this.roar);
      this.roar.connect(this.context.destination);
      roarSource.start();
    }
    await this.context.resume();
  }
  update(
    speed: number,
    throttle: number,
    active: boolean,
    boost = false,
    mach = 0,
  ) {
    if (!this.context || !this.gain || !this.oscillator || !this.wind) return;
    const on = active && this.enabled;
    if (this.roar && this.roarFilter) {
      this.roar.gain.setTargetAtTime(on && boost ? 0.09 : 0, this.context.currentTime, 0.25);
      // Past Mach 1 the engine noise trails behind the aircraft: muffle it.
      this.roarFilter.frequency.setTargetAtTime(mach > 1 ? 160 : 520, this.context.currentTime, 0.4);
    }
    const t = this.context.currentTime;
    this.oscillator.frequency.setTargetAtTime(
      36 + throttle * 40 + speed * 0.12,
      t,
      0.15,
    );
    this.gain.gain.setTargetAtTime(
      active && this.enabled ? 0.018 + throttle * 0.022 : 0,
      t,
      0.15,
    );
    this.wind.gain.setTargetAtTime(
      active && this.enabled ? Math.min(0.28, speed / 1200) : 0,
      t,
      0.2,
    );
  }
}
