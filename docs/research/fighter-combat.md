# Fighter combat: competitive research and design recommendations

Research accessed **October 5, 2026**. This combines developer/publisher product evidence, primary technical documentation, and an inspection of Stratos. Product descriptions establish advertised features, not independent quality ratings. Recommendations below are design inferences; no commercial games were playtested for this report, and no revenue or total addressable market is estimated from review counts.

## Recommended positioning

Build Stratos around **accessible, cinematic fighter combat in a continuous explorable island world**, with an immediate browser launch. Give aircraft believable momentum, bank, speed-dependent handling and combat consequences, while keeping targeting and controls understandable without learning a cockpit. This positioning is a hypothesis worth testing with new players, rather than a demonstrated gap in the market.

The existing game already supports keyboard free flight, chase/forward cameras, fixed-step simulation, deterministic streamed islands, landmarks and checkpoint races. It has no enemy aircraft, weapons, targeting, damage, countermeasures or combat mission director. The delivered Meshy plane is a rigid exterior asset with retracted landing gear; a detailed cockpit or working control surfaces would require additional assets. These facts make an exterior-camera single-player combat slice the most efficient next step.

## Competitive landscape: what each reference contributes

| Reference                | Verified offering                                                                                                   | Lesson proposed for Stratos                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ace Combat 8             | Arcade aerial action, campaign, multiplayer and dynamic multilayer clouds                                           | Sky composition and clear combat feedback are central to the spectacle; benchmark presentation rather than its content volume. [Publisher](https://www.bandainamcoent.com/games/ace-combat-8)                |
| Project Wingman          | Accessible flight action, campaign and replayable territory-based Conquest mode; customizable controller support    | Pair a strong flight/combat loop with reusable encounters and a small strategic progression layer. [Developer listing](https://store.steampowered.com/app/895870/Project_Wingman/)                           |
| Nuclear Option           | Dynamic air/land/sea battles, virtual mouse joystick, component damage and mission creation; currently Early Access | A living battlefield and meaningful damage can differentiate a sandbox, but select only affordable parts of that simulation. [Developer listing](https://store.steampowered.com/app/2168680/Nuclear_Option/) |
| DCS: Flaming Cliffs 2024 | Simplified controls combined with professional flight models                                                        | Input complexity and flight-model fidelity are separate choices. [Eagle Dynamics](https://www.digitalcombatsimulator.com/en/products/planes/flaming_cliffs_2024/)                                            |
| War Thunder              | Arcade, Realistic and Simulator options, objective-based team battles and mouse aiming                              | Assist levels and objective variety broaden access; offer a coherent default before multiple modes. [Developer FAQ](https://warthunder.com/en/game/faq/controlsanddifficulty)                                |
| GeoFS                    | Browser flight, global geographic scenery, multiplayer and simplified controls/instruments                          | Browser accessibility and navigation through a large world are established propositions; polished combat is Stratos's proposed focus. [Official site](https://www.geo-fs.com/)                               |

The strongest common signal is the combination of understandable controls and purposeful activities. A larger map alone does not establish differentiation. The recommendation is to concentrate on an identifiable coastal region, short sorties, visible objectives, and convincing aircraft responses before increasing aircraft count or reproducing real-world systems.

Ace Combat's official game overview includes air combat, ground support, naval strikes and squad commands. These support a mission-role reference: encounters need different priorities, not just larger waves of identical enemies. Stratos can initially borrow that diversity through intercept, escort and ground-strike templates using a shared entity and objective system. This is a design inference, not a claim about the publisher's implementation. [Official game overview](https://www.bandainamcoent.com/news/ace-combat-8-wings-of-theve-game-overview).

## Controls, flight feel and camera

Introduce an input-action layer: pitch, roll, yaw, throttle, fire, target cycle, weapon select, countermeasure, camera and pause. Keyboard, mouse and gamepad should produce the same normalized actions. Make bindings, pitch inversion, dead zones and sensitivity visible. An optional assisted mouse-direction controller should generate bounded pitch/roll/throttle commands rather than teleporting the aircraft's orientation. Keep direct keyboard/gamepad control available.

The Gamepad API exposes device axes/buttons and requires handling connection state and browser-specific availability. Poll within the game loop, inspect mapping, handle disconnects gracefully and provide calibration for nonstandard devices. HOTAS support needs validation on actual hardware; ordinary gamepad support does not establish compatibility with every joystick. [MDN Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API).

The present pitch/roll clamps limit aerobatic freedom. Evaluate quaternion-based attitude integration and an explicit angular-rate model before dogfight AI depends on it. Avoid Euler-angle discontinuities. Add gradual control response, speed-dependent turn authority, induced drag under sustained turns, throttle response and a recoverable low-speed warning. First tune the player experience, then allow AI to use the same limits. A stall system is useful only if its onset, feedback and recovery are teachable; default assistance can prevent frustrating spins.

Treat camera tuning as part of flight feel: damp position and orientation separately, retain a readable horizon, permit deliberate target look, and bound shake/FOV changes. Excessive lag can hide what the aircraft is doing; excessive roll-follow makes threats difficult to locate. Provide reduced shake and a comfortable FOV option. Use camera cuts for explicit events rather than automatically interrupting control on every kill.

## Targeting and situational awareness

Represent target selection, tracking, locking and firing as explicit states. A target should be selectable without being shootable. Show why a shot is unavailable through a small number of clear cues: range, forward cone, line of sight, acquisition progress and cooldown. Lock feedback should combine a reticle state and a distinct sound; never require the sound alone.

The HUD needs selected-target range, relative direction, identity/faction, health or damage state, weapon readiness and mission relevance. Off-screen arrows should indicate a useful bearing with stable placement, and the radar should use consistent heading/range conventions. Declutter peripheral enemies; do not draw a large label over every distant object. Selected targets, immediate threats and mission assets deserve priority over decorative contacts.

Incoming threat warnings should communicate direction and urgency before impact. Teach target cycle, maintaining lock, firing and evasion through a short interactive encounter. Explain failed attacks rather than silently withholding damage. Add subtitles/captions for radio objectives, separate speech/effects/music levels, shape-based faction cues and adjustable HUD scale. These align with published accessibility guidance on remapping, interactive tutorials and redundant visual/audio communication. [Game Accessibility Guidelines](https://gameaccessibilityguidelines.com/full-list/).

## Weapons and damage as game systems

Begin with two complementary weapons: a cannon rewarding close alignment and a guided missile rewarding sustained acquisition and timing. Store their parameters in data, including cooldown, magazine/reload policy, damage, range, visual/audio effect references and target compatibility. Use fictional, balanced handling rather than claiming real aircraft or weapons performance.

Cannon collision should query the segment traveled within each simulation step, or use a defined hitscan approximation with readable tracer timing. Guided projectiles need finite speed, turn rate, lifetime and a coherent loss-of-target policy. Provide predictable countermeasure windows and visible missile behavior. These are proposed game mechanics; tuning requires playtests, not importing real-world numbers.

At Stratos's present maximum speed, 340 metres/second, the player moves approximately **5.7 metres in one 60 Hz step**. Projectiles can travel farther. Endpoint overlap checks alone will miss thin targets. Rapier offers filtered ray and shape queries: exclude the shooter, respect factions and collision groups, and sweep from the previous position. A shape sweep gives a projectile finite radius. Account for the target's motion as well as the projectile's travel; querying only a frozen endpoint pose can miss crossings. [Rapier scene queries](https://rapier.rs/docs/user_guides/javascript/scene_queries/).

Do not treat CCD as a universal switch. Current Rapier documentation distinguishes collision handling against static and moving bodies; behavior also depends on the pinned version and chosen body types. A jet moved by a custom flight model requires explicit integration and query policies. Validate two moving fast objects, turning paths, terrain edges and thin buildings rather than relying on a single terrain test. [Current Rapier CCD documentation](https://rapier.rs/docs/user_guides/javascript/rigid_body_ccd/).

Centralize damage events so health, hit confirmation, scoring, AI reaction, smoke and sound all consume one authoritative outcome. Start with health plus a few readable states: intact, damaged, critical and destroyed. Add limited engine/control impairment if it improves decision-making. Nuclear Option's component damage demonstrates a deeper reference, but copying dozens of physical fragments per aircraft is not justified for the first browser slice. Debris can be pooled visual objects, with only a few nearby pieces receiving physics.

Friendly fire, invulnerability after respawn, projectile owner identity and simultaneous kills should have explicit rules. Decide whether ammunition replenishes at a base or over time and expose that rule in the HUD. Avoid a damage system whose particles imply a hit while authoritative health says otherwise.

## AI: decisions, steering and flight should be separate

Use three layers: tactical decision, desired maneuver, and flight controls. A finite-state machine can begin with patrol, acquire, approach, attack pass, extend, evade and disengage. Decision logic can run less frequently than the fixed flight integration. Keep a perception budget and a spatial neighborhood index; do not compare every entity against every other entity on every frame.

Craig Reynolds's primary steering research separates action selection, steering and locomotion and discusses pursuit, evasion and anticipatory obstacle avoidance. Apply those principles through the game's bounded aircraft controls. Generic seek behavior alone can produce endless circling or impossible changes in direction. [Reynolds, Steering Behaviors for Autonomous Characters](https://www.red3d.com/cwr/steer/gdc99/).

Make attack passes intentional: approach with altitude/separation, commit briefly, then extend and reposition. Terrain avoidance should anticipate the flight path using sampled clearance, with recovery taking priority over attacking. Enemy difficulty should vary reaction delay, aim error, tactical commitment and coordination. Keep telegraphed limits; invisible perfect targeting is a poor replacement for interesting maneuvers.

Formations need leader-relative slots, separation and lag, not rigid attachment. Only nearby combatants require detailed decisions; distant flights can follow coarse routes until activated. Maintain stable entity IDs and seeded random streams for repeatable bugs. Rebase aircraft, projectiles, trail buffers and physics bodies together when the floating origin shifts.

## An open world with useful pacing

Use a mission director over a geographically authored region. Persistent airfields, ports, radar stations, bridges and valleys make the terrain meaningful. Encounters should refer to those places: intercept bombers approaching a port, protect a transport through a valley, strike a radar installation before an escort phase. Preserve free flight between activities, with clear opt-in combat zones or mission starts.

Combine a few authored anchor missions with seeded encounter templates and bounded concurrent activity. A continuous world should not require continuous full simulation everywhere. Save strategic state and abstract off-screen movement; expand nearby units into physical entities when needed. Avoid spawning enemies inside the camera view or directly on top of the player merely to maintain pressure.

Use shorter sortie loops initially: briefing, departure or airborne start, objective, escalation, resolution and return/restart. Project Wingman's developer-described Conquest structure is a useful reference for replayability, but a full territory economy can wait until encounters are enjoyable. Large progression trees, dozens of aircraft and multiplayer each multiply balancing and production work.

## Audio, effects and animation

Replace the single procedural engine impression gradually with throttle-reactive layers, wind, near-miss sound, distant explosions and crisp weapon feedback. Cap simultaneous voices and prioritize warnings. Test whether radio speech remains understandable during afterburner and explosions. Browser audio should initialize from a user gesture and resume correctly after focus changes.

Emit combat events into a reusable effects system rather than creating bespoke meshes in weapon code. Damage smoke should indicate condition, contrails should indicate trajectory, and explosions should indicate hit scale without obscuring the next decision. The accompanying [smoke/fire report](./smoke-fire.md) covers the rendering pipeline. Keep Anime.js for HUD transitions, briefings, menus and cinematic parameter changes; simulation and targeting should use the game clock so pausing remains consistent.

## A bounded first combat slice

| Stage                  | Scope                                                                 | Acceptance evidence                                                               |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Flight foundation      | Full attitude control, action mapping, comfortable chase camera       | New players can orient, turn and recover; frame-rate independence remains valid   |
| Target and threat loop | One target, acquisition, cannon, missile, warning and countermeasure  | Every success/failure has clear feedback; swept tests catch high-speed crossings  |
| Enemy encounter        | Two to four enemies, attack/extend/evade states, one ground objective | No impossible turns, terrain suicides or endless tail-chasing in seeded scenarios |
| Open-world integration | Three landmark-linked mission templates and saved results             | Travel, entry, abort, completion and restart remain understandable                |
| Presentation           | Layered effects, audio mix, HUD accessibility, quality settings       | Feedback stays readable in smoke, sunset and crowded combat                       |

Multiplayer is a later architectural commitment: server authority, prediction, interpolation, reconciliation, anti-cheat assumptions and hosting costs need separate research. A fixed step helps, but JavaScript and a physics engine do not automatically provide cross-device deterministic lockstep.

## Validation and remaining market uncertainty

Track first-sortie completion, time to first successful shot, lock failures, accidental ground crashes, target-switch confusion, repeated deaths, restarts and voluntary replay. Pair those with short interviews: did the player understand why a missile hit or missed, and did control feel deliberate? These metrics are proposed product validation, not observed performance.

Create deterministic technical scenarios for rapid projectile crossings, occluded targets, two moving missiles/aircraft, pause/resume, focus loss, controller disconnect, damage events, AI terrain recovery and origin rebasing during combat. Benchmark several effects and active enemies at fixed resolution on selected integrated and discrete GPUs. Record median and tail frame times, memory plateau and streaming hitches; report devices explicitly.

The cited product pages establish viable reference designs, but do not prove willingness to pay for a browser fighter game, acquisition costs, retention or a specific audience size. Test a small public slice before selecting monetization. Browser launch simplicity is the proposed advantage; competent combat and a memorable world still need direct player evidence.
