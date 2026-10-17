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
| `sonic-boom.mp3` | Cinematic sonic boom, a massive sharp double crack that hits like a trailer impact, deep sub-bass drop, then a huge rolling thunder rumble across a valley fading out | replaced in iteration 6; 5 ms fade-in, 1.5 s tail fade, −1 dB peak |
| `thunder-near.mp3` | Very close lightning strike, violent ripping crack of thunder followed by a heavy booming rumble | strikes within 3.5 km |
| `thunder-far.mp3` | Distant thunder rolling slowly across a wide sky, deep low rumble with soft echoes | further strikes, low-passed by distance |
| `cannon.wav` | Aircraft rotary cannon firing one short burst, extremely rapid mechanical buzzing brrrt | sustained middle of the burst, looped while firing |
| `missile.mp3` | Air-to-air missile launch, rocket motor ignition with a fierce whoosh accelerating away | trimmed and faded |
| `explosion.mp3` | Mid-air explosion of a fighter jet, deep heavy boom with metal debris and a fiery whoosh | |
| `rush.wav` | Cinematic high-speed air rush for a fighter jet, deep powerful wind roar and pressure buffeting around the cockpit, low sub-bass rumble underneath, intense and continuous, movie trailer sound design | loop built from the steady 2.8–10 s of the take, smoothed with dynaudnorm, 1 s equal-power seam; fades in from 170 to 380 m/s |
| `supersonic.wav` | Supersonic flight inside a fighter cockpit, eerie muffled deep sub-bass rumble with a distant howling airflow, the engine sound left behind, tense cinematic drone | loop, 0.5 s seam; takes over from Mach 0.98 to 1.35 |
| `burner-light.mp3` | Fighter jet afterburner ignition, a deep powerful whump and thunderous roar kicking in, cinematic punch, short | plays as the burner lights |

Every layer has a synthesized Web Audio fallback, so the game still sounds right if a file fails to load.
Lock and missile-warning tones stay synthesized by design, as do the flare salvo (dispenser
thumps, then a sputtering magnesium fizz) and the radio's squelch, static and dropouts: the
ElevenLabs credits had run out by the time those were added.
