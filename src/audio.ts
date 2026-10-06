export class FlightAudio {
  private context?: AudioContext;
  private oscillator?: OscillatorNode;
  private gain?: GainNode;
  private wind?: GainNode;
  enabled = true;
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
    }
    await this.context.resume();
  }
  update(speed: number, throttle: number, active: boolean) {
    if (!this.context || !this.gain || !this.oscillator || !this.wind) return;
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
