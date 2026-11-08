"""Processing one uploaded recording.

  1. ffprobe: what is this file really? The name and the declared type are not
     trusted; the container and codec must be on the allow list.
  2. SHA-256 of the original, which is never modified.
  3. ebur128: loudness (LUFS) and true peak. Measured and shown, never applied.
  4. The listening copy: Opus in WebM, with no filter touching the level.
  5. Waveform peaks as JSON, so the player draws without downloading the audio.

A problem with the FILE is permanent: failed, with a code that the interface
can translate. A problem with the SYSTEM (database down, disk error) is
retried by RQ, and only marked failed after the last attempt.
"""

import hashlib
import json
import logging
import math
import re
import subprocess
import tempfile
import uuid
from array import array
from pathlib import Path

from rq import get_current_job
from sqlalchemy import select

from app import storage
from app.db import SessionLocal
from app.models import Recording

logger = logging.getLogger(__name__)

# What ffprobe calls each container, and the codecs allowed inside it.
ALLOWED = {
    "wav": {"pcm_u8", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le"},
    "flac": {"flac"},
    "mp3": {"mp3"},
    "mov,mp4,m4a,3gp,3g2,mj2": {"aac", "alac"},
    "aac": {"aac"},
    "ogg": {"opus", "vorbis", "flac"},
    "matroska,webm": {"opus", "vorbis"},
}

PEAK_BUCKETS = 800
PEAK_SAMPLE_RATE = 8000
MIN_TIMEOUT_SECONDS = 300
# Stops ffmpeg from following a reference inside a crafted file to the network
# or to other local files.
PROTOCOLS = ["-protocol_whitelist", "file,pipe"]


class InvalidFile(Exception):
    """The file itself is the problem: retrying cannot help."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def probe(path: Path) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", *PROTOCOLS, "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True,
        text=True,
        timeout=MIN_TIMEOUT_SECONDS,
    )
    if result.returncode != 0:
        raise InvalidFile("not_audio")
    return json.loads(result.stdout or "{}")


def check_allowed(info: dict) -> dict:
    """The audio stream, if this file is on the allow list; otherwise InvalidFile."""
    format_name = info.get("format", {}).get("format_name", "")
    streams = info.get("streams", [])
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if not audio:
        raise InvalidFile("not_audio")
    if format_name not in ALLOWED or audio[0].get("codec_name") not in ALLOWED[format_name]:
        raise InvalidFile("format_not_allowed")
    for stream in streams:
        # Cover art in an MP3 or M4A is a "video" stream; real video is not audio.
        if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic"):
            raise InvalidFile("format_not_allowed")
    return audio[0]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _timeout(duration: float | None) -> float:
    return max(MIN_TIMEOUT_SECONDS, (duration or 0) * 4)


_INTEGRATED = re.compile(r"I:\s+(-?[\d.]+|nan|-inf)\s+LUFS")
_TRUE_PEAK = re.compile(r"Peak:\s+(-?[\d.]+|nan|-inf|inf)\s+dBFS")


def _finite(match: re.Match | None) -> float | None:
    if match is None:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def measure_loudness(path: Path, duration: float | None) -> tuple[float | None, float | None]:
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-nostats", *PROTOCOLS, "-i", str(path),
         "-map", "a:0", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=_timeout(duration),
    )
    if result.returncode != 0:
        raise InvalidFile("cannot_decode")
    # The summary is at the end of the log.
    summary = result.stderr[result.stderr.rfind("Summary:") :]
    lufs = _finite(_INTEGRATED.search(summary))
    # ebur128 reports -70 for sound too short or too quiet to measure.
    if lufs is not None and lufs <= -70:
        lufs = None
    return lufs, _finite(_TRUE_PEAK.search(summary))


def make_listening_copy(source: Path, target: Path, channels: int, duration: float | None) -> None:
    """Opus in WebM. Only -c:a and -b:a: nothing here changes the level."""
    layout = ["-ac", "2"] if channels > 2 else []
    bitrate = "192k" if channels >= 2 else "128k"
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *PROTOCOLS, "-i", str(source),
         "-map", "a:0", "-vn", *layout, "-c:a", "libopus", "-b:a", bitrate, "-vbr", "on",
         # The seek index goes at the start, for seeking over HTTP.
         "-cues_to_front", "1", "-f", "webm", "-y", str(target)],
        capture_output=True,
        text=True,
        timeout=_timeout(duration),
    )
    if result.returncode != 0:
        raise InvalidFile("cannot_decode")


def make_peaks(source: Path, duration: float) -> list[float]:
    """The highest absolute level in each of PEAK_BUCKETS slices, from 0 to 1."""
    total = max(1, int(duration * PEAK_SAMPLE_RATE))
    per_bucket = max(1, total // PEAK_BUCKETS)
    process = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *PROTOCOLS, "-i", str(source),
         "-map", "a:0", "-ac", "1", "-ar", str(PEAK_SAMPLE_RATE), "-f", "s16le", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    peaks: list[float] = []
    try:
        assert process.stdout is not None
        while block := process.stdout.read(per_bucket * 2):
            samples = array("h")
            samples.frombytes(block[: len(block) - (len(block) % 2)])
            if samples:
                peaks.append(round(max(-min(samples), max(samples)) / 32768, 4))
    finally:
        process.stdout.close()
        if process.wait(timeout=_timeout(duration)) != 0:
            raise InvalidFile("cannot_decode")
    return peaks


def bit_depth_of(stream: dict) -> int | None:
    for key in ("bits_per_raw_sample", "bits_per_sample"):
        try:
            value = int(stream.get(key) or 0)
        except ValueError:
            value = 0
        if value > 0:
            return value
    return None


def _duration_of(info: dict) -> float | None:
    try:
        value = float(info.get("format", {}).get("duration", ""))
    except ValueError:
        return None
    return value if value > 0 and math.isfinite(value) else None


def analyse_and_store(recording: Recording, original: Path) -> None:
    info = probe(original)
    stream = check_allowed(info)
    duration = _duration_of(info)
    channels = int(stream.get("channels") or 0)

    recording.sha256 = sha256_of(original)
    recording.size_bytes = original.stat().st_size
    recording.container = info["format"]["format_name"]
    recording.codec = stream.get("codec_name")
    recording.sample_rate = int(stream.get("sample_rate") or 0) or None
    recording.channels = channels or None
    recording.bit_depth = bit_depth_of(stream)
    recording.loudness_lufs, recording.true_peak_dbfs = measure_loudness(original, duration)

    derived_relative = storage.derived_relative(recording.id, ".webm")
    peaks_relative = storage.derived_relative(recording.id, ".peaks.json")
    derived = storage.absolute(derived_relative)
    storage.ensure_parent(derived)
    # In the media folder: the final move must be within one filesystem.
    (storage.root() / "tmp").mkdir(parents=True, exist_ok=True, mode=storage.DIR_MODE)
    with tempfile.TemporaryDirectory(dir=storage.root() / "tmp") as work:
        copy = Path(work) / "copy.webm"
        make_listening_copy(original, copy, channels, duration)
        # A browser's MediaRecorder writes WebM without a duration in the
        # header. The copy we have just encoded always has one.
        duration = duration or _duration_of(probe(copy))
        if not duration:
            raise InvalidFile("cannot_decode")
        peaks_file = Path(work) / "peaks.json"
        peaks_file.write_text(json.dumps({"peaks": make_peaks(original, duration)}))
        storage.store_read_only(copy, derived_relative)
        storage.store_read_only(peaks_file, peaks_relative)
    recording.duration_seconds = round(duration, 3)
    recording.derived_path = derived_relative
    recording.peaks_path = peaks_relative
    recording.failure_code = None
    recording.status = "ready"


def process_recording(recording_id: str) -> None:
    with SessionLocal() as db:
        recording = db.execute(
            select(Recording).where(Recording.id == uuid.UUID(recording_id)).with_for_update(skip_locked=True)
        ).scalar_one_or_none()
        if recording is None or recording.status != "processing" or not recording.original_path:
            return
        try:
            analyse_and_store(recording, storage.absolute(recording.original_path))
            db.commit()
        except InvalidFile as problem:
            db.rollback()
            logger.info("recording %s refused: %s", recording_id, problem.code)
            _mark_failed(recording_id, problem.code)
        except Exception:
            db.rollback()
            job = get_current_job()
            if job is None or not job.retries_left:
                _mark_failed(recording_id, "processing_error")
            raise


def _mark_failed(recording_id: str, code: str) -> None:
    with SessionLocal() as db:
        recording = db.get(Recording, uuid.UUID(recording_id))
        if recording is not None and recording.status == "processing":
            recording.status = "failed"
            recording.failure_code = code
            db.commit()
