"""Recordings: create, upload, read, listen.

Uploading has two steps, so a dropped Wi-Fi connection does not cost the file:

    POST  /api/recordings              metadata; creates the draft
    GET   /api/recordings/{id}/upload  how many bytes have arrived
    PATCH /api/recordings/{id}/upload  a piece, with Content-Range

The body is streamed straight to disk: memory stays flat however large the
file is. Three independent limits apply to size: the declared total, the
total in Content-Range, and the count of bytes that really arrive (a header
can lie, the count cannot).

Listening uses the derived copy, with range requests (HTTP 206) so the browser
can seek without downloading everything.
"""

import fcntl
import os
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

import redis
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from rq import Queue, Retry
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.requests import ClientDisconnect

from app import audit, storage
from app.config import Settings
from app.deps import SessionDep, SettingsDep, Viewer, ViewerDep, WriterDep
from app.models import HEARD_MAX, LICENSES, TITLE_MAX, Place, Recording, Report, User
from app.ratelimit import get_redis

router = APIRouter(prefix="/api", tags=["recordings"])

RedisDep = Annotated[redis.Redis, Depends(get_redis)]
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=TITLE_MAX)]

_RANGE_RE = re.compile(r"^bytes (\d+)-(\d+)/(\d+)$")
_WRITE_BLOCK = 1024 * 1024
JOB_TIMEOUT_SECONDS = 2 * 60 * 60


class RecordingCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    place_id: uuid.UUID
    title: Title
    heard: str | None = Field(default=None, max_length=HEARD_MAX)
    recorded_at: datetime
    recorded_tz: str | None = Field(default=None, max_length=64)
    visibility: str = Field(default="public", pattern="^(public|private)$")
    show_author: bool = True
    license: str = "all-rights-reserved"
    capture_method: str = Field(pattern="^(browser|upload)$")
    capture_settings: dict[str, Any] | None = None
    device_note: str | None = Field(default=None, max_length=160)
    size: int = Field(gt=0)
    filename: str | None = Field(default=None, max_length=255)


class RecordingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Title | None = None
    heard: str | None = Field(default=None, max_length=HEARD_MAX)
    visibility: str | None = Field(default=None, pattern="^(public|private)$")
    show_author: bool | None = None
    license: str | None = None
    recorded_at: datetime | None = None
    device_note: str | None = Field(default=None, max_length=160)


class RecordingOut(BaseModel):
    id: uuid.UUID
    place_id: uuid.UUID
    place_name: str | None
    title: str
    heard: str | None
    recorded_at: datetime
    recorded_tz: str | None
    status: str
    failure_code: str | None
    visibility: str
    show_author: bool
    author_name: str | None
    is_owner: bool
    license: str
    capture_method: str
    capture_settings: dict[str, Any] | None
    device_note: str | None
    size_bytes: int | None
    sha256: str | None
    duration_seconds: float | None
    container: str | None
    codec: str | None
    sample_rate: int | None
    channels: int | None
    bit_depth: int | None
    loudness_lufs: float | None
    true_peak_dbfs: float | None
    location_accuracy_m: int | None
    created_at: datetime
    removed_reason: str | None = None
    report_count: int | None = None


class UploadState(BaseModel):
    received: int
    total: int
    status: str


class RecordingList(BaseModel):
    items: list[RecordingOut]


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found"})


def _is_owner(viewer: Viewer, recording: Recording) -> bool:
    return viewer.id is not None and recording.author_id == viewer.id


def to_out(
    viewer: Viewer,
    recording: Recording,
    place: Place,
    author: str | None,
    report_count: int | None = None,
) -> RecordingOut:
    owner = _is_owner(viewer, recording)
    return RecordingOut(
        id=recording.id,
        place_id=recording.place_id,
        place_name=place.name,
        title=recording.title,
        heard=recording.heard,
        recorded_at=recording.recorded_at,
        recorded_tz=recording.recorded_tz,
        status=recording.status,
        failure_code=recording.failure_code,
        visibility=recording.visibility,
        show_author=recording.show_author,
        # An anonymous recording shows no name to anyone but its author and the
        # administrators (who have to be able to act on reports).
        author_name=author if (recording.show_author or owner or viewer.is_admin) else None,
        is_owner=owner,
        license=recording.license,
        capture_method=recording.capture_method,
        capture_settings=recording.capture_settings,
        device_note=recording.device_note,
        size_bytes=recording.size_bytes,
        sha256=recording.sha256,
        duration_seconds=recording.duration_seconds,
        container=recording.container,
        codec=recording.codec,
        sample_rate=recording.sample_rate,
        channels=recording.channels,
        bit_depth=recording.bit_depth,
        loudness_lufs=recording.loudness_lufs,
        true_peak_dbfs=recording.true_peak_dbfs,
        location_accuracy_m=place.location_accuracy_m,
        created_at=recording.created_at,
        removed_reason=recording.removed_reason if viewer.is_admin else None,
        report_count=report_count,
    )


def _load(db: Session, recording_id: uuid.UUID) -> tuple[Recording, Place, str | None]:
    row = db.execute(
        select(Recording, Place, User.username)
        .join(Place, Place.id == Recording.place_id)
        .outerjoin(User, User.id == Recording.author_id)
        .where(Recording.id == recording_id)
    ).one_or_none()
    if row is None:
        raise _not_found()
    return row


def visible_or_raise(viewer: Viewer, recording: Recording, place: Place) -> None:
    """404 when it must look as if it did not exist; 410 when retired."""
    if viewer.is_admin:
        return
    owner = _is_owner(viewer, recording)
    if recording.visibility == "private" and not owner:
        raise _not_found()
    if recording.status == "removed" or place.removed_at is not None:
        raise HTTPException(status.HTTP_410_GONE, detail={"code": "removed"})
    if recording.status != "ready" and not owner:
        raise _not_found()


def _editable_or_raise(viewer: Viewer, recording: Recording) -> None:
    if not (viewer.is_admin or _is_owner(viewer, recording)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail={"code": "forbidden"})


def _enqueue(client: redis.Redis, recording_id: uuid.UUID) -> None:
    Queue("audio", connection=client).enqueue(
        "app.worker.tasks.process_recording",
        str(recording_id),
        job_timeout=JOB_TIMEOUT_SECONDS,
        retry=Retry(max=2, interval=[30, 120]),
        failure_ttl=7 * 86400,
    )


def _check_room(config: Settings, wanted: int) -> None:
    if storage.free_bytes() - wanted < config.min_free_bytes:
        raise HTTPException(status.HTTP_507_INSUFFICIENT_STORAGE, detail={"code": "disk_full"})


@router.post("/recordings", response_model=RecordingOut, status_code=status.HTTP_201_CREATED)
def create_recording(body: RecordingCreate, viewer: WriterDep, db: SessionDep, config: SettingsDep) -> RecordingOut:
    if body.size > config.max_upload_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, detail={"code": "too_large"})
    if body.license not in LICENSES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"code": "bad_license"})
    if body.recorded_at.tzinfo is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"code": "bad_date"})
    if body.capture_settings is not None and len(str(body.capture_settings)) > 2000:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"code": "bad_capture_settings"})
    place = db.get(Place, body.place_id)
    if place is None or place.removed_at is not None:
        raise _not_found()
    _check_room(config, body.size)

    recording = Recording(
        place_id=body.place_id,
        author_id=viewer.id,
        title=body.title,
        heard=(body.heard or "").strip() or None,
        recorded_at=body.recorded_at.astimezone(UTC),
        recorded_tz=body.recorded_tz,
        visibility=body.visibility,
        show_author=body.show_author,
        license=body.license,
        capture_method=body.capture_method,
        capture_settings=body.capture_settings,
        device_note=(body.device_note or "").strip() or None,
        declared_size=body.size,
        original_filename=(body.filename or "")[:255] or None,
    )
    db.add(recording)
    db.flush()
    part = storage.part_path(recording.id)
    storage.ensure_parent(part)
    part.touch(mode=0o640)
    audit.record(db, viewer, "recording.created", target_type="recording", target_id=recording.id)
    db.commit()
    db.refresh(recording)
    return to_out(viewer, recording, place, viewer.user.username if viewer.user else None)


def _own_upload_or_raise(viewer: Viewer, recording: Recording) -> None:
    if not _is_owner(viewer, recording):
        raise _not_found()
    if recording.status != "uploading":
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "not_uploading", "status": recording.status})


@router.get("/recordings/{recording_id}/upload", response_model=UploadState)
def upload_state(recording_id: uuid.UUID, viewer: ViewerDep, db: SessionDep) -> UploadState:
    recording, _place, _author = _load(db, recording_id)
    if not _is_owner(viewer, recording):
        raise _not_found()
    if recording.status != "uploading":
        return UploadState(received=recording.size_bytes or 0, total=recording.declared_size or 0, status=recording.status)
    part = storage.part_path(recording.id)
    received = part.stat().st_size if part.exists() else 0
    return UploadState(received=received, total=recording.declared_size or 0, status=recording.status)


def _finalize(db: Session, client: redis.Redis, recording_id: uuid.UUID, received: int) -> None:
    recording = db.get(Recording, recording_id)
    if recording is None:
        return
    relative = storage.original_relative(recording.id)
    storage.store_read_only(storage.part_path(recording.id), relative)
    recording.original_path = relative
    recording.size_bytes = received
    recording.status = "processing"
    db.commit()
    _enqueue(client, recording.id)


async def _receive(request: Request, part: Path, start: int, limit: int) -> tuple[int, bool]:
    """Append the request body at `start`. Returns (bytes written, whole body seen).

    Raises _TooMuch as soon as the real count passes `limit`.
    """
    written = 0
    buffer = bytearray()
    complete = True
    fd = await run_in_threadpool(os.open, part, os.O_WRONLY)
    try:
        await run_in_threadpool(os.lseek, fd, start, os.SEEK_SET)
        try:
            async for chunk in request.stream():
                if not chunk:
                    continue
                if start + written + len(buffer) + len(chunk) > limit:
                    raise _TooMuch
                buffer.extend(chunk)
                if len(buffer) >= _WRITE_BLOCK:
                    data = bytes(buffer)
                    buffer.clear()
                    await run_in_threadpool(_write_all, fd, data)
                    written += len(data)
        except ClientDisconnect:
            # The connection dropped. What arrived is kept, and the client
            # asks for the offset and continues from there.
            complete = False
        if buffer:
            data = bytes(buffer)
            await run_in_threadpool(_write_all, fd, data)
            written += len(data)
        await run_in_threadpool(os.fsync, fd)
    finally:
        await run_in_threadpool(os.close, fd)
    return written, complete


class _TooMuch(Exception):
    pass


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        count = os.write(fd, view)
        view = view[count:]


@router.patch("/recordings/{recording_id}/upload", response_model=UploadState)
async def upload_chunk(
    recording_id: uuid.UUID,
    request: Request,
    viewer: WriterDep,
    db: SessionDep,
    config: SettingsDep,
    client: RedisDep,
    content_range: Annotated[str, Header()],
) -> UploadState | JSONResponse:
    match = _RANGE_RE.fullmatch(content_range.strip())
    if not match:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "bad_content_range"})
    start, end, total = (int(value) for value in match.groups())
    if end < start or end >= total:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "bad_content_range"})
    if total > config.max_upload_bytes:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, detail={"code": "too_large"})

    def prepare() -> None:
        recording, _place, _author = _load(db, recording_id)
        _own_upload_or_raise(viewer, recording)
        if total != recording.declared_size:
            raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "size_mismatch"})
        _check_room(config, end - start + 1)
        # Hand the database connection back: a long upload must not hold one.
        db.rollback()

    await run_in_threadpool(prepare)

    part = storage.part_path(recording_id)
    if not part.exists():
        raise _not_found()
    # One writer at a time for each upload (a retry can overlap a dying request).
    lock = await run_in_threadpool(open, part, "rb")
    try:
        try:
            await run_in_threadpool(fcntl.flock, lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "upload_in_progress"}) from None

        current = part.stat().st_size
        if start != current:
            # The client's offset is wrong: tell it the real one.
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={"detail": {"code": "wrong_offset", "received": current}},
            )

        # Never more than Content-Range promised, nor than the file's total.
        limit = min(end + 1, config.max_upload_bytes)
        try:
            written, complete = await _receive(request, part, start, limit)
        except _TooMuch:
            await run_in_threadpool(os.truncate, part, start)
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, detail={"code": "too_large"}) from None

        received = start + written
        if complete and received == total:
            await run_in_threadpool(_finalize, db, client, recording_id, received)
            return UploadState(received=received, total=total, status="processing")
        return UploadState(received=received, total=total, status="uploading")
    finally:
        await run_in_threadpool(lock.close)


@router.get("/places/{place_id}/recordings", response_model=RecordingList)
def list_for_place(place_id: uuid.UUID, viewer: ViewerDep, db: SessionDep) -> RecordingList:
    place = db.get(Place, place_id)
    if place is None or (place.removed_at is not None and not viewer.is_admin):
        raise _not_found()
    # Other people's: only ready and public. Your own: everything but finished
    # with, so that "still processing" and "failed" appear for the author.
    query = (
        select(Recording, User.username)
        .outerjoin(User, User.id == Recording.author_id)
        .where(Recording.place_id == place_id, Recording.status != "uploading")
        .order_by(Recording.recorded_at.desc())
    )
    if viewer.is_admin:
        pass
    else:
        mine = Recording.author_id == viewer.id
        query = query.where(
            (mine & (Recording.status != "removed"))
            | ((Recording.status == "ready") & (Recording.visibility == "public"))
        )
    rows = db.execute(query).all()
    return RecordingList(items=[to_out(viewer, recording, place, name) for recording, name in rows])


@router.get("/recordings/{recording_id}", response_model=RecordingOut)
def get_recording(recording_id: uuid.UUID, viewer: ViewerDep, db: SessionDep) -> RecordingOut:
    recording, place, author = _load(db, recording_id)
    visible_or_raise(viewer, recording, place)
    return to_out(viewer, recording, place, author)


@router.patch("/recordings/{recording_id}", response_model=RecordingOut)
def update_recording(
    recording_id: uuid.UUID, body: RecordingUpdate, viewer: WriterDep, db: SessionDep
) -> RecordingOut:
    recording, place, author = _load(db, recording_id)
    _editable_or_raise(viewer, recording)
    changes = body.model_dump(exclude_unset=True)
    if "license" in changes and changes["license"] not in LICENSES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, detail={"code": "bad_license"})
    for key, value in changes.items():
        setattr(recording, key, value)
    audit.record(db, viewer, "recording.updated", target_type="recording", target_id=recording.id)
    db.commit()
    return to_out(viewer, recording, place, author)


class RemoveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str | None = Field(default=None, max_length=500)


@router.post("/recordings/{recording_id}/remove", response_model=RecordingOut)
def remove_own(recording_id: uuid.UUID, body: RemoveBody, viewer: WriterDep, db: SessionDep) -> RecordingOut:
    """The author takes it down. Files are kept; an admin can restore it."""
    recording, place, author = _load(db, recording_id)
    _editable_or_raise(viewer, recording)
    recording.status = "removed"
    recording.removed_at = datetime.now(UTC)
    recording.removed_by = viewer.id
    recording.removed_reason = (body.reason or "").strip() or None
    audit.record(db, viewer, "recording.removed", target_type="recording", target_id=recording.id)
    db.commit()
    return to_out(viewer, recording, place, author)


class ReportBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=500)]


@router.post("/recordings/{recording_id}/report", status_code=status.HTTP_201_CREATED)
def report_recording(recording_id: uuid.UUID, body: ReportBody, viewer: WriterDep, db: SessionDep) -> dict[str, str]:
    recording, place, _author = _load(db, recording_id)
    visible_or_raise(viewer, recording, place)
    db.add(Report(recording_id=recording.id, reporter_id=viewer.id, reason=body.reason))
    audit.record(db, viewer, "recording.reported", target_type="recording", target_id=recording.id)
    db.commit()
    return {"status": "received"}


# --- Files --------------------------------------------------------------------


def _ready_or_raise(recording: Recording) -> None:
    if recording.status not in ("ready", "removed") or not recording.derived_path:
        raise _not_found()


@router.get("/recordings/{recording_id}/audio")
def listen(recording_id: uuid.UUID, viewer: ViewerDep, db: SessionDep) -> FileResponse:
    """The listening copy. FileResponse answers Range requests with 206."""
    recording, place, _author = _load(db, recording_id)
    visible_or_raise(viewer, recording, place)
    _ready_or_raise(recording)
    return FileResponse(
        storage.absolute(recording.derived_path),
        media_type="audio/webm",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.get("/recordings/{recording_id}/peaks")
def peaks(recording_id: uuid.UUID, viewer: ViewerDep, db: SessionDep) -> FileResponse:
    recording, place, _author = _load(db, recording_id)
    visible_or_raise(viewer, recording, place)
    _ready_or_raise(recording)
    if not recording.peaks_path:
        raise _not_found()
    return FileResponse(
        storage.absolute(recording.peaks_path),
        media_type="application/json",
        headers={"Cache-Control": "private, max-age=86400"},
    )


_EXTENSIONS = {
    "wav": "wav",
    "flac": "flac",
    "mp3": "mp3",
    "mov,mp4,m4a,3gp,3g2,mj2": "m4a",
    "ogg": "ogg",
    "matroska,webm": "webm",
    "aac": "aac",
}


@router.get("/recordings/{recording_id}/original")
def download_original(recording_id: uuid.UUID, viewer: ViewerDep, db: SessionDep) -> FileResponse:
    recording, place, _author = _load(db, recording_id)
    visible_or_raise(viewer, recording, place)
    _ready_or_raise(recording)
    if not recording.original_path:
        raise _not_found()
    extension = _EXTENSIONS.get(recording.container or "", "bin")
    # The name offered to the browser comes from our id, not from user text.
    return FileResponse(
        storage.absolute(recording.original_path),
        media_type="application/octet-stream",
        filename=f"sound-archive-{recording.id}.{extension}",
        headers={"Cache-Control": "private, no-store"},
    )
