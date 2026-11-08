"""Where files live on the media volume.

    media/tmp/<uuid>.part           an upload in progress
    media/originals/aa/bb/<uuid>    the untouched original (read-only)
    media/derived/aa/bb/<uuid>.*    listening copy and waveform peaks
    media/photos/aa/bb/<uuid>-*.jpg re-encoded photos

Names come from random ids, never from what the person called the file, so a
hostile file name cannot point anywhere. aa/bb are the first characters of the
id: a directory with millions of entries is slow, 65 536 small ones are not.
"""

import os
import shutil
import uuid
from pathlib import Path

from app.config import settings

DIR_MODE = 0o750
READ_ONLY = 0o440


def root() -> Path:
    return Path(settings.media_root)


def absolute(relative: str) -> Path:
    """The real path of a stored file; refuses anything outside the media root."""
    base = root().resolve()
    path = (base / relative).resolve()
    if not path.is_relative_to(base):
        raise ValueError("path outside the media root")
    return path


def _shard(item_id: uuid.UUID) -> str:
    return f"{item_id.hex[:2]}/{item_id.hex[2:4]}"


def part_path(recording_id: uuid.UUID) -> Path:
    return root() / "tmp" / f"{recording_id}.part"


def original_relative(recording_id: uuid.UUID) -> str:
    return f"originals/{_shard(recording_id)}/{recording_id}"


def derived_relative(recording_id: uuid.UUID, suffix: str) -> str:
    return f"derived/{_shard(recording_id)}/{recording_id}{suffix}"


def photo_relative(photo_id: uuid.UUID, size: str) -> str:
    return f"photos/{_shard(photo_id)}/{photo_id}-{size}.jpg"


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=DIR_MODE)


def free_bytes() -> int:
    return shutil.disk_usage(root()).free


def store_read_only(source: Path, relative: str) -> None:
    """Move a finished file to its place and take away the right to change it."""
    target = absolute(relative)
    ensure_parent(target)
    os.replace(source, target)
    os.chmod(target, READ_ONLY)


def delete_file(relative: str | None) -> None:
    if not relative:
        return
    absolute(relative).unlink(missing_ok=True)
