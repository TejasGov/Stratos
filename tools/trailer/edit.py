"""Cut the captured shots into the trailer: 16:9 1080p master, 9:16 vertical cut, stills.

    python tools/trailer/edit.py <frames-dir> <music.mp3> <out-dir>

Shots come from tools/trailer/capture.ts (30 fps JPEG sequences per shot). Cuts follow the
music's structure (quiet intro to 0:16, drums from 0:16, the big hit at 0:32, final boom ~0:62).
"""
import os
import subprocess
import sys

frames, music, out = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
FPS = 30
AUDIO = os.path.join(os.path.dirname(__file__), "..", "..", "public", "assets", "audio")
FONT = "C\\:/Windows/Fonts/bahnschrift.ttf"

# (shot, first second used within the shot, seconds on screen)
CUT = [
    ("01-dawn", 0.0, 5.0),
    ("02-soldiers", 0.0, 4.0),
    ("03-crew", 0.0, 3.0),
    ("04-takeoff", 0.0, 4.0),
    ("05-valley", 0.0, 4.0),
    ("06-clouds", 0.0, 3.0),
    ("07-storm", 0.0, 3.0),
    ("08-sam", 0.0, 4.0),
    ("09-supersonic", 1.5, 2.0),
] + [(f"10-fleet-{i}", 0.0, 1.0) for i in range(1, 10)] + [
    ("11-cobra", 0.0, 3.0),
    ("12-wingmen", 0.0, 4.0),
    ("13-blackridge", 0.0, 3.0),
    ("14-airkill", 0.0, 2.0),
    ("15-space", 0.0, 4.0),
]
TITLE = 5.5  # seconds of title card after the last shot

# Concat list: every frame shown for 1/30 s.
listing = os.path.join(out, "frames.txt")
starts, t = {}, 0.0
with open(listing, "w", encoding="utf-8") as f:
    for shot, skip, seconds in CUT:
        starts[shot] = t
        first = round(skip * FPS)
        for i in range(first, first + round(seconds * FPS)):
            path = os.path.join(frames, shot, f"{i:05d}.jpg").replace("\\", "/")
            if not os.path.exists(path):
                raise SystemExit(f"missing frame {path}")
            f.write(f"file '{path}'\nduration {1 / FPS:.6f}\n")
        t += seconds
    f.write(f"file '{path}'\n")
body = t
total = body + TITLE
print(f"picture {body:.1f} s + title {TITLE} s = {total:.1f} s")


def text(s, size, y, start, end, alpha_in=0.25):
    """Centred caption with fades; y is a drawtext expression."""
    a = f"if(lt(t,{start}+{alpha_in}),(t-{start})/{alpha_in},if(gt(t,{end}-0.3),({end}-t)/0.3,1))"
    return (
        f"drawtext=fontfile='{FONT}':text='{s}':fontsize={size}:fontcolor=white:"
        f"x=(w-text_w)/2:y={y}:alpha='{a}':enable='between(t,{start},{end})'"
    )


captions = [
    ("FROM THE WAVETOPS", 1.0, 4.4),
    ("THROUGH THE STORM", starts["07-storm"] + 0.3, starts["08-sam"] - 0.1),
    ("NINE AIRCRAFT", starts["10-fleet-1"] + 0.1, starts["10-fleet-5"]),
    ("UP TO MACH 2.25", starts["10-fleet-5"] + 0.1, starts["11-cobra"] - 0.1),
    ("TO THE EDGE OF SPACE", starts["15-space"] + 0.4, body - 0.1),
]
grade = "eq=contrast=1.08:saturation=1.12:gamma=0.97,vignette=PI/5"


def picture(vertical):
    chain = [grade]
    if vertical:
        chain.append("crop=608:ih,scale=1080:1920:flags=lanczos,setsar=1")
        cap_y, size = "h*0.72", 72
    else:
        # 2.39:1 letterbox for the cinema look.
        chain.append("drawbox=x=0:y=0:w=iw:h=138:color=black:t=fill,drawbox=x=0:y=ih-138:w=iw:h=138:color=black:t=fill")
        cap_y, size = "h-138-text_h-46", 54
    chain += [text(s, size, cap_y, a, b) for s, a, b in captions]
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


def sfx():
    """Game sounds under the music: burner light, the sonic boom on the hit, explosions."""
    hits = [
        ("burner-light.mp3", starts["04-takeoff"] + 0.1, 0.55),
        ("sonic-boom.mp3", starts["09-supersonic"] + 1.2, 0.8),
        ("explosion.mp3", starts["13-blackridge"] + 1.1, 0.8),
        ("explosion.mp3", starts["14-airkill"] + 0.5, 0.6),
    ]
    inputs, chains = [], []
    for i, (name, at, gain) in enumerate(hits):
        inputs += ["-i", os.path.join(AUDIO, name)]
        ms = int(at * 1000)
        chains.append(f"[{i + 2}:a]volume={gain},adelay={ms}|{ms}[s{i}]")
    mix = "".join(f"[s{i}]" for i in range(len(hits)))
    chains.append(f"[1:a]afade=t=out:st={total - 1.5}:d=1.5[m];[m]{mix}amix=inputs={len(hits) + 1}:normalize=0,alimiter=limit=0.95[a]")
    return inputs, ";".join(chains)


def render(vertical, name):
    inputs, audio = sfx()
    graph = (
        f"[0:v]{picture(vertical)},format=yuv420p[body];"
        f"{title(vertical)},format=yuv420p[title];"
        f"[body][title]concat=n=2:v=1:a=0[v];{audio}"
    )
    cmd = (
        ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-i", music]
        + inputs
        + ["-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", f"{total:.2f}",
           "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", str(FPS),
           "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", os.path.join(out, name)]
    )
    subprocess.run(cmd, check=True)
    print("wrote", name)


render(False, "stratos-trailer-1080p.mp4")
render(True, "stratos-trailer-vertical.mp4")
for i, (shot, frame) in enumerate([("01-dawn", 60), ("07-storm", 45), ("10-fleet-5", 20), ("11-cobra", 40), ("13-blackridge", 45), ("15-space", 90)]):
    src = os.path.join(frames, shot, f"{frame:05d}.jpg")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", grade, "-q:v", "2", os.path.join(out, f"still-{i + 1}-{shot}.jpg")], check=True)
print("done")
