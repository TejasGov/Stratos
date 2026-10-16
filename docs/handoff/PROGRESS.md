# Progress so far

## Live and merged (`main`, deployed on Vercel)

Iterations 1–5 are on `main` (PRs #5 and #6 merged):

- Sky engine, GPU terrain, storms, photo mode, missions (intercept, escort, strike), gate routes, ascent challenge.
- Meshy fleet of nine aircraft (`src/aircraft.ts`, `public/assets/aircraft/`).
- ElevenLabs sound effects (`public/assets/audio/`).
- **Haven Control**: a voiced radio controller with 19 lines, subtitles, priorities and cooldowns (`src/comms.ts`, `public/assets/voice/`). After review it gained a hardened queue, pause hold, synthesized flare salvo, radio static, compression and signal dropouts. 62 tests pass.

## On `stratos/iteration-6-theatre` (pushed, not merged to `main`)

| Commit | What |
| --- | --- |
| `29abbc4` | **Shared contracts** so parallel work agrees on one API: `src/world/bases.ts` (HAVEN and BLACKRIDGE runways, SAM_SITES, `runwayThreshold()`); Airframe fields `engines`, `rcs`, `supermanoeuvre`, `thrustVectoring` for all nine jets; Flight fields `engines[]`, `onGround`, `airbrake`, `aoa`, `postStall`, `damageEngine()`; Effects stubs `emitFlares`, `emitLaunch`, `emitEngineFire`, `emitExplosion(pos, scale, kind)` |
| `c3582a0` | `BLACKRIDGE_TARGETS` (radar = strike objective, fuel depot, aircraft shelters) |
| `62aadb4` (merged as `0ce434b`) | **Meshy assets**: SAM launcher and radar trucks, three rigged soldiers, ten animation clips |

### Meshy assets (done)

- `public/assets/defense/sam-launcher.glb` (1.27 MB, 22k tris) and `sam-radar.glb` (1.27 MB, 22k tris). They face −Z with +Y up, origin at ground centre, scaled in metres. Each is one mesh, so the turret and antenna can't animate separately. The radar antenna came out boxy.
- `public/assets/characters/soldier.glb`, `trooper.glb` (gas mask, black tactical) and `instructor.glb`: 1.78 m tall, facing +Z, about 14k tris each, sharing the same 24-bone skeleton.
- `public/assets/characters/clips/*.glb`: idle, alert, dead, agree-gesture, boxing-practice, jumping-jacks, dying-backwards, talk-passionately, walk, run. All were made on the soldier rig and work on any of the three. Only Hips has a translation track.
- `public/assets/characters/manifest.json` and the two README files list the prompts, task ids and processing.
- Credits: 189 of 212 Meshy credits spent; **23 left**. Backflip, sit-ups, air squat and casual walk weren't bought.
- Misses on single takes: the soldier has goggles but no helmet; the instructor has a beret and short-sleeve shirt.

**Note:** these Meshy soldiers were made without asking first, even though the user wanted Mixamo. The plan is for Mixamo characters to become the main cast, with the Meshy ones used as Blackridge (enemy) troops or removed. The user decides.

## Layout decisions (in `src/world/bases.ts`)

- **Haven** (home): runway centre (−900, 0), heading 0 (takeoff to the north, −Z), 1600 × 45 m, elevation 29 m. The terrain is already flattened there by an ellipse in `terrain.ts` and `terrainGlsl.ts`.
- **Blackridge** (enemy): north coast at (0, −8350), runway east–west (heading −π/2), 1500 × 40 m, elevation 60 m. The north coast is small, so the runway runs along the coast. It sits behind the island's mountain spine, which gives terrain masking for low approaches.
- **SAM sites**: three around Blackridge (`br-west`/`br-east` shorad, `br-ridge` mrsam) and three forward on the north island (`strait` shorad, `spine` mrsam, `west-valley` shorad).
- **Stealth (`rcs`)**: F-22 0.1, F-35 0.15, J-20 0.3, Su-57 0.35, Rafale 0.55, Tejas 0.6, Typhoon 0.65, Su-30 1, MiG-21 1. Detection range scales with rcs^¼.
- **Cobra authority (`supermanoeuvre`)**: Su-30 and Su-57 1.0, F-22 0.9, Rafale 0.6, J-20 and Typhoon 0.55, Tejas 0.5, F-35 0.45, MiG-21 0.3.
- **Engines**: twins are Su-57, F-22, J-20, Su-30, Rafale and Typhoon; singles are F-35, Tejas and MiG-21.
