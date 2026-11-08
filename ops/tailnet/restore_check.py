"""Run inside a restored api container: can a recording really be listened to?

Signs in, lists a place's recordings, asks for the listening copy by range and
for the original, and compares the original's SHA-256 with the database.
Reads USERNAME and PASSWORD from the environment.
"""

import hashlib
import json
import os
import urllib.request

BASE = "http://127.0.0.1:8000"
ORIGIN = "https://restore-test"


def call(path, body=None, cookie=None, headers=None):
    all_headers = {"Origin": ORIGIN, "Content-Type": "application/json", **(headers or {})}
    if cookie:
        all_headers["Cookie"] = cookie
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=data, headers=all_headers)
    return urllib.request.urlopen(request, timeout=60)


login = call("/api/auth/login", {"username": os.environ["USERNAME"], "password": os.environ["PASSWORD"]})
cookie = login.headers["set-cookie"].split(";")[0]

places = json.load(call("/api/places/list?limit=100", cookie=cookie))["items"]
checked = 0
for place in places:
    if not place["recording_count"]:
        continue
    for recording in json.load(call(f"/api/places/{place['id']}/recordings", cookie=cookie))["items"]:
        if recording["status"] != "ready":
            continue
        part = call(f"/api/recordings/{recording['id']}/audio", cookie=cookie, headers={"Range": "bytes=0-3"})
        assert part.status == 206, part.status
        assert part.read() == b"\x1aE\xdf\xa3", "not a WebM file"
        original = call(f"/api/recordings/{recording['id']}/original", cookie=cookie).read()
        assert hashlib.sha256(original).hexdigest() == recording["sha256"], recording["id"]
        checked += 1
assert checked > 0, "no recording to check"
print(f"OK: {checked} grabaciones restauradas se sirven (206) y su original coincide con la huella.")
