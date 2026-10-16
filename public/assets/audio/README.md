# Audio

Sound effects generated for Stratos with **ElevenLabs Sound Effects v2** (`eleven_text_to_sound_v2`),
four variations each; the take listed here was chosen by loop-seam continuity, level stability,
attack and spectral balance, then mastered (equal-power loop crossfade, RMS or peak normalisation,
fades). Loops are 22.05 kHz mono WAV because MP3 encoder padding breaks gapless looping in Web Audio;
one-shots are 96 kbps MP3.

| File | Prompt | Notes |
| --- | --- | --- |
| `engine.wav` | Fighter jet turbofan engine at steady cruise, deep continuous rumble with a high turbine whine, heard from behind the aircraft | seamless loop, pitch follows throttle and airspeed |
| `afterburner.wav` | Fighter jet afterburner, continuous thunderous crackling roar of burning exhaust, very powerful low end | seamless loop, muffled past Mach 1 |
| `wind.wav` | Strong steady wind rushing past at high speed, airflow roar over a smooth metal surface, no gusts | seamless loop, level and pitch follow airspeed |
| `rain.wav` | Heavy rain drumming on an aircraft canopy, dense steady downpour, close-mic | seamless loop beneath storm cells |
| `sonic-boom.mp3` | Sonic boom outdoors, sharp double crack like two cannon shots then a deep rolling rumble fading away | |
| `thunder-near.mp3` | Very close lightning strike, violent ripping crack of thunder followed by a heavy booming rumble | strikes within 3.5 km |
| `thunder-far.mp3` | Distant thunder rolling slowly across a wide sky, deep low rumble with soft echoes | further strikes, low-passed by distance |
| `cannon.wav` | Aircraft rotary cannon firing one short burst, extremely rapid mechanical buzzing brrrt | sustained middle of the burst, looped while firing |
| `missile.mp3` | Air-to-air missile launch, rocket motor ignition with a fierce whoosh accelerating away | trimmed and faded |
| `explosion.mp3` | Mid-air explosion of a fighter jet, deep heavy boom with metal debris and a fiery whoosh | |

Every layer has a synthesized Web Audio fallback, so the game still sounds right if a file fails to load.
Lock and missile-warning tones stay synthesized by design.
