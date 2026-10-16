# Haven Control

The voice on the radio: one officer at Haven, callsign for the player **Kestrel**. Lines were voiced
with **ElevenLabs v4** (`eleven_v4`) using the library voice **Eryn – Strong Female Military
Commander**, directed with inline audio tags. Two takes were generated per line and the take was
checked with a speech-to-text pass against the script; files are trimmed, loudness-matched to
about −19 LUFS with a −1 dB limiter and stored as 80 kbps mono MP3. In game they run through a
compressed, band-limited radio chain (300 Hz–3.4 kHz, light saturation) with a squelch click
either side and carrier static underneath; the engine and wind beds duck while she talks. The
link gets rougher in storms and at altitude, with the odd dropout where the signal breaks up
(never over the closing words), and the crash call goes out over a failing link.

| File | When | Performance prompt |
| --- | --- | --- |
| `takeoff.mp3` | Free flight starts | [warmly] Kestrel, Haven Control. You're off the deck and the sky's all yours. [chuckles] Try to bring the jet back in one piece this time. |
| `ascent.mp3` | Ascent challenge starts | [excited] Kestrel, you're cleared for the climb. Full burner, nose up, and don't stop until the sky goes black. I've got the stopwatch running. |
| `tropopause.mp3` | Passing 11 km | Passing the tropopause. Air's getting thin up there, Kestrel. She'll feel light on the stick, so keep it smooth. |
| `stratosphere.mp3` | Passing 20 km | [impressed] Twenty thousand meters. [short pause] Nobody in this squadron's been that high all year. Keep going. |
| `edge.mp3` | Passing 30 km | [softly] Thirty thousand... [pause] Kestrel, take a second and look outside. That's the curve of the world. [warmly] Beautiful flying. |
| `mach-one.mp3` | Sonic boom | [laughs] There's the boom! We heard that one all the way down here. Mach one, Kestrel. |
| `intercept.mp3` | Intercept sortie | [serious] Kestrel, three bandits inbound from the north, low and fast. You're weapons free. Stop them before they reach the coast. |
| `escort.mp3` | Escort sortie | Transport's wheels up. Stay on her wing, Kestrel. She can't take a hit, and she's got people aboard. [firmly] Nobody touches her. |
| `strike.mp3` | Strike sortie | There's a radar site on the coast, and it's got fighters watching over it. [determined] Take out that dish, Kestrel, and their whole coastline goes dark. |
| `missile.mp3` | Missile inbound | [shouting] Missile, missile! Break hard, Kestrel! Flares, NOW! |
| `first-kill.mp3` | First kill of a sortie | [excited] Splash one! Good kill, Kestrel. |
| `kill.mp3` | Later kills | That's another one down. [focused] Stay sharp, they're regrouping. |
| `clear.mp3` | Sortie complete | [exhales] Airspace is clear. [warmly] Nicely done, Kestrel. Take a breath, then bring it home. |
| `escort-lost.mp3` | Transport destroyed | [sad] We lost the transport... [pause] Disengage, Kestrel. Come home. |
| `damaged.mp3` | Hull below 55 % | [worried] Kestrel, you're trailing smoke. Ease off and get clear. That's not a request. |
| `crash.mp3` | Aircraft lost | [nervous] Kestrel? [pause] Kestrel, Haven Control, respond. [long pause] [trembling voice] We've lost contact. |
| `landmark.mp3` | Landmark discovered | [curious] Oh, that's a new one. Logging it on the map. |
| `route-start.mp3` | Gate challenge starts | Gates are lit. One clean line, Kestrel, and the clock starts at the first gate. [playful] No pressure. |
| `route-done.mp3` | Gate challenge complete | [happy] That's a new time on the board. Not bad at all, Kestrel. |

Urgent calls (missile, crash) cut in over chatter; routine calls queue behind whatever is being
said, and each line has a cooldown so it never nags. Terrain warnings are the jet's own
synthesized ground-proximity alarm rather than a voice call, as in a real cockpit. Subtitles
follow the delivered takes, and the radio can be switched off in Settings.
