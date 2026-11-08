"""Photos of a place.

    GET  /api/places/{id}/photos
    POST /api/places/{id}/photos?caption=&alt=      raw body, the image
    GET  /api/photos/{id}/{thumb|medium|large}
    POST /api/photos/{id}/remove

Nothing the person sent is stored as it came. The image is decoded and encoded
again as a new JPEG, which drops EXIF (above all the GPS position), comments,
and anything hidden in the file. Pixel count is checked from the header before
decoding, so a small file that would unpack to gigabytes (a "decompression
bomb") is refused without being unpacked.
"""

import io
import uuid
import warnings
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import BaseModel
from sqlalchemy import func, select

from app import audit, storage
from app.config import Settings
from app.deps import SessionDep, SettingsDep, Viewer, ViewerDep, WriterDep
from app.models import ALT_MAX, CAPTION_MAX, Place, PlacePhoto

router = APIRouter(prefix="/api", tags=["photos"])

ACCEPTED_FORMATS = {"JPEG", "PNG", "WEBP"}
SIZES = {"large": 2048, "medium": 960, "thumb": 400}
PATH_COLUMNS = {"large": "large_path", "medium": "medium_path", "thumb": "thumb_path"}


class PhotoOut(BaseModel):
    id: uuid.UUID
    place_id: uuid.UUID
    caption: str | None
    alt_text: str | None
    width: int
    height: int
    is_owner: bool
    created_at: datetime


def _to_out(viewer: Viewer, photo: PlacePhoto) -> PhotoOut:
    return PhotoOut(
        id=photo.id,
        place_id=photo.place_id,
        caption=photo.caption,
        alt_text=photo.alt_text,
        width=photo.width,
        height=photo.height,
        is_owner=viewer.id is not None and photo.uploader_id == viewer.id,
        created_at=photo.created_at,
    )


def _reject(status_code: int, code: str) -> HTTPException:
    return HTTPException(status_code, detail={"code": code})


async def _read_limited(request: Request, limit: int) -> bytes:
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > limit:
            raise _reject(status.HTTP_413_CONTENT_TOO_LARGE, "too_large")
    return bytes(data)


def _encode(image: Image.Image, longest: int) -> bytes:
    copy = image.copy()
    copy.thumbnail((longest, longest), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    # Only these options: no exif=, no icc_profile=, so nothing carries over.
    copy.save(out, "JPEG", quality=85, optimize=True, progressive=True)
    return out.getvalue()


def _process(data: bytes, config: Settings) -> tuple[dict[str, bytes], int, int]:
    """Decode, check and re-encode. Returns the JPEGs by size name."""
    Image.MAX_IMAGE_PIXELS = config.photo_max_pixels
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as probe:
                if probe.format not in ACCEPTED_FORMATS:
                    raise _reject(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "not_an_image")
                width, height = probe.size
                if width * height > config.photo_max_pixels:
                    raise _reject(status.HTTP_413_CONTENT_TOO_LARGE, "image_too_large")
            image = Image.open(io.BytesIO(data))
            image.load()
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise _reject(status.HTTP_413_CONTENT_TOO_LARGE, "image_too_large") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise _reject(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "not_an_image") from None

    # A phone's sideways photo is stored rotated with a note in the EXIF that
    # says so. Apply the rotation for real before the note disappears.
    image = ImageOps.exif_transpose(image)
    if image.mode in ("RGBA", "LA", "P"):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel("A"))
        image = background
    else:
        image = image.convert("RGB")
    return {name: _encode(image, longest) for name, longest in SIZES.items()}, image.width, image.height


def _place_or_raise(db: SessionDep, place_id: uuid.UUID) -> Place:
    place = db.get(Place, place_id)
    if place is None or place.removed_at is not None:
        raise _reject(status.HTTP_404_NOT_FOUND, "not_found")
    return place


@router.get("/places/{place_id}/photos", response_model=list[PhotoOut])
def list_photos(place_id: uuid.UUID, viewer: ViewerDep, db: SessionDep) -> list[PhotoOut]:
    _place_or_raise(db, place_id)
    photos = db.scalars(
        select(PlacePhoto)
        .where(PlacePhoto.place_id == place_id, PlacePhoto.removed_at.is_(None))
        .order_by(PlacePhoto.created_at)
    )
    return [_to_out(viewer, photo) for photo in photos]


@router.post("/places/{place_id}/photos", response_model=PhotoOut, status_code=status.HTTP_201_CREATED)
async def upload_photo(
    place_id: uuid.UUID,
    request: Request,
    viewer: WriterDep,
    db: SessionDep,
    config: SettingsDep,
    caption: Annotated[str | None, Query(max_length=CAPTION_MAX)] = None,
    alt: Annotated[str | None, Query(max_length=ALT_MAX)] = None,
) -> PhotoOut:
    def precheck() -> None:
        _place_or_raise(db, place_id)
        count = db.scalar(
            select(func.count())
            .select_from(PlacePhoto)
            .where(
                PlacePhoto.place_id == place_id,
                PlacePhoto.uploader_id == viewer.id,
                PlacePhoto.removed_at.is_(None),
            )
        )
        if (count or 0) >= config.photos_per_person_per_place:
            raise _reject(status.HTTP_409_CONFLICT, "photo_limit")
        db.rollback()

    await run_in_threadpool(precheck)
    data = await _read_limited(request, config.photo_max_bytes)

    def store() -> PhotoOut:
        encoded, width, height = _process(data, config)
        photo_id = uuid.uuid4()
        paths: dict[str, str] = {}
        for name, content in encoded.items():
            relative = storage.photo_relative(photo_id, name)
            target = storage.absolute(relative)
            storage.ensure_parent(target)
            target.write_bytes(content)
            target.chmod(storage.READ_ONLY)
            paths[name] = relative
        photo = PlacePhoto(
            id=photo_id,
            place_id=place_id,
            uploader_id=viewer.id,
            caption=(caption or "").strip() or None,
            alt_text=(alt or "").strip() or None,
            width=width,
            height=height,
            large_path=paths["large"],
            medium_path=paths["medium"],
            thumb_path=paths["thumb"],
        )
        db.add(photo)
        audit.record(db, viewer, "photo.created", target_type="photo", target_id=photo_id)
        db.commit()
        db.refresh(photo)
        return _to_out(viewer, photo)

    return await run_in_threadpool(store)


@router.get("/photos/{photo_id}/{size}")
def photo_file(photo_id: uuid.UUID, size: str, viewer: ViewerDep, db: SessionDep) -> FileResponse:
    if size not in PATH_COLUMNS:
        raise _reject(status.HTTP_404_NOT_FOUND, "not_found")
    photo = db.get(PlacePhoto, photo_id)
    if photo is None or (photo.removed_at is not None and not viewer.is_admin):
        raise _reject(status.HTTP_404_NOT_FOUND, "not_found")
    return FileResponse(
        storage.absolute(getattr(photo, PATH_COLUMNS[size])),
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.post("/photos/{photo_id}/remove", status_code=status.HTTP_204_NO_CONTENT)
def remove_photo(photo_id: uuid.UUID, viewer: WriterDep, db: SessionDep) -> None:
    photo = db.get(PlacePhoto, photo_id)
    if photo is None:
        raise _reject(status.HTTP_404_NOT_FOUND, "not_found")
    if not (viewer.is_admin or (viewer.id is not None and photo.uploader_id == viewer.id)):
        raise _reject(status.HTTP_403_FORBIDDEN, "forbidden")
    photo.removed_at = datetime.now(UTC)
    photo.removed_by = viewer.id
    audit.record(db, viewer, "photo.removed", target_type="photo", target_id=photo.id)
    db.commit()
