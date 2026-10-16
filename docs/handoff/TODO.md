# To do, in order

## 1. Finish and merge the four paused branches
See [IN_PROGRESS.md](IN_PROGRESS.md). To resume a branch, check it out and give a Claude session the matching spec from section 5 below plus "this branch is partially done; finish it, verify in the browser, keep the shared contracts".

## 2. Integration pass (after merging)
- Wire `airbase.setParkedAircraft(...)` after the fleet loads in `main.ts`, and `combat.onTargetDestroyed = (id) => world.airbase.destroy(id)`. Call `airbase.reset()` on restart.
- Make sure every mission starts on the runway, including the menu → start transition and restart (R).
- Comms lines still fit:
  - `takeoff` "You're off the deck" should play at liftoff, not at spawn. Trigger it when `flight.onGround` flips to false.
  - The `intercept` brief should play after takeoff.
  - Consider a "cleared for takeoff" moment (no new voice line without ElevenLabs credits).
- Performance check on a real GPU: 60 fps at both bases at dusk with an explosion and a flare salvo on screen.
- Code review of the merged diff (correctness, per-frame allocations), then update `README.md` and `docs/IMPLEMENTATION_STATUS.md`.

## 3. Soldiers at the bases (not started)
- **Characters:** see "Mixamo" in [RESOURCES.md](RESOURCES.md). Convert the FBX files to GLB (e.g. `npx fbx2gltf` or Blender), then put them in `public/assets/characters/mixamo/` with a manifest like the existing `public/assets/characters/manifest.json`. Mixamo clips share one skeleton across Mixamo characters. Meshy and Mixamo bone names differ, so keep the two clip sets separate or retarget.
- **New module `src/world/Crowds.ts`:**
  - Squads walking routes around the apron.
  - Groups idling and talking (talk and agree-gesture clips).
  - A drill group doing jumping jacks, push-ups, sit-ups and backflips, led by an instructor.
  - A jogging column with the instructor alongside.
  - Guards at Blackridge.
  - After a strike, Blackridge troops nearby die (dying-backwards, then dead). Haven stays safe unless the mission fails.
- **Performance:** one `AnimationMixer` per character, pausing mixers and hiding crowds beyond ~2 km; cap visible characters (about 40); share materials and skeleton clips. Add some tint variation to tell units apart.
- **Base cinematics:**
  - A menu or briefing camera that sweeps Haven's apron with soldiers.
  - A takeoff shot with ground crew saluting or waving (`Big Wave Hello`, or a Mixamo `Salute`).

## 4. Trailer (not started)
- **Music:** an upbeat, fresh, cinematic track from ElevenLabs (`eleven_music_v2_5`, about 75–90 s). **Blocked:** the ElevenLabs balance is 0 credits, so top up first. Use `estimate_only` to price the track before generating it.
- **Shot list** (about 60–80 s), cut to the beat:
  - Dawn over the islands.
  - Ground crew and soldiers at Haven.
  - Takeoff roll.
  - Fleet showcase: all nine jets, one shot each.
  - Weather: towering clouds, a storm with lightning.
  - Terrain run through valleys.
  - Supersonic boom.
  - Cobra.
  - SAM launch → flare salvo → evasion.
  - Explosions: air kill and Blackridge radar.
  - Climb to space and the curvature at 30 km.
  - Title card "STRATOS" with a call to action.
- **Render:** write a deterministic capture harness. Stop the render loop, step the simulation at a fixed dt of 1/30 s, script cameras per shot with `window.stratos` and photo-mode camera controls, and grab frames with `canvas.toBlob` or a Playwright screenshot. Encode with `ffmpeg -framerate 30 -i %05d.png -c:a aac -c:v libx264 -crf 16 -pix_fmt yuv420p`. Render on your desktop GPU in a real browser window; it's far faster and better than headless SwiftShader. Add title cards and fades with ffmpeg `drawtext`/`xfade` or an editor.
- **Deliverables:** a 1080p MP4, a vertical 9:16 cut for social, and stills.

## 5. Specs for the paused features (paste into a session to resume)

**Common rules:**
- Keep the shared contracts in `src/world/bases.ts`, `src/aircraft.ts` (new fields), `src/flight.ts` (`engines[]`, `onGround`, `airbrake`, `aoa`, `postStall`, `damageEngine`) and `src/effects/Effects.ts` (`emitFlares`, `emitLaunch`, `emitEngineFire`, `emitExplosion` kind).
- Keep `main.ts` changes small and local.
- Avoid per-frame allocations.
- Verify in the browser and look at the screenshots.
- `tsc`, tests and build must pass.

**Bases:**
- Haven, clean grey/blue style: real runway texture and markings ("36"/"18"), edge, approach and PAPI lights; tower with lit glass cab; arched hangars and hardened shelters; fuel tanks, radar dome, barracks, fence, windsock, floodlights; parked jets via `setParkedAircraft`.
- Blackridge, camouflage with a red/white chequered tower and revetments: runway "09"/"27"; destroyable targets from `BLACKRIDGE_TARGETS` (rotating radar, fuel farm, shelters) via `destroy(id)` and `reset()`.
- Terrain flatten in both `terrain.ts` and `terrainGlsl.ts` (they must stay identical).
- Data-driven colliders; merged geometry with fewer than 40 draw calls per base; map markers.

**Flight:**
- `resetOnRunway(runway)`, ground roll and rotation at Vr, wheel brakes and nosewheel steering, runway surface exempt from collisions, landing acceptance (sink under 5 m/s, roll under 15°).
- Every sortie starts on Haven's runway.
- Airbrake on Z (pad button 5); engine master on I with a 3 s relight.
- Cobra on M (pad button 10): speed window 110–190 m/s; peak AoA 100–120° scaled by `supermanoeuvre`; flight path held; 35–50% speed bleed; recovery within 2.5 s; camera follows the flight path.
- Differential thrust on twins (+30–40% yaw).
- Engine failure: a twin loses half its thrust and yaws; a single glides; per-nozzle flames; `emitEngineFire`; HUD engine indicators.

**Air defence:**
- Enemies spawn from the north once the player is airborne; the escort departs after takeoff; strike targets the Blackridge radar.
- `AirDefense.ts`:
  - mrsam radar range × rcs^¼, terrain line of sight, under-100 m clutter, doppler notch and cobra break lock.
  - shorad IR detection by proximity, ×1.5 with afterburner, reduced with engines off.
  - States: search → track (2–4 s) → launch → reload.
  - Heat-seeking proportional-navigation missiles: boost then coast, flare decoy probability, proximity fuse at 15 m.
  - Sites are destroyable.
- Warning-receiver HUD and tones; the `missile` radio call fires on the threat rising edge; map range rings.

**Effects:**
- Magnesium flares: ejection, drag, gravity, HDR flicker, sparks, smoke "angel" arcs.
- Explosions:
  - Flash, turbulent fireball, lingering smoke, shockwave, burning debris, secondary pops.
  - The ground variant adds dust, debris and a 30 s smoke column with fires.
- SAM launch backblast and plume.
- Engine fire trail.
- Flare and explosion synthesis, plus distance delay and low-pass on explosions.

## 6. Open decisions for the user
- Keep the Meshy soldiers as Blackridge enemy troops once Mixamo characters arrive, or remove them?
- Top up ElevenLabs for the trailer music and optional new voice lines: "cleared for takeoff", "SAM launch, break!", "radar lock", "engine fire", "welcome home". Optionally re-record the synthesized flare, static and glitch sounds too.
- Top up Meshy (23 credits left) for backflip, sit-ups and air squat clips, or get those from Mixamo instead (free).
