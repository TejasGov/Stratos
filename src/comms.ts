import type { FlightAudio } from "./audio";

/**
 * Haven Control: the officer on the radio. Lines were voiced with ElevenLabs
 * (see public/assets/voice/README.md); the text below is the subtitle.
 */
export const LINES = {
  takeoff: {
    text: "Kestrel, Haven Control. You're off the deck and the sky's all yours. Try to bring the jet back in one piece this time.",
    priority: 1,
    cooldown: 60,
  },
  ascent: {
    text: "Kestrel, you're cleared for the climb. Full burner, nose up, and don't stop until the sky goes black. I've got the stopwatch running.",
    priority: 1,
    cooldown: 30,
  },
  tropopause: {
    text: "Passing the tropopause. Air's getting thin up there, Kestrel. She'll feel light on the stick, so keep it smooth.",
    priority: 1,
    cooldown: 120,
  },
  stratosphere: {
    text: "Twenty thousand meters. Nobody in this squadron's been that high all year. Keep going.",
    priority: 1,
    cooldown: 120,
  },
  edge: {
    text: "Thirty thousand. Kestrel, take a second and look outside. That's the curve of the world. Beautiful flying.",
    priority: 2,
    cooldown: 120,
  },
  machOne: {
    text: "Ha! There's the boom! We heard that one all the way down here. Mach one, Kestrel!",
    priority: 1,
    cooldown: 180,
  },
  intercept: {
    text: "Kestrel, three bandits inbound from the north, low and fast. You're weapons free. Stop them before they reach the coast.",
    priority: 2,
    cooldown: 20,
  },
  escort: {
    text: "Transport's wheels up. Stay on her wing, Kestrel. She can't take a hit, and she's got people aboard. Nobody touches her.",
    priority: 2,
    cooldown: 20,
  },
  strike: {
    text: "There's a radar site on the coast, and it's got fighters watching over it. Take out that dish, Kestrel, and their whole coastline goes dark.",
    priority: 2,
    cooldown: 20,
  },
  missile: {
    text: "Missile, missile! Break hard, Kestrel! Flares, now!",
    priority: 4,
    cooldown: 7,
  },
  firstKill: {
    text: "Splash one! Good kill, Kestrel!",
    priority: 2,
    cooldown: 4,
  },
  kill: {
    text: "That's another one down. Stay sharp, they're regrouping.",
    priority: 2,
    cooldown: 4,
  },
  clear: {
    text: "Airspace is clear. Nicely done, Kestrel. Take a breath, and then bring it home.",
    priority: 3,
    cooldown: 10,
  },
  escortLost: {
    text: "We lost the transport… Disengage, Kestrel. Come home.",
    priority: 3,
    cooldown: 10,
  },
  damaged: {
    text: "Kestrel, you're trailing smoke. Ease off and get clear. That's not a request.",
    priority: 3,
    cooldown: 45,
  },
  crash: {
    text: "Kestrel? Kestrel, Haven Control, respond… We've lost contact.",
    priority: 5,
    cooldown: 5,
  },
  landmark: {
    text: "Oh, that's a new one. Logging it on the map.",
    priority: 1,
    cooldown: 20,
  },
  routeStart: {
    text: "Gates are lit. One clean line, Kestrel, and the clock starts at the first gate. No pressure.",
    priority: 2,
    cooldown: 20,
  },
  routeDone: {
    text: "That's a new time on the board. Not bad at all, Kestrel.",
    priority: 2,
    cooldown: 10,
  },
} as const;
export type Line = keyof typeof LINES;

export const voiceFile = (line: Line) =>
  `/assets/voice/${line.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}.mp3`;

/**
 * Radio traffic from Haven Control: one voice at a time through the comms
 * chain, urgent calls cutting in over chatter, with subtitles and the engine
 * ducked underneath.
 */
export class Comms {
  enabled = true;
  /** Shows (text) or hides (null) the subtitle. */
  onSubtitle?: (text: string | null) => void;
  private buffers = new Map<Line, Promise<AudioBuffer | undefined>>();
  private current?: { line: Line; source: AudioBufferSourceNode };
  private queue: Line[] = [];
  private last = new Map<Line, number>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** Bumped by clear() so a line still decoding cannot start afterwards. */
  private epoch = 0;
  private held = false;
  constructor(private audio: FlightAudio) {}
  /** Starts fetching every line once audio is running. */
  preload() {
    for (const line of Object.keys(LINES) as Line[]) this.load(line);
  }
  private load(line: Line) {
    let buffer = this.buffers.get(line);
    if (!buffer) {
      buffer = this.audio.decode(voiceFile(line)).catch(() => undefined);
      this.buffers.set(line, buffer);
      // Audio not started yet or the fetch failed: try again next time.
      buffer.then((b) => b || this.buffers.delete(line));
    }
    return buffer;
  }
  /** Queues a call; `delay` (s) lets it land after a transition. */
  say(line: Line, delay = 0) {
    if (!this.enabled) return;
    if (delay > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.say(line);
      }, delay * 1000);
      this.timers.add(timer);
      return;
    }
    const now = performance.now() / 1000;
    const spec = LINES[line];
    if (now - (this.last.get(line) ?? -Infinity) < spec.cooldown) return;
    this.last.set(line, now);
    if (this.current && !this.held && spec.priority > LINES[this.current.line].priority) {
      this.interrupt();
      this.play(line);
    } else if (this.current || this.held) this.enqueue(line);
    else this.play(line);
  }
  /**
   * While held (paused, photo mode) the current sentence finishes but nothing
   * new starts; queued and delayed calls wait for the release.
   */
  hold(held: boolean) {
    if (this.held === held) return;
    this.held = held;
    if (!held) this.next();
  }
  private enqueue(line: Line) {
    if (this.queue.includes(line)) return;
    const priority = LINES[line].priority;
    // Chatter is capped; anything priority 3+ is never dropped.
    if (priority < 3 && this.queue.length >= 2) return;
    const at = this.queue.findIndex((queued) => LINES[queued].priority < priority);
    this.queue.splice(at < 0 ? this.queue.length : at, 0, line);
  }
  /** Drops everything in flight and queued (menu, restart). */
  clear() {
    this.epoch++;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.queue = [];
    this.stopCurrent();
    this.onSubtitle?.(null);
  }
  /** Urgent traffic steps on chatter; calls that matter are said again after. */
  private interrupt() {
    const cut = this.current?.line;
    this.queue = this.queue.filter((queued) => LINES[queued].priority >= 3);
    this.stopCurrent();
    if (cut && LINES[cut].priority >= 3 && !this.queue.includes(cut)) this.queue.unshift(cut);
  }
  private stopCurrent() {
    const current = this.current;
    if (!current) return;
    this.current = undefined;
    current.source.onended = null;
    try {
      current.source.stop();
    } catch {
      // Already stopped.
    }
    this.audio.duck = 0;
  }
  private async play(line: Line) {
    const epoch = this.epoch;
    const buffer = await this.load(line);
    if (epoch !== this.epoch) return;
    const radio = this.audio.radio();
    // A suspended context would never end the line and the channel would stay busy.
    if (!radio || !buffer || !this.enabled || radio.context.state !== "running") {
      // An interrupt that cannot play must not leave the old subtitle up.
      if (!this.current) this.onSubtitle?.(null);
      return this.next();
    }
    if (this.held) return this.enqueue(line);
    if (this.current) {
      // Something more urgent started while this line was loading.
      if (LINES[line].priority <= LINES[this.current.line].priority) return this.enqueue(line);
      this.interrupt();
    }
    const ctx = radio.context;
    const start = ctx.currentTime + 0.08;
    this.audio.squelch(start - 0.06);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(radio.input);
    source.start(start);
    this.current = { line, source };
    this.audio.duck = 1;
    this.onSubtitle?.(LINES[line].text);
    source.onended = () => {
      source.disconnect();
      if (this.current?.source !== source) return;
      this.current = undefined;
      this.audio.duck = 0;
      this.audio.squelch(ctx.currentTime, 0.18);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (!this.current) this.onSubtitle?.(null);
      }, 900);
      this.timers.add(timer);
      // A beat of silence between calls, like a real channel.
      const gap = setTimeout(() => {
        this.timers.delete(gap);
        this.next();
      }, 450);
      this.timers.add(gap);
    };
  }
  private next() {
    if (this.current || this.held) return;
    const line = this.queue.shift();
    if (line) this.play(line);
  }
}
