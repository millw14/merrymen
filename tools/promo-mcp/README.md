# Merrymen × Claude promo (MCP setup)

Source for the 65-second promo that walks through connecting Merrymen to Claude:
open merrymen.dev/claude, Add to Claude, allow permissions, then ask questions in
chat. It also covers the Claude Code one-liner, what Claude can never do, and an
outro.

The whole video is one deterministic HTML timeline (`film.html`). `render(t)` sets
every element for time `t`, so each frame is exact and repeatable. There are no
CSS transitions and no wall-clock timing. The chat data shown on screen is
illustrative and is labelled that way in the frame.

## Render

```bash
npm i playwright@1.56          # uses the preinstalled Chromium
pip install numpy imageio-ffmpeg
export FF=$(python3 -c "import imageio_ffmpeg as i; print(i.get_ffmpeg_exe())")

node stills.mjs 3 14.4 38.6 55.8        # quick stills: st_<t>.jpg
python3 audio.py                         # soundtrack -> music.wav (synced to the cues)

# 65 s × 60 fps = 3900 frames; split across workers, then join
for i in 0 1 2 3 4 5; do node render.mjs $((i*650)) $(((i+1)*650)) seg$i.mp4 60 & done; wait
for i in 0 1 2 3 4 5; do echo "file 'seg$i.mp4'"; done > list.txt
$FF -f concat -safe 0 -i list.txt -i music.wav -map 0:v -map 1:a -c:v copy \
    -c:a aac -b:a 256k -shortest -movflags +faststart merrymen-mcp-claude.mp4
```

Scene timings are listed in `SC` in `film.html`. Audio cues (clicks, typing,
whooshes, impacts) are hard-coded to the same times in `audio.py`. If you move a
scene, move its cues too.

Fonts: DM Sans, JetBrains Mono and Source Serif 4 (SIL Open Font License).
