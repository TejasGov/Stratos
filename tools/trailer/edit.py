"""Cut the captured shots into the trailer: 16:9 1080p master, 9:16 vertical cut, stills.

    python tools/trailer/edit.py <frames-dir> <music.mp3> <out-dir>

Shots come from tools/trailer/capture.ts (30 fps JPEG sequences per shot). Cuts follow the
music's structure (quiet intro to 0:16, drums from 0:16, the big hit at 0:32, final boom ~0:62).
"""
import os
import subprocess
import sys

frames, music, out = sys.argv[1], sys.argv[2], os.path.abspath(sys.argv[3])
os.makedirs(out, exist_ok=True)
FPS = 30
ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "public", "assets")
AUDIO = os.path.join(ROOT, "audio")
FONT = "C\\:/Windows/Fonts/bahnschrift.ttf"
BEAT = 60 / 128
BOOM_FRAME = 67  # 09-supersonic crosses Mach 1 at 2.23 s (capture is deterministic)
MACH1_FIRST = 36  # the cut opens 1.2 s in, so the boom comes 1 s into it
FLEET = ["SF-35 WRAITH", "S-57 VORTEX", "AF-22 TALON", "J-20X DRAGON", "S-30 MONARCH",
         "R-4 MISTRAL", "EF-2 CYCLONE", "LC-1 SURYA", "M-21 ARROW"]
GRID = 5.0  # seconds the fleet grid is on screen

# (shot, first frame used, frames on screen); "grid" is the composited fleet.
CUT = [
    ("01-dawn", 0, 150),
    ("02-soldiers", 0, 120),
    ("03-crew", 0, 90),
    ("04-takeoff", 0, 120),
    ("05-valley", 0, 120),
    ("06-weather-clear", 0, 45),
    ("06-weather-fair", 0, 45),
    ("06-weather-towering", 0, 45),
    ("07-storm", 0, 90),
    ("08-sam", 0, None),  # fills up to the Mach 1 boom landing on the music's big hit
    ("09-supersonic", MACH1_FIRST, 120),
    ("grid", 0, round(GRID * FPS)),
    ("11-cobra", 0, 90),
    ("12-wingmen", 0, 150),
    ("13-blackridge", 0, 90),
    ("14-airkill", 0, 60),
    ("15-space", 0, 150),
]
SAM = [s for s, _, _ in CUT].index("08-sam")
CUT[SAM] = ("08-sam", 0, 32 * FPS - (BOOM_FRAME - MACH1_FIRST) - sum(n for _, _, n in CUT[:SAM]))
TITLE = 5.5  # seconds of title card after the last shot

starts, t = {}, 0
for shot, _, n in CUT:
    starts[shot] = t / FPS
    t += n
body = t / FPS
total = body + TITLE
print(f"picture {body:.2f} s + title {TITLE} s = {total:.2f} s; boom at {starts['09-supersonic'] + (BOOM_FRAME - MACH1_FIRST) / FPS:.2f} s")


def text(s, size, y, start, end, alpha_in=0.25, x="(w-text_w)/2"):
    """Caption with fades; x and y are drawtext expressions."""
    a = f"if(lt(t,{start}+{alpha_in}),(t-{start})/{alpha_in},if(gt(t,{end}-0.25),({end}-t)/0.25,1))"
    return (
        f"drawtext=fontfile='{FONT}':text='{s}':fontsize={size}:fontcolor=white:"
        f"x={x}:y={y}:alpha='{a}':enable='between(t,{start},{end})'"
    )


def grid(vertical):
    """Composites the nine fleet orbits into a 3x3 grid, tiles popping in on the beat."""
    d = os.path.join(out, "_grid-v" if vertical else "_grid")
    os.makedirs(d, exist_ok=True)
    if vertical:
        # Laid out in the 608 px centre column that the vertical crop keeps.
        tw = th = 192
        gap, x0, y0, label = 6, 656 + 8, (1080 - 3 * 192 - 12) // 2, 13
        fit = f"scale=-2:{th},crop={tw}:{th}"
    else:
        # Inside the 2.39:1 letterbox.
        tw, th, gap = 448, 252, 10
        x0, y0, label = (1920 - 3 * tw - 2 * gap) // 2, 138 + (804 - 3 * th - 2 * gap) // 2, 22
        fit = f"scale={tw}:{th}"
    inputs, chains = [], [f"color=c=black:s=1920x1080:r={FPS}:d={GRID}[g0]"]
    for i, name in enumerate(FLEET):
        inputs += ["-framerate", str(FPS), "-i", os.path.join(frames, f"10-fleet-{i + 1}", "%05d.jpg")]
        at = round(i * BEAT, 3)
        chains.append(
            f"[{i}:v]{fit},setsar=1,fade=t=in:st={at}:d=0.15,"
            + text(name, label, f"h-{label}-8", at + 0.1, GRID + 1, 0.2, "10")
            + f"[t{i}]"
        )
        x, y = x0 + (i % 3) * (tw + gap), y0 + (i // 3) * (th + gap)
        chains.append(f"[g{i}][t{i}]overlay={x}:{y}:shortest=1[g{i + 1}]")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y"] + inputs
        + ["-filter_complex", ";".join(chains), "-map", "[g9]", "-frames:v", str(round(GRID * FPS)),
           "-q:v", "2", "-start_number", "0", os.path.join(d, "%05d.jpg")],
        check=True,
    )
    return d


def listing(vertical):
    """Concat list: every frame shown for 1/30 s."""
    path = os.path.join(out, "frames-v.txt" if vertical else "frames.txt")
    grid_dir = grid(vertical)
    with open(path, "w", encoding="utf-8") as f:
        for shot, first, n in CUT:
            src = grid_dir if shot == "grid" else os.path.join(frames, shot)
            for i in range(first, first + n):
                frame = os.path.join(src, f"{i:05d}.jpg").replace("\\", "/")
                if not os.path.exists(frame):
                    raise SystemExit(f"missing frame {frame}")
                f.write(f"file '{frame}'\nduration {1 / FPS:.6f}\n")
        f.write(f"file '{frame}'\n")
    return path


def cut_end(shot):
    i = [s for s, _, _ in CUT].index(shot)
    return starts[CUT[i + 1][0]] if i + 1 < len(CUT) else body


# (text, start, end, in the letterbox bar)
captions = [
    ("FROM THE WAVETOPS", 1.0, 4.4, False),
    ("CLEAR SKIES", starts["06-weather-clear"] + 0.05, cut_end("06-weather-clear") - 0.02, False),
    ("SCATTERED CUMULUS", starts["06-weather-fair"] + 0.05, cut_end("06-weather-fair") - 0.02, False),
    ("TOWERING CUMULUS", starts["06-weather-towering"] + 0.05, cut_end("06-weather-towering") - 0.02, False),
    ("THUNDERSTORMS", starts["07-storm"] + 0.05, cut_end("07-storm") - 0.1, False),
    ("MACH 1", starts["09-supersonic"] + (BOOM_FRAME - MACH1_FIRST) / FPS, cut_end("09-supersonic") - 0.1, False),
    ("NINE AIRCRAFT", starts["grid"] + 0.3, starts["grid"] + 2.6, True),
    ("UP TO MACH 2.25", starts["grid"] + 2.7, cut_end("grid") - 0.1, True),
    ("TO THE EDGE OF SPACE", starts["15-space"] + 0.6, body - 0.1, False),
]
grade = "eq=contrast=1.08:saturation=1.12:gamma=0.97,vignette=PI/5"


def picture(vertical):
    chain = [grade]
    if vertical:
        chain.append("crop=608:ih,scale=1080:1920:flags=lanczos,setsar=1")
        y, bar_y, size = "h*0.72", "h*0.84", 72
    else:
        # 2.39:1 letterbox for the cinema look.
        chain.append("drawbox=x=0:y=0:w=iw:h=138:color=black:t=fill,drawbox=x=0:y=ih-138:w=iw:h=138:color=black:t=fill")
        y, bar_y, size = "h-138-text_h-46", "h-138+(138-text_h)/2", 54
    chain += [text(s, size, bar_y if bar else y, a, b, min(0.25, (b - a) / 4)) for s, a, b, bar in captions]
    # Fade to black into the title card.
    chain.append(f"fade=t=out:st={body - 0.6}:d=0.6")
    return ",".join(chain)


def title(vertical):
    w, h = (1080, 1920) if vertical else (1920, 1080)
    big, small = (190, 44) if vertical else (200, 40)
    return (
        f"color=c=black:s={w}x{h}:r={FPS}:d={TITLE},"
        + text("STRATOS", big, "(h-text_h)/2-40", 0.2, TITLE - 0.05, 0.6)
        + ","
        + text("FROM THE WAVETOPS TO THE EDGE OF SPACE", small, "(h/2)+90", 1.0, TITLE - 0.05, 0.6)
        + ","
        + text("PLAY FREE IN YOUR BROWSER", small, "(h/2)+150", 2.2, TITLE - 0.05, 0.6)
    )


def sound():
    """Music ducked under Citadel on the radio, with game sounds on the hits."""
    hits = [
        ("burner-light.mp3", starts["04-takeoff"] + 0.1, 0.55),
        ("sonic-boom.mp3", starts["09-supersonic"] + (BOOM_FRAME - MACH1_FIRST) / FPS - 0.05, 0.9),
        ("explosion.mp3", starts["13-blackridge"] + 1.1, 0.8),
        ("explosion.mp3", starts["14-airkill"] + 0.5, 0.6),
    ]
    brief = os.path.join(ROOT, "voice", "war.mp3")
    # "Kestrel, this is Citadel. Operation Iron Dawn is go. Viper Two and Viper Three will join
    # your wing once you're airborne." (0-8.0 s), then "Good hunting." (13.65-14.5 s) on the title.
    radio = [(brief, 0.0, 8.0, starts["11-cobra"] + 0.2), (brief, 13.65, 14.5, body + 0.8)]
    inputs, chains, n = [], [], 2
    for name, at, gain in hits:
        inputs += ["-i", os.path.join(AUDIO, name)]
        ms = int(at * 1000)
        chains.append(f"[{n}:a]volume={gain},adelay={ms}|{ms}[s{n}]")
        n += 1
    voices = []
    for name, a, b, at in radio:
        inputs += ["-i", name]
        ms = int(at * 1000)
        chains.append(
            f"[{n}:a]atrim={a}:{b},asetpts=PTS-STARTPTS,highpass=f=260,lowpass=f=4200,"
            f"volume=3.5,aformat=channel_layouts=stereo,adelay={ms}|{ms}[v{n}]"
        )
        voices.append(f"[v{n}]")
        n += 1
    sfx = "".join(f"[s{i}]" for i in range(2, 2 + len(hits)))
    chains.append(f"{''.join(voices)}amix=inputs={len(voices)}:normalize=0,asplit[voice][key]")
    chains.append(f"[1:a]afade=t=out:st={total - 1.5}:d=1.5[m0]")
    chains.append("[m0][key]sidechaincompress=threshold=0.05:ratio=2.5:attack=30:release=600[m]")
    chains.append(f"[m]{sfx}[voice]amix=inputs={len(hits) + 2}:normalize=0,alimiter=limit=0.95[a]")
    return inputs, ";".join(chains)


def render(vertical, name):
    inputs, audio = sound()
    graph = (
        f"[0:v]{picture(vertical)},format=yuv420p[body];"
        f"{title(vertical)},format=yuv420p[title];"
        f"[body][title]concat=n=2:v=1:a=0[v];{audio}"
    )
    cmd = (
        ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing(vertical), "-i", music]
        + inputs
        + ["-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", f"{total:.2f}",
           "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS),
           "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", os.path.join(out, name)]
    )
    subprocess.run(cmd, check=True)
    print("wrote", name)


render(False, "stratos-trailer-1080p.mp4")
render(True, "stratos-trailer-vertical.mp4")
stills = [("01-dawn", 60), ("06-weather-towering", 20), ("07-storm", 45), ("09-supersonic", 80),
          ("_grid", 149), ("11-cobra", 40), ("13-blackridge", 45), ("15-space", 90)]
for i, (shot, frame) in enumerate(stills):
    src = os.path.join(out if shot == "_grid" else frames, shot, f"{frame:05d}.jpg")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", grade, "-q:v", "2",
                    os.path.join(out, f"still-{i + 1}-{shot.strip('_')}.jpg")], check=True)
print("done")
