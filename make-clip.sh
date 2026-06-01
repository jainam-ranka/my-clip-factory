#!/bin/bash

# Usage: ./make-clip.sh [URL] [START] [END] [TITLE]
URL=$1
START=$2
END=$3
TITLE=$4

if [ -z "$TITLE" ]; then TITLE="clip_$(date +%s)"; fi

echo "📥 STATION 1: Downloading..."
# We download to a temporary file first
yt-dlp --download-sections "*$START-$END" -f mp4 -o "public/raw-video.mp4" "$URL"

echo "🛠️ STATION 1.5: Sanitizing Video for Remotion..."
# This converts the messy Twitter format into a "Web-Safe" MP4
ffmpeg -y -i public/raw-video.mp4 -c:v libx264 -pix_fmt yuv420p -c:a aac public/input-video.mp4

echo "👂 STATION 2: Transcribing..."
# Pointing directly to the absolute path of your home folder
~/whisper.cpp/main -m ~/whisper.cpp/models/ggml-base.en.bin -f public/input-video.mp4 -ojf src/subtitles.json

echo "🎬 STATION 3: Baking Video..."
npx remotion render MyComposition out/"$TITLE".mp4

echo "✅ DONE! Check out/$TITLE.mp4"