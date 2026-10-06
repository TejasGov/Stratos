# Stratos: Broken Horizon

**Proposed multiplayer story and gameplay design · October 5, 2026**

Status: design draft for the next implementation session. Features below are proposed, not shipped. The initial target is **1–4 player cooperative sorties**, followed by an optional **4v4 objective mode** once cooperative flight and combat work reliably.

## The promise

You and your friends are a fighter squadron with a home worth protecting. Every operation begins at a real airfield and ends with aircraft returning across the horizon. The best moments are shared: rolling onto the runway behind your wingman, seeing a friend arrive to clear your tail, covering a strike, and bringing a damaged jet home.

The game should feel cinematic and approachable. Flight has enough physical continuity to make takeoff, speed, positioning and landing matter, while Easy controls and targeting assistance let new pilots participate immediately.

## Story: a scattered country, one open runway

A chain of violent storms has broken Haven's island communications and supply routes. Meridian, the security contractor once responsible for protecting those routes, has seized the relay network and begun enforcing an armed blockade. Its director claims centralized control is the only way to prevent another disaster. Island communities see their supplies diverted and their airfields closed.

Haven Airfield remains outside Meridian's control. The player squadron, **Stratos Flight**, is the archipelago's surviving defense and relief wing. Its first job is modest: get a medicine transport through the strait. Each successful operation opens another route, restores another outpost, and reveals how Meridian's autonomous defense network works.

The campaign builds toward a choice with an obvious gameplay consequence: destroy the central network and leave the islands temporarily disconnected, or preserve its relays while defeating the aircraft guarding them. The latter is a harder optional finale, with better civilian infrastructure in the epilogue. Neither outcome locks friends out of replaying missions.

### People you hear on the radio

- **Captain Mara Vale, “Anchor”** — Haven's airfield commander. Calm, dry humor, and determined to get every pilot home.
- **Ivo Sen, “Wren”** — a reconnaissance pilot who marks objectives and occasionally needs the squadron's help.
- **Director Soren Kestrel** — Meridian's former disaster-response leader. He believes the blockade is protecting Haven; his broadcasts become less composed as control slips.
- **“Glass”** — Meridian's ace, introduced through encounters rather than a cutscene. Retreats from the early fight and returns in later operations with different wingmen.

Briefings are short radio exchanges during preparation and transit. Story delivery never requires all players to sit through a long synchronized cutscene.

## The world is the mission board

Use the existing Haven geography as recognizable places, not disposable arenas.

| Region          | Identity                                  | Proposed gameplay                                                        |
| --------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| Haven Airfield  | Squadron home and surviving relief hub    | Briefings, taxi, takeoff, landing, repair and rearm.                     |
| The Crown       | Mountain spine and cloud gaps             | Navigation, reconnaissance, radar objectives and dramatic interceptions. |
| Azure Coast     | Strait, bridge and supply corridor        | Transport escort, patrols and coastal defense.                           |
| Northwatch      | Meridian's surveillance outpost           | Strike targets, contested approaches and ace encounters.                 |
| Solstice Island | Isolated community and later forward base | Relief missions; eventually a closer runway and recovery point.          |

Restored outposts visibly change between sorties: lights return, friendly radio traffic appears, transports arrive, and a damaged runway becomes usable. For the first release, these are explicit campaign states rather than a fully simulated world economy.

## A complete sortie

Target **10–15 minutes** for an ordinary operation. Flight distances between existing landmarks are short at jet speeds, so transit usually lasts 30–90 seconds. Do not enlarge empty flight time to reach the duration target; use encounters and objectives.

| Phase    | Player experience                                                            | Proposed duration |
| -------- | ---------------------------------------------------------------------------- | ----------------- |
| Assemble | Join a room, see friends' callsigns and choose an operation.                 | 30–60 sec         |
| Prepare  | Select a loadout, spawn in parking bays and taxi together.                   | 30–60 sec         |
| Launch   | Take runway clearance, accelerate and lift off.                              | 20–40 sec         |
| Ingress  | Form up, receive radio updates and select the first objective.               | 30–90 sec         |
| Engage   | Intercept enemies, protect allies and complete a strike or rescue objective. | 4–7 min           |
| Return   | Regroup, escort damaged teammates and choose a recovery airfield.            | 45–90 sec         |
| Recover  | Land, clear the runway and repair/rearm in a service zone.                   | 30–60 sec         |
| Debrief  | Team outcome, contributions and the next available operation.                | 20–30 sec         |

Mission success is recorded when the primary objective succeeds. Safe recovery adds a squadron bonus; a player who crashes on the way home does not erase everyone else's victory. A partially successful operation can still advance the campaign with a different follow-up.

### On the ground

Start with engines running and aircraft ready. Use the same Shift/Ctrl thrust controls, A/D steering, and a clearly labeled ground brake; full start-up checklists are optional future flavor. Flight pitch controls become active after liftoff. Show current ground controls on the HUD.

The tower assigns simple runway slots. Parked friendly aircraft do not block or damage each other; runway queues cannot become a griefing mechanism. Provide an explicit reset-to-parking action if a pilot gets stuck, and optional guided taxi/takeoff assistance.

Takeoff should communicate speed through wheel movement, engine pitch, runway markings and camera motion. The SF–35 needs visible landing gear and credible ground contact before this can feel finished; the current rigid airborne model does not provide them.

### Coming home

Easy landing shows an approach corridor, speed band and flare cue, with optional approach assistance. Advanced pilots can fly the approach manually. Arcade landing accepts a forgiving alignment, descent and speed window; it does not require simulator precision.

Touchdown should feel different from crashing. Damaged aircraft can limp home with visual smoke and reduced thrust, while retaining enough control to be recoverable. Repair/rearm happens after stopping in a marked service area, not instantly anywhere on the runway.

If repeated approaches stop being fun, offer assisted recovery once the aircraft enters the friendly approach corridor. This still brings the jet down visibly and consumes recovery time.

## Teamwork without forcing classes

Everyone initially flies the same SF–35 and can fight. Roles come from loadout choices and moment-to-moment decisions, rather than selecting an obligatory healer or tank.

| Loadout     | Strength                                                            | Tradeoff                                                     |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Interceptor | More air-to-air missiles and cannon ammunition                      | Limited strike capacity.                                     |
| Strike      | Guided ground weapons for marked objectives                         | Fewer air-to-air missiles.                                   |
| Support     | Target designation and a short defensive electronic-warfare ability | Less offensive ammunition; abilities have visible cooldowns. |

The first playable slice uses one general-purpose loadout. Add specialized loadouts only after all pilots can complete the basic mission. Solo and two-player teams must never fail because they lack a required role.

### Moments worth coordinating

- **Clear my tail:** a pilot requests help; their pursuer is marked for the squadron. A teammate can intercept while the threatened pilot evades.
- **Cover the run:** strike pilots line up on an objective while wingmen occupy defending fighters. Players may swap responsibilities at any time.
- **Shared designation:** one pilot identifies an objective and shares its marker. Teammates still need weapon range and a valid firing opportunity; designation is not a guaranteed hit through terrain.
- **Bring them home:** a damaged pilot heads for Haven while friends escort them. Recovering the aircraft grants a shared bonus.
- **Split and regroup:** two objectives can be handled in parallel, with a shared rally point and enough time to reunite before the next encounter.

A contextual ping wheel offers **Attack this**, **Cover me**, **Regroup**, **Returning to base** and **Need support**. Callsign labels, target ownership cues and shared objective markers work without voice chat. Avoid obscuring targets with four overlapping HUD markers.

## Combat pacing and readability

Keep Easy mode, target follow, the lead marker and forgiving acquisition. New players should get a useful shot in the first minute after reaching the engagement. Opening enemies are readable and slow enough to catch; tougher opponents arrive after the team succeeds.

Enemies use clear encounter identities: patrol pairs, strike escorts, interceptors, drone groups and occasional named aces. Waves are paced around objectives and team readiness, rather than spawning endlessly on top of players. The first slice caps the encounter at four active enemy fighters.

Dogfights have cannon range, missile locks, threats and countermeasures, but no intricate cockpit procedure. Strike objectives are visually distinct and easy to confirm: a radar dish, generator or marked military installation. Friendly transports and settlements use consistent colors and receive explicit identification.

Co-op friendly fire is off by default. Team aircraft cannot destroy each other by accidental contact. Credit is shared: kills matter, but assists, transport protection, designations, objectives and recovery also appear in the debrief. There is no last-hit contest for upgrades.

## Campaign operations

| Operation                | Opening                                                     | Mid-mission change                                                                            | Result                                                                                |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **01 — First Light**     | Take off from Haven and rendezvous with a relief transport. | A patrol intercepts it; after the dogfight, a relay must be disabled to open the corridor.    | First supply route restored.                                                          |
| **02 — Narrow Passage**  | Escort a convoy along Azure Coast.                          | Wren identifies a coastal threat while fighters arrive from the strait.                       | Coast traffic returns; two tasks can be split between wingmen.                        |
| **03 — Crown of Clouds** | Find a relay on the mountain spine.                         | Poor visibility gives way to a patrol and the first encounter with Glass.                     | Shared designation and navigation become useful.                                      |
| **04 — Solstice Run**    | Escort a repair flight to the isolated island.              | A returning teammate reports an enemy interception behind the squadron.                       | Solstice becomes a forward recovery airfield.                                         |
| **05 — Broken Signal**   | Strike Northwatch's relay defenses.                         | Interceptors respond while two objective sites become available.                              | The squadron can divide into pairs; Meridian loses part of its network.               |
| **06 — Homeward**        | Respond to a distress call away from base.                  | A second call reveals an attack on Haven's supply flight.                                     | Players choose the order of rescue and defense; partial success produces a follow-up. |
| **07 — Glass Horizon**   | Pursue Glass across restored regions.                       | His wingmen separate and try to pull the squadron apart.                                      | A team dogfight with a recognizable rival.                                            |
| **08 — Open Skies**      | Launch a final coordinated operation on the central relay.  | Choose to preserve the relays while defeating defenders, or destroy the control hub directly. | Haven's ending reflects the chosen recovery strategy.                                 |

These are mission concepts, not eight tasks for the first implementation. Author First Light fully before creating the rest.

## First playable mission: First Light

**Room:** 1–4 pilots. **Home:** Haven. **Destination:** the Azure Coast corridor, then a nearby relay objective and return to Haven. **Goal:** prove the complete social sortie loop with existing combat types.

1. Host chooses First Light. Friends join, pick callsigns and ready up. Everybody sees the same briefing and squadron list.
2. Spawn in separated parking bays at Haven; follow runway clearance and take off. The mission waits for the squadron or a short readiness timeout, rather than silently leaving a slow beginner behind.
3. Meet a relief transport at a visible rally marker. Escort progress pauses until at least one pilot reaches it. The first transport can be a clearly labeled placeholder, but must not be presented as a finished cargo model.
4. Spawn two hostile fighters, increasing to four for larger teams. The opening patrol provides a clean first engagement. All clients see consistent targets, damage, deaths and objective progress.
5. Once the transport is safe, mark one radar/relay target. Pilots cover each other and destroy it. Every default loadout can damage this first objective.
6. Give a return-to-Haven marker and landing assistance. Record objective success now; collect recovery bonuses for pilots who land or use assisted recovery.
7. Show a shared debrief, mark the supply route restored and return to preparation. Replaying the mission resets its entities and ammunition cleanly.

**Minimum success:** transport survives and relay is disabled. **Optional awards:** every pilot recovered, transport undamaged, no aircraft lost. **Fail:** transport destroyed or all pilots unavailable after recovery opportunities. A single pilot's death or disconnection does not automatically fail the team.

### Death, join and disconnect rules

- A downed pilot can spectate a wingman, then relaunch from a friendly base after a proposed 20–30 second recovery interval. The interval is tuning, not a hard simulator rule.
- The first slice may offer a clearly labeled beginner reinforcement spawn near the rally point; experienced rooms can require runway relaunch. No ordinary teleport command during combat.
- Joining in progress uses the next safe reinforcement window. New pilots do not appear inside another jet or in the middle of a missile impact.
- A reconnect restores the room identity when possible. Do not leave a disconnected aircraft invulnerable or firing forever.
- The world continues while a player opens Settings. Multiplayer menus release local controls; they do not pause the squadron.

## Shared progression and replay

Campaign progress belongs to the room's squadron save. Visitors receive personal mission completion and cosmetic rewards, without overwriting their own squadron's campaign. Mission voting lets a group replay any unlocked operation.

Initially unlock liveries, callsign patches and optional loadout alternatives. Avoid permanent damage/health upgrades that make friends at different progression levels incompatible. Campaign encounters scale to team size and can lower pressure after repeated losses.

Between missions, the host can choose a structured campaign operation or free patrol. Patrol offers optional encounters and return-to-base servicing; it does not silently alter the campaign chapter.

## Later competitive mode: Air Corridor

After co-op is solid, offer a separate **4v4 objective match**. Two temporary rival squadrons operate from different airfields, protect their own supply flight and contest relay sites. Objective play earns a shared score; fighter kills create opportunities rather than being the only route to victory.

Short matches should have protected departure/recovery areas and no scoring for camping a runway. The exact base locations need a map pass; do not force both teams onto the existing Haven runway. Competitive ratings, ranked matchmaking and public large-scale persistent worlds are outside the first release.

## Implementation boundaries for next time

The current game is browser-local and begins airborne. Its generated model has retracted gear, no animated surfaces and no ground-contact setup. Multiplayer and the runway loop both need actual implementation; a story document does not make the existing simulation network-ready.

Recommended sequence:

1. **Runway prototype, one player:** ground steering, braking, visible gear, liftoff, stable landing, service zone and optional assistance. Prove taxi → takeoff → fly → land → rearm before adding a network.
2. **Two-player room:** join/leave, names, shared world seed, player motion, runway spawn slots and clean disconnect behavior. Keep the first network encounter small.
3. **Shared combat:** synchronized targets, weapons, damage, countermeasures and mission state, with one trusted session authority determining outcomes. Rendering origin remains local to each client; gameplay positions refer to the shared world.
4. **First Light:** escort → dogfight → relay strike → return, with shared debrief and repeatable reset. Grow from two clients to four only after consistency is demonstrated.
5. **Polish and expansion:** pings, recovery, mission voting, loadouts, more campaign chapters, then objective PvP.

Before choosing network packages or hosting, research current options and decide whether rooms use a dedicated service or a trusted host. Browser rendering, server simulation and persistence boundaries need a separate technical implementation plan. Do not start with an MMO or migrate rendering APIs as part of this slice.

### Acceptance gates

- A beginner can launch, contribute a hit and recover using the default controls.
- Two players can complete First Light together from runway to debrief.
- Players agree on destroyed targets, transport health and mission outcome.
- Friends cannot accidentally collide during preparation or steal progression through last hits.
- A late join and a disconnect do not leave the mission permanently stuck.
- No duplicate projectiles, stale mission entities or ammunition carryover after a replay.
- Four clients remain playable under realistic latency; performance and network budgets are measured on identified machines, not assumed.

## The moment to build toward

The squadron taxis out at sunset. Anchor clears Stratos Flight to launch. A transport's distress call interrupts the quiet crossing. Two friends turn to intercept; the others stay with the relief flight. Later, one jet returns trailing smoke, with a wingman above it and runway lights ahead. The team lands, the supply route turns green on the map, and someone asks: “One more sortie?”
