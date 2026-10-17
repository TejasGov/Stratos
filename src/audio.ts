/**
 * Recorded layers (ElevenLabs sound effects); each falls back to synthesis
 * until loaded. Loops are WAV because MP3 encoder padding breaks gapless looping.
 */
const SAMPLE_FILES = {
  engine: "/assets/audio/engine.wav",
  afterburner: "/assets/audio/afterburner.wav",
  wind: "/assets/audio/wind.wav",
  rain: "/assets/audio/rain.wav",
  boom: "/assets/audio/sonic-boom.mp3",
  thunderNear: "/assets/audio/thunder-near.mp3",
  thunderFar: "/assets/audio/thunder-far.mp3",
  cannon: "/assets/audio/cannon.wav",
  missile: "/assets/audio/missile.mp3",
  explosion: "/assets/audio/explosion.mp3",
} as const;
type Sample = keyof typeof SAMPLE_FILES;
type LoopName = "engine" | "afterburner" | "wind" | "rain";

interface Loop {
  source: AudioBufferSourceNode;
  gain: GainNode;
  filter: BiquadFilterNode;
}

export class FlightAudio {
  private context?: AudioContext;
  /** Everything routes through here, so muting also silences scheduled thunder. */
  private master?: GainNode;
  private oscillator?: OscillatorNode;
  private gain?: GainNode;
  private wind?: GainNode;
  private roar?: GainNode;
  private roarFilter?: BiquadFilterNode;
  private noise?: AudioBuffer;
  /** Radio static: hiss with sparse crackle, looped under transmissions. */
  private crackle?: AudioBuffer;
  private samples = new Map<Sample, AudioBuffer>();
  private loops: Partial<Record<LoopName, Loop>> = {};
  private gun?: { source: AudioBufferSourceNode; gain: GainNode };
  private lastGun = 0;
  private radioInput?: AudioNode;
  /** Warning-receiver tracking tone: one oscillator kept alive, gated by gain. */
  private rwrTrack?: { oscillator: OscillatorNode; gain: GainNode };
  /** 0..1: lowers the engine and wind beds while someone is talking. */
  duck = 0;
  enabled = true;
  /** Sonic boom: a sharp double crack followed by a long rolling rumble. */
  boom() {
    if (!this.ready()) return;
    if (this.play("boom", 0.9)) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    for (const [delay, level] of [
      [0, 0.55],
      [0.11, 0.42],
    ]) {
      const source = ctx.createBufferSource();
      source.buffer = this.noise!;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(900, now + delay);
      filter.frequency.exponentialRampToValueAtTime(60, now + delay + 2.2);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(level, now + delay + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 2.4);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master!);
      source.start(now + delay, Math.random());
      source.stop(now + delay + 2.5);
      source.onended = () => {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    }
    const thump = ctx.createOscillator();
    const gain = ctx.createGain();
    thump.frequency.setValueAtTime(70, now);
    thump.frequency.exponentialRampToValueAtTime(28, now + 1.2);
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
    thump.connect(gain);
    gain.connect(this.master!);
    thump.start(now);
    thump.stop(now + 1.5);
    thump.onended = () => {
      thump.disconnect();
      gain.disconnect();
    };
  }
  /**
   * Thunder from a strike `distance` metres away, arriving at the speed of
   * sound: a sharp crack when close, otherwise a long low roll.
   */
  thunder(distance: number, power = 1) {
    if (!this.ready()) return;
    const ctx = this.context!;
    const start = ctx.currentTime + distance / 343;
    const near = 1 - Math.min(1, distance / 4000);
    const level = Math.min(0.5, (0.9 * power) / (1 + distance / 1500));
    if (level < 0.01) return;
    const sample = distance < 3500 ? "thunderNear" : "thunderFar";
    // Air absorbs high frequencies: the further away, the darker the roll.
    if (this.play(sample, level * 1.6, { at: start, cutoff: 600 + near * 9000, rate: 0.9 + Math.random() * 0.2 }))
      return;
    const duration = 2.5 + Math.min(6, distance / 3000) + Math.random() * 1.5;
    // Several overlapping rolls: sound from different parts of the channel.
    const rolls = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < rolls; i++) {
      const at = start + (i === 0 ? 0 : Math.random() * duration * 0.5);
      const source = ctx.createBufferSource();
      source.buffer = this.noise!;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      const cutoff = i === 0 ? 180 + near * 2400 : 90 + near * 300;
      filter.frequency.setValueAtTime(cutoff, at);
      filter.frequency.exponentialRampToValueAtTime(45, at + duration);
      const gain = ctx.createGain();
      const peak = level * (i === 0 ? 1 : 0.4 + Math.random() * 0.5);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(peak, at + (i === 0 ? 0.02 + (1 - near) * 0.4 : 0.3));
      gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master!);
      source.loop = true;
      source.start(at, Math.random() * 2);
      source.stop(at + duration + 0.1);
      source.onended = () => {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
    }
  }
  /** Warning receiver: a search radar's beam sweeping over the jet — one short ping. */
  rwrPing() {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const tone = ctx.createOscillator();
    tone.type = "sine";
    tone.frequency.setValueAtTime(1350, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.03, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    tone.connect(gain);
    gain.connect(this.master!);
    tone.start(now);
    tone.stop(now + 0.12);
    tone.onended = () => {
      tone.disconnect();
      gain.disconnect();
    };
  }
  /** Warning receiver: steady tone while any threat holds a track on the jet. */
  rwrTone(on: boolean) {
    if (!this.context || !this.master) return;
    const ctx = this.context;
    const t = ctx.currentTime;
    if (!this.rwrTrack) {
      if (!on || !this.ready()) return;
      const oscillator = ctx.createOscillator();
      oscillator.type = "square";
      oscillator.frequency.value = 980;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 2400;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      oscillator.start();
      this.rwrTrack = { oscillator, gain };
    }
    this.rwrTrack.gain.gain.setTargetAtTime(
      on && this.enabled ? 0.012 : 0,
      t,
      0.03,
    );
  }
  /** Warning receiver: rapid warble on a missile launch at the jet. */
  rwrLaunch() {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    const duration = 1.1;
    const tone = ctx.createOscillator();
    tone.type = "triangle";
    tone.frequency.setValueAtTime(1150, now);
    // A fast LFO sweeps the pitch: the unmistakable launch warble.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 16;
    const depth = ctx.createGain();
    depth.gain.value = 320;
    lfo.connect(depth);
    depth.connect(tone.frequency);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.05, now + 0.02);
    gain.gain.setValueAtTime(0.05, now + duration - 0.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    tone.connect(gain);
    gain.connect(this.master!);
    tone.start(now);
    lfo.start(now);
    tone.stop(now + duration);
    lfo.stop(now + duration);
    tone.onended = () => {
      tone.disconnect();
      lfo.disconnect();
      depth.disconnect();
      gain.disconnect();
    };
  }
  /** Ground-proximity alarm: the jet's own two rising "whoops". */
  terrainAlarm() {
    if (!this.ready()) return;
    const ctx = this.context!;
    const now = ctx.currentTime;
    for (const delay of [0, 0.42]) {
      const at = now + delay;
      const tone = ctx.createOscillator();
      tone.type = "triangle";
      tone.frequency.setValueAtTime(380, at);
      tone.frequency.exponentialRampToValueAtTime(1150, at + 0.32);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.06, at + 0.03);
      gain.gain.setValueAtTime(0.06, at + 0.28);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.36);
      tone.connect(gain);
      gain.connect(this.master!);
      tone.start(at);
      tone.stop(at + 0.38);
      tone.onended = () => {
        tone.disconnect();
        gain.disconnect();
      };
    }
  }
  cue(kind: "gun" | "missile" | "lock" | "warning" | "explosion" | "flare") {
    if (!this.ready()) return;
    if (kind === "flare") return this.flares();
    const ctx = this.context!;
    if (kind === "gun" && this.samples.has("cannon")) {
      this.holdGun();
      return;
    }
    if (kind === "missile" && this.play("missile", 0.55)) return;
    if (kind === "explosion" && this.play("explosion", 0.7, { rate: 0.9 + Math.random() * 0.2 })) return;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
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
    gain.connect(this.master!);
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
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(this.master);
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
      this.wind.connect(this.master);
      source.start();
      // White noise shared by the synthesized roar, boom and thunder fallbacks.
      this.noise = this.context.createBuffer(1, this.context.sampleRate * 3, this.context.sampleRate);
      const white = this.noise.getChannelData(0);
      for (let i = 0; i < white.length; i++) white[i] = Math.random() * 2 - 1;
      const rate = this.context.sampleRate;
      this.crackle = this.context.createBuffer(1, rate * 4, rate);
      const crackle = this.crackle.getChannelData(0);
      let pop = 0,
        popLevel = 0;
      for (let i = 0; i < crackle.length; i++) {
        if (pop <= 0 && Math.random() < 35 / rate) {
          pop = rate * (0.002 + Math.random() * 0.012);
          popLevel = 0.4 + Math.random() * 0.7;
        }
        pop--;
        popLevel *= 0.9992;
        // The hiss breathes three times per loop so the seam never shows.
        const breath = 0.8 + 0.2 * Math.sin((i / crackle.length) * Math.PI * 6);
        crackle[i] =
          (0.3 * breath + (pop > 0 ? popLevel : 0)) * (Math.random() * 2 - 1);
      }
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
      this.roar.connect(this.master);
      roarSource.start();
      this.loadSamples();
    }
    await this.context.resume();
  }
  /** Decodes an audio file with this context (voice lines, extra layers). */
  async decode(url: string) {
    if (!this.context) return undefined;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return this.context.decodeAudioData(await response.arrayBuffer());
  }
  /**
   * Radio voice chain: band-limited to the 300 Hz–3.4 kHz of a comms channel,
   * lightly saturated, with a touch of presence. Created on first use.
   */
  radio() {
    if (!this.context || !this.master) return undefined;
    if (!this.radioInput) {
      const ctx = this.context;
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 320;
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 3400;
      const presence = ctx.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = 1800;
      presence.gain.value = 4;
      const drive = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2);
      }
      drive.curve = curve;
      const gain = ctx.createGain();
      gain.gain.value = 0.85;
      highpass.connect(lowpass);
      lowpass.connect(presence);
      presence.connect(drive);
      drive.connect(gain);
      gain.connect(this.master);
      this.radioInput = highpass;
    }
    return { context: this.context, input: this.radioInput };
  }
  /**
   * Opens the channel for one transmission starting at `at`: carrier hiss
   * under the voice and, with `interference` (0..1), moments where the
   * signal breaks up. Returns the node the voice plugs into.
   */
  transmission(at: number, duration: number, interference: number) {
    const radio = this.radio();
    if (!radio || !this.crackle) return undefined;
    const ctx = radio.context;
    const voice = ctx.createGain();
    // Radios ride the voice hard, so quiet words still clear the static.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -34;
    compressor.knee.value = 8;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.2;
    voice.connect(compressor);
    compressor.connect(radio.input);
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.crackle;
    hiss.loop = true;
    const carrier = ctx.createGain();
    const level = 0.04 + 0.1 * interference;
    carrier.gain.setValueAtTime(0, at - 0.06);
    carrier.gain.linearRampToValueAtTime(level, at);
    hiss.connect(carrier);
    carrier.connect(radio.input);
    hiss.start(at - 0.06, Math.random() * this.crackle.duration);
    // Dropouts: the voice cuts under a burst of static, sometimes twice.
    // The closing words are left alone; that is usually where the point is.
    const count =
      Math.floor(Math.random() * interference * 3) + (Math.random() < interference ? 1 : 0);
    const times = Array.from({ length: duration > 2 ? count : 0 }, () =>
      at + 0.5 + Math.random() * (duration * 0.7 - 0.5),
    ).sort((a, b) => a - b);
    let free = 0;
    for (const time of times) {
      if (time < free) continue;
      let t = time;
      for (let cut = Math.random() < 0.4 ? 2 : 1; cut > 0; cut--) {
        const length = 0.04 + Math.random() * 0.09;
        voice.gain.setValueAtTime(1, t);
        voice.gain.linearRampToValueAtTime(0.05, t + 0.01);
        voice.gain.setValueAtTime(0.05, t + length);
        voice.gain.linearRampToValueAtTime(1, t + length + 0.015);
        carrier.gain.setValueAtTime(level, t);
        carrier.gain.linearRampToValueAtTime(Math.min(0.6, level * 4), t + 0.008);
        carrier.gain.setValueAtTime(Math.min(0.6, level * 4), t + length);
        carrier.gain.linearRampToValueAtTime(level, t + length + 0.02);
        t += length + 0.05 + Math.random() * 0.05;
      }
      free = t + 0.4;
    }
    let open = true;
    return {
      input: voice as AudioNode,
      /** Drops the carrier; call when the voice ends or is cut off. */
      close() {
        if (!open) return;
        open = false;
        const now = ctx.currentTime;
        voice.gain.cancelScheduledValues(now);
        carrier.gain.cancelScheduledValues(now);
        carrier.gain.setTargetAtTime(0, now, 0.025);
        hiss.stop(now + 0.2);
        hiss.onended = () => {
          hiss.disconnect();
          carrier.disconnect();
          voice.disconnect();
          compressor.disconnect();
        };
      },
    };
  }
  /** Push-to-talk click: a short burst of band-limited static. */
  squelch(at: number, level = 0.25) {
    const radio = this.radio();
    if (!radio || !this.noise) return;
    const ctx = radio.context;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.09);
    source.connect(gain);
    gain.connect(radio.input);
    source.start(at, Math.random() * 2);
    source.stop(at + 0.1);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
  }
  /** Countermeasure salvo: a dispenser thump per cartridge, then the magnesium fizz. */
  private flares() {
    const ctx = this.context!;
    const now = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const at = now + i * 0.1 + Math.random() * 0.025;
      const end = at + 1.1 + Math.random() * 0.4;
      const pop = ctx.createBufferSource();
      pop.buffer = this.noise!;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 700 + Math.random() * 600;
      band.Q.value = 0.9;
      const popGain = ctx.createGain();
      popGain.gain.setValueAtTime(0.0001, at);
      popGain.gain.exponentialRampToValueAtTime(0.35, at + 0.003);
      popGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
      const thump = ctx.createOscillator();
      thump.frequency.setValueAtTime(120, at);
      thump.frequency.exponentialRampToValueAtTime(40, at + 0.12);
      const thumpGain = ctx.createGain();
      thumpGain.gain.setValueAtTime(0.0001, at);
      thumpGain.gain.exponentialRampToValueAtTime(0.22, at + 0.004);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      // The flare lights and sputters as it falls away behind the jet.
      const fizz = ctx.createBufferSource();
      fizz.buffer = this.noise!;
      fizz.loop = true;
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.setValueAtTime(3200, at);
      highpass.frequency.exponentialRampToValueAtTime(1100, end);
      const fizzGain = ctx.createGain();
      fizzGain.gain.setValueAtTime(0, at);
      for (let t = at + 0.05; t < end; t += 0.025 + Math.random() * 0.03) {
        const fade = 1 - (t - at) / (end - at);
        fizzGain.gain.linearRampToValueAtTime(0.16 * fade * (0.4 + Math.random() * 0.6), t);
      }
      fizzGain.gain.linearRampToValueAtTime(0, end + 0.05);
      pop.connect(band);
      band.connect(popGain);
      popGain.connect(this.master!);
      thump.connect(thumpGain);
      thumpGain.connect(this.master!);
      fizz.connect(highpass);
      highpass.connect(fizzGain);
      fizzGain.connect(this.master!);
      pop.start(at, Math.random() * 2, 0.12);
      thump.start(at);
      thump.stop(at + 0.16);
      fizz.start(at, Math.random() * 2);
      fizz.stop(end + 0.1);
      fizz.onended = () => {
        for (const node of [pop, band, popGain, thump, thumpGain, fizz, highpass, fizzGain])
          node.disconnect();
      };
    }
  }
  /** Fetches and decodes the recorded layers in the background. */
  private loadSamples() {
    const ctx = this.context!;
    for (const [name, url] of Object.entries(SAMPLE_FILES) as [Sample, string][])
      fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(response.status)))
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => {
          this.samples.set(name, buffer);
          if (name === "engine" || name === "afterburner" || name === "wind" || name === "rain")
            this.startLoop(name, buffer);
        })
        .catch(() => {
          // Keep the synthesized layer for this sound.
        });
  }
  private startLoop(name: LoopName, buffer: AudioBuffer) {
    const ctx = this.context!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 20000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    // Random phase so layers that share a length do not beat against each other.
    source.start(0, Math.random() * buffer.duration);
    this.loops[name] = { source, gain, filter };
  }
  private ready() {
    return !!this.context && this.enabled && !!this.master && this.context.state === "running";
  }
  /** One-shot of a recorded layer; returns false when it has not loaded. */
  private play(
    name: Sample,
    level: number,
    options: { at?: number; cutoff?: number; rate?: number } = {},
  ) {
    const buffer = this.samples.get(name);
    if (!buffer) return false;
    const ctx = this.context!;
    const at = options.at ?? ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = options.rate ?? 1;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = options.cutoff ?? 20000;
    const gain = ctx.createGain();
    gain.gain.value = level;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    source.start(at);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    return true;
  }
  /** The cannon loops while rounds keep coming and fades out shortly after. */
  private holdGun() {
    const ctx = this.context!;
    this.lastGun = ctx.currentTime;
    if (this.gun) return;
    const buffer = this.samples.get("cannon")!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // The asset is the sustained middle of a burst, crossfaded into a loop.
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0.32;
    source.connect(gain);
    gain.connect(this.master!);
    source.start();
    this.gun = { source, gain };
  }
  update(
    speed: number,
    throttle: number,
    active: boolean,
    boost = false,
    mach = 0,
    rain = 0,
  ) {
    if (!this.context || !this.gain || !this.oscillator || !this.wind || !this.master) return;
    const t = this.context.currentTime;
    this.master.gain.setTargetAtTime(this.enabled ? 1 : 0, t, 0.05);
    const on = active && this.enabled;
    if (this.gun && t - this.lastGun > 0.12) {
      const { source, gain } = this.gun;
      gain.gain.setTargetAtTime(0, t, 0.03);
      source.stop(t + 0.2);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
      };
      this.gun = undefined;
    }
    // Past Mach 1 the engine noise trails behind the aircraft: muffle it.
    const muffle = mach > 1 ? 1 : 0;
    const bed = 1 - 0.5 * this.duck;
    const { engine, afterburner, wind: windLoop, rain: rainLoop } = this.loops;
    if (engine) {
      engine.gain.gain.setTargetAtTime(on ? (0.16 + throttle * 0.22) * bed : 0, t, 0.2);
      engine.source.playbackRate.setTargetAtTime(0.82 + throttle * 0.3 + Math.min(speed, 700) / 2800, t, 0.3);
      engine.filter.frequency.setTargetAtTime(muffle ? 700 : 9000, t, 0.4);
      this.gain.gain.setTargetAtTime(0, t, 0.1);
    } else
      this.gain.gain.setTargetAtTime(on ? 0.018 + throttle * 0.022 : 0, t, 0.15);
    this.oscillator.frequency.setTargetAtTime(36 + throttle * 40 + speed * 0.12, t, 0.15);
    if (afterburner) {
      afterburner.gain.gain.setTargetAtTime(on && boost ? 0.42 * bed : 0, t, 0.25);
      afterburner.filter.frequency.setTargetAtTime(muffle ? 500 : 12000, t, 0.4);
      this.roar?.gain.setTargetAtTime(0, t, 0.1);
    } else if (this.roar && this.roarFilter) {
      this.roar.gain.setTargetAtTime(on && boost ? 0.09 : 0, t, 0.25);
      this.roarFilter.frequency.setTargetAtTime(muffle ? 160 : 520, t, 0.4);
    }
    if (windLoop) {
      windLoop.gain.gain.setTargetAtTime(on ? Math.min(0.42, speed / 1300) * bed : 0, t, 0.2);
      windLoop.source.playbackRate.setTargetAtTime(0.75 + Math.min(speed, 700) / 1400, t, 0.3);
      this.wind.gain.setTargetAtTime(0, t, 0.1);
    } else this.wind.gain.setTargetAtTime(on ? Math.min(0.28, speed / 1200) : 0, t, 0.2);
    rainLoop?.gain.gain.setTargetAtTime(on ? rain * 0.5 : 0, t, 0.4);
  }
}
