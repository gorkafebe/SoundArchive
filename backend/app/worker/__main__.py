"""The audio worker: takes jobs from the "audio" queue, one at a time.

`with_scheduler` is what makes the retry delays work. A heartbeat file lets the
container's healthcheck tell a live worker from a hung one.
"""

import logging
import threading
import time
from pathlib import Path

from redis import Redis
from rq import Queue, Worker

from app.config import settings

HEARTBEAT = Path("/tmp/worker-heartbeat")


def beat() -> None:
    while True:
        HEARTBEAT.touch()
        time.sleep(30)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    threading.Thread(target=beat, daemon=True).start()
    connection = Redis.from_url(settings.redis_url)
    Worker([Queue("audio", connection=connection)], connection=connection).work(with_scheduler=True)


if __name__ == "__main__":
    main()
