"""Content moderation for administrators.

    GET  /api/admin/content             recordings and places, with reports
    POST /api/admin/recordings/{id}/remove | /restore
    POST /api/admin/places/{id}/remove | /restore
    POST /api/admin/photos/{id}/remove | /restore
    POST /api/admin/recordings/{id}/resolve-reports

"Remove" hides it from everyone and keeps the files; "restore" undoes that.
Deleting for good ("purge") exists only on the command line (app/cli.py), so
it cannot be done with a stray click or a stolen browser session.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, StringConstraints
from sqlalchemy import func, select, update

from app import audit
from app.deps import AdminDep, AdminWriterDep, SessionDep
from app.models import Place, PlacePhoto, Recording, Report, User
from app.recordings import RecordingOut, _load, to_out

router = APIRouter(prefix="/api/admin", tags=["moderation"])

Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class RemoveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Reason


class ContentReport(BaseModel):
    id: uuid.UUID
    reason: str
    created_at: datetime


class ContentRow(RecordingOut):
    reports: list[ContentReport]


class PlaceAdminRow(BaseModel):
    id: uuid.UUID
    name: str
    author_name: str | None
    removed_at: datetime | None
    removed_reason: str | None


class ContentPage(BaseModel):
    recordings: list[ContentRow]
    places: list[PlaceAdminRow]


def _not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found"})


@router.get("/content", response_model=ContentPage)
def content(
    admin: AdminDep, db: SessionDep, limit: Annotated[int, Query(ge=1, le=500)] = 200
) -> ContentPage:
    rows = db.execute(
        select(Recording, Place, User.username)
        .join(Place, Place.id == Recording.place_id)
        .outerjoin(User, User.id == Recording.author_id)
        .where(Recording.status != "uploading")
        .order_by(Recording.created_at.desc())
        .limit(limit)
    ).all()
    ids = [row[0].id for row in rows]
    reports: dict[uuid.UUID, list[Report]] = {}
    if ids:
        for report in db.scalars(
            select(Report).where(Report.recording_id.in_(ids), Report.resolved_at.is_(None)).order_by(Report.created_at)
        ):
            reports.setdefault(report.recording_id, []).append(report)
    recordings = []
    for recording, place, author in rows:
        open_reports = reports.get(recording.id, [])
        base = to_out(admin, recording, place, author, len(open_reports))
        recordings.append(
            ContentRow(
                **base.model_dump(),
                reports=[ContentReport(id=r.id, reason=r.reason, created_at=r.created_at) for r in open_reports],
            )
        )
    # Reported first: that is what an administrator opens this page for.
    recordings.sort(key=lambda r: (-(r.report_count or 0), r.status != "removed"))
    places = db.execute(
        select(Place, User.username)
        .outerjoin(User, User.id == Place.created_by)
        .order_by(Place.removed_at.desc().nulls_last(), Place.created_at.desc())
        .limit(limit)
    ).all()
    return ContentPage(
        recordings=recordings,
        places=[
            PlaceAdminRow(
                id=place.id,
                name=place.name,
                author_name=author,
                removed_at=place.removed_at,
                removed_reason=place.removed_reason,
            )
            for place, author in places
        ],
    )


@router.post("/recordings/{recording_id}/remove", response_model=RecordingOut)
def remove_recording(
    recording_id: uuid.UUID, body: RemoveRequest, admin: AdminWriterDep, db: SessionDep
) -> RecordingOut:
    recording, place, author = _load(db, recording_id)
    recording.status = "removed"
    recording.removed_at = datetime.now(UTC)
    recording.removed_by = admin.id
    recording.removed_reason = body.reason
    db.execute(
        update(Report)
        .where(Report.recording_id == recording.id, Report.resolved_at.is_(None))
        .values(resolved_at=func.now(), resolved_by=admin.id)
    )
    audit.record(db, admin, "admin.recording_removed", target_type="recording", target_id=recording.id)
    db.commit()
    return to_out(admin, recording, place, author)


@router.post("/recordings/{recording_id}/restore", response_model=RecordingOut)
def restore_recording(recording_id: uuid.UUID, admin: AdminWriterDep, db: SessionDep) -> RecordingOut:
    recording, place, author = _load(db, recording_id)
    if recording.status != "removed":
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "not_removed"})
    # Back to what it was: ready if it has a listening copy, otherwise failed.
    recording.status = "ready" if recording.derived_path else "failed"
    recording.removed_at = None
    recording.removed_by = None
    recording.removed_reason = None
    audit.record(db, admin, "admin.recording_restored", target_type="recording", target_id=recording.id)
    db.commit()
    return to_out(admin, recording, place, author)


@router.post("/recordings/{recording_id}/resolve-reports", status_code=status.HTTP_204_NO_CONTENT)
def resolve_reports(recording_id: uuid.UUID, admin: AdminWriterDep, db: SessionDep) -> None:
    db.execute(
        update(Report)
        .where(Report.recording_id == recording_id, Report.resolved_at.is_(None))
        .values(resolved_at=func.now(), resolved_by=admin.id)
    )
    audit.record(db, admin, "admin.reports_resolved", target_type="recording", target_id=recording_id)
    db.commit()


@router.post("/places/{place_id}/remove", response_model=PlaceAdminRow)
def remove_place(place_id: uuid.UUID, body: RemoveRequest, admin: AdminWriterDep, db: SessionDep) -> PlaceAdminRow:
    place = db.get(Place, place_id)
    if place is None:
        raise _not_found()
    place.removed_at = datetime.now(UTC)
    place.removed_by = admin.id
    place.removed_reason = body.reason
    audit.record(db, admin, "admin.place_removed", target_type="place", target_id=place.id)
    db.commit()
    return PlaceAdminRow(
        id=place.id, name=place.name, author_name=None, removed_at=place.removed_at, removed_reason=place.removed_reason
    )


@router.post("/places/{place_id}/restore", response_model=PlaceAdminRow)
def restore_place(place_id: uuid.UUID, admin: AdminWriterDep, db: SessionDep) -> PlaceAdminRow:
    place = db.get(Place, place_id)
    if place is None:
        raise _not_found()
    place.removed_at = None
    place.removed_by = None
    place.removed_reason = None
    audit.record(db, admin, "admin.place_restored", target_type="place", target_id=place.id)
    db.commit()
    return PlaceAdminRow(id=place.id, name=place.name, author_name=None, removed_at=None, removed_reason=None)


@router.post("/photos/{photo_id}/remove", status_code=status.HTTP_204_NO_CONTENT)
def remove_photo(photo_id: uuid.UUID, body: RemoveRequest, admin: AdminWriterDep, db: SessionDep) -> None:
    photo = db.get(PlacePhoto, photo_id)
    if photo is None:
        raise _not_found()
    photo.removed_at = datetime.now(UTC)
    photo.removed_by = admin.id
    photo.removed_reason = body.reason
    audit.record(db, admin, "admin.photo_removed", target_type="photo", target_id=photo.id)
    db.commit()


@router.post("/photos/{photo_id}/restore", status_code=status.HTTP_204_NO_CONTENT)
def restore_photo(photo_id: uuid.UUID, admin: AdminWriterDep, db: SessionDep) -> None:
    photo = db.get(PlacePhoto, photo_id)
    if photo is None:
        raise _not_found()
    photo.removed_at = None
    photo.removed_by = None
    photo.removed_reason = None
    audit.record(db, admin, "admin.photo_restored", target_type="photo", target_id=photo.id)
    db.commit()
