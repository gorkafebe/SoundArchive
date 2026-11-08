"""Healthcheck: has the heartbeat file been touched recently?

    python -m app.worker.health [file] [max age in seconds]
"""

import sys
import time
from pathlib import Path


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/worker-heartbeat")
    max_age = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    try:
        return 0 if time.time() - path.stat().st_mtime < max_age else 1
    except OSError:
        return 1


if __name__ == "__main__":
    sys.exit(main())
