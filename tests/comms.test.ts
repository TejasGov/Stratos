import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { Comms, LINES, voiceFile, type Line } from "../src/comms.ts";
import type { FlightAudio } from "../src/audio.ts";

const lines = Object.keys(LINES) as Line[];

test("every radio line has a recording and every recording has a line", () => {
  for (const line of lines) assert.ok(existsSync(`public${voiceFile(line)}`), voiceFile(line));
  const files = readdirSync("public/assets/voice").filter((f) => f.endsWith(".mp3"));
  assert.deepEqual(files.sort(), lines.map((l) => voiceFile(l).split("/").pop()).sort());
});

/** Minimal stand-in for the Web Audio graph Comms drives. */
function fakeAudio() {
  const sources: { line: string; stopped: boolean; end: () => void }[] = [];
  const context = {
    state: "running",
    currentTime: 0,
    createBufferSource() {
      const source = {
        buffer: undefined as unknown as { line: string },
        onended: null as null | (() => void),
        connect() {},
        disconnect() {},
        start() {
          const entry = {
            line: source.buffer.line,
            stopped: false,
            end: () => source.onended?.(),
          };
          sources.push(entry);
          source.stop = () => {
            entry.stopped = true;
          };
        },
        stop() {},
      };
      return source;
    },
  };
  const audio = {
    duck: 0,
    decode: async (url: string) => ({ line: url }),
    radio: () => ({ context, input: {} }),
    squelch() {},
  };
  return { audio: audio as unknown as FlightAudio, sources };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("urgent calls cut in; routine calls wait their turn", async () => {
  const { audio, sources } = fakeAudio();
  const comms = new Comms(audio);
  const subtitles: (string | null)[] = [];
  comms.onSubtitle = (text) => subtitles.push(text);
  comms.say("takeoff");
  await settle();
  comms.say("missile");
  await settle();
  assert.deepEqual(
    sources.map((s) => [s.line, s.stopped]),
    [
      [voiceFile("takeoff"), true],
      [voiceFile("missile"), false],
    ],
  );
  assert.equal(subtitles.at(-1), LINES.missile.text);
  assert.equal(audio.duck, 1);
  // Lower priority traffic queues behind the warning.
  comms.say("landmark");
  await settle();
  assert.equal(sources.length, 2);
  sources[1].end();
  assert.equal(audio.duck, 0);
  await wait(700);
  assert.equal(sources.at(-1)!.line, voiceFile("landmark"));
  comms.clear();
});

test("cooldowns stop a line repeating and clear() drops lines still loading", async () => {
  const { audio, sources } = fakeAudio();
  const comms = new Comms(audio);
  comms.say("kill");
  comms.say("kill");
  await settle();
  assert.equal(sources.length, 1);
  comms.clear();
  comms.say("clear");
  comms.clear();
  await settle();
  assert.equal(sources.length, 1);
  assert.equal(audio.duck, 0);
});

test("disabled comms stay silent", async () => {
  const { audio, sources } = fakeAudio();
  const comms = new Comms(audio);
  comms.enabled = false;
  comms.say("crash");
  await settle();
  assert.equal(sources.length, 0);
});

test("a call made in the gap between lines does not swallow the queue", async () => {
  const { audio, sources } = fakeAudio();
  const comms = new Comms(audio);
  comms.say("takeoff");
  await settle();
  comms.say("landmark");
  sources[0].end();
  // The channel is idle for a beat; a new call takes it before the queue does.
  comms.say("firstKill");
  await settle();
  sources[1].end();
  await wait(700);
  assert.deepEqual(
    sources.map((s) => s.line),
    [voiceFile("takeoff"), voiceFile("firstKill"), voiceFile("landmark")],
  );
  comms.clear();
});

test("important calls survive an interrupt and a full queue", async () => {
  const { audio, sources } = fakeAudio();
  const comms = new Comms(audio);
  comms.say("clear");
  await settle();
  comms.say("landmark");
  comms.say("routeDone");
  // Chatter is capped at two, but an important call still gets in line.
  comms.say("escortLost");
  comms.say("missile");
  await settle();
  for (let i = 0; i < 3; i++) {
    sources.at(-1)!.end();
    await wait(700);
  }
  assert.deepEqual(
    sources.map((s) => [s.line, s.stopped]),
    [
      [voiceFile("clear"), true],
      [voiceFile("missile"), false],
      [voiceFile("clear"), false],
      [voiceFile("escortLost"), false],
    ],
  );
  comms.clear();
});

test("an interrupt that cannot load clears the old subtitle", async () => {
  const { audio } = fakeAudio();
  const decode = audio.decode;
  audio.decode = async (url: string) => {
    if (url === voiceFile("missile")) throw new Error("offline");
    return decode.call(audio, url);
  };
  const comms = new Comms(audio);
  const subtitles: (string | null)[] = [];
  comms.onSubtitle = (text) => subtitles.push(text);
  comms.say("takeoff");
  await settle();
  comms.say("missile");
  await settle();
  assert.equal(subtitles.at(-1), null);
});

test("a held channel waits until it is released", async () => {
  const { audio, sources } = fakeAudio();
  const comms = new Comms(audio);
  comms.hold(true);
  comms.say("takeoff");
  await settle();
  assert.equal(sources.length, 0);
  comms.hold(false);
  await settle();
  assert.equal(sources.at(-1)!.line, voiceFile("takeoff"));
  comms.clear();
});
