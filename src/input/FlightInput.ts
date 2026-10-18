import type { Controls } from "../flight";

export type CombatAction = "gun" | "missile" | "target" | "flare" | "bomb";
export const defaultBindings: Record<CombatAction, string> = {
  gun: "KeyF",
  missile: "KeyX",
  target: "KeyT",
  flare: "KeyV",
  bomb: "KeyN",
};
const deadzone = (n: number) =>
  Math.abs(n) < 0.12 ? 0 : (Math.sign(n) * (Math.abs(n) - 0.12)) / 0.88;

/** Keyboard and standard gamepads share action values; no browser side effects. */
export class FlightInput {
  bindings = { ...defaultBindings };
  private previous = new Set<CombatAction>();
  private down = new Set<CombatAction>();
  private pressed = new Set<CombatAction>();
  /** Last sample's state of the edge-triggered flight switches. */
  private latched = { engines: false };
  /** Taps that came and went between two samples (slow frames). */
  private tapped = { engines: false };
  connected = false;
  sample(
    keys: ReadonlySet<string>,
    invert: boolean,
    sensitivity: number,
    pads: readonly (Gamepad | null)[] = [],
  ): Controls {
    const key = (...codes: string[]) =>
      codes.some((code) => keys.has(code)) ? 1 : 0;
    const pad = pads.find((p) => p?.connected && p.mapping === "standard");
    this.connected = !!pad;
    const button = (i: number) => pad?.buttons[i]?.value ?? 0;
    const axis = (i: number) => deadzone(pad?.axes[i] ?? 0);
    this.down.clear();
    const padButtons: Record<CombatAction, number> = {
      gun: 0,
      missile: 1,
      flare: 2,
      target: 3,
      bomb: 11,
    };
    for (const action of Object.keys(this.bindings) as CombatAction[]) {
      if (keys.has(this.bindings[action]) || button(padButtons[action]) > 0.5)
        this.down.add(action);
      if (this.down.has(action) && !this.previous.has(action))
        this.pressed.add(action);
    }
    this.previous = new Set(this.down);
    // The engine master (I) fires once per press.
    const enginesDown = !!key("KeyI");
    const engineToggle = (enginesDown && !this.latched.engines) || this.tapped.engines;
    this.tapped.engines = false;
    this.latched.engines = enginesDown;
    return {
      pitch: Math.max(
        -1.6,
        Math.min(
          1.6,
          (key("KeyW", "ArrowUp") - key("KeyS", "ArrowDown") - axis(1)) *
            (invert ? -1 : 1) *
            sensitivity,
        ),
      ),
      roll: Math.max(
        -1.6,
        Math.min(
          1.6,
          (key("KeyA", "ArrowLeft") - key("KeyD", "ArrowRight") - axis(0)) *
            sensitivity,
        ),
      ),
      yaw: key("KeyQ") - key("KeyE") - axis(2),
      throttle:
        key("ShiftLeft", "ShiftRight") -
        key("ControlLeft", "ControlRight") +
        button(7) -
        button(6),
      boost: !!key("Space") || button(4) > 0.5,
      airbrake: !!key("KeyZ") || button(5) > 0.5,
      engineToggle,
    };
  }
  /** Buffers an engine-switch key press so a tap between samples still counts. */
  tap(control: "engines") {
    this.tapped[control] = true;
  }
  held(action: CombatAction) {
    return this.down.has(action);
  }
  queue(action: CombatAction) {
    this.pressed.add(action);
  }
  active(action: CombatAction) {
    const pressed = this.consume(action);
    return this.held(action) || pressed;
  }
  consume(action: CombatAction) {
    const pressed = this.pressed.has(action);
    this.pressed.delete(action);
    return pressed;
  }
  clear() {
    this.down.clear();
    this.pressed.clear();
    this.previous.clear();
    this.latched.engines = false;
    this.tapped.engines = false;
  }
}
