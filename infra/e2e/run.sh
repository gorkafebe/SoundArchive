#!/bin/sh
# Inside the browser test container: trust the private CA, make the test audio
# with ffmpeg (nothing is downloaded), then run the given command.
set -eu
trust-ca /app/test-results/ca/root.crt true
media=/app/test-results/e2e-media
mkdir -p "$media"
if [ ! -f "$media/capture.wav" ]; then
    tone() { # name, frequency, seconds
        ffmpeg -nostdin -loglevel error -f lavfi \
            -i "aevalsrc=0.15*sin(2*PI*$2*t)|0.15*sin(2*PI*$2*t):s=48000:d=$3" \
            -c:a pcm_s16le -y "$media/$1"
    }
    # The fake microphone: Chromium plays this file as if it were captured.
    tone capture.wav 440 30
    tone tone-a.wav 440 8
    tone tone-b.wav 880 8
    tone short.wav 660 2
    printf 'this is plain text, not sound\n' > "$media/not-audio.wav"
fi
exec "$@"
