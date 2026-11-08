#!/usr/bin/env python3
"""Upload acceptance test against a running stack, through Caddy over HTTPS.

Sends a large file in chunks, interrupts it, resumes it, checks the SHA-256,
and samples the API container's memory during the upload.

    upload-acceptance.py --base https://localhost:9443 --ca root.crt \
        --project sa-test-accept --file big.wav

It needs an account: it reads USERNAME and PASSWORD from the environment.
Only the standard library, so it runs on the host with no installation.
"""

import argparse
import hashlib
import http.client
import json
import os
import ssl
import subprocess
import threading
import time
import urllib.parse


class Client:
    def __init__(self, base: str, ca: str) -> None:
        url = urllib.parse.urlparse(base)
        self.host, self.port = url.hostname, url.port
        self.origin = base
        self.context = ssl.create_default_context(cafile=ca)
        self.cookie = ""
        self.csrf = ""

    def connect(self) -> http.client.HTTPSConnection:
        return http.client.HTTPSConnection(self.host, self.port, context=self.context, timeout=600)

    def request(self, method, path, body=None, headers=None):
        conn = self.connect()
        all_headers = {"Origin": self.origin, "X-CSRF-Token": self.csrf, "Cookie": self.cookie, **(headers or {})}
        conn.request(method, path, body=body, headers=all_headers)
        response = conn.getresponse()
        data = response.read()
        for name, value in response.getheaders():
            if name.lower() == "set-cookie":
                self.cookie = value.split(";")[0]
        conn.close()
        return response.status, data

    def json(self, method, path, payload=None):
        status, data = self.request(
            method, path, json.dumps(payload) if payload is not None else None, {"Content-Type": "application/json"}
        )
        return status, json.loads(data) if data else None


def sample_memory(container: str, stop: threading.Event, out: list[float]) -> None:
    while not stop.is_set():
        text = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", container],
            capture_output=True, text=True,
        ).stdout.split("/")[0].strip()
        for unit, factor in (("GiB", 1024.0), ("MiB", 1.0), ("KiB", 1 / 1024)):
            if text.endswith(unit):
                out.append(float(text[: -len(unit)]) * factor)
                break
        time.sleep(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--ca", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--file", required=True)
    parser.add_argument("--chunk-mib", type=int, default=16)
    args = parser.parse_args()

    client = Client(args.base, args.ca)
    status, me = client.json("POST", "/api/auth/login", {"username": os.environ["USERNAME"], "password": os.environ["PASSWORD"]})
    assert status == 200, status
    client.csrf = me["csrf_token"]

    status, place = client.json("POST", "/api/places", {"name": "Aceptación", "latitude": 43.0, "longitude": -3.0})
    assert status == 201, (status, place)

    size = os.path.getsize(args.file)
    print(f"archivo: {size} bytes ({size / 1024 / 1024:.0f} MiB)")
    digest = hashlib.sha256()
    with open(args.file, "rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    expected = digest.hexdigest()

    status, recording = client.json(
        "POST",
        "/api/recordings",
        {"place_id": place["id"], "title": "Archivo grande", "recorded_at": "2026-11-08T10:00:00Z",
         "capture_method": "upload", "size": size, "filename": "grande.wav"},
    )
    assert status == 201, (status, recording)
    recording_id = recording["id"]
    upload_path = f"/api/recordings/{recording_id}/upload"

    stop = threading.Event()
    memory: list[float] = []
    sampler = threading.Thread(target=sample_memory, args=(f"{args.project}-api-1", stop, memory))
    sampler.start()
    chunk = args.chunk_mib * 1024 * 1024
    started = time.time()
    offset = 0
    interrupted = False
    with open(args.file, "rb") as source:
        while offset < size:
            source.seek(offset)
            data = source.read(chunk)
            end = offset + len(data) - 1
            if not interrupted and offset >= size // 3:
                # Cut the connection half way through a chunk: the Wi-Fi drops.
                interrupted = True
                conn = client.connect()
                conn.putrequest("PATCH", upload_path)
                conn.putheader("Origin", client.origin)
                conn.putheader("X-CSRF-Token", client.csrf)
                conn.putheader("Cookie", client.cookie)
                conn.putheader("Content-Range", f"bytes {offset}-{end}/{size}")
                conn.putheader("Content-Length", str(len(data)))
                conn.endheaders()
                conn.send(data[: len(data) // 2])
                conn.sock.close()
                print(f"corte simulado en el byte {offset + len(data) // 2}")
                time.sleep(3)
                for _ in range(30):
                    status, state = client.json("GET", upload_path)
                    if status == 200:
                        break
                    time.sleep(1)
                print(f"el servidor dice que tiene {state['received']} bytes; se reanuda desde ahí")
                assert state["received"] >= offset, state
                offset = state["received"]
                continue
            status, body = client.request("PATCH", upload_path, data, {"Content-Range": f"bytes {offset}-{end}/{size}"})
            if status == 409 and b"upload_in_progress" in body:
                time.sleep(1)
                continue
            assert status == 200, (status, body[:200])
            offset += len(data)
    elapsed = time.time() - started
    stop.set()
    sampler.join()
    print(f"subida completa en {elapsed:.1f} s ({size / 1024 / 1024 / elapsed:.0f} MiB/s)")
    print(f"memoria de la API durante la subida: mín {min(memory):.0f} MiB, máx {max(memory):.0f} MiB, {len(memory)} muestras")

    for _ in range(900):
        status, final = client.json("GET", f"/api/recordings/{recording_id}")
        if final["status"] != "processing":
            break
        time.sleep(2)
    print("estado:", final["status"], final["failure_code"])
    print("duración:", final["duration_seconds"], "LUFS:", final["loudness_lufs"], "pico:", final["true_peak_dbfs"])
    print("huella local   :", expected[:16], "...")
    print("huella servidor:", final["sha256"][:16], "...")
    assert final["status"] == "ready"
    assert final["sha256"] == expected
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
