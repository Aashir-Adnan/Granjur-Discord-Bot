#!/bin/bash
# Generate a "Ready to Record" audio cue using ffmpeg TTS (espeak) or a tone sequence
# Run once on the VM: bash bot/scripts/generate-ready-audio.sh

OUTFILE="bot/assets/ready-to-record.ogg"
mkdir -p bot/assets

# Try espeak first (TTS)
if command -v espeak-ng &> /dev/null; then
  espeak-ng -v en -s 140 -p 50 "Ready to record" --stdout | ffmpeg -y -i - -c:a libopus -b:a 64k "$OUTFILE"
  echo "Generated $OUTFILE using espeak-ng TTS"
elif command -v espeak &> /dev/null; then
  espeak -v en -s 140 -p 50 "Ready to record" --stdout | ffmpeg -y -i - -c:a libopus -b:a 64k "$OUTFILE"
  echo "Generated $OUTFILE using espeak TTS"
else
  # Fallback: generate a pleasant 3-tone chime
  ffmpeg -y \
    -f lavfi -i "sine=frequency=523:duration=0.2" \
    -f lavfi -i "sine=frequency=659:duration=0.2" \
    -f lavfi -i "sine=frequency=784:duration=0.4" \
    -filter_complex "[0]adelay=0|0[a];[1]adelay=250|250[b];[2]adelay=500|500[c];[a][b][c]amix=inputs=3:duration=longest" \
    -c:a libopus -b:a 64k "$OUTFILE"
  echo "Generated $OUTFILE using tone chime (install espeak-ng for voice)"
fi
