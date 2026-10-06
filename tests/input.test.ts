import test from "node:test";
import assert from "node:assert/strict";
import { FlightInput } from "../src/input/FlightInput";

test("quick key taps between simulation steps are buffered once without duplicating held actions", () => {
  const input = new FlightInput();
  input.queue("flare");
  input.sample(new Set(), false, 1);
  assert.equal(input.active("flare"), true);
  assert.equal(input.active("flare"), false);
  input.queue("missile");
  input.sample(new Set(["KeyX"]), false, 1);
  assert.equal(input.active("missile"), true);
  input.sample(new Set(), false, 1);
  assert.equal(input.active("missile"), false);
});

test("remapped combat input remains distinct from flight and pause clears pending actions", () => {
  const input = new FlightInput();
  input.bindings.missile = "KeyJ";
  const controls = input.sample(new Set(["KeyJ", "KeyW", "Space"]), false, 1);
  assert.equal(controls.pitch, 1);
  assert.equal(controls.boost, true);
  assert.equal(input.held("missile"), true);
  assert.equal(input.held("gun"), false);
  assert.equal(input.consume("missile"), true);
  assert.equal(input.consume("missile"), false);
  input.clear();
  assert.equal(input.held("missile"), false);
  assert.equal(input.consume("missile"), false);
  assert.equal(input.sample(new Set(["KeyW"]), true, 1).pitch, -1);
});

test("standard gamepad maps axes/buttons and disconnect falls back to keyboard", () => {
  const input = new FlightInput();
  const buttons = Array.from({ length: 8 }, () => ({
    value: 0,
    pressed: false,
    touched: false,
  }));
  buttons[0].value = buttons[7].value = 1;
  const pad = {
    connected: true,
    mapping: "standard",
    axes: [0.04, -1, 0, 0],
    buttons,
  } as unknown as Gamepad;
  const controls = input.sample(new Set(), false, 1, [pad]);
  assert.equal(controls.roll, 0);
  assert.equal(controls.pitch, 1);
  assert.equal(controls.throttle, 1);
  assert.equal(input.held("gun"), true);
  assert.equal(input.connected, true);
  input.sample(new Set(), false, 1, []);
  assert.equal(input.connected, false);
  assert.equal(input.held("gun"), false);
});
