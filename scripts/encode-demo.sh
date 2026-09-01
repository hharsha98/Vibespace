#!/usr/bin/env bash
#
# Turns a raw screen recording into the two assets the README needs.
#
# Why this exists as a script rather than a note in the README: the output
# width is the whole point and it is not an obvious number. GitHub renders a
# README's content column at roughly 830-900 CSS pixels. Every Retina laptop
# draws that column at 2x, so an asset narrower than ~1700px is upscaled by
# the display and looks soft no matter how clean the recording was. The first
# demo GIF this repo shipped was 1000px wide, which is exactly why it looked
# blurry on a 14" MacBook Pro. 1800px is the smallest width that survives 2x.
#
# The second reason: GIF. A GIF is capped at 256 colours, which is the worst
# possible format for a terminal UI — anti-aliased text and syntax highlighting
# dither into mush. H.264 has no such limit, so the MP4 below is not merely
# smaller than the equivalent GIF, it is visibly sharper at the same width.
#
# Usage:
#     scripts/encode-demo.sh path/to/recording.mov
#
# Produces:
#     docs/vibespace-demo.mp4        the demo itself
#     docs/vibespace-demo-still.png  a first-frame still
#
# Publishing note — this trips people up. GitHub will NOT play a <video> that
# points at a file committed in this repo; relative sources do not resolve to
# playable media. Video only plays from an uploaded attachment: drag the .mp4
# into a GitHub issue or release, and GitHub hands back a
# https://github.com/user-attachments/assets/... URL that does work in the
# README. The committed PNG is the fallback for every context where video does
# not render at all (npm, mirrors, offline clones, RSS).
set -euo pipefail

SRC="${1:-}"
if [ -z "$SRC" ]; then
  echo "usage: scripts/encode-demo.sh path/to/recording.mov" >&2
  exit 2
fi
if [ ! -f "$SRC" ]; then
  echo "encode-demo: no such file: $SRC" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "encode-demo: ffmpeg not found (brew install ffmpeg)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/docs"
MP4="$OUT_DIR/vibespace-demo.mp4"
PNG="$OUT_DIR/vibespace-demo-still.png"

# `-2` rather than `-1` for the height: H.264 requires even dimensions, and a
# source whose aspect ratio yields an odd height would otherwise fail to encode.
# lanczos because the default bicubic softens exactly the fine text detail this
# whole exercise is about preserving.
SCALE="scale=1800:-2:flags=lanczos"

echo "encoding $SRC -> $MP4"
# yuv420p and profile high are not optional: Safari and iOS refuse to play
# 4:4:4 or 4:2:2 H.264, and a README video that works everywhere except on
# iPhones is a bug report waiting to happen. -an strips audio, which a UI demo
# never needs and which only adds bytes. +faststart moves the moov atom to the
# front so playback can begin before the whole file has downloaded.
ffmpeg -hide_banner -loglevel error -i "$SRC" \
  -vf "$SCALE" \
  -c:v libx264 -profile:v high -crf 20 -preset slow -pix_fmt yuv420p \
  -movflags +faststart \
  -an \
  -y "$MP4"

echo "extracting still -> $PNG"
ffmpeg -hide_banner -loglevel error -i "$SRC" -vf "$SCALE" -frames:v 1 -y "$PNG"

echo
echo "done:"
ls -lh "$MP4" "$PNG" | awk '{print "  " $9 "  " $5}'
echo
echo "next: upload $MP4 to a GitHub release or issue to get its"
echo "      user-attachments URL, then put that URL in the README's <video> tag."
