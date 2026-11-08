"""Administrator commands, run inside the api container.

    python -m app.cli admin-create --username NAME
    python -m app.cli admin-reset-password --username NAME
    python -m app.cli invite-create [--days 7]

Passwords are asked for with hidden input (or read from standard input when
that is not a terminal, for scripts and tests). They are never a command-line
argument, so they cannot end up in the shell history or the process list.
There is no e-mail in this system: resetting a password is this command.

    python -m app.cli purge-recording --id UUID
    python -m app.cli purge-place --id UUID

Purging deletes files and rows for good. It works only on content that has
already been taken down, and asks you to type part of the id to confirm. It
exists only here, not in the web interface, so a stray click or a stolen
session can never destroy anything.
"""

import argparse
import getpass
import sys
from datetime import UTC, datetime, timedelta

import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app import audit, storage
from app.auth import USERNAME_RE
from app.db import SessionLocal
from app.models import AuthSession, Invitation, Place, PlacePhoto, Recording, Report, User
from app.security import hash_password, new_invitation_code, password_problem, token_hash


def _read_password(username: str) -> str:
    if not sys.stdin.isatty():
        return sys.stdin.readline().rstrip("\n")
    first = getpass.getpass("Password (at least 12 characters): ")
    second = getpass.getpass("Repeat it: ")
    if first != second:
        raise SystemExit("The two passwords are different. Nothing was changed.")
    return first


def _checked_password(username: str) -> str:
    password = _read_password(username)
    problem = password_problem(password, username)
    if problem:
        raise SystemExit(f"Password not accepted: {problem}. Nothing was changed.")
    return password


def _find(db: Session, username: str) -> User | None:
    return db.execute(select(User).where(func.lower(User.username) == username.lower())).scalar_one_or_none()


def admin_create(args: argparse.Namespace) -> int:
    if not USERNAME_RE.fullmatch(args.username):
        raise SystemExit("Username: 3 to 32 characters, letters, digits, dot, dash or underscore.")
    with SessionLocal() as db:
        if _find(db, args.username):
            raise SystemExit(f"The username {args.username} already exists.")
        password = _checked_password(args.username)
        user = User(username=args.username, password_hash=hash_password(password), role="admin")
        db.add(user)
        db.flush()
        audit.record(db, None, "cli.admin_created", target_type="user", target_id=user.id)
        db.commit()
    print(f"Administrator {args.username} created.")
    return 0


def admin_reset_password(args: argparse.Namespace) -> int:
    with SessionLocal() as db:
        user = _find(db, args.username)
        if user is None:
            raise SystemExit(f"No account named {args.username}.")
        user.password_hash = hash_password(_checked_password(user.username))
        db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
        audit.record(db, None, "cli.password_reset", target_type="user", target_id=user.id)
        db.commit()
    print(f"Password changed for {args.username}; every session of that account was closed.")
    return 0


def invite_create(args: argparse.Namespace) -> int:
    code = new_invitation_code()
    with SessionLocal() as db:
        invitation = Invitation(
            code_hash=token_hash(code),
            code_hint=code[:7],
            expires_at=datetime.now(UTC) + timedelta(days=args.days),
        )
        db.add(invitation)
        db.flush()
        audit.record(db, None, "cli.invitation_created", target_type="invitation", target_id=invitation.id)
        db.commit()
    # The only time the full code is shown: the database keeps just its hash.
    print(f"Invitation code (valid for {args.days} days, usable once):")
    print(code)
    return 0


def _confirm(kind: str, item_id: uuid.UUID, title: str) -> None:
    word = str(item_id)[:8]
    print(f"This deletes the {kind} \"{title}\" and its files, for good.")
    print(f"Type {word} to confirm:")
    if sys.stdin.readline().strip() != word:
        raise SystemExit("Not confirmed. Nothing was deleted.")


def _delete_recording_files(recording: Recording) -> None:
    for relative in (recording.original_path, recording.derived_path, recording.peaks_path):
        storage.delete_file(relative)


def purge_recording(args: argparse.Namespace) -> int:
    with SessionLocal() as db:
        recording = db.get(Recording, args.id)
        if recording is None:
            raise SystemExit("No such recording.")
        if recording.status != "removed":
            raise SystemExit("Only recordings that have been removed can be purged. Remove it first.")
        _confirm("recording", recording.id, recording.title)
        _delete_recording_files(recording)
        db.execute(delete(Report).where(Report.recording_id == recording.id))
        db.delete(recording)
        audit.record(db, None, "cli.recording_purged", target_type="recording", target_id=args.id)
        db.commit()
    print("Purged.")
    return 0


def purge_place(args: argparse.Namespace) -> int:
    with SessionLocal() as db:
        place = db.get(Place, args.id)
        if place is None:
            raise SystemExit("No such place.")
        if place.removed_at is None:
            raise SystemExit("Only places that have been removed can be purged. Remove it first.")
        recordings = list(db.scalars(select(Recording).where(Recording.place_id == place.id)))
        photos = list(db.scalars(select(PlacePhoto).where(PlacePhoto.place_id == place.id)))
        print(f"It also deletes {len(recordings)} recording(s) and {len(photos)} photo(s).")
        _confirm("place", place.id, place.name)
        for recording in recordings:
            _delete_recording_files(recording)
            db.execute(delete(Report).where(Report.recording_id == recording.id))
            db.delete(recording)
        for photo in photos:
            for relative in (photo.large_path, photo.medium_path, photo.thumb_path):
                storage.delete_file(relative)
            db.delete(photo)
        db.flush()
        db.delete(place)
        audit.record(db, None, "cli.place_purged", target_type="place", target_id=args.id)
        db.commit()
    print("Purged.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)

    cmd = commands.add_parser("admin-create", help="Create an administrator account")
    cmd.add_argument("--username", required=True)
    cmd.set_defaults(handler=admin_create)

    cmd = commands.add_parser("admin-reset-password", help="Set a new password for any account")
    cmd.add_argument("--username", required=True)
    cmd.set_defaults(handler=admin_reset_password)

    cmd = commands.add_parser("invite-create", help="Create an invitation code")
    cmd.add_argument("--days", type=int, default=7)
    cmd.set_defaults(handler=invite_create)

    cmd = commands.add_parser("purge-recording", help="Delete a removed recording and its files for good")
    cmd.add_argument("--id", type=uuid.UUID, required=True)
    cmd.set_defaults(handler=purge_recording)

    cmd = commands.add_parser("purge-place", help="Delete a removed place, its recordings and photos for good")
    cmd.add_argument("--id", type=uuid.UUID, required=True)
    cmd.set_defaults(handler=purge_place)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
