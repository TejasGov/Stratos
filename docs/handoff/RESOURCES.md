# Resources

## Branches (github.com/TejasGov/Stratos)
| Branch | Contents |
| --- | --- |
| `main` | Iterations 1–5, deployed on Vercel |
| `stratos/iteration-6-theatre` | Shared contracts, Meshy assets and this handoff (also mirrored to `claude/stoic-tesla-72c5t8`) |
| `wip/iter6-bases`, `wip/iter6-flight`, `wip/iter6-effects`, `wip/iter6-airdefense` | Paused feature work (see IN_PROGRESS.md) |

## Accounts and credits (as of the pause)
| Service | Status |
| --- | --- |
| Meshy | 23 credits left. Preview 20, refine 10, rigging 5, animation 3 per clip; even "free" catalog clips cost 3. |
| ElevenLabs | **0 credits** (quota 40,000 used). Sound effects cost about 17 credits per take (4 takes ≈ 67). Get a music price with `estimate_only` before generating. |
| Mixamo | Needs your Adobe sign-in in a browser; there is no API. |

## Mixamo download settings
- **Characters:** Swat Guy, Steve, David, Pete, Alex, Gas Mask. Use FBX Binary, With Skin, T-pose.
- **Animations** (one character selected): FBX Binary, Without Skin, 30 fps; tick *In Place* for locomotion.
  - Walking, Jogging, Running
  - Idle, Talking, Salute
  - Push Up, Jumping Jacks, Sit Up, Backflip
  - Dying, Death
- Put them in `public/assets/characters/mixamo/`.
- Convert to GLB with FBX2glTF (`npx fbx2gltf -i in.fbx -o out`) or Blender's glTF exporter. Strip meshes from animation-only files, shrink textures to 1024 px and aim for 3 MB or less per character.

## Meshy CLI
```bash
# On the cloud container Node's fetch needed NODE_USE_ENV_PROXY=1; locally you likely don't.
npm exec --yes --package=meshy-cli@0.4.0 -- meshy auth status --format json --no-update-check
npm exec --yes --package=meshy-cli@0.4.0 -- meshy balance --output-schema v1 --format json --no-update-check
npm exec --yes --package=meshy-cli@0.4.0 -- meshy animation-catalog list --search jump --output-schema v1 --format json
```
Task ids and processing notes for every asset are in `public/assets/defense/README.md` and `public/assets/characters/README.md`.

## Asset conventions
- **Aircraft:** `src/aircraft.ts`. Model units are normalised to a 1.9 length, nose −X; `airframeScale()` converts to metres.
- **Vehicles:** front −Z, +Y up, origin at ground centre, metres.
- **Characters:** 1.78 m, facing +Z, feet at origin. Bones are in centimetres under `Armature` (scale 0.01). Clips are skeleton plus one animation; only Hips has translation.
- **Audio:** loops are 22.05 kHz mono WAV and one-shots are MP3 (`public/assets/audio/README.md`). Voice is about −19 LUFS mono MP3 (`public/assets/voice/README.md`).

## Key code
| Area | Files |
| --- | --- |
| Game loop, camera, input, HUD wiring, combat events | `src/main.ts` (large; most agents touch it) |
| Flight model and collision | `src/flight.ts` (`sweptCollision` at the bottom) |
| Terrain height (CPU and GPU must match) | `src/world/terrain.ts` `heightAt`, `src/world/terrainGlsl.ts` |
| World objects and floating origin | `src/world/World.ts` |
| Combat | `src/combat/CombatSystem.ts`, `CombatView.ts` |
| Effects | `src/effects/Effects.ts`, `particle-core.ts`, `Supersonic.ts` (nozzle flames, shocks, vapour) |
| Audio | `src/audio.ts` (samples, synthesis, radio chain, `transmission()`) |
| Radio voice | `src/comms.ts` (`LINES`, `Comms`) |
| Missions and landmarks | `src/missions.ts` |
| Bases and SAM layout | `src/world/bases.ts` |

## Debugging
- Open the game with `?debug` to get `window.stratos`, which has `start()`, `flight`, `combat`, `effects`, `world`, `sky` (`time.hours`, `setWeather`), `comms`, `audio`, `renderer` and `camera`.
- Headless screenshots work with Playwright and SwiftShader, but slowly. Launch args: `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist --autoplay-policy=no-user-gesture-required`. CSS transitions look frozen under SwiftShader; that's expected. On your desktop, just use a real browser.
- To record real game audio: connect `stratos.audio.master` to a `MediaStreamDestination`, record it with `MediaRecorder`, then measure with `ffmpeg ... ebur128` and `astats`.
- Gotcha: Web Audio gain nodes default to 1 until their first automation event. Set the gain to 0 when you create the node, or you get full-scale clicks.

## Multi-agent tips (what worked here)
- Commit shared interfaces first, then run one agent per area in separate git worktrees, and merge in a fixed order.
- Opus was used for flight physics; Sonnet for bases, effects and assets.
- A Sonnet run on the weapons/defence task was stopped by the safety filter. The Opus retry framed it explicitly as fictional arcade game AI and ran fine.
- Give every agent its own preview port. Keep headless browser runs short on small machines.
