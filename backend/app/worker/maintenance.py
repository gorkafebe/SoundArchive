"""Housekeeping, every few minutes:

- delete uploads never finished, after DRAFT_MAX_AGE_HOURS;
- put back in the queue any recording stuck in "processing" (Redis keeps its
  queue only in memory, so a restart can lose a job, and this recovers it);
- delete expired sessions.
"""

import logging
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from redis import Redis
from rq import Queue, Retry
from sqlalchemy import delete, select

from app import storage
from app.config import settings
from app.db import SessionLocal
from app.models import AuthSession, Recording

logger = logging.getLogger("maintenance")

INTERVAL_SECONDS = 300
STUCK_AFTER = timedelta(minutes=30)
HEARTBEAT = Path("/tmp/maintenance-heartbeat")


def clean_drafts(now: datetime) -> int:
    cutoff = now - timedelta(hours=settings.draft_max_age_hours)
    with SessionLocal() as db:
        drafts = list(
            db.scalars(select(Recording).where(Recording.status == "uploading", Recording.created_at < cutoff))
        )
        for draft in drafts:
            storage.part_path(draft.id).unlink(missing_ok=True)
            db.delete(draft)
        db.commit()
    return len(drafts)


def requeue_stuck(now: datetime, connection: Redis) -> int:
    count = 0
    queue = Queue("audio", connection=connection)
    with SessionLocal() as db:
        stuck = list(
            db.scalars(
                select(Recording).where(Recording.status == "processing", Recording.updated_at < now - STUCK_AFTER)
            )
        )
        known = {job.args[0] for job in queue.get_jobs() if job.args}
        for recording in stuck:
            if str(recording.id) in known:
                continue
            queue.enqueue(
                "app.worker.tasks.process_recording",
                str(recording.id),
                job_timeout=2 * 60 * 60,
                retry=Retry(max=2, interval=[30, 120]),
            )
            # Touch it, so it is not queued again on the next pass.
            recording.updated_at = now
            count += 1
        db.commit()
    return count


def clean_sessions(now: datetime) -> int:
    with SessionLocal() as db:
        removed = db.execute(delete(AuthSession).where(AuthSession.expires_at < now)).rowcount
        db.commit()
    return removed or 0


def run_once(connection: Redis) -> None:
    now = datetime.now(UTC)
    drafts = clean_drafts(now)
    stuck = requeue_stuck(now, connection)
    sessions = clean_sessions(now)
    if drafts or stuck or sessions:
        logger.info("cleaned %d drafts, requeued %d recordings, deleted %d sessions", drafts, stuck, sessions)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    connection = Redis.from_url(settings.redis_url)
    while True:
        try:
            run_once(connection)
            HEARTBEAT.touch()
        except Exception:
            logger.exception("maintenance pass failed; trying again at the next one")
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
