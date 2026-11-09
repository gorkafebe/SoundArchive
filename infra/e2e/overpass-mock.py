"""A stand-in for the Overpass API, for the end-to-end tests only.

Runs as the container sa-e2e-overpass-mock on the throwaway test network; it
publishes no port. It knows two named sites per grid cell, and only inside a
small area of Spain that the tests use, so tests elsewhere see no suggestions.

    POST /api/interpreter    what the API calls
    GET  /__calls            how many calls so far, and the last body
    GET  /__mode?m=ok        ok | down (500) | slow (longer than the API waits)
    GET  /__health
"""

import json
import re
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SERVED_AREA = (37.0, -3.6, 37.6, -3.0)
SLOW_SECONDS = 6

state = {"mode": "ok", "calls": 0, "last": ""}


def answer(query: str) -> dict:
    match = re.search(r"\[bbox:([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\]", query)
    south, west, north, east = (float(v) for v in match.groups())
    lat, lon = (south + north) / 2, (west + east) / 2
    a_south, a_west, a_north, a_east = SERVED_AREA
    if not (a_south <= lat <= a_north and a_west <= lon <= a_east):
        return {"elements": []}
    base = int((lat + 90) * 100000) * 100000 + int(lon * -100000)
    return {
        "elements": [
            {"type": "node", "id": base + 1, "lat": lat, "lon": lon, "tags": {"name": "Panadería Paco", "shop": "bakery"}},
            {
                "type": "way",
                "id": base + 2,
                "center": {"lat": lat + 0.0003, "lon": lon},
                "tags": {"name": "Café Central", "amenity": "cafe"},
            },
        ]
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/__calls":
            self._send(200, {"calls": state["calls"], "last": state["last"]})
        elif url.path == "/__mode":
            state["mode"] = urllib.parse.parse_qs(url.query).get("m", ["ok"])[0]
            self._send(200, {"mode": state["mode"]})
        elif url.path == "/__health":
            self._send(200, {"status": "ok"})
        else:
            self._send(404, {})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        query = urllib.parse.parse_qs(self.rfile.read(length).decode()).get("data", [""])[0]
        state["calls"] += 1
        state["last"] = query
        if state["mode"] == "down":
            self._send(500, {"error": "down"})
            return
        if state["mode"] == "slow":
            time.sleep(SLOW_SECONDS)
        self._send(200, answer(query))

    def log_message(self, *args) -> None:
        pass


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
