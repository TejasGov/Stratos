# Stratos — local handoff (iteration 6 "theatre")

The cloud session was paused here so work can continue on a desktop machine.
Read these in order:

1. [PROGRESS.md](PROGRESS.md) — what is done, merged and pushed.
2. [IN_PROGRESS.md](IN_PROGRESS.md) — four features paused mid-task on `wip/iter6-*` branches, how far each got, and how to finish and merge them.
3. [TODO.md](TODO.md) — everything still to build, in order, with specs you can paste into a Claude session.
4. [RESOURCES.md](RESOURCES.md) — branches, credits, tools, commands, asset paths, gotchas.

## Quick start on your machine

```bash
git clone https://github.com/TejasGov/Stratos.git && cd Stratos
git checkout stratos/iteration-6-theatre
npm ci
npm run dev          # http://127.0.0.1:5173  (append ?debug for window.stratos)
npm test             # node:test via tsx
npm run build        # tsc --noEmit && vite build
```

Then fetch the paused work:

```bash
git fetch origin 'refs/heads/wip/*:refs/remotes/origin/wip/*'
git branch -r | grep wip/iter6
```

## The request being implemented (from the user)

1. A runway where every mission starts.
2. A home base, and an enemy base for missions that have one.
3. Ground SAMs in enemy missions: heat-seeking, triggered by proximity, SAM type and radar; stealthier jets are detected later.
4. A cobra manoeuvre, with an airbrake and engine-off control.
5. Twin-engine jets steer with single-engine thrust; missile hits fail one engine, then the other.
6. Realistic flares (sparks and sound).
7. More realistic explosions.
8. Soldiers at the bases (walking in groups, talking, drills/acrobatics, jogging with an instructor, dying depending on mission); never playable. The user wants Mixamo characters (Swat Guy, Steve, David, Pete, Alex, Gas Mask).
9. Then a cinematic trailer: upbeat ElevenLabs music, all aircraft, weather, terrain, manoeuvres, flares, evasion, blasts, space, dawn, soldiers.

Budget guidance from the user: multi-agent work with a model mix, $80 max for agents (ElevenLabs and Meshy excluded).
