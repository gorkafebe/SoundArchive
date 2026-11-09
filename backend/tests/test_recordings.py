"""Recordings: upload, processing, listening, permissions.

The audio is synthesised with ffmpeg at test time; nothing is downloaded.
"""

import hashlib
import json
import os
import stat
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select

from app import storage
from app.models import Recording
from app.worker import maintenance, tasks

REF_LEVEL = 0.0708  # -23 dBFS: a 1 kHz sine at this level measures -23.0 LUFS in stereo


def tone(path: Path, seconds: float = 10.0, *, rate: int = 48000, codec: list[str] | None = None) -> Path:
    expr = f"{REF_LEVEL}*sin(2*PI*1000*t)"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", f"aevalsrc={expr}|{expr}:s={rate}:d={seconds}",
         *(codec or ["-c:a", "pcm_s16le"]), "-y", str(path)],
        check=True,
    )
    return path


def make_place(browser) -> str:
    response = browser.write("POST", "/api/places", json={"name": "Lugar", "latitude": 43.0, "longitude": -3.0, "confirm_distinct": True})
    assert response.status_code == 201
    return response.json()["id"]


def create(browser, place_id, size, **extra):
    body = {
        "place_id": place_id,
        "title": "Toma",
        "recorded_at": "2026-10-12T08:42:00+02:00",
        "capture_method": "upload",
        "size": size,
        **extra,
    }
    return browser.write("POST", "/api/recordings", json=body)


def send(browser, recording_id, data, start, total):
    end = start + len(data) - 1
    return browser.write(
        "PATCH",
        f"/api/recordings/{recording_id}/upload",
        content=data,
        headers={"Content-Range": f"bytes {start}-{end}/{total}"},
    )


def upload(browser, place_id, data: bytes, chunk: int = 256 * 1024, **extra) -> dict:
    created = create(browser, place_id, len(data), **extra)
    assert created.status_code == 201, created.text
    recording_id = created.json()["id"]
    for offset in range(0, len(data), chunk):
        piece = data[offset : offset + chunk]
        response = send(browser, recording_id, piece, offset, len(data))
        assert response.status_code == 200, response.text
    return browser.get(f"/api/recordings/{recording_id}").json()


@pytest.fixture
def author(harness):
    return harness.signed_in("autora")


@pytest.fixture
def place(author):
    return make_place(author)


def test_full_upload_and_processing_of_a_reference_tone(author, place, tmp_path):
    data = tone(tmp_path / "tone.wav").read_bytes()
    recording = upload(author, place, data, heard="Un tono de referencia")
    assert recording["status"] == "ready", recording
    assert recording["sha256"] == hashlib.sha256(data).hexdigest()
    assert recording["size_bytes"] == len(data)
    assert recording["duration_seconds"] == pytest.approx(10.0, abs=0.05)
    assert recording["sample_rate"] == 48000
    assert recording["channels"] == 2
    assert recording["bit_depth"] == 16
    assert recording["codec"] == "pcm_s16le"
    # EBU R128 reference: tolerance documented in docs/ACCEPTANCE.md.
    assert recording["loudness_lufs"] == pytest.approx(-23.0, abs=0.5)
    assert recording["true_peak_dbfs"] == pytest.approx(-23.0, abs=1.0)
    assert recording["author_name"] == "autora"
    # No path of the disk in any answer.
    text = json.dumps(recording)
    assert "/media" not in text and "originals" not in text and "derived" not in text


def test_original_is_stored_read_only_and_never_under_the_user_filename(author, place, tmp_path, harness):
    data = tone(tmp_path / "t.wav", 1).read_bytes()
    recording = upload(author, place, data, filename="../../../etc/evil.wav")
    with harness.sessions() as session:
        row = session.execute(select(Recording)).scalar_one()
    assert "evil" not in row.original_path
    assert row.original_path.startswith("originals/")
    mode = stat.S_IMODE(os.stat(storage.absolute(row.original_path)).st_mode)
    assert mode == 0o440
    assert not storage.part_path(row.id).exists()
    assert recording["status"] == "ready"


def test_listening_copy_answers_range_requests_with_206(author, place, tmp_path):
    data = tone(tmp_path / "t.wav", 3).read_bytes()
    recording = upload(author, place, data)
    url = f"/api/recordings/{recording['id']}/audio"
    whole = author.get(url)
    assert whole.status_code == 200
    assert whole.headers["content-type"] == "audio/webm"
    assert whole.headers["accept-ranges"] == "bytes"
    assert whole.content[:4] == b"\x1aE\xdf\xa3"  # EBML header: a WebM file

    part = author.get(url, headers={"Range": "bytes=100-199"})
    assert part.status_code == 206
    assert part.headers["content-range"] == f"bytes 100-199/{len(whole.content)}"
    assert part.content == whole.content[100:200]

    suffix = author.get(url, headers={"Range": "bytes=-50"})
    assert suffix.status_code == 206
    assert suffix.content == whole.content[-50:]

    bad = author.get(url, headers={"Range": f"bytes={len(whole.content) + 10}-"})
    assert bad.status_code == 416


def test_peaks_describe_the_sound_without_the_audio(author, place, tmp_path):
    recording = upload(author, place, tone(tmp_path / "t.wav", 3).read_bytes())
    peaks = author.get(f"/api/recordings/{recording['id']}/peaks").json()["peaks"]
    assert len(peaks) >= 700
    assert max(peaks) == pytest.approx(REF_LEVEL, abs=0.02)


def test_download_original_returns_the_exact_bytes_with_a_safe_name(author, place, tmp_path):
    data = tone(tmp_path / "t.wav", 1).read_bytes()
    recording = upload(author, place, data, filename='we"ird; name.wav')
    response = author.get(f"/api/recordings/{recording['id']}/original")
    assert response.content == data
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment")
    assert "weird" not in disposition and '"we' not in disposition
    assert recording["id"] in disposition


@pytest.mark.parametrize(
    "name,codec,expected",
    [
        ("a.flac", ["-c:a", "flac"], "flac"),
        ("a.mp3", ["-c:a", "libmp3lame"], "mp3"),
        ("a.m4a", ["-c:a", "aac"], "aac"),
        ("a.ogg", ["-c:a", "libvorbis"], "vorbis"),
        ("a.opus", ["-c:a", "libopus"], "opus"),
        ("a.webm", ["-c:a", "libopus"], "opus"),
    ],
)
def test_allowed_formats_are_processed(author, place, tmp_path, name, codec, expected):
    recording = upload(author, place, tone(tmp_path / name, 1, codec=codec).read_bytes())
    assert recording["status"] == "ready", recording
    assert recording["codec"] == expected


def test_a_text_file_with_a_wav_name_fails_with_a_clear_code(author, place):
    recording = upload(author, place, b"this is not sound at all\n" * 100, filename="song.wav")
    assert recording["status"] == "failed"
    assert recording["failure_code"] == "not_audio"


def test_a_video_is_refused_even_with_an_audio_track(author, place, tmp_path):
    path = tmp_path / "v.mp4"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=d=1:s=64x64",
         "-f", "lavfi", "-i", "sine=d=1", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", "-y", str(path)],
        check=True,
    )
    recording = upload(author, place, path.read_bytes(), filename="audio.m4a")
    assert recording["status"] == "failed"
    assert recording["failure_code"] == "format_not_allowed"


def test_failed_file_has_no_listening_copy(author, place):
    recording = upload(author, place, b"nope" * 1000)
    assert author.get(f"/api/recordings/{recording['id']}/audio").status_code == 404


# --- Resuming and limits --------------------------------------------------------


def test_interrupted_upload_resumes_from_the_real_offset(author, place, tmp_path):
    data = tone(tmp_path / "t.wav", 2).read_bytes()
    recording_id = create(author, place, len(data)).json()["id"]
    half = len(data) // 2
    assert send(author, recording_id, data[:half], 0, len(data)).json()["received"] == half

    state = author.get(f"/api/recordings/{recording_id}/upload").json()
    assert state == {"received": half, "total": len(data), "status": "uploading"}

    # Sending from the wrong place is refused and says where to continue.
    wrong = send(author, recording_id, data[:100], 0, len(data))
    assert wrong.status_code == 409
    assert wrong.json()["detail"] == {"code": "wrong_offset", "received": half}

    assert send(author, recording_id, data[half:], half, len(data)).json()["status"] == "processing"
    final = author.get(f"/api/recordings/{recording_id}").json()
    assert final["status"] == "ready"
    assert final["sha256"] == hashlib.sha256(data).hexdigest()


def test_oversize_is_refused_when_declared(author, place, secure_settings):
    secure_settings.max_upload_bytes = 1000
    assert create(author, place, 1001).status_code == 413


def test_oversize_is_refused_in_content_range(author, place, secure_settings):
    created = create(author, place, 900).json()
    secure_settings.max_upload_bytes = 500
    response = send(author, created["id"], b"x" * 10, 0, 900)
    assert response.status_code == 413


def test_body_longer_than_its_content_range_is_cut_off_by_the_real_count(author, place, harness):
    created = create(author, place, 1000).json()
    # The header promises 100 bytes; the body has 500.
    response = author.write(
        "PATCH",
        f"/api/recordings/{created['id']}/upload",
        content=b"x" * 500,
        headers={"Content-Range": "bytes 0-99/1000"},
    )
    assert response.status_code == 413
    # Nothing of it stays on disk.
    assert author.get(f"/api/recordings/{created['id']}/upload").json()["received"] == 0


def test_declared_total_cannot_change_between_chunks(author, place):
    created = create(author, place, 1000).json()
    assert send(author, created["id"], b"x" * 10, 0, 2000).status_code == 409


def test_no_room_on_disk_is_refused_before_uploading(author, place, secure_settings):
    secure_settings.min_free_bytes = 10**18
    response = create(author, place, 100)
    assert response.status_code == 507


def test_only_the_author_can_upload_to_a_draft(author, place, harness):
    created = create(author, place, 100).json()
    other = harness.signed_in("otra")
    assert send(other, created["id"], b"x", 0, 100).status_code == 404
    assert other.get(f"/api/recordings/{created['id']}/upload").status_code == 404


def test_abandoned_drafts_are_cleaned_up(author, place, harness, monkeypatch):
    created = create(author, place, 100).json()
    monkeypatch.setattr(maintenance, "SessionLocal", harness.sessions)
    part = [p for p in (storage.root() / "tmp").iterdir()][0]
    assert part.exists()
    assert maintenance.clean_drafts(datetime.now(UTC)) == 0
    assert maintenance.clean_drafts(datetime.now(UTC) + timedelta(days=30)) == 1
    assert not part.exists()
    assert author.get(f"/api/recordings/{created['id']}").status_code == 404


def test_system_errors_are_retried_not_blamed_on_the_file(author, place, tmp_path, monkeypatch):
    data = tone(tmp_path / "t.wav", 1).read_bytes()
    created = create(author, place, len(data)).json()

    def broken(*_args, **_kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(tasks, "analyse_and_store", broken)

    class Job:
        retries_left = 1

    monkeypatch.setattr(tasks, "get_current_job", lambda: Job)
    with pytest.raises(RuntimeError):
        send(author, created["id"], data, 0, len(data))
    # Still "processing": the next attempt may succeed.
    assert author.get(f"/api/recordings/{created['id']}").json()["status"] == "processing"


# --- Permissions ---------------------------------------------------------------


def test_private_recording_is_invisible_to_others(author, place, harness, tmp_path):
    recording = upload(author, place, tone(tmp_path / "t.wav", 1).read_bytes(), visibility="private")
    other = harness.signed_in("otra")
    assert other.get(f"/api/recordings/{recording['id']}").status_code == 404
    assert other.get(f"/api/recordings/{recording['id']}/audio").status_code == 404
    assert other.get(f"/api/recordings/{recording['id']}/original").status_code == 404
    assert other.get(f"/api/places/{place}/recordings").json()["items"] == []
    assert other.get(f"/api/places/{place}").json()["recording_count"] == 0
    assert author.get(f"/api/places/{place}").json()["recording_count"] == 1


def test_an_admin_can_see_private_recordings(author, place, harness, tmp_path):
    recording = upload(author, place, tone(tmp_path / "t.wav", 1).read_bytes(), visibility="private")
    admin = harness.signed_in("raiz", admin=True)
    assert admin.get(f"/api/recordings/{recording['id']}").status_code == 200


def test_anonymous_recording_hides_the_name_from_others(author, place, harness, tmp_path):
    recording = upload(author, place, tone(tmp_path / "t.wav", 1).read_bytes(), show_author=False)
    assert recording["author_name"] == "autora"  # the author still sees it
    other = harness.signed_in("otra")
    seen = other.get(f"/api/recordings/{recording['id']}").json()
    assert seen["author_name"] is None
    assert "autora" not in str(seen)


def test_others_cannot_edit_or_remove(author, place, harness, tmp_path):
    recording = upload(author, place, tone(tmp_path / "t.wav", 1).read_bytes())
    other = harness.signed_in("otra")
    assert other.write("PATCH", f"/api/recordings/{recording['id']}", json={"title": "X"}).status_code == 403
    assert other.write("POST", f"/api/recordings/{recording['id']}/remove", json={}).status_code == 403


def test_author_can_edit_and_remove(author, place, harness, tmp_path):
    recording = upload(author, place, tone(tmp_path / "t.wav", 1).read_bytes())
    updated = author.write("PATCH", f"/api/recordings/{recording['id']}", json={"title": "Nuevo", "license": "cc-by"})
    assert updated.json()["title"] == "Nuevo"
    assert updated.json()["license"] == "cc-by"
    assert author.write("POST", f"/api/recordings/{recording['id']}/remove", json={}).status_code == 200
    other = harness.signed_in("otra")
    gone = other.get(f"/api/recordings/{recording['id']}")
    assert gone.status_code == 410
    assert gone.json()["detail"] == {"code": "removed"}
    assert other.get(f"/api/recordings/{recording['id']}/audio").status_code == 410
    assert other.get(f"/api/places/{place}/recordings").json()["items"] == []
